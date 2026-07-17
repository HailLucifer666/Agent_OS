'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function fakeBus() {
  var { createBus } = require('../src/core/bus');
  return createBus({ historySize: 100 });
}

function fakeConfig(overrides) {
  return Object.assign({
    AUTONOMOUS_MAX_TIER: 2,
    MYTHOS_DRY_RUN: false,
    LEASH_CONFIRM_TTL_MS: 30000
  }, overrides);
}

function noopIdentity() {
  // getMaxAutonomousTier returns 4 — the highest AUTONOMOUS_MAX_TIER any existing
  // leash test exercises (fakeConfig({AUTONOMOUS_MAX_TIER: 4})), so
  // Math.min(config.AUTONOMOUS_MAX_TIER, 4) never changes any pre-P8 test's
  // observed behavior (P8 delta).
  return { checkBoundary: function() { return null; }, getMaxAutonomousTier: function() { return 4; } };
}

function noopEffectors() {
  return { get: function() { return undefined; } };
}

function recordingAuditWriter(behavior) {
  var writes = [];
  return {
    write: function(entry) {
      writes.push(entry);
      return behavior ? behavior(entry) : { ok: true };
    },
    _writes: function() { return writes; }
  };
}

describe('BUG-008 — open_artifact tiering', function() {
  it('tierOf("open_artifact") resolves to the explicit T2 entry, not the T3 unmapped fallback', function() {
    var { tierOf, TIER_TABLE } = require('../src/core/leash/tiers');
    assert.equal(TIER_TABLE.open_artifact, 2);
    assert.equal(tierOf('open_artifact'), 2);
  });

  it('leash.check() auto-allows open_artifact on the voice ctx shape ({}, no goalId)', function() {
    var { createLeash } = require('../src/core/leash');
    var leash = createLeash({
      bus: fakeBus(), config: fakeConfig(), identity: noopIdentity(),
      auditWriter: recordingAuditWriter(), goals: { get: function() { return null; } },
      effectors: noopEffectors()
    });
    // Mirrors voice-agent.js executeAction(): leash.check(decision, {}) — no goalId.
    var result = leash.check({ tool: 'open_artifact', args: { path: '/vault/builds/x.html' } }, {});
    assert.equal(result.allow, true);
    assert.equal(result.requireConfirm, false);
    assert.equal(result.tier, 2);
    assert.equal(result.reason, 'within-autonomous-max');
  });

  it('leash.check() auto-allows open_artifact on the cortex ctx shape ({goalId}) identically to voice', function() {
    var { createLeash } = require('../src/core/leash');
    var leash = createLeash({
      bus: fakeBus(), config: fakeConfig(), identity: noopIdentity(),
      auditWriter: recordingAuditWriter(), goals: { get: function() { return null; } },
      effectors: noopEffectors()
    });
    // Mirrors cortex/index.js act(): leash.check(decision, { goalId: working.activeGoalId }).
    var result = leash.check({ tool: 'open_artifact', args: { path: '/vault/builds/x.html' } }, { goalId: 'goal-1' });
    assert.equal(result.allow, true);
    assert.equal(result.requireConfirm, false);
    assert.equal(result.tier, 2);
    // Same outcome as the voice ctx shape above — confirms the goalId/{} ctx
    // divergence between the two dispatch paths is inert for a T2 tool: the
    // tier<=maxTier auto-allow branch resolves before goalCtx.goalId is ever
    // consulted (that only happens in the T3 grant-check branch).
  });
});

describe('BUG-012 — session-scoped T3 grants for goal-less (voice) actions', function() {
  function makeLeash() {
    var { createLeash } = require('../src/core/leash');
    return createLeash({
      bus: fakeBus(), config: fakeConfig(), identity: noopIdentity(),
      auditWriter: recordingAuditWriter(), goals: { get: function() { return null; } },
      effectors: noopEffectors()
    });
  }

  it('first goal-less ui_click requires confirm; after accept, the next one on the SAME connection is session-granted', function() {
    // ui_click is the worked example here (not spotify_play — spotify_play/
    // spotify_search were re-tiered T3 -> T2 in the confirmation-policy pass
    // and now auto-allow before this branch is ever reached; ui_click stays
    // T3 and session-grantable).
    var leash = makeLeash();
    var first = leash.check({ tool: 'ui_click', args: { x: 1 } }, { connectionId: 'conn-1' });
    assert.equal(first.requireConfirm, true);
    assert.equal(first.reason, 'tier-3-requires-confirm');

    // Simulate the user accepting the confirm (same flow as handleConfirmReply).
    var confirmId = leash.confirm.create('click x', { tool: 'ui_click', args: { x: 1 } }, 'conn-1');
    var accepted = leash.confirm.accept(confirmId, 'conn-1');
    assert.ok(accepted, 'confirm accept returns the action');

    var second = leash.check({ tool: 'ui_click', args: { x: 2 } }, { connectionId: 'conn-1' });
    assert.equal(second.allow, true);
    assert.equal(second.requireConfirm, false);
    assert.equal(second.reason, 'session-granted');
  });

  it('outward-facing T3 tools (gmail_send) are NOT session-grantable — confirm every time', function() {
    var leash = makeLeash();
    var confirmId = leash.confirm.create('send mail', { tool: 'gmail_send', args: {} }, 'conn-1');
    leash.confirm.accept(confirmId, 'conn-1');
    var next = leash.check({ tool: 'gmail_send', args: {} }, { connectionId: 'conn-1' });
    assert.equal(next.requireConfirm, true, 'gmail_send must keep asking even after a prior accept');
    assert.equal(next.reason, 'tier-3-requires-confirm');
  });

  it('a session grant for one tool does not leak to another tool on the same connection', function() {
    var leash = makeLeash();
    var confirmId = leash.confirm.create('click x', { tool: 'ui_click', args: {} }, 'conn-1');
    leash.confirm.accept(confirmId, 'conn-1');
    var other = leash.check({ tool: 'click_at', args: {} }, { connectionId: 'conn-1' });
    assert.equal(other.requireConfirm, true, 'click_at was never individually accepted');
  });

  it('a session grant on connection A does not satisfy the same tool on connection B (per-connection scoping)', function() {
    var leash = makeLeash();
    var confirmId = leash.confirm.create('click x', { tool: 'ui_click', args: {} }, 'conn-A');
    leash.confirm.accept(confirmId, 'conn-A');

    // conn-A itself is now granted...
    var sameConn = leash.check({ tool: 'ui_click', args: {} }, { connectionId: 'conn-A' });
    assert.equal(sameConn.requireConfirm, false, 'conn-A accepted its own confirm — must be session-granted');

    // ...but conn-B (a second open tab) never accepted anything and must still confirm.
    var otherConn = leash.check({ tool: 'ui_click', args: {} }, { connectionId: 'conn-B' });
    assert.equal(otherConn.requireConfirm, true, 'conn-B must not inherit conn-A\'s grant');
    assert.equal(otherConn.reason, 'tier-3-requires-confirm');
  });

  it('a goal-less check with no connectionId (autonomous/cortex path) never matches any session grant', function() {
    var leash = makeLeash();
    var confirmId = leash.confirm.create('click x', { tool: 'ui_click', args: {} }, 'conn-1');
    leash.confirm.accept(confirmId, 'conn-1');

    // Autonomous/cortex calls pass {goalId} with no connectionId at all.
    var autonomous = leash.check({ tool: 'ui_click', args: {} }, { goalId: 'goal-9' });
    assert.equal(autonomous.requireConfirm, true, 'no connectionId must never match a connection-scoped grant');
  });
});

describe('leash/index — tier gates', function() {
  it('T0 tools auto-allow, no confirm', function() {
    var { createLeash } = require('../src/core/leash');
    var leash = createLeash({
      bus: fakeBus(), config: fakeConfig(), identity: noopIdentity(),
      auditWriter: recordingAuditWriter(), goals: { get: function() { return null; } },
      effectors: noopEffectors()
    });
    var result = leash.check({ tool: 'read_file', args: {} }, { goalId: null });
    assert.equal(result.allow, true);
    assert.equal(result.requireConfirm, false);
    assert.equal(result.tier, 0);
  });

  it('T4 always requires confirm, even with a matching grant', function() {
    var { createLeash } = require('../src/core/leash');
    var goal = { id: 'goal-1', grants: { '4': true } };
    var leash = createLeash({
      bus: fakeBus(), config: fakeConfig(), identity: noopIdentity(),
      auditWriter: recordingAuditWriter(), goals: { get: function() { return goal; } },
      effectors: noopEffectors()
    });
    var result = leash.check({ tool: 'kill_session', args: {} }, { goalId: 'goal-1' });
    assert.equal(result.allow, false);
    assert.equal(result.requireConfirm, true);
    assert.equal(result.tier, 4);
    assert.equal(result.reason, 'tier-4-always-confirm');
  });

  it('dry-run makes T>=1 a logged no-op', function() {
    var { createLeash } = require('../src/core/leash');
    var audit = recordingAuditWriter();
    var leash = createLeash({
      bus: fakeBus(), config: fakeConfig({ MYTHOS_DRY_RUN: true }), identity: noopIdentity(),
      auditWriter: audit, goals: { get: function() { return null; } }, effectors: noopEffectors()
    });
    var result = leash.check({ tool: 'create_goal', args: {} }, { goalId: null });
    assert.equal(result.allow, false);
    assert.equal(result.reason, 'dry-run');
    assert.equal(audit._writes()[0].decision, 'dry-run');
  });

  it('security-audit regression: dry-run still no-ops an unmapped tool name even when AUTONOMOUS_MAX_TIER allows T3', function() {
    // Unknown tools resolve to T3 fail-safe. Before this fix, `tier` was still
    // `undefined` at the DRY_RUN check (`undefined >= 1` is false in JS), so an
    // unmapped tool name skipped the DRY_RUN no-op and fell through to a real
    // auto-allow once AUTONOMOUS_MAX_TIER >= 3.
    var { createLeash } = require('../src/core/leash');
    var audit = recordingAuditWriter();
    var leash = createLeash({
      bus: fakeBus(), config: fakeConfig({ MYTHOS_DRY_RUN: true, AUTONOMOUS_MAX_TIER: 4 }), identity: noopIdentity(),
      auditWriter: audit, goals: { get: function() { return null; } }, effectors: noopEffectors()
    });
    var result = leash.check({ tool: 'totally_unmapped_tool', args: {} }, { goalId: null });
    assert.equal(result.allow, false, 'unmapped tool must still be a dry-run no-op, not auto-allowed');
    assert.equal(result.reason, 'dry-run');
    assert.equal(audit._writes()[0].decision, 'dry-run');
  });

  it('writes exactly one audit line per check() call', function() {
    var { createLeash } = require('../src/core/leash');
    var audit = recordingAuditWriter();
    var leash = createLeash({
      bus: fakeBus(), config: fakeConfig(), identity: noopIdentity(),
      auditWriter: audit, goals: { get: function() { return null; } }, effectors: noopEffectors()
    });
    leash.check({ tool: 'read_file', args: {} }, { goalId: null });
    leash.check({ tool: 'launch_app', args: {} }, { goalId: null });
    assert.equal(audit._writes().length, 2);
  });

  it('T>=3 fails closed when the audit write is unwritable', function() {
    var { createLeash } = require('../src/core/leash');
    var brokenAudit = recordingAuditWriter(function() { return { ok: false, degraded: true }; });
    var leash = createLeash({
      bus: fakeBus(), config: fakeConfig(), identity: noopIdentity(),
      auditWriter: brokenAudit, goals: { get: function() { return null; } }, effectors: noopEffectors()
    });
    var result = leash.check({ tool: 'kill_session', args: {} }, { goalId: null }); // T4
    assert.equal(result.allow, false);
    assert.equal(result.reason, 'audit-unwritable-fail-closed');
  });

  it('construction throws if a mandatory dependency is missing', function() {
    var { createLeash } = require('../src/core/leash');
    assert.throws(function() {
      createLeash({ bus: fakeBus(), config: fakeConfig(), auditWriter: recordingAuditWriter(), goals: {}, effectors: noopEffectors() });
    }, /identity/);
    assert.throws(function() {
      createLeash({ bus: fakeBus(), config: fakeConfig(), identity: noopIdentity(), auditWriter: recordingAuditWriter(), effectors: noopEffectors() });
    }, /goals/);
  });
});

describe('leash/confirm — connection scoping (Gate: wrong-connection cannot accept)', function() {
  it('accept from a different connectionId returns null and does not consume the entry', function() {
    var { createConfirmRegistry } = require('../src/core/leash/confirm');
    var registry = createConfirmRegistry({ config: fakeConfig() });
    var confirmId = registry.create('kill the session', { tool: 'kill_session', args: {} }, 'conn-A');
    var result = registry.accept(confirmId, 'conn-B');
    assert.equal(result, null, 'wrong connection must not receive the action');
    var legit = registry.accept(confirmId, 'conn-A');
    assert.ok(legit, 'the owning connection can still accept afterward');
  });
});

// ---------------------------------------------------------------------------
// REAL-INSTANCE INTEGRATION TEST — real GoalSystem <-> real Leash. Exercises
// the exact handoff goals.grantTier() -> leash.check() reading goal.grants['3']
// off a real goal record, not a fake.
// ---------------------------------------------------------------------------

describe('leash <-> goals — real-instance integration (Gate: tier3 once)', function() {
  function fakeFs() {
    var store = {};
    return {
      ensureDir: function() {},
      writeJSON: function(rel, data) { store[rel] = JSON.stringify(data); },
      readJSON: function(rel, fallback) { try { return JSON.parse(store[rel]); } catch (_) { return fallback; } },
      removeFile: function(rel) { delete store[rel]; },
      listFiles: function() { return []; }
    };
  }

  it('T3 tool requires confirm once, then auto-allows after grantTier persists it on the real goal', function() {
    var { createGoalSystem } = require('../src/core/goals');
    var { createLeash } = require('../src/core/leash');

    var bus = fakeBus();
    var goals = createGoalSystem({ fs: fakeFs(), config: fakeConfig(), bus: bus, memory: null, brain: null });
    var goal = goals.create({ title: 'Delete stale draft', drive: 'user-service', status: 'active' });

    var leash = createLeash({
      bus: bus, config: fakeConfig(), identity: noopIdentity(),
      auditWriter: recordingAuditWriter(), goals: goals, effectors: noopEffectors()
    });

    var first = leash.check({ tool: 'delete_goal', args: { id: goal.id } }, { goalId: goal.id });
    assert.equal(first.allow, false);
    assert.equal(first.requireConfirm, true, 'first T3 attempt must require confirm');

    goals.grantTier(goal.id, 3);   // real GoalSystem mutation — persists goal.grants['3']

    var second = leash.check({ tool: 'delete_goal', args: { id: goal.id } }, { goalId: goal.id });
    assert.equal(second.allow, true, 'second attempt after grantTier must auto-allow');
    assert.equal(second.reason, 'goal-granted');
  });
});

// ---------------------------------------------------------------------------
// REAL-INSTANCE INTEGRATION TEST — real memory audit-writer <-> real Leash,
// proving the "thin re-export, not a duplicate store" decision (Ambiguity #1)
// actually round-trips through the real append-only-JSONL writer.
// ---------------------------------------------------------------------------

describe('leash <-> memory/audit-writer — real-instance integration', function() {
  it('a leash.check() decision is queryable back out of the real audit-writer', async function() {
    var { createAuditWriter } = require('../src/core/leash/audit-writer'); // re-export path
    var { createLeash } = require('../src/core/leash');

    var appended = [];
    var fakeMemoryFs = {
      appendLine: function(relPath, entry) { appended.push(entry); },
      readDirLines: function() { return appended.slice(); },
      listFiles: function() { return []; },
      ensureDir: function() {},
      vaultPath: function(p) { return p; }
    };
    var audit = createAuditWriter({ fs: fakeMemoryFs, config: fakeConfig(), bus: fakeBus(), logger: { info: function() {}, warn: function() {}, error: function() {} } });
    await audit.init();

    var leash = createLeash({
      bus: fakeBus(), config: fakeConfig(), identity: noopIdentity(),
      auditWriter: audit, goals: { get: function() { return null; } }, effectors: noopEffectors()
    });

    leash.check({ tool: 'launch_app', args: { name: 'notes' } }, { goalId: null });

    var results = audit.query({ tool: 'launch_app' });
    assert.equal(results.length, 1, 'the leash decision must be queryable back out of the SAME writer leash used');
    assert.equal(results[0].decision, 'allow');
    assert.equal(results[0].tier, 2);
  });
});
