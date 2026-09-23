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

const OBSERVATION = 'observation';
const HYPOTHESIS = 'hypothesis';

function provenanceOf(text) {
  return CAUSE_MARKERS.test(String(text == null ? '' : text)) ? HYPOTHESIS : OBSERVATION;
}

module.exports = { provenanceOf, OBSERVATION, HYPOTHESIS, CAUSE_MARKERS };
