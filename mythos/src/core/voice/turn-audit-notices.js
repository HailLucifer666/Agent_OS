'use strict';
// turn-audit-notices.js — the PROSE for onLiveTurnComplete's three
// turn-auditing detectors, and their anomaly `reason` strings.
//
// WHY THIS MODULE EXISTS. The file-size ratchet on live-tool-adapter.js refused
// the BUG-275 detector: "an already-oversized file got bigger. The baseline
// number is a ceiling, not a suggestion — do not raise it to make this pass.
// Move the new code somewhere else." It was right, and the thing worth moving is
// the prose rather than the control flow: each of these three detectors is
// wiring (detect -> emit -> notify) plus twenty lines of carefully-worded text,
// and the text is what makes the adapter unreadable. All three moved together,
// not only the new one, because leaving two inline and one extracted is the
// inconsistency that makes the next person guess.
//
// EVERY FUNCTION HERE IS PURE and returns { message, instruction, reason }. The
// adapter still owns every decision: whether to fire, what to put on the bus,
// and which site label to send. Nothing in this file touches the bus, the
// session, or the ledger.
//
// TWO RULES THE WORDING FOLLOWS, both learned the hard way in this repo:
//
//   `reason` IS NOT DECORATION. None of these three anomaly kinds has a healer
//   playbook, so each reaches the immune explainer's `no-match` path and is
//   SPOKEN to the operator — and conversation/announcer.js's honestCauseClause
//   reads `reason` and nothing else, saying "I do not yet know the cause"
//   without it. An honesty alarm announced as an unexplained fault is noise
//   that teaches the operator to ignore it. Pinned for all three in
//   test/bug-275-evidence-digest-reaches-the-ledger.test.js.
//
//   STATE THE MEASUREMENT, NEVER A MECHANISM (BUG-398 row 5). A notice that
//   asserts WHY something happened hands the model an invented cause, which it
//   then explains to the operator in full confidence. Each message below states
//   only what was observed.
//
// `instruction` must always carry a prohibition — the property
// test/bug-297-late-for-turn-unverified.test.js's site-population guard exists
// to make somebody check when a narration site is added.

// BUG-398 row 7 — the model retracting a PROVEN success because the operator
// contradicted it. The missing behaviour is RECONCILE, not fold and not dig in.
function falseRetractionNotice(bad) {
  const tools = bad.provenTools.join(', ');
  return {
    reason: tools + ' succeeded and was confirmed, but the reply took the claim back',
    message: `CORRECTION of your own prior statement — you said "${bad.sentence}", but ${tools} `
      + 'DID succeed and was confirmed by an independent oracle. Nothing in this turn failed. '
      + 'You just took back something that was true.',
    instruction: 'Do NOT retract it. Tell the operator it did happen, name the evidence, and then '
      + 'RECONCILE the disagreement instead of folding: the window may be behind another one, on '
      + 'another display, or already closed since. Offer the next concrete step (focus_window, '
      + 'list_windows) rather than apologising for a success.',
  };
}

// BUG-398 D1 — a promised RECURRING commitment with nothing scheduled.
// Measured: `reminder_add` ran ZERO times in the 2026-09-02 session while a
// daily 10 AM briefing was promised three times. What actually ran was
// `remember`, which stores a fact, schedules nothing, and returns ok:true.
function unscheduledCommitmentNotice(promise) {
  return {
    reason: 'a recurring commitment was promised while no reminder_add, timer_add or '
      + 'daily_plan ran, so nothing will fire',
    message: `CORRECTION of your own prior statement — you said "${promise.sentence}" but NOTHING `
      + 'was scheduled. No reminder, timer or daily plan was created this turn, so nothing will '
      + 'fire. Note that `remember` stores a fact and schedules NOTHING.',
    instruction: 'Tell the operator now, plainly, that the recurring item is NOT set up yet. Do NOT '
      + 'repeat the promise. If they still want it, call reminder_add (or timer_add / daily_plan) '
      + 'and say so only once that has succeeded.',
  };
}

// BUG-275 H3/H4 — a ranked position handed to a name that is not in the
// evidence.
//
// THE WORDING IS THE CAREFUL PART. The detector knows exactly ONE fact: this
// name does not occur in the results currently in evidence. It does NOT know
// whether the model invented it, read it in an earlier lookup that has since
// aged out of the 120s window — which is H3's actual measured mechanism — or
// heard it from the operator. Wording this as "you fabricated this" would
// assert a cause nothing measured, and BUG-398 row 5 is the record of what
// happens next: the model explains the invented cause to the operator. So the
// message says what was measured and explicitly says it is not an accusation.
function unsourcedRankingNotice(bad) {
  const names = bad.absent.map((n) => '"' + n + '"').join(', ');
  const tools = bad.sawTools.join(', ');
  return {
    reason: 'a ranked position was given to ' + bad.absent.join(', ')
      + ', which does not occur in the ' + tools + ' results in evidence',
    message: `CHECK of your own prior statement — you said "${bad.sentence}" and gave a ranked `
      + `position to ${names}. Not one of those names occurs anywhere in the ${tools} results `
      + 'currently in evidence. This is a measurement of the results, not an accusation: the name '
      + 'may be from an earlier lookup that has since aged out, or from the operator.',
    instruction: 'Do NOT restate that ranking as established. Say which source and which names you '
      + 'actually have, and say plainly that you cannot place the others from what you fetched. If '
      + 'the operator asked for a count you cannot fill, report the shortfall — "the board lists '
      + 'three" — instead of filling it. Re-run the lookup if they want the rest.',
  };
}

module.exports = { falseRetractionNotice, unscheduledCommitmentNotice, unsourcedRankingNotice };
