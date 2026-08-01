'use strict';
// test/pcm-player.test.js — Phase 4 (V2 §9, merged-order step 4). Node-side
// coverage for pcm-player.js's scheduling/flush logic via a fake AudioContext
// injected through the contextFactory test seam (mirrors live-session.js's
// createSocket seam from Phase 1). Loaded via dynamic import(), same pattern
// as test/voice-barge-in-decision.test.js.
//
// Gate (test matrix §14): "flush() stops all sources."

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const PCM_PLAYER_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'pcm-player.js')
).href;

function makeFakeSource() {
  const src = {
    buffer: null,
    connect() {},
    started: false,
    startedAt: null,
    stopped: false,
    onended: null,
    start(at) { src.started = true; src.startedAt = at; },
    stop() { src.stopped = true; if (src.onended) src.onended(); },
  };
  return src;
}

function fakeContext(initialState = 'running') {
  const sources = [];
  const buffers = [];
  return {
    state: initialState,
    currentTime: 0,
    closed: false,
    async resume() { this.state = 'running'; },
    async close() { this.closed = true; },
    destination: {},
    createBuffer(channels, length, sampleRate) {
      const data = new Float32Array(length);
      const buf = { length, sampleRate, duration: length / sampleRate, getChannelData: () => data };
      buffers.push(buf);
      return buf;
    },
    createBufferSource() {
      const src = makeFakeSource();
      sources.push(src);
      return src;
    },
    _sources: sources,
  };
}

// One base64 frame encoding 2 int16 samples: 0 and 32767 (little-endian).
function twoSamplesBase64() {
  return Buffer.from([0x00, 0x00, 0xff, 0x7f]).toString('base64');
}

// n zero-valued int16 samples, for building a chunk of a specific duration
// at 24kHz (Stage 2's flush() tail-guard tests need buffers long enough to
// clear the 250ms threshold, unlike the ~83-microsecond twoSamplesBase64()
// chunk the pre-existing tests above use).
function samplesBase64(n) {
  return Buffer.alloc(n * 2, 0).toString('base64');
}

describe('pcm-player (Phase 4, V2 §9)', () => {
  it('enqueue() schedules a source with a 40ms floor on the first chunk', async () => {
    const { createPcmPlayer } = await import(PCM_PLAYER_URL);
    const ctx = fakeContext();
    const player = createPcmPlayer({ sampleRate: 24000, contextFactory: () => ctx });
    player.enqueue(twoSamplesBase64());
    assert.equal(ctx._sources.length, 1);
    assert.ok(ctx._sources[0].started);
    assert.ok(Math.abs(ctx._sources[0].startedAt - 0.04) < 1e-9, 'first chunk must start at currentTime+0.04, not 0');
  });

  it('back-to-back enqueues schedule sequentially, never overlapping', async () => {
    const { createPcmPlayer } = await import(PCM_PLAYER_URL);
    const ctx = fakeContext();
    const player = createPcmPlayer({ sampleRate: 24000, contextFactory: () => ctx });
    player.enqueue(twoSamplesBase64());
    const firstEnd = ctx._sources[0].startedAt + ctx._sources[0].buffer.duration;
    player.enqueue(twoSamplesBase64());
    assert.ok(Math.abs(ctx._sources[1].startedAt - firstEnd) < 1e-9, 'the second chunk must start exactly where the first ends');
  });

  it('flush() stops every currently-scheduled source and clears the live set (tail well over the 250ms guard)', async () => {
    const { createPcmPlayer } = await import(PCM_PLAYER_URL);
    const ctx = fakeContext();
    const player = createPcmPlayer({ sampleRate: 24000, contextFactory: () => ctx });
    // 1 second each — comfortably clears Stage 2's 250ms tail guard so this
    // exercises a genuine interrupt, not the "let it finish" path below.
    player.enqueue(samplesBase64(24000));
    player.enqueue(samplesBase64(24000));
    player.enqueue(samplesBase64(24000));
    assert.equal(ctx._sources.filter((s) => !s.stopped).length, 3);

    player.flush();

    assert.ok(ctx._sources.every((s) => s.stopped), 'flush() must stop every live source');
    // A source that has already ended (onended fired) must not throw or double-count.
    assert.doesNotThrow(() => player.flush());
  });

  it('flush() resets scheduling so the NEXT enqueue starts fresh relative to currentTime', async () => {
    const { createPcmPlayer } = await import(PCM_PLAYER_URL);
    const ctx = fakeContext();
    const player = createPcmPlayer({ sampleRate: 24000, contextFactory: () => ctx });
    player.enqueue(samplesBase64(24000));
    player.enqueue(samplesBase64(24000));
    player.flush();
    ctx.currentTime = 5.0; // time has moved on (barge-in mid-playback)
    player.enqueue(twoSamplesBase64());
    const newest = ctx._sources[ctx._sources.length - 1];
    assert.ok(Math.abs(newest.startedAt - 5.04) < 1e-9, 'after flush, the next chunk must schedule relative to the NEW currentTime, not the stale nextAt');
  });

  it('isSpeaking() reflects whether scheduled audio extends past currentTime', async () => {
    const { createPcmPlayer } = await import(PCM_PLAYER_URL);
    const ctx = fakeContext();
    const player = createPcmPlayer({ sampleRate: 24000, contextFactory: () => ctx });
    assert.equal(player.isSpeaking(), false, 'no context created yet -> not speaking');
    player.enqueue(samplesBase64(24000));
    assert.equal(player.isSpeaking(), true);
    player.flush();
    assert.equal(player.isSpeaking(), false, 'after flush, isSpeaking must be false');
  });

  // Stage 2 (BUG-061): "consistently cut off at the end, losing the last one
  // or two words." flush() now leaves a near-finished tail alone instead of
  // amputating it.
  it('flush() ignores the interrupt when under 250ms of audio remains queued', async () => {
    const { createPcmPlayer } = await import(PCM_PLAYER_URL);
    const ctx = fakeContext();
    const player = createPcmPlayer({ sampleRate: 24000, contextFactory: () => ctx });
    // 2400 samples at 24kHz = 100ms — well under the 250ms guard.
    player.enqueue(samplesBase64(2400));
    assert.equal(ctx._sources[0].stopped, false);

    player.flush();

    assert.equal(ctx._sources[0].stopped, false, 'a tail under 250ms must be left to finish, not stopped');
    assert.equal(player.isSpeaking(), true, 'the queued tail must still be considered speaking after the ignored interrupt');
  });

  it('flush() still stops immediately once the remaining tail exceeds 250ms', async () => {
    const { createPcmPlayer } = await import(PCM_PLAYER_URL);
    const ctx = fakeContext();
    const player = createPcmPlayer({ sampleRate: 24000, contextFactory: () => ctx });
    // 12000 samples at 24kHz = 500ms — over the 250ms guard.
    player.enqueue(samplesBase64(12000));
    player.flush();
    assert.equal(ctx._sources[0].stopped, true, 'a long remaining tail is a genuine interrupt and must stop immediately');
  });

  it('flush() at exactly the moment nothing is queued is a harmless no-op', async () => {
    const { createPcmPlayer } = await import(PCM_PLAYER_URL);
    const ctx = fakeContext();
    const player = createPcmPlayer({ sampleRate: 24000, contextFactory: () => ctx });
    assert.doesNotThrow(() => player.flush());
  });

  it('close() flushes all sources and closes the underlying context', async () => {
    const { createPcmPlayer } = await import(PCM_PLAYER_URL);
    const ctx = fakeContext();
    const player = createPcmPlayer({ sampleRate: 24000, contextFactory: () => ctx });
    player.enqueue(twoSamplesBase64());
    player.close();
    assert.ok(ctx._sources.every((s) => s.stopped));
    assert.equal(ctx.closed, true);
  });

  it('a suspended context is resumed on first enqueue (autoplay-policy handling)', async () => {
    const { createPcmPlayer } = await import(PCM_PLAYER_URL);
    const ctx = fakeContext('suspended');
    const player = createPcmPlayer({ sampleRate: 24000, contextFactory: () => ctx });
    player.enqueue(twoSamplesBase64());
    assert.equal(ctx.state, 'running');
  });
});
