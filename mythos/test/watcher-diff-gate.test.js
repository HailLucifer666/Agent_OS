'use strict';

// watcher-diff-gate.test.js — the "speak only when something changed" gate
// (src/core/cortex/diff-gate.js), and its two real consumers: cortex's
// mull() (idle reasoning) and planner/daily.js's runCheckin() (stall nudges).
// Neither previously checked whether what they were about to emit was NEW —
// mull() re-emitted 'cortex.thought' every mull pass even for the byte-
// identical thought, and runCheckin() re-emitted 'plan.checkin' every fire
// even for the exact same stalled-goal set. This file proves the gate
// suppresses the repeat and still fires on a genuine change.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createDiffGate } = require('../src/core/cortex/diff-gate');
const { createCortex } = require('../src/core/cortex');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createDailyPlanner } = require('../src/core/planner/daily');

describe('diff-gate module', () => {
  it('hasChanged is true the first time a key is probed', () => {
    const gate = createDiffGate();
    assert.equal(gate.hasChanged('k', 'v1'), true);
  });

  it('hasChanged is false on a repeat of the same value, true again once it differs', () => {
    const gate = createDiffGate();
    assert.equal(gate.hasChanged('k', 'v1'), true);
    assert.equal(gate.hasChanged('k', 'v1'), false, 'same value must not report a change');
    assert.equal(gate.hasChanged('k', 'v2'), true, 'a real change must report true');
    assert.equal(gate.hasChanged('k', 'v2'), false, 'repeating the new value must also settle');
  });

  it('keys are independent of one another', () => {
    const gate = createDiffGate();
    assert.equal(gate.hasChanged('a', 'x'), true);
    assert.equal(gate.hasChanged('b', 'x'), true, 'a different key seeing the same value is still new to IT');
  });

  it('compares by value, not by reference (arrays/objects)', () => {
    const gate = createDiffGate();
    assert.equal(gate.hasChanged('list', ['a', 'b']), true);
    assert.equal(gate.hasChanged('list', ['a', 'b']), false, 'an equal-but-different array instance is not a change');
    assert.equal(gate.hasChanged('list', ['a', 'c']), true);
  });

  it('reset(key) forgets one key; reset() with no args forgets everything', () => {
    const gate = createDiffGate();
    gate.hasChanged('k1', 'v');
    gate.hasChanged('k2', 'v');
    gate.reset('k1');
    assert.equal(gate.hasChanged('k1', 'v'), true, 'k1 was forgotten');
    assert.equal(gate.hasChanged('k2', 'v'), false, 'k2 was untouched');
    gate.reset();
    assert.equal(gate.hasChanged('k2', 'v'), true, 'reset() with no key clears every key');
  });
});

// ---------------------------------------------------------------------------
// Real consumer #1: cortex's idle mull(). Drives the real tick loop with
// MYTHOS_MULL_EVERY_TICKS: 1 so every idle tick mulls, and a brain fake that
// returns the SAME high-priority thought every call.
// ---------------------------------------------------------------------------
function fakeIdleMemory() {
  return {
    working: {
      tick: 0, activeGoalId: null, spendThisTick: 0,
      drainPerceptions: () => [], resetTickState() { this.spendThisTick = 0; },
      addSpend() {}, getRecallCache: () => null, setRecallCache() {},
    },
    episodic: {
      write: async () => ({ ref: 'ep-1' }),
      recall: () => [{ record: { summary: 'operator asked about the deploy' } }],
    },
    consolidate: async () => {},
  };
}

function fakeBrainWithThought(thoughtText) {
  return {
    think: async () => ({
      offline: false,
      parsed: { thoughts: thoughtText, priority: 'high', proposals: [] },
    }),
  };
}

const idleGoals = { getActive: () => null, hasActive: () => false };
const idleLeash = { check: () => ({ allow: true, requireConfirm: false, tier: 0 }) };

describe('cortex mull() speaks only when the thought changed', () => {
  it('the SAME thought across consecutive mull passes emits cortex.thought only once', async () => {
    const bus = fakeBus();
    const memory = fakeIdleMemory();
    const brain = fakeBrainWithThought('You never told me which theme you wanted.');
    const config = { MYTHOS_MULL_EVERY_TICKS: 1, ACTION_TIMEOUT_MS: 30000 };
    const cortex = createCortex({ bus, memory, goals: idleGoals, brain, leash: idleLeash, effectors: { invoke: async () => ({ ok: true }), count: () => 0, effectors: new Map() }, config });

    cortex.start();
    await cortex.tickOnce();
    await cortex.tickOnce();
    cortex.stop();

    const thoughts = bus._emitted().filter((e) => e.type === 'cortex.thought');
    assert.equal(thoughts.length, 1, 'the second pass repeats the first pass\'s thought verbatim and must be suppressed');
  });

  it('a genuinely NEW thought on a later pass emits again', async () => {
    const bus = fakeBus();
    const memory = fakeIdleMemory();
    let call = 0;
    const brain = {
      think: async () => {
        call++;
        return { offline: false, parsed: { thoughts: 'thought #' + call, priority: 'high', proposals: [] } };
      },
    };
    const config = { MYTHOS_MULL_EVERY_TICKS: 1, ACTION_TIMEOUT_MS: 30000 };
    const cortex = createCortex({ bus, memory, goals: idleGoals, brain, leash: idleLeash, effectors: { invoke: async () => ({ ok: true }), count: () => 0, effectors: new Map() }, config });

    cortex.start();
    await cortex.tickOnce();
    await cortex.tickOnce();
    cortex.stop();

    const thoughts = bus._emitted().filter((e) => e.type === 'cortex.thought');
    assert.equal(thoughts.length, 2, 'two genuinely different thoughts must both be spoken');
    assert.equal(thoughts[0].payload.text, 'thought #1');
    assert.equal(thoughts[1].payload.text, 'thought #2');
  });
});

// ---------------------------------------------------------------------------
// Real consumer #2: planner/daily.js's runCheckin().
// ---------------------------------------------------------------------------
function ts(y, mo, d, h, mi) {
  return new Date(y, mo - 1, d, h, mi || 0, 0, 0).getTime();
}

function fakeMemory(dir) {
  return { fs: createFsStore(() => dir, null) };
}

function fakeGoalsWith(active) {
  return {
    arbitrate: () => (active.length ? active[0] : null),
    list: () => active.slice(),
    get: (id) => active.find((g) => g.id === id) || null,
  };
}

describe('planner/daily runCheckin() nags only when the stalled set changed', () => {
  it('the SAME stalled goal reported twice in a row emits plan.checkin only once', async () => {
    const dir = tempVaultDir();
    const bus = fakeBus();
    const morningTs = ts(2026, 7, 17, 9, 0);
    const stalledGoal = { id: 'goal-1', title: 'Stalled goal', priority: 0.5, budget: { deadline: null }, status: 'active', lastActionAt: morningTs - 3600000, createdAt: morningTs - 7200000 };
    const goals = fakeGoalsWith([stalledGoal]);
    const brain = { think: async () => ({ content: 'Stalled goal needs attention.', offline: false }) };
    let current = morningTs;
    const now = () => current;
    const planner = createDailyPlanner({ bus, config: {}, memory: fakeMemory(dir), goals, brain, now });

    await planner.runMorning();
    current = morningTs + 1000;
    const first = await planner.runCheckin();
    assert.ok(first, 'the first check-in on a genuinely stalled goal must fire');

    current = morningTs + 2000;
    const second = await planner.runCheckin();
    assert.equal(second, null, 'the identical stalled set carries no new information and must be suppressed');

    const events = bus._emitted().filter((e) => e.type === 'plan.checkin');
    assert.equal(events.length, 1, 'only the first, genuinely new check-in should have emitted');

    cleanupVaultDir(dir);
  });

  it('a DIFFERENT stalled set on a later check-in emits again', async () => {
    const dir = tempVaultDir();
    const bus = fakeBus();
    const morningTs = ts(2026, 7, 17, 9, 0);
    const goalA = { id: 'goal-a', title: 'Goal A', priority: 0.5, budget: { deadline: null }, status: 'active', lastActionAt: morningTs - 3600000, createdAt: morningTs - 7200000 };
    const goalB = { id: 'goal-b', title: 'Goal B', priority: 0.5, budget: { deadline: null }, status: 'active', lastActionAt: morningTs - 3600000, createdAt: morningTs - 7200000 };
    let currentActive = [goalA];
    const goals = {
      arbitrate: () => currentActive[0],
      list: () => currentActive.slice(),
      get: (id) => currentActive.find((g) => g.id === id) || null,
    };
    const brain = { think: async () => ({ content: 'Nudge.', offline: false }) };
    let current = morningTs;
    const now = () => current;
    const planner = createDailyPlanner({ bus, config: {}, memory: fakeMemory(dir), goals, brain, now });

    await planner.runMorning();
    current = morningTs + 1000;
    const first = await planner.runCheckin();
    assert.deepEqual(first.stalled, ['Goal A']);

    // A different goal is now the stalled one — genuinely new information.
    currentActive = [goalB];
    current = morningTs + 2000;
    const second = await planner.runCheckin();
    assert.ok(second, 'a different stalled set must not be suppressed');
    assert.deepEqual(second.stalled, ['Goal B']);

    const events = bus._emitted().filter((e) => e.type === 'plan.checkin');
    assert.equal(events.length, 2);

    cleanupVaultDir(dir);
  });
});
