'use strict';

// server/routes/setup.js — GET /api/setup/status.
//
// This route exists to hand the renderer a list of what this machine is missing,
// which means it is a deliberate new path from process.env to the browser. The
// tests that matter are therefore the ones that pin what may NOT travel it:
// no key values, and nothing beyond an explicit projection of doctor's report.
//
// Run: cd mythos && node --test test/setup-route.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const { mountSetupRoutes } = require('../server/routes/setup');

function serve(deps) {
  const app = express();
  mountSetupRoutes(app, deps);
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

async function get(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}

const reportWith = (overrides) => Object.assign({
  keys: [
    { id: 'brain', label: 'Brain (any LLM lane)', required: true, ok: false, detail: 'none of: GOOGLE_API_KEY, GROQ_API_KEY', why: 'w', fix: 'f' },
    { id: 'stt', label: 'STT', required: false, ok: true, detail: 'configured: GROQ_API_KEY', why: 'w', fix: 'f' },
  ],
  assets: [
    { id: 'adb', label: 'adb', required: false, ok: false, detail: 'some/path/adb.exe', why: 'w', fix: 'f' },
  ],
  keyStore: { file: 'some/keys.json', names: ['GOOGLE_API_KEY'] },
  settings: { VOICE_TTS_PROVIDER: 'gemini' },
  gaps: [],
  requiredGaps: [{ id: 'brain', required: true }],
}, overrides || {});

describe('GET /api/setup/status', () => {
  it('reports the gaps, and needsSetup tracks the REQUIRED ones', async () => {
    const s = await serve({ buildReport: () => reportWith() });
    try {
      const res = await get(s.port, '/api/setup/status');
      assert.equal(res.status, 200);
      assert.equal(res.body.needsSetup, true);
      assert.equal(res.body.keys.length, 2);
      assert.equal(res.body.assets.length, 1);
      assert.deepEqual(res.body.keyStoreNames, ['GOOGLE_API_KEY']);
    } finally { await s.close(); }
  });

  it('needsSetup is false when only optional gaps remain', async () => {
    const s = await serve({ buildReport: () => reportWith({ requiredGaps: [] }) });
    try {
      const res = await get(s.port, '/api/setup/status');
      assert.equal(res.body.needsSetup, false);
    } finally { await s.close(); }
  });

  it('never leaks a key VALUE, even when the report grows a field carrying one', async () => {
    // The failure this guards is not today's code — it is a future edit adding a
    // field to doctor's report and this route passing `report` straight through.
    const canary = 'CANARY-SECRET-VALUE-a1b2c3';
    const s = await serve({
      buildReport: () => reportWith({
        // Two shapes of accident: a whole new top-level field, and a value
        // smuggled into an existing row.
        secrets: { GOOGLE_API_KEY: canary },
        settings: { GOOGLE_API_KEY: canary },
      }),
    });
    try {
      const res = await get(s.port, '/api/setup/status');
      assert.equal(res.status, 200);
      assert.doesNotMatch(JSON.stringify(res.body), new RegExp(canary),
        'the response is an explicit projection for exactly this reason — a pass-through would ship the key');
      assert.equal(Object.prototype.hasOwnProperty.call(res.body, 'secrets'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(res.body, 'settings'), false,
        'settings are for doctor --export on the operator\'s own terminal, not for the renderer');
    } finally { await s.close(); }
  });

  it('a report that throws is a 500, not a cheerful "no gaps"', async () => {
    const s = await serve({ buildReport: () => { throw new Error('disk on fire'); } });
    try {
      const res = await get(s.port, '/api/setup/status');
      assert.equal(res.status, 500);
      assert.match(res.body.error, /disk on fire/);
      // The client treats a non-200 as indeterminate and paints nothing, which
      // is the honest outcome: we do not know what is missing.
    } finally { await s.close(); }
  });

  it('projects exactly the documented fields per row — no more', async () => {
    const s = await serve({ buildReport: () => reportWith() });
    try {
      const res = await get(s.port, '/api/setup/status');
      const row = res.body.keys[0];
      assert.deepEqual(Object.keys(row).sort(), ['detail', 'fix', 'id', 'label', 'ok', 'required', 'why']);
    } finally { await s.close(); }
  });

  it('production wiring resolves the real doctor report when no seam is injected', async () => {
    // Guards the seam from becoming the only path that works — the same failure
    // shape as the wakeword models-dir seam, where an injectable path silently
    // broke the feature it was added to protect.
    const s = await serve({});
    try {
      const res = await get(s.port, '/api/setup/status');
      assert.equal(res.status, 200);
      assert.equal(Array.isArray(res.body.keys), true);
      assert.equal(Array.isArray(res.body.assets), true);
      assert.equal(typeof res.body.needsSetup, 'boolean');
    } finally { await s.close(); }
  });
});
