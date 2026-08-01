'use strict';

// test/config-vad-engine-route.test.js — GET /api/config/vad's new `engine`
// field (server/routes/config.js), added alongside VAD_ENGINE=rms|silero
// (schema.js). Same real-server harness shape as test/config-s2s-route.test.js.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

function fakeFs() {
  return { vaultPath: (...s) => path.join('/test-vault', ...s) };
}

function baseDeps(bus, configOverrides) {
  return {
    bus,
    config: Object.assign({
      MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
      MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '',
      VAD_SPEECH_RMS: 0.035, VAD_MIN_PEAK_RMS: 0.06, VAD_HOLD_TICKS: 3, VAD_SILENCE_MS: 1800,
    }, configOverrides || {}),
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
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body || '{}') }));
    }).on('error', reject);
  });
}

async function withServer(configOverrides, fn) {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus, configOverrides));
  await server.ready;
  const { port } = server.httpServer.address();
  try { await fn(port); } finally { await server.stop(); }
}

describe('GET /api/config/vad — engine field', () => {
  test('defaults to rms when VAD_ENGINE is unset', async () => {
    await withServer({}, async (port) => {
      const res = await httpGet(port, '/api/config/vad');
      assert.equal(res.body.engine, 'rms');
    });
  });

  test('reports silero when VAD_ENGINE=silero', async () => {
    await withServer({ VAD_ENGINE: 'silero' }, async (port) => {
      const res = await httpGet(port, '/api/config/vad');
      assert.equal(res.body.engine, 'silero');
    });
  });

  test('an unrecognized value degrades to rms rather than leaking through', async () => {
    await withServer({ VAD_ENGINE: 'something-unexpected' }, async (port) => {
      const res = await httpGet(port, '/api/config/vad');
      assert.equal(res.body.engine, 'rms');
    });
  });
});
