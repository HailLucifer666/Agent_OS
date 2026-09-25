'use strict';

// test/server-auth.test.js — Task 6 / V2 §7.2: server bind + bearer auth +
// WS ?token= + /vault/builds gate (merged-order step 2). RED-FIRST: written
// before server/index.js gained tokenOk()/requireToken()/the boot guard/the
// verifyClient token check — every assertion below failed on first run (see
// the roadmap Progress log for the pasted red-run output). Back-compat is
// total: a loopback bind with no MYTHOS_AUTH_TOKEN must exercise none of the
// new branches (see the two 'back-compat' tests).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

const MAIN_PATH = path.join(__dirname, '..', 'src', 'main.js');
const REPO_ROOT = path.join(__dirname, '..');
const TOKEN = 'server-auth-test-token-do-not-reuse';

function fakeFs() {
  return { vaultPath: (...s) => path.join('/test-vault', ...s) };
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

function httpGet(port, pathName, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathName, headers: headers || {} }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, '127.0.0.1');
  });
}

async function pickFreePort() {
  for (let i = 0; i < 30; i++) {
    const p = 20000 + Math.floor(Math.random() * 20000);
    if (await isPortFree(p)) return p;
  }
  throw new Error('no free port found after 30 tries');
}

describe('server-auth (§7.2): back-compat — loopback bind, no token', () => {
  test('/api/status is 200 with no Authorization at all', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const res = await httpGet(port, '/api/status');
      assert.equal(res.status, 200);
    } finally {
      await server.stop();
    }
  });

  test('WS upgrade succeeds with no Origin and no token (loopback dev tools)', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });
      ws.close();
    } finally {
      await server.stop();
    }
  });
});

describe('server-auth (§7.2): token configured — /api/* gate', () => {
  function tokenDeps(bus, overrides) {
    return baseDeps(bus, Object.assign({
      config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: TOKEN },
    }, overrides || {}));
  }

  test('/api/status is 401 with no Authorization', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(tokenDeps(bus));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const res = await httpGet(port, '/api/status');
      assert.equal(res.status, 401);
    } finally {
      await server.stop();
    }
  });

  test('/api/status is 401 with a wrong Bearer token', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(tokenDeps(bus));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const res = await httpGet(port, '/api/status', { Authorization: 'Bearer not-the-right-token' });
      assert.equal(res.status, 401);
    } finally {
      await server.stop();
    }
  });

  test('/api/status is 200 with the correct Bearer token', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(tokenDeps(bus));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const res = await httpGet(port, '/api/status', { Authorization: `Bearer ${TOKEN}` });
      assert.equal(res.status, 200);
    } finally {
      await server.stop();
    }
  });

  // INVERTED 2026-09-23 (BUG-444). This asserted a 200: the raw token in a
  // cookie was a credential channel, which is how the shared secret came to sit
  // in every browser for 30 days. The channel is gone; the cookie is only cleared.
  test('/api/status is 401 with the raw token in a mythos_token cookie (BUG-444)', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(tokenDeps(bus));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const res = await httpGet(port, '/api/status', { Cookie: `mythos_token=${TOKEN}` });
      assert.equal(res.status, 401);
    } finally {
      await server.stop();
    }
  });

  test('/vault/builds is gated: 401 with no token, not-401 with a valid token', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(tokenDeps(bus));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const noToken = await httpGet(port, '/vault/builds/whatever.html');
      assert.equal(noToken.status, 401);
      const withToken = await httpGet(port, '/vault/builds/whatever.html', { Authorization: `Bearer ${TOKEN}` });
      assert.notEqual(withToken.status, 401);
    } finally {
      await server.stop();
    }
  });

  test('the UI shell static mount stays open — GET / is 200 with no token', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(tokenDeps(bus));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const res = await httpGet(port, '/');
      assert.equal(res.status, 200);
    } finally {
      await server.stop();
    }
  });
});

describe('server-auth (§7.2): WS upgrade ?token=', () => {
  test('a browser-style connection (Origin set, no headers) needs ?token= when a token is configured', async () => {
    const port = await pickFreePort();
    const origin = `http://localhost:${port}`;
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus, {
      config: { MYTHOS_PORT: port, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: TOKEN },
    }));
    await server.ready;
    try {
      // No ?token= — must be rejected.
      const rejected = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
        ws.on('open', () => resolve('opened'));
        ws.on('unexpected-response', () => resolve('rejected'));
        ws.on('error', () => resolve('rejected'));
      });
      assert.equal(rejected, 'rejected');

      // Correct ?token= — must succeed.
      const accepted = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, { origin });
        ws.on('open', () => { ws.close(); resolve('opened'); });
        ws.on('unexpected-response', () => resolve('rejected'));
        ws.on('error', () => resolve('rejected'));
      });
      assert.equal(accepted, 'opened');
    } finally {
      await server.stop();
    }
  });

  test('security-reviewer finding: a no-Origin connection (the reverse-proxy shape — remoteAddress looks loopback, no browser Origin) also needs the token, not just the isLoopback bypass', async () => {
    // Regression test for the WS auth bypass the security-reviewer agent found
    // in the first version of this diff: verifyClient() only called tokenOk()
    // inside the `if (origin)` branch, so any connection with no Origin header
    // fell straight to isLoopback(info.req) and was accepted unconditionally —
    // even with MYTHOS_AUTH_TOKEN configured. That's exactly the shape every
    // connection takes when MYTHOS sits behind a reverse proxy terminating on
    // loopback: remoteAddress is 127.0.0.1 for every remote client, and no
    // browser-style client is involved so there's no Origin header either.
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus, {
      config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: TOKEN },
    }));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      // No Origin, no token — must now be rejected (was the bypass).
      const rejected = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        ws.on('open', () => resolve('opened'));
        ws.on('unexpected-response', () => resolve('rejected'));
        ws.on('error', () => resolve('rejected'));
      });
      assert.equal(rejected, 'rejected');

      // No Origin, correct token via Authorization header (a non-browser
      // client can set headers) — must succeed.
      const accepted = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        ws.on('open', () => { ws.close(); resolve('opened'); });
        ws.on('unexpected-response', () => resolve('rejected'));
        ws.on('error', () => resolve('rejected'));
      });
      assert.equal(accepted, 'opened');
    } finally {
      await server.stop();
    }
  });
});

describe('server-auth (§7.2): boot guard', () => {
  test('MYTHOS_BIND=0.0.0.0 with no MYTHOS_AUTH_TOKEN refuses to boot (non-zero exit)', async () => {
    const child = spawn(process.execPath, [MAIN_PATH], {
      cwd: REPO_ROOT,
      env: Object.assign({}, process.env, {
        MYTHOS_VAULT_ROOT: './vault',
        MYTHOS_BIND: '0.0.0.0',
        MYTHOS_AUTH_TOKEN: '',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const exitCode = await new Promise((resolve) => {
      child.on('close', resolve);
      child.on('error', () => resolve(-1));
      setTimeout(() => { child.kill('SIGKILL'); resolve(-99); }, 15000);
    });

    assert.notEqual(exitCode, 0, `expected a non-zero exit refusing to boot; got ${exitCode}. stderr: ${stderr}`);
    assert.match(stderr, /MYTHOS_AUTH_TOKEN/, `expected the refusal message to name MYTHOS_AUTH_TOKEN; stderr: ${stderr}`);
  });
});

describe('server-auth (H3b, security audit 2026-08-08): weak MYTHOS_AUTH_TOKEN is rejected at boot', () => {
  test('no token at all still boots (loopback back-compat is untouched)', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus));
    await server.ready;
    await server.stop();
  });

  test('a short token refuses to boot', () => {
    const bus = createBus({ historySize: 50 });
    assert.throws(
      () => createServer(baseDeps(bus, { config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: 'short' } })),
      /too weak/
    );
  });

  test('a long but single-repeated-character token refuses to boot', () => {
    const bus = createBus({ historySize: 50 });
    assert.throws(
      () => createServer(baseDeps(bus, { config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: 'aaaaaaaaaaaaaaaaaaaaaa' } })),
      /too weak/
    );
  });

  test('a common weak word (even if padded to length) refuses to boot', () => {
    const bus = createBus({ historySize: 50 });
    assert.throws(
      () => createServer(baseDeps(bus, { config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: 'password1234567890' } })),
      /too weak/
    );
  });

  test('a long, high-entropy token boots fine', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus, { config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: TOKEN } }));
    await server.ready;
    await server.stop();
  });
});

describe('server-auth (H3a, security audit 2026-08-08): the WS upgrade path is rate limited', () => {
  test('repeated wrong-token WS upgrade attempts from one IP eventually get 429, not endless 401s', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus, {
      config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: TOKEN },
    }));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      let sawTooMany = false;
      // The default cap is 30/min per IP; 40 rapid wrong-token guesses must
      // trip it before completing.
      for (let i = 0; i < 40; i++) {
        const status = await new Promise((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=guess-${i}`);
          ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
          ws.on('open', () => { try { ws.close(); } catch (_) {} resolve('opened'); });
          ws.on('error', () => resolve('error'));
        });
        if (status === 429) { sawTooMany = true; break; }
      }
      assert.equal(sawTooMany, true, 'expected a 429 once the per-IP WS-upgrade rate limit was exceeded');
    } finally {
      await server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/session — the exchange endpoint (server/routes/auth.js).
//
// The bug this closes: MYTHOS_BIND=0.0.0.0 (needed so the phone node can reach
// the server) makes MYTHOS_AUTH_TOKEN mandatory at boot, and a browser tab had
// no way to present it — it cannot set an Authorization header on its own
// navigation and cannot set headers on a WS upgrade at all. So every /api/*
// fetch 401'd and the socket was refused, while the deliberately-open static
// shell still loaded: the dashboard looked normal and was completely inert.
//
// extractToken()/tokenOk() already accepted the mythos_token cookie, and the
// comment there already described the HUD setting it. Only the endpoint that
// sets it was missing. These tests pin that it is a real check, not a bypass.
// ---------------------------------------------------------------------------
describe('server-auth: POST /api/auth/session (token -> session cookie; BUG-444)', () => {
  function httpPostJson(port, pathName, obj, headers) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(obj || {});
      const req = http.request({
        host: '127.0.0.1', port, path: pathName, method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {}),
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end(data);
    });
  }

  // The shared httpGet above drops response headers; this exchange is entirely
  // about a Set-Cookie, so it needs its own.
  function httpGetFull(port, pathName, headers) {
    return new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: pathName, headers: headers || {} }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }).on('error', reject);
    });
  }

  function authDeps(bus, overrides) {
    return baseDeps(bus, Object.assign({
      config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: TOKEN },
    }, overrides || {}));
  }

  function setCookieFor(res, name) {
    const raw = res.headers['set-cookie'] || [];
    return raw.find((c) => c.startsWith(name + '=')) || null;
  }

  test('404 when no MYTHOS_AUTH_TOKEN is configured — nothing to exchange for, said honestly', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus)); // default deps carry MYTHOS_AUTH_TOKEN ''
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const res = await httpPostJson(port, '/api/auth/session', { token: 'anything' });
      assert.equal(res.status, 404);
      assert.equal(setCookieFor(res, 'mythos_session'), null, 'a deployment with no token must never hand out a credential');
    } finally {
      await server.stop();
    }
  });

  test('a wrong token is 401 and sets NO cookie — the browser keeps exactly what it had', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(authDeps(bus));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const res = await httpPostJson(port, '/api/auth/session', { token: 'not-the-token' });
      assert.equal(res.status, 401);
      assert.equal(setCookieFor(res, 'mythos_session'), null);
    } finally {
      await server.stop();
    }
  });

  test('a missing token is 400 — not a 500, and certainly not a pass', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(authDeps(bus));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const res = await httpPostJson(port, '/api/auth/session', {});
      assert.equal(res.status, 400);
      assert.equal(setCookieFor(res, 'mythos_session'), null);
    } finally {
      await server.stop();
    }
  });

  test('the correct token is 200 and sets an HttpOnly; SameSite=Strict mythos_session cookie that is not the token', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(authDeps(bus));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const res = await httpPostJson(port, '/api/auth/session', { token: TOKEN });
      assert.equal(res.status, 200);
      const cookie = setCookieFor(res, 'mythos_session');
      assert.ok(cookie, 'expected a mythos_session cookie');
      assert.ok(!decodeURIComponent(cookie).includes(TOKEN), 'BUG-444: the cookie must never carry the token');
      assert.match(cookie, /HttpOnly/i, 'must not be readable from document.cookie');
      assert.match(cookie, /SameSite=Strict/i);
      assert.match(cookie, /Path=\//i);
    } finally {
      await server.stop();
    }
  });

  test('that cookie ALONE satisfies GET /api/status — no Authorization header anywhere', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(authDeps(bus));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const before = await httpGetFull(port, '/api/status');
      assert.equal(before.status, 401, 'precondition: the tab starts unauthenticated');

      const exchange = await httpPostJson(port, '/api/auth/session', { token: TOKEN });
      const cookiePair = setCookieFor(exchange, 'mythos_session').split(';')[0];

      const after = await httpGetFull(port, '/api/status', { Cookie: cookiePair });
      assert.equal(after.status, 200, 'the cookie the HUD now sets must be a credential tokenOk() accepts');
    } finally {
      await server.stop();
    }
  });

  // THE POINT OF THE WHOLE CHANGE for the live HUD: every WS-fed widget, the
  // core orb, agent actions and token usage ride this upgrade. A browser cannot
  // attach headers to it, but it DOES send cookies — so if this fails, the
  // dashboard stays dead even with a working REST path.
  test('that cookie ALONE lets the WS upgrade succeed, with no ?token= in the URL', async () => {
    const port = await pickFreePort();
    const origin = `http://localhost:${port}`;
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus, {
      config: { MYTHOS_PORT: port, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: TOKEN },
    }));
    await server.ready;
    try {
      const exchange = await httpPostJson(port, '/api/auth/session', { token: TOKEN });
      const cookiePair = setCookieFor(exchange, 'mythos_session').split(';')[0];

      const result = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin, headers: { Cookie: cookiePair } });
        ws.on('open', () => { ws.close(); resolve('opened'); });
        ws.on('unexpected-response', () => resolve('rejected'));
        ws.on('error', () => resolve('rejected'));
      });
      assert.equal(result, 'opened', 'the cookie must authenticate the upgrade — this is what revives every WS-fed widget');
    } finally {
      await server.stop();
    }
  });

  test('brute force is capped: repeated wrong-token exchanges hit 429', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(authDeps(bus));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      let sawTooMany = false;
      for (let i = 0; i < 10; i++) {
        const res = await httpPostJson(port, '/api/auth/session', { token: `guess-${i}` });
        if (res.status === 429) { sawTooMany = true; break; }
      }
      assert.equal(sawTooMany, true, 'expected the dedicated 5/min auth-exchange limiter to trip');
    } finally {
      await server.stop();
    }
  });

  test('GET /health reports authRequired so the HUD knows whether to prompt at all', async () => {
    const bus = createBus({ historySize: 50 });
    const withToken = createServer(authDeps(bus));
    await withToken.ready;
    try {
      const res = await httpGetFull(withToken.httpServer.address().port, '/health');
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.body).authRequired, true);
    } finally {
      await withToken.stop();
    }

    const bus2 = createBus({ historySize: 50 });
    const noToken = createServer(baseDeps(bus2));
    await noToken.ready;
    try {
      const res = await httpGetFull(noToken.httpServer.address().port, '/health');
      assert.equal(JSON.parse(res.body).authRequired, false, 'a default install must report false so the HUD never prompts');
    } finally {
      await noToken.stop();
    }
  });
});
