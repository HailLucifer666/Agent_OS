'use strict';
// test/pcm-resample.test.js — Phase 4 (V2 §9, merged-order step 4). Node-side
// coverage for the exact resampling math pcm-capture-worklet.js runs inline
// (AudioWorklet files take no imports, so pcm-resample.js is a standalone
// twin of that same algorithm — see both files' headers). Loaded via dynamic
// import() the same way test/voice-barge-in-decision.test.js already tests
// voice-loop.js's decideBargeIn().
//
// Gate (test matrix §14): "48k→16k length within ±1 sample/frame; no
// fractional drift accumulating over 100 frames."

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const PCM_RESAMPLE_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'pcm-resample.js')
).href;

function feed(resampler, totalInputSamples, blockSize) {
  let emittedSamples = 0;
  let frames = 0;
  let fed = 0;
  while (fed < totalInputSamples) {
    const n = Math.min(blockSize, totalInputSamples - fed);
    const block = new Float32Array(n);
    for (let i = 0; i < n; i++) block[i] = Math.sin((fed + i) * 0.01) * 0.5; // arbitrary non-silent signal
    resampler.push(block, () => { frames += 1; emittedSamples += resampler.outLen; });
    fed += n;
  }
  return { frames, emittedSamples, leftover: resampler.outIdx };
}

describe('pcm-resample (Phase 4, V2 §9)', () => {
  it('48kHz -> 16kHz: total emitted samples is within ±1 sample of the exact ratio, for 1 second of audio', async () => {
    const { createPcmResampler } = await import(PCM_RESAMPLE_URL);
    const resampler = createPcmResampler({ inputRate: 48000, targetRate: 16000, frameMs: 10 }); // outLen=160/frame
    const totalInput = 48000; // exactly 1 second at 48kHz
    const { emittedSamples, leftover } = feed(resampler, totalInput, 128);
    const expected = Math.round(totalInput / resampler.ratio); // 16000
    const total = emittedSamples + leftover;
    assert.ok(Math.abs(total - expected) <= 1, `expected ~${expected} total output samples, got ${total}`);
  });

  it('no fractional drift accumulates over 100 emitted frames — the cursor stays within [0, ratio) at all times', async () => {
    const { createPcmResampler } = await import(PCM_RESAMPLE_URL);
    const resampler = createPcmResampler({ inputRate: 48000, targetRate: 16000, frameMs: 10 }); // outLen=160/frame
    // 100 frames * 160 samples/frame @16kHz = 16000 samples = 1s @16kHz = 48000 samples @48kHz.
    const totalInput = 48000;
    let framesSeen = 0;
    let fed = 0;
    const blockSize = 100; // deliberately does not divide evenly into outLen's implied cadence
    while (fed < totalInput) {
      const n = Math.min(blockSize, totalInput - fed);
      const block = new Float32Array(n);
      for (let i = 0; i < n; i++) block[i] = Math.cos((fed + i) * 0.02) * 0.7;
      resampler.push(block, () => { framesSeen += 1; });
      fed += n;
      // The fractional cursor must never grow beyond one input-sample's width —
      // if it did, error would compound frame over frame (the drift bug).
      assert.ok(resampler.pos >= 0 && resampler.pos < resampler.ratio,
        `pos ${resampler.pos} escaped [0, ${resampler.ratio}) after feeding ${fed} samples — fractional drift is accumulating`);
    }
    assert.ok(framesSeen >= 99 && framesSeen <= 101, `expected ~100 frames, got ${framesSeen}`);
  });

  it('a non-integer ratio (44.1kHz -> 16kHz) still produces the right total length within ±1 sample', async () => {
    const { createPcmResampler } = await import(PCM_RESAMPLE_URL);
    const resampler = createPcmResampler({ inputRate: 44100, targetRate: 16000, frameMs: 20 });
    const totalInput = 44100 * 2; // 2 seconds
    const { emittedSamples, leftover } = feed(resampler, totalInput, 441);
    const expected = Math.round(totalInput / resampler.ratio);
    const total = emittedSamples + leftover;
    assert.ok(Math.abs(total - expected) <= 1, `expected ~${expected}, got ${total}`);
  });

  it('output samples are valid 16-bit PCM (never overflow int16 range)', async () => {
    const { createPcmResampler } = await import(PCM_RESAMPLE_URL);
    const resampler = createPcmResampler({ inputRate: 48000, targetRate: 16000, frameMs: 10 });
    let sawFrame = false;
    const block = new Float32Array(4800);
    for (let i = 0; i < block.length; i++) block[i] = Math.sin(i * 0.1) * 1.5; // deliberately clipped input (>1)
    resampler.push(block, (buf) => {
      sawFrame = true;
      const view = new Int16Array(buf);
      for (const s of view) assert.ok(s >= -32768 && s <= 32767);
    });
    assert.ok(sawFrame, 'this test must actually exercise at least one emitted frame');
  });
});
