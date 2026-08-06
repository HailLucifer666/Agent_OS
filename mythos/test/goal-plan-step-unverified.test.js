'use strict';

// The evidence contract's third outcome, at the plan-queue level.
//
// dispatch-action.js may receive {ok:true, unverified:true} — the effector did
// something world-changing but could not PROVE it landed. Two obvious handlings
// are both wrong, and this file pins why:
//
//   markPlanStepDone(id, true)   → launders an unproven action into 'done' and
//                                  feeds the success signal the planner reads.
//   markPlanStepDone(id, false)  → marks the step 'failed', charges
//                                  goal.failCount, and at >=2 fires
//                                  distillFailureIntoLesson — i.e. invents a
//                                  failure that was never observed.
//   (not calling it at all)      → worst of the three: plan() dispatches the
//                                  first *pending* step every tick, so the step
//                                  is re-dispatched forever and a real
//                                  world-changing action (ui_type, ui_click)
//                                  repeats without bound.
//
// So there is a third terminal status, 'unverified': resolved for queue-advance
// purposes, excluded from every failure signal.
//
// Wiring mirrors test/goal-failure-learning.test.js.

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

function fakeBus() {
  var events = [];
  return { emit: function (n, p) { events.push({ name: n, payload: p }); }, _events: events };
}

// brain that would distill a lesson if anything ever asked it to — so an
// unexpected distillation shows up as a written lesson rather than silently
// passing.
function fakeBrain() {
  return {
    think: async function (opts) {
      if (opts.source && opts.source.indexOf('goal-fail-distill') === 0) {
        return { content: 'x', parsed: { lesson: 'SHOULD NOT HAPPEN', avoid: 'x' }, offline: false, spentTokens: 1 };
      }
      return { content: null, parsed: null, offline: true };
    }
  };
}

function fakeMemory() {
  var lessonsWritten = [];
  return {
    // Two fail episodics on hand, so the >=2 precondition for
    // distillFailureIntoLesson is already satisfied — if an unverified step
    // wrongly counted as a failure, a lesson WOULD get written and this test
    // would catch it. Without this the test could pass for the wrong reason.
    episodic: {
      recall: function () {
        return [
          { record: { outcome: 'fail', summary: 'a', tool: 't', detail: 'd' } },
          { record: { outcome: 'fail', summary: 'b', tool: 't', detail: 'd' } }
        ];
      }
    },
    skills: { write: function () { return { ref: 'sk-x' }; }, recall: function () { return []; } },
    lessons: {
      recordFailure: function (trigger, lesson, meta) {
        lessonsWritten.push({ trigger: trigger, lesson: lesson, meta: meta });
        return { ref: 'lsn-x', count: lessonsWritten.length, isNew: true };
      },
      recall: function () { return []; },
      _written: function () { return lessonsWritten; }
    }
  };
}

function makeSystem(opts) {
  opts = opts || {};
  return goalsMod.createGoalSystem({
    fs: fakeFs(),
    config: Object.assign(
      { SKILL_MIN_SUCCESS_RATE: 0.5, GOAL_FAIL_PAUSE_THRESHOLD: 3, LESSON_RECALL_LIMIT: 5 },
      opts.config || {}
    ),
    bus: opts.bus || fakeBus(),
    memory: opts.memory || fakeMemory(),
    brain: opts.brain || fakeBrain()
  });
}

describe("plan-step 'unverified' — the evidence contract at the queue level", function () {
  it("resolves the step as 'unverified' instead of leaving it pending", function () {
    var sys = makeSystem();
    var g = sys.create({ title: 'type into notepad', drive: 'user-service' });
    // Two steps, so the allDone sweep does NOT clear the array and the status is
    // still inspectable (a single-step plan clears — covered separately below).
    g.plan = [
      { tool: 'ui_type', args: { text: 'hi' }, status: 'executing' },
      { tool: 'ui_click', args: {}, status: 'pending' }
    ];

    sys.markPlanStepDone(g.id, true, true);

    assert.equal(g.plan[0].status, 'unverified');
    assert.notEqual(g.plan[0].status, 'pending', 'a pending step would be re-dispatched forever');
  });

  it('does not charge failCount and does not distill a failure lesson', async function () {
    var memory = fakeMemory();
    var sys = makeSystem({ memory: memory });
    var g = sys.create({ title: 'type into notepad', drive: 'user-service' });

    // Two unverified steps in a row — more than the >=2 failCount threshold
    // that would trip distillFailureIntoLesson if these were scored as failures.
    g.plan = [{ tool: 'ui_type', args: {}, status: 'executing' }];
    sys.markPlanStepDone(g.id, true, true);
    g.plan = [{ tool: 'ui_type', args: {}, status: 'executing' }];
    sys.markPlanStepDone(g.id, true, true);
    await new Promise(function (r) { setTimeout(r, 10); });

    assert.ok(!g.failCount, 'unverified is not an observed failure: failCount must stay unset/0');
    assert.equal(memory.lessons._written().length, 0, 'no failure lesson may be distilled from an unverified outcome');
  });

  it('still scores a real failure, so the third state did not disarm the failure path', async function () {
    var memory = fakeMemory();
    var sys = makeSystem({ memory: memory });
    var g = sys.create({ title: 'run tests', drive: 'user-service' });

    g.plan = [
      { tool: 'shell_run', args: {}, status: 'executing' },
      { tool: 'shell_run', args: {}, status: 'pending' }
    ];
    sys.markPlanStepDone(g.id, false);
    assert.equal(g.plan[0].status, 'failed');
    assert.equal(g.failCount, 1);

    sys.markPlanStepDone(g.id, false);
    await new Promise(function (r) { setTimeout(r, 10); });
    assert.equal(g.failCount, 2);
    assert.ok(memory.lessons._written().length >= 1, 'a genuine repeated failure must still distill');
  });

  it('advances to the NEXT pending step rather than re-dispatching the unverified one', async function () {
    var sys = makeSystem();
    var g = sys.create({ title: 'two-step plan', drive: 'user-service' });
    g.plan = [
      { tool: 'ui_type', args: { text: 'first' }, status: 'executing' },
      { tool: 'ui_click', args: { x: 1 }, status: 'pending' }
    ];

    sys.markPlanStepDone(g.id, true, true);

    // This is the anti-infinite-loop assertion: plan() must now hand back the
    // SECOND step. Before the third state existed, skipping the call left step
    // one 'pending' and plan() returned ui_type again every tick, forever.
    var decision = await sys.plan(g, {});
    assert.ok(decision, 'plan() should return the next step');
    assert.equal(decision.tool, 'ui_click');
  });

  it("counts 'unverified' as resolved so the queue clears for a fresh re-plan", function () {
    var sys = makeSystem();
    var g = sys.create({ title: 'single-step plan', drive: 'user-service' });
    g.plan = [{ tool: 'ui_type', args: {}, status: 'executing' }];

    sys.markPlanStepDone(g.id, true, true);

    // allDone sweep must treat 'unverified' as terminal — otherwise a plan whose
    // only step was unverified never clears and plan() can never re-plan fresh.
    assert.equal(g.plan.length, 0, "an all-'unverified' plan must clear like an all-'done' one");
  });
});
