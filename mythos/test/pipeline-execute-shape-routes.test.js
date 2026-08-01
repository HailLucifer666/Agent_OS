'use strict';

// Pipeline execute/shape routes — the pipeline view's Execute and Shape buttons
// POST to /api/pipeline/:id/execute and /api/pipeline/:id/shape. These routes
// must exist and delegate to agentActions.executePipelineCard / pipelineEffector.

const { describe, it, afterEach } = require('node:test');
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
    pipelineEffector: {
      listAll: () => ({ capture: [], 'human-gate': [], execute: [], shipped: [] }),
      findCard: (id) => id === 'card-1' ? { card: { id: 'card-1', text: 'build x', stage: 'capture', risk: 'low' }, stage: 'capture' } : null,
      moveCard: (id, toStage, patch) => Object.assign({ id, text: 'build x', risk: 'low' }, patch, { stage: toStage }),
    },
    effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
    leash: { confirm: { create: () => 'cf-1', accept: () => null, reject: () => true } },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({}) },
    agentActions: {
      executePipelineCard: (cardId, goalId) => {
        if (cardId === 'missing') throw new Error('card not found');
        return { job: { id: 'job-1', status: 'queued', kind: 'pipeline-exec' }, board: { execute: [{ id: cardId }] } };
      },
    },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
  }, overrides || {});
}

function httpPost(port, pathName, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
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

describe('pipeline execute/shape routes', () => {
  let server;
  const bus = fakeBus();

  afterEach(() => { if (server) server.close(); server = null; });

  it('POST /api/pipeline/:id/execute returns 200 {job, board}', async () => {
    const handle = createServer(baseDeps(bus));
    server = handle.httpServer;
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const res = await httpPost(port, '/api/pipeline/card-1/execute', {});
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.job, 'response must carry the job');
    assert.equal(data.job.id, 'job-1');
    assert.ok(data.board, 'response must carry the updated board');
  });

  it('POST /api/pipeline/:id/execute returns 400 when the card cannot execute', async () => {
    const handle = createServer(baseDeps(bus));
    server = handle.httpServer;
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const res = await httpPost(port, '/api/pipeline/missing/execute', {});
    assert.equal(res.status, 400);
    const data = JSON.parse(res.body);
    assert.ok(data.error, 'error response must carry a message');
  });

  it('POST /api/pipeline/:id/shape returns 200 {card, board} and marks the card shaped', async () => {
    const handle = createServer(baseDeps(bus));
    server = handle.httpServer;
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const res = await httpPost(port, '/api/pipeline/card-1/shape', {});
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.card, 'response must carry the updated card');
    assert.equal(data.card.shaped, true);
    assert.ok(data.board, 'response must carry the updated board');
  });

  it('POST /api/pipeline/:id/shape returns 404 for an unknown card', async () => {
    const handle = createServer(baseDeps(bus));
    server = handle.httpServer;
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const res = await httpPost(port, '/api/pipeline/nope/shape', {});
    assert.equal(res.status, 404);
  });
});
