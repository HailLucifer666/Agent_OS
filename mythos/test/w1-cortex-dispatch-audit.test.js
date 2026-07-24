'use strict';
// W1 regression: cortex act() must route through dispatchAction() so autonomous
// actions (a) write an audit line and (b) emit the ui.navigate/close-panel/
// open-web relays. Before W1 the cortex carried an inline copy of the dispatch
// steps that had drifted and skipped both — autonomous actions left no audit
// trail and autonomous UI actions never reached the dashboard.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('../src/core/bus');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { createCortex } = require('../src/core/cortex');

function buildHarness({ tool, invokeResult }) {
  const bus = createBus({ historySize: 50 });
  const hub = createEffectorHub({ bus, config: {} });
  hub.register({
    id: tool, tier: 0,
    describe: () => tool,
    validate: () => ({ ok: true }),
    invoke: async () => invokeResult
  });

  const auditCalls = [];
  const memory = {
    working: {
      tick: 0, activeGoalId: null, spendThisTick: 0,
      drainPerceptions: () => [{ summary: 'x', channel: 'test', salience: 0.9 }],
      resetTickState() { this.spendThisTick = 0; },
      pushPerception() {}, addSpend() {}
    },
    episodic: { write: async () => ({ ref: 'ep-1' }) },
    // Round-trip through JSON like the real audit-writer's fs.appendLine
    // (JSON.stringify(obj) to a .jsonl line) — a key set to `undefined` is
    // an own property on the raw object but is dropped by serialization,
    // and audit lines are read back from disk by other consumers, so this
    // mock must reflect the persisted shape, not the in-memory one.
    audit: { write: (entry) => { auditCalls.push(JSON.parse(JSON.stringify(entry))); } },
    consolidate: async () => {}
  };
  const goals = {
    getActive: () => null, hasActive: () => false,
    arbitrate: () => ({ id: 'goal-1' }),
    plan: async () => ({ tool, args: { route: 'goals' } }),
    debitBudget: () => {}
  };
  const leash = { check: () => ({ allow: true, requireConfirm: false, tier: 0 }) };

  const cortex = createCortex({
    bus, memory, goals, brain: null, leash, effectors: hub,
    config: { MYTHOS_TICK_MS: 1000, ACTION_TIMEOUT_MS: 30000 }
  });

  return { bus, hub, memory, cortex, auditCalls };
}

describe('W1: cortex act() routes through dispatchAction (audit + ui.navigate relays)', () => {
  it('an autonomous action writes an audit line (memory.audit.write)', async () => {
    const { cortex, auditCalls } = buildHarness({
      tool: 'test_tool',
      invokeResult: { ok: true, result: 'done' }
    });
    cortex.start();
    await cortex.tickOnce();
    cortex.stop();

    // The inline copy pre-W1 never wrote audit lines. dispatchAction does (step B4).
    assert.ok(auditCalls.length >= 1, 'expected at least one audit entry from autonomous dispatch');
    const completed = auditCalls.find((e) => e.decision === 'completed');
    assert.ok(completed, 'expected an audit entry with decision:"completed"');
    assert.equal(completed.tool, 'test_tool');
    assert.equal(completed.outcome, 'ok');
    // A8: a successful action must carry NO reason key at all (not just a
    // falsy one) — JSON.stringify drops an `undefined` value, so the
    // success-case audit line stays byte-identical to before A8.
    assert.equal(Object.prototype.hasOwnProperty.call(completed, 'reason'), false,
      'a successful audit entry must not have a reason key at all');
  });

  it('a navigate action emits ui.navigate so the dashboard follows the route', async () => {
    const { bus, cortex } = buildHarness({
      tool: 'navigate',
      invokeResult: { ok: true, result: { route: 'goals' } }
    });
    cortex.start();
    await cortex.tickOnce();
    cortex.stop();

    const history = bus.history();
    const nav = history.find((e) => e.type === 'ui.navigate');
    assert.ok(nav, 'expected ui.navigate emit from autonomous navigate call (missing pre-W1)');
    assert.equal(nav.payload.route, 'goals');
  });

  it('a failing autonomous action records outcome:"fail" in the audit', async () => {
    const { cortex, auditCalls } = buildHarness({
      tool: 'test_tool',
      invokeResult: { ok: false, result: 'boom' }
    });
    cortex.start();
    await cortex.tickOnce();
    cortex.stop();

    const completed = auditCalls.find((e) => e.decision === 'completed');
    assert.ok(completed, 'expected an audit entry even on failure');
    assert.equal(completed.outcome, 'fail');
    // A8: the failure reason (effectors' fail() shape lands in result.result)
    // must be carried into the audit entry — outcome:'fail' alone gives no
    // way to diagnose why.
    assert.equal(completed.reason, 'boom');
  });

  it('a failing action with a long error message truncates reason to exactly 300 chars', async () => {
    const longError = 'x'.repeat(400);
    const { cortex, auditCalls } = buildHarness({
      tool: 'test_tool',
      invokeResult: { ok: false, result: longError }
    });
    cortex.start();
    await cortex.tickOnce();
    cortex.stop();

    const completed = auditCalls.find((e) => e.decision === 'completed');
    assert.ok(completed, 'expected an audit entry even on failure');
    assert.equal(completed.reason.length, 300, 'reason must be truncated to exactly 300 chars');
    assert.equal(completed.reason, 'x'.repeat(300));
  });
});
