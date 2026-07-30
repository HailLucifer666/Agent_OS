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

  function flush() {                    // barge-in / interrupted
    for (const s of live) { try { s.stop(); } catch {} }
    live.clear();
    nextAt = ctx ? ctx.currentTime : 0;
  }

  function isSpeaking() { return ctx ? nextAt > ctx.currentTime + 0.02 : false; }
  return { enqueue, flush, isSpeaking, close: () => { flush(); if (ctx) ctx.close().catch(() => {}); ctx = null; } };
}
