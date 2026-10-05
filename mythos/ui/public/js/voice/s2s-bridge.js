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
import { createOwnVoiceClock } from './own-voice-clock.js';
import { attachWaitChime } from './wait-chime.js';
import { openMicWithFallback } from './mic-device.js';
import { createBargeInPolicy } from './barge-in-policy.js';
import { createBargeInBackstop, rmsFromPcm16 } from './barge-in-backstop.js';
import { createLiveNoiseGate } from './live-noise-gate.js';
import { createEchoVerdictTracker } from './echo-verdict.js';
import { createGateRecorder, isGateRelease } from './gate-recorder.js'; // BUG-406: numbers-only mic-gate recorder, off unless configured
import { arrayBufferToBase64 } from './pcm-base64.js';
import { createUnheardMeter } from './unheard-meter.js'; // BUG-447: where a barge-in cut the answer, so "go ahead" can resume it
import { createSpeechEndReason } from './speech-end-reason.js'; // B1 (BUG-469): why speech stopped, for the gate's release line

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
export function createS2SBridge({ onState, onCaption, screenShare, sendMessageOverride, gateRecorder: recordGate } = {}) {
  const send = sendMessageOverride || sendMessage; const gateRecorder = recordGate ? createGateRecorder({ rms: rmsFromPcm16 }) : null;
  const unheard = createUnheardMeter(); const speechEnd = createSpeechEndReason();
  let active = false;
  let stream = null;
  let audioCtx = null;
  let captureNode = null;
  let player = null; let waitChime = null; // BUG-456: attached in start(), detached in stop()
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
  // ~300ms of ordinary speech and Gemini's own VAD — the better detector — makes
  // the interruption call. onFlush is the higher tier that actually stops MYTHOS
  // talking. Before the split, one threshold decided both, it never fired in the
  // 2026-08-14 session, and the operator's speech died in the 1.2s preroll ring:
  // two turns reached the server as live-turn-no-user-transcript.
  // BUG-272 V1/V2: the playback-aware policy is a VETO in front of both backstop
  // tiers, not a replacement for them. The backstop still does the level
  // counting it always did; what changed is that clearing a threshold is no
  // longer sufficient to release the gate or to flush playback.
  //
  // Why a veto rather than a rewrite: the backstop's tiers, its hysteresis and
  // its localStorage overrides are all pinned by existing tests and were
  // deliberately tuned. The defect was never that the levels were counted
  // wrongly — it was that a level ALONE decided, in a room where bleed
  // (0.09-0.38) sits above both tiers (0.05 and 0.056) and inside the operator's
  // own speech band. So the level stays as the trigger and the policy supplies
  // the judgement.
  //
  // Both callbacks are vetoed, including onFlush. Bleed clears the flush tier
  // too, and flushing on bleed is what CUT MYTHOS's own audio mid-word — the
  // clipping the operator heard. Vetoing the release while still flushing would
  // keep exactly the audible half of the bug.
  const bargePolicy = createBargeInPolicy(policyTuning());
  let policyAllowsRelease = false;

  const bargeBackstop = createBargeInBackstop({
    onFlush: (level) => {
      notePeakRms(level);   // recorded either way — a vetoed near-miss is evidence
      if (!policyAllowsRelease) { noteBargeVetoed('flush', level); return; }
      stopAssistantSpeech('barge-in');
    },
    onRelease: (level) => {
      notePeakRms(level);
      if (!policyAllowsRelease) { noteBargeVetoed('eager', level); return; }
      // BUG-274 step 5 (2026-08-19): THE TIER THAT REOPENED THE MIC WAS NOT THE TIER
      // THAT STOPPED THE SPEECH. This line used to call releaseOwnVoiceGate() alone,
      // and that function never touches the player — every "flush" inside it refers to
      // the preroll ring. So an eager-tier release opened the microphone and MYTHOS
      // carried on talking, which is the operator's complaint verbatim, and it was
      // logged as 'barge-in-confirmed' and counted as a LANDED barge-in by
      // scripts/verify-voice-session.js. A success line for the exact failure.
      //
      // How narrow this half of the fix is, stated rather than overclaimed: both
      // backstop tiers count 3 frames, so above BACKSTOP_RMS_THRESHOLD they fire on the
      // SAME frame and the flush tier stopped playback anyway. The eager tier is alone
      // only for levels inside the band between the two thresholds. The reason LOUD
      // barge-ins also failed to stop the speech is stopAssistantSpeech()'s second
      // half — see its comment, and bug-274-local-flush-does-not-stop-the-turn.test.js.
      stopAssistantSpeech('barge-in-confirmed');
    },
    ...bargeTuning(),
  });

  // BUG-271: noise gate on BOTH live-audio send points (the capture path below
  // and the gate-release replay in releaseOwnVoiceGate). Below-floor frames are
  // ZEROED to silence, never dropped — the stream stays continuous, so Gemini's
  // VAD timeline and the wire format are untouched. Without it, every 100ms of
  // room noise reached Gemini's START_SENSITIVITY_HIGH VAD and its STT
  // fabricated words the operator never said; and the replay handed MYTHOS's
  // own speaker bleed straight back to it. The floor is the localStorage-
  // tunable knob (MYTHOS_LIVE_NOISE_GATE_FLOOR, same lsNumber idiom as
  // MYTHOS_BARGE_*); rmsFromPcm16 is reused from barge-in-backstop.js so both
  // measurements share one scale. Deliberately NOT changed here: Gemini's
  // START_SENSITIVITY_HIGH stays — the rationale is documented at
  // live-session.js's automaticActivityDetection block.
  const noiseGate = createLiveNoiseGate({
    floorRms: lsNumber('MYTHOS_LIVE_NOISE_GATE_FLOOR') ?? undefined,
    rms: rmsFromPcm16,
  });

  // Bound listener refs, so stop() can precisely unsubscribe the exact
  // functions start() registered (offBroadcast matches by reference).
  let onAudioOutMsg = null;
  let onInterruptedMsg = null;
  let onLiveStateMsg = null;
  let onTranscriptMsg = null;
  let onEchoCheckMsg = null;
  let onWatchdogClearMsg = null;
  // BUG-274 step 5: 'live-turn-complete' has been broadcast by server/index.js since it
  // was written and, until this change, was read by NOTHING in the HUD — the exact
  // end-of-turn boundary the audio-out suppression needs, already on the wire, unused.
  let onTurnCompleteMsg = null;

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
  // BUG-274 W1 Q5: what Chromium actually GRANTED on this stream, as opposed to
  // what mic-device.js asked for. The comment above says "getUserMedia's
  // echoCancellation is already on (mic-device.js) and did not stop it on
  // speakers" — that was inferred from the request, because nothing on this path
  // had ever read the grant back. If AEC3 is silently off here, the own-voice
  // gate is compensating for a dropped constraint and the entire class of fix is
  // aimed at the wrong layer. null means "not measured yet", which is a
  // different statement from "measured as false" and must stay distinguishable.
  let micGranted = null;
  let captureSuspended = false;
  let suspendTimer = null;
  // Wave 0 (2026-08-13): fire-and-forget transition log so the server side has
  // a record of every suspend/clear, not just the fact a turn later came back
  // blind. Best-effort — sendMessage throwing (socket not open yet) must never
  // block the capture gate itself.
  // BUG-274 step 5 Q3 (who actually reads this?) — pcm-player.js's jitter cushion
  // computes cushionSec/underruns and, until this was wired, nothing anywhere called
  // stats(). A number with no reader is not instrumentation.
  //
  // It rides logSuspendTransition()'s own literal rather than one call site's `extra`
  // because it is SESSION state, not transition state: the cushion is cumulative, and
  // putting it on a single reason (it was on the barge-in suppression line first) meant
  // it only reached the log on turns the operator interrupted — the one shape of
  // session where the transport is least likely to be what went wrong.
  //
  // Everything here is undefined on a healthy session: JSON.stringify drops those, and
  // the server's allowlist copy drops them again, so a clean link adds no fields and
  // their ABSENCE means no stutter rather than a dropped field. Written out as literal
  // keys either way — bug-273-suspend-fields-reach-the-log.test.js reads this source to
  // find them, and a key hidden behind a conditional spread would be invisible to it.
  function cushionStats() {
    const st = player ? player.stats() : null;
    if (!st) return { cushionMs: undefined, underruns: undefined, missedTurnEnds: undefined };
    const stuttered = st.underruns > 0;
    return {
      // ALWAYS sent, unlike the two below, and the asymmetry is deliberate. This field
      // is what makes "the client is reporting and the cushion is at its base" tell
      // apart from "the client is not reporting" — and those need opposite responses
      // (nothing, versus reload the HUD or fix the allowlist).
      //
      // The success case forced this. When the cushion ABSORBS a late chunk there is no
      // underrun, so a conditional cushionMs would vanish from the log exactly when the
      // mechanism worked, while the server side still logged audioStarveEvents > 0 for
      // the same turn. verify-voice-session.js reads that pair, and with a conditional
      // field its "the two halves disagree" criterion would have failed hardest on a
      // perfectly working session. One number per transition is a cheap price for an
      // instrument that is not backwards.
      cushionMs: Math.round(st.cushionSec * 1000),
      underruns: stuttered ? st.underruns : undefined,
      // Reported on its own condition, NOT alongside underruns: a lost turn boundary
      // is a different fault from a slow link and can happen on a session with zero
      // underruns. Folding it into `stuttered` would hide it exactly when it is the
      // only thing wrong.
      missedTurnEnds: st.missedTurnEnds > 0 ? st.missedTurnEnds : undefined,
    };
  }

  function logSuspendTransition(extra) {
    try {
      // Spelled out as three literal keys below rather than spread in from
      // cushionStats(). A spread would put the names in a helper's return literal
      // where bug-273-suspend-fields-reach-the-log.test.js cannot see them, and the
      // fields would be computed, sent, and dropped at the server allowlist with the
      // guard printing PASS — the fourth occurrence of the bug that guard exists for,
      // committed inside the comment warning about it. Verified by watching it go RED.
      const cushion = cushionStats();
      // Q3 (who actually reads this?) — the transition message is the only channel
      // from here to the server log, and the server copies a hand-maintained
      // allowlist off it, so a field added here and nowhere else is computed,
      // sent, and dropped. bug-273-suspend-fields-reach-the-log.test.js fails
      // when that happens. Sent on every transition rather than once at open
      // because a log that loses its first lines still answers the question.
      send({
        type: 'voice-capture-suspend',
        suspended: captureSuspended,
        at: Date.now(),
        micEchoCancellation: micGranted ? micGranted.echoCancellation : null,
        micNoiseSuppression: micGranted ? micGranted.noiseSuppression : null,
        cushionMs: cushion.cushionMs,
        underruns: cushion.underruns,
        missedTurnEnds: cushion.missedTurnEnds,
        ...extra,
      });
      if (gateRecorder && isGateRelease(extra, captureSuspended)) send({ type: 'voice-gate-recording', at: Date.now(), reason: extra && extra.reason, samples: gateRecorder.drain() });
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
      // BUG-273 A4 — WHICH of the two expiries this is going to be, decided here
      // where the caller's intent is still visible.
      //
      // MEASURED, 2026-08-18: 8 media-start arms, 8 ceiling expiries, 0 explicit
      // clears. The fix plan filed that as "check whether media suspends are armed
      // and never cleared" — and they are never cleared, but that is the DESIGN, not
      // a leak. suspendForMedia asks for MEDIA_START_SUSPEND_MS (8s) precisely
      // because only the opening burst of a track is suppressed; there is no event
      // to clear it and there is not meant to be one. So the expiry fired on 100% of
      // the designed path while being logged as 'suspend-ceiling-fail-open', a name
      // that reads as an exceptional safety net catching a stuck state.
      //
      // Two very different things were sharing one label, which is the same defect
      // BUG-272 fixed one level up when the own-voice ceiling and this one both
      // emitted a bare 'ceiling-fail-open':
      //   * a caller-chosen hold that ran to completion — routine, expected, and
      //     the only thing that has ever been observed;
      //   * MAX_SUSPEND_MS being reached, which means a 'speaking' state never
      //     cleared (a SpeechSynthesisUtterance whose onend never fired) and Live
      //     would have gone permanently deaf without the net. That is a real fault
      //     and deserves a name nothing else uses.
      // Deciding it at ARM time rather than in the timer keeps the two facts
      // together: whether this was a deliberate window is a property of the call,
      // and reconstructing it from the elapsed time later would be a guess.
      const isDeliberateWindow = ceiling < MAX_SUSPEND_MS;
      logSuspendTransition({ holdMs: ceiling, reason: reason || 'suspend' });
      suspendTimer = setTimeout(() => {
        suspendTimer = null;
        captureSuspended = false;   // fail open: a deaf assistant is the worse failure
        setState(lastVoiceState);
        // BUG-272: renamed from the bare 'ceiling-fail-open'. The own-voice hold
        // ceiling emitted that same string from an unrelated timer, so a log
        // showing N of them could not be attributed to either — which is exactly
        // what happened to the 16 counted in the 2026-08-17 session. Two
        // ceilings, two names.
        //
        // BUG-273 A4: and now three, because this timer serves two purposes. See
        // isDeliberateWindow at the arm site. 'suspend-window-elapsed' is the
        // routine end of a caller-chosen hold; 'suspend-ceiling-fail-open' is kept
        // for MAX_SUSPEND_MS, where it means what its name says.
        logSuspendTransition({
          reason: isDeliberateWindow ? 'suspend-window-elapsed' : 'suspend-ceiling-fail-open',
          heldMs: ceiling,
        });
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
  // BUG-455 (2026-09-24): arriving is not playing — Live streams faster than real time, so 20 of 50 holds reopened the mic mid-reply. The window now runs on the PLAYBACK clock: own-voice-clock.js.
  const OWN_VOICE_IDLE_CEILING_MS = 8000;
  const ownVoiceClock = createOwnVoiceClock();
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
  // BUG-272: the policy's own overrides, same absolute-precedence rule as
  // bargeTuning() below. MYTHOS_BARGE_PROTECTED_MS=0 disables the protection
  // window entirely, which is the escape hatch if the window ever feels like
  // MYTHOS ignoring an interruption — alongside MYTHOS_LIVE_HALF_DUPLEX=off,
  // which still disables the whole gate. An operator mid-session must always
  // have a way back to the previous behaviour without a code change.
  function policyTuning() {
    const t = {};
    const protectedMs = lsNumber('MYTHOS_BARGE_PROTECTED_MS');
    const pendingHoldMs = lsNumber('MYTHOS_BARGE_PENDING_HOLD_MS');
    const bleedMargin = lsNumber('MYTHOS_BARGE_BLEED_MARGIN');
    const maxBleedFloor = lsNumber('MYTHOS_BARGE_MAX_BLEED_FLOOR');
    // BUG-273 A1: the learned floor ships dormant, so the escape hatch here is
    // the way BACK ON without a code change — the mirror of every other override
    // in this function, which exist to turn things off.
    const learnedFloor = lsNumber('MYTHOS_BARGE_LEARNED_FLOOR');
    if (protectedMs !== null) t.protectedMs = protectedMs;
    if (pendingHoldMs !== null) t.pendingHoldMs = pendingHoldMs;
    if (bleedMargin !== null) t.bleedMargin = bleedMargin;
    if (maxBleedFloor !== null) t.maxBleedFloor = maxBleedFloor;
    if (learnedFloor !== null) t.learnedFloorEnabled = learnedFloor !== 0;
    return t;
  }

  // A vetoed barge-in is a real event and the single most useful number for
  // judging whether the policy is too strict or too lax. Counted, and reported
  // on the release/hold log line — never silent, because "the gate quietly
  // stopped releasing" is indistinguishable from "the mic died" without it.
  let bargeVetoed = 0;
  let lastVetoReason = null;

  // BUG-428: only the ceiling reads the verdict; observe() keeps null so a
  // wrong echo ratio cannot veto barge-in. 8s idle / 30s max hold are unchanged.
  // VOICE_ECHO_VERDICT_TO_CLIENT=false sends nothing and preserves today's path.
  // Reset on each hold; ignore verdicts outside it. No hold id exists on this
  // protocol, so in-flight cross-hold attribution still needs live-room proof.
  const echoVerdict = createEchoVerdictTracker();

  // BUG-274: the policy's OWN reason for the veto, and the level it refused.
  //
  // WHY THIS WAS THE EXPENSIVE OMISSION. Until now the log recorded which BACKSTOP tier
  // was blocked ('flush' / 'eager') and threw the level away on the next line — `void
  // level` — so five tickets of tuning (BUG-224, 271, 272, 273 A1, 273 A2) read "13
  // barge-ins vetoed, tier flush" and could not tell apart the four causes the policy
  // actually distinguishes: protected-window, below-bleed-floor, pending-decayed,
  // already-confirmed. Those demand opposite fixes — one is a window that is too long,
  // one a floor that is too high, one a sustain test that is too strict, and the last
  // was a handoff bug with nothing to tune at all. Recording the count while discarding
  // the discriminator is how the wrong one got changed twice.
  let lastVetoPolicyReason = null;
  let lastVetoLevel = null;
  let lastPolicyDecision = null;

  // BUG-274 (second pass, from the 2026-08-19 live session): a level-triggered
  // barge-in that was refused only because the policy had not finished counting
  // yet. The two conditions — loud enough, and the policy agrees — must be
  // allowed to be met at DIFFERENT instants, because they are structurally
  // incapable of being met at the same one:
  //
  //   the backstop fires after 3 consecutive frames = 300ms
  //   the policy confirms after PENDING_HOLD_MS         = 350ms
  //
  // The backstop is therefore ALWAYS ~50ms early, is vetoed with
  // 'pending-sustaining', and spends its shot: the eager tier is latched by
  // releasedThisRun and the flush tier zeroes its counter, so the next
  // opportunity is frame 6 — by which time an ordinary two-word interruption has
  // already ended. Measured live: three holds, veto levels 0.0814/0.0883/0.1077
  // against a 0.05 floor, vetoed 1/4/7 times, and not one release. The operator's
  // voice at twice the floor, refused seven times in a single 9.4-second hold.
  let bargeAttemptedThisHold = false;
  function noteBargeVetoed(tier, level) {
    bargeVetoed += 1;
    lastVetoReason = tier;
    lastVetoPolicyReason = lastPolicyDecision ? lastPolicyDecision.reason : null;
    lastVetoLevel = typeof level === 'number' ? Math.round(level * 10000) / 10000 : null;
    // Only a candidacy that was actually building counts as an attempt. A veto
    // inside the protected window, or below the floor, is the policy working.
    if (lastVetoPolicyReason === 'pending-sustaining' || lastVetoPolicyReason === 'pending-opened') {
      bargeAttemptedThisHold = true;
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

  function armOwnVoiceCeiling(delayMs) {
    if (ownVoiceTimer) clearTimeout(ownVoiceTimer); ownVoiceClock.armed(player);
    ownVoiceTimer = setTimeout(() => {
      ownVoiceTimer = null; const wait = ownVoiceClock.check(player, OWN_VOICE_IDLE_CEILING_MS); if (wait) { armOwnVoiceCeiling(wait); return; } // BUG-455: still playing on a moving clock — wait, then look again
      // BUG-272 V2: at the ceiling we are not out of information, so this is no
      // longer a blind fail-open. The policy weighs what we know (echo verdict,
      // whether a transcript exists, peak level) and the reason string records
      // WHICH branch decided — 16 of these fired in the 2026-08-17 session and
      // the log could not say why any of them did.
      //
      // The reason is also now distinct from the media/TTS suspend ceiling's,
      // which emitted the identical string 'ceiling-fail-open' from a completely
      // different timer. That collision is why BUG-272's count of 16 cannot be
      // split by cause: two unrelated ceilings, one label.
      const verdict = bargePolicy.ceilingDecision({
        echoRatio: echoVerdict.echoRatio,
        hasTranscript: echoVerdict.transcriptSeen,
        peakRms: ownVoicePeakRms,
      });
      if (!verdict.release) {
        // Echo-like: the buffered audio is MYTHOS's own voice, so replaying it
        // to Gemini is what caused the self-interruption loop in the first
        // place. Drop the ring and re-arm rather than feeding it back.
        preroll = [];
        armOwnVoiceCeiling();
        logSuspendTransition({ reason: 'own-voice-ceiling-' + verdict.reason, ownVoiceGate: true });
        return;
      }
      releaseOwnVoiceGate('own-voice-' + verdict.reason);
    }, delayMs || OWN_VOICE_IDLE_CEILING_MS);
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
  // pushed out for half a minute: a broken player, or a reply over 30 s (BUG-455).
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
    echoVerdict.reset();
    preroll = [];
    prerollDropped = 0;
    ownVoicePeakRms = 0; ownVoiceClock.reset();
    ownVoiceHeldAt = Date.now();
    // BUG-272: MYTHOS has started speaking, so the protection window opens here.
    // This is the transition the policy needs and the only place that knows it.
    bargePolicy.assistantSpeakingStarted();
    policyAllowsRelease = false;
    bargeVetoed = 0;
    // BUG-274: clear the veto detail with the counter. The 2026-08-19 log contains
    // holds reading `"bargeVetoed":0,"bargeVetoTier":"flush"` — a tier left over from
    // an earlier hold, attached to a hold that vetoed nothing. Zero vetoes with a
    // named tier is a small lie, and it is the kind that gets read as a pattern.
    lastVetoReason = null;
    lastVetoPolicyReason = null;
    lastVetoLevel = null;
    // BUG-274: a refused attempt belongs to the utterance it happened in. Leaking
    // it into the next hold would let a stale candidacy release the gate on the
    // first authorised frame of a sentence the operator never spoke over.
    bargeAttemptedThisHold = false;
    armOwnVoiceCeiling();
    armOwnVoiceMaxHold();
    logSuspendTransition({ reason: 'own-voice-hold', ownVoiceGate: true });
  }

  function releaseOwnVoiceGate(reason) {
    if (ownVoiceTimer) { clearTimeout(ownVoiceTimer); ownVoiceTimer = null; }
    if (ownVoiceMaxTimer) { clearTimeout(ownVoiceMaxTimer); ownVoiceMaxTimer = null; }
    if (!ownVoiceGate) return;
    ownVoiceGate = false;
    // BUG-272: the hold is over, so the policy returns to IDLE and stops making
    // release decisions until MYTHOS speaks again. Its learned bleed floor
    // deliberately survives — that is a property of the room, not of this turn.
    bargePolicy.assistantSpeakingEnded();
    policyAllowsRelease = false;
    // Replay what the operator said while we were talking over them. Oldest
    // first, so the model receives it in the order it was spoken. BUG-271:
    // every replayed frame goes through the noise gate too — the ring holds
    // whatever the mic heard while MYTHOS was speaking, which is mostly
    // MYTHOS; the gate turns the bleed into silence at the wire level while
    // the operator's real interruption (loud enough to have opened the gate)
    // passes raw. The stored frames are never mutated — process() hands back
    // a fresh zeroed copy when it zeroes.
    const held = preroll;
    preroll = [];
    // BUG-273 A2 — MEASUREMENT ONLY, no behaviour change in this pass.
    //
    // 43% of the 2026-08-18 session's turns were interrupted while bargeVetoed hit
    // 49, i.e. the policy was vetoing constantly and the interruptions came from
    // Gemini's own server-side VAD reacting to audio that had reached it. The plan
    // for A2 assumed that audio was bleed the noise gate had passed during a hold.
    // It cannot be: the capture handler RETURNS before sendMessage while ownVoiceGate
    // is set, so during a hold nothing is on the wire at all.
    //
    // This loop is the only other candidate, and the comment above it asserts the
    // very thing that needs checking — "the gate turns the bleed into silence at the
    // wire level". Against this room's numbers that assertion is doubtful:
    // LIVE_NOISE_GATE_FLOOR_RMS is 0.02 and measured bleed was 0.123, roughly 6x
    // above it, and the gate's hysteresis keeps it open for 800ms of quiet once any
    // frame clears the floor. If that is right, releasing a full ring flushes up to
    // 133 frames — 13.3 SECONDS of audio the comment itself calls "mostly MYTHOS" —
    // onto the wire unzeroed, in one burst, and Gemini's VAD fires on it. It would
    // also explain the coupling to A1: the longer the hold, the bigger the burst.
    //
    // Q5 — do not fix this on the strength of that reasoning. The ONE number that
    // separates "the gate silenced the bleed" from "the gate passed all of it" is how
    // many flushed frames it actually zeroed, and nothing has ever reported it. So
    // this pass counts and reports, and changes nothing.
    // MEASURED 2026-08-19 AND THE HYPOTHESIS ABOVE IS REFUTED: 771 frames replayed,
    // 695 ZEROED; worst case 25 frames, not 133. NOTHING HERE IS PENDING - the remedy
    // it names must NOT be built. BUG-388 later showed the 0.123 "bleed" was the
    // OPERATOR'S OWN voice. The symptom is carried by BUG-274/BUG-388, not here.
    let flushedZeroed = 0;
    for (const frame of held) {
      try {
        const gated = noiseGate.process(frame);
        if (gated && gated.zero) flushedZeroed += 1;
        send({ type: 'live-audio', data: arrayBufferToBase64(gated.buffer) });
      } catch (_) { /* socket closed */ }
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
      // BUG-273 A2: of the frames replayed onto the wire at THIS release, how many the
      // noise gate actually silenced. flushedRaw is the number that matters —
      // flushedRaw frames of assistant-dominated audio arriving in one burst is the
      // only remaining candidate for the 43% of turns Gemini cut short, because
      // nothing is sent during the hold itself. Reported as both halves rather than a
      // ratio so a zero denominator stays readable.
      flushedFrames: held.length,
      flushedZeroed: flushedZeroed,
      flushedRaw: held.length - flushedZeroed,
      // BUG-272: how many times a level-triggered barge-in was VETOED by the
      // policy during this hold, and which tier last tried. This is the number
      // that says whether the new policy is calibrated: high vetoes with a
      // happy operator means it is correctly rejecting bleed; high vetoes with
      // an operator complaining they cannot interrupt means the protection
      // window or the learned floor is too aggressive. A silent veto would be
      // indistinguishable from a dead microphone.
      bargeVetoed: bargeVetoed,
      bargeVetoTier: lastVetoReason,
      playbackWaits: ownVoiceClock.waits, playbackStalled: ownVoiceClock.stalled, // BUG-455: times the watchdog waited on queued playback, and whether it met a frozen audio clock
      // BUG-274: the paragraph above turned out to be exactly the wrong dichotomy.
      // The operator complained they could not interrupt, and it was NEITHER the
      // protection window NOR the learned floor — it was 'already-confirmed', a veto
      // revoking a release the policy had granted one frame earlier. These two fields
      // are what make that legible: the policy's own reason, and the level it refused.
      // null means the hold had no veto, which stays distinguishable from a veto whose
      // reason went unrecorded.
      bargeVetoPolicyReason: lastVetoPolicyReason,
      bargeVetoLevel: lastVetoLevel,
      bleedFloor: Math.round(bargePolicy.bleedFloor() * 10000) / 10000,
      // BUG-273 A1 — Q2. bleedFloor alone used to carry both facts, because the
      // floor in force WAS the learned one. With learning dormant it reads 0.05
      // every session and says nothing about the room, so the two are reported
      // separately: bleedPeak is what this room bleeds, learnedFloor is the floor
      // that WOULD be in force if the mechanism were re-enabled. Those two numbers
      // against peakRms below are the whole case for or against re-enabling it, and
      // dropping them would leave the next session unable to make it either way.
      bleedPeak: Math.round(bargePolicy.bleedPeak() * 10000) / 10000,
      learnedFloor: Math.round(bargePolicy.learnedFloor() * 10000) / 10000,
      // BUG-271: how many frames the noise gate silenced (both send points)
      // so far THIS session — cumulative within the session, cleared by
      // noiseGate.reset() in stop(). The server logs this with the rest of
      // the transition line — the evidence chain belongs together.
      framesZeroed: noiseGate.framesZeroed(),
      // One line per hold, not per frame — see ownVoicePeakRms's declaration.
      peakRms: Math.round(ownVoicePeakRms * 10000) / 10000,
    });
    ownVoicePeakRms = 0;
    ownVoiceHeldAt = 0;
    prerollDropped = 0;
  }

  // BUG-274 step 5 (2026-08-19) — ONE DOOR FOR "STOP TALKING", AND WHY A FLUSH IS
  // NOT ENOUGH ON ITS OWN.
  //
  // Three call sites had to stop the speech and release the gate, and each had its own
  // copy of the sequence. One of them (the eager tier) was missing the flush, so a
  // barge-in it authorised reopened the microphone while MYTHOS kept speaking. Three
  // copies, one divergence, and no test could see it because both halves were only
  // ever exercised separately. This is the door; nothing else may release the gate for
  // a barge-in reason.
  //
  // THE SECOND HALF, which is what the operator actually hears. player.flush() only
  // discards the chunks ALREADY QUEUED in this browser. The local barge-in deliberately
  // sends nothing to the server (see barge-in-backstop.js's header), so Gemini keeps
  // generating the rest of its turn, the server keeps forwarding it as 'live-audio-out',
  // and onAudioOutMsg used to enqueue every chunk unconditionally. The queue was
  // emptied and instantly refilled: a few hundred milliseconds of silence, then MYTHOS
  // carrying on — which is precisely the report "interruption does not work".
  //
  // WHY IT HOLDS WHATEVER GEMINI DOES. A local barge-in sends nothing upstream, so the
  // server keeps forwarding the rest of the model turn as 'live-audio-out' — that is
  // true by construction, and it does not depend on what Gemini's VAD did. The
  // suppression is what makes a LOCAL decision to stop actually stop the speech.
  //
  // CORRECTED 2026-08-19 (BUG-274 step 5). This paragraph used to claim the stronger
  // thing — that Gemini's VAD "never fired once in the whole session" — and cited
  //   grep -c '"msg":"voice.live.interrupted"' mythos-server.log  ->  0
  // That 0 was not evidence. `voice.live.interrupted` is a BUS event name (live-session.js,
  // bus.emit) that no logger has ever written, so the grep returns 0 against every log
  // this project has ever produced, whatever actually happened. The same session's log
  // carried `interrupted` in live.turn-parts.scFields on 129 turns. Gemini's VAD fired
  // repeatedly; the reading that it never did was an artefact of a detector that matched
  // nothing. Second occurrence of that class — see verify-voice-session.js's own note.
  //
  // The mechanism below is unaffected: it was never the VAD's silence that justified it.
  // As of the same date live-session.js writes a real `live.interrupted` log line, so the
  // question "did the server cut this turn" now has an answer that can be read.
  //
  // So stopping the speech has to be local and has to outlast the flush: for the rest
  // of this model turn, arriving audio is DROPPED instead of played.
  function stopAssistantSpeech(reason) {
    if (player) unheard.cut(speechEnd.during(reason, () => player.flush()));
    armAudioOutSuppression();
    releaseOwnVoiceGate(reason);
  }
  // Positions only, never words; the server resolves them against its own transcript.
  function reportUnheard() { const report = unheard.endTurn(); if (report) send({ type: 'voice-unheard', ...report }); }

  // Fail-open window for the suppression above: if no audio has arrived for this long,
  // the turn is over whether or not a 'live-turn-complete' ever reached us. Q5 — this
  // is not a threshold and must never be tuned like one. The stuck state of this
  // mechanism is a permanently MUTE assistant, which is worse than the bug it fixes, so
  // it lifts on its own. Every arriving chunk pushes it out (the same idle-window shape
  // as OWN_VOICE_IDLE_CEILING_MS, and for the same reason: an absolute cap would cut a
  // long reply short instead of detecting a stuck one).
  const SUPPRESS_IDLE_MS = 2000;
  let suppressAudioOut = false;
  let suppressedChunks = 0;
  let suppressStartedAt = 0;
  let suppressIdleTimer = null;

  function armAudioOutSuppression() {
    suppressAudioOut = true;
    suppressedChunks = 0;
    suppressStartedAt = Date.now();
    refreshSuppressIdleTimer();
  }

  function refreshSuppressIdleTimer() {
    if (suppressIdleTimer) clearTimeout(suppressIdleTimer);
    suppressIdleTimer = setTimeout(() => {
      suppressIdleTimer = null;
      endAudioOutSuppression('idle');
    }, SUPPRESS_IDLE_MS);
    if (typeof suppressIdleTimer.unref === 'function') suppressIdleTimer.unref();
  }

  // Q2 — this mechanism eats speech by design, so it reports what it ate. A silent
  // suppression and a broken player are indistinguishable from the room, and that
  // ambiguity is what let a barge-in be logged as landed while MYTHOS talked over it.
  // 'how' is folded into the reason string rather than sent as its own field because
  // the server's allowlist is deliberately numeric/boolean only.
  function endAudioOutSuppression(how) {
    if (suppressIdleTimer) { clearTimeout(suppressIdleTimer); suppressIdleTimer = null; }
    if (!suppressAudioOut) return;
    suppressAudioOut = false;
    if (how === 'idle') unheard.resumed(); // the turn carries on, and from here the room hears it
    // The cushion diagnostics used to be added here and were moved to
    // logSuspendTransition() itself on 2026-08-20: on this line they only ever
    // reached the log for turns the operator interrupted, which is the least likely
    // shape of session for the transport to be the fault. They now ride every
    // transition. Nothing is lost from this line — it still carries them.
    logSuspendTransition({
      reason: 'barge-in-suppression-' + how,
      suppressedChunks: suppressedChunks,
      suppressedMs: suppressStartedAt ? Date.now() - suppressStartedAt : 0,
    });
    suppressedChunks = 0;
    suppressStartedAt = 0;
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
      // BUG-274 step 5: the operator interrupted, so the rest of THIS turn is not
      // played. Dropped rather than queued-and-flushed: flushing per chunk would race
      // the player's TAIL_GUARD_SEC and leak fragments. The idle timer is refreshed
      // here so the suppression lasts exactly as long as the server keeps streaming.
      if (suppressAudioOut) {
        suppressedChunks += 1;
        unheard.dropped(msg.data);
        refreshSuppressIdleTimer();
        return;
      }
      player.enqueue(msg.data);
      unheard.played(msg.data);
      // The gate's ceiling is an IDLE window, so every chunk that arrives pushes
      // it out. Without this it was an absolute cap on reply length and tripped
      // mid-sentence on the longest answers — see OWN_VOICE_IDLE_CEILING_MS.
      refreshOwnVoiceCeiling();
    };
    // The server won this race: stop the audio and clear the local run, so a
    // half-accumulated loud streak cannot tip over on the first frame of the NEXT
    // reply. A local flush that already happened makes this a no-op. BUG-274 step 5:
    // Gemini itself cut the turn, so no further chunks belong to it and the
    // suppression must lift. B1: the release this flush fires is logged
    // 'server-interrupted' (speech-end-reason.js); it used to read as a natural end.
    onInterruptedMsg = () => {
      bargeBackstop.reset();
      if (player) unheard.cut(speechEnd.during('server-interrupted', () => player.flush()));
      if (player) player.endTurn();
      endAudioOutSuppression('server-interrupted');
    };
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
    onEchoCheckMsg = (msg) => { if (ownVoiceGate) echoVerdict.accept(msg); };
    // Wave 2 (2026-08-13, resume-on-activity watchdog): the server tells us a
    // Live turn came back with no operator transcript. We're the only side
    // that knows whether captureSuspended is actually set right now — a
    // signal on a client that was never suspended (Gemini dropped it
    // server-side instead) is a harmless no-op.
    onWatchdogClearMsg = () => { if (captureSuspended) setCaptureSuspended(false, undefined, 'watchdog-clear'); };
    // The model turn is over, so there is nothing left to suppress. Also the guard
    // against suppressing the NEXT reply: turn-complete always precedes the next
    // turn's first chunk, so the idle window never has to be the thing that ends it.
    // BUG-274 step 5b (2026-08-20): the same boundary now also closes the player's
    // underrun attribution. pcm-player.js grows its jitter cushion only while a turn
    // is open, because a dry timeline mid-reply is the network and a dry timeline
    // between replies is the operator talking — and from inside the player those are
    // identical. Only this frame can separate them. Kept on ONE line: a source-shape
    // test in bug-274-local-flush-does-not-stop-the-turn.test.js reads this handler.
    onTurnCompleteMsg = () => { endAudioOutSuppression('turn-complete'); if (player) player.endTurn(); reportUnheard(); };
    onBroadcast('live-audio-out', onAudioOutMsg);
    onBroadcast('live-turn-complete', onTurnCompleteMsg);
    onBroadcast('live-interrupted', onInterruptedMsg);
    onBroadcast('live-state', onLiveStateMsg);
    onBroadcast('live-transcript', onTranscriptMsg);
    onBroadcast('live-echo-check', onEchoCheckMsg);
    onBroadcast('live-watchdog-clear', onWatchdogClearMsg); if (!waitChime) waitChime = attachWaitChime({ onBroadcast, offBroadcast, getPlayer: () => player, report: (waitedMs) => send({ type: 'voice-wait-chime', waitedMs }) }); // BUG-456: one soft chime in a silent tool wait

    sendMessage({ type: 'live-open' });
    armOpenAckTimer();   // BUG-147: silence from here on becomes a visible refusal

    try {
      // BUG-272 W1: shares the wake word's stale-device rescue. A saved device
      // id that has gone stale is a property of the machine, not of one capture
      // path, so all of them clear it and retry on the OS default.
      const openedMic = await openMicWithFallback();
      stream = openedMic.stream;
      micGranted = openedMic.actual;
      // onCaption is optional (see the destructure at the top) — guarded exactly
      // like every other call site in this file.
      if (openedMic.fallbackFired && onCaption) {
        onCaption('Saved microphone was unavailable — using the system default.', 'error');
      }
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      await audioCtx.audioWorklet.addModule('/js/voice/pcm-capture-worklet.js');
      captureNode = new AudioWorkletNode(audioCtx, 'pcm-capture', {
        processorOptions: { targetRate: TARGET_RATE, frameMs: FRAME_MS },
      });
      captureNode.port.onmessage = (e) => {
        if (!active) return; if (gateRecorder) gateRecorder.sample(e.data, { captureSuspended, ownVoiceGate, speaking: player ? player.isSpeaking() : false, playhead: player ? player.playhead() : null, micContextTime: audioCtx ? audioCtx.currentTime : null }); if (captureSuspended) return;   // see setCaptureSuspended. BUG-406: sampled BEFORE this return — the frames the gate holds are the ones being studied
        // Measured on the way out, on the same frames the server hears, so the
        // backstop and Gemini's VAD are looking at identical audio. Deliberately
        // AFTER the captureSuspended gate: while we are knowingly making noise
        // ourselves (own TTS, media playback) those frames are not the operator
        // and must not count toward an interruption.
        // BUG-272: the policy sees the frame FIRST, because bargeBackstop.observe()
        // invokes onFlush/onRelease synchronously and those callbacks read
        // policyAllowsRelease. Reversing these two lines would have every release
        // decided by the PREVIOUS frame's verdict — an off-by-one-frame bug that
        // no test on the pure module could ever catch, so the ordering is pinned
        // by a source-shape assertion alongside the existing gate-order one.
        // BUG-274: the whole decision is kept, not just .release — noteBargeVetoed()
        // reads its .reason so a veto says WHY, and the reason is the policy's own
        // (protected-window / below-bleed-floor / pending-decayed / already-confirmed),
        // which is the discriminator the log has been missing for five tickets.
        lastPolicyDecision = bargePolicy.observe({
          rms: rmsFromPcm16(e.data),
          echoRatio: null,
        });
        policyAllowsRelease = lastPolicyDecision.release;
        // Q1 — WHAT ELSE MATCHES THIS? Without this line the attempt flag below
        // survives the death of the candidacy that set it, so an attempt at second 1
        // could be cashed in by a confirmation growing out of a DIFFERENT sound at
        // second 9 of the same hold — a TV, a second person, a door. The level
        // condition was never widened, but the window in which a stale "loud enough"
        // could meet a fresh "policy agrees" would have been the whole utterance.
        // Bounding it by a timeout would have been a guessed constant; this is exact:
        // the candidacy either survived continuously to confirmation or it did not.
        if (lastPolicyDecision.reason === 'pending-decayed'
          || lastPolicyDecision.reason === 'below-bleed-floor'
          || lastPolicyDecision.reason === 'echo-transcript') {
          bargeAttemptedThisHold = false;
        }
        bargeBackstop.observe(e.data, player ? player.isSpeaking() : false);
        // BUG-274 (second pass): deliver an authorisation the backstop asked for
        // BEFORE the policy was ready. Runs after observe() so a backstop tier
        // firing on this very frame takes the normal path first (ownVoiceGate is
        // then already false and this is a no-op).
        //
        // WHY THIS IS NOT A BYPASS. Both original conditions still hold, they are
        // simply no longer required to hold on the SAME frame: a level run had to
        // clear a backstop tier for bargeAttemptedThisHold to be set, and the
        // policy had to pass its protected window, its floor and its full 350ms
        // sustain for release to be true. What is removed is the coincidence
        // requirement — that the backstop's 300ms counter happen to fire again on
        // the exact frame the policy's 350ms timer completes. It structurally
        // cannot, so the operator was refused seven times in one hold at twice the
        // floor. Bleed still has to survive the sustain test to reach here, which
        // is the defence that was designed for it and is untouched.
        //
        // ADVERSARIAL PASS on this fix, answered rather than assumed:
        //
        // Q1 — WHAT ELSE MATCHES THIS? Answered above, and it changed the fix: the
        //   attempt is now cleared when its candidacy dies, so a stale "loud enough"
        //   cannot be cashed in by an unrelated later sound in the same utterance.
        // Q2 — DOES THIS HIDE EVIDENCE? No, and it adds some. The release reason is a
        //   DISTINCT 'barge-in-deferred', so the log says which of the three routes
        //   let the operator in. bargeVetoed is per-hold and written on release, so
        //   the refused attempts that preceded it are still on the same line.
        //   verify-voice-session.js now counts landed barge-ins — until 2026-08-19 it
        //   counted only vetoes, ceilings and self-interruptions, i.e. three ways of
        //   measuring failure and none of success.
        // Q3 — WHO READS THIS? The reason string reaches verify-voice-session.js,
        //   which prefix-matches 'own-voice-ceiling' for the ceiling criterion (so
        //   this value is not mistaken for one) and keys self-interruption off
        //   live.turn-parts, not off this field. Both were checked, not assumed.
        // Q4 — WHAT IS STANDING NEXT TO IT? setCaptureSuspended(). While Spotify or a
        //   video is playing, the handler above returns BEFORE the policy or the
        //   backstop see a frame, so interruption with music playing remains
        //   impossible and this fix does not touch it. That is W1's checklist item
        //   (d), still open, named here so it is not mistaken for covered.
        // Q5 — IS THE CONSTANT CORRECT? No constant was added, and the live session
        //   settled the one that mattered: the veto reason was NEVER
        //   'below-bleed-floor' across 14 vetoes, so INITIAL_BLEED_FLOOR 0.05 is right
        //   for this room and was deliberately not touched. What this fix depends on
        //   is the RELATION 350ms (PENDING_HOLD_MS) > 300ms (3 backstop frames). If
        //   PENDING_HOLD_MS is ever lowered to 300 or below, this branch becomes
        //   unreachable — dead, not broken. Say so in the commit if you do that.
        //
        //   THAT HAPPENED, 2026-08-20: Stage 3 lowered PENDING_HOLD_MS to 200, so the
        //   policy now reaches CONFIRMED at frame 2 and the backstop's first delivery
        //   at frame 3 already finds policyAllowsRelease true and takes the NORMAL
        //   path. This branch is therefore unreachable at the shipped constant —
        //   DEAD, NOT BROKEN, exactly as predicted above. It is kept rather than
        //   deleted because it is the safety net if the sustain is ever raised back
        //   over 300ms, and deleting it would silently re-open the bug it fixed.
        //   test/bug-274-barge-in-authorisation-is-deliverable.test.js keeps proving
        //   it works by pinning those scenarios at pendingHoldMs 350 explicitly, and
        //   has a case asserting it is unreachable at the shipped value — so "dead"
        //   stays a measured claim rather than an assumption.
        // Q6 — WHAT CLASS IS THIS? The third instance in one day of "two independent
        //   counters required to coincide". The assertion, per the repo's own rule, is
        //   test/bug-274-barge-in-authorisation-is-deliverable.test.js, which drives
        //   both real modules together instead of either one alone.
        // Q7 — WHAT DID THE TICKET SAY? W1's checklist, honestly: (a) speaking stops
        //   MYTHOS — PARTIAL, 1 landed of roughly 5 attempts before this fix;
        //   (b) no ghost pickup — NOT addressed here; (c) first word not lost — not
        //   measured; (d) works with music — NO, see Q4; (e) works on the packaged
        //   installer — untested. Fixing (a) is not closing W1.
        // Q8 — PINNED, DELIBERATELY UNCHANGED: PENDING_HOLD_MS 350, PROTECTED_MS 500,
        //   INITIAL_BLEED_FLOOR 0.05, the dormant learned floor, both backstop tiers,
        //   and pcm-player's flush() staying a hard stop with no fade. Each is a
        //   choice, not an oversight.
        if (policyAllowsRelease && bargeAttemptedThisHold && ownVoiceGate) {
          stopAssistantSpeech('barge-in-deferred');
        }
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
        // BUG-271: the noise gate's decision goes on the wire, not the raw
        // frame — below-floor room noise is zeroed to silence (never dropped),
        // so Gemini's VAD no longer fires on it and its STT stops fabricating
        // words. e.data itself is untouched: the preroll branch above may
        // still hold a reference to it on a later hold.
        sendMessage({ type: 'live-audio', data: arrayBufferToBase64(noiseGate.process(e.data).buffer) });
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
      onSpeakStart: () => { holdOwnVoiceGate(); speechEnd.speechStarted(); setVoiceState('speaking'); },
      onSpeakEnd: () => { releaseOwnVoiceGate(speechEnd.ended()); setVoiceState('listening'); },
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
    if (onEchoCheckMsg) { offBroadcast('live-echo-check', onEchoCheckMsg); onEchoCheckMsg = null; }
    if (onWatchdogClearMsg) { offBroadcast('live-watchdog-clear', onWatchdogClearMsg); onWatchdogClearMsg = null; }
    if (onTurnCompleteMsg) { offBroadcast('live-turn-complete', onTurnCompleteMsg); onTurnCompleteMsg = null; } if (waitChime) { waitChime.detach(); waitChime = null; }
    // A suppression must not survive the session that armed it — nor may a cut.
    endAudioOutSuppression('session-stopped');
    unheard.endTurn();
    if (captureNode) { try { captureNode.disconnect(); } catch { /* ok */ } captureNode = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (audioCtx) { try { await audioCtx.close(); } catch { /* ok */ } audioCtx = null; }
    if (player) { speechEnd.during('session-stopped', () => player.close()); player = null; } // B1: a close mid-reply is not a natural end
    bargeBackstop.reset();
    // BUG-271: a stale hysteresis tail (or zeroed count) must not carry into
    // the next session — same once-per-session reasoning as the backstop reset.
    noiseGate.reset();
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
