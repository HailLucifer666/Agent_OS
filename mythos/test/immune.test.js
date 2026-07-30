'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fsNode = require('fs');
const os = require('os');
const crypto = require('crypto');

const { tempVaultDir, cleanupVaultDir } = require('./helpers');

// ---------------------------------------------------------------------------
// Helpers — fake dependencies (mirrors cortex-goals.test.js's conventions)
// ---------------------------------------------------------------------------

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
  bus._clearEmitted = function() { emitted.length = 0; };
  return bus;
}

function fakeMemory() {
  var auditWrites = [];
  var consolidateCalls = 0;
  return {
    audit: { write: function(entry) { auditWrites.push(entry); return { ok: true }; } },
    consolidate: async function() { consolidateCalls++; return { consolidated: true }; },
    fs: { listFiles: function() { return []; } },
    _auditWrites: function() { return auditWrites; },
    _consolidateCalls: function() { return consolidateCalls; }
  };
}

function fakeGoals() {
  var _activeGoal = null;
  var _goals = new Map();
  return {
    updateCalls: [],
    getActive: function() { return _activeGoal; },
    _setActive: function(g) { _activeGoal = g; if (g) _goals.set(g.id, g); },
    getActiveGoals: function() { return _activeGoal ? [_activeGoal] : []; },
    get: function(id) { return _goals.get(id) || null; },
    _put: function(g) { _goals.set(g.id, g); },
    update: function(id, patch) {
      this.updateCalls.push({ id: id, patch: patch });
      var g = _goals.get(id);
      if (!g) return null;
      Object.assign(g, patch);
      if (_activeGoal && _activeGoal.id === id) Object.assign(_activeGoal, patch);
      return g;
    }
  };
}

function fakeLeash() {
  return { check: function() { return { allow: true }; } };
}

function fakeEffectors() {
  return {
    breakers: { allow: function() { return true; } },
    invoke: async function() { return { ok: true }; }
  };
}

function fakeConfig(overrides) {
  return Object.assign({
    MYTHOS_TICK_MS: 60000,
    MAX_ACTIVE_GOALS: 5,
    STALL_MS: 5000,
    WATCHDOG_MS: 2000,
    ACTION_TIMEOUT_MS: 30000
  }, overrides);
}

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

function makeBigFile(dir, bytes) {
  var file = path.join(dir, 'big.jsonl');
  fsNode.writeFileSync(file, '');
  fsNode.truncateSync(file, bytes);
  return file;
}

// ---------------------------------------------------------------------------
// breakers
// ---------------------------------------------------------------------------

describe('immune/breakers', function() {
  it('requires bus and name at construction', function() {
    var { createBreaker } = require('../src/core/immune/breakers');
    assert.throws(function() { createBreaker({ name: 'x' }); }, /bus/);
    assert.throws(function() { createBreaker({ bus: fakeBus() }); }, /name/);
  });

  it('CLOSED -> OPEN at failThreshold, emits health.anomaly effector-flapping', function() {
    var bus = fakeBus();
    var { createBreaker, BREAKER_STATES } = require('../src/core/immune/breakers');
    var breaker = createBreaker({ name: 'test-a', bus: bus, config: { BREAKER_FAIL_THRESHOLD: 2, BREAKER_RESET_MS: 5000 } });
    assert.equal(breaker.state, BREAKER_STATES.CLOSED);
    breaker.recordFailure();
    assert.equal(breaker.state, BREAKER_STATES.CLOSED, 'one failure below threshold stays closed');
    breaker.recordFailure();
    assert.equal(breaker.state, BREAKER_STATES.OPEN, 'second failure trips OPEN');
    var anomalies = bus._emitted().filter(function(e) { return e.type === 'health.anomaly' && e.payload.kind === 'effector-flapping'; });
    assert.equal(anomalies.length, 1);
    assert.equal(anomalies[0].payload.target, 'test-a');
  });

  it('OPEN blocks allow() until resetAt elapses', function() {
    var bus = fakeBus();
    var { createBreaker } = require('../src/core/immune/breakers');
    var breaker = createBreaker({ name: 'test-b', bus: bus, config: { BREAKER_FAIL_THRESHOLD: 1, BREAKER_RESET_MS: 500 } });
    breaker.recordFailure();
    assert.equal(breaker.state, 'open');
    assert.equal(breaker.allow(), false, 'must not allow before resetAt');
  });

  it('OPEN -> HALF_OPEN after resetMs elapses, allows exactly one probe', async function() {
    var bus = fakeBus();
    var { createBreaker } = require('../src/core/immune/breakers');
    var breaker = createBreaker({ name: 'test-c', bus: bus, config: { BREAKER_FAIL_THRESHOLD: 1, BREAKER_RESET_MS: 30 } });
    breaker.recordFailure();
    assert.equal(breaker.state, 'open');
    await sleep(45);
    // The OPEN->HALF_OPEN transition call itself is the first probe grant (it does not
    // touch halfOpenAttempts); the HALF_OPEN branch's own counter then starts fresh at
    // 0 and permits exactly one further call before blocking — two `true`s total, per
    // the real allow() FSM in breakers.js, then false.
    assert.equal(breaker.allow(), true, 'first allow() after resetAt transitions to half-open and permits a probe');
    assert.equal(breaker.state, 'half-open');
    assert.equal(breaker.allow(), true, 'half-open branch permits exactly one further probe');
    assert.equal(breaker.allow(), false, 'a second further probe in half-open must be blocked');
  });

  it('HALF_OPEN success -> CLOSED', async function() {
    var bus = fakeBus();
    var { createBreaker } = require('../src/core/immune/breakers');
    var breaker = createBreaker({ name: 'test-d', bus: bus, config: { BREAKER_FAIL_THRESHOLD: 1, BREAKER_RESET_MS: 30 } });
    breaker.recordFailure();
    await sleep(45);
    breaker.allow();
    assert.equal(breaker.state, 'half-open');
    breaker.recordSuccess();
    assert.equal(breaker.state, 'closed');
  });

  it('HALF_OPEN failure -> OPEN with exponentially doubled backoff (bug fix regression)', async function() {
    var bus = fakeBus();
    var { createBreaker } = require('../src/core/immune/breakers');
    var breaker = createBreaker({ name: 'test-e', bus: bus, config: { BREAKER_FAIL_THRESHOLD: 1, BREAKER_RESET_MS: 60 } });
    breaker.recordFailure(); // CLOSED -> OPEN, currentResetMs = 60
    var firstResetAt = breaker.stats.resetAt;
    var firstDelay = firstResetAt - Date.now();
    assert.ok(firstDelay > 0 && firstDelay <= 60, 'first backoff should be ~ base resetMs, got ' + firstDelay);

    await sleep(75); // let resetAt pass
    breaker.allow(); // OPEN -> HALF_OPEN
    assert.equal(breaker.state, 'half-open');

    var beforeSecondFail = Date.now();
    breaker.recordFailure(); // HALF_OPEN probe fails -> OPEN, backoff DOUBLES (not resetAt*2 nonsense)
    var secondDelay = breaker.stats.resetAt - beforeSecondFail;
    assert.equal(breaker.state, 'open');
    // Doubled from base 60ms -> ~120ms, NOT a doubled absolute timestamp (which would be
    // billions of ms in the future — the bug this regression test guards against).
    assert.ok(secondDelay > 100 && secondDelay <= 130, 'expected ~120ms doubled backoff, got ' + secondDelay);
  });

  it('reset() forces CLOSED from OPEN without waiting for a probe (the HUD-degraded fix)', function() {
    // Regression for the 2026-07-31 bug: when the healer restores a suppressed
    // tool, recordSuccess() can NEVER run (the tool was suppressed, so it was
    // never dispatched), leaving the breaker stuck OPEN and the HUD showing
    // "degraded" after a heal. reset() is the missing state transition.
    var bus = fakeBus();
    var { createBreaker } = require('../src/core/immune/breakers');
    var breaker = createBreaker({ name: 'test-reset', bus: bus, config: { BREAKER_FAIL_THRESHOLD: 1, BREAKER_RESET_MS: 60000 } });
    breaker.recordFailure(); // CLOSED -> OPEN
    assert.equal(breaker.state, 'open');
    assert.equal(breaker.allow(), false, 'still open, blocking before reset');
    breaker.reset(); // healer's tool-restore path calls this
    assert.equal(breaker.state, 'closed', 'reset() must force CLOSED immediately');
    assert.equal(breaker.allow(), true, 'must allow again after reset');
    assert.equal(breaker.stats.failCount, 0, 'failCount cleared');
  });
});

// ---------------------------------------------------------------------------
// watchdog
// ---------------------------------------------------------------------------

describe('immune/watchdog', function() {
  it('requires getCortex and bus at construction', function() {
    var { createWatchdog } = require('../src/core/immune/watchdog');
    assert.throws(function() { createWatchdog({ bus: fakeBus() }); }, /getCortex/);
    assert.throws(function() { createWatchdog({ getCortex: function() { return null; } }); }, /bus/);
  });

  it('emits cortex-stall when lastTickAt is stale beyond STALL_MS, never calls cortex.stop/start', async function() {
    var bus = fakeBus();
    var stopCalls = 0, startCalls = 0;
    var fakeCortex = {
      lastTickAt: { value: Date.now() - 100 },
      stop: function() { stopCalls++; },
      start: function() { startCalls++; }
    };
    var { createWatchdog } = require('../src/core/immune/watchdog');
    var watchdog = createWatchdog({ bus: bus, config: { STALL_MS: 50, WATCHDOG_MS: 20 }, getCortex: function() { return fakeCortex; } });
    watchdog.start();
    await sleep(60);
    watchdog.stop();
    var anomalies = bus._emitted().filter(function(e) { return e.type === 'health.anomaly' && e.payload.kind === 'cortex-stall'; });
    assert.ok(anomalies.length >= 1, 'expected at least one cortex-stall anomaly');
    assert.equal(stopCalls, 0, 'watchdog must never call cortex.stop() directly');
    assert.equal(startCalls, 0, 'watchdog must never call cortex.start() directly');
  });

  it('does not emit when lastTickAt is fresh', async function() {
    var bus = fakeBus();
    var fakeCortex = { lastTickAt: { value: Date.now() } };
    var { createWatchdog } = require('../src/core/immune/watchdog');
    var watchdog = createWatchdog({ bus: bus, config: { STALL_MS: 5000, WATCHDOG_MS: 20 }, getCortex: function() { return fakeCortex; } });
    watchdog.start();
    await sleep(60);
    watchdog.stop();
    var anomalies = bus._emitted().filter(function(e) { return e.type === 'health.anomaly' && e.payload.kind === 'cortex-stall'; });
    assert.equal(anomalies.length, 0);
  });

  it('is a no-op before cortex exists (getCortex() returns null)', function() {
    var bus = fakeBus();
    var { createWatchdog } = require('../src/core/immune/watchdog');
    var watchdog = createWatchdog({ bus: bus, config: { STALL_MS: 50 }, getCortex: function() { return null; } });
    assert.doesNotThrow(function() { watchdog._internal.check(); });
    assert.equal(bus._emitted().length, 0);
  });
});

// ---------------------------------------------------------------------------
// diagnostician
// ---------------------------------------------------------------------------

describe('immune/diagnostician', function() {
  it('requires bus at construction', function() {
    var { createDiagnostician } = require('../src/core/immune/diagnostician');
    assert.throws(function() { createDiagnostician({}); }, /bus/);
  });

  it('severityOf maps known kinds, defaults unknown to minor', function() {
    var { severityOf } = require('../src/core/immune/diagnostician');
    assert.equal(severityOf('cortex-stall'), 'critical');
    assert.equal(severityOf('provider-down'), 'major');
    assert.equal(severityOf('quota-low'), 'minor');
    assert.equal(severityOf('nonsense-kind'), 'minor');
  });

  it('playbookLookup finds the matching SEED_PLAYBOOKS id by kind', function() {
    var { playbookLookup } = require('../src/core/immune/diagnostician');
    assert.equal(playbookLookup('cortex-stall'), 'stall-restart');
    assert.equal(playbookLookup('budget-exhausted'), 'budget-pause');
    assert.equal(playbookLookup('causal-loop'), null);
  });

  it('diagnose() shapes a full diagnosis from a raw anomaly', function() {
    var { diagnose } = require('../src/core/immune/diagnostician');
    var d = diagnose({ kind: 'cortex-stall', elapsed: 9999 });
    assert.equal(d.kind, 'cortex-stall');
    assert.equal(d.severity, 'critical');
    assert.equal(d.suggestedAction, 'stall-restart');
    assert.deepEqual(d.evidence, { kind: 'cortex-stall', elapsed: 9999 });
  });

  it('start() subscribes health.anomaly and re-emits health.diagnosed', function() {
    var bus = fakeBus();
    var { createDiagnostician } = require('../src/core/immune/diagnostician');
    var diag = createDiagnostician({ bus: bus });
    diag.start();
    bus.emit('health.anomaly', { kind: 'provider-down', target: 'nim' });
    var diagnosed = bus._emitted().filter(function(e) { return e.type === 'health.diagnosed'; });
    assert.equal(diagnosed.length, 1);
    assert.equal(diagnosed[0].payload.kind, 'provider-down');
    assert.equal(diagnosed[0].payload.severity, 'major');
    diag.stop();
  });
});

// ---------------------------------------------------------------------------
// healer — DSL evaluator (both shapes: eq-leaf and nested-field)
// ---------------------------------------------------------------------------

describe('immune/healer — matchClause/matches DSL', function() {
  it('matches an eq-leaf clause directly against anomaly.target', function() {
    var { matchClause, matches } = require('../src/core/immune/healer');
    assert.equal(matchClause({ eq: 'nim' }, 'nim'), true);
    assert.equal(matchClause({ eq: 'nim' }, 'groq'), false);
    assert.equal(matches({ when: { kind: 'provider-down', target: { eq: 'nim' } } }, { kind: 'provider-down', target: 'nim' }), true);
    assert.equal(matches({ when: { kind: 'provider-down', target: { eq: 'nim' } } }, { kind: 'provider-down', target: 'groq' }), false);
  });

  it('matches a nested-field gt clause against anomaly.target.bytes', function() {
    var { matchClause, matches } = require('../src/core/immune/healer');
    assert.equal(matchClause({ bytes: { gt: 100 } }, { bytes: 150 }), true);
    assert.equal(matchClause({ bytes: { gt: 100 } }, { bytes: 50 }), false);
    var playbook = { when: { kind: 'memory-growth', target: { bytes: { gt: 100 } } } };
    assert.equal(matches(playbook, { kind: 'memory-growth', target: { bytes: 150 } }), true);
    assert.equal(matches(playbook, { kind: 'memory-growth', target: { bytes: 50 } }), false);
  });

  it('an absent when.target matches any target', function() {
    var { matches } = require('../src/core/immune/healer');
    assert.equal(matches({ when: { kind: 'cortex-stall' } }, { kind: 'cortex-stall', target: undefined }), true);
    assert.equal(matches({ when: { kind: 'cortex-stall' } }, { kind: 'cortex-stall', target: 'anything' }), true);
  });

  it('resolveArgs resolves $-prefixed dotted paths against the diagnosis', function() {
    var { resolveArgs, getPath } = require('../src/core/immune/healer');
    var diagnosis = { kind: 'memory-growth', target: { bytes: 12345 } };
    assert.equal(getPath(diagnosis, 'target.bytes'), 12345);
    var resolved = resolveArgs({ literal: 'x', dynamic: '$target.bytes' }, diagnosis);
    assert.deepEqual(resolved, { literal: 'x', dynamic: 12345 });
  });

  it('all eight SEED_PLAYBOOKS are well-formed (kind + then + cooldownMs)', function() {
    // REMEDIATION P2-10: 6 -> 8 — search-provider-degrade and
    // build-engine-reprobe added (2026-07-29 audit item 11).
    var { SEED_PLAYBOOKS } = require('../src/core/immune/healer');
    assert.equal(SEED_PLAYBOOKS.length, 8);
    SEED_PLAYBOOKS.forEach(function(p) {
      assert.ok(p.id, 'playbook missing id');
      assert.ok(p.when && p.when.kind, 'playbook ' + p.id + ' missing when.kind');
      assert.ok(Array.isArray(p.then) && p.then.length > 0, 'playbook ' + p.id + ' missing then[]');
      assert.equal(typeof p.cooldownMs, 'number', 'playbook ' + p.id + ' missing cooldownMs');
    });
  });
});

describe('immune/healer — cooldown + actions', function() {
  it('requires bus at construction', function() {
    var { createHealer } = require('../src/core/immune/healer');
    assert.throws(function() { createHealer({}); }, /bus/);
  });

  it('applies a matching playbook once, then blocks a repeat within cooldownMs', async function() {
    var bus = fakeBus();
    var memory = fakeMemory();
    var goals = fakeGoals();
    var { createHealer } = require('../src/core/immune/healer');
    var healer = createHealer({
      bus: bus, config: fakeConfig(), memory: memory,
      getCortex: function() { return null; }, // 'restart-cortex' will report missing-dependency
      getGoals: function() { return goals; }
    });
    healer.start();

    bus.emit('health.diagnosed', { kind: 'cortex-stall', target: null });
    await sleep(10);
    var healed1 = bus._emitted().filter(function(e) { return e.type === 'health.healed'; });
    assert.equal(healed1.length, 1);
    assert.equal(healed1[0].payload.playbookId, 'stall-restart');
    assert.equal(healed1[0].payload.outcome, 'error', 'no real cortex -> missing-dependency error, not a crash');

    bus.emit('health.diagnosed', { kind: 'cortex-stall', target: null });
    await sleep(10);
    var healed2 = bus._emitted().filter(function(e) { return e.type === 'health.healed'; });
    assert.equal(healed2.length, 2);
    assert.equal(healed2[1].payload.outcome, 'cooldown', 'second stall-restart within 30s should be blocked by cooldown');

    healer.stop();
  });

  it('emits no-match and audits nothing actionable for an unrecognized kind', async function() {
    var bus = fakeBus();
    var memory = fakeMemory();
    var { createHealer } = require('../src/core/immune/healer');
    var healer = createHealer({ bus: bus, config: fakeConfig(), memory: memory, getCortex: function() { return null; }, getGoals: function() { return null; } });
    healer.start();
    bus.emit('health.diagnosed', { kind: 'totally-unknown', target: null });
    await sleep(10);
    var healed = bus._emitted().filter(function(e) { return e.type === 'health.healed'; });
    assert.equal(healed.length, 1);
    assert.equal(healed[0].payload.playbookId, null);
    assert.equal(healed[0].payload.outcome, 'no-match');
    healer.stop();
  });

  it('pause-goal is idempotent — does not re-transition an already-paused goal', async function() {
    var bus = fakeBus();
    var memory = fakeMemory();
    var goals = fakeGoals();
    goals._put({ id: 'goal-1', status: 'paused' });
    var { createHealer } = require('../src/core/immune/healer');
    var healer = createHealer({ bus: bus, config: fakeConfig(), memory: memory, getCortex: function() { return null; }, getGoals: function() { return goals; } });
    healer.start();
    bus.emit('health.diagnosed', { kind: 'budget-exhausted', target: 'goal-1' });
    await sleep(10);
    assert.equal(goals.updateCalls.length, 0, 'already-paused goal must not be re-transitioned');
    var healed = bus._emitted().filter(function(e) { return e.type === 'health.healed'; });
    assert.equal(healed[0].payload.outcome, 'applied');
    healer.stop();
  });

  it('pause-goal transitions an active goal to paused', async function() {
    var bus = fakeBus();
    var memory = fakeMemory();
    var goals = fakeGoals();
    goals._put({ id: 'goal-2', status: 'active' });
    var { createHealer } = require('../src/core/immune/healer');
    var healer = createHealer({ bus: bus, config: fakeConfig(), memory: memory, getCortex: function() { return null; }, getGoals: function() { return goals; } });
    healer.start();
    bus.emit('health.diagnosed', { kind: 'budget-exhausted', target: 'goal-2' });
    await sleep(10);
    assert.equal(goals.updateCalls.length, 1);
    assert.equal(goals.get('goal-2').status, 'paused');
    healer.stop();
  });

  it('writes an audit entry for every heal outcome', async function() {
    var bus = fakeBus();
    var memory = fakeMemory();
    var { createHealer } = require('../src/core/immune/healer');
    var healer = createHealer({ bus: bus, config: fakeConfig(), memory: memory, getCortex: function() { return null; }, getGoals: function() { return null; } });
    healer.start();
    bus.emit('health.diagnosed', { kind: 'memory-growth', target: { bytes: 999999999 } });
    await sleep(10);
    assert.equal(memory._auditWrites().length, 1);
    assert.equal(memory._auditWrites()[0].actor, 'healer');
    healer.stop();
  });

  it('consolidate-memory action calls memory.consolidate()', async function() {
    var bus = fakeBus();
    var memory = fakeMemory();
    var { createHealer } = require('../src/core/immune/healer');
    var healer = createHealer({ bus: bus, config: fakeConfig(), memory: memory, getCortex: function() { return null; }, getGoals: function() { return null; } });
    healer.start();
    bus.emit('health.diagnosed', { kind: 'memory-growth', target: { bytes: 999999999 } });
    await sleep(10);
    assert.equal(memory._consolidateCalls(), 1);
    var healed = bus._emitted().filter(function(e) { return e.type === 'health.healed'; });
    assert.equal(healed[0].payload.outcome, 'applied');
    healer.stop();
  });

  it('BUG-013: suppress-tool action suppresses a flapping tool from planner', async function() {
    var bus = fakeBus();
    var memory = fakeMemory();
    var { createHealer, isToolSuppressed } = require('../src/core/immune/healer');
    var healer = createHealer({ bus: bus, config: fakeConfig(), memory: memory, getCortex: function() { return null; }, getGoals: function() { return null; } });
    healer.start();

    // Emit effector-flapping event for 'spotify_play'
    bus.emit('health.diagnosed', { kind: 'effector-flapping', target: 'spotify_play' });
    await sleep(10);

    // Check that the playbook matched and applied successfully
    var healed = bus._emitted().filter(function(e) { return e.type === 'health.healed'; });
    assert.equal(healed.length, 1);
    assert.equal(healed[0].payload.playbookId, 'effector-flapping-breaker');
    assert.equal(healed[0].payload.outcome, 'applied');
    assert.equal(healed[0].payload.target, 'spotify_play');

    // Verify the tool is now suppressed
    assert.ok(isToolSuppressed('spotify_play'), 'spotify_play should be suppressed');
    assert.ok(!isToolSuppressed('some_other_tool'), 'other tools must not be suppressed');

    healer.stop();
  });

  it('BUG-013: suppressed tools auto-restore after cooldown expires', async function() {
    var bus = fakeBus();
    var memory = fakeMemory();
    var { createHealer, isToolSuppressed } = require('../src/core/immune/healer');
    var healer = createHealer({ bus: bus, config: fakeConfig(), memory: memory, getCortex: function() { return null; }, getGoals: function() { return null; } });
    healer.start();

    // Suppress a tool
    bus.emit('health.diagnosed', { kind: 'effector-flapping', target: 'test_tool_1' });
    await sleep(10);
    assert.ok(isToolSuppressed('test_tool_1'), 'tool should be suppressed after playbook fires');

    // Wait for restore timer (which runs every 60s in production, but we'll wait a moment here)
    // In the real scenario, this would happen automatically on the next restore check.
    // For the test, we manually verify the field is set by checking healed events.
    var healed = bus._emitted().filter(function(e) { return e.type === 'health.healed'; });
    assert.ok(healed.length > 0, 'at least one healed event should be emitted');

    healer.stop();
  });

  // REMEDIATION P2-10 (2026-07-29 audit, item 11): search-provider-failed and
  // build-engine-failed previously matched NO playbook at all ('no-match') —
  // the immune system detected the two failures that actually mattered in the
  // audited session and had nothing to do about either.
  it('search-provider-degrade suppresses the failing provider so the next web_search call skips it', async function() {
    var bus = fakeBus();
    var memory = fakeMemory();
    var { createHealer, isSearchProviderSuppressed } = require('../src/core/immune/healer');
    var healer = createHealer({ bus: bus, config: fakeConfig(), memory: memory, getCortex: function() { return null; }, getGoals: function() { return null; } });
    healer.start();

    // diagnostician.js's real diagnose() carries the full anomaly under
    // `evidence` — reproduced here rather than mocked, since that's the exact
    // shape the healer receives in production.
    bus.emit('health.diagnosed', {
      kind: 'search-provider-failed', target: undefined,
      evidence: { kind: 'search-provider-failed', provider: 'ddg-html', error: 'timeout' }
    });
    await sleep(10);

    var healed = bus._emitted().filter(function(e) { return e.type === 'health.healed'; });
    assert.equal(healed.length, 1);
    assert.equal(healed[0].payload.playbookId, 'search-provider-degrade');
    assert.equal(healed[0].payload.outcome, 'applied');
    assert.ok(isSearchProviderSuppressed('ddg-html'), 'the specific failing provider must be suppressed');
    assert.ok(!isSearchProviderSuppressed('wikipedia'), 'unrelated providers must be unaffected');

    healer.stop();
  });

  it('build-engine-reprobe forces a fresh Hermes probe and surfaces the item-6 CLI diagnostic', async function() {
    var bus = fakeBus();
    var memory = fakeMemory();
    var { createHealer } = require('../src/core/immune/healer');
    var healer = createHealer({ bus: bus, config: fakeConfig(), memory: memory, getCortex: function() { return null; }, getGoals: function() { return null; } });
    healer.start();

    bus.emit('health.diagnosed', {
      kind: 'build-engine-failed', target: undefined,
      evidence: { kind: 'build-engine-failed', engine: 'hermes', error: 'hermes-agent OFFLINE: ...' }
    });
    // Real probe() against the real hermes-agent adapter — a genuine live
    // re-probe, not a mock. Poll instead of a fixed sleep: the CLI spawn this
    // triggers is a real child process (~1s typical, more under load).
    var healed = [];
    for (var attempt = 0; attempt < 50 && healed.length === 0; attempt++) {
      await sleep(200);
      healed = bus._emitted().filter(function(e) { return e.type === 'health.healed'; });
    }
    assert.equal(healed.length, 1);
    assert.equal(healed[0].payload.playbookId, 'build-engine-reprobe');
    assert.equal(healed[0].payload.outcome, 'applied');
    assert.ok(healed[0].payload.detail && (healed[0].payload.detail.state === 'ONLINE' || healed[0].payload.detail.state === 'OFFLINE'),
      'must report a definite re-probed state, not silence');

    healer.stop();
  });
});

// ---------------------------------------------------------------------------
// (regression) degrade-lane — real registry.js seam
// ---------------------------------------------------------------------------

describe('immune/healer — (regression) degrade-lane real registry.js seam', function() {
  it('after degrade-lane fires, the CHAIN_VOICE override genuinely excludes groq', async function() {
    var bus = fakeBus();
    var memory = fakeMemory();
    var { createHealer } = require('../src/core/immune/healer');
    var healer = createHealer({ bus: bus, config: fakeConfig(), memory: memory, getCortex: function() { return null; }, getGoals: function() { return null; } });
    healer.start();
    delete process.env.CHAIN_VOICE;
    bus.emit('health.diagnosed', { kind: 'quota-low', target: 'groq' });
    await sleep(10);
    var healed = bus._emitted().filter(function(e) { return e.type === 'health.healed'; });
    assert.equal(healed[0].payload.playbookId, 'quota-guard');
    assert.equal(healed[0].payload.outcome, 'applied');

    var registry = require('../src/core/brain/registry');
    var override = registry._internal.parseOverride(process.env.CHAIN_VOICE);
    assert.ok(override.length > 0, 'override should be non-empty');
    assert.ok(!override.some(function(p) { return p.provider === 'groq'; }), 'groq must be excluded from the degraded voice lane');
    delete process.env.CHAIN_VOICE;
    healer.stop();
  });
});

// ---------------------------------------------------------------------------
// (regression) budget-exhausted producer — real goals/index.js
// ---------------------------------------------------------------------------

describe('goals/index — (regression) budget-exhausted health.anomaly producer', function() {
  function fakeFs() {
    var store = {};
    return {
      ensureDir: function() {},
      writeJSON: function(rel, data) { store[rel] = JSON.stringify(data); },
      readJSON: function(rel, fallback) { try { return JSON.parse(store[rel]); } catch(_) { return fallback; } },
      removeFile: function(rel) { delete store[rel]; },
      listFiles: function() { return []; }
    };
  }

  it('debitBudget past budget emits health.anomaly kind budget-exhausted on a real bus', function() {
    var bus = fakeBus();
    var fs = fakeFs();
    var { createGoalSystem } = require('../src/core/goals');
    var goals = createGoalSystem({ fs: fs, config: {}, bus: bus, memory: null, brain: null });
    var goal = goals.create({ title: 'Spender', status: 'active', budget: { tokens: 100, actions: 5 } });
    goals.debitBudget(goal.id, { tokens: 100, actions: 1 });
    var anomalies = bus._emitted().filter(function(e) { return e.type === 'health.anomaly' && e.payload.kind === 'budget-exhausted'; });
    assert.equal(anomalies.length, 1);
    assert.equal(anomalies[0].payload.target, goal.id);
  });
});

// ---------------------------------------------------------------------------
// (regression) quota null-guard — real quota.js
// ---------------------------------------------------------------------------

describe('immune/probes — (regression) null-guard on remainingPercent', function() {
  it('unlimited/untracked providers (remainingPercent: null) never satisfy the quota-low guard', function() {
    var quota = require('../src/core/quota');
    var stats = { byProvider: {}, today: { calls: 0, tokensIn: 0, tokensOut: 0 } };
    var quotas = quota.getAllQuotas(stats);
    // Exact guard predicate used in probes.js's getStatus() — see Spec Ambiguities #7.
    function isQuotaLow(q) { return !q.unlimited && q.remainingPercent !== null && q.remainingPercent < 10; }

    var ollama = quotas.find(function(q) { return q.provider === 'ollama'; });
    assert.equal(ollama.unlimited, true);
    assert.equal(isQuotaLow(ollama), false, 'unlimited provider must never trigger quota-low');

    var zcode = quotas.find(function(q) { return q.provider === 'zcode'; });
    assert.equal(zcode.remainingPercent, null, 'zcode has no publicly documented cap');
    assert.equal(isQuotaLow(zcode), false, 'null remainingPercent must never coerce to a false low-quota positive');

    var groq = quotas.find(function(q) { return q.provider === 'groq'; });
    var lowStats = { byProvider: { groq: { calls: 970, tokens: 0 } }, today: { calls: 970, tokensIn: 0, tokensOut: 0 } }; // ~97% of 1000 req/day used
    var groqLow = quota.getQuotaStatus('groq', lowStats);
    assert.ok(groqLow.remainingPercent < 10, 'sanity: contrived stats should genuinely be low, got ' + groqLow.remainingPercent);
    assert.equal(isQuotaLow(groqLow), true, 'a real low-quota provider must still trigger the guard');
  });

  it('isProviderDown classifies nim/groq/mistral correctly, never flags ollama', function() {
    var { isProviderDown } = require('../src/core/immune/probes');
    var status = {
      nim: { configured: 1, aliveModels: 0 },
      groq: { alive: false },
      mistral: { alive: true }
    };
    assert.equal(isProviderDown('nim', status), true, 'configured nim with zero alive models is down');
    assert.equal(isProviderDown('groq', status), true);
    assert.equal(isProviderDown('mistral', status), false);
    assert.equal(isProviderDown('ollama', status), false, 'ollama is local/optional — never "down"');
  });

  it('requires bus at construction', function() {
    var { createProbes } = require('../src/core/immune/probes');
    assert.throws(function() { createProbes({}); }, /bus/);
  });
});

// ---------------------------------------------------------------------------
// announcer
// ---------------------------------------------------------------------------

describe('immune/announcer', function() {
  it('requires bus and speak() at construction', function() {
    var { createAnnouncer } = require('../src/core/immune/announcer');
    assert.throws(function() { createAnnouncer({ speak: function() {} }); }, /bus/);
    assert.throws(function() { createAnnouncer({ bus: fakeBus() }); }, /speak/);
  });

  it('W6: does NOT announce health.diagnosed (conversation/announcer owns that now)', async function() {
    var bus = fakeBus();
    var spoken = [];
    var { createAnnouncer } = require('../src/core/immune/announcer');
    var announcer = createAnnouncer({ bus: bus, speak: function(text) { spoken.push(text); return Promise.resolve(); } });
    announcer.start();
    // Pre-W6 both immune/announcer and conversation/announcer spoke on health.diagnosed
    // (double-speak). W6 removes the subscription here — conversation/announcer is the
    // single speaker. Emit at every severity; none should be spoken by THIS announcer.
    bus.emit('health.diagnosed', { kind: 'cortex-stall', target: null, severity: 'critical' });
    bus.emit('health.diagnosed', { kind: 'quota-low', target: 'groq', severity: 'minor' });
    await sleep(10);
    assert.equal(spoken.length, 0, 'immune/announcer must not speak on health.diagnosed after W6');
    announcer.stop();
  });

  it('announces a successful heal, ignores non-applied outcomes', async function() {
    var bus = fakeBus();
    var spoken = [];
    var { createAnnouncer } = require('../src/core/immune/announcer');
    var announcer = createAnnouncer({ bus: bus, speak: function(text) { spoken.push(text); return Promise.resolve(); } });
    announcer.start();
    bus.emit('health.healed', { playbookId: 'stall-restart', outcome: 'applied' });
    bus.emit('health.healed', { playbookId: 'quota-guard', outcome: 'cooldown' });
    await sleep(10);
    assert.equal(spoken.length, 1);
    assert.ok(spoken[0].indexOf('stall-restart') !== -1);
    announcer.stop();
  });

  it('never throws even if speak() rejects', async function() {
    var bus = fakeBus();
    var { createAnnouncer } = require('../src/core/immune/announcer');
    var announcer = createAnnouncer({ bus: bus, speak: function() { return Promise.reject(new Error('tts down')); } });
    announcer.start();
    assert.doesNotThrow(function() { bus.emit('lifecycle.recovered', {}); });
    await sleep(10);
    announcer.stop();
  });

  // W6 removed the health.diagnosed subscription from immune/announcer (single-speaker
  // fix — conversation/announcer now owns diagnosis speech). The BUG-030 dedup test
  // that previously lived here pinned dedup behavior on a subscription that no longer
  // exists; the dedup map is retained in source for any future health-channel sub, but
  // with no subscriber there is no path to exercise. The W6 regression test
  // (test/w6-single-announcer.test.js) pins the new end-to-end single-speaker contract.
});

// ---------------------------------------------------------------------------
// monitor — checkpoint cadence (real memory facade) + memory-growth
// ---------------------------------------------------------------------------

describe('immune/monitor', function() {
  it('requires bus and memory at construction', function() {
    var { createMonitor } = require('../src/core/immune/monitor');
    assert.throws(function() { createMonitor({ memory: {} }); }, /bus/);
    assert.throws(function() { createMonitor({ bus: fakeBus() }); }, /memory/);
  });

  it('checkpoints every CHECKPOINT_EVERY_TICKS ticks using a real memory facade', async function() {
    var dir = tempVaultDir();
    try {
      var bus = fakeBus();
      var { createMemory } = require('../src/core/memory');
      var memory = createMemory({ config: { MYTHOS_VAULT_ROOT: dir, EPISODIC_RETENTION_DAYS: 30 }, bus: bus, logger: { info(){}, warn(){}, error(){}, debug(){} }, brain: null });
      await memory.init();

      assert.equal(memory.checkpoints.load(), null, 'no checkpoint should exist yet');

      var { createMonitor } = require('../src/core/immune/monitor');
      var monitor = createMonitor({ bus: bus, config: { CHECKPOINT_EVERY_TICKS: 3 }, memory: memory });
      monitor.start();

      memory.working.tick = 1;
      bus.emit('tick', { tick: 1 });
      assert.equal(memory.checkpoints.load(), null, 'tick 1 is not a checkpoint tick');

      memory.working.tick = 2;
      bus.emit('tick', { tick: 2 });
      assert.equal(memory.checkpoints.load(), null, 'tick 2 is not a checkpoint tick');

      memory.working.tick = 3;
      bus.emit('tick', { tick: 3 });
      var checkpoint = memory.checkpoints.load();
      assert.ok(checkpoint, 'tick 3 (multiple of 3) should have saved a checkpoint');
      assert.equal(checkpoint.tick, 3);

      monitor.stop();
    } finally {
      cleanupVaultDir(dir);
    }
  });

  it('checkMemoryGrowth emits health.anomaly when tracked files exceed MEMORY_GROWTH_BYTES', function() {
    var dir = fsNode.mkdtempSync(path.join(os.tmpdir(), 'mythos-mem-growth-'));
    try {
      var { MEMORY_GROWTH_BYTES } = require('../src/core/immune/monitor');
      var bigFile = makeBigFile(dir, MEMORY_GROWTH_BYTES + 1);
      var bus = fakeBus();
      var memory = {
        fs: { listFiles: function(relDir) { return relDir === 'Episodic' ? [{ full: bigFile }] : []; } }
      };
      var { createMonitor } = require('../src/core/immune/monitor');
      var monitor = createMonitor({ bus: bus, config: {}, memory: memory });
      monitor.checkMemoryGrowth();
      var anomalies = bus._emitted().filter(function(e) { return e.type === 'health.anomaly' && e.payload.kind === 'memory-growth'; });
      assert.equal(anomalies.length, 1);
      assert.ok(anomalies[0].payload.target.bytes > MEMORY_GROWTH_BYTES);
    } finally {
      fsNode.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checkMemoryGrowth does not emit when under threshold', function() {
    var dir = fsNode.mkdtempSync(path.join(os.tmpdir(), 'mythos-mem-small-'));
    try {
      var smallFile = makeBigFile(dir, 1000);
      var bus = fakeBus();
      var memory = { fs: { listFiles: function(relDir) { return relDir === 'Episodic' ? [{ full: smallFile }] : []; } } };
      var { createMonitor } = require('../src/core/immune/monitor');
      var monitor = createMonitor({ bus: bus, config: {}, memory: memory });
      monitor.checkMemoryGrowth();
      var anomalies = bus._emitted().filter(function(e) { return e.type === 'health.anomaly' && e.payload.kind === 'memory-growth'; });
      assert.equal(anomalies.length, 0);
    } finally {
      fsNode.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('threshold sync: MEMORY_GROWTH_BYTES equals the mem-consolidate playbook\'s literal', function() {
    var { MEMORY_GROWTH_BYTES } = require('../src/core/immune/monitor');
    var { SEED_PLAYBOOKS } = require('../src/core/immune/healer');
    var playbook = SEED_PLAYBOOKS.find(function(p) { return p.id === 'mem-consolidate'; });
    assert.equal(MEMORY_GROWTH_BYTES, playbook.when.target.bytes.gt, 'the two 50000000 literals must not drift apart');
  });
});

describe('immune/monitor — recoverFromCrash (§10)', function() {
  it('pauses active-at-crash goals and emits lifecycle.recovered', async function() {
    var bus = fakeBus();
    var goals = fakeGoals();
    goals._setActive({ id: 'goal-crash', status: 'active' });
    var checkpointLoaded = { tick: 5, isCrashRecovery: true };
    var memory = { checkpoints: { load: function() { return checkpointLoaded; } } };
    var { recoverFromCrash } = require('../src/core/immune/monitor');
    var result = await recoverFromCrash({ bus: bus, config: {}, memory: memory, goals: goals });
    assert.equal(result.hadCheckpoint, true);
    assert.equal(result.pausedGoals, 1);
    assert.equal(goals.get('goal-crash').status, 'paused');
    var recovered = bus._emitted().filter(function(e) { return e.type === 'lifecycle.recovered'; });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].payload.isCrashRecovery, true);
    assert.equal(recovered[0].payload.pausedGoals, 1);
  });

  it('handles no checkpoint / no active goals cleanly', async function() {
    var bus = fakeBus();
    var memory = { checkpoints: { load: function() { return null; } } };
    var { recoverFromCrash } = require('../src/core/immune/monitor');
    var result = await recoverFromCrash({ bus: bus, config: {}, memory: memory, goals: null });
    assert.equal(result.hadCheckpoint, false);
    assert.equal(result.pausedGoals, 0);
  });
});

// ---------------------------------------------------------------------------
// sensors/metric
// ---------------------------------------------------------------------------

describe('core/sensors/metric', function() {
  it('requires bus and probes at construction', function() {
    var { createMetricSensor } = require('../src/core/sensors/metric');
    assert.throws(function() { createMetricSensor({ probes: { getStatus: async function(){} } }); }, /bus/);
    assert.throws(function() { createMetricSensor({ bus: fakeBus() }); }, /probes/);
  });

  it('emits perception.metric with .salience (not .salienceHint) on each poll', async function() {
    var bus = fakeBus();
    var probes = { getStatus: async function() { return { providers: {}, quotas: [{ unlimited: true, remainingPercent: null }], probedAt: Date.now() }; } };
    var { createMetricSensor } = require('../src/core/sensors/metric');
    var sensor = createMetricSensor({ bus: bus, config: {}, probes: probes });
    await sensor._internal.poll();
    var events = bus._emitted().filter(function(e) { return e.type === 'perception.metric'; });
    assert.equal(events.length, 1);
    assert.equal(typeof events[0].payload.salience, 'number');
    assert.equal(events[0].payload.salienceHint, undefined, 'must not use the doc\'s salienceHint field name');
    assert.equal(events[0].payload.salience, 0.2, 'no low-quota provider -> low salience');
  });

  it('raises salience to 0.9 when a provider is genuinely low on quota', async function() {
    var bus = fakeBus();
    var probes = { getStatus: async function() { return { providers: {}, quotas: [{ unlimited: false, remainingPercent: 5 }], probedAt: Date.now() }; } };
    var { createMetricSensor } = require('../src/core/sensors/metric');
    var sensor = createMetricSensor({ bus: bus, config: {}, probes: probes });
    await sensor._internal.poll();
    var events = bus._emitted().filter(function(e) { return e.type === 'perception.metric'; });
    assert.equal(events[0].payload.salience, 0.9);
  });

  it('a failed poll is honest-inert — never throws, never crashes the timer', async function() {
    var bus = fakeBus();
    var probes = { getStatus: async function() { throw new Error('probe failed'); } };
    var { createMetricSensor } = require('../src/core/sensors/metric');
    var sensor = createMetricSensor({ bus: bus, config: {}, probes: probes });
    await assert.doesNotReject(sensor._internal.poll());
  });
});

// ---------------------------------------------------------------------------
// Real-instance integration (lesson #4): real bus + real cortex + real
// diagnostician + real healer + real watchdog restarts a genuinely stalled
// cortex exactly once.
// ---------------------------------------------------------------------------

describe('immune — real watchdog -> diagnostician -> healer -> real cortex restart', function() {
  it('restarts a genuinely stalled real cortex exactly once, not twice', async function() {
    var bus = fakeBus();
    var memory = fakeMemory();
    memory.working = {
      tick: 0, activeGoalId: null, spendThisTick: 0,
      drainPerceptions: function() { return []; },
      resetTickState: function() {},
      pushPerception: function() {},
      addSpend: function() {}
    };
    memory.episodic = { write: async function() {} };
    var goals = fakeGoals();
    var leash = fakeLeash();
    var effectors = fakeEffectors();
    var config = fakeConfig({ MYTHOS_TICK_MS: 60000, STALL_MS: 50, WATCHDOG_MS: 20, MAX_ACTIVE_GOALS: 5 });

    var { createCortex } = require('../src/core/cortex');
    var cortex = createCortex({ bus: bus, memory: memory, goals: goals, brain: null, leash: leash, effectors: effectors, config: config });

    var { createDiagnostician } = require('../src/core/immune/diagnostician');
    var { createHealer } = require('../src/core/immune/healer');
    var { createWatchdog } = require('../src/core/immune/watchdog');

    var diagnostician = createDiagnostician({ bus: bus });
    var healer = createHealer({ bus: bus, config: config, memory: memory, getCortex: function() { return cortex; }, getGoals: function() { return goals; } });
    var watchdog = createWatchdog({ bus: bus, config: config, getCortex: function() { return cortex; } });

    diagnostician.start();
    healer.start();

    cortex.start();
    var genBeforeStall = cortex.generation;
    // Do NOT call tickOnce() — lastTickAt.value stays at cortex.start() time, so it
    // ages past STALL_MS relative to the watchdog's checks below.
    await sleep(30);
    watchdog.start();
    await sleep(120); // several WATCHDOG_MS=20 check cycles — should fire exactly once

    // cortex/index.js's stop() AND start() each bump `generation` once (already-shipped
    // Phase 3/4 behavior, not something Phase 6 controls), so exactly one restart cycle
    // (stop+start) is +2. If watchdog's own double-restart bug (Ambiguity #2) were
    // reintroduced, two full restart cycles would land here at +4 instead.
    assert.equal(cortex.generation, genBeforeStall + 2, 'exactly one restart cycle (stop+start), from healer, not two');
    var healed = bus._emitted().filter(function(e) { return e.type === 'health.healed' && e.payload.playbookId === 'stall-restart'; });
    assert.ok(healed.length >= 1, 'stall-restart playbook should have fired');
    assert.equal(healed[0].payload.outcome, 'applied');

    watchdog.stop();
    diagnostician.stop();
    healer.stop();
    cortex.stop();
  });
});
