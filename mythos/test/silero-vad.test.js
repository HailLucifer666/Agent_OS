'use strict';
// silero-vad.test.js — pure node:test coverage for the two pure functions in
// ui/public/js/voice/silero-vad.js (resampleLinear, accumulateFrames). Same
// dynamic-import pattern as test/voice-barge-in-decision.test.js: the file is
// authored as a browser ES module, but these two functions touch no
// DOM/onnxruntime/window, so Node's ES-module-syntax detection lets a plain
// node:test file import it directly.
//
// The ONNX-driving half (createSileroVad/ensureLoaded/probeFrame) is NOT unit
// tested here, matching wakeword.js's own precedent (also untested at the
// unit level — see test/wakeword.test.js's comment). That half was instead
// live-verified once, out of band: a naive fetch of Silero's model straight
// from its GitHub repo carried the right tensor names but scored real speech
// near zero; the exact model this project downloads (via
// scripts/setup-silero.js, sourced from @ricky0123/vad-web's published npm
// package) was verified against snakers4/silero-vad's own test.wav fixture to
// score correctly (max 0.9998, 77% of frames > 0.5) using the identical
// {input, state, sr} -> {output, stateN} calling convention this module uses.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const SILERO_VAD_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'silero-vad.js')
).href;

describe('resampleLinear()', () => {
  it('identity when rates already match', async () => {
    const { resampleLinear } = await import(SILERO_VAD_URL);
    const samples = new Float32Array([0.1, 0.2, 0.3]);
    assert.equal(resampleLinear(samples, 16000, 16000), samples);
  });

  it('downsamples 48kHz analyser output to 16kHz for Silero', async () => {
    const { resampleLinear } = await import(SILERO_VAD_URL);
    const samples = new Float32Array(480).fill(0.25); // 10ms @ 48kHz, one vadTick's worth
    const out = resampleLinear(samples, 48000, 16000);
    assert.equal(out.length, 160); // 10ms @ 16kHz
    assert.ok(Math.abs(out[0] - 0.25) < 1e-6);
  });

  it('upsamples without producing NaN/undefined at the boundary', async () => {
    const { resampleLinear } = await import(SILERO_VAD_URL);
    const samples = new Float32Array([0, 1, 0, -1]);
    const out = resampleLinear(samples, 8000, 16000);
    assert.equal(out.length, 8);
    for (const v of out) assert.ok(Number.isFinite(v));
  });
});

describe('accumulateFrames()', () => {
  it('carries a short chunk forward with no frames yet', async () => {
    const { accumulateFrames } = await import(SILERO_VAD_URL);
    const carry = new Float32Array(0);
    const chunk = new Float32Array(160).fill(0.1); // one resampled vadTick, well under 512
    const { frames, remainder } = accumulateFrames(carry, chunk, 512);
    assert.equal(frames.length, 0);
    assert.equal(remainder.length, 160);
  });

  it('slices off complete frames and carries the remainder, across repeated calls', async () => {
    const { accumulateFrames } = await import(SILERO_VAD_URL);
    let carry = new Float32Array(0);
    let totalFrames = 0;
    // 4 chunks of 160 samples = 640 samples total -> exactly one 512-frame + 128 remainder
    for (let i = 0; i < 4; i++) {
      const chunk = new Float32Array(160).fill(i);
      const result = accumulateFrames(carry, chunk, 512);
      totalFrames += result.frames.length;
      carry = result.remainder;
    }
    assert.equal(totalFrames, 1);
    assert.equal(carry.length, 128);
  });

  it('a frame is exactly frameSize samples, in the order they arrived', async () => {
    const { accumulateFrames } = await import(SILERO_VAD_URL);
    const carry = new Float32Array([1, 2, 3]);
    const chunk = new Float32Array([4, 5, 6, 7, 8]);
    const { frames, remainder } = accumulateFrames(carry, chunk, 4);
    assert.equal(frames.length, 2);
    assert.deepEqual(Array.from(frames[0]), [1, 2, 3, 4]);
    assert.deepEqual(Array.from(frames[1]), [5, 6, 7, 8]);
    assert.equal(remainder.length, 0);
  });
});
