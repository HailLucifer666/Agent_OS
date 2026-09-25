'use strict';

// bug-455-mic-waits-for-playback.test.js — BUG-455 (mic half) and its echo-copy
// disposition. Found by the operator in the attended run of 2026-09-24: "I think
// you are hearing yourself … you are replying to your own words".
//
// THE BUG. The own-voice gate holds the mic while MYTHOS speaks. Its watchdog, an
// 8 s idle window, was refreshed only by ARRIVING audio chunks. Gemini Live
// streams faster than real time, so a long reply had fully arrived while the room
// was still hearing it, and 8 s after the last chunk landed the watchdog reopened
// the mic mid-sentence. Measured from that run's server log: 20 of 50 holds ended
// on the ceiling, every one but a single 1-chunk hold on a reply of 43-94 chunks,
// none of the 20 replies under 43 chunks; bargeVetoed was 0 on all 20.
//
// THE FIX (ui/public/js/voice/own-voice-clock.js): the watchdog waits while the
// player is still speaking and its clock is moving; a frozen clock is judged at
// once; the 30 s absolute cap is untouched.
//
// Probe letters and their dated results are recorded in BUGS.md (BUG-455, Proof)
// and in the commit body, per the operator-approved deviation from core.md 11.10.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const VOICE = path.join(ROOT, 'ui', 'public', 'js', 'voice');
const CLOCK_URL = pathToFileURL(path.join(VOICE, 'own-voice-clock.js')).href;
const PLAYER_URL = pathToFileURL(path.join(VOICE, 'pcm-player.js')).href;
const stripComments = (t) => t.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const BRIDGE = stripComments(fs.readFileSync(path.join(VOICE, 's2s-bridge.js'), 'utf8'));
const SERVER = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8'));

const IDLE_MS = 8000; // s2s-bridge.js OWN_VOICE_IDLE_CEILING_MS, asserted below
const CHUNK_MS = 200; // one chunk of 24 kHz 16-bit PCM
const CHUNK = Buffer.alloc((24000 * CHUNK_MS / 1000) * 2).toString('base64');

function fakeContext() {
  return {
    state: 'running', currentTime: 0,
    async resume() {}, async close() {},
    createBuffer(_ch, len, rate) { return { duration: len / rate, getChannelData: () => new Float32Array(len) }; },
    createBufferSource() { const s = { connect() {}, start() {}, stop() {}, onended: null }; return s; },
    destination: {},
  };
}

// A reply of `chunks` chunks that ARRIVES all at once (Live streams faster than
// real time), then `afterMs` of wall time during which the audio clock moves at
// `rate` (1 = playing, 0 = a suspended AudioContext).
async function scene({ chunks, afterMs, rate = 1 }) {
  const { createPcmPlayer } = await import(PLAYER_URL);
  const { createOwnVoiceClock } = await import(CLOCK_URL);
  const ctx = fakeContext();
  const player = createPcmPlayer({ contextFactory: () => ctx });
  let wall = 1_000_000;
  const clock = createOwnVoiceClock({ now: () => wall });
  for (let i = 0; i < chunks; i++) player.enqueue(CHUNK);
  clock.armed(player); // the watchdog is re-armed on the last arriving chunk
  wall += afterMs;
  ctx.currentTime += (afterMs / 1000) * rate;
  return { player, clock, ctx };
}

describe('BUG-455 — the watchdog judges on the playback clock', () => {
  it('(a) REPLAY 14:53:35 — a 72-chunk reply is still playing 8 s after its last chunk arrived, so the watchdog waits', async () => {
    const { player, clock } = await scene({ chunks: 72, afterMs: IDLE_MS });
    const queued = player.playhead().aheadMs;
    assert.ok(queued > 5000, 'the fixture must leave real audio queued, or it proves nothing: ' + queued);
    const wait = clock.check(player, IDLE_MS);
    assert.equal(wait, Math.round(queued) + IDLE_MS,
      'the old watchdog judged here and reopened the mic mid-sentence; it must wait for what is queued, then the same idle window');
    assert.equal(clock.waits, 1);
    assert.equal(clock.stalled, false);
  });

  it('(b) playback finished but the end-of-speech callback never came — judged at once (the watchdog\'s reason to exist)', async () => {
    const { player, clock } = await scene({ chunks: 20, afterMs: IDLE_MS });
    assert.equal(player.isSpeaking(), false, 'fixture: 4 s of audio is over after 8 s');
    assert.equal(clock.check(player, IDLE_MS), 0);
  });

  it('(c) a frozen audio clock (suspended AudioContext) is a broken player — judged at once, not waited on', async () => {
    const { player, clock } = await scene({ chunks: 72, afterMs: IDLE_MS, rate: 0 });
    assert.equal(player.isSpeaking(), true, 'fixture: the queue never drains when the clock is frozen');
    assert.equal(clock.check(player, IDLE_MS), 0,
      'waiting on a clock that does not move would keep the mic shut until the 30 s cap');
    assert.equal(clock.stalled, true, 'the stall must be reported, not only acted on');
    assert.equal(clock.waits, 0);
  });

  it('(c2) a clock running at a third of real time counts as stalled; one at 0.9 counts as playing', async () => {
    const slow = await scene({ chunks: 72, afterMs: IDLE_MS, rate: 0.3 });
    assert.equal(slow.clock.check(slow.player, IDLE_MS), 0);
    const ok = await scene({ chunks: 72, afterMs: IDLE_MS, rate: 0.9 });
    assert.ok(ok.clock.check(ok.player, IDLE_MS) > 0);
  });

  it('(d) ADJACENT — a short reply (19 chunks) is unchanged: done playing, judged immediately', async () => {
    const { player, clock } = await scene({ chunks: 19, afterMs: IDLE_MS });
    assert.equal(clock.check(player, IDLE_MS), 0);
  });

  it('(e) no player, or one that throws, is judged — never waited on', async () => {
    const { createOwnVoiceClock } = await import(CLOCK_URL);
    const clock = createOwnVoiceClock({ now: () => 5 });
    assert.equal(clock.check(null, IDLE_MS), 0);
    assert.equal(clock.check({ isSpeaking: () => true, playhead() { throw new Error('boom'); } }, IDLE_MS), 0);
  });

  it('(f) reset() clears the counts for the next hold', async () => {
    const { player, clock } = await scene({ chunks: 72, afterMs: IDLE_MS });
    clock.check(player, IDLE_MS);
    clock.reset();
    assert.equal(clock.waits, 0);
    assert.equal(clock.stalled, false);
  });
});

describe('BUG-455 — the bridge actually uses the playback clock', () => {
  const body = (start, end) => {
    const a = BRIDGE.indexOf(start);
    assert.notEqual(a, -1, start + ' must exist');
    const b = BRIDGE.indexOf(end, a + start.length);
    assert.notEqual(b, -1, end + ' must follow ' + start);
    return BRIDGE.slice(a, b);
  };

  it('(g) the ceiling timer asks the clock BEFORE the ceiling decision, and re-arms with the wait', () => {
    const arm = body('function armOwnVoiceCeiling', 'function refreshOwnVoiceCeiling');
    const checkAt = arm.indexOf('ownVoiceClock.check(player, OWN_VOICE_IDLE_CEILING_MS)');
    const decideAt = arm.indexOf('bargePolicy.ceilingDecision(');
    assert.ok(checkAt !== -1, 'the watchdog must consult the playback clock');
    assert.ok(decideAt !== -1 && checkAt < decideAt, 'and before it judges, or the judgement is on the arrival clock again');
    assert.match(arm, /ownVoiceClock\.armed\(player\)/, 'every (re)arm must note both clocks, or the stall test compares stale times');
    assert.match(arm, /armOwnVoiceCeiling\(wait\)/, 'a wait must re-arm the idle window, not release');
    assert.match(arm, /\}, delayMs \|\| OWN_VOICE_IDLE_CEILING_MS\);/, 'and the timer must use that wait, or it re-checks every 8 s instead');
  });

  it('(g2) the 30 s absolute cap is untouched and never consults or refreshes the clock', () => {
    assert.match(BRIDGE, /OWN_VOICE_MAX_HOLD_MS = 30000/);
    assert.match(BRIDGE, /OWN_VOICE_IDLE_CEILING_MS = 8000/);
    const cap = body('function armOwnVoiceMaxHold', 'function holdOwnVoiceGate');
    assert.doesNotMatch(cap, /ownVoiceClock/, 'the cap is the bound on every hold; it must not wait on playback');
    const arm = body('function armOwnVoiceCeiling', 'function refreshOwnVoiceCeiling');
    assert.doesNotMatch(arm, /armOwnVoiceMaxHold/, 'a wait must never push the absolute cap out');
  });

  it('(g3) a new hold resets the clock', () => {
    const hold = body('function holdOwnVoiceGate', 'function releaseOwnVoiceGate');
    assert.match(hold, /ownVoiceClock\.reset\(\)/);
  });

  it('(h) the release line reports the waits and the stall, and the server keeps both', () => {
    const release = BRIDGE.slice(BRIDGE.indexOf('function releaseOwnVoiceGate'));
    const logCall = release.slice(release.indexOf('logSuspendTransition({'), release.indexOf('});', release.indexOf('logSuspendTransition({')));
    assert.match(logCall, /playbackWaits: ownVoiceClock\.waits/);
    assert.match(logCall, /playbackStalled: ownVoiceClock\.stalled/);
    const at = SERVER.indexOf("'voice-capture-suspend'");
    const list = SERVER.slice(at, SERVER.indexOf("logger.info('voice.capture-suspend'", at));
    assert.match(list, /'playbackWaits'/, 'a field the server allowlist does not name is computed and thrown away (BUG-271/272/273)');
    assert.match(list, /'playbackStalled'/);
  });
});

// THE ECHO COPY — deliberately NOT extended. The ticket's other half says the
// echo filter never has a copy of MYTHOS's words (61 of 62 checks were
// no-reference on 09-24), and the plan proposed keeping the copy until playback
// ends. Replayed first: over 44 scored turns, 3 overlap the previous reply by 60%
// or more and all 3 are the operator's own words; "November" and "Yep, can you
// play" share no words with it. Kept to playback end + 3 s, the copy would have
// caught no echo and dropped the one-word reply below (2.7 s after playback ended).
describe('BUG-455 — the echo copy stays on the arrival clock (disposition, pinned)', () => {
  const { createEchoFilter } = require('../src/core/voice/echo-filter');
  const REPLY = 'Scrolled down a bit. Can you see the videos you want to choose from or should I go further?';

  it('(i) REPLAY 15:11:00 — the operator\'s real "further", 6.4 s after the last audio arrived, is accepted', () => {
    let t = 0;
    const f = createEchoFilter({ now: () => t });
    f.noteSpoken(REPLY);
    f.endUtterance();
    t = 6392; // msSinceAssistantAudio on that echo-check
    const r = f.inspect('further');
    assert.equal(r.matched, false, 'a copy kept until playback end would have eaten this real answer to MYTHOS\'s question');
    assert.equal(r.reason, 'no-reference');
  });

  it('(i2) the cost it avoids is real: inside the window the same word IS dropped as an echo', () => {
    let t = 0;
    const f = createEchoFilter({ now: () => t });
    f.noteSpoken(REPLY);
    f.endUtterance();
    t = 2000;
    assert.equal(f.inspect('further').matched, true);
  });
});
