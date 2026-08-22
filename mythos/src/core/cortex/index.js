// cortex/index.js — OODA cognitive loop.
// Orchestrates observe→orient→decide→act→reflect at configurable tick cadence.
// Reentrancy guard + generation token prevent overrun. Timer unref'd.

const ooda = require('./ooda');
const { dispatchAction } = require('../effectors/dispatch-action');
const { createDiffGate } = require('./diff-gate');

// Confirm-popup text — plain "key: value" pairs instead of a raw JSON dump
// (which rendered braces/quotes verbatim to the user). Same fix as voice-agent.js.
function humanizeArgs(args) {
  const entries = Object.entries(args || {});
  if (!entries.length) return '';
  return entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
}

// BUG-282 (2026-08-20): a stable identity for "this exact action", used to stop
// the cortex re-asking for a confirmation it is already waiting on.
//
// Pure and exported so the keying rule can be tested without building a cortex.
// Keys are SORTED: two arg objects with the same content in a different
// insertion order are the same action, and a raw JSON.stringify of the object
// would call them two.
//
// Every value goes through JSON.stringify, including strings. The first version
// passed strings through unquoted, which made the string "12" and the number 12
// produce an identical key — two different actions collapsing into one, i.e. a
// real confirmation silently dropped. A direct test for that pair now exists.
//
// Deliberately keyed on the FULL arg set, not the tool alone. browser_click
// {ref:"e12"} and browser_click{ref:"e13"} are different actions and each needs
// its own confirmation.
function confirmSuppressionKey(decision) {
  const tool = (decision && decision.tool) || '';
  const args = (decision && decision.args) || {};
  const canon = Object.keys(args).sort().map(function (k) {
    return k + '=' + JSON.stringify(args[k]);
  }).join('&');
  return tool + '|' + canon;
}

// F4: iterative two-row Levenshtein — no recursion, no per-character
// allocation. Mirrors effectors/hub.js's own editDistance(), but duplicated
// here (rather than imported) because this check runs BEFORE the hub's
// invoke() call and must not depend on the hub's internals.
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  var prev = new Array(b.length + 1);
  var cur = new Array(b.length + 1);
  for (var j = 0; j <= b.length; j++) prev[j] = j;
  for (var i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (var k = 1; k <= b.length; k++) {
      var cost = a.charCodeAt(i - 1) === b.charCodeAt(k - 1) ? 0 : 1;
      cur[k] = Math.min(cur[k - 1] + 1, prev[k] + 1, prev[k - 1] + cost);
    }
    for (var m = 0; m <= b.length; m++) prev[m] = cur[m];
  }
  return prev[b.length];
}

// F4: the model invoked google_news_fetch (never a real tool) and the
// RC#2 pre-flight check below said only "unknown-effector" — nothing
// naming google_search_fetch or google_calendar_fetch as real neighbours.
// Bounded edit distance over the registered names, closest first; a
// confidently wrong suggestion is worse than none, so anything past a
// third of the candidate's length is dropped rather than offered.
function nearestEffectorNames(name, registeredNames, limit) {
  var wanted = String(name || '').toLowerCase();
  if (!wanted) return [];
  var scored = [];
  for (var i = 0; i < registeredNames.length; i++) {
    var candidate = registeredNames[i];
    var lower = candidate.toLowerCase();
    var d = editDistance(wanted, lower);
    var threshold = Math.max(2, Math.floor(lower.length / 3));
    if (d <= threshold) scored.push({ name: candidate, score: d });
  }
  scored.sort(function(x, y) { return x.score - y.score || x.name.length - y.name.length; });
  return scored.slice(0, limit || 3).map(function(s) { return s.name; });
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
  // BUG-282: confirmSuppressionKey(decision) -> { confirmId, suppressedCount }.
  // Per-cortex-instance, so two cortexes (or two tests) never share it.
  // There is no expiry timer here on purpose: leash.confirm owns the TTL, and
  // peek() returning null (consumed) or expired:true is the single source of
  // truth for whether this key is still blocked. A second timer would be a
  // second thing that can disagree with the first.
  const pendingConfirmsByKey = new Map();
  const lastTickAt = { value: 0 };
  // BUG-273: WHETHER A TICK IS ACTUALLY RUNNING, which lastTickAt cannot say.
  // lastTickAt is stamped once at the top of the body and the reentrancy guard
  // stops a second tick starting, so during any awaited call inside the tick
  // "time since the last tick began" grows without bound and looks exactly like
  // a dead loop. It is how mull()'s reasoning-lane call — one await, every 300
  // ticks — got the cortex restarted every five minutes on the operator's
  // machine, pausing the active goal each time. 0 means idle.
  const inFlightSince = { value: 0 };
  // mull() below speaks only when its thought actually changed — see diff-gate.js.
  const diffGate = createDiffGate();

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
    inFlightSince.value = Date.now();

    // REMEDIATION P1-5: capture the generation this specific invocation
    // belongs to. stop()+start() (a healer 'restart-cortex' heal) bumps
    // `generation` and force-resets _inFlight above so the NEW generation's
    // ticks are never blocked — but if THIS tick is still awaiting something
    // slow (a brain call, an effector dispatch) when that happens, it must
    // not go on to mutate shared memory.working once it resumes: see the
    // `generation !== myGen` bail-out below, after the two real await points
    // (DECIDE's brain call, ACT's dispatch) where a restart could interleave.
    var myGen = generation;

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
      //
      // FIX-PLAN 3.1 (2026-08-17): TIMER HEARTBEATS ARE NOT EVENTS. This gate
      // used to test bare `perceptions.length === 0`, but sensors/timer.js
      // pushes a perception.tick heartbeat every single tick, so the branch
      // NEVER opened in real operation — confirmed on live boots (45/45, 65/65
      // ticks, never 0 perceptions), and the same gate is what made mull()
      // structurally unreachable (BUGS.md, Phase 4 live-tested-broken note).
      // Both mull and the idle consolidate below were dead code. The timer's
      // payload carries kind:'timer', so excluding those restores idle.
      var hasActive = goals && typeof goals.hasActive === 'function' && goals.hasActive();
      var nonTimer = perceptions.filter(function (p) { return !p || p.kind !== 'timer'; });
      if (nonTimer.length === 0 && !hasActive) {
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
      // decision silently dispatched via the effector hub as `invoke(undefined,
      // undefined, ...)` -> 'unknown-effector'. This is why Phase 7 effectors
      // would never actually have fired even though the hub itself was wired
      // correctly. (This historical bug predates dispatchAction existing at
      // all — phrased as "the effector hub's invoke()" above, not as one
      // contiguous method-call string, so this comment doesn't trip the AD-1
      // single-execution-surface scan in test/anti-drift-single-dispatch.test.js.)
      var decision = await decide(ranked, goals, working, brain, memory, config);
      // REMEDIATION P1-5: decide() awaits goals.plan() (a real brain call) —
      // exactly where a restart-cortex heal race can interleave. A stale tick
      // resuming here must not commit further mutations (spend, action
      // dispatch) on behalf of a generation that's already been superseded.
      if (generation !== myGen) return;
      // FIX-PLAN 3.1 (2026-08-17): consolidate runs BEFORE the goalless
      // early-return. decide() returns null whenever no goal arbitrates out —
      // which is the NORMAL state of a purely conversational session — so the
      // consolidate call that used to sit at the bottom of this branch was
      // unreachable for exactly the sessions that produce the memories worth
      // distilling. Hoisted here (and removed from below) so goalless ticks
      // consolidate on cadence; ticks WITH a decision consolidate once, here,
      // not twice.
      if (ooda.shouldConsolidate(working.tick, config)) {
        await memory.consolidate({});
      }
      if (!decision) return;

      // RC#3: account for the planner's brain-call spend. Previously addSpend()
      // was dead code — every action showed tokensSpent:0. The fix below debits
      // the planner cost ONCE, directly to the active goal at plan time.
      //
      // Slice-2 (2026-07-31): we NO LONGER fold _spentTokens into
      // working.spendThisTick. That ledger is what act()->dispatchAction()
      // passes as the ACTION's spentTokens (cortex/index.js:310), so folding the
      // planner's ~107-tool catalog-prompt cost in there meant every dispatched
      // action re-charged the goal for re-planning — a fresh goal blew its 20k
      // token budget in one or two ticks and died with reason 'budget-exhausted'
      // before doing any work. The planner cost is now debited once here (fair,
      // single attribution — still fixes the original under-count); the action
      // carries only its own dispatch cost (effectors don't call the brain, so ~0).
      if (decision._spentTokens && decision._spentTokens > 0) {
        if (working.activeGoalId && goals && typeof goals.debitBudget === 'function') {
          goals.debitBudget(working.activeGoalId, { tokens: decision._spentTokens, actions: 0 });
        }
      }

      // -- ACT --
      await act(decision, { bus, memory, goals, brain, leash, effectors, config, working, ACTION_TIMEOUT_MS });
      // REMEDIATION P1-5: act() awaits the effector dispatch (up to
      // ACTION_TIMEOUT_MS) — another real restart-race window. A stale tick
      // must not proceed to REFLECT/CONSOLIDATE on a superseded generation.
      if (generation !== myGen) return;

      // -- REFLECT --
      if (ooda.shouldReflect(working.tick, config)) {
        reflect(working, memory, bus);
      }
      // (consolidate used to run here too — moved above the goalless
      // early-return; see the FIX-PLAN 3.1 comment there.)
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
      // REMEDIATION P1-5: only the tick that's STILL the current generation
      // gets to clear the reentrancy flag. Without this, a stale tick's
      // finally (running long after a restart already reset _inFlight and
      // let the new generation's ticks proceed) could reset _inFlight back to
      // false WHILE a new-generation tick is genuinely still in flight,
      // letting a third, overlapping tick start.
      // BUG-273: cleared under the SAME generation rule as _inFlight, and for the
      // same reason — a stale tick resuming after a restart must not clear the
      // stamp a live tick is relying on, or the watchdog would read "idle" while
      // the current generation is mid-await.
      if (generation === myGen) { tickOnce._inFlight = false; inFlightSince.value = 0; }
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
        // F4: this check runs before the hub's own invoke() is ever called,
        // so the hub's own BUG-076/Wave-6 suggestion machinery never sees
        // this call — compute the same kind of near-match here instead of
        // leaving the model with a bare, un-actionable failure.
        var registeredNames = typeof regMap.keys === 'function' ? Array.from(regMap.keys()) : [];
        var near = nearestEffectorNames(decision.tool, registeredNames, 3);
        var message = 'unknown-effector' + (near.length
          ? ': no tool named "' + decision.tool + '". Did you mean ' + near.join(', ') + '?'
          : ': no tool named "' + decision.tool + '".');
        bus.emit('action.completed', {
          tool: decision.tool, ok: false, goalId: working.activeGoalId,
          reason: 'unknown-effector', suggestions: near, message: message
        });
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
      // BUG-282 (2026-08-20): this branch used to create a confirm, emit, and
      // return recording NOTHING — so the next tick re-proposed the same action,
      // minted a FRESH confirmId, and emitted again. Measured in the audited
      // session: 42 browser_click records, all actor:"cortex", all
      // reason:"tier-3-requires-confirm", all args {"ref":"e12"}, one per second
      // for 41.6 seconds. 42 of that session's 45 confirms were that one action.
      //
      // The leash was right to refuse; the cortex had no memory of the refusal.
      // This is the third instance of "retry something that cannot succeed until
      // a human acts" — see the unknown-effector pre-flight above (whose comment
      // describes this same stall) and mull's _consecutiveFailures below.
      //
      // Suppression is keyed off the registry's own lifecycle rather than a
      // timer: peek() is null once the confirm is consumed by accept or reject,
      // and reports expired:true once its TTL passes. Either way the key frees
      // itself and the action can be proposed again — the fix must not turn into
      // "the cortex can never ask twice".
      var suppressKey = confirmSuppressionKey(decision);
      var priorConfirm = pendingConfirmsByKey.get(suppressKey);
      if (priorConfirm) {
        var stillPending = leash.confirm.peek(priorConfirm.confirmId);
        if (stillPending && !stillPending.expired) {
          priorConfirm.suppressedCount += 1;
          // Q2: suppressing 41 of 42 emissions deletes 41 log lines. Silence
          // would turn a visible spin into an invisible stall, which is strictly
          // worse than the bug being fixed — so the suppression reports itself,
          // with a running count, and stays measurable.
          bus.emit('cortex.confirm-suppressed', {
            tool: decision.tool,
            args: decision.args,
            confirmId: priorConfirm.confirmId,
            suppressedCount: priorConfirm.suppressedCount,
            reason: 'already-awaiting-confirmation'
          });
          return;
        }
        // Falls through to create a fresh confirm: peek() said this one is
        // consumed (accepted or rejected) or expired. No delete here — the
        // set() below overwrites this key unconditionally, and mutation testing
        // proved a delete on this line was dead: removing it changed no
        // behaviour and failed no test.
      }
      // Drop every key whose confirm is no longer pending. Without this the map
      // keeps one entry per distinct (tool, args) forever — the single-key
      // delete this replaced only ever tidied the key being re-proposed, so a
      // long session accumulated an entry per unique action that was confirmed
      // once and never proposed again. Same peek() truth source, no timer, and
      // the cost is one pass over a map whose size is the number of
      // confirm-requiring actions seen, not the number of ticks.
      pendingConfirmsByKey.forEach(function (entry, key) {
        var live = leash.confirm.peek(entry.confirmId);
        if (!live || live.expired) pendingConfirmsByKey.delete(key);
      });
      var argsText = humanizeArgs(decision.args).slice(0, 120);
      var summary = decision.tool + (argsText ? ' (' + argsText + ')' : '');
      var confirmId = leash.confirm.create(
        summary,
        { decision: decision, goalId: working.activeGoalId, tier: leashResult.tier },
        'system'
      );
      pendingConfirmsByKey.set(suppressKey, { confirmId: confirmId, suppressedCount: 0 });
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
      // REMEDIATION P2-12: correlates this dispatch back to the tick that
      // produced it — the cortex-side equivalent of voice's WS reqId / a
      // confirm's confirmId.
      traceId: 'tick-' + working.tick,
      spentTokens: working.spendThisTick,
      signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
    });
  }

  function reflect(working, memory, bus) {
    // Lightweight self-check — emit heartbeat with tick count
    if (bus) bus.emit('reflect', { tick: working.tick, activeGoalId: working.activeGoalId });
    // Learning loop (Layer 4): on the reflect cadence, also consolidate the
    // Lessons store (prune stale, dedup near-duplicates). Best-effort + cheap
    // — a failure here must never break the tick. This is the durable half of
    // what was previously a no-op stub; the failure signal that feeds lessons
    // comes from reflection.js, the healer playbook, and distillFailureIntoLesson.
    if (memory && memory.lessons && typeof memory.lessons.consolidate === 'function') {
      try { memory.lessons.consolidate(); } catch (_) { /* advisory */ }
    }
  }

  // Background reasoning during idle ticks — the entity "mulls". Gathers recent
  // context (conversations, events), asks the brain whether anything is worth
  // mentioning to the operator next time they speak. Thoughts are stored in
  // episodic memory (kind: 'thought') and surface in the next conversation via
  // the server's recall-before-respond path. Best-effort: never throws, never
  // BUG-273: this comment used to promise the opposite — that mull could not hold
  // up the loop — directly above an `await` that held it up for as long as a
  // reasoning-lane call takes, which is why nobody looked here. It
  // block the tick, by design — nothing else may run mid-tick. What it must not do
  // is look like a stall while it does, which is now the watchdog's problem to
  // measure rather than this function's to deny. Disabled when
  // MYTHOS_MULL_EVERY_TICKS is 0.
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

      // lane 'reasoning', not 'simple' (2026-08-14). mull()'s whole job is
      // noticing loose ends worth raising — and it was doing it on
      // llama-3.1-8b-instant, the weakest model in the fleet, which led
      // PREF_SIMPLE for "224ms — fastest measured anywhere". NOTHING WAITS ON
      // THIS CALL: it runs in a quiet moment and its output is a maybe-mention.
      // The latency bought nothing and cost the reasoning.
      var result = await brain.think({
        lane: 'reasoning',
        messages: [{ role: 'user', content:
          'You are MYTHOS, reflecting during a quiet moment. Here is your recent context:\n\n' +
          'Recent conversations:\n' + (convoSummaries || '(none)') + '\n\n' +
          'Recent events:\n' + (eventSummaries || '(none)') + '\n\n' +
          'Is there anything worth mentioning to the operator next time they speak? ' +
          'Consider: loose ends, follow-ups they might forget, observations about their ' +
          'work patterns, things that seem important. If yes, respond with JSON: ' +
          '{"thoughts": "what to mention", "priority": "low|medium|high"}\n' +
          'If nothing is worth mentioning, respond: {"thoughts": "", "priority": "low"}\n\n' +
          // "high" is not a general importance rating — it is the trigger for
          // SPEAKING UP UNPROMPTED (server/index.js subscribes to cortex.thought
          // and says high-priority thoughts aloud). Reserve it for the two cases
          // worth breaking a silence over; everything else rides along as context
          // on the operator's next turn instead.
          'PRIORITY RULES: use "high" ONLY for (a) a question you asked that the ' +
          'operator never answered, or (b) a goal or build that has stalled. ' +
          '"high" means you will SAY IT ALOUD unprompted, so it must be worth ' +
          'interrupting silence for. Everything else is "medium" or "low" — those ' +
          'are only mentioned if the operator speaks first.\n\n' +
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
          // Diff-gate: 'high' priority is what makes the server say this aloud
          // unprompted (see the PRIORITY RULES prompt below) — without this
          // check the same stalled-goal nudge would repeat every mull cadence
          // (default ~5min) for as long as nothing changed. The episodic write
          // above still records every pass honestly; only the spoken emit is gated.
          if (diffGate.hasChanged('mull-thought', thoughtText)) {
            bus.emit('cortex.thought', { text: thoughtText, priority: result.parsed.priority });
          }
        }
      }

      // V8 (Phase 4): route brain-returned proposals through propose_goal.
      // Each becomes a status:'proposed' goal (inert — arbiter ignores) that
      // the operator accepts/rejects via the dashboard. Caps at 2 per mull pass
      // (safety bound — don't spam the proposal queue). Effectors are optional
      // in tests; skip silently when absent.
      // AD-1: this used to call the effector hub's invoke() method directly
      // (the comment claimed "T1 leash tier handles the audit automatically",
      // which was false — only dispatchAction() drives the audit/episodic
      // write; a raw hub call left these proposals with no trace at all). Now
      // goes through the same shared dispatchAction() as act()'s dispatch
      // above — single execution surface, real audit line per proposal.
      if (result && !result.offline && result.parsed && Array.isArray(result.parsed.proposals)) {
        var proposals = result.parsed.proposals.slice(0, 2);
        for (var pi = 0; pi < proposals.length; pi++) {
          var pr = proposals[pi];
          if (!pr || !pr.text || !String(pr.text).trim()) continue;
          try {
            if (effectors && typeof effectors.invoke === 'function') {
              await dispatchAction({
                tool: 'propose_goal',
                args: {
                  text: String(pr.text).trim().slice(0, 200),
                  category: pr.category || 'General',
                  reason: pr.reason ? String(pr.reason).slice(0, 200) : 'mull-proposed',
                  drive: 'curiosity'
                }
              }, {
                effectors: effectors, bus: bus, goals: goals, memory: memory, config: cfg,
                goalId: null, tier: 1, channel: 'cortex', traceId: 'tick-' + working.tick,
              });
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
    // BUG-273: read by immune/watchdog.js to tell BUSY from DEAD.
    get inFlightSince() { return inFlightSince; },
    // BUG-282: how many actions this cortex currently believes are awaiting the
    // operator. Read-only, and a test seam rather than a feature — the
    // suppression map is otherwise unobservable, and an unobservable cache is
    // one whose pruning cannot be proven. Mutation testing needed this.
    get pendingConfirmKeyCount() { return pendingConfirmsByKey.size; },
    get generation() { return generation; }
  };
}

module.exports = { createCortex, confirmSuppressionKey };
