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
function deriveCompletionPayload({ reviewStatus, buildEngine } = {}) {
  var isFallbackEngine = buildEngine === 'brain-fallback' || buildEngine === 'fallback';
  var needsWork = reviewStatus === 'failed' || isFallbackEngine;
  return {
    status: needsWork ? 'needs-work' : 'done',
    evidence: { pass: !needsWork }
  };
}

module.exports = { deriveCompletionPayload };
