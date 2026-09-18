'use strict';

// quit-sequence.js — one shutdown, held open until it is actually finished.
//
// BUG-437 (2026-09-18), the sub-defect the 2026-09-16 attended run found inside
// the 2026-09-16 fix. That fix gave the shell a real ladder: ask the server to
// stop over IPC, wait CHILD_EXIT_DEADLINE_MS, then tree-kill. Nothing awaited
// it. `window-all-closed` called stopChild() and then app.quit(); `before-quit`
// called stopChild() and returned. Electron terminates as soon as a before-quit
// handler returns without preventDefault, so the shell was gone 0.47 s after
// sending the request:
//
//   lifecycle.shutdown.step step:stop-loops status:ok   <- then nothing
//   app quit: orderly exit, code=0                      <- 0.47 s after the request
//   Checkpoints/latest.json                             <- 13 s stale
//
// The 7 s wait never ran, the escalation behind it was unreachable from a GUI
// quit, and the child's stdout pipe died with the shell — which is why its log
// stops at step one rather than at lifecycle.shutdown.complete.
//
// WHY A MODULE. electron/main.js requires `electron` and cannot be require()d
// under node --test, so anything living there can only ever be asserted on by
// reading its source. That is how a ladder with five behavioural tests ended up
// never running in production: every test was about child-exit.js, and the
// defect was in the two lines that called it. This file is pure — no electron
// import, every side effect injected — so the ORDER and the WAITING are
// behaviour-testable, which is the part that was broken.
//
// THE STATES. idle -> stopping -> finished, and they are not decorative:
//
//   idle       no quit has been requested
//   stopping   one shutdown is running; every further quit request joins it
//              rather than starting a second, and must still preventDefault or
//              Electron terminates underneath the one already in flight
//   finished   cleanup has run and the process is exiting; a request here is
//              not held, because there is nothing left to hold it for
//
// THE BUDGET, and why these numbers. The BUG-225 watchdog stays at 10 s and
// stays the outer backstop. Inside it:
//
//   snapshot      <= 1000 ms   (process-tree.js, bounded there)
//   child stop    <= 7000 ms   (CHILD_EXIT_DEADLINE_MS, child-exit.js)
//   verify        <= 1000 ms   (process-tree.js, bounded there)
//   cleanup        = 1000 ms reserved, never spent on anything else
//                   ---------
//                   10000 ms
//
// So the worst case lands exactly on the watchdog rather than past it, and the
// vault push gets the time the normal case leaves over — which is almost all of
// it, because a healthy child exits in well under a second. Pinned in test (k).

const DEFAULT_TOTAL_BUDGET_MS = 10000;
const DEFAULT_CLEANUP_RESERVE_MS = 1000;

function createQuitSequence(deps) {
  const d = deps || {};
  const log = typeof d.log === 'function' ? d.log : () => {};
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const setTimer = typeof d.setTimer === 'function' ? d.setTimer : setTimeout;
  const clearTimer = typeof d.clearTimer === 'function' ? d.clearTimer : clearTimeout;
  const totalBudgetMs = Number.isFinite(d.totalBudgetMs) ? d.totalBudgetMs : DEFAULT_TOTAL_BUDGET_MS;
  const cleanupReserveMs = Number.isFinite(d.cleanupReserveMs) ? d.cleanupReserveMs : DEFAULT_CLEANUP_RESERVE_MS;

  let state = 'idle';
  let running = null;
  let watchdog = null;
  // Set once the child has been reaped (its own exitCode/signalCode is no
  // longer null). It gates the watchdog's tree-kill: see armWatchdog.
  let childReaped = false;
  let childPid = null;

  function call(name, fn, ...args) {
    // A cleanup step that throws must never leave the shutdown unresolved —
    // that is the wedge this whole file exists to end, arriving by a different
    // door. Loud in the log, fatal to nothing.
    try { return typeof fn === 'function' ? fn(...args) : undefined; } catch (err) {
      log('quit-sequence: ' + name + ' failed — ' + (err && err.message));
      return undefined;
    }
  }

  async function callAsync(name, fn, ...args) {
    try { return typeof fn === 'function' ? await fn(...args) : undefined; } catch (err) {
      log('quit-sequence: ' + name + ' failed — ' + (err && err.message));
      return undefined;
    }
  }

  // BUG-225's backstop, moved here so it shares the state the rest of the
  // sequence keeps. Two things changed with the move, both deliberate:
  //
  //  * it is CLEARED when the sequence finishes. It used to be left to die with
  //    the process, which was fine when the process always died; now that the
  //    sequence owns the exit, a live timer would fire into a finished
  //    sequence.
  //  * it does NOT tree-kill a child that has already been reaped. The pid it
  //    holds is a bare number, and once node has reaped the child Windows is
  //    free to hand that number to somebody else. Killing it then would tree-
  //    kill an unrelated process — a real hazard on the one path that can reach
  //    here with the child already gone (the child exits, the vault push
  //    wedges, the watchdog fires). Making the kill unreachable in that state
  //    is cheaper than rechecking an identity under a deadline.
  function armWatchdog() {
    watchdog = setTimer(() => {
      log('quit watchdog: graceful quit did not complete in ' + totalBudgetMs + 'ms — exiting');
      if (childPid && !childReaped) {
        log('quit watchdog: tree-killing the server child (pid ' + childPid + ')');
        call('killTree', d.killTree, { pid: childPid }, log);
      } else if (childPid) {
        log('quit watchdog: the child was already reaped — not tree-killing pid ' + childPid + ', it may have been reused');
      }
      finish(0);
    }, totalBudgetMs);
  }

  let finished = false;
  function finish(code) {
    if (finished) return;
    finished = true;
    state = 'finished';
    if (watchdog) call('clearTimer', clearTimer, watchdog);
    watchdog = null;
    // Everything app.exit() would skip. Electron's app.exit() terminates
    // without emitting will-quit, and both exits from this file are app.exit(),
    // so the process-wide accelerator claims that will-quit releases must be
    // released here or not at all.
    call('cleanup', d.cleanup);
    call('exit', d.exit, code);
  }

  async function run() {
    const deadline = now() + totalBudgetMs;
    call('setIsQuitting', d.setIsQuitting);

    const child = call('captureChild', d.captureChild) || null;
    childPid = (child && child.pid) || null;
    armWatchdog();

    // Windows that would otherwise sit on screen for the length of the
    // shutdown. Early, as before-quit did it, rather than in cleanup.
    call('closeSecondaryWindows', d.closeSecondaryWindows);

    // BEFORE the request: once the child starts tearing down, the descendants
    // we want to account for are already disappearing, and an identity we never
    // recorded cannot be verified afterwards.
    const snapshot = childPid ? await callAsync('snapshotTree', d.snapshotTree, childPid) : null;

    await callAsync('stopChild', d.stopChild, child);
    childReaped = !!(child && (child.exitCode !== null || child.signalCode !== null));

    const verdict = (await callAsync('verifyGone', d.verifyGone, snapshot))
      || { outcome: 'terminated-unconfirmed', survivors: [], reason: 'the check did not run' };
    if (verdict.outcome === 'survivors') {
      log('quit: ' + verdict.outcome + ' — ' + verdict.reason + ': '
        + verdict.survivors.map((s) => s.pid).join(', '));
    } else {
      log('quit: ' + verdict.outcome + ' — ' + verdict.reason);
    }

    await pushVault(deadline, verdict);
    finish(0);
  }

  // The vault push, no longer a blocking spawnSync on the quit path. Three
  // reasons it can be skipped, and each one says so rather than passing in
  // silence: the installer already pushed, there is no time left, or we cannot
  // say the child is gone. That last one is not fussiness — the push commits
  // the vault, and committing it while a server we failed to account for may
  // still be writing to it is how a half-written episodic line gets recorded as
  // synced. Whatever misses this window goes on the next boot's pull/push,
  // which is unchanged.
  async function pushVault(deadline, verdict) {
    if (call('isInstallerHandover', d.isInstallerHandover)) {
      log('quit: skipping the vault push — the installer handover already pushed.');
      return;
    }
    if (verdict.outcome === 'survivors' || verdict.outcome === 'terminated-unconfirmed') {
      log('quit: skipping the vault push — child termination is ' + verdict.outcome
        + ', and committing the vault under a possibly-live writer is worse than a late push.');
      return;
    }
    const budget = deadline - now() - cleanupReserveMs;
    if (budget <= 0) {
      log('quit: skipping the vault push — no budget left inside the quit deadline.');
      return;
    }
    await callAsync('pushVault', d.pushVault, { timeoutMs: budget });
  }

  return {
    // Returns true when the caller must hold the quit open. main.js's
    // before-quit handler is then one line, which is the point: the decision
    // lives somewhere a test can reach it.
    request() {
      if (state === 'finished') return false;
      if (state === 'stopping') return true;
      state = 'stopping';
      // A rejection here would leave the quit held open forever with no
      // backstop other than the watchdog — the wedge, again, by a third door.
      // Every step inside run() is already wrapped; this catches the ones that
      // are not steps (arming the timer, the awaits themselves).
      running = run().catch((err) => {
        log('quit-sequence: the shutdown threw — ' + (err && err.message));
        finish(0);
      });
      // The promise is returned for tests and for any caller that wants to
      // await it. Nothing in production does: the sequence ends by exiting.
      return true;
    },
    state() { return state; },
    whenDone() { return running || Promise.resolve(); },
  };
}

module.exports = { createQuitSequence, DEFAULT_TOTAL_BUDGET_MS, DEFAULT_CLEANUP_RESERVE_MS };
