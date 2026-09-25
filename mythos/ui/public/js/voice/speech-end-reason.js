// speech-end-reason.js — WHY MYTHOS stopped speaking, for the mic gate's release log.
// B1 of the Stage 1 repair campaign (2026-09-25), BUG-469 / BUG-455.
//
// THE DEFECT. s2s-bridge.js releases the half-duplex mic gate from two kinds of
// place: the player's onSpeakEnd (speech ran out), and the stop doors — a local
// barge-in (stopAssistantSpeech) and Gemini's own interruption (onInterruptedMsg).
// Both stop doors call player.flush() FIRST. flush() -> stopAll() -> markStopped()
// fires onSpeakEnd synchronously, before flush() returns, and onSpeakEnd released
// the gate as 'own-voice-ended'. The stop door's own release then found the gate
// already open and returned without logging. So every interruption, local or
// server, was logged as a natural end, and a log could not tell them apart: the 41
// 'own-voice-ended' releases of the 2026-09-25 session cannot be read as 41 replies
// that finished.
//
// THE FIX IS LABELLING ONLY. The gate releases at exactly the moment it did before;
// this only decides the reason written beside it. A stop door runs its flush inside
// during(reason, ...), so an onSpeakEnd the flush fires is attributed to that stop.
//
// THE TAIL GUARD. flush() spares a reply with under 250 ms left and fires nothing.
// A local stop then releases the gate itself, with its reason (unchanged). A server
// interruption does not release the gate, so the tail plays out and the release
// comes at its natural end: that one is logged '<reason>-tail-finished', because it
// is neither a plain natural end nor a cut.
//
// Browser ES module, no imports: node:test loads it directly (see ui/CLAUDE.md).
export const NATURAL_END = 'own-voice-ended';
export const TAIL_SUFFIX = '-tail-finished';

export function createSpeechEndReason() {
  let stopping = null;   // the stop whose flush is running right now
  let spared = null;     // a stop that ran while speech continued (the tail guard)

  return {
    // Run a stop door's flush with `reason` as the cause of any speech end it fires.
    // Cleared in finally: a flush that throws must not leave a stale reason behind.
    during(reason, flush) {
      stopping = reason;
      spared = reason;
      try { return flush(); } finally { stopping = null; }
    },
    // A new utterance started: an earlier stop no longer explains anything.
    speechStarted() { spared = null; },
    // The reason for THIS end, consumed: the stop in progress, a stop that spared
    // this utterance's tail, or a natural end.
    ended() {
      const reason = stopping || (spared ? spared + TAIL_SUFFIX : NATURAL_END);
      spared = null;
      return reason;
    },
  };
}
