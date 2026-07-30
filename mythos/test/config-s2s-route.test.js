'use strict';

// test/config-s2s-route.test.js — GET /api/config/s2s (server/routes/config.js).
//
// Why this route exists: ui/public/js/voice/s2s-bridge.js was a complete,
// protocol-correct Gemini Live client with no consumer, because the client had
// NO way to learn VOICE_S2S_ENABLED — the flag was only ever read server-side
// (server/index.js's liveOpen()). This route is that missing surface, and
// ui/public/js/app.js gates the whole S2S path on it.
//
// Drives the REAL server through the same harness shape as
// test/pin-routes.test.js, so this proves the actual mount, not a stub.

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

describe('GET /api/config/s2s (the flag surface the S2S bridge needs)', () => {
  test('reports enabled:false when VOICE_S2S_ENABLED is off — the schema default', async () => {
    await withServer({ VOICE_S2S_ENABLED: false }, async (port) => {
      const res = await httpGet(port, '/api/config/s2s');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { enabled: false });
    });
  });

  test('reports enabled:true when VOICE_S2S_ENABLED is on', async () => {
    await withServer({ VOICE_S2S_ENABLED: true }, async (port) => {
      const res = await httpGet(port, '/api/config/s2s');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { enabled: true });
    });
  });

  test('an absent VOICE_S2S_ENABLED is reported as false, never as undefined/null', async () => {
    await withServer({}, async (port) => {
      const res = await httpGet(port, '/api/config/s2s');
      assert.deepEqual(res.body, { enabled: false });
    });
  });

  test('leaks nothing but the boolean — no API key, model id or endpoint', async () => {
    await withServer({ VOICE_S2S_ENABLED: true, GEMINI_API_KEY: 'sk-should-never-appear', LIVE_MODEL: 'secret-model' }, async (port) => {
      const res = await httpGet(port, '/api/config/s2s');
      assert.deepEqual(Object.keys(res.body), ['enabled']);
      assert.equal(JSON.stringify(res.body).includes('sk-should-never-appear'), false);
      assert.equal(JSON.stringify(res.body).includes('secret-model'), false);
    });
  });

  test('the pre-existing /api/config/vad and /api/config/wakeword routes still answer (additive change)', async () => {
    await withServer({ VAD_SPEECH_RMS: 0.035, VAD_MIN_PEAK_RMS: 0.05, VAD_HOLD_TICKS: 3, VAD_SILENCE_MS: 900, WAKEWORD_ENABLED: false, WAKEWORD_THRESHOLD: 0.5 }, async (port) => {
      const vad = await httpGet(port, '/api/config/vad');
      assert.equal(vad.status, 200);
      assert.equal(vad.body.speechRms, 0.035);
      const ww = await httpGet(port, '/api/config/wakeword');
      assert.equal(ww.status, 200);
      assert.equal(ww.body.enabled, false);
    });
  });
});
