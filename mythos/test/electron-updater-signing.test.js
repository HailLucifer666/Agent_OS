'use strict';

// test/electron-updater-signing.test.js — B6: an auto-update mechanism and a
// signing config exist now, but the operator has bought no code-signing cert
// and chosen no update host yet (see root CLAUDE.md's B6 note). So this
// asserts the SHAPE of what real code was added, not that updates/signing are
// live: config that degrades to a no-op/unsigned build when nothing is
// configured, never a config that throws or silently pretends to succeed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');

function loadPkg() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
}

test('electron-updater is a real (non-dev) dependency', () => {
  const pkg = loadPkg();
  assert.ok(pkg.dependencies && pkg.dependencies['electron-updater'],
    'electron-updater must be a runtime dependency so the packaged app can require() it');
});

test('build.publish is explicitly inert (no host chosen yet) rather than erroring a build', () => {
  const { build } = loadPkg();
  // null is electron-builder's own documented "no publishing configured" —
  // a plain `npm run dist` build never depends on a host existing, and never
  // fails to resolve one. Once a host is chosen, this is the value that
  // changes — not electron/main.js, which reads the feed URL from
  // MYTHOS_UPDATE_URL at runtime (see checkForUpdates() there).
  assert.equal(build.publish, null,
    'build.publish should stay null until an update host is actually chosen');
});

test('build.win.forceCodeSigning is false — a missing cert must not break the build', () => {
  const { build } = loadPkg();
  assert.ok(build.win, 'package.json must have a build.win block');
  assert.equal(build.win.forceCodeSigning, false,
    'forceCodeSigning:true would fail the build on Windows whenever CSC_LINK is unset — ' +
    'signing must stay opportunistic (electron-builder reads CSC_LINK/CSC_KEY_PASSWORD from ' +
    'the environment automatically; no cert present means an unsigned build, not a failed one)');
});

test('no signing secret literal is present in any tracked file', () => {
  // Grep every tracked, text-ish file this repo owns for the electron-builder
  // signing env var NAMES used as an assignment target with a real-looking
  // value — e.g. "CSC_LINK": "C:\\certs\\..." or CSC_KEY_PASSWORD=something.
  // The names themselves are fine to mention (this test does); a literal
  // value next to one is not (CLAUDE.md: secrets/keys are env-only, never
  // committed). Scoped to files this task owns plus their obvious homes.
  const candidates = [
    path.join(REPO_ROOT, 'package.json'),
    path.join(REPO_ROOT, 'electron', 'main.js'),
    path.join(REPO_ROOT, 'CONTRIBUTING.md'),
  ];
  const secretAssignment = /CSC_(LINK|KEY_PASSWORD)\s*[:=]\s*["'][^"']+["']/;
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, secretAssignment,
      `${file} must not assign a literal value to a signing env var name`);
  }
});

function readMainJs() {
  return fs.readFileSync(path.join(REPO_ROOT, 'electron', 'main.js'), 'utf8');
}

test('electron/main.js wires an update check that is a no-op without a configured host', () => {
  const text = readMainJs();
  assert.match(text, /require\(['"]electron-updater['"]\)/, 'main.js must require electron-updater');
  assert.match(text, /MYTHOS_UPDATE_URL/,
    'the update host must come from an env var (MYTHOS_UPDATE_URL), not a hardcoded URL');
  assert.match(text, /autoDownload\s*=\s*false/,
    'auto-update must not silently download/install — see CLAUDE.md\'s honest-inert house style');
  assert.doesNotMatch(text, /autoUpdater\.quitAndInstall/,
    'nothing should force-install an update without an explicit, logged operator action');
});

// electron-updater exports `autoUpdater` as a getter that CONSTRUCTS the
// platform updater on first property read, so a module-scope
// `const { autoUpdater } = require('electron-updater')` runs that constructor
// before app.whenReady(). This repo has already lost a boot to that exact
// shape (root CLAUDE.md, Slice 5: a module-scope read of `screen`, where the
// defensive check itself was the crash), and a source-shape assertion is the
// only automated guard available — unit tests inject fakes and are blind to
// load order.
// Takes the source text rather than reading the file, so the checker itself can
// be proven against a known-bad sample below instead of being trusted.
function moduleScopeUpdaterRequires(text) {
  const lines = text.split(/\r?\n/);
  const fnLine = lines.findIndex((l) => /function checkForUpdates\s*\(/.test(l));
  if (fnLine < 0) return null; // caller asserts on this
  return lines
    .map((l, i) => ({ line: l.trim(), number: i + 1, index: i }))
    .filter(({ line }) => /require\(['"]electron-updater['"]\)/.test(line) && !line.startsWith('//'))
    .filter(({ index }) => index < fnLine);
}

test('the module-scope-require checker actually catches the shape it exists to catch', () => {
  // The exact line this work started with, before it was moved to the use site.
  const knownBad = [
    "const { autoUpdater } = require('electron-updater');",
    'function checkForUpdates() {',
    '  autoUpdater.autoDownload = false;',
    '}',
  ].join('\n');
  assert.equal(moduleScopeUpdaterRequires(knownBad).length, 1,
    'a top-level require of electron-updater must be reported');

  const knownGood = [
    'function checkForUpdates() {',
    "  const { autoUpdater } = require('electron-updater');",
    '}',
  ].join('\n');
  assert.equal(moduleScopeUpdaterRequires(knownGood).length, 0,
    'a require inside checkForUpdates() must not be reported');
});

test('electron-updater is required lazily at its use site, never at module scope', () => {
  const text = readMainJs();
  const violations = moduleScopeUpdaterRequires(text);
  assert.notEqual(violations, null, 'checkForUpdates() must exist in electron/main.js');
  assert.match(text, /require\(['"]electron-updater['"]\)/, 'electron-updater must be required somewhere');
  assert.deepEqual(violations, [],
    'electron-updater must be required INSIDE checkForUpdates() (which runs after whenReady), ' +
    `not at module scope — found: ${JSON.stringify(violations)}`);
});

// The client side of "just set MYTHOS_UPDATE_URL" is true; the release side is
// not, and the first draft of this work claimed otherwise in both the code
// comment and CONTRIBUTING. electron-builder emits the `latest.yml` a generic
// feed is polled for ONLY when a publish config exists, so a release build
// needs more than the env var. Pin the honest version so it cannot quietly
// regress to the overclaim.
test('the release-side requirement for a real update feed is documented, not overclaimed', () => {
  const contributing = fs.readFileSync(path.join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8');
  assert.match(contributing, /latest\.yml/,
    'CONTRIBUTING must name latest.yml — the metadata file a generic update feed is polled for, ' +
    'which build.publish:null deliberately does not produce');
  assert.doesNotMatch(readMainJs(), /no code change, no rebuild/,
    'main.js must not claim MYTHOS_UPDATE_URL alone is sufficient — that is client-side only');
});
