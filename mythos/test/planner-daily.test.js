'use strict';

// Phase 3 Jarvis upgrade — daily planning + accountability. Mirrors
// sensors-screen.test.js's structure: fake bus, real fs-store over a temp
// vault dir (the day file's atomic writeJSON/readJSON round-trip IS the
// idempotence mechanism under test, so a real fs-store is used rather than a
// mock), injected `now` for determinism.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createDailyPlanner } = require('../src/core/planner/daily');

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

function fakeBrain(reply) {
  const calls = [];
  return {
    calls,
    think: async (args) => {
      calls.push(args);
      if (reply === undefined) return { content: 'Default brief.', offline: false };
      return reply;
    },
  };
}

describe('planner/daily: createDailyPlanner', () => {
  it('constructor throws without memory(.fs)', () => {
    assert.throws(() => createDailyPlanner({ bus: fakeBus(), config: {}, goals: fakeGoalsWith([]) }));
  });

  it('constructor throws without goals', () => {
    assert.throws(() => createDailyPlanner({ bus: fakeBus(), config: {}, memory: { fs: {} } }));
  });

  it('runMorning emits plan.morning-brief and writes the day file with focus + morningFiredAt', async () => {
    const dir = tempVaultDir();
    const bus = fakeBus();
    const goal = { id: 'goal-1', title: 'Ship the report', priority: 0.8, budget: { deadline: null }, status: 'active', lastActionAt: null, createdAt: Date.now() };
    const goals = fakeGoalsWith([goal]);
    const brain = fakeBrain({ content: 'Focus on shipping the report today.', offline: false });
    const now = () => ts(2026, 7, 17, 9, 1);
    const planner = createDailyPlanner({ bus, config: {}, memory: fakeMemory(dir), goals, brain, now });

    const result = await planner.runMorning();
    assert.match(result.text, /shipping the report/);
    const evt = bus._lastEvent('plan.morning-brief');
    assert.ok(evt);
    assert.equal(evt.payload.text, result.text);
    assert.equal(brain.calls[0].lane, 'voice');
    assert.equal(brain.calls[0].source, 'planner:morning');

    const day = planner.status();
    assert.equal(day.date, '2026-07-17');
    assert.equal(day.focus.length, 1);
    assert.equal(day.focus[0].goalId, 'goal-1');
    assert.ok(day.morningFiredAt);

    cleanupVaultDir(dir);
  });

  it('no active goals: morning brief still fires and says so (presence is the feature)', async () => {
    const dir = tempVaultDir();
    const bus = fakeBus();
    const goals = fakeGoalsWith([]);
    const brain = fakeBrain({ content: 'You have no active goals today — consider picking one.', offline: false });
    const now = () => ts(2026, 7, 17, 9, 1);
    const planner = createDailyPlanner({ bus, config: {}, memory: fakeMemory(dir), goals, brain, now });

    const result = await planner.runMorning();
    assert.match(result.text, /no active goals/i);
    assert.ok(bus._lastEvent('plan.morning-brief'));
    assert.equal(planner.status().focus.length, 0);

    cleanupVaultDir(dir);
  });

  it('scheduler: morning fires once at the hour boundary and never re-fires the same day, even after a simulated restart', async () => {
    const dir = tempVaultDir();
    const goal = { id: 'goal-1', title: 'Ship it', priority: 0.5, budget: { deadline: null }, status: 'active', lastActionAt: null, createdAt: Date.now() };
    const goals = fakeGoalsWith([goal]);
    const brain = fakeBrain({ content: 'Morning brief text.', offline: false });
    const now = () => ts(2026, 7, 17, 9, 1);
    const config = { PLANNER_MORNING_HOUR: 9, PLANNER_EVENING_HOUR: 21 };

    const busA = fakeBus();
    const plannerA = createDailyPlanner({ bus: busA, config, memory: fakeMemory(dir), goals, brain, now });
    await plannerA._internal.tick();
    assert.ok(busA._lastEvent('plan.morning-brief'), 'first tick should fire the morning brief');
    assert.equal(brain.calls.length, 1);

    // Simulate a mid-day restart: construct a brand-new planner instance over
    // the SAME vault dir — the day file on disk already has morningFiredAt set.
    const busB = fakeBus();
    const plannerB = createDailyPlanner({ bus: busB, config, memory: fakeMemory(dir), goals, brain, now });
    await plannerB._internal.tick();
    assert.equal(busB._lastEvent('plan.morning-brief'), null, 'restart must not re-fire the morning brief');
    assert.equal(brain.calls.length, 1, 'no second brain call either');

    cleanupVaultDir(dir);
  });

  it('explicit runMorning() (the daily_plan "replan" path) IS allowed to re-fire, unlike the scheduler', async () => {
    const dir = tempVaultDir();
    const bus = fakeBus();
    const goal = { id: 'goal-1', title: 'Ship it', priority: 0.5, budget: { deadline: null }, status: 'active', lastActionAt: null, createdAt: Date.now() };
    const goals = fakeGoalsWith([goal]);
    const brain = fakeBrain({ content: 'Morning brief text.', offline: false });
    const now = () => ts(2026, 7, 17, 9, 1);
    const planner = createDailyPlanner({ bus, config: {}, memory: fakeMemory(dir), goals, brain, now });

    await planner.runMorning();
    await planner.runMorning();
    const events = bus._emitted().filter((e) => e.type === 'plan.morning-brief');
    assert.equal(events.length, 2, 'an explicit re-brief must be allowed to fire again');

    cleanupVaultDir(dir);
  });

  it('check-in fires only when a goal is genuinely stalled', async () => {
    const dir = tempVaultDir();
    const bus = fakeBus();
    const morningTs = ts(2026, 7, 17, 9, 0);
    const stalledGoal = { id: 'goal-1', title: 'Stalled goal', priority: 0.5, budget: { deadline: null }, status: 'active', lastActionAt: morningTs - 3600000, createdAt: morningTs - 7200000 };
    const goals = fakeGoalsWith([stalledGoal]);
    const brain = fakeBrain({ content: 'Stalled goal needs attention.', offline: false });
    let current = morningTs;
    const now = () => current;
    const planner = createDailyPlanner({ bus, config: {}, memory: fakeMemory(dir), goals, brain, now });

    await planner.runMorning();
    current = morningTs + 1000;
    const result = await planner.runCheckin();
    assert.ok(result);
    assert.match(result.text, /stalled/i);
    assert.deepEqual(result.stalled, ['Stalled goal']);
    assert.ok(bus._lastEvent('plan.checkin'));

    cleanupVaultDir(dir);
  });

  it('check-in skips silently (no emit) when all active goals are progressing', async () => {
    const dir = tempVaultDir();
    const bus = fakeBus();
    const morningTs = ts(2026, 7, 17, 9, 0);
    let current = morningTs;
    const now = () => current;
    // Acted on AFTER the morning brief fired — not stalled.
    const progressingGoal = { id: 'goal-1', title: 'Progressing goal', priority: 0.5, budget: { deadline: null }, status: 'active', lastActionAt: morningTs + 500, createdAt: morningTs - 7200000 };
    const goals = fakeGoalsWith([progressingGoal]);
    const brain = fakeBrain();
    const planner = createDailyPlanner({ bus, config: {}, memory: fakeMemory(dir), goals, brain, now });

    await planner.runMorning();
    current = morningTs + 1000;
    const result = await planner.runCheckin();
    assert.equal(result, null);
    assert.equal(bus._lastEvent('plan.checkin'), null);

    cleanupVaultDir(dir);
  });

  it('evening review writes review with correct done/slipped diff', async () => {
    const dir = tempVaultDir();
    const bus = fakeBus();
    const now = () => ts(2026, 7, 17, 21, 5);
    const doneGoal = { id: 'goal-done', title: 'Done goal', status: 'done' };
    const openGoal = { id: 'goal-open', title: 'Still open goal', status: 'active' };
    const goals = {
      arbitrate: () => null,
      list: () => [doneGoal, openGoal],
      get: (id) => [doneGoal, openGoal].find((g) => g.id === id) || null,
    };
    const brain = fakeBrain({ content: 'Finished the done goal; the open goal slipped.', offline: false });
    const planner = createDailyPlanner({ bus, config: {}, memory: fakeMemory(dir), goals, brain, now });

    // Seed a day file with a focus list covering both goals, as morning would have.
    const day = planner._internal.loadDay('2026-07-17');
    day.focus = [
      { goalId: 'goal-done', title: 'Done goal', priority: 0.5, deadline: null },
      { goalId: 'goal-open', title: 'Still open goal', priority: 0.5, deadline: null },
    ];
    day.morningFiredAt = now();
    planner._internal.saveDay(day);

    const result = await planner.runEvening();
    assert.deepEqual(result.review.done, ['Done goal']);
    assert.deepEqual(result.review.slipped, ['Still open goal']);
    assert.ok(bus._lastEvent('plan.evening-review'));
    assert.equal(planner.status().eveningFiredAt, now());

    cleanupVaultDir(dir);
  });

  it('brain offline still emits canned fallback text — never silent, never a crash', async () => {
    const dir = tempVaultDir();
    const bus = fakeBus();
    const now = () => ts(2026, 7, 17, 9, 1);
    const goal = { id: 'goal-1', title: 'Some goal', priority: 0.5, budget: { deadline: null }, status: 'active', lastActionAt: null, createdAt: Date.now() };
    const goals = fakeGoalsWith([goal]);
    const brain = fakeBrain({ offline: true, content: null });
    const planner = createDailyPlanner({ bus, config: {}, memory: fakeMemory(dir), goals, brain, now });

    const result = await planner.runMorning();
    assert.ok(result.text && result.text.length > 0);
    assert.match(result.text, /offline/i);
    const evt = bus._lastEvent('plan.morning-brief');
    assert.ok(evt);
    assert.equal(evt.payload.text, result.text);

    cleanupVaultDir(dir);
  });

  it('no brain at all still emits canned fallback text', async () => {
    const dir = tempVaultDir();
    const bus = fakeBus();
    const now = () => ts(2026, 7, 17, 9, 1);
    const goal = { id: 'goal-1', title: 'Some goal', priority: 0.5, budget: { deadline: null }, status: 'active', lastActionAt: null, createdAt: Date.now() };
    const goals = fakeGoalsWith([goal]);
    const planner = createDailyPlanner({ bus, config: {}, memory: fakeMemory(dir), goals, brain: null, now });

    const result = await planner.runMorning();
    assert.ok(result.text && result.text.length > 0);
    assert.ok(bus._lastEvent('plan.morning-brief'));

    cleanupVaultDir(dir);
  });

  it('skipToday sets every fired-flag so the scheduler never fires again today', () => {
    const dir = tempVaultDir();
    const bus = fakeBus();
    const now = () => ts(2026, 7, 17, 8, 0);
    const goals = fakeGoalsWith([]);
    const planner = createDailyPlanner({ bus, config: {}, memory: fakeMemory(dir), goals, brain: null, now });

    const day = planner.skipToday();
    assert.ok(day.morningFiredAt);
    assert.ok(day.lastCheckinAt);
    assert.ok(day.eveningFiredAt);

    cleanupVaultDir(dir);
  });

  it('start()/stop() run an unref\'d interval and stop cleanly', () => {
    const dir = tempVaultDir();
    const bus = fakeBus();
    const goals = fakeGoalsWith([]);
    const planner = createDailyPlanner({ bus, config: {}, memory: fakeMemory(dir), goals, brain: null });

    planner.start();
    assert.equal(planner.isRunning(), true);
    planner.stop();
    assert.equal(planner.isRunning(), false);

    cleanupVaultDir(dir);
  });
});
