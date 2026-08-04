// screen-share.js — Electron Slice 3 (spine §13's desktopCapturer): stream the
// desktop into the open Gemini Live session as realtimeInput.video frames, so
// "what am I looking at?" is answered from the actual screen.
//
// Why this beats the existing screen-sensor.js for the voice path (and does not
// replace it): screen-sensor.js polls, hashes, and spends a separate vision-lane
// brain call to DESCRIBE a changed screen into words, then puts those words on
// the bus. That is the right shape for ambient awareness the cortex can reason
// over later. It is the wrong shape for a live conversation — by the time a
// description exists the operator has already asked their question, and the model
// answers from prose about the screen instead of the screen. Frames on the Live
// socket go straight into the same context window as the operator's voice.
// Both keep running; they answer different questions.
//
// Capture path: getDisplayMedia() → a detached <video> element → drawImage onto a
// canvas → canvas.toDataURL('image/jpeg', quality) → base64 → {type:'live-video'}
// over the existing HUD socket. No new transport, no worklet, no dependency.
// In Electron the getDisplayMedia() call is granted by the main process's
// setDisplayMediaRequestHandler (electron/main.js) with no source picker; in a
// plain browser the user gets the normal native picker and it works there too.
//
// Cost is the reason every knob here is conservative. Every frame is a billed
// image input on the operator's own key, and a capture loop is the easiest way
// in this codebase to spend real money on nothing — so the default is 0.5 fps,
// the loop stops the moment the session closes, and a frame is skipped whenever
// the previous one hasn't finished encoding.

import { sendMessage } from '../ws.js';

const DEFAULT_FPS = 0.5;
const DEFAULT_QUALITY = 0.6;

// Downscale cap on the long edge. A 4K desktop encodes to a ~900KB JPEG that
// buys nothing — the model reads layout and large text, not pixels. 1280 keeps
// UI text legible while cutting the payload by an order of magnitude.
const MAX_EDGE = 1280;

export function createScreenShare({ onState } = {}) {
  let active = false;
  let stream = null;
  let video = null;
  let canvas = null;
  let timer = null;
  let encoding = false;

  function setState(s) { if (onState) onState(s); }

  function releaseStream() {
    // getTracks().stop() is not optional bookkeeping: until every track is
    // stopped the OS keeps its screen-capture indicator lit and Electron keeps
    // the capture pipeline alive. A user who ended a voice session and still
    // sees "your screen is being shared" has been lied to by the UI.
    if (stream) {
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* already gone */ }
      stream = null;
    }
    if (video) {
      try { video.srcObject = null; video.remove(); } catch { /* detached already */ }
      video = null;
    }
    canvas = null;
  }

  function captureFrame() {
    if (!active || encoding || !video || !canvas) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;   // first frames before metadata lands — skip, don't guess

    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));

    encoding = true;
    try {
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL('image/jpeg', quality());
      const comma = url.indexOf(',');
      if (comma > -1) {
        sendMessage({ type: 'live-video', data: url.slice(comma + 1) });
      }
    } catch (err) {
      // A tainted canvas or a track that died mid-draw. Report and keep the
      // loop alive: one bad frame is not a reason to end screen share, and a
      // silent catch here would hide a permanently broken capture.
      console.warn('[screen-share] frame capture failed:', err);
    } finally {
      encoding = false;
    }
  }

  let _quality = DEFAULT_QUALITY;
  function quality() { return _quality; }

  async function start(opts = {}) {
    if (active) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      setState('unsupported');
      return false;
    }

    const fps = Number(opts.fps) > 0 ? Number(opts.fps) : DEFAULT_FPS;
    _quality = Number(opts.quality) > 0 ? Number(opts.quality) : DEFAULT_QUALITY;

    try {
      // audio:false is deliberate — see electron/main.js's handler comment.
      // Capturing system audio would feed MYTHOS's own TTS back to Gemini as
      // operator speech.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (err) {
      // Denied by the OS, by the user cancelling a picker, or unavailable
      // headless. Honest state, no retry loop — voice keeps working without it.
      console.warn('[screen-share] getDisplayMedia denied:', err);
      setState('denied');
      return false;
    }

    // If the user stops sharing through the OS's own "Stop sharing" affordance,
    // the track ends without anything calling stop() here. Without this the loop
    // would keep firing against a dead track, logging a failed frame every tick.
    const track = stream.getVideoTracks()[0];
    if (track) track.addEventListener('ended', () => { stop(); });

    video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    try {
      await video.play();
    } catch (err) {
      console.warn('[screen-share] video element failed to play:', err);
      releaseStream();
      setState('denied');
      return false;
    }

    canvas = document.createElement('canvas');
    active = true;
    setState('sharing');
    timer = setInterval(captureFrame, Math.round(1000 / fps));
    return true;
  }

  function stop() {
    if (!active && !stream) return;
    active = false;
    if (timer) { clearInterval(timer); timer = null; }
    releaseStream();
    setState('idle');
  }

  return { start, stop, isActive: () => active };
}
