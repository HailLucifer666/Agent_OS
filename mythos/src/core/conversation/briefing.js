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

// Self-healing fact (#11 below) window bounds. server/index.js reads
// Identity/last-boot.json's PREVIOUS bootDate before overwriting it with the
// current one (same file bootUpgrade already diffs gitRef against) and
// passes that as deps.previousBootAt — the real "since this entity was last
// alive" instant, not a guess. DEFAULT_SELF_HEALING_WINDOW_MS is the fallback
// for a first run (no previous boot recorded yet) or an unparseable
// timestamp. MAX_SELF_HEALING_WINDOW_MS caps how far back an unusually long
// gap between boots (machine off for days/weeks) can reach, so a stale heal
// from a much earlier session never gets reported as if it just happened.
const DEFAULT_SELF_HEALING_WINDOW_MS = 24 * 3600 * 1000; // 24h
const MAX_SELF_HEALING_WINDOW_MS = 7 * 24 * 3600 * 1000; // 7 days
// query({decision:'heal', limit}) walks newest-first and stops at `limit`
// matches for decision:'heal' regardless of outcome — onDiagnosed writes
// that decision for every diagnosis (no-match/cooldown/verifying/heal-failed
// too, not just applied heals), so a noisy window can fill the cap with
// non-applied rows and push genuine in-window applied heals out of the
// result set. Raised well past the old 200 so that's rare in practice, but
// truncation is still DETECTED (see the fact body) rather than assumed away.
const SELF_HEALING_QUERY_LIMIT = 500;

// Runs fn() with a hard ~ms timeout via a real Promise.race. Resolves null on
// timeout OR on any thrown/rejected error from fn() — callers treat null as
// "skip this fact", never as a reason to fail the whole briefing.
function withTimeout(fn, ms) {
  const guarded = Promise.resolve().then(fn).catch(() => null);
  // BUG-259 (2026-08-16): the timer must stay REF'D. It was unref()'d here,
  // which silently removed the guarantee this helper exists to provide: in a
  // process with nothing else holding the event loop (exactly the test-runner
  // child on CI's Node 22), the loop drained before the timer fired, the race
  // never settled, and the runner killed the pending test ("Promise resolution
  // is still pending but the event loop has already resolved"), cascading
  // cancelledByParent through ~64 sibling tests and failing CI's test-count
  // gate on every push since 2026-08-13 while local Node 24 runs stayed green.
  // A ref'd timer fires at ms and closes its handle; the only thing unref ever
  // bought was skipping a ≤timeoutMs wait at process exit for a hung source.
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve(null), ms);
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
    selfHealingFact,
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

    // 11. Self-healing since last boot (TASK B4, revised in code review) —
    // summarizes what the immune system's healer.js playbooks did, read from
    // the PERSISTENT audit trail via `memory.audit.query`, never from
    // `bus.emit('health.healed', ...)` — that event is a stream-only signal
    // with nothing listening at boot time, so it cannot answer "what
    // happened while nobody was watching". The window is genuinely
    // since-last-boot via deps.previousBootAt (see the constants above),
    // falling back to DEFAULT_SELF_HEALING_WINDOW_MS only when that isn't
    // available. A heal audit record (see healer.js) carries only
    // playbookId/kind/target/outcome/detail — no human-facing playbook
    // title — so the fact names playbooks by their own recorded id (hyphens
    // turned to spaces for speech), never a friendlier name that would have
    // to be invented. Only outcome === 'applied' counts as "healed": an
    // 'error' outcome means the playbook ran and did NOT fix anything, so
    // it is excluded rather than reported as a heal.
    withTimeout(async () => {
      const memory = deps.memory;
      if (!memory || !memory.audit || typeof memory.audit.query !== 'function') return null;

      const previousBootAt = typeof deps.previousBootAt === 'number' ? deps.previousBootAt : null;
      let windowMs = DEFAULT_SELF_HEALING_WINDOW_MS;
      if (previousBootAt !== null) {
        const sinceLastBoot = Date.now() - previousBootAt;
        if (sinceLastBoot > 0) windowMs = Math.min(sinceLastBoot, MAX_SELF_HEALING_WINDOW_MS);
      }
      const cutoff = Date.now() - windowMs;

      const records = await memory.audit.query({ decision: 'heal', limit: SELF_HEALING_QUERY_LIMIT });
      if (!Array.isArray(records)) return null;

      const applied = records.filter((r) => (
        r && r.outcome === 'applied' && typeof r.ts === 'number' && r.ts >= cutoff
      ));
      if (!applied.length) return null;

      // Truncation check: query() returns newest-first, so if the OLDEST
      // record it handed back is still inside the window, the cap was hit
      // before the window was fully covered — the true in-window count (and
      // possibly which playbooks ran) could be larger than what we can see.
      const oldest = records[records.length - 1];
      const truncated = records.length >= SELF_HEALING_QUERY_LIMIT &&
        oldest && typeof oldest.ts === 'number' && oldest.ts >= cutoff;

      const counts = {};
      applied.forEach((r) => {
        const id = String(r.playbookId || 'unknown-playbook');
        counts[id] = (counts[id] || 0) + 1;
      });

      // Bound the number of distinct playbooks NAMED in the sentence — same
      // precedent as the last-conversations fact's slice(0, 3) and
      // needs-done's four fixed sub-counts. This feeds an LLM prompt.
      const MAX_PLAYBOOK_CLAUSES = 3;
      const ids = Object.keys(counts);
      const parts = ids.slice(0, MAX_PLAYBOOK_CLAUSES).map((id) => {
        const n = counts[id];
        return id.replace(/-/g, ' ') + ' ' + (n === 1 ? 'once' : n + ' times');
      });
      if (ids.length > MAX_PLAYBOOK_CLAUSES) parts.push((ids.length - MAX_PLAYBOOK_CLAUSES) + ' more');

      // Describe the ACTUAL window instead of a hardcoded "24h" — must stay
      // true once previousBootAt makes the window something other than the
      // fallback (the same rule that forced the spend fact's "not
      // today-scoped" wording).
      const windowHours = Math.max(1, Math.round(windowMs / 3600000));
      const scope = 'in the last ' + windowHours + (windowHours === 1 ? ' hour' : ' hours');

      // Never silently under-claim: when the query cap means genuine
      // in-window heals could exist beyond what we saw, say "at least"
      // instead of stating applied.length as if it were the full count.
      const countPhrase = (truncated ? 'at least ' : '') + applied.length + (applied.length === 1 ? ' heal' : ' heals');

      return 'Self-healing ' + scope + ': ' + countPhrase + ' — ' + parts.join(', ') + '.';
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
  // report, last-conversations, weather, system, spend, needs-done,
  // self-healing (TASK B4 — appended last).
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
  if (selfHealingFact) facts.push(selfHealingFact);

  return facts;
}

// BUG-423: a greeting once invented a refreshed Gmail token immediately before
// the same process reported reauthentication required. Only the supplied facts count.
const GREETING_FACT_DISCIPLINE = 'State only facts explicitly listed below. Never invent completed repairs, refreshed tokens, connectivity, or successful checks. Omit anything not listed. ';
// BUG-447 (2026-09-23): a weeks-long operator was greeted with "Allow me to
// introduce myself" — the prompt never said whether they had met. The previous
// boot's record (Identity/last-boot.json, read into `previousBootAt`) is the
// evidence that they have: it exists from the second boot on.
function greetingRelationshipClause(previousBootAt) {
  if (Number.isFinite(previousBootAt)) {
    return 'You and the operator already know each other — you have run on this machine before. '
      + 'Do NOT introduce yourself or explain what you are; greet them as someone you work with every day. ';
  }
  return 'This is your first boot with this operator: introduce yourself in half a sentence, then give the status. ';
}

module.exports = { buildBriefingFacts, GREETING_FACT_DISCIPLINE, greetingRelationshipClause };
