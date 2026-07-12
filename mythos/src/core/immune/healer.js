'use strict';

// immune/healer.js — playbook-driven auto-remediation. Playbooks are DATA, never
// code eval. Per-playbook cooldownMs is the ONLY de-duplication mechanism: upstream
// producers (probes.js, watchdog.js) are allowed — expected — to re-emit the same
// anomaly on every poll; cooldown is what keeps that from becoming a heal storm.

const SEED_PLAYBOOKS = [
  {
    id: 'rotate-nim-key',
    when: { kind: 'provider-down', target: { eq: 'nim' } },
    then: [{ do: 'probe-provider', args: { provider: 'nim', rotateKey: true } }],
    cooldownMs: 60000
  },
  {
    id: 'stall-restart',
    when: { kind: 'cortex-stall' },
    then: [{ do: 'restart-cortex' }],
    cooldownMs: 30000
  },
  {
    id: 'quota-guard',
    when: { kind: 'quota-low', target: { eq: 'groq' } },
    then: [{ do: 'degrade-lane', args: { lane: 'voice', removeProvider: 'groq' } }],
    cooldownMs: 300000
  },
  {
    id: 'mem-consolidate',
    // 50000000 must equal monitor.js's MEMORY_GROWTH_BYTES — see Spec Ambiguities
    // Resolved #19; immune.test.js asserts the two literals stay in sync.
    when: { kind: 'memory-growth', target: { bytes: { gt: 50000000 } } },
    then: [{ do: 'consolidate-memory' }],
    cooldownMs: 600000
  },
  {
    id: 'budget-pause',
    when: { kind: 'budget-exhausted' },
    then: [{ do: 'pause-goal', args: { reason: 'budget-exhausted' } }],
    cooldownMs: 0 // no cooldown — immediate, every time
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
    }
  };
}

// ---------------------------------------------------------------------------
// Healer
// ---------------------------------------------------------------------------

function createHealer({ bus, config, memory, getCortex, getGoals, playbooks }) {
  if (!bus) throw new Error('createHealer requires bus');

  const ACTIONS = buildActions({ getCortex: getCortex, getGoals: getGoals, memory: memory });
  const activePlaybooks = playbooks || SEED_PLAYBOOKS;
  const lastFiredAt = {}; // playbook.id -> ts
  var restoreTimer = null;

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
      const now = Date.now();
      const lastFired = lastFiredAt[playbook.id] || 0;
      if (playbook.cooldownMs > 0 && now - lastFired < playbook.cooldownMs) {
        outcome = 'cooldown';
        detail = { remainingMs: playbook.cooldownMs - (now - lastFired) };
      } else {
        lastFiredAt[playbook.id] = now;
        const applied = await applyPlaybook(playbook, diagnosis);
        outcome = applied.outcome;
        detail = applied.detail;
      }
    }

    // 'health.healed' — exact string, do not paraphrase.
    bus.emit('health.healed', { playbookId: playbookId, kind: diagnosis.kind, target: diagnosis.target, outcome: outcome, detail: detail });

    if (memory && memory.audit && typeof memory.audit.write === 'function') {
      memory.audit.write({
        actor: 'healer', decision: 'heal', playbookId: playbookId,
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
    restoreTimer = setInterval(function() {
      var now = Date.now();
      Object.keys(degradedLanes).forEach(function(lane) {
        if (degradedLanes[lane].restoreAt <= now) {
          var entry = degradedLanes[lane];
          delete process.env[entry.env];
          delete degradedLanes[lane];
          bus.emit('health.healed', {
            playbookId: 'lane-restore', kind: 'quota-recovered',
            target: lane, outcome: 'applied', detail: { restored: true }
          });
        }
      });
    }, 60000);
    if (restoreTimer.unref) restoreTimer.unref();
  }

  function stop() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (restoreTimer) { clearInterval(restoreTimer); restoreTimer = null; }
  }

  return {
    start: start, stop: stop,
    _internal: { ACTIONS: ACTIONS, lastFiredAt: lastFiredAt, applyPlaybook: applyPlaybook }
  };
}

module.exports = {
  createHealer: createHealer, SEED_PLAYBOOKS: SEED_PLAYBOOKS,
  matchClause: matchClause, matches: matches, resolveArgs: resolveArgs, getPath: getPath
};
