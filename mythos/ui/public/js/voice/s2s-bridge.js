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

  function setState(s) { if (onState) onState(s); }

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
    onLiveStateMsg = (msg) => { setState(msg && msg.state === 'open' ? 'listening' : (msg && msg.state) || 'idle'); };
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
        if (!active) return;
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
    isActive: () => active,
    isSpeaking: () => (player ? player.isSpeaking() : false),
  };
}
