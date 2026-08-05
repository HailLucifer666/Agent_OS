'use strict';

// test/browser-target-honesty.test.js — BUG-099. On 2026-08-05 the operator asked
// four times for YouTube in BRAVE. launch_app('brave') opened Brave, then every
// browser_navigate landed in Chrome — because the browser effectors drive one
// fixed CDP endpoint and findBrowserExecutable() only ever knew Chrome and Edge.
// MYTHOS then described the Chrome navigation as though the request had been
// honored.
//
// Two guarantees pinned here:
//   1. Brave is a launchable debug browser (env-derived paths only — repo
//      portability rule, no hardcoded absolutes).
//   2. When the caller names a browser, the tool never silently drives a
//      different one. When the attached browser is genuinely unknown (MYTHOS
//      connected to a CDP endpoint it did not start), it says so rather than
//      assuming a match.
//
// The target check is tested through its own pure helper deliberately: calling
// browser_navigate here would run requireOnline(), which may LAUNCH a real
// browser on the test machine.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const browserAgent = require('../adapters/browser-agent');
const browserMod = require('../src/core/effectors/from-browser');

const {
  TOOLS,
  browserCandidatePaths,
  normalizeBrowserName,
  checkBrowserTarget,
  __setAttachedBrowserForTest,
  findBrowserExecutable,
} = browserMod;

function tool(name) {
  const t = TOOLS.find((x) => x.name === name);
  assert.ok(t, `${name} must be registered`);
  return t;
}

describe('browser executable resolution', () => {
  test('brave is a known browser with env-derived candidate paths', () => {
    const paths = browserCandidatePaths('brave');
    assert.ok(paths.length > 0, 'brave must have candidate paths');
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
      .filter(Boolean);
    for (const p of paths) {
      assert.match(path.basename(p).toLowerCase(), /brave\.exe$/);
      assert.ok(roots.some((r) => p.startsWith(r)), `${p} must derive from an env root, not a hardcoded absolute`);
    }
  });

  test('chrome stays the default and is still first in the default search order', () => {
    const order = browserCandidatePaths();
    assert.ok(order.length > 0);
    assert.match(path.basename(order[0]).toLowerCase(), /chrome\.exe$/);
  });

  test('the default order still includes brave and edge as fallbacks', () => {
    const names = browserCandidatePaths().map((p) => path.basename(p).toLowerCase());
    assert.ok(names.some((n) => n.includes('brave')), 'brave must be reachable without naming it');
    assert.ok(names.some((n) => n.includes('msedge')), 'edge must still be a fallback');
  });

  test('browser names are normalized, and an unknown name is rejected not guessed', () => {
    assert.equal(normalizeBrowserName('Brave'), 'brave');
    assert.equal(normalizeBrowserName(' brave browser '), 'brave');
    assert.equal(normalizeBrowserName('google chrome'), 'chrome');
    assert.equal(normalizeBrowserName('msedge'), 'edge');
    assert.equal(normalizeBrowserName('firefox'), null, 'not a Chromium-CDP browser');
    assert.equal(normalizeBrowserName(''), null);
  });

  test('a resolved executable actually exists on disk', () => {
    const resolved = findBrowserExecutable('brave');
    if (resolved) assert.ok(fs.existsSync(resolved), 'the resolver must never return a non-existent path');
  });
});

describe('checkBrowserTarget — never silently drive the wrong browser', () => {
  // BUG-106: checkBrowserTarget() now also reads browserAgent.getStatus() and
  // clears attachedBrowser whenever the adapter is not ONLINE (a stale
  // attachedBrowser must not outlive the real connection). These tests are
  // about the NAMING logic specifically, so they mock the adapter ONLINE —
  // the connectivity-clearing behavior itself is covered separately in
  // test/bug-106-attached-browser-stale.test.js.
  let originalGetStatus;
  beforeEach(() => {
    originalGetStatus = browserAgent.getStatus;
    browserAgent.getStatus = () => ({ state: 'ONLINE', mode: 'launched' });
  });
  afterEach(() => { browserAgent.getStatus = originalGetStatus; });

  test('no browser requested → no objection (existing behavior unchanged)', () => {
    __setAttachedBrowserForTest('chrome');
    assert.equal(checkBrowserTarget(undefined), null);
    assert.equal(checkBrowserTarget(''), null);
  });

  test('requesting the attached browser → no objection', () => {
    __setAttachedBrowserForTest('brave');
    assert.equal(checkBrowserTarget('brave'), null);
    assert.equal(checkBrowserTarget('Brave'), null);
  });

  test('requesting a different browser → fails, naming both', () => {
    __setAttachedBrowserForTest('chrome');
    const res = checkBrowserTarget('brave');
    assert.ok(res, 'a mismatch must be refused');
    assert.equal(res.ok, false);
    assert.match(String(res.result), /brave/i);
    assert.match(String(res.result), /chrome/i);
    assert.match(String(res.result), /browser_launch_debug/, 'must say how to fix it');
  });

  test('unknown attached browser → says unknown, never assumes a match', () => {
    __setAttachedBrowserForTest(null);
    const res = checkBrowserTarget('brave');
    assert.ok(res);
    assert.equal(res.ok, false);
    assert.match(String(res.result), /cannot confirm/i);
  });

  test('an unsupported browser name → refused with the supported list', () => {
    __setAttachedBrowserForTest('chrome');
    const res = checkBrowserTarget('firefox');
    assert.ok(res);
    assert.equal(res.ok, false);
    assert.match(String(res.result), /chrome/i);
    assert.match(String(res.result), /brave/i);
  });
});

describe('voice can actually act on the refusal', () => {
  test('browser_launch_debug is reachable from the Live voice path', () => {
    // A failure hint that names a tool the model cannot call is a dead end.
    const { DEFAULT_ALLOWLIST } = require('../src/core/voice/live-tools');
    assert.ok(DEFAULT_ALLOWLIST.includes('browser_launch_debug'),
      'browser_navigate now tells the model to call browser_launch_debug — it must be reachable');
    assert.ok(DEFAULT_ALLOWLIST.includes('browser_get_title'),
      'the read oracle for "which page is actually open" must ship with the act tools');
    assert.ok(DEFAULT_ALLOWLIST.includes('browser_tabs'),
      'tab management was the other half of the 2026-08-05 failure');
  });
});

describe('tool declarations expose the browser target', () => {
  test('browser_navigate accepts an optional browser param', () => {
    const t = tool('browser_navigate');
    assert.ok(t.params.browser, 'browser_navigate must accept a browser name');
    assert.match(String(t.params.browser), /optional/i);
  });

  test('browser_launch_debug accepts a browser param and mentions Brave', () => {
    const t = tool('browser_launch_debug');
    assert.ok(t.params.browser, 'browser_launch_debug must accept a browser name');
    assert.match(String(t.params.browser), /optional/i);
    assert.match(String(t.description).toLowerCase(), /brave/);
  });
});
