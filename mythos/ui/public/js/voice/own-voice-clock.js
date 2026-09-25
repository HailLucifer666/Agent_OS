// own-voice-clock.js — the own-voice watchdog judges on the PLAYBACK clock (BUG-455).
//
// The watchdog in s2s-bridge.js exists to catch a player that never reports the
// end of speech. It was an idle window refreshed only by ARRIVING audio chunks,
// on the belief that audio stops arriving when it stops playing. It does not:
// Gemini Live streams faster than real time, so a long reply has fully arrived
// while the room is still hearing it.
//
// MEASURED 2026-09-24 (attended run, build bd4df360): 20 of 50 own-voice holds
// ended on the ceiling, 10.9-15.6 s after they began. All but one belonged to a
// reply of 43-94 audio chunks, and none of the 20 replies under 43 chunks did.
// Eight seconds after the last chunk landed, the gate reopened the mic while
// MYTHOS was still talking. At 14:53:35 that let its own voice back in, and
// Gemini cut the reply 115 ms later on the word "November". No barge-in was
// refused in any of the 20 (bargeVetoed 0), so the early release rescued nobody.
//
// The rule now: while the player says it is still speaking AND its clock is
// moving, wait for what is queued plus the same idle window, then look again.
// A clock that stopped (a suspended AudioContext) is exactly the broken player
// the watchdog is for, so it is judged at once. The 30 s absolute cap in
// s2s-bridge.js (armOwnVoiceMaxHold) is untouched and still bounds every hold.
//
// Pure: no DOM, no timers, clock injectable, so node:test drives it with the
// real pcm-player (test/bug-455-mic-waits-for-playback.test.js).

// The player's clock must advance at least half as fast as the wall clock for
// playback to count as progressing. A running AudioContext advances at 1.0; a
// suspended one at 0. Any value between the two separates them.
export const PLAYBACK_PROGRESS_MIN_RATIO = 0.5;

export function createOwnVoiceClock({ now = () => Date.now() } = {}) {
  let armedAt = 0;
  let armedContextTime = null;
  let waits = 0;
  let stalled = false;

  function playheadOf(player) {
    try { return player && typeof player.playhead === 'function' ? player.playhead() : null; } catch (_) { return null; }
  }

  return {
    // A new hold began: nothing waited yet.
    reset() { armedAt = 0; armedContextTime = null; waits = 0; stalled = false; },
    // The watchdog timer was (re)armed: note both clocks, so check() can tell a
    // moving playhead from a frozen one.
    armed(player) {
      armedAt = now();
      const p = playheadOf(player);
      armedContextTime = p && typeof p.contextTime === 'number' ? p.contextTime : null;
    },
    // Milliseconds to wait before judging, or 0 to judge now.
    check(player, idleMs) {
      if (!player || typeof player.isSpeaking !== 'function' || !player.isSpeaking()) return 0;
      const p = playheadOf(player);
      const wallMs = now() - armedAt;
      const playedMs = p && typeof p.contextTime === 'number' && armedContextTime !== null
        ? (p.contextTime - armedContextTime) * 1000 : 0;
      if (wallMs > 0 && playedMs < wallMs * PLAYBACK_PROGRESS_MIN_RATIO) { stalled = true; return 0; }
      waits += 1;
      const queuedMs = p && Number.isFinite(p.aheadMs) && p.aheadMs > 0 ? p.aheadMs : 0;
      return Math.round(queuedMs) + idleMs;
    },
    get waits() { return waits; },
    get stalled() { return stalled; },
  };
}
