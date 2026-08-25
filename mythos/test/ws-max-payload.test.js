'use strict';

// test/ws-max-payload.test.js — an authenticated WebSocket must not be able to
// make the server buffer an unbounded frame.
//
// Every HTTP body on this server is explicitly capped: express.json at 1mb, and
// the one raw-audio route at 15mb. The WebSocket server was constructed with no
// maxPayload at all, so it inherited the ws library's 100 MiB default. The
// upgrade rate limiter does not help here — it throttles NEW connections, and
// says nothing about how large a frame an already-open socket may send.
//
// The bound is 16 MiB by default, sized above the largest legitimate inbound
// frame (a vision-query carrying a base64 webcam JPEG) with room to spare, and
// overridable via WS_MAX_PAYLOAD_BYTES. These tests drive the real server with
// the override set small, so the assertion is about behaviour — an over-sized
// frame is refused with close code 1009 — rather than about a config literal.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');

const SMALL_MAX = 4096;   // bytes; keeps the over-sized frame cheap to build

function fakeFs() {
  return { vaultPath: (...s) => path.join('/test-vault', ...s) };
}

function baseDeps(bus) {
  return {
    bus,
    config: {
      MYTHOS_PORT: 0,
      // Loopback explicitly: the §7.2 boot guard refuses a non-loopback bind
      // with no token, and an unset MYTHOS_BIND counts as non-loopback.
      MYTHOS_BIND: '127.0.0.1',
      MYTHOS_NAME: 'TEST',
      MYTHOS_IDLE_SALIENCE: 0.3,
      ACTION_TIMEOUT_MS: 30000,
      MYTHOS_AUTH_TOKEN: '',
    },
    logger: { info() {}, warn() {}, error() {} },
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
  };
}

// Boot a loopback server with the payload cap overridden, run fn(port), tear
// down. The override is read inside createServer, so it must be set first.
async function withServer(maxPayloadBytes, fn) {
  const previous = process.env.WS_MAX_PAYLOAD_BYTES;
  process.env.WS_MAX_PAYLOAD_BYTES = String(maxPayloadBytes);
  // Fresh require: server/index.js reads the override when createServer runs,
  // but the module may already be cached from another test in this file.
  delete require.cache[require.resolve('../server')];
  const { createServer } = require('../server');
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus));
  try {
    await server.ready;
    await fn(server.httpServer.address().port);
  } finally {
    await server.stop();
    if (previous === undefined) delete process.env.WS_MAX_PAYLOAD_BYTES;
    else process.env.WS_MAX_PAYLOAD_BYTES = previous;
  }
}

// Open a socket, send one frame, and report how the server reacted. A refusal
// is a close, so "no close within the window" is the accepted outcome — the
// window is short because ws sends the 1009 immediately on the over-sized
// frame, not after any processing.
// -> { closeCode } | { error } | { accepted: true }
const OBSERVE_MS = 800;
function sendFrame(port, payload) {
  return new Promise((resolve) => {
    // No Origin header on purpose. verifyClient allows an origin-less upgrade
    // from loopback (the non-browser client path); sending one would have to
    // match ALLOWED_ORIGINS, which is derived from the CONFIGURED port and so
    // can never match the ephemeral port a test server binds.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { ws.close(); } catch (_) {} resolve(v); } };
    ws.on('open', () => ws.send(payload));
    ws.on('close', (code) => done({ closeCode: code }));
    ws.on('error', (err) => done({ error: (err && err.message) || 'ERR' }));
    setTimeout(() => done({ accepted: true }), OBSERVE_MS);
  });
}

test('an over-sized WebSocket frame is refused with close code 1009', async () => {
  await withServer(SMALL_MAX, async (port) => {
    // Comfortably over the cap, and still valid JSON so nothing else can be
    // blamed for the rejection.
    const oversized = JSON.stringify({ type: 'utterance', text: 'x'.repeat(SMALL_MAX * 4) });
    assert.ok(oversized.length > SMALL_MAX, 'fixture must exceed the cap');
    const outcome = await sendFrame(port, oversized);
    assert.equal(outcome.closeCode, 1009,
      'ws closes with 1009 (Message Too Big) when maxPayload is enforced; with the library '
      + 'default of 100 MiB this frame is accepted and buffered. Got: ' + JSON.stringify(outcome));
  });
});

test('a normal-sized frame on the same server is accepted — the cap is not just closing everything', async () => {
  await withServer(SMALL_MAX, async (port) => {
    const normal = JSON.stringify({ type: 'ping' });
    assert.ok(normal.length < SMALL_MAX);
    const outcome = await sendFrame(port, normal);
    assert.equal(outcome.accepted, true,
      'a small frame must not be refused — positive control against a cap set too low. Got: '
      + JSON.stringify(outcome));
  });
});

test('the SAME over-sized frame is accepted when the cap is raised — the refusal comes from the cap', async () => {
  // The control that makes the first test mean something. Without it, "the
  // socket closed" could be any other server behaviour reacting to a large or
  // unfamiliar frame; here the only variable that changes is the cap.
  await withServer(64 * 1024 * 1024, async (port) => {
    const oversized = JSON.stringify({ type: 'utterance', text: 'x'.repeat(SMALL_MAX * 4) });
    const outcome = await sendFrame(port, oversized);
    assert.notEqual(outcome.closeCode, 1009,
      'with a large cap the identical frame must go through. Got: ' + JSON.stringify(outcome));
  });
});

test('the default cap is explicit and generous enough for a vision-query frame', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(src, /maxPayload: WS_MAX_PAYLOAD/,
    'the WebSocketServer must be constructed with an explicit maxPayload');
  const decl = src.match(/const WS_MAX_PAYLOAD = Number\(process\.env\.WS_MAX_PAYLOAD_BYTES\) \|\| (\d+) \* 1024 \* 1024;/);
  assert.ok(decl, 'the default must be a readable MiB expression, not a bare byte count');
  const mib = Number(decl[1]);
  assert.ok(mib >= 16, 'the default must clear the largest legitimate frame (a base64 webcam JPEG); got ' + mib + ' MiB');
  assert.ok(mib < 100, 'and must actually be lower than the ws library default it replaces; got ' + mib + ' MiB');
});
