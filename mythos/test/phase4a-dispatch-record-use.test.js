'use strict';

// Phase 4 / Area A — V2 execution→learning loop closure.
//
// This is THE central wiring test for the loop: a procedural-skill decision
// dispatched via dispatchAction() must (a) call skills.recordUse(ref, ok) so
// the EMA successRate the planner consults reflects reality, and (b) call
// goals.markPlanStepDone(goalId, ok) so multi-step plans advance.
//
// Pre-Phase-4: skills.recordUse() was implemented but had ZERO callers, so
// successRate was always 0 and the planner's procedural-skill branch was
// silently dead (B-1/B-2). markPlanStepDone did not exist.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { dispatchAction } = require('../src/core/effectors/dispatch-action');

function fakeEffectors(okResult) {
  return {
    invoke: async function () { return okResult; },
    breakers: { allow: function () { return true; } },
    count: function () { return 1; },
    effectors: new Map([['shell_run', {}]])
  };
}

function fakeBus() {
  var emitted = [];
  return { emit: function (name, payload) { emitted.push({ name: name, payload: payload }); },
           _emitted: function () { return emitted; } };
}

function fakeMemory() {
  var episodic = [];
  return {
    episodic: {
      write: async function (rec) { episodic.push(rec); },
      _records: episodic
    },
    audit: { write: function () {} },
    skills: { recordUse: function () {} }
  };
}

function fakeGoals() {
  return {
    debitBudget: function () {},
    markPlanStepDone: function () {}
  };
}

describe('Phase 4 / Area A — V2 execution→learning loop in dispatchAction', function () {

  it('calls skills.recordUse(ref, true) when a procedural-skill action succeeds', async function () {
    var recorded = [];
    var mem = fakeMemory();
    mem.skills.recordUse = function (ref, ok) { recorded.push({ ref: ref, ok: ok }); };
    var decision = { tool: 'shell_run', args: { cmd: 'deploy' }, skillRef: 'sk-deploy', rationale: 'procedural-skill' };
    await dispatchAction(decision, {
      effectors: fakeEffectors({ ok: true, result: 'deployed' }),
      bus: fakeBus(), goals: fakeGoals(), memory: mem, config: { ACTION_TIMEOUT_MS: 5000 },
      goalId: 'g-1', tier: 2
    });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].ref, 'sk-deploy');
    assert.equal(recorded[0].ok, true);
  });

  it('calls skills.recordUse(ref, false) when a procedural-skill action fails', async function () {
    var recorded = [];
    var mem = fakeMemory();
    mem.skills.recordUse = function (ref, ok) { recorded.push({ ref: ref, ok: ok }); };
    var decision = { tool: 'shell_run', args: { cmd: 'deploy' }, skillRef: 'sk-bad', rationale: 'procedural-skill' };
    await dispatchAction(decision, {
      effectors: fakeEffectors({ ok: false, error: 'crash' }),
      bus: fakeBus(), goals: fakeGoals(), memory: mem, config: { ACTION_TIMEOUT_MS: 5000 },
      goalId: 'g-1', tier: 2
    });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].ref, 'sk-bad');
    assert.equal(recorded[0].ok, false);
  });

  it('does NOT call skills.recordUse when skillRef is absent (brain-planned decision)', async function () {
    var recorded = [];
    var mem = fakeMemory();
    mem.skills.recordUse = function (ref, ok) { recorded.push({ ref: ref, ok: ok }); };
    var decision = { tool: 'shell_run', args: { cmd: 'x' }, rationale: 'brain-planned' };
    await dispatchAction(decision, {
      effectors: fakeEffectors({ ok: true }),
      bus: fakeBus(), goals: fakeGoals(), memory: mem, config: { ACTION_TIMEOUT_MS: 5000 },
      goalId: 'g-1', tier: 2
    });
    assert.equal(recorded.length, 0, 'brain-planned decisions must not touch skill bookkeeping');
  });

  it('calls goals.markPlanStepDone(goalId, ok) after a successful action', async function () {
    var marked = [];
    var g = fakeGoals();
    g.markPlanStepDone = function (id, ok) { marked.push({ id: id, ok: ok }); };
    var decision = { tool: 'shell_run', args: {}, skillRef: 'sk', rationale: 'procedural-skill' };
    await dispatchAction(decision, {
      effectors: fakeEffectors({ ok: true }),
      bus: fakeBus(), goals: g, memory: fakeMemory(), config: { ACTION_TIMEOUT_MS: 5000 },
      goalId: 'g-plan', tier: 2
    });
    assert.equal(marked.length, 1);
    assert.equal(marked[0].id, 'g-plan');
    assert.equal(marked[0].ok, true);
  });

  it('episodic record carries skillRef + rationale (V9 reflection will read these)', async function () {
    var mem = fakeMemory();
    var decision = { tool: 'shell_run', args: { cmd: 'd' }, skillRef: 'sk-x', rationale: 'procedural-skill' };
    await dispatchAction(decision, {
      effectors: fakeEffectors({ ok: true }),
      bus: fakeBus(), goals: fakeGoals(), memory: mem, config: { ACTION_TIMEOUT_MS: 5000 },
      goalId: 'g-1', tier: 2
    });
    assert.equal(mem.episodic._records.length, 1);
    var rec = mem.episodic._records[0];
    assert.equal(rec.skillRef, 'sk-x');
    assert.equal(rec.rationale, 'procedural-skill');
    assert.equal(rec.outcome, 'ok');
  });

  it('failures in recordUse/markPlanStepDone do NOT mask the action result', async function () {
    var mem = fakeMemory();
    mem.skills.recordUse = function () { throw new Error('skills disk full'); };
    var g = fakeGoals();
    g.markPlanStepDone = function () { throw new Error('plan corrupt'); };
    var decision = { tool: 'shell_run', args: {}, skillRef: 'sk', rationale: 'procedural-skill' };
    var bus = fakeBus();
    var result = await dispatchAction(decision, {
      effectors: fakeEffectors({ ok: true, result: 'deployed' }),
      bus: bus, goals: g, memory: mem, config: { ACTION_TIMEOUT_MS: 5000 },
      goalId: 'g-1', tier: 2
    });
    // Result is still returned — bookkeeping failure must not propagate.
    assert.equal(result.ok, true);
    assert.equal(result.result, 'deployed');
    // action.completed still emitted
    var completed = bus._emitted().find(function (e) { return e.name === 'action.completed'; });
    assert.ok(completed);
    assert.equal(completed.payload.ok, true);
  });

});
