'use strict';

// BUG-275 H1 — the fabricated "top five" matched none of the external-fact
// claim shapes, so the honesty detector was silent on it even with the search
// failed.
//
// MEASURED 2026-08-28 against the real utterance, taken from
// Episodic/2026-08-19.jsonl `detail.reply`:
//
//   "On current leaderboards, Sir, top five stands thus: Claude Mythos 5, then
//    Claude Fable 5, followed by GPT-5.6 Sol, Claude Opus 5, and Gemini CLI."
//
// `detectUnbackedClaims` returned [] for it in BOTH states — search succeeded
// AND search failed. Two independent reasons, and only one of them is fixable
// here:
//
//   1. THE BACKED SHORT-CIRCUIT. A gateTool that succeeded backs every
//      external-fact claim in the reply regardless of content, and exits before
//      any shape is consulted. In the real session `web_search` had succeeded
//      79.6s earlier, so this is what actually hid H1. It is DELIBERATE (the
//      F1b lesson: without it the detector tells the assistant to retract
//      statements it just earned) and is NOT touched here. Recorded in the
//      BUG-275 entry as the reason H1 needs a different mechanism.
//   2. THE MISSING SHAPE, which this fixes. `ellipticalRe` claims to cover "a
//      ranking or superlative" and covered `leads|tops|ranks|beats|outperforms|
//      is the best/fastest/...` — but not an ENUMERATED ranking, which is how a
//      top-N answer is actually spoken. So the shape the operator complained
//      about was the one shape absent.
//
// What this closes is therefore the ADJACENT case, and the test says so rather
// than implying the ticket is fixed: an enumerated ranking spoken when the
// fact-finding tool did NOT succeed — H6's shape — was equally invisible.
//
// Run: cd mythos && node --test test/bug-275-enumerated-ranking-is-a-claim-shape.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { detectUnbackedClaims, CLAIM_CATEGORIES } = require('../src/core/voice/claim-check.js');

// The real utterance. Verbatim from the vault, not a paraphrase.
const H1 = 'On current leaderboards, Sir, top five stands thus: Claude Mythos 5, then '
  + 'Claude Fable 5, followed by GPT-5.6 Sol, Claude Opus 5, and Gemini CLI.';

const searchOk = [{ tool: 'web_search', ok: true }];
const searchFailed = [{ tool: 'web_search', ok: false }];

describe('BUG-275 H1 — an enumerated ranking is a claim shape', () => {
  it('the real fabricated ranking is flagged when the search did not succeed', () => {
    // The regression. Pre-fix this returned [] — no shape matched at all.
    const claims = detectUnbackedClaims(H1, searchFailed, []);
    assert.equal(claims.length, 1, 'an enumerated ranking with no successful source is a claim');
    assert.equal(claims[0].category, 'external-fact');
    assert.match(claims[0].phrase, /top\s+five/i);
  });

  it('DISPOSITION PINNED — a SUCCEEDED search still backs it, and H1 stays uncaught', () => {
    // Deliberately not changed. The `backed` short-circuit is the F1b lesson: it
    // stops the detector demanding a retraction of something just earned. In the
    // real session the search HAD succeeded, so this is the state that actually
    // occurred, and it must keep returning nothing until a mechanism that
    // compares claim CONTENT to result CONTENT exists. If this ever flips, the
    // fix was applied in the dangerous direction.
    assert.deepEqual(detectUnbackedClaims(H1, searchOk, []), [],
      'a successful fact-finding tool backs the claim by design (F1b)');
  });

  it('stays silent when no fact-finding tool was attempted at all', () => {
    // The category has re:null, so it is evidence-gated only. Without the gate
    // a pattern this broad would flag ordinary conversation every turn — the
    // stated safety property of the whole category.
    assert.deepEqual(detectUnbackedClaims(H1, [], []), []);
    assert.deepEqual(detectUnbackedClaims('My top five films, since you ask.', [], []), []);
  });

  it('a future-tense promise about a ranking is never flagged', () => {
    // FUTURE_RE must still win. A promise is not a completed-aspect claim.
    for (const s of ['I will get you the top five shortly.',
      "I'm going to check the top ten now.",
      'Let me pull the top three for you.']) {
      assert.deepEqual(detectUnbackedClaims(s, searchFailed, []), [], s);
    }
  });

  it('the numeric and word forms both match, and a bare "top" does not', () => {
    const fire = ['top 5 stands thus: A, then B.', 'top ten reads: A, then B.',
      'top three are A, B and C.'];
    for (const s of fire) {
      assert.equal(detectUnbackedClaims(s, searchFailed, []).length, 1, s);
    }
    // "top" alone is an ordinary word — "top of the hour", "top priority" — and
    // must not become a claim shape. This is the bound on the new pattern.
    for (const s of ['That is my top priority, Sir.', 'At the top of the hour.']) {
      assert.deepEqual(detectUnbackedClaims(s, searchFailed, []), [], s);
    }
  });

  it('the shape lives in external-fact, whose gate is evidence-only', () => {
    // Guards the structural property rather than the behaviour: if someone gives
    // this category a non-null `re`, every assertion above still passes while the
    // category starts firing ungated on ordinary conversation.
    const cat = CLAIM_CATEGORIES.find((c) => c.name === 'external-fact');
    assert.ok(cat, 'the external-fact category must still exist');
    assert.equal(cat.re, null, 'external-fact must stay evidence-gated (re:null)');
    assert.match(String(cat.ellipticalRe), /top\\s\+/, 'the enumerated-ranking shape must be present');
    assert.ok(cat.gateTools.includes('web_search'), 'web_search must remain a gate tool');
  });
});
