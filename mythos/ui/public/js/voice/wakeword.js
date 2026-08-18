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
import { openMicWithFallback, micErrorMessage, micConstraintShape } from './mic-device.js';

// Shared with createWakeWord below AND exported for tests. openWakeWord's mel
// bin count is fixed by the model, so these are module constants, not
// per-instance state.
export const MEL_BINS = 32;
// BUG-175: openWakeWord's own melspectrogram transform — see reshapeMelOutput.
// Named rather than inline so the two halves of `x/10 + 2` cannot drift apart
// or be mistaken for magic numbers.
export const MEL_SCALE_DIV = 10;
export const MEL_SCALE_ADD = 2;

// Python does `spec = np.squeeze(outputs[0])`, producing a 2D (frames, 32)
// array. onnxruntime-web gives us flat data + dims instead of squeeze — this
// strips singleton dims and treats the last remaining dimension as mel bins,
// which is robust to whatever rank the specific ONNX export reports.
//
// BUG-175 — THE MEL SCALING IS NOT OPTIONAL AND IS NOT A TUNING KNOB.
// openwakeword/utils.py's AudioFeatures._get_melspectrogram does:
//     spec = np.squeeze(outputs[0])
//     spec = spec/10 + 2      # "Arbitrary transform of melspectrogram"
// and the embedding model was TRAINED on features in that scale. This port
// reproduced every tensor SHAPE from that same source (1280-sample chunks,
// 32 bins, 76-frame window, stride 8, 96-dim output) and missed the one
// VALUE transform, which left the embedding model reading out-of-distribution
// input and the classifier floored near zero. That is why "hey jarvis" never
// fired for a week while the HUD honestly reported a live mic: the microphone
// was fine, the detector was deaf.
//
// MEASURED, on real synthesized speech through these exact three ONNX models
// (2026-08-07, harness replicating onFrame() in node):
//     "hey jarvis"          without: 0.0073   with: 0.998   (threshold 0.5)
//     unrelated speech      without: 0.00019  with: 0.0000305
// 137x on the target phrase, and the NON-target score drops — so this is a
// corrected feature scale, not a sensitivity trade. Do not "simplify" it away.
export function reshapeMelOutput(out) {
  const dims = out.dims.filter((d) => d !== 1);
  const bins = dims.length ? dims[dims.length - 1] : MEL_BINS;
  const data = out.data;
  const frames = Math.floor(data.length / bins);
  const rows = [];
  for (let i = 0; i < frames; i++) {
    const row = Float32Array.from(data.subarray(i * bins, (i + 1) * bins));
    for (let k = 0; k < row.length; k++) row[k] = row[k] / MEL_SCALE_DIV + MEL_SCALE_ADD;
    rows.push(row);
  }
  return rows;
}

export function createWakeWord({ threshold, onWake, onStatus }) {
  const THRESHOLD = typeof threshold === 'number' ? threshold : 0.5;
  const REFRACTORY_MS = 2000;
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

  // BUG-150: liveness + diagnostics. Until these existed, "the detector is
  // listening" was an ASSERTION — start() returned true once the audio graph was
  // wired, having never confirmed a single frame arrived or a single score was
  // computed. Every silent failure mode (a suspended AudioContext, a worklet that
  // never fires, a mic delivering nothing) builds that graph without throwing, so
  // all of them reported "Standby — listening". A week of "hey jarvis" produced no
  // information because nothing here was ever measured or logged.
  let framesSeen = 0;         // incremented in the port handler, BEFORE the running gate
  let peakScore = 0;          // rolling peak since the last metrics report
  let scoresComputed = 0;     // how many times the CLASSIFIER actually ran
  let framesAtLastReport = 0;
  let metricsTimer = null;
  let ctxStateAtStart = null; // AudioContext.state as measured, not as assumed
  // BUG-272 W1: the 2026-08-17 session could not tell WHY getUserMedia threw
  // OverconstrainedError, because nothing recorded what was requested. These
  // carry shape flags and real track settings, never the device id itself.
  let micFallbackFired = false;
  let micConstraintsRequested = null;
  let micTrackSettings = null;

  // What the browser ACTUALLY granted, as opposed to what was asked for — the
  // pair is what makes an OverconstrainedError diagnosable.
  //
  // Q4 (what is standing next to it?) — MediaTrackSettings includes `deviceId`
  // and `groupId`, so returning getSettings() verbatim would put exactly the
  // identifier micConstraintShape() is careful to omit straight into a log
  // line, one field away. Pick the fields explicitly; never spread this object.
  function trackSettingsOf(s) {
    try {
      const track = s && s.getAudioTracks && s.getAudioTracks()[0];
      if (!track || typeof track.getSettings !== 'function') return null;
      const st = track.getSettings() || {};
      return {
        sampleRate: st.sampleRate ?? null,
        channelCount: st.channelCount ?? null,
        echoCancellation: st.echoCancellation ?? null,
        noiseSuppression: st.noiseSuppression ?? null,
        autoGainControl: st.autoGainControl ?? null,
      };
    } catch (_) {
      return null;
    }
  }
  // Generous: ~18 frames (1280 samples / 80ms each) are expected in this window,
  // so zero means genuinely no audio rather than a slow machine.
  const FIRST_FRAME_TIMEOUT_MS = 3000;
  const METRICS_INTERVAL_MS = 5000;

  function status(kind, msg, data) { if (onStatus) onStatus(kind, msg, data); }

  // The single most diagnostic number available, and it was being thrown away on
  // every frame that didn't cross the threshold. Reported WITH the threshold, so
  // the two are never read apart: a peak of 0.42 against 0.5 is a tuning problem,
  // a peak of 0.001 is a dead pipeline, and they look identical without both.
  function reportMetrics() {
    if (!running) return;
    const framesSince = framesSeen - framesAtLastReport;
    framesAtLastReport = framesSeen;
    const peak = peakScore;
    const scored = scoresComputed;
    peakScore = 0;
    scoresComputed = 0;
    status('metrics', 'wake-word listening', {
      // 6dp, not 4: a real classifier on silence emits values like 1e-6, and
      // rounding those to a flat 0.0000 is indistinguishable from a classifier
      // that never ran — which is exactly the ambiguity `scores` below resolves.
      peakScore: Number(peak.toFixed(6)),
      // THE decisive counter. frames>0 with scores==0 means audio arrives but the
      // mel -> embedding -> classifier chain never completes a window, i.e. the
      // detector is structurally incapable of ever firing. frames>0 with scores>0
      // means the pipeline is whole and the only question left is the score value.
      scores: scored,
      frames: framesSince,
      framesTotal: framesSeen,
      threshold: THRESHOLD,
      ctxState: audioCtx ? audioCtx.state : null,
      streamLive: Boolean(stream && stream.getAudioTracks().some((t) => t.readyState === 'live')),
    });
  }

  function waitForFirstFrame(timeoutMs) {
    if (framesSeen > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      (function poll() {
        if (framesSeen > 0) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(poll, 50);
      })();
    });
  }

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
        // BUG-150: remember the highest score seen, whether or not it fires. This
        // is what turns "it never works" into a number that names the cause.
        scoresComputed++;
        if (score > peakScore) peakScore = score;
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
    // BUG-272 W1: a stale MYTHOS_MIC_DEVICE id used to end the wake word for the
    // whole session here — deviceId:{exact} is a hard constraint, so
    // OverconstrainedError repeated on every arm attempt and nothing re-armed.
    // openMicWithFallback clears the proven-bad id and retries on the OS
    // default, reporting the degrade rather than hiding it.
    // Recorded BEFORE the attempt so a rejection still reports what was asked
    // for — that is the fact the 2026-08-17 session was missing.
    micConstraintsRequested = micConstraintShape();
    const opened = await openMicWithFallback();
    stream = opened.stream;
    micFallbackFired = opened.fallbackFired;
    micConstraintsRequested = opened.requested;
    micTrackSettings = trackSettingsOf(stream);
    if (opened.fallbackFired) {
      status('degraded', 'Saved microphone was unavailable — fell back to the system default. '
        + micErrorMessage(opened.originalError), { fallbackFired: true });
    }
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    // BUG-150: Chromium creates an AudioContext 'suspended' unless it is made
    // during a user gesture, and a suspended context wires its whole graph
    // happily while NEVER running the worklet — a silently deaf detector that
    // reports success. The Electron shell relaxes this
    // (--autoplay-policy=no-user-gesture-required, electron/main.js), which makes
    // it unlikely here but does not make it false, and nothing in this file ever
    // read the state to find out. pcm-player.js:16 already does exactly this for
    // playback; capture needs it just as much. Idempotent when already running.
    ctxStateAtStart = audioCtx.state;
    if (audioCtx.state === 'suspended') {
      try { await audioCtx.resume(); } catch (_) { /* reported via the state below */ }
    }
    // A context can also be suspended LATER — an OS audio-device change, sleep/
    // resume — which would otherwise turn the detector quietly deaf mid-session
    // with the caption still promising it is listening.
    audioCtx.addEventListener('statechange', () => {
      if (!running || !audioCtx) return;
      if (audioCtx.state === 'suspended') {
        status('degraded', 'Wake word stopped receiving audio (context suspended) — trying to resume', { ctxState: audioCtx.state });
        audioCtx.resume().catch(() => {});
      }
    });
    const source = audioCtx.createMediaStreamSource(stream);
    // addModule() rejects with the same generic "Unable to load a worklet's
    // module" for every cause — a 404, a script that throws, or an AudioContext
    // whose render thread never started. On a packaged 0.1.7 install that message
    // was the whole diagnosis available, and it was not enough: the file serves
    // HTTP 200 as application/javascript and contains no import, so the fetch was
    // never the problem (operator, 2026-08-13). Re-throw with the state that
    // actually distinguishes the causes.
    try {
      await audioCtx.audioWorklet.addModule('/js/voice/wakeword-worklet.js');
    } catch (err) {
      const detail = `${err && err.name ? err.name : 'Error'}: ${err && err.message ? err.message : String(err)}`
        + ` [ctx.state=${audioCtx.state} sampleRate=${audioCtx.sampleRate} baseLatency=${audioCtx.baseLatency}]`;
      throw new Error(`addModule(wakeword-worklet) failed — ${detail}`);
    }
    workletNode = new AudioWorkletNode(audioCtx, 'wakeword-frame-processor');
    workletNode.port.onmessage = (e) => {
      if (!e.data || e.data.type !== 'frame') return;
      // BUG-150: counted BEFORE onFrame's `if (!running) return` gate, and before
      // any inference. This counter is the evidence that audio is physically
      // arriving, independent of whether the model does anything useful with it.
      framesSeen++;
      onFrame(e.data.samples);
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
      // BUG-272 W1: this used to surface the raw error ("OverconstrainedError"),
      // which told the operator nothing actionable. micErrorMessage already maps
      // every getUserMedia error name to operator-readable text — reuse it
      // rather than adding a second mapper. constraintsRequested says whether an
      // exact-device constraint was in play, which is the one fact that
      // separates a stale saved device from a genuinely missing mic.
      status('error', 'Wake word could not start: ' + micErrorMessage(err), {
        errorName: (err && err.name) || null,
        constraintsRequested: micConstraintsRequested,
        fallbackFired: micFallbackFired,
      });
      stop();
      return false;
    }
    // Set BEFORE waiting: onFrame's own `if (!running) return` gate would
    // otherwise discard every frame we are waiting for.
    running = true;

    // BUG-150: the detector must PROVE it is receiving audio before claiming to
    // listen. Everything above can succeed while no frame ever arrives, and that
    // is precisely the state the operator spent a week in — a caption saying
    // "Standby — listening" over a detector that was deaf. Returning false here
    // means app.js reports the failure and lets a later gesture re-arm, exactly
    // as it already does for a throwing start().
    const gotAudio = await waitForFirstFrame(FIRST_FRAME_TIMEOUT_MS);
    if (!gotAudio) {
      const live = Boolean(stream && stream.getAudioTracks().some((t) => t.readyState === 'live'));
      status('silent',
        'Wake word armed but received no audio in ' + (FIRST_FRAME_TIMEOUT_MS / 1000) + 's — not listening',
        { ctxState: audioCtx ? audioCtx.state : null, ctxStateAtStart: ctxStateAtStart, streamLive: live, frames: 0 });
      stop();
      return false;
    }

    status('listening', 'Wake word receiving audio', {
      ctxState: audioCtx ? audioCtx.state : null,
      ctxStateAtStart: ctxStateAtStart,
      framesToFirstAudio: framesSeen,
      threshold: THRESHOLD,
      // BUG-272 W1: requested-vs-actual on the success line too, so a session
      // that armed can still be compared against one that did not.
      constraintsRequested: micConstraintsRequested,
      constraintsActual: micTrackSettings,
      fallbackFired: micFallbackFired,
    });
    metricsTimer = setInterval(reportMetrics, METRICS_INTERVAL_MS);
    return true;
  }

  function stop() {
    running = false;
    // BUG-150: the metrics interval must die with the detector, or it keeps
    // reporting "listening" for a detector that has released the microphone.
    if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
    framesSeen = 0;
    framesAtLastReport = 0;
    peakScore = 0;
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
