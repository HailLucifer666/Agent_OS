'use strict';

// test/proactive-speak-live-routing.test.js — Stage 2 (BUG-060/BUG-061), "two
// voices speaking simultaneously" (vault/Incidents/2026-07-31.jsonl, x2).
//
// Root cause: server/index.js's proactiveSpeak() (the boot greeting /
// reminders / late-outcome-report path) emitted edge-tts 'speech-chunk' audio
// unconditionally, with no check for whether the SAME connection also had an
// open Gemini Live session. Live's own PCM playback (pcm-player.js) and the
// edge-tts audio then played at once — two voices — and Live's VAD heard the
// edge-tts bleed through the mic and fired a spurious 'live-interrupted',
// clipping the tail of whatever Live was saying.
//
// Fix: proactiveSpeak() now checks the target connection's Live session and,
// if open, routes the text through liveSession.sendText('[SYSTEM] ...') — the
// exact channel live-tool-adapter.js's reportLateOutcome() already uses —
// instead of ever emitting a speech-chunk. Uses the same createLiveSocket
// test-only seam as server-live-wiring.test.js to drive a real Live session
// without a network call to Gemini.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

function fakeFs() {
  return { vaultPath: (...s) => path.join('/test-vault', ...s) };
}

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
  close() {
    this.closed = true;
    this.readyState = this.CLOSED;
    this.emit('close', 1000, 'test-close');
  }
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
      episodic: { write: async () => ({ ref: 'ep-1' }), recall: () => [] },
      recallHybrid: async () => [],
      fs: fakeFs(),
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

describe('proactiveSpeak routes through the Live session instead of edge-tts (Stage 2)', () => {
  test('an open Live session gets sendText, and the client never receives a speech-chunk', async () => {
    const bus = createBus({ historySize: 50 });
    const sockets = [];
    const createLiveSocket = () => { const s = new FakeGeminiSocket(); sockets.push(s); return s; };
    const prevKey = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = 'test-key-for-proactive-speak-routing';
    const server = createServer(baseDeps(bus, { config: { VOICE_S2S_ENABLED: true }, createLiveSocket }));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

      const received = [];
      ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));

      // Open a real Live session on this connection (this also sets
      // lastActiveWs, exactly as any inbound message would).
      ws.send(JSON.stringify({ type: 'live-open' }));
      await waitFor(() => sockets.length === 1);
      sockets[0].simulateOpen();
      sockets[0].serverFrame({ setupComplete: {} });
      await waitFor(() => sockets[0].sent.some((f) => f.setup));

      // Now fire a reminder — a proactiveSpeak() caller with no explicit
      // targetWs, exactly like reminder.due in server/index.js.
      bus.emit('reminder.due', { text: 'Stand-up in five minutes.' });

      // The reminder text must reach Gemini via the Live session's own
      // sendText() -> realtimeInput.text channel, not via a client-visible
      // speech-chunk. (live-session.js's sendText() deliberately uses
      // realtimeInput, not clientContent, per Google's VAD guidance.)
      await waitFor(() => sockets[0].sent.some((f) =>
        f.realtimeInput && typeof f.realtimeInput.text === 'string' &&
        f.realtimeInput.text.includes('Stand-up in five minutes')));

      const sentToGemini = sockets[0].sent.find((f) =>
        f.realtimeInput && typeof f.realtimeInput.text === 'string' &&
        f.realtimeInput.text.includes('Stand-up in five minutes'));
      assert.ok(sentToGemini, 'the reminder text must have been sent to the open Live session');
      assert.match(
        sentToGemini.realtimeInput.text, /\[SYSTEM NOTICE/,
        'must use the same [SYSTEM NOTICE ...] sendText channel reportLateOutcome() uses (BUG-117)'
      );

      // Give any (incorrect) speech-chunk path a beat to arrive, then assert
      // it never did — this is the "one voice" invariant.
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(
        received.filter((m) => m.type === 'speech-chunk').length, 0,
        'no speech-chunk (edge-tts audio) may be emitted while a Live session is open — that is the two-voices bug'
      );

      ws.close();
    } finally {
      if (prevKey === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prevKey;
      await server.stop();
    }
  });

  test('no Live session open: the legacy edge-tts speech-chunk path is unaffected', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus, { config: { VOICE_S2S_ENABLED: true } }));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

      const received = [];
      ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));

      // Send a harmless subscribe so lastActiveWs is set, but never open Live.
      ws.send(JSON.stringify({ type: 'subscribe', types: ['tick'] }));
      await new Promise((r) => setTimeout(r, 50));

      bus.emit('reminder.due', { text: 'Stand-up in five minutes.' });

      await waitFor(() => received.some((m) => m.type === 'proactive-speech'));
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(
        received.some((m) => m.type === 'done' && m.proactive === true),
        'the legacy (no Live session) path must still complete a proactive turn'
      );

      ws.close();
    } finally {
      await server.stop();
    }
  });
});
