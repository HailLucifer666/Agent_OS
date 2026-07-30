// pcm-capture-worklet.js — mic → 16kHz mono 16-bit PCM frames for Gemini Live.
// Registration pattern copied from wakeword-worklet.js / preroll-worklet.js.
// Resampling is linear-interpolation decimation: good enough for speech at 48k→16k,
// and it runs off the main thread so it cannot jank the HUD canvas.
//
// This file is loaded via audioCtx.audioWorklet.addModule('/js/voice/pcm-capture-worklet.js')
// — it runs in the AudioWorkletGlobalScope, NOT the main JS context. No imports.
// The resample math below is intentionally duplicated (not shared via import)
// in mythos/ui/public/js/voice/pcm-resample.js, which is what
// test/pcm-resample.test.js exercises under plain node:test — any change here
// must be mirrored there.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    this.frameMs = opts.frameMs || 100;
    this.ratio = sampleRate / this.targetRate;          // sampleRate is a global here
    this.outLen = Math.round(this.targetRate * this.frameMs / 1000);
    this.out = new Int16Array(this.outLen);
    this.outIdx = 0;
    this.pos = 0;                                       // fractional read cursor
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    while (this.pos < ch.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = ch[i];
      const b = i + 1 < ch.length ? ch[i + 1] : a;
      let s = a + (b - a) * frac;
      if (s > 1) s = 1; else if (s < -1) s = -1;
      this.out[this.outIdx++] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      if (this.outIdx >= this.outLen) {
        // Copy — the buffer is reused, and a transfer would detach it.
        this.port.postMessage(this.out.slice().buffer);
        this.outIdx = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= ch.length;                              // carry the fraction across blocks
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
