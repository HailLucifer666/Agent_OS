// gate-recorder.js — BUG-406: a recorder for the half-duplex mic gate. Numbers only.
//
// WHY. On 2026-09-03 the gate held the operator's microphone for 267.7 s of an
// ~11-minute conversation; 7 of 34 releases ended at a CEILING rather than because
// MYTHOS stopped speaking, including a 21.4 s hold on "near-field energy". Every
// attempt to tune it has been made from one scalar summary per release, and this
// repo has mis-diagnosed this area twice from exactly that. The entry's own
// conclusion: a correct fix needs the mic level, the gate state and the playback
// timeline, synchronised, around each release — which nothing recorded.
//
// WHAT THIS RECORDS, per sample (at most one every MIN_GAP_MS, the last WINDOW_MS
// kept): the mic frame's RMS, both gates (the media suspend and the own-voice
// hold), whether the player says it is speaking, how far ahead of the clock the
// player has audio scheduled, and both AudioContext clocks. On every gate RELEASE
// the window is handed to the server, which writes it under the project's
// .cache/ (server/voice-gate-recording.js). Off unless VOICE_GATE_RECORDER=true.
//
// WHAT IT NEVER RECORDS. No audio: the PCM frame is reduced to one number here and
// dropped. No words: nothing from a transcript is in reach of this module.
//
// DECISION D9 (2026-09-23): this round ships the recorder only. The acoustic
// study, the replay harness and any change to the gate are the next round's work,
// and the p95 250 ms local-stop target is not claimed.

export const WINDOW_MS = 30000;
export const MIN_GAP_MS = 50;
export const MAX_SAMPLES = 800;

const round = (n, places) => (Number.isFinite(n) ? Math.round(n * places) / places : null);

// Pure: which transitions end a hold, so the window around them is worth keeping.
// An own-voice release carries ownVoiceGate:false; the media hold ends with one of
// three reasons (setCaptureSuspended in s2s-bridge.js).
export function isGateRelease(extra, captureSuspended) {
  const x = extra || {};
  if (x.ownVoiceGate === false) return true;
  return captureSuspended === false && x.ownVoiceGate === undefined
    && ['clear', 'suspend-window-elapsed', 'suspend-ceiling-fail-open'].includes(String(x.reason));
}

export function createGateRecorder({ rms, now = () => performance.now() } = {}) {
  if (typeof rms !== 'function') throw new TypeError('gate-recorder: rms(frame) is required');
  const ring = [];
  let lastAt = -Infinity;

  // `frame` is reduced to its RMS on the spot; the frame itself is never kept.
  function sample(frame, state) {
    const t = now();
    if (t - lastAt < MIN_GAP_MS) return false;
    lastAt = t;
    const s = state || {};
    const ph = s.playhead || {};
    ring.push({
      t: Math.round(t),
      rms: round(rms(frame), 10000),
      captureSuspended: Boolean(s.captureSuspended),
      ownVoiceGate: Boolean(s.ownVoiceGate),
      speaking: Boolean(s.speaking),
      aheadMs: Number.isFinite(ph.aheadMs) ? Math.round(ph.aheadMs) : null,
      micContextTime: round(s.micContextTime, 1000),
      playContextTime: round(ph.contextTime, 1000),
    });
    while (ring.length > MAX_SAMPLES || (ring.length && t - ring[0].t > WINDOW_MS)) ring.shift();
    return true;
  }

  // A copy of the window. The ring is kept, so two releases close together share
  // the samples between them rather than the second starting empty.
  function drain() { return ring.slice(); }

  return { sample, drain, size: () => ring.length };
}
