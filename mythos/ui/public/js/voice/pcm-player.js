// pcm-player.js — schedule 24kHz PCM chunks from Gemini Live back-to-back.
// The MP3 `new Audio(data:...)` path cannot play raw PCM. flush() is barge-in.
//
// contextFactory is a test-only seam (mirrors live-session.js's createSocket):
// defaults to the real browser AudioContext; test/pcm-player.test.js injects a
// fake context so the scheduling/flush logic is node:test-able without jsdom.
export function createPcmPlayer({ sampleRate = 24000, contextFactory } = {}) {
  let ctx = null;
  let nextAt = 0;
  const live = new Set();

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
