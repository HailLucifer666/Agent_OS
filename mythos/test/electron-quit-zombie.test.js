'use strict';

// test/electron-quit-zombie.test.js — BUG-225, the four structural defects that
// made an X-close able to leave a windowless, single-instance-locked zombie:
//
//   1. the re-fork race (window-all-closed killed the child before anything
//      set isQuitting, so the exit handler scheduled a fresh MYTHOS.exe inside
//      the quit window);
//   2. secondary windows (media window, cursor overlay) pinning the app open —
//      before-quit never starts while window-all-closed has not fired;
//   3. the normal close path having no kill ladder — one bare kill(), while a
//      working awaitChildExit escalation existed but only the update handover
//      used it;
//   4. no hard-exit backstop — a wedged before-quit (the vault push is a
//      BLOCKING spawnSync with a 15s budget) held the process alive forever.
//
// electron/main.js requires `electron` and cannot be require()d under
// node --test, so these are SOURCE-SHAPE assertions — the same standing
// limitation and pattern as electron-update-handoff.test.js and
// electron-cursor-overlay.test.js. The kill-ladder behaviour itself is
// behaviour-tested in electron-child-exit.test.js (that is why awaitChildExit
// lives in its own module); what is pinned here is that main.js USES it on the
// ordinary quit path, in the right order, plus the wiring the shape cannot
// derive.
//
// Run: cd mythos && node --test test/electron-quit-zombie.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readMainJs() {
  return fs.readFileSync(path.join(REPO_ROOT, 'electron', 'main.js'), 'utf8');
}

// Strip `//` line comments before order assertions — same guard as
// electron-update-handoff.test.js: the prose around the quit seam says things
// like "isQuitting must be set before stopChild()" in comments, and a naive
// indexOf would match the comment and report the order backwards.
function codeOnly(text) {
  return text.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const CODE = codeOnly(readMainJs());

function handlerBlock(name, until) {
  const start = CODE.indexOf(name);
  assert.ok(start !== -1, `${name} must exist in electron/main.js`);
  const end = until ? CODE.indexOf(until, start) : CODE.indexOf('});', start);
  assert.ok(end !== -1, `the block after ${name} must be findable`);
  return CODE.slice(start, end);
}

// ---- 1. the re-fork race -------------------------------------------------------

// RE-POINTED 2026-09-18 (BUG-437). window-all-closed no longer stops the child
// itself: it sets the flag and calls app.quit(), and the stop happens once,
// inside the quit sequence that before-quit starts. The INVARIANT is unchanged
// and is what these two still assert — isQuitting is set before anything can
// reach the child's exit handler, and darwin is exempt from both.
test('BUG-225 / window-all-closed sets isQuitting BEFORE it can reach the child stop', () => {
  const body = handlerBlock("app.on('window-all-closed'", "app.on('before-quit'");
  const flagAt = body.indexOf('isQuitting = true');
  const quitAt = body.indexOf('app.quit()');
  assert.ok(flagAt !== -1, 'window-all-closed must set isQuitting itself — before-quit runs only after app.quit(), i.e. AFTER this handler');
  assert.ok(quitAt !== -1 && flagAt < quitAt,
    'the flag must precede the quit: app.quit() is what reaches before-quit, the sequence and the stop. In the other '
    + 'order the exit handler sees isQuitting === false during the gap and re-forks inside the quit window');
  assert.doesNotMatch(body.slice(body.indexOf("'darwin'") === -1 ? 0 : body.indexOf('isQuitting')), /stopChild\(/,
    'BUG-437: the non-darwin path must NOT start its own stop — two entry points starting two shutdowns is what the sequence exists to prevent');
});

test('BUG-225 / window-all-closed does not quit on darwin, and does not set isQuitting there either', () => {
  const body = handlerBlock("app.on('window-all-closed'", "app.on('before-quit'");
  const guardAt = body.indexOf("if (process.platform === 'darwin')");
  const flagAt = body.indexOf('isQuitting = true');
  assert.ok(guardAt !== -1 && flagAt !== -1 && guardAt < flagAt,
    'on darwin window-all-closed does not quit, so setting isQuitting there would strand a live app whose exit handler refuses to restart the server');
  assert.match(body.slice(guardAt, flagAt), /stopChild\(\);\s*return;/,
    'and darwin keeps its original behaviour verbatim: stop the child, leave it free to restart, never quit');
});

test('BUG-225 / startChild refuses to run once quitting has begun (destination-side guard)', () => {
  const body = handlerBlock('function startChild(', 'function stopChild(');
  const guardAt = body.indexOf('if (isQuitting)');
  const forkAt = body.indexOf('child_process.fork');
  assert.ok(guardAt !== -1 && forkAt !== -1 && guardAt < forkAt,
    'the exit handler guards at the SOURCE (exit time), but a restart scheduled in the gap can still land in startChild after the quit started — the destination needs its own guard, before the fork');
  assert.ok(/return;/.test(body.slice(guardAt, guardAt + 200)), 'and it must return, not fall through');
});

// ---- 2. secondary windows must not pin the app open ----------------------------

test('BUG-225 / the main window closed handler releases the media window and the overlay', () => {
  const body = handlerBlock("mainWindow.on('closed'", 'registerTalkHotkey()');
  assert.match(body, /mediaWindowController\.closeMediaWindow\(\)/,
    'the media window was only closed in before-quit, which never starts while it keeps window-all-closed un-fired');
  assert.match(body, /cursorOverlayController\) cursorOverlayController\.destroy\(\)/,
    'a live (even hidden) overlay window pins the app open the same way — and must stay null-guarded, it is null when disabled');
  assert.match(body, /process\.platform !== 'darwin'/,
    'on macOS the app deliberately outlives its windows; closing secondaries there would change the platform contract');
});

// ---- 3. the kill ladder on the ordinary path -----------------------------------

test('BUG-225 + BUG-437 / stopChild requests shutdown and waits, never a bare kill()', () => {
  // BUG-437 (2026-09-16): this pin used to demand `dying.kill()` followed by
  // awaitChildExit(dying, 3000). On Windows that kill() is TerminateProcess, so
  // the server's shutdown steps never ran from a GUI quit. The path is now
  // stopChildGracefully(): send mythos:shutdown -> wait 7 s -> tree-kill
  // (behaviour in test/bug-437-graceful-quit-then-tree-kill.test.js).
  // Terminator re-pointed 2026-09-18: armQuitWatchdog moved to quit-sequence.js.
  const body = handlerBlock('function stopChild(', '\nfunction syncVault(');
  const captureAt = body.indexOf('const dying = child');
  const gracefulAt = body.indexOf('stopChildGracefully(dying');
  assert.ok(captureAt !== -1 && gracefulAt !== -1 && captureAt < gracefulAt,
    'the dying child must be captured BEFORE `child = null` — the ladder takes it explicitly, the same lesson electron-child-exit.test.js pins for beginInstall');
  assert.doesNotMatch(body, /dying\.kill\(\)/,
    'BUG-437: a kill() before the request is TerminateProcess on Windows — the steps never run');
  assert.match(body, /child = null/, 'the module-level reference is still cleared synchronously — sync callers depend on that');
});

// ---- 4. the hard-exit backstop -------------------------------------------------

// RE-POINTED 2026-09-18 (BUG-437). The watchdog moved out of main.js into
// electron/quit-sequence.js, together with the shutdown it backs up, so that
// both share one set of states — and so that the backstop is finally reachable
// by node --test rather than only by reading source. What it guards is
// unchanged: armed before anything that can block, 10 s, ref'd, tree-kills,
// force-exits. The timing of the arming is now a BEHAVIOUR test
// (bug-437-quit-sequence.test.js, 'the watchdog fires at the budget and exits');
// what stays here is that main.js still delegates and no longer blocks.
test('BUG-225 + BUG-437 / before-quit does nothing that can block, and delegates the quit', () => {
  const body = handlerBlock("app.on('before-quit'");
  assert.match(body, /quitSequence\.request\(\)/,
    'the ordinary quit is started in exactly one place, and it is the place that also arms the backstop');
  assert.match(body, /event\.preventDefault\(\)/,
    'BUG-437: without this Electron terminates as soon as the handler returns — 0.47 s after the shutdown request on 2026-09-16');
  assert.doesNotMatch(body, /syncVault\(/,
    'the vault push is a BLOCKING spawnSync with a 15s budget, and a JavaScript watchdog cannot fire while it holds the loop — '
    + 'a backstop that the wedge itself disables is not a backstop');
  assert.doesNotMatch(body, /spawnSync/, 'nothing synchronous and unbounded may sit on the quit path at all');
});

test('BUG-225 + BUG-437 / the watchdog still tree-kills and force-exits, on a REF’d 10s timer', () => {
  const seq = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'quit-sequence.js'), 'utf8');
  const body = codeOnly(seq);
  assert.match(body, /DEFAULT_TOTAL_BUDGET_MS = 10000/,
    '10s, mirroring the child’s own SHUTDOWN_MS design (schema default 10000) — graceful shutdown gets a real budget');
  assert.match(body, /setTimer\(/, 'the watchdog is timer-driven');
  assert.doesNotMatch(body, /\.unref\(\)/,
    'an unref’d deadline never fires in a drained process — the BUG-259 lesson, applied to this timer too');
  assert.match(body, /killTree/,
    'win32 must tree-kill: the forked server leaves piper and pc-child grandchildren a bare kill() never reaches');
  assert.match(body, /d\.exit/,
    'the backstop must exit the process — correct here because the shutdown has already had its full budget by the time it fires');
  // The tree-kill body itself is still child-exit.js's, shared with stopChild()'s
  // deadline escalation; its /T /F shape is asserted behaviourally in
  // bug-437-graceful-quit-then-tree-kill.test.js (d) and (f).
  const childExit = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'child-exit.js'), 'utf8');
  assert.match(childExit, /taskkill/, 'the shared body is the tree kill');
  assert.match(childExit, /'\/T'/, 'and /T is what makes taskkill a TREE kill');
  // main.js must still hand it the pid — a sequence with no killTree wired in
  // would pass every assertion above and tree-kill nothing.
  assert.match(CODE, /killTree,/, 'main.js wires the shared tree-kill into the sequence');
});

// ---- the flag separation the re-fork fix forced --------------------------------

test('BUG-225 / the vault-push skip keys off installerHandover, not isQuitting', () => {
  // RE-POINTED 2026-09-18 (BUG-437): the push and its skip moved into the quit
  // sequence. The distinction this guards is the one that matters and is
  // unchanged — window-all-closed pre-sets isQuitting on EVERY ordinary quit,
  // so a skip keyed on isQuitting would skip the vault push every single time.
  assert.match(CODE, /isInstallerHandover: \(\) => installerHandover/,
    'main.js must hand the sequence the handover flag itself, not isQuitting');
  const seq = codeOnly(fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'quit-sequence.js'), 'utf8'));
  assert.match(seq, /isInstallerHandover/, 'and the sequence must be the thing that reads it');
  assert.doesNotMatch(seq, /isQuitting/,
    'the sequence must never key the push skip off the quitting flag — that is the bug this test was written for');

  const begin = handlerBlock('function beginInstall(', 'function promptInstall(');
  const quitAt = begin.indexOf('isQuitting = true');
  const handAt = begin.indexOf('installerHandover = true');
  assert.ok(quitAt !== -1 && handAt !== -1,
    'beginInstall must still set both: isQuitting stops restarts, installerHandover marks the handover');
});
