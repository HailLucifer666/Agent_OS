'use strict';

// tts-voices-route.test.js — GET /api/tts/voices and POST /api/tts/voice.
//
// The picker's whole promise is "hear it, pick it, and the next reply speaks in
// it". These pin the halves of that a test can hold:
//   * the listing tells the truth about an engine that is missing or throwing,
//     instead of hiding it — an operator needs to see that piper exists and is
//     not installed, not have it silently absent
//   * a chosen voice is PERSISTED before it is applied, so a failed hot-swap
//     still survives a restart
//   * the rebuilt chain leads with the chosen engine and keeps the rest as
//     failover (providers/tts.js is sticky; a one-engine chain would strand the
//     entity mute when that engine has a bad minute)
//
// Run: cd mythos && node --test test/tts-voices-route.test.js

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { mountTtsVoiceRoutes } = require('../server/routes/tts-voices');
const { readVoiceChoice } = require('../src/core/config/voice-choice-store');

let vault;
beforeEach(() => { vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-voice-route-')); });
afterEach(() => { fs.rmSync(vault, { recursive: true, force: true }); });

function fakeProvider(name, opts = {}) {
  return {
    name,
    mime: opts.mime || 'audio/wav',
    async isAvailable() { if (opts.probeThrows) throw new Error('probe blew up'); return opts.available !== false; },
    async listVoices() { if (opts.listThrows) throw new Error('sidecar down'); return opts.voices || []; },
    async synthesize() { return Buffer.from('audio'); },
  };
}

async function serve(overrides = {}) {
  const app = express();
  app.use(express.json());
  const swapped = [];
  const deps = Object.assign({
    config: { MYTHOS_VAULT_ROOT: vault, VOICE_TTS_CHAIN: 'gemini,edge,kokoro,piper', GEMINI_LIVE_VOICE: 'Aoede' },
    logger: { info() {}, warn() {} },
    vaultRoot: vault,
    getTts: () => ({ name: 'gemini-tts', chainNames: ['gemini-tts', 'edge-tts'] }),
    setTts: (next) => swapped.push(next),
    listEngines: async () => ([
      { provider: 'gemini-tts', short: 'gemini', available: true, voices: [{ id: 'Aoede', label: 'Aoede' }] },
      { provider: 'piper-tts', short: 'piper', available: false, voices: [] },
    ]),
    providerByShortName: (short) => ({
      gemini: fakeProvider('gemini-tts', { voices: ['Aoede', 'Kore'] }),
      piper: fakeProvider('piper-tts', { listThrows: true }),
    }[short] || null),
  }, overrides);
  mountTtsVoiceRoutes(app, deps);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    swapped,
    close: () => new Promise((done) => server.close(done)),
  };
}

async function call(port, method, url, body) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* not json */ }
  return { status: res.status, body: parsed };
}

describe('GET /api/tts/voices', () => {
  it('lists every engine, including the ones this machine does not have', async () => {
    const s = await serve();
    try {
      const { status, body } = await call(s.port, 'GET', '/api/tts/voices');
      assert.equal(status, 200);
      assert.equal(body.engines.length, 2);
      const piper = body.engines.find((e) => e.short === 'piper');
      assert.equal(piper.available, false, 'a missing engine must be shown as missing, not omitted');
      assert.deepEqual(body.default, { provider: 'gemini-tts', voice: 'Aoede' });
    } finally { await s.close(); }
  });

  it('answers 500 rather than an empty list when the listing itself fails', async () => {
    const s = await serve({ listEngines: async () => { throw new Error('registry exploded'); } });
    try {
      const { status, body } = await call(s.port, 'GET', '/api/tts/voices');
      assert.equal(status, 500);
      assert.match(body.error, /registry exploded/);
    } finally { await s.close(); }
  });
});

describe('POST /api/tts/voice', () => {
  it('persists the choice and installs a chain that leads with it', async () => {
    const s = await serve();
    try {
      const { status, body } = await call(s.port, 'POST', '/api/tts/voice', { provider: 'gemini-tts', voice: 'Kore' });
      assert.equal(status, 200);
      assert.equal(body.applied, true);
      assert.equal(body.voiceKey, 'GEMINI_LIVE_VOICE');
      assert.equal(readVoiceChoice(vault).voice, 'Kore', 'the file must be written before the swap');
      assert.equal(s.swapped.length, 1);
      assert.equal(s.swapped[0].chainNames[0], 'gemini-tts');
      assert.ok(s.swapped[0].chainNames.length > 1, 'the rest of the chain must stay as failover');
    } finally { await s.close(); }
  });

  it('rejects an unknown provider and an empty or oversized voice', async () => {
    const s = await serve();
    try {
      assert.equal((await call(s.port, 'POST', '/api/tts/voice', { provider: 'espeak', voice: 'x' })).status, 400);
      assert.equal((await call(s.port, 'POST', '/api/tts/voice', { provider: 'gemini-tts', voice: '  ' })).status, 400);
      assert.equal((await call(s.port, 'POST', '/api/tts/voice', { provider: 'gemini-tts', voice: 'a'.repeat(201) })).status, 400);
      assert.equal(readVoiceChoice(vault), null, 'a rejected request must not write anything');
    } finally { await s.close(); }
  });

  it('rejects a voice the engine says it does not have', async () => {
    const s = await serve();
    try {
      const { status, body } = await call(s.port, 'POST', '/api/tts/voice', { provider: 'gemini-tts', voice: 'Brian' });
      assert.equal(status, 400);
      assert.deepEqual(body.voices, ['Aoede', 'Kore']);
    } finally { await s.close(); }
  });

  it('still stores the choice when the engine cannot be asked', async () => {
    // A down piper sidecar must not veto a valid piper voice — the chain fails
    // over honestly at use; it does not pre-emptively forbid.
    const s = await serve();
    try {
      const { status } = await call(s.port, 'POST', '/api/tts/voice', { provider: 'piper-tts', voice: 'en_US-amy-medium' });
      assert.equal(status, 200);
      assert.equal(readVoiceChoice(vault).provider, 'piper-tts');
    } finally { await s.close(); }
  });

  it('reports a save that could not happen instead of claiming success', async () => {
    const s = await serve({ vaultRoot: path.join(vault, 'plainfile') });
    fs.writeFileSync(path.join(vault, 'plainfile'), 'x', 'utf8');
    try {
      const { status, body } = await call(s.port, 'POST', '/api/tts/voice', { provider: 'gemini-tts', voice: 'Kore' });
      assert.equal(status, 500);
      assert.match(body.error, /Could not save/);
      assert.equal(s.swapped.length, 0, 'nothing may be applied when nothing was stored');
    } finally { await s.close(); }
  });
});

// With Live duplex now the default whenever a Google key exists (see
// src/core/config/voice-defaults.js), a picked Gemini voice has to reach the
// Live session too — live-session.js reads GEMINI_LIVE_VOICE once, when the
// session is built, so the server closes any open session and lets the next
// turn reopen it. Without this the picker changes the batch voice while the
// operator, who is on Live, keeps hearing the old one.
describe('a Gemini voice also switches the Live session', () => {
  it('closes open Live sessions so the next turn reopens speaking as the new voice', async () => {
    const swapped = [];
    const s = await serve({ setLiveVoice: (v) => { swapped.push(v); return 2; } });
    try {
      const { status, body } = await call(s.port, 'POST', '/api/tts/voice', { provider: 'gemini-tts', voice: 'Kore' });
      assert.equal(status, 200);
      assert.deepEqual(swapped, ['Kore']);
      assert.equal(body.liveSessionsClosed, 2);
    } finally { await s.close(); }
  });

  it('leaves Live alone for a non-Gemini engine — it has no say in that voice', async () => {
    const swapped = [];
    const s = await serve({ setLiveVoice: (v) => { swapped.push(v); return 1; } });
    try {
      await call(s.port, 'POST', '/api/tts/voice', { provider: 'piper-tts', voice: 'en_US-amy-medium' });
      assert.deepEqual(swapped, []);
    } finally { await s.close(); }
  });
});

// Wave 6 (2026-08-13) — "switch back to the previous live voice". The route's
// own job is small: call deps.revertLiveVoice() and report what it did, or
// say honestly that there was nothing to revert.
describe('POST /api/tts/voice/revert', () => {
  it('reports the reverted-to voice on a successful revert', async () => {
    const s = await serve({ revertLiveVoice: () => 'Aoede' });
    try {
      const { status, body } = await call(s.port, 'POST', '/api/tts/voice/revert', {});
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.voice, 'Aoede');
      assert.equal(body.revertedTo, 'Aoede');
    } finally { await s.close(); }
  });

  it('reports reverting to the config default distinctly, when the recorded history IS "no override"', async () => {
    const s = await serve({ revertLiveVoice: () => null });
    try {
      const { status, body } = await call(s.port, 'POST', '/api/tts/voice/revert', {});
      assert.equal(status, 200);
      assert.equal(body.voice, null);
      assert.equal(body.revertedTo, 'config default');
    } finally { await s.close(); }
  });

  it('answers 409 honestly when there is nothing to revert (deps.revertLiveVoice returns undefined)', async () => {
    const s = await serve({ revertLiveVoice: () => undefined });
    try {
      const { status, body } = await call(s.port, 'POST', '/api/tts/voice/revert', {});
      assert.equal(status, 409);
      assert.match(body.error, /nothing has been switched/i);
    } finally { await s.close(); }
  });

  it('answers 501 when the server was built without a revertLiveVoice at all (older wiring)', async () => {
    const s = await serve({ revertLiveVoice: undefined });
    try {
      const { status } = await call(s.port, 'POST', '/api/tts/voice/revert', {});
      assert.equal(status, 501);
    } finally { await s.close(); }
  });
});
