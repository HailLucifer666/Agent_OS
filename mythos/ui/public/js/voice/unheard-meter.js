// BUG-447 (2026-09-24): how much of a Live answer the room did NOT hear.
//
// A barge-in stops playback here and nowhere else. player.flush() throws away the
// audio already queued, and the bridge then drops every later chunk of the same
// turn — while Gemini's history records the whole answer as said. This meter
// measures, in the turn's own audio timeline, where playback was cut and (if the
// suppression lifted on idle before the turn ended) where it came back. The
// bridge sends that as 'voice-unheard' on the turn's end; the server turns the
// positions into text from its own transcript (src/core/voice/unheard-answer.js).
// Numbers only: no words leave this file.
import { pcmBase64Ms } from './pcm-base64.js';

// Less unheard audio than this is not a sentence worth resuming — about one word.
// Below it the turn reports nothing, so a barge-in that spared the reply's last
// word (pcm-player's TAIL_GUARD_SEC) cannot make MYTHOS repeat a sentence that
// was heard in full.
export const MIN_UNHEARD_MS = 400;

export function createUnheardMeter({ sampleRate = 24000 } = {}) {
  let turnMs = 0;
  let unheardMs = 0;
  let cutMs = null;
  let heardAgainMs = null;

  function reset() { turnMs = 0; unheardMs = 0; cutMs = null; heardAgainMs = null; }

  return {
    // Every chunk the server forwarded for this turn counts toward its timeline,
    // played or not — that is what keeps the positions in the server's frame.
    played(b64) { turnMs += pcmBase64Ms(b64, sampleRate); },
    // Only ever called while the bridge's suppression is armed, and it is armed
    // straight after a cut() — so a cut position already exists.
    dropped(b64) {
      const ms = pcmBase64Ms(b64, sampleRate);
      turnMs += ms;
      unheardMs += ms;
    },
    // discardedMs is player.flush()'s return: the queued speech it threw away
    // (0 when its tail guard let the last word finish). Playback was cut that far
    // back from the end of what has arrived.
    cut(discardedMs) {
      const discarded = Number(discardedMs) > 0 ? Number(discardedMs) : 0;
      // A second cut after playback came back starts a new unheard stretch; the
      // report describes the most recent interruption, which is what "go ahead"
      // refers to.
      if (heardAgainMs !== null) { cutMs = null; heardAgainMs = null; unheardMs = 0; }
      if (cutMs === null) cutMs = Math.max(0, turnMs - discarded);
      unheardMs += discarded;
    },
    resumed() { if (cutMs !== null && heardAgainMs === null) heardAgainMs = turnMs; },
    // The report for the turn that just ended, or null; the meter is reset either way.
    // turnMs rides along so the server can check it against its own count: a
    // 'live-turn-complete' the HUD never received (pcm-player's missedTurnEnds)
    // would otherwise stretch this timeline across two turns and resume the wrong words.
    endTurn() {
      const report = cutMs !== null && unheardMs >= MIN_UNHEARD_MS
        ? { cutMs: Math.round(cutMs), turnMs: Math.round(turnMs), ...(heardAgainMs !== null ? { heardAgainMs: Math.round(heardAgainMs) } : {}) }
        : null;
      reset();
      return report;
    },
  };
}
