'use strict';

// test/bug-437-no-reflection-at-quit.test.js
//
// BUG-437 closure, 2026-10-06 (operator decision): the quit sequence does NOT
// run the reflection pass ("what did I learn today"). Measured: it timed out at
// its 5.5 s budget on 2 of the last 3 closes (2026-09-24, 2026-10-06), so
// `lifecycle.shutdown.complete` read clean=false for a step whose answer was
// fenced and written nowhere. Reflection already runs DURING the session:
// reflection.noteTurn() -> runNow('cadence') every REFLECTION_EVERY_TURNS (15)
// completed Live turns (identity/reflection.js noteTurn; called per turn from
// voice/live-tool-adapter.js), and reflectOnActions on a wall-clock timer
// (main.js actionReflectTimer).
//
// What this file pins:
//   (a) quitting never invokes reflection — not runNow, not even the getter —
//       so a reflection that would hang cannot make the quit unclean;
//   (b) the saving steps still run, in the 2026-09-23 order, and a healthy
//       quit reports clean:true;
//   (c) ADJACENT: a saving step that times out still reports clean:false (the
//       clean flag was not neutered along with reflection);
//   (d) main.js no longer hands the quit sequence a reflection;
//   (e) PREMISE of the decision: the periodic path still fires runNow
//       ('cadence') after REFLECTION_EVERY_TURNS turns — if that ever breaks,
//       skipping reflection at quit would lose it entirely.
//
// RED FIRST, 2026-10-06, against 323fba62: see the literal output recorded in
// the BUG-437 closure report. (a) and (b) failed because reflection was still
// the last quit step; (d) failed because main.js still passed getReflection.
// (c) and (e) were green before the change, as adjacent controls should be.
//
// MUTATIONS, 2026-10-06 (each applied — diff checked — run, restored):
//   M1  re-add the reflection-final-pass step to shutdown-steps.js  -> (a) (b)
//   M2  main.js passes getReflection again                          -> (d)
//   M3  lifecycle `clean` hardcoded true                            -> (c)
//   M4  noteTurn stops calling runNow('cadence')                    -> (e)
//
// UNREACHABLE NOW (gate F): reflection.runNow's `opts.signal` fence
// ('shutdown-deadline', reflection.js) has no production caller; its unit test
// in bug-437-shutdown-saves-before-reflecting.test.js (d) still reaches it
// directly and is kept as a backstop for any future caller that passes a signal.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fsNode = require('node:fs');
const { EventEmitter } = require('node:events');

const { createLifecycle } = require('../src/core/lifecycle');
const { registerCoreShutdownSteps } = require('../src/core/lifecycle/shutdown-steps');

function fakeProc() {
  const p = new EventEmitter();
  p.exits = [];
  p.exit = (code) => { p.exits.push(code); };
  p.send = () => {};
  return p;
}
function rig() {
  const lines = [];
  const log = (level) => (msg, f) => lines.push(Object.assign({ level, msg }, f || {}));
  const lc = createLifecycle({
    bus: { emit() {} }, logger: { info: log('info'), warn: log('warn'), error: log('error') },
    config: {}, proc: fakeProc(), shutdownReserveMs: 50, drainMaxMs: 100,
  });
  return { lc, lines };
}
const stepLines = (lines) => lines.filter((l) => l.msg === 'lifecycle.shutdown.step');
const completeLine = (lines) => lines.find((l) => l.msg === 'lifecycle.shutdown.complete');
const never = () => new Promise(() => {});

function wire(lc, done, over) {
  const memory = {
    working: { flushToEpisodic: async () => done.push('episodic-flush'), snapshot: () => ({ tick: 1 }) },
    checkpoints: { save: () => { done.push('checkpoint-write'); return { ok: true }; } },
    audit: { write: () => { done.push('audit-flush'); return { ok: true }; } },
  };
  // getReflection is passed on purpose: the registrar must ignore it entirely.
  const calls = { getter: 0, runNow: [] };
  registerCoreShutdownSteps(lc, Object.assign({
    stopRunningLoops: () => done.push('stop-loops'),
    getMemory: () => memory,
    getReflection: () => { calls.getter += 1; return { runNow: (...a) => { calls.runNow.push(a); return never(); } }; },
  }, over || {}));
  return calls;
}

describe('BUG-437 closure — quit does not run reflection', () => {
  test('(a)+(b) reflection is never invoked; saving steps run in order; a healthy quit is clean', async () => {
    const { lc, lines } = rig();
    const done = [];
    const calls = wire(lc, done);
    const res = await lc.shutdown(1000);
    assert.deepEqual(calls.runNow, [], 'reflection must never be invoked at quit');
    assert.equal(calls.getter, 0, 'the quit sequence must not even look reflection up');
    assert.deepEqual(done, ['stop-loops', 'episodic-flush', 'checkpoint-write', 'audit-flush']);
    assert.deepEqual(stepLines(lines).map((l) => l.step), ['stop-loops', 'episodic-flush', 'checkpoint-write', 'audit-flush']);
    assert.equal(res.clean, true);
    assert.equal(completeLine(lines).clean, true);
    assert.deepEqual(completeLine(lines).notOk, []);
  });

  test('(c) ADJACENT: a saving step that times out still reports clean:false', async () => {
    const { lc, lines } = rig();
    const done = [];
    wire(lc, done, { getMemory: () => ({
      working: { flushToEpisodic: never, snapshot: () => ({}) },
      checkpoints: { save: () => ({ ok: true }) }, audit: { write: () => ({ ok: true }) },
    }) });
    const res = await lc.shutdown(300);
    assert.equal(stepLines(lines).find((l) => l.step === 'episodic-flush').status, 'timeout');
    assert.equal(res.clean, false);
    assert.equal(completeLine(lines).clean, false);
    assert.ok(completeLine(lines).notOk.some((s) => s.startsWith('episodic-flush:')));
  });

  test('(d) main.js hands the quit sequence no reflection', () => {
    const src = fsNode.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
    const at = src.indexOf('registerCoreShutdownSteps(');
    const call = src.slice(at, src.indexOf('});', at));
    assert.ok(call.length > 0 && call.includes('stopRunningLoops'), 'found the registration call');
    assert.doesNotMatch(call, /getReflection|reflection/i, 'main.js still passes reflection to the quit sequence');
  });

  test('(e) PREMISE: the periodic path still runs the conversation reflection every REFLECTION_EVERY_TURNS turns', async () => {
    const { createReflection } = require('../src/core/identity/reflection');
    let recalls = 0;
    const reflection = createReflection({
      brain: { think: async () => ({ parsed: {} }) },
      memory: { episodic: { recall: () => { recalls += 1; return []; } }, identity: { readRaw: () => '' } },
      identity: { learn: async () => ({}), setOperatorStyle() {}, setOperatorProfile() {}, getOperatorProfile: () => '' },
      config: { REFLECTION_EVERY_TURNS: 3, REFLECTION_ACTION_EVERY_TURNS: 1000 },
      // 2026-10-07: since BUG-464 (operator decision 2026-10-06) the identity pass runs
      // only with MEMORY_AUTO_USER_FACTS=true. This premise is about the cadence, so it
      // states the switch rather than depending on the machine's environment.
      env: { MEMORY_AUTO_USER_FACTS: 'true' },
      logger: { info() {}, warn() {} },
    });
    reflection.noteTurn(); reflection.noteTurn();
    await new Promise((r) => setImmediate(r));
    assert.equal(recalls, 0, 'control: nothing before the cadence is reached');
    reflection.noteTurn();
    await new Promise((r) => setImmediate(r));
    assert.ok(recalls >= 1, 'the third turn must start the cadence pass (runNow reads recent conversations)');
  });
});
