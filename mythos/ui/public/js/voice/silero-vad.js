// silero-vad.js — Silero VAD (MIT, snakers4/silero-vad) driven directly
// through onnxruntime-web, same loading pattern as wakeword.js:
// import('/vendor/onnxruntime/ort.min.mjs'), ort.InferenceSession.create().
// No new client dependency — @ricky0123/vad-web is only a thin wrapper over
// this exact model (see scripts/setup-silero.js for the sourcing story,
// including a real bug it caught: a naively-fetched copy of the model from
// snakers4/silero-vad's own repo carried the right input/output NAMES but
// produced near-zero speech probability on real speech; the npm-published
// wrapper's bundled copy, fetched here, was verified live against a known
// speech fixture to score correctly).
//
// MODEL CONTRACT (verified live against the real ONNX graph, not guessed —
// same discipline wakeword.js uses for its tensor shapes):
//   inputs:  input  float32 [1, N]   one frame, N=512 samples for 16kHz audio
//            state  float32 [2,1,128]  recurrent state, fed back every call
//            sr     int64   scalar   sample rate (16000)
//   outputs: output float32 [1,1]   speech probability, 0..1
//            stateN float32 [2,1,128]  updated state — feed into the NEXT call
//
// voice-loop.js's VAD tick runs every 100ms reading the analyser's raw
// time-domain samples at the AudioContext's real sample rate (commonly
// 48000Hz), not 16kHz — resampleLinear() below converts, and the caller
// accumulates resampled samples across ticks (a 100ms tick doesn't divide
// evenly into 512-sample frames) before calling probeFrame().

const FRAME_SAMPLES = 512;      // one Silero frame at 16kHz (32ms)
const MODEL_SAMPLE_RATE = 16000;
const STATE_SIZE = 2 * 1 * 128;

// Linear-interpolation resampler — the exact same algorithm as
// providers/local-whisper-stt.js's resampleLinear(), deliberately duplicated
// rather than shared: this runs in the browser (ESM, no bundler) and that one
// runs in Node; keeping a real build/shared-module step out of a
// bundler-less HUD is the point of driving the ONNX directly in the first
// place (see the plan for this work). Identity when the rates already match.
export function resampleLinear(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const a = samples[idx] ?? 0;
    const b = idx + 1 < samples.length ? samples[idx + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

// Pure: merges a new resampled chunk onto a carry-over buffer and slices off
// as many complete FRAME_SAMPLES-length frames as are available, returning
// the frames plus whatever remainder to carry into the next call. Exported
// so the accumulation logic (which sample ends up in which frame, across
// arbitrary chunk sizes) is unit-testable without ORT or the DOM.
export function accumulateFrames(carry, chunk, frameSize = FRAME_SAMPLES) {
  const merged = new Float32Array(carry.length + chunk.length);
  merged.set(carry, 0);
  merged.set(chunk, carry.length);
  const frames = [];
  let offset = 0;
  while (offset + frameSize <= merged.length) {
    frames.push(merged.subarray(offset, offset + frameSize));
    offset += frameSize;
  }
  return { frames, remainder: merged.subarray(offset) };
}

// Owns the ONNX session + recurrent state. ensureLoaded() is idempotent and
// safe to call repeatedly; probeFrame() is a no-op (resolves null) until
// loaded, so a caller mid-load just keeps using its RMS fallback for that
// tick — never blocks, never throws into the VAD loop.
export function createSileroVad({ modelUrl = '/models/silero/silero_vad.onnx', sampleRate = MODEL_SAMPLE_RATE } = {}) {
  let ort = null;
  let session = null;
  let state = new Float32Array(STATE_SIZE);
  let ready = false;
  let loadingPromise = null;

  async function ensureLoaded() {
    if (ready) return true;
    if (!loadingPromise) {
      loadingPromise = (async () => {
        // ADAPT: matches wakeword.js's exact loading pattern/comment — the
        // ESM bundle filename varies across onnxruntime-web versions.
        const mod = await import('/vendor/onnxruntime/ort.min.mjs');
        ort = mod;
        ort.env.wasm.wasmPaths = '/vendor/onnxruntime/';
        session = await ort.InferenceSession.create(modelUrl);
      })();
    }
    try {
      await loadingPromise;
      ready = true;
      return true;
    } catch (err) {
      console.warn('[voice] Silero VAD failed to load, falling back to RMS:', err);
      return false;
    }
  }

  // frame must be exactly FRAME_SAMPLES (512) samples at `sampleRate` (16000),
  // Float32, range -1..1. Returns a speech probability 0..1, or null if not
  // loaded yet.
  async function probeFrame(frame) {
    if (!ready || !session) return null;
    const input = new ort.Tensor('float32', frame, [1, frame.length]);
    const stateTensor = new ort.Tensor('float32', state, [2, 1, 128]);
    const srTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(sampleRate)]), []);
    const out = await session.run({ input, state: stateTensor, sr: srTensor });
    state = out.stateN.data;
    return out.output.data[0];
  }

  // Start a fresh utterance context — clears the recurrent state so a new
  // listening session doesn't carry over stale context from a prior one.
  function reset() {
    state = new Float32Array(STATE_SIZE);
  }

  return {
    ensureLoaded,
    probeFrame,
    reset,
    get ready() { return ready; },
  };
}

export { FRAME_SAMPLES, MODEL_SAMPLE_RATE };
