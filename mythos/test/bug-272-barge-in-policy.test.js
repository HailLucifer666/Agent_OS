'use strict';
// bug-272-barge-in-policy.test.js — the state machine that replaces the RMS-only
// barge-in policy (V1 + V2 + V5).
//
// The numbers in these tests are the ones the 2026-08-17 session actually
// measured, not invented ones: speaker bleed 0.09-0.38 RMS across 46 eager
// releases, against an eager tier of 0.05 and a flush tier of 0.056. Both static
// tiers are underwater, which is why no threshold value is the fix and why the
// fixtures below use real bleed levels rather than convenient small ones.
//
// The module is pure with an injected clock, so this drives real behaviour rather
// than asserting on source shape (which is all s2s-bridge.js can support).
//
// BUG-273 A1 — READ THIS BEFORE TRUSTING THE FLOOR TESTS BELOW. The adaptive floor
// this file describes as the third pillar of slice 3 is DORMANT in production as of
// 2026-08-18. It was measured for the first time that session and it settled at
// 0.1781 against an operator peak of 0.069 — roughly 3x the operator's own voice, so
// nothing could open a candidacy and real barge-ins were held 13.4 seconds. The three
// tests that require the floor to RISE therefore now construct the policy with
// { learnedFloorEnabled: true } explicitly: they still prove the mechanism works as
// designed, which is why it was kept rather than deleted, but they no longer describe
// the shipped default. The default is pinned at INITIAL_BLEED_FLOOR and is covered by
// test/bug-273-bleed-floor-dormant.test.js. The protected window and the sustain test
// — the two parts with evidence behind them — are unchanged and still ship on.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const POLICY_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'barge-in-policy.js')
).href;

// Measured in the operator's room.
const BLEED_QUIET = 0.09;
const BLEED_LOUD = 0.38;
const SPEECH = 0.30;   // sits INSIDE the bleed band — that overlap is the bug

function clock(start) {
  const c = { t: start || 1000 };
  c.now = () => c.t;
  c.advance = (ms) => { c.t += ms; };
  return c;
}

// Feed n frames of 100ms at a constant level, returning every decision.
function feed(policy, c, level, frames, extra) {
  const out = [];
  for (let i = 0; i < frames; i++) {
    out.push(policy.observe(Object.assign({ rms: level }, extra || {})));
    c.advance(100);
  }
  return out;
}

describe('BUG-272 slice 3 — the protected window kills sentence-start self-interruption', () => {
  it('releases nothing during the protected window, however loud the bleed', async () => {
    const { createBargeInPolicy, STATES } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    p.assistantSpeakingStarted();
    assert.equal(p.state(), STATES.PROTECTED);

    // The loudest bleed this room produced, for the whole window.
    const decisions = feed(p, c, BLEED_LOUD, 4); // 400ms < PROTECTED_MS 500
    for (const d of decisions) {
      assert.equal(d.release, false,
        'a release inside the protection window is the 63%-of-turns bug: MYTHOS is loudest at '
        + 'its own sentence onset and no operator has reacted yet');
      assert.equal(d.reason, 'protected-window');
    }
  });

  it('becomes interruptible once the window passes', async () => {
    const { createBargeInPolicy, STATES } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    p.assistantSpeakingStarted();
    feed(p, c, 0.001, 6); // 600ms of near-silence
    assert.equal(p.state(), STATES.INTERRUPTIBLE,
      'protection must EXPIRE — a permanently protected assistant is V2, the 13-second hold');
  });

  it('a mid-sentence audio chunk does not re-protect', async () => {
    const { createBargeInPolicy, STATES } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    p.assistantSpeakingStarted();
    feed(p, c, 0.001, 6);
    // Audio arrives as a stream of chunks; the caller should not have to track
    // which is first. If each one re-armed protection, MYTHOS would be
    // uninterruptible for as long as it kept talking.
    p.assistantSpeakingStarted();
    assert.equal(p.state(), STATES.INTERRUPTIBLE);
  });
});

describe('BUG-272 slice 3 — bleed opens a candidacy, it does not release', () => {
  it('sustained real speech confirms and releases', async () => {
    const { createBargeInPolicy } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    p.assistantSpeakingStarted();
    feed(p, c, 0.001, 6);                 // leave the protected window quietly
    const d = feed(p, c, SPEECH, 6);      // 600ms of continuous speech

    const released = d.filter((x) => x.release);
    assert.equal(released.length, 1, 'exactly one release per barge-in, never a repeat');
    assert.equal(released[0].reason, 'confirmed-sustained');
  });

  it('bleed that decays with the assistant envelope is discarded, not released', async () => {
    const { createBargeInPolicy } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    p.assistantSpeakingStarted();
    feed(p, c, 0.001, 6);

    // Two loud frames then a dip — the signature of speaker bleed tracking
    // MYTHOS's own syllables. Under the old policy 2-3 frames above 0.05 was a
    // release, which is exactly how 46 of these fired.
    const a = feed(p, c, BLEED_LOUD, 2);
    const b = feed(p, c, 0.01, 1);

    assert.ok(a.every((x) => !x.release), 'two loud frames must not be enough on their own');
    assert.equal(b[0].release, false);
    assert.equal(b[0].reason, 'pending-decayed');
  });

  it('real barge-in latency stays well under 700ms', async () => {
    const { createBargeInPolicy } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    p.assistantSpeakingStarted();
    feed(p, c, 0.001, 6);

    const startedAt = c.t;
    let releasedAt = null;
    for (let i = 0; i < 20 && releasedAt === null; i++) {
      if (p.observe({ rms: SPEECH }).release) releasedAt = c.t;
      c.advance(100);
    }
    assert.notEqual(releasedAt, null, 'a sustained interruption must eventually land');
    assert.ok(releasedAt - startedAt <= 500,
      `latency ${releasedAt - startedAt}ms — the pass criterion is under 700ms and V2 was 10-13s`);
  });

  it('an echo transcript outranks the level entirely', async () => {
    const { createBargeInPolicy } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    p.assistantSpeakingStarted();
    feed(p, c, 0.001, 6);

    // Loud AND recognised as MYTHOS's own words. Amplitude cannot separate these
    // in this room; the transcript can.
    const d = feed(p, c, BLEED_LOUD, 6, { echoRatio: 0.95 });
    assert.ok(d.every((x) => !x.release));
    assert.ok(d.some((x) => x.reason === 'echo-transcript'));
  });
});

describe('BUG-272 slice 3 — the adaptive floor is learned from THIS room', () => {
  it('starts at the pre-existing eager tier, so it is never a sensitivity regression', async () => {
    const { createBargeInPolicy, INITIAL_BLEED_FLOOR } = await import(POLICY_URL);
    const p = createBargeInPolicy({ now: clock().now });
    assert.equal(p.bleedFloor(), INITIAL_BLEED_FLOOR);
    assert.equal(INITIAL_BLEED_FLOOR, 0.05, "BUG-271's raised eager tier");
  });

  it('rises above measured bleed — and above the flush tier, which BUG-272 got backwards', async () => {
    const { createBargeInPolicy } = await import(POLICY_URL);
    const c = clock();
    // BUG-273 A1: opt in explicitly. This asserts the MECHANISM, not the default —
    // the default is dormant because in the operator's room this floor rose above the
    // operator too. Kept because one room is not a sample.
    const p = createBargeInPolicy({ now: c.now, learnedFloorEnabled: true, bleedMargin: 1.45 });

    p.assistantSpeakingStarted();
    feed(p, c, BLEED_QUIET, 6);

    const floor = p.bleedFloor();
    assert.ok(floor > BLEED_QUIET,
      `the learned floor (${floor}) must clear the bleed that taught it (${BLEED_QUIET})`);
    // BUG-272's spec said "clamped below the flush tier (0.056)". Against this
    // room's real numbers that clamp is inverted: bleed is ABOVE 0.056, so a
    // floor pinned below it would be crossed on nearly every frame and would
    // rebuild V1. This asserts the correction deliberately.
    assert.ok(floor > 0.056,
      'a floor clamped below the flush tier cannot separate 0.09-0.38 bleed from anything');
  });

  it('is bounded, so a pathological measurement cannot make MYTHOS deaf', async () => {
    const { createBargeInPolicy, MAX_BLEED_FLOOR } = await import(POLICY_URL);
    const c = clock();
    // BUG-273 A1: the bound only means anything while learning is on, so opt in.
    const p = createBargeInPolicy({ now: c.now, learnedFloorEnabled: true, bleedMargin: 1.45 });

    p.assistantSpeakingStarted();
    feed(p, c, 0.99, 4); // absurd — a clipped frame, or a mic fault

    assert.equal(p.bleedFloor(), MAX_BLEED_FLOOR,
      'unbounded learning would end in an assistant that can never be interrupted; deafness '
      + 'and self-interruption are both failures and this one fails toward hearing the operator');
  });

  it('remembers the room across turns but forgets it across sessions', async () => {
    const { createBargeInPolicy, INITIAL_BLEED_FLOOR } = await import(POLICY_URL);
    const c = clock();
    // BUG-273 A1: this one still PASSED with learning dormant, and that is worse than
    // failing — every assertion compared INITIAL_BLEED_FLOOR to itself, so it proved
    // nothing about remembering or forgetting. Opted in so it keeps testing what it
    // was written to test.
    const p = createBargeInPolicy({ now: c.now, learnedFloorEnabled: true, bleedMargin: 1.45 });

    p.assistantSpeakingStarted();
    feed(p, c, BLEED_LOUD, 6);
    const learned = p.bleedFloor();

    p.reset();
    assert.equal(p.bleedFloor(), learned,
      'speaker volume is a property of the room, not of one turn — re-learning from zero every '
      + 'turn would put the floor back at the static tier for exactly the frames where '
      + 'self-interruption happens');

    p.forgetRoom();
    assert.equal(p.bleedFloor(), INITIAL_BLEED_FLOOR, 'a new session may be a new room');
  });
});

describe('BUG-272 slice 3 — the ceiling decides instead of blindly failing open', () => {
  it('echo-like at the ceiling drops rather than interrupting', async () => {
    const { createBargeInPolicy } = await import(POLICY_URL);
    const p = createBargeInPolicy({ now: clock().now });
    const d = p.ceilingDecision({ echoRatio: 0.9, hasTranscript: true, peakRms: 0.3 });
    assert.equal(d.release, false);
    assert.equal(d.reason, 'ceiling-echo-like');
  });

  it('a transcript with no echo match is the operator', async () => {
    const { createBargeInPolicy } = await import(POLICY_URL);
    const p = createBargeInPolicy({ now: clock().now });
    const d = p.ceilingDecision({ echoRatio: 0.1, hasTranscript: true, peakRms: 0.3 });
    assert.equal(d.release, true);
    assert.equal(d.reason, 'ceiling-user-like');
  });

  it('strong energy with no transcript interrupts', async () => {
    const { createBargeInPolicy } = await import(POLICY_URL);
    const p = createBargeInPolicy({ now: clock().now });
    const d = p.ceilingDecision({ hasTranscript: false, peakRms: 0.3 });
    assert.equal(d.release, true);
    assert.equal(d.reason, 'ceiling-near-field-energy');
  });

  // Q5/Q8: the bias is stated in code and pinned here. With no evidence either
  // way the ceiling releases, because a wrongly-interrupted assistant is
  // recoverable in one sentence and a swallowed operator utterance is not. This
  // matches the codebase's existing position at the other fail-open ("a deaf
  // assistant is the worse failure").
  it('no evidence at all still releases — the bias is deliberate', async () => {
    const { createBargeInPolicy } = await import(POLICY_URL);
    const p = createBargeInPolicy({ now: clock().now });
    const d = p.ceilingDecision({});
    assert.equal(d.release, true);
    assert.equal(d.reason, 'ceiling-no-evidence-of-echo');
  });
});

describe('BUG-272 slice 3 — when MYTHOS is silent the policy is inert', () => {
  it('never releases while idle, at any level', async () => {
    const { createBargeInPolicy, STATES } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    const d = feed(p, c, BLEED_LOUD, 5);
    assert.equal(p.state(), STATES.IDLE);
    assert.ok(d.every((x) => !x.release && x.reason === 'not-speaking'),
      'there is no gate to release when nothing is speaking — a release here would be '
      + 'meaningless and would confuse the caller into flushing a ring it never filled');
  });

  it('speech ending returns to idle and clears any candidacy', async () => {
    const { createBargeInPolicy, STATES } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    p.assistantSpeakingStarted();
    feed(p, c, 0.001, 6);
    feed(p, c, SPEECH, 1); // opens PENDING
    p.assistantSpeakingEnded();

    assert.equal(p.state(), STATES.IDLE);
    assert.equal(p.observe({ rms: SPEECH }).reason, 'not-speaking');
  });
});

describe('BUG-272 slice 3 — the adaptive floor must not be poisoned by the operator', () => {
  // Regression for a defect in the FIRST version of this module, caught by the
  // sustained-speech test releasing 0 times. bleedPeak updated from every frame
  // heard while MYTHOS spoke, "to bias the floor upward safely" — so the
  // operator's own voice raised the floor above itself and no barge-in could
  // ever confirm. A detector destroyed by the signal it exists to distinguish.
  //
  // The invariant: sustained speech ABOVE the current floor must confirm, no
  // matter how loud it is. Louder speech confirming less easily is the signature
  // of the bug.
  it('louder operator speech does not become harder to confirm', async () => {
    const { createBargeInPolicy } = await import(POLICY_URL);

    for (const level of [0.10, 0.30, 0.60, 0.95]) {
      const c = clock();
      const p = createBargeInPolicy({ now: c.now });
      p.assistantSpeakingStarted();
      feed(p, c, 0.001, 6); // quiet room: floor stays at the initial tier

      const released = feed(p, c, level, 8).filter((x) => x.release);
      assert.equal(released.length, 1,
        `speech at ${level} must confirm exactly once; if a louder voice fails to release, the `
        + 'floor is learning from the operator instead of from the bleed');
    }
  });

  it('the floor does not move while the operator is talking over MYTHOS', async () => {
    const { createBargeInPolicy } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    p.assistantSpeakingStarted();
    feed(p, c, 0.001, 6);
    const before = p.bleedFloor();
    feed(p, c, 0.95, 8); // the operator, loudly
    assert.equal(p.bleedFloor(), before,
      'only the protected window and echo-confirmed frames may teach the floor');
  });
});

describe('BUG-272 slice 3 — the policy is actually wired into s2s-bridge.js', () => {
  const fs = require('fs');
  const src = () => fs.readFileSync(
    path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 's2s-bridge.js'), 'utf8'
  ).replace(/\r\n/g, '\n');

  it('imports and constructs the policy', () => {
    const s = src();
    assert.match(s, /import\s*\{[^}]*createBargeInPolicy[^}]*\}\s*from\s*'\.\/barge-in-policy\.js'/,
      'no build step in this repo — the import path is the exact path the browser fetches');
    assert.match(s, /createBargeInPolicy\(policyTuning\(\)\)/,
      'constructed WITH its localStorage overrides, so the operator keeps an escape hatch');
  });

  // The ordering bug this pins is invisible to the pure module's own tests, and
  // it is a one-line mistake: bargeBackstop.observe() invokes onFlush/onRelease
  // SYNCHRONOUSLY, and those callbacks read policyAllowsRelease. If the policy
  // observed the frame after the backstop, every release would be decided by the
  // previous frame's verdict.
  it('the policy sees each frame BEFORE the backstop callbacks can fire', () => {
    const s = src();
    const start = s.indexOf('captureNode.port.onmessage');
    assert.notEqual(start, -1);
    const body = s.slice(start, start + 4200);
    // Match the CALL forms, not the names. The first attempt used bare
    // indexOf('bargeBackstop.observe'), which matched the explanatory COMMENT
    // above the policy call and reported the order as reversed on correct code —
    // the same "your detector catches what you did not mean" failure this
    // codebase keeps paying for. Anchor on the argument list.
    const policyAt = body.indexOf('bargePolicy.observe({');
    const backstopAt = body.indexOf('bargeBackstop.observe(e.data');
    assert.ok(policyAt !== -1 && backstopAt !== -1, 'both observers must run on the frame');
    assert.ok(policyAt < backstopAt,
      'policy first: the backstop fires its callbacks synchronously and they read the '
      + 'policy verdict, so observing second would decide every release one frame late');
  });

  it('BOTH backstop tiers are vetoed, including the flush that stops playback', () => {
    const s = src();
    const ctor = s.slice(s.indexOf('createBargeInBackstop({'), s.indexOf('\n  });', s.indexOf('createBargeInBackstop({')));
    const flush = ctor.slice(ctor.indexOf('onFlush:'), ctor.indexOf('onRelease:'));
    const release = ctor.slice(ctor.indexOf('onRelease:'));
    assert.match(flush, /policyAllowsRelease/,
      'bleed clears the FLUSH tier too (0.056 vs 0.09-0.38), and flushing on bleed is what '
      + "cut MYTHOS's own audio mid-word — vetoing only the release keeps the audible half "
      + 'of the bug');
    assert.match(release, /policyAllowsRelease/, 'the eager tier must be vetoed too');
    // The veto must be observable. A gate that quietly stopped releasing is
    // indistinguishable from a dead microphone.
    assert.match(ctor, /noteBargeVetoed/, 'a vetoed barge-in must be counted, never silent');
    assert.match(s, /bargeVetoed: bargeVetoed/, 'and reported on the transition log line');
  });

  it('the protection window opens on hold and closes on release', () => {
    const s = src();
    const hold = s.slice(s.indexOf('function holdOwnVoiceGate'), s.indexOf('function releaseOwnVoiceGate'));
    assert.match(hold, /bargePolicy\.assistantSpeakingStarted\(\)/,
      'holdOwnVoiceGate is the only place that knows MYTHOS just started speaking');
    const rel = s.slice(s.indexOf('function releaseOwnVoiceGate'));
    assert.match(rel.slice(0, 1200), /bargePolicy\.assistantSpeakingEnded\(\)/,
      'and the release is where it stops making decisions');
  });

  it('the two ceilings no longer share one reason string', () => {
    const s = src();
    assert.match(s, /suspend-ceiling-fail-open/,
      'the media/TTS suspend ceiling needs its own label — BUG-272 counted 16 '
      + "'ceiling-fail-open' events that could not be attributed to either timer");
    assert.match(s, /bargePolicy\.ceilingDecision/,
      'and the own-voice ceiling decides from what it knows instead of failing open blind');
  });

  it('the operator keeps a documented way back to the old behaviour', () => {
    const s = src();
    assert.match(s, /MYTHOS_BARGE_PROTECTED_MS/,
      'if the protection window ever reads as MYTHOS ignoring an interruption, the operator '
      + 'must be able to switch it off mid-session without a code change');
    assert.match(s, /MYTHOS_LIVE_HALF_DUPLEX/, 'and the whole-gate kill switch must survive');
  });
});
