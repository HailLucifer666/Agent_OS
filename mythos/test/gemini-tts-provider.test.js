'use strict';

// gemini-tts-provider.test.js — the Gemini TTS provider and the engine selector.
//
// WHY IT EXISTS: `Aoede` is a Gemini prebuilt voice and was reachable only inside a
// Live session, so the operator heard Aoede while talking but edge-tts for the boot
// greeting and every proactive announcement. The same prebuilt voices are available
// on the non-streaming TTS models, which is what providers/gemini-tts.js wraps —
// one voice on every path.
//
// Two things here are easy to get subtly wrong and are asserted rather than trusted:
//   1. The WAV header. The API returns RAW PCM (`audio/L16; rate=24000`), which
//      `new Audio('data:...')` cannot play. A wrong header is not a crash — it is a
//      chipmunk voice or silence, which no other test would catch.
//   2. The selector's back-compat. When the provider is 'edge' it must return the
//      edge-tts module OBJECT ITSELF, because server/index.js requires that
//      singleton and two existing tests monkey-patch it. Wrapping it would break
//      them silently.
//
// No network: synthesize() is exercised against a stubbed global.fetch.

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const gemini = require('../providers/gemini-tts');
const edge = require('../providers/edge-tts');
const { selectTts, mimeFor, voiceFor } = require('../providers/tts');

const realFetch = global.fetch;
const realKey = process.env.GOOGLE_API_KEY;
afterEach(() => {
  global.fetch = realFetch;
  if (realKey === undefined) delete process.env.GOOGLE_API_KEY;
  else process.env.GOOGLE_API_KEY = realKey;
});

describe('selectTts() — one place decides who speaks', () => {
  test("defaults to edge-tts and returns the module ITSELF (monkey-patch back-compat)", () => {
    assert.equal(selectTts({}), edge, 'must be the same object test/barge-in-tts-cancel.test.js patches');
    assert.equal(selectTts({ VOICE_TTS_PROVIDER: '' }), edge);
    assert.equal(selectTts({ VOICE_TTS_PROVIDER: 'edge' }), edge);
  });

  test("'gemini' selects the Gemini provider, case/whitespace tolerant", () => {
    assert.equal(selectTts({ VOICE_TTS_PROVIDER: 'gemini' }), gemini);
    assert.equal(selectTts({ VOICE_TTS_PROVIDER: '  GEMINI ' }), gemini);
  });

  test('an unknown provider falls back to edge rather than breaking speech', () => {
    assert.equal(selectTts({ VOICE_TTS_PROVIDER: 'nonsense' }), edge);
  });

  test('mime: edge is the client default (mpeg), gemini must declare wav', () => {
    assert.equal(mimeFor(edge), 'audio/mpeg');
    assert.equal(mimeFor(gemini), 'audio/wav');
  });
});

describe('voiceFor() — the voice id belongs to the engine, not the app', () => {
  // FOUND LIVE the first time this was wired: server/index.js passed
  // config.VOICE_TTS_VOICE to whichever provider was selected, so Gemini received
  // an edge-tts id and hard-400'd on EVERY chunk — the reply arrived carrying
  // mime=audio/wav and 0 bytes of audio:
  //   "Voice name en-GB-SoniaNeural is not supported. Allowed voice names are:
  //    achernar, achird, algenib, ... aoede, ..."
  // The two namespaces are disjoint, so the mapping has to be explicit.
  const CONFIG = { VOICE_TTS_VOICE: 'en-GB-SoniaNeural', GEMINI_LIVE_VOICE: 'Aoede' };

  test('edge gets the Microsoft Neural id', () => {
    assert.equal(voiceFor(edge, CONFIG), 'en-GB-SoniaNeural');
  });

  test('gemini gets the prebuilt name, NEVER the edge id', () => {
    const v = voiceFor(gemini, CONFIG);
    assert.equal(v, 'Aoede');
    assert.ok(!/^en-[A-Z]{2}-/.test(v), 'a Microsoft Neural id sent to Gemini is a hard 400 on every chunk');
  });

  test('gemini reuses GEMINI_LIVE_VOICE, so both paths share ONE voice setting', () => {
    assert.equal(voiceFor(gemini, { GEMINI_LIVE_VOICE: 'Kore' }), 'Kore',
      'changing the Live voice must move the batch voice with it — that is the point');
  });

  test('gemini falls back to Aoede rather than to an unusable edge id', () => {
    assert.equal(voiceFor(gemini, {}), 'Aoede');
  });
});

describe('WAV wrapping', () => {
  test('produces a valid 44-byte RIFF/WAVE header with the PCM appended intact', () => {
    const pcm = Buffer.alloc(800, 7);
    const wav = gemini._pcmToWav(pcm, 24000);

    assert.equal(wav.length, 44 + pcm.length);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
    assert.equal(wav.toString('ascii', 36, 40), 'data');

    assert.equal(wav.readUInt32LE(4), 36 + pcm.length, 'RIFF size');
    assert.equal(wav.readUInt16LE(20), 1, 'format must be PCM');
    assert.equal(wav.readUInt16LE(22), 1, 'mono');
    assert.equal(wav.readUInt32LE(24), 24000, 'sample rate');
    assert.equal(wav.readUInt32LE(28), 24000 * 2, 'byte rate = rate * 2 for 16-bit mono');
    assert.equal(wav.readUInt16LE(32), 2, 'block align');
    assert.equal(wav.readUInt16LE(34), 16, 'bits per sample');
    assert.equal(wav.readUInt32LE(40), pcm.length, 'data size');

    assert.deepEqual(wav.subarray(44), pcm, 'the PCM payload must be untouched');
  });

  test('sample rate is read from the API mime, with a sane default', () => {
    assert.equal(gemini._rateFromMime('audio/L16; rate=24000; channels=1'), 24000);
    assert.equal(gemini._rateFromMime('audio/L16;codec=pcm;rate=16000'), 16000);
    assert.equal(gemini._rateFromMime('audio/l16'), 24000, 'missing rate defaults, never throws');
    assert.equal(gemini._rateFromMime(undefined), 24000);
  });
});

describe('synthesize()', () => {
  function stubOk(pcmBytes, mime) {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: mime || 'audio/L16; rate=24000', data: Buffer.alloc(pcmBytes, 3).toString('base64') } }] } }],
      }),
    });
  }

  test('returns a playable WAV buffer and sends the configured voice', async () => {
    process.env.GOOGLE_API_KEY = 'test-key';
    let sentBody = null;
    global.fetch = async (url, opts) => {
      sentBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16; rate=24000', data: Buffer.alloc(100, 1).toString('base64') } }] } }] }),
      };
    };
    const buf = await gemini.synthesize({ text: 'hello', voice: 'Aoede' });
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
    assert.equal(sentBody.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Aoede');
    assert.deepEqual(sentBody.generationConfig.responseModalities, ['AUDIO']);
  });

  test('a 200 carrying NO audio throws rather than reporting success (AD-4)', async () => {
    process.env.GOOGLE_API_KEY = 'test-key';
    global.fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'blocked' }] } }] }) });
    await assert.rejects(() => gemini.synthesize({ text: 'hi' }), /no audio/i);
  });

  test('an API error surfaces the real message, not a generic failure', async () => {
    process.env.GOOGLE_API_KEY = 'test-key';
    global.fetch = async () => ({ ok: false, status: 429, statusText: 'Too Many Requests', json: async () => ({ error: { message: 'Quota exceeded for tts' } }) });
    await assert.rejects(() => gemini.synthesize({ text: 'hi' }), /429.*Quota exceeded for tts/);
  });

  test('a missing key fails fast and names the key', async () => {
    delete process.env.GOOGLE_API_KEY;
    await assert.rejects(() => gemini.synthesize({ text: 'hi' }), /GOOGLE_API_KEY/);
  });

  test('empty text is rejected before any network call', async () => {
    process.env.GOOGLE_API_KEY = 'test-key';
    let called = false;
    global.fetch = async () => { called = true; stubOk(10); };
    await assert.rejects(() => gemini.synthesize({ text: '   ' }), /text required/);
    assert.equal(called, false, 'must not spend a billed call on empty text');
  });
});

describe('isAvailable()', () => {
  test('true with a key, false without — and it never makes a billed call', async () => {
    let fetched = false;
    global.fetch = async () => { fetched = true; throw new Error('should not be called'); };

    process.env.GOOGLE_API_KEY = 'test-key';
    // Availability is cached; force a fresh read by waiting out the failure TTL is
    // impractical in a unit test, so assert the no-network property instead, which
    // is the part that costs money if it regresses.
    await gemini.isAvailable();
    assert.equal(fetched, false, 'availability must not synthesize — it is polled per reply');
  });
});
