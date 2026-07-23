'use strict';

// P21 — verifies the AUTONOMOUS_EXCLUDED filter in goals/index.js plan():
// 1. Excluded tools (capture_idea, etc.) are stripped from the tool list sent to the brain
// 2. If the brain returns an excluded tool name, plan() rejects it (returns null)
// 3. Legitimate tools pass through normally

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createGoalSystem } = require('../src/core/goals');

function fakeEffectors(tools) {
  var registry = new Map();
  tools.forEach(function(t) { registry.set(t, { name: t, fn: async () => ({ ok: true }) }); });
  return {
    count: function() { return registry.size; },
    effectors: registry,
    invoke: async function() { return { ok: true }; },
    // FIX A: goals/index.js's plan() now sources the brain-facing tool list from
    // catalog() (hub.js's real {name, description, params} shape, via describeMeta())
    // instead of a bare name list — mirror that shape here.
    catalog: function() {
      return Array.from(registry.values()).map(function(t) {
        return { name: t.name, description: t.description || '', params: t.params || {} };
      });
    }
  };
}

describe('P21: planner tool exclusion (AUTONOMOUS_EXCLUDED)', () => {
  it('strips excluded tools from the brain prompt and rejects if brain returns one', async () => {
    var brainCalled = false;
    var brainContent = '';
    var brain = {
      think: async function(opts) {
        brainCalled = true;
        brainContent = opts.messages[0].content;
        // brain tries to use the excluded tool
        return { content: '{"tool":"capture_idea","args":{"text":"plan dump"}}', offline: false, parsed: { tool: 'capture_idea', args: { text: 'plan dump' } } };
      }
    };

    var dir = tempVaultDir();
    var fs = createFsStore(function() { return dir; });
    var bus = fakeBus();
    var anomalies = [];
    bus.emit = function(evt, data) { if (evt === 'health.anomaly') anomalies.push(data); };

    // registry has capture_idea (excluded) + list_goals (legit)
    var effectors = fakeEffectors(['capture_idea', 'list_goals', 'read_status']);
    var goals = createGoalSystem({ fs: fs, config: { GOAL_TOKEN_BUDGET: 50000 }, bus: bus, memory: null, brain: brain });

    var goal = goals.create({ title: 'test goal', drive: 'maintenance' });
    goal.status = 'active';

    var result = await goals.plan(
      goal,
      { effectors: effectors, brain: brain }
    );

    // brain was called
    assert.ok(brainCalled, 'brain.think should have been called');
    // tool list in prompt must NOT contain capture_idea
    assert.ok(brainContent.indexOf('capture_idea') === -1, 'capture_idea should be stripped from tool list');
    assert.ok(brainContent.indexOf('list_goals') !== -1, 'list_goals should remain in tool list');
    // result must be null — excluded tool rejected
    assert.equal(result, null, 'plan() should return null when brain picks an excluded tool');
    // anomaly should have fired
    assert.ok(anomalies.length > 0, 'health.anomaly should have been emitted');
    assert.equal(anomalies[0].kind, 'planner-hallucinated-tool');

    cleanupVaultDir(dir);
  });

  it('allows legitimate tools through normally', async () => {
    var brain = {
      think: async function() {
        return { content: '{"tool":"read_status","args":{}}', offline: false, parsed: { tool: 'read_status', args: {} } };
      }
    };

    var dir = tempVaultDir();
    var fs = createFsStore(function() { return dir; });
    var bus = fakeBus();
    var effectors = fakeEffectors(['capture_idea', 'read_status', 'get_time']);
    var goals = createGoalSystem({ fs: fs, config: { GOAL_TOKEN_BUDGET: 50000 }, bus: bus, memory: null, brain: brain });

    var goal = goals.create({ title: 'legit goal', drive: 'user-service' });
    goal.status = 'active';

    var result = await goals.plan(
      goal,
      { effectors: effectors, brain: brain }
    );

    assert.ok(result !== null, 'plan() should return a result for a legit tool');
    assert.equal(result.tool, 'read_status');
    assert.equal(result.rationale, 'brain-planned');

    cleanupVaultDir(dir);
  });

  // REMEDIATION P2-10: an effectors implementation without catalog() (only
  // count()/effectors, the pre-FIX-A shape) previously left toolList as an
  // empty string — the brain got NO tool guidance at all, worse than the
  // original bare name-only list FIX A replaced. Must fall back to that list.
  it('falls back to a bare name-only tool list when ctx.effectors.catalog is not a function', async () => {
    var brainContent = '';
    var brain = {
      think: async function(opts) {
        brainContent = opts.messages[0].content;
        return { content: '{"tool":"read_status","args":{}}', offline: false, parsed: { tool: 'read_status', args: {} } };
      }
    };

    var dir = tempVaultDir();
    var fs = createFsStore(function() { return dir; });
    var bus = fakeBus();

    // Deliberately no catalog() — mirrors an effectors implementation that
    // predates FIX A (or any partial one that never grew it).
    var registry = new Map();
    ['capture_idea', 'read_status', 'get_time'].forEach(function(t) { registry.set(t, { name: t }); });
    var effectorsNoCatalog = {
      count: function() { return registry.size; },
      effectors: registry,
      invoke: async function() { return { ok: true }; }
    };

    var goals = createGoalSystem({ fs: fs, config: { GOAL_TOKEN_BUDGET: 50000 }, bus: bus, memory: null, brain: brain });
    var goal = goals.create({ title: 'no-catalog goal', drive: 'user-service' });
    goal.status = 'active';

    var result = await goals.plan(goal, { effectors: effectorsNoCatalog, brain: brain });

    assert.ok(brainContent.trim().length > 0, 'the brain must receive a non-empty tool list even without catalog()');
    assert.ok(brainContent.indexOf('read_status') !== -1, 'a legitimate tool must still appear in the fallback list');
    assert.ok(brainContent.indexOf('capture_idea') === -1, 'AUTONOMOUS_EXCLUDED must still be honored in the fallback list');
    assert.ok(result !== null, 'plan() should still work end-to-end with the fallback list');

    cleanupVaultDir(dir);
  });
});
