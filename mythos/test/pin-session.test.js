'use strict';

// test/pin-session.test.js — Track B1: real server-side PIN session
// enforcement. RED-FIRST: written and run BEFORE server/index.js or
// server/routes/pin.js gained any session-issuing/checking code — every
// enforcement assertion below failed on first run (see the roadmap Progress
// log / session report for the pasted red-run output). Mirrors
// test/server-auth.test.js's and test/pin-routes.test.js's real-server
// harness pattern exactly (real createServer, real createPinLock).
//
// Back-compat is the whole point of the gate: the schema default flipped to
// true in Task A2 (2026-08-17), but pinSessionRequired() (server/index.js)
// requires BOTH the flag AND a configured PIN, and a config object handed to
// createServer directly carries no schema defaults at all — so a loopback
// install with no token and no PIN configured (the default, and every
// pre-existing test) must keep behaving exactly as before. Only tests in the
// 'enforcement ON' describe block exercise the new refusal path.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');
const { createPinLock } = require('../src/core/security/pin-lock');

function fakeFs() {
  const store = {};
  return {
    readJSON: (p, fb) => (store[p] !== undefined ? JSON.parse(JSON.stringify(store[p])) : fb),
    readJSONStrict: (p, fb) => (store[p] !== undefined ? JSON.parse(JSON.stringify(store[p])) : fb),
    writeJSON: (p, d) => { store[p] = d === null ? null : JSON.parse(JSON.stringify(d)); },
    vaultPath: (...s) => s.join('/'),
  };
}

function baseDeps(bus, overrides) {
  return Object.assign({
    bus,
    config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '' },
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
  }, overrides || {});
}

function realPinLock() {
  return createPinLock({ fs: fakeFs() });
}

function httpGet(port, pathName, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathName, headers: headers || {} }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

function httpPostJson(port, pathName, obj, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(obj || {});
    const req = http.request({
      host: '127.0.0.1', port, path: pathName, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {}),
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body || '{}') }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Extracts the `mythos_pin` value from a Set-Cookie response header, the
// same cookie name extractToken() (server/index.js) already parses.
function extractSessionCookie(setCookieHeader) {
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const line of arr) {
    if (!line) continue;
    const m = /mythos_pin=([^;]+)/.exec(line);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

describe('PIN session (Track B1): enforcement flag unset on a raw config — total back-compat', () => {
  test('a PIN configured but PIN_SESSION_ENFORCE unset: /api/status is still 200 with no token at all', async () => {
    const bus = createBus({ historySize: 50 });
    const pinLock = realPinLock();
    pinLock.setPin('4242');
    const server = createServer(baseDeps(bus, { pinLock }));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const res = await httpGet(port, '/api/status');
      assert.equal(res.status, 200);
    } finally {
      await server.stop();
    }
  });
});

describe('PIN session (Track B1): enforcement ON + a PIN configured — the real gate', () => {
  function enforceDeps(bus, pinLock, overrides) {
    return baseDeps(bus, Object.assign({
      pinLock,
      config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '', PIN_SESSION_ENFORCE: true, PIN_SESSION_TTL_MS: 1800000 },
    }, overrides || {}));
  }

  // THE MONEY TEST — this is the bug from the roadmap, made concrete:
  // "curl 127.0.0.1/api/... bypasses the lock screen entirely." With a PIN
  // configured and enforcement on, a request presenting NOTHING must be
  // refused, not silently allowed through by tokenOk()'s no-AUTH_TOKEN
  // back-compat branch.
  test('a request with no session and no bearer token is refused (401) on /api/*', async () => {
    const bus = createBus({ historySize: 50 });
    const pinLock = realPinLock();
    pinLock.setPin('4242');
    const server = createServer(enforceDeps(bus, pinLock));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const res = await httpGet(port, '/api/status');
      assert.equal(res.status, 401, `expected 401 with no session; got ${res.status}. This is the bypass the roadmap flagged: PIN lock is real access control, or it is not.`);
    } finally {
      await server.stop();
    }
  });

  test('the WS upgrade is refused too — REST-only would be half a fix', async () => {
    const bus = createBus({ historySize: 50 });
    const pinLock = realPinLock();
    pinLock.setPin('4242');
    const server = createServer(enforceDeps(bus, pinLock));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const rejected = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        ws.on('open', () => resolve('opened'));
        ws.on('unexpected-response', () => resolve('rejected'));
        ws.on('error', () => resolve('rejected'));
      });
      assert.equal(rejected, 'rejected');
    } finally {
      await server.stop();
    }
  });

  test('POST /api/pin/verify with the correct PIN issues a session cookie that then unlocks /api/*', async () => {
    const bus = createBus({ historySize: 50 });
    const pinLock = realPinLock();
    pinLock.setPin('4242');
    const server = createServer(enforceDeps(bus, pinLock));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const denied = await httpGet(port, '/api/status');
      assert.equal(denied.status, 401);

      const verifyRes = await httpPostJson(port, '/api/pin/verify', { pin: '4242' });
      assert.equal(verifyRes.status, 200);
      const cookie = extractSessionCookie(verifyRes.headers['set-cookie']);
      assert.ok(cookie, 'expected /api/pin/verify to set a mythos_pin session cookie on success');

      const allowed = await httpGet(port, '/api/status', { Cookie: `mythos_pin=${cookie}` });
      assert.equal(allowed.status, 200);
    } finally {
      await server.stop();
    }
  });

  test('the session cookie also unlocks the WS upgrade', async () => {
    const bus = createBus({ historySize: 50 });
    const pinLock = realPinLock();
    pinLock.setPin('4242');
    const server = createServer(enforceDeps(bus, pinLock));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const verifyRes = await httpPostJson(port, '/api/pin/verify', { pin: '4242' });
      const cookie = extractSessionCookie(verifyRes.headers['set-cookie']);
      assert.ok(cookie);

      const accepted = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: `mythos_pin=${cookie}` } });
        ws.on('open', () => { ws.close(); resolve('opened'); });
        ws.on('unexpected-response', () => resolve('rejected'));
        ws.on('error', () => resolve('rejected'));
      });
      assert.equal(accepted, 'opened');
    } finally {
      await server.stop();
    }
  });

  test('a wrong/garbage cookie value is refused, same as no cookie at all', async () => {
    const bus = createBus({ historySize: 50 });
    const pinLock = realPinLock();
    pinLock.setPin('4242');
    const server = createServer(enforceDeps(bus, pinLock));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const res = await httpGet(port, '/api/status', { Cookie: 'mythos_pin=not-a-real-session-token' });
      assert.equal(res.status, 401);
    } finally {
      await server.stop();
    }
  });

  test('a wrong PIN never issues a session, and the failed attempt does not leak the PIN in the error body', async () => {
    const bus = createBus({ historySize: 50 });
    const pinLock = realPinLock();
    pinLock.setPin('4242');
    const server = createServer(enforceDeps(bus, pinLock));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const verifyRes = await httpPostJson(port, '/api/pin/verify', { pin: '9999' });
      assert.equal(verifyRes.status, 401);
      assert.equal(verifyRes.headers['set-cookie'], undefined, 'a failed verify must not set any session cookie');
      assert.equal(JSON.stringify(verifyRes.body).includes('9999'), false, 'the presented PIN must never be echoed back');

      const stillDenied = await httpGet(port, '/api/status');
      assert.equal(stillDenied.status, 401);
    } finally {
      await server.stop();
    }
  });
});

describe('PIN session (Track B1): enforcement ON but NO PIN configured yet — fail open, not locked out', () => {
  test('with PIN_SESSION_ENFORCE true and no PIN ever set, /api/* stays open (nothing to enforce yet)', async () => {
    const bus = createBus({ historySize: 50 });
    const pinLock = realPinLock(); // never setPin()
    const server = createServer(baseDeps(bus, {
      pinLock,
      config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '', PIN_SESSION_ENFORCE: true },
    }));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const res = await httpGet(port, '/api/status');
      assert.equal(res.status, 200, 'a fresh install with the flag on but no PIN set yet must not lock the operator out of their own server');
    } finally {
      await server.stop();
    }
  });
});

// H1 (security audit, 2026-08-08): MYTHOS_AUTH_TOKEN set AND
// PIN_SESSION_ENFORCE true AND a real PIN configured — the untested
// combination every existing PIN test above deliberately avoided (they all
// pin MYTHOS_AUTH_TOKEN: ''). RED-FIRST against the pre-fix tokenOk(), which
// returned true on a matching bearer token without ever consulting
// pinSessionRequired() — the bearer token alone fully bypassed PIN
// enforcement. Also covers the mirror-image bug the fix must not introduce:
// a live PIN session alone (obtainable from the deliberately-unauthenticated
// POST /api/pin/verify) must NOT be sufficient either once a token is
// configured, or that endpoint's 5-attempt lockout becomes the entire
// remaining attack surface on a network-exposed instance.
describe('PIN session (Track B1) + H1: BOTH layers configured — neither alone is sufficient', () => {
  const AUTH_TOKEN = 'h1-combined-layer-token-do-not-reuse';

  function bothDeps(bus, pinLock, overrides) {
    return baseDeps(bus, Object.assign({
      pinLock,
      config: {
        MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
        MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000,
        MYTHOS_AUTH_TOKEN: AUTH_TOKEN, PIN_SESSION_ENFORCE: true, PIN_SESSION_TTL_MS: 1800000,
      },
    }, overrides || {}));
  }

  async function getSessionCookie(port) {
    const verifyRes = await httpPostJson(port, '/api/pin/verify', { pin: '4242' });
    assert.equal(verifyRes.status, 200);
    const cookie = extractSessionCookie(verifyRes.headers['set-cookie']);
    assert.ok(cookie, 'expected a session cookie from a correct PIN');
    return cookie;
  }

  test('bearer token alone (correct, no PIN session) is refused — the H1 bypass, made concrete', async () => {
    const bus = createBus({ historySize: 50 });
    const pinLock = realPinLock();
    pinLock.setPin('4242');
    const server = createServer(bothDeps(bus, pinLock));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const res = await httpGet(port, '/api/status', { Authorization: `Bearer ${AUTH_TOKEN}` });
      assert.equal(res.status, 401, `bearer token alone must not bypass an active PIN session requirement; got ${res.status}`);
    } finally {
      await server.stop();
    }
  });

  test('PIN session alone (correct, no bearer token) is refused — the mirror bypass this fix must not create', async () => {
    const bus = createBus({ historySize: 50 });
    const pinLock = realPinLock();
    pinLock.setPin('4242');
    const server = createServer(bothDeps(bus, pinLock));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const cookie = await getSessionCookie(port);
      const res = await httpGet(port, '/api/status', { Cookie: `mythos_pin=${cookie}` });
      assert.equal(res.status, 401, `a live PIN session alone must not grant access once a bearer token is configured; got ${res.status}`);
    } finally {
      await server.stop();
    }
  });

  test('both credentials together, on their own channels, are accepted', async () => {
    const bus = createBus({ historySize: 50 });
    const pinLock = realPinLock();
    pinLock.setPin('4242');
    const server = createServer(bothDeps(bus, pinLock));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const cookie = await getSessionCookie(port);
      const res = await httpGet(port, '/api/status', {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        Cookie: `mythos_pin=${cookie}`,
      });
      assert.equal(res.status, 200, `bearer (header) + PIN session (cookie) together must be accepted; got ${res.status}`);
    } finally {
      await server.stop();
    }
  });

  test('WS upgrade: bearer via ?token= alone (no PIN session cookie) is refused', async () => {
    const bus = createBus({ historySize: 50 });
    const pinLock = realPinLock();
    pinLock.setPin('4242');
    const server = createServer(bothDeps(bus, pinLock));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const rejected = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${AUTH_TOKEN}`);
        ws.on('open', () => resolve('opened'));
        ws.on('unexpected-response', () => resolve('rejected'));
        ws.on('error', () => resolve('rejected'));
      });
      assert.equal(rejected, 'rejected', 'a WS upgrade with only the bearer token must not bypass PIN enforcement');
    } finally {
      await server.stop();
    }
  });

  test('WS upgrade: bearer via ?token= AND the PIN session cookie together are accepted', async () => {
    const bus = createBus({ historySize: 50 });
    const pinLock = realPinLock();
    pinLock.setPin('4242');
    const server = createServer(bothDeps(bus, pinLock));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const cookie = await getSessionCookie(port);
      const accepted = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${AUTH_TOKEN}`, { headers: { Cookie: `mythos_pin=${cookie}` } });
        ws.on('open', () => { ws.close(); resolve('opened'); });
        ws.on('unexpected-response', () => resolve('rejected'));
        ws.on('error', () => resolve('rejected'));
      });
      assert.equal(accepted, 'opened', 'a WS upgrade presenting both credentials on their own channels must succeed');
    } finally {
      await server.stop();
    }
  });
});
