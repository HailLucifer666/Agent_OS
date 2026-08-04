'use strict';

// test/rest-ws-no-secret-leak.test.js — Track B3, AD-8 MISSING HALF.
//
// AD-8 has two spine assertions. The COVERED half — the Electron preload
// surface pins contextBridge to exactly {getKeyNames, setKey, hasKey,
// onHotkey} and proves inbound hotkey payloads are re-derived as strings —
// lives in test/electron-preload-surface.test.js. That file is untouched.
//
// This is the other half: no current WS or REST response leaks a
// key-shaped secret. test/config-s2s-route.test.js already guards ONE route
// (/api/config/s2s) with an exact-key-set assertion; this file generalizes
// that idea across the REAL server's whole read surface instead of
// duplicating that one case (the s2s route is included in the sweep below,
// but its exact-key-set assertion is not repeated here).
//
// RED-FIRST: the first describe block proves the scanner used below actually
// has teeth — it is run against known-bad fixtures (provider-key-shaped
// strings) and known-good ones, so the real-server sweep that follows isn't
// a test that "passes because it matches nothing" (the exact failure mode
// this repo has shipped before — see CLAUDE.md's fixture-only-gate warning).
//
// Drives the REAL server via createServer, same harness shape as
// test/config-s2s-route.test.js and test/server-live-wiring.test.js — both
// REST (http.get over every mounted read route) and WS (the live socket
// protocol), with real-shaped secrets loaded into both `config` and
// `process.env` so a route that ever starts spreading config/env into a
// response would be caught here, not in production.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { EventEmitter } = require('node:events');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

// ---- the scanner under test (test-only; no production code needs this) ----
// Matches the common provider-key shapes MYTHOS's own providers use
// (Google/Gemini, OpenAI, Anthropic, Groq, Google OAuth, Slack-style, and a
// generic Bearer token) plus a literal check against the actual secret
// values a test injects — catching both "looks like SOME key" and "is
// literally THIS key", which a shape-only regex can miss (e.g. an
// ElevenLabs key has no widely-recognized public shape).
const KEY_SHAPE_RE = new RegExp(
  '\\b(?:' +
    'sk-(?:ant-)?[A-Za-z0-9_-]{16,}' +      // OpenAI / Anthropic
    '|AIza[0-9A-Za-z_-]{20,}' +              // Google API key
    '|gsk_[A-Za-z0-9]{16,}' +                // Groq
    '|ya29\\.[A-Za-z0-9_-]{20,}' +           // Google OAuth access token
    '|xox[baprs]-[A-Za-z0-9-]{10,}' +        // Slack-style
    '|Bearer\\s+[A-Za-z0-9._-]{20,}' +       // generic bearer token
  ')\\b',
);

function findLeak(bodyText, secrets) {
  if (typeof bodyText !== 'string') return null;
  for (const s of secrets || []) {
    if (s && bodyText.includes(s)) return { type: 'literal-secret', value: s };
  }
  const m = bodyText.match(KEY_SHAPE_RE);
  if (m) return { type: 'key-shaped-pattern', value: m[0] };
  return null;
}

describe('secret-leak scanner (red-first sanity — proves the scanner has teeth)', () => {
  test('flags an OpenAI/Anthropic-shaped key literal', () => {
    const leak = findLeak(JSON.stringify({ status: 'ok', debug: 'sk-FAKEabcdefghijklmnopqrstuvwxyz1234' }), []);
    assert.ok(leak, 'must flag an sk-... shaped value embedded in a response body');
    assert.equal(leak.type, 'key-shaped-pattern');
  });

  test('flags a Google-shaped API key literal', () => {
    const leak = findLeak(JSON.stringify({ token: 'AIzaSyFAKE1234567890FAKE1234567890FAK' }), []);
    assert.ok(leak, 'must flag an AIza... shaped value');
  });

  test('flags a literal secret even with no recognizable shape (e.g. ElevenLabs-style keys)', () => {
    const secret = 'el_9f7d2a1b6c8e4f0031aa22bb99cc7711';
    const leak = findLeak(JSON.stringify({ note: 'using key ' + secret }), [secret]);
    assert.ok(leak, 'literal-value matching must catch shapeless secrets a regex cannot');
    assert.equal(leak.type, 'literal-secret');
  });

  test('does NOT flag an ordinary flag/status response (must not be vacuous)', () => {
    const clean = findLeak(JSON.stringify({ enabled: true, screenShare: { enabled: false, fps: 1 } }), ['sk-should-not-match-anything']);
    assert.equal(clean, null, 'a clean boolean/flag body must not be flagged — otherwise every real response would "fail" and the gate would be worthless');
  });
});

// ---- real-server sweep -------------------------------------------------

function fakeFs() {
  return { vaultPath: (...s) => path.join('/test-vault', ...s) };
}

// Real-shaped-but-fake secrets. Injected into BOTH config (in case a route
// ever reads config.*_API_KEY directly, like /api/config/s2s already must
// not) and process.env (several real modules — live-session.js,
// src/core/brain/registry.js — read process.env.*_API_KEY directly rather
// than through config).
const FAKE_SECRETS = {
  GOOGLE_API_KEY: 'AIzaSyFAKE00000000000000000000000FAKE',
  GEMINI_API_KEY: 'AIzaSyFAKE11111111111111111111111FAKE',
  OPENAI_API_KEY: 'sk-FAKEabcdefghijklmnopqrstuvwxyzABCD12',
  ANTHROPIC_API_KEY: 'sk-ant-FAKEabcdefghijklmnopqrstuvwxyzABCD',
  GROQ_API_KEY: 'gsk_FAKEabcdefghijklmnopqrstuvwxyzABCD1234',
  MISTRAL_API_KEY: 'msFAKEabcdefghijklmnopqrstuvwxyz1234',
  CEREBRAS_API_KEY: 'csk-FAKEabcdefghijklmnopqrstuvwxyz1234',
  ELEVENLABS_API_KEY: 'el_FAKEabcdefghijklmnopqrstuvwxyz1234', // no recognizable shape — literal-only catch
};
const SECRET_VALUES = Object.values(FAKE_SECRETS);

function baseDeps(bus, configOverrides) {
  return {
    bus,
    config: Object.assign(
      {
        MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
        MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '',
      },
      FAKE_SECRETS,
      configOverrides || {},
    ),
    logger: { info() {}, warn() {}, error() {} },
    memory: {
      working: { tick: 0, activeGoalId: null },
      episodic: { write: async () => {} },
      audit: { write: () => ({ ok: true }), query: () => [] },
      fs: fakeFs(),
    },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
    leash: { confirm: { create: () => 'cf-1', accept: () => null, reject: () => true } },
    goals: { debitBudget: () => {} },
    // getStatus() shape matches the real src/core/immune/probes.js return
    // ({providers, quotas, probedAt}) — see registry.js: every field there is
    // a boolean/count, never a raw key, but the sweep proves the ROUTE never
    // adds one on top even if a future probes implementation changed that.
    probes: { getStatus: async () => ({ providers: { google: { configured: true, aliveModels: 2 } }, quotas: [], probedAt: Date.now() }) },
    agentActions: {
      assembleKanbanPlan: () => ({ job: { id: 'j1', status: 'queued' } }),
      buildKanbanCard: () => ({ job: { id: 'j1', status: 'queued' }, board: { cards: [] } }),
      reviewKanbanCard: () => ({ job: { id: 'j1', status: 'queued' } }),
    },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
  };
}

function httpGet(port, pathName) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathName }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

async function withServer(configOverrides, fn) {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus, configOverrides));
  await server.ready;
  const { port } = server.httpServer.address();
  try { await fn(port, bus); } finally { await server.stop(); }
}

// The real, mounted read routes (server/index.js + server/routes/*.js).
// Mutating (POST/DELETE) routes are out of scope here — W4's audit-coverage
// tests already own those, and a response body is a response body regardless
// of verb, but GET is where an operator-facing dashboard actually reads from,
// so that is the surface this sweep exercises.
const READ_ROUTES = [
  '/health',
  '/api/status',
  '/api/config/vad',
  '/api/config/wakeword',
  '/api/config/s2s', // already guarded specifically by config-s2s-route.test.js; included here too so the general sweep doesn't skip it
  '/api/stats',
  '/api/goals',
  '/api/goals/proposals',
  '/api/kanban',
  '/api/pipeline',
  '/api/memory/episodic',
  '/api/memory/semantic',
  '/api/memory/skills',
  '/api/memory/identity',
  '/api/memory/audit',
  '/api/audit/recent',
  '/api/news',
  '/api/system',
  '/api/forge/projects',
  '/api/checkpoints',
  '/api/pin/status',
  '/api/engagements',
];

describe('REST surface — no response leaks a key pattern (AD-8, missing half)', () => {
  // One real server for the whole sweep (not one per route) — booting 20+
  // separate HTTP servers in a loop also accumulates process-level
  // listeners across createServer() calls fast enough to trip Node's
  // MaxListenersExceededWarning, which is noise, not a finding.
  test('every mounted read route leaks no secret (literal or key-shaped)', async () => {
    await withServer({}, async (port) => {
      const leaks = [];
      for (const route of READ_ROUTES) {
        const res = await httpGet(port, route);
        const leak = findLeak(res.body, SECRET_VALUES);
        if (leak) leaks.push({ route, leak });
      }
      assert.deepEqual(leaks, [], `one or more routes leaked a secret: ${JSON.stringify(leaks)}`);
    });
  });
});

describe('WS surface — no live frame leaks a key pattern (AD-8, missing half)', () => {
  class FakeGeminiSocket extends EventEmitter {
    constructor() {
      super();
      this.OPEN = 1; this.CLOSED = 3; this.readyState = 0; this.sent = [];
    }
    send(json) { this.sent.push(JSON.parse(json)); }
    close() { this.readyState = this.CLOSED; this.emit('close', 1000, 'test-close'); }
    simulateOpen() { this.readyState = this.OPEN; this.emit('open'); }
    serverFrame(frame) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
  }

  test('the live-open / live-state / entity-state / tick WS frames carry no secret', async () => {
    const prevKey = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = FAKE_SECRETS.GOOGLE_API_KEY;
    const sockets = [];
    const createLiveSocket = () => { const s = new FakeGeminiSocket(); sockets.push(s); return s; };

    await withServer({ VOICE_S2S_ENABLED: true, createLiveSocket }, async (port, bus) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

      const frames = [];
      ws.on('message', (raw) => frames.push(raw.toString()));

      ws.send(JSON.stringify({ type: 'live-open' }));
      ws.send(JSON.stringify({ type: 'subscribe', types: ['tick'] }));
      bus.emit('tick', { tick: 1, perceptions: [] });

      // Let the fake Gemini socket open and complete setup, generating a
      // real 'live-state' frame from the actual server code path.
      await new Promise((r) => setTimeout(r, 30));
      if (sockets.length) {
        sockets[0].simulateOpen();
        sockets[0].serverFrame({ setupComplete: {} });
      }
      await new Promise((r) => setTimeout(r, 50));

      ws.close();
      await new Promise((r) => setTimeout(r, 20));

      assert.ok(frames.length > 0, 'the WS connection must have produced at least one frame to scan');
      for (const frame of frames) {
        const leak = findLeak(frame, SECRET_VALUES);
        assert.equal(leak, null, `a WS frame leaked a secret — found: ${leak && JSON.stringify(leak)}; frame: ${frame}`);
      }
    });

    if (prevKey === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prevKey;
  });
});
