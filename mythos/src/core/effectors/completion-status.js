'use strict';

// effectors/completion-status.js — C1: a failed review must never be
// announced as a success.
//
// Job -531 (2026-08-12 voice-session finding) carried reviewStatus:'failed'
// with buildFailed:false, evidence.pass:true, progress:100 — and was spoken/
// shown to the operator as done. evidence.pass meant "the gate phases ran",
// which reads to a human as "the thing works". It never did: the phases
// running and the review approving the result are two different facts, and
// only the file that sets reviewStatus (agent-actions.js) had the second one.
//
// Two independent signals must degrade the announced status, per the repo's
// CLAUDE.md (there is exactly ONE build-content engine — `dsh` since W6
// 2026-08-22, Hermes-Agent from 2026-07-29 until then — and a build with no
// engine FAILS rather than shipping a plausible-but-wrong artifact):
//   - reviewStatus === 'failed'   -> the reviewer/reality-checker rejected it.
//   - a fallback engine was used  -> the content did not come from the real
//     engine at all, so "it works" was never actually checked.
//
// NOTE ON THE ENGINE VALUE: there is no literal 'fallback' engine tag
// anywhere in this codebase (checked build-engine.js, build-runner.js, and
// full git history). The only engine tag current code produces is 'dsh'
// (W6, 2026-08-22; it was 'hermes' before the harness swap). 'brain-fallback'
// came from build-engine.js's brainFallback(), which was REMOVED on
// 2026-08-15 under operator ruling A, and 'fallback' was only ever a
// defensive alias. All three are kept as accepted historical values because
// job records on disk still carry them — a stored job predating the swap must
// keep deriving the same completion status it always did.
//
// This module is deliberately tiny and dependency-free (no bus, no vault) so
// both the shipping path (agent-actions.js, which sets reviewStatus) and the
// spoken/HUD path (conversation/announcer.js, which only has reviewVerdict)
// can share one rule instead of drifting.
//
// NOT TREATED AS FALLBACK: build-runner.js can also stamp job.engine === 'brain'
// (no buildEngine wired at all — test harnesses only, see build-runner.js's
// comment at the job.engine assignment). That is deliberately excluded here —
// several existing tests rely on a plain-brain build with an approving review
// reaching 'shipped'. If 'brain' ever becomes reachable in production, this
// function needs an explicit decision for it, not a silent fall-through to 'done'.
// BUG-311/316 — THIS WAS A DENYLIST, AND THAT IS WHY THE CLASS KEPT RETURNING.
// It used to read:
//
//     var needsWork = reviewStatus === 'failed' || isFallbackEngine;
//
// so anything it had not been taught to distrust read as 'done'. Measured
// against the shipped function: `deriveCompletionPayload({})` — no arguments at
// all — returned status 'done' with evidence.pass true. So did a typo
// ('aproved'), an undefined reviewStatus, and the literal 'skipped' that
// agent-actions would need in order to be honest about a review it never ran.
// The module written to stop success being claimed without evidence claimed it
// for the empty object.
//
// It is now an allowlist: 'done' requires positive evidence of each thing it
// asserts, and every unrecognised value — including any added later — degrades.
// That inversion is the guard against the sixth recurrence, and it is what
// test/bug-311-316-completion-is-allowlist.test.js pins.
//
// THE THREE THINGS 'done' NOW ASSERTS:
//   1. review — either a reviewer ran and approved, or the risk class did not
//      require one AND the caller says so explicitly (reviewRequired:false).
//      A bare 'skipped' with no such statement is not enough: that is exactly
//      the shape the 2026-08-22 build shipped, where a hardcoded
//      { verdict:'approve' } stood in for a review nobody performed.
//   2. engine — the content came from the real build engine.
//   3. refine — the visual gate did not reject it.
//
// WHY 'blind' AND 'skipped' REFINE STATUSES DO NOT DEGRADE (deliberate, pinned
// by a test). "We looked and rejected it" — 'reverted' (the regeneration was
// worse by the source rules, so the rejected original shipped) and 'exhausted'
// (the iteration bound was reached with the critique still failing) — is
// evidence of a defect. "We never looked" — refinement disabled, or the vision
// lane could not answer — is absence of evidence. Treating absence as failure
// would make every build read needs-work whenever BUILD_REFINE_ENABLED is off
// or the vision lane times out, both of which this repo records as routine, and
// a status that is always bad is a status nobody reads.
var REAL_REVIEW_APPROVED = 'approved';
var REVIEW_SKIPPED = 'skipped';
// Refine outcomes that mean the artifact was LOOKED AT and found wanting.
var REFINE_REJECTED = ['reverted', 'exhausted'];

function deriveCompletionPayload({ reviewStatus, buildEngine, refineStatus, reviewRequired } = {}) {
  var isFallbackEngine = buildEngine === 'brain-fallback' || buildEngine === 'fallback';
  var refineRejected = REFINE_REJECTED.indexOf(refineStatus) !== -1;
  var reviewProven = reviewStatus === REAL_REVIEW_APPROVED
    || (reviewStatus === REVIEW_SKIPPED && reviewRequired === false);
  var needsWork = !reviewProven || isFallbackEngine || refineRejected;
  return {
    status: needsWork ? 'needs-work' : 'done',
    evidence: { pass: !needsWork }
  };
}

// Same rule, applied to a persisted job record. BUG-316: reviewVerdict alone
// cannot distinguish a real approval from a skipped review — the skip is
// implemented upstream as a hardcoded { verdict: 'approve' } — so the recorded
// reviewStatus wins when the job carries one.
//
// A job with NO review phase at all (a planner job) has neither field. It is
// treated as a declared skip rather than an unproven one, because under the
// allowlist above the alternative is every planner job reading needs-work
// forever. That is the one place absence is read generously, and it is here
// rather than at the call sites so both readers — job_status and the announcer —
// cannot drift apart on it.
function completionForJob(job) {
  var j = job || {};
  var reviewStatus = j.reviewStatus || (j.reviewVerdict === 'reject' ? 'failed'
    : j.reviewVerdict === 'approve' ? 'approved' : 'skipped');
  return deriveCompletionPayload({
    reviewStatus: reviewStatus,
    buildEngine: j.engine,
    refineStatus: j.refineStatus,
    reviewRequired: j.reviewRequired === undefined ? false : j.reviewRequired,
  });
}

module.exports = { deriveCompletionPayload, completionForJob };
