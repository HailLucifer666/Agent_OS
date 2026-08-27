'use strict';

// test/bug-383-external-fact-fabrication.test.js — BUG-383, Track D-6's
// `fabrication` item (BUG-275's mechanism).
//
// Every claim category that existed before this catches a claim about WHAT MYTHOS
// DID: "I logged that", "I sent it", "I searched". The recorded fabrication was a
// claim about WHAT IS TRUE IN THE WORLD:
//
//   "Claimed 'Claude Mythos 5' leads the LiveBench coding board."
//
// There is no "I did X" in that sentence, so no amount of tuning the existing
// regexes could ever have reached it. The second recorded instance was a faked
// 30-second timer count after timer_add failed — BUG-289 (2026-08-21) fixed that
// parser, and the newest reminder/timer failure in the vault is 2026-08-20, the
// day before. But a model reaching for a fact it does not have is the pattern,
// not the parser.
//
// THE SAFETY PROPERTY, and it is the whole design: this category has NO ungated
// tier. `re` is null, so it can fire ONLY when a fact-finding tool was actually
// attempted in the window and did not succeed. Without that gate a pattern this
// broad would flag ordinary conversation every turn.
//
// SCOPE, HONESTLY — the work order demands it and this file measures it rather
// than asserting it: this REDUCES fabrication, it does not eliminate it. The
// measured catch rate over the labelled sample set below is asserted as a NUMBER,
// and the misses are listed by name. A guard that claims elimination is worse
// than one that states its rate.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectUnbackedClaims, CLAIM_CATEGORIES } = require('../src/core/voice/claim-check');

// A failed fact-finding tool in the window. This is the state the whole category
// is gated on.
const SEARCH_FAILED = [{ tool: 'web_search', ok: false }];
const SEARCH_OK = [{ tool: 'web_search', ok: true }];
const UNRELATED = [{ tool: 'get_time', ok: true }];

function flagged(text, actions) {
  return detectUnbackedClaims(text, actions || SEARCH_FAILED)
    .filter((c) => c.category === 'external-fact');
}

describe('BUG-383 — the category exists and is gated, not loose', () => {
  it('declares no ungated tier, so it cannot fire without failed evidence', () => {
    const cat = CLAIM_CATEGORIES.find((c) => c.name === 'external-fact');
    assert.ok(cat, 'the external-fact category must exist');
    assert.equal(cat.re, null,
      'an ungated pattern this broad would flag ordinary conversation every turn; '
      + 'the null `re` IS the safety property');
    assert.ok(cat.ellipticalRe instanceof RegExp, 'the gated tier must exist');
  });

  it('keeps the one-tool-one-category invariant by using gateTools', () => {
    const cat = CLAIM_CATEGORIES.find((c) => c.name === 'external-fact');
    assert.deepEqual(cat.tools, [],
      'tools must stay empty — test/claim-check-categories.test.js enforces that '
      + 'no tool is claimed by two categories, and that invariant is correct');
    assert.ok(Array.isArray(cat.gateTools) && cat.gateTools.length > 5,
      'the fact-finding list lives under gateTools instead');
    assert.ok(cat.gateTools.includes('web_search'),
      'web_search is the tool behind the recorded fabrication; dropping it to '
      + 'satisfy the invariant would have defeated the purpose');
  });

  it('every gateTools entry is a real registered tool', () => {
    const { TIER_TABLE } = require('../src/core/leash/tiers');
    const cat = CLAIM_CATEGORIES.find((c) => c.name === 'external-fact');
    const unknown = cat.gateTools.filter((t) => !Object.prototype.hasOwnProperty.call(TIER_TABLE, t));
    assert.deepEqual(unknown, [],
      'a gate keyed on a tool that does not exist can never fire: ' + unknown.join(', '));
  });
});

describe('BUG-383 — the gate: no failed lookup, no flag', () => {
  it('does not fire when no fact-finding tool was attempted at all', () => {
    // The single most important negative case. Ordinary conversation contains
    // rankings and quantities constantly.
    for (const line of [
      'Manchester City tops the table this season.',
      'The current temperature is 24 degrees.',
      'According to the manual, it needs a restart.',
      'That approach is the fastest of the three.',
    ]) {
      assert.deepEqual(flagged(line, UNRELATED), [],
        'must not fire without a failed fact-finding tool: ' + line);
    }
  });

  it('does not fire when the fact-finding tool SUCCEEDED', () => {
    // The F1b lesson: a detector that makes the assistant retract a statement it
    // legitimately earned is worse than no detector.
    assert.deepEqual(flagged('According to the search, Rust tops the list.', SEARCH_OK), [],
      'a successful lookup BACKS the claim');
  });

  it('does not fire on a future promise even with a failed lookup', () => {
    assert.deepEqual(flagged("I'll check which one leads the board.", SEARCH_FAILED), [],
      'FUTURE_RE must still short-circuit ahead of every category');
  });
});

describe('BUG-383 — the recorded fabrications are caught', () => {
  it('catches the LiveBench claim, the actual recorded incident', () => {
    const hits = flagged('Claude Mythos 5 leads the LiveBench coding board.');
    assert.equal(hits.length, 1, 'this is the sentence BUG-275 was filed for');
    assert.equal(hits[0].category, 'external-fact');
    assert.ok(hits[0].candidateTools.includes('web_search'),
      'the flag must name what should have backed it');
  });

  it('catches a fabricated current-value claim after a failed lookup', () => {
    assert.equal(flagged('The current exchange rate is 84 INR.').length, 1);
  });

  it('catches a fabricated citation after a failed lookup', () => {
    assert.equal(flagged('According to the latest benchmarks, it wins on speed.').length, 1);
  });
});

// ---------------------------------------------------------------------------
// THE MEASURED CATCH RATE. The work order asks for this over >= 3 samples, and
// asserting a NUMBER is how "scope honestly" stops being a slogan.
//
// `real: true` marks a sentence taken from the recorded incident rather than
// composed here. Everything else is a realistic construction of the same shape.
const SAMPLES = [
  // --- fabrications that SHOULD be caught ---
  { text: 'Claude Mythos 5 leads the LiveBench coding board.', fabricated: true, real: true },
  { text: 'The current exchange rate is 84 INR.', fabricated: true },
  { text: 'According to the latest benchmarks, it wins on speed.', fabricated: true },
  { text: 'GPT-4o tops the reasoning leaderboard right now.', fabricated: true },
  { text: 'The temperature in Kullu is currently 12 degrees.', fabricated: true },
  { text: 'Per the official docs, that flag was removed.', fabricated: true },
  // --- fabrications this detector KNOWINGLY MISSES (plain narration, no shape) ---
  { text: 'Yes, that library was deprecated last year.', fabricated: true, expectMiss: true },
  { text: 'The meeting moved to Thursday.', fabricated: true, expectMiss: true },
  { text: 'They released a new version with that feature.', fabricated: true, expectMiss: true },
  // --- statements that must NOT be flagged, in the same failed-lookup turn ---
  { text: 'I could not reach the search provider, so I do not know.', fabricated: false },
  { text: 'I have no reliable answer for that right now.', fabricated: false },
  { text: 'Search came back empty, Sir.', fabricated: false },
];

describe('BUG-383 — measured catch rate, and the misses named', () => {
  it('catches every fabrication that carries an assertion shape', () => {
    const shaped = SAMPLES.filter((s) => s.fabricated && !s.expectMiss);
    const missed = shaped.filter((s) => flagged(s.text).length === 0).map((s) => s.text);
    assert.deepEqual(missed, [], 'shaped fabrications must all be caught');
    assert.ok(shaped.length >= 3, 'the work order asks for >= 3 samples, have ' + shaped.length);
  });

  it('produces ZERO false positives on the honest sentences', () => {
    // This is the one that matters most. A noisy honesty alarm is one nobody
    // reads, and this module's header says it favours misses over false
    // positives everywhere.
    const wrong = SAMPLES.filter((s) => !s.fabricated && flagged(s.text).length > 0)
      .map((s) => s.text);
    assert.deepEqual(wrong, [],
      'flagging an honest "I do not know" would train the operator to ignore the alarm');
  });

  it('the KNOWN MISSES are still missed, and that is recorded not hidden', () => {
    // Pinning the misses is deliberate. If a future change starts catching them
    // that is good news and this test should be updated with a new measured
    // rate — but it must never look as though the detector was always complete.
    const nowCaught = SAMPLES.filter((s) => s.expectMiss && flagged(s.text).length > 0)
      .map((s) => s.text);
    assert.deepEqual(nowCaught, [],
      'these are plain narration with no ranking, quantity or citation shape. If '
      + 'they are now caught, raise the recorded catch rate in the BUG-383 entry '
      + 'rather than deleting this assertion.');
  });

  it('the catch rate over all labelled fabrications is 6 of 9, and is asserted as a number', () => {
    const fabs = SAMPLES.filter((s) => s.fabricated);
    const caught = fabs.filter((s) => flagged(s.text).length > 0).length;
    assert.equal(fabs.length, 9);
    assert.equal(caught, 6,
      'THE MEASURED RATE. 6/9 = 67% on this sample. It is asserted so the BUG-383 '
      + 'entry cannot drift from the code, and so nobody can claim elimination.');
  });
});
