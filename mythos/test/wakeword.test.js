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
const os = require('os');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

// This test used to arrange "models present" vs "models absent" by renameSync-ing
// the operator's REAL ui/public/models/wakeword directory aside and renaming it
// back in a finally block, because the /api/config/wakeword route statSynced a
// hardcoded path with no seam.
//
// That was destructive and it fired. On Windows the rename loses an EPERM race
// under full-suite load, and when it does the real .onnx weights are left
// stranded in `wakeword.test-backup/` while `wakeword/` no longer exists. Wake
// word is then silently dead, and git shows nothing at all because BOTH
// directories are gitignored (the models are CC BY-NC-SA and fetched
// per-machine by scripts/setup-wakeword.js). It does NOT self-heal — an earlier
// revision of CLAUDE.md claimed it did, which is how it survived as a known
// issue instead of being fixed.
//
// routes/config.js now takes an injectable `wakewordModelsDir`, so each case
// points the route at a fresh temp directory. Real models are never touched,
// and a crash mid-test can strand nothing that matters. The last test below
// pins the production default so the seam cannot silently stop resolving the
// real path.
const REQUIRED_MODEL_FILES = ['melspectrogram.onnx', 'embedding_model.onnx', 'hey_jarvis_v0.1.onnx'];

// Set by withWakewordDir(), injected via baseDeps(). Never the real path.
let activeWakewordDir = null;

function withWakewordDir(desiredState, fn) {
  // desiredState: 'empty' | 'present'
  return async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-wakeword-'));
    activeWakewordDir = path.join(root, 'wakeword');
    try {
      if (desiredState === 'present') {
        fs.mkdirSync(activeWakewordDir, { recursive: true });
        for (const name of REQUIRED_MODEL_FILES) fs.writeFileSync(path.join(activeWakewordDir, name), Buffer.from('placeholder-not-a-real-model'));
      }
      // 'empty' deliberately leaves the directory absent: the route derives
      // modelsPresent from a per-file statSync, so absent and empty are the
      // same observable state and this exercises the real code path.
      await fn();
    } finally {
      activeWakewordDir = null;
      fs.rmSync(root, { recursive: true, force: true });
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
    // The temp-dir seam (see the header comment). Null outside a
    // withWakewordDir() wrapper, which is exactly what production passes, so
    // the route falls back to the real path.
    wakewordModelsDir: activeWakewordDir,
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

// The seam above is only safe if production still resolves the REAL models
// directory when nothing is injected — otherwise this refactor would trade a
// destructive test for a silently broken feature, and modelsPresent would read
// false forever while the operator's models sat right where they belong.
//
// Asserted two ways, because neither alone is sufficient. Behaviourally,
// omitting the dep must give the same answer as passing the real path
// explicitly (environment-independent: both read the same directory, so they
// agree whether or not models happen to be installed on this machine). And by
// source shape, because the behavioural half would pass vacuously if the
// fallback resolved to some OTHER nonexistent path on a machine with no models
// — both would be false and agree for the wrong reason.
test('with no wakewordModelsDir injected, the route resolves the real models path', async () => {
  const realDir = path.join(__dirname, '..', 'ui', 'public', 'models', 'wakeword');

  const bus = createBus({ historySize: 50 });
  assert.equal(activeWakewordDir, null, 'this test must run outside a withWakewordDir wrapper');
  const serverDefault = createServer(baseDeps(bus));
  await serverDefault.ready;
  const viaDefault = await httpGet(serverDefault.httpServer.address().port, '/api/config/wakeword');
  await serverDefault.stop();

  const bus2 = createBus({ historySize: 50 });
  const depsExplicit = Object.assign(baseDeps(bus2), { wakewordModelsDir: realDir });
  const serverExplicit = createServer(depsExplicit);
  await serverExplicit.ready;
  const viaExplicit = await httpGet(serverExplicit.httpServer.address().port, '/api/config/wakeword');
  await serverExplicit.stop();

  assert.equal(viaDefault.body.modelsPresent, viaExplicit.body.modelsPresent,
    'the default fallback must read the same directory as the real path');

  // Source shape, UPDATED 2026-08-11 (installer parity). This used to require a
  // literal ui/public/models/wakeword path in routes/config.js. That path is now
  // only ONE of the directories searched: the downloaders write to a
  // userData-scoped models directory instead, because mythos/ui/public/models is
  // excluded from package.json build.files (a packaged install has no models
  // directory at all) and the install tree is replaced by every update. Pinning
  // the literal path would now pin the bug.
  //
  // What still has to hold is the same thing that assertion was standing in for:
  // the seam is a fallback and not a requirement, and the fallback resolves
  // through the shared resolver rather than inventing a path of its own.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'config.js'), 'utf8');
  assert.match(source, /deps\.wakewordModelsDir/,
    'routes/config.js must still honour the injected seam, not ignore it');
  assert.match(source, /findModelFile\('wakeword'/,
    'with no seam the route must search every model directory via core/setup/model-paths.js');

  // And the resolver's install-tree entry must still BE ui/public/models, which is
  // what keeps the behavioural half above from agreeing for the wrong reason.
  const { INSTALL_TREE_MODELS_DIR } = require('../src/core/setup/model-paths');
  assert.equal(path.resolve(INSTALL_TREE_MODELS_DIR), path.resolve(path.join(__dirname, '..', 'ui', 'public', 'models')));
  assert.equal(path.resolve(realDir), path.resolve(path.join(INSTALL_TREE_MODELS_DIR, 'wakeword')));
});

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
