'use strict';

// voice-choice.test.js — THE PICKED VOICE, AND WHAT IT IS NOT ALLOWED TO OUTRANK.
//
// The HUD's voice picker writes a file. This module turns that file into config.
// The properties pinned here are the ones that would each be a real incident:
//   * a click in a HUD must never out-rank an operator's .env / Dockerfile /
//     render.yaml — that is the loudest statement of intent the system has
//   * a corrupt file must degrade to "no choice was made", never to a
//     plausible-but-wrong voice, and never to a boot failure
//   * the picked engine goes to the FRONT of the chain, not INSTEAD of it, so
//     providers/tts.js's sticky failover still has somewhere to fall when the
//     chosen engine has a bad minute

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  KNOWN_PROVIDERS, SHORT_NAME, VOICE_ENV_KEY, isValidChoice, applyVoiceChoice,
} = require('../src/core/config/voice-choice');
const { voiceFor } = require('../providers/tts');

const BASE = 'gemini,edge,kokoro,piper';

describe('isValidChoice', () => {
  test('accepts a well-formed choice for every known provider', () => {
    for (const provider of KNOWN_PROVIDERS) {
      assert.equal(isValidChoice({ provider, voice: 'x' }), true, provider);
    }
  });

  test('rejects an unknown provider, a missing voice and an oversized voice', () => {
    assert.equal(isValidChoice({ provider: 'espeak', voice: 'x' }), false);
    assert.equal(isValidChoice({ provider: 'gemini-tts' }), false);
    assert.equal(isValidChoice({ provider: 'gemini-tts', voice: '   ' }), false);
    assert.equal(isValidChoice({ provider: 'gemini-tts', voice: 'a'.repeat(201) }), false);
    assert.equal(isValidChoice(null), false);
    assert.equal(isValidChoice('gemini'), false);
  });
});

describe('applyVoiceChoice', () => {
  test('moves the chosen engine to the front and KEEPS the rest as failover', () => {
    const out = applyVoiceChoice({}, { provider: 'piper-tts', voice: 'en_US-amy-medium' }, BASE);
    assert.equal(out.VOICE_TTS_CHAIN, 'piper,gemini,edge,kokoro');
    assert.equal(out.PIPER_VOICE, 'en_US-amy-medium');
  });

  test('writes the voice into the key that provider actually reads', () => {
    for (const provider of KNOWN_PROVIDERS) {
      const out = applyVoiceChoice({}, { provider, voice: 'chosen' }, BASE);
      assert.equal(out[VOICE_ENV_KEY[provider]], 'chosen', provider);
      assert.equal(out.VOICE_TTS_CHAIN.split(',')[0], SHORT_NAME[provider], provider);
    }
  });

  test('an operator VOICE_TTS_CHAIN outranks the picker entirely', () => {
    const out = applyVoiceChoice({ VOICE_TTS_CHAIN: 'edge' }, { provider: 'gemini-tts', voice: 'Kore' }, BASE);
    assert.deepEqual(out, {});
  });

  test('an operator VOICE_TTS_PROVIDER outranks the picker entirely', () => {
    const out = applyVoiceChoice({ VOICE_TTS_PROVIDER: 'piper' }, { provider: 'gemini-tts', voice: 'Kore' }, BASE);
    assert.deepEqual(out, {});
  });

  test('an operator voice id survives even when the chain came from the picker', () => {
    const out = applyVoiceChoice({ GEMINI_LIVE_VOICE: 'Zephyr' }, { provider: 'gemini-tts', voice: 'Kore' }, BASE);
    assert.equal(out.VOICE_TTS_CHAIN, 'gemini,edge,kokoro,piper');
    assert.equal('GEMINI_LIVE_VOICE' in out, false, 'a real env voice id must not be overwritten');
  });

  test('a missing, corrupt or unknown-provider file changes nothing', () => {
    for (const stored of [null, undefined, {}, 'gemini', { provider: 'espeak', voice: 'x' }, { provider: 'gemini-tts', voice: '' }]) {
      assert.deepEqual(applyVoiceChoice({}, stored, BASE), {}, JSON.stringify(stored));
    }
  });

  test('an empty base chain still yields a usable single-engine chain', () => {
    const out = applyVoiceChoice({}, { provider: 'kokoro-tts', voice: 'af_heart' }, '');
    assert.equal(out.VOICE_TTS_CHAIN, 'kokoro');
  });

  test('the chosen engine is never duplicated in the chain', () => {
    const out = applyVoiceChoice({}, { provider: 'gemini-tts', voice: 'Kore' }, BASE);
    assert.equal(out.VOICE_TTS_CHAIN, 'gemini,edge,kokoro,piper');
  });
});

// The picker stores a provider + a voice id; providers/tts.js must actually READ
// that id. These two tables drifting apart would be silent — the operator would
// pick a voice, the file would save, and nothing would change.
describe('the stored voice reaches voiceFor()', () => {
  test('every provider key the picker writes is the one voiceFor reads', () => {
    const fake = { 'gemini-tts': 'gemini-tts', 'piper-tts': 'piper-tts', 'kokoro-tts': 'kokoro-tts', 'edge-tts': 'edge-tts' };
    for (const provider of KNOWN_PROVIDERS) {
      const overlay = applyVoiceChoice({}, { provider, voice: 'picked-voice' }, BASE);
      assert.equal(voiceFor({ name: fake[provider] }, overlay), 'picked-voice', provider);
    }
  });
});
