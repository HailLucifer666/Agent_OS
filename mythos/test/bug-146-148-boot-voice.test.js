'use strict';

// BUG-146 / BUG-148 — the two boot-time voice defects the operator reported on
// 2026-08-07 ("the gold middle button does nothing at all", and "email read is
// happening twice as soon as boot sequence").
//
// BUG-146: liveOpen()'s already-open branch was a bare `return`, sending the
// client nothing. The HUD paints the orb and caption ONLY from live-state
// messages (ui/public/js/voice/s2s-bridge.js's onLiveStateMsg), and
// VOICE_UNIFIED_LIVE_VOICE makes "a session is already open by the time you
// click" the NORMAL case, because the boot greeting opens one ~2.5s in. So every
// orb click on a healthy session produced zero visible feedback.
//
// BUG-148: the greeting dedup was one-directional. deliverBootGreeting() calls
// conversationAnnouncer.markAnnounced(GREETING_DEDUP_KEY) but never isRecent(),
// so it always speaks; the gmail sensor's default 'boot-once' mode polls
// immediately at start() while the greeting waits 2.5s for a client to attach.
// The sensor therefore spoke first and the greeting — which reads the inbox into
// its own opening line — spoke anyway. Two mail announcements per boot.
//
// Run: cd mythos && MYTHOS_PORT=4987 EDGE_TTS_PORT=5087 EDGE_TTS_URL=http://127.0.0.1:5087 \
//   node --test test/bug-146-148-boot-voice.test.js

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

function fakeFs() {
  return { vaultPath: (...s) => path.join('/test-vault', ...s) };
}

// Same shape as proactive-speak-live-routing.test.js's fake — the createLiveSocket
// seam is the only way to get a genuinely open liveSession without a network call.
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

describe('BUG-146: live-open on an already-open session still answers the client', () => {
  test('the second live-open produces a live-state the HUD can repaint from', async () => {
    const bus = createBus({ historySize: 50 });
    const sockets = [];
    const createLiveSocket = () => { const s = new FakeGeminiSocket(); sockets.push(s); return s; };
    const prevKey = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = 'test-key-bug-146';
    const server = createServer(baseDeps(bus, { config: { VOICE_S2S_ENABLED: true }, createLiveSocket }));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      const received = [];
      ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));

      // First click: opens a real session.
      ws.send(JSON.stringify({ type: 'live-open' }));
      await waitFor(() => sockets.length === 1);
      sockets[0].simulateOpen();
      sockets[0].serverFrame({ setupComplete: {} });
      await waitFor(() => received.some((m) => m.type === 'live-state' && m.state === 'open'));

      const beforeSecondClick = received.filter((m) => m.type === 'live-state').length;

      // Second click, with the session already open — this is the exact state the
      // operator's orb was in on every boot, and the branch that used to `return`
      // without sending anything.
      ws.send(JSON.stringify({ type: 'live-open' }));
      await waitFor(() => received.filter((m) => m.type === 'live-state').length > beforeSecondClick);

      const ack = received.filter((m) => m.type === 'live-state').slice(-1)[0];
      assert.equal(ack.state, 'open', 'the already-open ack must report the session as open');
      assert.equal(ack.reason, 'already-open',
        'the reason must distinguish this from a fresh open, so the log stays readable');

      // No second Gemini socket: answering the client must not cost a new session.
      assert.equal(sockets.length, 1,
        'the already-open path must not open a second metered Live session just to reply');

      ws.close();
    } finally {
      if (prevKey === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prevKey;
      await server.stop();
    }
  });
});

describe('BUG-148: the boot greeting owns the boot-window mail announcement', () => {
  test('a gmail.unread-batch arriving before the greeting is delivered is suppressed, not spoken', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus, {}));
    await server.ready;
    // Under `node --test` the greeting is suppressed (NODE_TEST_CONTEXT), which
    // correctly seeds bootGreetingDelivered=true — so the state under test has to
    // be set explicitly. This is production's state ~2.5s into a real boot: a
    // client is attached, the greeting timer is armed, nothing spoken yet.
    server._internal.setBootGreetingDelivered(false);
    const { port } = server.httpServer.address();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      const received = [];
      ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));

      // The sensor's boot-once poll landing first — the real observed ordering
      // (gmail batch 22:08:07, greeting 22:08:09).
      bus.emit('gmail.unread-batch', {
        count: 10,
        messages: [{ id: 'm1', subject: 'Your Personalized Developer News' }],
      });
      await new Promise((r) => setTimeout(r, 250));

      assert.equal(
        received.filter((m) => m.type === 'proactive-speech').length, 0,
        'the raw mail batch must yield to the pending boot greeting, which reads the inbox itself'
      );
      assert.equal(
        received.some((m) => m.text && String(m.text).includes('10 new emails')), false,
        'the suppressed batch text must never reach the client'
      );

      ws.close();
    } finally {
      await server.stop();
    }
  });

  test('once the greeting HAS been delivered, mail speaks again — the suppression cannot silence it outright', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus, {}));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      const received = [];
      ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));

      // Greeting done (or never coming): nothing left to defer to. Note this is
      // the DEFAULT state under the test runner, which is why no seam call is
      // needed here — and it is also the state of a long-running process hours
      // after boot, when mail must obviously still be announced.
      assert.equal(server._internal.isBootGreetingDelivered(), true,
        'precondition: with no greeting pending the suppression window is already closed');

      bus.emit('gmail.unread-batch', {
        count: 3,
        messages: [{ id: 'm9', subject: 'Invoice' }],
      });
      await waitFor(() => received.some((m) => m.type === 'proactive-speech'), 3000);

      const spoken = received.find((m) => m.type === 'proactive-speech');
      assert.ok(spoken, 'with no greeting pending there is nothing to defer to, so mail must be announced');
      assert.match(String(spoken.text), /3 new emails/,
        'and it must be the real batch text, not a placeholder');

      ws.close();
    } finally {
      await server.stop();
    }
  });
});
