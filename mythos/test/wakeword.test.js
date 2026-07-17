'use strict';

// wakeword.test.js — Phase 1 (hands-free wake-word) coverage:
//   1. GET /api/config/wakeword over a real HTTP server (mirrors server.test.js's
//      real-instance pattern — Lesson #4: real server, not a fake route table).
//   2. scripts/setup-wakeword.js's resolveAssetUrls() — pure, no network calls.

const { test, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

// The /api/config/wakeword route (server/index.js) statSyncs a hardcoded real
// path (ui/public/models/wakeword/) rather than an injectable one, so "models
// present" vs "models absent" is exercised here by actually moving that real
// directory aside / restoring it — not by mocking. This also means the test
// is honest about a developer machine that has already run
// scripts/setup-wakeword.js (this repo's own CI/dev box may have real models
// downloaded from an earlier live-verification pass): each test case
// arranges the exact directory state it asserts on and restores whatever was
// there before, so it passes identically whether or not models are present.
const WAKEWORD_DIR = path.join(__dirname, '..', 'ui', 'public', 'models', 'wakeword');
const WAKEWORD_DIR_BACKUP = WAKEWORD_DIR + '.test-backup';
const REQUIRED_MODEL_FILES = ['melspectrogram.onnx', 'embedding_model.onnx', 'hey_jarvis_v0.1.onnx'];

function withWakewordDir(desiredState, fn) {
  // desiredState: 'empty' | 'present'
  return async () => {
    const existed = fs.existsSync(WAKEWORD_DIR);
    if (existed) fs.renameSync(WAKEWORD_DIR, WAKEWORD_DIR_BACKUP);
    try {
      if (desiredState === 'present') {
        fs.mkdirSync(WAKEWORD_DIR, { recursive: true });
        for (const name of REQUIRED_MODEL_FILES) fs.writeFileSync(path.join(WAKEWORD_DIR, name), Buffer.from('placeholder-not-a-real-model'));
      }
      await fn();
    } finally {
      if (fs.existsSync(WAKEWORD_DIR)) fs.rmSync(WAKEWORD_DIR, { recursive: true, force: true });
      if (existed) fs.renameSync(WAKEWORD_DIR_BACKUP, WAKEWORD_DIR);
    }
  };
}

function fakeFs() {
  return { vaultPath: (...segments) => path.join('/test-vault', ...segments) };
}

function baseDeps(bus, configOverrides) {
  return {
    bus,
    config: Object.assign({
      MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
      MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000,
      WAKEWORD_ENABLED: false, WAKEWORD_THRESHOLD: 0.5,
    }, configOverrides || {}),
    logger: { info() {}, warn() {}, error() {} },
    memory: { working: { tick: 0, activeGoalId: null }, episodic: { write: async () => {} }, fs: fakeFs() },
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
  };
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

test('GET /api/config/wakeword reports disabled default + modelsPresent:false when the models dir is empty', withWakewordDir('empty', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus));
  await server.ready;
  const { port } = server.httpServer.address();

  const res = await httpGet(port, '/api/config/wakeword');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { enabled: false, threshold: 0.5, modelsPresent: false });

  await server.stop();
}));

test('GET /api/config/wakeword reflects enabled + custom threshold, and modelsPresent:true once all 3 files exist', withWakewordDir('present', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus, { WAKEWORD_ENABLED: true, WAKEWORD_THRESHOLD: 0.7 }));
  await server.ready;
  const { port } = server.httpServer.address();

  const res = await httpGet(port, '/api/config/wakeword');
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.threshold, 0.7);
  assert.equal(res.body.modelsPresent, true);

  await server.stop();
}));

describe('scripts/setup-wakeword.js resolveAssetUrls (pure, no network)', () => {
  const { resolveAssetUrls, REQUIRED_ASSETS } = require('../scripts/setup-wakeword');

  it('finds the newest release carrying all three required assets', () => {
    const releases = [
      { tag_name: 'v0.6.0', assets: [] }, // newest — no model assets, must be skipped
      {
        tag_name: 'v0.5.1',
        assets: [
          { name: 'melspectrogram.onnx', browser_download_url: 'https://example.test/mel.onnx' },
          { name: 'embedding_model.onnx', browser_download_url: 'https://example.test/embed.onnx' },
          { name: 'hey_jarvis_v0.1.onnx', browser_download_url: 'https://example.test/jarvis.onnx' },
          { name: 'hey_mycroft_v0.1.onnx', browser_download_url: 'https://example.test/mycroft.onnx' },
        ],
      },
      { tag_name: 'v0.1.1', assets: [{ name: 'unrelated.whl', browser_download_url: 'https://example.test/x.whl' }] },
    ];
    const urls = resolveAssetUrls(releases);
    assert.ok(urls);
    for (const name of REQUIRED_ASSETS) assert.ok(urls[name], `missing resolved URL for ${name}`);
    assert.equal(urls['melspectrogram.onnx'], 'https://example.test/mel.onnx');
    assert.equal(urls['hey_jarvis_v0.1.onnx'], 'https://example.test/jarvis.onnx');
  });

  it('returns null when no release carries the full required set', () => {
    const releases = [
      { tag_name: 'v9.9.9', assets: [{ name: 'melspectrogram.onnx', browser_download_url: 'x' }] },
    ];
    assert.equal(resolveAssetUrls(releases), null);
  });

  it('handles an empty/missing releases list without throwing', () => {
    assert.equal(resolveAssetUrls([]), null);
    assert.equal(resolveAssetUrls(undefined), null);
  });
});
