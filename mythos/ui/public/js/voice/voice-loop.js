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
const SPEECH_RMS = 0.035;      // volume threshold marking "speech present" — raised from 0.02 (fans/AC/bikes were clearing it)
const VAD_TICK_MS = 100;
const SPEECH_HOLD_TICKS = 3;   // consecutive above-threshold ticks required before recording starts — raised from 2; 300ms sustained filters transient noise (door slam, keyboard, cough, bike pass)
const MIN_CLIP_MS = 500;       // shorter clips are noise/mic-bumps, dropped — raised from 300; real utterances are longer
const MIN_CLIP_BYTES = 800;
const MIN_PEAK_RMS = 0.06;     // the loudest moment of the clip must clear this — raised from 0.035; real speech peaks well above ambient that merely brushed the old floor
const ECHO_GUARD_MS = 3000;    // after playback ends, keep rejecting transcripts matching what was just spoken — speakers bleed into the mic for a beat after TTS finishes

// voice-nav table — checked before falling through to the brain.
const NAV_COMMANDS = [
  [/^(show|open)\s+(my\s+)?goals?$/i, 'goals'],
  [/^(show|open)\s+(the\s+)?kanban( board)?$/i, 'kanban'],
  [/^(show|open)\s+(the\s+)?pipeline$/i, 'pipeline'],
  [/^(show|open)\s+(my\s+)?memor(y|ies)$/i, 'memory'],
  [/^(show|open)\s+health$/i, 'health'],
  [/^(show|open)\s+(the\s+)?audit( log| trail)?$/i, 'audit'],
];

// Vision questions are intercepted before the brain, same as NAV_COMMANDS —
// they need a camera frame attached, which only the client can do.
const VISION_TRIGGER = /^(what (do you|can you) see|describe (this|what you see)|look at (this|me)|take a look|what am i (holding|showing))/i;

export function createVoiceLoop({ onState, openPanel, onCaption, onVisionQuery }) {
  let active = false;
  let processing = false;
  let disposed = false;
  let currentAudio = null;   // in-flight TTS playback (barge-in target)
  let speakingText = '';     // spoken reply text — echo-guard reference (during playback)
  let lastSpokenText = '';   // what was just spoken — echo-guard reference (after playback ends)
  let lastSpokenAt = 0;      // when playback ended — used to expire the post-playback echo window
  let speakSession = 0;      // invalidates stale playback callbacks

  // ---- chunked playback (speech-chunk messages arrive before 'done') ----
  let chunkQueue = [];
  let playing = false;
  let doneReceived = false;
  let lastChunkPlayed = false;

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

    // Reserve this turn's session token now, at dispatch time — speech-chunk
    // messages can arrive before 'done' and need a live session to enqueue
    // against (see enqueueChunk/playNextChunk below).
    const session = beginTurn();

    // Fall through to the brain over WS. Grace timeout returns to listening
    // even if the reply never lands (no new WS type invented — P9 brief).
    let done = false;
    const grace = setTimeout(() => {
      if (!done) {
        done = true;
        caption('No reply from the brain (timed out). Check that providers are configured.', 'error');
        finishTurn();
      }
    }, 35000);
    utterance({
      text: command,
      onChunk: (msg) => enqueueChunk(msg, session),
      onDone: (msg) => {
        if (done) return;
        done = true;
        clearTimeout(grace);
        deliverReply(msg, session);
      },
    });
  }

  // Reserves a fresh session token for a turn whose reply may stream
  // speech-chunk messages before 'done' arrives. Shared by handleCommand
  // (voice) and the external vision-query path (Part B / app.js).
  function beginTurn() {
    const session = ++speakSession;
    doneReceived = false;
    lastChunkPlayed = false;
    chunkQueue = [];
    playing = false;
    return session;
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
    // Active playback: check against speakingText
    if (speakingText) {
      if (echoMatch(text, speakingText)) return true;
    }
    // Post-playback window: check against lastSpokenText within ECHO_GUARD_MS.
    // Speaker bleed arrives after TTS finishes — without this, "to help." (the
    // tail of "...ready to help") gets treated as a real command.
    if (lastSpokenText && (Date.now() - lastSpokenAt) < ECHO_GUARD_MS) {
      if (echoMatch(text, lastSpokenText)) return true;
    } else {
      lastSpokenText = ''; // window expired — clear stale reference
    }
    return false;
  }

  function echoMatch(text, reference) {
    if (!reference) return false;
    const spoken = new Set(reference.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean));
    const words = text.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
    if (!words.length) return true;
    let hits = 0;
    for (const w of words) if (spoken.has(w)) hits++;
    return hits / words.length >= 0.6;
  }

  // Stops any in-flight playback and invalidates its pending finish callbacks.
  // Does NOT wipe the echo-guard reference: moves it to lastSpokenText with a
  // timestamp so transcripts arriving AFTER playback ends (late speaker bleed)
  // are still caught by isEcho() within ECHO_GUARD_MS.
  function stopSpeaking() {
    speakSession++;
    if (currentAudio) { try { currentAudio.pause(); } catch { /* ok */ } currentAudio = null; }
    if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch { /* ok */ } }
    if (speakingText) { lastSpokenText = speakingText; lastSpokenAt = Date.now(); }
    speakingText = '';
    chunkQueue = [];
    playing = false;
  }

  // ---- chunked playback (speech-chunk messages arrive before 'done') ----
  function enqueueChunk(msg, session) {
    if (speakSession !== session) return; // barge-in already happened
    chunkQueue.push(msg);
    if (!playing) playNextChunk(session);
  }

  function playNextChunk(session) {
    if (speakSession !== session) return;
    const chunk = chunkQueue.shift();
    if (!chunk) { playing = false; maybeFinishTurn(session); return; }
    playing = true;
    processing = false;     // mic stays live during playback — barge-in
    setState('speaking');
    const isLast = chunk.index === chunk.total - 1;
    const onOneDone = () => {
      if (speakSession !== session) return;
      if (isLast) lastChunkPlayed = true;
      playNextChunk(session);
    };
    if (chunk.audioB64) {
      const audio = new Audio('data:audio/mpeg;base64,' + chunk.audioB64);
      currentAudio = audio;
      audio.onended = onOneDone;
      audio.onerror = () => speakChunkFallback(chunk.text, session, onOneDone);
      audio.play().catch(() => speakChunkFallback(chunk.text, session, onOneDone));
    } else {
      speakChunkFallback(chunk.text, session, onOneDone);
    }
  }

  function speakChunkFallback(text, session, onDone) {
    if (window.speechSynthesis && !disposed) {
      const u = new SpeechSynthesisUtterance(text);
      u.onend = () => { if (speakSession === session) onDone(); };
      u.onerror = () => { if (speakSession === session) onDone(); };
      try { window.speechSynthesis.speak(u); return; } catch { /* fall through to silent finish */ }
    }
    if (speakSession === session) onDone();
  }

  function maybeFinishTurn(session) {
    if (speakSession !== session) return;
    if (doneReceived && (lastChunkPlayed || chunkQueue.length === 0) && !playing) {
      stopSpeaking();
      finishTurn();
    }
  }

  // Show the brain's reply and speak it aloud. `session` was reserved by
  // beginTurn() at dispatch time (before any speech-chunk could arrive).
  // Chunked replies (msg.chunked) already streamed their audio via
  // speech-chunk messages — 'done' here just supplies the caption text and
  // triggers the barge-in-aware finish once the queue drains. Non-chunked
  // replies (TTS down / offline / error) keep the direct fallback path,
  // byte-identical to pre-Part-C behavior.
  function deliverReply(msg, session) {
    const say = msg && msg.say ? String(msg.say) : '';
    if (!say) { finishTurn(); return; }
    const kind = msg.error || msg.offline ? 'error' : 'reply';
    caption(say, kind);
    if (kind !== 'reply' || disposed) { finishTurn(); return; }

    const spoken = msg.speak || say;
    speakingText = spoken;
    processing = false;      // mic stays live during playback — barge-in
    setState('speaking');
    doneReceived = true;

    if (msg.chunked) {
      maybeFinishTurn(session); // covers the case where all chunks already played
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
    // Drop single-word transcripts — they are almost always noise hallucinations
    // ("and", "I", "yeah") or incomplete fragments, never real commands.
    const words = command.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length < 2) return;
    // Echo check covers BOTH active playback (speakingText) and the post-playback
    // window (lastSpokenText within ECHO_GUARD_MS). Stops MYTHOS hearing its own
    // voice — during playback AND the beat after it ends.
    if (isEcho(command)) {
      if (speakingText) return;          // during playback: drop the echo silently
      // after playback: also drop — it's late speaker bleed, not a real command
      return;
    }
    if (speakingText) stopSpeaking();    // barge-in: user talked over playback
    caption('» ' + command, 'heard');
    if (VISION_TRIGGER.test(command) && onVisionQuery) {
      onVisionQuery(command);
      return;
    }
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
    // External reply path (Part B, vision Q&A): the camera flow dispatches
    // its own WS request (visionQuery, not utterance) but the reply must
    // flow through this same chunk-queue/barge-in machinery so a "what do
    // you see" answer is spoken exactly like a voice reply. beginTurn()
    // reserves the session before any speech-chunk can arrive; the caller
    // routes onChunk/onDone to onExternalChunk/deliverExternalReply with it.
    beginTurn,
    onExternalChunk: enqueueChunk,
    deliverExternalReply: deliverReply,
  };
}
