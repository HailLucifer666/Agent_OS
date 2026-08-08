'use strict';

// test/csp-headers.test.js — H7 (security audit, 2026-08-08): the response
// pipeline had NO Content-Security-Policy at all. Pins the two-header split
// server/index.js now ships: a narrow ENFORCING header (verified safe — no
// <base>/<object>/<embed>/cross-origin-framing use anywhere in the HUD) and a
// broader REPORT-ONLY header for everything that can't be safely enforced yet
// (cssText inline styles, arbitrary open_web iframe embeds, the geo-IP
// fallback hosts). See server/index.js's setCspHeaders for the full story.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

function fakeFs() {
  return { vaultPath: (...s) => require('path').join('/test-vault', ...s) };
}

function baseDeps(bus) {
  return {
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
  };
}

function httpGet(port, pathName) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathName }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    }).on('error', reject);
  });
}

test('every response carries an enforcing CSP that is safe by construction (no base/object/frame-ancestors surface exists)', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus));
  await server.ready;
  const { port } = server.httpServer.address();
  try {
    const res = await httpGet(port, '/');
    const csp = res.headers['content-security-policy'];
    assert.ok(csp, 'expected a Content-Security-Policy header');
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'self'/);
    assert.match(csp, /frame-ancestors 'self'/);
  } finally {
    await server.stop();
  }
});

test('a broader report-only CSP is present for the directives not yet safe to enforce', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus));
  await server.ready;
  const { port } = server.httpServer.address();
  try {
    const res = await httpGet(port, '/');
    const cspRO = res.headers['content-security-policy-report-only'];
    assert.ok(cspRO, 'expected a Content-Security-Policy-Report-Only header');
    assert.match(cspRO, /script-src 'self' 'wasm-unsafe-eval'/, 'script-src should be strict — no eval/inline exists in the HUD');
    assert.match(cspRO, /style-src[^;]*'unsafe-inline'/, 'style-src must stay report-only until cssText usage is reworked');
    assert.match(cspRO, /frame-src https: http:/, 'frame-src must stay wide open — open_web embeds arbitrary URLs');
  } finally {
    await server.stop();
  }
});

test('the CSP applies to /api responses too, not just the static HTML shell', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus));
  await server.ready;
  const { port } = server.httpServer.address();
  try {
    const res = await httpGet(port, '/api/status');
    assert.ok(res.headers['content-security-policy']);
    assert.ok(res.headers['content-security-policy-report-only']);
  } finally {
    await server.stop();
  }
});
