'use strict';

// test/electron-vault-wiring.test.js — B3 wiring guard for electron/main.js.
//
// The migration logic itself is unit-tested for real in
// test/vault-migration.test.js (electron/vault-migration.js has no
// `require('electron')`). main.js does, so it cannot be require()d under a
// bare `node --test` (it calls app.whenReady() at load) — source-shape
// assertions are the guard, same pattern as electron-adblock-fallback.test.js
// and electron-cursor-overlay.test.js's Layer 2.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const MAIN = fs.readFileSync(path.join(REPO_ROOT, 'electron', 'main.js'), 'utf8');

test('B3 / electron: wires the real vault-migration module', () => {
  assert.match(MAIN, /require\(['"]\.\/vault-migration['"]\)/,
    'main.js must require the extracted, unit-testable vault-migration module');
});

test('B3 / electron: fork() resolves the vault via resolveVaultRoot and never re-derives it inline', () => {
  const startIdx = MAIN.indexOf('function startChild');
  assert.ok(startIdx > -1, 'startChild must exist');
  const forkIdx = MAIN.indexOf('child_process.fork(', startIdx);
  assert.ok(forkIdx > -1, 'startChild must fork the server');
  const block = MAIN.slice(startIdx, forkIdx + 400);

  assert.match(block, /resolveVaultRoot\(\{/, 'the vault root must come from resolveVaultRoot(), not an inline literal');
  assert.match(block, /explicitEnv:\s*process\.env\.MYTHOS_VAULT_ROOT/,
    'the operator\'s own explicit env value must be passed through so it always wins');
  assert.match(block, /userDataDir:\s*app\.getPath\('userData'\)/,
    'must resolve under app.getPath(\'userData\'), matching keys.json/the server log/the adblock cache');
  assert.match(block, /MYTHOS_VAULT_ROOT:\s*vaultRoot/, 'the resolved root must actually reach the child env');
});

test('B3 / electron: startChild (the only caller) is never invoked before app.whenReady()', () => {
  // startChild's own body reads app.getPath('userData') now (via
  // resolveVaultRoot), matching storePath()/childLogPath()'s existing
  // pattern — those are also *defined* ahead of app.whenReady() textually
  // but only ever *called* from inside it. What actually matters is the
  // call site, not the definition site.
  const readyIdx = MAIN.indexOf('app.whenReady()');
  const moduleScope = MAIN.slice(0, readyIdx);
  assert.doesNotMatch(moduleScope, /^\s*startChild\(\)/m,
    'startChild() must not be invoked at module scope, before app is ready');
  const readyBlock = MAIN.slice(readyIdx);
  assert.match(readyBlock, /startChild\(\)/, 'startChild() must be called from inside app.whenReady()');
});
