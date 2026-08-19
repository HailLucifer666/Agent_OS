'use strict';

// The operator, 2026-08-19: "after every word, there is a second delay, and then
// it speaks the other word, as if it's glitching through, getting stuck in
// between when talking."
//
// Measured with the live.turn-parts audioStarve counters added the same day, over
// one real session: on roughly half of all turns a chunk arrives LATER than the
// previous chunk finishes playing — by 272ms, 298ms, 477ms and 954ms. A chunk
// holds ~100ms of 24kHz PCM and pcm-player.js led the clock by 40ms, so every one
// of those drained the scheduled timeline and the room heard silence until the
// next chunk landed.
//
// Nothing was dropped and nothing was broken. The audio was played exactly as
// fast as it arrived, and it does not arrive evenly. That is what a jitter
// cushion is for, and there was none.
//
// These tests pin the cushion's three properties: it exists at the start of a
// reply, it GROWS when the timeline runs dry anyway, and it is bounded.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const PCM_PLAYER_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'pcm-player.js')
).href;

// A controllable AudioContext: the test moves currentTime by hand, which is what
// makes "the chunk arrived 477ms late" expressible at all.
function fakeContext() {
  const sources = [];
  return {
    state: 'running',
    currentTime: 0,
    async resume() {}, async close() {},
    destination: {},
    createBuffer(channels, length, sampleRate) {
      const data = new Float32Array(length);
      return { length, sampleRate, duration: length / sampleRate, getChannelData: () => data };
    },
    createBufferSource() {
      const src = {
        buffer: null, connect() {}, startedAt: null, stopped: false, onended: null,
        start(at) { src.startedAt = at; },
        stop() { src.stopped = true; if (src.onended) src.onended(); },
      };
      sources.push(src);
      return src;
    },
    _sources: sources,
  };
}

// 100ms of 24kHz mono PCM16, base64 — the shape Gemini Live sends.
const CHUNK_SAMPLES = 2400;
function chunk() {
  const bytes = Buffer.alloc(CHUNK_SAMPLES * 2);
  return bytes.toString('base64');
}
const CHUNK_SEC = CHUNK_SAMPLES / 24000;   // 0.1

async function makePlayer() {
  const { createPcmPlayer } = await import(PCM_PLAYER_URL);
  const ctx = fakeContext();
  const player = createPcmPlayer({ contextFactory: () => ctx });
  return { ctx, player };
}

describe('pcm-player jitter cushion', () => {
  it('the first chunk of a reply is scheduled a cushion ahead, not 40ms ahead', async () => {
    const { ctx, player } = await makePlayer();
    player.enqueue(chunk());

    const first = ctx._sources[0];
    assert.ok(first.startedAt >= 0.25,
      'the first chunk must be scheduled at least CUSHION_BASE_SEC ahead so the next '
      + 'chunk has somewhere to land; got ' + first.startedAt);
    assert.equal(player.stats().cushionSec, 0.25, 'and it starts at the base cushion');
    assert.equal(player.stats().underruns, 0);
  });

  it('chunks that arrive on time stay gapless behind the cushion', async () => {
    const { ctx, player } = await makePlayer();
    player.enqueue(chunk());
    const firstStart = ctx._sources[0].startedAt;

    // Three more chunks arrive promptly (30ms of wall clock each).
    for (let i = 0; i < 3; i++) {
      ctx.currentTime += 0.03;
      player.enqueue(chunk());
    }

    const starts = ctx._sources.map((s) => s.startedAt);
    for (let i = 1; i < starts.length; i++) {
      assert.ok(Math.abs(starts[i] - (starts[i - 1] + CHUNK_SEC)) < 1e-9,
        'chunk ' + i + ' must start exactly where chunk ' + (i - 1) + ' ended — '
        + 'got ' + starts[i] + ', expected ' + (starts[i - 1] + CHUNK_SEC));
    }
    assert.equal(player.stats().underruns, 0, 'no underrun when audio keeps up');
    assert.ok(starts[0] === firstStart);
  });

  it('a 477ms late chunk lands INSIDE the cushion, producing no gap', async () => {
    // The measured real-world case. Four chunks arrive promptly, building 400ms
    // of scheduled audio behind a 250ms cushion; then one arrives 477ms late.
    const { ctx, player } = await makePlayer();
    for (let i = 0; i < 4; i++) { player.enqueue(chunk()); ctx.currentTime += 0.02; }
    const beforeLate = ctx._sources[ctx._sources.length - 1].startedAt + CHUNK_SEC;

    ctx.currentTime += 0.477;                    // the gap that used to be audible
    player.enqueue(chunk());

    const late = ctx._sources[ctx._sources.length - 1];
    assert.ok(Math.abs(late.startedAt - beforeLate) < 1e-9,
      'the late chunk must continue the timeline rather than restart it — got '
      + late.startedAt + ', expected ' + beforeLate);
    assert.equal(player.stats().underruns, 0,
      'with audio still scheduled, a late chunk is absorbed and is not an underrun');
  });

  it('one underrun sizes the cushion to the gap that just happened', async () => {
    // Fixed-step growth would need seven stutters to reach a 1.5s gap. An
    // underrun already reports its own length, so one is enough.
    const { ctx, player } = await makePlayer();
    player.enqueue(chunk());                     // scheduled at 0.25, ends 0.35
    assert.equal(player.stats().cushionSec, 0.25);

    // The measured worst case from the operator's link: dry for ~1.486s.
    ctx.currentTime = 0.35 + 1.486;
    player.enqueue(chunk());

    const s = player.stats();
    assert.equal(s.underruns, 1, 'the dry timeline must be counted');
    assert.ok(Math.abs(s.worstDrySec - 1.486) < 1e-9,
      'the silence must be measured, not inferred; got ' + s.worstDrySec);
    assert.ok(Math.abs(s.cushionSec - (1.486 + 0.25)) < 1e-9,
      'the cushion must now cover that gap plus the margin; got ' + s.cushionSec);

    // And the recovering chunk is scheduled a full grown cushion ahead, so a
    // repeat of the same 1486ms gap is absorbed rather than heard.
    const recovered = ctx._sources[ctx._sources.length - 1];
    assert.ok(Math.abs(recovered.startedAt - (ctx.currentTime + s.cushionSec)) < 1e-9,
      'got ' + recovered.startedAt);
  });

  it('the cushion never shrinks back mid-session on a smaller gap', async () => {
    const { ctx, player } = await makePlayer();
    player.enqueue(chunk());
    ctx.currentTime = 0.35 + 1.0;                // a 1s gap
    player.enqueue(chunk());
    const grown = player.stats().cushionSec;
    assert.ok(grown > 1.0);

    // A later, smaller gap must not undo the protection the big one bought.
    ctx.currentTime += 3;
    player.enqueue(chunk());
    assert.ok(player.stats().cushionSec >= grown,
      'a 0.3s gap must not lower a cushion sized for a 1s one');
  });

  it('the cushion is bounded, so a dead link cannot grow unbounded latency', async () => {
    const { ctx, player } = await makePlayer();
    // NOTE ON WHAT THIS DOES AND DOES NOT PROVE. The clock here is frozen except
    // where the test moves it, so END_GRACE_MS's end-timer never fires and
    // `speaking` stays true across all five jumps. That is what lets the cushion
    // reach CUSHION_MAX_SEC at all. It pins the CLAMP — the thing this test is for
    // — and it must not be read as evidence that a real session reaches 2s; the
    // live-clock test below shows it does not. Kept frozen deliberately: a clamp
    // is arithmetic and deserves a deterministic test, not a 60-second one.
    // Repeated 30-second dry spells — far past any cushion worth paying for.
    for (let i = 0; i < 5; i++) {
      player.enqueue(chunk());
      ctx.currentTime += 30;
    }
    const s = player.stats();
    assert.equal(s.cushionSec, 2.0, 'must stop at CUSHION_MAX_SEC');
    assert.equal(s.cushionAtMax, true,
      'and say so — a cushion pinned at max while still underrunning is a verdict '
      + 'about the connection, not a tuning problem');
    assert.ok(s.underruns >= 4);
  });

  it('close() resets the cushion — it describes a session, not the machine', async () => {
    const { ctx, player } = await makePlayer();
    player.enqueue(chunk());
    ctx.currentTime = 9;
    player.enqueue(chunk());
    assert.ok(player.stats().cushionSec > 0.25);

    player.close();
    assert.equal(player.stats().cushionSec, 0.25);
    assert.equal(player.stats().underruns, 0);
  });

  // A LIVE clock, as a real AudioContext has. Every test above freezes currentTime
  // between statements, which is right for pinning arithmetic and blind to anything
  // decided by a timer — and the cushion's growth is gated on `speaking`, which
  // END_GRACE_MS flips off 250ms after the scheduled audio runs out. With a frozen
  // clock that timer re-arms forever and `speaking` never lapses, so the frozen tests
  // cannot see the boundary that decides which real gaps the cushion learns from.
  function liveContext() {
    const sources = [];
    const t0 = Date.now();
    return {
      state: 'running',
      get currentTime() { return (Date.now() - t0) / 1000; },
      async resume() {}, async close() {},
      destination: {},
      createBuffer(channels, length, sampleRate) {
        const data = new Float32Array(length);
        return { length, sampleRate, duration: length / sampleRate, getChannelData: () => data };
      },
      createBufferSource() {
        const src = {
          buffer: null, connect() {}, startedAt: null, stopped: false, onended: null,
          start(at) { src.startedAt = at; },
          stop() { src.stopped = true; if (src.onended) src.onended(); },
        };
        sources.push(src);
        return src;
      },
      _sources: sources,
    };
  }
  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

  async function oneLateChunk(gapMs) {
    const { createPcmPlayer } = await import(PCM_PLAYER_URL);
    const ctx = liveContext();
    const player = createPcmPlayer({ contextFactory: () => ctx });
    player.enqueue(chunk());          // scheduled at ~0.25, ends ~0.35
    await sleep(gapMs);               // the network stalls for real wall-clock time
    player.enqueue(chunk());
    const s = player.stats();
    player.close();
    return s;
  }

  // Q8 — PINNING A DISPOSITION, not asserting a wish. The cushion GROWS only while
  // the player still believes it is mid-reply, and END_GRACE_MS ends that belief
  // 250ms after the timeline empties. So the growth covers short stalls and stops
  // covering long ones, and the two worst gaps measured on the operator's link
  // (954ms, 1486ms) fall on the far side of it. This is deliberate: the player
  // cannot distinguish a stalled network from a finished reply followed by an
  // operator turn, and counting the latter would pin the cushion at 2s and put that
  // much latency in front of every first word for the rest of the session.
  //
  // Written because the frozen-clock tests above assert growth to 1.736s and 2.0s,
  // which reads as "the cushion self-tunes to any gap" — and a comment claiming
  // exactly that was in the source until this test was written. If the boundary is
  // ever moved on purpose (feeding s2s-bridge.js's live-turn-complete into the
  // player would do it, and would make the attribution exact), this test should be
  // updated to the new boundary rather than deleted.
  it('a stall inside the end-grace window grows the cushion', async () => {
    const s = await oneLateChunk(477);   // measured: the largest gap that still counts
    assert.equal(s.underruns, 1, 'a 477ms stall lands while the reply is still live');
    assert.ok(s.cushionSec > 0.25,
      'so it must size the cushion; got ' + s.cushionSec);
  });

  it('a stall past the end-grace window does NOT grow the cushion — the known limit', async () => {
    const s = await oneLateChunk(1486);  // measured: the worst gap on the operator's link
    assert.equal(s.underruns, 0,
      'not a bug in this test: END_GRACE_MS has already ended the reply, so this is '
      + 'indistinguishable from a new one starting. Growth is declined rather than '
      + 'risk mistaking an operator turn for a network stall.');
    assert.equal(s.cushionSec, 0.25,
      'the base cushion still applies to the recovering chunk — the reply resumes '
      + 'behind 250ms of lead, it simply does not learn that it needs more');
  });

  it('flush() still stops everything, cushion or not', async () => {
    // The barge-in contract must survive this change: BUG-061's tail guard only
    // spares a reply within TAIL_GUARD_SEC of finishing, and a cushion means
    // MORE audio is scheduled, not less.
    const { ctx, player } = await makePlayer();
    for (let i = 0; i < 5; i++) { player.enqueue(chunk()); ctx.currentTime += 0.02; }
    player.flush();
    assert.ok(ctx._sources.every((s) => s.stopped),
      'every scheduled source must be stopped by a flush');
  });
});
