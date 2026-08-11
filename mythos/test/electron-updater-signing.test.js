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

test('build.publish targets GitHub Releases for this repo, and never carries secrets', () => {
  const { build } = loadPkg();
  // The chosen host is GitHub Releases — the repo's home — so a plain
  // `npm run dist` now also emits the `latest.yml` + blockmap that
  // electron-updater polls, and embeds app-update.yml in the packaged app.
  // Publishing itself still needs GH_TOKEN from the environment (never from
  // this file) and electron-builder's default onTagOrDraft policy means a
  // non-tag build never attempts an upload.
  assert.ok(Array.isArray(build.publish),
    'build.publish must be a publish-provider array now that a host is chosen');
  const github = build.publish.find((p) => p && p.provider === 'github');
  assert.ok(github, 'the chosen host is GitHub Releases (provider "github")');
  assert.equal(github.owner, 'HailLucifer666', 'owner must match the repo remote');
  assert.equal(github.repo, 'Agent_OS', 'repo must match the repo remote');
  // v0.1.4 (2026-08-11) went green and shipped NOTHING anyone could install:
  // electron-builder's GitHub publisher defaults to releaseType 'draft', and
  // electron-updater only ever sees PUBLISHED releases. The failure was silent in
  // both directions — the workflow logged "creating GitHub release", and a
  // read-only token reported no releases at all.
  assert.equal(github.releaseType, 'release',
    'releaseType must be explicit: the default is "draft", and a draft release is one every ' +
    'installed app reports "no update" against, forever');
  const serialized = JSON.stringify(build.publish);
  assert.doesNotMatch(serialized, /(GH_TOKEN|token|password|secret|CSC_)/i,
    'a publish config must never carry a credential — publishing reads GH_TOKEN from the environment');
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

// REVERSED 2026-08-11 (operator): this used to assert autoDownload === false and
// that quitAndInstall appeared nowhere, on the stated grounds that an unsigned
// build "gives electron-updater nothing to verify against". Reading
// node_modules/electron-updater rather than repeating the claim:
//   * NsisUpdater.verifySignature() RETURNS NULL — passes — when app-update.yml
//     carries no publisherName (out/NsisUpdater.js:84-99). Unsigned means the
//     signature check is skipped, not failed, so refusing to download bought no
//     verification at all; it only cost every release a manual reinstall.
//   * DownloadedUpdateHelper still hashes the download and compares it to the
//     sha512 in latest.yml, fetched from GitHub over HTTPS. Tampering in transit
//     fails today, signed or not.
// The residual risk — a compromised release host serving a validly-hashed
// installer — is accepted, not disproven: anyone able to publish a release on
// this public repo can already publish the source. A cert would still close it.
// What must NOT regress is the operator's consent, so that is what is pinned.
test('electron/main.js downloads updates but installs only on an explicit operator action', () => {
  const text = readMainJs();
  assert.match(text, /require\(['"]electron-updater['"]\)/, 'main.js must require electron-updater');
  assert.match(text, /app\.isPackaged/,
    'the check must be gated to packaged builds — a dev boot skips with one explicit log line instead of ' +
    'electron-updater\'s unpackaged rejection');
  assert.match(text, /MYTHOS_UPDATE_URL/,
    'the feed must stay overridable at runtime via MYTHOS_UPDATE_URL (self-hosted generic feeds)');
  assert.match(text, /autoDownload\s*=\s*true/,
    'downloading in the background is the whole point — a notice-only updater made every fix a reinstall');
  assert.match(text, /autoInstallOnAppQuit\s*=\s*false/,
    'quitting must never become an install: an operator who closes the app would return to a version ' +
    'they never agreed to');
  assert.match(text, /autoUpdater\.quitAndInstall|updaterRef\.quitAndInstall/,
    'the update must actually be installable from inside the app');
  assert.match(text, /showMessageBox/,
    'quitAndInstall must be gated behind a modal choice — a notification is dismissable by accident, ' +
    'and this one exits the app');
  assert.match(text, /MYTHOS_AUTO_UPDATE/,
    'there must be an escape hatch that turns the whole thing off');
});

test('the update state reaches the HUD as strings on one named channel, and installing takes no renderer input', () => {
  const text = readMainJs();
  assert.match(text, /mythos:update-status/,
    'the HUD renders an Update button, so main must push the updater state to it (js/update-banner.js)');
  assert.match(text, /ipcMain\.handle\('mythos:install-update'/,
    'the HUD button needs a channel to install through');
  const handler = /ipcMain\.handle\('mythos:install-update'[\s\S]*?\n\}\);/.exec(text);
  assert.ok(handler, 'the install handler must exist');
  assert.match(handler[0], /isHudContents\(event\.sender\)/,
    'only the real HUD window may trigger an install — media-window.js loads caller-supplied URLs ' +
    'through the same preload (see the B2/H6 comment in main.js)');
  assert.doesNotMatch(handler[0], /event,\s*\w+/,
    'the handler must not accept a renderer-supplied argument: which version is installed is main-process state');
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
// Appended to mythos/test/electron-updater-signing.test.js — the update
// NOTIFICATION. Source-shape assertions, which root CLAUDE.md establishes as
// the only automated guard available for electron/main.js: unit tests inject
// fakes and are therefore blind to load order, and "a slice is not verified
// until the app actually starts".

test('an available update is announced, not just logged into a file nobody opens', () => {
  const text = readMainJs();
  assert.match(text, /notifyUpdateAvailable\s*\(/,
    'update-available must reach the operator somehow — a log line in userData is honest but invisible');
  assert.match(text, /new Notification\(/,
    'the announcement is a native OS notification (see the comment for why not a HUD toast)');
});

test('Notification is required at its use site, never destructured at module scope', () => {
  const text = readMainJs();
  // The exact shape that has already cost this repo a boot: a module-scope
  // destructure of a ready-gated Electron export. `Notification` is one, so it
  // must be required inside the function, like `screen`/`session`/`desktopCapturer`.
  const moduleScopeRequire = /^const \{[^}]*\} = require\('electron'\);$/m.exec(text);
  assert.ok(moduleScopeRequire, 'main.js should still have exactly one module-scope electron require to check');
  assert.doesNotMatch(moduleScopeRequire[0], /\bNotification\b/,
    'Notification is app.ready-gated — a module-scope property read throws before whenReady (root CLAUDE.md, Slice 5)');
  assert.match(text, /const \{ Notification \} = require\('electron'\);/,
    'it must be required at the use site instead');
});

test('the notification says what is actually happening and never installs by itself', () => {
  const text = readMainJs();
  // It used to have to say "Nothing has been downloaded". Now something IS being
  // downloaded, so the body must say THAT — and must still promise that nothing
  // installs without being asked, which promptInstall() is what keeps true.
  assert.match(text, /Downloading it in the background/,
    'the body must describe the real behaviour; the old "nothing has been downloaded" is now a lie');
  assert.match(text, /you will be asked before anything is installed/i,
    'the operator must be told the install is still their call');
  const notify = /function notifyUpdateAvailable\([\s\S]*?\n}/.exec(text);
  assert.ok(notify, 'notifyUpdateAvailable must exist');
  assert.doesNotMatch(notify[0], /quitAndInstall/,
    'the notification path must not be able to install anything on its own');
});

test('a failed notification cannot take down the update check or boot', () => {
  const text = readMainJs();
  const fn = /function notifyUpdateAvailable\([\s\S]*?\n}/.exec(text);
  assert.ok(fn, 'notifyUpdateAvailable must exist as a named function');
  assert.match(fn[0], /try \{/, 'the whole body must be guarded');
  assert.match(fn[0], /isSupported\(\)/,
    'notifications are unsupported on some platforms/sessions — that is a log line, not a throw');
});
