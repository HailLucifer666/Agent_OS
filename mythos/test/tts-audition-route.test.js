'use strict';

// tts-audition-route.test.js — POST /api/tts/audition.
//
// THE PROPERTY THIS FILE EXISTS FOR: pressing play on a sample must not decide
// which engine the entity speaks with. providers/tts.js resolves its chain ONCE
// and STICKS to the winner — that is the fix for the entity changing voice
// mid-session — so a preview routed through a chain would silently pin a
// provider as a side effect of curiosity. The route therefore calls the provider
// module directly, and the test below asserts the session chain is never even
// consulted: zero getTts/setTts calls, for a success AND for a failure.
//
// The rest is bounding a metered call: Gemini TTS is ~3.9s/sentence and billed,
// so a sample stays one sentence.
//
// Run: cd mythos && node --test test/tts-audition-route.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

const { mountTtsVoiceRoutes, MAX_AUDITION_CHARS, DEFAULT_SAMPLE } = require('../server/routes/tts-voices');

function fakeProvider(name, opts = {}) {
  const p = {
    name,
    mime: opts.mime || 'audio/wav',
    calls: [],
    async isAvailable() { return opts.available !== false; },
    async listVoices() { return opts.voices || []; },
    async synthesize(args) {
      p.calls.push(args);
      if (opts.synthThrows) throw new Error('engine said no');
      return opts.empty ? Buffer.alloc(0) : Buffer.from('sample-audio');
    },
  };
  return p;
}

async function serve(providers, counters) {
  const app = express();
  app.use(express.json());
  mountTtsVoiceRoutes(app, {
    config: { MYTHOS_VAULT_ROOT: '', VOICE_TTS_CHAIN: 'gemini' },
    logger: { info() {}, warn() {} },
    vaultRoot: '',
    getTts: () => { counters.get++; return { name: 'gemini-tts', chainNames: ['gemini-tts'] }; },
    setTts: () => { counters.set++; },
    listEngines: async () => [],
    providerByShortName: (short) => providers[short] || null,
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((d) => server.close(d)) };
}

async function audition(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/tts/audition`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* not json */ }
  return { status: res.status, body: parsed };
}

describe('POST /api/tts/audition', () => {
  it('synthesizes with the requested voice and never touches the session chain', async () => {
    const gemini = fakeProvider('gemini-tts');
    const counters = { get: 0, set: 0 };
    const s = await serve({ gemini }, counters);
    try {
      const { status, body } = await audition(s.port, { provider: 'gemini-tts', voice: 'Kore', text: 'Hello there.' });
      assert.equal(status, 200);
      assert.equal(body.mime, 'audio/wav');
      assert.equal(Buffer.from(body.audioB64, 'base64').toString(), 'sample-audio');
      assert.equal(gemini.calls[0].voice, 'Kore', 'the auditioned voice must be the one asked for');
      assert.equal(gemini.calls[0].text, 'Hello there.');
      assert.ok(gemini.calls[0].signal, 'a metered call must be cancellable');
      assert.equal(counters.get + counters.set, 0, 'auditioning must not read or replace the session chain');
    } finally { await s.close(); }
  });

  it('falls back to a fixed sample sentence when no text is given', async () => {
    const gemini = fakeProvider('gemini-tts');
    const counters = { get: 0, set: 0 };
    const s = await serve({ gemini }, counters);
    try {
      await audition(s.port, { provider: 'gemini-tts', voice: 'Aoede' });
      assert.equal(gemini.calls[0].text, DEFAULT_SAMPLE);
    } finally { await s.close(); }
  });

  it('refuses a paragraph — a sample is one sentence, and Gemini is metered', async () => {
    const gemini = fakeProvider('gemini-tts');
    const counters = { get: 0, set: 0 };
    const s = await serve({ gemini }, counters);
    try {
      const { status } = await audition(s.port, { provider: 'gemini-tts', voice: 'Aoede', text: 'a'.repeat(MAX_AUDITION_CHARS + 1) });
      assert.equal(status, 400);
      assert.equal(gemini.calls.length, 0, 'an over-long sample must never reach a billed engine');
    } finally { await s.close(); }
  });

  it('answers 503 for an engine this machine does not have, without calling it', async () => {
    const piper = fakeProvider('piper-tts', { available: false });
    const counters = { get: 0, set: 0 };
    const s = await serve({ piper }, counters);
    try {
      const { status, body } = await audition(s.port, { provider: 'piper-tts', voice: 'en_US-amy-medium' });
      assert.equal(status, 503);
      assert.match(body.error, /not available/);
      assert.equal(piper.calls.length, 0);
    } finally { await s.close(); }
  });

  it('reports an engine failure as 502 and still leaves the chain alone', async () => {
    const gemini = fakeProvider('gemini-tts', { synthThrows: true });
    const counters = { get: 0, set: 0 };
    const s = await serve({ gemini }, counters);
    try {
      const { status, body } = await audition(s.port, { provider: 'gemini-tts', voice: 'Kore' });
      assert.equal(status, 502);
      assert.match(body.error, /engine said no/);
      assert.equal(counters.get + counters.set, 0);
    } finally { await s.close(); }
  });

  it('treats empty audio as a failure rather than shipping silence', async () => {
    const gemini = fakeProvider('gemini-tts', { empty: true });
    const counters = { get: 0, set: 0 };
    const s = await serve({ gemini }, counters);
    try {
      const { status } = await audition(s.port, { provider: 'gemini-tts', voice: 'Kore' });
      assert.equal(status, 502);
    } finally { await s.close(); }
  });

  it('rejects an unknown provider before any work happens', async () => {
    const counters = { get: 0, set: 0 };
    const s = await serve({}, counters);
    try {
      assert.equal((await audition(s.port, { provider: 'espeak', voice: 'x' })).status, 400);
      assert.equal((await audition(s.port, { provider: 'gemini-tts', voice: '' })).status, 400);
    } finally { await s.close(); }
  });
});
