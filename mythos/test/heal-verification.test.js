'use strict';

// Task C2 (2026-08-12 live-session finding): the healer must not claim a heal
// that did not hold. 'healed: build-engine-failed' was announced at 01:05:05
// and 02:24:22 while the identical anomaly kept firing for another minute
// (four recurrences each) — the real cause (a missing OPENAI_API_KEY) was
// nothing reprobe-build-engine could fix, so its ok:true was never proof the
// anomaly was gone. This mirrors the effector "evidence contract"
// (dispatch-action.js: ok:true without proof must carry unverified/reason,
// never be flattened into a plain success) — a healer's ok:true is the same
// unproven claim unless something checks that the anomaly stayed gone.
//
// Uses a custom playbook (via createHealer's `playbooks` override) pointed at
// the existing 'restart-cortex' action so the mechanism under test —
// onDiagnosed + checkVerifications — is exercised without needing the real
// hermes-agent child-process probe. Time is injected (mirrors
// planner/daily.js's nowFn seam); checkVerifications() is called directly
// against the injected clock instead of sleeping out a real window.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createHealer } = require('../src/core/immune/healer');

function fakeBus() {
  const { createBus } = require('../src/core/bus');
  const bus = createBus({ historySize: 200 });
  var emitted = [];
  var origEmit = bus.emit.bind(bus);
  bus.emit = function(type, payload, opts) {
    emitted.push({ type: type, payload: payload });
    return origEmit(type, payload, opts);
  };
  bus._emitted = function() { return emitted.slice(); };
  return bus;
}

function fakeMemory() {
  var auditWrites = [];
  return {
    audit: { write: function(entry) { auditWrites.push(entry); return { ok: true }; } },
    _auditWrites: function() { return auditWrites; }
  };
}

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

// A verified playbook using the real 'restart-cortex' action (ok:true whenever
// getCortex() returns a truthy cortex — no child process, no network).
var VERIFIED_PLAYBOOK = {
  id: 'test-verified-restart',
  title: 'test verified restart',
  when: { kind: 'test-anomaly' },
  then: [{ do: 'restart-cortex' }],
  cooldownMs: 60000,
  verifyMs: 60000
};

function fakeCortex() {
  return { generation: 1, stop: function() {}, start: function() { this.generation++; } };
}

function healedEvents(bus) {
  return bus._emitted().filter(function(e) { return e.type === 'health.healed'; });
}

describe('heal-verification (Task C2) — a heal must hold before it is reported', function() {
  it('does not report "applied" the instant a verified playbook fires', async function() {
    var bus = fakeBus();
    var memory = fakeMemory();
    var healer = createHealer({
      bus: bus, memory: memory, playbooks: [VERIFIED_PLAYBOOK],
      getCortex: fakeCortex, getGoals: function() { return null; }
    });
    healer.start();

    bus.emit('health.diagnosed', { kind: 'test-anomaly', target: null });
    await sleep(10);

    var healed = healedEvents(bus);
    assert.equal(healed.length, 1);
    assert.notEqual(healed[0].payload.outcome, 'applied', 'a heal with an unverified verifyMs must not be announced healed on the first pass');
    assert.notEqual(healed[0].payload.outcome, 'heal-failed', 'no recurrence has happened yet — this must not be a failure either');

    healer.stop();
  });

  it('reports heal-failed (not healed) when the same anomaly recurs inside the verification window', async function() {
    var bus = fakeBus();
    var memory = fakeMemory();
    var tick = 1000000;
    var healer = createHealer({
      bus: bus, memory: memory, playbooks: [VERIFIED_PLAYBOOK],
      getCortex: fakeCortex, getGoals: function() { return null; },
      now: function() { return tick; }
    });
    healer.start();

    bus.emit('health.diagnosed', { kind: 'test-anomaly', target: null });
    await sleep(10);

    // The identical anomaly kind fires again 5s later — well inside the 60s
    // verification window (and inside cooldownMs, matching the real incident:
    // build-engine-failed kept firing every few seconds for the next minute).
    tick += 5000;
    bus.emit('health.diagnosed', { kind: 'test-anomaly', target: null });
    await sleep(10);

    var healed = healedEvents(bus);
    assert.equal(healed.length, 2);
    assert.equal(healed[1].payload.outcome, 'heal-failed', 'a recurrence inside the verification window must correct the earlier claim');
    assert.notEqual(healed[1].payload.outcome, 'healed');
    assert.notEqual(healed[1].payload.outcome, 'applied', 'must never be reported as a successful heal once it is known to have recurred');

    // Visible to the operator: the audit trail records the correction too.
    var writes = memory._auditWrites();
    assert.equal(writes[writes.length - 1].outcome, 'heal-failed');

    healer.stop();
  });

  it('a genuinely successful heal is still reported healed once the verification window passes with no recurrence', async function() {
    var bus = fakeBus();
    var memory = fakeMemory();
    var tick = 2000000;
    var healer = createHealer({
      bus: bus, memory: memory, playbooks: [VERIFIED_PLAYBOOK],
      getCortex: fakeCortex, getGoals: function() { return null; },
      now: function() { return tick; }
    });
    healer.start();

    bus.emit('health.diagnosed', { kind: 'test-anomaly', target: null });
    await sleep(10);
    assert.equal(healedEvents(bus)[0].payload.outcome, 'verifying');

    // Advance the injected clock past verifyMs with no recurrence, then
    // resolve directly — no real sleep, per the no-real-wait requirement.
    tick += 60001;
    healer._internal.checkVerifications();

    var healed = healedEvents(bus);
    assert.equal(healed.length, 2);
    assert.equal(healed[1].payload.outcome, 'applied', 'no recurrence for the full window -> the heal is confirmed');
    assert.equal(healed[1].payload.playbookId, 'test-verified-restart');

    var writes = memory._auditWrites();
    assert.equal(writes[writes.length - 1].outcome, 'applied');

    healer.stop();
  });

  it('a playbook with no verifyMs is unaffected — reports applied immediately (regression guard)', async function() {
    var bus = fakeBus();
    var memory = fakeMemory();
    var healer = createHealer({
      bus: bus, memory: memory, getCortex: fakeCortex, getGoals: function() { return null; }
    });
    healer.start();

    bus.emit('health.diagnosed', { kind: 'cortex-stall', target: null });
    await sleep(10);

    var healed = healedEvents(bus);
    assert.equal(healed.length, 1);
    assert.equal(healed[0].payload.outcome, 'applied', 'unverified playbooks must keep reporting applied immediately, unchanged');

    healer.stop();
  });
});
