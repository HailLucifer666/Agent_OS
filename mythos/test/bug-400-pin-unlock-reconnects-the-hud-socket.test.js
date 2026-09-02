'use strict';

// BUG-400, defect 3b — in PIN-only mode the PIN gates the HUD's WebSocket, so
// until the operator unlocks, every reply MYTHOS generates is broadcast to
// nobody. The operator now depends on this path every session and it had no test.
//
// MEASURED LIVE ON THE PACKAGED BUILD, 2026-09-03, after MYTHOS_AUTH_TOKEN was
// removed from the keystore at the operator's request (keep the PIN, drop the
// token). Reported symptom: "it just keeps in thinking mode and never replies…
// I can see the token usage. It is pulling in Google Live. It also did some
// Mistral." All three halves were true at once, and none of them was a stuck
// model:
//
//   * The server WAS replying. Three complete replies for those turns are in
//     %APPDATA%\MYTHOS\vault\Episodic\2026-09-03.jsonl — turnId live-turn-2/3/4,
//     transport "s2s", one carrying a successful read_status action.
//   * live.turn-parts recorded 47 and 46 audioParts for two of them, so audio
//     was generated too.
//   * Every HUD upgrade logged
//       ws-upgrade-rejected  reason="bad or missing token"  credential=none
//     from the Electron client. ws.js then retries at its 8s BACKOFF_MAX_MS
//     ceiling forever, which is the HUD's "Live connection lost — retrying".
//
// THE MECHANISM, from server/index.js's tokenOk(). With no token configured and
// a PIN enforced, the combined-mode branch is skipped and it ends at:
//     const presented = extractToken(req);
//     if (pinSession.isValid(presented)) return true;
//     if (!AUTH_TOKEN) return !pinSessionRequired();   // -> false
// So a PIN session is the ONLY credential that satisfies the /ws upgrade, and
// the compose bar can still SEND (the typed text reached the server — the log
// shows site:"operator-typed") while nothing can be RECEIVED. That asymmetry is
// what presents as "thinking forever": setVoiceState('processing') fires on
// send, and live-transcript / live-audio-out / live-turn-complete never arrive.
//
// WHY A TEST AND NOT A NOTE. pin-gate.js's own header calls the overlay "a
// client-side visual/pointer lock, not a security boundary", which is true of
// the OVERLAY and false of the PIN SESSION it mints — that session is load
// bearing for the socket. A future reader trusting the header could remove the
// lock screen and silently take away the only way to authenticate this
// deployment. This drives the real route end to end (refuse → POST
// /api/pin/verify → use the Set-Cookie it mints → reconnect) rather than
// asserting it from reading tokenOk().
//
// Fixtures mirror test/server-auth.test.js's, minus the token.
//
// Run: cd mythos && node --test test/bug-400-pin-unlock-reconnects-the-hud-socket.test.js

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');
const { createPinLock } = require('../src/core/security/pin-lock');

function pinLockWith(pin) {
  const store = {};
  const lock = createPinLock({
    fs: {
      readJSON: (p, fallback) => (p in store ? store[p] : fallback),
      readJSONStrict: (p, fallback) => (p in store ? store[p] : fallback),
      writeJSON: (p, d) => { store[p] = d === null ? null : JSON.parse(JSON.stringify(d)); },
      vaultPath: (...s) => s.join('/'),
    },
  });
  if (pin) lock.setPin(pin);
  return lock;
}

function deps(bus, config, pinLock) {
  return {
    bus,
    pinLock,
    config: Object.assign({
      MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3,
      ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '',
      PIN_SESSION_ENFORCE: true, PIN_SESSION_TTL_MS: 1800000,
    }, config),
    logger: { info() {}, warn() {}, error() {} },
    memory: {
      working: { tick: 0, activeGoalId: null },
      episodic: { write: async () => {} },
      fs: { vaultPath: (...s) => s.join('/') },
    },
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

function httpPostJson(port, pathName, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathName,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// Just the `name=value` pair, which is what a browser would send back.
function cookiePairFrom(res) {
  const raw = res.headers['set-cookie'];
  if (!raw) return null;
  const line = Array.isArray(raw) ? raw.find((c) => /^mythos_token=/.test(c)) : raw;
  return line ? String(line).split(';')[0] : null;
}

// Resolves true on 'open', false on 'error'. Asserting the SOCKET, not a
// boolean some helper returned — a refused upgrade is the mechanism here.
function wsOpens(port, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws', { headers: headers || {} });
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (_) { /* already closing */ }
      resolve(v);
    };
    ws.on('open', () => done(true));
    ws.on('error', () => done(false));
  });
}

describe('BUG-400 defect 3b — the PIN unlock is what reconnects the HUD socket', () => {
  test('PIN-only: the WS is refused with no session, and accepted with the cookie /api/pin/verify mints', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(deps(bus, {}, pinLockWith('4242')));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      assert.equal(await wsOpens(port), false,
        'precondition, and the live symptom: with no PIN session the HUD socket is refused, '
        + 'so every reply the server generates is broadcast to nobody');

      const verify = await httpPostJson(port, '/api/pin/verify', { pin: '4242' });
      assert.equal(verify.status, 200, 'the PIN unlock route must work in PIN-only mode');
      const pair = cookiePairFrom(verify);
      assert.ok(pair, '/api/pin/verify must mint the mythos_token PIN-session cookie');

      assert.equal(await wsOpens(port, { Cookie: pair }), true,
        "entering the PIN must reconnect the HUD socket — this is the operator's daily path "
        + 'in the configuration they chose, and it is the only credential this deployment has');
    } finally {
      await server.stop();
    }
  });

  test('BOUND: a wrong PIN mints nothing and the socket stays refused', async () => {
    // Without this, the case above could pass on a server that accepted every
    // upgrade, which is the direction that would make the whole gate pointless.
    const bus = createBus({ historySize: 50 });
    const server = createServer(deps(bus, {}, pinLockWith('4242')));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const verify = await httpPostJson(port, '/api/pin/verify', { pin: '9999' });
      assert.equal(verify.status, 401);
      assert.equal(cookiePairFrom(verify), null,
        'a wrong guess must leave the browser with exactly what it had');
      assert.equal(await wsOpens(port), false);
    } finally {
      await server.stop();
    }
  });

  test('BOUND: with no PIN configured and no token, the socket opens freely (unchanged default)', async () => {
    // The plain loopback install. This is what the operator would get by also
    // clearing the PIN, and it must stay untouched by anything above.
    const bus = createBus({ historySize: 50 });
    const server = createServer(deps(bus, { PIN_SESSION_ENFORCE: true }, pinLockWith(null)));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      assert.equal(await wsOpens(port), true,
        'PIN_SESSION_ENFORCE is true but no PIN is configured, so pinSessionRequired() is '
        + 'false and a default loopback install must not be gated at all');
    } finally {
      await server.stop();
    }
  });
});

// MUTATION PROOF, run 2026-09-03. Mutations verified applied by re-reading the
// mutated line; server/index.js restored by full-path copy and the restore
// verified by re-running this file green.
//
//   (a) In tokenOk(), change `if (!AUTH_TOKEN) return !pinSessionRequired();`
//       to `if (!AUTH_TOKEN) return true;` — i.e. stop gating a PIN-only
//       deployment -> reds "BOUND: a wrong PIN mints nothing and the socket
//       stays refused" and the first assertion of the accept case, because the
//       socket now opens with no credential at all.
//   (b) Delete `if (pinSession.isValid(presented)) return true;` -> reds only
//       the accept half ("entering the PIN must reconnect the HUD socket"),
//       while both BOUND cases stay green. That is the contrast that proves the
//       accept assertion watches the PIN-session channel specifically.
//   (c) In routes/pin.js, drop the `res.cookie(PIN_SESSION_COOKIE, …)` call ->
//       reds "/api/pin/verify must mint the mythos_token PIN-session cookie"
//       before the socket assertion is ever reached, naming the real cause
//       rather than a downstream connection failure.
