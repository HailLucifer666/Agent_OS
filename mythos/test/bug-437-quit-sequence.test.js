'use strict';

// test/bug-437-quit-sequence.test.js — the behaviour the 2026-09-16 quit path
// did not have: waiting.
//
// The ladder in electron/child-exit.js was already tested five ways and already
// correct. The defect was in the two lines that CALLED it — neither
// window-all-closed nor before-quit awaited the promise it returned, so the
// shell exited 0.47 s after sending the shutdown request and every rung below
// the first was unreachable from a real quit. That is why the sequence now
// lives in a pure module: electron/main.js requires `electron` and cannot be
// require()d here, so ordering and waiting could only ever be asserted by
// reading its source, and reading its source is exactly what missed this.
//
// BRANCH TRAVERSED (protocol STAGE 4.11). Every test below drives
// createQuitSequence() itself: the state machine, the watchdog, the budget
// arithmetic and the push skips. The wiring from main.js into it is pinned
// separately by source shape in bug-437-quit-awaits-shutdown.test.js, and the
// tree-kill body it delegates to is behaviour-tested in
// bug-437-graceful-quit-then-tree-kill.test.js. None of the three is
// sufficient alone, which is the lesson this ticket is.
//
// THE CLOCK IS MOVED BY THE TEST, NEVER FROZEN. A frozen fake clock makes every
// deadline test vacuous: the budget never elapses, so a sequence that ignores
// its budget entirely still passes. `clock.advance()` fires the timers whose
// deadline it crosses, in order, and the budget assertions below depend on it.
//
// MUTATION PROBE, run 2026-09-18, all green BEFORE this change:
//   (m1) delete the `await` in front of callAsync('stopChild', ...) in
//        quit-sequence.js — i.e. reproduce the original defect exactly.
//        => fails TWO: 'the quit is held open until the child has actually
//           stopped' with "exit must not have been called while the child was
//           still stopping", and 'the watchdog fires at the budget and exits',
//           because a sequence that does not wait has already finished and
//           cleared the timer before the budget can elapse. The second failure
//           is not noise — it is the same defect seen from the other end, and
//           recording only the first would understate what the mutation proves.
//   (m2) change the watchdog's `if (childPid && !childReaped)` to `if (childPid)`.
//        => fails 'the watchdog refuses to tree-kill a child that was already reaped'.
//   (m3) drop the `verdict.outcome === 'terminated-unconfirmed'` clause from
//        pushVault's skip.
//        => fails 'the vault push is skipped when termination could not be confirmed'.
// Each mutation was diffed before the run to confirm it applied; a mutation
// that silently fails to apply looks exactly like a guard that works.
//
// ADJACENT CASES THAT MUST KEEP PASSING (a guard nobody knows the bounds of is
// not a guard): a healthy child that exits immediately still gets its vault
// push, and the installer handover still skips the push for its own reason
// rather than for this one. Both are asserted below.
//
// Run: cd mythos && node --test test/bug-437-quit-sequence.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ELECTRON_DIR = path.resolve(__dirname, '..', '..', 'electron');
const { createQuitSequence, DEFAULT_TOTAL_BUDGET_MS, DEFAULT_CLEANUP_RESERVE_MS } =
  require(path.join(ELECTRON_DIR, 'quit-sequence.js'));
const processTree = require(path.join(ELECTRON_DIR, 'process-tree.js'));
const { CHILD_EXIT_DEADLINE_MS } = require(path.join(ELECTRON_DIR, 'child-exit.js'));

// ---- a clock the test moves ----------------------------------------------------

function makeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    pending: () => timers.size,
    advance(ms) {
      const target = t + ms;
      for (;;) {
        let next = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (!next || timer.at < next.timer.at)) next = { id, timer };
        }
        if (!next) break;
        timers.delete(next.id);
        t = next.timer.at;
        next.timer.fn();
      }
      t = target;
    },
  };
}

// A child that behaves like node's ChildProcess for the two fields the sequence
// reads. `reap()` is what node does when the process actually exits.
function fakeChild(pid) {
  return { pid, exitCode: null, signalCode: null, reap(code) { this.exitCode = code === undefined ? 0 : code; } };
}

function harness(overrides) {
  const o = overrides || {};
  const calls = [];
  const clock = o.clock || makeClock();
  const child = o.child === undefined ? fakeChild(4242) : o.child;
  const seq = createQuitSequence({
    log: (...a) => calls.push(['log', a.join(' ')]),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    setIsQuitting: () => calls.push(['setIsQuitting']),
    captureChild: () => { calls.push(['captureChild']); return child; },
    closeSecondaryWindows: () => calls.push(['closeSecondaryWindows']),
    snapshotTree: o.snapshotTree || (async (pid) => { calls.push(['snapshotTree', pid]); return { rootPid: pid, members: [] }; }),
    stopChild: o.stopChild || (async () => { calls.push(['stopChild']); if (child) child.reap(0); }),
    verifyGone: o.verifyGone || (async () => { calls.push(['verifyGone']); return { outcome: 'terminated-confirmed', survivors: [], reason: 'gone' }; }),
    pushVault: o.pushVault || (async (opts) => { calls.push(['pushVault', opts.timeoutMs]); }),
    isInstallerHandover: o.isInstallerHandover || (() => false),
    killTree: o.killTree || ((target) => calls.push(['killTree', target.pid])),
    cleanup: o.cleanup || (() => calls.push(['cleanup'])),
    exit: o.exit || ((code) => calls.push(['exit', code])),
    totalBudgetMs: o.totalBudgetMs,
    cleanupReserveMs: o.cleanupReserveMs,
  });
  return { seq, calls, clock, child, names: () => calls.map((c) => c[0]) };
}

// ---- 1. the defect itself ------------------------------------------------------

test('BUG-437 / the quit is held open until the child has actually stopped', async () => {
  let releaseStop;
  const stopped = new Promise((r) => { releaseStop = r; });
  const h = harness({ stopChild: async () => { await stopped; h.child.reap(0); } });

  assert.equal(h.seq.request(), true,
    'the first quit request must be held — returning false is what let Electron terminate underneath the shutdown');
  assert.equal(h.seq.state(), 'stopping');

  // Let every already-resolved microtask drain. If the sequence did not await
  // the stop, it would have reached exit by now — which is precisely the
  // 0.47-second quit from the 2026-09-16 record.
  await new Promise((r) => setImmediate(r));
  assert.ok(!h.names().includes('exit'),
    'exit must not have been called while the child was still stopping — this is the filed sub-defect');
  assert.ok(!h.names().includes('cleanup'), 'and cleanup must not have run either');

  releaseStop();
  await h.seq.whenDone();
  assert.ok(h.names().includes('exit'), 'once the child is gone the sequence finishes');
  assert.equal(h.seq.state(), 'finished');
});

test('BUG-437 / the identity snapshot is taken BEFORE the child is asked to stop', async () => {
  const h = harness();
  h.seq.request();
  await h.seq.whenDone();
  const order = h.names();
  assert.ok(order.indexOf('snapshotTree') !== -1 && order.indexOf('stopChild') !== -1);
  assert.ok(order.indexOf('snapshotTree') < order.indexOf('stopChild'),
    'once the child starts tearing down its descendants are already going; an identity never recorded cannot be verified afterwards');
});

test('BUG-437 / repeated quit requests join the one shutdown, never start a second', async () => {
  const h = harness();
  assert.equal(h.seq.request(), true);
  assert.equal(h.seq.request(), true, 'a second before-quit must still be held, or Electron terminates under the one in flight');
  assert.equal(h.seq.request(), true);
  await h.seq.whenDone();
  assert.equal(h.calls.filter((c) => c[0] === 'stopChild').length, 1, 'exactly one stop');
  assert.equal(h.calls.filter((c) => c[0] === 'exit').length, 1, 'exactly one exit');
});

test('BUG-437 / a request after the sequence has finished is not held', async () => {
  const h = harness();
  h.seq.request();
  await h.seq.whenDone();
  assert.equal(h.seq.request(), false,
    'holding a quit open after cleanup has run and exit has been called would wedge the app with nothing left to finish it');
});

// ---- 2. cleanup that app.exit() would otherwise skip ---------------------------

test('BUG-437 / cleanup runs before exit, because app.exit() never emits will-quit', async () => {
  const h = harness();
  h.seq.request();
  await h.seq.whenDone();
  const order = h.names();
  assert.ok(order.indexOf('cleanup') < order.indexOf('exit'),
    'the global shortcut release lives in will-quit, which app.exit() skips — so it must be performed here');
});

test('BUG-437 / a cleanup that throws still exits', async () => {
  const h = harness({ cleanup: () => { throw new Error('unregisterAll blew up'); } });
  h.seq.request();
  await h.seq.whenDone();
  assert.ok(h.names().includes('exit'),
    'a failing cleanup step must not leave the shutdown unresolved — that is the wedge arriving by another door');
  assert.ok(h.calls.some((c) => c[0] === 'log' && /cleanup failed/.test(c[1])), 'and it must be loud');
});

// ---- 3. the watchdog, and the pid-reuse hazard the move exposed ----------------

test('BUG-437 / the watchdog fires at the budget and exits', async () => {
  const h = harness({ stopChild: () => new Promise(() => {}) }); // never resolves
  h.seq.request();
  await new Promise((r) => setImmediate(r));
  assert.ok(!h.names().includes('exit'), 'not yet');
  h.clock.advance(DEFAULT_TOTAL_BUDGET_MS);
  assert.ok(h.names().includes('exit'), 'a shutdown that never finishes is still cut short at 10 s');
});

test('BUG-437 / the watchdog tree-kills a child that never exited', () => {
  const h = harness({ stopChild: () => new Promise(() => {}) });
  h.seq.request();
  h.clock.advance(DEFAULT_TOTAL_BUDGET_MS);
  const killed = h.calls.find((c) => c[0] === 'killTree');
  assert.ok(killed, 'the forked server leaves piper and pc-child grandchildren a bare kill() never reaches');
  assert.equal(killed[1], 4242);
});

test('BUG-437 / the watchdog refuses to tree-kill a child that was already reaped', async () => {
  // The reachable shape: the child exits promptly, the vault push wedges, the
  // watchdog fires. The pid it holds is a bare number and node has already
  // reaped the process, so Windows is free to have handed that number to
  // somebody else. Tree-killing it would take out an unrelated process.
  const h = harness({ pushVault: () => new Promise(() => {}) });
  h.seq.request();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.child.exitCode, 0, 'precondition: the child really was reaped');
  h.clock.advance(DEFAULT_TOTAL_BUDGET_MS);
  assert.ok(!h.names().includes('killTree'),
    'a reaped pid may already belong to somebody else — making the kill unreachable here is cheaper than rechecking an identity under a deadline');
  assert.ok(h.names().includes('exit'), 'it still exits');
});

test('BUG-437 / the watchdog is cleared once the sequence finishes', async () => {
  const h = harness();
  h.seq.request();
  await h.seq.whenDone();
  assert.equal(h.clock.pending(), 0,
    'the timer used to be left to die with the process; now that the sequence owns the exit, a live timer would fire into a finished sequence');
});

// ---- 4. the vault push, no longer a blocking spawnSync -------------------------

test('BUG-437 / the push gets the time left inside the deadline, minus the cleanup reserve', async () => {
  const clock = makeClock();
  const h = harness({
    clock,
    stopChild: async () => { clock.advance(2000); h.child.reap(0); },
  });
  h.seq.request();
  await h.seq.whenDone();
  const push = h.calls.find((c) => c[0] === 'pushVault');
  assert.ok(push, 'a confirmed-clean shutdown still pushes — the adjacent case that must keep passing');
  assert.equal(push[1], DEFAULT_TOTAL_BUDGET_MS - 2000 - DEFAULT_CLEANUP_RESERVE_MS,
    'the push is bounded by what is actually left, so it can never eat the reserve the cleanup needs');
});

test('BUG-437 / the push is skipped when no budget remains', async () => {
  const clock = makeClock();
  const h = harness({ clock, stopChild: async () => { clock.advance(9500); h.child.reap(0); } });
  h.seq.request();
  await h.seq.whenDone();
  assert.ok(!h.names().includes('pushVault'));
  assert.ok(h.calls.some((c) => c[0] === 'log' && /no budget left/.test(c[1])), 'and it says so rather than passing in silence');
});

test('BUG-437 / the vault push is skipped when termination could not be confirmed', async () => {
  const h = harness({
    verifyGone: async () => ({ outcome: 'terminated-unconfirmed', survivors: [], reason: 'the process query did not answer' }),
  });
  h.seq.request();
  await h.seq.whenDone();
  assert.ok(!h.names().includes('pushVault'),
    'committing the vault while a server we failed to account for may still be writing to it is how a half-written episodic line gets recorded as synced');
});

test('BUG-437 / the vault push is skipped when a survivor was found, and the survivor is named', async () => {
  const h = harness({
    verifyGone: async () => ({ outcome: 'survivors', survivors: [{ pid: 9001 }], reason: '1 process(es) still present' }),
  });
  h.seq.request();
  await h.seq.whenDone();
  assert.ok(!h.names().includes('pushVault'));
  assert.ok(h.calls.some((c) => c[0] === 'log' && /9001/.test(c[1])),
    '"some survived" without saying which is not actionable');
});

test('BUG-437 / the installer handover still skips the push for its own reason', async () => {
  const h = harness({ isInstallerHandover: () => true });
  h.seq.request();
  await h.seq.whenDone();
  assert.ok(!h.names().includes('pushVault'));
  assert.ok(h.calls.some((c) => c[0] === 'log' && /installer handover already pushed/.test(c[1])),
    'beginInstall pushes with the clock still ours; a second push here is what made every 0.1.7 update fail');
});

test('BUG-437 / no child at all is a clean, quick, complete shutdown', async () => {
  const h = harness({ child: null });
  h.seq.request();
  await h.seq.whenDone();
  assert.ok(!h.names().includes('snapshotTree'), 'nothing to snapshot');
  assert.ok(h.names().includes('cleanup') && h.names().includes('exit'));
});

// ---- 5. the deadline arithmetic ------------------------------------------------

test('BUG-437 / the budget adds up to the watchdog, not past it', () => {
  const snapshot = processTree.QUERY_TIMEOUT_MS;
  const verify = processTree.QUERY_TIMEOUT_MS;
  assert.equal(snapshot + CHILD_EXIT_DEADLINE_MS + verify + DEFAULT_CLEANUP_RESERVE_MS, DEFAULT_TOTAL_BUDGET_MS,
    'snapshot 1000 + child stop 7000 + verify 1000 + cleanup reserve 1000 = the 10 s backstop. '
    + 'Raising any of them silently eats the reserve, and the worst case then lands past the watchdog instead of on it');
});

// ---- 6. process identity -------------------------------------------------------

test('BUG-437 / process rows parse tolerantly and never yield a NaN pid', () => {
  const rows = processTree.parseRows('10=4=13300\nnot a row\n0=1=5\n11=10=13301\n  12=10=0  \n');
  assert.deepEqual(rows.map((r) => r.pid), [10, 11, 12], 'a row that does not parse is skipped; pid 0 is refused');
  assert.equal(rows[2].createdAt, '0', 'a missing creation time is recorded as 0, not invented');
});

test('BUG-437 / the descendant walk is a closure, and a recycled parent link cannot loop it', () => {
  const rows = [
    { pid: 10, ppid: 1, createdAt: 'a' },
    { pid: 11, ppid: 10, createdAt: 'b' },
    { pid: 12, ppid: 11, createdAt: 'c' },
    { pid: 13, ppid: 99, createdAt: 'd' },
    { pid: 99, ppid: 12, createdAt: 'e' },
  ];
  const got = processTree.descendantsOf(rows, 10).map((r) => r.pid).sort((x, y) => x - y);
  assert.deepEqual(got, [10, 11, 12, 13, 99], 'grandchildren count, and the 99 -> 12 -> 11 -> 10 chain terminates');
});

test('BUG-437 / identity is the pid AND its creation time, so a recycled pid is not a survivor', async () => {
  const snapshot = { rootPid: 10, members: [{ pid: 10, ppid: 1, createdAt: '111' }] };
  const verdict = await processTree.verifyGone(snapshot, {
    platform: 'win32',
    execFile: (_exe, _args, _opts, cb) => cb(null, '10=1=999\n'), // same pid, different birth
  });
  assert.equal(verdict.outcome, 'terminated-confirmed',
    'pid 10 exists again, but it is not OUR pid 10 — keying on the number alone would report a false survivor forever');
});

test('BUG-437 / a descendant born after the snapshot is still counted as a survivor', async () => {
  const snapshot = { rootPid: 10, members: [{ pid: 10, ppid: 1, createdAt: '111' }] };
  const verdict = await processTree.verifyGone(snapshot, {
    platform: 'win32',
    execFile: (_exe, _args, _opts, cb) => cb(null, '77=10=999\n'), // spawned by ours, never seen
  });
  assert.equal(verdict.outcome, 'survivors');
  assert.equal(verdict.survivors[0].pid, 77,
    'the only thing that could have spawned it is something inside the tree we were killing');
});

test('BUG-437 / a query that cannot answer reports unconfirmed, never confirmed', async () => {
  const snapshot = { rootPid: 10, members: [{ pid: 10, ppid: 1, createdAt: '111' }] };
  const verdict = await processTree.verifyGone(snapshot, {
    platform: 'win32',
    execFile: (_exe, _args, _opts, cb) => cb(new Error('powershell is not on PATH')),
  });
  assert.equal(verdict.outcome, 'terminated-unconfirmed',
    'ignorance reported as a clean result is the single most expensive mistake this repository has made repeatedly');
});

test('BUG-437 / no snapshot means unconfirmed, not confirmed', async () => {
  const verdict = await processTree.verifyGone(null, { platform: 'win32' });
  assert.equal(verdict.outcome, 'terminated-unconfirmed');
});

// ---- 7. the bounded vault push -------------------------------------------------
//
// This branch used to live inside main.js, where no test could execute it —
// which is the same false-green shape the whole ticket is about, so it was
// extracted rather than left as an untestable improvement.

const { spawnVaultPush } = require(path.join(ELECTRON_DIR, 'vault-push.js'));

function fakeProc() {
  const handlers = {};
  const stdoutHandlers = {};
  return {
    stdout: { on: (e, fn) => { stdoutHandlers[e] = fn; } },
    on: (e, fn) => { handlers[e] = fn; },
    emit: (e, ...a) => handlers[e] && handlers[e](...a),
    emitStdout: (chunk) => stdoutHandlers.data && stdoutHandlers.data(chunk),
  };
}

test('BUG-437 / the bounded push logs what the script said and resolves on close', async () => {
  const lines = [];
  const proc = fakeProc();
  const p = spawnVaultPush({ script: 's', flag: '--push', timeoutMs: 500, log: (...a) => lines.push(a.join(' ')), spawn: () => proc });
  proc.emitStdout('pushed 3 files\ntwo\n');
  proc.emit('close', 0, null);
  await p;
  assert.deepEqual(lines, ['pushed 3 files', 'two'], "a push that said something useful must not say nothing at all");
});

test('BUG-437 / a push cut off by its own timeout is reported as cut off, never as clean', async () => {
  const lines = [];
  const proc = fakeProc();
  const p = spawnVaultPush({ script: 's', flag: '--push', timeoutMs: 500, log: (...a) => lines.push(a.join(' ')), spawn: () => proc });
  proc.emit('close', null, 'SIGTERM'); // how node reports a `timeout:` kill
  await p;
  assert.ok(lines.some((l) => /cut off after 500ms/.test(l)),
    'a timeout arrives as a signal rather than an error, and reporting it as a clean push is the same lie this ticket is about');
});

test('BUG-437 / the push never rejects, however it fails', async () => {
  const proc = fakeProc();
  const p1 = spawnVaultPush({ script: 's', flag: '--push', timeoutMs: 5, log: () => {}, spawn: () => proc });
  proc.emit('error', new Error('ENOENT'));
  await p1; // would throw here if it rejected

  const lines = [];
  await spawnVaultPush({
    script: 's', flag: '--push', timeoutMs: 5, log: (...a) => lines.push(a.join(' ')),
    spawn: () => { throw new Error('bad cwd'); },
  });
  assert.ok(lines.some((l) => /could not start/.test(l)),
    'spawn can throw synchronously, and a throw here would reject a promise the quit sequence is awaiting');
});

test('BUG-437 / snapshotTree refuses a bad pid and a non-win32 platform without spawning anything', async () => {
  let spawned = 0;
  const execFile = () => { spawned += 1; };
  assert.equal(await processTree.snapshotTree(0, { platform: 'win32', execFile }), null);
  assert.equal(await processTree.snapshotTree(undefined, { platform: 'win32', execFile }), null);
  assert.equal(await processTree.snapshotTree(123, { platform: 'linux', execFile }), null);
  assert.equal(spawned, 0, 'a NaN pid reaching a kill path would be a very bad kind of surprise — refuse before spawning');
});
