'use strict';

// Phase 5 (P1) — MYTHOS_AUTH_TOKEN gate on /api + WS.
//
// The HTTP server had no auth — any client reaching /api/* could drive the
// entire leash-gated surface. For deployments exposed beyond loopback this is
// a security hole. Phase 5 adds an OPTIONAL bearer-token gate: when
// MYTHOS_AUTH_TOKEN is empty (default), the gate is DISABLED and local dev +
// loopback keep working. When set, every /api request must carry the token
// (via X-Auth-Token header or Authorization: Bearer).
//
// /health stays open regardless — Render/k8s readiness probes hit it without
// a token. WS uses ?token=<token> on the upgrade URL (browsers can't set
// custom headers on new WebSocket()).
//
// We exercise the gate by constructing a real Express app via the same
// middleware shape (no full createServer needed — the middleware is the unit).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

// Build a minimal app with the SAME auth middleware shape as server/index.js.
// config is read LIVE (D-46) so we pass it via closure.
function buildApp(config) {
  const app = express();
  app.use(express.json());

  // The auth gate (mirror of server/index.js)
  app.use('/api', (req, res, next) => {
    const expected = config.MYTHOS_AUTH_TOKEN;
    if (!expected) return next();
    const provided = req.headers['x-auth-token'] ||
                     (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (provided === expected) return next();
    return res.status(401).json({ error: 'Unauthorized' });
  });

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.get('/api/status', (req, res) => res.json({ status: 'ok' }));
  app.post('/api/echo', (req, res) => res.json({ got: req.body }));

  return app;
}

async function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

async function request(port, method, path, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const headers = opts.headers || {};
    if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const req = http.request({
      method, host: '127.0.0.1', port, path, headers,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(data); } catch (_) { body = data; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.end(opts.body ? JSON.stringify(opts.body) : '');
  });
}

describe('Phase 5 (P1) — MYTHOS_AUTH_TOKEN /api gate', function () {

  it('gate is DISABLED when MYTHOS_AUTH_TOKEN is empty (default)', async function () {
    const app = buildApp({ MYTHOS_AUTH_TOKEN: '' });
    const { server, port } = await startServer(app);
    try {
      const r = await request(port, 'GET', '/api/status');
      assert.equal(r.status, 200);
      assert.equal(r.body.status, 'ok');
    } finally { server.close(); }
  });

  it('gate is ENABLED when MYTHOS_AUTH_TOKEN is set — bare request rejected', async function () {
    const app = buildApp({ MYTHOS_AUTH_TOKEN: 'secret-token-123' });
    const { server, port } = await startServer(app);
    try {
      const r = await request(port, 'GET', '/api/status');
      assert.equal(r.status, 401);
      assert.equal(r.body.error, 'Unauthorized');
    } finally { server.close(); }
  });

  it('gate accepts X-Auth-Token header', async function () {
    const app = buildApp({ MYTHOS_AUTH_TOKEN: 'secret-token-123' });
    const { server, port } = await startServer(app);
    try {
      const r = await request(port, 'GET', '/api/status', {
        headers: { 'X-Auth-Token': 'secret-token-123' }
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.status, 'ok');
    } finally { server.close(); }
  });

  it('gate accepts Authorization: Bearer header', async function () {
    const app = buildApp({ MYTHOS_AUTH_TOKEN: 'secret-token-123' });
    const { server, port } = await startServer(app);
    try {
      const r = await request(port, 'GET', '/api/status', {
        headers: { 'Authorization': 'Bearer secret-token-123' }
      });
      assert.equal(r.status, 200);
    } finally { server.close(); }
  });

  it('gate rejects wrong token', async function () {
    const app = buildApp({ MYTHOS_AUTH_TOKEN: 'secret-token-123' });
    const { server, port } = await startServer(app);
    try {
      const r = await request(port, 'GET', '/api/status', {
        headers: { 'X-Auth-Token': 'wrong-token' }
      });
      assert.equal(r.status, 401);
    } finally { server.close(); }
  });

  it('gate handles Authorization without Bearer prefix gracefully', async function () {
    const app = buildApp({ MYTHOS_AUTH_TOKEN: 'secret-token-123' });
    const { server, port } = await startServer(app);
    try {
      // Authorization with the bare token (no "Bearer " prefix) — the regex
      // strip leaves it intact, so it matches. This is fine: the header still
      // carries the right secret. The gate cares about the value, not the form.
      const r = await request(port, 'GET', '/api/status', {
        headers: { 'Authorization': 'secret-token-123' }
      });
      assert.equal(r.status, 200, 'bare token in Authorization header still matches');
    } finally { server.close(); }
  });

  it('/health stays OPEN regardless of token (Render readiness probes)', async function () {
    const app = buildApp({ MYTHOS_AUTH_TOKEN: 'secret-token-123' });
    const { server, port } = await startServer(app);
    try {
      const r = await request(port, 'GET', '/health');
      assert.equal(r.status, 200, '/health must always return 200');
      assert.equal(r.body.ok, true);
    } finally { server.close(); }
  });

  it('gate applies to POST endpoints too (full /api coverage)', async function () {
    const app = buildApp({ MYTHOS_AUTH_TOKEN: 'secret-token-123' });
    const { server, port } = await startServer(app);
    try {
      const r1 = await request(port, 'POST', '/api/echo', { body: { x: 1 } });
      assert.equal(r1.status, 401);
      const r2 = await request(port, 'POST', '/api/echo', {
        body: { x: 1 }, headers: { 'X-Auth-Token': 'secret-token-123' }
      });
      assert.equal(r2.status, 200);
      assert.deepEqual(r2.body.got, { x: 1 });
    } finally { server.close(); }
  });

  it('token is read LIVE at request time (D-46) — config change reflects immediately', async function () {
    const config = { MYTHOS_AUTH_TOKEN: '' };
    const app = buildApp(config);
    const { server, port } = await startServer(app);
    try {
      // Initially disabled → request succeeds
      const r1 = await request(port, 'GET', '/api/status');
      assert.equal(r1.status, 200);
      // Flip the config live (no rebuild) → gate engages
      config.MYTHOS_AUTH_TOKEN = 'new-token';
      const r2 = await request(port, 'GET', '/api/status');
      assert.equal(r2.status, 401);
      const r3 = await request(port, 'GET', '/api/status', {
        headers: { 'X-Auth-Token': 'new-token' }
      });
      assert.equal(r3.status, 200);
    } finally { server.close(); }
  });

});

describe('Phase 5 (P1) — MYTHOS_AUTH_TOKEN schema key', function () {

  it('schema declares MYTHOS_AUTH_TOKEN with empty default', function () {
    const schema = require('../src/core/config/schema').SCHEMA;
    assert.ok(schema.MYTHOS_AUTH_TOKEN, 'key must exist');
    assert.equal(schema.MYTHOS_AUTH_TOKEN.type, 'string');
    assert.equal(schema.MYTHOS_AUTH_TOKEN.default, '');
  });

});
