'use strict';
// BUG-464 follow-up — independent review finding, 2026-10-07, confirmed by reading:
// server/index.js's confirm-accept dispatched with no consent, so a consent-gated
// tool (remember, note_take, write_note; and with BUG-446 the goal tools) that
// needed a CLICK was refused after the operator clicked Approve: "Not saved
// (no-consent)". A click needs a confirm whenever the autonomy ceiling is below
// the tool's tier (ceiling 0, or a boundaries.md that lowers it).
//
// Now authority-gate.js's consentForClickedConfirm mints a token for exactly the
// approved call, and only for a reported 'click' — app.js's thumbs-up gesture
// auto-clicked an approval once (G4), and an 'unknown' surface is no person.
//
// Probes 2026-10-07, each turning the named test red: (a) the consent argument
// removed from the confirm-accept dispatch -> (1); (b) the surface check removed
// -> (2); (c) CONSENT_TOOLS ignored (mint for every tool) -> (3).
// The harness is confirm-surface-attribution.test.js's: the real server, a real
// WebSocket client, and a leash double whose accept() hands back the decision.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');
const { verifyConsent } = require('../src/core/leash/consent');

function leashApproving(decision) {
  return {
    check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }),
    confirm: {
      create: () => 'cf-1',
      peek: () => ({ summary: 'test action' }),
      peekTier: () => 1,
      accept: () => ({ decision, goalId: null, tier: 1 }),
      reject: () => true,
    },
  };
}

function deps(bus, leash, invoked) {
  return {
    bus,
    config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '' },
    logger: { info() {}, warn() {}, error() {} },
    memory: {
      working: { tick: 0, activeGoalId: null },
      episodic: { write: async () => ({ ref: 'ep-1' }), recall: () => [] },
      recallHybrid: async () => [],
      fs: { vaultPath: (...s) => path.join('/test-vault', ...s) },
      audit: { write: () => ({ ok: true }) },
    },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: {
      breakers: { allow: () => true },
      invoke: async (tool, args, ctx) => { invoked.push({ tool, args, ctx }); return { ok: true }; },
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
      if (fn()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor: condition never became true'));
      setTimeout(check, 10);
    })();
  });
}

async function approve(decision, surface) {
  const invoked = [];
  const server = createServer(deps(createBus({ historySize: 50 }), leashApproving(decision), invoked));
  await server.ready;
  try {
    const { port } = server.httpServer.address();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    try {
      ws.send(JSON.stringify({ type: 'confirm-reply', confirmId: 'cf-1', accept: true, ...(surface ? { surface } : {}) }));
      await waitFor(() => invoked.length > 0);
    } finally { ws.close(); }
  } finally { await server.stop(); }
  return invoked[0];
}

describe('BUG-464 — a clicked Approve carries the operator\'s consent', () => {
  const NOTE = { tool: 'note_take', args: { text: 'buy milk' } };

  test('(1) GOAL: clicking Approve on a held note hands the effector a consent for exactly that call', async () => {
    const call = await approve(NOTE, 'click');
    assert.equal(call.tool, 'note_take');
    assert.ok(call.ctx && call.ctx.consent, 'the operator clicked Approve and the effector got no consent');
    assert.equal(verifyConsent(call.ctx.consent, 'note_take', NOTE.args).ok, true);
  });

  test('(2) a gesture or an unreported surface is not a click: no consent is minted', async () => {
    for (const surface of ['gesture', undefined]) {
      const call = await approve(NOTE, surface);
      assert.equal(call.ctx && call.ctx.consent, null, 'surface ' + surface + ' minted a consent');
    }
  });

  test('(3) ADJACENT: a click on a tool that verifies no consent dispatches exactly as before, with none', async () => {
    const call = await approve({ tool: 'noop_tool', args: {} }, 'click');
    assert.equal(call.tool, 'noop_tool');
    assert.equal(call.ctx && call.ctx.consent, null);
  });
});
