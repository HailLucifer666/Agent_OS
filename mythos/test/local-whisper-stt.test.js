'use strict';

// local-whisper-stt.test.js — the local Whisper STT provider
// (providers/local-whisper-stt.js) and the STT chain it plugs into
// (providers/stt.js).
//
// The actual model load is a real onnxruntime + Hugging Face download, so
// (matching kokoro-tts-provider.test.js's reasoning) it is NOT exercised
// live here. What IS asserted, with zero network/model load:
//   1. parseWav()/resampleLinear() are pure functions — tested directly
//      against hand-built WAV bytes, the same shape voice-loop.js's own
//      encodeWav() produces (16-bit PCM, arbitrary sample rate);
//   2. transcribe() rejects non-WAV input immediately, before touching the
//      model loader — the whole reason this provider is WAV-only;
//   3. providers/stt.js's chain: defaults to 'groq' (back-compat), resolves
//      names to the right modules, and a provider returning '' is treated as
//      a real (if empty) result, not a failure to fall through on.
//
// Full audible verification (VOICE_STT_CHAIN=local, compare transcripts
// against Groq for the same audio) is a live/manual step — see the plan's
// Stage 2 verification.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const whisper = require('../providers/local-whisper-stt');
const sttChain = require('../providers/stt');
const groqStt = require('../providers/groq-stt');

// Build the exact WAV bytes voice-loop.js's encodeWav() produces: 44-byte
// RIFF/WAVE/fmt/data header, 16-bit PCM, mono.
function buildWav(samples, sampleRate) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);  // PCM
  buffer.writeUInt16LE(1, 22);  // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(samples.length * 2, 40);
  let offset = 44;
  for (const s of samples) {
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), offset);
    offset += 2;
  }
  return buffer;
}

describe('parseWav()', () => {
  test('recovers samples and sample rate from a hand-built WAV', () => {
    const samples = [0, 0.5, -0.5, 1, -1];
    const wav = buildWav(samples, 48000);
    const parsed = whisper.parseWav(wav);
    assert.equal(parsed.sampleRate, 48000);
    assert.equal(parsed.samples.length, samples.length);
    // 16-bit round-trip tolerance
    for (let i = 0; i < samples.length; i++) {
      assert.ok(Math.abs(parsed.samples[i] - samples[i]) < 0.001, `sample ${i}`);
    }
  });

  test('rejects a non-WAV buffer', () => {
    assert.throws(() => whisper.parseWav(Buffer.from('not a wav file at all')), /RIFF\/WAVE/);
  });

  test('rejects an unsupported bit depth honestly rather than misreading bytes', () => {
    const wav = buildWav([0, 0.1], 16000);
    wav.writeUInt16LE(32, 34); // claim 32-bit
    assert.throws(() => whisper.parseWav(wav), /bit depth/);
  });
});

describe('resampleLinear()', () => {
  test('identity when rates already match', () => {
    const samples = new Float32Array([0.1, 0.2, 0.3]);
    const out = whisper.resampleLinear(samples, 16000, 16000);
    assert.equal(out, samples, 'must return the same array, not a needless copy');
  });

  test('downsamples to the target length within rounding', () => {
    const samples = new Float32Array(48000).fill(0.5);
    const out = whisper.resampleLinear(samples, 48000, 16000);
    assert.equal(out.length, 16000);
    assert.ok(Math.abs(out[0] - 0.5) < 1e-6);
  });
});

describe('transcribe() — WAV-only, fails fast on anything else', () => {
  test('rejects a webm clip before touching the model loader', async () => {
    await assert.rejects(
      () => whisper.transcribe(Buffer.from('fake-webm-bytes'), 'audio/webm;codecs=opus'),
      /only accepts WAV/
    );
  });

  test('rejects empty audio', async () => {
    await assert.rejects(() => whisper.transcribe(Buffer.alloc(0), 'audio/wav'), /empty audio/);
  });
});

describe('providers/stt.js — chain', () => {
  test("defaults to ['groq'] — unchanged behavior for anyone who sets nothing", () => {
    assert.deepEqual(sttChain.parseChain({}), [groqStt]);
  });

  test("'local' resolves to the local-whisper-stt module", () => {
    assert.deepEqual(sttChain.parseChain({ VOICE_STT_CHAIN: 'local' }), [whisper]);
  });

  test('an ordered multi-provider chain keeps its order', () => {
    assert.deepEqual(sttChain.parseChain({ VOICE_STT_CHAIN: 'local,groq' }), [whisper, groqStt]);
  });

  test('falls through to the next provider on a throw, and an empty-string result is NOT a failure', async () => {
    const failing = { name: 'failing', isAvailable: async () => true, transcribe: async () => { throw new Error('boom'); } };
    const silentOk = { name: 'silent-ok', isAvailable: async () => true, transcribe: async () => '' };
    const original = sttChain.BY_NAME;
    sttChain.BY_NAME.failing = failing;
    sttChain.BY_NAME.silentok = silentOk;
    try {
      const text = await sttChain.transcribe(Buffer.from('x'), 'audio/wav', { VOICE_STT_CHAIN: 'failing,silentok' });
      assert.equal(text, '', 'an empty transcript from a real provider is a valid result, not a fallthrough signal');
    } finally {
      delete sttChain.BY_NAME.failing;
      delete sttChain.BY_NAME.silentok;
      assert.equal(sttChain.BY_NAME, original);
    }
  });

  test('every provider unavailable/failing throws rather than hanging', async () => {
    const down = { name: 'down', isAvailable: async () => false, transcribe: async () => 'unreachable' };
    sttChain.BY_NAME.down = down;
    try {
      await assert.rejects(() => sttChain.transcribe(Buffer.from('x'), 'audio/wav', { VOICE_STT_CHAIN: 'down' }));
    } finally {
      delete sttChain.BY_NAME.down;
    }
  });
});
