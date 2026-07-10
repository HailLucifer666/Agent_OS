'use strict';

// CHAOS DRILL 5 — Concurrent-tick.
// Calls cortex.tickOnce() twice without awaiting the first, and proves the
// reentrancy guard (_inFlight) makes the second call a true no-op while the first
// completes normally start-to-finish.
//
// This is ALSO the mandatory real-instance cortex<->goals integration test required
// by lesson #4 / Risk R9: it wires the REAL goals module (not a fake) so that if a
// future change reintroduces D-38 (stripping rankedSalience before arbitrate()), this
// test catches it — the fake-goals tests in cortex-goals.test.js structurally cannot.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fakeBus() {
  const { createBus } = require('../src/core/bus');
  return createBus({ historySize: 200 });
}

function stubLeash() { return { check: function() { return { allow: true, requireConfirm: false, tier: 0 }; } }; }

describe('chaos drill: concurrent-tick', () => {
  it('two overlapping tickOnce() calls: second no-ops, first completes normally, real goals.arbitrate sees rankedSalience', async () => {
    const { createCortex } = require('../src/core/cortex');
    const { createGoalSystem } = require('../src/core/goals');

    const bus = fakeBus();
    const fs = { writeJSON: function() {}, ensureDir: function() {}, listFiles: function() { return []; }, removeFile: function() {} };
    // P10 BUILD FIX: ACTION_TIMEOUT_MS added — this drill's goal has a pending plan
    // step, so cortex genuinely reaches act(), which does
    // `AbortSignal.timeout(ACTION_TIMEOUT_MS)` (cortex/index.js:164). That key has no
    // inline fallback (schema-guaranteed only, cortex/index.js:21-24) — omitting it
    // makes AbortSignal.timeout(undefined) throw (verified directly), which cortex's
    // own try/catch would swallow into a silent 'tick-error' anomaly, making
    // invokeCallCount stay 0 and this test fail on a false premise instead of testing
    // the reentrancy guard. Every other real test that reaches act() sets this
    // (cortex-goals.test.js, immune.test.js) — matching house convention.
    const config = { MYTHOS_TICK_MS: 60000, MAX_ACTIVE_GOALS: 5, ACTION_TIMEOUT_MS: 30000 }; // long interval — only manual tickOnce() calls fire

    // REAL goals module — the exact seam D-38 broke.
    const goals = createGoalSystem({ fs: fs, config: config, bus: bus, memory: null, brain: null });
    const goal = goals.create({ title: 'Chaos concurrent target', drive: 'user-service', status: 'active' });
    // Pre-populate a pending plan step so plan() resolves without a real Brain call.
    goals.update(goal.id, { plan: [{ tool: 'noop_tool', args: {}, status: 'pending' }] });

    // Spy on the REAL arbitrate to capture what cortex actually hands it.
    const arbitrateCalls = [];
    const realArbitrate = goals.arbitrate.bind(goals);
    goals.arbitrate = function(perceptions, working) {
      arbitrateCalls.push(perceptions);
      return realArbitrate(perceptions, working);
    };

    let drainCallCount = 0;
    let invokeCallCount = 0;
    const memory = {
      working: {
        tick: 0,
        activeGoalId: null,
        spendThisTick: 0,
        drainPerceptions: function() {
          drainCallCount++;
          // One high-salience perception so orient() produces a ranked entry.
          return [{ summary: 'chaos concurrent perception', salience: 0.8, channel: 'test' }];
        },
        resetTickState: function() { this.spendThisTick = 0; },
        pushPerception: function() {},
        addSpend: function() {}
      },
      episodic: { write: async function() { return { ref: 'ep-x', degraded: false }; } },
      consolidate: async function() {}
    };

    const effectors = {
      invoke: async function() {
        invokeCallCount++;
        await sleep(40); // widens the in-flight window so the second tickOnce() truly overlaps
        return { ok: true };
      },
      breakers: { allow: function() { return true; } }
    };

    const cortex = createCortex({ bus: bus, memory: memory, goals: goals, brain: null, leash: stubLeash(), effectors: effectors, config: config });
    cortex.start();

    const p1 = cortex.tickOnce();
    const p2 = cortex.tickOnce(); // fired before p1 resolves — must be a no-op
    await Promise.all([p1, p2]);

    assert.equal(drainCallCount, 1, 'OBSERVE must run exactly once — the second concurrent call must never reach it');
    assert.equal(memory.working.tick, 1, 'tick counter must increment exactly once');
    assert.equal(invokeCallCount, 1, 'the effector must be dispatched exactly once — no double-dispatch from the overlap');
    assert.equal(arbitrateCalls.length, 1, 'arbitrate must be called exactly once');

    // The D-38 regression check: arbitrate must receive objects carrying rankedSalience,
    // not bare perceptions stripped of it.
    const firstCallArg = arbitrateCalls[0];
    assert.ok(Array.isArray(firstCallArg) && firstCallArg.length > 0, 'arbitrate must receive a non-empty array');
    assert.ok(
      firstCallArg.every((p) => typeof p.rankedSalience === 'number'),
      'every perception handed to goals.arbitrate() must carry a numeric rankedSalience field (D-38 regression)'
    );

    cortex.stop();
  });
});
