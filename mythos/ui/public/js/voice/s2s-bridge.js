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
import { createBargeInBackstop } from './barge-in-backstop.js';

const FRAME_MS = 100;
const TARGET_RATE = 16000;
const PLAYBACK_RATE = 24000;

// screenShare (Slice 3) is an OPTION, not an import-time dependency: the module
// is loaded lazily inside start() only when the operator opted in, so a default
// install never pulls the capture code into the HUD's critical path.
//
// sendMessageOverride (Wave 0, 2026-08-13): the real ws.js sendMessage requires
// a live socket/WebSocket global that only exists in a browser, so tests inject
// a spy here instead of mocking the whole ws.js module graph (which every other
// voice-loop.js import shares). Defaults to the real one — no behavior change
// outside tests.
export function createS2SBridge({ onState, onCaption, screenShare, sendMessageOverride } = {}) {
  const send = sendMessageOverride || sendMessage;
  let active = false;
  let stream = null;
  let audioCtx = null;
  let captureNode = null;
  let player = null;
  let screenCapture = null;   // Slice 3 screen share, null unless opted in

  // Client-side barge-in backstop (V2 spine §1002-1005). The server's
  // `live-interrupted` is the primary signal and still does all the work when
  // Gemini's VAD fires; this only covers the case where it MISSES, which is
  // what the operator experiences as "it talks over me". Local flush only —
  // see barge-in-backstop.js for why nothing is sent to the server here.
  // releaseOwnVoiceGate is a function DECLARATION below, so it is hoisted and
  // safe to reference here. A sustained-loud local streak is the operator
  // genuinely talking over us, which is exactly when the half-duplex gate has
  // to get out of the way — see the gate's own comment for why it opens here
  // rather than waiting for playback to end.
  //
  // TWO TIERS since 2026-08-14. onRelease is the eager one: it opens the gate and
  // touches playback not at all, so the operator's audio reaches Gemini after
  // ~200ms of ordinary speech and Gemini's own VAD — the better detector — makes
  // the interruption call. onFlush is the higher tier that actually stops MYTHOS
  // talking. Before the split, one threshold decided both, it never fired in the
  // 2026-08-14 session, and the operator's speech died in the 1.2s preroll ring:
  // two turns reached the server as live-turn-no-user-transcript.
  const bargeBackstop = createBargeInBackstop({
    onFlush: (level) => {
      if (player) player.flush();
      notePeakRms(level);   // before the release, so the hold's log line includes it
      releaseOwnVoiceGate('barge-in');
    },
    onRelease: (level) => {
      notePeakRms(level);
      releaseOwnVoiceGate('barge-in-eager');
    },
    ...bargeTuning(),
  });

  // Bound listener refs, so stop() can precisely unsubscribe the exact
  // functions start() registered (offBroadcast matches by reference).
  let onAudioOutMsg = null;
  let onInterruptedMsg = null;
  let onLiveStateMsg = null;
  let onTranscriptMsg = null;
  let onWatchdogClearMsg = null;

  // BUG-059: debounce for the auto-reopen below, so a persistent server-side
  // failure (e.g. breaker tripped) can't turn into a tight live-open retry loop.
  const AUTO_REOPEN_COOLDOWN_MS = 3000;
  let lastAutoReopenAt = 0;

  // BUG-147: "start requested" is tracked SEPARATELY from "capture running".
  // `active` only becomes true after getUserMedia + the worklet graph are up
  // (~100ms, longer on first permission grant), and the auto-reopen guard below
  // tested `active` — so a terminal `closed` arriving during that window was
  // dropped and the session was never retried, leaving the operator talking to
  // nothing. It is also what makes a failure DURING startup observable at all.
  let startRequested = false;

  // BUG-147: nothing repainted the orb until a live-state arrived from the
  // server, so a click whose live-open produced no reply (the BUG-146
  // already-open early return, a dropped socket, a stalled open) looked
  // identical to a click that never registered. The orb now reacts to the CLICK,
  // and this timer converts silence into a visible refusal instead of a blank
  // stare.
  const OPEN_ACK_TIMEOUT_MS = 6000;
  let openAckTimer = null;
  function clearOpenAckTimer() {
    if (openAckTimer) { clearTimeout(openAckTimer); openAckTimer = null; }
  }
  function armOpenAckTimer() {
    clearOpenAckTimer();
    openAckTimer = setTimeout(() => {
      openAckTimer = null;
      if (!startRequested) return;   // stopped in the meantime; nothing to report
      setVoiceState('idle');
      if (onCaption) {
        onCaption('Live voice did not respond — click to try again.', 'error');
      }
    }, OPEN_ACK_TIMEOUT_MS);
  }

  function setState(s) { if (onState) onState(s); }

  // Wave 2 (2026-08-13): candidate 1 for the lost-transcript incidents — the
  // mic gate below drops frames while captureSuspended, but the orb still
  // showed 'listening', so the operator had no idea they were talking to a
  // client that had already stopped sending audio. lastVoiceState is the
  // underlying voice-loop state (idle|listening|processing|speaking) as if
  // captureSuspended didn't exist; setVoiceState is what every real state
  // transition below now goes through, so the mute overlay in
  // setCaptureSuspended can always restore the right thing on clear instead
  // of guessing 'listening'.
  let lastVoiceState = 'idle';
  function setVoiceState(s) {
    lastVoiceState = s;
    setState(captureSuspended ? 'muted' : s);
  }

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
  // Wave 0 (2026-08-13): fire-and-forget transition log so the server side has
  // a record of every suspend/clear, not just the fact a turn later came back
  // blind. Best-effort — sendMessage throwing (socket not open yet) must never
  // block the capture gate itself.
  function logSuspendTransition(extra) {
    try {
      send({ type: 'voice-capture-suspend', suspended: captureSuspended, at: Date.now(), ...extra });
    } catch (_) { /* logging only — never block the gate */ }
  }
  function setCaptureSuspended(flag, holdMs, reason) {
    const next = Boolean(flag);
    if (suspendTimer) { clearTimeout(suspendTimer); suspendTimer = null; }
    captureSuspended = next;
    // Wave 2: paint the overlay the moment the gate itself changes, not on
    // the next unrelated live-state message — a caption alongside it, since
    // "muted" alone doesn't say WHY (core-orb.js collapses anything it
    // doesn't recognize to idle, so this is additive, not a repaint hack).
    setState(next ? 'muted' : lastVoiceState);
    if (next && onCaption) onCaption('Mic muted — media playing', 'muted');
    if (next) {
      const ceiling = Math.min(Number(holdMs) || MAX_SUSPEND_MS, MAX_SUSPEND_MS);
      logSuspendTransition({ holdMs: ceiling, reason: reason || 'suspend' });
      suspendTimer = setTimeout(() => {
        suspendTimer = null;
        captureSuspended = false;   // fail open: a deaf assistant is the worse failure
        setState(lastVoiceState);
        logSuspendTransition({ reason: 'ceiling-fail-open' });
      }, ceiling);
    } else {
      logSuspendTransition({ reason: reason || 'clear' });
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
    setCaptureSuspended(true, Number(holdMs) || MEDIA_START_SUSPEND_MS, 'media-start');
  }

  // ---- BUG-224: half-duplex against MYTHOS's OWN Live voice -----------------
  //
  // The gate above covers our own edge-tts and media playback. It never covered
  // the loudest source of all: the Live model's own spoken reply. Those frames
  // come out of the same speakers, back in through the same mic, and go straight
  // to Gemini's server-side VAD — which is configured START_SENSITIVITY_HIGH
  // (live-session.js) precisely so it reacts to speech onset quickly.
  //
  // That produces BOTH of the operator's complaints from one mechanism:
  //   - the VAD hears MYTHOS's own trailing word, decides the operator has
  //     started talking, and fires serverContent.interrupted — so the server
  //     STOPS SYNTHESIZING mid-word. This is why pcm-player's 250ms tail guard
  //     (BUG-084) never fixed the clipping: that guard protects audio already
  //     buffered on the client, and cannot recover a word the server never sent.
  //   - and the same self-trigger, one turn later, reads as MYTHOS interrupting
  //     the operator.
  //
  // getUserMedia already asks for echoCancellation (mic-device.js) and it is not
  // enough on open-air speakers — BUGS.md has recorded that twice.
  //
  // Two properties make this safe rather than a mute button:
  //   1. It gates the SEND to Gemini only. bargeBackstop.observe() keeps running
  //      on every frame, so a genuine interruption is still detected locally —
  //      and its onFlush opens this gate immediately (see above). Gating the
  //      observe() call too, the way the media gate does, would disable barge-in
  //      exactly while MYTHOS is speaking, which is the only time it matters.
  //   2. The frames dropped during the gate are not thrown away but kept in a
  //      short preroll ring and sent on release, so the first word of an
  //      interruption is not lost. Without this, "stop, actually—" would reach
  //      the model as "actually—".
  //
  // Kill switch: localStorage.MYTHOS_LIVE_HALF_DUPLEX = 'off' (same per-session
  // idiom the VAD constants already use — see docs/live-verification-runbook.md).
  // Same fail-open reasoning as MAX_SUSPEND_MS above, and the same reason it is
  // not optional: if onSpeakEnd never arrives (a player torn down mid-utterance,
  // an AudioContext that never resumes), a gate with no ceiling leaves Live
  // permanently deaf with no symptom except silence.
  //
  // IT IS AN IDLE WINDOW, NOT AN ABSOLUTE CAP — and it was the wrong shape until
  // 2026-08-14. As a flat 20s ceiling this constant was written as a watchdog for
  // "onSpeakEnd never arrived", but measured against a real session it was a cap
  // on how long MYTHOS was allowed to speak: own-voice-ended n=31, median 6650ms,
  // MAX 17941ms, against a 20000ms ceiling that then tripped twice at 20001ms. So
  // on the longest answers the gate opened while MYTHOS was still talking, its own
  // voice went back into Gemini's START_SENSITIVITY_HIGH VAD, and it re-created
  // the exact self-interrupt this whole gate exists to prevent.
  //
  // Refreshed on every arriving live-audio-out chunk (see onAudioOutMsg), the same
  // window is both safer and more responsive: it can only expire when audio has
  // genuinely STOPPED arriving and no onSpeakEnd came — which is the condition the
  // watchdog was always meant to detect — so reply length no longer enters into
  // it and reaching it still always means something else broke.
  const OWN_VOICE_IDLE_CEILING_MS = 8000;
  // DERIVED, never hand-tuned — that is the whole fix (2026-08-14, second pass).
  // The ring must span the LONGEST time the gate can possibly be held, because
  // every frame it drops is speech the operator actually made. It was a flat 12
  // frames (1.2s) against a gate that can hold for the full idle ceiling, and the
  // 2026-08-14 session paid for the gap: 36 of 125 holds ended only because this
  // ceiling's watchdog fired, and the four half-blind turns reached the server
  // with audioIn of 6, 9, 11 and 69 frames — i.e. exactly the surviving ring —
  // against 116..584 on healthy turns. Gemini will not transcribe a mid-sentence
  // tail, so `inputTranscription` never arrived and the turn was stored with an
  // empty operator transcript (live-turn-no-user-transcript x33 that day).
  //
  // Deriving it means a future change to the ceiling cannot silently re-open
  // this; test/s2s-preroll-ring.test.js pins the derivation, not the number.
  //
  // F3 (2026-08-15) — THE DERIVATION WAS FROM THE WRONG CONSTANT.
  // OWN_VOICE_IDLE_CEILING_MS is an IDLE window that refreshes on every arriving
  // audio-out chunk (that is the 2026-08-14 fix directly above), so the TOTAL
  // hold is unbounded by it: the same session that motivated the ring recorded a
  // single hold of 17941ms against an 8000ms ring. Anything the operator said
  // more than 8s before release was still dropped, and the ring looked correct
  // while doing it.
  //
  // Measured on 2026-08-14: 18 of 104 user turns reached the server with no
  // inputTranscription, and their audioIn frame counts were
  //   52,43,132,114,116,88,7,18,17,100,8,115,188,40,84,92,1429,9
  // Only five are ring-starved (<=20); thirteen had ample audio. So the ring is
  // ONE cause among several — sizing it correctly is necessary and not
  // sufficient, and the per-hold instrumentation below is what will separate the
  // remaining population instead of another inference a day later.
  //
  // The ring is now derived from an ABSOLUTE cap on the hold, and that cap is
  // enforced (armOwnVoiceMaxHold) rather than assumed — so the ring provably
  // spans every hold that can occur, which the previous derivation only appeared
  // to do. 30s is ~1.7x the longest hold ever observed.
  //
  // The AAD/VAD sensitivity values are deliberately NOT touched: nothing here
  // argues for relaxing them, and the standing instruction not to is correct.
  const OWN_VOICE_MAX_HOLD_MS = 30000;
  // 300 frames x 3200 bytes (100ms of 16kHz mono 16-bit) is ~960KB — bounded,
  // allocated only while MYTHOS is audibly speaking, and freed on release.
  const PREROLL_MAX_FRAMES = Math.ceil(OWN_VOICE_MAX_HOLD_MS / FRAME_MS);
  let ownVoiceGate = false;
  let ownVoiceTimer = null;
  let ownVoiceMaxTimer = null;   // F3: absolute cap, never refreshed
  let ownVoiceHeldAt = 0;
  let preroll = [];
  let prerollDropped = 0;        // F3: frames the ring evicted — speech genuinely lost
  // Peak RMS observed while the gate was held, logged once per hold on release.
  // The 2026-08-14 analysis could only INFER that the backstop threshold was too
  // high, because no RMS figure was ever written down anywhere; this is the number
  // that makes the next tuning decision evidence rather than another inference.
  let ownVoicePeakRms = 0;
  function notePeakRms(level) {
    if (ownVoiceGate && typeof level === 'number' && level > ownVoicePeakRms) ownVoicePeakRms = level;
  }

  function halfDuplexEnabled() {
    try {
      return String(window.localStorage.getItem('MYTHOS_LIVE_HALF_DUPLEX') || '').toLowerCase() !== 'off';
    } catch (_) {
      return true;   // no localStorage (tests, privacy modes) — default on
    }
  }

  // Same field-tunable-without-a-rebuild idiom voice-loop.js already uses for
  // MYTHOS_VAD_RMS / MYTHOS_BARGE_RMS_MULT. Both backstop tiers are exposed
  // because eager barge-in is a deliberate tradeoff the operator chose (stopping
  // on a cough beats losing a sentence) and a tradeoff nobody can walk back in
  // the field is not one they really made. Absent/unparseable keys are omitted
  // entirely so the module's own defaults stay in charge.
  function lsNumber(key) {
    try {
      const v = parseFloat(window.localStorage.getItem(key));
      return Number.isFinite(v) ? v : null;
    } catch (_) {
      return null;   // no localStorage (tests, privacy modes)
    }
  }
  function bargeTuning() {
    const t = {};
    const flushRms = lsNumber('MYTHOS_BARGE_RMS');
    const flushHold = lsNumber('MYTHOS_BARGE_HOLD_FRAMES');
    const releaseRms = lsNumber('MYTHOS_BARGE_RELEASE_RMS');
    const releaseHold = lsNumber('MYTHOS_BARGE_RELEASE_HOLD_FRAMES');
    if (flushRms !== null) t.threshold = flushRms;
    if (flushHold !== null) t.holdFrames = flushHold;
    if (releaseRms !== null) t.releaseThreshold = releaseRms;
    if (releaseHold !== null) t.releaseHoldFrames = releaseHold;
    return t;
  }

  function armOwnVoiceCeiling() {
    if (ownVoiceTimer) clearTimeout(ownVoiceTimer);
    ownVoiceTimer = setTimeout(() => {
      ownVoiceTimer = null;
      releaseOwnVoiceGate('ceiling-fail-open');
    }, OWN_VOICE_IDLE_CEILING_MS);
    if (typeof ownVoiceTimer.unref === 'function') ownVoiceTimer.unref();
  }

  // Called from onAudioOutMsg for every chunk the server sends. A no-op when the
  // gate is not held, so an arriving chunk can never arm a gate nothing holds.
  function refreshOwnVoiceCeiling() {
    if (ownVoiceGate) armOwnVoiceCeiling();
  }

  // F3: the absolute cap. Armed ONCE at hold start and never refreshed — that is
  // the entire difference from armOwnVoiceCeiling(), whose refresh is what let a
  // hold outrun its own ring. Reaching this means the idle ceiling kept being
  // pushed out for half a minute, which is a broken player, not a long answer.
  function armOwnVoiceMaxHold() {
    if (ownVoiceMaxTimer) clearTimeout(ownVoiceMaxTimer);
    ownVoiceMaxTimer = setTimeout(() => {
      ownVoiceMaxTimer = null;
      releaseOwnVoiceGate('max-hold-fail-open');
    }, OWN_VOICE_MAX_HOLD_MS);
    if (typeof ownVoiceMaxTimer.unref === 'function') ownVoiceMaxTimer.unref();
  }

  function holdOwnVoiceGate() {
    if (!halfDuplexEnabled() || ownVoiceGate) return;
    ownVoiceGate = true;
    preroll = [];
    prerollDropped = 0;
    ownVoicePeakRms = 0;
    ownVoiceHeldAt = Date.now();
    armOwnVoiceCeiling();
    armOwnVoiceMaxHold();
    logSuspendTransition({ reason: 'own-voice-hold', ownVoiceGate: true });
  }

  function releaseOwnVoiceGate(reason) {
    if (ownVoiceTimer) { clearTimeout(ownVoiceTimer); ownVoiceTimer = null; }
    if (ownVoiceMaxTimer) { clearTimeout(ownVoiceMaxTimer); ownVoiceMaxTimer = null; }
    if (!ownVoiceGate) return;
    ownVoiceGate = false;
    // Replay what the operator said while we were talking over them. Oldest
    // first, so the model receives it in the order it was spoken.
    const held = preroll;
    preroll = [];
    for (const frame of held) {
      try { send({ type: 'live-audio', data: arrayBufferToBase64(frame) }); } catch (_) { /* socket closed */ }
    }
    logSuspendTransition({
      reason: reason || 'own-voice-release',
      ownVoiceGate: false,
      prerollFrames: held.length,
      // Both of these were computed and then thrown away, which is why the ring
      // overflow could only be INFERRED from Gemini's audioIn counts a day later.
      // prerollFrames === prerollCap means the ring was full, i.e. frames WERE
      // dropped; heldMs says how long the gate was held to earn that.
      prerollCap: PREROLL_MAX_FRAMES,
      heldMs: ownVoiceHeldAt ? Date.now() - ownVoiceHeldAt : 0,
      // F3: the discriminator. prerollFrames === prerollCap says the ring was
      // FULL; framesDropped says how much speech was actually lost, which is the
      // number that separates "the ring is too small" from "the audio reaching
      // Gemini was our own voice" — the two explanations the 2026-08-14 data
      // could not tell apart. A hold that drops nothing and still yields no
      // transcript is evidence for the second, and this is how we will know.
      framesDropped: prerollDropped,
      // One line per hold, not per frame — see ownVoicePeakRms's declaration.
      peakRms: Math.round(ownVoicePeakRms * 10000) / 10000,
    });
    ownVoicePeakRms = 0;
    ownVoiceHeldAt = 0;
    prerollDropped = 0;
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

    // BUG-147: react to the click NOW, not to the network round-trip. 'processing'
    // is deliberate rather than a new state name: core-orb.js maps anything
    // outside listening/processing/speaking to 'idle', so an invented
    // 'connecting' would render as no change at all — exactly the bug.
    startRequested = true;
    setVoiceState('processing');

    onAudioOutMsg = (msg) => {
      if (!player || !msg || !msg.data) return;
      player.enqueue(msg.data);
      // The gate's ceiling is an IDLE window, so every chunk that arrives pushes
      // it out. Without this it was an absolute cap on reply length and tripped
      // mid-sentence on the longest answers — see OWN_VOICE_IDLE_CEILING_MS.
      refreshOwnVoiceCeiling();
    };
    // The server won this race: stop the audio and clear the local run, so a
    // half-accumulated loud streak cannot tip over on the first frame of the
    // NEXT reply. A local flush that already happened makes this a no-op —
    // flush() on nothing scheduled stops nothing.
    onInterruptedMsg = () => { bargeBackstop.reset(); if (player) player.flush(); };
    onLiveStateMsg = (msg) => {
      const s = msg && msg.state;
      // BUG-147: the server answered, so the "no answer" fallback must not fire.
      // Includes the BUG-146 already-open ack, which is the whole reason a click
      // on an already-open session now repaints anything.
      clearOpenAckTimer();
      setVoiceState(s === 'open' ? 'listening' : s || 'idle');
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
      // BUG-147: `startRequested || active` — see startRequested's declaration.
      // Testing `active` alone dropped any closed that arrived while the mic was
      // still being set up.
      if (s === 'closed' && (active || startRequested) && msg.reason !== 'disabled' && msg.reason !== 'no-key') {
        const now = Date.now();
        if (now - lastAutoReopenAt > AUTO_REOPEN_COOLDOWN_MS) {
          lastAutoReopenAt = now;
          sendMessage({ type: 'live-open' });
        }
      }
    };
    onTranscriptMsg = (msg) => { if (onCaption && msg) onCaption(msg.text, msg.role === 'user' ? 'heard' : 'reply'); };
    // Wave 2 (2026-08-13, resume-on-activity watchdog): the server tells us a
    // Live turn came back with no operator transcript. We're the only side
    // that knows whether captureSuspended is actually set right now — a
    // signal on a client that was never suspended (Gemini dropped it
    // server-side instead) is a harmless no-op.
    onWatchdogClearMsg = () => { if (captureSuspended) setCaptureSuspended(false, undefined, 'watchdog-clear'); };
    onBroadcast('live-audio-out', onAudioOutMsg);
    onBroadcast('live-interrupted', onInterruptedMsg);
    onBroadcast('live-state', onLiveStateMsg);
    onBroadcast('live-transcript', onTranscriptMsg);
    onBroadcast('live-watchdog-clear', onWatchdogClearMsg);

    sendMessage({ type: 'live-open' });
    armOpenAckTimer();   // BUG-147: silence from here on becomes a visible refusal

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
        // Measured on the way out, on the same frames the server hears, so the
        // backstop and Gemini's VAD are looking at identical audio. Deliberately
        // AFTER the captureSuspended gate: while we are knowingly making noise
        // ourselves (own TTS, media playback) those frames are not the operator
        // and must not count toward an interruption.
        bargeBackstop.observe(e.data, player ? player.isSpeaking() : false);
        // Instrumentation only, and only while the gate is actually held (notePeakRms
        // checks): the question this answers is "how loud did the operator get while
        // we were refusing to listen?", which is exactly that interval. A frame that
        // triggered a release/flush already folded its own level in from the callback
        // above, before the log line was written.
        notePeakRms(bargeBackstop.lastLevel());
        // BUG-224: while MYTHOS's own voice is in the room, hold the frames
        // instead of feeding them to Gemini's VAD. observe() above deliberately
        // still ran — it is what decides this is a real interruption and opens
        // the gate, and it already takes isSpeaking() into account.
        if (ownVoiceGate) {
          preroll.push(e.data);
          // F3: count evictions. Every shift() here is 100ms of the operator's
          // speech thrown away, and until now it happened silently.
          if (preroll.length > PREROLL_MAX_FRAMES) { preroll.shift(); prerollDropped++; }
          return;
        }
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
      // Same reasoning as wakeword.js/voice-loop.js: name + AudioContext state,
      // because addModule()'s message is identical for every failure cause.
      console.warn('[s2s] failed to start capture:',
        (err && err.name) || 'Error', (err && err.message) || err,
        `[ctx.state=${audioCtx && audioCtx.state} sampleRate=${audioCtx && audioCtx.sampleRate}]`);
      setState('disabled');
      await stop();
      return false;
    }

    player = createPcmPlayer({
      sampleRate: PLAYBACK_RATE,
      // BUG-224. The gate is driven by the edges of our OWN playback, so it is
      // held for exactly as long as we are making noise — no fixed timeout to
      // guess, and pcm-player's own END_GRACE_MS covers the room's reverb tail.
      // F2b (2026-08-15): these two edges also drive the mic indicator. Before
      // this, setState() was reached from exactly two places — onLiveStateMsg
      // and the mute overlay — so on the Live path the state was set to
      // 'listening' once when the session opened and NEVER CHANGED AGAIN for the
      // rest of the session, across every reply. The operator reported it as
      // "the HUD stays blue while it is talking"; they were right, and the
      // hooks to fix it were already wired here and simply unused. The legacy
      // voice-loop.js path has always done this (setState('speaking') at :489,
      // back to listening at :568).
      //
      // The paint is deliberately OUTSIDE the gate: holdOwnVoiceGate() returns
      // early when half-duplex is disabled or the gate is already held, and the
      // orb must still show speech in both of those cases. ownVoiceGate is its
      // own flag, distinct from captureSuspended (the media-playing mute
      // overlay), so this does not fight the overlay for the indicator.
      onSpeakStart: () => { holdOwnVoiceGate(); setVoiceState('speaking'); },
      onSpeakEnd: () => { releaseOwnVoiceGate('own-voice-ended'); setVoiceState('listening'); },
    });
    active = true;

    // Slice 3: screen share rides the session lifecycle. Started here so frames
    // only ever flow into an open session, and torn down in stop() so capture
    // can never outlive it. A failure to start is non-fatal by design — voice is
    // the product, screen share is an enhancement, and a denied capture must not
    // take the conversation down with it.
    await startScreenShare();

    return true;
  }

  // Lazily imported so a default (opt-out) install never fetches this module.
  async function startScreenShare() {
    if (!screenShare || !screenShare.enabled || screenCapture) return;
    try {
      const { createScreenShare } = await import('./screen-share.js');
      // No onState hook: the mic indicator reflects the VOICE session, and
      // letting a capture state write to it would misreport listening state.
      screenCapture = createScreenShare();
      const ok = await screenCapture.start({ fps: screenShare.fps, quality: screenShare.quality });
      if (!ok) screenCapture = null;
    } catch (err) {
      console.warn('[s2s] screen share unavailable:', err);
      screenCapture = null;
    }
  }

  function stopScreenShare() {
    if (!screenCapture) return;
    try { screenCapture.stop(); } catch { /* already torn down */ }
    screenCapture = null;
  }

  async function stop() {
    // BUG-147: startRequested is cleared and the ack timer cancelled even on the
    // early return, so a stop() during startup can neither leave the flag set nor
    // let the "did not respond" caption fire after the operator already gave up.
    startRequested = false;
    clearOpenAckTimer();
    if (!active && !stream && !audioCtx) return;
    active = false;
    // Before anything else: a capture loop that outlives the session both keeps
    // the OS screen-share indicator lit and pushes frames into a closed socket.
    stopScreenShare();
    sendMessage({ type: 'live-close' });
    if (onAudioOutMsg) { offBroadcast('live-audio-out', onAudioOutMsg); onAudioOutMsg = null; }
    if (onInterruptedMsg) { offBroadcast('live-interrupted', onInterruptedMsg); onInterruptedMsg = null; }
    if (onLiveStateMsg) { offBroadcast('live-state', onLiveStateMsg); onLiveStateMsg = null; }
    if (onTranscriptMsg) { offBroadcast('live-transcript', onTranscriptMsg); onTranscriptMsg = null; }
    if (onWatchdogClearMsg) { offBroadcast('live-watchdog-clear', onWatchdogClearMsg); onWatchdogClearMsg = null; }
    if (captureNode) { try { captureNode.disconnect(); } catch { /* ok */ } captureNode = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (audioCtx) { try { await audioCtx.close(); } catch { /* ok */ } audioCtx = null; }
    if (player) { player.close(); player = null; }
    bargeBackstop.reset();
    setVoiceState('idle');
  }

  return {
    start,
    stop,
    stopScreenShare,
    isScreenSharing: () => Boolean(screenCapture && screenCapture.isActive()),
    setCaptureSuspended,
    suspendForMedia,
    isActive: () => active,
    isCaptureSuspended: () => captureSuspended,
    isSpeaking: () => (player ? player.isSpeaking() : false),
  };
}
