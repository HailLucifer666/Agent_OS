'use strict';

// test/bug-115-browser-extensions.test.js — BUG-115.
//
// browser_launch_debug drives the debug browser through a dedicated
// --user-data-dir that has never had any extensions installed into it — the
// operator's ad blocker (or any other extension) lives only in their REAL
// browser profile, so every page MYTHOS navigates is unfiltered. Verified
// read-only: neither debug profile directory has ever had a
// Default/Extensions folder.
//
// BROWSER_EXTENSIONS (env, semicolon-separated list of unpacked extension
// directory paths, already documented in mythos/.env.example) lets the
// operator load their own extensions into the debug profile via
// --load-extension + --disable-extensions-except (Chromium ignores
// --load-extension alone in current builds). A misconfigured path must fail
// the launch LOUDLY, never silently proceed without the blocker — that
// silent-absence shape is exactly today's bug.
//
// IMPORTANT test-safety note: Chrome, Brave AND Edge are all genuinely
// installed on this dev machine, so any call that reaches
// browser_launch_debug's real spawn() launches an ACTUAL visible browser
// window (confirmed the hard way while building the sibling BUG-107 tests).
// These tests therefore exercise the pure, exported helper seams
// (resolveBrowserExtensions / buildBrowserLaunchArgs / buildLaunchResult)
// for every "what would be loaded" assertion, and call the real
// browser_launch_debug() ONLY for the invalid-path case, where validation
// fails and returns BEFORE the exe lookup or spawn() ever run.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const browserMod = require('../src/core/effectors/from-browser');
const {
  parseBrowserExtensionsEnv,
  resolveBrowserExtensions,
  buildBrowserLaunchArgs,
  buildLaunchResult,
  browser_launch_debug,
} = browserMod;

describe('BUG-115 — BROWSER_EXTENSIONS loads real extensions into the debug profile', () => {
  let originalEnv;
  let fixtureDir, nonManifestDir, tmpRoot;

  before(() => {
    originalEnv = process.env.BROWSER_EXTENSIONS;
    tmpRoot = path.join(os.tmpdir(), 'mythos-test-bug115-' + crypto.randomBytes(4).toString('hex'));
    fixtureDir = path.join(tmpRoot, 'ublock-fixture');
    nonManifestDir = path.join(tmpRoot, 'not-an-extension');
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.mkdirSync(nonManifestDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'fixture', version: '1.0' }));
    // nonManifestDir deliberately has no manifest.json — a real directory that
    // is NOT an unpacked extension.
  });

  after(() => {
    process.env.BROWSER_EXTENSIONS = originalEnv;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('unset/empty BROWSER_EXTENSIONS -> unchanged default behavior, zero extensions', () => {
    delete process.env.BROWSER_EXTENSIONS;
    assert.deepEqual(parseBrowserExtensionsEnv(), []);
    assert.deepEqual(resolveBrowserExtensions(), { ok: true, dirs: [] });

    process.env.BROWSER_EXTENSIONS = '   ';
    assert.deepEqual(parseBrowserExtensionsEnv(), [], 'whitespace-only counts as unset');
    assert.deepEqual(resolveBrowserExtensions(), { ok: true, dirs: [] });

    // The result must NEVER claim an extension is active for a profile that
    // loaded none.
    const result = buildLaunchResult('chrome', { mode: 'launched', pageCount: 1 }, '/fake/profile-dir', []);
    assert.deepEqual(result.extensionsLoaded, []);
    const args = buildBrowserLaunchArgs('/fake/profile-dir', []);
    assert.ok(!args.some((a) => a.startsWith('--load-extension')), 'no extension flags when none configured');
    assert.ok(!args.some((a) => a.startsWith('--disable-extensions-except')));
  });

  test('a real (test-fixture) unpacked extension dir -> resolved, both launch flags built, result reports it loaded', () => {
    process.env.BROWSER_EXTENSIONS = fixtureDir;
    const resolved = resolveBrowserExtensions();
    assert.deepEqual(resolved, { ok: true, dirs: [fixtureDir] });

    const profileDir = '/fake/profile-dir';
    const args = buildBrowserLaunchArgs(profileDir, resolved.dirs);
    assert.ok(args.includes(`--load-extension=${fixtureDir}`), 'must pass --load-extension');
    assert.ok(args.includes(`--disable-extensions-except=${fixtureDir}`), 'must ALSO pass --disable-extensions-except (Chromium ignores --load-extension alone)');

    const result = buildLaunchResult('chrome', { mode: 'launched', pageCount: 1 }, profileDir, resolved.dirs);
    assert.equal(result.profileDir, profileDir, 'result must report which profile directory was used');
    assert.deepEqual(result.extensionsLoaded, [fixtureDir], 'result must report exactly the verified dir(s) that were loaded');
  });

  test('multiple extension dirs, semicolon-separated -> comma-joined into a single Chromium flag value', () => {
    const secondDir = path.join(tmpRoot, 'second-fixture');
    fs.mkdirSync(secondDir, { recursive: true });
    fs.writeFileSync(path.join(secondDir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'second', version: '1.0' }));
    process.env.BROWSER_EXTENSIONS = `${fixtureDir};${secondDir}`;

    const resolved = resolveBrowserExtensions();
    assert.deepEqual(resolved, { ok: true, dirs: [fixtureDir, secondDir] });
    const args = buildBrowserLaunchArgs('/fake/profile-dir', resolved.dirs);
    assert.ok(args.includes(`--load-extension=${fixtureDir},${secondDir}`));
    assert.ok(args.includes(`--disable-extensions-except=${fixtureDir},${secondDir}`));
  });

  test('a configured directory with no manifest.json is rejected — not a real unpacked extension', () => {
    process.env.BROWSER_EXTENSIONS = nonManifestDir;
    const resolved = resolveBrowserExtensions();
    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /manifest\.json/i);
    assert.match(resolved.error, new RegExp(nonManifestDir.replace(/[\\]/g, '\\\\')));
  });

  test('a configured path that does not exist on disk -> fails loudly, names the missing path', () => {
    const missing = path.join(tmpRoot, 'does-not-exist-at-all');
    process.env.BROWSER_EXTENSIONS = missing;
    const resolved = resolveBrowserExtensions();
    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /does not exist/i);
    assert.ok(resolved.error.includes(missing), 'must name the exact missing path, not a generic error');
  });

  test('browser_launch_debug itself fails LOUDLY before any spawn when BROWSER_EXTENSIONS names a missing path', async () => {
    const missing = path.join(tmpRoot, 'still-does-not-exist');
    process.env.BROWSER_EXTENSIONS = missing;

    const result = await browser_launch_debug({});
    // This must be the extension-validation failure specifically, not some
    // other unrelated failure (e.g. "already online" from a prior test run
    // leaving state behind) — assert on the exact message shape.
    assert.equal(result.ok, false);
    assert.match(String(result.result), /BROWSER_EXTENSIONS/);
    assert.ok(String(result.result).includes(missing));
  });
});
