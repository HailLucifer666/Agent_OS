'use strict';
// W4 regression: every REST mutation on /api/goals, /api/kanban, /api/pipeline,
// /api/engagements writes an audit line. Pre-W4 these routes mutated state
// with no leash check and no audit entry — destructive routes were
// unguarded (task-957 §24 W4). W4 is audit-only (the leash/auth story is P1,
// Phase 5).
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
    config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
              MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000 },
    logger: { info() {}, warn() {}, error() {} },
    // memory.audit.write is the sink W4's auditRest() writes to. Record every call.
    memory: {
      working: { tick: 0, activeGoalId: null },
      episodic: { write: async () => {} },
      audit: { write: (entry) => { auditLog.push(entry); }, query: () => [] },
      fs: fakeFs(),
    },
    goalsEffector: {
      listGoals: () => [], addGoal: () => [], toggleGoal: () => [], deleteGoal: () => [],
      stats: () => ({ total: 0, done: 0, active: 0 }),
    },
    kanbanEffector: {
      listBoard: () => ({ cards: [] }),
      addCard: (title, lane) => ({ id: 'c1', title, lane: lane || 'backlog' }),
      moveCard: () => ({ id: 'c1', lane: 'done' }),
      deleteCard: () => {},
      patchCard: () => {},
    },
    pipelineEffector: {
      listAll: () => ({}),
      capture: (text) => ({ id: 'p1', text }),
      approve: (id) => ({ id }),
      reject: () => {},
      ship: (id) => ({ id }),
    },
    effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
    leash: { confirm: { create: () => 'cf-1', accept: () => null, reject: () => true } },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({}) },
    agentActions: {
      assembleKanbanPlan: () => ({ job: { id: 'plan-1', status: 'queued' } }),
      buildKanbanCard: () => ({ job: { id: 'build-1', status: 'queued' }, board: { cards: [] } }),
      reviewKanbanCard: () => ({ job: { id: 'review-1', status: 'queued' } }),
    },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
  }, overrides || {});
}

// Single shared audit log across the suite — reset per test.
let auditLog = [];

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

function httpDelete(port, pathName) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method: 'DELETE' }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(deps, fn) {
  const handle = createServer(deps);
  const server = handle.httpServer;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try { await fn(port); } finally { server.close(); }
}

describe('W4: REST mutations write audit entries', () => {
  it('POST /api/goals writes a rest.goals.add audit entry', async () => {
    auditLog = [];
    await withServer(baseDeps(fakeBus()), async (port) => {
      const res = await httpPost(port, '/api/goals', { text: 'ship phase 2', category: 'work' });
      assert.equal(res.status, 200);
    });
    assert.ok(auditLog.some(a => a.tool === 'rest.goals.add' && a.decision === 'completed'),
      'expected rest.goals.add audit entry');
  });

  it('POST /api/goals/:id/toggle + DELETE /api/goals/:id each audit', async () => {
    auditLog = [];
    await withServer(baseDeps(fakeBus()), async (port) => {
      await httpPost(port, '/api/goals/g1/toggle', {});
      await httpDelete(port, '/api/goals/g1');
    });
    assert.ok(auditLog.some(a => a.tool === 'rest.goals.toggle'));
    assert.ok(auditLog.some(a => a.tool === 'rest.goals.delete'));
  });

  it('kanban mutations (add/move/delete/assemble/build/review/accept) each audit', async () => {
    auditLog = [];
    await withServer(baseDeps(fakeBus()), async (port) => {
      await httpPost(port, '/api/kanban/cards', { title: 'card1', lane: 'backlog' });
      await httpPost(port, '/api/kanban/cards/c1/move', { lane: 'done' });
      await httpDelete(port, '/api/kanban/cards/c1');
      await httpPost(port, '/api/kanban/assemble', { goal: 'tiny toy' });
      await httpPost(port, '/api/kanban/cards/c1/build', {});
      await httpPost(port, '/api/kanban/cards/c1/review', {});
      await httpPost(port, '/api/kanban/cards/c1/accept', { lane: 'done' });
    });
    const expected = [
      'rest.kanban.addCard', 'rest.kanban.moveCard', 'rest.kanban.deleteCard',
      'rest.kanban.assemble', 'rest.kanban.buildCard', 'rest.kanban.reviewCard',
      'rest.kanban.acceptCard'
    ];
    for (const tool of expected) {
      assert.ok(auditLog.some(a => a.tool === tool),
        'expected audit entry for ' + tool + ' (got: ' + auditLog.map(a => a.tool).join(', ') + ')');
    }
  });

  it('pipeline mutations (capture/approve/reject/delete/ship) each audit', async () => {
    auditLog = [];
    await withServer(baseDeps(fakeBus()), async (port) => {
      await httpPost(port, '/api/pipeline/capture', { text: 'idea' });
      await httpPost(port, '/api/pipeline/p1/approve', {});
      await httpPost(port, '/api/pipeline/p1/reject', {});
      await httpPost(port, '/api/pipeline/p1/delete', {});
      await httpPost(port, '/api/pipeline/p1/ship', {});
    });
    const expected = [
      'rest.pipeline.capture', 'rest.pipeline.approve', 'rest.pipeline.reject',
      'rest.pipeline.delete', 'rest.pipeline.ship'
    ];
    for (const tool of expected) {
      assert.ok(auditLog.some(a => a.tool === tool), 'expected audit entry for ' + tool);
    }
  });

  it('every W4 audit entry has tier:1, decision:"completed", source:"rest"', async () => {
    auditLog = [];
    await withServer(baseDeps(fakeBus()), async (port) => {
      await httpPost(port, '/api/goals', { text: 'x' });
    });
    const entry = auditLog.find(a => a.tool === 'rest.goals.add');
    assert.ok(entry);
    assert.equal(entry.tier, 1);
    assert.equal(entry.decision, 'completed');
    assert.equal(entry.source, 'rest');
  });
});
