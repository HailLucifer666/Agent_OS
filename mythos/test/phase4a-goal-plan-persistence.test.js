'use strict';

// Phase 4 / Area A — goal.plan persistence (B-3 + V3).
//
// Pre-Phase-4: goal.plan was initialized to [] and NEVER written. The
// plan-step reader at goals/index.js:204 was dead code. Procedural-skill
// recall returned ONLY step[0] every tick, so multi-step procedures never
// advanced past the first action.
//
// Phase 4 fix:
//   - procedural-skill recall persists the WHOLE procedure into goal.plan
//   - brain can OPTIONALLY return a multi-step "plan" — validated + persisted
//   - markPlanStepDone(goalId, success) advances the queue
//   - the plan-step reader at the top of plan() honors 'pending'/'executing'
//
// This test exercises the queue mechanics without spinning up a brain —
// procedural-skill seeding gives us deterministic multi-step plans.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const goalsMod = require('../src/core/goals/index');

function fakeFs() {
  var store = {};
  return {
    ensureDir: function () {},
    listFiles: function (dir) {
      return Object.keys(store).filter(function (k) { return k.indexOf(dir + '/') === 0; })
        .map(function (k) { return { path: k, name: path.basename(k, '.json') }; });
    },
    readText: function (p) { return store[p] != null ? store[p] : ''; },
    readJSON: function (p) { try { return JSON.parse(store[p] || 'null'); } catch (_) { return null; } },
    writeJSON: function (p, v) { store[p] = JSON.stringify(v); },
    writeText: function (p, v) { store[p] = v; },
    removeFile: function (p) { delete store[p]; },
    exists: function (p) { return Object.prototype.hasOwnProperty.call(store, p); },
    vaultPath: function () { return 'vault'; }
  };
}

function fakeSkillsStore(seedSteps) {
  return {
    recall: function (query, opts) {
      opts = opts || {};
      var limit = opts.limit || 10;
      if (typeof query !== 'string') throw new TypeError('query must be a string');
      // Always match so we exercise the persistence branch deterministically.
      var hit = {
        ref: 'sk-multi', score: 1.0,
        record: { id: 'sk-multi', uses: 3, successRate: 0.8, steps: seedSteps, when: [] },
        store: 'skills'
      };
      return [hit].slice(0, limit);
    },
    recordUse: function () {}
  };
}

function makeGoalSystem(seedSteps) {
  var memory = { skills: fakeSkillsStore(seedSteps) };
  return goalsMod.createGoalSystem({
    fs: fakeFs(),
    config: { SKILL_MIN_SUCCESS_RATE: 0.5 },
    bus: { emit: function () {} },
    memory: memory,
    brain: null
  });
}

describe('Phase 4 / Area A — goal.plan persistence + markPlanStepDone (B-3, V3)', function () {

  it('procedural-skill recall persists ALL skill steps into goal.plan', async function () {
    var steps = [
      { tool: 'shell_run', args: { cmd: 'step-1' } },
      { tool: 'shell_run', args: { cmd: 'step-2' } },
      { tool: 'shell_run', args: { cmd: 'step-3' } }
    ];
    var gs = makeGoalSystem(steps);
    var g = gs.create({ title: 'do the thing', drive: 'user-service' });
    var d = await gs.plan(g, { memory: { skills: gs._internal } });
    // Use the internal store for recall
    var skillsStore = { recall: function () { return [{ ref: 'sk-multi', score: 1.0, record: { id: 'sk-multi', uses: 3, successRate: 0.8, steps: steps, when: [] }, store: 'skills' }]; } };
    d = await gs.plan(g, { memory: { skills: skillsStore } });
    assert.equal(d.tool, 'shell_run');
    assert.equal(d.args.cmd, 'step-1');
    assert.equal(d.skillRef, 'sk-multi');
    assert.ok(Array.isArray(g.plan), 'goal.plan must be populated');
    assert.equal(g.plan.length, 3, 'all three steps persisted');
    assert.equal(g.plan[0].status, 'executing');
    assert.equal(g.plan[1].status, 'pending');
    assert.equal(g.plan[2].status, 'pending');
    assert.equal(g.plan[0].skillRef, 'sk-multi');
  });

  it('the plan-step reader dispatches the next pending step on the next tick', async function () {
    var steps = [
      { tool: 'shell_run', args: { cmd: 'a' } },
      { tool: 'shell_run', args: { cmd: 'b' } }
    ];
    var gs = makeGoalSystem(steps);
    var skillsStore = { recall: function () { return [{ ref: 'sk', score: 1.0, record: { id: 'sk', uses: 1, successRate: 1.0, steps: steps, when: [] }, store: 'skills' }]; } };
    var g = gs.create({ title: 'do the thing', drive: 'user-service' });
    var d1 = await gs.plan(g, { memory: { skills: skillsStore } });
    assert.equal(d1.args.cmd, 'a');
    // Mark step[0] done, then plan() again — should pick step[1]
    gs.markPlanStepDone(g.id, true);
    var d2 = await gs.plan(g, { memory: { skills: skillsStore } });
    assert.equal(d2.args.cmd, 'b', 'second tick must advance to step[1]');
    assert.equal(d2.rationale, 'procedural-skill');
  });

  it('markPlanStepDone(false) marks the current step failed (no replay)', async function () {
    var steps = [
      { tool: 'shell_run', args: { cmd: 'only' } }
    ];
    var gs = makeGoalSystem(steps);
    var skillsStore = { recall: function () { return [{ ref: 'sk', score: 1.0, record: { id: 'sk', uses: 1, successRate: 1.0, steps: steps, when: [] }, store: 'skills' }]; } };
    var g = gs.create({ title: 'do the thing', drive: 'user-service' });
    var d1 = await gs.plan(g, { memory: { skills: skillsStore } });
    assert.ok(d1, 'first step dispatched');
    // Fail the only step — queue should clear
    gs.markPlanStepDone(g.id, false);
    assert.equal(g.plan.length, 0, 'queue clears when all steps resolved');
  });

  it('markPlanStepDone is a no-op on a goal with no plan', function () {
    var gs = makeGoalSystem([]);
    var g = gs.create({ title: 'idle', drive: 'user-service' });
    assert.equal(g.plan.length, 0);
    // Must not throw
    gs.markPlanStepDone(g.id, true);
    gs.markPlanStepDone('does-not-exist', true);
    assert.equal(g.plan.length, 0);
  });

  it('goal.plan survives save/load round-trip (status field preserved)', async function () {
    var steps = [
      { tool: 'shell_run', args: { cmd: 'persist-1' } },
      { tool: 'shell_run', args: { cmd: 'persist-2' } }
    ];
    var sharedFs = fakeFs();
    var skillsStore = { recall: function () { return [{ ref: 'sk', score: 1.0, record: { id: 'sk', uses: 1, successRate: 1.0, steps: steps, when: [] }, store: 'skills' }]; } };
    var gs1 = goalsMod.createGoalSystem({ fs: sharedFs, config: { SKILL_MIN_SUCCESS_RATE: 0.5 }, bus: { emit: function () {} }, memory: { skills: skillsStore }, brain: null });
    var g = gs1.create({ title: 'persisted', drive: 'user-service' });
    await gs1.plan(g, { memory: { skills: skillsStore } });
    assert.equal(g.plan.length, 2);
    // Reload from disk — the loader normalizes plan: data.plan || []
    var gs2 = goalsMod.createGoalSystem({ fs: sharedFs, config: { SKILL_MIN_SUCCESS_RATE: 0.5 }, bus: { emit: function () {} }, memory: { skills: skillsStore }, brain: null });
    await gs2.init();
    var loaded = gs2.get(g.id);
    assert.ok(loaded, 'goal loaded from disk');
    assert.ok(Array.isArray(loaded.plan));
    assert.equal(loaded.plan.length, 2, 'plan persisted across save/load');
    assert.equal(loaded.plan[0].status, 'executing');
  });

});
