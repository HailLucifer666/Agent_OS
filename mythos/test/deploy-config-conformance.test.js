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
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('close', resolve));
      try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    }
  });
});
