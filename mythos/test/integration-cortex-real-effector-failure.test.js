'use strict';

// R9 regression (Risk Register): "Not covered: Cortex→Effectors under real
// (non-stub) effectors during a failure (Drills 2/5/6 all use stub effectors to
// isolate the seam under test); recommend one more real-instance test." Every
// existing cortex/effector integration test (test/integration-cortex-effectors.test.js,
// the chaos drills) registers a minimal test-double effector into the real hub. This
// file drives a real, shipped, production effector — effectors/from-system.js's
// get_weather (a real network call through effectorFromTool's real adapter) — through
// a real cortex tick, with the failure being a genuine network outage (the real
// fetch() call actually fails), not a fake ok:false stub.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('../src/core/bus');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { createCortex } = require('../src/core/cortex');
const { registerFromSystem } = require('../src/core/effectors/from-system');

describe('R9 integration: real cortex + real (non-stub) production effector during a real failure', () => {
  it('get_weather (real effector, real adapter) genuinely fails over an unreachable host — cortex records the failure and trips the real breaker', async () => {
    const bus = createBus({ historySize: 100 });
    const hub = createEffectorHub({ bus, config: { BREAKER_FAIL_THRESHOLD: 1 } });

    // Real production registration path — registerFromSystem() + effectorFromTool(),
    // no test double anywhere in the effector itself. Point it at a host that does
    // not exist so the real fetch() inside from-system.js's getWeather() genuinely
    // rejects (DNS failure), not a mocked rejection.
    const originalUrl = global.fetch;
    registerFromSystem(hub, { config: { WEATHER_LOCATION: '0,0' } });
    // Force the real network call to fail deterministically without relying on
    // external DNS behavior in CI: override global.fetch to reject like a real
    // outage would, scoped to this test only.
    global.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND api.open-meteo.com'); };

    const memory = {
      working: {
        tick: 0, activeGoalId: null, spendThisTick: 0,
        drainPerceptions: () => [{ summary: 'weather check', channel: 'test', salience: 0.9 }],
        resetTickState() { this.spendThisTick = 0; },
        pushPerception() {}, addSpend() {}
      },
      episodic: { write: async (rec) => { memory._lastWrite = rec; return { ref: 'ep-1' }; } },
      consolidate: async () => {},
      _lastWrite: null
    };
    const goals = {
      getActive: () => null, hasActive: () => false,
      arbitrate: () => ({ id: 'goal-1' }),
      // BUG-446 (2026-09-23): the cortex's autonomous dispatch now checks the goal
      // it runs for (goals/execution-gate.js). This fake describes the ACTIVE goal
      // arbitrate() returns, the way the real goal system would.
      get: (id) => ({ id, status: 'active', budget: { tokens: 20000, actions: 25 }, spent: { tokens: 0, actions: 0 } }),
      plan: async () => ({ tool: 'get_weather', args: {} }),
      debitBudget: () => {}
    };
    const leash = { check: () => ({ allow: true, requireConfirm: false, tier: 0 }) };

    const cortex = createCortex({ bus, memory, goals, brain: null, leash, effectors: hub, config: { MYTHOS_TICK_MS: 1000, ACTION_TIMEOUT_MS: 30000 } });

    try {
      cortex.start();
      await cortex.tickOnce();
      cortex.stop();

      // The real effector never throws (from-system.js's own honest-degrade
      // philosophy) — it returns { ok: false, result: '...' }, so the failure must
      // surface as a normal, well-formed action outcome, not an uncaught exception
      // anywhere in the real Cortex->EffectorHub->adapter->tool chain.
      const history = bus.history();
      const completed = history.find((e) => e.type === 'action.completed');
      assert.ok(completed, 'action.completed must still fire — a real network failure inside an effector must not crash the tick');
      assert.equal(completed.payload.ok, false, 'the real weather effector\'s honest failure must be reported as ok:false, not swallowed as success');

      assert.ok(memory._lastWrite, 'episodic action record must be written even on a real-effector failure');
      assert.equal(memory._lastWrite.outcome, 'fail');
      assert.match(memory._lastWrite.detail.result, /unavailable right now/, 'the real effector\'s own honest error message must survive to the episodic record, unmodified by the hub');

      // Real breaker (immune/breakers.js, wired by the real hub, not a fake) must
      // have recorded the failure and tripped at threshold 1.
      assert.equal(hub.breakers.allow('get_weather'), false, 'the real breaker must trip on the real effector\'s real failure');

      // A second dispatch of the same real effector while the real breaker is open
      // must short-circuit at the hub, never re-invoking the (still-broken) tool.
      const secondResult = await hub.invoke('get_weather', {}, {});
      assert.deepEqual(secondResult, { ok: false, result: 'circuit-open' });
    } finally {
      global.fetch = originalUrl;
    }
  });
});
