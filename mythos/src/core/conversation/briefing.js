'use strict';

// conversation/briefing.js — buildBriefingFacts(deps): assembles the boot
// greeting's fact list. Extracted from server/index.js's deliverBootGreeting()
// (TASK B2) so fact assembly is independently, behaviorally testable instead
// of only source-shape-assertable — same rationale as electron/child-exit.js's
// extraction. Dependencies are INJECTED by the caller, never required
// internally, and every fact source is individually time-boxed via
// Promise.race so one slow or broken source never costs the whole greeting.
// The outer 12s brain-compose race in deliverBootGreeting() is unrelated and
// stays exactly where it is — this module only guards raw fact gathering.

const DEFAULT_FACT_TIMEOUT_MS = 2000;

// Runs fn() with a hard ~ms timeout via a real Promise.race. Resolves null on
// timeout OR on any thrown/rejected error from fn() — callers treat null as
// "skip this fact", never as a reason to fail the whole briefing.
function withTimeout(fn, ms) {
  const guarded = Promise.resolve().then(fn).catch(() => null);
  const timeout = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    if (t.unref) t.unref();
  });
  return Promise.race([guarded, timeout]);
}

async function buildBriefingFacts(deps) {
  deps = deps || {};
  const facts = [];
  const timeoutMs = typeof deps.factTimeoutMs === 'number' ? deps.factTimeoutMs : DEFAULT_FACT_TIMEOUT_MS;

  // 1. Local time.
  const timeFact = await withTimeout(() => (
    'Local time: ' + new Date().toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' })
  ), timeoutMs);
  if (timeFact) facts.push(timeFact);

  // 2. Goals stats.
  const goalsFact = await withTimeout(async () => {
    const goalsEffector = deps.goalsEffector;
    if (!goalsEffector || typeof goalsEffector.stats !== 'function') return null;
    const gs = await goalsEffector.stats();
    if (!gs || typeof gs.active !== 'number' || typeof gs.done !== 'number') return null;
    return 'Goals: ' + gs.active + ' active, ' + gs.done + ' done';
  }, timeoutMs);
  if (goalsFact) facts.push(goalsFact);

  // 3. Provider health.
  const providersFact = await withTimeout(async () => {
    const probes = deps.probes;
    const isProviderDown = deps.isProviderDown;
    if (!probes) return null;
    const st = await probes.getStatus();
    const down = ['nim', 'groq', 'mistral'].filter((id) => {
      try { return isProviderDown(id, st.providers); } catch (_) { return false; }
    });
    return down.length ? 'AI providers down: ' + down.join(', ') : 'All AI providers online';
  }, timeoutMs);
  if (providersFact) facts.push(providersFact);

  // 4. gitRef upgrade delta — precomputed once at boot by the caller
  // (server/index.js's bootUpgrade), no I/O here to time-box.
  const bootUpgrade = deps.bootUpgrade;
  if (bootUpgrade && bootUpgrade.upgraded) {
    facts.push('You received a code upgrade since your last boot' +
      (bootUpgrade.changes && bootUpgrade.changes.length ? ' — recent changes: ' + bootUpgrade.changes.join('; ') : ''));
  }

  // 5. Update report (TASK B1) — precomputed once at boot by the caller from
  // MYTHOS_UPDATE_RESULT via getUpdateReport(), no I/O here either.
  const updateReport = deps.updateReport;
  if (updateReport) {
    facts.push(updateReport.completed
      ? 'I was updated to v' + updateReport.version +
        (updateReport.releaseNotes ? ' — ' + updateReport.releaseNotes : '')
      : 'an update to v' + updateReport.version + ' did not complete — still on v' + updateReport.from);
  }

  // 6. Last 3 conversations (session carryover). recall('') with a kind
  // filter scores by recency alone (episodic.js) — this is simply the three
  // most recent conversation records, no new query path.
  const recentFact = await withTimeout(() => {
    const memory = deps.memory;
    if (!memory || !memory.episodic || typeof memory.episodic.recall !== 'function') return null;
    const recent = memory.episodic.recall('', { kind: 'conversation', limit: 3, windowDays: 3 }) || [];
    const lines = recent
      .map((hit) => (hit.record && hit.record.summary) || hit.snippet || '')
      .filter(Boolean)
      .slice(0, 3);
    return lines.length ? 'Last time we spoke: ' + lines.join(' / ') : null;
  }, timeoutMs);
  if (recentFact) facts.push(recentFact);

  // 7. Weather (NEW) — via the get_weather effector (Open-Meteo, T0), reached
  // through `deps.dispatch` (server/index.js binds this to the shared
  // dispatchAction() sequence — AD-1's "one execution surface" rule forbids
  // any OTHER call site from invoking the hub's dispatch method directly),
  // never by calling Open-Meteo directly.
  const weatherFact = await withTimeout(async () => {
    const dispatch = deps.dispatch;
    if (typeof dispatch !== 'function') return null;
    const res = await dispatch('get_weather', {});
    if (!res || !res.ok || !res.result || typeof res.result !== 'object') return null;
    const w = res.result;
    if (typeof w.temperatureC !== 'number') return null;
    return 'Weather' + (w.location ? ' in ' + w.location : '') + ': ' +
      w.temperatureC + '°C, ' + (w.condition || 'unknown conditions');
  }, timeoutMs);
  if (weatherFact) facts.push(weatherFact);

  // 8. System conditions (NEW) — snapshotSystemMetrics(), the exact metric
  // math server/routes/system.js's /api/system route reports, extracted so
  // both callers share one source of truth instead of two copies drifting.
  const systemFact = await withTimeout(async () => {
    const snapshot = deps.snapshotSystemMetrics;
    if (typeof snapshot !== 'function') return null;
    const snapped = await snapshot();
    const metrics = snapped && snapped.metrics;
    if (!metrics) return null;
    const parts = [];
    if (metrics.cpu && typeof metrics.cpu.loadPercent === 'number') parts.push('CPU ' + metrics.cpu.loadPercent + '%');
    if (metrics.mem && typeof metrics.mem.usedPercent === 'number') parts.push('memory ' + metrics.mem.usedPercent + '%');
    if (!parts.length) return null;
    return 'System: ' + parts.join(', ') + ' in use';
  }, timeoutMs);
  if (systemFact) facts.push(systemFact);

  // 9. Spend (NEW) — spend.getStats().today: calls / tokens / success-rate
  // only. Deliberately NOT converted to dollars — there is no pricing table
  // in this repo, and inventing one would state a falsehood.
  const spendFact = await withTimeout(() => {
    const spend = deps.spend;
    if (!spend || typeof spend.getStats !== 'function') return null;
    const stats = spend.getStats();
    const today = stats && stats.today;
    if (!today || !today.calls) return null;
    return 'Today so far: ' + today.calls + ' brain calls, ' +
      (today.tokensIn + today.tokensOut) + ' tokens, ' + stats.successRate + '% success rate';
  }, timeoutMs);
  if (spendFact) facts.push(spendFact);

  // 10. Needs-done (NEW) — one line combining active goals + kanban
  // backlog/building cards + pending proposals + due reminders.
  const needsDoneFact = await withTimeout(async () => {
    const goalsEffector = deps.goalsEffector;
    const kanbanEffector = deps.kanbanEffector;
    const dispatch = deps.dispatch;
    const parts = [];
    try {
      if (goalsEffector && typeof goalsEffector.stats === 'function') {
        const gs = await goalsEffector.stats();
        if (gs && typeof gs.active === 'number' && gs.active) {
          parts.push(gs.active + ' active goal' + (gs.active === 1 ? '' : 's'));
        }
      }
    } catch (_) {}
    try {
      if (kanbanEffector && typeof kanbanEffector.listBoard === 'function') {
        const board = kanbanEffector.listBoard();
        const cards = (board && board.cards) || [];
        const n = cards.filter((c) => c && (c.lane === 'backlog' || c.lane === 'building')).length;
        if (n) parts.push(n + ' kanban card' + (n === 1 ? '' : 's') + ' in progress');
      }
    } catch (_) {}
    try {
      if (goalsEffector && typeof goalsEffector.listProposals === 'function') {
        const proposals = goalsEffector.listProposals() || [];
        if (proposals.length) parts.push(proposals.length + ' pending proposal' + (proposals.length === 1 ? '' : 's'));
      }
    } catch (_) {}
    try {
      if (typeof dispatch === 'function') {
        const res = await dispatch('reminder_list', {});
        if (res && res.ok && res.result && Array.isArray(res.result.reminders)) {
          const now = Date.now();
          const due = res.result.reminders.filter((r) => r && !r.fired && r.dueAt <= now).length;
          if (due) parts.push(due + ' due reminder' + (due === 1 ? '' : 's'));
        }
      }
    } catch (_) {}
    return parts.length ? 'On your plate: ' + parts.join(', ') + '.' : null;
  }, timeoutMs);
  if (needsDoneFact) facts.push(needsDoneFact);

  // SLOT for a following task (B4): a self-healing summary fact belongs here
  // — appended after needs-done, before the facts are handed to the brain
  // prompt. Deliberately NOT implemented in this task.

  return facts;
}

module.exports = { buildBriefingFacts };
