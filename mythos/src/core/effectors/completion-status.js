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
// CLAUDE.md (Hermes-Agent is the only build-content engine as of 2026-07-29 —
// a build with no engine FAILS rather than shipping a plausible-but-wrong
// artifact):
//   - reviewStatus === 'failed'   -> the reviewer/reality-checker rejected it.
//   - a fallback engine was used  -> the content did not come from the real
//     engine at all, so "it works" was never actually checked.
//
// NOTE ON THE ENGINE VALUE: there is no literal 'fallback' engine tag
// anywhere in this codebase (checked build-engine.js, build-runner.js, and
// full git history) — the only build-content engines that exist are
// 'hermes' and, when Hermes is wired but transiently unreachable at runtime,
// 'brain-fallback' (build-engine.js's brainFallback()). 'fallback' is kept
// as an accepted alias here only in case an older/external job record used
// that literal value; it is not otherwise reachable from current code.
//
// This module is deliberately tiny and dependency-free (no bus, no vault) so
// both the shipping path (agent-actions.js, which sets reviewStatus) and the
// spoken/HUD path (conversation/announcer.js, which only has reviewVerdict)
// can share one rule instead of drifting.
function deriveCompletionPayload({ reviewStatus, buildEngine } = {}) {
  var isFallbackEngine = buildEngine === 'brain-fallback' || buildEngine === 'fallback';
  var needsWork = reviewStatus === 'failed' || isFallbackEngine;
  return {
    status: needsWork ? 'needs-work' : 'done',
    evidence: { pass: !needsWork }
  };
}

module.exports = { deriveCompletionPayload };
