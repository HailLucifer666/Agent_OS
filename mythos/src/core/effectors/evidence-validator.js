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

// EVERY PHASE NAME THIS GATE UNDERSTANDS. Split into two lists on purpose,
// because the failure this file keeps having is a phase that is DECLARED in a
// gate path and CHECKED nowhere — it reads as rigour and enforces nothing.
//
// Two instances were live when BUG-304 was written. 'adr' was caught in
// 2026-08-20 and removed from the gate path (see risk-classifier.js). 'verify'
// survived: grepping src/ for it as a phase name returned exactly two hits, the
// gate-path table demanding it and this file's comment listing it. Nothing
// produced it, nothing checked it, and quick-win advertised it as a required
// phase. Removed on the same precedent in the same commit as this fix.
//
// A name in NEITHER list now throws. That is the fix for the class rather than
// the instance: a phase cannot be added to a gate path and quietly ignored
// again, because the gate will refuse to run until someone decides which list
// it belongs in.
var CHECKED_PHASES = ['artifact', 'visual', 'review'];

// Declared, deliberately not enforced, each with the reason it is exempt.
// An entry here is a decision; an omission is a bug.
var UNCHECKED_PHASES = {
  research: 'best-effort. Whether real web data was fetched cannot be proven from here, and '
    + 'the network may simply be down — blocking delivery on an offline research step would '
    + 'be a deadlock, not a stricter gate.',
};

function createEvidenceValidator(deps) {
  // The vault handle. Without it the artifact check cannot touch the disk, and
  // the gate says so instead of skipping the check — see the artifact block.
  var vault = (deps && deps.fs) || null;

  function verify(opts) {
    var card = opts.card || {};
    var artifact = opts.artifact;
    var review = opts.review;
    var job = opts.job || {};
    var requiredPhases = opts.requiredPhases || ['artifact', 'review'];
    var missing = [];

    // Refuse a phase this gate has no answer for. Loud, because the alternative
    // is the exact silence that let 'verify' sit in a gate path unenforced.
    for (var p = 0; p < requiredPhases.length; p++) {
      var phase = requiredPhases[p];
      if (CHECKED_PHASES.indexOf(phase) === -1 && !UNCHECKED_PHASES[phase]) {
        throw new Error('evidence gate: required phase "' + phase + '" has no check in '
          + 'evidence-validator.js. Add the check to CHECKED_PHASES, or record why it is exempt '
          + 'in UNCHECKED_PHASES — do not leave it declared and unenforced.');
      }
    }

    // artifact: the FILE must exist and have content.
    //
    // BUG-304. This used to be `if (!artifact || !artifact.path)` — a check on a
    // piece of text. Nothing looked at the disk, and for tiny-fix (gate path
    // ['artifact']) it was the only check the gate performed, so a card could be
    // marked shipped with nothing written anywhere. Measured before the fix: an
    // artifact naming a file that was never created returned pass:true for both
    // tiny-fix and quick-win.
    //
    // An empty file is checked separately from a missing one because they have
    // different causes — nothing ran, versus a write that started and failed —
    // and the operator needs to know which.
    if (requiredPhases.indexOf('artifact') !== -1) {
      if (!artifact || !artifact.path) {
        missing.push('no artifact produced');
      } else if (!vault) {
        // FAIL CLOSED, and name our own missing dependency rather than the
        // card's. `if (vault) { ...check... }` would turn a wiring mistake into
        // a gate that passes everything and reports nothing, which is strictly
        // worse than having no gate — it looks like one.
        missing.push('the ship gate has no vault handle and cannot confirm the artifact file '
          + 'exists; refusing rather than approving an unverifiable card. Construct it as '
          + 'createEvidenceValidator({ fs: memory.fs }).');
      } else {
        // The writer returns '/vault/builds/...' and the handle is rooted AT the
        // vault, so the prefix comes off — the same strip agent-actions.js:381
        // already does before reading an artifact for review.
        var rel = String(artifact.path).replace(/^\/vault\//, '');
        if (!vault.exists(rel)) {
          missing.push('the artifact file was never written: ' + artifact.path);
        } else if (!String(vault.readText(rel, '')).trim()) {
          missing.push('the artifact file is empty: ' + artifact.path);
        }
      }
    }

    // research: deliberately unenforced. The reason now lives in UNCHECKED_PHASES
    // at the top of this file rather than in a comment here, so that the decision
    // is a value the phase-name guard above reads, not prose it cannot.

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

module.exports = {
  createEvidenceValidator: createEvidenceValidator,
  _CHECKED_PHASES: CHECKED_PHASES,
  _UNCHECKED_PHASES: UNCHECKED_PHASES,
};
