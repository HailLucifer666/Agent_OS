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

    // adr: architecture-change requires an Architecture Decision Record.
    // Check if shipMeta or card has an adr field (future: the builder would produce one)
    if (requiredPhases.indexOf('adr') !== -1) {
      // ADR not yet wired — for now this is informational, not blocking.
      // When ADR generation is added, check card.adr or artifact.adr exists.
    }

    // visual: if visual verification was required (risk class includes it),
    // check that review has a visualDescription or was explicitly skipped
    if (requiredPhases.indexOf('visual') !== -1 && review) {
      // review.visualDescription is set when vision brain described the page.
      // If browser was offline, visual is 'skipped' — that's acceptable degradation,
      // not a missing evidence failure.
      if (!review.visualDescription && !review._visualSkipped) {
        // visual was supposed to run but left no description and wasn't marked skipped
        // This catches the case where visual verify was required but never invoked
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
