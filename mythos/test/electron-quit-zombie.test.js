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

test('BUG-225 / window-all-closed sets isQuitting BEFORE stopChild()', () => {
  const body = handlerBlock("app.on('window-all-closed'", "app.on('before-quit'");
  const flagAt = body.indexOf('isQuitting = true');
  const stopAt = body.indexOf('stopChild()');
  assert.ok(flagAt !== -1, 'window-all-closed must set isQuitting itself — before-quit runs only after app.quit(), i.e. AFTER this handler');
  assert.ok(stopAt !== -1 && flagAt < stopAt,
    'the flag must precede the kill: in the other order the exit handler sees isQuitting === false during the gap and re-forks inside the quit window');
});

test('BUG-225 / window-all-closed does not quit on darwin, and does not set isQuitting there either', () => {
  const body = handlerBlock("app.on('window-all-closed'", "app.on('before-quit'");
  const guard = body.match(/if \(process\.platform !== 'darwin'\) isQuitting = true/);
  assert.ok(guard,
    'on darwin window-all-closed does not quit, so setting isQuitting there would strand a live app whose exit handler refuses to restart the server');
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

test('BUG-225 / stopChild returns the awaitChildExit ladder, not a bare kill()', () => {
  const body = handlerBlock('function stopChild(', 'function armQuitWatchdog(');
  const captureAt = body.indexOf('const dying = child');
  const killAt = body.indexOf('dying.kill()');
  const ladderAt = body.indexOf('awaitChildExit(dying');
  assert.ok(captureAt !== -1 && killAt !== -1 && captureAt < killAt,
    'the dying child must be captured BEFORE `child = null` — the ladder takes it explicitly, the same lesson electron-child-exit.test.js pins for beginInstall');
  assert.ok(ladderAt !== -1,
    'the ordinary close path must use the SAME escalation (SIGKILL at the 3s deadline) the update handover already had');
  assert.match(body, /child = null/, 'the module-level reference is still cleared synchronously — sync callers depend on that');
});

// ---- 4. the hard-exit backstop -------------------------------------------------

test('BUG-225 / before-quit arms a quit watchdog BEFORE anything that can block', () => {
  const body = handlerBlock("app.on('before-quit'", "app.on('will-quit'");
  const pidAt = body.indexOf('const dyingPid = child');
  const armAt = body.indexOf('armQuitWatchdog(dyingPid)');
  const pushAt = body.lastIndexOf("syncVault('--push')");
  assert.ok(pidAt !== -1 && armAt !== -1,
    'before-quit must capture the child pid before stopChild() nulls it and arm the watchdog with it');
  assert.ok(pushAt === -1 || armAt < pushAt,
    'the vault push is a BLOCKING spawnSync with a 15s budget — a backstop armed after the wedge can never fire');
});

test('BUG-225 / the watchdog tree-kills and force-exits, with a REF’d 10s timer', () => {
  const body = handlerBlock('function armQuitWatchdog(', '\nfunction ');
  const timerAt = body.indexOf('setTimeout(');
  assert.ok(timerAt !== -1, 'the watchdog is timer-driven');
  assert.match(body.slice(timerAt), /,\s*10000\s*\)/,
    '10s, mirroring the child’s own SHUTDOWN_MS design (schema default 10000) — graceful shutdown gets a real budget');
  assert.doesNotMatch(body, /\.unref\(\)/,
    'an unref’d deadline never fires in a drained process — the BUG-259 lesson, applied to this timer too');
  assert.match(body, /taskkill/, 'win32 must tree-kill: the forked server leaves piper and pc-child grandchildren a bare kill() never reaches');
  assert.match(body, /\/T/, 'and /T is what makes taskkill a TREE kill');
  assert.match(body, /app\.exit\(0\)/,
    'the backstop must exit the process — this is the ONE place app.exit is correct, because before-quit has already run by the time it fires');
});

// ---- the flag separation the re-fork fix forced --------------------------------

test('BUG-225 / the vault-push skip keys off installerHandover, not isQuitting', () => {
  const before = handlerBlock("app.on('before-quit'", "app.on('will-quit'");
  assert.match(before, /const handedOverToInstaller = installerHandover/,
    'before-quit used to infer "the installer handover already pushed" from isQuitting being pre-set; window-all-closed now pre-sets isQuitting on every ordinary quit, which would skip the vault push EVERY time');

  const begin = handlerBlock('function beginInstall(', 'function promptInstall(');
  const quitAt = begin.indexOf('isQuitting = true');
  const handAt = begin.indexOf('installerHandover = true');
  assert.ok(quitAt !== -1 && handAt !== -1,
    'beginInstall must still set both: isQuitting stops restarts, installerHandover marks the handover');
});
