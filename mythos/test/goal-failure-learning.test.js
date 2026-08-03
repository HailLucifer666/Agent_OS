'use strict';

// Learning loop (Layer 4) — goal-failure distillation + the repeated-failure pause.
//
// Covers three things the plan added to goals/index.js:
//   1. distillFailureIntoLesson — the symmetric counterpart to distillIntoSkill.
//      Reads outcome:'fail' action episodics, one brain call, writes a Lesson.
//   2. markPlanStepDone increments goal.failCount and fires distillation at >=2.
//   3. plan()'s repeated-failure pause — when a lesson's count crosses
//      GOAL_FAIL_PAUSE_THRESHOLD, the goal auto-pauses with reason
//      'repeated-failure' instead of re-planning forever.
//
// Mirrors phase4a-goal-completion-distill.test.js's fake-fs/bus/brain/memory wiring.

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
  return {
    emit: function (n, p) { events.push({ name: n, payload: p }); },
    _events: events
  };
}

function fakeBrain(failureParsedResponse) {
  return {
    think: async function (opts) {
      if (opts.source && opts.source.indexOf('goal-fail-distill') === 0) {
        return { content: 'x', parsed: failureParsedResponse, offline: false, spentTokens: 100 };
      }
      // plan() brain call — return a no-op so it doesn't drive the test.
      return { content: null, parsed: null, offline: true };
    }
  };
}

// memory with episodic (returning FAIL records), skills, AND lessons.
function fakeMemory(failEpisodics) {
  var lessonsWritten = [];
  return {
    episodic: {
      recall: function (query, opts) {
        // distillFailureIntoSkill filters to outcome:'fail' itself; return all.
        return failEpisodics || [];
      }
    },
    skills: { write: function () { return { ref: 'sk-x' }; } },
    lessons: {
      recordFailure: function (trigger, lesson, meta) {
        lessonsWritten.push({ trigger: trigger, lesson: lesson, meta: meta });
        return { ref: 'lsn-x', count: lessonsWritten.length, isNew: lessonsWritten.length === 1 };
      },
      recall: function () { return []; },
      _written: function () { return lessonsWritten; }
    }
  };
}

function makeSystem(opts) {
  return goalsMod.createGoalSystem({
    fs: fakeFs(),
    config: Object.assign({ SKILL_MIN_SUCCESS_RATE: 0.5, GOAL_FAIL_PAUSE_THRESHOLD: 3, LESSON_RECALL_LIMIT: 5 }, opts.config || {}),
    bus: opts.bus || fakeBus(),
    memory: opts.memory,
    brain: opts.brain || null
  });
}

describe('Layer 4 — distillFailureIntoLesson', function () {
  it('distills a goal failure trace into ONE lesson via a brain call', async function () {
    var fails = [
      { record: { outcome: 'fail', summary: 'shell_run npm test', tool: 'shell_run', detail: 'timeout' } },
      { record: { outcome: 'fail', summary: 'shell_run npm test', tool: 'shell_run', detail: 'timeout' } }
    ];
    var brain = fakeBrain({ lesson: 'npm test needs --timeout=120s', avoid: 'shell_run' });
    var memory = fakeMemory(fails);
    var sys = makeSystem({ memory: memory, brain: brain });

    var g = sys.create({ title: 'run tests', drive: 'user-service' });
    // Seed a plan so markPlanStepDone has a step to mark.
    g.plan = [{ tool: 'shell_run', args: {}, status: 'executing', skillRef: 'x' }];

    sys.markPlanStepDone(g.id, false);
    // failCount is now 1 — below the threshold, no distillation yet.
    assert.equal(memory.lessons._written().length, 0, 'failCount=1 should not yet distill');

    g.plan = [{ tool: 'shell_run', args: {}, status: 'executing', skillRef: 'x' }];
    sys.markPlanStepDone(g.id, false);
    // failCount=2 — distillation fires (async). Give it a tick.
    await new Promise(function (r) { setTimeout(r, 10); });
    var written = memory.lessons._written();
    assert.ok(written.length >= 1, 'failCount>=2 should trigger distillFailureIntoLesson');
    assert.match(written[0].lesson, /timeout|npm test/i, 'the distilled lesson should carry the failure detail');
    assert.equal(written[0].meta.source, 'goal-failure');
  });

  it('does NOT distill when there are fewer than 2 failures (no pattern yet)', async function () {
    var brain = fakeBrain({ lesson: 'should not be called', avoid: '' });
    var memory = fakeMemory([{ record: { outcome: 'fail', summary: 'flake' } }]);
    var sys = makeSystem({ memory: memory, brain: brain });
    var g = sys.create({ title: 'flaky goal', drive: 'user-service' });
    g.plan = [{ tool: 'x', args: {}, status: 'executing' }];
    sys.markPlanStepDone(g.id, false);
    await new Promise(function (r) { setTimeout(r, 10); });
    // Only one failure episodic → distillFailureIntoLesson returns null without a brain call.
    assert.equal(memory.lessons._written().length, 0);
  });
});

describe('Layer 3 — plan() repeated-failure pause', function () {
  it('pauses the goal when a lesson count crosses GOAL_FAIL_PAUSE_THRESHOLD', async function () {
    // memory.lessons.recall returns ONE hit with count=3 (>= threshold).
    var memory = fakeMemory([]);
    memory.lessons.recall = function () {
      return [{ count: 3, snippet: 'shell_run npm test always times out', record: { lessons: ['x'] } }];
    };
    var brain = fakeBrain({});
    var sys = makeSystem({ memory: memory, brain: brain, config: { GOAL_FAIL_PAUSE_THRESHOLD: 3 } });
    var g = sys.create({ title: 'doomed goal', drive: 'user-service' });

    var decision = await sys.plan(g, { memory: memory, brain: brain, recallCache: [] });
    assert.equal(decision, null, 'plan() should return null when paused for repeated failure');
    assert.equal(g.status, 'paused');
    assert.equal(g.reason, 'repeated-failure');
  });

  it('injects a PRIOR FAILURES block (but does not pause) when count is below threshold', async function () {
    var memory = fakeMemory([]);
    memory.lessons.recall = function () {
      return [{ count: 2, snippet: 'minor flake', record: { lessons: ['x'] } }];
    };
    var thinkCalls = [];
    var brain = {
      think: async function (opts) {
        thinkCalls.push(opts);
        // Brain offline → plan returns null but does NOT pause (count < threshold).
        return { content: null, parsed: null, offline: true };
      }
    };
    var sys = makeSystem({ memory: memory, brain: brain, config: { GOAL_FAIL_PAUSE_THRESHOLD: 3 } });
    var g = sys.create({ title: 'warned goal', drive: 'user-service' });

    await sys.plan(g, { memory: memory, brain: brain, recallCache: [] });
    assert.notEqual(g.status, 'paused', 'below-threshold failures should warn, not pause');
    assert.ok(thinkCalls.length >= 1, 'the brain should still be consulted with a PRIOR FAILURES block');
    assert.match(thinkCalls[0].messages[0].content, /PRIOR FAILURES/, 'the prompt should carry the grounding block');
  });
});
