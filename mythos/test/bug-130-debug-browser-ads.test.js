'use strict';

// test/bug-130-debug-browser-ads.test.js — BUG-130.
//
// 2026-08-06: MYTHOS opened YouTube in the debug browser and the operator got
// the full ad break. Not a regression — the debug browser has ALWAYS run in a
// dedicated, empty --user-data-dir (BUG-115 verified those profiles have never
// held an extension), so the operator's own blocker, which lives in their real
// profile, was never in play.
//
// The fix is deliberately BYO, per the repo's portability/licensing rules: no
// third-party extension is bundled and nothing is downloaded on the operator's
// behalf. Instead:
//   1. Brave is preferred when installed — its Shields are part of the browser,
//      so they work in a fresh profile with nothing installed.
//   2. BROWSER_EXTENSIONS (BUG-115) stays the path for an operator-supplied
//      unpacked blocker, and is now documented with a worked example.
//
// What is pinned here is what is actually verifiable without a live network:
// the resolution order, that an explicit browser still wins, that no launch arg
// we pass turns extensions off, and that the docs carry the example.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  browserCandidatePaths,
  buildBrowserLaunchArgs,
} = require('../src/core/effectors/from-browser');

function firstBrowserOf(candidates) {
  // The candidate list is grouped by browser, so the first entry names the
  // browser that would be picked if every browser were installed.
  const lower = candidates[0].toLowerCase();
  if (lower.includes('brave')) return 'brave';
  if (lower.includes('chrome')) return 'chrome';
  if (lower.includes('edge')) return 'edge';
  return null;
}

describe('BUG-130 — the debug browser should not be the one place with no ad blocking', () => {
  test('with no browser named, Brave is tried first', () => {
    const candidates = browserCandidatePaths();
    assert.equal(firstBrowserOf(candidates), 'brave',
      'Brave Shields are the only ad blocking available in a fresh profile with nothing installed');
  });

  test('Chrome and Edge are still candidates — this is a preference, not a removal', () => {
    const joined = browserCandidatePaths().join('|').toLowerCase();
    assert.ok(joined.includes('chrome.exe'), 'Chrome must remain a fallback');
    assert.ok(joined.includes('msedge.exe'), 'Edge must remain a fallback');
  });

  test('an explicitly named browser still wins outright', () => {
    // "open it in Chrome" must never be answered with Brave — BUG-099's whole
    // point was that a named browser is honoured or the call fails.
    const chromeOnly = browserCandidatePaths('chrome');
    assert.ok(chromeOnly.length > 0);
    assert.ok(chromeOnly.every((p) => p.toLowerCase().includes('chrome.exe')),
      'a named browser must not silently widen to any other');
  });

  test('no launch arg we pass disables the browser\'s own blocking', () => {
    // Derived from os.tmpdir() rather than written out: AD-7 fails any
    // machine-specific absolute path literal in a tracked file, tests included.
    const args = buildBrowserLaunchArgs(path.join(os.tmpdir(), 'mythos-bug130-profile'), []);
    // --disable-extensions would switch off Brave Shields' extension-backed
    // components as well as any operator-supplied blocker.
    assert.ok(!args.some((a) => a.startsWith('--disable-extensions')),
      'with no extensions configured we must pass no extension-disabling flag at all');
  });

  test('with extensions configured, both flags Chromium needs are passed and nothing else is disabled', () => {
    const profileDir = path.join(os.tmpdir(), 'mythos-bug130-profile');
    const extDir = path.join(os.tmpdir(), 'mythos-bug130-ublock');
    const args = buildBrowserLaunchArgs(profileDir, [extDir]);
    assert.ok(args.includes('--load-extension=' + extDir));
    // --disable-extensions-except is required (Chromium ignores --load-extension
    // on its own) and is scoped to exactly the configured list, never bare.
    assert.ok(args.includes('--disable-extensions-except=' + extDir));
    assert.ok(!args.includes('--disable-extensions'));
  });

  test('.env.example documents BROWSER_EXTENSIONS with a worked, BYO example', () => {
    const envExample = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
    const block = envExample.slice(envExample.indexOf('# BROWSER_EXTENSIONS') - 3000, envExample.indexOf('# BROWSER_EXTENSIONS=') + 40);
    assert.match(block, /manifest\.json/, 'the example must say which folder to point at');
    assert.match(block, /Brave/, 'and offer the zero-install route');
    assert.match(block, /BROWSER_EXTENSIONS=%USERPROFILE%/, 'a copyable example line, not just prose');
    // The supply-chain boundary is part of the documented contract.
    assert.match(block, /downloads nothing on your behalf/i);
  });
});
