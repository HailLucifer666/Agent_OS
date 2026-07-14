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
        tier: tier, tokensSpent: 0,
      });
    } catch (_) { /* persistence is best-effort */ }
  }

  // 4. Budget debit
  if (goalId && goals && typeof goals.debitBudget === 'function') {
    goals.debitBudget(goalId, { tokens: 0, actions: 1 });
  }

  // 5. Emit completion event
  bus.emit('action.completed', { tool: decision.tool, ok: result && result.ok, goalId: goalId });

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

  // 6. UI-specific events (navigate, close_panel)
  if (decision.tool === 'navigate' && result && result.ok && result.result && result.result.route) {
    bus.emit('ui.navigate', { route: result.result.route });
  }
  if (decision.tool === 'close_panel' && result && result.ok) {
    bus.emit('ui.close-panel', { all: result.result.all });
  }

  return result;
}

module.exports = { dispatchAction: dispatchAction, humanizeArgs: humanizeArgs };
