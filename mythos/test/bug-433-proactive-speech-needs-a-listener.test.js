'use strict';

// test/bug-433-proactive-speech-needs-a-listener.test.js — BUG-433.
//
// 2026-09-10 09:20Z, packaged 0.1.12, first boot: "As soon as the app starts it
// does not greet. Waits for the wake word." The server log shows the greeting
// was NOT lost — `live.text-injected site:proactive-speak` (146 chars) and Gemini
// answered it. Nobody was listening. The HUD registers its
// onBroadcast('live-audio-out') handler inside s2s-bridge.js's start()
// (:1031), start() runs only from toggleVoice — orb click, hotkey, wake word —
// and ws.js drops a broadcast type with no handler silently (:166-169). So the
// boot greeting was spoken into a socket whose audio frames went nowhere, and
// the TTS path that WOULD have been audible (subscribed at boot, app.js:999)
// was skipped because liveForSpeech() had already opened a Live session.
//
// THE FIX is a listener gate on liveForSpeech(): no client that can render
// live-audio-out, no metered Gemini session. Two channels announce that
// capability and they are NOT the same message — the HUD sends live-open, a
// voice node declares caps:['live-audio'] at identify time and never sends
// live-open at all. Test (5) below is that second channel; without it this fix
// would have taken Live away from every capable phone.
//
// OPERATOR DECISION 2026-09-10: the boot greeting is audible in the TTS voice.
// Test (1) is that pin — it asserts BOTH that the client hears something and
// that no Gemini socket was opened to say it.
//
// MUTATION RUN — see the block above the last test in this file.
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

const LIVE_CFG = { VOICE_S2S_ENABLED: true, VOICE_UNIFIED_LIVE_VOICE: true };

// The key is set for EVERY test here, deliberately. The sibling suite's
// legacy-path test passes without one, which means it cannot tell "no listener"
// from "no key" — the exact ambiguity BUG-433 lives in.
function withKey(fn) {
  return async () => {
    const prev = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = 'test-key-for-bug-433';
    try { await fn(); }
    finally { if (prev === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prev; }
  };
}

async function boot(bus, sockets, extraConfig) {
  const createLiveSocket = () => { const s = new FakeGeminiSocket(); sockets.push(s); return s; };
  const server = createServer(baseDeps(bus, { config: Object.assign({}, LIVE_CFG, extraConfig || {}), createLiveSocket }));
  await server.ready;
  const { port } = server.httpServer.address();
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const received = [];
  ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));
  return { server, ws, received };
}

async function openLive(ws, sockets) {
  ws.send(JSON.stringify({ type: 'live-open' }));
  await waitFor(() => sockets.length === 1);
  sockets[0].simulateOpen();
  sockets[0].serverFrame({ setupComplete: {} });
  await waitFor(() => sockets[0].sent.some((f) => f.setup));
}

describe('BUG-433 — proactive speech opens Live only for a client that can hear it', () => {
  test('(1) no live-open: the greeting reaches the client as TTS and NO Gemini socket is opened', withKey(async () => {
    const bus = createBus({ historySize: 50 });
    const sockets = [];
    const { server, ws, received } = await boot(bus, sockets);
    try {
      // A harmless subscribe sets lastActiveWs, exactly as any inbound message
      // does. The HUD's bridge has NOT started, so nothing is listening for
      // live-audio-out — which is the whole of BUG-433.
      ws.send(JSON.stringify({ type: 'subscribe', types: ['tick'] }));
      await new Promise((r) => setTimeout(r, 50));

      bus.emit('reminder.due', { text: 'Stand-up in five minutes.' });

      await waitFor(() => received.some((m) => m.type === 'proactive-speech'));
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(sockets.length, 0,
        'a Gemini session was opened for a client with no live-audio-out listener — that is the 0.1.12 silent greeting');
      assert.ok(received.some((m) => m.type === 'done' && m.proactive === true),
        'the TTS path must complete the proactive turn');
      ws.close();
    } finally { await server.stop(); }
  }));

  test('(2) after live-open the Live path is unchanged: one socket, the text goes to Gemini', withKey(async () => {
    const bus = createBus({ historySize: 50 });
    const sockets = [];
    const { server, ws, received } = await boot(bus, sockets);
    try {
      await openLive(ws, sockets);
      bus.emit('reminder.due', { text: 'Stand-up in five minutes.' });
      await waitFor(() => sockets[0].sent.some((f) =>
        f.realtimeInput && typeof f.realtimeInput.text === 'string' &&
        f.realtimeInput.text.includes('Stand-up in five minutes')));
      assert.equal(sockets.length, 1, 'exactly one Live session');
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(received.filter((m) => m.type === 'speech-chunk').length, 0,
        'the one-voice invariant (Stage 2) must survive this gate');
      ws.close();
    } finally { await server.stop(); }
  }));

  test('(3) live-open then live-close: the listener is gone, so the next reminder takes the TTS path', withKey(async () => {
    const bus = createBus({ historySize: 50 });
    const sockets = [];
    const { server, ws, received } = await boot(bus, sockets);
    try {
      await openLive(ws, sockets);
      ws.send(JSON.stringify({ type: 'live-close' }));
      await waitFor(() => sockets[0].closed);
      await new Promise((r) => setTimeout(r, 50));

      bus.emit('reminder.due', { text: 'Second reminder.' });
      await waitFor(() => received.some((m) => m.type === 'proactive-speech'));
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(sockets.length, 1,
        'stopping the bridge must not leave the server free to reopen Live behind it');
      ws.close();
    } finally { await server.stop(); }
  }));

  test('(4) a typed utterance with no listener answers without opening Live', withKey(async () => {
    const bus = createBus({ historySize: 50 });
    const sockets = [];
    const { server, ws, received } = await boot(bus, sockets);
    try {
      ws.send(JSON.stringify({ type: 'utterance', reqId: 'r-433', text: 'hello there' }));
      await waitFor(() => received.some((m) => m.type === 'done' && m.reqId === 'r-433'), 8000);
      const done = received.find((m) => m.type === 'done' && m.reqId === 'r-433');
      assert.notEqual(done.routedToLive, true,
        'a typed utterance must not be routed into a Live session nobody can hear');
      assert.equal(sockets.length, 0, 'no Gemini socket for a client with no listener');
      ws.close();
    } finally { await server.stop(); }
  }));

  // MUTATION RUN 2026-09-10 against server/index.js, each verified applied by
  // grep and restored sha256-identical (6421213905e7...):
  //   delete `if (!canRender(renderer)) return null;` — literally the pre-fix
  //     code -> 4 red: (1), (3), (4) here and "a typed utterance from a client
  //     that cannot play Live audio is answered by the batch chain" in
  //     test/unified-live-voice.test.js.
  //   `canRender() { return true; }` -> the same 4 red, from the other side.
  //   drop the `|| ws._nodeLiveAudio === true` channel -> (5) red.
  //   `renderer === 'nope'` instead of 'operator' -> 2 red in
  //     test/desktop-server.test.js ("routes conversation and suppresses old
  //     PCM after local cancel", "completed operator conversations retain
  //     native Live context"). That branch was the one mutation that first
  //     SURVIVED, because the files I reached for did not exercise operator
  //     mode; finding its real cover is why it is written down here.
  //   drop `clientLiveRequested = false` from the live-close branch -> (3) red.
  //     A first attempt at this one ate the closing quote and only broke the
  //     parse — a mutation that fails to apply looks exactly like a guard that
  //     works, so the anchor is now an exact string, not a regex.
  test('(5) a voice node that declared live-audio is a listener, though it never sends live-open', withKey(async () => {
    // Enumerate every channel (this fix's own near-miss). The phone announces its
    // capability at identify time and drives Live through the utterance branch;
    // it has no bridge and no live-open. A gate reading only the HUD's message
    // would silently downgrade every capable phone to the batch text lane, which
    // is the regression the node gate at the utterance branch already documents.
    const bus = createBus({ historySize: 50 });
    const sockets = [];
    const { server, ws, received } = await boot(bus, sockets);
    try {
      ws.send(JSON.stringify({ type: 'identify', role: 'node', nodeId: 'phone-433', caps: ['live-audio'] }));
      await waitFor(() => received.some((m) => m.type === 'identified'));
      assert.equal(received.find((m) => m.type === 'identified').ok, true,
        'the fixture must speak the wire: the handler matches role node, and an ok:false identify sets no caps at all');
      ws.send(JSON.stringify({ type: 'utterance', reqId: 'r-433n', text: 'hello there' }));
      await waitFor(() => sockets.length === 1, 8000);
      assert.equal(sockets.length, 1, 'a node that declared live-audio must still get Live');
      ws.close();
    } finally { await server.stop(); }
  }));
});
