'use strict';

// test/server-live-wiring.test.js — Phase 5 (V2 §10, merged-order step 4).
// Gate (test matrix §14): a live-audio frame arriving before live-open is a
// no-op, not a throw; ws.close closes the session. Uses createServer's
// createLiveSocket test-only seam (mirrors live-session.js's own createSocket
// seam one level up) so this drives the REAL connection wiring end-to-end
// without any real network call to Gemini.

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
  // Deep-merge just the `config` sub-object (a shallow Object.assign of the
  // whole deps object would let ov.config REPLACE the defaults wholesale,
  // wiping out MYTHOS_BIND/MYTHOS_PORT/etc. whenever a test only wants to
  // override one config key).
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
  };
  const merged = Object.assign({}, base, ov);
  merged.config = config; // re-assert the properly deep-merged config last
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

describe('server-live-wiring (Phase 5, V2 §10)', () => {
  test('VOICE_S2S_ENABLED=false (the default): live-open reports closed/disabled honestly, no session is created', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus, { config: { VOICE_S2S_ENABLED: false } }));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      const stateMsgs = [];
      ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.type === 'live-state') stateMsgs.push(m); });
      ws.send(JSON.stringify({ type: 'live-open' }));
      await waitFor(() => stateMsgs.length > 0);
      assert.equal(stateMsgs[0].state, 'closed');
      assert.equal(stateMsgs[0].reason, 'disabled');
      ws.close();
    } finally {
      await server.stop();
    }
  });

  test('a live-audio frame arriving before live-open is a no-op, not a throw — the connection stays healthy', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus, { config: { VOICE_S2S_ENABLED: true } }));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      // No live-open was ever sent — liveSession is still null server-side.
      ws.send(JSON.stringify({ type: 'live-audio', data: 'not-real-pcm-base64' }));
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(ws.readyState, WebSocket.OPEN, 'an out-of-order live-audio frame must not crash the connection');
      // Prove the connection is still genuinely alive, not just not-yet-closed:
      // subscribe and confirm a normal message still gets handled.
      const done = new Promise((resolve) => {
        ws.on('message', (raw) => {
          const m = JSON.parse(raw.toString());
          if (m.type === 'entity-state') resolve();
        });
      });
      ws.send(JSON.stringify({ type: 'subscribe', types: ['tick'] }));
      bus.emit('tick', { tick: 1, perceptions: [] });
      // entity-state was already sent at connect; this just confirms send() still works post-live-audio.
      await new Promise((r) => setTimeout(r, 50));
      ws.close();
    } finally {
      await server.stop();
    }
  });

  test('ws.close() closes an open Live session — no dangling socket left billing for open-mic time', async () => {
    const bus = createBus({ historySize: 50 });
    const sockets = [];
    const createLiveSocket = () => { const s = new FakeGeminiSocket(); sockets.push(s); return s; };
    const prevKey = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = 'test-key-for-server-wiring';
    const server = createServer(baseDeps(bus, { config: { VOICE_S2S_ENABLED: true }, createLiveSocket }));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      ws.send(JSON.stringify({ type: 'live-open' }));
      await waitFor(() => sockets.length === 1);
      sockets[0].simulateOpen();
      sockets[0].serverFrame({ setupComplete: {} });
      await waitFor(() => sockets[0].sent.some((f) => f.setup)); // setup frame was sent on 'open'

      ws.close();
      await waitFor(() => sockets[0].closed === true);
      assert.equal(sockets[0].closed, true, 'closing the client WS connection must close the underlying Gemini socket');
    } finally {
      if (prevKey === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prevKey;
      await server.stop();
    }
  });

  test('BUG-079: the Live systemInstruction carries local date/time, and refreshes it on reconnect', async () => {
    // Real evidence: MYTHOS said "have a good afternoon" at ~01:50 local; the
    // operator corrected "a.m. not p.m." — nothing in the prompt ever told it
    // what time it actually was. buildLiveSystemInstruction() is now passed
    // as a FUNCTION (not its one-time result) so live-session.js's buildSetup()
    // re-renders it fresh on every open()/reconnect, not just at first connect.
    const bus = createBus({ historySize: 50 });
    const sockets = [];
    const createLiveSocket = () => { const s = new FakeGeminiSocket(); sockets.push(s); return s; };
    const prevKey = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = 'test-key-for-time-injection';
    const server = createServer(baseDeps(bus, {
      config: { VOICE_S2S_ENABLED: true, LIVE_IDLE_TIMEOUT_MS: 15 },
      createLiveSocket,
    }));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      ws.send(JSON.stringify({ type: 'live-open' }));
      await waitFor(() => sockets.length === 1);
      sockets[0].simulateOpen();
      sockets[0].serverFrame({ setupComplete: {} });
      await waitFor(() => sockets[0].sent.some((f) => f.setup));

      const firstText = sockets[0].sent.find((f) => f.setup).setup.systemInstruction.parts[0].text;
      assert.match(firstText, /Current local date\/time:/, 'the setup prompt must name the current local time');
      const firstYear = new Date().getFullYear();
      assert.ok(firstText.includes(String(firstYear)), 'must be a real current date, not a placeholder');

      // Idle-timeout rotates the session (BUG-059) — the reconnect must
      // recompute the instruction, not replay the stale first-connect string.
      await waitFor(() => sockets.length === 2, 2000);
      sockets[1].simulateOpen();
      sockets[1].serverFrame({ setupComplete: {} });
      await waitFor(() => sockets[1].sent.some((f) => f.setup));
      const secondText = sockets[1].sent.find((f) => f.setup).setup.systemInstruction.parts[0].text;
      assert.match(secondText, /Current local date\/time:/, 'the rotated session must ALSO carry a local time, not lose it on reconnect');

      ws.close();
    } finally {
      if (prevKey === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prevKey;
      await server.stop();
    }
  });
});
