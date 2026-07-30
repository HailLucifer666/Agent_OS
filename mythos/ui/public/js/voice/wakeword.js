// wakeword.js — always-on "hey jarvis" detector. Owns its OWN mic stream +
// 16kHz AudioContext, independent of voice-loop.js (which fully releases the
// mic when idle — see voice-loop.js stop(); standby wake-word listening must
// not be affected by that). Ported pipeline logic from openWakeWord
// (github.com/dscripka/openWakeWord, Apache-2.0 code license — see
// THIRD_PARTY_NOTICES.md; the pretrained model WEIGHTS are a separate
// CC BY-NC-SA artifact fetched by scripts/setup-wakeword.js, never committed):
// PCM 16kHz -> melspectrogram ONNX -> sliding-window speech-embedding ONNX ->
// per-wake-word classifier ONNX -> score 0..1.
//
// Tensor shapes below are grounded in openWakeWord's real source
// (openwakeword/utils.py's AudioFeatures class, openwakeword/model.py's
// Model class), fetched and read at build time — not guessed:
//   - raw audio processed in 1280-sample (80ms @ 16kHz) chunks
//   - melspectrogram output: mel bins = 32
//   - embedding window: 76 mel frames, stride 8, input tensor [1,76,32,1]
//   - embedding output dimension: 96
//   - classifier input: [1, N, 96] — N (n_feature_frames) defaults to 16 in
//     openWakeWord's own get_features(), but is read from EACH loaded
//     classifier model's own input shape at runtime below (exactly what
//     openwakeword/model.py itself does via get_input_details()), since that
//     is the one dimension openWakeWord itself does not hardcode.
// Input/output tensor NAMES are also read from each loaded ONNX session at
// runtime (session.inputNames/outputNames) rather than assumed, since the
// exact exported name isn't recoverable from the Python source alone.
import { getMicDeviceId, buildAudioConstraints } from './mic-device.js';

export function createWakeWord({ threshold, onWake, onStatus }) {
  const THRESHOLD = typeof threshold === 'number' ? threshold : 0.5;
  const REFRACTORY_MS = 2000;
  const MEL_BINS = 32;
  const EMBED_WINDOW = 76;   // mel frames per embedding window
  const EMBED_STRIDE = 8;    // mel-frame stride between successive embedding windows
  const EMBED_DIM = 96;      // speech-embedding output dimension
  const DEFAULT_CLASSIFIER_WINDOW = 16; // openWakeWord's get_features() default n_feature_frames
  const MEL_COMPACT_AT = 200;     // compact the mel-frame ring once the consumed prefix grows this large
  const FEATURE_BUFFER_MAX = 200; // cap embedding history — only the last classifierWindow ever gets used

  let running = false;
  let stream = null;
  let audioCtx = null;
  let workletNode = null;
  let ort = null;
  let melSession = null;
  let embedSession = null;
  let clsSession = null;
  let classifierWindow = DEFAULT_CLASSIFIER_WINDOW;

  let melBuffer = [];   // array of Float32Array(MEL_BINS) — running mel-frame history
  let melConsumed = 0;  // index into melBuffer where the next embedding window starts
  let featureBuffer = []; // array of Float32Array(EMBED_DIM) — embedding history
  let lastWakeAt = 0;

  function status(kind, msg) { if (onStatus) onStatus(kind, msg); }

  async function loadOrt() {
    // ADAPT: '/vendor/onnxruntime/ort.min.mjs' matches the ESM bundle name
    // shipped by the installed onnxruntime-web version (verified against
    // node_modules/onnxruntime-web/dist at build time — this filename varies
    // across versions, so re-check dist/ after any onnxruntime-web upgrade).
    const mod = await import('/vendor/onnxruntime/ort.min.mjs');
    ort = mod;
    ort.env.wasm.wasmPaths = '/vendor/onnxruntime/';
    return ort;
  }

  async function loadSessions() {
    const base = '/models/wakeword/';
    melSession = await ort.InferenceSession.create(base + 'melspectrogram.onnx');
    embedSession = await ort.InferenceSession.create(base + 'embedding_model.onnx');
    clsSession = await ort.InferenceSession.create(base + 'hey_jarvis_v0.1.onnx');
    // Read the classifier's real embedding-window length from its own input
    // shape — openwakeword/model.py does the exact same thing
    // (get_input_details()[0]['shape'][1]) rather than hardcoding it. Falls
    // back to the documented default only if the model reports a
    // non-numeric (symbolic/dynamic) dimension.
    try {
      const dim = clsSession.inputMetadata[0].shape[1];
      if (typeof dim === 'number' && dim > 0) classifierWindow = dim;
    } catch { /* keep DEFAULT_CLASSIFIER_WINDOW */ }
  }

  // Python does `spec = np.squeeze(outputs[0])`, producing a 2D (frames, 32)
  // array. onnxruntime-web gives us flat data + dims instead of squeeze — this
  // strips singleton dims and treats the last remaining dimension as mel bins,
  // which is robust to whatever rank the specific ONNX export reports.
  function reshapeMelOutput(out) {
    const dims = out.dims.filter((d) => d !== 1);
    const bins = dims.length ? dims[dims.length - 1] : MEL_BINS;
    const data = out.data;
    const frames = Math.floor(data.length / bins);
    const rows = [];
    for (let i = 0; i < frames; i++) {
      rows.push(Float32Array.from(data.subarray(i * bins, (i + 1) * bins)));
    }
    return rows;
  }

  async function runMelspectrogram(frame1280) {
    const inputName = melSession.inputNames[0];
    const tensor = new ort.Tensor('float32', frame1280, [1, frame1280.length]);
    const result = await melSession.run({ [inputName]: tensor });
    const outputName = melSession.outputNames[0];
    return reshapeMelOutput(result[outputName]);
  }

  async function runEmbedding(windowRows) {
    // windowRows: EMBED_WINDOW rows x MEL_BINS cols -> flatten to [1, 76, 32, 1]
    // (row-major frame-then-bin order matches the trailing size-1 channel dim).
    const flat = new Float32Array(EMBED_WINDOW * MEL_BINS);
    for (let i = 0; i < windowRows.length; i++) flat.set(windowRows[i], i * MEL_BINS);
    const inputName = embedSession.inputNames[0];
    const tensor = new ort.Tensor('float32', flat, [1, EMBED_WINDOW, MEL_BINS, 1]);
    const result = await embedSession.run({ [inputName]: tensor });
    const outputName = embedSession.outputNames[0];
    const data = result[outputName].data;
    return Float32Array.from(data.length === EMBED_DIM ? data : data.slice(data.length - EMBED_DIM));
  }

  async function runClassifier() {
    const windowEmbeds = featureBuffer.slice(-classifierWindow);
    const flat = new Float32Array(classifierWindow * EMBED_DIM);
    for (let i = 0; i < windowEmbeds.length; i++) flat.set(windowEmbeds[i], i * EMBED_DIM);
    const inputName = clsSession.inputNames[0];
    const tensor = new ort.Tensor('float32', flat, [1, classifierWindow, EMBED_DIM]);
    const result = await clsSession.run({ [inputName]: tensor });
    const outputName = clsSession.outputNames[0];
    return result[outputName].data[0];
  }

  async function onFrame(samples) {
    if (!running) return;
    try {
      const newRows = await runMelspectrogram(samples);
      for (const row of newRows) melBuffer.push(row);
      // Slide the embedding window forward in EMBED_STRIDE steps exactly as
      // openwakeword/utils.py's AudioFeatures streaming loop does.
      while (melBuffer.length - melConsumed >= EMBED_WINDOW) {
        const win = melBuffer.slice(melConsumed, melConsumed + EMBED_WINDOW);
        const emb = await runEmbedding(win);
        featureBuffer.push(emb);
        if (featureBuffer.length > FEATURE_BUFFER_MAX) featureBuffer.splice(0, featureBuffer.length - FEATURE_BUFFER_MAX);
        melConsumed += EMBED_STRIDE;
      }
      // Compact the mel-frame ring periodically so it doesn't grow unbounded
      // over a long-running standby session.
      if (melConsumed > MEL_COMPACT_AT) {
        melBuffer = melBuffer.slice(melConsumed);
        melConsumed = 0;
      }
      if (featureBuffer.length >= classifierWindow) {
        const score = await runClassifier();
        const now = Date.now();
        if (score >= THRESHOLD && now - lastWakeAt >= REFRACTORY_MS) {
          lastWakeAt = now;
          if (onWake) onWake(score);
        }
      }
    } catch (err) {
      // Failure honesty: any inference-time error surfaces and stops the
      // detector — never fails silently while pretending to listen.
      status('error', 'Wake-word inference failed: ' + ((err && err.message) || err));
      stop();
    }
  }

  async function ensureAudio() {
    stream = await navigator.mediaDevices.getUserMedia(buildAudioConstraints(getMicDeviceId()));
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const source = audioCtx.createMediaStreamSource(stream);
    await audioCtx.audioWorklet.addModule('/js/voice/wakeword-worklet.js');
    workletNode = new AudioWorkletNode(audioCtx, 'wakeword-frame-processor');
    workletNode.port.onmessage = (e) => {
      if (e.data && e.data.type === 'frame') onFrame(e.data.samples);
    };
    // Muted gain sink: AudioWorklet is pull-based — without a downstream
    // destination the process() callback never fires (same pattern as
    // preroll-worklet.js's wiring in voice-loop.js's ensureMic()). Muted so no
    // standby audio leaks to the speakers.
    const mutedGain = audioCtx.createGain();
    mutedGain.gain.value = 0;
    source.connect(workletNode);
    workletNode.connect(mutedGain);
    mutedGain.connect(audioCtx.destination);
  }

  async function start() {
    if (running) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || (!window.AudioContext && !window.webkitAudioContext)) {
      status('error', 'Wake-word unsupported in this browser.');
      return false;
    }
    try {
      await loadOrt();
      await loadSessions();
      await ensureAudio();
    } catch (err) {
      status('error', 'Wake-word failed to start: ' + ((err && err.message) || err));
      stop();
      return false;
    }
    running = true;
    return true;
  }

  function stop() {
    running = false;
    if (workletNode) {
      try { workletNode.port.onmessage = null; workletNode.disconnect(); } catch { /* ok */ }
      workletNode = null;
    }
    // Release the actual hardware mic — same discipline as voice-loop.js's
    // stop(). This standby stream is independent of voice-loop's own mic, so
    // releasing it here never affects an active voice-loop conversation.
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    if (melSession) { melSession.release().catch(() => {}); melSession = null; }
    if (embedSession) { embedSession.release().catch(() => {}); embedSession = null; }
    if (clsSession) { clsSession.release().catch(() => {}); clsSession = null; }
    melBuffer = [];
    melConsumed = 0;
    featureBuffer = [];
  }

  return {
    start,
    stop,
    isRunning: () => running,
  };
}
