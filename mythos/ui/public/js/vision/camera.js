// camera.js — live webcam + hand-gesture recognition, fully client-side
// (MediaPipe tasks-vision GestureRecognizer, WASM — no server round-trip for
// detection, no Python, no GPU). Camera is OFF by default and only starts on
// an explicit toggle — same privacy posture as the mic. Gesture -> action
// bindings live in app.js (composition root), NOT here: this module only
// detects and reports.
//
// Debounce discipline (same principle as voice-loop's SPEECH_HOLD_TICKS):
// a gesture must be the top result for GESTURE_HOLD_TICKS consecutive
// detections to fire, then a per-gesture cooldown stops a held hand from
// re-firing every frame.

import { FilesetResolver, GestureRecognizer } from '/vendor/mediapipe/vision_bundle.mjs';

const WASM_BASE = '/vendor/mediapipe/wasm';
const MODEL_URL = '/models/gesture_recognizer.task';
const DETECT_INTERVAL_MS = 150;     // ~6-7 fps — plenty for hand poses, cheap on CPU
const GESTURE_HOLD_TICKS = 3;       // ~450ms sustained before firing
const GESTURE_COOLDOWN_MS = 2000;   // per-gesture refractory period after firing
const MIN_CONFIDENCE = 0.6;

export function createCameraLoop({ onState, onGesture, onCaption, onDebug, previewEl }) {
  let active = false;
  let stream = null;
  let video = null;          // <video> the recognizer reads from (mounted into previewEl if given)
  let recognizer = null;     // lazy-built once, reused across start/stop
  let detectTimer = null;
  let holdGesture = null;    // gesture name currently being held
  let holdCount = 0;
  const lastFired = new Map(); // gesture name -> ts of last fire

  function setState(s) { if (onState) onState(s); }
  function caption(text, kind) { if (onCaption) onCaption(text, kind); }

  async function ensureRecognizer() {
    if (recognizer) return recognizer;
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    recognizer = await GestureRecognizer.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numHands: 1,
    });
    return recognizer;
  }

  function detectTick() {
    if (!active || !recognizer || !video || video.readyState < 2) return;
    let result;
    try {
      result = recognizer.recognizeForVideo(video, performance.now());
    } catch { return; } // a single bad frame is not an error condition
    const top = result.gestures && result.gestures[0] && result.gestures[0][0];
    const handSeen = !!(result.landmarks && result.landmarks.length);
    // Debug feed: raw top-1 result every tick, even below MIN_CONFIDENCE / hold
    // ticks — lets a test widget show "yes I see a hand" independent of
    // whether the production debounce logic would actually fire an action.
    if (onDebug) onDebug({ handSeen, name: top ? top.categoryName : null, score: top ? top.score : 0 });

    const name = top && top.score >= MIN_CONFIDENCE ? top.categoryName : null;

    if (!name || name === 'None') { holdGesture = null; holdCount = 0; return; }
    if (name !== holdGesture) { holdGesture = name; holdCount = 1; return; }
    holdCount++;
    if (holdCount < GESTURE_HOLD_TICKS) return;

    const last = lastFired.get(name) || 0;
    if (Date.now() - last < GESTURE_COOLDOWN_MS) return;
    lastFired.set(name, Date.now());
    holdGesture = null;
    holdCount = 0;
    if (onGesture) onGesture(name);
  }

  // One JPEG frame from the live stream, base64 without the data: prefix —
  // exactly what the vision-query WS message carries (Part B).
  function captureFrame() {
    if (!video || video.readyState < 2) return null;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.7).split(',')[1];
  }

  async function start() {
    if (active) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setState('unsupported');
      return false;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
    } catch (err) {
      console.warn('[camera] permission denied:', err);
      setState('disabled');
      caption('Camera permission denied — enable it in the browser to use gestures.', 'error');
      return false;
    }
    try {
      await ensureRecognizer();
    } catch (err) {
      console.warn('[camera] gesture model failed to load:', err);
      caption('Gesture recognition unavailable — model failed to load.', 'error');
      releaseStream();
      setState('error');
      return false;
    }
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    if (previewEl) {
      // Debug/testing widget: mirror the feed so raising your right hand
      // shows on your right, like a mirror — mounted only while active,
      // torn down on stop() same as the stream itself.
      video.style.width = '100%';
      video.style.height = '100%';
      video.style.objectFit = 'cover';
      video.style.transform = 'scaleX(-1)';
      // xss-safe: static template, no interpolation
      previewEl.innerHTML = '';
      previewEl.appendChild(video);
    }
    await video.play();
    active = true;
    setState('watching');
    detectTimer = setInterval(detectTick, DETECT_INTERVAL_MS);
    return true;
  }

  function releaseStream() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (video) { video.srcObject = null; video = null; }
    // xss-safe: static template, no interpolation
    if (previewEl) previewEl.innerHTML = '';
  }

  function stop() {
    active = false;
    if (detectTimer) { clearInterval(detectTimer); detectTimer = null; }
    // Same lesson as P15's mic fix: releasing the timer is NOT releasing the
    // hardware — stop the tracks or the camera light stays on forever.
    releaseStream();
    holdGesture = null;
    holdCount = 0;
    setState('idle');
  }

  return {
    start,
    stop,
    toggle() { return active ? (stop(), false) : start(); },
    isActive: () => active,
    captureFrame,
  };
}
