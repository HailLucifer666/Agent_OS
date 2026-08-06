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

  // FIX-2: recordUse() is async and was previously fire-and-forget with no
  // .catch attached to its returned promise. The try/catch above only guards
  // call-INITIATION (a synchronous throw) — a promise that resolves and later
  // REJECTS (e.g. a transient Windows EBUSY/EPERM reading a locked
  // Skills/*.md file) escaped as an unhandled rejection with no
  // unhandledRejection handler anywhere in the app, crashing the process.
  it('a REJECTING (async) recordUse promise does not escape as an unhandled rejection', async function () {
    var mem = fakeMemory();
    mem.skills.recordUse = function () { return Promise.reject(new Error('EBUSY: locked Skills/x.md')); };
    var bus = fakeBus();
    var unhandled = [];
    function onUnhandled(err) { unhandled.push(err); }
    process.on('unhandledRejection', onUnhandled);
    var result;
    try {
      var decision = { tool: 'shell_run', args: {}, skillRef: 'sk', rationale: 'procedural-skill' };
      result = await dispatchAction(decision, {
        effectors: fakeEffectors({ ok: true, result: 'deployed' }),
        bus: bus, goals: fakeGoals(), memory: mem, config: { ACTION_TIMEOUT_MS: 5000 },
        goalId: 'g-1', tier: 2
      });
      // Give the rejected recordUse promise's microtasks a couple of ticks to
      // surface as an unhandledRejection if it were going to.
      await new Promise(function (r) { setImmediate(r); });
      await new Promise(function (r) { setImmediate(r); });
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
    assert.equal(result.ok, true, 'the action result must still be returned even though recordUse rejected');
    assert.equal(unhandled.length, 0, 'a rejecting recordUse() must not escape as an unhandled rejection');
    var anomaly = bus._emitted().find(function (e) { return e.name === 'health.anomaly'; });
    assert.ok(anomaly, 'the rejection should be reported as a health.anomaly event');
    assert.equal(anomaly.payload.source, 'skills.recordUse');
  });

  // BUG-137: {ok:true, unverified:true} (the evidence contract's "we don't know"
  // case) must not be scored as a success in either the skill EMA or the
  // persisted plan queue — see the comment above the recordUse/
  // markPlanStepDone calls in dispatch-action.js for why `false` is not a
  // safe substitute either (it actively fails the step / drags the EMA down).
  it('does NOT score an unverified action into the skill EMA, but DOES resolve the plan step as unverified', async function () {
    var recorded = [];
    var marked = [];
    var mem = fakeMemory();
    mem.skills.recordUse = function (ref, ok) { recorded.push({ ref: ref, ok: ok }); };
    var g = fakeGoals();
    g.markPlanStepDone = function (id, ok, unverified) {
      marked.push({ id: id, ok: ok, unverified: unverified });
    };
    var decision = { tool: 'ui_type', args: { text: 'hello' }, skillRef: 'sk-type', rationale: 'procedural-skill' };
    var result = await dispatchAction(decision, {
      effectors: fakeEffectors({ ok: true, unverified: true, reason: 'no readback confirmation' }),
      bus: fakeBus(), goals: g, memory: mem, config: { ACTION_TIMEOUT_MS: 5000 },
      goalId: 'g-1', tier: 2
    });
    assert.equal(result.unverified, true);
    assert.equal(recorded.length, 0, 'an unverified action must not be scored into the skill EMA at all');
    // It MUST still be called: plan() re-dispatches the first *pending* step
    // every tick, so a step left unresolved re-runs a real world-changing
    // action forever. The third argument is what keeps it out of both the
    // success and the failure signal.
    assert.equal(marked.length, 1, 'an unverified action must still resolve the plan step (else it re-runs forever)');
    assert.equal(marked[0].unverified, true, 'must be flagged unverified, not scored as done/failed');
  });

  // Control case: a bare {ok:true} (no unverified flag) is a proven success
  // and must still fully participate in both bookkeeping paths.
  it('still calls skills.recordUse(ref, true) and markPlanStepDone(id, true) for a verified (non-unverified) success', async function () {
    var recorded = [];
    var marked = [];
    var mem = fakeMemory();
    mem.skills.recordUse = function (ref, ok) { recorded.push({ ref: ref, ok: ok }); };
    var g = fakeGoals();
    g.markPlanStepDone = function (id, ok, unverified) {
      marked.push({ id: id, ok: ok, unverified: unverified });
    };
    var decision = { tool: 'ui_type', args: { text: 'hello' }, skillRef: 'sk-type', rationale: 'procedural-skill' };
    await dispatchAction(decision, {
      effectors: fakeEffectors({ ok: true }),
      bus: fakeBus(), goals: g, memory: mem, config: { ACTION_TIMEOUT_MS: 5000 },
      goalId: 'g-1', tier: 2
    });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].ok, true);
    assert.equal(marked.length, 1);
    assert.equal(marked[0].ok, true);
    assert.ok(!marked[0].unverified, 'a proven success must not be flagged unverified');
  });

});
