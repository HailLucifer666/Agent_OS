'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const { once } = require('node:events');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createAuditWriter } = require('../src/core/memory/audit-writer');

function baseDeps(bus, overrides) {
  return Object.assign({
    bus,
    config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000 },
    logger: { info() {}, warn() {}, error() {} },
    memory: { working: { tick: 0, activeGoalId: null }, episodic: { write: async () => {} }, fs: {} },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
    leash: { confirm: { create: () => 'cf-1', accept: () => null, reject: () => true } },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({}) },
    agentActions: {
      assembleKanbanPlan: () => ({ job: { id: 'j1', status: 'queued' } }),
      buildKanbanCard: () => ({ job: { id: 'j1', status: 'queued' }, board: { cards: [] } }),
      reviewKanbanCard: () => ({ job: { id: 'j1', status: 'queued' } }),
    },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
  }, overrides || {});
}

function httpGet(port, pathName) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathName }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
}

test('BUG-019: GET /api/audit/recent returns recent audit entries newest-first', async () => {
  const bus = createBus({ historySize: 50 });
  const vaultRoot = path.join(__dirname, '..', 'vault_test_audit_' + Date.now());

  // Create a real fs-store pointing to a temp vault
  const fsStore = createFsStore(() => vaultRoot, bus);
  const auditWriter = createAuditWriter({ fs: fsStore, config: {}, bus, logger: { info() {}, warn() {}, error() {} } });
  await auditWriter.init();

  // Write 5 test entries in chronological order
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    auditWriter.write({
      tool: `tool_${i}`,
      decision: i % 2 === 0 ? 'accept' : 'deny',
      tier: i,
      ts: now - (5000 - i * 1000), // spread them out
    });
  }

  const fakeMemory = {
    working: { tick: 0, activeGoalId: null },
    episodic: { write: async () => {} },
    fs: fsStore,
    audit: auditWriter,
    stats: () => ({ audit: { count: 5 } }),
  };

  const server = createServer(baseDeps(bus, { memory: fakeMemory }));
  await server.ready;
  const addr = server.httpServer.address();

  // The persisted id/ts are additive: all previous payload fields survive,
  // and the UI can identify a row arriving through both HTTP and WS.
  const socket = new WebSocket('ws://127.0.0.1:' + addr.port + '/ws');
  await once(socket, 'open');
  try {
    const delivered = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('audit WS event missing')), 3000);
      socket.on('message', raw => {
        const message = JSON.parse(String(raw));
        if (message.type === 'audit') { clearTimeout(timeout); resolve(message.payload); }
      });
    });
    bus.emit('audit.decision', { id: 'aud-wire', ts: now, tool: 'wire_probe', tier: 2, decision: 'allow' });
    assert.deepEqual(await delivered, { id: 'aud-wire', ts: now, tool: 'wire_probe', tier: 2, decision: 'allow' });
  } finally {
    socket.close();
    await once(socket, 'close');
  }

  // Test 1: fetch all with default limit
  const res1 = await httpGet(addr.port, '/api/audit/recent');
  assert.equal(res1.status, 200, 'endpoint should return 200');
  assert.ok(Array.isArray(res1.body.entries), 'response should have entries array');
  assert.equal(res1.body.entries.length, 5, 'should return all 5 entries');

  // API returns newest-first: the first entry should be tool_4
  assert.equal(res1.body.entries[0].tool, 'tool_4', 'first entry should be newest (tool_4)');
  assert.equal(res1.body.entries[4].tool, 'tool_0', 'last entry should be oldest (tool_0)');

  // Test 2: fetch with limit
  const res2 = await httpGet(addr.port, '/api/audit/recent?limit=2');
  assert.equal(res2.status, 200);
  assert.equal(res2.body.entries.length, 2, 'should respect limit parameter');
  assert.equal(res2.body.entries[0].tool, 'tool_4', 'newest entry first');
  assert.equal(res2.body.entries[1].tool, 'tool_3', 'second newest entry second');

  // Test 3: respects max limit of 200
  const res3 = await httpGet(addr.port, '/api/audit/recent?limit=300');
  assert.equal(res3.status, 200);
  assert.ok(res3.body.entries.length <= 200, 'should cap at 200 even if requested higher');

  // Test 4: empty vault returns empty array
  const emptyVaultRoot = path.join(__dirname, '..', 'vault_test_audit_empty_' + Date.now());
  const emptyFs = createFsStore(() => emptyVaultRoot, bus);
  const emptyAudit = createAuditWriter({ fs: emptyFs, config: {}, bus, logger: { info() {}, warn() {}, error() {} } });
  await emptyAudit.init();

  const emptyMemory = {
    working: { tick: 0, activeGoalId: null },
    episodic: { write: async () => {} },
    fs: emptyFs,
    audit: emptyAudit,
    stats: () => ({ audit: { count: 0 } }),
  };

  const server2 = createServer(baseDeps(bus, { memory: emptyMemory }));
  await server2.ready;
  const addr2 = server2.httpServer.address();

  const res4 = await httpGet(addr2.port, '/api/audit/recent');
  assert.equal(res4.status, 200);
  assert.equal(res4.body.entries.length, 0, 'empty vault should return empty array');

  // Cleanup
  await server.stop();
  await server2.stop();

  // Clean up test vault directories
  try { fs.rmSync(vaultRoot, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(emptyVaultRoot, { recursive: true, force: true }); } catch (_) {}
});
