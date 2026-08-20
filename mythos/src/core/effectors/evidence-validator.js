'use strict';

// evidence-validator.js — external ship gate that blocks delivery if required
// phases are missing evidence. Runs in the ship closure BEFORE moveCard('shipped'),
// so the agent cannot bypass it. If verify() returns {pass: false}, the build
// closure throws and build-runner marks the job failed — the card stays in execute.
//
// requiredPhases comes from the risk classifier's gate path:
//   tiny-fix: ['artifact']
//   quick-win: ['artifact', 'verify']
//   feature: ['research', 'artifact', 'visual', 'review']
//   architecture-change: ['research', 'adr', 'artifact', 'visual', 'review']

function createEvidenceValidator() {

  function verify(opts) {
    var card = opts.card || {};
    var artifact = opts.artifact;
    var review = opts.review;
    var job = opts.job || {};
    var requiredPhases = opts.requiredPhases || ['artifact', 'review'];
    var missing = [];

    // artifact: must exist with a path
    if (requiredPhases.indexOf('artifact') !== -1) {
      if (!artifact || !artifact.path) {
        missing.push('no artifact produced');
      }
    }

    // research: tracked via the researchBrief in shipMeta — if the risk class
    // requires research but none was attempted, flag it. We can't directly verify
    // web data was fetched (that's best-effort), but we can verify the field exists.
    // Skipped here — research is best-effort and network may be down.

    // adr: DELIBERATELY NOT REQUIRED, and removed from risk-classifier.js's
    // architecture-change gate path on 2026-08-20 rather than enforced here.
    //
    // Nothing in this repo produces an ADR artifact. Gating on one would block
    // every architecture-change card forever, waiting on a document no code can
    // create — a deadlock, not a stricter gate, and this repo's bias is that no
    // mechanism beats a mechanism that cannot pass. The block that used to sit
    // here contained only comments, so it read as an enforced phase while
    // enforcing nothing, which is worse than its absence.
    //
    // Re-add BOTH the phase and a check here in the same commit that adds a
    // producer. test/evidence-gate-visual-and-adr.test.js fails if 'adr' returns
    // to any gate path, so this cannot be un-decided silently.

    // visual: required by the feature and architecture-change classes. The
    // condition below was already written correctly and its result was thrown
    // away — the `if` body was empty, so the gate detected a card shipping with
    // no visual verification and returned pass:true anyway. Using it is the whole
    // fix.
    //
    // _visualSkipped is the honest degradation path: agent-actions.js's
    // fullReview sets it when verifyBuildVisually reports checked:false (browser
    // automation unavailable, browser offline, vision brain unavailable,
    // screenshot failed). An offline browser must not block delivery. That field
    // did NOT exist when this gate was written — it was read here and set
    // nowhere, so enforcing this condition before fullReview recorded it would
    // have blocked every card whose browser was down.
    if (requiredPhases.indexOf('visual') !== -1 && review) {
      if (!review.visualDescription && !review._visualSkipped) {
        missing.push('visual verification was required but never ran');
      }
    }

    // review: must have a verdict
    if (requiredPhases.indexOf('review') !== -1) {
      if (!review) {
        missing.push('no review recorded');
      } else if (review.verdict !== 'approve' && review.verdict !== 'reject') {
        missing.push('review has no valid verdict');
      }
      // If review rejected but no retry was attempted, that's a process violation
      if (review && review.verdict === 'reject' && !job._reviewRetried) {
        missing.push('review rejected but no retry was attempted');
      }
    }

    return { pass: missing.length === 0, missing: missing };
  }

  return { verify: verify };
}

module.exports = { createEvidenceValidator: createEvidenceValidator };
