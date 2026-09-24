'use strict';

// fragment-guard.js — BUG-299's rule ("a fragment transcript cannot license a
// factual assertion") and BUG-460's narrowing of it. Moved out of
// live-tool-adapter.js on 2026-09-24 because that file sits at its size ceiling
// (test/file-size-ratchet.test.js) — and so the rule is a pure function a test
// can reach without building an adapter. The incident that made the rule, and
// why BOTH halves must hold before it fires, stays at its call site in
// live-tool-adapter.js's onLiveTurnComplete.
//
// The thresholds are judgement calls a later reader will want to argue with, so
// they are named.
//
// FRAGMENT: a single token, no internal whitespace, short. "आदिए" is four
// characters. Deliberately measured in code points rather than words — the
// operator speaks Bengali, Hindi and English, and a word count is meaningless
// for scripts this STT segments badly.
//
// SUBSTANTIVE: long enough that it cannot be an acknowledgement. "Okay, Sir."
// and "ঠিক আছে।" are 10 and 9; the fabricated match report was 63. 40 sits well
// clear of both, and erring high is the safe direction — a missed correction
// leaves the existing behaviour, a false one interrupts a working turn.
const FRAGMENT_MAX_CHARS = 8;
const SUBSTANTIVE_MIN_CHARS = 40;

// BUG-460 — 2026-09-24 15:11:06. The operator said "further"; MYTHOS pressed
// PageDown and said "Got it, going further down. How about now, do you see it?";
// this rule then fired and MYTHOS said "I completely missed what you said" about
// a command it had just carried out.
//
// The ticket's direction — consult the turn's tool outcomes — is right, but
// "a tool succeeded" is the wrong test, and the replay is why. Replayed over
// every reply in Episodic 2026-09-23 and 2026-09-24 (97 replies), this rule
// fired three times: "further" + a PageDown (FALSE — the command was obeyed);
// "November" + remember() writing "you haven't been feeling well" (TRUE — the
// write is BUG-464, an unrequested memory); "Right." with no action (the reply
// continued an earlier topic; left as it is). BUG-299's own case wrote the
// invented match result with write_note. remember and write_note both return ok:
// a write carries the model's OWN words, so it proves nothing about what was
// heard. The exemption is therefore an action this turn whose effect an ORACLE
// verified (evidence.isVerified — carried on the turn row as `verified`): a
// scroll that moved, a key that toggled the player, a click that navigated.
//
// Bound, stated: a command acted on with no oracle (an unverified outcome) still
// draws the correction; so does a verified action beside an invented fact in the
// same reply, which is the correction's purpose.
function isAssertionOnUnintelligibleInput(userText, assistantText, actionsThisTurn) {
  const heard = String(userText || '').trim();
  // An EMPTY transcript is not a fragment. MYTHOS speaks unprompted on
  // proactive and entity-initiated turns, and treating those as garbled would
  // fire this correction on every one of them.
  if (!heard) return false;
  if (heard.length > FRAGMENT_MAX_CHARS) return false;
  if (/\s/.test(heard)) return false;
  if (String(assistantText || '').trim().length < SUBSTANTIVE_MIN_CHARS) return false;
  return !(Array.isArray(actionsThisTurn) ? actionsThisTurn : []).some((a) => a && a.verified === true);
}

module.exports = { isAssertionOnUnintelligibleInput, FRAGMENT_MAX_CHARS, SUBSTANTIVE_MIN_CHARS };
