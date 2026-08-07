'use strict';

// test/bug-167-pcchild-handshake-retry.test.js — BUG-167.
//
// A live session on 2026-08-07 lost the entire desktop-control surface for
// its whole duration: screen_look, send_key, focus_window, per-app volume —
// every effector that routes through pc-child answered "PC automation
// offline". ps-automation.ps1 parsed clean and the process was still alive.
//
// Root cause: the exponential-backoff restart lived inline in the child's
// 'exit' handler, so it was reachable ONLY when the child actually died. A
// child that spawned but never answered the startup ping (slow first
// PowerShell spawn, Defender on-access scan, a hang before stdout) hit
// handleStartup()'s timeout, which set state = 'OFFLINE' and returned —
// permanently, with a live zombie child still holding the pipes. And the
// child's stderr, captured in the ring buffer since forever, was never
// logged, so the failure was undiagnosable after the fact.
//
// RED-FIRST EVIDENCE: against the pre-fix adapter, "restarts after a
// handshake timeout" observed spawnCount === 1 (expected >= 2) and
// "recovers when the second child answers" stayed OFFLINE forever.
//
// The adapter reads PC_CHILD_STARTUP_TIMEOUT_MS / PC_CHILD_RESTART_BACKOFF_MS
// at require time purely so this file can drive the REAL timeout and backoff
// code paths in milliseconds. Production sets neither.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const ADAPTER_PATH = require.resolve('../adapters/pc-child');
const STARTUP_TIMEOUT_MS = 200;
const BACKOFF_MS = '50,50';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Fake ChildProcess with the members pc-child actually touches.
// `pid` is deliberately left undefined: killLiveChild() shells out to a REAL
// `taskkill /PID <n> /T /F` on win32 when pid is truthy, which would kill
// whatever unrelated process happens to own that pid on the test machine.
// With no pid it takes the child.kill() branch, which this fake records.
function makeFakeChild({ answerPing, stderrLine }) {
  const proc = new EventEmitter();
  proc.killed = false;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = {
    write(line) {
      if (!answerPing) return; // the hang this bug is about
      const cmd = JSON.parse(line);
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, id: cmd.id, result: 'pong' }) + '\n'));
      });
    },
    end() {},
  };
  proc.kill = function () { proc.killed = true; return true; };
  if (stderrLine) {
    setImmediate(() => proc.stderr.emit('data', Buffer.from(stderrLine + '\n')));
  }
  return proc;
}

// Requires the adapter fresh with child_process.spawn and the logger factory
// swapped out. Same require-cache reasoning as test/helpers/mock-spawn-enoent.js:
// the adapter destructures `const { spawn } = require('child_process')` at
// module scope, so the mock has to be in place during its own require() call.
function loadAdapter(spawnImpl) {
  const logs = [];
  const fakeLogger = {
    info: (msg, data) => logs.push({ level: 'info', msg, data }),
    warn: (msg, data) => logs.push({ level: 'warn', msg, data }),
    error: (msg, data) => logs.push({ level: 'error', msg, data }),
    debug: () => {},
  };

  const originalRequire = Module.prototype.require;
  const prevTimeout = process.env.PC_CHILD_STARTUP_TIMEOUT_MS;
  const prevBackoff = process.env.PC_CHILD_RESTART_BACKOFF_MS;
  process.env.PC_CHILD_STARTUP_TIMEOUT_MS = String(STARTUP_TIMEOUT_MS);
  process.env.PC_CHILD_RESTART_BACKOFF_MS = BACKOFF_MS;

  Module.prototype.require = function (id) {
    if (id === 'child_process') {
      return Object.assign({}, originalRequire.call(this, id), { spawn: spawnImpl });
    }
    if (id === '../../src/core/logger') {
      return { createLogger: () => fakeLogger };
    }
    return originalRequire.apply(this, arguments);
  };

  delete require.cache[ADAPTER_PATH];
  let mod;
  try {
    mod = require(ADAPTER_PATH);
  } finally {
    Module.prototype.require = originalRequire;
    if (prevTimeout === undefined) delete process.env.PC_CHILD_STARTUP_TIMEOUT_MS;
    else process.env.PC_CHILD_STARTUP_TIMEOUT_MS = prevTimeout;
    if (prevBackoff === undefined) delete process.env.PC_CHILD_RESTART_BACKOFF_MS;
    else process.env.PC_CHILD_RESTART_BACKOFF_MS = prevBackoff;
  }

  return {
    pcChild: mod,
    logs,
    cleanup() {
      try { mod.shutdownPcChild(); } catch { /* best-effort */ }
      delete require.cache[ADAPTER_PATH];
    },
  };
}

describe('BUG-167 — pc-child handshake timeout must restart, not strand the adapter OFFLINE forever', () => {

  it('a child that never answers ping is killed and restarted with backoff', async () => {
    const spawned = [];
    const { pcChild, logs, cleanup } = loadAdapter(() => {
      const proc = makeFakeChild({ answerPing: false, stderrLine: 'Add-Type : cannot compile' });
      spawned.push(proc);
      return proc;
    });

    try {
      pcChild.startPcChild();
      await sleep(STARTUP_TIMEOUT_MS + 200);

      assert.ok(spawned.length >= 2, `handshake timeout must schedule a restart, spawned ${spawned.length} time(s)`);
      assert.equal(spawned[0].killed, true, 'the hung child must be killed, not left as a zombie holding the pipes');

      const timeoutLog = logs.find((l) => l.msg === 'pc-child.handshake-timeout');
      assert.ok(timeoutLog, 'the handshake timeout must be logged');
      assert.ok(Array.isArray(timeoutLog.data.stderr), 'the log must carry the child stderr tail');
      assert.ok(
        timeoutLog.data.stderr.some((line) => line.includes('cannot compile')),
        'the child stderr that explains the hang must reach the log, got: ' + JSON.stringify(timeoutLog.data.stderr)
      );
    } finally {
      cleanup();
    }
  });

  it('exhausting the restart budget settles OFFLINE with a hint carrying the child stderr', async () => {
    const spawned = [];
    const { pcChild, cleanup } = loadAdapter(() => {
      const proc = makeFakeChild({ answerPing: false, stderrLine: 'ps-automation.ps1 : access denied' });
      spawned.push(proc);
      return proc;
    });

    try {
      pcChild.startPcChild();
      // initial spawn + MAX_RESTART_ATTEMPTS (2) restarts, then give up
      await sleep((STARTUP_TIMEOUT_MS + 100) * 3 + 600);

      const status = pcChild.getStatus();
      assert.equal(status.state, 'OFFLINE', 'must settle OFFLINE once the restart budget is spent');
      assert.equal(spawned.length, 3, `initial spawn + 2 restarts, got ${spawned.length}`);
      assert.match(status.hint, /timed out/i);
      assert.match(status.hint, /access denied/, 'the hint must name what the child actually complained about');
    } finally {
      cleanup();
    }
  });

  it('a child that answers on the second spawn brings the adapter ONLINE', async () => {
    let spawnCount = 0;
    const { pcChild, cleanup } = loadAdapter(() => {
      spawnCount += 1;
      return makeFakeChild({ answerPing: spawnCount > 1 });
    });

    try {
      pcChild.startPcChild();
      await sleep(STARTUP_TIMEOUT_MS + 400);

      assert.equal(pcChild.getStatus().state, 'ONLINE', 'the retry must actually recover the adapter');
      assert.equal(spawnCount, 2);
    } finally {
      cleanup();
    }
  });

  it('probePcChild() is the recovery surface after the restart budget is spent', async () => {
    let spawnCount = 0;
    let answer = false;
    const { pcChild, cleanup } = loadAdapter(() => {
      spawnCount += 1;
      return makeFakeChild({ answerPing: answer });
    });

    try {
      pcChild.startPcChild();
      await sleep((STARTUP_TIMEOUT_MS + 100) * 3 + 600);
      assert.equal(pcChild.getStatus().state, 'OFFLINE');
      const spentBudgetSpawns = spawnCount;

      // Whatever was wrong is now fixed — a health check re-probes.
      answer = true;
      pcChild.probePcChild();
      await sleep(200);

      assert.equal(pcChild.getStatus().state, 'ONLINE', 'a re-probe must be able to bring a budget-exhausted adapter back');
      assert.equal(spawnCount, spentBudgetSpawns + 1);
    } finally {
      cleanup();
    }
  });

  it('probePcChild() is a no-op while the adapter is healthy (safe for a periodic health check)', async () => {
    let spawnCount = 0;
    const { pcChild, cleanup } = loadAdapter(() => {
      spawnCount += 1;
      return makeFakeChild({ answerPing: true });
    });

    try {
      pcChild.startPcChild();
      await sleep(100);
      assert.equal(pcChild.getStatus().state, 'ONLINE');

      pcChild.probePcChild();
      pcChild.probePcChild();
      await sleep(100);

      assert.equal(spawnCount, 1, 'repeated probes must not stack spawns on a healthy adapter');
      assert.equal(pcChild.getStatus().state, 'ONLINE');
    } finally {
      cleanup();
    }
  });
});
