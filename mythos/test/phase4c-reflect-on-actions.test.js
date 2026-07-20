'use strict';

// Phase 4 / Area C — V9 reflect() action-outcome analysis.
//
// Pre-Phase-4: the cortex reflect() was a heartbeat-only no-op. reflection.js
// (the real P4 learning loop) read conversations only and wrote to identity
// only. No path existed from action outcomes to either the diagnostician
// (failures) or Skills (successes). Spec calls this V9.
//
// Phase 4 fix: new reflectOnActions(reason) reads the last N action episodics,
// asks the brain to identify recurring failures + success patterns, then:
//   - failures → bus.emit('health.anomaly', {kind:'recurring-failure', ...})
//     (the diagnostician already subscribes to health.anomaly)
//   - successes → memory.skills.write() for future procedural recall

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createReflection } = require('../src/core/identity/reflection');

function fakeBrain(parsedBySource) {
  return {
    think: async function (opts) {
      var p = parsedBySource[opts.source || ''];
      if (p) return { content: 'ok', parsed: p, offline: false };
      return { content: null, parsed: null, offline: true };
    }
  };
}

function fakeMemory(actions) {
  return {
    episodic: {
      recall: function (query, opts) {
        if (opts && opts.kind === 'action') return actions || [];
        return [];
      }
    },
    identity: { readRaw: function () { return ''; } },
    skills: {
      writes: [],
      write: function (name, data) {
        this.writes.push({ name: name, data: data });
        return { ref: 'sk-' + name, degraded: false };
      }
    }
  };
}

function fakeIdentity() {
  return { learn: async function () { return { ref: 'id-1' }; }, setOperatorStyle: function () { return { ok: true }; } };
}

function fakeBus() {
  var events = [];
  return { emit: function (n, p) { events.push({ name: n, payload: p }); }, _events: events };
}

function makeReflection(opts) {
  return createReflection({
    brain: opts.brain || fakeBrain({}),
    memory: opts.memory || fakeMemory([]),
    identity: opts.identity || fakeIdentity(),
    config: opts.config || {},
    logger: { info: function () {}, warn: function () {} },
    bus: opts.bus || fakeBus()
  });
}

describe('Phase 4 / Area C — reflectOnActions (V9)', function () {

  it('skips when there are fewer than REFLECTION_ACTION_MIN actions', async function () {
    var actions = [{ record: { summary: 'a', outcome: 'ok' } }];
    var brain = fakeBrain({ 'reflection:actions:cadence': { failures: ['x'], successes: [] } });
    var r = makeReflection({ brain: brain, memory: fakeMemory(actions) });
    var result = await r.reflectOnActions('cadence');
    assert.equal(result.skipped, 'too-few-actions');
  });

  it('emits health.anomaly recurring-failure for each identified failure pattern', async function () {
    var actions = Array.from({ length: 6 }, function (_, i) {
      return { record: { summary: 'shell_run(build) timeout #' + i, outcome: 'fail', skillRef: 'sk-build' } };
    });
    var bus = fakeBus();
    var brain = fakeBrain({
      'reflection:actions:cadence': {
        failures: ['shell_run(build) keeps timing out', 'pc_click on Spotify play button fails repeatedly'],
        successes: []
      }
    });
    var r = makeReflection({ brain: brain, memory: fakeMemory(actions), bus: bus });
    var result = await r.reflectOnActions('cadence');
    assert.equal(result.failuresEmitted, 2);
    var anomalies = bus._events.filter(function (e) {
      return e.name === 'health.anomaly' && e.payload.kind === 'recurring-failure';
    });
    assert.equal(anomalies.length, 2);
    assert.ok(anomalies[0].payload.detail.length > 0);
  });

  it('writes a Skill for each identified success pattern', async function () {
    var actions = Array.from({ length: 5 }, function (_, i) {
      return { record: { summary: 'step ' + i, outcome: 'ok' } };
    });
    var memory = fakeMemory(actions);
    var brain = fakeBrain({
      'reflection:actions:cadence': {
        failures: [],
        successes: [{
          name: 'morning-routine',
          when: 'at start of day',
          steps: [{ tool: 'news_fetch', args: { topic: 'tech' } }, { tool: 'gmail_unread', args: {} }]
        }]
      }
    });
    var r = makeReflection({ brain: brain, memory: memory });
    var result = await r.reflectOnActions('cadence');
    assert.equal(result.skillsWritten, 1);
    assert.equal(memory.skills.writes.length, 1);
    assert.equal(memory.skills.writes[0].name, 'morning-routine');
    assert.equal(memory.skills.writes[0].data.steps.length, 2);
  });

  it('caps failures at 5 and successes at 3 (safety bound)', async function () {
    var actions = Array.from({ length: 10 }, function (_, i) {
      return { record: { summary: 'a' + i, outcome: 'fail' } };
    });
    var bus = fakeBus();
    var memory = fakeMemory(actions);
    var brain = fakeBrain({
      'reflection:actions:cadence': {
        failures: [
          'failure mode one is here', 'failure mode two is here', 'failure mode three is here',
          'failure mode four is here', 'failure mode five is here', 'failure mode six is here',
          'failure mode seven is here', 'failure mode eight is here'
        ],
        successes: [
          { name: 's1', when: 'x condition', steps: [{ tool: 't', args: {} }] },
          { name: 's2', when: 'x condition', steps: [{ tool: 't', args: {} }] },
          { name: 's3', when: 'x condition', steps: [{ tool: 't', args: {} }] },
          { name: 's4', when: 'x condition', steps: [{ tool: 't', args: {} }] }
        ]
      }
    });
    var r = makeReflection({ brain: brain, memory: memory, bus: bus });
    var result = await r.reflectOnActions('cadence');
    assert.equal(result.failuresEmitted, 5, 'failures capped at 5');
    assert.equal(result.skillsWritten, 3, 'successes capped at 3');
  });

  it('skips silently when brain is offline', async function () {
    var actions = Array.from({ length: 6 }, function () { return { record: { summary: 'x', outcome: 'ok' } }; });
    var brain = { think: async function () { return { offline: true }; } };
    var r = makeReflection({ brain: brain, memory: fakeMemory(actions) });
    var result = await r.reflectOnActions('cadence');
    assert.equal(result.skipped, 'brain-unavailable');
  });

  it('does NOT throw when bus is absent (defensive — failures just get dropped)', async function () {
    var actions = Array.from({ length: 6 }, function () { return { record: { summary: 'x', outcome: 'fail' } }; });
    var brain = fakeBrain({
      'reflection:actions:cadence': { failures: ['something broke'], successes: [] }
    });
    // No bus passed — reflection.js handles bus being undefined
    var r = createReflection({
      brain: brain, memory: fakeMemory(actions), identity: fakeIdentity(),
      config: {}, logger: { info: function () {}, warn: function () {} }
      // bus deliberately omitted
    });
    var result = await r.reflectOnActions('cadence');
    assert.equal(result.failuresEmitted, 0, 'no bus → failures silently dropped');
  });

  it('reentrancy guard: a second concurrent call skips while the first is running', async function () {
    var actions = Array.from({ length: 6 }, function () { return { record: { summary: 'x', outcome: 'ok' } }; });
    var thinkCalls = 0;
    var brain = {
      think: async function () {
        thinkCalls++;
        // Delay so the second call overlaps
        await new Promise(function (r) { setTimeout(r, 30); });
        return { content: 'ok', parsed: { failures: [], successes: [] }, offline: false };
      }
    };
    var r = makeReflection({ brain: brain, memory: fakeMemory(actions) });
    var p1 = r.reflectOnActions('cadence');
    var p2 = r.reflectOnActions('cadence');
    var [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(thinkCalls, 1, 'only one brain call must fire');
    assert.equal(r2.skipped, 'already-running');
  });

});
