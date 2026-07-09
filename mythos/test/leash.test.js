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
  return { checkBoundary: function() { return null; } };
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
