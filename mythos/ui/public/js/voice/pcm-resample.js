// pcm-resample.js — pure linear-interpolation decimation resampler: the exact
// algorithm pcm-capture-worklet.js's PcmCaptureProcessor.process() runs inline
// (AudioWorklets in this repo take no imports — see that file's header — so
// this is a standalone, node-testable twin of the same math, not a module the
// worklet actually loads at runtime). Kept here so pcm-resample.test.js can
// exercise it under plain node:test via dynamic import(), the same pattern
// test/voice-barge-in-decision.test.js already uses for voice-loop.js's
// decideBargeIn().
//
// Any change to the resampling math in pcm-capture-worklet.js's process()
// must be mirrored here, and vice versa — they are intentionally identical.

export function createPcmResampler({ inputRate, targetRate = 16000, frameMs = 100 } = {}) {
  const ratio = inputRate / targetRate;
  const outLen = Math.round(targetRate * frameMs / 1000);
  let out = new Int16Array(outLen);
  let outIdx = 0;
  let pos = 0; // fractional read cursor into the current input block

  // Feeds one Float32Array input block (mono, samples in [-1, 1]). Calls
  // onFrame(ArrayBuffer) once per completed output frame of outLen Int16
  // samples. The fractional cursor carries across calls exactly as
  // pcm-capture-worklet.js's process() does, so no drift accumulates.
  function push(ch, onFrame) {
    while (pos < ch.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = ch[i];
      const b = i + 1 < ch.length ? ch[i + 1] : a;
      let s = a + (b - a) * frac;
      if (s > 1) s = 1; else if (s < -1) s = -1;
      out[outIdx++] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      if (outIdx >= outLen) {
        // Copy — the buffer is reused, and a transfer would detach it.
        onFrame(out.slice().buffer);
        outIdx = 0;
      }
      pos += ratio;
    }
    pos -= ch.length;
  }

  return {
    push,
    get outLen() { return outLen; },
    get outIdx() { return outIdx; }, // samples buffered but not yet emitted as a full frame
    get pos() { return pos; },       // fractional cursor — must stay within [0, ratio) between calls
    get ratio() { return ratio; },
  };
}
