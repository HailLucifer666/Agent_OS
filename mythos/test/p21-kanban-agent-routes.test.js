'use strict';

// P21 — kanban agent routes: assemble, build, review, accept, job polling

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { fakeBus } = require('./helpers');
const { createServer } = require('../server/index');

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
    kanbanEffector: {
      listBoard: () => ({ cards: [] }),
      moveCard: () => ({ id: 'c1', lane: 'done' }),
      patchCard: () => {},
      addCard: (title, lane) => ({ id: 'c1', title: title, lane: lane || 'backlog' }),
    },
    pipelineEffector: { listAll: () => ({}) },
    effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
    leash: { confirm: { create: () => 'cf-1', accept: () => null, reject: () => true } },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({}) },
    agentActions: {
      assembleKanbanPlan: (goal) => ({ job: { id: 'plan-1', status: 'queued', kind: 'kanban-plan' } }),
      buildKanbanCard: (cardId) => ({ job: { id: 'build-1', status: 'queued' }, board: { cards: [] } }),
      reviewKanbanCard: (cardId) => ({ job: { id: 'review-1', status: 'queued' } }),
    },
    buildRunner: { getJob: (id) => id === 'build-1' ? { id: 'build-1', status: 'done' } : null, onJobUpdate: () => () => {} },
  }, overrides || {});
}

function httpPost(port, pathName, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function httpGet(port, pathName) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathName }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

describe('P21: kanban agent routes (assemble / build / review / accept / jobs)', () => {
  let server;
  const bus = fakeBus();

  it('POST /api/kanban/assemble with goal returns 200 {job}', async () => {
    const handle = createServer(baseDeps(bus));
    server = handle.httpServer;
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const res = await httpPost(port, '/api/kanban/assemble', { goal: 'three tiny web toys' });
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.job);
    assert.equal(data.job.status, 'queued');

    server.close();
  });

  it('POST /api/kanban/assemble with empty goal returns 400', async () => {
    const handle = createServer(baseDeps(bus));
    server = handle.httpServer;
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const res = await httpPost(port, '/api/kanban/assemble', { goal: '' });
    assert.equal(res.status, 400);

    server.close();
  });

  it('GET /api/jobs/:id returns 200 for existing job, 404 for missing', async () => {
    const handle = createServer(baseDeps(bus));
    server = handle.httpServer;
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const found = await httpGet(port, '/api/jobs/build-1');
    assert.equal(found.status, 200);
    assert.equal(JSON.parse(found.body).job.status, 'done');

    const missing = await httpGet(port, '/api/jobs/nope');
    assert.equal(missing.status, 404);

    server.close();
  });

  it('POST /api/kanban/cards/:id/accept moves card to done', async () => {
    const handle = createServer(baseDeps(bus));
    server = handle.httpServer;
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const res = await httpPost(port, '/api/kanban/cards/c1/accept', {});
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.board);

    server.close();
  });

  it('POST /api/kanban/cards/:id/build returns 200 {job, board}', async () => {
    const handle = createServer(baseDeps(bus));
    server = handle.httpServer;
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const res = await httpPost(port, '/api/kanban/cards/x/build', {});
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.job);
    assert.ok(data.board);

    server.close();
  });

  it('POST /api/kanban/cards/:id/review returns 200 {job}', async () => {
    const handle = createServer(baseDeps(bus));
    server = handle.httpServer;
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const res = await httpPost(port, '/api/kanban/cards/x/review', {});
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.job);

    server.close();
  });
});
