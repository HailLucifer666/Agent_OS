'use strict';

// kokoro-tts-provider.test.js — the Kokoro-82M TTS provider (providers/kokoro-tts.js)
// and its wiring into providers/tts.js's chain/voice selector.
//
// Kokoro's model load is a real onnxruntime + Hugging Face download (~26MB on
// first run), so it is deliberately NOT exercised live here — that would make
// this suite network-dependent and slow, exactly what the plan for this work
// warns against. What IS asserted, with zero network/model load:
//   1. the provider is registered under the chain name 'kokoro' and keeps the
//      shape every other provider has (name/mime/isAvailable/synthesize);
//   2. voiceFor() maps it to KOKORO_VOICE (default 'af_heart'), never to
//      another engine's voice id — the exact bug class gemini-tts-provider
//      already caught once for a different provider;
//   3. synthesize() rejects fast on empty text / an aborted signal BEFORE
//      touching the model loader, so a bad call never pays the load cost.
// Full audible verification (VOICE_TTS_CHAIN=kokoro, confirm the greeting is
// audibly Kokoro) is a live/manual step — see the plan's Stage 1 verification.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const kokoro = require('../providers/kokoro-tts');
const { parseChain, mimeFor, voiceFor } = require('../providers/tts');

describe('provider shape', () => {
  test('exposes the same shape as every other TTS provider', () => {
    assert.equal(kokoro.name, 'kokoro-tts');
    assert.equal(kokoro.mime, 'audio/wav');
    assert.equal(typeof kokoro.isAvailable, 'function');
    assert.equal(typeof kokoro.synthesize, 'function');
  });

  test('mimeFor() reports wav', () => {
    assert.equal(mimeFor(kokoro), 'audio/wav');
  });
});

describe('chain registration', () => {
  test("'kokoro' in VOICE_TTS_CHAIN resolves to this module", () => {
    const chain = parseChain({ VOICE_TTS_CHAIN: 'kokoro' });
    assert.equal(chain.length, 1);
    assert.equal(chain[0], kokoro);
  });

  test('kokoro can sit anywhere in a multi-engine chain without disturbing the default', () => {
    assert.equal(parseChain({}).length, 1, 'default chain is still just edge — untouched by adding kokoro');
    const chain = parseChain({ VOICE_TTS_CHAIN: 'gemini,kokoro,piper' });
    assert.equal(chain.map((p) => p.name).join(','), 'gemini-tts,kokoro-tts,piper-tts');
  });
});

describe('voiceFor() — the voice id belongs to the engine', () => {
  test('defaults to af_heart with no config', () => {
    assert.equal(voiceFor(kokoro, {}), 'af_heart');
  });

  test('reads KOKORO_VOICE, never another engine\'s voice id', () => {
    const CONFIG = { KOKORO_VOICE: 'af_bella', VOICE_TTS_VOICE: 'en-GB-SoniaNeural', GEMINI_LIVE_VOICE: 'Aoede' };
    assert.equal(voiceFor(kokoro, CONFIG), 'af_bella');
  });
});

describe('synthesize() — fails fast before touching the model loader', () => {
  test('empty text is rejected without loading the model', async () => {
    await assert.rejects(() => kokoro.synthesize({ text: '   ' }), /text required/);
  });

  test('an already-aborted signal is rejected without loading the model', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => kokoro.synthesize({ text: 'hello', signal: controller.signal }), /aborted/);
  });
});
