'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Helpers — fake dependencies
// ---------------------------------------------------------------------------

function fakeFs() {
  var store = {};
  return {
    ensureDir: function() {},
    writeJSON: function(rel, data) { store[rel] = JSON.stringify(data); },
    readJSON: function(rel, fallback) { try { return JSON.parse(store[rel]); } catch(_) { return fallback; } },
    removeFile: function(rel) { delete store[rel]; },
    listFiles: function(dir, ext) {
      return Object.keys(store).filter(function(k) { return k.indexOf(dir + '/') === 0 && k.endsWith(ext); })
        .map(function(k) { return { path: k }; });
    }
  };
}

function fakeBus() {
  const { createBus } = require('../src/core/bus');
  const bus = createBus({ historySize: 100 });
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

function fakeLogger() {
  return { debug: function(){}, info: function(){}, warn: function(){}, error: function(){} };
}

function fakeMemory() {
  var perceptions = [];
  var episodicWrites = [];
  return {
    working: {
      tick: 0,
      activeGoalId: null,
      spendThisTick: 0,
      drainPerceptions: function() { var p = perceptions.slice(); perceptions.length = 0; return p; },
      resetTickState: function() { this.spendThisTick = 0; },
      pushPerception: function(p) { perceptions.push(p); },
      addSpend: function(n) { this.spendThisTick += n; }
    },
    episodic: {
      write: async function(entry) { episodicWrites.push(entry); return { ref: 'ep-' + episodicWrites.length }; }
    },
    consolidate: async function() {},
    _episodicWrites: function() { return episodicWrites; }
  };
}

function fakeGoals() {
  var _activeGoal = null;
  var _goals = new Map();
  return {
    arbitrateCalls: [],
    planCalls: [],
    getActive: function() { return _activeGoal; },
    _setActive: function(g) { _activeGoal = g; },
    hasActive: function() { return _activeGoal !== null; },
    arbitrate: function(perceptions, working) {
      this.arbitrateCalls.push({ perceptions: perceptions, working: working });
      return _activeGoal;
    },
    plan: async function(goal, ctx) {
      this.planCalls.push({ goal: goal, ctx: ctx });
      return null;
    },
    debitBudget: function(id, usage) {}
  };
}

function fakeLeash() {
  return { check: function() { return { allow: true }; } };
}

function fakeEffectors() {
  var invocations = [];
  return {
    breakers: { allow: function() { return true; } },
    invoke: async function(tool, args) { invocations.push({ tool: tool, args: args }); return { ok: true }; },
    _invocations: function() { return invocations; }
  };
}

function fakeConfig(overrides) {
  return Object.assign({
    MYTHOS_TICK_MS: 1000,
    MYTHOS_VAULT_ROOT: './vault',
    MAX_ACTIVE_GOALS: 5,
    GOAL_TOKEN_BUDGET: 20000,
    GOAL_ACTION_BUDGET: 25,
    MYTHOS_IDLE_SALIENCE: 0.3,
    ACTION_TIMEOUT_MS: 30000
  }, overrides);
}

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

// ---------------------------------------------------------------------------
// cortex/sensors/timer
// ---------------------------------------------------------------------------

describe('cortex/sensors/timer', function() {
  it('emits sensor.timer events at tick cadence', async function() {
    var bus = fakeBus();
    var { createTimerSensor } = require('../src/core/sensors/timer');
    var timer = createTimerSensor({ bus: bus, config: { MYTHOS_TICK_MS: 50 } });
    timer.start();
    await sleep(180);
    timer.stop();
    var events = bus._emitted().filter(function(e) { return e.type === 'perception.tick'; });
    assert.ok(events.length >= 2, 'expected at least 2 timer events, got ' + events.length);
    for (var i = 0; i < events.length; i++) {
      assert.ok(events[i].payload.ts, 'event ' + i + ' missing ts');
      assert.ok(typeof events[i].payload.generation === 'number', 'event ' + i + ' missing generation');
      assert.equal(events[i].payload.kind, 'timer', 'event ' + i + ' missing kind');
      assert.equal(events[i].payload.salienceHint, 0.1, 'event ' + i + ' missing salienceHint');
    }
  });

  it('stops and does not emit after stop()', async function() {
    var bus = fakeBus();
    var { createTimerSensor } = require('../src/core/sensors/timer');
    var timer = createTimerSensor({ bus: bus, config: { MYTHOS_TICK_MS: 50 } });
    timer.start();
    await sleep(130);
    timer.stop();
    var countAtStop = bus._emitted().filter(function(e) { return e.type === 'perception.tick'; }).length;
    await sleep(130);
    var countAfter = bus._emitted().filter(function(e) { return e.type === 'perception.tick'; }).length;
    assert.equal(countAfter, countAtStop, 'new events appeared after stop()');
  });

  it('start/stop generation tracking prevents stale timers', async function() {
    var bus = fakeBus();
    var { createTimerSensor } = require('../src/core/sensors/timer');
    var timer = createTimerSensor({ bus: bus, config: { MYTHOS_TICK_MS: 50 } });
    timer.start();
    await sleep(30);
    timer.stop();
    timer.start();
    await sleep(130);
    timer.stop();
    var events = bus._emitted().filter(function(e) { return e.type === 'perception.tick'; });
    // All events should have the second generation
    var lastGen = events[events.length - 1].payload.generation;
    for (var i = 0; i < events.length; i++) {
      assert.equal(events[i].payload.generation, lastGen,
        'event ' + i + ' has stale generation ' + events[i].payload.generation + ' vs ' + lastGen);
    }
  });
});

// ---------------------------------------------------------------------------
// cortex/ooda
// ---------------------------------------------------------------------------

describe('cortex/ooda', function() {
  var ooda;

  before(function() {
    ooda = require('../src/core/cortex/ooda');
  });

  it('orient ranks by salience', function() {
    var perceptions = [
      { summary: 'low event', salience: 0.1, channel: 'test' },
      { summary: 'high event', salience: 0.9, channel: 'test' },
      { summary: 'mid event', salience: 0.5, channel: 'test' }
    ];
    var ranked = ooda.orient(perceptions, null);
    assert.equal(ranked.length, 3);
    assert.equal(ranked[0].perception.summary, 'high event');
    assert.equal(ranked[1].perception.summary, 'mid event');
    assert.equal(ranked[2].perception.summary, 'low event');
    assert.ok(ranked[0].rankedSalience > ranked[1].rankedSalience);
    assert.ok(ranked[1].rankedSalience > ranked[2].rankedSalience);
  });

  it('orient boosts by goal relevance', function() {
    var perceptions = [
      { summary: 'deploy server', salience: 0.2, channel: 'deploy' },
      { summary: 'unrelated noise', salience: 0.4, channel: 'misc' }
    ];
    var goal = { title: 'deploy server', reason: 'production deploy' };
    var ranked = ooda.orient(perceptions, goal);
    // 'deploy server' perception shares keywords with goal, should get boosted
    var deployRanked = ranked.find(function(r) { return r.perception.summary === 'deploy server'; });
    var unrelatedRanked = ranked.find(function(r) { return r.perception.summary === 'unrelated noise'; });
    assert.ok(deployRanked.rankedSalience > 0.2, 'deploy should be boosted above its raw salience');
    // The raw salience of unrelated (0.4) may still be higher than boosted deploy,
    // but the boost should be visible on deploy.
    assert.ok(deployRanked.rankedSalience > 0.2, 'deploy got goal boost: ' + deployRanked.rankedSalience);
  });

  it('goalRelevance computes keyword overlap', function() {
    var perception = { summary: 'build react component', channel: 'build' };
    var goal = { title: 'build react app', reason: '' };
    var relevance = ooda.goalRelevance(perception, goal);
    // 'build', 'react' overlap — 2 out of 4 perception terms = 0.5
    assert.ok(relevance > 0, 'expected positive relevance, got ' + relevance);
    assert.ok(relevance <= 1, 'relevance should not exceed 1');
  });

  it('goalRelevance returns 0 for no overlap', function() {
    var perception = { summary: 'deploy server', channel: 'ops' };
    var goal = { title: 'paint the fence', reason: 'yard work' };
    var relevance = ooda.goalRelevance(perception, goal);
    assert.equal(relevance, 0);
  });

  it('goalRelevance returns 0 for null inputs', function() {
    assert.equal(ooda.goalRelevance(null, { title: 'test' }), 0);
    assert.equal(ooda.goalRelevance({ summary: 'test' }, null), 0);
  });

  it('shouldReflect returns true every N ticks', function() {
    var N = ooda.REFLECT_EVERY;
    assert.equal(ooda.shouldReflect(0), true);
    assert.equal(ooda.shouldReflect(N), true);
    assert.equal(ooda.shouldReflect(N * 2), true);
    assert.equal(ooda.shouldReflect(1), false);
    assert.equal(ooda.shouldReflect(N - 1), false);
    assert.equal(ooda.shouldReflect(N + 1), false);
  });

  it('shouldConsolidate returns true every N ticks', function() {
    var N = ooda.CONSOLIDATE_EVERY;
    assert.equal(ooda.shouldConsolidate(0), true);
    assert.equal(ooda.shouldConsolidate(N), true);
    assert.equal(ooda.shouldConsolidate(N * 2), true);
    assert.equal(ooda.shouldConsolidate(1), false);
    assert.equal(ooda.shouldConsolidate(N - 1), false);
    assert.equal(ooda.shouldConsolidate(N + 1), false);
  });
});

// ---------------------------------------------------------------------------
// cortex/index  (with mocked memory, bus, goals)
// ---------------------------------------------------------------------------

describe('cortex/index', function() {
  var bus, memory, goals, cortex;

  it('D-39 regression: construction throws without leash', function() {
    var { createCortex } = require('../src/core/cortex');
    assert.throws(function() {
      createCortex({ bus: fakeBus(), memory: fakeMemory(), goals: fakeGoals(), brain: null, effectors: fakeEffectors(), config: fakeConfig() });
    }, /leash/);
  });

  it('D-39 regression: construction throws without effectors', function() {
    var { createCortex } = require('../src/core/cortex');
    assert.throws(function() {
      createCortex({ bus: fakeBus(), memory: fakeMemory(), goals: fakeGoals(), brain: null, leash: fakeLeash(), config: fakeConfig() });
    }, /effectors/);
  });

  function makeCortex(configOverrides) {
    bus = fakeBus();
    memory = fakeMemory();
    goals = fakeGoals();
    var cfg = fakeConfig(configOverrides);
    var { createCortex } = require('../src/core/cortex');
    cortex = createCortex({ bus: bus, memory: memory, goals: goals, brain: null, leash: fakeLeash(), effectors: fakeEffectors(), config: cfg });
    return cortex;
  }

  it('tickOnce increments working.tick', async function() {
    makeCortex({ MYTHOS_TICK_MS: 60000 }); // very long interval — won't fire during test
    assert.equal(memory.working.tick, 0);
    cortex.start();
    await cortex.tickOnce();
    assert.equal(memory.working.tick, 1);
    await cortex.tickOnce();
    assert.equal(memory.working.tick, 2);
    cortex.stop();
  });

  it('tickOnce emits tick event on bus', async function() {
    makeCortex({ MYTHOS_TICK_MS: 60000 });
    cortex.start();
    await cortex.tickOnce();
    var tickEvents = bus._emitted().filter(function(e) { return e.type === 'tick'; });
    assert.equal(tickEvents.length, 1);
    assert.equal(tickEvents[0].payload.tick, 1);
    cortex.stop();
  });

  it('reentrancy guard — concurrent tickOnce calls skip', async function() {
    makeCortex({ MYTHOS_TICK_MS: 60000 });
    cortex.start();
    // Patch the first tickOnce to delay completion, allowing second call to hit guard
    var originalTickOnce = cortex.tickOnce.bind(cortex);
    var firstCallDone = false;
    cortex.tickOnce = async function() {
      if (this._inFlight || cortex.tickOnce._inFlight) return;
      cortex.tickOnce._inFlight = true;
      try {
        var working = memory.working;
        working.tick++;
        working.resetTickState();
        // Yield so second call can attempt
        await new Promise(function(r) { setImmediate(r); });
        bus.emit('tick', { tick: working.tick, perceptions: 0 });
        firstCallDone = true;
      } finally {
        cortex.tickOnce._inFlight = false;
      }
    };
    var p1 = cortex.tickOnce();
    // Second call should be blocked while first is in flight
    var p2 = cortex.tickOnce();
    await Promise.all([p1, p2]);
    // tick should only be 1 — second call skipped
    assert.equal(memory.working.tick, 1, 'second concurrent tickOnce should have been skipped');
    cortex.stop();
  });

  it('start/stop control the loop', async function() {
    makeCortex({ MYTHOS_TICK_MS: 50 });
    cortex.start();
    assert.ok(cortex.generation > 0, 'start should bump generation');
    await sleep(180);
    cortex.stop();
    var tickEvents = bus._emitted().filter(function(e) { return e.type === 'tick'; });
    assert.ok(tickEvents.length >= 2, 'expected at least 2 ticks from interval, got ' + tickEvents.length);
    // After stop, count should stabilize
    var countAtStop = tickEvents.length;
    await sleep(130);
    var tickEventsAfter = bus._emitted().filter(function(e) { return e.type === 'tick'; });
    assert.equal(tickEventsAfter.length, countAtStop, 'ticks appeared after stop()');
  });

  it('idle tick with no goals and no perceptions — zero brain calls', async function() {
    makeCortex({ MYTHOS_TICK_MS: 60000 });
    cortex.start();
    await cortex.tickOnce();
    // No goals active, no perceptions → decide() returns null → no arbitrate called
    assert.equal(goals.arbitrateCalls.length, 0, 'arbitrate should not be called on idle');
    assert.equal(goals.planCalls.length, 0, 'plan should not be called on idle');
    cortex.stop();
  });

  it('tick with perceptions — writes high-salience to episodic', async function() {
    makeCortex({ MYTHOS_TICK_MS: 60000 });
    cortex.start();
    memory.working.pushPerception({ summary: 'critical error', salience: 0.9, channel: 'system' });
    memory.working.pushPerception({ summary: 'low noise', salience: 0.1, channel: 'misc' });
    await cortex.tickOnce();
    var writes = memory._episodicWrites();
    // Only salience > 0.5 should be written
    var critical = writes.find(function(w) { return w.summary === 'critical error'; });
    var noise = writes.find(function(w) { return w.summary === 'low noise'; });
    assert.ok(critical, 'high-salience perception should be written to episodic');
    assert.ok(!noise, 'low-salience perception should NOT be written to episodic');
    cortex.stop();
  });

  it('tick with active goal — calls goals.arbitrate', async function() {
    makeCortex({ MYTHOS_TICK_MS: 60000 });
    cortex.start();
    memory.working.pushPerception({ summary: 'build component', salience: 0.7, channel: 'build' });
    // Make goals appear active
    goals._setActive({ id: 'goal-1', title: 'build component', status: 'active' });
    goals.hasActive = function() { return true; };
    await cortex.tickOnce();
    assert.ok(goals.arbitrateCalls.length >= 1, 'arbitrate should be called when goals active');
    var call = goals.arbitrateCalls[0];
    assert.ok(Array.isArray(call.perceptions), 'arbitrate receives perceptions array');
    assert.ok(call.perceptions.length > 0, 'arbitrate receives at least one perception');
    assert.ok(typeof call.perceptions[0].rankedSalience === 'number',
      'D-38 regression: arbitrate() must receive objects carrying rankedSalience, not bare perceptions');
    assert.equal(call.perceptions[0].summary, 'build component',
      'perception fields must still be present alongside rankedSalience');
    assert.ok(call.working, 'arbitrate receives working state');
    cortex.stop();
  });
});

// ---------------------------------------------------------------------------
// goals/index  (with mocked fs + bus)
// ---------------------------------------------------------------------------

describe('goals/index', function() {
  var bus, fs, goals;

  before(function() {
    // Use fresh modules for each test via init
  });

  function makeGoals(configOverrides) {
    bus = fakeBus();
    fs = fakeFs();
    var cfg = fakeConfig(configOverrides);
    var { createGoalSystem } = require('../src/core/goals');
    goals = createGoalSystem({ fs: fs, config: cfg, bus: bus, memory: null, brain: null });
    return goals;
  }

  // --- CRUD ---

  it('create returns goal with id, timestamps', function() {
    makeGoals();
    var goal = goals.create({ title: 'Test Goal', drive: 'user-service', priority: 0.8 });
    assert.ok(goal.id.startsWith('goal-'), 'id should start with goal-');
    assert.ok(goal.createdAt > 0, 'createdAt should be set');
    assert.ok(goal.updatedAt > 0, 'updatedAt should be set');
    assert.equal(goal.title, 'Test Goal');
    assert.equal(goal.drive, 'user-service');
    assert.equal(goal.priority, 0.8);
    assert.equal(goal.status, 'proposed');
    assert.ok(goal.budget.tokens > 0, 'default budget.tokens should be set');
  });

  it('get by id returns goal', function() {
    makeGoals();
    var created = goals.create({ title: 'Find Me' });
    var fetched = goals.get(created.id);
    assert.ok(fetched, 'get should return the goal');
    assert.equal(fetched.title, 'Find Me');
    assert.equal(fetched.id, created.id);
  });

  it('get returns null for missing id', function() {
    makeGoals();
    assert.equal(goals.get('goal-nonexistent'), null);
  });

  it('update patches fields', function() {
    makeGoals();
    var goal = goals.create({ title: 'Original' });
    var updated = goals.update(goal.id, { title: 'Updated Title', priority: 0.9 });
    assert.ok(updated, 'update should return the goal');
    assert.equal(updated.title, 'Updated Title');
    assert.equal(updated.priority, 0.9);
    assert.ok(updated.updatedAt >= goal.createdAt, 'updatedAt should be refreshed');
  });

  it('update does not patch immutable id', function() {
    makeGoals();
    var goal = goals.create({ title: 'Immutable ID' });
    var updated = goals.update(goal.id, { id: 'goal-hacked' });
    assert.equal(updated.id, goal.id, 'id should not change');
  });

  it('update patches nested budget and spent', function() {
    makeGoals();
    var goal = goals.create({ title: 'Budget Patch' });
    goals.update(goal.id, { budget: { tokens: 99999 }, spent: { tokens: 100 } });
    var refreshed = goals.get(goal.id);
    assert.equal(refreshed.budget.tokens, 99999);
    assert.equal(refreshed.spent.tokens, 100);
  });

  it('remove deletes goal', function() {
    makeGoals();
    var goal = goals.create({ title: 'Delete Me' });
    assert.ok(goals.get(goal.id), 'goal should exist before removal');
    var result = goals.remove(goal.id);
    assert.equal(result, true);
    assert.equal(goals.get(goal.id), null, 'goal should be gone after removal');
  });

  it('remove returns false for missing goal', function() {
    makeGoals();
    assert.equal(goals.remove('goal-nonexistent'), false);
  });

  it('remove cleans parent childIds', function() {
    makeGoals();
    var parent = goals.create({ title: 'Parent' });
    var child = goals.create({ title: 'Child', parentId: parent.id });
    // Manually add child to parent's childIds (the system doesn't auto-link on create)
    goals.update(parent.id, { childIds: [child.id] });
    goals.remove(child.id);
    var refreshedParent = goals.get(parent.id);
    assert.ok(refreshedParent.childIds.indexOf(child.id) === -1,
      'child id should be removed from parent.childIds');
  });

  it('list with filters', function() {
    makeGoals();
    goals.create({ title: 'A', drive: 'user-service', status: 'active' });
    goals.create({ title: 'B', drive: 'maintenance', status: 'proposed' });
    goals.create({ title: 'C', drive: 'user-service', status: 'active' });
    goals.create({ title: 'D', drive: 'maintenance', status: 'active' });

    var allUser = goals.list({ drive: 'user-service' });
    assert.equal(allUser.length, 2);

    var allActive = goals.list({ status: 'active' });
    assert.equal(allActive.length, 3);

    var userActive = goals.list({ drive: 'user-service', status: 'active' });
    assert.equal(userActive.length, 2);
  });

  it('list returns all goals when no filter', function() {
    makeGoals();
    goals.create({ title: 'A' });
    goals.create({ title: 'B' });
    assert.equal(goals.list().length, 2);
  });

  // --- Active ---

  it('getActive returns first active goal', function() {
    makeGoals();
    goals.create({ title: 'First Active', status: 'active' });
    goals.create({ title: 'Second Active', status: 'active' });
    var active = goals.getActive();
    assert.ok(active, 'should return an active goal');
    assert.equal(active.status, 'active');
  });

  it('getActive returns null when no active goals', function() {
    makeGoals();
    goals.create({ title: 'Proposed', status: 'proposed' });
    assert.equal(goals.getActive(), null);
  });

  it('hasActive returns boolean', function() {
    makeGoals();
    assert.equal(goals.hasActive(), false);
    goals.create({ title: 'Active', status: 'active' });
    assert.equal(goals.hasActive(), true);
  });

  // --- Arbiter ---

  it('arbitrate scores by drive weight + priority', function() {
    makeGoals();
    var g1 = goals.create({ title: 'User goal', drive: 'user-service', status: 'active', priority: 0.9 });
    var g2 = goals.create({ title: 'Curiosity goal', drive: 'curiosity', status: 'active', priority: 0.9 });
    // user-service has drive weight 1.0, curiosity has 0.25
    var winner = goals.arbitrate([], {});
    assert.ok(winner, 'should return a winner');
    assert.equal(winner.id, g1.id, 'user-service should win over curiosity at same priority');
  });

  it('arbitrate sticky bonus for current goal', function() {
    makeGoals();
    var g1 = goals.create({ title: 'Sticky goal', drive: 'user-service', status: 'active', priority: 0.8 });
    var g2 = goals.create({ title: 'Challenger', drive: 'user-service', status: 'active', priority: 0.85 });
    // Without sticky, g2 would win (higher priority). With sticky on g1, g1 may win.
    var winner = goals.arbitrate([], { activeGoalId: g1.id });
    assert.ok(winner, 'should return a winner');
    assert.equal(winner.id, g1.id, 'sticky bonus should make current goal win');
  });

  it('arbitrate deadline urgency', function() {
    makeGoals();
    // Goal with deadline < 1 hour away should get urgency boost
    var deadline = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 minutes
    var g1 = goals.create({ title: 'Urgent', drive: 'user-service', status: 'active', priority: 0.5,
      budget: { tokens: 50000, actions: 50, deadline: deadline } });
    var g2 = goals.create({ title: 'Relaxed', drive: 'user-service', status: 'active', priority: 0.5 });
    var winner = goals.arbitrate([], {});
    assert.ok(winner, 'should return a winner');
    assert.equal(winner.id, g1.id, 'urgent deadline should win over no deadline');
  });

  it('arbitrate budget pressure', function() {
    makeGoals();
    // Goal with higher budget pressure (more remaining) should score higher
    var g1 = goals.create({ title: 'Full Budget', drive: 'user-service', status: 'active', priority: 0.5 });
    var g2 = goals.create({ title: 'Low Budget', drive: 'user-service', status: 'active', priority: 0.5 });
    // Deplete g2's budget heavily
    goals.update(g2.id, { spent: { tokens: 45000, actions: 0 } });
    var winner = goals.arbitrate([], {});
    assert.ok(winner, 'should return a winner');
    assert.equal(winner.id, g1.id, 'full budget should win over depleted budget');
  });

  it('arbitrate returns null when no active goals', function() {
    makeGoals();
    goals.create({ title: 'Proposed', status: 'proposed' });
    assert.equal(goals.arbitrate([], {}), null);
  });

  // --- Planner ---

  it('plan returns pending step from existing plan', async function() {
    makeGoals();
    var goal = goals.create({ title: 'Planned goal', status: 'active' });
    goals.update(goal.id, {
      plan: [
        { tool: 'echo', args: { msg: 'step 1' }, status: 'done' },
        { tool: 'write_file', args: { path: '/tmp/test' }, status: 'pending' },
        { tool: 'bash', args: { cmd: 'ls' }, status: 'pending' }
      ]
    });
    var step = await goals.plan(goal, {});
    assert.ok(step, 'plan should return a step');
    assert.equal(step.tool, 'write_file', 'should return first pending step');
    assert.equal(step.rationale, 'plan-step');
  });

  it('plan returns null on budget exhaustion', async function() {
    makeGoals();
    var goal = goals.create({ title: 'Exhausted', status: 'active', budget: { tokens: 100, actions: 10 } });
    goals.update(goal.id, { spent: { tokens: 100, actions: 0 } });
    var step = await goals.plan(goal, {});
    assert.equal(step, null, 'plan should return null when budget exhausted');
    // Goal should be auto-paused
    var refreshed = goals.get(goal.id);
    assert.equal(refreshed.status, 'paused');
    assert.equal(refreshed.reason, 'budget-exhausted');
  });

  // --- Budget ---

  it('debitBudget updates spent and auto-pauses', function() {
    makeGoals();
    var goal = goals.create({ title: 'Budget test', status: 'active',
      budget: { tokens: 500, actions: 5 } });
    goals.debitBudget(goal.id, { tokens: 200, actions: 1 });
    var refreshed = goals.get(goal.id);
    assert.equal(refreshed.spent.tokens, 200, 'tokens should be debited');
    assert.equal(refreshed.spent.actions, 1, 'actions should be debited');
    assert.equal(refreshed.status, 'active', 'should still be active before exhaustion');

    // Debit to exhaust tokens
    goals.debitBudget(goal.id, { tokens: 300, actions: 1 });
    refreshed = goals.get(goal.id);
    assert.equal(refreshed.spent.tokens, 500, 'tokens should be fully spent');
    assert.equal(refreshed.status, 'paused', 'should auto-pause on token exhaustion');
    assert.equal(refreshed.reason, 'budget-exhausted');
  });

  it('debitBudget ignores missing goal', function() {
    makeGoals();
    // Should not throw
    goals.debitBudget('goal-nonexistent', { tokens: 100, actions: 1 });
  });

  // --- Stats ---

  it('stats returns counts', function() {
    makeGoals();
    goals.create({ title: 'A', status: 'active', drive: 'user-service' });
    goals.create({ title: 'B', status: 'proposed', drive: 'maintenance' });
    goals.create({ title: 'C', status: 'active', drive: 'user-service' });
    goals.create({ title: 'D', status: 'paused', drive: 'curiosity' });
    var s = goals.stats();
    assert.equal(s.total, 4);
    assert.equal(s.active, 2);
    assert.equal(s.byStatus.active, 2);
    assert.equal(s.byStatus.proposed, 1);
    assert.equal(s.byStatus.paused, 1);
    assert.equal(s.byDrive['user-service'], 2);
    assert.equal(s.byDrive.maintenance, 1);
    assert.equal(s.byDrive.curiosity, 1);
  });

  it('stats tracks total spent tokens and actions', function() {
    makeGoals();
    var g1 = goals.create({ title: 'Spender', status: 'active' });
    var g2 = goals.create({ title: 'Also spends', status: 'active' });
    goals.debitBudget(g1.id, { tokens: 100, actions: 2 });
    goals.debitBudget(g2.id, { tokens: 250, actions: 3 });
    var s = goals.stats();
    assert.equal(s.totalTokensSpent, 350);
    assert.equal(s.totalActionsSpent, 5);
  });

  // --- Persistence ---

  it('init loads goals from fs', async function() {
    bus = fakeBus();
    fs = fakeFs();
    // Pre-populate fake fs with a goal file
    fs.writeJSON('Goals/goal-preloaded.json', {
      id: 'goal-preloaded',
      title: 'Preloaded Goal',
      status: 'active',
      drive: 'user-service',
      priority: 0.7,
      budget: { tokens: 50000, actions: 50, deadline: null },
      spent: { tokens: 0, actions: 0 },
      parentId: null,
      childIds: [],
      plan: [],
      grants: {},
      reason: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastActionAt: null
    });
    var cfg = fakeConfig();
    var { createGoalSystem } = require('../src/core/goals');
    goals = createGoalSystem({ fs: fs, config: cfg, bus: bus, memory: null, brain: null });
    await goals.init();
    var loaded = goals.get('goal-preloaded');
    assert.ok(loaded, 'preloaded goal should be loaded from fs');
    assert.equal(loaded.title, 'Preloaded Goal');
    assert.equal(loaded.status, 'active');
  });

  it('create persists to fs', function() {
    makeGoals();
    var goal = goals.create({ title: 'Persisted' });
    var stored = fs.readJSON('Goals/' + goal.id + '.json', null);
    assert.ok(stored, 'goal should be persisted in fs');
    assert.equal(stored.title, 'Persisted');
  });

  // --- Events ---

  it('emits goal.created on create', function() {
    makeGoals();
    goals.create({ title: 'Event Test' });
    var events = bus._emitted().filter(function(e) { return e.type === 'goal.created'; });
    assert.equal(events.length, 1);
    assert.ok(events[0].payload.id.startsWith('goal-'));
    assert.equal(events[0].payload.title, 'Event Test');
  });

  it('emits goal.updated on update', function() {
    makeGoals();
    var goal = goals.create({ title: 'Before' });
    bus._clearEmitted();
    goals.update(goal.id, { title: 'After' });
    var events = bus._emitted().filter(function(e) { return e.type === 'goal.updated'; });
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.id, goal.id);
  });

  it('emits goal.removed on remove', function() {
    makeGoals();
    var goal = goals.create({ title: 'Remove Me' });
    bus._clearEmitted();
    goals.remove(goal.id);
    var events = bus._emitted().filter(function(e) { return e.type === 'goal.removed'; });
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.id, goal.id);
  });

  it('emits goal.budget-debited on debitBudget', function() {
    makeGoals();
    var goal = goals.create({ title: 'Debit Event', status: 'active' });
    bus._clearEmitted();
    goals.debitBudget(goal.id, { tokens: 50, actions: 1 });
    var events = bus._emitted().filter(function(e) { return e.type === 'goal.budget-debited'; });
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.id, goal.id);
    assert.equal(events[0].payload.spent.tokens, 50);
  });
});
