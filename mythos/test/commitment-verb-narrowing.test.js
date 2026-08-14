'use strict';

// commitment-verb-narrowing.test.js — B6 of the 2026-08-14 session repair.
//
// MEASURED: a goal exists in vault/Goals titled `Commitment: I'll get it right`,
// with MYTHOS's entire apology stored in its reason field — "I hear you loud and
// clear, boss, my wires are definitely crossed today...". An apology became a
// project commitment.
//
// from-calendar.js's own header states the rule this broke, and it is an operator
// decision, not a preference: "EXPLICIT-ONLY detection. A missed commitment is
// merely today's behaviour; a FALSE entry teaches the operator to distrust the
// ledger, which is worse than not having one."
//
// The cause was one over-broad verb. The list is otherwise phrasal and specific
// ("follow up on", "circle back on", "pull up"); a bare `get` matched "I'll get it
// right", "I'll get to it" and "I'll get that wrong again".
//
// NOT deleted — narrowed. "I'll get those numbers" is a real commitment and the
// ledger should keep it, so `get` now needs an object that makes it a fetch. And
// NOT put in the hedge list: isHedgedCommitment exists to cancel "I'll check,
// but..."; an apology was never a commitment in the first place, so the verb is
// what was wrong.
//
// Sampled in both directions below, because a matcher is only as good as what it
// refuses.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { detectCommitment, logCommitmentIfPresent } = require('../src/core/effectors/from-calendar');

describe('B6 the apology no longer becomes a goal', () => {
  const MUST_NOT_MATCH = [
    // The measured sentence, in its real context.
    "I hear you loud and clear, boss. My wires are definitely crossed today. I'll get it right.",
    "I'll get it right.",
    "I'll get it right this time, sir.",
    "Apologies — I'll get that right.",
    "I'll get that wrong again if I am not careful.",
    // "get to it" is an intention with no object — the same adverbial shape.
    "I'll get to it.",
    "I'll get to it eventually.",
    // Ambiguous between fetching and succeeding; the operator decision says a miss
    // costs less than a false entry, so this stays a miss.
    "I'll get it.",
  ];

  for (const text of MUST_NOT_MATCH) {
    it('refuses: ' + text, () => {
      assert.equal(detectCommitment(text), null,
        'a false ledger entry teaches the operator to distrust the ledger — from-calendar.js\'s own '
        + 'stated operator decision');
    });
  }
});

describe('B6 real commitments still land, or the narrowing broke the feature', () => {
  const MUST_MATCH = [
    "I'll get those numbers for you.",
    "I'll get you the report tonight.",
    "I'll get back to you on that.",
    "I'll get the file from the vault.",
    "I'll get your calendar cleared.",
    "I'll get a summary together.",
    // The adverbial guard must not swallow these: "get that sorted" and "get that
    // done" ARE undertakings, which is why the guard is a short explicit list
    // rather than a rule about anything following the verb.
    "I'll get that sorted.",
    "I'll get that done today.",
    // And the untouched verbs must be untouched.
    "I'll check the calendar.",
    "I'll follow up on that email.",
    "I'll circle back on the pricing.",
    "Let me get those numbers.",
    "Let me pull up the report.",
  ];

  for (const text of MUST_MATCH) {
    it('keeps: ' + text, () => {
      const phrase = detectCommitment(text);
      assert.ok(phrase, 'this is a genuine commitment and the ledger should hold it');
      assert.ok(phrase.length <= text.length);
    });
  }

  it('the hedge and negation exclusions still work', () => {
    assert.equal(detectCommitment("I'll get those numbers if you like."), null, 'a conditional offer');
    assert.equal(detectCommitment("I don't think I'll get to the report."), null, 'negation before the phrase');
  });
});

describe('B6 the ledger entry stores the clause, not 300 characters of apology', () => {
  function fakeGoals() {
    const created = [];
    return { created, create: (opts) => { created.push(opts); return Object.assign({ id: 'g1' }, opts); } };
  }

  it('reason is the matched commitment, and the full turn goes to context', () => {
    const goals = fakeGoals();
    const turn = 'Right, understood. I\'ll get those numbers for you. Anything else, sir?';
    logCommitmentIfPresent(turn, { goals });

    assert.equal(goals.created.length, 1);
    const rec = goals.created[0];
    assert.equal(rec.reason, "I'll get those numbers for you",
      'a ledger entry\'s reason is read back as WHY the commitment exists; the whole reply is context, '
      + 'not a reason, and the false entry carried a 300-character apology there');
    assert.match(rec.context, /Right, understood/, 'the surrounding turn is kept, just not as the reason');
    assert.equal(rec.title, "Commitment: I'll get those numbers for you");
    assert.equal(rec.status, 'proposed', 'still inert — the arbiter must never try to "work on" a commitment');
  });

  it('context is bounded, so one long turn cannot bloat the goal record', () => {
    const goals = fakeGoals();
    logCommitmentIfPresent("I'll get those numbers. " + 'x'.repeat(2000), { goals });
    assert.ok(goals.created[0].context.length <= 300);
  });

  it('nothing is written when nothing matched', () => {
    const goals = fakeGoals();
    assert.equal(logCommitmentIfPresent("I'll get it right, boss.", { goals }), null);
    assert.equal(goals.created.length, 0, 'this is the exact call that created the false goal');
  });
});
