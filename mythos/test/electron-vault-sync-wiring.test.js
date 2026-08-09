'use strict';

// electron/main.js — the vault-sync lifecycle wiring.
//
// Source-shape assertions, which root CLAUDE.md establishes as the only automated
// guard available for this file: unit tests inject fakes and are blind to load
// order, and a green suite cannot tell you the app boots.
//
// What is pinned here is ORDER, because order is the entire correctness of this
// feature and both directions fail silently:
//   - the pull must land BEFORE the server child starts, or the other machine's
//     memory is read only on the following launch;
//   - the push must happen AFTER the child stops, or a half-written episodic line
//     gets committed as "synced".
// Plus the two properties that keep it from becoming a liability: it must be
// time-boxed, and it must resolve the vault root the same way startChild() does.
//
// Run: cd mythos && node --test test/electron-vault-sync-wiring.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readMainJs() {
  return fs.readFileSync(path.join(REPO_ROOT, 'electron', 'main.js'), 'utf8');
}

// Strip `//` line comments before looking for CALLS. Learned the hard way while
// writing this file: the comment above the pull says "BEFORE startChild()", so a
// naive indexOf found startChild in the prose and reported the order backwards.
// This repo has the same bug shape on record elsewhere (a `/api/*` inside a `//`
// comment read as a block-comment opener and blanked a whole file for a scanner).
// A source-shape assertion has to look at code.
function codeOnly(text) {
  return text.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('the vault is pulled BEFORE the server child starts', () => {
  const text = readMainJs();
  const ready = /app\.whenReady\(\)\.then\(async \(\) => \{([\s\S]*?)\n {4}\/\/ ---/.exec(text)
    || /app\.whenReady\(\)\.then\(async \(\) => \{([\s\S]{0,600})/.exec(text);
  assert.ok(ready, 'could not locate the whenReady block');
  const readyCode = codeOnly(ready[1]);
  const pullAt = readyCode.indexOf("syncVault('--pull')");
  const startAt = readyCode.indexOf('startChild()');
  assert.notEqual(pullAt, -1, 'whenReady must pull the vault');
  assert.notEqual(startAt, -1, 'whenReady must start the child');
  assert.ok(pullAt < startAt,
    'the pull must precede startChild(): the child builds the memory facade over the vault as it boots, ' +
    'so a later pull is only read on the NEXT launch — the exact "the other machine\'s work is not here" bug');
});

test('the vault is pushed on quit, AFTER the child is stopped', () => {
  const text = readMainJs();
  const block = /app\.on\('before-quit', \(\) => \{([\s\S]*?)\n {2}\}\);/.exec(text);
  assert.ok(block, 'could not locate the before-quit handler');
  const quitCode = codeOnly(block[1]);
  const stopAt = quitCode.indexOf('stopChild()');
  const pushAt = quitCode.indexOf("syncVault('--push')");
  assert.notEqual(pushAt, -1, 'quitting must push the vault, or a session\'s memory never leaves the machine');
  assert.ok(stopAt !== -1 && stopAt < pushAt,
    'the push must follow stopChild(), so the vault is not being written while it is committed');
});

test('syncVault is time-boxed and cannot fail a boot', () => {
  const text = readMainJs();
  const fn = /function syncVault\(flag\) \{[\s\S]*?\n\}/.exec(text);
  assert.ok(fn, 'syncVault must exist as a named function');
  assert.match(fn[0], /timeout:\s*\d+/,
    'git against an unreachable host can sit in DNS well past its own timeout — a boot that hangs is worse ' +
    'than memory that arrives one launch late');
  assert.match(fn[0], /try \{/, 'the whole body must be guarded — sync is a feature, not a precondition');
  assert.match(fn[0], /spawnSync/,
    'deliberately synchronous: Electron does not wait for async work in before-quit, so an await there would ' +
    'simply not happen');
});

test('syncVault resolves the vault root exactly as startChild does', () => {
  const text = readMainJs();
  const fn = /function syncVault\(flag\) \{[\s\S]*?\n\}/.exec(text)[0];
  // The bug this pins: called with only explicitEnv, resolveVaultRoot path.joins
  // an undefined userDataDir and throws — and syncVault's own catch would swallow
  // it, so sync would silently never run on a default install, which is everyone.
  assert.match(fn, /userDataDir:\s*app\.getPath\('userData'\)/,
    'without userDataDir the resolve throws and the sync silently no-ops for every default install');
  assert.match(fn, /explicitEnv:\s*process\.env\.MYTHOS_VAULT_ROOT/,
    'an operator-set vault root must still win');
});

test('the sync script it calls actually exists at the path main.js uses', () => {
  const text = readMainJs();
  const fn = /function syncVault\(flag\) \{[\s\S]*?\n\}/.exec(text)[0];
  assert.match(fn, /'mythos',\s*'scripts',\s*'vault-sync\.js'/,
    'the path is asserted here so a moved/renamed script fails a test rather than silently disabling sync');
  assert.equal(
    fs.existsSync(path.join(REPO_ROOT, 'mythos', 'scripts', 'vault-sync.js')),
    true,
    'main.js guards on existsSync, so a missing script is a SILENT no-op — this is the only thing that would notice'
  );
});
