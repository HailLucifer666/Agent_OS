'use strict';

// immune/healer.js — playbook-driven auto-remediation. Playbooks are DATA, never
// code eval. Per-playbook cooldownMs is the ONLY de-duplication mechanism: upstream
// producers (probes.js, watchdog.js) are allowed — expected — to re-emit the same
// anomaly on every poll; cooldown is what keeps that from becoming a heal storm.

// Task C2 (2026-08-12 live-session finding): reprobe-build-engine's own comment
// says it is "Always ok:true — the action's job is to re-probe and report, not
// to guarantee Hermes comes back online". That is exactly the effector-reports-
// success-without-an-oracle defect dispatch-action.js's evidence contract
// already rejects everywhere else — 'healed: build-engine-failed' was
// announced at 01:05:05 and 02:24:22 while the identical anomaly kept firing
// for another minute (four recurrences each) because the real cause
// (a missing OPENAI_API_KEY) was nothing a reprobe could fix. 60000ms matches
// that observed recurrence window (all four repeats landed inside the same
// minute) and is deliberately equal to this playbook's own cooldownMs below,
// so a verification never outlives the window the cooldown already blocks
// re-application for.
const BUILD_ENGINE_VERIFY_MS = 60000;

const SEED_PLAYBOOKS = [
  {
    id: 'rotate-nim-key',
    title: 'NVIDIA provider key rotation',
    when: { kind: 'provider-down', target: { eq: 'nim' } },
    then: [{ do: 'probe-provider', args: { provider: 'nim', rotateKey: true } }],
    cooldownMs: 60000
  },
  {
    id: 'stall-restart',
    title: 'cortex restart after a stall',
    when: { kind: 'cortex-stall' },
    then: [{ do: 'restart-cortex' }],
    cooldownMs: 30000
  },
  {
    id: 'quota-guard',
    title: 'voice-lane degrade on low Groq quota',
    when: { kind: 'quota-low', target: { eq: 'groq' } },
    then: [{ do: 'degrade-lane', args: { lane: 'voice', removeProvider: 'groq' } }],
    cooldownMs: 300000
  },
  {
    id: 'mem-consolidate',
    title: 'memory consolidation after growth',
    // 50000000 must equal monitor.js's MEMORY_GROWTH_BYTES — see Spec Ambiguities
    // Resolved #19; immune.test.js asserts the two literals stay in sync.
    when: { kind: 'memory-growth', target: { bytes: { gt: 50000000 } } },
    then: [{ do: 'consolidate-memory' }],
    cooldownMs: 600000
  },
  {
    id: 'budget-pause',
    title: 'goal pause on exhausted budget',
    when: { kind: 'budget-exhausted' },
    then: [{ do: 'pause-goal', args: { reason: 'budget-exhausted' } }],
    cooldownMs: 0 // no cooldown — immediate, every time
  },
  {
    id: 'effector-flapping-breaker',
    title: 'suppression of a flapping tool',
    when: { kind: 'effector-flapping' },
    then: [{ do: 'suppress-tool', args: { tool: '$target' } }],
    cooldownMs: 60000
  },
  // REMEDIATION P2-10 (2026-07-29 audit, item 11): search-provider-failed and
  // build-engine-failed both returned 'no-match' — the immune system detected
  // the two failures that actually mattered in the audited session and had
  // nothing to do about either. web_search() already retries across its own
  // provider chain within one call (exa -> exa-mcp -> ddg-html -> ddg-lite ->
  // wikipedia), so "retry" is already covered; what the healer adds is
  // skipping a provider that keeps failing on FUTURE calls instead of paying
  // its full PROBE_TIMEOUT every time, and reprobe-build-engine surfaces the
  // item-6 CLI probe diagnostic (ENOENT vs timeout vs exit code) instead of
  // leaving P0-1-class failures undiagnosable.
  {
    id: 'search-provider-degrade',
    title: 'skip of a failing search provider',
    when: { kind: 'search-provider-failed' },
    then: [{ do: 'suppress-search-provider', args: { provider: '$evidence.provider' } }],
    cooldownMs: 30000
  },
  {
    id: 'build-engine-reprobe',
    title: 'build-engine reprobe',
    when: { kind: 'build-engine-failed' },
    then: [{ do: 'reprobe-build-engine' }],
    cooldownMs: 60000,
    // Task C2: reprobe-build-engine cannot prove the anomaly is actually
    // gone (see comment above) — hold the claim open for verifyMs before
    // reporting 'applied'. See createHealer()'s onDiagnosed/checkVerifications.
    verifyMs: BUILD_ENGINE_VERIFY_MS
  },
  // Learning loop closure: reflection.js:215 emits 'recurring-failure' when
  // reflectOnActions spots a repeated failure mode in the action trace. Before
  // this playbook existed, the signal fell through to no-match and died — the
  // agent detected its own repeated mistakes and forgot them. record-lesson
  // makes the failure durable in the Lessons store, where the goal planner
  // (goals/index.js Layer 3) reads it before its next brain call. The cooldown
  // is deliberately short (30s) so a burst of the same failure still records
  // promptly; recordFailure() dedups by trigger so repeated fires increment
  // count rather than spawning duplicate files.
  {
    id: 'recurring-failure-record',
    title: 'recording of a repeated failure as a lesson',
    when: { kind: 'recurring-failure' },
    then: [{ do: 'record-lesson', args: { lesson: '$evidence.detail', source: 'reflection' } }],
    cooldownMs: 30000
  }
];

// ---------------------------------------------------------------------------
// DSL evaluator — equality + lt/gt + nested-field matching (Spec Ambiguities #13)
// ---------------------------------------------------------------------------

function matchClause(clause, value) {
  if (clause === undefined) return true; // an absent `when.target` matches any target
  if (clause !== null && typeof clause === 'object' && !Array.isArray(clause)) {
    if ('eq' in clause) return value === clause.eq;
    if ('lt' in clause) return typeof value === 'number' && value < clause.lt;
    if ('gt' in clause) return typeof value === 'number' && value > clause.gt;
    // Otherwise every key is a nested field name on `value` — recurse.
    for (const key in clause) {
      const nested = value && typeof value === 'object' ? value[key] : undefined;
      if (!matchClause(clause[key], nested)) return false;
    }
    return true;
  }
  return value === clause;
}

function matches(playbook, diagnosis) {
  if (playbook.when.kind !== diagnosis.kind) return false;
  return matchClause(playbook.when.target, diagnosis.target);
}

// $-prefixed string args resolve against the diagnosis via dotted path, e.g.
// '$target' -> diagnosis.target. None of the SEED_PLAYBOOKS above use this — it
// exists for future playbooks and is covered by a dedicated unit test.
function getPath(obj, dottedPath) {
  return dottedPath.split('.').reduce(function(acc, key) {
    return acc && typeof acc === 'object' ? acc[key] : undefined;
  }, obj);
}

function resolveArgs(args, diagnosis) {
  const out = {};
  const source = args || {};
  for (const key in source) {
    const v = source[key];
    out[key] = (typeof v === 'string' && v.charAt(0) === '$') ? getPath(diagnosis, v.slice(1)) : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Action implementations
// ---------------------------------------------------------------------------

// RC#4: tracks degraded lanes with TTL so they auto-restore after the cooldown.
// Keyed by lane name → { env: envVarName, restoreAt: timestamp }
var degradedLanes = {};

// BUG-013: tracks suppressed tools with TTL so they auto-restore after the cooldown.
// Keyed by tool name → { restoreAt: timestamp }. When a tool flaps (circuit breaker opens),
// the healer suppresses it from the planner's available-tool list, forcing the brain to
// choose a different approach on the next decision cycle.
var suppressedTools = {};

// REMEDIATION P2-10: same TTL-map pattern as suppressedTools above, scoped to
// web-search's provider chain instead of the effector-tool catalog. Keyed by
// provider name (e.g. 'ddg-html', 'exa') → { restoreAt: timestamp }.
var suppressedSearchProviders = {};

function buildActions({ getCortex, getGoals, memory }) {
  const registry = require('../brain/registry');
  const { BRAIN_TABLES } = require('../brain/lanes.default');

  return {
    // registry.js has no selective per-provider refresh and no live key-swap
    // capability — NIM's own two-key rotation is already structural in chain.js's
    // expand(). The real, honest action is a full forced re-probe (Spec Ambiguities #11).
    'probe-provider': async function() {
      const status = await registry.refresh(true);
      return { ok: true, result: { probedAt: status.at } };
    },

    'restart-cortex': async function() {
      const cortex = getCortex && getCortex();
      if (!cortex) return { ok: false, reason: 'missing-dependency:cortex' };
      // Pause the active goal BEFORE restarting — cortex.stop()/start() bumps
      // generation but does not touch goal state; recovery invariant #2 (§13)
      // requires the interrupted goal to be marked, not silently re-arbitrated
      // as if nothing happened.
      const goals = getGoals && getGoals();
      const activeGoal = goals && typeof goals.getActive === 'function' ? goals.getActive() : null;
      if (activeGoal) {
        goals.update(activeGoal.id, { status: 'paused', reason: 'cortex-restart' });
      }
      cortex.stop();
      cortex.start();
      return { ok: true, result: { generation: cortex.generation, pausedGoalId: activeGoal ? activeGoal.id : null } };
    },

    // Real mutable seam: registry.js's per-lane env override, read fresh on every
    // chainFor() call (Spec Ambiguity #12).
    // RC#4: track degradation with a TTL so the provider is automatically restored
    // when the cooldown window expires. Previously this permanently mutated
    // process.env[table.env] with no restore path — after one quota-low event, groq
    // was gone from the voice lane until process restart.
    'degrade-lane': async function(diagnosis, args) {
      const table = BRAIN_TABLES[args.lane];
      if (!table) return { ok: false, reason: 'unknown-lane:' + args.lane };
      const kept = table.prefs.filter(function(p) { return p.provider !== args.removeProvider; });
      const override = kept.map(function(p) { return p.provider + ':' + p.model; }).join(',');
      process.env[table.env] = override;
      // Track when this degradation should be reversed (5 min = the quota-guard
      // playbook cooldown). The healer's tick loop checks degradedLanes and
      // restores expired entries via restore-lane.
      degradedLanes[args.lane] = { env: table.env, restoreAt: Date.now() + 300000 };
      return { ok: true, result: { lane: args.lane, removed: args.removeProvider, override: override } };
    },

    // RC#4: restore a degraded lane by clearing the env override so registry.js
    // falls back to the built-in BRAIN_TABLES preference list.
    'restore-lane': async function(diagnosis, args) {
      var entry = degradedLanes[args.lane];
      if (!entry) return { ok: false, reason: 'lane-not-degraded:' + args.lane };
      delete process.env[entry.env];
      delete degradedLanes[args.lane];
      return { ok: true, result: { lane: args.lane, restored: true } };
    },

    'consolidate-memory': async function() {
      if (!memory || typeof memory.consolidate !== 'function') {
        return { ok: false, reason: 'missing-dependency:memory' };
      }
      const stats = await memory.consolidate({});
      return { ok: true, result: stats };
    },

    // Idempotent: goals/index.js's debitBudget() already self-pauses synchronously
    // on budget exhaustion (Spec Ambiguities #9) — this confirms/audits, never
    // double-transitions.
    'pause-goal': async function(diagnosis, args) {
      const goals = getGoals && getGoals();
      if (!goals) return { ok: false, reason: 'missing-dependency:goals' };
      const goalId = diagnosis.target;
      const goal = goals.get(goalId);
      if (!goal) return { ok: false, reason: 'unknown-goal:' + goalId };
      if (goal.status !== 'paused') {
        goals.update(goalId, { status: 'paused', reason: args.reason || 'healer-pause' });
      }
      return { ok: true, result: { goalId: goalId, reason: args.reason || 'healer-pause' } };
    },

    // BUG-013: suppress a flapping tool for its cooldown window. When a tool's circuit
    // breaker opens (repeated failures), the healer injects it into the suppressedTools
    // map so the planner's next brain call excludes it from the available-tool list.
    // The planner checks suppressedTools() (exported below) and filters them out.
    'suppress-tool': async function(diagnosis, args) {
      const toolName = args.tool;
      if (!toolName) return { ok: false, reason: 'missing-arg:tool' };
      // Track the suppression with a TTL (cooldown window from the playbook).
      // The tick loop's restoreTimer (RC#4) also restores expired suppressions.
      suppressedTools[toolName] = { restoreAt: Date.now() + 60000 };
      return { ok: true, result: { tool: toolName, suppressedUntil: suppressedTools[toolName].restoreAt } };
    },

    // REMEDIATION P2-10: web_search() already retries across its full provider
    // chain within one call — this action's job is to make the NEXT call skip
    // a provider that just failed (saving a wasted PROVIDER_TIMEOUT) rather
    // than re-attempting a known-currently-bad endpoint. web-search.js checks
    // isSearchProviderSuppressed() before trying each provider.
    'suppress-search-provider': async function(diagnosis, args) {
      const provider = args.provider;
      if (!provider) return { ok: false, reason: 'missing-arg:provider' };
      suppressedSearchProviders[provider] = { restoreAt: Date.now() + 30000 };
      return { ok: true, result: { provider: provider, suppressedUntil: suppressedSearchProviders[provider].restoreAt } };
    },

    // REMEDIATION P2-10 / P0-1: force a fresh Hermes probe (bypassing
    // PROBE_TTL_MS's cache) and surface the item-6 CLI probe diagnostic
    // (ENOENT vs timeout vs non-zero exit) instead of leaving a build-engine
    // failure with no path to re-check or diagnose it. Always ok:true — the
    // action's job is to re-probe and report, not to guarantee Hermes comes
    // back online (that's the OFFLINE/ONLINE result inside detail).
    'reprobe-build-engine': async function() {
      var hermesAgent;
      try {
        hermesAgent = require('../../../adapters/hermes-agent');
      } catch (err) {
        return { ok: false, reason: 'missing-dependency:hermes-agent', detail: err.message };
      }
      const online = await hermesAgent.probe(true);
      const status = hermesAgent.getStatus();
      return { ok: true, result: { online: online, state: status.state, hint: status.hint, cliProbeDiagnostic: status.cliProbeDiagnostic } };
    },

    // Learning loop: write a recurring-failure lesson so the planner can avoid
    // it next time. The recurring-failure anomaly (reflection.js:215) carries a
    // one-line `detail` describing the failure mode; recordFailure() dedups by
    // trigger so repeated fires of the same mode increment count, not files.
    // best-effort — never fails the heal if the store is unavailable.
    'record-lesson': async function(diagnosis, args) {
      if (!memory || !memory.lessons || typeof memory.lessons.recordFailure !== 'function') {
        return { ok: false, reason: 'missing-dependency:lessons' };
      }
      var lesson = args && args.lesson;
      if (!lesson) return { ok: false, reason: 'missing-arg:lesson' };
      // The recurring-failure anomaly has no structured trigger (just a prose
      // detail), so we key on the detail itself — recordFailure still dedups
      // by trigger identity across repeated fires.
      var trigger = { tool: '', argsHash: '0', goalTitle: String(lesson).slice(0, 60) };
      try {
        var res = memory.lessons.recordFailure(trigger, lesson, { source: args.source || 'reflection' });
        return { ok: true, result: { ref: res.ref, count: res.count, isNew: res.isNew } };
      } catch (err) {
        return { ok: false, reason: 'record-lesson-failed', detail: err.message };
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Healer
// ---------------------------------------------------------------------------

function createHealer({ bus, config, memory, getCortex, getGoals, getEffectors, playbooks, now }) {
  if (!bus) throw new Error('createHealer requires bus');

  const ACTIONS = buildActions({ getCortex: getCortex, getGoals: getGoals, memory: memory });
  const activePlaybooks = playbooks || SEED_PLAYBOOKS;
  const lastFiredAt = {}; // playbook.id -> ts
  // Task C2: injected clock (mirrors planner/daily.js's nowFn seam) so tests
  // can advance the verification window without a real sleep.
  const nowFn = typeof now === 'function' ? now : Date.now;
  // Task C2: playbook.id -> { verifyAt, appliedAt, kind, target, detail, title, actions }.
  // A heal that has been applied but not yet confirmed lives here until either
  // checkVerifications() finds no recurrence past verifyAt (-> 'applied'), or
  // onDiagnosed sees the same playbook's cooldown re-tripped while an entry is
  // still here, which IS the recurrence signal (-> 'heal-failed').
  const pendingVerifications = {};
  var restoreTimer = null;

  // Task C2: resolve any pending verification whose window has closed with no
  // recurrence. Called from the 60s restore tick and exposed via _internal so
  // tests can resolve it on demand against an injected clock instead of a
  // real wait.
  function checkVerifications() {
    var ts = nowFn();
    Object.keys(pendingVerifications).forEach(function(playbookId) {
      var pending = pendingVerifications[playbookId];
      if (pending.verifyAt > ts) return;
      delete pendingVerifications[playbookId];
      bus.emit('health.healed', {
        playbookId: playbookId, kind: pending.kind, target: pending.target, outcome: 'applied', detail: pending.detail,
        title: pending.title, actions: pending.actions
      });
      if (memory && memory.audit && typeof memory.audit.write === 'function') {
        memory.audit.write({
          actor: 'healer', decision: 'heal', tool: null, playbookId: playbookId,
          kind: pending.kind, target: pending.target, outcome: 'applied', detail: pending.detail
        });
      }
    });
  }

  async function applyPlaybook(playbook, diagnosis) {
    let outcome = 'applied';
    let detail = null;
    try {
      for (let i = 0; i < playbook.then.length; i++) {
        const step = playbook.then[i];
        const action = ACTIONS[step.do];
        if (!action) { outcome = 'error'; detail = { reason: 'unknown-action:' + step.do }; break; }
        const args = resolveArgs(step.args, diagnosis);
        const result = await action(diagnosis, args);
        if (!result || !result.ok) { outcome = 'error'; detail = result; break; }
        detail = result.result;
      }
    } catch (err) {
      outcome = 'error';
      detail = { error: err.message };
    }
    return { outcome: outcome, detail: detail };
  }

  async function onDiagnosed(event) {
    const diagnosis = event.payload;
    const playbook = activePlaybooks.find(function(p) { return matches(p, diagnosis); });

    let outcome, detail, playbookId;
    if (!playbook) {
      outcome = 'no-match';
      detail = null;
      playbookId = null;
    } else {
      playbookId = playbook.id;
      const ts = nowFn();
      const lastFired = lastFiredAt[playbook.id] || 0;
      if (playbook.cooldownMs > 0 && ts - lastFired < playbook.cooldownMs) {
        // Task C2: this diagnosis landing on cooldown WHILE a heal for this
        // exact playbook is still pending verification is the recurrence
        // itself — the anomaly the healer just claimed to fix is still
        // firing. Correct the earlier claim now rather than waiting out the
        // rest of the window.
        if (pendingVerifications[playbook.id]) {
          outcome = 'heal-failed';
          detail = { reason: 'anomaly-recurred-during-verification', recurredAfterMs: ts - pendingVerifications[playbook.id].appliedAt };
          delete pendingVerifications[playbook.id];
        } else {
          outcome = 'cooldown';
          detail = { remainingMs: playbook.cooldownMs - (ts - lastFired) };
        }
      } else {
        lastFiredAt[playbook.id] = ts;
        const applied = await applyPlaybook(playbook, diagnosis);
        if (applied.outcome === 'applied' && playbook.verifyMs) {
          // Task C2: an action reporting ok:true is not proof the anomaly is
          // gone (see reprobe-build-engine's own comment) — hold the claim
          // open until verifyMs passes with no recurrence.
          pendingVerifications[playbook.id] = {
            appliedAt: ts, verifyAt: ts + playbook.verifyMs,
            kind: diagnosis.kind, target: diagnosis.target, detail: applied.detail,
            title: playbook.title || null, actions: playbook.then.map(function(s) { return s.do; })
          };
          outcome = 'verifying';
          detail = applied.detail;
        } else {
          outcome = applied.outcome;
          detail = applied.detail;
        }
      }
    }

    // 'health.healed' — exact string, do not paraphrase.
    // BUG-162: carry the playbook's human title and its action list so the
    // announcer can say WHAT was healed. "Self-healed: recurring-failure-record."
    // was the operator's entire explanation on 2026-08-07 (incident 04:27), and
    // when they asked what it fixed, nothing downstream could answer.
    bus.emit('health.healed', {
      playbookId: playbookId, kind: diagnosis.kind, target: diagnosis.target, outcome: outcome, detail: detail,
      title: playbook ? (playbook.title || null) : null,
      actions: playbook ? playbook.then.map(function(s) { return s.do; }) : [],
    });

    if (memory && memory.audit && typeof memory.audit.write === 'function') {
      // BUG-125: healer rows land in the same Audit/*.jsonl stream as the
      // leash's tool rows, and a healer row has no tool by nature — it records
      // a playbook decision, not a dispatch. Omitting the field entirely made
      // readers render `tool: undefined`, which is indistinguishable from a
      // dispatch that lost its tool name on the way to the audit. An explicit
      // null says "there is deliberately no tool here".
      memory.audit.write({
        actor: 'healer', decision: 'heal', tool: null, playbookId: playbookId,
        kind: diagnosis.kind, target: diagnosis.target, outcome: outcome, detail: detail
      });
    }
  }

  let unsubscribe = null;

  function start() {
    unsubscribe = bus.subscribe('health.diagnosed', onDiagnosed);
    // RC#4: periodic check for expired lane degradations. Every 60s, if a
    // degraded lane's restoreAt has passed, clear the env override so the
    // registry falls back to the built-in preference list (re-adding groq etc.).
    // Also restores suppressed tools (BUG-013) when their cooldown expires.
    restoreTimer = setInterval(function() {
      var now = Date.now();
      Object.keys(degradedLanes).forEach(function(lane) {
        if (degradedLanes[lane].restoreAt <= now) {
          var entry = degradedLanes[lane];
          delete process.env[entry.env];
          delete degradedLanes[lane];
          bus.emit('health.healed', {
            playbookId: 'lane-restore', title: 'brain lane restored after quota recovery', kind: 'quota-recovered',
            target: lane, outcome: 'applied', detail: { restored: true }
          });
        }
      });
      // BUG-013: restore suppressed tools after cooldown expires
      Object.keys(suppressedTools).forEach(function(toolName) {
        if (suppressedTools[toolName].restoreAt <= now) {
          delete suppressedTools[toolName];
          // Reset the effector's circuit breaker so the FSM matches the tool's
          // restored state. Without this the breaker stays OPEN/HALF_OPEN
          // (recordSuccess() is never called because the tool was suppressed
          // and never dispatched), so broadcastHealth keeps reporting it as
          // open and the HUD shows "degraded" indefinitely after a heal.
          // This is the missing state transition reported 2026-07-31.
          if (getEffectors) {
            try { getEffectors().breakers.reset(toolName); } catch (_) { /* tool may not have a breaker */ }
          }
          bus.emit('health.healed', {
            playbookId: 'tool-restore', title: 'suppressed tool restored', kind: 'tool-unsuppressed',
            target: toolName, outcome: 'applied', detail: { restored: true }
          });
        }
      });
      // REMEDIATION P2-10: restore suppressed search providers after cooldown.
      Object.keys(suppressedSearchProviders).forEach(function(provider) {
        if (suppressedSearchProviders[provider].restoreAt <= now) {
          delete suppressedSearchProviders[provider];
          bus.emit('health.healed', {
            playbookId: 'search-provider-restore', title: 'search provider restored', kind: 'search-provider-unsuppressed',
            target: provider, outcome: 'applied', detail: { restored: true }
          });
        }
      });
      // Task C2: same TTL-tick pattern, resolving any heal that has held its
      // verification window with no recurrence.
      checkVerifications();
    }, 60000);
    if (restoreTimer.unref) restoreTimer.unref();
  }

  function stop() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (restoreTimer) { clearInterval(restoreTimer); restoreTimer = null; }
  }

  return {
    start: start, stop: stop,
    _internal: {
      ACTIONS: ACTIONS, lastFiredAt: lastFiredAt, applyPlaybook: applyPlaybook,
      pendingVerifications: pendingVerifications, checkVerifications: checkVerifications
    }
  };
}

function isToolSuppressed(toolName) {
  if (!suppressedTools[toolName]) return false;
  const now = Date.now();
  if (suppressedTools[toolName].restoreAt <= now) {
    delete suppressedTools[toolName];
    return false;
  }
  return true;
}

// P6 Jarvis upgrade: lets immune/explainer.js apply the same suppression the
// 'suppress-tool' playbook action uses (same map, same TTL semantics, same
// restore path via the tick loop) without reaching into the ACTIONS closure.
function suppressTool(toolName, ttlMs) {
  if (!toolName) return false;
  suppressedTools[toolName] = { restoreAt: Date.now() + (ttlMs || 60000) };
  return true;
}

// REMEDIATION P2-10: same isToolSuppressed()/suppressTool() pattern, scoped to
// web-search's provider chain — web-search.js calls isSearchProviderSuppressed()
// before attempting each provider so a provider degraded by the
// search-provider-degrade playbook is actually skipped, not just logged.
function isSearchProviderSuppressed(provider) {
  if (!suppressedSearchProviders[provider]) return false;
  const now = Date.now();
  if (suppressedSearchProviders[provider].restoreAt <= now) {
    delete suppressedSearchProviders[provider];
    return false;
  }
  return true;
}

function suppressSearchProvider(provider, ttlMs) {
  if (!provider) return false;
  suppressedSearchProviders[provider] = { restoreAt: Date.now() + (ttlMs || 30000) };
  return true;
}

module.exports = {
  createHealer: createHealer, SEED_PLAYBOOKS: SEED_PLAYBOOKS,
  matchClause: matchClause, matches: matches, resolveArgs: resolveArgs, getPath: getPath,
  isToolSuppressed: isToolSuppressed, suppressTool: suppressTool,
  isSearchProviderSuppressed: isSearchProviderSuppressed, suppressSearchProvider: suppressSearchProvider
};
