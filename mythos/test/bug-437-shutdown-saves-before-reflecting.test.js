'use strict';

// test/bug-437-shutdown-saves-before-reflecting.test.js
//
// BUG-437, the server half (2026-09-23 attended run): an X-button quit logged
// `step=stop-loops status=ok`, then nothing for exactly 6.000 s, then
// `lifecycle.shutdown.hard-exit`. Step 2 was `reflection-final-pass` — a brain
// (LLM) call inside a 6 s budget — and the three steps that SAVE data
// (episodic-flush, checkpoint-write, audit-flush) never ran:
// Checkpoints/latest.json was 47 s older than the quit.
//
// What this file pins (the mechanism is in src/core/lifecycle/index.js and
// src/core/lifecycle/shutdown-steps.js):
//   (a) the production order: the saving steps run BEFORE reflection, and a
//       reflection that never returns cannot stop them;
//   (b) a stalled server drain is bounded and the steps still run;
//   (c) a stalled step is cut at the deadline, logged as `timeout` with its
//       elapsed time, and the sequence moves on — `complete` says clean:false;
//   (d) a reflection that returns AFTER its deadline writes NOTHING (fenced),
//       and one that returns in time writes normally;
//   (e) repeated quit signals share ONE shutdown: no exit before it completes,
//       every step runs once;
//   (f) the checkpoint written at shutdown is read back by a fresh store — the
//       contents, not only the call;
//   (g) main.js no longer registers shutdown steps of its own.
//
// RED FIRST, 2026-09-23, against 2a252e0b: (a) and (g) failed because the steps
// lived inline in main.js with reflection second; (b) and (c) failed because a
// stalled step or drain hung the sequence until the hard exit; (e) failed —
// the second IPC message resolved `shutdown()` immediately (it returned
// undefined) and exit(0) ran before the first shutdown finished. Each failed for
// the reason named.
//
// MUTATIONS, 2026-09-23: table at the bottom of this file.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fsNode = require('node:fs');
const { EventEmitter } = require('node:events');

const { createLifecycle } = require('../src/core/lifecycle');
const shutdownStepsPath = path.join(__dirname, '../src/core/lifecycle/shutdown-steps.js');

function recorder() {
  const lines = [];
  const log = (level) => (msg, fields) => lines.push(Object.assign({ level, msg }, fields || {}));
  return { lines, logger: { info: log('info'), warn: log('warn'), error: log('error') } };
}
function fakeProc() {
  const p = new EventEmitter();
  p.exits = [];
  p.exit = (code) => { p.exits.push(code); };
  p.send = () => {};
  return p;
}
const bus = { emit() {} };
const never = () => new Promise(() => {});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Every wait on a shutdown is bounded, so a regression that stops the sequence
// finishing is a NAMED red here, not a hung run (mutation M2 hung before this).
function within(p, ms, why) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(why)), ms); })]).finally(() => clearTimeout(t));
}
const HELD = 'the shutdown never finished — a stalled step or drain held the whole sequence';

function lifecycle(extra) {
  const r = recorder();
  const proc = fakeProc();
  const lc = createLifecycle(Object.assign({ bus, logger: r.logger, config: {}, proc, shutdownReserveMs: 50, drainMaxMs: 100 }, extra || {}));
  return { lc, r, proc };
}
const stepLines = (r) => r.lines.filter((l) => l.msg === 'lifecycle.shutdown.step');
const completeLine = (r) => r.lines.find((l) => l.msg === 'lifecycle.shutdown.complete');

describe('BUG-437 — the saving steps run first and cannot be held hostage', () => {
  test('(a) production order: saving steps before reflection; a reflection that never returns cannot stop them', async () => {
    assert.ok(fsNode.existsSync(shutdownStepsPath), 'the production shutdown order is not a module a test can read');
    const { registerCoreShutdownSteps } = require(shutdownStepsPath);
    const { lc, r } = lifecycle();
    const done = [];
    const memory = {
      working: { flushToEpisodic: async () => done.push('episodic-flush'), snapshot: () => ({ tick: 7 }) },
      checkpoints: { save: () => { done.push('checkpoint-write'); return { ok: true }; } },
      audit: { write: () => { done.push('audit-flush'); return { ok: true }; } },
    };
    let seen = null;
    registerCoreShutdownSteps(lc, {
      stopRunningLoops: () => done.push('stop-loops'),
      getMemory: () => memory,
      getReflection: () => ({ runNow: (reason, opts) => { seen = opts; return never(); } }),
    });
    await within(lc.shutdown(600), 2000, HELD);
    assert.ok(seen && seen.signal, 'reflection must be handed the step deadline as an AbortSignal');
    assert.equal(seen.signal.aborted, true, 'and it must be aborted once the deadline passes');
    assert.deepEqual(done, ['stop-loops', 'episodic-flush', 'checkpoint-write', 'audit-flush'],
      'every saving step must run, in this order, before reflection is even started');
    const names = stepLines(r).map((l) => l.step);
    assert.equal(names[names.length - 1], 'reflection-final-pass', 'reflection runs LAST');
    assert.equal(stepLines(r).find((l) => l.step === 'reflection-final-pass').status, 'timeout');
  });

  test('(b) a server drain that never finishes is bounded, and the steps still run', async () => {
    const { lc, r } = lifecycle();
    const ran = [];
    lc.registerStopServer(never);
    lc.registerShutdownStep('checkpoint-write', () => ran.push('checkpoint-write'));
    await within(lc.shutdown(1000), 2500, HELD);
    assert.deepEqual(ran, ['checkpoint-write']);
    const drain = stepLines(r).find((l) => l.step === 'server-close');
    assert.equal(drain.status, 'timeout');
    assert.ok(drain.elapsedMs >= 90 && drain.elapsedMs < 400, 'bounded by drainMaxMs, measured ' + drain.elapsedMs);
  });

  test('(c) a stalled step is cut at the deadline, named with its elapsed time, and the sequence continues', async () => {
    const { lc, r, proc } = lifecycle();
    const ran = [];
    lc.registerShutdownStep('stuck', never);
    lc.registerShutdownStep('after', () => ran.push('after'));
    const start = Date.now();
    await within(lc.shutdown(400), 1500, HELD);
    assert.ok(Date.now() - start < 450, 'the sequence finished before the hard exit would have');
    assert.deepEqual(proc.exits, [], 'no hard exit fired');
    const stuck = stepLines(r).find((l) => l.step === 'stuck');
    assert.equal(stuck.status, 'timeout');
    assert.equal(typeof stuck.elapsedMs, 'number');
    // `after` got no time: the deadline belongs to the whole sequence, not to each step.
    assert.equal(stepLines(r).find((l) => l.step === 'after').status, 'skipped');
    assert.equal(completeLine(r).clean, false, 'complete alone must not read as success');
  });

  test('ADJACENT: healthy steps are all ok, complete says clean:true', async () => {
    const { lc, r } = lifecycle();
    lc.registerShutdownStep('one', () => {});
    lc.registerShutdownStep('two', async () => {});
    await lc.shutdown(1000);
    assert.deepEqual(stepLines(r).map((l) => l.status), ['ok', 'ok']);
    assert.equal(completeLine(r).clean, true);
  });

  test('(d) a reflection that returns AFTER its deadline writes nothing; one in time writes', async () => {
    const { createReflection } = require('../src/core/identity/reflection');
    function rig(delayMs) {
      const writes = [];
      const reflection = createReflection({
        brain: { think: async ({ signal }) => { await wait(delayMs); return { parsed: { preferences: ['prefers short answers late at night'], style: 'terse and direct', profile: 'Calls me boss.\nWorks late.' } }; } },
        memory: { episodic: { recall: () => Array.from({ length: 6 }, (_, i) => ({ record: { summary: 'turn ' + i } })) }, identity: { readRaw: () => '' } },
        identity: {
          learn: async (e) => { writes.push('learn:' + e.text); return { ref: 'r' }; },
          setOperatorStyle: (s) => { writes.push('style'); return { ok: true }; },
          setOperatorProfile: (p) => { writes.push('profile'); return { ok: true }; },
          getOperatorProfile: () => '',
        },
        logger: { info() {}, warn() {} },
        // CHANGED 2026-10-06 (BUG-464 widened): the pass now runs only with the
        // switch on; this test is about the deadline, so it turns it on.
        env: { MEMORY_AUTO_USER_FACTS: 'true' },
      });
      return { reflection, writes };
    }
    const late = rig(300);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const res = await late.reflection.runNow('shutdown', { signal: ac.signal });
    assert.deepEqual(late.writes, [], 'a reflection past its deadline must not write — it would race the exit');
    assert.equal(res.skipped, 'shutdown-deadline');

    const inTime = rig(10);
    await inTime.reflection.runNow('shutdown', { signal: new AbortController().signal });
    assert.deepEqual(inTime.writes, ['learn:prefers short answers late at night', 'style', 'profile'], 'ADJACENT: in time, it writes');
  });

  test('(e) repeated quit signals share ONE shutdown: no exit before it completes, steps run once', async () => {
    const { lc, proc } = lifecycle();
    const ran = [];
    lc.registerShutdownStep('slow-save', async () => { await wait(80); ran.push('slow-save'); });
    lc.registerShutdown();
    proc.emit('message', { channel: 'mythos:shutdown', timeoutMs: 1000 });
    await wait(5);
    proc.emit('message', { channel: 'mythos:shutdown', timeoutMs: 1000 });
    proc.emit('SIGTERM');
    await wait(20);
    assert.deepEqual(proc.exits, [], 'a second signal exited while the first shutdown was still saving');
    await wait(200);
    assert.deepEqual(ran, ['slow-save'], 'the step ran exactly once');
    assert.ok(proc.exits.length >= 1 && proc.exits.every((c) => c === 0));
    assert.equal(lc.shutdown(), lc.shutdown(), 'one shared promise');
  });

  test('(f) the checkpoint written at shutdown is read back by a fresh store — contents, not only the call', async () => {
    const { tempVaultDir, cleanupVaultDir } = require('./helpers');
    const { createFsStore } = require('../src/core/memory/fs-store');
    const { createCheckpointStore } = require('../src/core/memory/checkpoints');
    const dir = tempVaultDir();
    try {
      const fs = createFsStore(() => dir, null);
      const store = createCheckpointStore({ fs, config: {}, bus, logger: recorder().logger });
      await store.init();
      const { registerCoreShutdownSteps } = require(shutdownStepsPath);
      const { lc } = lifecycle();
      registerCoreShutdownSteps(lc, {
        stopRunningLoops: () => {},
        getMemory: () => ({
          working: { flushToEpisodic: async () => {}, snapshot: () => ({ tick: 4242, activeGoalId: 'g-437', contextKeys: ['quit'] }) },
          checkpoints: store,
          audit: { write: () => ({ ok: true }) },
        }),
        getReflection: () => null,
      });
      await lc.shutdown(1000);
      const reread = createCheckpointStore({ fs: createFsStore(() => dir, null), config: {}, bus, logger: recorder().logger }).load();
      assert.equal(reread.tick, 4242);
      assert.equal(reread.activeGoalId, 'g-437');
      assert.deepEqual(reread.salientContextKeys, ['quit']);
    } finally { cleanupVaultDir(dir); }
  });

  test('(g) main.js registers no shutdown step of its own — the order lives in one module', () => {
    const src = fsNode.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
    assert.doesNotMatch(src, /registerShutdownStep\(/, 'main.js registers its own shutdown steps (reflection second)');
    assert.match(src, /registerCoreShutdownSteps\(/);
  });
});

// MUTATION TABLE, 2026-09-23. Eight probes, each applied (sha256 changed), run
// against this file, restored (sha256 equal):
//   M1  a reflection step registered before the saving steps again    -> (a)
//   M2  steps awaited directly, not raced against the deadline        -> (a) (b) (c)
//       (its FIRST run hung instead of failing: the tests awaited shutdown()
//       with no bound. Every wait now goes through within(), so the regression
//       is a named red, not a stuck run.)
//   M3  the server drain is not capped                                -> (b)
//   M4  a repeated signal gets no shared promise                      -> (e)
//   M5  a late reflection answer is not fenced                        -> (d)
//   M6  the reflection step does not pass the deadline                -> (a)
//   M7  complete always reports clean                                 -> (c)
//   M8  each step gets the whole budget instead of one deadline       -> (c)
// Not probed, by design: the hard exit now calls the INJECTED proc. Pointing it
// back at the global process would kill this test runner — which is how the red
// run found it: (b) and (c) took the whole runner down on the old code.
