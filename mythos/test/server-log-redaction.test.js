'use strict';

// test/server-log-redaction.test.js — Task A2: the logger.onLog relay in
// server/index.js is the ONE choke point feeding both broadcastAll({type:'log'})
// and pushReplay('log'). A future call site that logs a secret would otherwise
// reach every authenticated WS client live AND from the replay buffer. These
// tests pin that the client-bound copy is scrubbed (key-name fields ->
// '[REDACTED]', value patterns -> '[REDACTED]' inline) while the original entry
// object — the one stdout already received — is left untouched.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createLogger } = require('../src/core/logger');
const { createServer } = require('../server');

// String concat so secret scanners don't flag this test file (repo convention,
// see test/p23-agentic-patterns.test.js).
const SK_SECRET = 'sk-' + 'test-sentinel-' + 'a'.repeat(24);   // OpenAI shape
const GSK_SECRET = 'gsk_' + 'sentinel' + 'b'.repeat(28);        // Groq shape
const NVAPI_SECRET = 'nvapi-' + 'sentinel' + 'c'.repeat(26);   // NVIDIA shape
const KEY_FIELD_SECRET = 'sk-test-sentinel';                    // brief's field sentinel

function fakeFs() {
  return { vaultPath: (...s) => path.join('/test-vault', ...s) };
}

function baseDeps(bus, logger, overrides) {
  return Object.assign({
    bus,
    config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '' },
    logger,
    memory: { working: { tick: 0, activeGoalId: null }, episodic: { write: async () => {} }, fs: fakeFs() },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
    leash: { confirm: { create: () => 'cf-1', accept: () => null, reject: () => true } },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({ ok: true }) },
    agentActions: {
      assembleKanbanPlan: () => ({ job: { id: 'j1', status: 'queued' } }),
      buildKanbanCard: () => ({ job: { id: 'j1', status: 'queued' }, board: { cards: [] } }),
      reviewKanbanCard: () => ({ job: { id: 'j1', status: 'queued' } }),
    },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
  }, overrides || {});
}

function connectWs(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// Collect 'log' frames and resolve with the first one matching `match(payload)`.
// Predicate-based (not "first frame") because the server logs startup lines
// (e.g. server.listening) into the replay buffer before a test client connects,
// so the frame we care about is not necessarily the first one delivered.
function waitForLogFrame(ws, match, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('timed out waiting for a matching log frame'));
    }, timeoutMs || 5000);
    function onMessage(raw) {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'log' && match(msg.payload)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      }
    }
    ws.on('message', onMessage);
  });
}

describe('server log redaction (A2): the WS relay scrubs the client-bound copy', () => {
  test('a secret-shaped field and a value-pattern msg never reach a live WS client', async () => {
    const bus = createBus({ historySize: 50 });
    // The REAL logger: it writes stdout itself before notifying listeners, so
    // this also proves the relay redacts a copy, not the object stdout got.
    const logger = createLogger('info');
    const originals = [];
    // Registered BEFORE createServer's relay listener, so it sees the entry too.
    logger.onLog((entry) => originals.push(entry));
    const server = createServer(baseDeps(bus, logger));
    await server.ready;
    const { port } = server.httpServer.address();
    let ws;
    try {
      ws = await connectWs(port);
      const framePromise = waitForLogFrame(ws, (p) => typeof p.msg === 'string' && p.msg.startsWith('provisioning'));
      logger.info('provisioning with key ' + SK_SECRET, {
        apiKey: KEY_FIELD_SECRET,
        nested: { dbPassword: 'hunter2hunter2', plain: 'harmless' },
      });
      const frame = await framePromise;

      // Key-name redaction: replacement, not key-dropping — JSON shape survives.
      assert.equal(frame.payload.apiKey, '[REDACTED]');
      assert.ok('apiKey' in frame.payload, 'the key must still be present (shape preserved)');
      assert.equal(frame.payload.nested.dbPassword, '[REDACTED]');
      assert.equal(frame.payload.nested.plain, 'harmless', 'benign sibling fields pass through');

      // Value-pattern redaction inside the msg string.
      assert.ok(!frame.payload.msg.includes(SK_SECRET), 'the sk- secret must not appear in msg');
      assert.ok(frame.payload.msg.includes('[REDACTED]'), 'the secret span is replaced inline');
      assert.ok(frame.payload.msg.startsWith('provisioning with key '), 'surrounding text survives');

      // The sentinel never appears anywhere in the relayed frame.
      assert.ok(!JSON.stringify(frame).includes(KEY_FIELD_SECRET));
      assert.ok(!JSON.stringify(frame).includes(SK_SECRET));

      // The original entry object is untouched — stdout/container consumers and
      // any other listener see exactly what logger.js emitted.
      const original = originals.find((e) => typeof e.msg === 'string' && e.msg.startsWith('provisioning'));
      assert.ok(original, 'the capture listener saw the entry');
      assert.equal(original.apiKey, KEY_FIELD_SECRET, 'the original entry must NOT be mutated');
      assert.ok(original.msg.includes(SK_SECRET), 'the original msg keeps the raw value');
    } finally {
      if (ws) try { ws.close(); } catch (_) {}
      await server.stop();
    }
  });

  test('the replay buffer replays the redacted copy, not the raw entry', async () => {
    const bus = createBus({ historySize: 50 });
    const logger = createLogger('info');
    const server = createServer(baseDeps(bus, logger));
    await server.ready;
    const { port } = server.httpServer.address();
    let ws;
    try {
      // Emit with NO client connected — the frame lands only in the replay buffer.
      logger.info('rotated key ' + GSK_SECRET, { authToken: KEY_FIELD_SECRET });

      ws = await connectWs(port);
      const replayed = waitForLogFrame(ws, (p) => typeof p.msg === 'string' && p.msg.startsWith('rotated key'));
      ws.send(JSON.stringify({ type: 'subscribe', types: ['log'], replay: true }));
      const frame = await replayed;

      assert.equal(frame.payload.authToken, '[REDACTED]');
      assert.ok(!JSON.stringify(frame).includes(GSK_SECRET), 'the gsk_ secret must not be replayed');
      assert.ok(!JSON.stringify(frame).includes(KEY_FIELD_SECRET));
      assert.ok(frame.payload.msg.includes('[REDACTED]'));
    } finally {
      if (ws) try { ws.close(); } catch (_) {}
      await server.stop();
    }
  });

  test('all three new provider prefixes (sk-, gsk_, nvapi-) are masked in msg values', async () => {
    const bus = createBus({ historySize: 50 });
    const logger = createLogger('info');
    const server = createServer(baseDeps(bus, logger));
    await server.ready;
    const { port } = server.httpServer.address();
    let ws;
    try {
      ws = await connectWs(port);
      const cases = [
        { secret: SK_SECRET, tag: 'openai' },
        { secret: GSK_SECRET, tag: 'groq' },
        { secret: NVAPI_SECRET, tag: 'nvidia' },
      ];
      for (const { secret, tag } of cases) {
        const framePromise = waitForLogFrame(ws, (p) => typeof p.msg === 'string' && p.msg.startsWith('key-' + tag));
        logger.info('key-' + tag + ' is ' + secret);
        const frame = await framePromise;
        assert.ok(!frame.payload.msg.includes(secret), `${tag} secret must be masked`);
        assert.ok(frame.payload.msg.includes('[REDACTED]'), `${tag} secret replaced inline`);
      }
    } finally {
      if (ws) try { ws.close(); } catch (_) {}
      await server.stop();
    }
  });

  test('clean log lines pass through unchanged — no over-redaction of ordinary text', async () => {
    const bus = createBus({ historySize: 50 });
    const logger = createLogger('info');
    const server = createServer(baseDeps(bus, logger));
    await server.ready;
    const { port } = server.httpServer.address();
    let ws;
    try {
      ws = await connectWs(port);
      const framePromise = waitForLogFrame(ws, (p) => p.msg === 'tts.chain-swapped');
      logger.info('tts.chain-swapped', { chain: 'edge,browser', count: 3 });
      const frame = await framePromise;
      assert.equal(frame.payload.msg, 'tts.chain-swapped');
      assert.equal(frame.payload.chain, 'edge,browser');
      assert.equal(frame.payload.count, 3);
      assert.ok(!JSON.stringify(frame.payload).includes('[REDACTED]'));
    } finally {
      if (ws) try { ws.close(); } catch (_) {}
      await server.stop();
    }
  });
});
