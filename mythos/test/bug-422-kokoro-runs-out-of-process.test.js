'use strict';

// test/bug-422-kokoro-runs-out-of-process.test.js
//
// BUG-422 (CRITICAL): the server child died mid-session. On 2026-09-23 a death was
// captured with exit code 0xE06D7363 — an unhandled C++ exception in NATIVE code —
// six seconds after Kokoro's fourth synthesis timeout in 20 s. Each timeout
// terminated Kokoro's worker THREAD while onnxruntime inference was still running
// in it, and a thread shares its process.
//
// THE CAUSE, reproduced 2026-09-23 against the real model (.cache/bug422/matrix.js,
// one fresh process per trial, > 6 s observed after each operation):
//   terminate an IDLE worker (control)          exit 0            2 of 2
//   terminate mid-inference                     exit 0xC0000409   2 of 2 (at exit)
//     ... then a replacement load               exit 0xC0000409   2 of 2 (at exit)
//     ... then a replacement synthesis          exit 0xC0000409   2 of 2 (at exit)
//   shut down mid-inference, then exit(0)       exit 0xC0000409   2 of 2  (BUG-437's)
//   FOUR kills ~5 s apart (the attended shape)  DIED MID-SESSION  2 of 2, after kill 2
// So a mid-inference kill poisons the whole process: it dies at exit every time,
// and mid-session once kills accumulate.
//
// THE REPAIR: Kokoro runs in a child PROCESS (providers/kokoro/child-transport.js).
// A native death or a kill costs that process only. This file proves CONTAINMENT
// with a fake child that speaks the real protocol — CI has no model weights — and
// measures "the server survives" as a real host process's exit code.
//
// RED FIRST, 2026-09-23, against ee823a95: (a) transport() did not exist and the
// default was a worker THREAD; (b)/(c) could not select the child file; the
// control (w) below — the SAME abort inside a worker thread — took its host down,
// which is the mechanism the repair routes around.
//
// MUTATIONS, 2026-09-23: table at the bottom of this file.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync, fork } = require('node:child_process');

// Outside test/ on purpose: node --test runs EVERY .js under a test/ directory, and
// the harness starts real processes (test-dir-hygiene.test.js, BUG-134).
const HARNESS = path.join(__dirname, '..', 'test-fixtures', 'kokoro', 'host-harness.js');
const FAKE = path.join(__dirname, '..', 'test-fixtures', 'kokoro', 'fake-child.js');
const WORKER = path.join(__dirname, '..', 'providers', 'kokoro', 'worker.js');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-422-')); }
function runHarness(scenario, mode) {
  const dir = tmp();
  const env = Object.assign({}, process.env, { KOKORO_FAKE_MODE: mode, KOKORO_FAKE_DIR: dir });
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(process.execPath, [HARNESS, scenario], { env, encoding: 'utf8', timeout: 30000 });
  fs.rmSync(dir, { recursive: true, force: true });
  let out = null;
  try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch (_) { out = null; }
  return { status: r.status, out, stderr: r.stderr };
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (_) { return false; } }
function forkWorker() {
  return fork(WORKER, [], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) });
}
// Bounded: a child that never answers is a NAMED red, not a hung file (the first
// red run hung 120 s here, because the old worker.js exits at once when forked).
function ask(child, msg, ms = 5000) {
  return Promise.race([
    new Promise((resolve) => { child.once('message', resolve); child.send(msg); }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('the forked worker.js never answered over IPC')), ms)),
  ]);
}

describe('BUG-422 — Kokoro runs in its own process, so its native death is not the server\'s', () => {
  test('(a) the DEFAULT transport is a child process, in a different process', async () => {
    const { createKokoroClient } = require('../providers/kokoro/client');
    const c = createKokoroClient({ env: process.env, initTimeoutMs: 5000, synthTimeoutMs: 5000, workerPath: FAKE });
    assert.equal(typeof c.transport, 'function', 'the default was a worker THREAD with no transport to report');
    assert.equal(c.transport(), 'child-process');
    const r = await c.synthesize({ text: 'x' });
    assert.notEqual(r.pid, process.pid, 'synthesis must run in ANOTHER process');
    await c.shutdown();
  });

  test('(b) a NATIVE abort mid-synthesis: the host survives, the call fails honestly, the replacement speaks', () => {
    const { status, out } = runHarness('abort', 'abort-on-synth');
    assert.equal(status, 0, 'the host process died with its Kokoro child — exit ' + status);
    assert.ok(out && out.first && out.first.ok === false, 'the aborted synthesis must fail, not hang or fake success');
    assert.match(out.first.error, /exited/, 'and say the engine exited: ' + (out && out.first && out.first.error));
    assert.equal(out.second.ok, true, 'the next synthesis must run on a fresh child');
    assert.notEqual(out.second.pid, out.hostPid);
  });

  test('(c) a synthesis past its deadline KILLS the child (a process, so its threads die with it); the replacement speaks', () => {
    const { status, out } = runHarness('hang', 'hang-on-synth');
    assert.equal(status, 0);
    assert.equal(out.first.ok, false);
    assert.match(out.first.error, /timed out/);
    assert.equal(out.second.ok, true);
  });

  test('(w) CONTROL: the same abort inside a worker THREAD takes the host down — why a thread cannot contain it', () => {
    const script = [
      "const { Worker } = require('node:worker_threads');",
      `const w = new Worker(${JSON.stringify(FAKE)});`,
      "w.postMessage({ id: 1, gen: 1, op: 'synthesize', text: 'x' });",
      'setTimeout(() => { process.stdout.write("host survived\\n"); process.exit(0); }, 3000);',
    ].join('\n');
    const dir = tmp();
    const env = Object.assign({}, process.env, { KOKORO_FAKE_MODE: 'abort-on-synth', KOKORO_FAKE_DIR: dir });
    const r = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 20000 });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.notEqual(r.status, 0, 'a native abort in a worker thread must be fatal to its host (measured: it is)');
    assert.doesNotMatch(r.stdout || '', /host survived/);
  });

  test('(d) ELECTRON_RUN_AS_NODE=1 is set in the CHILD only — the host environment is untouched', async () => {
    const { childEnv } = require('../providers/kokoro/child-transport');
    const before = process.env.ELECTRON_RUN_AS_NODE;
    const env = childEnv({ PATH: 'x' });
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1', 'the packaged server runs electron.exe as execPath; without this the child would start a GUI');
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, before);
    const { createKokoroClient } = require('../providers/kokoro/client');
    const c = createKokoroClient({ env: process.env, initTimeoutMs: 5000, synthTimeoutMs: 5000, workerPath: FAKE });
    const r = await c.synthesize({ text: 'x' });
    assert.equal(r.electronRunAsNode, '1', 'the child must have been started with it');
    await c.shutdown();
  });

  test('(e) the child stays while connected and leaves when its parent goes away — no orphan holding a model', async () => {
    const child = forkWorker();
    const exited = new Promise((r) => child.once('exit', r));
    // Alive and listening FIRST — otherwise "it exited" proves nothing (the old
    // worker.js exited at once when forked, and this test passed vacuously on it).
    try { await ask(child, { id: 1, gen: 1, op: 'no-such-op' }); } finally { /* fall through to the disconnect */ }
    child.disconnect();
    const t = await Promise.race([exited.then(() => 'exited'), new Promise((r) => setTimeout(() => r('still running'), 3000))]);
    if (t !== 'exited') child.kill();
    assert.equal(t, 'exited', 'the real worker.js must exit when its IPC channel closes');
  });

  test('(f) the real worker.js answers over IPC, with no model loaded', async () => {
    const child = forkWorker();
    let reply;
    try { reply = await ask(child, { id: 7, gen: 3, op: 'no-such-op' }); } finally { child.kill(); }
    assert.deepEqual({ id: reply.id, gen: reply.gen, ok: reply.ok }, { id: 7, gen: 3, ok: false });
    assert.match(reply.error, /unknown op/);
  });

  test('(g) shutdown() leaves no child process behind', async () => {
    const { createKokoroClient } = require('../providers/kokoro/client');
    const c = createKokoroClient({ env: process.env, initTimeoutMs: 5000, synthTimeoutMs: 5000, workerPath: FAKE });
    const r = await c.synthesize({ text: 'x' });
    await c.shutdown();
    assert.equal(alive(r.pid), false, 'a Kokoro child outlived shutdown');
  });

  test('(h) ADJACENT: audio bytes cross the process boundary intact', async () => {
    const { createKokoroClient } = require('../providers/kokoro/client');
    const c = createKokoroClient({ env: process.env, initTimeoutMs: 5000, synthTimeoutMs: 5000, workerPath: FAKE });
    const r = await c.synthesize({ text: 'x' });
    await c.shutdown();
    const v = new Uint8Array(r.audio);
    assert.equal(v.length, 1000);
    for (let i = 0; i < v.length; i++) if (v[i] !== i % 251) assert.fail('byte ' + i + ' changed crossing the process boundary');
  });
});

// MUTATION TABLE, 2026-09-23. Six probes, each applied (sha256 changed), run against
// this file and bug-372-kokoro-worker-and-cache.test.js, restored (sha256 equal):
//   M1  the default transport is a worker THREAD again        -> (a) (b) (d) (g)
//   M2  IPC serialization 'json' — the ArrayBuffer is lost     -> (h)
//   M3  ELECTRON_RUN_AS_NODE not set in the child env          -> (d)
//   M4  the child does not leave when its parent goes away     -> (e)
//   M5  worker.js does not listen on IPC (the old shape)       -> (e) (f)
//   M6  terminate() does not wait for the exit                 SURVIVED — and it is
//       recorded rather than hidden. On Windows kill() is TerminateProcess, which
//       leaves no window between the kill and the exit that a pid check can see, so
//       no test on this platform can observe the wait. It is kept because on POSIX
//       SIGTERM -> exit is asynchronous; (g) is named for what it DOES prove.
// The first red run of (e) PASSED vacuously (the old worker.js exits the moment it
// is forked, because nothing listens); (e) now requires an answer first, and (f)
// hung the file for 120 s until every IPC wait was bounded.
// REAL-MODEL EVIDENCE (not in this suite: CI has no weights) — the same matrix
// after the repair: all 12 trials exit 0; four kills then a synthesis survive; the
// real server quits 0 in 65 ms (it crashed 0xC0000409 ~4 s after exit before);
// the PACKAGED MYTHOS.exe runs verify-packaged-kokoro.js to PASS with transport
// child-process, 28 voices, 211,244 bytes, 0 network calls.
