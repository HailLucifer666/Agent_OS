'use strict';

// bug-136-live-capability-freshness.test.js — BUG-136.
//
// The Live/S2S setup frame is composed once per open()/rotation and can then
// ride unrefreshed for up to ~10 minutes, while its CAPABILITY SNAPSHOT told
// the model to "trust this over any assumption" — the mechanical cause behind
// BUG-046's fabricated "PC automation is offline, sir" with zero audit rows.
// The batch path (voice-agent.js) re-reads the digest fresh every turn and is
// unaffected; this file pins that only the Live composition point asks for
// the labelled `asOf` form, that the labelled form reads honestly, that the
// default (batch) output is byte-identical to before, and that RULES carries
// the negative-honesty guard for adapter availability.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');
const capabilities = require('../src/core/identity/capabilities');
const fs = require('node:fs');

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

describe('BUG-136: default summaryDigest is unchanged', () => {
  test('no asOf: header still reads "live — trust this over any assumption"', () => {
    const digest = capabilities.summaryDigest({
      apps: ['slack'],
      roots: ['C:\\Users\\test\\Documents'],
      adapters: { 'pc-child': true, browser: false },
      providerCount: 3,
    });
    assert.match(digest, /^CAPABILITY SNAPSHOT \(live — trust this over any assumption\):/);
    assert.ok(digest.includes('pc-child ONLINE'));
    assert.ok(digest.includes('browser OFFLINE'));
    assert.ok(digest.split('\n').length <= 5, 'hard budget: <= 5 lines');
  });
});

describe('BUG-136: the asOf variant is honest about staleness', () => {
  test('asOf set: no "trust this over any assumption", states when it was taken, adapters carry the same qualifier', () => {
    const digest = capabilities.summaryDigest({
      apps: ['slack'],
      roots: ['C:\\Users\\test\\Documents'],
      adapters: { 'pc-child': true, browser: false },
      asOf: 'session-start',
    });
    assert.equal(/trust this over any assumption/i.test(digest), false,
      'a labelled snapshot must not claim to be trustable over reality');
    assert.match(digest, /session-start/, 'must state when the snapshot was taken');
    assert.match(digest, /may have changed/i, 'must warn the state can be stale');
    assert.ok(digest.includes('pc-child ONLINE'));
    assert.ok(digest.includes('browser OFFLINE'));
  });
});

describe('BUG-136: buildLiveSystemInstruction asks for the labelled variant', () => {
  test('the Live setup frame is composed from a getCapabilityDigest call carrying { asOf: "session-start" }', async () => {
    const bus = createBus({ historySize: 50 });
    const sockets = [];
    const createLiveSocket = () => { const s = new FakeGeminiSocket(); sockets.push(s); return s; };
    const calls = [];
    const getCapabilityDigest = (opts) => {
      calls.push(opts);
      return capabilities.summaryDigest(Object.assign({ adapters: { 'pc-child': true } }, opts));
    };
    const prevKey = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = 'test-key-for-bug-136';
    const server = createServer(baseDeps(bus, {
      config: { VOICE_S2S_ENABLED: true },
      createLiveSocket,
      getCapabilityDigest,
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

      assert.ok(calls.length >= 1, 'buildLiveSystemInstruction must call getCapabilityDigest');
      assert.equal(calls[0].asOf, 'session-start', 'the Live composition point must ask for the labelled, not the "live", form');

      const text = sockets[0].sent.find((f) => f.setup).setup.systemInstruction.parts[0].text;
      assert.match(text, /session-start/, 'the labelled digest text must actually reach the setup frame');
      assert.equal(/trust this over any assumption/i.test(text), false);

      ws.close();
    } finally {
      if (prevKey === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prevKey;
      await server.stop();
    }
  });
});

describe('Task B3: the two BUG-136 gaps named in the comment are now labelled too', () => {
  test('version.contextLine() and the skills catalog both carry an "as of session-start" staleness note', async () => {
    const bus = createBus({ historySize: 50 });
    const sockets = [];
    const createLiveSocket = () => { const s = new FakeGeminiSocket(); sockets.push(s); return s; };
    const prevKey = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = 'test-key-for-b3';
    const server = createServer(baseDeps(bus, {
      config: { VOICE_S2S_ENABLED: true },
      createLiveSocket,
      getCapabilityDigest: (opts) => capabilities.summaryDigest(Object.assign({ adapters: {} }, opts)),
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

      const text = sockets[0].sent.find((f) => f.setup).setup.systemInstruction.parts[0].text;
      // version.contextLine() reads 'MYTHOS vX.Y.Z (gitref). Last change: ...' —
      // its own staleness note must ride right along with it.
      assert.match(text, /MYTHOS v[^(]*\([^)]*\)\.[^]*as of session-start/,
        'version.contextLine() must carry the session-start staleness note');
      // The skills catalog block starts with 'SKILLS AVAILABLE' — its staleness
      // note must appear after it, not just anywhere else in the prompt.
      assert.match(text, /SKILLS AVAILABLE[^]*as of session-start/,
        'the skills catalog must carry the session-start staleness note');

      ws.close();
    } finally {
      if (prevKey === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prevKey;
      await server.stop();
    }
  });
});

describe('BUG-136: RULES carries the negative-honesty guard for adapter availability', () => {
  test('AVAILABILITY RULE requires a this-turn tool result before claiming unavailability', () => {
    // RULES is a module-private const, not exported — both the batch and Live
    // paths build their prompt from this one shared string (server/index.js's
    // buildLiveSystemInstruction and voice-agent.js's buildPrompt both reference
    // the same top-level RULES), so a source read is a faithful proxy for "what
    // every prompt actually contains".
    const source = fs.readFileSync(require.resolve('../src/core/voice/voice-agent'), 'utf8');
    assert.match(source, /AVAILABILITY RULE/);
    assert.match(source, /AVAILABILITY RULE[^]*THIS turn/i);
  });
});
