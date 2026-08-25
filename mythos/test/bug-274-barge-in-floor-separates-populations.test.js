'use strict';

// bug-274-barge-in-floor-separates-populations.test.js — the barge-in floor asserted
// against MEASURED AUDIO, not against itself.
//
// WHY THIS FILE EXISTS. A test that reads `INITIAL_BLEED_FLOOR` and asserts something
// about `INITIAL_BLEED_FLOOR` is a tautology: it passes for every value and so protects
// nothing. This ticket's whole thesis is that mechanisms which look like coverage and do
// nothing are why the backlog regenerates. So the numbers below are the levels the
// operator's own microphone produced on 2026-08-19, read out of
// `voice.capture-suspend`, and the assertion is that the floor SEPARATES them. Change
// the floor to a value that fails to separate these two populations and this file fails.
//
// THE FINDING THIS PINS. The repo had two floors 2.5x apart answering the same question:
//   live-noise-gate.js  0.02  — "the operator is speaking, send it to Gemini"
//   barge-in-policy.js  0.05  — "the operator is speaking, stop talking"
// Between them lay a band where the operator was audible, transmitted, transcribed and
// answered, while barge-in recorded nothing at all. MYTHOS heard the interruption and
// carried on. The decisive hold: peak 0.0480 against the 0.05 floor — refused by 0.002 —
// with 34 frames (3.4s) of the operator's speech reaching the model in the same hold.
//
// WHAT THIS FILE DOES *NOT* CLAIM. That every interruption is now separable. Two
// measured holds sit at 0.0242 and 0.0245 — inside the bleed range — and no scalar floor
// can distinguish those from the room without also firing on MYTHOS's own voice. They
// are recorded below as the honest limit rather than quietly excluded.
//
// Run: cd mythos && node --test test/bug-274-barge-in-floor-separates-populations.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const voiceDir = path.join(__dirname, '..', 'ui', 'public', 'js', 'voice');
const POLICY_URL = pathToFileURL(path.join(voiceDir, 'barge-in-policy.js')).href;
const GATE_URL = pathToFileURL(path.join(voiceDir, 'live-noise-gate.js')).href;

// --- MEASURED 2026-08-19, live session, from voice.capture-suspend -----------------
//
// Room bleed with AEC3 confirmed on and the operator silent. CLEAN readings only: the
// 0.1041 and 0.1236 values from the same session are EXCLUDED because bleedPeak learns
// inside the protected window and had learned the operator's own voice — the poisoning
// recorded in BUGS.md. Including them would let the operator's voice argue for a floor
// above the operator's voice, which is the self-poisoning failure this repo already hit.
const BLEED_CLEAN = [0.0031, 0.0186, 0.0214, 0.0232, 0.0309];

// Levels at which the operator actually interrupted and was IGNORED or refused.
const OPERATOR_INTERRUPTIONS = [0.0398, 0.0480, 0.0598, 0.1006, 0.1057, 0.1257, 0.1807, 0.2717];

// The honest limit: measured holds whose peak sits inside the bleed range. No scalar
// floor separates these, and pretending otherwise is how the opposite bug gets shipped.
const BELOW_ANY_SEPARABLE_FLOOR = [0.0242, 0.0245];

describe('BUG-274 — the barge-in floor must separate measured bleed from measured speech', () => {
  it('sits above every clean bleed reading', async () => {
    const { INITIAL_BLEED_FLOOR } = await import(POLICY_URL);
    const worstBleed = Math.max(...BLEED_CLEAN);
    assert.ok(INITIAL_BLEED_FLOOR > worstBleed,
      `floor ${INITIAL_BLEED_FLOOR} must exceed the loudest clean bleed reading ${worstBleed}, `
      + 'or MYTHOS opens a barge-in candidacy on its own voice and self-interruption returns');
  });

  it('sits below every level the operator actually interrupted at', async () => {
    const { INITIAL_BLEED_FLOOR } = await import(POLICY_URL);
    const quietest = Math.min(...OPERATOR_INTERRUPTIONS);
    assert.ok(INITIAL_BLEED_FLOOR < quietest,
      `floor ${INITIAL_BLEED_FLOOR} must sit below the quietest real interruption ${quietest}. `
      + 'At 0.05 the operator peaked at 0.0480 and was refused by 0.002 while 3.4s of their '
      + 'speech was being transcribed by the model in the same hold.');
  });

  it('opens a candidacy for every measured interruption, and for none of the clean bleed', async () => {
    const { createBargeInPolicy } = await import(POLICY_URL);

    // One fresh policy per level, walked out of the protected window on a real clock.
    // The clock MUST be read by the policy (injected at construction) — an earlier draft
    // of this test advanced a variable the policy never looked at, so every case sat in
    // the protected window and the assertion was measuring the wrong refusal.
    const firstVerdictAt = (level) => {
      let t = 0;
      const p = createBargeInPolicy({ now: () => t });
      p.assistantSpeakingStarted();
      const step = (rms) => { const d = p.observe({ rms, echoRatio: null }); t += 100; return d; };
      for (let i = 0; i < 6; i++) step(0.001);   // out of the 500ms window, teaching nothing
      return step(level);
    };

    for (const level of OPERATOR_INTERRUPTIONS) {
      assert.notEqual(firstVerdictAt(level).reason, 'below-bleed-floor',
        `the operator at ${level} was rejected as bleed — this is the failure being fixed`);
    }

    for (const level of BLEED_CLEAN) {
      assert.equal(firstVerdictAt(level).reason, 'below-bleed-floor',
        `clean bleed at ${level} opened a candidacy — self-interruption is the opposite bug`);
    }
  });

  it('records the honest limit: some measured speech is inside the bleed range and cannot be separated', async () => {
    const { INITIAL_BLEED_FLOOR } = await import(POLICY_URL);
    for (const level of BELOW_ANY_SEPARABLE_FLOOR) {
      assert.ok(level < INITIAL_BLEED_FLOOR,
        `${level} is now above the floor. If that was deliberate, say which session measured `
        + 'the bleed that justifies it — this list exists so the limit is not silently claimed as fixed.');
    }
  });

  it('is NOT collapsed into the noise gate floor, and the gap is deliberate', async () => {
    const { INITIAL_BLEED_FLOOR } = await import(POLICY_URL);
    const { LIVE_NOISE_GATE_FLOOR_RMS } = await import(GATE_URL);
    assert.ok(INITIAL_BLEED_FLOOR > LIVE_NOISE_GATE_FLOOR_RMS,
      `the barge-in floor (${INITIAL_BLEED_FLOOR}) must stay above the noise gate's `
      + `${LIVE_NOISE_GATE_FLOOR_RMS}: the gate's job is "is this worth sending", which tolerates `
      + 'room noise, while this one stops MYTHOS mid-sentence. 0.02 sits inside the measured '
      + 'bleed range and would reproduce BUG-272 V1 (63% self-interruption).');
    // ...but they must not drift 2.5x apart again, which is the bug this ticket found.
    assert.ok(INITIAL_BLEED_FLOOR < LIVE_NOISE_GATE_FLOOR_RMS * 2.5,
      `the two floors have drifted to ${INITIAL_BLEED_FLOOR} vs ${LIVE_NOISE_GATE_FLOOR_RMS}. `
      + 'A band where the operator is transmitted and transcribed but invisible to barge-in is '
      + 'exactly the defect found on 2026-08-19.');
  });

  it('the sustain test still rejects decaying bleed AT THE NEW FLOOR', async () => {
    // Lowering the floor makes the 350ms sustain the primary bleed discriminator rather
    // than a backup — at 0.05 nothing ever reached it, so it had never been exercised in
    // this room. This asserts it does the job it is now relied upon for.
    const { createBargeInPolicy } = await import(POLICY_URL);
    let t = 0;
    const p = createBargeInPolicy({ now: () => t });
    p.assistantSpeakingStarted();
    const step = (rms) => { const d = p.observe({ rms, echoRatio: null }); t += 100; return d; };
    for (let i = 0; i < 6; i++) step(0.001);

    // Bleed just above the new floor that dips with MYTHOS's own syllables.
    let released = 0;
    for (let i = 0; i < 30; i++) {
      if (step(i % 2 === 0 ? 0.04 : 0.01).release) released += 1;
    }
    assert.equal(released, 0,
      'bleed alternating above and below the new floor was treated as an interruption — the '
      + 'sustain test is the discriminator the lowered floor depends on');
  });

  it('PENDING_HOLD_MS is the staged 200 — Stage 3, pulled on measured evidence', async () => {
    // Was 350, and was deliberately left alone when the floor moved: one lever at a
    // time. The 2026-08-20 live session is the evidence the staged plan was waiting
    // for. Over 55 turns the policy vetoed 24 barge-ins, ELEVEN 'pending-sustaining',
    // at levels up to 0.2144 — five of the eight recorded levels sit ABOVE the room's
    // own bleed peak (0.1193), so they are unambiguously the operator, refused for not
    // LASTING rather than for being too quiet. A one- or two-word interruption is
    // 200-400ms of speech and could not clear a 350ms bar plus the backstop's 3-frame
    // cadence. Ten barge-ins reached the stop door and exactly ONE cut real audio.
    //
    // The counter-failure to watch is self-interruption, which ran at 26/89 turns
    // before this change. If it rises, raise INITIAL_BLEED_FLOOR back toward 0.04 —
    // do NOT lengthen this again, which is the move that broke interruption before.
    const { PENDING_HOLD_MS } = await import(POLICY_URL);
    assert.equal(PENDING_HOLD_MS, 200,
      'if this is being changed again, say which session measured the need — this ticket '
      + 'has had a constant guessed at three times and measured twice');
  });
});

