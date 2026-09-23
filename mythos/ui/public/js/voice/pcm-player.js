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
  // WHAT DECIDES THAT A SILENT TIMELINE IS AN UNDERRUN — and this is the whole
  // difficulty. A dry timeline mid-reply is the network stalling. A dry timeline
  // between replies is the operator talking, and growing the cushion for THAT
  // would pin it at MAX and put two seconds of latency in front of every first
  // word for the rest of the session. The two are identical from inside this
  // file.
  //
  // Until 2026-08-20 the proxy was `speaking`, which END_GRACE_MS flips false
  // 250ms after the audio runs out. It never produced a false positive, and it
  // was deaf to exactly the gaps that motivated the fix: measured on a live
  // clock, a 477ms arrival gap grew the cushion and the 954ms and 1486ms gaps —
  // the worst ones, the ones that sound like one word per second — did not,
  // because the reply had been declared over 250ms into the stall.
  //
  // It is now the real thing: `turnOpen`, ended by the `live-turn-complete`
  // frame the server already broadcasts and s2s-bridge.js already listens to.
  // A model turn is open or it is not; there is no window to tune, and the
  // longest network stall inside a turn is still attributed correctly.
  //
  // MAX is 2s because the gaps measured on the operator's own link on
  // 2026-08-19 reached 1486ms. Past that the added latency stops being worth
  // paying and the honest reading is that the connection cannot carry a live
  // conversation — which is what stats().cushionAtMax is for.
  const CUSHION_BASE_SEC = 0.25;
  const CUSHION_MARGIN_SEC = 0.25;
  const CUSHION_MAX_SEC = 2.0;
  // Is a model turn open? Set by any chunk arriving, cleared by endTurn() (the
  // server's own turn boundary) and by stopAll(). Only while this is true can a
  // dry timeline be blamed on the transport.
  let turnOpen = false;

  // THE FAIL-SAFE ON THAT SIGNAL, because trusting it unconditionally fails in the
  // dangerous direction. If `live-turn-complete` never arrives — dropped socket,
  // rotated session, a server-side path that forgets to send it — turnOpen stays
  // true forever, and then the FIRST chunk of the next reply, after however long
  // the operator took to speak, is scored as one enormous underrun and pins the
  // cushion at MAX for the session. That is the outcome this whole mechanism
  // exists to avoid, arrived at by a lost frame.
  //
  // So a dry period this long is not treated as jitter no matter what turnOpen
  // says: growth is declined and the run is closed. 3s is well past the worst
  // measured stall (1486ms arrival gap, ~1.1s dry) and well short of any
  // conversational turnaround worth mistaking for one. When it fires it means the
  // turn boundary was lost, not that the link is bad, so it is counted separately
  // and reported — a fail-safe nobody can see is the same inert mechanism this
  // ticket keeps finding.
  const UNDERRUN_ATTRIBUTION_MAX_SEC = 3.0;
  let missedTurnEnds = 0;

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
    // `turnOpen` is the guard against learning from the wrong silence: a gap
    // between TURNS is the operator talking and must never inflate the cushion.
    // Checked BEFORE this chunk opens a turn of its own — the first chunk after a
    // boundary is by definition not an underrun, however long the pause before it.
    if (drained && turnOpen) {
      // Mid-reply underrun: the room just heard a gap, and we know its length —
      // the timeline ran out at nextAt and it is now currentTime. Grow to cover
      // THAT plus a margin, so one stutter is enough to size the cushion rather
      // than the seven it would take to creep there in fixed steps.
      const drySec = c.currentTime - nextAt;
      if (drySec > UNDERRUN_ATTRIBUTION_MAX_SEC) {
        // Longer than any stall worth cushioning, inside a turn that says it is
        // still running: the turn boundary was lost, not the packets. Decline the
        // growth and close the run by hand, so one missed frame costs a single
        // uncounted gap instead of a permanently inflated cushion.
        missedTurnEnds += 1;
        turnOpen = false;
      } else {
        if (drySec > worstDrySec) worstDrySec = drySec;
        cushionSec = Math.min(CUSHION_MAX_SEC, Math.max(cushionSec, drySec + CUSHION_MARGIN_SEC));
        underruns += 1;
      }
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
    // Audio is arriving, so a model turn is open — whatever the server's boundary
    // frames have or have not said. Set AFTER the underrun check above, never
    // before: otherwise every first chunk would score its own arrival as a stall.
    turnOpen = true;
    markSpeaking();
  }

  // The server's turn boundary, forwarded by s2s-bridge.js from the
  // 'live-turn-complete' broadcast (and from 'live-interrupted', which ends a turn
  // just as definitely). This is the ONLY thing that can tell the cushion apart
  // from a conversation: after this, silence is the operator thinking, not the
  // link stalling, and the next chunk starts a fresh run rather than closing a gap.
  //
  // Deliberately not the same call as flush(): a barge-in stops PLAYBACK while the
  // server keeps streaming the same turn, and a turn ending stops the TURN while
  // whatever is already scheduled plays out. Collapsing them would make one of the
  // two wrong, and it was the flush/turn confusion that produced this ticket.
  function endTurn() { turnOpen = false; }

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
    // Closed for ATTRIBUTION purposes only. The server may well still be streaming
    // this turn (that is exactly what the barge-in suppression in s2s-bridge.js is
    // for), but nothing that arrives after a stop can tell us anything about jitter:
    // the timeline was emptied deliberately, so the next gap is not the network's
    // fault. Erring toward not-counting is the safe direction throughout this file.
    turnOpen = false;
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
  // Q3 — WHO ACTUALLY READS THIS: s2s-bridge.js's logSuspendTransition(), which puts
  // cushionMs on EVERY capture-suspend line and underruns/missedTurnEnds beside it
  // when they are non-zero (server/index.js allowlists all three). From there
  // scripts/verify-voice-session.js reads them against the server's own
  // live.turn-parts.audioStarveEvents — the client and server halves of one question.
  //
  // cushionMs is unconditional on purpose. It was briefly sent only when something had
  // stuttered, which is wrong in the direction that matters: a cushion doing its job
  // absorbs the late chunk and records NO underrun, so the field would have vanished
  // from the log exactly when the mechanism worked, while the server still logged
  // starvation for the same turn. A stat that is only sometimes emitted reads as a
  // stat that is always emitted, and that is how a zero gets believed.
  function stats() {
    return {
      cushionSec, underruns, worstDrySec,
      cushionAtMax: cushionSec >= CUSHION_MAX_SEC,
      // How many times a turn ran past UNDERRUN_ATTRIBUTION_MAX_SEC while still
      // claiming to be open. Reported because it means the turn-boundary signal
      // this file now depends on is not arriving — a different fault from a slow
      // link, wanting a different fix, and otherwise indistinguishable from a
      // quiet session. Non-zero here says read the server's turn frames, not the
      // cushion.
      missedTurnEnds,
    };
  }
  // close() is a real teardown (session ending), not a barge-in guess — it
  // always stops everything immediately, bypassing flush()'s tail guard. The
  // cushion resets with it: it describes one session's link, not the machine.
  // BUG-406 recorder: how far ahead of its own clock the player has audio queued
  // (nextAt is the end of the last scheduled chunk). 0 means nothing is left to play.
  function playhead() {
    return ctx ? { aheadMs: Math.max(0, (nextAt - ctx.currentTime) * 1000), contextTime: ctx.currentTime } : { aheadMs: 0, contextTime: null };
  }
  return {
    enqueue, flush, isSpeaking, stats, endTurn, playhead,
    close: () => {
      stopAll();
      cushionSec = CUSHION_BASE_SEC;
      underruns = 0;
      worstDrySec = 0;
      missedTurnEnds = 0;
      if (ctx) ctx.close().catch(() => {});
      ctx = null;
    },
  };
}
