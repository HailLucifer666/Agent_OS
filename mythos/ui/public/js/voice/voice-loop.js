// voice-loop.js — always-listening voice loop. Speech input runs through
// server-side Groq Whisper transcription, NOT the browser's built-in
// SpeechRecognition: Chrome's cloud speech backend (speech.googleapis.com)
// and its on-device model download are both unreachable on this network
// (confirmed live: cloud fails with a 'network' error in <0.5s; on-device
// install() never resolves, available() reports 'downloading' indefinitely
// across reloads) — a network-level block to Google's speech infrastructure
// specifically, not something client-side retry/timeout logic can fix.
// Groq's host is proven reachable all session for chat completions, so audio
// is recorded here and POSTed to /api/voice/transcribe for transcription.
//
// Armed by orb/mic click — every captured utterance IS the command; no wake
// word required (a leading "Mythos, ..." is stripped when present).
//
// States: idle -> listening -> processing -> speaking -> listening.

import { utterance } from '../ws.js';

const WAKE_WORD = 'mythos';
const WAKE_PATTERN = new RegExp('^\\s*' + WAKE_WORD + '[,\\s]+', 'i');
const SILENCE_MS = 1800;       // quiet gap that ends an utterance
const SPEECH_RMS = 0.02;       // volume threshold marking "speech present"
const VAD_TICK_MS = 100;
const SPEECH_HOLD_TICKS = 2;   // consecutive above-threshold ticks required before recording starts — filters brief noise blips (a door, a click, a cough)
const MIN_CLIP_MS = 300;       // shorter clips are noise/mic-bumps, dropped
const MIN_CLIP_BYTES = 800;
const MIN_PEAK_RMS = 0.035;    // the loudest moment of the clip must clear this — real speech peaks well above ambient noise that merely brushed SPEECH_RMS

// voice-nav table — checked before falling through to the brain.
const NAV_COMMANDS = [
  [/^(show|open)\s+(my\s+)?goals?$/i, 'goals'],
  [/^(show|open)\s+(the\s+)?kanban( board)?$/i, 'kanban'],
  [/^(show|open)\s+(the\s+)?pipeline$/i, 'pipeline'],
  [/^(show|open)\s+(my\s+)?memor(y|ies)$/i, 'memory'],
  [/^(show|open)\s+health$/i, 'health'],
  [/^(show|open)\s+(the\s+)?audit( log| trail)?$/i, 'audit'],
];

export function createVoiceLoop({ onState, openPanel, onCaption }) {
  let active = false;
  let processing = false;
  let disposed = false;
  let currentAudio = null;   // in-flight TTS playback (barge-in target)
  let speakingText = '';     // spoken reply text — echo-guard reference
  let speakSession = 0;      // invalidates stale playback callbacks

  let stream = null;         // persistent mic stream for the whole active session
  let audioCtx = null;
  let analyser = null;
  let vadTimer = null;
  let recorder = null;
  let chunks = [];
  let recordingSince = 0;
  let silenceSince = null;
  let aboveCount = 0;        // consecutive above-threshold VAD ticks (see SPEECH_HOLD_TICKS)
  let peakRms = 0;           // loudest VAD tick seen during the current recording (see MIN_PEAK_RMS)

  function setState(s) { if (onState) onState(s); }
  function caption(text, kind) { if (onCaption) onCaption(text, kind); }

  function navTarget(command) {
    for (const [pattern, panelId] of NAV_COMMANDS) {
      if (pattern.test(command.trim())) return panelId;
    }
    return null;
  }

  function handleCommand(command) {
    processing = true;
    setState('processing');
    stopRecording();

    const panelId = navTarget(command);
    if (panelId) {
      openPanel(panelId);
      finishTurn();
      return;
    }

    // Fall through to the brain over WS. Grace timeout returns to listening
    // even if the reply never lands (no new WS type invented — P9 brief).
    let done = false;
    const grace = setTimeout(() => {
      if (!done) {
        done = true;
        caption('No reply from the brain (timed out after 20s).', 'error');
        finishTurn();
      }
    }, 20000);
    utterance({
      text: command,
      onDone: (msg) => {
        if (done) return;
        done = true;
        clearTimeout(grace);
        deliverReply(msg);
      },
    });
  }

  // Show the brain's reply and speak it aloud. BARGE-IN: the mic keeps
  // recording during playback (processing drops before 'speaking'), so the
  // user can talk over MYTHOS — a non-echo transcript stops playback and
  // becomes the next command. isEcho() drops transcripts that are mostly
  // MYTHOS's own words leaking from the speakers (hardware echo cancellation
  // catches most of it; this is the software backstop). Preferred voice:
  // server edge-tts mp3 in msg.audioB64; browser speechSynthesis (msg.speak,
  // sanitized) is the fallback.
  function isEcho(text) {
    if (!speakingText) return false;
    const spoken = new Set(speakingText.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean));
    const words = text.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
    if (!words.length) return true;
    let hits = 0;
    for (const w of words) if (spoken.has(w)) hits++;
    return hits / words.length >= 0.6;
  }

  // Stops any in-flight playback and invalidates its pending finish callbacks.
  function stopSpeaking() {
    speakSession++;
    if (currentAudio) { try { currentAudio.pause(); } catch { /* ok */ } currentAudio = null; }
    if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch { /* ok */ } }
    speakingText = '';
  }

  function deliverReply(msg) {
    const say = msg && msg.say ? String(msg.say) : '';
    if (!say) { finishTurn(); return; }
    const kind = msg.error || msg.offline ? 'error' : 'reply';
    caption(say, kind);
    if (kind !== 'reply' || disposed) { finishTurn(); return; }

    const spoken = msg.speak || say;
    const session = ++speakSession;
    const finish = () => {
      if (speakSession !== session) return; // superseded (barge-in) — new turn owns state
      stopSpeaking();
      finishTurn();
    };

    speakingText = spoken;
    processing = false;      // mic stays live during playback — barge-in
    setState('speaking');

    if (msg.audioB64) {
      const audio = new Audio('data:audio/mpeg;base64,' + msg.audioB64);
      currentAudio = audio;
      audio.onended = finish;
      audio.onerror = () => { if (speakSession === session) speakFallback(spoken, session); };
      audio.play().catch(() => { if (speakSession === session) speakFallback(spoken, session); });
      return;
    }
    speakFallback(spoken, session);
  }

  function speakFallback(spoken, session) {
    const finish = () => {
      if (speakSession !== session) return;
      stopSpeaking();
      finishTurn();
    };
    if (window.speechSynthesis && !disposed) {
      const u = new SpeechSynthesisUtterance(spoken);
      u.onend = finish;
      u.onerror = finish;
      try {
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
        return;
      } catch { /* synthesis broken — fall through to silent finish */ }
    }
    finish();
  }

  function finishTurn() {
    processing = false;
    setState(active && !disposed ? 'listening' : 'idle');
  }

  // Runs the exact same command logic regardless of where the final text
  // came from (mirrors the old inline recognizer dispatch()).
  function processTranscript(text) {
    const trimmed = (text || '').replace(/\s+/g, ' ').trim();
    if (!trimmed) return;
    const match = trimmed.match(WAKE_PATTERN);
    const command = (match ? trimmed.slice(match[0].length) : trimmed).trim();
    if (!command) return;
    if (speakingText) {
      if (isEcho(command)) return; // MYTHOS hearing its own reply — drop
      stopSpeaking();              // barge-in: user talked over playback
    }
    caption('» ' + command, 'heard');
    handleCommand(command);
  }

  function pickMimeType() {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    for (const c of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
  }

  function rms(data) {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / data.length);
  }

  async function ensureMic() {
    if (stream) return stream;
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    return stream;
  }

  function startRecording() {
    if (recorder) return;
    chunks = [];
    recordingSince = Date.now();
    peakRms = 0;
    try {
      recorder = new MediaRecorder(stream, { mimeType: pickMimeType() });
    } catch (err) {
      console.warn('[voice] MediaRecorder failed to start:', err);
      recorder = null;
      return;
    }
    caption('🎤 …', 'heard');
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const clipMs = Date.now() - recordingSince;
      const type = recorder.mimeType || 'audio/webm';
      const blob = new Blob(chunks, { type });
      const loudEnough = peakRms >= MIN_PEAK_RMS;
      recorder = null;
      chunks = [];
      if (clipMs < MIN_CLIP_MS || blob.size < MIN_CLIP_BYTES) return; // noise/blip — drop silently
      if (!loudEnough) return; // never actually got louder than ambient noise — drop silently, don't waste a transcription call on it
      transcribeAndDispatch(blob);
    };
    recorder.start();
  }

  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* ok */ } }
    silenceSince = null;
    aboveCount = 0;
  }

  async function transcribeAndDispatch(blob) {
    try {
      const res = await fetch('/api/voice/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
      });
      if (disposed || !active) return; // stopped while the request was in flight — drop it
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        caption(err.error || 'Speech-to-text unavailable.', 'error');
        return;
      }
      const { text } = await res.json();
      if (disposed || !active) return;
      processTranscript(text);
    } catch (err) {
      if (disposed || !active) return;
      console.warn('[voice] transcription request failed:', err);
      caption('Speech-to-text request failed — check connection.', 'error');
    }
  }

  function vadTick() {
    if (!analyser) return;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    const level = rms(data);
    if (recorder) peakRms = Math.max(peakRms, level);
    const speaking = level > SPEECH_RMS;
    if (speaking) {
      silenceSince = null;
      if (recorder || processing) return;
      // Require a short sustained hold above threshold before committing to a
      // recording — a single loud tick (a door, a click, a cough) shouldn't
      // arm the whole capture-and-transcribe pipeline.
      aboveCount++;
      if (aboveCount >= SPEECH_HOLD_TICKS) startRecording();
    } else {
      aboveCount = 0;
      if (recorder) {
        if (silenceSince === null) silenceSince = Date.now();
        else if (Date.now() - silenceSince >= SILENCE_MS) stopRecording();
      }
    }
  }

  async function start() {
    if (active) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      setState('unsupported'); // honest: no mic-recording API in this browser
      return false;
    }
    try {
      await ensureMic();
    } catch (err) {
      console.warn('[voice] microphone permission denied:', err);
      setState('disabled');
      caption('Microphone permission denied — enable it in the browser to use voice.', 'error');
      return false;
    }
    if (disposed) return false;
    active = true;
    processing = false;
    setState('listening');
    vadTimer = setInterval(vadTick, VAD_TICK_MS);
    return true;
  }

  function stop() {
    active = false;
    processing = false;
    stopSpeaking();
    if (vadTimer) { clearInterval(vadTimer); vadTimer = null; }
    stopRecording();
    // Release the actual hardware mic — without this the getUserMedia stream
    // stays live forever (browser mic-in-use indicator included) even though
    // the UI says "off"; ensureMic() re-acquires instantly next start() since
    // permission is already granted.
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    analyser = null;
    setState('idle');
    caption('', 'info');
  }

  return {
    start,
    stop,
    toggle() { return active ? (stop(), false) : start(); },
    isActive: () => active,
    cleanup() { disposed = true; stop(); },
  };
}
