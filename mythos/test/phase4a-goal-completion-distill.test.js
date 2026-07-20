'use strict';

// Phase 4 / Area A — V3 goal-completion + procedure distillation.
//
// Pre-Phase-4: the cortex never marked a goal done. Status 'done' transitions
// happened only via the human-facing toggleGoal / Goals.md checkbox bridge.
// No 'goal.completed' event existed. Distilling a successful execution into a
// reusable Skill was impossible — the action episodics sat in memory with no
// producer to read them.
//
// Phase 4 fix: complete(id) is the autonomous path — sets status:'done',
// emits 'goal.completed', and fire-and-forget distills the action history
// into a Skill via ONE bounded brain call (idle-skip respected).

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

function fakeBrain(parsedResponse) {
  return {
    think: async function (opts) {
      // Match the distill prompt by source.
      if (opts.source && opts.source.indexOf('goal-distill') === 0) {
        return { content: 'x', parsed: parsedResponse, offline: false, spentTokens: 100 };
      }
      return { content: null, parsed: null, offline: true };
    }
  };
}

function fakeMemory(actionEpisodics) {
  return {
    episodic: {
      recall: function (query, opts) { return actionEpisodics || []; }
    },
    skills: {
      write: function (name, data) { return { ref: 'sk-' + name, degraded: false }; }
    }
  };
}

function makeSystem(opts) {
  return goalsMod.createGoalSystem({
    fs: fakeFs(),
    config: { SKILL_MIN_SUCCESS_RATE: 0.5 },
    bus: opts.bus || fakeBus(),
    memory: opts.memory || fakeMemory([]),
    brain: opts.brain || null
  });
}

describe('Phase 4 / Area A — goal.complete() (V3)', function () {

  it('complete(id) sets status:done + reason + completedAt + emits goal.completed', function () {
    var bus = fakeBus();
    var gs = makeSystem({ bus: bus });
    var g = gs.create({ title: 'ship it', drive: 'user-service' });
    var before = g.status;
    var result = gs.complete(g.id, { reason: 'shipped' });
    assert.equal(result.status, 'done');
    assert.equal(result.reason, 'shipped');
    assert.ok(result.completedAt, 'completedAt must be set');
    var completed = bus._events.find(function (e) { return e.name === 'goal.completed'; });
    assert.ok(completed, 'goal.completed event must fire');
    assert.equal(completed.payload.id, g.id);
    assert.equal(completed.payload.prevStatus, before);
    assert.equal(completed.payload.title, 'ship it');
  });

  it('complete(id) returns null for an unknown goal id', function () {
    var gs = makeSystem({});
    assert.equal(gs.complete('does-not-exist'), null);
  });

  it('complete(id) skips distillation when no brain/memory.skills is wired (idle-skip)', function () {
    // No brain → distillIntoSkill returns null silently, no anomaly spam.
    var bus = fakeBus();
    var gs = makeSystem({ bus: bus, brain: null, memory: { episodic: { recall: function () { return []; } } } });
    var g = gs.create({ title: 'x', drive: 'user-service' });
    var result = gs.complete(g.id);
    assert.equal(result.status, 'done');
    // No distill anomaly because we never had a brain to call
    var anomalies = bus._events.filter(function (e) { return e.name === 'health.anomaly'; });
    assert.equal(anomalies.length, 0);
  });

  it('complete(id) distills the action history into a Skill via one brain call', async function () {
    var actions = [
      { record: { summary: 'shell_run(cmd: build)', outcome: 'ok' } },
      { record: { summary: 'shell_run(cmd: deploy)', outcome: 'ok' } }
    ];
    var written = [];
    var memory = fakeMemory(actions);
    memory.skills.write = function (name, data) {
      written.push({ name: name, data: data });
      return { ref: 'sk-' + name, degraded: false };
    };
    var brain = fakeBrain({
      name: 'ship-the-thing',
      when: 'when shipping the thing',
      steps: [{ tool: 'shell_run', args: { cmd: 'build' } }, { tool: 'shell_run', args: { cmd: 'deploy' } }]
    });
    var gs = makeSystem({ brain: brain, memory: memory });
    var g = gs.create({ title: 'ship the thing', drive: 'user-service' });
    gs.complete(g.id);
    // Distillation is async fire-and-forget — give it a tick to resolve.
    await new Promise(function (r) { setTimeout(r, 50); });
    assert.equal(written.length, 1, 'exactly one skill must be written');
    assert.equal(written[0].name, 'ship-the-thing');
    assert.equal(written[0].data.steps.length, 2);
    assert.equal(written[0].data.uses, 0, 'newly-distilled skills start at uses:0');
  });

  it('complete(id) does NOT distill when there are < 2 action episodics', async function () {
    var written = [];
    var memory = fakeMemory([{ record: { summary: 'one action', outcome: 'ok' } }]);
    memory.skills.write = function (name) { written.push(name); return { ref: 'sk-' + name }; };
    var brain = fakeBrain({ name: 'x', steps: [{ tool: 'shell_run', args: {} }] });
    var gs = makeSystem({ brain: brain, memory: memory });
    var g = gs.create({ title: 'x', drive: 'user-service' });
    gs.complete(g.id);
    await new Promise(function (r) { setTimeout(r, 50); });
    assert.equal(written.length, 0, 'insufficient trace must not produce a skill');
  });

  it('complete(id) emits health.anomaly if distillation brain call rejects', async function () {
    var bus = fakeBus();
    var memory = fakeMemory([
      { record: { summary: 'a', outcome: 'ok' } },
      { record: { summary: 'b', outcome: 'ok' } }
    ]);
    var brain = {
      think: async function () { throw new Error('brain offline'); }
    };
    var gs = makeSystem({ bus: bus, brain: brain, memory: memory });
    var g = gs.create({ title: 'x', drive: 'user-service' });
    gs.complete(g.id);
    await new Promise(function (r) { setTimeout(r, 50); });
    var anomaly = bus._events.find(function (e) {
      return e.name === 'health.anomaly' && e.payload.kind === 'goal-distill-failed';
    });
    assert.ok(anomaly, 'brain failure must emit goal-distill-failed anomaly');
  });

});
