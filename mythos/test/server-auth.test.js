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

  test('/api/status is 200 with the mythos_token cookie', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(tokenDeps(bus));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const res = await httpGet(port, '/api/status', { Cookie: `mythos_token=${TOKEN}` });
      assert.equal(res.status, 200);
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
