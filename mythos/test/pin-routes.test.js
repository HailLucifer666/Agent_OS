'use strict';

// test/pin-routes.test.js — §7.3 PIN lock server routes (server/routes/pin.js).
// Drives the REAL server + a REAL createPinLock instance (not a stub) so
// this proves the actual wiring, not just each half in isolation. Reuses
// test/server-auth.test.js's real-server/baseDeps harness pattern.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');
const { createPinLock } = require('../src/core/security/pin-lock');

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

function realPinLock() {
  const store = {};
  const fs = {
    readJSON: (p, fb) => (store[p] !== undefined ? JSON.parse(JSON.stringify(store[p])) : fb),
    writeJSON: (p, d) => { store[p] = d === null ? null : JSON.parse(JSON.stringify(d)); },
  };
  return createPinLock({ fs });
}

function httpGet(port, pathName) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathName }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body || '{}') }));
    }).on('error', reject);
  });
}

function httpPostJson(port, pathName, obj) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(obj || {});
    const req = http.request({
      host: '127.0.0.1', port, path: pathName, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body || '{}') }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('§7.3 PIN routes', () => {
  test('GET /api/pin/status reports not configured, then configured after a real set', async () => {
    const bus = createBus({ historySize: 50 });
    const pinLock = realPinLock();
    const server = createServer(baseDeps(bus, { pinLock }));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const before = await httpGet(port, '/api/pin/status');
      assert.equal(before.status, 200);
      assert.equal(before.body.configured, false);
      assert.equal(before.body.hasWindowsHello, false);

      const setRes = await httpPostJson(port, '/api/pin/set', { pin: '4242' });
      assert.equal(setRes.status, 200);
      assert.equal(setRes.body.ok, true);

      const after = await httpGet(port, '/api/pin/status');
      assert.equal(after.body.configured, true);
    } finally {
      await server.stop();
    }
  });

  test('security-reviewer fix: POST /api/pin/set requires currentPin to change an already-configured PIN', async () => {
    const bus = createBus({ historySize: 50 });
    const pinLock = realPinLock();
    const server = createServer(baseDeps(bus, { pinLock }));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      await httpPostJson(port, '/api/pin/set', { pin: '4242' }); // first-time setup

      const noCurrentPin = await httpPostJson(port, '/api/pin/set', { pin: '9999' });
      assert.notEqual(noCurrentPin.status, 200);
      const stillOldOk = await httpPostJson(port, '/api/pin/verify', { pin: '4242' });
      assert.equal(stillOldOk.status, 200, 'the old PIN must still work — the bypass this fix closes');

      const withCurrentPin = await httpPostJson(port, '/api/pin/set', { pin: '9999', currentPin: '4242' });
      assert.equal(withCurrentPin.status, 200);
      const newOk = await httpPostJson(port, '/api/pin/verify', { pin: '9999' });
      assert.equal(newOk.status, 200);
    } finally {
      await server.stop();
    }
  });

  test('POST /api/pin/set rejects a non-numeric PIN, never touches the store', async () => {
    const bus = createBus({ historySize: 50 });
    const pinLock = realPinLock();
    const server = createServer(baseDeps(bus, { pinLock }));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const res = await httpPostJson(port, '/api/pin/set', { pin: 'abcd' });
      assert.equal(res.status, 400);
      const status = await httpGet(port, '/api/pin/status');
      assert.equal(status.body.configured, false);
    } finally {
      await server.stop();
    }
  });

  test('POST /api/pin/verify: correct PIN 200s, wrong PIN 401s, real lockout 429s after repeated failures', async () => {
    const bus = createBus({ historySize: 50 });
    const pinLock = realPinLock();
    const server = createServer(baseDeps(bus, { pinLock }));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      await httpPostJson(port, '/api/pin/set', { pin: '1357' });

      const ok = await httpPostJson(port, '/api/pin/verify', { pin: '1357' });
      assert.equal(ok.status, 200);

      const wrong = await httpPostJson(port, '/api/pin/verify', { pin: '0000' });
      assert.equal(wrong.status, 401);

      // Real rate-limit: drive it into lockout with real repeated wrong attempts.
      for (let i = 0; i < 4; i++) await httpPostJson(port, '/api/pin/verify', { pin: '0000' });
      const locked = await httpPostJson(port, '/api/pin/verify', { pin: '1357' }); // correct PIN, but locked out
      assert.equal(locked.status, 429);
    } finally {
      await server.stop();
    }
  });

  test('routes 404 honestly when pinLock is not wired (no deployment leaks a 500/crash)', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus)); // no pinLock override
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const res = await httpGet(port, '/api/pin/status');
      assert.equal(res.status, 404);
    } finally {
      await server.stop();
    }
  });
});
