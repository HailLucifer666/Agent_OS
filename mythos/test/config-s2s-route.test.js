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

// 2026-08-04, Electron Slice 3: the first three tests below asserted
// `deepEqual(res.body, {enabled})` — the whole body, exactly. Slice 3 adds a
// `screenShare` block (LIVE_SCREEN_SHARE_ENABLED plus its fps/quality cost
// dials) because the HUD's capture module has no other way to learn whether the
// operator opted into streaming their desktop — the identical gap that left
// s2s-bridge.js unreachable until this route existed.
//
// These assertions were REWRITTEN rather than deleted, and deliberately not
// loosened to a bare truthiness check. This file guards two things, both kept
// below: (1) `enabled` is always a real boolean, never undefined/null, so a
// client can trust it; (2) nothing but flags crosses this boundary — no key, no
// model id, no endpoint. The exact-key-set assertion in the leak test is
// therefore still exact, just against the new two-key shape, so a future field
// added here still has to come and justify itself in this file.
describe('GET /api/config/s2s (the flag surface the S2S bridge needs)', () => {
  test('reports enabled:false when VOICE_S2S_ENABLED is off — the schema default', async () => {
    await withServer({ VOICE_S2S_ENABLED: false }, async (port) => {
      const res = await httpGet(port, '/api/config/s2s');
      assert.equal(res.status, 200);
      assert.equal(res.body.enabled, false);
    });
  });

  test('reports enabled:true when VOICE_S2S_ENABLED is on', async () => {
    await withServer({ VOICE_S2S_ENABLED: true }, async (port) => {
      const res = await httpGet(port, '/api/config/s2s');
      assert.equal(res.status, 200);
      assert.equal(res.body.enabled, true);
    });
  });

  test('an absent VOICE_S2S_ENABLED is reported as false, never as undefined/null', async () => {
    await withServer({}, async (port) => {
      const res = await httpGet(port, '/api/config/s2s');
      assert.equal(res.body.enabled, false);
    });
  });

  test('leaks nothing but flags — no API key, model id or endpoint', async () => {
    await withServer({ VOICE_S2S_ENABLED: true, GEMINI_API_KEY: 'sk-should-never-appear', LIVE_MODEL: 'secret-model' }, async (port) => {
      const res = await httpGet(port, '/api/config/s2s');
      // 2026-09-23: gateRecorder added (BUG-406's mic-gate recorder). A boolean, like the others — asserted
      // below — so the route still exposes flags only.
      assert.deepEqual(Object.keys(res.body), ['enabled', 'operatorEnabled', 'gateRecorder', 'screenShare']);
      assert.equal(typeof res.body.gateRecorder, 'boolean');
      assert.equal(res.body.operatorEnabled, false);
      assert.equal(JSON.stringify(res.body).includes('sk-should-never-appear'), false);
      assert.equal(JSON.stringify(res.body).includes('secret-model'), false);
    });
  });

  test('screen share is reported false unless explicitly enabled — it streams the desktop', async () => {
    // Fail-closed matters more here than for the other flags in this file: the
    // failure mode is not a missing feature, it is sending pictures of the
    // operator's screen to Google without them asking.
    await withServer({ VOICE_S2S_ENABLED: true }, async (port) => {
      const res = await httpGet(port, '/api/config/s2s');
      assert.equal(res.body.screenShare.enabled, false,
        'absent LIVE_SCREEN_SHARE_ENABLED must report false, never undefined');
    });
    await withServer({ VOICE_S2S_ENABLED: true, LIVE_SCREEN_SHARE_ENABLED: true, LIVE_SCREEN_FPS: 1, LIVE_SCREEN_JPEG_QUALITY: 0.5 }, async (port) => {
      const res = await httpGet(port, '/api/config/s2s');
      assert.equal(res.body.screenShare.enabled, true);
      assert.equal(res.body.screenShare.fps, 1);
      assert.equal(res.body.screenShare.quality, 0.5);
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
