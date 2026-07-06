// edge-tts.test.js — hermetic tests for the edge-tts provider.
// The provider talks to a local Python service over HTTP; we must NOT depend on
// the real service running. Mock global.fetch for every test.
//
// edge-tts.js caches its health-check result for 10s, and there's no exported
// cache-clear function. The cleanest way to get a fresh cache per test is to
// delete the module from the require cache and re-require it.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.EDGE_TTS_URL || 'http://127.0.0.1:5050';

// Re-require the provider so each test starts with an empty health cache.
function freshProvider() {
  delete require.cache[require.resolve('./providers/edge-tts')];
  return require('./providers/edge-tts');
}

describe('edge-tts provider', () => {
  let originalFetch;
  let mockResponses = {}; // url -> {status, body, json}
  let fetchCalls = [];    // record of {url, opts} for assertion

  beforeEach(() => {
    originalFetch = global.fetch;
    mockResponses = {};
    fetchCalls = [];
    global.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts });
      const mock = mockResponses[url] || { status: 404, body: 'not found' };
      return {
        ok: mock.status >= 200 && mock.status < 300,
        status: mock.status,
        statusText: 'Mock',
        json: async () => mock.json || {},
        arrayBuffer: async () => mock.body || new ArrayBuffer(0),
      };
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('name is "edge-tts"', () => {
    const p = freshProvider();
    assert.equal(p.name, 'edge-tts');
  });

  test('isAvailable() returns true when /health returns {ok:true, voices:322}', async () => {
    mockResponses[`${BASE}/health`] = { status: 200, json: { ok: true, voices: 322 } };
    const p = freshProvider();
    const ok = await p.isAvailable();
    assert.equal(ok, true);
  });

  test('isAvailable() returns false when fetch throws / network error', async () => {
    global.fetch = async () => { throw new Error('network down'); };
    const p = freshProvider();
    const ok = await p.isAvailable();
    assert.equal(ok, false);
  });

  test('isAvailable() returns false when /health returns non-200', async () => {
    mockResponses[`${BASE}/health`] = { status: 503, json: {} };
    const p = freshProvider();
    const ok = await p.isAvailable();
    assert.equal(ok, false);
  });

  test('getStatus() returns {ok:true, voices:322} when healthy', async () => {
    mockResponses[`${BASE}/health`] = { status: 200, json: { ok: true, voices: 322 } };
    const p = freshProvider();
    const s = await p.getStatus();
    assert.deepEqual(s, { ok: true, voices: 322 });
  });

  test('synthesize({text, voice}) returns an MP3 Buffer and posts text + voice', async () => {
    // A fake MP3 frame: 0xFF 0xFB then 10 more bytes.
    const mp3 = Buffer.from([0xFF, 0xFB, 0x90, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    mockResponses[`${BASE}/v1/audio/speech`] = {
      status: 200,
      body: mp3.buffer.slice(mp3.byteOffset, mp3.byteOffset + mp3.byteLength),
    };
    const p = freshProvider();
    const buf = await p.synthesize({ text: 'hello', voice: 'en-US-AriaNeural' });

    assert.ok(Buffer.isBuffer(buf), 'synthesize should resolve to a Buffer');
    assert.ok(buf.length > 0, 'buffer should be non-empty');
    assert.equal(buf[0], 0xFF, 'MP3 buffer should start with 0xFF');

    // Verify a POST was made to the speech endpoint with text + voice in the body.
    const speechCall = fetchCalls.find((c) => c.url === `${BASE}/v1/audio/speech`);
    assert.ok(speechCall, 'expected a fetch to /v1/audio/speech');
    assert.equal(speechCall.opts.method, 'POST');
    const body = JSON.parse(speechCall.opts.body);
    assert.equal(body.input, 'hello');
    assert.equal(body.voice, 'en-US-AriaNeural');
  });

  test('synthesize({text:""}) throws "text required" WITHOUT calling fetch', async () => {
    const p = freshProvider();
    await assert.rejects(
      () => p.synthesize({ text: '' }),
      /text required/i,
    );
    // No HTTP should have been made — the validation guard runs first.
    assert.equal(fetchCalls.length, 0, 'fetch must not be called when text is empty');
  });

  test('listVoices() returns the voices array, first id matches', async () => {
    mockResponses[`${BASE}/v1/voices`] = {
      status: 200,
      json: { voices: [{ id: 'en-US-AriaNeural', name: 'Aria' }, { id: 'en-US-GuyNeural', name: 'Guy' }] },
    };
    const p = freshProvider();
    const voices = await p.listVoices();
    assert.ok(Array.isArray(voices));
    assert.equal(voices.length, 2);
    assert.equal(voices[0].id, 'en-US-AriaNeural');
  });
});
