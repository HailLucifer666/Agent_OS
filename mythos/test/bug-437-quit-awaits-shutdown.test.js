'use strict';

// test/bug-437-quit-awaits-shutdown.test.js — the sub-defect the 2026-09-16
// attended run found INSIDE the 2026-09-16 fix.
//
// WHAT WAS OBSERVED (quit 1 of 3, window X, 2026-09-16). The shell sent the
// shutdown request and then exited 0.47 s later:
//
//   server log:  lifecycle.signal signal:"ipc:mythos:shutdown"
//                lifecycle.shutdown.start
//                lifecycle.shutdown.step step:stop-loops status:ok
//                <nothing further>
//   main.log:    app quit: orderly exit, code=0        @ 11:01:20.199Z
//   vault:       Checkpoints/latest.json last written  @ 11:01:06Z  (13 s BEFORE the quit)
//
// WHY. `stopChild()` returns the stopChildGracefully() promise, and NOTHING
// AWAITS IT. `window-all-closed` calls stopChild() then app.quit(); `before-quit`
// calls stopChild() and returns. Electron is free to terminate the moment the
// handler returns, so:
//
//   * the 7 s CHILD_EXIT_DEADLINE_MS wait never runs in the real quit path;
//   * the killTree() escalation behind it is unreachable from a GUI quit —
//     it is covered by tests and by the 10 s watchdog, and by nothing else;
//   * the child's stdout pipe dies with the shell, which is why its log stops
//     at step 1 rather than at lifecycle.shutdown.complete;
//   * checkpoint-write and audit-flush do not complete.
//
// A ladder nobody waits on is not a ladder. These are SOURCE-SHAPE assertions
// for the same standing reason electron-quit-zombie.test.js records: main.js
// requires `electron` and cannot be require()d under node --test. The mechanism
// itself is behaviour-tested in bug-437-quit-sequence.test.js against the pure
// module this wiring delegates to — that split is deliberate and is why the
// module exists.
//
// BRANCH TRAVERSED (protocol STAGE 4.11): these assertions read the ordinary
// quit path in electron/main.js — the `before-quit` handler and the
// `window-all-closed` handler. They do NOT traverse the updater handover
// (beginInstall), which keeps its own awaited stop and is pinned in
// electron-update-handoff.test.js.
//
// Run: cd mythos && node --test test/bug-437-quit-awaits-shutdown.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MAIN_PATH = path.join(REPO_ROOT, 'electron', 'main.js');

// Strip `//` line comments before any order or presence assertion. The prose
// around this seam says things like "before-quit must preventDefault" in
// comments, and a naive indexOf would match the explanation instead of the
// code — the same guard electron-quit-zombie.test.js and
// electron-update-handoff.test.js already apply.
function codeOnly(text) {
  return text.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const CODE = codeOnly(fs.readFileSync(MAIN_PATH, 'utf8'));

function handlerBlock(name, until) {
  const start = CODE.indexOf(name);
  assert.ok(start !== -1, `${name} must exist in electron/main.js`);
  const end = until ? CODE.indexOf(until, start) : CODE.indexOf('});', start);
  assert.ok(end !== -1, `the block after ${name} must be findable`);
  return CODE.slice(start, end);
}

// ---- the quit must not race the shutdown it just asked for ---------------------

test('BUG-437 / before-quit takes the event and preventDefault()s the first quit', () => {
  const body = handlerBlock("app.on('before-quit'");
  assert.match(body, /app\.on\('before-quit',\s*(async\s*)?\(?\s*event\s*\)?\s*=>/,
    'the handler must receive the event — without it there is nothing to preventDefault, and Electron '
    + 'terminates as soon as the handler returns, 0.47 s after the shutdown request (2026-09-16)');
  assert.match(body, /event\.preventDefault\(\)/,
    'BUG-437: the ordinary quit must be held open while the child shuts down. Returning without '
    + 'preventDefault is what made the 7 s wait and the tree-kill escalation unreachable from a GUI quit');
});

test('BUG-437 / the quit path awaits the shutdown before exiting', () => {
  const body = handlerBlock("app.on('before-quit'");
  assert.match(body, /quitSequence\.request\(/,
    'the ordinary quit delegates to the shutdown controller — main.js cannot be require()d, so the '
    + 'behaviour lives in a pure module that node --test can actually drive');
  assert.doesNotMatch(body, /^\s*syncVault\('--push'\);/m,
    'BUG-437: the bare blocking spawnSync push must not sit on the quit path. A JavaScript watchdog '
    + 'cannot fire while spawnSync blocks the loop, so the 10 s backstop armed above it could not '
    + 'cut short the very wedge it exists for');
});

test('BUG-437 / window-all-closed hands the same controller the quit, not a fire-and-forget stop', () => {
  const body = handlerBlock("app.on('window-all-closed'", "app.on('before-quit'");
  assert.match(body, /isQuitting = true/,
    'BUG-225 ordering is unchanged: the flag precedes the stop, or the exit handler re-forks in the gap');
  assert.doesNotMatch(body, /^\s*stopChild\(\);/m,
    'BUG-437: calling stopChild() here and then app.quit() is the fire-and-forget shape. The stop is '
    + 'started and awaited in one place, so two entry points cannot run two overlapping shutdowns');
});

// ---- the cleanup that app.exit() would otherwise skip --------------------------

test('BUG-437 / shortcut cleanup is performed explicitly, not left to will-quit', () => {
  // app.exit() terminates without emitting will-quit (Electron `app` docs), and
  // the watchdog has always ended in app.exit(0). So every forced quit has been
  // leaving the process-wide accelerator claims registered until process
  // teardown. Now that the ordinary path also ends in an explicit exit, the
  // cleanup must be performed by the sequence rather than by an event that may
  // never fire.
  const seqPath = path.join(REPO_ROOT, 'electron', 'quit-sequence.js');
  assert.ok(fs.existsSync(seqPath),
    'electron/quit-sequence.js must exist — it is the module that holds the states the shape test above delegates to');
  assert.match(CODE, /cleanup:/,
    'main.js must hand the controller a cleanup callback that releases the global shortcuts');
});
