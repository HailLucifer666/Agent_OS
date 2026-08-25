'use strict';

// test/anti-drift-secret-leak-sentinel.test.js — Task A3: widen the AD-8
// secret-leak gate from the Electron preload (test/anti-drift-no-key-to-client
// .test.js) to the two client-bound surfaces that guard did NOT cover:
//
//   1. every WS OUT frame a connected client can receive — the live broadcast
//      fan-out (broadcastAll) AND the replay buffers a {type:'subscribe',
//      replay:true} message flushes to that one connection;
//   2. the response bodies of the five read-only /api routes the HUD boots
//      against: /api/config/settings, /api/config/s2s, /api/setup/status,
//      /api/status, /api/audit/recent.
//
// AD-8 (V2 spine §1) says no WS OUT message and no /api/* response body may
// ever contain a value matching GOOGLE_API_KEY/GROQ_API_KEY/etc. The method:
// plant one unique sentinel as the value of all 13 secret keys from
// .env.example BEFORE the server boots, then assert that exact string appears
// in ZERO collected frames and ZERO response bodies. Key NAMES are allowed to
// travel these surfaces (setup/status reports them by design) — only VALUES
// leak, and only the sentinel is a value, so a match is a real leak. If this
// ever fails, do NOT weaken the assertion — find the route/frame that leaked.
//
// Boot recipe is the verified one from test/server-log-redaction.test.js
// (Task A2): createServer(baseDeps(bus, logger)) with MYTHOS_PORT:0 in the
// deps object (the schema min-1024 check applies only to env/config-file
// validation, not the deps object) and the real ephemeral port read from
// server.httpServer.address() after `await server.ready`.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

// String concatenation so secret scanners don't flag this test file (repo
// convention, see test/server-log-redaction.test.js). One shared sentinel is
// enough: the gate is "this value never appears anywhere", not "which key
// leaked" — and it is deliberately NOT secret-shaped (no sk-/gsk_/Bearer/
// api_key: prefix), so credential-scanner redaction can never mask it into a
// false pass. If it reaches a client, it reaches it verbatim.
const SENTINEL = 'SENTINEL_LEAK_' + 'CHECK_' + 'x'.repeat(20);

// The 13 secret keys documented in mythos/.env.example (task brief list).
const SECRET_KEYS = [
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'NIM_API_KEY',
  'OPENROUTER_API_KEY',
  'CEREBRAS_API_KEY',
  'GOOGLE_API_KEY',
  'HERMES_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'LLM_API_KEY',
  'PERPLEXITY_API_KEY',
  'EXA_API_KEY',
];

// The five read-only routes the HUD fetches at boot. Collected as raw text —
// the assertion is substring-based, so JSON shape does not matter.
const ROUTES = [
  '/api/config/settings',
  '/api/config/s2s',
  '/api/setup/status',
  '/api/status',
  '/api/audit/recent',
];

function fakeFs() {
  return { vaultPath: (...s) => path.join('/test-vault', ...s) };
}

// Silent logger with the real logger's onLog hook: the server's relay
// (server/index.js) registers via logger.onLog, so 'log' frames still flow
// through the exact production choke point — but nothing is written to
// stdout, keeping the suite output pristine.
function fakeLogger() {
  const listeners = [];
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    onLog: (fn) => { listeners.push(fn); },
    // test-only: emit an entry exactly like logger.js would notify listeners
    _emit: (entry) => { for (const fn of listeners) fn(entry); },
  };
}

function baseDeps(bus, logger, overrides) {
  return Object.assign({
    bus,
    config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '' },
    logger,
    memory: { working: { tick: 0, activeGoalId: null }, episodic: { write: async () => {} }, audit: { query: () => [] }, fs: fakeFs() },
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

function connectWs(port, onFrame) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    // Attach the collector BEFORE 'open' resolves: the server sends an initial
    // entity-state snapshot the moment the connection is accepted, and a
    // listener added after open would silently miss it.
    if (onFrame) ws.on('message', (raw) => onFrame(raw.toString()));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Plant the sentinel under every secret key; return a restorer for finally.
// Captures prior values (including undefined) so the process env comes back
// exactly as it was — other test files in the same `node --test` process must
// not see the sentinel.
function plantSentinels() {
  const saved = {};
  for (const key of SECRET_KEYS) {
    saved[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    process.env[key] = SENTINEL;
  }
  return function restore() {
    for (const key of SECRET_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

// Assert the sentinel value appears in none of the collected strings.
// `label` names the surface in the failure message so a real leak is
// immediately attributable to a route or frame type.
function assertNoSentinel(strings, label) {
  for (const s of strings) {
    if (s.includes(SENTINEL)) {
      assert.fail(`AD-8 LEAK: the secret-value sentinel appeared in ${label}: ${s.slice(0, 400)}`);
    }
  }
}

describe('AD-8 sentinel gate (A3): secret values never reach WS frames or /api bodies', () => {
  test('live + replayed WS frames and five REST bodies contain zero sentinel values', async () => {
    const restoreEnv = plantSentinels();
    const bus = createBus({ historySize: 50 });
    const logger = fakeLogger();
    const deps = baseDeps(bus, logger);
    // /api/config/settings serializes the CONFIG object, not process.env — in
    // production loadConfig copies env values into it, so plant the sentinel
    // into the schema-keyed config entries too. Without this the route would
    // be scanned against empty values and the gate would be weaker than it
    // looks: a future edit breaking isSecretShaped redaction must leak the
    // sentinel here, not an empty string.
    for (const key of SECRET_KEYS) deps.config[key] = SENTINEL;
    const server = createServer(deps);
    await server.ready;
    const { port } = server.httpServer.address();
    let ws;
    try {
      const frames = [];
      ws = await connectWs(port, (s) => frames.push(s));

      // Replay for every buffered stream (log/action/brain-spend are the three
      // replay buffers; the rest are live-only subscriptions). This also makes
      // the server flush its boot-time log entries (tts.chain, server.listening)
      // to THIS connection — the log replay path is therefore covered even
      // though no client was connected when they were emitted.
      ws.send(JSON.stringify({
        type: 'subscribe',
        types: ['log', 'action', 'brain-spend', 'tick', 'entity-state', 'health', 'audit', 'perception', 'goal-update', 'token-usage'],
        replay: true,
      }));

      // Push traffic through the live broadcast fan-out so the collection
      // window holds real frames of several types, not just the connect-time
      // entity-state snapshot. These payloads are benign by construction — the
      // assertion is that the sentinel (which lives only in process.env) never
      // rides along on ANY frame.
      bus.emit('tick', { tick: 1, perceptions: [] });
      bus.emit('action.completed', { tool: 'sentinel_probe', ok: true });
      bus.emit('brain-spend', { tokens: 1, lane: 'voice' });
      bus.emit('audit.decision', { tool: 'sentinel_probe', tier: 0, decision: 'completed' });
      logger._emit({ ts: new Date().toISOString(), level: 'info', msg: 'sentinel.probe', probe: 'a3' });

      // GET the five boot routes while the socket keeps collecting. Every one
      // must answer 200: a 500 body is an error stub, and scanning only error
      // stubs would make this gate weaker than it looks.
      const bodies = [];
      for (const route of ROUTES) {
        const res = await fetch(`http://127.0.0.1:${port}${route}`);
        assert.equal(res.status, 200, `${route} must answer 200 so its real body is what gets scanned`);
        bodies.push(await res.text());
      }

      // Short collection window for the broadcasts above to land.
      await sleep(500);

      assert.ok(frames.length > 0, 'expected to collect at least one WS frame');
      assert.equal(bodies.length, ROUTES.length, 'every route returned a body');
      assertNoSentinel(frames, 'a WS frame');
      assertNoSentinel(bodies, 'an /api response body');
    } finally {
      if (ws) try { ws.close(); } catch (_) {}
      await server.stop();
      restoreEnv();
    }
  });

  test('replay buffers flushed by a late subscriber carry no sentinel values', async () => {
    const restoreEnv = plantSentinels();
    const bus = createBus({ historySize: 50 });
    const logger = fakeLogger();
    const server = createServer(baseDeps(bus, logger));
    await server.ready;
    const { port } = server.httpServer.address();
    let ws;
    try {
      // Emit with NO client connected: these land only in the replay buffers
      // (log/action/brain-spend). A leak that only exists in the buffered copy
      // is caught here, not by the live fan-out.
      bus.emit('action.completed', { tool: 'replay_probe', ok: true });
      bus.emit('brain-spend', { tokens: 2, lane: 'code' });
      logger._emit({ ts: new Date().toISOString(), level: 'info', msg: 'replay.probe', probe: 'a3-replay' });

      const frames = [];
      ws = await connectWs(port, (s) => frames.push(s));
      ws.send(JSON.stringify({ type: 'subscribe', types: ['log', 'action', 'brain-spend'], replay: true }));

      await sleep(500);

      // Sanity: the replayed probes actually arrived, so the zero-sentinel
      // result below is about the buffers, not about an empty collection.
      const joined = frames.join('\n');
      assert.ok(joined.includes('replay_probe'), 'the action replay buffer was flushed');
      assert.ok(joined.includes('replay.probe'), 'the log replay buffer was flushed');
      assertNoSentinel(frames, 'a replayed WS frame');
    } finally {
      if (ws) try { ws.close(); } catch (_) {}
      await server.stop();
      restoreEnv();
    }
  });
});
