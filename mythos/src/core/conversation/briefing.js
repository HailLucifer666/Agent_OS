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
//
// All I/O-bound sources are gathered with Promise.all (code review, 2026-08-13):
// each is capped at ~timeoutMs individually, but awaiting them one at a time
// let the caps STACK — several slow sources in a row could add multiple
// seconds in front of the 12s brain-compose race that follows. Gathering in
// parallel bounds the total wait to the slowest single source instead.
//
// One exception to "never required internally" (Task B3 code review): the
// two-sample CPU-delta dance fact #8 used to run inline here is now shared
// with system_status (effectors/from-system.js) via sampledSystemMetrics()
// in server/routes/system.js. It is required directly rather than injected
// because it takes the actual data dependency — the snapshot function — as
// its own parameter (deps.snapshotSystemMetrics still flows through exactly
// as before), so requiring it adds no untestable coupling: it is pure
// orchestration (sample, wait, sample, diff), not a subsystem that needs
// faking on its own.
const { sampledSystemMetrics } = require('../../../server/routes/system');

const DEFAULT_FACT_TIMEOUT_MS = 2000;
// The gap between the two os.cpus() samples the system-conditions fact takes
// to measure a real CPU delta (see fact #8 below). Small enough to leave
// headroom inside the per-source timeout; overridable so tests don't have to
// burn wall-clock time waiting on it.
const DEFAULT_SYSTEM_SAMPLE_GAP_MS = 150;

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
  const timeoutMs = typeof deps.factTimeoutMs === 'number' ? deps.factTimeoutMs : DEFAULT_FACT_TIMEOUT_MS;
  const systemSampleGapMs = typeof deps.systemSampleGapMs === 'number' ? deps.systemSampleGapMs : DEFAULT_SYSTEM_SAMPLE_GAP_MS;

  // Every I/O-bound source races in parallel below (fixed 2026-08-13 — see
  // header comment). Order of the destructured results is preserved into the
  // final `facts` array further down, regardless of which one resolves first.
  const [
    timeFact,
    goalsFact,
    providersFact,
    recentFact,
    weatherFact,
    systemFact,
    spendFact,
    needsDoneFact,
  ] = await Promise.all([
    // 1. Local time.
    withTimeout(() => (
      'Local time: ' + new Date().toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' })
    ), timeoutMs),

    // 2. Goals stats.
    withTimeout(async () => {
      const goalsEffector = deps.goalsEffector;
      if (!goalsEffector || typeof goalsEffector.stats !== 'function') return null;
      const gs = await goalsEffector.stats();
      if (!gs || typeof gs.active !== 'number' || typeof gs.done !== 'number') return null;
      return 'Goals: ' + gs.active + ' active, ' + gs.done + ' done';
    }, timeoutMs),

    // 3. Provider health.
    withTimeout(async () => {
      const probes = deps.probes;
      const isProviderDown = deps.isProviderDown;
      if (!probes) return null;
      const st = await probes.getStatus();
      const down = ['nim', 'groq', 'mistral'].filter((id) => {
        try { return isProviderDown(id, st.providers); } catch (_) { return false; }
      });
      return down.length ? 'AI providers down: ' + down.join(', ') : 'All AI providers online';
    }, timeoutMs),

    // 6. Last 3 conversations (session carryover). recall('') with a kind
    // filter scores by recency alone (episodic.js) — this is simply the three
    // most recent conversation records, no new query path.
    withTimeout(() => {
      const memory = deps.memory;
      if (!memory || !memory.episodic || typeof memory.episodic.recall !== 'function') return null;
      const recent = memory.episodic.recall('', { kind: 'conversation', limit: 3, windowDays: 3 }) || [];
      const lines = recent
        .map((hit) => (hit.record && hit.record.summary) || hit.snippet || '')
        .filter(Boolean)
        .slice(0, 3);
      return lines.length ? 'Last time we spoke: ' + lines.join(' / ') : null;
    }, timeoutMs),

    // 7. Weather (NEW) — via the get_weather effector (Open-Meteo, T0), reached
    // through `deps.dispatch` (server/index.js binds this to the shared
    // dispatchAction() sequence, on the 'boot-briefing' internal channel —
    // AD-1's "one execution surface" rule forbids any OTHER call site from
    // invoking the hub's dispatch method directly), never by calling
    // Open-Meteo directly.
    withTimeout(async () => {
      const dispatch = deps.dispatch;
      if (typeof dispatch !== 'function') return null;
      const res = await dispatch('get_weather', {});
      if (!res || !res.ok || !res.result || typeof res.result !== 'object') return null;
      const w = res.result;
      if (typeof w.temperatureC !== 'number') return null;
      return 'Weather' + (w.location ? ' in ' + w.location : '') + ': ' +
        w.temperatureC + '°C, ' + (w.condition || 'unknown conditions');
    }, timeoutMs),

    // 8. System conditions (NEW) — snapshotSystemMetrics(), the exact metric
    // math server/routes/system.js's /api/system route reports, extracted so
    // both callers share one source of truth instead of two copies drifting.
    // A single snapshot has no earlier os.cpus() sample to diff against (same
    // reason the route's very first request reports cpu.loadPercent:null), so
    // the two-sample dance (take one, wait systemSampleGapMs, diff a second
    // against the first) now lives in sampledSystemMetrics() alongside
    // snapshotSystemMetrics — shared with system_status (Task B3 code review)
    // instead of being duplicated inline here a second time.
    withTimeout(async () => {
      const snapshot = deps.snapshotSystemMetrics;
      if (typeof snapshot !== 'function') return null;
      const metrics = await sampledSystemMetrics(snapshot, systemSampleGapMs);
      if (!metrics) return null;
      const parts = [];
      if (metrics.cpu && typeof metrics.cpu.loadPercent === 'number') parts.push('CPU ' + metrics.cpu.loadPercent + '%');
      if (metrics.mem && typeof metrics.mem.usedPercent === 'number') parts.push('memory ' + metrics.mem.usedPercent + '%');
      if (!parts.length) return null;
      return 'System: ' + parts.join(', ') + ' in use';
    }, timeoutMs),

    // 9. Spend (NEW) — spend.getStats().today: calls / tokens (both genuinely
    // today-scoped). successRate is NOT today-scoped — it is computed over the
    // whole in-memory recent-call ring buffer (spend.js's getStats()), so it is
    // called out as such rather than attached to "Today so far" as if it shared
    // that scope (code review, 2026-08-13). Deliberately NOT converted to
    // dollars either — there is no pricing table in this repo, and inventing
    // one would state a falsehood.
    withTimeout(() => {
      const spend = deps.spend;
      if (!spend || typeof spend.getStats !== 'function') return null;
      const stats = spend.getStats();
      const today = stats && stats.today;
      if (!today || !today.calls) return null;
      return 'Today so far: ' + today.calls + ' brain calls, ' + (today.tokensIn + today.tokensOut) + ' tokens. ' +
        'Success rate across recent calls (not today-scoped): ' + stats.successRate + '%.';
    }, timeoutMs),

    // 10. Needs-done (NEW) — one line combining active goals + kanban
    // backlog/building cards + pending proposals + due reminders.
    withTimeout(async () => {
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
    }, timeoutMs),
  ]);

  // 4. gitRef upgrade delta — precomputed once at boot by the caller
  // (server/index.js's bootUpgrade), no I/O here to time-box, so it is not
  // part of the Promise.all above.
  const bootUpgrade = deps.bootUpgrade;
  const upgradeFact = (bootUpgrade && bootUpgrade.upgraded)
    ? 'You received a code upgrade since your last boot' +
      (bootUpgrade.changes && bootUpgrade.changes.length ? ' — recent changes: ' + bootUpgrade.changes.join('; ') : '')
    : null;

  // 5. Update report (TASK B1) — precomputed once at boot by the caller from
  // MYTHOS_UPDATE_RESULT via getUpdateReport(), no I/O here either.
  const updateReport = deps.updateReport;
  const updateFact = updateReport
    ? (updateReport.completed
      ? 'I was updated to v' + updateReport.version +
        (updateReport.releaseNotes ? ' — ' + updateReport.releaseNotes : '')
      : 'an update to v' + updateReport.version + ' did not complete — still on v' + updateReport.from)
    : null;

  // Original fact order: time, goals, providers, gitRef upgrade, update
  // report, last-conversations, weather, system, spend, needs-done.
  const facts = [];
  if (timeFact) facts.push(timeFact);
  if (goalsFact) facts.push(goalsFact);
  if (providersFact) facts.push(providersFact);
  if (upgradeFact) facts.push(upgradeFact);
  if (updateFact) facts.push(updateFact);
  if (recentFact) facts.push(recentFact);
  if (weatherFact) facts.push(weatherFact);
  if (systemFact) facts.push(systemFact);
  if (spendFact) facts.push(spendFact);
  if (needsDoneFact) facts.push(needsDoneFact);

  // SLOT for a following task (B4): a self-healing summary fact belongs here
  // — appended after needs-done, before the facts are handed to the brain
  // prompt. Deliberately NOT implemented in this task.

  return facts;
}

module.exports = { buildBriefingFacts };
