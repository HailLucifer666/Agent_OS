'use strict';

// test/confirm-surface-attribution.test.js — G4, "unattributable consent".
//
// This is NOT a consent-bug fix. show_desktop is Tier 2 and isn't in
// SEND_TOOLS, so it never arms the spoken-confirm path; AFFIRMATIVE_RE is
// fully anchored so a spoken "No" cannot match even as a substring, and
// NEGATIVE_RE is tested first regardless; every reachable create-site passes
// a real connection id and accept() is single-use. A cross-connection accept
// is closed by construction.
//
// The real finding: dispatch-action.js's audit write hardcodes
// `actor: ctx.channel || 'cortex'`, and server/index.js's handleConfirmReply
// hardcodes `channel: 'confirm-accept'` for every accept regardless of what
// surface (a real click vs. app.js's Thumb_Up gesture auto-clicking the same
// button) produced it. Every accept therefore looked identical in the audit
// — the incident was unattributable IN PRINCIPLE, not just in this one case.
//
// Fix: confirm-reply carries a client-reported `surface` field end-to-end
// into the audit row (defaulting to 'unknown' for clients that don't send
// one — never defaulting to 'click', which would invent an attribution).
// The row also now records which of the two confirm.accept() scopes
// (connection-owned vs. the T0-T2-only 'system' fallback) actually resolved
// it, since that is material to attribution and was previously
// indistinguishable too.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

function fakeFs() {
  return { vaultPath: (...s) => path.join('/test-vault', ...s) };
}

// A leash.confirm double whose accept() lets a test control exactly which
// scope resolves the confirm, so both the connection-owned path and the
// T0-T2 'system' fallback can be exercised deterministically:
//   firstAcceptSucceeds: true  -> the FIRST accept() call (always made with
//                                 this connection's real id) succeeds ->
//                                 acceptedScope must come out 'connection'.
//   firstAcceptSucceeds: false -> the first call is made to fail, so
//                                 handleConfirmReply falls back to the
//                                 SECOND call, made with the literal string
//                                 'system' -> acceptedScope must come out
//                                 'system' (only when tier <= 2).
function fakeConfirmLeash({ firstAcceptSucceeds, tier }) {
  let calls = 0;
  const decision = { tool: 'noop_tool', args: {} };
  return {
    check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }),
    confirm: {
      create: () => 'cf-1',
      peek: () => ({ summary: 'test action' }),
      peekTier: () => tier,
      accept: (confirmId, scope) => {
        calls += 1;
        if (calls === 1) {
          return firstAcceptSucceeds ? { decision, goalId: null, tier } : null;
        }
        if (scope === 'system' && tier <= 2) return { decision, goalId: null, tier };
        return null;
      },
      reject: () => true,
    },
  };
}

function baseDeps(bus, leash, auditWrites) {
  const config = {
    MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
    MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '',
  };
  return {
    bus,
    config,
    logger: { info() {}, warn() {}, error() {} },
    memory: {
      working: { tick: 0, activeGoalId: null },
      episodic: { write: async () => ({ ref: 'ep-1' }), recall: () => [] },
      recallHybrid: async () => [],
      fs: fakeFs(),
      audit: { write: (e) => { auditWrites.push(e); return { ok: true }; } },
    },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: {
      breakers: { allow: () => true },
      invoke: async () => ({ ok: true }),
      effectors: new Map(),
      catalog: () => [],
      get: () => undefined,
    },
    leash,
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({ ok: true }) },
    agentActions: {
      assembleKanbanPlan: () => ({ job: { id: 'j1', status: 'queued' } }),
      buildKanbanCard: () => ({ job: { id: 'j1', status: 'queued' }, board: { cards: [] } }),
      reviewKanbanCard: () => ({ job: { id: 'j1', status: 'queued' } }),
    },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
    ttsChain: { chainNames: ['fake'], isAvailable: async () => false, synthesize: async () => ({ audio: Buffer.from(''), mime: 'audio/mpeg' }) },
  };
}

function waitFor(fn, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      let ok;
      try { ok = fn(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor: condition never became true'));
      setTimeout(check, 10);
    })();
  });
}

async function withConnectedClient(server, fn) {
  const { port } = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  try {
    await fn(ws);
  } finally {
    ws.close();
  }
}

describe('confirm-reply surface attribution (G4)', () => {
  test('a click accept records surface: "click"', async () => {
    const bus = createBus({ historySize: 50 });
    const auditWrites = [];
    const leash = fakeConfirmLeash({ firstAcceptSucceeds: true, tier: 3 });
    const server = createServer(baseDeps(bus, leash, auditWrites));
    await server.ready;
    try {
      await withConnectedClient(server, async (ws) => {
        ws.send(JSON.stringify({ type: 'confirm-reply', confirmId: 'cf-1', accept: true, surface: 'click' }));
        await waitFor(() => auditWrites.some((e) => e.tool === 'noop_tool'));
      });
    } finally {
      await server.stop();
    }
    const row = auditWrites.find((e) => e.tool === 'noop_tool');
    assert.ok(row, 'the dispatched action must have written an audit row');
    assert.equal(row.surface, 'click');
    assert.equal(row.acceptedScope, 'connection', 'the connection-owned accept() call resolved it, not the system fallback');
    assert.equal(row.actor, 'confirm-accept', 'actor must stay exactly as before — this fix does not repurpose it');
  });

  test('a gesture accept records surface: "gesture"', async () => {
    const bus = createBus({ historySize: 50 });
    const auditWrites = [];
    const leash = fakeConfirmLeash({ firstAcceptSucceeds: true, tier: 3 });
    const server = createServer(baseDeps(bus, leash, auditWrites));
    await server.ready;
    try {
      await withConnectedClient(server, async (ws) => {
        ws.send(JSON.stringify({ type: 'confirm-reply', confirmId: 'cf-1', accept: true, surface: 'gesture' }));
        await waitFor(() => auditWrites.some((e) => e.tool === 'noop_tool'));
      });
    } finally {
      await server.stop();
    }
    const row = auditWrites.find((e) => e.tool === 'noop_tool');
    assert.ok(row);
    assert.equal(row.surface, 'gesture');
  });

  test('a confirm-reply with no surface field records "unknown", never "click"', async () => {
    const bus = createBus({ historySize: 50 });
    const auditWrites = [];
    const leash = fakeConfirmLeash({ firstAcceptSucceeds: true, tier: 3 });
    const server = createServer(baseDeps(bus, leash, auditWrites));
    await server.ready;
    try {
      await withConnectedClient(server, async (ws) => {
        // Old-client shape: no `surface` key at all.
        ws.send(JSON.stringify({ type: 'confirm-reply', confirmId: 'cf-1', accept: true }));
        await waitFor(() => auditWrites.some((e) => e.tool === 'noop_tool'));
      });
    } finally {
      await server.stop();
    }
    const row = auditWrites.find((e) => e.tool === 'noop_tool');
    assert.ok(row);
    assert.equal(row.surface, 'unknown');
    assert.notEqual(row.surface, 'click', 'an unreported surface must never be defaulted to click — that invents an attribution');
  });

  test('the system-scope fallback accept is distinguishable from a connection-scope accept', async () => {
    const bus = createBus({ historySize: 50 });
    const auditWrites = [];
    // Tier 1 (<=2) so the system fallback is legally allowed, and the
    // connection-scope attempt is forced to fail so the fallback is what
    // actually resolves the confirm.
    const leash = fakeConfirmLeash({ firstAcceptSucceeds: false, tier: 1 });
    const server = createServer(baseDeps(bus, leash, auditWrites));
    await server.ready;
    try {
      await withConnectedClient(server, async (ws) => {
        ws.send(JSON.stringify({ type: 'confirm-reply', confirmId: 'cf-1', accept: true, surface: 'click' }));
        await waitFor(() => auditWrites.some((e) => e.tool === 'noop_tool'));
      });
    } finally {
      await server.stop();
    }
    const row = auditWrites.find((e) => e.tool === 'noop_tool');
    assert.ok(row);
    assert.equal(row.acceptedScope, 'system', 'the system fallback (not the connection scope) resolved this one, and the row must say so');
  });
});
