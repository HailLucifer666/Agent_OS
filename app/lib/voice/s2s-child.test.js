// s2s-child.test.js — lifecycle tests for the optional S2S child process module. Stubs
// fs.existsSync and child_process.spawn in place (same monkeypatch-the-shared-module pattern
// tts.test.js uses for providers/edge-tts) so no real Python process or install is required.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('fs');
const childProcess = require('child_process');

const s2sChild = require('./s2s-child');

// Fake child process: an EventEmitter with stdout/stderr sub-emitters and a killed flag,
// standing in for the real ChildProcess node_modules/child_process.spawn() would return.
function fakeChildProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = 4242;
  proc.killed = false;
  return proc;
}

describe('s2s-child', () => {
  let originalExistsSync;
  let originalSpawn;
  let originalExecFile;

  beforeEach(() => {
    originalExistsSync = fs.existsSync;
    originalSpawn = childProcess.spawn;
    originalExecFile = childProcess.execFile;
  });

  afterEach(() => {
    fs.existsSync = originalExistsSync;
    childProcess.spawn = originalSpawn;
    childProcess.execFile = originalExecFile;
    s2sChild.shutdownS2s(); // reset module state between tests (best-effort, no real child)
  });

  test('exe not found -> startS2s resolves without throwing, status OFFLINE with a setup-script hint', async () => {
    fs.existsSync = () => false;
    let spawnCalled = false;
    childProcess.spawn = () => { spawnCalled = true; return fakeChildProcess(); };

    await assert.doesNotReject(() => s2sChild.startS2s({ port: 4477 }));

    const status = s2sChild.getS2sStatus();
    assert.equal(status.state, 'OFFLINE');
    assert.ok(status.hint && status.hint.includes('setup-s2s.ps1'), `expected hint to reference setup-s2s.ps1, got: ${status.hint}`);
    assert.equal(spawnCalled, false);
  });

  test('exe found: 3 consecutive crash-exits -> exactly 3 total spawn calls (1 initial + 2 restarts), then no further spawns', async () => {
    fs.existsSync = () => true;
    let spawnCount = 0;
    const procs = [];
    childProcess.spawn = () => {
      spawnCount += 1;
      const proc = fakeChildProcess();
      procs.push(proc);
      return proc;
    };

    await s2sChild.startS2s({ port: 4477 });
    assert.equal(spawnCount, 1);

    // Simulate crash #1 -> should schedule a restart (backoff timers are real but short;
    // we don't want to wait 2s+5s in a unit test, so drive it via fake timers instead).
    // Use a manual clock stand-in: monkeypatch global timers is avoided here — instead we
    // just await the real (short) backoff windows since 2s+5s is within test timeout budget.
    procs[0].emit('exit', 1, null);
    await new Promise((r) => setTimeout(r, 2100));
    assert.equal(spawnCount, 2, 'expected 1 restart after the 2s backoff');

    procs[1].emit('exit', 1, null);
    await new Promise((r) => setTimeout(r, 5100));
    assert.equal(spawnCount, 3, 'expected the 2nd restart after the 5s backoff');

    // 3rd spawn's process also crashes — restart budget (2) is now exhausted, must NOT restart again.
    procs[2].emit('exit', 1, null);
    await new Promise((r) => setTimeout(r, 5200));
    assert.equal(spawnCount, 3, 'must never restart a 4th time');

    const status = s2sChild.getS2sStatus();
    assert.equal(status.state, 'OFFLINE');
  });

  test('ring buffer stays capped at 100 lines when fed 500+ synthetic lines', async () => {
    fs.existsSync = () => true;
    let proc;
    childProcess.spawn = () => { proc = fakeChildProcess(); return proc; };

    await s2sChild.startS2s({ port: 4477 });

    const lines = [];
    for (let i = 0; i < 520; i += 1) lines.push(`line-${i}`);
    proc.stdout.emit('data', Buffer.from(lines.join('\n') + '\n'));

    const status = s2sChild.getS2sStatus();
    assert.equal(status.ringBuffer.length, 100);
    // Oldest-evicted-on-overflow: the buffer should end with the most recent lines.
    assert.equal(status.ringBuffer[status.ringBuffer.length - 1], 'line-519');
    assert.equal(status.ringBuffer[0], 'line-420');
  });

  test('shutdownS2s on a "running" stubbed child does NOT trigger a restart', async () => {
    fs.existsSync = () => true;
    let spawnCount = 0;
    let proc;
    childProcess.spawn = () => {
      spawnCount += 1;
      proc = fakeChildProcess();
      return proc;
    };
    childProcess.execFile = () => {};

    await s2sChild.startS2s({ port: 4477 });
    assert.equal(spawnCount, 1);

    s2sChild.shutdownS2s();
    // The real taskkill is async/best-effort; simulate the resulting exit event synchronously,
    // as would eventually happen once the process is actually killed.
    proc.emit('exit', null, 'SIGTERM');

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(spawnCount, 1, 'shutdown-triggered exit must not cause a restart');

    const status = s2sChild.getS2sStatus();
    assert.equal(status.state, 'OFFLINE');
  });
});
