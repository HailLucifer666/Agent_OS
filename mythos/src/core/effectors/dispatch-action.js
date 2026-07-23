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
  if (decision.skillRef && memory && memory.skills && typeof memory.skills.recordUse === 'function') {
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
    try { goals.markPlanStepDone(goalId, actionOk); }
    catch (_) { /* plan-queue advance is best-effort */ }
  }

  // 5. Emit completion event
  bus.emit('action.completed', { tool: decision.tool, ok: actionOk, goalId: goalId });

  // B4: Audit-log the action outcome for traceability.
  if (memory && memory.audit && typeof memory.audit.write === 'function') {
    try {
      memory.audit.write({
        tool: decision.tool, tier: tier, decision: 'completed',
        outcome: result && result.ok ? 'ok' : 'fail',
        goalId: goalId,
      });
    } catch (_) {}
  }

  // 6. UI-specific events (navigate, close_panel, open_web)
  if (decision.tool === 'navigate' && result && result.ok && result.result && result.result.route) {
    bus.emit('ui.navigate', { route: result.result.route });
  }
  if (decision.tool === 'close_panel' && result && result.ok) {
    bus.emit('ui.close-panel', { all: result.result.all });
  }
  if (decision.tool === 'open_web' && result && result.ok && result.result) {
    bus.emit('ui.open-web', result.result);
  }

  return result;
}

module.exports = { dispatchAction: dispatchAction, humanizeArgs: humanizeArgs };
