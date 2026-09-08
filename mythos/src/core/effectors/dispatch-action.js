'use strict';

// effectors/dispatch-action.js — F1: Shared dispatch sequence used by both the
// cortex autonomous loop and the server's voice/confirm-accept paths.
// Consolidates: breaker check → effectors.invoke → episodic write → budget debit → event emit.
// Prevents drift between the two dispatch surfaces.

// Channels whose actions are PLUMBING, not experience. They still get a full
// audit row — the audit trail is what an investigation reads — but they are kept
// out of episodic memory, which is what the brain recalls when composing a
// reply.
//
// WHY (operator, 2026-08-11): the packaged build ducked system volume at every
// mic-hot boundary, which with music playing oscillated — 58 set_volume rows in
// one session, all channel:'voice-ducking'. Each one was also an episodic entry,
// and server/index.js recalls the 12 most relevant recent memories per turn, so
// those rows crowded out everything else. The entity then answered "how's it
// going" with "Volume's at 15 now" and, asked about it, said "because you keep
// setting it there" — it was reading its own microphone plumbing as if it were
// something the operator had done. Hysteresis (server/index.js) stops the
// oscillation; this stops the plumbing from being remembered as events at all.
//
// 'boot-briefing' (TASK B2 code review, 2026-08-13): the boot briefing dispatches
// get_weather/reminder_list through this same sequence every boot for the exact
// same reason set_volume did — the reads are plumbing for a spoken greeting, not
// an experience, and an episodic row per boot for "checked the weather" would
// crowd the same recall window this exception was created to protect.
const INTERNAL_CHANNELS = new Set(['voice-ducking', 'boot-briefing']);

function humanizeArgs(args) {
  const entries = Object.entries(args || {});
  if (!entries.length) return '';
  return entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
}

// REMEDIATION P2-12: some effectors' fail() shape is an object, not a string
// (e.g. from-runner.js's run_command: fail(m, extra) -> {error: m, ...extra}),
// so a plain String(result.result) produced the useless literal
// "[object Object]" in the audit trail — confirmed in the 2026-07-29 audit's
// own Audit/2026-07-29.jsonl. Extracted to util/reason-text.js (2026-08-13,
// Wave 0) so effectors' own catch blocks can share it instead of re-deriving
// the same fallback ad hoc.
const { reasonText } = require('../util/reason-text');

// REVIEW-of-a0c82fe (2026-08-24): hub.invoke now ENFORCES the caller signal
// (GAP-ANALYSIS-2026-08-24 H1), so this dispatcher's default ACTION_TIMEOUT_MS
// became a hard kill for tools whose effectors carry their own, larger,
// documented budgets. Intentionally narrow: an ordinary tool over budget is
// still killed (pinned by the negative control in
// test/dispatch-self-timed-tools.test.js). Adding to this set requires naming
// the effector's own budget in the comment.
const SELF_TIMED_TOOLS = new Set([
  // build-engine path — DSH_TEXT_BUILD_TIMEOUT_MS defaults to 600000 (10 min)
  'build_project', 'revise_project', 'start_project', 'dsh_task',
  'kanban_build_card', 'kanban_assemble',
  // ingestion / scanning — unbounded multi-item work with no internal budget yet
  'index_project', 'document_ingest', 'security_scan',
  // orchestration — each stage dispatches its own bounded actions
  'run_mission', 'pipeline_execute',
  // browser-use agent — from-browser-use.js kills its runner at BROWSER_USE_TIMEOUT_MS
  // (default 120000). Live 2026-09-08 13:31: two spoken tasks were cut at this dispatcher's
  // 30 s default mid-run (audit: browser_task tool-timeout x2), then the tool was suppressed.
  'browser_task',
]);

async function dispatchAction(decision, ctx) {
  const { effectors, bus, goals, memory, config } = ctx;
  const goalId = ctx.goalId || null;
  const tier = ctx.tier || 0;
  // W1: callers that track per-call token spend (the cortex autonomous loop,
  // via working.spendThisTick) pass it through here. Voice/confirm-accept
  // callers omit it → defaults to 0, preserving their existing behavior.
  const spentTokens = ctx.spentTokens || 0;
  const signal = ctx.signal || (SELF_TIMED_TOOLS.has(decision.tool)
    ? undefined // REVIEW-of-a0c82fe fix: these effectors carry their own larger
                // budgets (DSH builds: DSH_TEXT_BUILD_TIMEOUT_MS=600000); hub
                // enforcement made the dispatcher's default binding, killing
                // legitimate builds at 30s. Their internal budget governs; an
                // explicit caller signal still applies.
    : AbortSignal.timeout((config && config.ACTION_TIMEOUT_MS) || 30000));

  // 1. Breaker check
  if (effectors.breakers && typeof effectors.breakers.allow === 'function') {
    if (!effectors.breakers.allow(decision.tool)) {
      bus.emit('action.blocked', Object.assign({}, decision, { reason: 'circuit-open' }));
      return { ok: false, result: 'circuit-open' };
    }
  }

  // 2. Dispatch
  // BUG-398 row 13: `channel` rides along so an effector can tell WHICH surface
  // is calling it. The audit line below has always recorded it (as `actor`);
  // the effector itself could not see it, which is how think_deeply came to tell
  // a voice turn that IT had just used a budget the background loop consumed.
  const result = await effectors.invoke(decision.tool, decision.args,
    { signal: signal, bus: bus, goalId: goalId, channel: ctx.channel || null, connectionId: ctx.connectionId || null, requestId: ctx.requestId ?? undefined });

  // REMEDIATION P2-12: the one per-turn correlation id already threaded
  // through by callers (the voice WS message's reqId, a confirm's confirmId,
  // cortex's tick counter) so origin AND turn can both be reconstructed later
  // — audit/episodic previously recorded neither, only ever the tool+outcome.
  const traceId = ctx.traceId || null;

  // 3. Record outcome in episodic memory — unless this channel is plumbing
  // (see INTERNAL_CHANNELS above; the audit write below is unconditional).
  const isInternal = INTERNAL_CHANNELS.has(ctx.channel);
  if (!isInternal && memory && memory.episodic && typeof memory.episodic.write === 'function') {
    try {
      await memory.episodic.write({
        kind: 'action', channel: ctx.channel || 'cortex',
        summary: decision.tool + '(' + JSON.stringify(decision.args || {}).slice(0, 80) + ')',
        detail: result,
        outcome: result && result.ok ? 'ok' : 'fail',
        tier: tier, tokensSpent: spentTokens,
        // V2 (Phase 4): carry skillRef so V9 reflection can correlate outcomes
        // back to the procedural skill that produced them.
        skillRef: decision.skillRef || null,
        rationale: decision.rationale || null,
        traceId: traceId,
      });
    } catch (_) { /* persistence is best-effort */ }
  }

  // 4. Budget debit
  if (goalId && goals && typeof goals.debitBudget === 'function') {
    goals.debitBudget(goalId, { tokens: spentTokens, actions: 1 });
  }


  // 4.5 V2 (Phase 4): close the execution→learning loop.
  //   (a) skills.recordUse — feeds the EMA successRate the planner consults
  //       in goals.plan() to decide whether to replay this procedure. Only
  //       fires when the decision came from a procedural skill (skillRef set).
  //   (b) goals.markPlanStepDone — advances a persisted multi-step plan so
  //       the next tick dispatches the next step instead of step[0] forever.
  // Both are best-effort: failures here MUST NOT mask the action's own result.
  const actionOk = !!(result && result.ok);
  // Wave 0 evidence contract (effectors/evidence.js): a world-changing effector
  // may return ok:true WITHOUT having proved the world changed, in which case it
  // sets unverified:true plus a spoken-usable reason. That is neither success nor
  // failure and must not be flattened into either — a ✓ on an unverified action
  // is exactly how three ui_type calls came to be reported as delivered text into
  // an empty Notepad. Carried alongside `ok` rather than folded into it so the
  // existing outcome:'ok'|'fail' audit vocabulary (asserted by the AD-4 tests)
  // keeps its meaning.
  const actionUnverified = actionOk && !!(result && result.unverified);
  const unverifiedReason = actionUnverified
    ? String((result && result.reason) || 'not confirmed').slice(0, 300)
    : undefined;
  // BUG-137: an unverified action (ok:true, unverified:true) is neither a proven
  // success nor a proven failure — it is exactly the "we don't know" case the
  // evidence contract exists to preserve. Both call sites' real bodies were
  // checked rather than assumed (memory/skills.js recordUse, goals/index.js
  // markPlanStepDone): passing `false` is NOT a harmless non-advance.
  // recordUse's EMA (`oldRate*0.9 + newRate*0.1`) treats false as a real 0 and
  // drags the skill's successRate down; markPlanStepDone would mark the step
  // 'failed', charge goal.failCount, and at failCount >= 2 fire
  // distillFailureIntoLesson — inventing a failure nobody observed.
  //
  // The two call sites therefore diverge, deliberately:
  //   recordUse       — skipped entirely. An EMA has no "unknown" slot; the
  //                     only honest thing is to not move the average.
  //   markPlanStepDone— still called, with a third argument marking the step
  //                     'unverified'. It CANNOT be skipped: plan() dispatches
  //                     the first *pending* step every tick, so a step left
  //                     unresolved re-runs a real world-changing action
  //                     (ui_type, ui_click) forever.
  // F9 (2026-08-15): promote a repeated action into a durable fact.
  //
  // "MYTHOS did not remember previously requested songs" — a track played three
  // times in one session left 18 episodic records and produced nothing in
  // Semantic, because the ONLY route into Semantic was the model choosing to
  // call `remember`. Behaviour is the more reliable signal and it was being
  // thrown away entirely. See memory/habit-promoter.js for why the watch list is
  // narrow and why this is a count rather than a brain call.
  //
  // Sits with the other post-dispatch bookkeeping and is guarded the same way:
  // it observes an action that already happened and can never change its result.
  // `actionOk && !actionUnverified` deliberately — an action that only MIGHT
  // have landed is not evidence of a habit, which is exactly the distinction the
  // evidence contract in src/core/CLAUDE.md exists to keep alive this far down.
  if (memory && memory.habits && typeof memory.habits.observe === 'function') {
    try {
      memory.habits.observe(decision.tool, decision.args || decision.params,
        actionOk && !actionUnverified);
    } catch (_) { /* memory bookkeeping must never affect an action's result */ }
  }

  if (decision.skillRef && !actionUnverified && memory && memory.skills && typeof memory.skills.recordUse === 'function') {
    try {
      // FIX-2: recordUse is async and was previously fire-and-forget with no
      // .catch — a rejection (e.g. a transient Windows EBUSY/EPERM reading a
      // locked Skills/*.md) escaped as an unhandled rejection and could crash
      // the whole process. Attach .catch so it can never escape; best-effort
      // telemetry only, must not mask the action's own result.
      const recordUseResult = memory.skills.recordUse(decision.skillRef, actionOk);
      if (recordUseResult && typeof recordUseResult.catch === 'function') {
        recordUseResult.catch((err) => {
          if (bus && typeof bus.emit === 'function') {
            try { bus.emit('health.anomaly', { source: 'skills.recordUse', error: err && err.message }); } catch (_) { /* best-effort */ }
          }
        });
      }
    } catch (_) { /* skill bookkeeping is best-effort */ }
  }
  if (goalId && goals && typeof goals.markPlanStepDone === 'function') {
    // BUG-137: still called for an unverified action, but with the third argument
    // set so goals.markPlanStepDone() resolves the step as 'unverified' —
    // neither 'done' (which would launder an unproven action into a success and
    // advance the learning signal) nor 'failed' (which charges failCount and
    // trips distillFailureIntoLesson). Skipping the call entirely was the wrong
    // shape: plan() re-dispatches the first *pending* step every tick, so a
    // never-resolved step means a real world-changing action (ui_type,
    // ui_click) repeats forever — strictly worse than the mis-scoring it was
    // meant to fix. recordUse above is genuinely skipped instead, because an
    // EMA has no "unknown" slot to record into.
    try { goals.markPlanStepDone(goalId, actionOk, actionUnverified); }
    catch (_) { /* plan-queue advance is best-effort */ }
  }

  // 5. Emit completion event
  bus.emit('action.completed', {
    tool: decision.tool, ok: actionOk, goalId: goalId,
    unverified: actionUnverified, reason: unverifiedReason,
  });

  // B4: Audit-log the action outcome for traceability.
  if (memory && memory.audit && typeof memory.audit.write === 'function') {
    try {
      memory.audit.write({
        tool: decision.tool, tier: tier, decision: 'completed',
        outcome: actionOk ? 'ok' : 'fail',
        // The failure reason was sitting in result.result (effectors' fail()
        // shape) and was never carried over — outcome:'fail' alone is
        // useless for diagnosing WHY. Truncated: audit lines persist
        // forever in JSONL.
        reason: actionOk ? unverifiedReason : reasonText(result && result.result).slice(0, 300),
        // Present only when true, so the JSONL an operator greps a year from now
        // stays readable. This is the field that makes "MYTHOS said it typed the
        // text" auditable after the fact.
        unverified: actionUnverified || undefined,
        goalId: goalId,
        // REMEDIATION P2-12: this call never passed `actor`, so audit-writer's
        // own default (`entry.actor = 'cortex'`) silently applied to EVERY
        // record regardless of true origin — voice, confirm-accept, and
        // autonomous actions were indistinguishable in the audit trail even
        // though ctx.channel (used above for episodic) already carried the
        // real answer. traceId is new: correlates this line back to the
        // specific turn (voice reqId / confirmId / cortex tick) that caused it.
        actor: ctx.channel || 'cortex',
        traceId: traceId,
        // G4 (unattributable-consent finding): actor above is a hardcoded
        // per-code-path literal (server/index.js's handleConfirmReply always
        // passes channel: 'confirm-accept'), so every accept looked identical
        // in the audit no matter which surface produced it — a spoken "no"
        // could not have caused an accept (show_desktop isn't in SEND_TOOLS,
        // AFFIRMATIVE_RE/NEGATIVE_RE are anchored and reject-checked first,
        // and accept() is single-use per confirm), but that could not be
        // PROVEN from the audit trail either. `surface` carries the actual
        // client-reported origin of a confirm-reply ('click' vs 'gesture'),
        // defaulting to 'unknown' for anything that didn't report one — never
        // 'click', which would be inventing an attribution, the exact defect
        // this fixes. `acceptedScope` records which of the two accept()
        // scopes tried in handleConfirmReply actually resolved the confirm
        // ('connection' vs the T0-T2-only 'system' fallback), which is
        // material to attribution and was previously indistinguishable too.
        surface: ctx.surface || 'unknown',
        acceptedScope: ctx.acceptedScope || undefined,
      });
    } catch (_) {}
  }

  // 6. UI-specific events (navigate, open_web). close_panel is deliberately
  // NOT relayed here (REMEDIATION P1-5): it now broadcasts + awaits a client
  // ack directly (ctx.closePanelProvider, mirroring camera_look's
  // self-contained cameraFrameProvider round-trip) so its return value can be
  // honest about what actually closed, instead of a post-hoc fire-and-forget
  // that always looked like success regardless of outcome.
  if (decision.tool === 'navigate' && result && result.ok && result.result && result.result.route) {
    bus.emit('ui.navigate', { route: result.result.route });
  }
  if (decision.tool === 'open_web' && result && result.ok && result.result) {
    // BUG-273 B3: skip when the effector already dispatched the render itself in
    // order to collect a mount ack. Emitting here as well would render the widget
    // twice, which is BUG-166 (one open_web, two players) from the other direction.
    // Every other producer of this event (from-pc.js, from-widgets.js) is untouched
    // and still relies on this relay.
    if (!result.result.renderDispatched) bus.emit('ui.open-web', result.result);
  }

  return result;
}

module.exports = { dispatchAction: dispatchAction, humanizeArgs: humanizeArgs };
