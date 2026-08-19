// pcm-player.js — schedule 24kHz PCM chunks from Gemini Live back-to-back.
// The MP3 `new Audio(data:...)` path cannot play raw PCM. flush() is barge-in.
//
// contextFactory is a test-only seam (mirrors live-session.js's createSocket):
// defaults to the real browser AudioContext; test/pcm-player.test.js injects a
// fake context so the scheduling/flush logic is node:test-able without jsdom.
// onSpeakStart/onSpeakEnd (BUG-224) turn "are we speaking" from a POLLED value
// into an edge. isSpeaking() below has always existed, but nothing fires when it
// flips, so the only way to react to MYTHOS finishing a sentence was to poll it.
// The half-duplex mic gate in s2s-bridge.js needs both edges, and a poll would
// have to run on the audio-frame path (every 100ms, forever) to get them.
// Optional and best-effort: a throwing callback must never break playback.
export function createPcmPlayer({ sampleRate = 24000, contextFactory, onSpeakStart, onSpeakEnd } = {}) {
  let ctx = null;
  let nextAt = 0;
  const live = new Set();

  // How long after the last scheduled sample before we call it "stopped".
  // Not zero: this is a ROOM, and the speaker's decay plus the room's reverb
  // tail keep arriving at the mic after the samples run out. Reopening the mic
  // the instant the buffer empties feeds that tail straight back to Gemini's
  // VAD, which is the self-interrupt this whole mechanism exists to stop.
  const END_GRACE_MS = 250;
  let speaking = false;
  let endTimer = null;

  // See the cushion block in enqueue(). BASE is what a reply starts with, and it
  // is what does most of the work: it alone absorbs any chunk arriving up to
  // BASE late, which covers the 272ms and 298ms gaps measured on 2026-08-19
  // outright. On an underrun the cushion grows to cover the silence that just
  // happened plus MARGIN, rather than by a fixed step — an underrun reports
  // exactly how long the timeline was dry, so one is enough to size the cushion
  // instead of creeping up on it over seven more stutters.
  //
  // BUT THE GROWTH HAS A CEILING IT DOES NOT CHOOSE, AND IT IS NOT MAX. Growth
  // requires `speaking`, and END_GRACE_MS above flips that false 250ms after the
  // scheduled audio runs out. So a dry spell longer than END_GRACE_MS is not
  // counted at all: measured on a live clock, arrival gaps of 477ms grow the
  // cushion and gaps of 954ms and 1486ms — the worst ones, the ones that sound
  // like one word per second — leave it at BASE. That is deliberate and it is
  // the safe direction. The player cannot tell a stalled network from a finished
  // reply followed by an operator turn; only the turn boundary can, and that
  // lives in s2s-bridge.js. Counting a conversational pause as an underrun would
  // pin the cushion at MAX and put two seconds of latency in front of every
  // first word for the rest of the session. Under-learning is recoverable by ear;
  // that is not. Pinned by test/pcm-player-jitter-cushion.test.js's live-clock
  // case so the boundary is visible instead of being rediscovered.
  //
  // MAX is 2s because the gaps measured on the operator's own link on
  // 2026-08-19 reached 1486ms. Past that the added latency stops being worth
  // paying and the honest reading is that the connection cannot carry a live
  // conversation — which is what stats().cushionAtMax is for. Given the ceiling
  // above, MAX binds only on a link that stutters repeatedly WITHIN the grace
  // window; it is a backstop, not the operating range.
  const CUSHION_BASE_SEC = 0.25;
  const CUSHION_MARGIN_SEC = 0.25;
  const CUSHION_MAX_SEC = 2.0;
  let cushionSec = CUSHION_BASE_SEC;
  let underruns = 0;
  let worstDrySec = 0;
  // Where the current continuous run of audio starts playing. flush()'s tail
  // guard uses it to tell scheduled SILENCE (the cushion) from scheduled speech.
  let runStartsAt = 0;

  function clearEndTimer() {
    if (endTimer) { clearTimeout(endTimer); endTimer = null; }
  }

  // Re-armed on every enqueue: a continuing reply keeps pushing the deadline
  // out, so the callbacks fire once per utterance, not once per 100ms chunk.
  function armEndTimer() {
    clearEndTimer();
    if (!ctx) return;
    const remainingMs = Math.max(0, (nextAt - ctx.currentTime) * 1000);
    endTimer = setTimeout(() => {
      endTimer = null;
      if (isSpeaking()) { armEndTimer(); return; }   // more audio landed meanwhile
      markStopped();
    }, remainingMs + END_GRACE_MS);
    if (typeof endTimer.unref === 'function') endTimer.unref();
  }

  function markSpeaking() {
    if (!speaking) {
      speaking = true;
      try { if (onSpeakStart) onSpeakStart(); } catch { /* never break playback */ }
    }
    armEndTimer();
  }

  function markStopped() {
    clearEndTimer();
    if (!speaking) return;
    speaking = false;
    try { if (onSpeakEnd) onSpeakEnd(); } catch { /* never break playback */ }
  }

  const makeContext = contextFactory || (() => new (window.AudioContext || window.webkitAudioContext)());

  function ensure() {
    if (!ctx) ctx = makeContext();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function enqueue(base64) {
    const c = ensure();
    const bin = atob(base64);
    const pcm = new Int16Array(bin.length / 2);
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = (bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8)) << 16 >> 16;
    }
    const buf = c.createBuffer(1, pcm.length, sampleRate);
    const f32 = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 0x8000;

    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);

    // JITTER CUSHION. The scheduling here was always gapless in principle —
    // each chunk starts where the last one ended — but it only ever led the
    // clock by 40ms, and that is the whole reason the operator hears a reply
    // come out one word at a time.
    //
    // Measured 2026-08-19 with the live.turn-parts audioStarve counters, over
    // one real session: chunks arrive later than the previous chunk finishes
    // playing on roughly half of all turns, by 272ms, 298ms, 477ms and 954ms.
    // A chunk holds ~100ms of audio and the lead was 40ms, so every one of
    // those drained the timeline and the room heard silence until the next
    // chunk landed. Nothing was dropped and nothing was broken — the audio was
    // simply played as fast as it arrived, and it does not arrive evenly.
    //
    // So the cushion is built at the START of a reply and grown whenever the
    // timeline runs dry anyway. It is self-tuning rather than a constant
    // because the jitter is a property of this network and this session, and a
    // number picked here would be wrong on the next machine. The cost is
    // real and bounded: the first word of a reply is delayed by the current
    // cushion. Continuous speech is worth more than a quarter second.
    const drained = nextAt <= c.currentTime;
    // `speaking` is the guard against learning from the wrong silence. It is still
    // true only while the player believes this reply is running, so a gap between
    // TURNS — the operator talking — cannot be mistaken for the network stalling
    // and inflate the cushion. It also costs the biggest gaps, which stop being
    // counted once END_GRACE_MS has elapsed; see the constants above for why that
    // trade goes this way rather than the other.
    if (drained && speaking) {
      // Mid-reply underrun: the room just heard a gap, and we know its length —
      // the timeline ran out at nextAt and it is now currentTime. Grow to cover
      // THAT plus a margin, so one stutter is enough to size the cushion rather
      // than the seven it would take to creep there in fixed steps.
      const drySec = c.currentTime - nextAt;
      if (drySec > worstDrySec) worstDrySec = drySec;
      cushionSec = Math.min(CUSHION_MAX_SEC, Math.max(cushionSec, drySec + CUSHION_MARGIN_SEC));
      underruns += 1;
    }
    // The 40ms is a FLOOR, not the first chunk's lead: cushionSec starts at
    // CUSHION_BASE_SEC, so the opening chunk of a session is scheduled a full base
    // cushion ahead and the Math.max only matters if BASE is ever set below 40ms.
    // (An earlier draft of this comment said the first chunk still got 40ms. It
    // does not, and that is the entire fix — 40ms of lead is what met 1486ms of
    // jitter.)
    const startAt = drained
      ? c.currentTime + Math.max(0.04, cushionSec)
      : nextAt;
    // Where the current continuous run of audio begins. flush()'s tail guard
    // needs it to tell scheduled SILENCE (the cushion) from scheduled SPEECH.
    if (drained) runStartsAt = startAt;
    src.start(startAt);
    nextAt = startAt + buf.duration;
    live.add(src);
    src.onended = () => live.delete(src);
    markSpeaking();
  }

  // Stage 2 (BUG-061): "consistently cut off at the end, losing the last one
  // or two words." A hard stop-everything flush() amputated the tail whenever
  // an interrupt landed with almost nothing left queued — including the
  // spurious 'live-interrupted' Gemini's own VAD fired on hearing our OWN
  // leaked edge-tts audio bleed back through the mic (now fixed at the
  // source in server/index.js's proactiveSpeak(), but this is a second,
  // independent guard: any near-tail-end interrupt, spurious or not, should
  // let a near-finished reply finish rather than chop its last word).
  const TAIL_GUARD_SEC = 0.25;

  function stopAll() {
    for (const s of live) { try { s.stop(); } catch {} }
    live.clear();
    // This line is also what keeps a stale runStartsAt harmless for flush()'s tail
    // guard below. runStartsAt is deliberately NOT reset here: it is only ever read
    // as `max(currentTime, runStartsAt)`, and with nextAt pinned to currentTime the
    // guard's `remainingAudio` can only come out <= 0 — whether the stale value is
    // in the past or, after a barge-in landing inside a cushion, in the future. So
    // the guard falls through to a real stop rather than protecting audio that is
    // no longer scheduled. Every new run reassigns it (enqueue() does so on the
    // drained branch, which a post-stop enqueue always takes).
    nextAt = ctx ? ctx.currentTime : 0;
    // A barge-in cut IS the end of speech, and the mic gate must reopen for it —
    // otherwise interrupting MYTHOS would leave the operator muted until the
    // timer that was measuring the audio we just threw away finally expired.
    markStopped();
  }

  function flush() {                    // barge-in / interrupted
    if (ctx) {
      // Measure the AUDIO still to play, not the timeline still to elapse. Those
      // were the same number when the lead was 40ms and are not once there is a
      // cushion: at the start of a reply the timeline runs from
      // now+cushion to now+cushion+audio, so `nextAt - currentTime` counts up to
      // two seconds of scheduled SILENCE as if it were speech worth protecting.
      // Reading it that way made a 100ms reply look like a 350ms one and stopped
      // a tail this guard exists to spare.
      const audioFrom = Math.max(ctx.currentTime, runStartsAt);
      const remainingAudio = nextAt - audioFrom;
      if (remainingAudio > 0 && remainingAudio < TAIL_GUARD_SEC) return; // let the tail finish
    }
    stopAll();
  }

  function isSpeaking() { return ctx ? nextAt > ctx.currentTime + 0.02 : false; }
  // The cushion currently in force and how many mid-reply underruns produced
  // it. Exposed for the same reason live-session.js now logs its starve
  // counters: "the audio stutters" was unattributable for two sessions because
  // nothing on either side of the wire recorded a number. A cushion that has
  // grown to CUSHION_MAX_SEC and is still underrunning is a transport verdict,
  // not a tuning problem, and this is where that shows up.
  //
  // Q3 — WHO ACTUALLY READS THIS: s2s-bridge.js's endAudioOutSuppression(), which
  // puts cushionMs/underruns on the voice.capture-suspend line (server/index.js
  // allowlists both). That is the only reader, and it fires only when a barge-in
  // suppression lifts — so these numbers reach the log on interrupted turns and
  // not on quiet ones. Adequate for the question they were added to answer
  // ("was the operator's chopped reply the network or the barge-in?") and NOT a
  // continuous record of link health; live.turn-parts.audioStarveEvents is that,
  // on the server side. Said here because a stat that is only sometimes emitted
  // reads as a stat that is always emitted, and that is how a zero gets believed.
  function stats() {
    return {
      cushionSec, underruns, worstDrySec,
      cushionAtMax: cushionSec >= CUSHION_MAX_SEC,
    };
  }
  // close() is a real teardown (session ending), not a barge-in guess — it
  // always stops everything immediately, bypassing flush()'s tail guard. The
  // cushion resets with it: it describes one session's link, not the machine.
  return {
    enqueue, flush, isSpeaking, stats,
    close: () => {
      stopAll();
      cushionSec = CUSHION_BASE_SEC;
      underruns = 0;
      worstDrySec = 0;
      if (ctx) ctx.close().catch(() => {});
      ctx = null;
    },
  };
}
