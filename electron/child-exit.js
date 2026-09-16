'use strict';

// child-exit.js — ask a spawned child to stop, wait for it to actually be gone,
// and tree-kill it if it will not.
//
// Extracted from electron/main.js so it can be tested for BEHAVIOUR rather than
// shape. main.js requires `electron`, so node --test can only ever make
// source-shape assertions about it — and on 2026-08-13 that was not enough: the
// first version of this function read main.js's module-level `child`, which
// stopChild() had just set to null, so it resolved instantly and waited for
// nothing. Every order assertion around it stayed green.
//
// WHY IT MATTERS: this is what an update waits on before handing the machine to
// the NSIS installer. The server child is forked from process.execPath (so it IS
// a MYTHOS.exe holding the executable open) and its cwd is inside
// resources/app.asar.unpacked/mythos — a directory Windows will not let the
// uninstaller rename while a process sits in it. If this resolves early, the
// uninstaller fails and the update rolls back, which is exactly the bug three
// 0.1.7 updates died of.
//
// BUG-437 (2026-09-16). Until this change the ordinary quit path was
// `child.kill()` THEN awaitChildExit(). On Windows, Node's child.kill() is
// TerminateProcess: no signal is delivered and no handler runs, so the server's
// lifecycle shutdown steps (stop-loops, episodic-flush, checkpoint-write,
// audit-flush) had never once run from a GUI quit on Windows, and the escalation
// here was a bare SIGKILL of the direct child — grandchildren (pc-child
// PowerShell, piper, edge-tts, an in-flight dsh task) were left to the 10 s quit
// watchdog, which only fires when the quit wedges. Two things changed:
//   * stopChildGracefully() SENDS {channel:'mythos:shutdown'} over the fork IPC
//     channel, WAITS, and only then escalates. Sending and killing in the same
//     tick would still terminate abruptly (the 2026-09-16 review's correction).
//     lifecycle.registerShutdown() answers the message with the same body as
//     SIGTERM and ends in process.exit(0).
//   * the escalation is killTree(): `taskkill /PID <pid> /T /F` on win32, the
//     same command the watchdog already used, so a wedged server takes its
//     grandchildren with it. Proven against a real node parent + grandchild in
//     test/bug-437-graceful-quit-then-tree-kill.test.js (f).
//
// THE DEADLINES, and why these numbers. lifecycle.shutdown(timeoutMs) hard-exits
// with code 1 at timeoutMs; main.js's quit watchdog fires at 10000 and
// app.exit()s. So: the request carries 6000, this module escalates at 7000, and
// the watchdog stays at 10000 — 3 s of margin at each step, so the graceful path
// finishes before the next backstop cuts it short. Pinned in test (k).
const SHUTDOWN_REQUEST_MS = 6000;
const CHILD_EXIT_DEADLINE_MS = 7000;

// Kill `child` and everything it spawned. Never throws. `deps.spawn` and
// `deps.platform` exist for tests; production passes neither.
//
// win32: taskkill /T is the only tree kill the platform offers — a bare kill()
// reaches one process. Elsewhere: the process-group convention (works when the
// child was spawned detached) and otherwise SIGKILL on the child itself, which
// is the best a non-group-leader allows; on POSIX the graceful path above has
// already run the server's own stop-loops, so the grandchildren are its job.
function killTree(child, log, deps) {
  const note = typeof log === 'function' ? log : () => {};
  const platform = (deps && deps.platform) || process.platform;
  const spawnFn = (deps && deps.spawn) || require('node:child_process').spawn;
  const pid = child && child.pid;
  try {
    if (platform === 'win32' && pid) {
      const killer = spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      if (killer && typeof killer.on === 'function') {
        killer.on('error', (err) => note('child-exit: taskkill failed: ' + (err && err.message)));
      }
      // unref: a best-effort killer must not hold the (quitting) parent open.
      if (killer && typeof killer.unref === 'function') killer.unref();
      return;
    }
    if (pid && platform !== 'win32') {
      try { process.kill(-pid, 'SIGKILL'); return; } catch (_) { /* not a group leader — fall through */ }
    }
    if (child && typeof child.kill === 'function') { child.kill('SIGKILL'); return; }
    if (pid) process.kill(pid, 'SIGKILL');
  } catch (err) {
    note('child-exit: tree-kill failed: ' + (err && err.message));
  }
}

// Resolves when `pending` has exited. Never rejects, and never waits forever: at
// the deadline it tree-kills and resolves anyway, because a stuck child must not
// be able to block an update either.
//
// `pending` is passed in, never read from a module-level variable — see above.
function awaitChildExit(pending, timeoutMs, log, deps) {
  const note = typeof log === 'function' ? log : () => {};
  return new Promise((resolve) => {
    // No child, or one that has already exited: node keeps exitCode/signalCode
    // null until then, and 'exit' will never fire again for a dead child.
    if (!pending || pending.exitCode !== null || pending.signalCode !== null) return resolve();

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };

    pending.once('exit', finish);

    const timer = setTimeout(() => {
      if (done) return;
      note('child-exit: the server child did not exit in ' + timeoutMs + 'ms — tree-killing it');
      killTree(pending, note, deps);
      finish();
    }, timeoutMs);
    // BUG-259 class fix (2026-08-16): this timer must stay REF'D. Unref'd, the
    // deadline never fires in a process with nothing else holding the event
    // loop — exactly the quiet-runner condition — so awaitChildExit would hang
    // forever, defeating the "never waits forever: escalates and resolves
    // anyway" contract above. A ref'd timer fires at timeoutMs and closes its
    // handle; the only case unref ever changed was a stuck child delaying
    // process exit by at most the deadline, which is this function's designed
    // behavior anyway. (CI was red for three days on this class: the Node 22
    // test-runner child drained its loop, the pending test was killed, and its
    // siblings cascaded to cancelledByParent.)
  });
}

// The ordinary quit path (BUG-437). Request first; kill() only when there is no
// channel to request over (already disconnected, or send() throws); tree-kill
// only at the deadline. Returns the exit promise — sync callers may ignore it,
// the escalation is timer-driven and needs no awaiter to make progress.
function stopChildGracefully(child, log, deps) {
  const note = typeof log === 'function' ? log : () => {};
  if (!child) return Promise.resolve();
  let sent = false;
  try {
    if (typeof child.send === 'function' && child.connected !== false) {
      child.send({ channel: 'mythos:shutdown', timeoutMs: SHUTDOWN_REQUEST_MS });
      sent = true;
    }
  } catch (err) {
    note('child-exit: shutdown request failed to send (' + (err && err.message) + ') — falling back to kill()');
  }
  if (!sent) { try { child.kill(); } catch (err) { note('child-exit: kill() failed: ' + (err && err.message)); } }
  return awaitChildExit(child, CHILD_EXIT_DEADLINE_MS, note, deps);
}

module.exports = { awaitChildExit, killTree, stopChildGracefully, SHUTDOWN_REQUEST_MS, CHILD_EXIT_DEADLINE_MS };
