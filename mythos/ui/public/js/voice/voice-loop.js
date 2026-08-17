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

import { utterance, stopRequest, sendMessage } from '../ws.js';
import { getMicDeviceId, setMicDeviceId, buildAudioConstraints, micErrorMessage } from './mic-device.js';
import { isVisionQuery } from './vision-trigger.js';
// Static import is cheap: silero-vad.js only DEFINES functions at module
// scope — it fetches onnxruntime-web and the ONNX model lazily, inside
// ensureLoaded(), which is only ever called when VAD_ENGINE==='silero'. A HUD
// left on the 'rms' default never pays for either.
import { resampleLinear, accumulateFrames, createSileroVad, FRAME_SAMPLES, MODEL_SAMPLE_RATE } from './silero-vad.js';

const WAKE_WORD = 'mythos';
const WAKE_PATTERN = new RegExp('^\\s*' + WAKE_WORD + '[,\\s]+', 'i');
// BUG-020: these four are `let`, not `const` — createVoiceLoop's optional
// `vad` option can override them per-instance. Values below are the
// defaults and match the previously-hardcoded constants.
// SILENCE_MS default is 1800. The 2026-08-17 experiment of 900 (faster
// endpointing) was live-falsified the same day: natural mid-sentence pauses
// of 0.9–1.8s split one utterance into two clips, MYTHOS answered
// mid-thought, and the assistantSpeaking half-duplex gate then swallowed the
// operator's continuation. 1800 restored; env-tunable via VAD_SILENCE_MS.
let SILENCE_MS = 1800;       // quiet gap that ends an utterance
let SPEECH_RMS = 0.035;      // volume threshold marking "speech present" — raised from 0.02 (fans/AC/bikes were clearing it)
const VAD_TICK_MS = 100;
let SPEECH_HOLD_TICKS = 3;   // consecutive above-threshold ticks required before recording starts — raised from 2; 300ms sustained filters transient noise (door slam, keyboard, cough, bike pass)
const MIN_CLIP_MS = 500;       // shorter clips are noise/mic-bumps, dropped — raised from 300; real utterances are longer
const MIN_CLIP_BYTES = 800;
let MIN_PEAK_RMS = 0.06;     // the loudest moment of the clip must clear this — raised from 0.035; real speech peaks well above ambient that merely brushed the old floor
const ECHO_GUARD_MS = 3000;    // after playback ends, keep rejecting transcripts matching what was just spoken — speakers bleed into the mic for a beat after TTS finishes
// Item 8 (barge-in): a SECOND, higher, threshold used ONLY inside the
// existing BUG-027 assistantSpeaking gate (see vadTick below) — it does not
// replace or weaken that gate. Sustained loud audio while MYTHOS is talking
// is treated as the user interrupting; anything quieter is left to the gate
// exactly as BUG-027 fixed it. `let` (not const) so createVoiceLoop's `vad`
// option can override per-instance, same convention as the four above.
let BARGE_IN_RMS_MULT = 2.5;       // multiplied onto SPEECH_RMS for the barge-in floor
let BARGE_IN_HOLD_TICKS_MULT = 2;  // multiplied onto SPEECH_HOLD_TICKS for the barge-in hold

// VAD_ENGINE (config-gated, VAD_ENGINE=rms|silero, default rms — zero behavior
// change unless the operator opts in): 'rms' is the threshold-based volume
// detector above; 'silero' runs a trained speech/non-speech model
// (silero-vad.js) instead. Overridable per-instance via createVoiceLoop's
// `vad.engine` option, same convention as the four thresholds above (BUG-020).
let VAD_ENGINE = 'rms';

// voice-nav table — checked before falling through to the brain.
// Leading-edge only (no $ anchor) so compound utterances like
// "pipeline dashboard and open the ACDC video" still match the nav
// clause and open the panel client-side before hitting the brain.
const NAV_COMMANDS = [
  [/^(?:show|open|view|display)\s+(?:my\s+|the\s+|current\s+|active\s+)*goals?(?:\s+(?:panel|tab|view))?(?:\s|$)/i, 'goals'],
  [/^(?:show|open|view|display)\s+(?:my\s+|the\s+|current\s+|active\s+)*kanban(?:\s+board)?(?:\s+(?:panel|tab|view))?(?:\s|$)/i, 'kanban'],
  [/^(?:show|open|view|display)\s+(?:my\s+|the\s+|current\s+|active\s+)*pipeline(?:\s+(?:panel|tab|view))?(?:\s|$)/i, 'pipeline'],
  [/^(?:show|open|view|display)\s+(?:my\s+|the\s+)?memor(?:y|ies)(?:\s+(?:panel|tab|view))?(?:\s|$)/i, 'memory'],
  [/^(?:show|open|view|display)\s+(?:my\s+|the\s+)?health(?:\s+(?:panel|tab|view))?(?:\s|$)/i, 'health'],
  [/^(?:show|open|view|display)\s+(?:my\s+|the\s+)?audit(?:\s+(?:log|trail))?(?:\s+(?:panel|tab|view))?(?:\s|$)/i, 'audit'],
  [/^(?:show|open|view|display)\s+(?:my\s+|the\s+)?(?:backend|terminal|system\s+logs?)(?:\s+(?:panel|tab|view))?(?:\s|$)/i, 'backend'],
  [/^(?:show|open|view|display)\s+(?:my\s+|the\s+)?(?:conversation|chat|transcript|history)(?:\s+(?:panel|tab|view))?(?:\s|$)/i, 'conversation'],
  [/^(?:show|open|view|display)\s+(?:my\s+|the\s+)?engagements?(?:\s+(?:panel|tab|view))?(?:\s|$)/i, 'engagements'],
  [/^(?:show|open|view|display)\s+(?:my\s+|the\s+)?(?:security|pin|lock)(?:\s+(?:panel|tab|view))?(?:\s|$)/i, 'security'],
];

// Close commands — close the top panel or all panels.
const CLOSE_COMMANDS = [
  /^(?:close|hide|dismiss)\s+(?:the\s+|all\s+)?(?:panel|tab|window|overlay|view)s?$/i,
  /^(?:close|hide|dismiss)\s+(?:everything|all)$/i,
  /^close\s+(?:it|them|that)$/i,
];

// Vision questions are intercepted before the brain, same as NAV_COMMANDS —
// they need a camera frame attached, which only the client can do. The phrase
// list moved to voice/vision-trigger.js (imported above) so it can be tested
// without a browser; the interception point below is unchanged.

// E2: Strip markdown, HTML, and control characters before passing text to TTS engines.
// Without this, the browser SpeechSynthesis reads aloud "asterisk asterisk bold asterisk"
// and edge-tts may misinterpret markdown as pronunciation instructions.
function sanitizeForTts(text) {
  if (!text) return '';
  return String(text)
    .replace(/\*\*([^*]+)\*\*/g, '$1')   // **bold**
    .replace(/\*([^*]+)\*/g, '$1')        // *italic*
    .replace(/`([^`]+)`/g, '$1')          // `code`
    .replace(/^#{1,6}\s+/gm, '')          // # headings
    .replace(/^[-*+]\s+/gm, '')           // - bullet points
    .replace(/^\d+\.\s+/gm, '')           // 1. numbered lists
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // [text](url) -> text
    .replace(/<[^>]+>/g, '')              // HTML tags
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')  // control chars
    .trim();
}

// Item 8 (barge-in): pure VAD-level decision, no DOM/window/audio access —
// this is what makes it unit-testable under plain node:test (see
// test/voice-barge-in-decision.test.js). Groq STT has no streaming mode, so
// this has to be threshold-based, not transcription-based: a sustained tick
// louder than `thresholds.bargeThreshold` while MYTHOS is speaking means the
// user is talking over it.
//
// SAFETY: when `assistantSpeaking` is false this is a pass-through no-op
// (bargeAboveCount returned unchanged) — it never manufactures a barge-in
// outside the gate. In the real vadTick below this function is only ever
// called from inside the existing `if (assistantSpeaking)` block, so the
// false branch here is a belt-and-suspenders guarantee for callers, not a
// path vadTick exercises today.
export function decideBargeIn({ level, assistantSpeaking, bargeAboveCount, thresholds }) {
  if (!assistantSpeaking) return { shouldBargeIn: false, newBargeAboveCount: bargeAboveCount };
  const { bargeThreshold, bargeHoldTicks } = thresholds;
  if (level <= bargeThreshold) return { shouldBargeIn: false, newBargeAboveCount: 0 };
  const newBargeAboveCount = bargeAboveCount + 1;
  if (newBargeAboveCount >= bargeHoldTicks) return { shouldBargeIn: true, newBargeAboveCount: 0 };
  return { shouldBargeIn: false, newBargeAboveCount };
}

// One played chunk must produce exactly ONE queue advance and at most ONE
// speechSynthesis fallback.
//
// REPORTED BY THE OPERATOR 2026-07-31: "the voice glitches, I am hearing 5-6
// words repetitions". Cause, in playNextChunk() below: an <audio> element whose
// data fails to decode fires BOTH the `error` event AND rejects the promise
// returned by play() — that is specified behavior (resource-selection failure
// sets the error and rejects any pending play), not an edge case. Both handlers
// called speakChunkFallback() with no guard between them, and
// speakChunkFallback() QUEUES a SpeechSynthesisUtterance rather than replacing
// the current one, so the same sentence-sized chunk (~5-6 words) was spoken
// twice back to back.
//
// The same unguarded pair also advanced the queue twice, which SKIPS the next
// chunk. When it hit the second-to-last chunk the reply lost its final words —
// the "speech cut off at the end" the operator reported earlier the same day
// (test/tts-down-sentence-chunks.test.js fixed a different cause of that
// symptom: zero chunks sent while TTS was down. Both are real; this is the one
// that survives with TTS up).
//
// Pure and exported for the same reason decideBargeIn() is: the chunk queue
// itself needs Audio/speechSynthesis, this decision does not.
export function createChunkCompletion({ advance, fallback }) {
  let advanced = false;
  let fellBack = false;
  function done() {
    if (advanced) return;
    advanced = true;
    if (typeof advance === 'function') advance();
  }
  function fail() {
    if (advanced || fellBack) return;   // already finished, or already re-speaking
    fellBack = true;
    if (typeof fallback === 'function') fallback(done);
    else done();
  }
  return { done, fail };
}

// The entity speaks through three different engines and the operator hears all
// of them in one session: server edge-tts (VOICE_TTS_VOICE), Gemini Live S2S
// (GEMINI_LIVE_VOICE), and — when edge-tts is down — this browser fallback.
// The fallback used to set NO voice at all, so it inherited the OS default,
// which on Windows is Microsoft David: male. Combined with a male edge-tts
// default, the entity greeted the operator as a British man and then answered
// as a woman. All three are female now; this picks the closest available match
// instead of taking whatever the OS hands over.
//
// 2026-08-06: retuned from en-GB-first to en-US-first. The entity now speaks
// through Gemini Live (Aoede) on every surface it can — boot greeting and typed
// turns included (VOICE_UNIFIED_LIVE_VOICE) — so this list's job is no longer
// "pair with a British edge-tts voice" but "sound like Aoede when neither Live
// nor edge-tts is available". Aoede is US-leaning, so is en-US-AvaNeural, so is
// this list. This surface can never literally BE Aoede: speechSynthesis has no
// access to Gemini. Nearest match is the ceiling here.
//
// Pure and exported so it can be unit-tested against fixture voice lists —
// getVoices() is unavailable and unstubbable in the test runner.
const PREFERRED_VOICES = [
  // en-US female first: pairs with edge-tts en-US-AvaNeural, which in turn is
  // the closest match to Gemini Live's Aoede.
  'Ava', 'Aria', 'Jenny', 'Michelle', 'Emma',
  // then other known-female names, en-GB included — a British voice is a worse
  // match than a US one here, but far better than the OS default (male).
  'Samantha', 'Zira', 'Victoria', 'Sonia', 'Libby', 'Hazel', 'Susan',
];
// Locale preferred when the same name exists in more than one variant. Matches
// PREFERRED_VOICES' leading block and VOICE_TTS_VOICE's locale — change all
// three together (test/voice-identity-consistent.test.js pins them).
const PREFERRED_LANG = 'en-us';
export function pickSpeechVoice(voices) {
  if (!Array.isArray(voices) || voices.length === 0) return null;
  for (const wanted of PREFERRED_VOICES) {
    // Prefer the preferred-locale match for this name, then the name anywhere.
    const local = voices.find((v) => v && typeof v.name === 'string' && v.name.includes(wanted)
      && typeof v.lang === 'string' && v.lang.toLowerCase().startsWith(PREFERRED_LANG));
    if (local) return local;
    const any = voices.find((v) => v && typeof v.name === 'string' && v.name.includes(wanted));
    if (any) return any;
  }
  // Nothing recognised: return null and let the browser choose, rather than
  // grabbing an arbitrary voice that might be a worse match than the default.
  return null;
}

export function createVoiceLoop({ onState, openPanel, closePanel, onCaption, onVisionQuery, onActivity, brainOnline, vad }) {
  // BUG-020: optional per-instance VAD tuning overrides — partial overrides
  // only (unspecified fields keep the module-level defaults declared above).
  if (vad && (vad.engine === 'rms' || vad.engine === 'silero')) VAD_ENGINE = vad.engine;
  // Silero's "level" is a 0..1 speech PROBABILITY, not an RMS amplitude — the
  // RMS defaults (0.035 etc, tuned against fans/AC/bikes) would either never
  // fire (a probability rarely idles above 0.035) or misfire constantly if
  // reused verbatim. Apply probability-scale defaults BEFORE the explicit
  // numeric overrides below, which still win either way.
  if (VAD_ENGINE === 'silero') {
    SPEECH_RMS = 0.5;
    MIN_PEAK_RMS = 0.6;
    BARGE_IN_RMS_MULT = 1.6; // 0.5 * 1.6 = 0.8 — a sustained high-confidence barge-in floor
  }
  if (vad) {
    if (typeof vad.speechRms === 'number') SPEECH_RMS = vad.speechRms;
    if (typeof vad.minPeakRms === 'number') MIN_PEAK_RMS = vad.minPeakRms;
    if (typeof vad.holdTicks === 'number') SPEECH_HOLD_TICKS = vad.holdTicks;
    if (typeof vad.silenceMs === 'number') SILENCE_MS = vad.silenceMs;
    // Item 8 (barge-in): same partial-override convention as the four above.
    if (typeof vad.bargeInRmsMult === 'number') BARGE_IN_RMS_MULT = vad.bargeInRmsMult;
    if (typeof vad.bargeInHoldTicksMult === 'number') BARGE_IN_HOLD_TICKS_MULT = vad.bargeInHoldTicksMult;
  }
  // BUG-020 (optional): live client-side tuning without a server restart —
  // wins over both the default and the `vad` option since it's the most
  // specific/most recently set-by-the-user override.
  try {
    if (typeof localStorage !== 'undefined') {
      const lsRms = parseFloat(localStorage.getItem('MYTHOS_VAD_RMS'));
      if (!Number.isNaN(lsRms)) SPEECH_RMS = lsRms;
      // Item 8 (barge-in): dev-only override, same pattern as MYTHOS_VAD_RMS above.
      const lsBargeMult = parseFloat(localStorage.getItem('MYTHOS_BARGE_RMS_MULT'));
      if (!Number.isNaN(lsBargeMult)) BARGE_IN_RMS_MULT = lsBargeMult;
    }
  } catch { /* localStorage unavailable (privacy mode, etc.) — ignore */ }

  let active = false;
  let processing = false;
  let disposed = false;
  // D5: Track brain availability — set by app.js via entity-state subscription.
  // When false, voice commands skip transcription to avoid wasting API calls.
  let _brainOnline = typeof brainOnline === 'function' ? brainOnline : () => true;
  let currentAudio = null;   // in-flight TTS playback (barge-in target)
  let speakingText = '';     // spoken reply text — echo-guard reference (during playback)
  let lastSpokenText = '';   // what was just spoken — echo-guard reference (after playback ends)
  let lastSpokenAt = 0;      // when playback ended — used to expire the post-playback echo window
  let speakSession = 0;      // invalidates stale playback callbacks
  let activeReqId = null;    // Item B: server reqId of the turn currently playing —
                             // stopSpeaking() sends {type:'stop', reqId} so the server
                             // cancels not-yet-synthesized TTS chunks on barge-in.
  // BUG-027: hard half-duplex gate — true from the moment TTS playback of a
  // reply STARTS (first chunk begins playing, or the non-chunked fallback
  // starts speaking) until the TTS queue is fully drained. While true, the
  // VAD tick loop below refuses to arm a new recording — a mechanical gate,
  // independent of the ECHO_GUARD_MS text-similarity heuristic (which only
  // catches echo AFTER a transcript already came back). Fixes MYTHOS's own
  // TTS output bleeding into the mic and getting transcribed as a new turn.
  let assistantSpeaking = false;

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
  // Task 12 (V2 Decision 1, latency instrumentation): the true mic-stop
  // moment, stamped in stopRecording() below and threaded through the
  // outbound utterance() call so the server can measure real mic-stop ->
  // first-audio-frame latency (AD-5: real samples only, never estimated).
  let lastMicStoppedAt = 0;
  let aboveCount = 0;        // consecutive above-threshold VAD ticks (see SPEECH_HOLD_TICKS)
  let peakRms = 0;           // loudest VAD tick seen during the current recording (see MIN_PEAK_RMS)
  let bargeAboveCount = 0;   // Item 8: consecutive above-barge-threshold ticks while assistantSpeaking (see decideBargeIn)

  // Pre-roll ring buffer state — the fix for first-word clipping. The mic is
  // always feeding an AudioWorkletProcessor ring buffer (off main thread). When
  // VAD confirms speech, we snapshot the ring contents (the last ~1s of audio)
  // and prepend them to the MediaRecorder output so the first 1-3 words that
  // were lost during the hold gate are recovered.
  let prerollNode = null;     // AudioWorkletNode
  let prerollBuffer = null;   // Float32Array snapped at speech-confirm (or null)
  let prerollSampleRate = 0;  // sample rate of the pre-roll (for WAV encoding)

  // Silero VAD (VAD_ENGINE='silero') — lazily imported so a HUD left on the
  // 'rms' default never fetches onnxruntime or the model. See silero-vad.js:
  // its ONNX frame is 512 samples @16kHz, but vadTick's 100ms analyser
  // snapshot is 512 samples at the CONTEXT's real sample rate (commonly
  // 48000) — resampleLinear() converts, accumulateFrames() carries the
  // remainder across ticks since 100ms of resampled audio isn't an exact
  // multiple of 512.
  let sileroVad = null;         // createSileroVad() instance, once loaded
  let sileroLoading = false;
  let sileroBuffer = new Float32Array(0); // carry-over between ticks
  let sileroProb = 0;           // last known speech probability — used as `level` for every tick until the next frame resolves (probeFrame is async; at most ~100ms stale)

  function ensureSileroLoaded() {
    if (sileroVad || sileroLoading) return;
    sileroLoading = true;
    const instance = createSileroVad();
    instance.ensureLoaded().then((ok) => {
      if (ok) sileroVad = instance;
      // else: stays null — vadTick's `sileroVad &&` guard keeps using the RMS
      // level for this tick, an honest degrade rather than a hang or throw.
    }).catch(() => { /* sileroVad stays null — same honest degrade */ }).finally(() => {
      sileroLoading = false;
    });
  }

  function setState(s) { if (onState) onState(s); }
  function caption(text, kind) { if (onCaption) onCaption(text, kind); }

  function navTarget(command) {
    for (const [pattern, panelId] of NAV_COMMANDS) {
      if (pattern.test(command.trim())) return panelId;
    }
    return null;
  }

  function isCloseCommand(command) {
    var trimmed = command.trim();
    for (const pattern of CLOSE_COMMANDS) {
      if (pattern.test(trimmed)) return true;
    }
    return false;
  }

  function handleCommand(command) {
    processing = true;
    setState('processing');
    stopRecording();

    // Close panel command — checked before nav
    if (isCloseCommand(command) && closePanel) {
      closePanel();
      caption(' Panels closed.', 'info');
      finishTurn();
      return;
    }

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

    // D5: Pre-flight brain availability check — skip transcription if brain is known offline.
    if (!_brainOnline()) {
      caption('Brain is offline — voice processing unavailable.', 'error');
      finishTurn();
      return;
    }

    // E3: Show progress feedback while waiting for brain response.
    caption('Thinking…', 'info');

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
    const req = utterance({
      text: command,
      // Task 12: real mic-stop timestamp for server-side latency measurement.
      // 0 (the initial value, no recording ever happened this session — e.g.
      // a nav/close command dispatched with no speech) is falsy and ws.js
      // omits it, so an unmeasured turn contributes no sample (AD-5).
      micStoppedAt: lastMicStoppedAt || undefined,
      onChunk: (msg) => enqueueChunk(msg, session),
      onDone: (msg) => {
        if (done) return;
        done = true;
        clearTimeout(grace);
        deliverReply(msg, session);
      },
    });
    activeReqId = req.reqId; // Item B: barge-in (stopSpeaking) needs this to send 'stop'
  }

  // Reserves a fresh session token for a turn whose reply may stream
  // speech-chunk messages before 'done' arrives. Shared by handleCommand
  // (voice) and the external vision-query path (Part B / app.js). reqId is
  // known upfront for server-initiated turns (proactive speech); local
  // dispatch (handleCommand, or app.js callers of utterance()/visionQuery())
  // learns it only once the WS call returns, and sets activeReqId directly.
  function beginTurn(reqId) {
    const session = ++speakSession;
    doneReceived = false;
    lastChunkPlayed = false;
    chunkQueue = [];
    playing = false;
    activeReqId = reqId || null;
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
    // Item B: tell the server to stop synthesizing any not-yet-sent chunks for
    // the turn we just cut off client-side — otherwise edge-tts keeps running
    // in the background for audio nobody will hear. Harmless no-op server-side
    // if the turn already finished (reqId not found).
    if (activeReqId) { stopRequest(activeReqId); activeReqId = null; }
    if (currentAudio) { try { currentAudio.pause(); } catch { /* ok */ } currentAudio = null; }
    if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch { /* ok */ } }
    if (speakingText) { lastSpokenText = speakingText; lastSpokenAt = Date.now(); }
    speakingText = '';
    chunkQueue = [];
    playing = false;
    assistantSpeaking = false; // BUG-027: TTS queue fully drained (or force-stopped) — release the VAD gate
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
    assistantSpeaking = true; // BUG-027: chunk playback starting — arm the VAD gate
    processing = false;     // mic stays live during playback — barge-in
    setState('speaking');
    const isLast = chunk.index === chunk.total - 1;
    // Idempotent completion — see createChunkCompletion() above for why both
    // handlers below can fire for one chunk and what the operator heard when
    // they did.
    const step = createChunkCompletion({
      advance: () => {
        if (speakSession !== session) return;
        if (isLast) lastChunkPlayed = true;
        playNextChunk(session);
      },
      fallback: (done) => speakChunkFallback(chunk.text, session, done),
    });
    if (chunk.audioB64) {
      // Task 5 (step 5, alarms/timers): the bundled alert tone is a real WAV,
      // not edge-tts's MP3 — chunk.mime lets a sender declare that explicitly.
      // Every existing sender omits it, so this defaults to the prior
      // hardcoded behavior unchanged.
      const audio = new Audio('data:' + (chunk.mime || 'audio/mpeg') + ';base64,' + chunk.audioB64);
      currentAudio = audio;
      audio.onended = step.done;
      audio.onerror = step.fail;
      audio.play().catch(step.fail);
    } else {
      speakChunkFallback(chunk.text, session, step.done);
    }
  }

  // Memoised: getVoices() is cheap but the list is stable for the page's life,
  // and in Chrome it is empty until 'voiceschanged' fires — so a null result is
  // NOT cached, letting a later call pick the voice up once the list populates.
  let _pickedVoice = null;
  function preferredVoice() {
    if (_pickedVoice) return _pickedVoice;
    if (!window.speechSynthesis || typeof window.speechSynthesis.getVoices !== 'function') return null;
    try { _pickedVoice = pickSpeechVoice(window.speechSynthesis.getVoices()); } catch { return null; }
    return _pickedVoice;
  }

  function speakChunkFallback(text, session, onDone) {
    if (window.speechSynthesis && !disposed) {
      const u = new SpeechSynthesisUtterance(sanitizeForTts(text));
      const v = preferredVoice();
      if (v) u.voice = v;
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
      // Task 6: the reply just finished playing — clear the caption back to
      // the idle hint instead of leaving the spoken phrase on screen forever.
      caption('', 'idle');
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

    const spoken = sanitizeForTts(msg.speak || say);
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
    assistantSpeaking = true; // BUG-027: non-chunked reply starting to speak — arm the VAD gate
    const finish = () => {
      if (speakSession !== session) return;
      stopSpeaking();
      // Task 6: same clear-on-finish as maybeFinishTurn() above, for the
      // non-chunked (speechSynthesis fallback) reply path.
      caption('', 'idle');
      finishTurn();
    };
    if (window.speechSynthesis && !disposed) {
      const u = new SpeechSynthesisUtterance(sanitizeForTts(spoken));
      const v = preferredVoice();
      if (v) u.voice = v;
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
    if (isVisionQuery(command) && onVisionQuery) {
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
    stream = await navigator.mediaDevices.getUserMedia(buildAudioConstraints(getMicDeviceId()));
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    // Pre-roll ring buffer: load the AudioWorklet module and connect the source
    // to a PrerollProcessor node, then to a muted gain → destination so the
    // graph keeps pulling audio (AudioWorklet is pull-based; without a
    // downstream sink the process() callback never fires). The muted gain
    // ensures no sound leaks to the speakers.
    try {
      await audioCtx.audioWorklet.addModule('/js/voice/preroll-worklet.js');
      prerollNode = new AudioWorkletNode(audioCtx, 'preroll-processor');
      const mutedGain = audioCtx.createGain();
      mutedGain.gain.value = 0;
      source.connect(prerollNode);
      prerollNode.connect(mutedGain);
      mutedGain.connect(audioCtx.destination);
      prerollSampleRate = audioCtx.sampleRate;
    } catch (err) {
      // Worklet not supported or module failed to load — degrade to no pre-roll
      // (the old behavior: first 1-3 words may be clipped, but capture works).
      // Context, not just the message: addModule() reports every cause as the
      // same "Unable to load a worklet's module", so err alone cannot tell a 404
      // from an AudioContext whose render thread never started (see the same
      // note in wakeword.js, operator 2026-08-13).
      console.warn('[voice] preroll worklet unavailable, capturing without pre-roll:',
        (err && err.name) || 'Error', (err && err.message) || err,
        `[ctx.state=${audioCtx && audioCtx.state} sampleRate=${audioCtx && audioCtx.sampleRate}]`);
      prerollNode = null;
    }
    return stream;
  }

  // Snapshot the current pre-roll ring buffer contents. Called when VAD confirms
  // speech (at startRecording time). Returns a Promise that resolves to a
  // Float32Array of the last ~1s of audio, or null if no worklet is available.
  function snapshotPreroll() {
    if (!prerollNode) return Promise.resolve(null);
    return new Promise(function(resolve) {
      var settled = false;
      var onMsg = function(e) {
        if (settled || !e.data || e.data.type !== 'snapshot') return;
        settled = true;
        prerollNode.port.removeEventListener('message', onMsg);
        resolve(e.data.samples);
      };
      prerollNode.port.addEventListener('message', onMsg);
      prerollNode.port.postMessage({ type: 'snapshot' });
      // Safety timeout — if the worklet doesn't respond in 200ms, give up
      setTimeout(function() {
        if (settled) return;
        settled = true;
        prerollNode.port.removeEventListener('message', onMsg);
        resolve(null);
      }, 200);
    });
  }

  function startRecording() {
    if (recorder) return;
    // REMEDIATION P0-3 (2026-07-29 audit, item 10 — council verdict): duck
    // system/media playback volume for exactly the VAD-confirmed recording
    // window, so Spotify lyrics can't be transcribed as commands. This is
    // the mic-hot boundary — the earliest point real speech is confirmed,
    // not merely "listening" (which is open the whole session). Server
    // restores the pre-duck volume in stopRecording() below, or after a
    // bounded timeout if this connection drops mid-utterance.
    sendMessage({ type: 'duck-audio' });
    chunks = [];
    recordingSince = Date.now();
    peakRms = 0;
    // Snapshot the pre-roll ring buffer NOW — this captures the ~1s of audio
    // BEFORE the hold gate completed, recovering the first 1-3 words that were
    // previously lost. Snapshotted synchronously before recording starts so the
    // audio predates the MediaRecorder's first sample. The snapshot resolves
    // async (worklet message round-trip) but the recorder starts immediately —
    // the merge happens in onstop after recording finishes.
    snapshotPreroll().then(function(snap) { prerollBuffer = snap; });
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
      var capturedPreroll = prerollBuffer; // grab before clearing
      recorder = null;
      chunks = [];
      prerollBuffer = null;
      if (!loudEnough) {
        // BUG-270: this drop used to be silent — missed speech left zero
        // evidence anywhere, so "not picking up words" was undiagnosable.
        // Warn with the measured peak and the floor, and say so in the HUD.
        console.warn('[voice] clip dropped: peak RMS ' + peakRms.toFixed(4)
          + ' below floor ' + MIN_PEAK_RMS
          + ' — speech detected but too quiet (tune VAD_MIN_PEAK_RMS)');
        caption('🎤 too quiet — not sent', 'error');
        return;
      }
      // With pre-roll, the effective clip length includes the pre-roll duration.
      // MIN_CLIP_MS was originally raised to 500 because the first words were
      // being clipped — with pre-roll recovered, we can check the full duration.
      var prerollMs = capturedPreroll ? Math.round(capturedPreroll.length / prerollSampleRate * 1000) : 0;
      var effectiveMs = clipMs + prerollMs;
      if (effectiveMs < MIN_CLIP_MS || blob.size < MIN_CLIP_BYTES) {
        // BUG-270: same observability hole as the loudness gate above.
        console.warn('[voice] clip dropped: ' + effectiveMs + 'ms / ' + blob.size
          + 'B below minimums (' + MIN_CLIP_MS + 'ms / ' + MIN_CLIP_BYTES + 'B)');
        caption('🎤 too short — not sent', 'error');
        return;
      }
      // Merge pre-roll + recorded audio if a pre-roll snapshot is available.
      if (capturedPreroll && capturedPreroll.length) {
        mergePrerollAndTranscribe(blob, type, capturedPreroll);
      } else {
        transcribeAndDispatch(blob);
      }
    };
    recorder.start();
  }

  // Merge the pre-roll PCM (from the ring buffer snapshot) with the recorded
  // audio blob (from MediaRecorder), then transcribe. The MediaRecorder blob
  // is decoded back to PCM via decodeAudioData, concatenated with the pre-roll,
  // and re-encoded as a WAV file. The /api/voice/transcribe route accepts
  // arbitrary audio MIME types so WAV is fine. If any step fails, fall back to
  // transcribing the raw recorded blob (the old behavior — no pre-roll).
  async function mergePrerollAndTranscribe(blob, blobType, prerollPcm) {
    try {
      var arrayBuf = await blob.arrayBuffer();
      var decoded = await audioCtx.decodeAudioData(arrayBuf);
      // Take channel 0 (mono) from the decoded audio
      var recordedPcm = decoded.getChannelData(0);
      var sr = decoded.sampleRate;
      // If pre-roll sample rate differs from decoded rate, skip the merge
      // (resampling is out of scope — the worklet and MediaRecorder should both
      // run at the context sample rate, so this is a safety check only).
      if (sr !== prerollSampleRate) {
        transcribeAndDispatch(blob);
        return;
      }
      // Concatenate: pre-roll PCM first (oldest audio), then recorded PCM
      var merged = new Float32Array(prerollPcm.length + recordedPcm.length);
      merged.set(prerollPcm, 0);
      merged.set(recordedPcm, prerollPcm.length);
      // Encode to WAV
      var wav = encodeWav(merged, sr);
      var wavBlob = new Blob([wav], { type: 'audio/wav' });
      transcribeAndDispatch(wavBlob);
    } catch (err) {
      // decode/merge failed — fall back to the raw recorded blob
      console.warn('[voice] pre-roll merge failed, transcribing raw:', err);
      transcribeAndDispatch(blob);
    }
  }

  // Encode a Float32Array of mono PCM into a WAV Blob (44-byte header + raw
  // 16-bit PCM). No dependencies — pure byte manipulation. WAV is the simplest
  // uncompressed audio format and is universally decodable by Whisper.
  function encodeWav(samples, sampleRate) {
    var buffer = new ArrayBuffer(44 + samples.length * 2);
    var view = new DataView(buffer);
    // RIFF header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(view, 8, 'WAVE');
    // fmt chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);          // chunk size
    view.setUint16(20, 1, true);           // audio format = PCM
    view.setUint16(22, 1, true);           // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true);           // block align
    view.setUint16(34, 16, true);          // bits per sample
    // data chunk
    writeString(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true);
    // PCM samples (float32 → int16)
    var offset = 44;
    for (var i = 0; i < samples.length; i++, offset += 2) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return buffer;
  }

  function writeString(view, offset, str) {
    for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  function stopRecording() {
    // Task 12: stamp BEFORE the async stop/transcribe/dispatch chain begins —
    // this is the true mic-stop moment the latency measurement is anchored to.
    lastMicStoppedAt = Date.now();
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* ok */ } }
    silenceSince = null;
    aboveCount = 0;
    // REMEDIATION P0-3: restore playback volume — the mic-hot window closed.
    // Transcription/dispatch happens async after this; playback doesn't need
    // to stay ducked for that (network-bound, not acoustic).
    sendMessage({ type: 'unduck-audio' });
  }

  async function transcribeAndDispatch(blob) {
    try {
      const res = await fetch('/api/voice/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
      });
      if (disposed || !active) return; // stopped while the request was in flight — drop it
      const body = await res.json().catch(() => ({}));
      if (disposed || !active) return;
      if (!res.ok || body.ok === false || typeof body.text !== 'string') {
        caption(body.message || body.error || 'Speech-to-text unavailable.', 'error');
        return;
      }
      processTranscript(body.text);
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
    // RMS is always computed — it drives the visualizer regardless of engine,
    // and is the fallback `level` until Silero has loaded (or if it fails to).
    let level = rms(data);
    if (VAD_ENGINE === 'silero') {
      if (sileroVad && sileroVad.ready) {
        const floats = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) floats[i] = (data[i] - 128) / 128;
        const resampled = resampleLinear(floats, audioCtx.sampleRate, MODEL_SAMPLE_RATE);
        const { frames, remainder } = accumulateFrames(sileroBuffer, resampled, FRAME_SAMPLES);
        sileroBuffer = remainder;
        for (const frame of frames) {
          // Fire-and-forget: probeFrame is async and setInterval's vadTick is
          // not, so the result lands on a LATER tick (at most ~100ms behind,
          // acceptable for VAD). sileroProb keeps the most recent result.
          sileroVad.probeFrame(Float32Array.from(frame)).then((p) => { if (p != null) sileroProb = p; });
        }
        level = sileroProb;
      } else {
        ensureSileroLoaded(); // idempotent; keeps using RMS `level` until ready
      }
    }
    if (recorder) peakRms = Math.max(peakRms, level);
    // Drive the visualizer with the live VAD level — the mic-indicator shows
    // dynamic waves proportional to the input level, flat when silent. Only
    // fires while listening (not during processing/speaking/idle).
    if (onActivity && active && !processing && !speakingText) {
      onActivity(level);
    }
    // BUG-027: hard mechanical half-duplex gate — while MYTHOS's own TTS is
    // playing (or queued to play), never arm a new recording. This is
    // independent of isEcho()/ECHO_GUARD_MS (a fuzzy post-hoc text match on
    // the transcript that already came back) — it stops the capture pipeline
    // from ever starting on the assistant's own voice bleeding into the mic.
    if (assistantSpeaking) {
      aboveCount = 0;
      // Item 8 (barge-in): ADDITIVE second, higher threshold INSIDE the
      // BUG-027 gate — this does not open the gate for ordinary speech-level
      // audio, only for sustained loud audio that looks like the user
      // talking over MYTHOS. decideBargeIn is pure/stateless; the running
      // count still lives here (bargeAboveCount) same as aboveCount does for
      // the normal VAD path above.
      const decision = decideBargeIn({
        level,
        assistantSpeaking,
        bargeAboveCount,
        thresholds: {
          bargeThreshold: SPEECH_RMS * BARGE_IN_RMS_MULT,
          bargeHoldTicks: SPEECH_HOLD_TICKS * BARGE_IN_HOLD_TICKS_MULT,
        },
      });
      bargeAboveCount = decision.newBargeAboveCount;
      if (decision.shouldBargeIn) {
        stopSpeaking();      // cut TTS immediately — decision made at VAD level
        aboveCount = 1;
        startRecording();    // the loud tick IS the start of the user's utterance
      }
      return;
    }
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
    // BUG-269 defect 3: instant visible feedback, synchronously, before
    // anything asynchronous — ensureMic() is unbounded on the first press per
    // session, and a slow press used to look exactly like a lost one. The
    // compose-bar/orb/hud fan-out treats an unknown state harmlessly.
    setState('arming');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      setState('unsupported'); // honest: no mic-recording API in this browser
      return false;
    }
    try {
      await ensureMic();
    } catch (err) {
      console.warn('[voice] microphone unavailable (' + ((err && err.name) || 'unknown') + '):', err);
      setState('disabled');
      caption(micErrorMessage(err), 'error');
      return false;
    }
    if (disposed) return false;
    active = true;
    processing = false;
    setState('listening');
    vadTimer = setInterval(vadTick, VAD_TICK_MS);
    vadTick(); // BUG-269 defect 3: first VAD tick NOW, not up to a full 100ms
    // tick later — removes the dead time between arming and the first sample.
    // vadTick() is a safe no-op if the analyser is somehow gone.
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
    prerollNode = null;
    prerollBuffer = null;
    // Drop the carry-over buffer and recurrent state — a new listening
    // session should not pick up mid-frame from a previous one. sileroVad
    // itself (the loaded model session) is kept; reloading it every
    // start/stop would refetch nothing (cached), but reset() is still cheap
    // and correct to call every time.
    sileroBuffer = new Float32Array(0);
    if (sileroVad) sileroVad.reset();
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
    // Item B: external callers (visionQuery/utterance return {reqId, stop} only
    // after beginTurn() already reserved the session) report the reqId back so
    // barge-in (stopSpeaking) can cancel synthesis for THEIR turns too, not
    // just handleCommand's own.
    setActiveReqId(reqId) { activeReqId = reqId || null; },
    // Mic device selection (mic-settings panel): persist the chosen deviceId
    // and drop any live stream so the next ensureMic() re-acquires on the new
    // device. Selection is read fresh from localStorage inside ensureMic(), so
    // s2s-bridge/wakeword honor the same key without a shared setter.
    setMicDevice(id) {
      setMicDeviceId(id);
      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    },
    getMicDevice: () => getMicDeviceId(),
  };
}
