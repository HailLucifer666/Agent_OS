'use strict';

// test/bug-275-h2-defended-under-challenge.test.js — BUG-275 H2, 2026-09-02.
//
// THE DEFECT, verbatim from the 2026-08-19 session:
//   operator: "I mean I see a lie. How is Gemini CLI a AI model?"
//   MYTHOS:   "Indeed, Sir, good eye. 'Gemini CLI' refers to the model's access
//              method in that benchmark, not the actual model version name. It
//              belongs to Google's Gemini family, rated highly for coding tasks."
//
// No lookup ran in that turn. Challenged, it produced a confident, plausible,
// unevidenced justification — which converts correct scepticism into false
// reassurance. The entry calls this the highest-severity half of BUG-275, and
// nothing was looking at it.
//
// IT IS THE THIRD CASE OF A POLICY BUG-398 ROW 7 ALREADY DECLARED MISSING:
// "there is NO POLICY for 'the operator contradicts my evidence', and which way
// it goes is unrelated to how strong the evidence is." That row's guard catches
// the FOLD (retracting something proven); this catches the DIG IN (defending
// something unproven). A system corrected in one direction only learns to fail
// in the other, which is exactly what the WhatsApp standoff and the folder
// retraction were, one session apart.
//
// WHAT WAS MEASURED BEFORE ANY CODE, across all 127 operator utterances in that
// session's episodic log:
//   * The accusation markers fire on 2 utterances. One is the H2 case. The other
//     is "Which website are you checking?" — a real challenge that MYTHOS
//     answered correctly with "Searching for…", and the reply gate keeps it
//     silent. That turn is the negative control this file uses.
//   * A first draft also matched a challenge to a CATEGORISATION — "How is
//     <Named Thing> a <noun>?", which is the H2 utterance's second sentence.
//     REMOVED after measuring: it fires on ordinary questions like "How is
//     Spotify a good choice for this?", and on the reply path a false positive
//     tells the model to retract something true. The accusation markers alone
//     catch the one real instance, so the ambiguous half bought nothing.
//   * A combined single regex fired on 0 of 127, because the accusation shapes
//     need case-insensitivity while the capitalised-subject shape needs the
//     opposite. Caught by a bound test going silent, not by reading.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectDefendedChallenge } = require('../src/core/voice/ranked-claim-check');
const { defendedChallengeNotice } = require('../src/core/voice/turn-audit-notices');

// Verbatim from the vault.
const CHALLENGE = 'I mean I see a lie. How is Gemini CLI a AI model?';
const DEFENCE = "Indeed, Sir, good eye. 'Gemini CLI' refers to the model's access method in "
  + 'that benchmark, not the actual model version name. It belongs to Google\'s Gemini family, '
  + 'rated highly for coding tasks. Shall I clarify those version numbers precisely?';
// The turn one exchange later, also verbatim — a real challenge, answered right.
const COMPLIED_CHALLENGE = 'No. Go ahead. Do a live web search. What Which website are you '
  + "checking? What's your You know, data relevance.";
const COMPLIED_REPLY = 'Searching for';

describe('BUG-275 H2 — a disputed claim explained instead of re-checked', () => {
  it('the measured case is flagged', () => {
    const out = detectDefendedChallenge(DEFENCE, CHALLENGE, []);
    assert.equal(out.length, 1, 'the real H2 exchange must be flagged');
    assert.equal(out[0].category, 'defended-under-challenge');
    assert.match(out[0].sentence, /refers to/);
  });

  it('BOUND: complying with the challenge is silent (the real next turn)', () => {
    // The most important negative in the file, and it is real data rather than
    // an invented shape: the operator challenged the source, MYTHOS said it was
    // searching, and that is the CORRECT response. A guard that flags it teaches
    // the model that answering a challenge is itself an offence.
    assert.deepEqual(detectDefendedChallenge(COMPLIED_REPLY, COMPLIED_CHALLENGE, []), []);
  });

  it('BOUND: a fresh lookup in THIS turn silences it', () => {
    // The remedy the notice asks for. If the model did re-check, the defence is
    // evidence-backed and nothing is wrong.
    const out = detectDefendedChallenge(DEFENCE, CHALLENGE, [
      { tool: 'web_search', ok: true },
    ]);
    assert.deepEqual(out, [], 'a successful fact-finding call this turn is the answer');
  });

  it('a STALE lookup does not silence it — the window is this turn only', () => {
    // The load-bearing scope decision. In the measured session `web_search` had
    // succeeded 80+ seconds earlier, and that result is exactly what the reply
    // was defending with. Counting the 120s recent-action window the sibling
    // detectors use would excuse the defect outright, so this detector does not
    // receive it. `recentActions` is not a parameter at all, which makes the
    // mistake unrepresentable rather than merely avoided.
    assert.equal(detectDefendedChallenge.length, 3,
      'signature must be (assistantText, userText, actionsThisTurn) — adding a recentActions '
      + 'parameter would let a stale search silence this guard');
  });

  it('BOUND: a FAILED or unverified lookup does not count as a re-check', () => {
    for (const row of [
      { tool: 'web_search', ok: false },
      { tool: 'web_search', ok: true, unverified: true },
      { tool: 'launch_app', ok: true },
    ]) {
      assert.equal(detectDefendedChallenge(DEFENCE, CHALLENGE, [row]).length, 1,
        'a ' + JSON.stringify(row) + ' row must not read as a successful re-check');
    }
  });

  it('BOUND: an honest response is silent even when it also explains', () => {
    // Negative tested before the positive, per the MARK table's rule. A
    // retraction and an explanation routinely share a reply, and the retraction
    // is the behaviour being asked for — flagging it would punish compliance.
    for (const reply of [
      "I was wrong, Sir. 'Gemini CLI' refers to something I cannot confirm.",
      "I do not know what that refers to — let me re-check.",
      "Retracting that. It belongs to nothing I can evidence.",
      "Let me search again; I cannot verify what it means.",
    ]) {
      assert.deepEqual(detectDefendedChallenge(reply, CHALLENGE, []), [],
        'flagged an honest answer: ' + reply);
    }
  });

  it('BOUND: no challenge means no check, however the reply is worded', () => {
    assert.deepEqual(detectDefendedChallenge(DEFENCE, 'What are the top models?', []), []);
    assert.deepEqual(detectDefendedChallenge(DEFENCE, '', []), []);
    assert.deepEqual(detectDefendedChallenge('', CHALLENGE, []), []);
  });

  it('BOUND: the ordinary-question shapes the categorisation form used to catch', () => {
    // Every one of these was measured against the real session or is the exact
    // false positive that got the categorisation matcher removed. None is an
    // accusation, so none may fire whatever the reply says.
    for (const said of [
      'Hi, how is it going?',
      'How is the weather looking today?',
      'How is Spotify a good choice for this?',
      'how is that going to work?',
      "tell me what what what what was that Nvidia's news you were telling?",
      'Yes, I asked you to give me the top five',
    ]) {
      assert.deepEqual(detectDefendedChallenge(DEFENCE, said, []), [],
        'fired on an ordinary utterance: ' + said);
    }
  });

  it('the provenance demand is a challenge too', () => {
    // "Which website are you checking?" is the same challenge asked politely,
    // and the entry records the operator asking exactly that at turn 18. It
    // fires only when the reply explains instead of answering.
    const out = detectDefendedChallenge(
      "That refers to the aggregate listing, Sir, not a single site.",
      'Which website are you checking?', []);
    assert.equal(out.length, 1);
  });

  it('the notice states the measurement and does NOT call the operator right', () => {
    // What is measured is narrow: disputed, explained, no lookup. It is NOT
    // measured that the claim was false — the operator can be wrong, which is
    // the entire reason the sibling false-retraction guard exists. A notice that
    // asserted "you lied" would be the row-5 defect (asserting an unmeasured
    // cause) pointed at the operator's opinion.
    const n = defendedChallengeNotice({ sentence: 'X refers to Y', sawTools: [] });
    assert.match(n.message, /measurement of the turn, not a ruling that you were wrong/i);
    assert.ok(!/you lied|you fabricated/i.test(n.message), 'must not assert the claim was false');
    assert.match(n.instruction, /re-?run the lookup|cannot confirm/i, 'must name the honest moves');
    assert.ok(n.reason.length > 40, 'unplaybooked anomalies are spoken; reason carries the cause');
  });
});

// MUTATION PROOF — run 2026-09-02, each applied-verified by re-counting the
// mutated string, restored by full-path copy verified sha256-identical.
//
//   (a) delete the HONEST_RESPONSE_RE early return -> reds "an honest response is
//       silent even when it also explains". That negative runs BEFORE the
//       positive on purpose and this is what proves the order matters.
//   (b) widen CHALLENGE_RE with the removed categorisation form
//       (`How is <Named> a <noun>`) -> reds "the ordinary-question shapes",
//       naming "How is Spotify a good choice for this?". The measured reason
//       that half is not in the source.
//   (c) drop the `ok === true && unverified !== true` filter from the re-check
//       test -> reds "a FAILED or unverified lookup does not count".
//   (d) accept `recentActions` as a fourth parameter and include it in the
//       re-check -> reds "a STALE lookup does not silence it", which asserts the
//       ARITY rather than the behaviour, because the safest form of that rule is
//       a function that cannot receive the stale window at all.
//   (e) ADJACENT CASE, must stay green: reword the notice prose -> nothing reds
//       except the notice test's two anchored phrases, which are the two claims
//       that must survive any rewording.
//
// Results as observed are recorded in the BUG-275 entry in BUGS.md.
