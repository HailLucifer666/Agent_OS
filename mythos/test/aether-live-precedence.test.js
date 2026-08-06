'use strict';

// test/aether-live-precedence.test.js — AETHER-WIRING.md Phase 2 precedence.
//
// Operator decision (2026-08-07): **Live wins always.** Gemini Live in-session
// speech takes priority over Aether nearest-device audio routing; the Aether
// route is best-effort and may only be attempted when NO Live session is open.
// server/index.js already orders both speech paths that way — proactiveSpeak()
// takes its Live branch (and, with VOICE_UNIFIED_LIVE_VOICE on, tries to OPEN
// one) before ever reaching speakViaAether(), and sendSpokenReply()/the typed-
// utterance handler check the connection's Live session first. Nothing here
// changes that ordering; these tests pin it so a future edit cannot quietly
// reverse the precedence.
//
// The reachable-when-no-Live direction and the aggregator-down fallback are
// covered in test/server.test.js ('Aether Phase 2: nearest-device voice
// routing'). This file owns the mutual-exclusivity invariant, including the
// honest consequence: with VOICE_UNIFIED_LIVE_VOICE on (the default) the
// Aether audio route effectively never fires.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

// Same test-only Gemini socket seam server-live-wiring.test.js and
// proactive-speak-live-routing.test.js use — a real Live session, no network.
class FakeGeminiSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.CLOSED = 3;
    this.readyState = 0;
    this.sent = [];
  }
  send(json) { this.sent.push(JSON.parse(json)); }
  close() { this.readyState = this.CLOSED; this.emit('close', 1000, 'test-close'); }
  simulateOpen() { this.readyState = this.OPEN; this.emit('open'); }
  serverFrame(frame) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
}

function baseDeps(bus, overrides) {
  const ov = overrides || {};
  const config = Object.assign({
    MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
    MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '',
    AETHER_ENABLED: true, AETHER_AUDIO_ROUTE: true,
  }, ov.config || {});
  const base = {
    bus,
    config,
    logger: { info() {}, warn() {}, error() {} },
    memory: {
      working: { tick: 0, activeGoalId: null },
      episodic: { write: async () => ({ ref: 'ep-1' }), recall: () => [] },
      recallHybrid: async () => [],
      fs: { vaultPath: (...s) => path.join('test-vault', ...s) },
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
    tts: { isAvailable: async () => false },
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

// Every Live-session test needs a key present for liveForSpeech()/liveOpen()
// to attempt an open at all (it reads process.env, not config).
async function withGoogleKey(fn) {
  const prev = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = 'test-key-for-aether-live-precedence';
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prev;
  }
}

describe('Aether audio routing yields to Gemini Live (Live wins always)', () => {
  test('proactive speech with a Live session already open goes to Live, never to the aggregator', async () => {
    await withGoogleKey(async () => {
      const bus = createBus({ historySize: 50 });
      const sockets = [];
      const spoke = [];
      const server = createServer(baseDeps(bus, {
        config: { VOICE_S2S_ENABLED: true, VOICE_UNIFIED_LIVE_VOICE: false },
        createLiveSocket: () => { const s = new FakeGeminiSocket(); sockets.push(s); return s; },
        aetherSpeak: (t) => { spoke.push(t); return true; },
      }));
      await server.ready;
      const { port } = server.httpServer.address();
      try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
        const received = [];
        ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));

        ws.send(JSON.stringify({ type: 'live-open' }));
        await waitFor(() => sockets.length === 1);
        sockets[0].simulateOpen();
        sockets[0].serverFrame({ setupComplete: {} });
        await waitFor(() => sockets[0].sent.some((f) => f.setup));

        bus.emit('reminder.due', { text: 'Stand-up in five minutes.' });
        await waitFor(() => sockets[0].sent.some((f) =>
          f.realtimeInput && typeof f.realtimeInput.text === 'string' &&
          f.realtimeInput.text.includes('Stand-up in five minutes')));

        // Give the (wrong) Aether branch a beat to have fired, then assert it
        // never did — this is the precedence, not a timing artefact.
        await new Promise((r) => setTimeout(r, 150));
        assert.deepEqual(spoke, [], 'Aether must not be asked to speak while Live is open');
        assert.equal(received.filter((m) => m.type === 'speech-chunk').length, 0,
          'and no local edge-tts audio either — Live is the only voice');
        ws.close();
      } finally { await server.stop(); }
    });
  });

  test('with VOICE_UNIFIED_LIVE_VOICE on, proactive speech opens a Live session rather than routing to Aether', async () => {
    await withGoogleKey(async () => {
      const bus = createBus({ historySize: 50 });
      const sockets = [];
      const spoke = [];
      const server = createServer(baseDeps(bus, {
        config: { VOICE_S2S_ENABLED: true, VOICE_UNIFIED_LIVE_VOICE: true },
        createLiveSocket: () => { const s = new FakeGeminiSocket(); sockets.push(s); return s; },
        aetherSpeak: (t) => { spoke.push(t); return true; },
      }));
      await server.ready;
      const { port } = server.httpServer.address();
      try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
        // Any inbound message makes this the targeted connection (lastActiveWs);
        // proactiveSpeak only tries liveForSpeech() on a live targetWs.
        ws.send(JSON.stringify({ type: 'subscribe', types: ['tick'] }));
        await new Promise((r) => setTimeout(r, 50));

        // No Live session exists yet — the unified-voice path must open one.
        bus.emit('reminder.due', { text: 'Stand-up in five minutes.' });
        await waitFor(() => sockets.length === 1);
        sockets[0].simulateOpen();
        sockets[0].serverFrame({ setupComplete: {} });

        await waitFor(() => sockets[0].sent.some((f) =>
          f.realtimeInput && typeof f.realtimeInput.text === 'string' &&
          f.realtimeInput.text.includes('Stand-up in five minutes')));
        assert.deepEqual(spoke, [],
          'unified Live voice and Aether audio routing are mutually exclusive, and Live wins');
        ws.close();
      } finally { await server.stop(); }
    });
  });

  test('an utterance reply with Live open answers on the Live path, not through Aether', async () => {
    await withGoogleKey(async () => {
      const bus = createBus({ historySize: 50 });
      const sockets = [];
      const spoke = [];
      const server = createServer(baseDeps(bus, {
        config: { VOICE_S2S_ENABLED: true, VOICE_UNIFIED_LIVE_VOICE: false },
        createLiveSocket: () => { const s = new FakeGeminiSocket(); sockets.push(s); return s; },
        aetherSpeak: (t) => { spoke.push(t); return true; },
      }));
      await server.ready;
      const { port } = server.httpServer.address();
      try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
        const received = [];
        ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));

        ws.send(JSON.stringify({ type: 'live-open' }));
        await waitFor(() => sockets.length === 1);
        sockets[0].simulateOpen();
        sockets[0].serverFrame({ setupComplete: {} });
        await waitFor(() => sockets[0].sent.some((f) => f.setup));

        ws.send(JSON.stringify({ type: 'utterance', reqId: 'r1', text: 'what time is it' }));
        await waitFor(() => received.some((m) => m.type === 'done' && m.reqId === 'r1'));

        const done = received.find((m) => m.type === 'done' && m.reqId === 'r1');
        assert.equal(done.routedToLive, true, 'the turn belongs to the open Live conversation');
        assert.deepEqual(spoke, [], 'the reply must not also be routed to the Aether device');
        assert.equal(received.filter((m) => m.type === 'speech-chunk').length, 0,
          'and no local chunks — one voice per turn');
        ws.close();
      } finally { await server.stop(); }
    });
  });

  test('no Live session available: the Aether route is the one that fires', async () => {
    const bus = createBus({ historySize: 50 });
    const spoke = [];
    // VOICE_UNIFIED_LIVE_VOICE off is exactly the condition under which Phase 2
    // is exercisable at all — liveForSpeech() returns null, so the Aether
    // branch below it is reached.
    const server = createServer(baseDeps(bus, {
      config: { VOICE_S2S_ENABLED: true, VOICE_UNIFIED_LIVE_VOICE: false },
      aetherSpeak: (t) => { spoke.push(t); return true; },
    }));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      const received = [];
      ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));
      ws.send(JSON.stringify({ type: 'subscribe', types: ['tick'] }));
      await new Promise((r) => setTimeout(r, 50));

      bus.emit('reminder.due', { text: 'Stand-up in five minutes.' });
      await waitFor(() => spoke.length === 1);

      assert.ok(spoke[0].includes('Stand-up in five minutes'), 'the text reaches the aggregator as a say');
      assert.ok(received.some((m) => m.type === 'proactive-speech'), 'the HUD still captions it');
      assert.equal(received.filter((m) => m.type === 'speech-chunk').length, 0,
        'routed away means the local machine stays silent');
      ws.close();
    } finally { await server.stop(); }
  });
});
