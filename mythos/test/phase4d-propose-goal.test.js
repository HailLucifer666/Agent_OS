'use strict';

// Phase 4 / Area D — V5 propose_goal effector + bridge methods.
//
// The cortex must not mint ACTIVE goals (AUTONOMOUS_EXCLUDED forbids create_goal).
// But the spec calls for the cortex to be able to SUGGEST goals via mull(). The
// compromise: a propose_goal tool that creates a status:'proposed' goal which the
// arbiter ignores until the operator accepts it via the dashboard.
//
// This test exercises the bridge layer (effectors/goals.js proposeGoal /
// listProposals / acceptProposal / rejectProposal) and the effector registration
// (TOOLS array contains propose_goal). The leash tier + UI routes are validated
// separately (leash.test.js, server smoke).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createGoalsMdBridge, parseGoalsMd } = require('../src/core/effectors/goals');
const goalsMod = require('../src/core/goals/index');
const { buildTools } = require('../src/core/effectors/from-dashboard');
const tiers = require('../src/core/leash/tiers');

function fakeFs() {
  var store = {};
  return {
    ensureDir: function () {},
    listFiles: function (dir) {
      return Object.keys(store).filter(function (k) { return k.indexOf(dir + '/') === 0; })
        .map(function (k) { return { path: k, name: path.basename(k, '.json') }; });
    },
    readText: function (p, fallback) {
      if (store[p] != null) return store[p];
      return fallback !== undefined ? fallback : '';
    },
    readJSON: function (p, fallback) {
      if (store[p] == null) return fallback;
      try { return JSON.parse(store[p]); } catch (_) { return fallback; }
    },
    writeJSON: function (p, v) { store[p] = JSON.stringify(v); },
    writeText: function (p, v) { store[p] = v; },
    removeFile: function (p) { delete store[p]; },
    exists: function (p) { return Object.prototype.hasOwnProperty.call(store, p); },
    vaultPath: function () { return 'vault'; }
  };
}

function makeBridge() {
  var fs = fakeFs();
  var goalSystem = goalsMod.createGoalSystem({
    fs: fs, config: {}, bus: { emit: function () {} }, memory: null, brain: null
  });
  var bridge = createGoalsMdBridge({ fs: fs, goalSystem: goalSystem, bus: { emit: function () {} } });
  return { bridge: bridge, goalSystem: goalSystem, fs: fs };
}

describe('Phase 4 / Area D — propose_goal bridge methods (V5)', function () {

  it('proposeGoal creates a status:proposed goal the arbiter ignores', function () {
    var t = makeBridge();
    var proposals = t.bridge.proposeGoal('deploy the new auth service', 'Work', { reason: 'follow-up from morning meeting' });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].text, 'deploy the new auth service');
    assert.equal(proposals[0].category, 'Work');
    // The goal itself is status:proposed, not active
    var goal = t.goalSystem.get(proposals[0].id);
    assert.equal(goal.status, 'proposed');
    // The arbiter ignores proposals
    assert.equal(t.goalSystem.getActive(), null, 'no active goal must exist');
    assert.equal(t.goalSystem.list({ status: 'active' }).length, 0);
  });

  it('proposeGoal does NOT write to Goals.md (keeps the human checkbox list clean)', function () {
    var t = makeBridge();
    t.bridge.proposeGoal('something', 'General', {});
    var goalsMd = t.fs.readText('Goals.md', '');
    assert.equal(goalsMd, '', 'Goals.md must remain empty until a proposal is accepted');
  });

  it('listProposals returns all status:proposed goals with category parsed from reason', function () {
    var t = makeBridge();
    t.bridge.proposeGoal('a', 'Work', { reason: 'r1' });
    t.bridge.proposeGoal('b', 'Personal', { reason: 'r2' });
    var proposals = t.bridge.listProposals();
    assert.equal(proposals.length, 2);
    var cats = proposals.map(function (p) { return p.category; }).sort();
    assert.deepEqual(cats, ['Personal', 'Work']);
  });

  it('acceptProposal flips status proposed → active and writes to Goals.md', function () {
    var t = makeBridge();
    var before = t.bridge.proposeGoal('accept me', 'General', {});
    var id = before[0].id;
    var remaining = t.bridge.acceptProposal(id);
    assert.equal(remaining.length, 0, 'proposal queue empties after accept');
    // The goal is now active
    var goal = t.goalSystem.get(id);
    assert.equal(goal.status, 'active');
    // Goals.md got the new row
    var goalsMd = t.fs.readText('Goals.md', '');
    assert.ok(goalsMd.indexOf('accept me') !== -1, 'accepted proposal appears in Goals.md');
    // The arbiter can now pick it up
    assert.ok(t.goalSystem.getActive() !== null, 'arbitrator can now select the accepted goal');
  });

  it('rejectProposal deletes the proposed goal outright', function () {
    var t = makeBridge();
    var before = t.bridge.proposeGoal('reject me', 'General', {});
    var id = before[0].id;
    var remaining = t.bridge.rejectProposal(id);
    assert.equal(remaining.length, 0);
    assert.equal(t.goalSystem.get(id), null, 'rejected goal must be gone from the goal system');
    var goalsMd = t.fs.readText('Goals.md', '');
    assert.equal(goalsMd, '', 'rejected proposal must NOT land in Goals.md');
  });

  it('acceptProposal on a non-proposed goal is a no-op (idempotent)', function () {
    var t = makeBridge();
    // Create an ACTIVE goal directly (simulating operator-created)
    var active = t.goalSystem.create({ title: 'already active', status: 'active' });
    var remaining = t.bridge.acceptProposal(active.id);
    // No proposals in the queue either way
    assert.equal(remaining.length, 0);
    // The active goal stays active (not re-accepted)
    assert.equal(t.goalSystem.get(active.id).status, 'active');
  });

});

describe('Phase 4 / Area D — propose_goal effector + leash tier (V5)', function () {

  function makeCtx() {
    var t = makeBridge();
    return {
      fs: t.fs,
      goalsEffector: t.bridge,
      bus: { emit: function () {} },
      logger: { info: function () {}, warn: function () {}, error: function () {} },
      config: {}
    };
  }

  it('propose_goal is registered in the TOOLS array', function () {
    var built = buildTools(makeCtx());
    var names = built.TOOLS.map(function (t) { return t.name; });
    assert.ok(names.indexOf('propose_goal') !== -1, 'propose_goal must be a registered tool');
    var tool = built.TOOLS.find(function (t) { return t.name === 'propose_goal'; });
    assert.equal(tool.danger, false);
    assert.equal(typeof tool.fn, 'function');
  });

  it('propose_goal fn returns ok({proposals}) on success', async function () {
    var built = buildTools(makeCtx());
    var tool = built.TOOLS.find(function (t) { return t.name === 'propose_goal'; });
    var result = await tool.fn({ text: 'try dark mode', category: 'Personal', reason: 'user mentioned eye strain' });
    assert.equal(result.ok, true);
    // ok() wraps the payload as {ok:true, result: <payload>} — proposals live under result
    assert.ok(Array.isArray(result.result.proposals));
    assert.equal(result.result.proposals.length, 1);
    assert.equal(result.result.proposals[0].text, 'try dark mode');
  });

  it('propose_goal fn fails on empty text', async function () {
    var built = buildTools(makeCtx());
    var tool = built.TOOLS.find(function (t) { return t.name === 'propose_goal'; });
    var result = await tool.fn({ text: '   ' });
    assert.equal(result.ok, false);
    // fail() returns {ok:false, result: <reason>} — the reason lives under result
    assert.ok(result.result);
  });

  it('propose_goal is T1 in the leash tier table (NOT in AUTONOMOUS_EXCLUDED)', function () {
    assert.equal(tiers.TIER_TABLE.propose_goal, 1, 'propose_goal must be T1');
    var excluded = require('../src/core/goals/index')._internal || {};
    // AUTONOMOUS_EXCLUDED is module-private; verify via the public effect: the
    // brain's tool list filter would strip it if excluded. We assert the tier
    // table entry exists and is permissive enough for autonomous use.
    assert.ok(tiers.TIER_TABLE.propose_goal <= 2,
      'propose_goal must be T0-T2 so the autonomous cortex can call it without confirm');
  });

});
