'use strict';

// test/vision-live-voice-gate.test.js — G1, the third BUG-060 site.
//
// proactiveSpeak() (server/index.js ~1691) and sendSpokenReply() (~2647) are
// both already guarded against speaking a vision-lane-style reply through
// edge-tts while a Gemini Live session is open on the same connection —
// Live's own PCM playback IS the entity's voice at that point, and emitting
// speech-chunk audio on top of it is the "two voices" bug
// (vault/Incidents/2026-07-31.jsonl). handleVisionQuery() (~2938) had no such
// check at all: it is dispatched bare from the message router
// (`else if (msg.type === 'vision-query') handleVisionQuery(msg);`) with no
// upstream gate, and it emits speech-chunk frames unconditionally.
//
// Fix: handleVisionQuery() now resolves the connection's Live session the
// same way sendSpokenReply() does and, when it is open, skips the whole
// ttsUp/streamer chunking path and instead routes the answer through
// liveSession.sendText() with SYSTEM_NOTICE_PREFIX — same channel
// proactiveSpeak() uses. The final `done` still carries the caption text so
// the HUD shows the answer, and is marked chunked so the client finishes the
// turn silently instead of narrating the reply a second time.
//
// NOTE this test does NOT establish: it is not confirmed the *installed/
// packaged* build contains the BUG-060 fix at all — packaging drift is this
// whole repair plan's premise, and a stale packaged server/index.js would
// explain the original incident with no new mechanism whatsoever. This test
// only proves the source file's hole is closed.

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

// A tiny opaque 1x1 JPEG-shaped base64 blob — handleVisionQuery only checks
// length/presence, it never decodes the bytes.
const FAKE_IMAGE_B64 = Buffer.from('fake-image-bytes').toString('base64');

function fakeBrain(sayText) {
  return {
    think: async (opts) => {
      if (typeof opts.onToken === 'function') opts.onToken(sayText);
      return { content: sayText };
    },
  };
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
    ttsChain: { chainNames: ['fake'], isAvailable: async () => true, synthesize: async () => ({ audio: Buffer.from('a'), mime: 'audio/mpeg' }) },
  };
  const merged = Object.assign({}, base, ov);
  merged.config = config;
  return merged;
}

// 15s, not 3s. This polls every 10ms and resolves the instant the condition
// holds, so the ceiling costs nothing on the happy path — it only bounds the
// FAILURE case. At 3s it blocked a commit once and then passed clean on a
// quiet re-run: the suite starts a real server and a real WS here, and under
// full-suite parallelism that boot does not reliably finish inside 3s. A
// deadline sized for an idle machine turns load into a fake test failure,
// which is worse than useless — it trains you to re-run instead of read.
function waitFor(fn, timeoutMs = 15000) {
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

describe('handleVisionQuery gates on the Live session (G1 / BUG-060 third site)', () => {
  test('an open Live session gets sendText and ZERO speech-chunk frames', async () => {
    const bus = createBus({ historySize: 50 });
    const sockets = [];
    const createLiveSocket = () => { const s = new FakeGeminiSocket(); sockets.push(s); return s; };
    const prevKey = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = 'test-key-for-vision-live-gate';
    const say = 'A wooden desk with a mug on it.';
    const server = createServer(baseDeps(bus, {
      config: { VOICE_S2S_ENABLED: true },
      createLiveSocket,
      brain: fakeBrain(say),
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

      ws.send(JSON.stringify({ type: 'vision-query', reqId: 'vq-1', image: FAKE_IMAGE_B64, text: 'what do you see' }));

      await waitFor(() => sockets[0].sent.some((f) =>
        f.realtimeInput && typeof f.realtimeInput.text === 'string' && f.realtimeInput.text.includes(say)));

      const sentToGemini = sockets[0].sent.find((f) =>
        f.realtimeInput && typeof f.realtimeInput.text === 'string' && f.realtimeInput.text.includes(say));
      assert.ok(sentToGemini, 'the vision answer must have been sent to the open Live session');
      assert.match(sentToGemini.realtimeInput.text, /\[SYSTEM NOTICE/,
        'must use the same [SYSTEM NOTICE ...] sendText channel proactiveSpeak() uses');

      await waitFor(() => received.some((m) => m.type === 'done' && m.reqId === 'vq-1'));
      const done = received.find((m) => m.type === 'done' && m.reqId === 'vq-1');
      assert.equal(done.say, say, 'the done frame must still carry the caption text for the HUD');
      assert.equal(done.chunked, true, 'chunked must be true so the client finishes the turn silently');

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

  test('no Live session open: the legacy speech-chunk path is unaffected', async () => {
    const bus = createBus({ historySize: 50 });
    const say = 'A wooden desk with a mug on it.';
    const server = createServer(baseDeps(bus, { brain: fakeBrain(say) }));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

      const received = [];
      ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));

      ws.send(JSON.stringify({ type: 'vision-query', reqId: 'vq-2', image: FAKE_IMAGE_B64, text: 'what do you see' }));

      await waitFor(() => received.some((m) => m.type === 'speech-chunk'));
      await waitFor(() => received.some((m) => m.type === 'done' && m.reqId === 'vq-2'));

      const done = received.find((m) => m.type === 'done' && m.reqId === 'vq-2');
      assert.equal(done.say, say);

      ws.close();
    } finally {
      await server.stop();
    }
  });
});
