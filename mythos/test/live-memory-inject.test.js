'use strict';

// live-memory-inject.test.js — BUG-251.
//
// The Live/S2S path composed its system instruction from rules + persona +
// capabilities + skills + time — and NO memory of the operator. Everything the
// vault knew (Semantic/user-facts.md — music taste, preferences, durable facts)
// was reachable only from the typed compose-bar path's recallHybrid() call, so
// the primary spoken surface was structurally amnesiac: "MYTHOS did not
// remember previously requested songs" (incident inc-1786745736899-8) while
// the songs sat in user-facts.md the whole time. BUG-249 fixed the WRITE side
// (habit promotion); this pins the READ side — buildLiveSystemInstruction()
// must carry a size-capped OPERATOR FACTS block sourced from the semantic
// store's user-facts topic, honestly labelled as-of-session-start (the BUG-136
// staleness convention), gated by LIVE_MEMORY_INJECT, and degrade to no block
// (never a crashed session) when the store is absent, empty, or throwing.
//
// Injection is deliberately SYNCHRONOUS (semantic.topic() is a plain file
// read): buildLiveSystemInstruction() is called from live-session.js's
// buildSetup() on every open()/rotation, which cannot await — and per-turn
// recallHybrid() here would put an embeddings call on the session-open path.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fsNode = require('node:fs');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');
const { createSemanticStore } = require('../src/core/memory/semantic');

// ---- semantic.topic() unit tests against a real store over a temp vault ----

function tempVaultFs() {
  const root = fsNode.mkdtempSync(path.join(os.tmpdir(), 'mythos-sem-topic-'));
  return {
    root,
    vaultPath: (...s) => path.join(root, ...s),
    readText(rel, fallback) {
      try { return fsNode.readFileSync(path.join(root, rel), 'utf8'); }
      catch (_) { return fallback; }
    },
    writeText(rel, content) {
      const p = path.join(root, rel);
      fsNode.mkdirSync(path.dirname(p), { recursive: true });
      fsNode.writeFileSync(p, content);
    },
    ensureDir(p) { fsNode.mkdirSync(p, { recursive: true }); },
    removeFile(rel) { try { fsNode.unlinkSync(path.join(root, rel)); } catch (_) {} },
  };
}

describe('BUG-251: semantic.topic() direct read', () => {
  test('returns the facts of an existing topic without query scoring', () => {
    const fs = tempVaultFs();
    fs.writeText('Semantic/user-facts.md',
      '## user-facts\n\n<!-- {"id":"sem-1","ts":1} -->\n- Operator likes Pink Floyd\n- Operator likes Porcupine Tree\n');
    const store = createSemanticStore({ fs, config: {}, bus: { emit() {} }, logger: { info() {}, warn() {} } });
    const t = store.topic('user-facts');
    assert.ok(t, 'existing topic must be returned');
    assert.equal(t.topic, 'user-facts');
    assert.deepEqual(t.facts, ['Operator likes Pink Floyd', 'Operator likes Porcupine Tree']);
  });

  test('returns null for a missing topic, an empty name, and a header-only file', () => {
    const fs = tempVaultFs();
    fs.writeText('Semantic/empty.md', '## empty\n\n<!-- {"id":"sem-2","ts":1} -->\n');
    const store = createSemanticStore({ fs, config: {}, bus: { emit() {} }, logger: { info() {}, warn() {} } });
    assert.equal(store.topic('does-not-exist'), null);
    assert.equal(store.topic(''), null);
    assert.equal(store.topic(null), null);
    assert.equal(store.topic('empty'), null, 'a topic that parses to zero facts is not a topic worth injecting');
  });

  test('topic name is sanitized — path traversal cannot escape Semantic/', () => {
    const fs = tempVaultFs();
    fs.writeText('secret.md', '- top secret outside Semantic\n');
    const store = createSemanticStore({ fs, config: {}, bus: { emit() {} }, logger: { info() {}, warn() {} } });
    const t = store.topic('../secret');
    assert.ok(!t || !t.facts.join('').includes('top secret'),
      'a traversal-shaped name must never read outside Semantic/');
  });
});

// ---- Live setup-frame integration tests (pattern: bug-136 test) ----

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

// Drives a real live-open through the server with a fake Gemini socket and
// returns the composed setup-frame system-instruction text.
async function setupTextWith(memorySemantic, configOverrides) {
  const bus = createBus({ historySize: 50 });
  const sockets = [];
  const createLiveSocket = () => { const s = new FakeGeminiSocket(); sockets.push(s); return s; };
  const prevKey = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = 'test-key-for-bug-251';
  const deps = baseDeps(bus, {
    config: Object.assign({ VOICE_S2S_ENABLED: true }, configOverrides || {}),
    createLiveSocket,
  });
  if (memorySemantic !== undefined) deps.memory.semantic = memorySemantic;
  const server = createServer(deps);
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
    ws.close();
    return sockets[0].sent.find((f) => f.setup).setup.systemInstruction.parts[0].text;
  } finally {
    if (prevKey === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prevKey;
    await server.stop();
  }
}

describe('BUG-251: the Live setup frame carries operator facts from memory', () => {
  test('user-facts reach the setup frame, honestly labelled as-of-session-start', async () => {
    const text = await setupTextWith({
      topic: (name) => name === 'user-facts'
        ? { topic: 'user-facts', facts: ['Operator likes Pink Floyd', 'Operator likes Porcupine Tree'] }
        : null,
    });
    assert.match(text, /OPERATOR FACTS/, 'the facts block must be present and named');
    assert.ok(text.includes('Pink Floyd'), 'a stored fact must actually reach the frame');
    assert.ok(text.includes('Porcupine Tree'));
    // BUG-136 convention: anything composed once per open() must say so.
    const block = text.slice(text.indexOf('OPERATOR FACTS'));
    assert.match(block.split('\n\n')[0], /session-start/,
      'the facts block itself must carry the session-start staleness label');
  });

  test('the block is size-capped and keeps the NEWEST facts (append-only store grows at the tail)', async () => {
    const facts = [];
    for (let i = 0; i < 500; i++) facts.push('Fact number ' + i + ' about the operator, padded to a realistic sentence length for the cap.');
    const text = await setupTextWith({ topic: () => ({ topic: 'user-facts', facts }) });
    const block = text.slice(text.indexOf('OPERATOR FACTS'));
    const factsBlock = block.split('\n\n')[0];
    assert.ok(factsBlock.length <= 5000, 'block must be size-capped, got ' + factsBlock.length);
    assert.ok(factsBlock.includes('Fact number 499'), 'the newest fact must survive the cap');
    assert.equal(factsBlock.includes('Fact number 0 '), false, 'the oldest fact is what the cap drops');
  });

  test('LIVE_MEMORY_INJECT=false removes the block entirely (zero-code rollback)', async () => {
    const text = await setupTextWith(
      { topic: () => ({ topic: 'user-facts', facts: ['Operator likes Pink Floyd'] }) },
      { LIVE_MEMORY_INJECT: false }
    );
    assert.equal(text.includes('OPERATOR FACTS'), false);
    assert.equal(text.includes('Pink Floyd'), false);
  });

  test('no semantic store, an empty topic, or a throwing topic() degrades to no block — never a failed session', async () => {
    const noStore = await setupTextWith(undefined);
    assert.equal(noStore.includes('OPERATOR FACTS'), false);
    const emptyTopic = await setupTextWith({ topic: () => null });
    assert.equal(emptyTopic.includes('OPERATOR FACTS'), false);
    const throwing = await setupTextWith({ topic: () => { throw new Error('vault on fire'); } });
    assert.ok(throwing.length > 0, 'the rest of the instruction must still compose');
    assert.equal(throwing.includes('OPERATOR FACTS'), false);
  });
});
