'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('../src/core/bus');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { createCortex } = require('../src/core/cortex');

describe('integration: real cortex + real effector hub', () => {
  it('dispatches a decision through the real hub and records action.completed', async () => {
    const bus = createBus({ historySize: 50 });
    const hub = createEffectorHub({ bus, config: {} });
    // register.() would normally call createBreaker from immune/breakers.js (P6);
    // that module has shipped by the time Phase 7 lands, so the real hub.register()
    // path (real createBreaker, real BreakerRegistry) is exercised here — only the
    // effector itself is a minimal test double, per lesson #4 (real seams, not mocks).
    hub.register({
      id: 'test_tool', tier: 0,
      describe: () => 'test',
      validate: () => ({ ok: true }),
      invoke: async () => ({ ok: true, result: 'done' })
    });

    const memory = { working: {
      tick: 0, activeGoalId: null, spendThisTick: 0,
      drainPerceptions: () => [], resetTickState() { this.spendThisTick = 0; },
      pushPerception() {}, addSpend() {}
    }, episodic: { write: async () => ({ ref: 'ep-1' }) }, consolidate: async () => {} };
    const goals = {
      getActive: () => null, hasActive: () => false,
      arbitrate: () => ({ id: 'goal-1' }),
      plan: async () => ({ tool: 'test_tool', args: {} }),
      debitBudget: () => {}
    };
    const leash = { check: () => ({ allow: true, requireConfirm: false, tier: 0 }) };

    const cortex = createCortex({ bus, memory, goals, brain: null, leash, effectors: hub, config: { MYTHOS_TICK_MS: 1000 } });
    memory.working.drainPerceptions = () => [{ summary: 'x', channel: 'test', salience: 0.9 }];

    // tickOnce() no-ops unless the cortex is running (real cortex/index.js:24 guards on
    // `running`, set only by start()) — start()/stop() bracket the single manual tick so
    // the unref'd setInterval never outlives this test.
    cortex.start();
    await cortex.tickOnce();
    cortex.stop();

    const history = bus.history();
    assert.ok(history.some((e) => e.type === 'tick'));
    assert.ok(history.some((e) => e.type === 'action.completed' && e.payload.ok === true));
  });

  it('a real breaker trip on the real hub still surfaces through effectors.breakers.allow (Ambiguity #4 regression)', async () => {
    const bus = createBus({ historySize: 50 });
    const hub = createEffectorHub({ bus, config: { BREAKER_FAIL_THRESHOLD: 1 } });
    hub.register({
      id: 'flaky_tool', tier: 0,
      describe: () => 'test',
      validate: () => ({ ok: true }),
      invoke: async () => ({ ok: false, result: 'boom' })
    });

    await hub.invoke('flaky_tool', {}, {});
    assert.equal(hub.breakers.allow('flaky_tool'), false);

    const result = await hub.invoke('flaky_tool', {}, {});
    assert.deepEqual(result, { ok: false, result: 'circuit-open' });
  });
});
