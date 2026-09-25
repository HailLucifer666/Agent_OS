'use strict';

// Phase 4 / Area A — execution→learning loop foundation.
//
// This file is the regression guard for two latent bugs that had silently
// disabled the procedural-skill planner branch since the goal system shipped:
//
//   B-1 (goals/index.js:215, pre-Phase-4): skills.recall() was called with
//       {query,limit} as the FIRST arg, but the signature is recall(query, opts).
//       recall() called .toLowerCase() on the first arg → TypeError → caught
//       by the surrounding try/catch → health.anomaly spam, branch never fires.
//
//   B-2 (goals/index.js:216, pre-Phase-4): skill.successRate was tracked by
//       recordUse() but no planner ever read it. plan() gated purely on the
//       keyword-overlap score, so a procedure that consistently failed would
//       be replayed forever.
//
// After Phase 4: recall() is called correctly, successRate gates replay,
// and the chosen decision carries skillRef through to dispatchAction for
// the recordUse() feedback loop.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const goalsMod = require('../src/core/goals/index');

function fakeFs() {
  var store = {};
  return {
    ensureDir: function () {},
    listFiles: function (dir) {
      var keys = Object.keys(store).filter(function (k) { return k.indexOf(dir + '/') === 0; });
      return keys.map(function (k) { return { path: k, name: path.basename(k, '.json') }; });
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

function fakeSkillsStore() {
  // Mirror the real memory/skills.js recall signature: (query, opts) -> hits[].
  var records = [];
  return {
    _records: records,
    seed: function (name, md, sidecar) {
      records.push({ name: name, md: md, when: ['deploy the app'], sidecar: sidecar || {} });
    },
    recall: function (query, opts) {
      opts = opts || {};
      var limit = opts.limit || 10;
      // MUST receive query as a string (the B-1 regression). If anything else
      // comes in, throw exactly like the real store did pre-fix.
      if (typeof query !== 'string') {
        throw new TypeError('recall(query, opts): query must be a string, got ' + typeof query);
      }
      var terms = query.toLowerCase().split(/\s+/);
      var hits = [];
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        var lower = r.md.toLowerCase();
        var matched = terms.filter(function (t) { return lower.indexOf(t) !== -1; }).length;
        var score = terms.length > 0 ? matched / terms.length : 0;
        if (score > 0) {
          hits.push({
            ref: r.sidecar.id || r.name,
            score: score,
            record: {
              id: r.sidecar.id, uses: r.sidecar.uses || 0,
              successRate: r.sidecar.successRate || 0,
              steps: r.steps || [], when: r.when || []
            },
            store: 'skills'
          });
        }
      }
      hits.sort(function (a, b) { return b.score - a.score; });
      return hits.slice(0, limit);
    },
    recordUse: function () {}
  };
}

function makeGoalSystem(opts) {
  var bus = opts.bus || { emit: function () {} };
  var config = opts.config || { SKILL_MIN_SUCCESS_RATE: 0.5 };
  var memory = opts.memory || { skills: fakeSkillsStore() };
  var gs = goalsMod.createGoalSystem({
    fs: fakeFs(), config: config, bus: bus, memory: memory, brain: null
  });
  return gs;
}

describe('Phase 4 / Area A — skills.recall signature + successRate gate (B-1, B-2)', function () {

  it('plan() calls skills.recall(goal.title, opts) with a STRING (B-1 regression)', async function () {
    var received = null;
    var skills = fakeSkillsStore();
    skills.recall = function (query, opts) {
      received = { query: query, opts: opts };
      return [];
    };
    var gs = makeGoalSystem({ memory: { skills: skills } });
    var g = gs.create({ title: 'deploy the app', drive: 'user-service' });
    // plan() goes: budget → plan-step (empty) → skills recall → brain (none in ctx).
    // BUG-446 (2026-09-23) moved the budget check FIRST, so this no longer zeroes the
    // budget to stop before the brain: with no brain in ctx, plan() stops there anyway.
    gs.debitBudget = function () {};
    await gs.plan(g, { memory: { skills: skills }, config: { SKILL_MIN_SUCCESS_RATE: 0.5 } });
    assert.ok(received, 'skills.recall was never invoked');
    assert.equal(typeof received.query, 'string', 'query must be a string, got ' + typeof received.query);
    assert.equal(received.query, 'deploy the app');
    assert.equal(received.opts.limit, 3);
  });

  it('plan() returns a procedural-skill decision when a high-score skill matches', async function () {
    var skills = fakeSkillsStore();
    skills.seed('deploy-proc',
      '# deploy the app\n## Steps\n- tool: shell_run, args: {cmd: "deploy"}',
      { id: 'sk-deploy', uses: 2, successRate: 0.9 });
    // Patch the seeded record so .steps is populated (the fakeSkillsStore shape above
    // expects steps on the record object, not parsed from md).
    skills._records[0].steps = [{ tool: 'shell_run', args: { cmd: 'deploy' } }];
    var gs = makeGoalSystem({ memory: { skills: skills } });
    var g = gs.create({ title: 'deploy the app', drive: 'user-service' });
    var d = await gs.plan(g, { memory: { skills: skills }, config: { SKILL_MIN_SUCCESS_RATE: 0.5 } });
    assert.equal(d.tool, 'shell_run');
    assert.equal(d.rationale, 'procedural-skill');
    assert.equal(d.offline, true);
    assert.equal(d.skillRef, 'sk-deploy', 'decision must carry skillRef for recordUse');
  });

  it('plan() SKIPS a skill whose tracked successRate is below the floor (B-2)', async function () {
    var skills = fakeSkillsStore();
    skills.seed('bad-proc',
      '# deploy the app\n## Steps\n- tool: shell_run, args: {cmd: "deploy"}',
      { id: 'sk-bad', uses: 5, successRate: 0.1 });   // well below 0.5 floor
    skills._records[0].steps = [{ tool: 'shell_run', args: { cmd: 'deploy' } }];
    var gs = makeGoalSystem({ memory: { skills: skills } });
    var g = gs.create({ title: 'deploy the app', drive: 'user-service' });
    var d = await gs.plan(g, { memory: { skills: skills }, config: { SKILL_MIN_SUCCESS_RATE: 0.5 } });
    assert.equal(d, null, 'low-successRate skill must not be replayed');
  });

  it('plan() DOES replay a brand-new skill (uses===0) regardless of successRate', async function () {
    var skills = fakeSkillsStore();
    skills.seed('new-proc',
      '# deploy the app\n## Steps\n- tool: shell_run, args: {cmd: "deploy"}',
      { id: 'sk-new', uses: 0, successRate: 0 });    // never tried — give it a chance
    skills._records[0].steps = [{ tool: 'shell_run', args: { cmd: 'deploy' } }];
    var gs = makeGoalSystem({ memory: { skills: skills } });
    var g = gs.create({ title: 'deploy the app', drive: 'user-service' });
    var d = await gs.plan(g, { memory: { skills: skills }, config: { SKILL_MIN_SUCCESS_RATE: 0.5 } });
    assert.equal(d && d.rationale, 'procedural-skill', 'untried skills get a chance to prove themselves');
    assert.equal(d.skillRef, 'sk-new');
  });

  it('plan() honors a higher SKILL_MIN_SUCCESS_RATE threshold from config', async function () {
    var skills = fakeSkillsStore();
    skills.seed('ok-proc',
      '# deploy the app\n## Steps\n- tool: shell_run, args: {cmd: "deploy"}',
      { id: 'sk-ok', uses: 4, successRate: 0.6 });    // above 0.5 floor, below 0.75
    skills._records[0].steps = [{ tool: 'shell_run', args: { cmd: 'deploy' } }];
    // config is read at plan() call time from the closure (house rule §24.2 —
    // live read, not construction-cache), so we rebuild the goal system per
    // threshold. Same skills store, different threshold.
    var gsDefault = makeGoalSystem({ memory: { skills: skills }, config: { SKILL_MIN_SUCCESS_RATE: 0.5 } });
    var g1 = gsDefault.create({ title: 'deploy the app', drive: 'user-service' });
    var d1 = await gsDefault.plan(g1, { memory: { skills: skills } });
    assert.equal(d1 && d1.rationale, 'procedural-skill');

    var gsStrict = makeGoalSystem({ memory: { skills: skills }, config: { SKILL_MIN_SUCCESS_RATE: 0.75 } });
    var g2 = gsStrict.create({ title: 'deploy the app', drive: 'user-service' });
    var d2 = await gsStrict.plan(g2, { memory: { skills: skills } });
    assert.equal(d2, null, '0.6 successRate must be rejected when floor is 0.75');
  });

});
