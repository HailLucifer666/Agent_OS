'use strict';

// test/bug-129-typed-chat-live-voice.test.js — BUG-129.
// Evidence: HUD typed input (compose-bar -> ws {type:'utterance'}) always took
// the batch path, which speaks through edge-tts, while an open Live session
// speaks in Gemini's own voice off a separate history. Two voices, two
// contexts, one conversation. Typed text must join the Live session when one
// is open, and only fall back to the batch path when none is.
// Same createLiveSocket seam as server-live-wiring.test.js — no real network.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

class FakeGeminiSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.CLOSED = 3;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
  }
  send(json) { this.sent.push(JSON.parse(json)); }
  close() { this.closed = true; this.readyState = this.CLOSED; this.emit('close', 1000, 'test-close'); }
  simulateOpen() { this.readyState = this.OPEN; this.emit('open'); }
  serverFrame(frame) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
}

function baseDeps(bus, overrides) {
  const ov = overrides || {};
  const config = Object.assign({
    MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
    MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '',
  }, ov.config || {});
  const base = {
    bus,
    config,
    logger: { info() {}, warn() {}, error() {} },
    memory: {
      working: { tick: 0, activeGoalId: null },
      episodic: { write: async () => {} },
      fs: { vaultPath: (...s) => path.join('/test-vault', ...s) },
      audit: { write: () => ({ ok: true }) },
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
    leash: {
      check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'cf-1', accept: () => null, reject: () => true },
    },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({ ok: true }) },
    agentActions: {
      assembleKanbanPlan: () => ({ job: { id: 'j1', status: 'queued' } }),
      buildKanbanCard: () => ({ job: { id: 'j1', status: 'queued' }, board: { cards: [] } }),
      reviewKanbanCard: () => ({ job: { id: 'j1', status: 'queued' } }),
    },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
  };
  const merged = Object.assign({}, base, ov);
  merged.config = config;
  return merged;
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

describe('BUG-129: typed chat answers in the Live voice while a Live session is open', () => {
  test('with an open Live session, a typed utterance is injected as user text — not answered by the batch/edge-tts path', async () => {
    const bus = createBus({ historySize: 50 });
    const sockets = [];
    const createLiveSocket = () => { const s = new FakeGeminiSocket(); sockets.push(s); return s; };
    const prevKey = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = 'test-key-for-bug-129';
    const server = createServer(baseDeps(bus, { config: { VOICE_S2S_ENABLED: true }, createLiveSocket }));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      const dones = [];
      ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.type === 'done') dones.push(m); });

      ws.send(JSON.stringify({ type: 'live-open' }));
      await waitFor(() => sockets.length === 1);
      sockets[0].simulateOpen();
      sockets[0].serverFrame({ setupComplete: {} });
      await waitFor(() => sockets[0].sent.some((f) => f.setup));

      ws.send(JSON.stringify({ type: 'utterance', reqId: 'u1', text: 'what is on my calendar' }));
      await waitFor(() => sockets[0].sent.some((f) => f.realtimeInput && f.realtimeInput.text));

      const textFrames = sockets[0].sent.filter((f) => f.realtimeInput && f.realtimeInput.text);
      assert.equal(textFrames.length, 1, 'exactly one text frame for one typed message');
      assert.equal(textFrames[0].realtimeInput.text, 'what is on my calendar');

      // The HUD's per-reqId reply handler must still be released, or the typed
      // turn hangs forever client-side. An empty `say` is deliverReply's
      // finishTurn path — the spoken answer arrives on the Live audio channel.
      await waitFor(() => dones.length > 0);
      assert.equal(dones[0].reqId, 'u1');
      assert.equal(dones[0].routedToLive, true);
      assert.equal(dones[0].say, '', 'the batch path must not also speak this turn');

      ws.close();
    } finally {
      if (prevKey === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prevKey;
      await server.stop();
    }
  });

  test('with no Live session, a typed utterance still takes the batch path unchanged', async () => {
    const bus = createBus({ historySize: 50 });
    // No voiceAgent in deps, so the batch path answers "Brain is offline." —
    // an answer only handleUtterance can produce, which is the point: it proves
    // the fallback still runs rather than the text being swallowed.
    const server = createServer(baseDeps(bus, { config: { VOICE_S2S_ENABLED: false } }));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      const dones = [];
      ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.type === 'done') dones.push(m); });

      ws.send(JSON.stringify({ type: 'utterance', reqId: 'u2', text: 'hello' }));
      await waitFor(() => dones.length > 0);
      assert.equal(dones[0].reqId, 'u2');
      assert.equal(dones[0].offline, true);
      assert.equal(dones[0].routedToLive, undefined);
      ws.close();
    } finally {
      await server.stop();
    }
  });
});
