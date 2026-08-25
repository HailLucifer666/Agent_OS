'use strict';
// bug-273-bleed-floor-dormant.test.js — BUG-273 A1.
//
// THE MEASUREMENT. The 2026-08-18 live session is the first real reading of
// BUG-272 slice 3's adaptive floor, and it says the adaptive half is harmful:
//
//   learned bleedFloor          0.1781
//   operator speech peakRms     0.0395 - 0.069
//   bargeVetoed                 49
//   framesDropped               0
//   max own-voice hold          13,396 ms
//
// The floor settled roughly 3x above the operator's own voice, so no frame ever
// opened a candidacy, every hold ran to its idle ceiling, and real barge-ins
// arrived 11-13 seconds late. framesDropped 0 says nothing was lost — it was all
// LATE. That is V2, the failure BUG-272 was written to remove, reached from the
// opposite side: BUG-272 argued correctly that no static threshold separates
// overlapping bleed and speech, then shipped a learned threshold, which has the
// same defect the moment bleed is the LOUDER of the two. In this room it is.
//
// Q5/Q8 — what this file pins. The mechanism is dormant, not deleted: one room is
// not a sample, and the parts of slice 3 with evidence behind them (the 500ms
// protected window, the 350ms sustain test) are untouched. So there are two
// invariants here, and both matter:
//   1. by DEFAULT the floor in force is INITIAL_BLEED_FLOOR, whatever the room
//      bleeds, and the session's own numbers now produce a release;
//   2. the learning still RUNS and still REPORTS (learnedFloor/bleedPeak), and
//      re-enabling it restores BUG-272's behaviour exactly — so the escape hatch
//      is real and the next session can still judge the mechanism on data.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const POLICY_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'barge-in-policy.js')
).href;

// Measured 2026-08-18, in the operator's room, by the code under test.
const BLEED_PEAK = 0.123;      // what the room bled during assistant speech
const OPERATOR_LOUD = 0.069;   // the operator's loudest measured turn
const OPERATOR_QUIET = 0.0395; // the operator's quietest measured turn
const LEARNED_1_45 = 0.1781;   // the floor slice 3 actually settled on

function clock(start) {
  const c = { t: start || 1000 };
  c.now = () => c.t;
  c.advance = (ms) => { c.t += ms; };
  return c;
}

function feed(policy, c, level, frames, extra) {
  const out = [];
  for (let i = 0; i < frames; i++) {
    out.push(policy.observe(Object.assign({ rms: level }, extra || {})));
    c.advance(100);
  }
  return out;
}

// Teach the room its bleed the only way the policy allows — inside the protected
// window, where no release is possible and the assistant's onset is by
// construction the loudest thing present. Then leave the window.
function teachRoomAndLeaveWindow(p, c, bleed) {
  p.assistantSpeakingStarted();
  feed(p, c, bleed, 5);      // 500ms == PROTECTED_MS, learning happens here
  feed(p, c, 0.001, 2);      // out of the window, quietly
}

describe('BUG-273 A1 — the adaptive floor is dormant by default', () => {
  it('the floor in force stays at the initial tier however loud the room bleeds', async () => {
    const { createBargeInPolicy, INITIAL_BLEED_FLOOR } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    teachRoomAndLeaveWindow(p, c, BLEED_PEAK);

    assert.equal(p.bleedFloor(), INITIAL_BLEED_FLOOR,
      'a floor learned from bleed louder than the operator can only be deaf');
    assert.ok(p.bleedFloor() < LEARNED_1_45,
      `the shipped floor must be below the ${LEARNED_1_45} that held real barge-ins for 13.4s`);
  });

  it("the operator's loudest measured turn now releases — the 13.4-second hold, gone", async () => {
    const { createBargeInPolicy } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    teachRoomAndLeaveWindow(p, c, BLEED_PEAK);

    const startedAt = c.t;
    const d = feed(p, c, OPERATOR_LOUD, 8);
    // BUG-274: counts the CONFIRMATION transition, not authorised frames. This test's
    // invariants — the loudest turn releases, and it releases inside 700ms — are both
    // unchanged and both still asserted below. What changed is that CONFIRMED keeps
    // answering yes while MYTHOS is still speaking, because the caller that acts on the
    // answer only fires every third frame and a one-frame-wide yes reached it by
    // coincidence. See test/bug-274-barge-in-authorisation-is-deliverable.test.js.
    const released = d.filter((x) => x.release);
    const confirmations = d.filter((x) => x.reason === 'confirmed-sustained');
    assert.equal(confirmations.length, 1,
      'this is the session: 49 vetoes, 0 frames dropped, everything arriving 11-13s late');
    assert.equal(released[0].reason, 'confirmed-sustained');
    const latency = (startedAt + (d.indexOf(released[0]) + 1) * 100) - startedAt;
    assert.ok(latency <= 700,
      `latency ${latency}ms — the BUG-273 target is under 2000ms and the session measured 13,396ms`);
  });

  it('the QUIETEST measured turn NOW releases — the tripwire below fired and the numbers arrived', async () => {
    const { createBargeInPolicy, INITIAL_BLEED_FLOOR } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    teachRoomAndLeaveWindow(p, c, BLEED_PEAK);

    // THIS TEST WAS A TRIPWIRE AND IT FIRED AS DESIGNED. Its previous assertion was
    // that OPERATOR_QUIET (0.0395) does NOT release, with the message "if this ever
    // starts releasing, the tier was lowered — BUG-273 A2 must have the numbers".
    // BUG-274 lowered the tier 0.05 -> 0.035 on 2026-08-19, and A2's open question —
    // "what actually reaches Gemini during a hold" — is the very thing that got
    // answered, so the condition it set is satisfied rather than overridden:
    //
    //   * `raw` on the live capture-suspend lines showed 34-54 frames (3.4-5.4s) of the
    //     operator's speech passing the noise gate and reaching the model DURING holds,
    //     with Gemini returning transcripts of 7-106 words for those same turns. So
    //     MYTHOS was hearing the interruption and continuing to speak.
    //   * The decisive hold peaked at 0.0480 against the 0.05 floor — refused by 0.002.
    //   * Clean bleed measured 0.0031-0.0309 with AEC3 confirmed granted, i.e. a full
    //     order of magnitude below the 0.09-0.38 the 0.05 floor was chosen against.
    //   * The 0.05 floor was ALSO 2.5x the noise gate's own 0.02 "this is the operator"
    //     threshold, so a band existed where speech was transmitted but invisible here.
    //
    // The floor now sits between the two measured populations, so the quiet end that
    // this test existed to flag as unreachable IS reachable. The honest remaining limit
    // moved rather than vanished: holds at 0.0242/0.0245 sit inside the bleed range and
    // no scalar floor separates them — that limit is pinned in
    // test/bug-274-barge-in-floor-separates-populations.test.js against measured audio.
    assert.ok(OPERATOR_QUIET > INITIAL_BLEED_FLOOR,
      `0.0395 must now clear the floor (${INITIAL_BLEED_FLOOR}); if it does not, the floor went `
      + 'back up and the interruption this unblocked is blocked again');
    const d = feed(p, c, OPERATOR_QUIET, 8);
    assert.equal(d.filter((x) => x.reason === 'confirmed-sustained').length, 1,
      'the quiet end of measured operator speech must now confirm exactly once');
  });

  it('the learning still runs and still reports, so the mechanism can be judged later', async () => {
    const { createBargeInPolicy, BLEED_MARGIN } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    teachRoomAndLeaveWindow(p, c, BLEED_PEAK);

    // Q2: pinning the floor must not blind the next session. bleedPeak is what the
    // room bleeds; learnedFloor is the floor that WOULD be in force. s2s-bridge.js
    // reports both on the suspend line and verify-voice-session.js prints them.
    assert.ok(Math.abs(p.bleedPeak() - BLEED_PEAK) < 1e-9,
      'the measurement must keep running while it decides nothing');
    assert.ok(p.learnedFloor() >= BLEED_PEAK * BLEED_MARGIN - 1e-9,
      'and it must keep reporting what it would have chosen');
    assert.notEqual(p.learnedFloor(), p.bleedFloor(),
      'the two numbers are different facts and must not be conflated again');
  });

  it('re-enabling it restores BUG-272 behaviour exactly — the escape hatch is real', async () => {
    const { createBargeInPolicy } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now, learnedFloorEnabled: true, bleedMargin: 1.45 });

    teachRoomAndLeaveWindow(p, c, BLEED_PEAK);

    // The exact floor the session settled on, from the exact inputs.
    assert.ok(Math.abs(p.bleedFloor() - LEARNED_1_45) < 0.0005,
      `re-enabled with the old margin this must reproduce ${LEARNED_1_45}, or the opt-in is not the old code`);
    assert.equal(feed(p, c, OPERATOR_LOUD, 8).filter((x) => x.release).length, 0,
      'and it must reproduce the failure too — that is what makes it a real escape hatch');
  });

  it('the default margin no longer adds headroom to the reported floor', async () => {
    const { BLEED_MARGIN, LEARNED_FLOOR_ENABLED } = await import(POLICY_URL);
    assert.equal(LEARNED_FLOOR_ENABLED, false, 'flipping this back needs a room and numbers in the commit');
    assert.equal(BLEED_MARGIN, 1.0,
      'with learning dormant the reported learnedFloor should be the raw measured bleed peak, '
      + 'which is the number BUG-273 A2 needs — 1.45 was headroom for a decision no longer being made');
  });
});

describe('BUG-273 A1 — the bridge keeps the dormant measurement visible', () => {
  const fs = require('fs');
  const src = () => fs.readFileSync(
    path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 's2s-bridge.js'), 'utf8'
  ).replace(/\r\n/g, '\n');

  it('reports bleedPeak and learnedFloor next to the floor in force', () => {
    const s = src();
    assert.match(s, /bleedPeak: Math\.round\(bargePolicy\.bleedPeak\(\)/,
      'Q2: with the floor pinned at 0.05, bleedFloor alone says nothing about the room');
    assert.match(s, /learnedFloor: Math\.round\(bargePolicy\.learnedFloor\(\)/,
      'and nothing about what the mechanism would have chosen');
    assert.match(s, /bleedFloor: Math\.round\(bargePolicy\.bleedFloor\(\)/,
      'the floor in force must still be reported — it is what actually gated the session');
  });

  it('the operator can turn the learned floor back ON without a code change', () => {
    const s = src();
    assert.match(s, /MYTHOS_BARGE_LEARNED_FLOOR/,
      'every other override in policyTuning() exists to switch something off; this one is the '
      + 'way back on, and a dormant mechanism with no runtime switch is a deleted one');
    assert.match(s, /t\.learnedFloorEnabled = /,
      'and it must reach the policy as the option the policy actually reads');
  });
});
