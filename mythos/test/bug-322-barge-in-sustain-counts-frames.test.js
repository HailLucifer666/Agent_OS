'use strict';

// test/bug-322-barge-in-sustain-counts-frames.test.js
//
// THE OPERATOR'S REPORT, 2026-08-22: "I had to shout and still it did not stop
// telling." Root-caused from %APPDATA%/MYTHOS/mythos-server.log, scoped to that
// day's session (74 own-voice holds, 101 live turns).
//
// WHAT THE LOG SAYS. Thirteen barge-in attempts were refused. Not one of them was
// refused for being too quiet — there is not a single 'below-bleed-floor' veto in
// the whole day. Seven were refused as 'pending-sustaining', at these levels:
//
//     0.3942  0.3655  0.1900  0.1671  0.1260  0.0824  0.0713
//
// against a floor of 0.035 and a room whose loudest measured bleed all day was
// 0.1641. The top two are more than DOUBLE the loudest sound MYTHOS's own speaker
// has ever produced in this room, and ten times the floor. They cannot be bleed.
// They were the operator, and the policy refused them for not lasting long enough.
//
// WHY THE SUSTAIN NEVER COMPLETED — two counters that measure different things.
//
//   barge-in-policy.js  measures its 200ms sustain in WALL-CLOCK time:
//                       `t - pendingSince >= pendingHoldMs`, where t is now().
//
//   the capture path     counts FRAMES. pcm-capture-worklet.js fills a 100ms
//                        buffer and postMessage()s it; the main thread runs the
//                        handler whenever it next gets a turn.
//
// Those agree only while the main thread keeps up. It does not have to: while
// MYTHOS is speaking, that same thread is decoding and playing audio, and a
// postMessage backlog is delivered as a burst in one task-loop turn. Every frame
// in that burst carries 100ms of real speech and advances now() by almost nothing,
// so `t - pendingSince` crawls while the audio flies past. The candidacy stays in
// PENDING; the backstop, which counts frames, fires on its 3rd, 6th, 9th and is
// vetoed each time with reason 'pending-sustaining'. The log's veto counts of 2, 3
// and 4 per hold are that shape exactly.
//
// Q6 — WHAT CLASS IS THIS AN INSTANCE OF? The same one as BUG-274: two independent
// counters required to coincide, one counting frames and one counting milliseconds.
// BUG-274 fixed the delivery side of it. This is the measurement side, and it was
// already predicted — bug-274-barge-in-authorisation-is-deliverable.test.js records
// "PENDING resets ... 350ms is never reached" as a known-failing shape, deferred
// with an explicit instruction to bring a measurement rather than a guess. The
// measurement is above.
//
// WHAT THE FIX IS NOT. It does not lower the sustain, widen the floor, shorten the
// protected window or touch either backstop tier. PENDING_HOLD_MS stays at 200ms
// and keeps meaning 200ms of speech. The only change is that 200ms of speech is
// counted the way the audio actually arrives — in frames — as well as on the clock,
// so a busy main thread can no longer make a shout look brief. Under unbroken
// real-time delivery the two are arithmetically identical, which the second test
// below pins.
//
// THE COUNTER-FAILURE, asserted rather than hoped for. Self-interruption is the
// opposite failure and the one this repo has walked into twice. Frame-counting
// cannot cause it: the decay rule is untouched, so bleed that dips below the floor
// still kills its candidacy on the very next frame, batched or not. Tests 3 and 4
// hold that line.
//
// PROVEN BY BREAKING IT. Five mutations of barge-in-policy.js, restored
// byte-identical and verified by hash afterwards:
//   M1  sustain measured on the clock alone (the pre-fix code)   -> test 1 fails
//   M2  count the opening frame as already sustained (off-by-one) -> tests 2-4 fail
//   M3  frameMs inflated to 1000, one frame = a whole second      -> tests 2-4 fail
//   M5  a below-floor frame no longer leaves PENDING              -> test 4 fails
//
//   M4  delete `pendingFrames = 0` from the decay branch          -> SURVIVES, and
//       that is correct. It is an equivalent mutant: the INTERRUPTIBLE branch
//       assigns pendingFrames = 1 when it re-opens a candidacy, so the decay
//       branch's reset can only ever change the pendingFrames value REPORTED on
//       the decay frame itself. Nothing reads that field — it is returned by
//       decision() and no caller or log line consumes it — so no assertion was
//       added to pin it. Guarding a field nobody reads is how a test starts
//       measuring itself. The assignment is left in place as harmless defensive
//       code; it is simply not load-bearing, and now that is written down instead
//       of being rediscovered by the next person who mutates this file.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const { pathToFileURL } = require('url');

const POLICY_PATH = path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'barge-in-policy.js');
const BRIDGE_PATH = path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 's2s-bridge.js');
const POLICY_URL = pathToFileURL(POLICY_PATH).href;

// Levels straight out of the 2026-08-22 log rather than invented for the test.
const OPERATOR_SHOUT = 0.3655;  // vetoed 'pending-sustaining' in the real session
const ROOM_BLEED_PEAK = 0.1641; // the loudest bleed measured that day
const BELOW_FLOOR = 0.02;       // under INITIAL_BLEED_FLOOR (0.035), a syllable gap

// A clock the test drives by hand, so "how much wall time passed" and "how many
// frames arrived" can be varied independently — which is the whole point.
function clock(start) {
  const c = { t: start || 1000 };
  c.now = () => c.t;
  c.advance = (ms) => { c.t += ms; };
  return c;
}

// Feed one 100ms frame of audio and advance the clock by `wallMs`.
//
// wallMs === 100 is the healthy case: audio time and wall time run together.
// wallMs < 100 is a delivery burst — the frames were captured 100ms apart and
// handed to the main thread late, all at once. That is the condition under test
// and it is not hypothetical: it is what a postMessage backlog looks like.
function feed(policy, c, level, frames, wallMs) {
  const out = [];
  for (let i = 0; i < frames; i++) {
    out.push(policy.observe({ rms: level }));
    c.advance(wallMs === undefined ? 100 : wallMs);
  }
  return out;
}

// Get past the 500ms protected window with the room quiet, exactly as a real hold
// does. Uses honest real-time delivery so no test starts from a distorted state.
function leaveProtectedWindow(policy, c) {
  policy.assistantSpeakingStarted();
  feed(policy, c, 0.001, 6);   // 600ms of near-silence at true 100ms cadence
}

describe('BUG-322 — a shout refused for "not lasting long enough"', () => {
  it('authorises a sustained shout even when frames arrive faster than the clock', async () => {
    const { createBargeInPolicy } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    leaveProtectedWindow(p, c);

    // The burst: ten frames of genuine speech — a full second of the operator
    // shouting — delivered while the janked main thread advances only 10ms per
    // frame. Every frame is real captured audio; only the delivery is late.
    const decisions = feed(p, c, OPERATOR_SHOUT, 10, 10);
    const released = decisions.findIndex((d) => d.release);

    assert.notEqual(released, -1,
      'a full second of speech at ' + OPERATOR_SHOUT + ' — ten times the 0.035 floor and '
      + 'more than double this room\'s loudest measured bleed (' + ROOM_BLEED_PEAK + ') — was '
      + 'never authorised. Reasons seen: '
      + JSON.stringify(decisions.map((d) => d.reason))
      + '. This is the operator shouting and being refused, which is the reported bug.');

    // 200ms of sustain is 200ms of AUDIO: the candidacy opens on frame 1 and the
    // third frame is the one carrying the 200th millisecond. Asserting the exact
    // frame keeps this honest — a fix that simply released earlier would be a
    // retune of PENDING_HOLD_MS wearing a different hat, and would fail here.
    assert.equal(released, 2,
      'expected authorisation on the third frame of the candidacy (200ms of audio). '
      + 'Earlier means the sustain requirement was weakened, not re-counted.');
  });

  it('still takes exactly 200ms of audio when delivery is healthy', async () => {
    // The no-regression half. With frames arriving at their true 100ms cadence the
    // frame count and the clock agree, so this must behave precisely as it did
    // before — same frame, same reasons, nothing loosened.
    const { createBargeInPolicy } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    leaveProtectedWindow(p, c);
    const decisions = feed(p, c, OPERATOR_SHOUT, 6, 100);

    assert.equal(decisions.findIndex((d) => d.release), 2,
      'under real-time delivery the sustain must land on the same frame it always has');
    assert.deepEqual(decisions.slice(0, 3).map((d) => d.reason),
      ['pending-opened', 'pending-sustaining', 'confirmed-sustained'],
      'the state sequence itself must be unchanged, not merely the outcome');
  });

  it('a candidacy shorter than the sustain is still refused, however it is delivered', async () => {
    // The obvious way to "fix" this bug is to count frames but forget to require
    // enough of them. Two frames is 100ms of audio and must not be believed, in a
    // burst just as much as in real time.
    const { createBargeInPolicy } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    leaveProtectedWindow(p, c);
    const decisions = feed(p, c, OPERATOR_SHOUT, 2, 10);

    assert.deepEqual(decisions.map((d) => d.release), [false, false],
      '100ms of audio is not 200ms of audio, and a delivery burst must not make it so');
  });

  it('bleed that dips below the floor is still killed on the next frame, burst or not', async () => {
    // THE COUNTER-FAILURE. Self-interruption is what this repo has twice traded
    // one bug for, so the discriminator that rejects bleed has to survive the fix.
    // Bleed follows MYTHOS's own amplitude envelope and drops between its
    // syllables; that decay rule is untouched here, and this proves it — even
    // under the same burst delivery that the first test exploits.
    const { createBargeInPolicy } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    leaveProtectedWindow(p, c);

    // Two loud frames open and build a candidacy, then the envelope drops.
    const rising = feed(p, c, ROOM_BLEED_PEAK, 2, 10);
    const dip = feed(p, c, BELOW_FLOOR, 1, 10);
    // ...and comes back up. The candidacy must have been reset by the dip, so this
    // run has to earn its 200ms from scratch rather than inheriting the old one.
    const again = feed(p, c, ROOM_BLEED_PEAK, 2, 10);

    assert.deepEqual(rising.map((d) => d.release), [false, false],
      'two frames must not authorise on their own');
    assert.equal(dip[0].reason, 'pending-decayed',
      'a frame below the floor must kill the candidacy — this is the bleed discriminator');
    assert.deepEqual(again.map((d) => d.release), [false, false],
      'after a decay the frame count must restart from zero, otherwise bleed accumulates '
      + 'across its own silences and eventually authorises itself — which is V1, the '
      + '63%-self-interruption failure, rebuilt out of the fix for the opposite bug');
  });

  it('the protected window is not bypassed by a burst', async () => {
    // PROTECTED_MS is wall-clock by design and must stay that way: it exists
    // because MYTHOS's own onset is the loudest thing in the room and no operator
    // has had time to react yet. Frame-counting the sustain must not leak into it.
    const { createBargeInPolicy } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    p.assistantSpeakingStarted();
    const decisions = feed(p, c, OPERATOR_SHOUT, 10, 10);   // 100ms of wall time total

    assert.deepEqual(decisions.map((d) => d.release), new Array(10).fill(false),
      'nothing may release inside the protected window, whatever the level');
    assert.ok(decisions.every((d) => d.reason === 'protected-window'),
      'and every refusal there must say so: ' + JSON.stringify(decisions.map((d) => d.reason)));
  });

  it('the frame size the policy counts with matches the frame size the mic is chopped into', async () => {
    // THE DRIFT GUARD, and the reason this fix needs one at all.
    //
    // The sustain is now measured in frames, so FRAME_MS is load-bearing: if the
    // policy believes a frame is 100ms while the capture worklet is producing 20ms
    // frames, the sustain silently becomes 40ms and bleed starts authorising
    // itself. The number therefore has to be the same in both places.
    //
    // ONE SHARED CONSTANT WOULD NORMALLY BEAT TWO THAT AGREE, and it was tried:
    // export FRAME_MS from the policy, import it into s2s-bridge.js, delete the
    // duplicate. That breaks s2s-preroll-ring.test.js, which reads the bridge as
    // TEXT and matches `FRAME_MS = <digits>` to prove the preroll ring is derived
    // from the frame size rather than hand-tuned. s2s-bridge.js is a browser ES
    // module with no Node double (see ui/CLAUDE.md), so source-shape assertions are
    // the only tool available against it, and moving a constant out of the file
    // blinds them. That invariant is worth more than removing a duplicated literal,
    // so the duplicate stays and this test makes drift impossible to do quietly.
    const { FRAME_MS } = await import(POLICY_URL);
    const bridgeSrc = fs.readFileSync(BRIDGE_PATH, 'utf8');
    const m = bridgeSrc.match(/const FRAME_MS\s*=\s*(\d+)\s*;/);

    assert.ok(m, 's2s-bridge.js must still declare FRAME_MS as a literal — s2s-preroll-ring.test.js '
      + 'reads it as text to prove the preroll ring is derived from it, and so does this guard');
    assert.equal(Number(m[1]), FRAME_MS,
      'the capture worklet is built with s2s-bridge.js\'s FRAME_MS (' + m[1] + 'ms) while the '
      + 'barge-in policy counts its sustain in ' + FRAME_MS + 'ms frames. They must be equal: a '
      + 'mismatch scales the 200ms sustain by the ratio between them, in whichever direction — '
      + 'too short and bleed authorises itself, too long and the operator is refused again.');
  });
});
