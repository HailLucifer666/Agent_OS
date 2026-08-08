'use strict';

// test/deploy-config-conformance.test.js — the go-live proof plan's config
// drift gate (F1–F3). render.yaml and the Dockerfile are the only files that
// describe how this repo deploys, and until 2026-08-08 zero tests read either
// of them — so a deploy that dies (Render's health probe 404ing, the WS origin
// allowlist strangling the live surface, an LGPL package baked into the
// production image) was invisible to `node --test`. This file parses the REAL
// files on disk — never a hand-rolled copy of them — so config drift is one
// file's job (the same god-file decomposition the repo already uses for
// routes).
//
// Red-first discipline: every static guard below was written against the
// pre-fix render.yaml / Dockerfile and FAILED (see each commit message for the
// pasted red output) before the corresponding fix landed.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

const REPO_ROOT = path.join(__dirname, '..', '..'); // repo root — render.yaml lives here
const MYTHOS_ROOT = path.join(__dirname, '..');     // mythos/
const RENDER_YAML_PATH = path.join(REPO_ROOT, 'render.yaml');
const DOCKERFILE_PATH = path.join(MYTHOS_ROOT, 'Dockerfile');
const MAIN_PATH = path.join(MYTHOS_ROOT, 'src', 'main.js');
const RENDER_HOSTNAME = 'agent-os.onrender.com';
const TOKEN = 'deploy-config-conformance-test-token';

// The same minimal fake deps every server test in this repo uses (server-auth,
// config-s2s-route, pin-routes, …) — createServer() only exercises the paths
// the test drives, and these stubs are enough for it to boot.
function fakeFs() {
  return { vaultPath: (...s) => path.join('/test-vault', ...s) };
}

function baseDeps(bus, overrides) {
  return Object.assign({
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
  }, overrides || {});
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/);
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, '127.0.0.1');
  });
}

async function pickFreePort() {
  for (let i = 0; i < 30; i++) {
    const p = 20000 + Math.floor(Math.random() * 20000);
    if (await isPortFree(p)) return p;
  }
  throw new Error('no free port found after 30 tries');
}

function httpGet(port, pathName) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathName }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

async function waitForStatus(port, pathName, wantStatus, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = new Error(`timeout waiting for ${pathName} -> ${wantStatus}`);
  while (Date.now() < deadline) {
    try {
      const res = await httpGet(port, pathName);
      if (res.status === wantStatus) return res;
      lastErr = new Error(`${pathName} -> ${res.status}, wanted ${wantStatus}`);
    } catch (err) { lastErr = err; }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw lastErr;
}

// Kill a spawned child WITHOUT hanging: if the child already exited (a boot
// crash), 'close' was emitted before we got here and awaiting it would never
// resolve. Race the close with a bounded timeout instead.
async function stopChild(child) {
  if (child.exitCode !== null) return; // already exited
  child.kill('SIGKILL');
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

// ---------------------------------------------------------------------------
// F1 — Render's health probe must hit a route that actually exists.
//
// render.yaml said healthCheckPath: /api/health, but server/index.js mounts
// app.get('/health') (line ~638) and the /api catch-all 404s everything that
// isn't a real route — so every Render deploy was marked UNHEALTHY and
// restarted in a loop. The e2e harness's phase A already waits on /health,
// which is the real route. Fix: /api/health -> /health in render.yaml.
// ---------------------------------------------------------------------------

describe('F1 · render.yaml healthCheckPath matches the real route', () => {
  test('healthCheckPath is exactly /health (the route server/index.js actually mounts)', () => {
    const lines = readLines(RENDER_YAML_PATH);
    const hits = lines.filter((l) => l.trim().startsWith('healthCheckPath:'));
    // Guard the line-scan itself: a second healthCheckPath line (or a shape
    // change) must fail loudly here, never silently pass.
    assert.equal(hits.length, 1, `expected exactly one healthCheckPath line in render.yaml, got ${hits.length}`);
    assert.equal(hits[0].trim(), 'healthCheckPath: /health');
  });

  test('real boot: /health answers 200 {ok:true} with NO token; /api/health stays 404', async () => {
    const port = await pickFreePort();
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-conformance-vault-'));
    const child = spawn(process.execPath, [MAIN_PATH], {
      cwd: MYTHOS_ROOT,
      env: {
        ...process.env,
        MYTHOS_PORT: String(port),
        MYTHOS_BIND: '127.0.0.1',
        MYTHOS_AUTH_TOKEN: '',
        MYTHOS_VAULT_ROOT: vaultDir,
        EDGE_TTS_AUTOSTART: 'false',
        EDGE_TTS_URL: 'http://127.0.0.1:5099',
        EDGE_TTS_PORT: '5099',
        LOG_LEVEL: 'warn',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    try {
      // /health must answer 200 with NO token — it is mounted OUTSIDE the
      // /api gate, which is the whole point of a health probe (Render's probe
      // cannot carry a token).
      await waitForStatus(port, '/health', 200, 30000);
      const health = await httpGet(port, '/health');
      assert.equal(health.status, 200);
      assert.equal(JSON.parse(health.body).ok, true);
      // The wrong path must stay wrong: if someone re-points render.yaml at
      // /api/health, this assertion is what catches the reintroduction.
      const apiHealth = await httpGet(port, '/api/health');
      assert.equal(apiHealth.status, 404, '/api/health must stay 404 — it is not a route');
    } finally {
      await stopChild(child);
      try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    }
  });
});

// ---------------------------------------------------------------------------
// F2 — the WS origin allowlist must admit the deployed hostname.
//
// server/index.js's verifyClient() rejects any WS upgrade whose Origin is not
// in ALLOWED_ORIGINS (defaults: http://localhost:<port> + http://127.0.0.1:
// <port> only — server/index.js:355-358). On Render the HUD connects
// same-origin to the deployed hostname (ui/public/js/ws.js), so without an
// ALLOWED_ORIGINS entry the ENTIRE live layer (voice, confirms, entity state,
// tick stream) is 403-rejected in production. render.yaml declared no
// ALLOWED_ORIGINS — the deployment had no way to learn its own hostname.
// ---------------------------------------------------------------------------

describe('F2 · render.yaml carries the WS origin allowlist for the deployed hostname', () => {
  test('ALLOWED_ORIGINS is declared — as a committed value, or as a dashboard-supplied sync:false entry', () => {
    const lines = readLines(RENDER_YAML_PATH);
    const keyIdx = lines.findIndex((l) => l.trim() === '- key: ALLOWED_ORIGINS');
    assert.notEqual(keyIdx, -1, 'render.yaml must declare an ALLOWED_ORIGINS env var (a deploy without one 403s the whole live layer)');
    const rest = lines.slice(keyIdx + 1).filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    const valueLine = rest.find((l) => l.trim().startsWith('value:'));
    const syncLine = rest.find((l) => l.trim().startsWith('sync:'));
    if (valueLine) {
      // Committed value: must be a list of origins the server will actually
      // accept — isValidOrigin (server/index.js) SILENTLY drops anything that
      // fails ^https?://[a-zA-Z0-9._-]+(:\d+)?$, so a schemeless string would
      // pass here yet leave the deploy 403-dead with a green suite.
      const value = valueLine.trim().replace(/^value:\s*"?/, '').replace(/"?$/, '');
      const originRe = /^https?:\/\/[a-zA-Z0-9._-]+(:\d+)?$/;
      const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
      assert.ok(parts.length >= 1, `ALLOWED_ORIGINS must not be empty; got: ${value}`);
      for (const part of parts) {
        assert.ok(originRe.test(part), `origin "${part}" would be silently dropped by the server's isValidOrigin — must match ^https?://[a-zA-Z0-9._-]+(:\d+)?$`);
      }
      assert.ok(parts.some((p) => p.includes(RENDER_HOSTNAME)),
        `ALLOWED_ORIGINS must include https://${RENDER_HOSTNAME}; got: ${value}`);
    } else {
      // Dashboard-supplied (sync:false, per render.yaml B4): the key exists
      // and is explicitly marked sync:false — a bare key with no value and no
      // sync flag means Render deploys it empty and the live layer 403s.
      assert.ok(syncLine && /sync:\s*false/.test(syncLine),
        'ALLOWED_ORIGINS with no committed value must be declared sync:false (set once in the Render dashboard)');
    }
  });

  test('mechanism: a foreign-but-allowlisted Origin + ?token= opens a REAL ws; a non-allowlisted foreign Origin still 403s', async () => {
    // createServer builds its allowlist from process.env.ALLOWED_ORIGINS at
    // construction (server/index.js:358) — exactly the env var render.yaml
    // now supplies. Set it to prove the deployed config would actually work
    // end-to-end, then restore. Note: this mechanism test is green even on
    // the pre-fix code; the RED proof for F2 is the static guard above, which
    // fails on a render.yaml with no ALLOWED_ORIGINS.
    const prev = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = `https://${RENDER_HOSTNAME}`;
    try {
      const bus = createBus({ historySize: 50 });
      const server = createServer(baseDeps(bus, {
        config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: TOKEN },
      }));
      await server.ready;
      const { port } = server.httpServer.address();
      try {
        // Allowlisted foreign origin + ?token= -> must OPEN. This is the
        // connection that 403s on Render today because render.yaml never
        // declared the hostname.
        const opened = await new Promise((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, { origin: `https://${RENDER_HOSTNAME}` });
          ws.on('open', () => { ws.close(); resolve('opened'); });
          ws.on('unexpected-response', () => resolve('rejected'));
          ws.on('error', () => resolve('rejected'));
        });
        assert.equal(opened, 'opened', 'allowlisted foreign origin must connect (dead on Render without this)');

        // A DIFFERENT foreign origin that is NOT allowlisted -> still 403.
        // Pins the security property the allowlist exists for.
        const rejected = await new Promise((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, { origin: 'https://evil.example.com' });
          ws.on('open', () => resolve('opened'));
          ws.on('unexpected-response', () => resolve('rejected'));
          ws.on('error', () => resolve('rejected'));
        });
        assert.equal(rejected, 'rejected', 'non-allowlisted foreign origin must stay rejected');
      } finally {
        await server.stop();
      }
    } finally {
      if (prev === undefined) delete process.env.ALLOWED_ORIGINS;
      else process.env.ALLOWED_ORIGINS = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// F3 — the Dockerfile must not bundle the LGPLv3 edge-tts package.
//
// Repo policy (CLAUDE.md + roadmap step 6.5, Decision 1): TTS is BYO — "the
// step-7 installer never bundles the LGPL package". The Dockerfile used to
// `pip3 install --break-system-packages edge-tts || true`, which shipped the
// LGPLv3 Python package inside the production image — the exact exposure the
// licensing gate exists to prevent. The desktop path already excludes
// edge-tts-server.py via package.json build.files (pinned by
// test/electron-builder-files-allowlist.test.js); the cloud image must honor
// the same policy. Absent the package, server TTS stays off and the browser's
// speechSynthesis fallback speaks instead — the same honest degrade as on
// desktop.
// ---------------------------------------------------------------------------

describe('F3 · Dockerfile honors the TTS-is-BYO licensing gate', () => {
  const dockerfile = () => fs.readFileSync(DOCKERFILE_PATH, 'utf8');

  test('no pip install line may reference edge-tts (LGPLv3 — never bundled)', () => {
    const installs = dockerfile().split(/\r?\n/).filter((l) => /pip(\d)?\s+install/.test(l));
    const edgeInstalls = installs.filter((l) => /edge-tts/i.test(l));
    assert.equal(edgeInstalls.length, 0,
      `edge-tts must never be pip-installed in the image (LGPLv3 — BYO). Found: ${edgeInstalls.join(' | ')}`);
  });

  test('positive control: the image still boots MYTHOS and states the BYO policy', () => {
    const df = dockerfile();
    // The CMD must survive so this guard can never pass vacuously on a gutted file.
    assert.match(df, /CMD\s+\["node",\s*"src\/main\.js"\]/, 'Dockerfile must keep CMD ["node", "src/main.js"]');
    // And the policy comment must be present so the removal is a documented
    // decision, not an accident that later gets silently re-added.
    assert.match(df, /edge-tts is BYO — never bundled/i, 'Dockerfile must carry the TTS-is-BYO comment');
  });

  test('cross-doc consistency: .env.example, Dockerfile and THIRD_PARTY_NOTICES all say never-bundled', () => {
    const docs = [
      ['.env.example', fs.readFileSync(path.join(MYTHOS_ROOT, '.env.example'), 'utf8')],
      ['Dockerfile', dockerfile()],
      ['THIRD_PARTY_NOTICES.md', fs.readFileSync(path.join(MYTHOS_ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8')],
    ];
    for (const [name, content] of docs) {
      assert.ok(/never bundled/i.test(content), `${name} must state that edge-tts is never bundled (BYO)`);
    }
  });
});
