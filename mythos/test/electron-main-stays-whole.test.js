'use strict';

// test/electron-main-stays-whole.test.js — audit item 13, Phase 6 (2026-08-22).
//
// Item 13 said two files are far over the 800-line house limit and asked for
// mythos/server/index.js to be split. It asked for the opposite for
// electron/main.js: leave it whole, write down why, and pin it — this repo's
// rule being that a deliberate NON-fix gets a test like any other decision,
// rather than surviving as an unexplained exception nobody dares touch.
//
// WHY IT STAYS WHOLE. Several Electron exports are lazy getters that throw
// until the app emits 'ready', and reading the property is enough to trigger
// it. The cursor-overlay slice proved that here: it shipped with a walked
// installer artefact and 2,598 green tests, and the shell would not start —
// `Error: The 'screen' module can't be used before the app 'ready' event` —
// because a defensive `typeof x.method !== 'function'` check touched the getter.
// Splitting a file moves requires, and moving requires is precisely what
// changes when those getters are first read. The suite is blind to it: unit
// tests inject a fake `screen`, so they stay green while the packaged app is
// dead on launch.
//
// WHAT THIS FILE ACTUALLY GUARDS. Not "the file must be one file" — that would
// be a rule with no failure mode worth catching. It guards the two things a
// careless split would break:
//
//   1. the decision comment is still in electron/main.js, so anyone splitting
//      it has to delete the explanation of why not to, deliberately;
//   2. the ready-gated Electron APIs are still required lazily at their use
//      sites rather than destructured at module scope.
//
// Note on the deny list: `screen`, `session` and `desktopCapturer` are lazily
// required in the file today (three real call sites). `powerMonitor` is NOT
// used anywhere yet — it is on the list as a forward guard, because it is
// ready-gated in the same way and the next person reaching for it will reach
// for the module-scope destructure first. `globalShortcut` and `safeStorage`
// are deliberately NOT on the list: both are destructured at module scope today
// and both work, so listing them would make this guard red on arrival, and a
// guard that is red on arrival gets muted rather than obeyed.
//
// electron-cursor-overlay.test.js already pins `screen` specifically, as part of
// that slice. This generalises the rule and ties it to the size decision.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_PATH = path.join(__dirname, '..', '..', 'electron', 'main.js');
const MAIN = fs.readFileSync(MAIN_PATH, 'utf8');

// Everything before the app actually starts. Anything evaluated here runs
// before 'ready'.
function moduleScope() {
  const readyAt = MAIN.indexOf('app.whenReady()');
  assert.ok(readyAt > 0, "could not find app.whenReady() in electron/main.js — re-point this test");
  return MAIN.slice(0, readyAt);
}

const READY_GATED = ['screen', 'session', 'desktopCapturer', 'powerMonitor'];

test('electron/main.js still carries the written reason it is not split', () => {
  assert.match(MAIN, /THIS FILE IS DELIBERATELY NOT SPLIT/,
    'the decision comment is gone from electron/main.js. If the file is being split on purpose, that '
    + 'is a real decision and this test should be deleted in the same commit — but it must not '
    + 'disappear by accident, because the reason it stays whole is a class of bug no test can see.');
  assert.match(MAIN, /can't be used before the app 'ready' event|before app\.ready|whenReady/,
    'the comment no longer explains the load-order trap, which is the entire reason for the exception');
  assert.match(MAIN, /file-size-ratchet|ratchet/,
    'the comment should point at the size ratchet that records this file as an accepted exception');
});

test('ready-gated Electron APIs are never destructured at module scope', () => {
  const scope = moduleScope();
  const offenders = [];
  for (const api of READY_GATED) {
    // The exact shape that crashed the app: pulled off require('electron') in a
    // destructure that runs at load time.
    const re = new RegExp('(?:const|let|var)\\s*\\{[^}]*\\b' + api + '\\b[^}]*\\}\\s*=\\s*require\\(\'electron\'\\)');
    if (re.test(scope)) offenders.push(api);
  }
  assert.deepEqual(offenders, [],
    'these Electron exports throw when read before the app is ready, so they must be required at '
    + 'their use site instead of at module scope: ' + offenders.join(', '));
});

test('the APIs that are used are used lazily, so the rule above is not vacuous', () => {
  // Without this, deleting every use of `session`/`desktopCapturer`/`screen`
  // would make the guard above pass for the wrong reason — nothing to find.
  const inUse = ['screen', 'session', 'desktopCapturer'];
  for (const api of inUse) {
    const lazy = new RegExp('(?:const|let|var)\\s*\\{[^}]*\\b' + api + '\\b[^}]*\\}\\s*=\\s*require\\(\'electron\'\\)');
    const afterReady = MAIN.slice(MAIN.indexOf('app.whenReady()'));
    assert.ok(lazy.test(afterReady),
      api + ' is no longer required lazily anywhere in electron/main.js. Either it was removed — in '
      + 'which case drop it from this list — or it moved to module scope, which the previous test '
      + 'should have caught.');
  }
});

test('electron/main.js is still the app entry point, not a stub that re-exports a split', () => {
  // A split would most likely leave a thin main.js requiring ./main/*.js. The
  // decision is that the lifecycle stays here.
  assert.match(MAIN, /app\.whenReady\(\)/, 'the app lifecycle no longer starts in electron/main.js');
  assert.doesNotMatch(MAIN, /require\('\.\/main\/[a-z-]+'\)/,
    'electron/main.js appears to delegate to a ./main/ directory — that is the split this file '
    + 'exists to prevent. If it was intentional, delete this test in the same commit and say why.');
});
