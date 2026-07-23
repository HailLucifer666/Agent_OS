'use strict';

// server.test.js — Phase 9 real-instance integration tests (Lesson #4: real bus,
// real server, real ws client — the D-38 class of seam bug is invisible to fakes).
// Tests 1 and 2 are the spec's own Test Plan fixtures, verbatim.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const path = require('path');
const { createServer } = require('../server');
const pcChild = require('../adapters/pc-child');
const groqStt = require('../providers/groq-stt');

// Minimal fs-store stand-in — the real one resolves paths under the vault
// root; tests never touch the filesystem, so any deterministic join works.
function fakeFs() {
  return { vaultPath: (...segments) => path.join('/test-vault', ...segments) };
}

function baseDeps(bus, overrides) {
  return Object.assign({
    bus,
    config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000 },
    logger: { info() {}, warn() {}, error() {} },
    memory: { working: { tick: 0, activeGoalId: null }, episodic: { write: async () => {} }, fs: fakeFs() },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
    leash: { confirm: { create: () => 'cf-1', accept: () => null, reject: () => true } },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({}) },
    agentActions: {
      assembleKanbanPlan: () => ({ job: { id: 'j1', status: 'queued' } }),
      buildKanbanCard: () => ({ job: { id: 'j1', status: 'queued' }, board: { cards: [] } }),
      reviewKanbanCard: () => ({ job: { id: 'j1', status: 'queued' } }),
    },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
  }, overrides || {});
}

function httpGet(port, pathName) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathName }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
}

function httpPost(port, pathName, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method: 'POST', headers: headers || {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('real bus tick event relays to a real WS client as type:tick', async () => {
  const bus = createBus({ historySize: 50 });
  const fakeMemory = { working: { tick: 0, activeGoalId: null }, episodic: { write: async () => {} }, fs: fakeFs() };
  const server = createServer(baseDeps(bus, { memory: fakeMemory }));

  await server.ready; // address() is null until the listening event (async bind on Windows)
  const addr = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  const received = new Promise((resolve) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'tick') resolve(msg);
    });
  });

  bus.emit('tick', { tick: 5, perceptions: 2 });
  const msg = await received;
  assert.equal(msg.payload.tick, 5);
  assert.equal(msg.payload.perceptions, 2);
  assert.equal(msg.payload.activeGoal, null);

  ws.close();
  await server.stop();
});

test('confirm-reply accept invokes the effector via dispatchAction, not a shadow path', async () => {
  const bus = createBus({ historySize: 50 });
  const invoked = [];
  const fakeEffectors = {
    breakers: new Map(),
    invoke: async (tool, args) => { invoked.push({ tool, args }); return { ok: true }; },
    effectors: new Map(),
  };
  let storedAction = null;
  // P5's real confirm.js signature is create(summary, action, connectionId) and
  // accept(confirmId, connectionId) — 2 args (spec CROSS-PHASE FIX note).
  const fakeLeash = {
    confirm: {
      create: (summary, action, connectionId) => { storedAction = action; return 'cf-42'; },
      accept: (id, connectionId) => (id === 'cf-42' ? storedAction : null),
      reject: () => true,
    },
  };
  const server = createServer(baseDeps(bus, {
    memory: { working: { tick: 0 }, episodic: { write: async () => {} }, fs: fakeFs() },
    effectors: fakeEffectors,
    leash: fakeLeash,
  }));

  await server.ready; // address() is null until the listening event (async bind on Windows)
  const addr = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  fakeLeash.confirm.create('Kill session x?', { tool: 'kill_session', args: { sessionId: 'x' } }, 'conn-1');
  ws.send(JSON.stringify({ type: 'confirm-reply', confirmId: 'cf-42', accept: true }));

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(invoked.length, 1, 'effector should have been invoked exactly once via dispatchAction');
  assert.equal(invoked[0].tool, 'kill_session');

  ws.close();
  await server.stop();
});

test('confirm-reply accept resolves a cortex {decision,goalId,tier} envelope too', async () => {
  const bus = createBus({ historySize: 50 });
  const invoked = [];
  const debits = [];
  const envelope = { decision: { tool: 'run_build', args: { target: 'x' } }, goalId: 'g-9', tier: 3 };
  const server = createServer(baseDeps(bus, {
    effectors: { breakers: new Map(), invoke: async (tool, args) => { invoked.push({ tool, args }); return { ok: true }; }, effectors: new Map() },
    // cortex creates 'system'-scoped confirms; the server must fall back to the
    // 'system' sentinel when the confirm isn't bound to this connection.
    leash: { confirm: { create: () => 'cf-sys', accept: (id, conn) => (id === 'cf-sys' && conn === 'system' ? envelope : null), reject: () => false } },
    goals: { debitBudget: (id, usage) => debits.push({ id, usage }) },
  }));

  await server.ready; // address() is null until the listening event (async bind on Windows)
  const addr = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  ws.send(JSON.stringify({ type: 'confirm-reply', confirmId: 'cf-sys', accept: true }));
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(invoked.length, 1);
  assert.equal(invoked[0].tool, 'run_build');
  assert.equal(debits.length, 1, 'goal budget must be debited for envelope confirms');
  assert.equal(debits[0].id, 'g-9');

  ws.close();
  await server.stop();
});

test('GET /api/stats returns the HUD density snapshot shape over real HTTP', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus, {
    memory: {
      working: { tick: 0, activeGoalId: null },
      episodic: { write: async () => {} },
      stats: () => ({
        episodic: { count: 12 }, semantic: { count: 3 }, skills: { count: 1 },
        identity: { count: 2 }, working: { keys: 0 }, audit: { count: 7 },
      }),
      fs: fakeFs(),
    },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 4, done: 1, active: 3 }) },
    kanbanEffector: { listBoard: () => ({ cards: [{ id: 'c1', lane: 'backlog' }, { id: 'c2', lane: 'done' }, { id: 'c3', lane: 'backlog' }] }) },
    pipelineEffector: { listAll: () => ({ capture: [{ id: 'p1' }], 'human-gate': [], execute: [], shipped: [{ id: 'p2' }] }) },
  }));

  await server.ready; // address() is null until the listening event (async bind on Windows)
  const { port } = server.httpServer.address();
  const res = await httpGet(port, '/api/stats');
  assert.equal(res.status, 200);
  assert.equal(res.body.memory.episodic.count, 12);
  assert.equal(res.body.memory.audit.count, 7);
  assert.deepEqual(res.body.goals, { total: 4, active: 3, completed: 1 });
  assert.equal(res.body.kanban.total, 3);
  assert.deepEqual(res.body.kanban.byLane, { backlog: 2, done: 1 });
  assert.equal(res.body.pipeline.total, 2);
  assert.equal(res.body.pipeline.byStage.capture, 1);

  await server.stop();
});

test('GET /api/memory/:store browses episodic via tail and rejects unknown stores', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus, {
    memory: {
      working: { tick: 0, activeGoalId: null },
      episodic: {
        write: async () => {},
        tail: (n) => [{ ts: '2026-07-10T00:00:00Z', summary: 'first', kind: 'action' }].slice(0, n),
      },
      audit: { query: (opts) => [{ ts: '2026-07-10T00:00:01Z', tier: 3, decision: 'confirm', tool: 'kill_session' }].slice(0, opts.limit) },
      fs: fakeFs(),
    },
  }));

  await server.ready; // address() is null until the listening event (async bind on Windows)
  const { port } = server.httpServer.address();
  const ep = await httpGet(port, '/api/memory/episodic?limit=10');
  assert.equal(ep.status, 200);
  assert.equal(ep.body.store, 'episodic');
  assert.equal(ep.body.entries.length, 1);
  assert.equal(ep.body.entries[0].summary, 'first');

  const audit = await httpGet(port, '/api/memory/audit?limit=10');
  assert.equal(audit.status, 200);
  assert.match(audit.body.entries[0].summary, /T3 confirm kill_session/);

  const bad = await httpGet(port, '/api/memory/nonsense');
  assert.equal(bad.status, 404);

  await server.stop();
});

test('perception relay is salience-gated: below-threshold non-ws perceptions are NOT broadcast', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus));

  await server.ready; // address() is null until the listening event (async bind on Windows)
  const addr = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  const perceptions = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'perception') perceptions.push(msg.payload);
  });

  // Shapes below match how real sensors actually call bus.emit(type, payload)
  // — the payload IS `summary` (every sensor) with an optional untruncated
  // `text` (perception.voice only). A prior version of this test used a
  // synthetic double-nested `{payload:{text:...}}` shape that matched a bug
  // in the server's relay (it read `p.payload.text`, but `p` is already the
  // emitted payload — real sensors never nest a second `.payload` inside it),
  // masking that every non-voice sensor's description was silently dropped
  // on the wire. Fixed in server/index.js's perception.* relay; this test now
  // exercises the real shape.

  // Below MYTHOS_IDLE_SALIENCE (0.3), channel 'file' — must be filtered.
  bus.emit('perception.file', { channel: 'file', kind: 'file-change', salience: 0.1, summary: 'noise' });
  // Above threshold — must relay.
  bus.emit('perception.file', { channel: 'file', kind: 'file-change', salience: 0.9, summary: 'signal' });
  // 'ws' channel — always relays regardless of salience. text (untruncated),
  // when present, must win over summary.
  bus.emit('perception.ws', { channel: 'ws', kind: 'utterance', salience: 0, summary: 'human (clipped)', text: 'human' });

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(perceptions.length, 2, 'exactly the high-salience and ws perceptions relay');
  assert.equal(perceptions[0].text, 'signal');
  assert.equal(perceptions[1].text, 'human');

  ws.close();
  await server.stop();
});

test('verifyClient rejects a foreign Origin on WS upgrade (CSWSH guard)', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus));

  await server.ready; // address() is null until the listening event (async bind on Windows)
  const { port } = server.httpServer.address();
  const evil = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'http://evil.example' });
  const rejected = await new Promise((resolve) => {
    evil.on('unexpected-response', (req, res) => resolve(res.statusCode));
    evil.on('open', () => resolve('opened'));
    evil.on('error', () => {}); // ws also emits error after unexpected-response
  });
  assert.equal(rejected, 403, 'foreign-origin upgrade must be rejected with 403');

  // Same-origin client still connects. ALLOWED_ORIGINS is built from
  // config.MYTHOS_PORT (0 in tests), so the allowlisted origin is literally
  // 'http://localhost:0' — the check is set membership, not live-port equality.
  const ok = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'http://localhost:0' });
  const okResult = await new Promise((resolve) => {
    ok.on('open', () => resolve('opened'));
    ok.on('unexpected-response', (req, res) => resolve(res.statusCode));
    ok.on('error', () => {});
  });
  assert.equal(okResult, 'opened', 'allowlisted origin must be accepted');
  ok.close();

  await server.stop();
});

test('GET /api/media propagates the real error string on a pc-child failure (BUG-004)', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus));

  // pcChild is a module-level singleton required directly by server/index.js
  // (not injected via deps), so we monkey-patch its sendCommand for this test
  // and restore it afterward to avoid leaking state into other tests.
  const originalSendCommand = pcChild.sendCommand;
  pcChild.sendCommand = async () => ({ ok: false, error: 'Media session not found' });

  try {
    await server.ready; // address() is null until the listening event (async bind on Windows)
    const { port } = server.httpServer.address();
    const res = await httpGet(port, '/api/media');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, 'Media session not found', 'must be the real pc-child error, not undefined');
  } finally {
    pcChild.sendCommand = originalSendCommand;
    await server.stop();
  }
});

test('POST /api/voice/transcribe surfaces a Groq failure as a real HTTP 503, never a 200 masquerade', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus));

  // groq-stt is a module-level singleton required directly by server/index.js
  // (not injected via deps), same monkey-patch pattern as pcChild above.
  const originalIsAvailable = groqStt.isAvailable;
  const originalTranscribe = groqStt.transcribe;
  groqStt.isAvailable = () => true;
  groqStt.transcribe = async () => { throw new Error('groq transcription failed: 500 boom'); };

  try {
    await server.ready;
    const { port } = server.httpServer.address();
    const res = await httpPost(port, '/api/voice/transcribe', Buffer.from('fake-audio'), { 'Content-Type': 'audio/webm' });
    assert.equal(res.status, 503, 'a Groq failure must be a real HTTP error, never HTTP 200 with ok:false hidden in the body');
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, 'stt-down');
  } finally {
    groqStt.isAvailable = originalIsAvailable;
    groqStt.transcribe = originalTranscribe;
    await server.stop();
  }
});
