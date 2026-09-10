'use strict';

// test/unified-live-voice.test.js — VOICE_UNIFIED_LIVE_VOICE.
//
// Operator report, 2026-08-06: "when mythos boots there is one voice, when I
// speak it is another, and when I type it replies with another." All three were
// real. BUG-129 had already made typed chat join an OPEN Live session, and
// BUG-060 had done the same for proactive speech — but the Live session is
// created lazily by liveOpen(), the wake-word gate, so before the operator had
// spoken there was no session for either of them to join. The boot greeting
// (2.5s after the first connection) and typed-only chat therefore fell to
// edge-tts, and if the edge-tts sidecar was still starting, to the browser's own
// speechSynthesis. Three engines, three voices.
//
// liveForSpeech() closes that gap by opening a session on demand. These tests
// pin the two things that matter: it DOES open one for entity/typed speech, and
// it never strands a turn when it can't (no key, S2S off, unified voice off) —
// the batch path must still answer.
//
// Same createLiveSocket seam as bug-129-typed-chat-live-voice.test.js — no
// real network. This socket auto-completes the handshake, because here nothing
// client-side asks for the session: the server opens it by itself, which is
// the behaviour under test.

// BUG-433 (2026-09-10) CHANGED WHAT THIS FILE PINS, AND THE CHANGE IS THE POINT.
// These tests used to open a Live session for a client that had never sent
// live-open. That client has no renderer for live-audio-out: the HUD registers
// its handler inside s2s-bridge start() (:1031) and operator-playback.js is
// built only in operator mode, so the reply was inaudible AND uncaptioned
// (say:''). The session opened, the voice name was right, and nobody heard a
// word — measured on the 0.1.12 boot greeting. Unified voice is still the goal
// and is still pinned below; it is now conditional on the client being able to
// play the audio, and every test here says so by sending the live-open a real
// HUD sends. The audible fallback is a different voice, which is worse than one
// voice and much better than silence. Operator decision, 2026-09-10.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

class AutoOpeningGeminiSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.CLOSED = 3;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    // The transport opens by itself, and answers the setup frame with
    // setupComplete — live-session.js's open() resolves on that frame.
    setImmediate(() => {
      this.readyState = this.OPEN;
      this.emit('open');
    });
  }
  send(json) {
    const frame = JSON.parse(json);
    this.sent.push(frame);
    if (frame.setup) {
      setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} }))));
    }
  }
  close() { this.closed = true; this.readyState = this.CLOSED; this.emit('close', 1000, 'test-close'); }
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

// Every case here needs a client connection and a running server; the only
// differences are config and what the socket factory records.
async function withServer(deps, fn) {
  const server = createServer(deps);
  await server.ready;
  const { port } = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const dones = [];
  try {
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'done') dones.push(m);
    });
    await fn({ ws, dones });
  } finally {
    try { ws.close(); } catch (_) { /* already gone */ }
    await server.stop();
  }
}

function withKey(value, fn) {
  const prev = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = value;
  return (async () => {
    try { return await fn(); }
    finally {
      if (prev === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = prev;
    }
  })();
}

describe('VOICE_UNIFIED_LIVE_VOICE: typed chat opens a Live session rather than answering in another voice', () => {
  test('a typed utterance reopens a Live session for a listening client and speaks through it', async () => {
    const bus = createBus({ historySize: 50 });
    const sockets = [];
    const createLiveSocket = () => { const s = new AutoOpeningGeminiSocket(); sockets.push(s); return s; };
    await withKey('test-key-unified-voice', () => withServer(
      baseDeps(bus, {
        config: { VOICE_S2S_ENABLED: true, VOICE_UNIFIED_LIVE_VOICE: true },
        createLiveSocket,
      }),
      async ({ ws, dones }) => {
        // BUG-433 REWROTE THIS SCENARIO, because the old one was unreachable.
        // It used to type with no live-open at all, which is a client that cannot
        // play the reply — the session opened and nobody heard it. The reachable
        // version of "liveForSpeech() must open one on demand" is a listening
        // client whose session has since gone: an idle rotation, a goAway, a
        // transport drop. The listener outlives the session, and the next typed
        // turn must get the Live voice rather than falling to the batch chain.
        ws.send(JSON.stringify({ type: 'live-open' }));
        await waitFor(() => sockets.length === 1 && sockets[0].sent.some((f) => f.setup), 5000);
        sockets[0].close();
        await waitFor(() => sockets[0].closed, 5000);

        ws.send(JSON.stringify({ type: 'utterance', reqId: 'typed-1', text: 'what is on my calendar' }));
        await waitFor(() => sockets.length === 2, 5000);
        await waitFor(() => sockets[1].sent.some((f) => f.realtimeInput && f.realtimeInput.text), 5000);

        const textFrames = sockets[1].sent.filter((f) => f.realtimeInput && f.realtimeInput.text);
        assert.equal(textFrames.length, 1, 'exactly one text frame for one typed message');
        assert.equal(textFrames[0].realtimeInput.text, 'what is on my calendar');

        await waitFor(() => dones.length > 0);
        assert.equal(dones[0].reqId, 'typed-1');
        assert.equal(dones[0].routedToLive, true);
        assert.equal(dones[0].say, '', 'the batch/edge-tts path must not also answer this turn');
      },
    ));
  });

  test('a typed utterance from a client that cannot play Live audio is answered by the batch chain, not into silence', async () => {
    // The other half of BUG-433, and the reason the test above changed. No
    // live-open means no live-audio-out handler and no operator playback, so a
    // Live reply would be inaudible AND uncaptioned. Answering in the batch voice
    // is a worse voice and a real answer. Pinned so nobody restores the silence.
    const bus = createBus({ historySize: 50 });
    const sockets = [];
    const createLiveSocket = () => { const s = new AutoOpeningGeminiSocket(); sockets.push(s); return s; };
    await withKey('test-key-unified-voice', () => withServer(
      baseDeps(bus, {
        config: { VOICE_S2S_ENABLED: true, VOICE_UNIFIED_LIVE_VOICE: true },
        createLiveSocket,
      }),
      async ({ ws, dones }) => {
        ws.send(JSON.stringify({ type: 'utterance', reqId: 'typed-3', text: 'hello' }));
        await waitFor(() => dones.length > 0, 8000);
        assert.equal(dones[0].reqId, 'typed-3');
        assert.notEqual(dones[0].routedToLive, true,
          'a client with no renderer must not be answered into a Live session');
        assert.equal(sockets.length, 0, 'and no metered Gemini session may be opened for it');
      },
    ));
  });

  test('the session it opens uses GEMINI_LIVE_VOICE — the same voice spoken turns use', async () => {
    const bus = createBus({ historySize: 50 });
    const sockets = [];
    const createLiveSocket = () => { const s = new AutoOpeningGeminiSocket(); sockets.push(s); return s; };
    await withKey('test-key-unified-voice', () => withServer(
      baseDeps(bus, {
        config: { VOICE_S2S_ENABLED: true, VOICE_UNIFIED_LIVE_VOICE: true, GEMINI_LIVE_VOICE: 'Aoede' },
        createLiveSocket,
      }),
      async ({ ws }) => {
        ws.send(JSON.stringify({ type: 'live-open' }));
        await new Promise((r) => setTimeout(r, 50));
        ws.send(JSON.stringify({ type: 'utterance', reqId: 'typed-2', text: 'hello' }));
        await waitFor(() => sockets.length === 1 && sockets[0].sent.some((f) => f.setup), 5000);
        const setup = sockets[0].sent.find((f) => f.setup).setup;
        // This is the whole point of the change: one voice name, on the session
        // a typed turn opened, identical to the one a spoken turn would open.
        assert.equal(
          setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
          'Aoede');
      },
    ));
  });
});

describe('VOICE_UNIFIED_LIVE_VOICE: the fallback path is never stranded', () => {
  // Each of these must leave the batch path intact. The tell is the same in all
  // three: deps carry no voiceAgent, so only handleUtterance can produce a
  // reply, and it answers offline. A swallowed turn would time out instead.
  const stranding = [
    {
      name: 'unified voice off -> batch path, no session opened',
      config: { VOICE_S2S_ENABLED: true, VOICE_UNIFIED_LIVE_VOICE: false },
      key: 'test-key-unified-voice',
    },
    {
      name: 'S2S disabled -> batch path, no session opened',
      config: { VOICE_S2S_ENABLED: false, VOICE_UNIFIED_LIVE_VOICE: true },
      key: 'test-key-unified-voice',
    },
    {
      name: 'no GOOGLE_API_KEY -> batch path, no session opened',
      config: { VOICE_S2S_ENABLED: true, VOICE_UNIFIED_LIVE_VOICE: true },
      key: null,
    },
  ];

  for (const c of stranding) {
    test(c.name, async () => {
      const bus = createBus({ historySize: 50 });
      const sockets = [];
      const createLiveSocket = () => { const s = new AutoOpeningGeminiSocket(); sockets.push(s); return s; };
      const run = () => withServer(
        baseDeps(bus, { config: c.config, createLiveSocket }),
        async ({ ws, dones }) => {
          ws.send(JSON.stringify({ type: 'utterance', reqId: 'fb-1', text: 'hello' }));
          await waitFor(() => dones.length > 0, 5000);
          assert.equal(dones[0].reqId, 'fb-1');
          assert.equal(dones[0].offline, true, 'the batch path must still answer');
          assert.equal(dones[0].routedToLive, undefined);
          assert.equal(sockets.length, 0, 'no Live session should have been opened');
        },
      );
      if (c.key === null) {
        const prev = process.env.GOOGLE_API_KEY;
        delete process.env.GOOGLE_API_KEY;
        try { await run(); }
        finally { if (prev !== undefined) process.env.GOOGLE_API_KEY = prev; }
      } else {
        await withKey(c.key, run);
      }
    });
  }
});
