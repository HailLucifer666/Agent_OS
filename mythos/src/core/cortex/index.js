// cortex/index.js — OODA cognitive loop.
// Orchestrates observe→orient→decide→act→reflect at configurable tick cadence.
// Reentrancy guard + generation token prevent overrun. Timer unref'd.

const ooda = require('./ooda');
const { dispatchAction } = require('../effectors/dispatch-action');

// Confirm-popup text — plain "key: value" pairs instead of a raw JSON dump
// (which rendered braces/quotes verbatim to the user). Same fix as voice-agent.js.
function humanizeArgs(args) {
  const entries = Object.entries(args || {});
  if (!entries.length) return '';
  return entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
}

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
  // [Phase 9] ACTION_TIMEOUT_MS is now a real schema key (config/schema.js,
  // default 30000) — read it, don't re-default it (Lesson #6). The schema
  // guarantees the key on every loadConfig()'d config; test fakes mirror it.
  const ACTION_TIMEOUT_MS = config.ACTION_TIMEOUT_MS;

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

      // V1 (Phase 4): memory consultation on the autonomous path. When ANY
      // high-salience perception arrives, hydrate the per-tick recall cache
      // ONCE — the cache lives in working memory, cleared at the top of the
      // next tick (zero leak). decide()/plan() can consult it without
      // re-running recallHybrid (which fires an embeddings call).
      //
      // Gating: top-ranked perception above ORIENT_RECALL_MIN_SALIENCE only.
      // Below that the cortex shouldn't act anyway, so a recall would be wasted
      // cost (idle-skip). Cost: 1 embeddings call per NON-IDLE tick, exactly
      // matching the spec's idle-skip principle (zero cost when idle). Offline
      // brain → recallHybrid degrades to keyword-only, still useful.
      var orientMinSalience = (config && typeof config.ORIENT_RECALL_MIN_SALIENCE === 'number')
        ? config.ORIENT_RECALL_MIN_SALIENCE : 0.5;
      var orientLimit = (config && typeof config.ORIENT_RECALL_LIMIT === 'number')
        ? config.ORIENT_RECALL_LIMIT : 5;
      if (ranked.length > 0 && ranked[0].rankedSalience > orientMinSalience &&
          memory && typeof memory.recallHybrid === 'function') {
        try {
          var topQuery = ranked[0].perception.summary ||
                         (ranked[0].perception.channel || '') + ' perception';
          var hits = await memory.recallHybrid(topQuery, { limit: orientLimit });
          if (hits && hits.length > 0) {
            working.setRecallCache(hits);
            bus.emit('cortex.recall', {
              tick: working.tick,
              query: topQuery.slice(0, 80),
              hits: hits.length
            });
          }
        } catch (_) { /* recall is best-effort — orient proceeds regardless */ }
      }

      // -- IDLE CHECK (cost lever #1: zero Brain calls on MOST idle ticks) --
      // Idle ticks still skip the brain entirely EXCEPT for the throttled "mull"
      // below — a periodic background reasoning pass that lets the entity form
      // thoughts about the operator's situation during quiet moments. The mull
      // cadence is config-driven (MYTHOS_MULL_EVERY_TICKS, default 300 = ~5min);
      // setting it to 0 reverts to pure zero-cost idle.
      var hasActive = goals && typeof goals.hasActive === 'function' && goals.hasActive();
      if (perceptions.length === 0 && !hasActive) {
        working.activeGoalId = null;
        var mullFired = false;
        if (shouldMull(working.tick, config)) {
          await mull(working, memory, brain, bus, config);
          mullFired = true;
        }
      if (ooda.shouldReflect(working.tick, config)) {
        reflect(working, memory, bus);
      }
      // Consolidation must run on a time cadence regardless of whether goals
      // are active — conversation turns are written to episodic memory by the
      // server (not routed here as perceptions), so a purely conversational
      // session would otherwise NEVER consolidate. Without this, user-facts
      // distillation never fires and long-term memory stalls. Mirrors the
      // shouldReflect call above (already duplicated in the idle branch).
      //
      // STAGGER: skip consolidate when mull already fired this tick — mull
      // (tick%300) and consolidate (tick%60) co-fire on tick 300/600/900,
      // causing up to 3 brain calls on one tick. Skipping consolidate when
      // mull fired keeps idle ticks to at most 1 brain call. Consolidate
      // fires on the next 60-boundary that isn't also a 300-boundary.
      if (!mullFired && ooda.shouldConsolidate(working.tick, config)) {
        await memory.consolidate({});
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

      // RC#3: feed the planner's brain-call spend into the working-memory ledger
      // so episodic records and goal budgets reflect real token usage. Previously
      // addSpend() was dead code — every action showed tokensSpent:0.
      if (decision._spentTokens && typeof working.addSpend === 'function') {
        working.addSpend(decision._spentTokens);
      }

      // -- ACT --
      await act(decision, { bus, memory, goals, brain, leash, effectors, config, working, ACTION_TIMEOUT_MS });

      // -- REFLECT --
      if (ooda.shouldReflect(working.tick, config)) {
        reflect(working, memory, bus);
      }
      if (ooda.shouldConsolidate(working.tick, config)) {
        await memory.consolidate({});
      }
      // D4: Reset consecutive error counter on successful tick.
      tickOnce._consecutiveErrors = 0;
    } catch (err) {
      // D4: Track consecutive tick errors. After 10 consecutive failures, escalate
      // to a diagnosed event so the healer can trigger a cortex restart.
      tickOnce._consecutiveErrors = (tickOnce._consecutiveErrors || 0) + 1;
      bus.emit('health.anomaly', { kind: 'tick-error', error: err.message, tick: memory ? memory.working.tick : 0, consecutive: tickOnce._consecutiveErrors });
      if (tickOnce._consecutiveErrors >= 10) {
        bus.emit('health.diagnosed', { kind: 'cortex-stall', target: 'tick-loop', consecutive: tickOnce._consecutiveErrors });
      }
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
      // V1 (Phase 4): pass the per-tick recall cache into the plan ctx so the
      // planner's brain prompt can ground its decision in relevant memory
      // (cheap — already hydrated by orient once this tick, no second call).
      var recallCache = null;
      if (working && typeof working.getRecallCache === 'function') {
        recallCache = working.getRecallCache();
      }
      var plan = await goals.plan(best, {
        memory: memory, brain: brain, effectors: effectors,
        recallCache: recallCache
      });
      if (!plan) return null;
      return plan;
    }
    return null;
  }

  async function act(decision, ctx) {
    var bus = ctx.bus, leash = ctx.leash, effectors = ctx.effectors;
    var working = ctx.working, goals = ctx.goals, memory = ctx.memory;
    var config = ctx.config, ACTION_TIMEOUT_MS = ctx.ACTION_TIMEOUT_MS;

    // RC#2: pre-flight effector existence check. If the planner returned a tool
    // that isn't registered, fail fast — emit action.completed with ok:false and
    // return BEFORE the leash confirm gate. Without this, a hallucinated tool
    // name blocks on a confirm popup (tier-3) that can never succeed, stalling
    // the cortex tick for 5s+ and triggering the watchdog's stall-restart loop.
    if (effectors && typeof effectors.count === 'function' && decision && decision.tool) {
      var regMap = effectors.effectors;
      if (regMap && typeof regMap.has === 'function' && !regMap.has(decision.tool)) {
        bus.emit('action.completed', { tool: decision.tool, ok: false, goalId: working.activeGoalId, reason: 'unknown-effector' });
        return;
      }
    }

    // 1. Leash check — mandatory, fail-closed (createCortex requires leash to construct)
    var leashResult = leash.check(decision, { goalId: working.activeGoalId });
    if (!leashResult.allow && leashResult.requireConfirm) {
      // [Phase 9 — spec Ambiguity #2 contract] Register the paused action with
      // leash.confirm BEFORE emitting, and embed the returned confirmId in the
      // event payload — the server resolves confirm-reply via
      // leash.confirm.accept(confirmId, connectionId), never an ad-hoc map.
      // connectionId is the sentinel 'system': cortex-initiated actions have no
      // single waiting client, so the server accepts 'system'-scoped confirms
      // from any connected client (open question resolved in ROADMAP.md P9).
      var argsText = humanizeArgs(decision.args).slice(0, 120);
      var summary = decision.tool + (argsText ? ' (' + argsText + ')' : '');
      var confirmId = leash.confirm.create(
        summary,
        { decision: decision, goalId: working.activeGoalId, tier: leashResult.tier },
        'system'
      );
      bus.emit('confirm-request', Object.assign({}, decision, {
        confirmId: confirmId, summary: summary, tier: leashResult.tier
      }));
      return;
    }
    if (!leashResult.allow) {
      bus.emit('action.denied', Object.assign({}, decision, { reason: leashResult.reason }));
      return;
    }

    // 2-7. Dispatch via the shared dispatchAction() — single execution surface
    // shared with the server's voice/confirm-accept path (Anti-Drift invariant #1).
    // Replaces the inline copy that had drifted: this call now also writes the
    // audit line (memory.audit.write) and emits the ui.navigate/close-panel/
    // open-web relays that the inline copy was missing (W1). The leash check +
    // confirm-request gate above are cortex-specific and stay here; everything
    // from the breaker check onward is delegated. spentTokens flows the cortex's
    // per-tick spend ledger through to episodic + budget accounting.
    await dispatchAction(decision, {
      effectors: effectors,
      bus: bus,
      goals: goals,
      memory: memory,
      config: config,
      goalId: working.activeGoalId,
      tier: leashResult.tier || 0,
      channel: 'cortex',
      spentTokens: working.spendThisTick,
      signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
    });
  }

  function reflect(working, memory, bus) {
    // Lightweight self-check — emit heartbeat with tick count
    if (bus) bus.emit('reflect', { tick: working.tick, activeGoalId: working.activeGoalId });
  }

  // Background reasoning during idle ticks — the entity "mulls". Gathers recent
  // context (conversations, events), asks the brain whether anything is worth
  // mentioning to the operator next time they speak. Thoughts are stored in
  // episodic memory (kind: 'thought') and surface in the next conversation via
  // the server's recall-before-respond path. Best-effort: never throws, never
  // blocks the tick loop. Disabled when MYTHOS_MULL_EVERY_TICKS is 0.
  function shouldMull(tick, cfg) {
    var every = (cfg && cfg.MYTHOS_MULL_EVERY_TICKS) || 300;
    if (every === 0) return false;
    return tick % every === 0;
  }

  async function mull(working, memory, brain, bus, cfg) {
    if (!brain || typeof brain.think !== 'function') return;
    try {
      var recentConvos = memory.episodic.recall('', { kind: 'conversation', limit: 5, windowDays: 1 });
      var recentEvents = memory.episodic.recall('', { limit: 10, windowDays: 1 });

      var convoSummaries = recentConvos.map(function(r) { return r.record.summary || ''; }).join('\n');
      var eventSummaries = recentEvents.map(function(r) { return r.record.summary || ''; }).join('\n');

      // Skip if there's nothing to think about — pure zero-cost idle
      if (!convoSummaries.trim() && !eventSummaries.trim()) return;

      var result = await brain.think({
        lane: 'simple',
        messages: [{ role: 'user', content:
          'You are MYTHOS, reflecting during a quiet moment. Here is your recent context:\n\n' +
          'Recent conversations:\n' + (convoSummaries || '(none)') + '\n\n' +
          'Recent events:\n' + (eventSummaries || '(none)') + '\n\n' +
          'Is there anything worth mentioning to the operator next time they speak? ' +
          'Consider: loose ends, follow-ups they might forget, observations about their ' +
          'work patterns, things that seem important. If yes, respond with JSON: ' +
          '{"thoughts": "what to mention", "priority": "low|medium|high"}\n' +
          'If nothing is worth mentioning, respond: {"thoughts": "", "priority": "low"}\n\n' +
          // V8 (Phase 4): also surface goal PROPOSALS — things the operator might
          // want to do that MYTHOS noticed but shouldn't auto-pursue. The cortex
          // cannot mint active goals (AUTONOMOUS_EXCLUDED), but it CAN propose
          // them via the propose_goal effector for one-tap operator acceptance.
          'ALSO consider: are there 0-2 GOALS the operator might want to add? ' +
          'These should be durable aims you noticed from their work patterns, not ' +
          'one-off tasks. Each will be proposed (NOT auto-activated) — the operator ' +
          'sees them in the dashboard and accepts/rejects.\n' +
          'Respond as: {"thoughts": "...", "priority": "...", ' +
          '"proposals": [{"text": "goal text", "category": "Work|Personal|Learning|Health|General", ' +
          '"reason": "why this is worth pursuing"}, ...]}\n' +
          'Empty proposals array if nothing fits.'
        }],
        schemaHint: '{ thoughts: string, priority: string, proposals: Array<{text:string,category:string,reason:string}> }',
        source: 'idle-mull'
      });

      // RC#3: account for the mull's token spend too
      if (result && result.spentTokens && typeof working.addSpend === 'function') {
        working.addSpend(result.spentTokens);
      }

      if (result && !result.offline && result.parsed && result.parsed.thoughts &&
          result.parsed.priority && result.parsed.priority !== 'low') {
        var thoughtText = String(result.parsed.thoughts).trim();
        if (thoughtText) {
          // B3: Await the write to prevent unhandled promise rejection on disk failure.
          await memory.episodic.write({
            kind: 'thought',
            tick: working.tick,
            summary: thoughtText.slice(0, 200),
            detail: { text: thoughtText, priority: result.parsed.priority },
            salience: 0.4,
            channel: 'cognition'
          });
          bus.emit('cortex.thought', { text: thoughtText, priority: result.parsed.priority });
        }
      }

      // V8 (Phase 4): route brain-returned proposals through propose_goal.
      // Each becomes a status:'proposed' goal (inert — arbiter ignores) that
      // the operator accepts/rejects via the dashboard. Caps at 2 per mull pass
      // (safety bound — don't spam the proposal queue). T1 leash tier handles
      // the audit automatically. Effectors are optional in tests; skip silently
      // when absent.
      if (result && !result.offline && result.parsed && Array.isArray(result.parsed.proposals)) {
        var proposals = result.parsed.proposals.slice(0, 2);
        for (var pi = 0; pi < proposals.length; pi++) {
          var pr = proposals[pi];
          if (!pr || !pr.text || !String(pr.text).trim()) continue;
          try {
            if (effectors && typeof effectors.invoke === 'function') {
              await effectors.invoke('propose_goal', {
                text: String(pr.text).trim().slice(0, 200),
                category: pr.category || 'General',
                reason: pr.reason ? String(pr.reason).slice(0, 200) : 'mull-proposed',
                drive: 'curiosity'
              }, { bus: bus, goalId: null });
              bus.emit('cortex.proposed', { text: String(pr.text).slice(0, 80) });
            }
          } catch (_) { /* proposal is best-effort — never blocks the tick */ }
        }
      }
      // D2: Reset consecutive failure counter on success.
      mull._consecutiveFailures = 0;
    } catch (err) {
      // D2: Track consecutive mull failures and emit anomaly after repeated failures.
      mull._consecutiveFailures = (mull._consecutiveFailures || 0) + 1;
      if (mull._consecutiveFailures >= 3) {
        bus.emit('health.anomaly', { kind: 'mull-repeated-failure', error: err.message, count: mull._consecutiveFailures });
      }
    }
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
    // FIX C: a restart during a slow-but-live tick (tickOnce._inFlight still true,
    // its finally() hasn't run yet) previously left the reentrancy guard stuck —
    // every tick on the freshly-started cortex would see _inFlight===true and
    // silently no-op forever, even though healer already announced "Self-healed".
    tickOnce._inFlight = false;
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
