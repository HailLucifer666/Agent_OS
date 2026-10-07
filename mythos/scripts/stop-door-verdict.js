'use strict';
// stop-door-verdict.js — did each barge-in stop actually cut MYTHOS's speech?
// B1b of the Stage 1 repair campaign (2026-09-26), BUG-469, operator decision C1 row 13.
// Pure (no I/O) and separate from verify-voice-session.js so its tests share one rule.
//
// A stop cuts speech in two places, and until B1b the log carried only the second:
//   discardedMs       what player.flush() threw out of the speaker's queue, summed over
//                     every stop in the episode (ui/public/js/voice/stop-tally.js). 0 when
//                     nothing was queued, or when flush()'s tail guard let the last 250 ms play.
//   suppressedChunks  audio that ARRIVED after the stop and was dropped instead of played.
// Graded on suppressedChunks alone, the report printed "fired with nothing left to cut — the
// reply had already finished" whenever it was 0: 7 of the 8 stops on 2026-09-25, while the
// mic-gate recorder showed 398-5080 ms still queued at all 8.
//
// THE RULE. Cut: it discarded queued speech or dropped later audio. Nothing left to cut: the
// line MEASURED both, and both are zero. Cannot be graded: nothing later was dropped and the
// line has no valid discardedMs (a log from before B1b). Absence is never read as a measured
// zero; that reading is the defect this module replaces.
// Number.isFinite does not coerce: '1920', true and null are all refused, as is a negative.
const amount = (v) => (Number.isFinite(v) && v >= 0 ? v : null);

function gradeStopDoor(episodes) {
  const g = { reached: 0, cut: 0, cutQueued: 0, droppedLater: 0, nothingLeft: 0, ungraded: 0,
    measured: 0, discardedMs: 0, longestDiscardMs: 0, chunks: 0, longestSuppressionMs: 0 };
  for (const e of episodes) {
    const discarded = amount(e.discardedMs);
    const chunks = amount(e.suppressedChunks) || 0;
    g.reached += 1;
    g.chunks += chunks;
    g.longestSuppressionMs = Math.max(g.longestSuppressionMs, amount(e.suppressedMs) || 0);
    if (discarded !== null) {
      g.measured += 1;
      g.discardedMs += discarded;
      g.longestDiscardMs = Math.max(g.longestDiscardMs, discarded);
      if (discarded > 0) g.cutQueued += 1;
    }
    if (chunks > 0) g.droppedLater += 1;
    if (discarded > 0 || chunks > 0) g.cut += 1;
    else if (discarded === null) g.ungraded += 1;
    else g.nothingLeft += 1;
  }
  return g;
}

function describeStopDoor(g) {
  const queued = g.measured === 0
    ? 'queued speech discarded: not in this log'
    : `${g.cutQueued} discarded queued speech (${Math.round(g.discardedMs)}ms total, longest ${Math.round(g.longestDiscardMs)}ms)`;
  return `${g.reached} barge-in(s) reached the stop door, of which ${g.cut} actually cut audio: ${queued}; `
    + `${g.droppedLater} dropped ${g.chunks} audio chunk(s) that arrived after the stop (longest suppression ${g.longestSuppressionMs}ms)`
    + (g.nothingLeft ? `. ${g.nothingLeft} had nothing left to cut: the flush discarded nothing and no later audio arrived` : '')
    + (g.ungraded ? `. ${g.ungraded} CANNOT BE GRADED: this log predates discardedMs, and suppressedChunks counts only audio `
      + 'that arrived after the stop, not the speech the stop discarded, so "actually cut" above is a floor' : '');
}

module.exports = { gradeStopDoor, describeStopDoor };
