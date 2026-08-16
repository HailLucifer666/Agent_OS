'use strict';

// static-asset-perf.test.js — guards the static-delivery policy that made the
// HUD slow to load.
//
// MEASURED 2026-07-31, before the fix. Every static mount was
// { etag: false, maxAge: 0, lastModified: false } with no compression anywhere,
// so a browser re-fetched every byte, uncompressed, on every single load:
//   node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm  13.5 MB
//   node_modules/onnxruntime-web/dist/ort.all.mjs                   5.9 MB
//   ui/public/models/wakeword/*.onnx                                3.6 MB
//   ui/public/js + ui/public/css                                  489 KB
// After: ort.all.mjs ships as 1.15 MB gzipped and is immutable-cached, app.js is
// 25 KB -> 8.8 KB, and a reload revalidates to a 304 instead of re-sending.
//
// Two properties are load-bearing and easy to break later, which is why they are
// asserted rather than left to a comment:
//   1. App source must NEVER be cached beyond revalidation. A long max-age on
//      ui/public/js would show the operator a stale HUD after an edit — worse
//      than the slowness this fix targets.
//   2. The compression path must not corrupt the 304 path or touch /api. The
//      FIRST implementation of this fix wrapped res.write/res.end around a zlib
//      stream ahead of express.static and HUNG every request, because static had
//      already set Content-Length to the raw size and the browser waited forever
//      for bytes the shorter gzipped body never sent. Precompressing with an
//      explicit Content-Length is what replaced it.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const { createServer } = require('../server');
const { createBus } = require('../src/core/bus');

// createServer() opens its OWN listening socket and owns it (see the comment at
// server/index.js:802). An earlier revision of this file wrapped server.app in a
// SECOND http.createServer and only closed that one, so the internal socket kept
// the event loop alive and `node --test` never exited. Use server.httpServer +
// server.stop(), the same lifecycle test/server-auth.test.js uses.
function deps(bus) {
  return {
    bus: bus,
    config: {
      MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
      MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '',
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    memory: {
      working: { tick: 0, activeGoalId: null },
      episodic: { write: async () => {} },
      fs: { vaultPath: (...s) => path.join(__dirname, '..', '.test-vault-staticperf', ...s) },
    },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
    leash: { confirm: { create: () => 'cf-1', accept: () => null, reject: () => true } },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({ ok: true }) },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
  };
}

function get(port, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: port, path: p, method: 'GET', headers: headers || {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, bytes: buf.length, buf: buf });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('static asset delivery — compression + caching policy', () => {
  let server, port;

  before(async () => {
    server = createServer(deps(createBus({ historySize: 20 })));
    await server.ready;
    port = server.httpServer.address().port;
  });

  after(async () => {
    if (server) await server.stop();
  });

  it('app JS is gzipped for a gzip-capable client, and materially smaller', async () => {
    const gz = await get(port, '/js/app.js', { 'accept-encoding': 'gzip' });
    const raw = await get(port, '/js/app.js', {});
    assert.equal(gz.status, 200);
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.ok(gz.bytes < raw.bytes * 0.6, `gzip ${gz.bytes} must be well under raw ${raw.bytes}`);
    assert.match(String(gz.headers.vary || ''), /accept-encoding/i, 'must Vary on Accept-Encoding');
  });

  it('a client that does not accept gzip still gets an identity response', async () => {
    const raw = await get(port, '/js/app.js', {});
    assert.equal(raw.status, 200);
    assert.ok(!raw.headers['content-encoding'], 'must not force gzip on a client that did not ask');
    assert.ok(raw.bytes > 0);
  });

  // Property 1: the anti-staleness guarantee.
  it('app source is NEVER cached beyond revalidation', async () => {
    for (const p of ['/js/app.js', '/css/hud.css', '/index.html']) {
      const res = await get(port, p, {});
      if (res.status !== 200) continue;
      const cc = String(res.headers['cache-control'] || '');
      assert.ok(/no-cache/.test(cc), p + ' must be no-cache, got: ' + cc);
      assert.ok(!/max-age=[1-9]/.test(cc), p + ' must not carry a positive max-age, got: ' + cc);
      assert.ok(res.headers.etag, p + ' must send an ETag so a reload can 304');
    }
  });

  // Property 2: the 304 path must survive compression.
  it('a matching ETag yields a 304 with an empty body, on the gzip path', async () => {
    const first = await get(port, '/js/app.js', { 'accept-encoding': 'gzip' });
    assert.equal(first.headers['content-encoding'], 'gzip');
    const again = await get(port, '/js/app.js', { 'accept-encoding': 'gzip', 'if-none-match': first.headers.etag });
    assert.equal(again.status, 304, 'an unchanged file must revalidate to 304');
    assert.equal(again.bytes, 0, 'a 304 must carry no body');
  });

  it('version-pinned vendor runtime is immutable-cached AND compressed', async () => {
    const res = await get(port, '/vendor/onnxruntime/ort.all.mjs', { 'accept-encoding': 'gzip' });
    assert.equal(res.status, 200);
    assert.match(String(res.headers['cache-control'] || ''), /immutable/,
      'the heaviest asset the HUD loads must be cacheable across reloads');
    assert.equal(res.headers['content-encoding'], 'gzip', '5.9MB of plain JS must not ship raw');
  });

  it('wake-word ONNX models are immutable-cached', async () => {
    const res = await get(port, '/models/wakeword/melspectrogram.onnx', {});
    // Absent weights don't 404 — the SPA index.html fallback answers them with
    // a 200 (the same fallback the path-escape test below documents). The old
    // status-only guard passed that 200 straight into the assert, so this
    // "self-silencing on clones without models" test actually FAILED on CI
    // (2026-08-16, named by the annotation channel) while passing on any
    // machine that had fetched the weights. Recognize the fallback by its
    // content-type and stand down; machines with real weights still assert.
    if (res.status !== 200) return;
    if (/html/i.test(String(res.headers['content-type'] || ''))) return; // SPA fallback, not a model
    assert.match(String(res.headers['cache-control'] || ''), /immutable/,
      'version-pinned model binaries must not be re-downloaded every load');
  });

  it('the API is untouched by the static compression middleware', async () => {
    const res = await get(port, '/health', { 'accept-encoding': 'gzip' });
    assert.equal(res.status, 200);
    assert.ok(!res.headers['content-encoding'],
      'the static gzip handler must never intercept an API response');
  });

  it('a path-escape attempt through the gzip handler leaks nothing outside the served roots', async () => {
    // The handler reads files itself, so it carries its own escape guard rather
    // than relying on express.static's. NOTE: a 200 here is expected and correct —
    // it is the SPA index.html fallback, not the traversal target. Asserting on
    // status alone was a FALSE alarm; assert on the bytes actually returned.
    const marker = require('../package.json').name;
    for (const p of ['/../package.json', '/js/../../package.json', '/%2e%2e/package.json',
                     '/../../CLAUDE.md', '/..%2fpackage.json']) {
      const res = await get(port, p, { 'accept-encoding': 'gzip' });
      const body = res.buf.toString('utf8');
      assert.ok(!body.includes(marker), p + ' leaked package.json ("' + marker + '" in body)');
      assert.ok(!body.includes('Anti-Drift Contract'), p + ' leaked a repo-root doc');
      if (res.status === 200) {
        assert.match(body, /^<!DOCTYPE html>/i, p + ' returned 200 with something other than the SPA shell');
      }
    }
  });
});
