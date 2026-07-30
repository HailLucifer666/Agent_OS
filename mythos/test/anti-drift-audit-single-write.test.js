'use strict';

// test/anti-drift-audit-single-write.test.js — AD-2 from
// mythos/Plans/MYTHOS-IRIS-Synthesis-Plan-V2-spine.md §1: "Leash owns the audit
// write. leash.check() already calls writeAudit() on every branch (allow/deny/
// confirm/dry-run). Callers must never write a second audit line for the same
// decision." Executable check, verbatim from the spine's own table: stub
// auditWriter.write, drive one Live tool call end-to-end through the REAL
// leash (createLeash), assert exactly one write per check().

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createLeash } = require('../src/core/leash');
const { createBus } = require('../src/core/bus');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');

function fakeConfig(overrides) {
  return Object.assign({
    AUTONOMOUS_MAX_TIER: 2,
    MYTHOS_DRY_RUN: false,
    LEASH_CONFIRM_TTL_MS: 30000,
  }, overrides || {});
}

function noopIdentity() {
  return { checkBoundary: () => null, getMaxAutonomousTier: () => 4 };
}

function recordingAuditWriter() {
  const writes = [];
  return { write: (entry) => { writes.push(entry); return { ok: true }; }, _writes: writes };
}

function fakeMemory() {
  return { working: { tick: 1 }, episodic: { write: async () => {} } };
}

function buildAdapter({ auditWriter, dispatchAction }) {
  const bus = createBus({ historySize: 50 });
  const leash = createLeash({
    bus, config: fakeConfig(), identity: noopIdentity(),
    auditWriter, goals: { get: () => null }, effectors: { get: () => undefined },
  });
  const adapter = createLiveToolAdapter({
    leash,
    dispatchAction: dispatchAction || (async () => ({ ok: true, result: {} })),
    bus, logger: { warn() {}, info() {} }, connectionId: 'conn-ad2',
    memory: fakeMemory(), historyAppend: () => {}, reflection: null,
    summarizeActionsForResult: () => null,
    getLiveSession: () => null,
  });
  return { adapter, leash };
}

describe('AD-2: leash.check() writes exactly one audit line per decision, the adapter writes zero', () => {
  test('a T0 auto-allow tool call produces exactly one audit write', async () => {
    const auditWriter = recordingAuditWriter();
    const { adapter } = buildAdapter({ auditWriter });
    const responses = [];
    await adapter.handleLiveToolCalls(
      [{ id: 'c1', name: 'read_status', args: {} }],
      { sendToolResponse: (r) => responses.push(...r) },
    );
    assert.equal(auditWriter._writes.length, 1, 'exactly one audit write for one T0 decision');
    assert.equal(auditWriter._writes[0].decision, 'allow');
    assert.equal(responses[0].response.status, 'ok');
  });

  test('a T3 tool call (requireConfirm) produces exactly one audit write — the "confirm" line — and dispatches nothing', async () => {
    const auditWriter = recordingAuditWriter();
    const dispatchCalls = [];
    const { adapter } = buildAdapter({
      auditWriter,
      dispatchAction: async (d, ctx) => { dispatchCalls.push({ d, ctx }); return { ok: true, result: {} }; },
    });
    const responses = [];
    await adapter.handleLiveToolCalls(
      [{ id: 'c2', name: 'delete_goal', args: { query: 'thing' } }],
      { sendToolResponse: (r) => responses.push(...r) },
    );
    assert.equal(auditWriter._writes.length, 1, 'exactly one audit write for the T3 confirm decision — the adapter must never write a second one');
    assert.equal(auditWriter._writes[0].decision, 'confirm');
    assert.equal(auditWriter._writes[0].tier, 3);
    assert.equal(dispatchCalls.length, 0, 'a T3 call must not dispatch before human approval');
    assert.equal(responses[0].response.status, 'awaiting_human_confirmation');
  });

  test('a denied tool call still produces exactly one audit write', async () => {
    const auditWriter = recordingAuditWriter();
    const { adapter } = buildAdapter({ auditWriter });
    // gmail_send is T3 by default tiering, but boundary-deny happens before the
    // tier check when identity.checkBoundary() flags it — simulate that path
    // directly via a leash whose identity denies everything, to hit the
    // 'deny' branch distinctly from 'confirm'.
    const bus = createBus({ historySize: 50 });
    const denyLeash = createLeash({
      bus, config: fakeConfig(), identity: { checkBoundary: () => 'denied by boundaries.md', getMaxAutonomousTier: () => 4 },
      auditWriter, goals: { get: () => null }, effectors: { get: () => undefined },
    });
    const adapter2 = createLiveToolAdapter({
      leash: denyLeash, dispatchAction: async () => ({ ok: true, result: {} }),
      bus, logger: { warn() {}, info() {} }, connectionId: 'conn-ad2b',
      memory: fakeMemory(), historyAppend: () => {}, reflection: null,
      summarizeActionsForResult: () => null, getLiveSession: () => null,
    });
    const responses = [];
    await adapter2.handleLiveToolCalls([{ id: 'c3', name: 'read_status', args: {} }], { sendToolResponse: (r) => responses.push(...r) });
    assert.equal(auditWriter._writes.length, 1);
    assert.equal(auditWriter._writes[0].decision, 'deny');
    assert.equal(responses[0].response.status, 'denied');
  });
});
