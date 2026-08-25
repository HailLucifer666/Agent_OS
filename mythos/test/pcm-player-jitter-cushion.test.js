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

  it('the cushion is bounded, so a bad link cannot grow unbounded latency', async () => {
    const { ctx, player } = await makePlayer();
    // Dry spells of 2.5s: bad enough that the cushion wants more than MAX
    // (2.5 + 0.25 margin), and still inside UNDERRUN_ATTRIBUTION_MAX_SEC so they
    // are read as stalls rather than as a lost turn boundary. Three of them,
    // because the clamp has to hold on repeats and not only on the first.
    for (let i = 0; i < 3; i++) {
      player.enqueue(chunk());
      ctx.currentTime += 2.5;
    }
    const s = player.stats();
    assert.equal(s.cushionSec, 2.0, 'must stop at CUSHION_MAX_SEC');
    assert.equal(s.cushionAtMax, true,
      'and say so — a cushion pinned at max while still underrunning is a verdict '
      + 'about the connection, not a tuning problem');
    assert.ok(s.underruns >= 2);
    assert.equal(s.missedTurnEnds, 0, 'these are stalls, not lost turn boundaries');
  });

  it('close() resets the cushion — it describes a session, not the machine', async () => {
    const { ctx, player } = await makePlayer();
    player.enqueue(chunk());
    ctx.currentTime = 2.0;             // dry ~1.65s: a stall, under the ceiling
    player.enqueue(chunk());
    assert.ok(player.stats().cushionSec > 0.25);

    player.close();
    assert.equal(player.stats().cushionSec, 0.25);
    assert.equal(player.stats().underruns, 0);
    assert.equal(player.stats().missedTurnEnds, 0);
  });

  // ---- the turn boundary, wired 2026-08-20 -------------------------------------
  //
  // The cushion may only learn from silence that happened INSIDE a model turn. The
  // player cannot tell that apart from the operator taking a breath, so it is told:
  // s2s-bridge.js forwards the server's own 'live-turn-complete' (and
  // 'live-interrupted') to endTurn(). These three cases are the whole contract.

  it('a long gap ACROSS a turn boundary is not an underrun', async () => {
    // The false positive that would otherwise pin the cushion at MAX for a session:
    // MYTHOS finishes a reply, the operator thinks for two seconds and speaks, and
    // the next reply's first chunk arrives to find an empty timeline. Nothing was
    // late. Nobody heard a gap in a reply. This must not grow anything.
    const { ctx, player } = await makePlayer();
    player.enqueue(chunk());
    player.endTurn();                  // the server said the turn is over
    ctx.currentTime = 2.5;             // the operator takes their time
    player.enqueue(chunk());           // a NEW reply begins

    const s = player.stats();
    assert.equal(s.underruns, 0,
      'silence between turns is a conversation, not an underrun — counting it is '
      + 'what would put 2s of latency in front of every first word');
    assert.equal(s.cushionSec, 0.25, 'so the cushion is untouched');
    assert.equal(s.missedTurnEnds, 0, 'and the boundary arrived, so nothing was lost');
  });

  it('the SAME gap inside an open turn IS an underrun — the boundary is the only difference', async () => {
    // Deliberately identical to the case above except for the endTurn() call, so the
    // test names the actual discriminator rather than two unrelated scenarios.
    const { ctx, player } = await makePlayer();
    player.enqueue(chunk());
    ctx.currentTime = 2.5;
    player.enqueue(chunk());

    const s = player.stats();
    assert.equal(s.underruns, 1, 'no boundary arrived, so the turn is still open');
    assert.ok(s.cushionSec > 0.25, 'and the stall sizes the cushion; got ' + s.cushionSec);
  });

  it('a turn that never ends cannot inflate the cushion — the fail-safe closes it', async () => {
    // The failure mode that made this wiring risky enough to defer once: if
    // 'live-turn-complete' is lost (dropped socket, rotated session), turnOpen stays
    // true and the next reply — after however long the operator spoke — would be
    // scored as one enormous underrun and pin the cushion at MAX for the session.
    // Past UNDERRUN_ATTRIBUTION_MAX_SEC the gap is read as a lost boundary instead,
    // growth is declined, and the run is closed by hand.
    const { ctx, player } = await makePlayer();
    player.enqueue(chunk());
    // No endTurn() — the frame never arrived.
    ctx.currentTime = 30;              // far past any stall worth cushioning
    player.enqueue(chunk());

    const s = player.stats();
    assert.equal(s.underruns, 0, 'a 30s gap is not jitter, whatever turnOpen claims');
    assert.equal(s.cushionSec, 0.25, 'so it must not inflate the cushion');
    assert.equal(s.missedTurnEnds, 1,
      'and it must SAY the boundary was lost — a silent fail-safe is the inert '
      + 'mechanism this ticket keeps finding');

    // The run is now closed and this chunk reopened it, so the reply continues
    // normally: a promptly-arriving next chunk is neither an underrun nor another
    // lost boundary. The fail-safe is charged once per GAP, not once per chunk that
    // follows one — a counter that ticked per chunk would report a dead link as
    // hundreds of lost boundaries and drown the signal it exists to give.
    ctx.currentTime = 30.05;
    player.enqueue(chunk());
    const after = player.stats();
    assert.equal(after.missedTurnEnds, 1, 'no second gap, so no second count');
    assert.equal(after.underruns, 0);
    assert.equal(after.cushionSec, 0.25);
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

  // WHY A LIVE CLOCK IS STILL REQUIRED HERE, now more than before. The frozen tests
  // above cannot observe anything a timer decides, and END_GRACE_MS still runs on a
  // real timer — it drives `speaking` and the mic gate. Until 2026-08-20 it ALSO
  // gated the cushion's growth, and that is exactly what these two cases caught:
  // frozen tests asserted the cushion growing to 1.736s and to its 2.0s cap while a
  // live clock showed the two worst measured gaps (954ms, 1486ms) growing it not at
  // all, because the reply had been declared over 250ms into the stall.
  //
  // The gate is now the server's turn boundary, which no timer competes with. These
  // cases are kept, inverted, and are the regression that would catch a re-coupling:
  // if anything ever re-ties growth to `speaking`, the 1486ms case goes back to
  // reporting zero and this fails.
  it('a 477ms stall grows the cushion — unchanged by the rewiring', async () => {
    const s = await oneLateChunk(477);   // measured on the operator's link
    assert.equal(s.underruns, 1);
    assert.ok(s.cushionSec > 0.25, 'it must size the cushion; got ' + s.cushionSec);
  });

  it('a 1486ms stall NOW grows the cushion too — this is what the rewiring bought', async () => {
    // The worst gap measured on the operator's link, and the one the cushion was
    // built for. It went uncounted for as long as growth depended on a 250ms timer
    // rather than on whether the model turn was still open.
    const s = await oneLateChunk(1486);
    assert.equal(s.underruns, 1,
      'no turn boundary arrived during this stall, so the turn was still open and '
      + 'the silence was the transport — if this reads 0, growth has been re-tied '
      + 'to END_GRACE_MS and the worst gaps are invisible again');
    assert.ok(s.cushionSec > 1.0,
      'and the cushion must now be sized to absorb a repeat of it; got ' + s.cushionSec);
    assert.equal(s.missedTurnEnds, 0,
      '1486ms is a stall, not a lost boundary — the fail-safe must not fire here, '
      + 'or the ceiling has been set below real-world jitter');
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
