'use strict';

// effectors/dispatch-action.js — F1: Shared dispatch sequence used by both the
// cortex autonomous loop and the server's voice/confirm-accept paths.
// Consolidates: breaker check → effectors.invoke → episodic write → budget debit → event emit.
// Prevents drift between the two dispatch surfaces.

function humanizeArgs(args) {
  const entries = Object.entries(args || {});
  if (!entries.length) return '';
  return entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
}

// REMEDIATION P2-12: some effectors' fail() shape is an object, not a string
// (e.g. from-runner.js's run_command: fail(m, extra) -> {error: m, ...extra}),
// so a plain String(result.result) produced the useless literal
// "[object Object]" in the audit trail — confirmed in the 2026-07-29 audit's
// own Audit/2026-07-29.jsonl. Extract a real message when there is one,
// falling back to a truncated JSON dump instead of toString's default.
function reasonText(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    if (typeof raw.error === 'string') return raw.error;
    if (typeof raw.message === 'string') return raw.message;
    try { return JSON.stringify(raw); } catch (_) { /* fall through */ }
  }
  return String(raw);
}

async function dispatchAction(decision, ctx) {
  const { effectors, bus, goals, memory, config } = ctx;
  const goalId = ctx.goalId || null;
  const tier = ctx.tier || 0;
  // W1: callers that track per-call token spend (the cortex autonomous loop,
  // via working.spendThisTick) pass it through here. Voice/confirm-accept
  // callers omit it → defaults to 0, preserving their existing behavior.
  const spentTokens = ctx.spentTokens || 0;
  const signal = ctx.signal || AbortSignal.timeout((config && config.ACTION_TIMEOUT_MS) || 30000);

  // 1. Breaker check
  if (effectors.breakers && typeof effectors.breakers.allow === 'function') {
    if (!effectors.breakers.allow(decision.tool)) {
      bus.emit('action.blocked', Object.assign({}, decision, { reason: 'circuit-open' }));
      return { ok: false, result: 'circuit-open' };
    }
  }

  // 2. Dispatch
  const result = await effectors.invoke(decision.tool, decision.args, { signal: signal, bus: bus, goalId: goalId });

  // REMEDIATION P2-12: the one per-turn correlation id already threaded
  // through by callers (the voice WS message's reqId, a confirm's confirmId,
  // cortex's tick counter) so origin AND turn can both be reconstructed later
  // — audit/episodic previously recorded neither, only ever the tool+outcome.
  const traceId = ctx.traceId || null;

  // 3. Record outcome in episodic memory
  if (memory && memory.episodic && typeof memory.episodic.write === 'function') {
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
    bus.emit('ui.open-web', result.result);
  }

  return result;
}

module.exports = { dispatchAction: dispatchAction, humanizeArgs: humanizeArgs };
