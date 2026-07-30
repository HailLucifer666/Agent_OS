'use strict';

// leash-grant-scope.test.js — the per-goal T3 grant must be scoped to the
// SPECIFIC tools a human actually approved, never to the whole tier.
//
// THE BUG THIS FILE EXISTS FOR (found by a security review, 2026-07-31).
// goals.grantTier(id, 3) used to set `goal.grants['3'] = true` — a bare boolean
// with no tool restriction — and leash.check() used to honour it by asking only
// "does this goalId have grants['3']?", never "was THIS tool what the human
// approved?". Approving one Forge build plan therefore handed the goal a
// standing pass for EVERY T3 tool that later carried the same goalId:
// gmail_send, delete_file, run_command, phone_call, phone_sms_send,
// browser_click, install_from_github, hermes_task, and the rest.
//
// That was reachable two ways without any external attacker:
//   1. engagements/executor.js runs `kind:'action'` stages whose {tool,args}
//      pairs come straight from an LLM (plan-builder.js's buildViaBrain) with
//      no allowlist beyond "has a tool string", and calls
//      leash.check(decision, {goalId: record.goalId}). Any untrusted text that
//      reaches spec.markdown (interview answers, ingested docs, fetched web
//      content) could steer that stage JSON — a prompt-injection path to
//      unconfirmed T3 execution.
//   2. cortex/index.js passes {goalId: working.activeGoalId} on every tick, so
//      while a previously-approved build's goal stayed active, cortex's own
//      autonomous decisions for unrelated T3 tools executed with no human.
//
// The fix: grants['3'] is now an ARRAY of tool names (array, not Set — the goal
// record is persisted as JSON and a Set serialises to {}). A grant matches only
// when it names the tool being checked. A legacy boolean grant read off an
// older vault is deliberately NOT honoured — it fails closed to a re-confirm
// and emits an anomaly, because there is no way to recover which tools the
// human originally saw.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function realBus() {
  const { createBus } = require('../src/core/bus');
  return createBus({ historySize: 100 });
}

function fakeConfig(overrides) {
  return Object.assign({
    AUTONOMOUS_MAX_TIER: 2,
    MYTHOS_DRY_RUN: false,
    LEASH_CONFIRM_TTL_MS: 30000,
    CHECKPOINT_TTL_MS: 1800000
  }, overrides);
}

function noopIdentity() {
  return { checkBoundary: function() { return null; }, getMaxAutonomousTier: function() { return 4; } };
}

function noopEffectors() {
  return { get: function() { return undefined; } };
}

function recordingAuditWriter() {
  const writes = [];
  return { write: function(e) { writes.push(e); return { ok: true }; }, _writes: function() { return writes; } };
}

function fakeFs() {
  const store = {};
  return {
    ensureDir: function() {},
    writeJSON: function(rel, data) { store[rel] = JSON.stringify(data); },
    readJSON: function(rel, fallback) { try { return JSON.parse(store[rel]); } catch (_) { return fallback; } },
    readText: function(rel, fallback) { return store[rel] === undefined ? fallback : store[rel]; },
    writeText: function(rel, text) { store[rel] = text; },
    removeFile: function(rel) { delete store[rel]; },
    listFiles: function() { return []; }
  };
}

// One real GoalSystem + one real Leash over a fake vault fs. No mocks of the
// thing under test — this is the same real-instance discipline
// test/leash.test.js's own integration block uses.
function harness(configOverrides) {
  const { createGoalSystem } = require('../src/core/goals');
  const { createLeash } = require('../src/core/leash');
  const bus = realBus();
  const config = fakeConfig(configOverrides);
  const goals = createGoalSystem({ fs: fakeFs(), config: config, bus: bus, memory: null, brain: null });
  const leash = createLeash({
    bus: bus, config: config, identity: noopIdentity(),
    auditWriter: recordingAuditWriter(), goals: goals, effectors: noopEffectors()
  });
  return { bus: bus, config: config, goals: goals, leash: leash };
}

describe('leash T3 grants are tool-scoped, not tier-wide', function() {
  it('a grant for the approved tool auto-allows THAT tool', function() {
    const h = harness();
    const goal = h.goals.create({ title: 'Build a landing page', drive: 'user-service', status: 'active' });

    const before = h.leash.check({ tool: 'build_project', args: {} }, { goalId: goal.id });
    assert.equal(before.allow, false, 'T3 must require confirm before any grant');
    assert.equal(before.requireConfirm, true);

    h.goals.grantTier(goal.id, 3, ['build_project', 'revise_project']);

    const after = h.leash.check({ tool: 'build_project', args: {} }, { goalId: goal.id });
    assert.equal(after.allow, true, 'the granted tool must auto-allow');
    assert.equal(after.requireConfirm, false);
    assert.equal(after.reason, 'goal-granted');

    const sibling = h.leash.check({ tool: 'revise_project', args: {} }, { goalId: goal.id });
    assert.equal(sibling.allow, true, 'every tool named in the same grant must auto-allow');
  });

  // THE SECURITY GATE. This is the assertion the old boolean grant failed.
  it('a grant for one tool does NOT allow any other T3 tool on the same goal', function() {
    const h = harness();
    const goal = h.goals.create({ title: 'Build a landing page', drive: 'user-service', status: 'active' });
    h.goals.grantTier(goal.id, 3, ['build_project']);

    // A deliberately broad sample: outward-facing, destructive, and
    // device-controlling T3 tools that an LLM-authored engagement stage or an
    // autonomous cortex tick could plausibly name.
    const mustStillConfirm = [
      'gmail_send', 'compose_email', 'delete_file', 'move_file', 'copy_file',
      'run_command', 'install_from_github', 'delete_artifact', 'delete_goal',
      'hermes_task', 'ui_click', 'ui_type', 'browser_click', 'browser_type',
      'phone_call', 'phone_sms_send', 'phone_whatsapp_send', 'phone_file_push'
    ];

    const { TIER_TABLE } = require('../src/core/leash/tiers');
    for (const tool of mustStillConfirm) {
      // Guard the fixture itself: if one of these is ever re-tiered below T3
      // this test would silently stop proving anything about it.
      assert.equal(TIER_TABLE[tool], 3, tool + ' must be T3 for this test to mean anything');
      const res = h.leash.check({ tool: tool, args: {} }, { goalId: goal.id });
      assert.equal(res.allow, false, tool + ' must NOT be allowed by a build_project grant');
      assert.equal(res.requireConfirm, true, tool + ' must still require confirm');
      assert.notEqual(res.reason, 'goal-granted', tool + ' must not report goal-granted');
    }
  });

  it('grantTier with no tool list grants nothing (fails closed)', function() {
    const h = harness();
    const goal = h.goals.create({ title: 'Ambiguous grant', drive: 'user-service', status: 'active' });

    h.goals.grantTier(goal.id, 3);

    const res = h.leash.check({ tool: 'build_project', args: {} }, { goalId: goal.id });
    assert.equal(res.allow, false, 'an empty grant must not allow anything');
    assert.equal(res.requireConfirm, true);
  });

  it('a legacy boolean grant on a persisted goal is not honoured, and is reported', function() {
    const h = harness();
    const goal = h.goals.create({ title: 'Goal from an older vault', drive: 'user-service', status: 'active' });

    // Simulate a goal record written before the grant became tool-scoped.
    goal.grants['3'] = true;

    const res = h.leash.check({ tool: 'build_project', args: {} }, { goalId: goal.id });
    assert.equal(res.allow, false, 'a legacy tier-wide grant must fail closed');
    assert.equal(res.requireConfirm, true);

    const anomalies = h.bus.history(function(e) { return e.type === 'health.anomaly'; });
    const legacy = anomalies.filter(function(e) { return e.payload && e.payload.kind === 'goal-grant-legacy-unscoped'; });
    assert.equal(legacy.length, 1, 'ignoring a legacy grant must emit exactly one health.anomaly, not pass silently');
    assert.equal(legacy[0].payload.evidence.tool, 'build_project', 'the anomaly must name the tool that was refused');
  });

  it('a grant on one goal never leaks to a different goal', function() {
    const h = harness();
    const granted = h.goals.create({ title: 'Granted goal', drive: 'user-service', status: 'active' });
    const other = h.goals.create({ title: 'Unrelated goal', drive: 'user-service', status: 'active' });
    h.goals.grantTier(granted.id, 3, ['build_project']);

    const res = h.leash.check({ tool: 'build_project', args: {} }, { goalId: other.id });
    assert.equal(res.allow, false, 'the grant must be scoped to its own goal record');
  });

  it('the grant survives a goal reload from the vault (array persists as JSON)', async function() {
    const { createGoalSystem } = require('../src/core/goals');
    const { createLeash } = require('../src/core/leash');
    const bus = realBus();
    const config = fakeConfig();
    const fs = fakeFs();

    // A listFiles-capable fake so init() can actually reload what create() wrote.
    // Shape matters: goals/index.js's init() reads files[i].path as a vault-
    // relative path, so entries are objects, not bare names.
    const written = [];
    const trackingFs = Object.assign({}, fs, {
      writeJSON: function(rel, data) { if (written.indexOf(rel) === -1) written.push(rel); return fs.writeJSON(rel, data); },
      listFiles: function(dir, ext) {
        if (dir !== 'Goals') return [];
        return written
          .filter(function(r) { return r.indexOf('Goals/') === 0 && (!ext || r.endsWith(ext)); })
          .map(function(r) { return { path: r, name: r.slice('Goals/'.length) }; });
      }
    });

    const goalsA = createGoalSystem({ fs: trackingFs, config: config, bus: bus, memory: null, brain: null });
    const goal = goalsA.create({ title: 'Persisted grant', drive: 'user-service', status: 'active' });
    goalsA.grantTier(goal.id, 3, ['build_project']);

    const goalsB = createGoalSystem({ fs: trackingFs, config: config, bus: bus, memory: null, brain: null });
    await goalsB.init();
    assert.ok(goalsB.get(goal.id), 'fixture check: the goal must actually reload from the fake vault');

    const leash = createLeash({
      bus: bus, config: config, identity: noopIdentity(),
      auditWriter: recordingAuditWriter(), goals: goalsB, effectors: noopEffectors()
    });

    const res = leash.check({ tool: 'build_project', args: {} }, { goalId: goal.id });
    assert.equal(res.allow, true, 'a reloaded goal must keep its tool-scoped grant');
    assert.equal(res.reason, 'goal-granted');
  });
});

describe('checkpoints plan-approval grants only the build tools it disclosed', function() {
  it('approving a plan-approval checkpoint grants a bounded tool list, not all of T3', async function() {
    const { createCheckpointRegistry } = require('../src/core/leash/checkpoints');
    const calls = [];
    const goals = { grantTier: function(id, tier, tools) { calls.push({ id: id, tier: tier, tools: tools }); } };
    const bus = realBus();
    const registry = createCheckpointRegistry({
      config: fakeConfig(), bus: bus,
      auditWriter: recordingAuditWriter(), goals: goals, fs: fakeFs()
    });

    const view = registry.create({ kind: 'plan-approval', title: 'Build X', goalId: 'g1', projectId: 'p1', connectionId: 'system' });
    await registry.accept(view.id, 'system');

    assert.equal(calls.length, 1, 'plan approval must still issue exactly one grant');
    assert.equal(calls[0].tier, 3);
    assert.ok(Array.isArray(calls[0].tools), 'the grant must carry an explicit tool list, never a bare tier');
    assert.ok(calls[0].tools.length > 0, 'the disclosed tool list must not be empty');

    // The disclosed list must stay narrow: build tools only. If a future change
    // widens it, this fails and forces the widening to be deliberate.
    const { TIER_TABLE } = require('../src/core/leash/tiers');
    const forbidden = ['gmail_send', 'run_command', 'delete_file', 'phone_call', 'phone_sms_send', 'install_from_github'];
    for (const tool of forbidden) {
      assert.ok(TIER_TABLE[tool] === 3, tool + ' expected to be T3');
      assert.ok(calls[0].tools.indexOf(tool) === -1, 'a build plan approval must never grant ' + tool);
    }
  });

  it('rejecting a plan-approval checkpoint grants nothing', async function() {
    const { createCheckpointRegistry } = require('../src/core/leash/checkpoints');
    const calls = [];
    const goals = { grantTier: function(id, tier, tools) { calls.push({ id: id, tier: tier, tools: tools }); } };
    const registry = createCheckpointRegistry({
      config: fakeConfig(), bus: realBus(),
      auditWriter: recordingAuditWriter(), goals: goals, fs: fakeFs()
    });

    const view = registry.create({ kind: 'plan-approval', title: 'Build X', goalId: 'g1', projectId: 'p1', connectionId: 'system' });
    await registry.reject(view.id, 'system');

    assert.equal(calls.length, 0, 'a rejected plan must issue no grant at all');
  });
});
