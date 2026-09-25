// stop-tally.js — how much queued speech the stops of one barge-in episode threw away.
// B1b of the Stage 1 repair campaign (2026-09-26), BUG-469. Browser ES module with no
// imports, so the test drives it directly.
//
// A barge-in stop cuts MYTHOS's speech in two places: player.flush() discards what is
// already queued in the speaker, then the suppression drops the audio that keeps arriving.
// Only the second was ever logged (suppressedChunks), and verify-voice-session.js read its 0
// as "fired with nothing left to cut". That was 7 of the 8 stops on 2026-09-25, and the
// mic-gate recorder showed 0.4-5.1 s still queued at every one of them.
//
// SUMMED, NOT THE LAST STOP. One loud run calls stopAssistantSpeech() more than once: the
// eager tier fires just before the flush tier on the same frame, and the flush tier re-fires
// every holdFrames (barge-in-backstop.js). The first stop empties the queue; the next one
// flushes nothing and re-arms the suppression. A tally that kept only the latest stop would
// log 0 for exactly the episode that cut the most. It resets only when the episode ends,
// which is when the bridge writes the line.
export function createStopTally() {
  let discardedMs = 0;
  return {
    stopped(ms) { if (Number(ms) > 0) discardedMs += Number(ms); },
    ended() { const total = Math.round(discardedMs); discardedMs = 0; return total; },
  };
}
