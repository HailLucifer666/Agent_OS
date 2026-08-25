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

// The action.* relay (Agent Actions feed) is a PREFIX glob — matchGlob in
// src/core/bus/index.js is startsWith — so it also catches
// 'action.speak-requested', a fourth event with no `tool`/`ok` that already
// has its own dedicated subscriber (~line 1929) feeding proactiveSpeak(). Before
// this test's fix, the relay's fallback branches painted it as a nameless
// failed row in the Agent Actions feed and tripped the missing-tool warning
// meant for genuine outcome events. This test pins both halves: the
// dedicated handler still runs (a real 'done' comes back), and the relay
// ignores the event outright — no 'action' broadcast, no warning — while a
// real outcome event with a missing tool still gets both.
test('action relay ignores action.speak-requested — only real outcome events produce an action row', async () => {
  const bus = createBus({ historySize: 50 });
  const warnings = [];
  const server = createServer(baseDeps(bus, {
    logger: { info() {}, warn: (msg, meta) => warnings.push({ msg, meta }), error() {} },
  }));

  await server.ready;
  const addr = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  const received = [];
  ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));

  bus.emit('action.speak-requested', { text: 'hello' });
  // Wait for the dedicated subscriber's turn to actually finish (proves it
  // still fires, unmodified by this fix) before asserting on the relay.
  await waitForMessages(received, (m) => m.type === 'done', 2000);

  assert.equal(received.some((m) => m.type === 'action'), false,
    'action.speak-requested must never produce an "action" row in the Agent Actions feed');
  assert.equal(warnings.some((w) => w.msg === 'action-relay.missing-tool'), false,
    'action.speak-requested must not trip the missing-tool warning meant for real outcome events');

  // A genuine outcome event with no tool must still relay AND still warn.
  bus.emit('action.denied', { reason: 'tier-2-requires-confirm' });
  await waitForMessages(received, (m) => m.type === 'action', 2000);

  const actionMsgs = received.filter((m) => m.type === 'action');
  assert.equal(actionMsgs.length, 1, 'the real denial is the only action row relayed');
  assert.equal(actionMsgs[0].payload.state, 'denied');
  assert.equal(actionMsgs[0].payload.tool, null);
  assert.ok(warnings.some((w) => w.msg === 'action-relay.missing-tool' && w.meta.state === 'denied'),
    'a genuine outcome event with no tool must still trip the missing-tool warning');

  ws.close();
  await server.stop();
});

// REMEDIATION P1-4: FIX B's lifecycle bridge flipped entityStatus='alive' on
// ANY 'lifecycle.started'{component:'cortex'} — but cortex.start() ALSO fires
// during ordinary boot sequencing, before later fail-fast boot steps run. If
// a later step then throws, the process exits without ever emitting
// 'lifecycle.alive' — but the HUD had already been told 'alive' by the
// cortex step alone. A genuine 'lifecycle.alive' (fired exactly once, at the
// very end of a successful boot — src/core/lifecycle/index.js) must gate
// whether a later 'lifecycle.started'{cortex} (a genuine restart-cortex heal)
// is honored as "alive again".
test('entity-state: a cortex lifecycle.started BEFORE boot ever reaches alive is not painted alive (boot-race guard)', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus));
  let ws;

  try {
    await server.ready;
    const addr = server.httpServer.address();
    ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    await new Promise((resolve) => ws.on('open', resolve));

    const states = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'entity-state') states.push(msg.payload.status);
    });

    function waitForState(count, timeoutMs) {
      return new Promise((resolve, reject) => {
        const start = Date.now();
        const poll = setInterval(() => {
          if (states.length >= count) { clearInterval(poll); resolve(); }
          else if (Date.now() - start > (timeoutMs || 2000)) { clearInterval(poll); reject(new Error('timed out waiting for entity-state broadcasts')); }
        }, 5);
      });
    }

    // Cortex starting as part of ORDINARY boot sequencing — 'lifecycle.alive'
    // has not fired yet (boot isn't done; a later fail-fast step could still
    // abort it). Must NOT be painted alive.
    bus.emit('lifecycle.started', { component: 'cortex', generation: 1 });
    await waitForState(1);
    assert.notEqual(states[0], 'alive', 'a cortex start before the FIRST lifecycle.alive must not be painted alive (boot-race)');

    // Boot genuinely completes.
    bus.emit('lifecycle.alive', {});
    await waitForState(2);
    assert.equal(states[1], 'alive');

    // NOW a real restart-cortex heal (stop -> start) after boot has genuinely
    // completed once — this IS the case FIX B exists to handle.
    bus.emit('lifecycle.stopped', { component: 'cortex' });
    bus.emit('lifecycle.started', { component: 'cortex', generation: 2 });
    await waitForState(4);
    assert.equal(states[2], 'stopped');
    assert.equal(states[3], 'alive', 'a cortex restart AFTER boot has completed must restore alive');
  } finally {
    // Always tear down, even on assertion failure — an uncleaned real
    // HTTP/WS server otherwise keeps the process alive and hangs the whole
    // `node --test` run instead of failing this one test.
    if (ws) { try { ws.close(); } catch { /* best-effort */ } }
    await server.stop();
  }
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

// A7: 'health.anomaly' was subscribed and fed anomalyLog/broadcastHealth, but
// 'health.healed' (probes.js down->up transition, healer.js recovery) had no
// subscriber at all — the health card only ever accumulated "down" entries,
// never recoveries. Exercises the real bus + real server + real ws client,
// same shape as the 'tick' relay test above.
test('real bus health.healed event relays to a real WS client health broadcast, marked healed:true', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus));

  await server.ready; // address() is null until the listening event (async bind on Windows)
  const addr = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  const received = new Promise((resolve) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'health') resolve(msg);
    });
  });

  bus.emit('health.healed', { kind: 'provider-recovered', target: 'mistral' });
  const msg = await received;
  const entry = msg.payload.anomalies[msg.payload.anomalies.length - 1];
  assert.equal(entry.healed, true);
  assert.equal(entry.kind, 'provider-recovered');
  assert.equal(entry.target, 'mistral');

  ws.close();
  await server.stop();
});

// ---- Aether Phase 2: nearest-device voice routing (AETHER-WIRING.md) ----
// proactiveSpeak is triggered via the existing bus wire ('action.speak-
// requested' -> proactiveSpeak) so the routing branch is exercised through the
// real server + real WS client without needing a voice agent or brain.

function waitForMessages(received, predicate, ms) {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const timer = setInterval(() => {
      if (received.some(predicate) || Date.now() > deadline) { clearInterval(timer); resolve(); }
    }, 10);
  });
}

test('proactive speech routes to the Aether aggregator (caption-only done) when AETHER_AUDIO_ROUTE is on', async () => {
  const bus = createBus({ historySize: 50 });
  const spoke = [];
  const server = createServer(baseDeps(bus, {
    config: {
      MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
      MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000,
      AETHER_ENABLED: true, AETHER_AUDIO_ROUTE: true,
    },
    aetherSpeak: (t) => { spoke.push(t); return true; },
  }));

  await server.ready;
  const addr = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  const received = [];
  ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));

  // The bus wraps the second arg as e.payload, so the payload is {text} — the
  // shape the server's action.speak-requested subscription reads (e.payload.text).
  bus.emit('action.speak-requested', { text: 'hello aether device' });
  await waitForMessages(received, (m) => m.type === 'done', 2000);

  assert.deepEqual(spoke, ['hello aether device'], 'the text must reach the aggregator as a say');
  assert.ok(received.some((m) => m.type === 'proactive-speech'), 'HUD must still get the announcement');
  const done = received.find((m) => m.type === 'done');
  assert.ok(done, 'the turn must resolve with a done');
  assert.equal(done.chunked, true, 'chunked:true + zero chunks = silent caption-only finish (voice-loop.js deliverReply)');
  assert.equal(received.some((m) => m.type === 'speech-chunk'), false, 'no local audio chunks when routed');

  ws.close();
  await server.stop();
});

test('proactive speech falls back to the local TTS path when the Aether socket is down', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus, {
    config: {
      MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
      MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000,
      AETHER_ENABLED: true, AETHER_AUDIO_ROUTE: true,
    },
    aetherSpeak: () => false, // aggregator socket down -> fail open
  }));

  await server.ready;
  const addr = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  const received = [];
  ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));

  bus.emit('action.speak-requested', { text: 'local fallback hello' });
  await waitForMessages(received, (m) => m.type === 'done', 2000);

  assert.ok(received.some((m) => m.type === 'proactive-speech'), 'announcement must still broadcast locally');
  assert.ok(received.some((m) => m.type === 'speech-chunk'), 'the local TTS path must run (chunks, null audio in the test env)');
  const done = received.find((m) => m.type === 'done');
  assert.ok(done, 'the local path must still finish the turn');

  ws.close();
  await server.stop();
});

// The interactive branch (sendSpokenReply) needs a real utterance turn through
// the voice agent — same stub-brain harness as test/tts-down-sentence-chunks.
test('an interactive utterance reply routes to the Aether aggregator (caption-only done, no local chunks)', async () => {
  const bus = createBus({ historySize: 50 });
  const spoke = [];
  const REPLY = 'Routing this reply to the nearest device now.';
  const server = createServer(baseDeps(bus, {
    config: {
      MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
      MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000,
      AETHER_ENABLED: true, AETHER_AUDIO_ROUTE: true,
    },
    memory: {
      working: { tick: 0, activeGoalId: null },
      fs: fakeFs(),
      episodic: { write: async () => ({ ref: 'ep-1' }), recall: () => [] },
      semantic: { recall: () => [] },
      recallHybrid: async () => [],
    },
    brain: {
      think: async () => ({
        content: JSON.stringify({ say: REPLY, actions: [], needs_result: false }),
        parsed: { say: REPLY, actions: [], needs_result: false },
        offline: false,
      }),
    },
    leash: {
      check: () => ({ allow: true, tier: 0, requireConfirm: false }),
      confirm: { create: () => 'cf-1', accept: () => null, reject: () => true },
    },
    aetherSpeak: (t) => { spoke.push(t); return true; },
  }));

  await server.ready;
  const addr = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  const chunks = [];
  const donePromise = new Promise((resolve) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'speech-chunk') chunks.push(msg);
      if (msg.type === 'done') resolve(msg);
    });
  });

  ws.send(JSON.stringify({ type: 'utterance', reqId: 'r1', text: 'say something' }));
  const done = await donePromise;

  assert.equal(spoke.length, 1, 'the spoken reply must reach the aggregator as exactly one say');
  assert.ok(spoke[0].includes('nearest device'), `reply text must be the spoken answer, got: ${spoke[0]}`);
  assert.equal(done.chunked, true, 'caption-only done keeps the turn silent locally');
  assert.equal(chunks.length, 0, 'no local audio chunks when the reply is routed');

  ws.close();
  await server.stop();
});
