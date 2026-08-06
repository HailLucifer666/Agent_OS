'use strict';

// test/f5-pc-child-startup-guard.test.js — BUG-141.
//
// BUG-141(a): startPcChild() used to spawn a brand-new child unconditionally. If
// ever called while a previous PowerShell child was still alive, the old
// process was orphaned — never killed, only abandoned once the
// `proc !== child` identity guards in adapters/pc-child/index.js started
// ignoring its events. Fixed by killing any live previous child first
// (killLiveChild(), shared with shutdownPcChild()).
//
// BUG-141(b): the startup-handshake watchdog (handleStartup) marks state OFFLINE
// at STARTUP_TIMEOUT_MS (5s), but the ping occupying commandInFlight carries
// the full COMMAND_TIMEOUT_MS (15s) — found, while live-verifying this, that
// handleStartup's own recursive setTimeout was never actually kicked off in
// the first place (dead code — state never reached OFFLINE via this path at
// all). Fixed by starting the loop AND freeing the stale ping's in-flight
// slot (matched by id) the moment the startup timeout fires, so a
// newly-queued command isn't stuck behind it.
//
// Mocking approach: adapters/pc-child/index.js destructures
// `const { spawn } = require('child_process')` at module top level — a
// value copy, not a live binding — so child_process.spawn must be swapped
// out BEFORE the module is required (same require-cache-eviction technique
// as test/helpers/mock-spawn-enoent.js). execFile, by contrast, is required
// freshly inside killLiveChild() at CALL time, so it can be monkeypatched
// directly without any cache tricks.

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const { EventEmitter } = require('events');

const PC_CHILD_PATH = require.resolve('../adapters/pc-child');

function makeFakeChild(pid) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.killed = false;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = {
    writes: [],
    write(s) { this.writes.push(s); },
  };
  proc.kill = function (sig) {
    proc.killed = true;
    proc.killSignal = sig;
    return true;
  };
  return proc;
}

describe('BUG-141(a): startPcChild kills a live previous child before spawning a new one', () => {
  let realSpawn;
  let realExecFile;
  let spawnedChildren;
  let execFileCalls;
  let pcChild;

  function install() {
    spawnedChildren = [];
    execFileCalls = [];
    realSpawn = cp.spawn;
    realExecFile = cp.execFile;

    cp.spawn = function fakeSpawn() {
      const proc = makeFakeChild(9000 + spawnedChildren.length);
      spawnedChildren.push(proc);
      return proc;
    };
    cp.execFile = function fakeExecFile(cmd, args) {
      execFileCalls.push({ cmd, args });
      // No callback given (matches production's fire-and-forget call) — no
      // real taskkill process is spawned for these fake pids.
    };

    delete require.cache[PC_CHILD_PATH];
    pcChild = require(PC_CHILD_PATH);
  }

  function uninstall() {
    if (pcChild) {
      try { pcChild.shutdownPcChild(); } catch (_) { /* best-effort */ }
    }
    cp.spawn = realSpawn;
    cp.execFile = realExecFile;
    delete require.cache[PC_CHILD_PATH];
  }

  afterEach(() => {
    uninstall();
  });

  test('second startPcChild() kills the first child via taskkill and only the new child stays live', async () => {
    install();

    await pcChild.startPcChild();
    assert.equal(spawnedChildren.length, 1, 'first start spawns exactly one child');
    const firstChild = spawnedChildren[0];
    assert.equal(firstChild.stdin.writes.length, 1, 'first child receives its own startup ping');

    await pcChild.startPcChild();
    assert.equal(spawnedChildren.length, 2, 'second start spawns a second child');
    const secondChild = spawnedChildren[1];

    // process.platform is win32 in this repo's dev/CI environment, so
    // killLiveChild() takes the taskkill path (child.pid is set on the fake).
    assert.ok(
      execFileCalls.some((c) => c.cmd === 'taskkill' && c.args.includes(String(firstChild.pid))),
      'expected taskkill to be invoked for the FIRST child\'s pid'
    );

    // The orphaned first child must receive no further traffic once the
    // second child is live.
    assert.equal(firstChild.stdin.writes.length, 1, 'orphaned first child gets no new writes');
    assert.equal(secondChild.stdin.writes.length, 1, 'the new (second) child receives its own startup ping');
  });

  test('a fresh startPcChild() with no previous child never calls taskkill', async () => {
    install();

    await pcChild.startPcChild();
    assert.equal(spawnedChildren.length, 1);
    assert.equal(execFileCalls.length, 0, 'nothing to kill on the very first start');
  });
});

describe('BUG-141(b): startup-handshake timeout frees the stale in-flight ping slot', () => {
  let realSpawn;
  let realExecFile;
  let spawnedChildren;
  let pcChild;

  function install() {
    spawnedChildren = [];
    realSpawn = cp.spawn;
    realExecFile = cp.execFile;

    cp.spawn = function fakeSpawn() {
      const proc = makeFakeChild(9500 + spawnedChildren.length);
      spawnedChildren.push(proc);
      return proc;
    };
    // Never actually invoked in this describe block (no previous child to
    // kill), but stub it anyway so no real taskkill.exe could ever be spawned.
    cp.execFile = function fakeExecFile() {};

    delete require.cache[PC_CHILD_PATH];
    pcChild = require(PC_CHILD_PATH);
  }

  function uninstall() {
    if (pcChild) {
      try { pcChild.shutdownPcChild(); } catch (_) { /* best-effort */ }
    }
    cp.spawn = realSpawn;
    cp.execFile = realExecFile;
    delete require.cache[PC_CHILD_PATH];
  }

  afterEach(() => {
    uninstall();
  });

  test('getStatus() reports OFFLINE once the startup handshake never answers', async () => {
    install();
    await pcChild.startPcChild();

    // The fake child never emits a ping response, so the real
    // ps-automation.ps1 handshake never completes. Poll getStatus() past
    // STARTUP_TIMEOUT_MS (5s) — before the fix this stayed STARTING forever
    // because handleStartup's own watchdog loop was never kicked off.
    const deadline = Date.now() + 6000;
    let sawOffline = false;
    while (Date.now() < deadline) {
      if (pcChild.getStatus().state === 'OFFLINE') { sawOffline = true; break; }
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.ok(sawOffline, 'expected getStatus().state to reach OFFLINE once the handshake times out');
  });
});
