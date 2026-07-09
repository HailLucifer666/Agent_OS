// cortex/index.js — OODA cognitive loop.
// Orchestrates observe→orient→decide→act→reflect at configurable tick cadence.
// Reentrancy guard + generation token prevent overrun. Timer unref'd.

const ooda = require('./ooda');

function createCortex({ bus, memory, goals, brain, leash, effectors, config }) {
  if (!leash || typeof leash.check !== 'function') {
    throw new Error('createCortex requires a leash with a check() method — fail-closed gating cannot be skipped');
  }
  if (!effectors || typeof effectors.invoke !== 'function') {
    throw new Error('createCortex requires effectors with an invoke() method — fail-closed gating cannot be skipped');
  }

  let timer = null;
  let running = false;
  let generation = 0;
  const lastTickAt = { value: 0 };

  const MAX_DRAIN_PER_TICK = (config && config.MAX_DRAIN_PER_TICK) || 50;
  const ACTION_TIMEOUT_MS = (config && config.ACTION_TIMEOUT_MS) || 30000;

  async function tickOnce() {
    if (!running) return;

    // Reentrancy guard
    if (tickOnce._inFlight) return;
    tickOnce._inFlight = true;

    try {
      var working = memory.working;
      working.tick++;
      working.resetTickState();
      var tickStart = Date.now();
      lastTickAt.value = tickStart;

      // -- OBSERVE --
      var perceptions = working.drainPerceptions();
      if (perceptions.length > MAX_DRAIN_PER_TICK) {
        perceptions.length = MAX_DRAIN_PER_TICK;
        bus.emit('perception.coalesced', { original: perceptions.length });
      }
      bus.emit('tick', { tick: working.tick, perceptions: perceptions.length });

      // -- ORIENT --
      var activeGoal = goals && typeof goals.getActive === 'function' ? goals.getActive() : null;
      var ranked = ooda.orient(perceptions, activeGoal);
      for (var i = 0; i < ranked.length; i++) {
        if (ranked[i].rankedSalience > 0.5) {
          await memory.episodic.write({
            kind: 'perception', tick: working.tick,
            summary: ranked[i].perception.summary || '',
            detail: ranked[i].perception,
            salience: ranked[i].rankedSalience,
            channel: ranked[i].perception.channel || 'sensor'
          });
        }
      }

      // -- IDLE CHECK (cost lever #1: zero Brain calls on idle) --
      var hasActive = goals && typeof goals.hasActive === 'function' && goals.hasActive();
      if (perceptions.length === 0 && !hasActive) {
        working.activeGoalId = null;
        if (ooda.shouldReflect(working.tick)) {
          reflect(working, memory, bus);
        }
        return;
      }

      // -- DECIDE --
      // BUG FIX (Phase 7, found via the spec-mandated real-instance integration test —
      // see test/integration-cortex-effectors.test.js, lesson #4/D-38-class seam bug):
      // decide() is `async` (it awaits goals.plan() internally) but was called here
      // without `await`, so `decision` was always the pending Promise object itself —
      // truthy, so the `if (!decision) return;` guard never tripped, but `decision.tool`/
      // `decision.args` were undefined by the time act() read them, so every real
      // decision silently dispatched as `effectors.invoke(undefined, undefined, ...)` ->
      // 'unknown-effector'. This is why Phase 7 effectors would never actually have
      // fired even though the hub itself was wired correctly.
      var decision = await decide(ranked, goals, working, brain, memory, config);
      if (!decision) return;

      // -- ACT --
      await act(decision, { bus, memory, goals, brain, leash, effectors, config, working, ACTION_TIMEOUT_MS });

      // -- REFLECT --
      if (ooda.shouldReflect(working.tick)) {
        reflect(working, memory, bus);
      }
      if (ooda.shouldConsolidate(working.tick)) {
        await memory.consolidate({});
      }
    } catch (err) {
      bus.emit('health.anomaly', { kind: 'tick-error', error: err.message, tick: memory ? memory.working.tick : 0 });
    } finally {
      tickOnce._inFlight = false;
    }
  }

  async function decide(ranked, goals, working, brain, memory, config) {
    if (!goals || typeof goals.arbitrate !== 'function') return null;

    // Arbiter: pick best goal — pass the full ranked structure (perception fields +
    // rankedSalience) so the arbiter's salience-boost term isn't silently zeroed
    var best = goals.arbitrate(ranked.map(function(r) {
      return Object.assign({}, r.perception, { rankedSalience: r.rankedSalience });
    }), working);
    if (!best) return null;

    working.activeGoalId = best.id;

    // Planner: procedural recall first, then brain
    if (typeof goals.plan === 'function') {
      var plan = await goals.plan(best, { memory: memory, brain: brain });
      if (!plan) return null;
      return plan;
    }
    return null;
  }

  async function act(decision, ctx) {
    var bus = ctx.bus, leash = ctx.leash, effectors = ctx.effectors;
    var working = ctx.working, goals = ctx.goals, memory = ctx.memory;
    var config = ctx.config, ACTION_TIMEOUT_MS = ctx.ACTION_TIMEOUT_MS;

    // 1. Leash check — mandatory, fail-closed (createCortex requires leash to construct)
    var leashResult = leash.check(decision, { goalId: working.activeGoalId });
    if (!leashResult.allow && leashResult.requireConfirm) {
      bus.emit('confirm-request', decision);
      return;
    }
    if (!leashResult.allow) {
      bus.emit('action.denied', Object.assign({}, decision, { reason: leashResult.reason }));
      return;
    }

    // 2. Breaker check
    if (effectors.breakers && typeof effectors.breakers.allow === 'function') {
      if (!effectors.breakers.allow(decision.tool)) {
        bus.emit('action.blocked', Object.assign({}, decision, { reason: 'circuit-open' }));
        return;
      }
    }

    // 3. Dispatch — mandatory, fail-closed (createCortex requires effectors to construct)
    var signal = AbortSignal.timeout(ACTION_TIMEOUT_MS);
    var result = await effectors.invoke(decision.tool, decision.args, { signal: signal, bus: bus, goalId: working.activeGoalId });

    // 4. Record outcome
    await memory.episodic.write({
      kind: 'action', channel: 'cortex',
      summary: decision.tool + '(' + JSON.stringify(decision.args || {}).slice(0, 80) + ')',
      detail: result,
      outcome: result && result.ok ? 'ok' : 'fail',
      tokensSpent: working.spendThisTick
    });

    // 5. Debit goal budget
    if (working.activeGoalId && goals && typeof goals.debitBudget === 'function') {
      goals.debitBudget(working.activeGoalId, { tokens: working.spendThisTick, actions: 1 });
    }

    bus.emit('action.completed', { tool: decision.tool, ok: result && result.ok, goalId: working.activeGoalId });
  }

  function reflect(working, memory, bus) {
    // Lightweight self-check — emit heartbeat with tick count
    if (bus) bus.emit('reflect', { tick: working.tick, activeGoalId: working.activeGoalId });
  }

  function start() {
    generation++;
    var myGen = generation;
    running = true;
    var tickMs = (config && config.MYTHOS_TICK_MS) || 1000;
    timer = setInterval(function() {
      if (generation !== myGen) return;
      tickOnce();
    }, tickMs);
    if (timer.unref) timer.unref();
    if (bus) bus.emit('lifecycle.started', { component: 'cortex', generation: myGen });
  }

  function stop() {
    running = false;
    generation++;
    if (timer) { clearInterval(timer); timer = null; }
    if (bus) bus.emit('lifecycle.stopped', { component: 'cortex' });
  }

  return {
    start: start,
    stop: stop,
    tickOnce: tickOnce,
    get lastTickAt() { return lastTickAt; },
    get generation() { return generation; }
  };
}

module.exports = { createCortex };
