'use strict';

// REMEDIATION P1-5: FIX C's stop() force-resets tickOnce._inFlight=false so a
// restart during a slow-but-live tick doesn't leave every subsequent tick
// silently no-op'ing forever (the ORIGINAL bug this addressed). But tickOnce()
// itself had NO generation check in its body — the still-awaiting stale tick
// resumes after the restart and keeps mutating shared memory.working
// (activeGoalId, spendThisTick, dispatched actions) right alongside the new
// generation's own tick, a genuine overlap/race.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function fakeBus() {
  const { createBus } = require('../src/core/bus');
  return createBus({ historySize: 50 });
}

function fakeMemory() {
  return {
    working: {
      tick: 0, activeGoalId: null, spendThisTick: 0,
      drainPerceptions: function () { return []; },
      resetTickState: function () { this.spendThisTick = 0; },
      addSpend: function (n) { this.spendThisTick += (n || 0); },
    },
    episodic: { write: async function () { return { ref: 'x' }; } },
    consolidate: async function () {},
  };
}

function stubLeash() { return { check: function () { return { allow: true, requireConfirm: false, tier: 0 }; } }; }

function makeTrackedEffectors() {
  const invoked = [];
  return {
    invoked,
    invoke: async function (tool) { invoked.push(tool); return { ok: true }; },
    breakers: { allow: function () { return true; } },
  };
}

// arbitrate() call #1 (from the stale tick) returns 'stale-goal'; call #2
// (from the fresh, post-restart tick) returns 'fresh-goal'. plan() for
// 'stale-goal' hangs on a controllable gate (simulating a slow brain.think()
// call); plan() for 'fresh-goal' resolves immediately.
function makeGatedGoals() {
  let arbitrateCalls = 0;
  let resolveStaleGate;
  const staleGate = new Promise((resolve) => { resolveStaleGate = resolve; });
  // Slice-2: the planner's _spentTokens is now debited directly to the goal via
  // debitBudget() (actions:0) instead of folded into working.spendThisTick. Track
  // those debits so the staleness test can still assert which tick committed.
  const debits = [];
  return {
    _resolveStaleGate: function () { resolveStaleGate(); },
    _debits: function () { return debits.slice(); },
    hasActive: function () { return true; },
    arbitrate: function () {
      arbitrateCalls++;
      return arbitrateCalls === 1 ? { id: 'stale-goal' } : { id: 'fresh-goal' };
    },
    plan: async function (best) {
      if (best.id === 'stale-goal') {
        await staleGate;
        return { tool: 'stale_tool', args: {}, rationale: 'stale', _spentTokens: 999 };
      }
      return { tool: 'fresh_tool', args: {}, rationale: 'fresh', _spentTokens: 7 };
    },
    debitBudget: function (id, usage) { debits.push({ id: id, tokens: usage.tokens, actions: usage.actions }); },
    markPlanStepDone: function () {},
  };
}

describe('REMEDIATION: cortex tick overlap after a restart mid-tick', () => {
  it('a stale in-flight tick must not mutate shared working memory or dispatch actions after being superseded by a restart', async () => {
    const { createCortex } = require('../src/core/cortex');
    const bus = fakeBus();
    const memory = fakeMemory();
    const goals = makeGatedGoals();
    const effectors = makeTrackedEffectors();
    // MYTHOS_TICK_MS huge so the real setInterval never fires during this test
    // — every tickOnce() call here is invoked directly and deliberately.
    const config = { ACTION_TIMEOUT_MS: 30000, MYTHOS_TICK_MS: 999999 };

    const cortex = createCortex({ bus, memory, goals, brain: null, leash: stubLeash(), effectors, config });

    cortex.start(); // running=true, generation=1

    // Tick #1 (stale generation) — arbitrates 'stale-goal', suspends inside
    // goals.plan() on the gate (simulating a slow brain call mid-tick).
    const stalePromise = cortex.tickOnce();
    await new Promise((r) => setImmediate(r));

    // Restart mid-tick — exactly what a healer 'restart-cortex' heal does
    // (stop() then start()), and exactly what forcing tickOnce._inFlight=false
    // in stop() allows to happen while tick #1 is still suspended above.
    cortex.stop();
    cortex.start(); // generation bumps twice total (stop + start)

    // Tick #2 (new generation) — arbitrates 'fresh-goal', resolves
    // immediately, dispatches 'fresh_tool'. Runs to full completion.
    await cortex.tickOnce();

    assert.equal(memory.working.activeGoalId, 'fresh-goal', 'the new-generation tick must own activeGoalId');
    // Slice-2: the planner's _spentTokens is debited to the goal directly
    // (actions:0) rather than folded into spendThisTick — so the fresh tick's
    // commit is now visible in the goal debit ledger, not spendThisTick. The
    // fresh tick debits: planner (7 tokens, 0 actions) + action (0 tokens, 1 action).
    assert.deepEqual(goals._debits(), [
      { id: 'fresh-goal', tokens: 7, actions: 0 },
      { id: 'fresh-goal', tokens: 0, actions: 1 }
    ], "only the fresh tick's planner + action spend must be committed");
    assert.deepEqual(effectors.invoked, ['fresh_tool'], 'only the fresh tick may have dispatched an action so far');

    // NOW let the stale tick resume. It must bail out WITHOUT overwriting the
    // fresh tick's already-committed state or dispatching its stale action.
    goals._resolveStaleGate();
    await stalePromise;

    assert.equal(memory.working.activeGoalId, 'fresh-goal', 'a resumed stale tick must not clobber activeGoalId');
    assert.deepEqual(goals._debits(), [
      { id: 'fresh-goal', tokens: 7, actions: 0 },
      { id: 'fresh-goal', tokens: 0, actions: 1 }
    ], "a resumed stale tick must not add its stale spend (999 tokens for stale-goal)");
    assert.deepEqual(effectors.invoked, ['fresh_tool'], 'a resumed stale tick must never dispatch its stale action');

    cortex.stop();
  });
});
