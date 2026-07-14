'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createGoalSystem } = require('../src/core/goals');

describe('P24 goals planner fixes (D-48, D-49)', () => {
  let dir, bus, fs;
  beforeEach(() => { dir = tempVaultDir(); bus = fakeBus(); fs = createFsStore(() => dir, bus); });
  afterEach(() => cleanupVaultDir(dir));

  it('D-49: create() honors GOAL_TOKEN_BUDGET / GOAL_ACTION_BUDGET config keys', () => {
    const g = createGoalSystem({ fs, config: { GOAL_TOKEN_BUDGET: 20000, GOAL_ACTION_BUDGET: 25 }, bus, memory: null, brain: null });
    const goal = g.create({ title: 'budgeted goal' });
    assert.equal(goal.budget.tokens, 20000);
    assert.equal(goal.budget.actions, 25);
  });

  it('D-49: explicit opts.budget still overrides config', () => {
    const g = createGoalSystem({ fs, config: { GOAL_TOKEN_BUDGET: 20000, GOAL_ACTION_BUDGET: 25 }, bus, memory: null, brain: null });
    const goal = g.create({ title: 'custom', budget: { tokens: 999, actions: 3 } });
    assert.equal(goal.budget.tokens, 999);
    assert.equal(goal.budget.actions, 3);
  });

  it('D-48: plan() falls back to parsing result.content when result.parsed is absent', async () => {
    const g = createGoalSystem({ fs, config: { GOAL_TOKEN_BUDGET: 20000, GOAL_ACTION_BUDGET: 25 }, bus, memory: null, brain: null });
    const goal = g.create({ title: 'do a thing', drive: 'maintenance' });
    const brain = { think: async () => ({ parsed: null, content: '{"tool":"list_goals","args":{}}', offline: false }) };
    const step = await g.plan(goal, { brain });
    assert.ok(step, 'plan must not silently return null when content holds valid JSON');
    assert.equal(step.tool, 'list_goals');
    assert.equal(step.rationale, 'brain-planned');
  });

  it('D-48: offline brain still yields no plan (honest null), not a crash', async () => {
    const g = createGoalSystem({ fs, config: { GOAL_TOKEN_BUDGET: 20000, GOAL_ACTION_BUDGET: 25 }, bus, memory: null, brain: null });
    const goal = g.create({ title: 'x', drive: 'maintenance' });
    const brain = { think: async () => ({ offline: true, parsed: null, content: '' }) };
    const step = await g.plan(goal, { brain });
    assert.equal(step, null);
  });
});
