'use strict';

// Phase 4 / Area A — end-to-end execution→learning loop integration test.
//
// This is THE closing test for Area A. It wires all five pieces together:
//   planner (skill recall + successRate gate)
//     → dispatchAction (records outcome via skills.recordUse + markPlanStepDone)
//       → next planner tick sees updated successRate
//
// Pre-Phase-4 these pieces existed in isolation but the loop was broken in
// three places (B-1 signature bug, B-2 unread successRate, B-3 unwritten
// goal.plan). After Phase 4 the loop closes for real.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const goalsMod = require('../src/core/goals/index');
const { dispatchAction } = require('../src/core/effectors/dispatch-action');

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

// A single shared skills store that DOES the real recordUse EMA so we can
// observe successRate changing across the loop. Mirrors memory/skills.js.
function realEmaSkillsStore(initialRecords) {
  var records = {};   // ref -> { record: {...}, sidecar: {...} }
  (initialRecords || []).forEach(function (r) {
    records[r.ref] = {
      record: r.record,
      // recordUse EMA (mirrors skills.js:144-166)
      _applyRecordUse: function (success) {
        var sc = this.record;
        sc.uses = (sc.uses || 0) + 1;
        var oldRate = sc.successRate || 0;
        var newRate = success ? 1 : 0;
        sc.successRate = oldRate === 0 ? newRate : (oldRate * 0.9 + newRate * 0.1);
      }
    };
  });
  return {
    recall: function (query, opts) {
      opts = opts || {};
      if (typeof query !== 'string') throw new TypeError('query must be a string');
      var terms = query.toLowerCase().split(/\s+/);
      var hits = [];
      Object.keys(records).forEach(function (ref) {
        var r = records[ref].record;
        var hay = (r.when && r.when.join(' ') || r.name || '').toLowerCase();
        var matched = terms.filter(function (t) { return hay.indexOf(t) !== -1; }).length;
        var score = terms.length > 0 ? matched / terms.length : 0;
        if (score > 0) hits.push({ ref: ref, score: score, record: r, store: 'skills' });
      });
      hits.sort(function (a, b) { return b.score - a.score; });
      return hits.slice(0, opts.limit || 10);
    },
    recordUse: function (ref, success) {
      if (!records[ref]) return;
      records[ref]._applyRecordUse(success);
    },
    write: function (name, data) {
      var ref = 'sk-' + name;
      records[ref] = {
        record: Object.assign({ id: ref, name: name }, data),
        _applyRecordUse: function (success) {
          var sc = this.record;
          sc.uses = (sc.uses || 0) + 1;
          var oldRate = sc.successRate || 0;
          var newRate = success ? 1 : 0;
          sc.successRate = oldRate === 0 ? newRate : (oldRate * 0.9 + newRate * 0.1);
        }
      };
      return { ref: ref, degraded: false };
    },
    _inspect: function (ref) { return records[ref] && records[ref].record; }
  };
}

describe('Phase 4 / Area A — end-to-end execution→learning loop', function () {

  it('the FULL loop: plan → dispatch → recordUse → successRate drops → replan skips', async function () {
    // Seed a procedure that starts with a great successRate (so it's replayed).
    var skills = realEmaSkillsStore([{
      ref: 'sk-fragile',
      record: {
        id: 'sk-fragile', name: 'fragile', uses: 5, successRate: 0.9,
        when: ['do the risky thing'],
        steps: [
          { tool: 'shell_run', args: { cmd: 'risky-a' } },
          { tool: 'shell_run', args: { cmd: 'risky-b' } }
        ]
      }
    }]);
    var bus = { emit: function () {} };
    var gs = goalsMod.createGoalSystem({
      fs: fakeFs(), config: { SKILL_MIN_SUCCESS_RATE: 0.5 }, bus: bus,
      memory: { skills: skills }, brain: null
    });
    var g = gs.create({ title: 'do the risky thing', drive: 'user-service' });

    // 1. plan() picks the procedural skill (successRate 0.9 > floor 0.5)
    var d1 = await gs.plan(g, { memory: { skills: skills } });
    assert.equal(d1.rationale, 'procedural-skill');
    assert.equal(d1.skillRef, 'sk-fragile');
    assert.equal(g.plan.length, 2, 'multi-step plan persisted');

    // 2. dispatch the decision — simulating FAILURE each time
    var dispatchCount = 0;
    async function dispatchFail(decision) {
      await dispatchAction(decision, {
        effectors: {
          invoke: async function () { dispatchCount++; return { ok: false, error: 'boom' }; },
          breakers: { allow: function () { return true; } },
          count: function () { return 1; }, effectors: new Map([['shell_run', {}]])
        },
        bus: bus, goals: gs, memory: { episodic: { write: async function () {} }, audit: { write: function () {} }, skills: skills },
        config: { ACTION_TIMEOUT_MS: 5000 },
        goalId: g.id, tier: 2
      });
    }

    // 3. Run the loop several times — each failure should pull successRate down
    //    via the EMA (α=0.1) until it drops below the 0.5 floor and the
    //    planner stops replaying this skill.
    var replaysObserved = 0;
    for (var tick = 0; tick < 30; tick++) {
      var decision = await gs.plan(g, { memory: { skills: skills } });
      if (!decision) break;          // planner gave up on the skill
      if (decision.rationale === 'procedural-skill') replaysObserved++;
      await dispatchFail(decision);
    }
    assert.ok(replaysObserved >= 1, 'skill must be replayed at least once');
    assert.ok(replaysObserved < 30, 'skill must eventually stop being replayed');

    // 4. Final state: successRate has dropped below the floor
    var finalSkill = skills._inspect('sk-fragile');
    assert.ok(finalSkill.uses > 5, 'recordUse fired across the loop');
    assert.ok(finalSkill.successRate < 0.5,
      'successRate dropped below floor — got ' + finalSkill.successRate);
  });

  it('the FULL loop on success: skill.successRate climbs, planner keeps replaying it', async function () {
    var skills = realEmaSkillsStore([{
      ref: 'sk-solid',
      record: {
        id: 'sk-solid', name: 'solid', uses: 2, successRate: 0.7,
        when: ['do the solid thing'],
        steps: [{ tool: 'shell_run', args: { cmd: 'reliable' } }]
      }
    }]);
    var bus = { emit: function () {} };
    var gs = goalsMod.createGoalSystem({
      fs: fakeFs(), config: { SKILL_MIN_SUCCESS_RATE: 0.5 }, bus: bus,
      memory: { skills: skills }, brain: null
    });
    var g = gs.create({ title: 'do the solid thing', drive: 'user-service' });

    var replaysObserved = 0;
    for (var tick = 0; tick < 5; tick++) {
      var decision = await gs.plan(g, { memory: { skills: skills } });
      if (!decision) break;
      if (decision.rationale === 'procedural-skill') replaysObserved++;
      await dispatchAction(decision, {
        effectors: {
          invoke: async function () { return { ok: true, result: 'done' }; },
          breakers: { allow: function () { return true; } },
          count: function () { return 1; }, effectors: new Map([['shell_run', {}]])
        },
        bus: bus, goals: gs,
        memory: { episodic: { write: async function () {} }, audit: { write: function () {} }, skills: skills },
        config: { ACTION_TIMEOUT_MS: 5000 },
        goalId: g.id, tier: 2
      });
    }
    assert.equal(replaysObserved, 5, 'successful skill must be replayed every tick');
    var finalSkill = skills._inspect('sk-solid');
    assert.ok(finalSkill.successRate > 0.7, 'successRate climbed — got ' + finalSkill.successRate);
  });

});
