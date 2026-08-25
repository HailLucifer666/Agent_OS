'use strict';

// effectors/review-status.js — BUG-316: what a build's review actually
// concluded, as one rule shared by the pipeline and kanban ship paths.
//
// THE BUG. Both paths implemented the review skip as a hardcoded stand-in:
//
//     var review = needsReview ? await fullReview(...)
//                              : { verdict: 'approve', issues: [], visualDescription: '' };
//
// and then branched on `review.verdict === 'approve'`. So a card nobody reviewed
// recorded reviewStatus:"approved". On the 2026-08-22 AI-news-digest build that
// is exactly what happened — reviewStatus:"approved", status:"done",
// evidence:{pass:true} — and MYTHOS told the operator "Completed and verified,
// Sir." while no reviewer had run at any point.
//
// The skip itself is legitimate and is NOT what changed: tiny-fix and quick-win
// gate on ['artifact'] alone by design (risk-classifier.js's GATE_PATHS). What
// changed is that a skip now says it is a skip, so completion-status.js can tell
// "nobody looked, and that was expected" from "a reviewer approved this".
//
// Extracted rather than fixed twice in place: the two call sites had identical
// branching, and agent-actions.js is already over the house line limit with a
// one-directional ceiling recorded in test/file-size-ratchet.test.js.

// review        — the object the ship path holds: { verdict, issues, visualDescription }
// needsReview   — riskClassifierLib.requiresReview(risk) for this card
//
// Returns the review-related fields to merge onto the card's ship/patch meta.
// Never returns 'approved' for a review that did not run.
function deriveReviewMeta(review, needsReview) {
  if (!needsReview) return { reviewStatus: 'skipped' };
  var r = review || {};
  if (r.verdict !== 'approve') {
    return { reviewStatus: 'failed', reviewIssues: r.issues || [] };
  }
  var out = { reviewStatus: 'approved' };
  if (r.visualDescription) out.visualReview = r.visualDescription;
  return out;
}

module.exports = { deriveReviewMeta: deriveReviewMeta };
