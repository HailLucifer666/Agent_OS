'use strict';

// test/unknown-effector-suggestion.test.js — F4.
//
// 2026-08-12 01:30:37: the model invoked google_news_fetch, a tool that has
// never existed. cortex/index.js's RC#2 pre-flight check (act(), before the
// leash confirm gate) caught it and emitted action.completed with
// reason: 'unknown-effector' — and nothing else. By then the model had
// already told the operator "I can see some headlines", so the bare failure
// gave it no way to recover in the same turn; it could only invent again.
//
// This RC#2 check runs BEFORE effectors.invoke() (see dispatch-action.js),
// so it never reaches the hub's own BUG-076/Wave-6 suggestion machinery
// (effectors/hub.js's nearestToolNames). The fix lives in cortex/index.js
// itself: compute the same kind of near-match over the registered tool
// names and carry it on the event, so the model has real neighbours to try
// instead of a dead end.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('../src/core/bus');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { createCortex } = require('../src/core/cortex');

function registerTool(hub, id) {
  hub.register({
    id: id, tier: 0,
    describe: () => id,
    validate: () => ({ ok: true }),
    invoke: async () => ({ ok: true, result: 'done' })
  });
}

function harness(plannedTool) {
  const bus = createBus({ historySize: 50 });
  const hub = createEffectorHub({ bus, config: {} });
  registerTool(hub, 'google_search_fetch');
  registerTool(hub, 'google_calendar_fetch');
  registerTool(hub, 'launch_app');

  const memory = { working: {
    tick: 0, activeGoalId: null, spendThisTick: 0,
    drainPerceptions: () => [], resetTickState() { this.spendThisTick = 0; },
    pushPerception() {}, addSpend() {}
  }, episodic: { write: async () => ({ ref: 'ep-1' }) }, consolidate: async () => {} };
  const goals = {
    getActive: () => null, hasActive: () => false,
    arbitrate: () => ({ id: 'goal-1' }),
    plan: async () => ({ tool: plannedTool, args: {} }),
    debitBudget: () => {}
  };
  const leash = { check: () => ({ allow: true, requireConfirm: false, tier: 0 }) };

  const cortex = createCortex({ bus, memory, goals, brain: null, leash, effectors: hub, config: { MYTHOS_TICK_MS: 1000, ACTION_TIMEOUT_MS: 30000 } });
  memory.working.drainPerceptions = () => [{ summary: 'x', channel: 'test', salience: 0.9 }];

  return { bus, cortex };
}

const run = async (plannedTool) => {
  const { bus, cortex } = harness(plannedTool);
  cortex.start();
  await cortex.tickOnce();
  cortex.stop();
  const history = bus.history();
  return history.find((e) => e.type === 'action.completed' && e.payload.tool === plannedTool);
};

describe('F4 — an unknown effector names its closest real neighbours', () => {
  it('a near-miss tool name gets real registered names as suggestions', async () => {
    const event = await run('google_news_fetch');
    assert.ok(event, 'action.completed must fire for the hallucinated tool');
    assert.equal(event.payload.ok, false);
    assert.equal(event.payload.reason, 'unknown-effector', 'the bare reason string must survive for existing consumers');
    assert.ok(Array.isArray(event.payload.suggestions), 'suggestions must be an array');
    assert.ok(event.payload.suggestions.length > 0, 'google_news_fetch is close to the two google_* tools');
    assert.ok(event.payload.suggestions.every((s) => ['google_search_fetch', 'google_calendar_fetch', 'launch_app'].includes(s)),
      'suggestions must be real registered tool names, never invented ones');
  });

  it('the registry is not dumped wholesale — only a handful of closest matches', async () => {
    const event = await run('google_news_fetch');
    assert.ok(event.payload.suggestions.length <= 3, 'a handful, not the whole registry');
  });

  it('a name with no sensible match says so plainly instead of guessing', async () => {
    const event = await run('quantumflux_teleport');
    assert.equal(event.payload.reason, 'unknown-effector');
    assert.deepEqual(event.payload.suggestions, [], 'nothing close enough — a confident bad guess is worse than none');
    assert.ok(typeof event.payload.message === 'string' && event.payload.message.length > 0,
      'the failure must still say plainly that nothing matched');
    assert.doesNotMatch(event.payload.message, /Did you mean/, 'no "did you mean" phrasing when there is no real suggestion');
  });

  it('a close typo of a real tool still resolves to that tool as the top suggestion', async () => {
    const event = await run('lauch_app');
    assert.ok(event.payload.suggestions.includes('launch_app'));
  });
});
