'use strict';

// provenance.js — how a remembered sentence was established, assigned by the
// SERVER from what the sentence says, never chosen by the model that wrote it.
//
// BUG-451, 2026-09-23 (attended run). Two records went into permanent memory as
// if they were findings. The healer's lesson said a symptom ("browser_click on
// specific element refs/selectors (e.g., f5e1537, f5e298) fails repeatedly");
// the model's note_take said a cause ("those elements can become stale very
// quickly due to page re-renders. A browser_snapshot should be taken immediately
// before each browser_click…"). The cause was wrong — f5e1537 was invented and
// never in any snapshot (BUG-445) — and the planner reads lessons as
// instructions, so a guess would have steered every later session away from the
// one mechanism that works.
//
// THE RULE. A sentence that states a cause is a HYPOTHESIS; a sentence that
// reports what happened is an OBSERVATION. Nothing written by a model, a
// reflection pass or an incident report is VERIFIED — that label needs trusted
// evidence for that specific claim, and no writer supplies it today, so no
// code path here can produce it. Callers cannot pass a label in: the only input
// is the text.
//
// Applied at write AND at read, so records written before this existed (the two
// above included) are classified the same way without editing the operator's
// files.
//
// HONEST LIMITS. It is a shape rule, not understanding: a cause phrased without
// one of these markers reads as an observation, and a symptom that uses one
// ("failed because the page timed out", which is itself an observation of an
// error message) reads as a hypothesis. It errs towards "unverified", which is
// the safe direction for something a planner treats as an instruction.

const CAUSE_MARKERS = new RegExp([
  '\\bbecause\\b', '\\bdue to\\b', '\\bcaused by\\b', '\\bas a result of\\b',
  '\\b(?:the|a|its)\\s+(?:root\\s+)?cause\\b', '\\bthe reason (?:is|was|being)\\b',
  '\\b(?:stems?|stemmed|results?|resulted) from\\b', '\\bwhich (?:is )?why\\b',
  '\\bsuggests? that\\b', '\\b(?:leads?|led) to\\b', '\\bthanks to\\b',
].join('|'), 'i');

// BUG-451 closure, 2026-10-06. The 2026-09-24 incident ("Operator expects direct browser
// link opening; MYTHOS only offers dashboard rendering or app launch") stated no cause at
// all: it stated a LIMITATION of MYTHOS, and that was false (open_web with browser:true
// does open links - BUG-459). A claim about what the system cannot do is as unobserved as a
// claim about why something failed, and is written as fact in the same way, so it takes the
// same label. NARROW ON PURPOSE: the subject must be MYTHOS or the system, because a quoted
// tool error ("unable to find element e5") is an observation and must stay one - the
// adjacent case in test/bug-451-closure-writers.test.js (t) pins both sides.
const LIMITATION_MARKERS = new RegExp(
  '\\b(?:mythos|the system|the assistant)\\s+(?:only|cannot|can\'t|can not|does not|doesn\'t|never|is unable to|has no|lacks)\\b', 'i');

const OBSERVATION = 'observation';
const HYPOTHESIS = 'hypothesis';

function provenanceOf(text) {
  const s = String(text == null ? '' : text);
  return CAUSE_MARKERS.test(s) || LIMITATION_MARKERS.test(s) ? HYPOTHESIS : OBSERVATION;
}

// How a hypothesis is shown to whoever reads the record back (the model, in a prompt or a
// tool result). The label lives beside the record; this puts it in front of the TEXT, because
// a reader that never looks at the label is the reader the false cause fooled. Display only:
// the stored text is never rewritten, so an operator who opens the file sees their own words.
const UNVERIFIED_TAG = '(unverified) ';
function labelText(text, label) {
  return label === HYPOTHESIS ? UNVERIFIED_TAG + text : text;
}

module.exports = { provenanceOf, labelText, UNVERIFIED_TAG, OBSERVATION, HYPOTHESIS, CAUSE_MARKERS, LIMITATION_MARKERS };
