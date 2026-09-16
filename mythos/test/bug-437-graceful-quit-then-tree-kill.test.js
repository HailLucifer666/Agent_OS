'use strict';

// test/bug-437-graceful-quit-then-tree-kill.test.js — BUG-437.
//
// FILED: closing 0.1.12 left processes in Task Manager and wrote no quit line.
// MEASURED 2026-09-16 against the code, not the report: electron/main.js
// stopChild() called child.kill() and only then awaitChildExit(). On Windows,
// Node's child.kill() is TerminateProcess — no signal is delivered and no
// handler runs — so the server's lifecycle shutdown steps (stop-loops,
// reflection, episodic-flush, checkpoint-write, audit-flush; src/main.js) have
// NEVER run from a GUI quit on Windows. lifecycle.registerShutdown() listened
// for SIGINT/SIGTERM only; no shutdown IPC existed. The escalation in
// child-exit.js was a bare SIGKILL of the direct child, and the only tree-kill
// lived in the 10 s quit watchdog — so a server that exited promptly took its
// grandchildren (pc-child PowerShell, piper, edge-tts, an in-flight dsh task)
// with it only if lifecycle happened to stop them, which it never got to do.
//
// This is the fragility half of BUG-437 (unflushed episodic/audit and orphaned
// grandchildren on EVERY normal quit). The filed live symptom — a lingering
// process after quit — is not reproduced here; the missing
// `lifecycle.process-exit` line is consistent with an abrupt kill but does not
// exclude other causes (isQuitting timing among them). Track A step 12 of the
// 2026-09-16 plan is where that gets observed. Nothing in this file claims it.
//
// THE FIX, and the order that makes it a fix: the shell SENDS
// {channel:'mythos:shutdown', timeoutMs} over the fork IPC channel, WAITS for
// the child to exit up to a deadline, and only THEN tree-kills. Sending and
// killing in the same tick would still terminate abruptly (the 2026-09-16
// review's correction of the first draft). Deadlines reconciled, and pinned in
// (k): the message carries 6000 (lifecycle's hard-exit(1) budget), the shell
// escalates at 7000, the quit watchdog stays at 10000 — 3 s of margin at each
// step. lifecycle.registerShutdown() handles the IPC message with the SAME body
// as the signals, so both routes end in process.exit(0).
//
// DESCENDANTS. A parent that exits within the deadline is never escalated, so
// grandchildren need their own stop: dsh-agent gains shutdown(), which tree-
// kills any in-flight task child, registered in stopRunningLoops(). And the
// escalation itself is now a real tree-kill (taskkill /T /F on win32), proven
// in (f) against a REAL node parent with a REAL node grandchild.
//
// PLATFORM, honestly: the defect is Windows-shaped (POSIX kill() is SIGTERM and
// the signal handler already ran the steps). (f) asserts the grandchild is gone
// on win32 — which is also what CI runs (runs-on: windows-latest). Elsewhere it
// asserts the direct child, because a non-detached child is not a process-group
// leader and there is no portable tree-kill without one.
//
// MUTATION RUN — see the block at the bottom of this file.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

const childExit = require('../../electron/child-exit');
const { awaitChildExit, killTree, stopChildGracefully, SHUTDOWN_REQUEST_MS, CHILD_EXIT_DEADLINE_MS } = childExit;
const { createLifecycle } = require('../src/core/lifecycle');
const { createBus } = require('../src/core/bus');

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.connected = true;
  child.sent = [];
  child.kill = (signal) => { child.killed = signal || 'SIGTERM'; return true; };
  child.send = (msg) => { child.sent.push(msg); return true; };
  child.die = (code) => { child.exitCode = code === undefined ? 0 : code; child.emit('exit', child.exitCode, null); };
  return child;
}

function spySpawn() {
  const calls = [];
  const fn = (cmd, args) => { calls.push({ cmd, args }); const p = new EventEmitter(); p.unref = () => {}; return p; };
  fn.calls = calls;
  return fn;
}

const settle = () => new Promise((r) => setImmediate(r));

describe('BUG-437 — the shell asks the server to shut down, waits, then tree-kills', () => {
  it('(a) stopChildGracefully SENDS the shutdown request and does NOT kill a child that is still exiting', async () => {
    const child = fakeChild(4242);
    let settled = false;
    const waiting = stopChildGracefully(child, () => {}, { platform: 'win32', spawn: spySpawn() }).then(() => { settled = true; });
    await settle();
    assert.deepEqual(child.sent, [{ channel: 'mythos:shutdown', timeoutMs: SHUTDOWN_REQUEST_MS }],
      'the request rides the fork IPC channel — on Windows kill() delivers no signal at all');
    assert.equal(child.killed, false, 'kill() before the child has had its chance is the old behaviour');
    assert.equal(settled, false, 'it is waiting for the exit');
    child.die(0);
    await waiting;
    assert.equal(child.killed, false, 'a child that exits in time is never killed');
  });

  it('(b) a closed IPC channel falls back to kill() immediately rather than waiting on a message nobody will read', async () => {
    const child = fakeChild(4242);
    child.send = () => { throw new Error('channel closed'); };
    const waiting = stopChildGracefully(child, () => {}, { platform: 'win32', spawn: spySpawn() });
    await settle();
    assert.equal(child.killed, 'SIGTERM', 'the plain kill() the old code always used, kept for exactly this case');
    child.die(0);
    await waiting;
  });

  it('(b2) no child at all resolves at once', async () => {
    await stopChildGracefully(null, () => {});
    assert.ok(true);
  });

  it('(c) awaitChildExit never spawns taskkill for a child that exits before the deadline', async () => {
    const child = fakeChild(4242);
    const sp = spySpawn();
    const waiting = awaitChildExit(child, 5000, () => {}, { platform: 'win32', spawn: sp });
    setImmediate(() => child.die(0));
    await waiting;
    assert.equal(sp.calls.length, 0);
    assert.equal(child.killed, false);
  });

  it('(d) at the deadline the escalation is a TREE kill on win32: taskkill /PID <pid> /T /F, once', async () => {
    const child = fakeChild(4242);
    const sp = spySpawn();
    const logged = [];
    await awaitChildExit(child, 10, (m) => logged.push(String(m)), { platform: 'win32', spawn: sp });
    assert.equal(sp.calls.length, 1, 'exactly one tree-kill');
    assert.equal(sp.calls[0].cmd, 'taskkill');
    assert.deepEqual(sp.calls[0].args, ['/PID', '4242', '/T', '/F'],
      '/T is what reaches the grandchildren a bare kill() never does');
    assert.ok(logged.some((l) => /did not exit/.test(l)), 'the log is the only witness this close to exit');
  });

  it('(e) a taskkill that fails to spawn is logged and the wait still resolves', async () => {
    const child = fakeChild(4242);
    const logged = [];
    const sp = () => { throw new Error('ENOENT taskkill'); };
    await awaitChildExit(child, 10, (m) => logged.push(String(m)), { platform: 'win32', spawn: sp });
    assert.ok(logged.some((l) => /ENOENT taskkill/.test(l)), 'the failure must not be swallowed silently');
  });

  it('(e2) off win32 a child that is not a group leader still gets SIGKILL on itself', async () => {
    const child = fakeChild(2147483000); // no such process group -> process.kill(-pid) throws -> fallback
    await awaitChildExit(child, 10, () => {}, { platform: 'linux' });
    assert.equal(child.killed, 'SIGKILL');
  });

  it('(f) DESCENDANT PROOF with real processes: killTree on the parent takes the grandchild with it', async () => {
    // Parent prints its grandchild's pid, then both idle forever.
    const script = "const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(c.pid)+'\\n');setInterval(()=>{},1000);";
    const parent = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let grandchildPid = 0;
    try {
      grandchildPid = await new Promise((resolve, reject) => {
        let buf = '';
        const t = setTimeout(() => reject(new Error('parent never printed the grandchild pid')), 10000);
        parent.stdout.on('data', (d) => { buf += String(d); const m = buf.match(/^(\d+)\s*\n/); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
        parent.on('exit', () => { clearTimeout(t); reject(new Error('parent exited early')); });
      });
      const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code !== 'ESRCH'; } };
      assert.ok(alive(grandchildPid), 'precondition: the grandchild is running');

      killTree(parent, () => {});

      const target = process.platform === 'win32' ? grandchildPid : parent.pid;
      const deadline = Date.now() + 3000;
      while (alive(target) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      assert.equal(alive(target), false,
        process.platform === 'win32'
          ? 'the grandchild must be dead within 3 s of tree-killing its parent — this is the orphan BUG-437 leaves in Task Manager'
          : 'the direct child must be dead within 3 s (no portable tree-kill for a non-detached child off win32)');
    } finally {
      try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* already gone */ }
      try { parent.kill('SIGKILL'); } catch { /* already gone */ }
    }
  });

  it('(k) the deadlines are reconciled: request 6000 < shell escalation 7000 < watchdog 10000', () => {
    assert.equal(SHUTDOWN_REQUEST_MS, 6000, 'what lifecycle gets as its hard-exit(1) budget');
    assert.equal(CHILD_EXIT_DEADLINE_MS, 7000, 'when the shell stops waiting and tree-kills');
    assert.ok(SHUTDOWN_REQUEST_MS < CHILD_EXIT_DEADLINE_MS && CHILD_EXIT_DEADLINE_MS < 10000,
      'each step needs margin under the next: lifecycle exits itself before the shell kills, the shell kills before the watchdog fires');
  });
});

describe('BUG-437 — the server runs its shutdown steps on the IPC request, same body as SIGTERM', () => {
  function harness() {
    const bus = createBus();
    const lines = [];
    const logger = {
      info: (msg, meta) => lines.push({ level: 'info', msg, meta }),
      warn: (msg, meta) => lines.push({ level: 'warn', msg, meta }),
      error: (msg, meta) => lines.push({ level: 'error', msg, meta }),
      debug: () => {},
    };
    const proc = new EventEmitter();
    proc.exits = [];
    proc.exit = (code) => { proc.exits.push({ code, at: lines.length }); };
    proc.send = () => true; // a forked child has process.send
    const lc = createLifecycle({ bus, logger, config: { SHUTDOWN_MS: 5000 }, proc });
    return { lc, proc, lines };
  }

  it('(g) the message runs the registered steps in order and then exit(0), after lifecycle.shutdown.complete', async () => {
    const { lc, proc, lines } = harness();
    const order = [];
    lc.registerShutdownStep('stop-loops', () => order.push('stop-loops'));
    lc.registerShutdownStep('episodic-flush', async () => order.push('episodic-flush'));
    lc.registerShutdownStep('audit-flush', () => order.push('audit-flush'));
    lc.registerShutdown();

    proc.emit('message', { channel: 'mythos:shutdown', timeoutMs: 6000 });
    for (let i = 0; i < 20 && proc.exits.length === 0; i++) await settle();

    assert.deepEqual(order, ['stop-loops', 'episodic-flush', 'audit-flush'], 'the steps a Windows GUI quit has never run until now');
    assert.deepEqual(proc.exits.map((e) => e.code), [0], 'one exit, code 0 — the same ending the signal path has');
    const completeAt = lines.findIndex((l) => l.msg === 'lifecycle.shutdown.complete');
    assert.ok(completeAt !== -1, 'lifecycle.shutdown.complete must be logged — Track A step 12 greps for it');
    assert.ok(proc.exits[0].at > completeAt, 'exit(0) comes AFTER the completion line, never before');
    assert.equal(lc.getState(), 'dead');
  });

  it('(g2) a message on another channel is ignored', async () => {
    const { lc, proc } = harness();
    lc.registerShutdownStep('never', () => { throw new Error('must not run'); });
    lc.registerShutdown();
    proc.emit('message', { channel: 'mythos:ocr-grab' });
    proc.emit('message', null);
    proc.emit('message', 'mythos:shutdown');
    await settle(); await settle();
    assert.equal(proc.exits.length, 0);
    assert.equal(lc.getState(), 'idle');
  });

  it('(g3) a throwing step does not prevent exit(0)', async () => {
    const { lc, proc } = harness();
    lc.registerShutdownStep('boom', () => { throw new Error('nope'); });
    lc.registerShutdown();
    proc.emit('message', { channel: 'mythos:shutdown', timeoutMs: 6000 });
    for (let i = 0; i < 20 && proc.exits.length === 0; i++) await settle();
    assert.deepEqual(proc.exits.map((e) => e.code), [0]);
  });

  it('(g4) without process.send (npm start, no parent) no message listener is registered', () => {
    const bus = createBus();
    const proc = new EventEmitter();
    proc.exit = () => {};
    // no proc.send
    const lc = createLifecycle({ bus, logger: { info() {}, warn() {}, error() {}, debug() {} }, proc });
    lc.registerShutdown();
    assert.equal(proc.listenerCount('message'), 0, 'a listener with no channel behind it is dead code that reads as coverage');
    assert.ok(proc.listenerCount('SIGTERM') >= 1, 'the signal route is untouched');
  });
});

describe('BUG-437 — dsh-agent.shutdown() tree-kills an in-flight task child', () => {
  it('(h) a running task child is stopped by shutdown(), and shutdown() is idempotent', async () => {
    const dsh = require('../adapters/dsh-agent');
    assert.equal(typeof dsh.shutdown, 'function', 'dsh-agent must expose shutdown() for stopRunningLoops');
    // spawnDsh runs process.execPath with --expose-internals prepended; a
    // bare -e script idles exactly like a task that has not finished.
    const running = dsh.spawnDsh(['-e', 'setInterval(()=>{},1000)'], { cwd: process.cwd(), env: process.env, timeoutMs: 30000 });
    await new Promise((r) => setTimeout(r, 300)); // let it start
    const before = Date.now();
    dsh.shutdown();
    const res = await Promise.race([running, new Promise((r) => setTimeout(() => r({ kind: 'still-running' }), 5000))]);
    assert.notEqual(res.kind, 'still-running', 'the task child must be gone within 5 s of shutdown()');
    assert.notEqual(res.kind, 'timeout', 'stopped by shutdown(), not by its own 30 s clock');
    assert.ok(Date.now() - before < 5000);
    assert.doesNotThrow(() => dsh.shutdown(), 'a second shutdown() with nothing running is a no-op');
  });
});

// MUTATION RUN 2026-09-16. Each probe applied by exact single-match replacement
// (refused on 0 or 2+ matches); child-exit.js, lifecycle/index.js and
// dsh-agent/index.js restored from snapshots and checked sha256-identical
// (40ff0fb1..., 4ab124ea..., 93044bc1...). Green baseline first: 107/107 across
// this file, electron-child-exit, electron-quit-zombie, lifecycle, dsh-agent,
// electron-update-handoff and file-size-ratchet.
//   pre-fix code (HEAD before this commit) against this file -> 11 of 14 red;
//                   (c), (e2), (g2) hold either way — the adjacent cases.
//   child-exit.js  kill() unconditionally after the send (the first draft's
//                   send-and-kill-in-one-tick shape)      -> 1 red: (a).
//   child-exit.js  escalation back to bare pending.kill('SIGKILL') -> 2 red: (d), (e).
//   lifecycle      IPC listener ignores every message     -> 2 red: (g), (g3).
//   lifecycle      exit(0) BEFORE shutdown() instead of after -> 1 red: (g) on the
//                   "exit comes after lifecycle.shutdown.complete" ordering.
//   dsh-agent      never track the spawned child          -> 1 red: (h), after its
//                   full 5 s wait — the child kept running.
// (f), the real-process descendant proof, stayed green under every probe except
// the pre-fix run (no killTree existed), and the src/main.js file-size ratchet
// forced the stop-loops registration onto one line (1373 is its ceiling).
