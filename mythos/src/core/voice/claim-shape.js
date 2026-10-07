'use strict';
// claim-shape.js — which part of a sentence claims anything at all?
// B2b-1 of the Stage 1 repair campaign (2026-09-26), BUG-448. Pure; claim-check.js is the
// caller, and it matches its category patterns against claimView(sentence), not the raw text.
//
// WHY. A replay of every Live turn through the claim checker flagged 64 sentences, and 11
// of the 40 wrong flags claimed nothing, in four shapes (labelled by reading each turn):
//   a question            "Shall I try launching it for you now?"
//   a hedged gerund       "Opening it in a real browser window would be best."
//   reported speech       'I said "I clicked," but I can't confirm it actually happened.'
//   a gerund as a noun    "the tool for opening the dashboard widget is reporting ..."
// Each wrong flag made MYTHOS retract, aloud, something it never claimed, and the third
// shape loops: the retraction quotes the claim, and the quote is flagged again.
//
// THE RULE, narrow on purpose (this file's caller favours misses over false retractions,
// but a miss here is a lie spoken unchallenged, so each rule removes only what it names):
//   - a question is excused whole only when it OPENS like one ("Shall I", "How about") and
//     ends in "?". "I've opened YouTube, can you see it?" is still a claim.
//   - a hedged gerund subject is removed up to its clause boundary (comma, dash, ";").
//     The hedge must be named: a modal, a negation, "seems/appears", "is beyond". Without
//     one it is a claim ("Opening YouTube is now underway"), and a claim after the boundary
//     survives ("Opening it would have been easy, and I've opened it now").
//   - a quote is removed only after a reporting verb (said, claimed, stated, told you), and
//     "saying/claiming <clause>" only to the clause's end. "As I said, I've opened it" is a
//     re-assertion and stays.
//   - a gerund after for/of/about/by/before/after/without is a noun. "on" is NOT in the list:
//     "I'm working on opening it" is BUG-423's claim shape.
// Returns null when nothing in the sentence is a claim, else the sentence with the excused
// spans removed. The caller reports the ORIGINAL sentence, so a correction can find it.

const GERUND = '(?:opening|launching|closing|dismissing|spawning|navigating|loading|clicking|sending)';
const QUESTION_OPENER_RE = /^(?:shall|should|would|could|can|may|do|did|does|is|are|how about|what about|want me to|would you like)\b/i;
const HEDGE = "(?:would|could|might|may|should|must|isn'?t|is not|wasn'?t|was not|won'?t|will not|can'?t|cannot|couldn'?t|hasn'?t|has not|didn'?t|did not|doesn'?t|does not|never|seems?|seemed|appears?|appeared|is beyond|is outside)";
const HEDGED_GERUND_SUBJECT_RE = new RegExp('^' + GERUND + '\\b[^,;—–]{0,80}?\\b' + HEDGE + '\\b[^,;—–]*[,;—–]?', 'i');
const NOW_RE = /\b(?:now|as we speak)\b/i;
const REPORTED_QUOTE_RE =/\b(?:said|claimed|stated|told you)\s*[,:]?\s*(?:"[^"]*"|“[^”]*”)/gi;
const REPORTED_CLAUSE_RE = /\b(?:saying|claiming)\s+(?:that\s+)?[^,;.!?]*/gi;
const NOUN_GERUND_RE = new RegExp('\\b(for|of|about|by|before|after|without)\\s+' + GERUND + '\\b', 'gi');

function claimView(sentence) {
  const s = String(sentence || '').trim();
  if (QUESTION_OPENER_RE.test(s) && /\?\s*$/.test(s)) return null;
  // "Opening YouTube now should not take long" asserts the act is under way; the hedge is
  // about duration. A hedged gerund that says "now" stays a claim (found attacking this rule).
  const hedged = HEDGED_GERUND_SUBJECT_RE.exec(s);
  const view = (hedged && !NOW_RE.test(hedged[0]) ? s.replace(HEDGED_GERUND_SUBJECT_RE, ' ') : s)
    .replace(REPORTED_QUOTE_RE, ' ')
    .replace(REPORTED_CLAUSE_RE, ' ')
    .replace(NOUN_GERUND_RE, '$1 it')
    .trim();
  return /[a-z]/i.test(view) ? view : null;
}

module.exports = { claimView };
