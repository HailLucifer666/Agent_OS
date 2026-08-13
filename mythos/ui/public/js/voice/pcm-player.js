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
    // 40ms floor prevents crackle when a chunk lands late.
    const startAt = Math.max(c.currentTime + 0.04, nextAt);
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
    nextAt = ctx ? ctx.currentTime : 0;
    // A barge-in cut IS the end of speech, and the mic gate must reopen for it —
    // otherwise interrupting MYTHOS would leave the operator muted until the
    // timer that was measuring the audio we just threw away finally expired.
    markStopped();
  }

  function flush() {                    // barge-in / interrupted
    if (ctx) {
      const remaining = nextAt - ctx.currentTime;
      if (remaining > 0 && remaining < TAIL_GUARD_SEC) return; // let the tail finish
    }
    stopAll();
  }

  function isSpeaking() { return ctx ? nextAt > ctx.currentTime + 0.02 : false; }
  // close() is a real teardown (session ending), not a barge-in guess — it
  // always stops everything immediately, bypassing flush()'s tail guard.
  return { enqueue, flush, isSpeaking, close: () => { stopAll(); if (ctx) ctx.close().catch(() => {}); ctx = null; } };
}
