// preroll-worklet.js — AudioWorkletProcessor that maintains a ring buffer of
// the last ~1 second of mic audio. Runs off the main thread (zero GC, zero
// main-thread cost). When the VAD confirms speech, the main thread posts
// 'snapshot' and receives the buffer contents back — the pre-roll that gets
// prepended to the MediaRecorder output so the first 1-3 words aren't lost.
//
// The ring is a Float32Array of channelCount * ringLength samples. We store
// mono (channel 0) only — Whisper transcribes mono, stereo is wasted bytes.
//
// This file is loaded via audioCtx.audioWorklet.addModule('/js/voice/preroll-worklet.js')
// — it runs in the AudioWorkletGlobalScope, NOT the main JS context. No imports.

class PrerollProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // Ring buffer: holds the last ~1s of mono audio at the context sample rate
    // (typically 48000 Hz → 48000 samples = 1s = 192KB). Enough to cover the
    // 300ms hold gate plus onset detection latency with comfortable margin.
    const sr = sampleRate; // global in AudioWorkletGlobalScope
    this.ringLength = Math.ceil(sr * 1.0); // 1 second of audio
    this.ring = new Float32Array(this.ringLength);
    this.writePos = 0;

    // Listen for snapshot requests from the main thread
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'snapshot') {
        // Copy the ring in chronological order (oldest first) into a new buffer
        const out = new Float32Array(this.ringLength);
        const tail = this.ringLength - this.writePos;
        // writePos..end is the oldest data; 0..writePos is the newest
        out.set(this.ring.subarray(this.writePos), 0);         // oldest → front
        out.set(this.ring.subarray(0, this.writePos), tail);   // newest → back
        this.port.postMessage({ type: 'snapshot', samples: out, sampleRate: sr });
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    // Take channel 0 (mono) — Whisper transcribes mono
    const ch0 = input[0];
    if (!ch0 || !ch0.length) return true;
    // Copy samples into the ring, overwriting the oldest data
    for (let i = 0; i < ch0.length; i++) {
      this.ring[this.writePos] = ch0[i];
      this.writePos = (this.writePos + 1) % this.ringLength;
    }
    return true;
  }
}

registerProcessor('preroll-processor', PrerollProcessor);
