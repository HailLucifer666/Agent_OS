// wakeword-worklet.js — AudioWorkletProcessor that buffers the mic's 128-sample
// render quantums into openWakeWord's native 1280-sample (80ms @ 16kHz) frame
// size and posts each completed frame to the main thread. Mirrors
// preroll-worklet.js's registration pattern (same file, same
// AudioWorkletGlobalScope constraints — no imports).
//
// This file is loaded via
// audioCtx.audioWorklet.addModule('/js/voice/wakeword-worklet.js') by
// wakeword.js, which runs its OWN AudioContext({sampleRate:16000}) — fully
// independent of voice-loop.js's mic/preroll-worklet pair.

const FRAME_SIZE = 1280; // openWakeWord's native chunk size: 80ms @ 16kHz

class WakeWordFrameProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.buffer = new Float32Array(FRAME_SIZE);
    this.writePos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const ch0 = input[0]; // mono — mic capture is single-channel
    if (!ch0 || !ch0.length) return true;
    for (let i = 0; i < ch0.length; i++) {
      this.buffer[this.writePos++] = ch0[i];
      if (this.writePos === FRAME_SIZE) {
        // Post a copy — the underlying buffer is reused for the next frame.
        this.port.postMessage({ type: 'frame', samples: this.buffer.slice() });
        this.writePos = 0;
      }
    }
    return true;
  }
}

registerProcessor('wakeword-frame-processor', WakeWordFrameProcessor);
