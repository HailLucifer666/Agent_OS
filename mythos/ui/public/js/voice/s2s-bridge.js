// s2s-bridge.js — Phase 4 (V2 §9, merged-order step 4): browser-side glue for
// native Gemini Live speech-to-speech voice.
//
// Deliberately a SEPARATE module from voice-loop.js rather than a
// modification of it: voice-loop.js's batch-STT path is the untouched honest
// fallback under VOICE_S2S_ENABLED=false (the default — see V2 §16's
// rollback table), and this file owns only the S2S-specific wiring so the
// existing, already-tested voice loop is never at risk of regressing. The
// caller (app.js) picks ONE of the two on wake-word arm, gated by the same
// config flag the server already exposes.
//
// Wiring contract:
//   - start() sends {type:'live-open'}, opens the mic, loads
//     pcm-capture-worklet.js, and streams 16kHz PCM frames to the server as
//     {type:'live-audio', data} — matching the frozen wire shape server/
//     index.js's ws.on('message') branch expects (Phase 5).
//   - Incoming {type:'live-audio-out'}, {type:'live-interrupted'},
//     {type:'live-state'}, {type:'live-transcript'} broadcasts are self-wired
//     via onBroadcast/offBroadcast — no manual routing needed from the caller.
//   - stop() sends {type:'live-close'} and tears down the worklet graph.
//
// No echo guard here (V2 §9): voice-loop.js's ECHO_GUARD_MS/echoMatch exist
// because batch Whisper STT re-transcribes MYTHOS's own TTS as a SEPARATE
// pass; a continuous duplex Live stream has no separate transcription step to
// fool, and fighting the model's own server-side VAD with a text-similarity
// heuristic would only eat real user speech. getUserMedia's
// echoCancellation/noiseSuppression/autoGainControl remain the acoustic-level
// defense — headphones give the best result.
//
// NOT independently unit-tested beyond what it composes: pcm-resample.test.js
// and pcm-player.test.js already cover the resampling math and playback
// scheduling this file drives. The remaining wiring here (getUserMedia,
// AudioWorkletNode, the live WS socket) has no meaningful Node-side test
// double that wouldn't just be re-asserting the mocks — it needs a real
// browser with a real microphone, which is the operator's job (V2 §14's live
// verification items 1-4).

import { sendMessage, onBroadcast, offBroadcast } from '../ws.js';
import { createPcmPlayer } from './pcm-player.js';
import { getMicDeviceId, buildAudioConstraints } from './mic-device.js';

const FRAME_MS = 100;
const TARGET_RATE = 16000;
const PLAYBACK_RATE = 24000;

export function createS2SBridge({ onState, onCaption } = {}) {
  let active = false;
  let stream = null;
  let audioCtx = null;
  let captureNode = null;
  let player = null;

  // Bound listener refs, so stop() can precisely unsubscribe the exact
  // functions start() registered (offBroadcast matches by reference).
  let onAudioOutMsg = null;
  let onInterruptedMsg = null;
  let onLiveStateMsg = null;
  let onTranscriptMsg = null;

  // BUG-059: debounce for the auto-reopen below, so a persistent server-side
  // failure (e.g. breaker tripped) can't turn into a tight live-open retry loop.
  const AUTO_REOPEN_COOLDOWN_MS = 3000;
  let lastAutoReopenAt = 0;

  function setState(s) { if (onState) onState(s); }

  // Half-duplex gate for MYTHOS's OWN server-side TTS — the boot greeting,
  // reminders, build announcements and idle thoughts. Those play through the
  // speakers from a SEPARATE <audio> element (voice-loop.js's chunk queue)
  // while this bridge is streaming the microphone, so Gemini hears them and
  // answers itself.
  //
  // Not a theory: vault/Episodic/2026-07-31.jsonl has the boot greeting coming
  // back as three USER transcripts ("All systems are online and the build is
  // green") with the model replying to each, and the operator heard its own
  // words repeated. getUserMedia's echoCancellation is already on (mic-device.js)
  // and did not stop it on speakers.
  //
  // This is NOT the text-similarity echo guard the header rejects — that one
  // fights the model's VAD over what the OPERATOR said. This drops mic frames
  // only while we are knowingly making noise ourselves.
  //
  // Frames are dropped rather than the stream stopped: no permission churn, no
  // worklet teardown, and the mic indicator stays honest about being open. The
  // timeout matters — a 'speaking' state that never clears (a
  // SpeechSynthesisUtterance whose onend never fires) would otherwise leave
  // Live permanently deaf with no symptom except silence.
  const MAX_SUSPEND_MS = 30000;
  let captureSuspended = false;
  let suspendTimer = null;
  function setCaptureSuspended(flag, holdMs) {
    const next = Boolean(flag);
    if (suspendTimer) { clearTimeout(suspendTimer); suspendTimer = null; }
    captureSuspended = next;
    if (next) {
      const ceiling = Math.min(Number(holdMs) || MAX_SUSPEND_MS, MAX_SUSPEND_MS);
      suspendTimer = setTimeout(() => {
        suspendTimer = null;
        captureSuspended = false;   // fail open: a deaf assistant is the worse failure
      }, ceiling);
    }
  }

  // WAVE 5 — MEDIA echo, the sibling of our own TTS above. When an effector starts
  // playback (spotify_play, open_web type:"youtube"), the media's own audio comes
  // out of the same speakers and Gemini transcribes it as the OPERATOR. In the
  // 2026-07-31 session a German YouTube narration arrived as two "User:" turns.
  //
  // The tradeoff is real and is NOT resolved in favour of silence: a song plays
  // for minutes, and suspending capture for its whole duration would leave MYTHOS
  // deaf exactly when the operator is most likely to say "next" or "stop that".
  // So this suspends only the opening burst — long enough to swallow the intro
  // narration that actually produced the false turns — and then fails open. Pass a
  // larger hold (bounded by MAX_SUSPEND_MS) if the operator prefers deafness to
  // false transcripts; that is their call, not a default worth choosing for them.
  const MEDIA_START_SUSPEND_MS = 8000;
  function suspendForMedia(holdMs) {
    setCaptureSuspended(true, Number(holdMs) || MEDIA_START_SUSPEND_MS);
  }

  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  async function start() {
    if (active) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setState('unsupported');
      return false;
    }

    onAudioOutMsg = (msg) => { if (player && msg && msg.data) player.enqueue(msg.data); };
    onInterruptedMsg = () => { if (player) player.flush(); };
    onLiveStateMsg = (msg) => {
      const s = msg && msg.state;
      setState(s === 'open' ? 'listening' : s || 'idle');
      // BUG-059: the server-side session (live-session.js) now rotates itself
      // transparently through idle-timeout/session-max, so a terminal 'closed'
      // reaching the browser while the operator never pressed stop() (active
      // is still true) means a genuine failure the server couldn't recover
      // from on its own (no API key, breaker open, an unexpected drop with no
      // resume handle yet). Previously this just repainted the mic indicator
      // and left the operator talking to a dead session until they noticed
      // and re-armed it by hand ("I have to click you every time"). Resend
      // live-open to give the server a fresh liveSession — the mic capture
      // pipeline here was never torn down, so nothing else needs rebuilding.
      // Config-permanent failures (disabled/no key) are excluded since
      // retrying those cannot succeed and would just loop. 'reconnecting' is
      // deliberately NOT handled here: the server is already mid-transparent-
      // reconnect for that state, and sending live-open now would stomp its
      // in-flight liveSession with a brand new one.
      if (s === 'closed' && active && msg.reason !== 'disabled' && msg.reason !== 'no-key') {
        const now = Date.now();
        if (now - lastAutoReopenAt > AUTO_REOPEN_COOLDOWN_MS) {
          lastAutoReopenAt = now;
          sendMessage({ type: 'live-open' });
        }
      }
    };
    onTranscriptMsg = (msg) => { if (onCaption && msg) onCaption(msg.text, msg.role === 'user' ? 'heard' : 'reply'); };
    onBroadcast('live-audio-out', onAudioOutMsg);
    onBroadcast('live-interrupted', onInterruptedMsg);
    onBroadcast('live-state', onLiveStateMsg);
    onBroadcast('live-transcript', onTranscriptMsg);

    sendMessage({ type: 'live-open' });

    try {
      stream = await navigator.mediaDevices.getUserMedia(buildAudioConstraints(getMicDeviceId()));
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      await audioCtx.audioWorklet.addModule('/js/voice/pcm-capture-worklet.js');
      captureNode = new AudioWorkletNode(audioCtx, 'pcm-capture', {
        processorOptions: { targetRate: TARGET_RATE, frameMs: FRAME_MS },
      });
      captureNode.port.onmessage = (e) => {
        if (!active || captureSuspended) return;   // see setCaptureSuspended
        sendMessage({ type: 'live-audio', data: arrayBufferToBase64(e.data) });
      };
      source.connect(captureNode);
      // Pull-based worklet needs a downstream sink to keep firing (same
      // muted-gain trick voice-loop.js's ensureMic() already uses for the
      // preroll worklet) — no sound leaks to the speakers.
      const mutedGain = audioCtx.createGain();
      mutedGain.gain.value = 0;
      captureNode.connect(mutedGain);
      mutedGain.connect(audioCtx.destination);
    } catch (err) {
      console.warn('[s2s] failed to start capture:', err);
      setState('disabled');
      await stop();
      return false;
    }

    player = createPcmPlayer({ sampleRate: PLAYBACK_RATE });
    active = true;
    return true;
  }

  async function stop() {
    if (!active && !stream && !audioCtx) return;
    active = false;
    sendMessage({ type: 'live-close' });
    if (onAudioOutMsg) { offBroadcast('live-audio-out', onAudioOutMsg); onAudioOutMsg = null; }
    if (onInterruptedMsg) { offBroadcast('live-interrupted', onInterruptedMsg); onInterruptedMsg = null; }
    if (onLiveStateMsg) { offBroadcast('live-state', onLiveStateMsg); onLiveStateMsg = null; }
    if (onTranscriptMsg) { offBroadcast('live-transcript', onTranscriptMsg); onTranscriptMsg = null; }
    if (captureNode) { try { captureNode.disconnect(); } catch { /* ok */ } captureNode = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (audioCtx) { try { await audioCtx.close(); } catch { /* ok */ } audioCtx = null; }
    if (player) { player.close(); player = null; }
    setState('idle');
  }

  return {
    start,
    stop,
    setCaptureSuspended,
    suspendForMedia,
    isActive: () => active,
    isCaptureSuspended: () => captureSuspended,
    isSpeaking: () => (player ? player.isSpeaking() : false),
  };
}
