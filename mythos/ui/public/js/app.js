// app.js — HUD boot entry: hud -> overlays -> widgets -> confirm -> voice.
// Voice initializes on first pointerdown (Chrome's user-gesture policy for
// mic/AudioContext); everything else mounts immediately.

// FIRST import on purpose — net-guard.js installs its window.fetch wrapper at
// import time, and ES modules evaluate every import before the importing
// module's body, so anything below that fetches (at module scope or later) is
// covered. It turns a 401 on any /api/… call into a visible condition instead
// of the null every call site already swallows.
import './net-guard.js';
import { subscribe, visionQuery, registerReplyHandler, sendMessage, utterance, reconnectAfterUnlock } from './ws.js';
import { onRefresh } from './stats-bus.js';
import { mountHud } from './neural-map/hud-canvas.js';
import { mountCoreOrb } from './neural-map/core-orb.js';
import { createOverlayManager } from './overlay/overlay-manager.js';
import { mountWidgets } from './widgets/widget-host.js';
import { mountConfirmModal } from './confirm/confirm-modal.js';
import { createVoiceLoop } from './voice/voice-loop.js';
import { voiceConfiguration } from './voice/voice-config.js';
import { createOperatorPlayback } from './voice/operator-playback.js';
import { mountDesktopTask } from './desktop-task.js';
import { decideVoiceTransport } from './voice/voice-transport.js';
import { createToggleGuard } from './voice/toggle-guard.js';
import { createCameraLoop } from './vision/camera.js';
import { decideGestureMic } from './vision/gesture-mic.js';
import { canGestureAccept } from './vision/gesture-confirm.js';
import { createComposeBar } from './compose-bar.js';
import { mountInitScreen } from './init-screen.js';
import { mountPinLockScreen } from './pin/pin-lock-screen.js';
import { mountAuthGate } from './auth/auth-gate.js';
import { mountStatusBanner } from './status-banner.js';
import { mountUpdateBanner } from './update-banner.js';
import { mountVersionBadge } from './version-badge.js';
import { mountSetupScreen } from './setup/setup-screen.js';
import { mountComponentBanner } from './setup/component-banner.js';
import { isGateClosed } from './pin/pin-gate.js';
import { isEntityAlive } from './entity-status.js';
import { safeUrl } from './url.js';

const ctx = { subscribe, onRefresh };

// Cinematic boot overlay — mounted before anything else so the HUD build-up
// (orb/widgets/panels initializing underneath) is hidden behind it. Skips
// itself once the entity reports alive (or after a hard timeout if the
// server never answers) — see init-screen.js for the reveal timing.
mountInitScreen({ subscribe });

// MYTHOS_AUTH_TOKEN gate — mounted BEFORE the PIN screen because the PIN
// screen's own GET /api/pin/status is itself behind the token gate: with a
// token configured and no cookie, that call 401s and the PIN screen resolves
// 'indeterminate' (fails open) without ever knowing whether a PIN exists.
// Non-blocking and completely inert on a default install — it asks GET /health
// first and does nothing at all when authRequired is false. See auth/auth-gate.js.
mountAuthGate(document.getElementById('auth-root'));

// Says out loud when the socket or an /api call has failed. Both conditions
// were silent before, which is why an unauthenticated dashboard read as
// "unresponsive" rather than "unauthenticated".
mountStatusBanner(document.getElementById('status-banner-root'));

// Says out loud when a new version has downloaded, with a button that installs
// it. No-ops in a browser tab (no window.mythos, therefore no updater).
mountUpdateBanner(document.getElementById('status-banner-root'));
mountVersionBadge(document.getElementById('version-badge'));

// First-run setup — the answer to "this machine is a half-broken twin of the
// other one". Asks GET /api/setup/status and paints ONLY when a REQUIRED gap
// exists, so a fully wired install never sees it and an install with merely
// optional gaps (no adb, no piper voice) is not nagged on every boot. Mounted
// after the token gate because that status call is itself behind it: a 401 here
// means "not authenticated yet", never "your install is incomplete".
// On a machine where NOTHING is configured yet (no stored key, no PIN) this
// opens the first-run wizard instead of the gap list, and it now RETRIES the
// status probe: in the packaged .exe the window loads before the fork()ed server
// child is listening, so the single boot-time probe used to resolve
// 'indeterminate' and the screen was never shown again — a fresh install was
// never asked for a key at all. setupScreen.open() is the manual route back in
// (the key button in the compose bar).
const setupScreen = mountSetupScreen(document.getElementById('setup-root'));

// Says out loud when a component the operator ASKED FOR during install is not
// actually on disk (installer parity, 2026-08-11). The installer recorded
// silero/wakeword/adb as wanted, downloaded none of them, and said nothing — so
// the wake word was simply dead and the only symptom was that "hey jarvis" did
// nothing. Paints nothing on a fully-installed machine, and nothing at all on an
// indeterminate probe. See setup/component-banner.js.
mountComponentBanner(document.getElementById('status-banner-root'), {
  onOpenSetup: () => { try { setupScreen.open(); } catch (_) { /* screen not mountable here */ } },
});

// §7.3 local PIN lock — the enforcement point the backend never had. Mounted
// here (before the HUD builds) but NON-BLOCKING: it asks GET /api/pin/status
// and only paints an overlay if a PIN is actually configured. With no PIN
// configured — the default — nothing changes at all. See pin/pin-lock-screen.js.
const pinLockScreen = mountPinLockScreen(document.getElementById('pin-root'), { onUnlock: () => {
  reconnectAfterUnlock();
  refreshVoiceConfiguration().then(() => { if (!isGateClosed(pinLockScreen.lockState())) ensureWakeWord(); });
} });

// D5: Track brain availability from entity-state broadcasts.
// When entity reports offline/degraded, voice loop skips transcription to save API calls.
let _brainOnline = true;
subscribe(['entity-state'], (msg) => {
  // FIX I: the server sends the status nested at msg.payload.status (see
  // server/index.js's 'entity-state' broadcast) — msg.state/msg.status were
  // always undefined, so _brainOnline was always true (failed open).
  // REMEDIATION P1-6: isEntityAlive() (entity-status.js) classifies the
  // server's real booting/alive/stopped vocabulary — the previous inline
  // comparison here checked for 'offline'/'error', values the server never
  // actually sends, so this still always evaluated true.
  const state = (msg.payload && msg.payload.status) || '';
  _brainOnline = isEntityAlive(state);
});

// PIN-protected settings refresh after unlock. Every construction path waits
// for current facts so a fast click cannot freeze pre-unlock VAD defaults.
let _vadOverrides = null, _wakewordCfg = null, _wakewordCfgError = null;
let _s2sEnabled = false, _operatorEnabled = false, operatorPlayback = null, disposeDesktopTask = null;
let _screenShareCfg = null;
let voiceConfigReady, _wakewordCfgReady, voiceConfigLoaded = false;
voiceConfiguration.subscribe(({ vad, wakeword, s2s }) => {
  voiceConfigLoaded = true;
  _vadOverrides = vad.value;
  _wakewordCfg = wakeword.value; _wakewordCfgError = wakeword.error;
  _s2sEnabled = Boolean(s2s.value && s2s.value.enabled);
  _operatorEnabled = Boolean(s2s.value && s2s.value.operatorEnabled);
  _screenShareCfg = s2s.value?.screenShare?.enabled ? s2s.value.screenShare : null;
  if (_operatorEnabled && !disposeDesktopTask) disposeDesktopTask = mountDesktopTask();
  if (!_operatorEnabled && disposeDesktopTask) { disposeDesktopTask.close(); disposeDesktopTask = null; }
});
function refreshVoiceConfiguration() {
  // Refresh all authenticated facts after PIN success, not just the caption.
  voiceConfigLoaded = false;
  voiceConfigReady = _wakewordCfgReady = voiceConfiguration.refresh();
  return voiceConfigReady;
}
refreshVoiceConfiguration();

// overlays
const overlays = createOverlayManager(document.getElementById('overlay-root'), {
  // Keep the chat bar's transcript toggle honest about the panel's real state:
  // the × button, the backdrop, Escape and a close_panel tool call all close it
  // without going through onTranscript below. `compose` is created further down
  // this file, and a panel can open before that (a routed WS frame), so this
  // guards rather than assuming.
  onChange: (panelId, isOpen) => {
    if (panelId !== 'conversation') return;
    if (compose && typeof compose.setTranscriptOpen === 'function') compose.setTranscriptOpen(isOpen);
  },
});

// core orb mounts first — hud-canvas's ctx needs orb.flashAction for its
// per-action-type color relay (pure reorder, no visual side effect: DOM
// z-order is CSS-driven, not mount-call-order-driven).
const orb = mountCoreOrb(document.getElementById('core-orb'), {
  ...ctx,
  onClick: () => toggleVoice(),
});

// neural map — onPan keeps the DOM core-orb glued to the panned constellation
// (hud.css centers it with translate(-50%,-50%); the pan offset is additive).
// mountHud's return shape changed from a bare cleanup fn to { cleanup,
// setVoiceState, setActivity } (Orb 2.0 ambient bloom needs the same
// voice-state/activity feed the orb gets) — captured here, was discarded before.
const orbEl = document.getElementById('core-orb');
const hud = mountHud(document.getElementById('hud-canvas'), {
  ...ctx,
  onNodeClick: (panelId) => overlays.openPanel(panelId),
  onAction: (category, ok) => orb.flashAction(category, ok),
  onPan: (pan) => {
    orbEl.style.transform = `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`;
  },
});

// floating widgets — mountWidgets returns { cleanup, spawnWebWidget }
const widgetApi = mountWidgets(document.getElementById('widget-root'), ctx);

// global confirm modal (mounted once, never routed)
mountConfirmModal(document.getElementById('confirm-root'), {
  onResolved: () => orb.notifyConfirmResolved && orb.notifyConfirmResolved(),
});

// voice — created lazily on first user gesture, then toggled via compose-bar
// voice button or orb click. The compose bar is the primary input surface
// (text + voice); the old standalone mic indicator is hidden.
const compose = createComposeBar({
  onVoiceToggle: () => toggleVoice(),
  onVoiceState: (s) => { orb.setVoiceState(s); hud.setVoiceState(s); },
  onCaption: (text, kind) => {},
  onActivity: (level) => { orb.setActivity(level); hud.setActivity(level); },
  onSubmitText: sendTextMessage,
  onCamToggle: () => ensureCamera().toggle(),
  onMicSettings: async () => {
    await voiceConfigReady;
    if (isGateClosed(pinLockScreen.lockState())) return;
    // Ensure the voice loop exists so its setMicDevice/getMicDevice are live,
    // then open the panel with them threaded through the overlay payload. The
    // panel works even if voice is idle — it owns its own diagnostic AudioContext.
    const v = ensureVoice();
    overlays.openPanel('mic-settings', { voice: { setMicDevice: (id) => v.setMicDevice(id), getMicDevice: () => v.getMicDevice() } });
  },
  // Which voice the entity SPEAKS in — audition each, keep one. Owns no state
  // here: the panel reads /api/tts/voices and writes /api/tts/voice, and the
  // server rebuilds its chain so the next reply already uses the new voice.
  onVoiceSettings: () => {
    overlays.openPanel('voice-settings');
  },
  // Provider keys + local PIN, on demand. Re-probes /api/setup/status first so
  // the wizard reflects what the server sees now, not what it saw at boot.
  onSetup: () => setupScreen.open(),
  // F7: the full-session transcript. The panel is not new — it has been in the
  // registry as 'conversation' all along — but nothing on the chat bar opened
  // it, so the operator's only view of the session was whatever few turns the
  // compose caption happened to be showing.
  // It is a toggle (aria-pressed, "Toggle the full conversation transcript"),
  // so a second click has to close it — before this it re-opened, which
  // overlay-manager treats as a focus() and looks like a dead button.
  onTranscript: () => {
    if (overlays.isOpen('conversation')) overlays.close('conversation');
    else overlays.openPanel('conversation');
  },
});

// mic indicator API still used by some caption calls below — keep a shim.
const mic = {
  setState: (s) => compose.setVoiceState(s),
  setCaption: (text, kind) => compose.setCaption(text, kind),
  setActivity: (level) => compose.setActivity(level),
};

let voice = null;
let wakeword = null;
// Last-known voice-loop state — createVoiceLoop's returned API has no state
// getter, so onVoiceState (called on every transition, including 'speaking'
// during TTS playback) is the only way to know it here. Used by wake-word's
// onWake below to avoid re-triggering while MYTHOS is talking.
let _voiceState = 'idle';

// BUG-273 A3 — WHEN MYTHOS LAST HAD SPEECH AUDIO IN THE ROOM.
//
// Every guard in the wake-word suppression chain below asks about the present
// instant, and a wake-word score is evidence about the previous ~2 seconds (see
// wakeword.js's receptiveFieldMs). So a greeting that stopped playing shortly
// before the score crossed the threshold defeats all of them. On 2026-08-18 it did:
// gemini-tts 503 -> edge-tts failover at 11:33:17.978 -> 0.9797 at 11:33:19.591, in
// a room that had been at 5e-6 for twenty seconds.
//
// A timestamp rather than a boolean, for exactly that reason: "was MYTHOS speaking
// at any point inside the detector's window" is the question that can actually be
// answered correctly, and a flag can only answer it for the instant it is read.
//
// Q1 — WHAT ELSE MATCHES THIS? Deliberately only MYTHOS's own SPEECH. Media the
// operator asked for — Spotify, a YouTube page — must not deafen the wake word,
// which is the whole reason suspendForMedia below is a separate, narrower mechanism
// with its own opening-burst-only scope. The two feeds here are the server-TTS
// chunk stream and voice-state transitions into 'speaking'; no action/media event
// touches this timestamp.
let _lastAssistantAudioAt = 0;
function noteAssistantAudio() { _lastAssistantAudioAt = Date.now(); }

function onVoiceState(s) {
  _voiceState = s;
  // Covers both engines that route through here: voice-loop chunk playback (the
  // batch/proactive path) and the Live bridge, which is constructed with
  // onState: onVoiceState and calls setVoiceState('speaking') from onSpeakStart.
  if (s === 'speaking') noteAssistantAudio();
  compose.setVoiceState(s);
  orb.setVoiceState(s);
  hud.setVoiceState(s);
  // Stage 2 (BUG-060/BUG-061): the own-TTS mic-suspend that used to live here
  // is gone. It existed because proactive speech (boot greeting, reminders,
  // build announcements) played edge-tts audio out of the speakers while a
  // Live session's mic capture was still running, and Gemini transcribed it
  // back as the operator — server/index.js's proactiveSpeak() now checks for
  // an open Live session and routes that text through the session's own
  // sendText() instead of ever emitting a speech-chunk, so there is no more
  // own-TTS audio for this bridge to hear while Live is active. See
  // suspendForMedia below for the still-needed, unrelated media-echo guard.
}

// WAVE 5 — the same gate, for media WE started. An effector that begins playback
// puts audio through the same speakers, and Gemini transcribes it as the operator
// (a German YouTube narration arrived as two "User:" turns on 2026-07-31). Only
// the opening burst is suppressed — see suspendForMedia's comment for why the
// whole track is deliberately not.
const PLAYBACK_TOOLS = { spotify_play: true, open_web: true, spotify_next: true, spotify_previous: true };
subscribe(['action'], (msg) => {
  const p = (msg && msg.payload) || {};
  if (!p.ok || !PLAYBACK_TOOLS[p.tool]) return;
  if (s2s && typeof s2s.suspendForMedia === 'function') s2s.suspendForMedia();
});

// TTS speaking pulse — each speech-chunk WS msg (server-side TTS audio en route)
// kicks the orb's speaking-state exhale. The mic is muted during playback
// (voice-loop BUG-027) so onActivity() never fires while speaking; this is the
// synthetic amplitude signal that makes the orb pulse in rhythm with MYTHOS's
// voice. Spikes an envelope that decays in core-orb's frame loop.
subscribe(['speech-chunk'], () => {
  // BUG-273 A3: a chunk on the wire means server-side TTS audio is arriving to be
  // played out of the speakers. This is the earliest honest signal there is — it
  // precedes playback, so the suppression window opens before the first sample is
  // audible rather than after, and it does not depend on which of the three TTS
  // engines won the chain or on a voice-state transition landing in time.
  noteAssistantAudio();
  if (typeof orb.pulseSpeaking === 'function') orb.pulseSpeaking();
  if (typeof hud.pulseSpeaking === 'function') hud.pulseSpeaking();
});

function ensureVoice() {
  if (!voice) {
    voice = createVoiceLoop({
      onState: onVoiceState,
      openPanel: (id) => overlays.openPanel(id),
      closePanel: () => overlays.closeAll(),
      onCaption: (text, kind) => compose.setCaption(text, kind),
      onVisionQuery: (text) => describeScene(text),
      onActivity: (level) => { compose.setActivity(level); orb.setActivity(level); hud.setActivity(level); },
      brainOnline: () => _brainOnline,
      operatorEnabled: () => _operatorEnabled,
      onOperatorTurn: (reqId) => { if (operatorPlayback) operatorPlayback.begin(reqId); },
      onOperatorRequestId: (reqId) => operatorPlayback?.setRequestId(reqId),
      onOperatorStop: () => { if (operatorPlayback) operatorPlayback.stop(); },
      vad: _vadOverrides || undefined,
    });
  }
  if (_operatorEnabled && !operatorPlayback) {
    const loop = voice;
    operatorPlayback = createOperatorPlayback({
      onOwnership: (owned) => { loop.setOperatorPlayback(owned); if (owned) noteAssistantAudio(); },
      onDrain: () => loop.finishOperatorPlayback(),
      onError: (message) => loop.finishOperatorPlayback(message),
      onCaption: (text, kind) => { loop.setOperatorTranscript(text); compose.setCaption(text, kind); },
    });
  }
  return voice;
}

// Duplex is lazy; operator mode uses only the separately owned playback sink.
let s2s = null;
let _s2sImport = null;

function ensureS2S() {
  if (s2s) return Promise.resolve(s2s);
  if (!_s2sImport) {
    _s2sImport = import('./voice/s2s-bridge.js')
      .then(({ createS2SBridge }) => {
        s2s = createS2SBridge({
          onState: onVoiceState,
          onCaption: (text, kind) => compose.setCaption(text, kind),
          // Slice 3 screen share. Stays undefined (= off) unless /api/config/s2s
          // reported it enabled, so a failed or missing fetch cannot start
          // streaming the operator's desktop.
          screenShare: _screenShareCfg,
        });
        return s2s;
      })
      .catch((err) => {
        // Honest degradation, and permanent for this page: fall back to the
        // batch loop rather than pretending S2S is available.
        _s2sEnabled = false;
        _s2sImport = null;
        mic.setCaption('Live voice failed to load — using standard voice: ' + ((err && err.message) || err), 'error');
        return null;
      });
  }
  return _s2sImport;
}

// All voice affordances share the tested, exclusive transport decision.
async function toggleVoiceImpl() {
  await voiceConfigReady;
  // PIN status must positively permit capture before any microphone starts.
  if (isGateClosed(pinLockScreen.lockState())) return;
  const plan = decideVoiceTransport({
    s2sEnabled: _s2sEnabled && !_operatorEnabled,
    s2sActive: Boolean(s2s && s2s.isActive()),
    batchActive: Boolean(voice && voice.isActive()),
  });

  // Release the transport that must not hold the mic, FIRST and always —
  // including on a stop, so no stray capture is left running.
  if (plan.stopOther === 'batch' && voice) voice.stop();
  if (plan.stopOther === 's2s' && s2s) await s2s.stop();

  if (plan.transport === 'batch') {
    // Await capture acquisition so the toggle guard covers the whole start.
    if (plan.action === 'start') await ensureVoice().start();
    else if (voice) voice.stop();
    return;
  }

  const bridge = await ensureS2S();
  if (!bridge) { await ensureVoice().start(); return; } // import failed — batch fallback
  if (plan.action === 'start') await bridge.start();
  else await bridge.stop();
}

// Drop concurrent toggles through the tested guard; never queue surprise toggles.
const toggleVoice = createToggleGuard(toggleVoiceImpl);

// Orb click still toggles voice (legacy affordance)
// (onClick already wired in mountCoreOrb above)

// ---- Global push-to-talk hotkey (Electron only) ----------------------------
// electron/main.js claims an OS-wide accelerator (Alt+Space by default) and
// forwards it here as 'talk', so the operator can start talking without finding
// the window. Routed through toggleVoice() rather than at the mic directly, so
// it inherits transport selection AND the PIN-gate refusal — a keypress must not
// be able to open the mic on a locked HUD.
//
// window.mythos exists only under Electron; in a plain browser tab this block is
// a no-op, which is the honest degradation (a web page cannot claim a global
// hotkey at all).
if (typeof window !== 'undefined' && window.mythos && typeof window.mythos.onHotkey === 'function') {
  window.mythos.onHotkey((action) => {
    if (action === 'talk') toggleVoice();
  });
  // BUG-269 defect 1: announce the listener above is registered. The main
  // process latches earlier presses and flushes them now (electron/
  // hotkey-latch.js) — without this, a boot-time press was lost forever.
  if (typeof window.mythos.notifyReady === 'function') window.mythos.notifyReady();
}

// camera + hand-gesture control (Part A/B, P16). Camera is OFF by default,
// same privacy posture as the mic — only starts on an explicit toggle click.
// State renders through the compose-bar's cam button (compose.setCamState);
// the old standalone floating ring is gone.
let camera = null;

// Gesture -> action map. Confirm accept/reject reuse the LIVE modal buttons
// (confirm-modal.js) — same code path as a human click, zero new approval
// surface. Selectors return null harmlessly when no confirm is showing.
// Timestamp of the last mic state change a gesture caused. Owned here rather
// than inside decideGestureMic so that function stays pure — see
// vision/gesture-mic.js for why the refractory window it feeds is load-bearing
// (a hand held in frame re-fires every 2s and would otherwise flip the mic back).
let lastGestureMicToggleAt = 0;

// Open_Palm toggles the mic; Pointing_Up only ever unmutes it. The decision
// lives in decideGestureMic() so it is testable without a DOM; this handler owns
// only the side effects.
function applyGestureMic(gesture) {
  const plan = decideGestureMic({
    gesture,
    batchActive: Boolean(voice && voice.isActive()),
    s2sActive: Boolean(s2s && s2s.isActive()),
    now: Date.now(),
    lastToggleAt: lastGestureMicToggleAt,
  });
  if (plan.action === 'none') return;
  lastGestureMicToggleAt = Date.now();
  if (plan.action === 'stop') {
    // Whichever transport currently holds the mic (see toggleVoice) — the
    // gesture has to be able to mute an S2S session too, not just the batch loop.
    if (voice && voice.isActive()) voice.stop();
    if (s2s && s2s.isActive()) s2s.stop();
    mic.setCaption('🖐 mic muted by gesture', 'info');
    return;
  }
  // Start goes through toggleVoice(), never voice.start()/s2s.start() directly:
  // it owns the PIN gate refusal, the transport choice and the mic-exclusivity
  // invariant. It is async and a gesture handler must not block, so this is
  // deliberately fire-and-forget — but a rejection still has to be visible
  // rather than an unhandled promise.
  mic.setCaption('☝ mic on by gesture', 'info');
  toggleVoice().catch((err) => {
    mic.setCaption(`Could not open the mic: ${err && err.message ? err.message : err}`, 'error');
  });
}

const GESTURE_ACTIONS = {
  // G4: tag the button with the real origin BEFORE the synchronous .click()
  // fires confirm-modal.js's listener, so the audit trail can tell a gesture
  // accept apart from a human click on the same button — see that listener
  // for why the click event itself carries no such distinction on its own.
  // The tier ceiling (vision/gesture-confirm.js) is checked BEFORE the tag and
  // the click, so a refused gesture leaves no data-mythos-surface behind for a
  // later real human click to inherit. A refusal has to be spoken in the caption
  // or a held thumbs-up looks like the camera simply stopped working.
  Thumb_Up:    () => {
    const b = document.querySelector('.confirm-accept');
    if (!b) return;
    if (!canGestureAccept(b.dataset.mythosTier)) {
      mic.setCaption(`👍 ignored — tier ${b.dataset.mythosTier || '?'} needs a real click`, 'error');
      return;
    }
    b.dataset.mythosSurface = 'gesture';
    b.click();
    mic.setCaption('👍 approved by gesture', 'reply');
  },
  Closed_Fist: () => { const b = document.querySelector('.confirm-reject'); if (b) { b.click(); mic.setCaption('✊ denied by gesture', 'reply'); } },
  Open_Palm:   () => applyGestureMic('Open_Palm'),
  Pointing_Up: () => applyGestureMic('Pointing_Up'),
  Victory:     () => describeScene('Describe what you see, briefly.'),
};

// Vision Q&A reply reuses the voice loop's own chunk-queue/barge-in playback
// machinery (beginTurn/onExternalChunk/deliverExternalReply) so a "what do
// you see" answer is spoken exactly like a voice reply, chunk-by-chunk.
async function describeScene(text) {
  await voiceConfigReady;
  if (isGateClosed(pinLockScreen.lockState())) return;
  if (!camera || !camera.isActive()) { mic.setCaption('Camera is off — click the camera icon first.', 'error'); return; }
  const image = camera.captureFrame();
  if (!image) { mic.setCaption('Could not capture a frame.', 'error'); return; }
  mic.setCaption('👁 looking…', 'info');
  const v = ensureVoice();
  const session = v.beginTurn();
  const req = visionQuery({
    image, text,
    onChunk: (m) => v.onExternalChunk(m, session),
    onDone: (msg) => v.deliverExternalReply(msg, session),
  });
  v.setActiveReqId(req.reqId); // Item B: barge-in can cancel this turn's TTS synthesis too
}

// Compose-bar text submit reuses the voice loop's own chunk-queue/barge-in
// playback machinery (same pattern as describeScene() above) so a typed
// message gets a spoken reply exactly like a voice utterance.
async function sendTextMessage(text) {
  await voiceConfigReady;
  const v = ensureVoice();
  const session = v.beginTurn();
  const req = utterance({
    text,
    onChunk: (m) => v.onExternalChunk(m, session),
    onDone: (msg) => v.deliverExternalReply(msg, session),
  });
  v.setActiveReqId(req.reqId); // Item B: barge-in can cancel this turn's TTS synthesis too
}

// Debug-only live preview (not part of the shipped P16 UI — see voice.css's
// #camera-preview comment): raw feed + top-1 gesture guess, so gesture
// detection can be visually confirmed against a real camera while testing.
const camPreviewEl = document.getElementById('camera-preview');
const camPreviewVideoEl = document.getElementById('camera-preview-video');
const camPreviewLabelEl = document.getElementById('camera-preview-label');

function ensureCamera() {
  if (!camera) {
    camera = createCameraLoop({
      onState: (s) => {
        compose.setCamState(s);
        camPreviewEl.className = s === 'watching' ? '' : 'cam-preview-hidden';
      },
      onGesture: (name) => { const fn = GESTURE_ACTIONS[name]; if (fn) fn(); },
      onCaption: (text, kind) => mic.setCaption(text, kind),
      onDebug: ({ handSeen, name, score }) => {
        camPreviewLabelEl.textContent = handSeen
          ? `${name || '...'} ${(score * 100).toFixed(0)}%`
          : 'no hand';
      },
      previewEl: camPreviewVideoEl,
    });
  }
  return camera;
}

// Server-initiated camera look: when the entity asks to see, answer with
// one frame if the camera is actively watching. Privacy-safe: camera off = silent.
subscribe(['camera-frame-request'], (msg) => {
  const m = msg.payload || msg;
  if (!camera || !camera.isActive()) return;
  const image = camera.captureFrame();
  if (image) sendMessage({ type: 'camera-frame', frameReqId: m.frameReqId, image: image });
});

// Server-initiated camera POWER-ON (camera_on, T3 — the operator has already
// confirmed by the time this arrives; see leash/tiers.js). Answers with the state
// the camera loop ACTUALLY reached, never a hopeful one: createCameraLoop().start()
// returns false on permission denial and on a failed gesture-model load, and both
// of those are things the operator needs told rather than papered over.
//
// This is the fix for the 2026-08-10 incident's dead end: with the camera off and
// no way to ask for it, "can you see me?" had no honest path, and the model
// substituted a desktop screenshot and described that instead.
subscribe(['camera-power-request'], async (msg) => {
  const m = msg.payload || msg;
  const ack = (on, state, reason) =>
    sendMessage({ type: 'camera-power-ack', reqId: m.reqId, on, state, reason: reason || '' });
  // The PIN gate governs every sensor affordance, exactly as it does for the mic
  // and every voice path (see toggleVoice) — a locked HUD must not open a camera.
  if (isGateClosed(pinLockScreen.lockState())) {
    ack(false, 'locked', 'the HUD is locked');
    return;
  }
  const cam = ensureCamera();
  if (cam.isActive()) { ack(true, 'watching', ''); return; }
  try {
    // start() resolves only once getUserMedia AND the MediaPipe model are ready
    // and the detect loop is running, so acking on it means a camera_look issued
    // immediately afterwards does not race the warm-up. It also emits its own
    // caption on failure, so the operator sees why in the HUD too.
    const started = await cam.start();
    if (started && cam.isActive()) ack(true, 'watching', '');
    else ack(false, 'off', 'the camera did not start — permission may have been denied, or no camera is available');
  } catch (err) {
    ack(false, 'error', (err && err.message) ? err.message : String(err));
  }
});

// The first permitted pointerdown prepares voice after configuration settles.
// Construction acquires no microphone; explicit start still owns capture.
const armOnce = async () => {
  // Clicking into the PIN lock screen is a pointerdown too — do NOT arm the
  // mic or start always-on wake-word listening behind a locked HUD. Stay
  // subscribed so the first real click after unlocking arms as usual.
  //
  // Uses the tri-state lockState(), not the boolean isLocked(): the PIN
  // status check (GET /api/pin/status) is non-blocking, so there is a real
  // window where lockState() is still 'unknown' (isLocked() reads false in
  // that same window). isGateClosed() treats 'unknown' the same as 'locked'
  // so a pointerdown landing during that round trip can't permanently arm
  // the mic behind a HUD that then paints locked a moment later.
  if (isGateClosed(pinLockScreen.lockState())) return;
  await voiceConfigReady;
  if (isGateClosed(pinLockScreen.lockState())) return;
  document.removeEventListener('pointerdown', armOnce);
  ensureVoice();
  ensureWakeWord();
};
document.addEventListener('pointerdown', armOnce);

// Electron only: arm the wake word with NO click at all. The pointerdown gate
// above exists for Chrome's gesture policy, which the shell opts out of via
// --autoplay-policy=no-user-gesture-required (electron/main.js). In a browser tab
// that gate is still correct and stays exactly as it was; here it made "hands-free
// activation" require a hand — an untouched HUD had no detector running, so
// speaking "hey jarvis" at a freshly opened window could never work.
// window.mythos is the established Electron probe in this file (see the hotkey
// bridge below). Only the wake word is armed early: ensureVoice() stays on the
// gesture so click-to-talk behaviour is untouched.
if (typeof window !== 'undefined' && window.mythos && typeof window.mythos.onHotkey === 'function') {
  // The PIN gate must hold here exactly as it does in armOnce — including its
  // 'unknown'-counts-as-locked stance — so a locked HUD never starts listening.
  // Unlike armOnce this can retry, so poll briefly rather than giving up: the
  // lock state resolves via a non-blocking GET /api/pin/status.
  let tries = 0;
  const armInShell = () => {
    if (wakeword) return;
    if (isGateClosed(pinLockScreen.lockState())) {
      if (++tries < 40) setTimeout(armInShell, 500); // ~20s, then leave it to a click
      return;
    }
    ensureWakeWord();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', armInShell, { once: true });
  else armInShell();
}

// BUG-272 W1: a FAILED wake-word start used to be terminal. On 2026-08-17 the
// mic threw OverconstrainedError 29s into boot (a stale MYTHOS_MIC_DEVICE id)
// and the wake word stayed dead for the whole 20-minute session, because every
// arm path in this file is one-shot: armOnce removes its own listener, armInShell
// polls only the PIN gate and stops once ensureWakeWord() has been CALLED (not
// once it has succeeded), and startWakeWord() nulls `wakeword` on failure
// specifically so "a later gesture" can retry. In the Electron shell, hands-free,
// that later gesture never comes.
//
// Two cheap heals, both bounded:
//   * a backoff re-arm (30s/60s/120s, then stop). Bounded on purpose — an
//     unbounded retry loop against a denied permission is a prompt storm, and a
//     mic that is still broken after ~3.5 minutes needs the operator, not
//     another attempt.
//   * a `devicechange` re-arm, which is the event that actually corresponds to
//     the failure: openMicWithFallback() has by then cleared the stale id, so
//     plugging the mic back in (or Windows re-enumerating it) is exactly when a
//     retry can newly succeed. Mirrors the listener in views/mic-settings.js.
//
// Q8 (pin the disposition): this deliberately does NOT retry when the wake word
// is disabled by config or its models are absent — those are honest, permanent
// "not available here" states, and retrying them would just log noise every
// 30 seconds. `_wakewordCfgError` / model-missing paths return before arming and
// are left exactly as they were.
const WAKEWORD_REARM_DELAYS_MS = [30000, 60000, 120000];
let wakewordRearmIndex = 0;
let wakewordRearmTimer = null;

function wakewordIsLive() {
  return Boolean(wakeword && typeof wakeword.isRunning === 'function' && wakeword.isRunning());
}

function scheduleWakewordRearm(source) {
  if (wakewordRearmTimer) return;                                  // one pending attempt at a time
  if (wakewordRearmIndex >= WAKEWORD_REARM_DELAYS_MS.length) return; // bounded, then the operator's problem
  if (wakewordIsLive()) return;
  const delay = WAKEWORD_REARM_DELAYS_MS[wakewordRearmIndex++];
  wakewordRearmTimer = setTimeout(() => {
    wakewordRearmTimer = null;
    if (wakewordIsLive()) return;
    if (isGateClosed(pinLockScreen.lockState())) { scheduleWakewordRearm(source); return; }
    reportWakeword('rearm', 'retrying the wake word after a failed start', {
      source: source, attempt: wakewordRearmIndex, delayMs: delay,
    });
    ensureWakeWord();
  }, delay);
}

// A device arriving/leaving is the one signal that can turn a stale-device
// failure into a success, so it resets the backoff ladder rather than consuming
// a rung of it.
if (typeof navigator !== 'undefined' && navigator.mediaDevices
    && typeof navigator.mediaDevices.addEventListener === 'function') {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (wakewordIsLive()) return;
    if (isGateClosed(pinLockScreen.lockState())) return;
    wakewordRearmIndex = 0;
    if (wakewordRearmTimer) { clearTimeout(wakewordRearmTimer); wakewordRearmTimer = null; }
    reportWakeword('rearm', 'audio devices changed — retrying the wake word', { source: 'devicechange' });
    ensureWakeWord();
  });
}

// Wake-word ("hey jarvis") — hands-free activation. Lazily imported (like
// voice-loop.js above) only on the same first-gesture arm, and only when the
// server reports it enabled AND the on-device models are actually present
// (scripts/setup-wakeword.js). Deliberately NOT paused on visibilitychange —
// unlike hud-canvas.js's render-pause pattern, always-on standby listening is
// the entire point of this feature, so a backgrounded tab must keep listening.
let _wakewordArming = false;
function ensureWakeWord() {
  // BUG-175: this used to be a bare `if (wakeword)`, which made a detector
  // that had stopped — or was constructed and then failed — permanently
  // unrecoverable: every later gesture saw a non-null object and returned. The
  // operator's instinct ("click it and try again") was silently a no-op. A
  // detector only counts as armed if it is actually RUNNING; otherwise drop
  // the dead object and let this arm a fresh one.
  if (wakeword && typeof wakeword.isRunning === 'function' && !wakeword.isRunning()) {
    try { wakeword.stop(); } catch (_) { /* already down; we only want the slot free */ }
    wakeword = null;
  }
  if (wakeword || _wakewordArming) return;
  _wakewordArming = true;
  // Await the config fetch instead of reading a possibly-unresolved snapshot —
  // the caller (armOnce, or the Electron load-time arm) has already given up its
  // one chance to retry by the time this runs.
  return _wakewordCfgReady.then(() => {
    if (wakeword) return;
    if (_wakewordCfgError) {
      mic.setCaption('Wake word unavailable — could not read its config: ' + _wakewordCfgError, 'error');
      return;
    }
    if (!_wakewordCfg || !_wakewordCfg.enabled) return; // honestly off, not broken
    if (!_wakewordCfg.modelsPresent) {
      mic.setCaption('Wake word enabled but models missing — run scripts/setup-wakeword.js', 'error');
      return;
    }
    return startWakeWord();
  }).finally(() => { _wakewordArming = false; });
}

// BUG-150: the wake word's entire state used to live in a transient HUD caption
// and nowhere else — no status, score or frame count ever reached the server, so
// no log could answer "did it hear me". These two helpers fix that in the two
// places it matters: the server log (permanent, greppable) and a DOM attribute
// (so standby is visible in the UI and inspectable in devtools, which is also
// how the headless measurement reads it).
// Voice Nodes Stage 4 — wake arbitration for the desktop.
//
// The PC is a scanner in the Aether mesh like any phone (the operator's own
// bridge.py), so saying the wake phrase in the kitchen should NOT also open a turn
// here. The HUD reports what it heard and waits briefly for the mesh's verdict.
//
// FAIL OPEN, deliberately and on a short fuse. If no verdict arrives — Aether down,
// AETHER_LOCAL_SCANNER_ID unset, the local scanner not present in the election —
// the desktop behaves exactly as it always has. Only an explicit "suppressed"
// stands it down. A wake word that goes deaf waiting for a network answer is a far
// worse defect than one that occasionally answers alongside a phone.
var WAKE_VERDICT_TIMEOUT_MS = 700; // §6.4 round trip is ~400ms; this is that plus slack
var _pendingWakeVerdict = null;

subscribe(['wake-verdict'], function (msg) {
  var pending = _pendingWakeVerdict;
  if (!pending) return;
  _pendingWakeVerdict = null;
  clearTimeout(pending.timer);
  pending.resolve({
    accepted: !msg || msg.accepted !== false,
    reason: (msg && msg.reason) || 'unknown',
  });
});

// Resolves to {accepted, reason}. Never rejects, never hangs.
function askWakeArbitration() {
  return new Promise(function (resolve) {
    var settled = false;
    function finish(v) { if (!settled) { settled = true; resolve(v); } }
    var timer = setTimeout(function () {
      _pendingWakeVerdict = null;
      finish({ accepted: true, reason: 'no-verdict-timeout' });
    }, WAKE_VERDICT_TIMEOUT_MS);
    _pendingWakeVerdict = { resolve: finish, timer: timer };
    try {
      sendMessage({ type: 'node-wake' });
    } catch (_) {
      // Socket not up: nothing can arbitrate, so proceed as before.
      clearTimeout(timer);
      _pendingWakeVerdict = null;
      finish({ accepted: true, reason: 'socket-down' });
    }
  });
}

function reportWakeword(state, detail, data) {
  try {
    document.documentElement.dataset.wakeword = state;
    // BUG-175: the peak score is the one number that separates "armed and
    // hearing you" from "armed and deaf", and it only ever went to the server
    // log. Mirror it onto the DOM too so the VOICE widget can show it — the
    // whole reason the broken pipeline survived a week is that nobody watching
    // the screen could see it was scoring 1e-5.
    if (data && typeof data.peakScore === 'number') {
      document.documentElement.dataset.wakewordPeak = String(data.peakScore);
    }
  } catch (_) { /* pre-DOM or exotic host; telemetry below still goes out */ }
  try {
    sendMessage(Object.assign({
      type: 'wakeword-status',
      state: state,
      detail: typeof detail === 'string' ? detail.slice(0, 300) : '',
    }, data && typeof data === 'object' ? data : {}));
  } catch (_) { /* socket not up yet — never let telemetry break the detector */ }
}

function startWakeWord() {
  return import('./voice/wakeword.js').then(({ createWakeWord }) => {
    wakeword = createWakeWord({
      threshold: _wakewordCfg.threshold,
      onWake: (score) => {
        // BUG-150: every one of these five guards was a SILENT return. A wake
        // word that was heard and then suppressed looked exactly like one that
        // was never heard at all, which is half of why this went a week without
        // a diagnosis. Behaviour is deliberately unchanged — the PIN gate in
        // particular is a security control, not a nuisance — they only say so now.
        // BUG-273 A3: the sixth guard, and the only one that is not about the
        // present instant. See _lastAssistantAudioAt and wakeword.js's
        // receptiveFieldMs: a score reported now is evidence about the previous ~2
        // seconds, so "MYTHOS is not speaking right now" is not the same claim as
        // "this score cannot be MYTHOS's own voice".
        //
        // Q8 — THE COST, DELIBERATELY ACCEPTED. This extends an existing suppression
        // rather than adding a new one: an operator speaking the wake word WHILE
        // MYTHOS talks was already suppressed by the two guards above ('mythos-is-
        // speaking', 'voice-state-speaking'). What changes is that the suppression now
        // outlasts the speech by one receptive field instead of ending the instant the
        // audio stops. So the operator cannot wake MYTHOS for ~2s after it finishes a
        // sentence, and that is the price of not having it wake itself. It is bounded
        // by the window, it is logged with the exact age below, and it is smaller than
        // the detector's own REFRACTORY_MS gap between two accepted wakes.
        const audioAgeMs = _lastAssistantAudioAt ? Date.now() - _lastAssistantAudioAt : Infinity;
        // Read from the detector, never hardcoded here — a copied constant drifts the
        // first time a model ships a different classifierWindow.
        const windowMs = (wakeword && typeof wakeword.receptiveFieldMs === 'function')
          ? wakeword.receptiveFieldMs() : 0;
        const suppressed =
          isGateClosed(pinLockScreen.lockState()) ? 'pin-gate-closed' :
          (voice && voice.isActive()) ? 'voice-turn-already-active' :
          (s2s && s2s.isActive()) ? 's2s-session-already-active' :
          (s2s && s2s.isSpeaking()) ? 'mythos-is-speaking' :
          (_voiceState === 'speaking') ? 'voice-state-speaking' :
          (audioAgeMs < windowMs) ? 'own-audio-within-detector-window' : null;
        if (suppressed) {
          // Q2 — the age and the window ride along. The 2026-08-18 diagnosis was
          // only possible because the suppressed/unsuppressed distinction and the
          // score were both in the log; a suppression whose margin is invisible is
          // the next session that cannot tell "correctly rejected our own greeting"
          // from "the window is too wide and ate the operator".
          reportWakeword('detected-suppressed', 'wake word detected but not acted on', {
            reason: suppressed, score: typeof score === 'number' ? Number(score.toFixed(4)) : null,
            ownAudioAgeMs: Number.isFinite(audioAgeMs) ? Math.round(audioAgeMs) : null,
            detectorWindowMs: windowMs,
          });
          return;
        }
        // The five guards above are local truths (PIN gate, already-in-a-turn,
        // MYTHOS speaking). This one is the mesh's: with several devices hearing
        // the same phrase, exactly one should answer. Reported as its own
        // suppression reason so 'the kitchen phone took it' is visible in the log
        // rather than looking like a missed detection.
        askWakeArbitration().then(function (verdict) {
          if (!verdict.accepted) {
            reportWakeword('detected-suppressed', 'wake word detected but another device won arbitration', {
              reason: verdict.reason,
              score: typeof score === 'number' ? Number(score.toFixed(4)) : null,
            });
            return;
          }
          reportWakeword('detected', 'wake word detected — opening a turn', {
            score: typeof score === 'number' ? Number(score.toFixed(4)) : null,
            arbitration: verdict.reason,
          });
          if (orb.flashAction) orb.flashAction('wake', true);
          toggleVoice();                           // same path as clicking the orb
        });
      },
      onStatus: (s, msg, data) => {
        // BUG-150: relay EVERY status to the server so the wake word's state is
        // readable in the log instead of living only in a caption that scrolls
        // away. This is what makes "did it hear me" a five-second read.
        reportWakeword(s, msg, data);
        if (s === 'error') mic.setCaption('Wake word offline: ' + msg, 'error');
        // 'silent' is the new honest failure: armed, but no audio ever arrived.
        // It must NOT read as "listening" — that false reassurance is the bug.
        if (s === 'silent') { mic.setCaption('Wake word is not hearing anything — ' + msg, 'error'); scheduleWakewordRearm('silent'); }
        if (s === 'degraded') mic.setCaption('Wake word: ' + msg, 'error');
      },
    });
    // start() resolves false (and has already emitted an 'error' status) when the
    // browser can't support it or the ONNX/mic setup throws. Report the SUCCESS
    // case too: a listening detector was previously indistinguishable from a
    // silently dead one — the orb looks identical either way — so there was no
    // way for the operator to tell "hey jarvis" was armed at all.
    // BUG-150: `ok` now MEANS something — start() only resolves true once it has
    // actually received audio frames. Before, this caption promised standby on the
    // strength of a wired audio graph alone, which is exactly what it said during
    // the week the wake word did nothing. (Comment kept above the .then() rather
    // than inside it: wakeword-arming.test.js asserts setCaption appears within
    // 300 chars of the .then(, and that assertion is worth keeping intact.)
    return wakeword.start().then((ok) => {
      // A successful arm resets the ladder, so a failure LATER in the session
      // gets its own three attempts rather than inheriting a spent budget.
      if (ok) { wakewordRearmIndex = 0; mic.setCaption('Standby — listening for "hey jarvis"', 'info'); }
      else {
        wakeword = null; // failed to arm; let a later gesture try again
        // The status handler has already set a specific caption ('silent' /
        // 'error') and reported it; don't overwrite it with something vaguer.
        reportWakeword('not-listening', 'wake word did not arm');
        // BUG-272 W1: "let a later gesture try again" is not a plan in the
        // hands-free Electron shell, where no later gesture arrives.
        scheduleWakewordRearm('start-failed');
      }
      return ok;
    });
  }).catch((err) => {
    wakeword = null;
    mic.setCaption('Wake word failed to load: ' + (err && err.message || err), 'error');
    scheduleWakewordRearm('load-failed');
  });
}

// Live build-job progress ('job' WS broadcasts from build-runner): auto-open
// the pipeline panel when a build starts, narrate stage transitions in the
// voice caption, announce done/failed honestly.
// Mission (agent team) progress: kanban panel shows the cards moving
// backlog -> building -> review; caption narrates the team.
let missionPanelShown = false;
subscribe(['mission'], (msg) => {
  const m = msg.payload || {};
  if (m.status === 'planning' || m.status === 'building') {
    if (!missionPanelShown) {
      missionPanelShown = true;
      overlays.openPanel('kanban');
    }
    const a = m.agents || {};
    mic.setCaption(
      m.status === 'planning'
        ? '🤖 planning mission — splitting into tasks…'
        : `🤖 ${a.total} agents building — ${a.done}/${a.total} done`,
      'info'
    );
  } else if (m.status === 'synthesizing') {
    mic.setCaption('🤖 all agents done — writing summary…', 'info');
  } else if (m.status === 'done') {
    missionPanelShown = false;
    const n = (m.artifacts || []).length;
    mic.setCaption(`✔ mission complete — ${n} deliverable${n === 1 ? '' : 's'} built. Say "open it" to view.`, 'reply');
  } else if (m.status === 'failed') {
    missionPanelShown = false;
    mic.setCaption('✘ mission failed: ' + (m.error || 'unknown error'), 'error');
  }
});

let buildPanelShown = false;
subscribe(['job'], (msg) => {
  if (missionPanelShown) return; // mission handler above narrates its own jobs
  const j = msg.payload || {};
  if (j.status === 'queued' || j.status === 'running') {
    if (!buildPanelShown) {
      buildPanelShown = true;
      overlays.openPanel('pipeline');
    }
    mic.setCaption('⚙ building — ' + (j.stage || j.status) + '…', 'info');
  } else if (j.status === 'done') {
    buildPanelShown = false;
    mic.setCaption('✔ build finished — say "open it" to view', 'reply');
  } else if (j.status === 'failed') {
    buildPanelShown = false;
    mic.setCaption('✘ build failed: ' + (j.error || 'unknown error'), 'error');
  }
});

// Proactive speech — MYTHOS speaks without being asked (build done, goal done,
// critical anomaly, or an idle thought it wants to share). The server sends a
// 'proactive-speech' broadcast (carries the text) followed by 'speech-chunk' +
// 'done' messages with the same reqId. We register a reply handler for those
// chunks and route them through the voice loop's playback machinery — same
// chunk-queue/barge-in path as voice replies and vision answers. The orb
// flashes so the user knows MYTHOS is speaking on its own initiative.
subscribe(['proactive-speech'], (msg) => {
  // Do not construct a permanently mistuned loop while auth facts are pending.
  if (!voiceConfigLoaded) return;
  // Cortex keeps ticking while locked — do not read build results, goal
  // titles, or error text aloud over a locked HUD (pin.css's "nothing may be
  // ... read over the top of a locked HUD" claim). Dropped here, before a
  // reply handler is even registered, so the matching speech-chunk/done
  // broadcasts land with no handler and are silently ignored (see ws.js's
  // registerReplyHandler comment) rather than played later.
  if (isGateClosed(pinLockScreen.lockState())) return;
  const v = ensureVoice();
  const session = v.beginTurn(msg.reqId); // reqId known upfront — barge-in can cancel this turn's TTS synthesis too (Item B)
  mic.setCaption(msg.text || msg.speak || '', 'reply');
  if (orb.flashAction) orb.flashAction('proactive', true);
  registerReplyHandler(msg.reqId, {
    onChunk: (m) => v.onExternalChunk(m, session),
    // Pass the real 'done' message through (same as the other reply handlers
    // above) — it carries the `chunked` flag. Rebuilding {say, speak} here
    // dropped that flag, so the voice loop played the streamed edge-tts
    // chunks AND the speechSynthesis fallback at once: two different voices
    // speaking the same greeting simultaneously.
    onDone: (m) => v.deliverExternalReply({ ...m, say: m.say || msg.text, speak: m.speak || msg.speak }, session),
  });
});

// Navigate — emitted by dispatchAction when a brain-driven `navigate` effector
// call succeeds. The voice-loop's NAV_COMMANDS shortcut opens panels directly
// for exact-match phrases, but anything that falls through to the brain needs
// this relay to actually open the panel. Without it, "open the memory panel"
// succeeds server-side but the view never changes.
subscribe(['navigate'], (msg) => {
  // Same locked-HUD invariant as proactive-speech above: a server-driven
  // navigate must not change what's rendered behind a locked screen.
  if (isGateClosed(pinLockScreen.lockState())) return;
  if (msg.route) overlays.openPanel(msg.route);
});

// OCR-result — Slice 2 (Electron shell): Ctrl+Alt+X pressed anywhere → server
// ran screen_read_text → text arrives here. Caption the first line and copy
// the full text to the clipboard (best-effort: clipboard write needs a focused
// document, and the whole point of the hotkey is that the HUD is NOT focused —
// a rejected promise just means the caption is the only surface this time).
subscribe(['ocr-result'], (msg) => {
  // BUG-268 instrumentation, boundary 3 of 3 (see electron/main.js's OCR-grab
  // callback for the read-in-order guide). Logged BEFORE the gate check and
  // recording the gate verdict, because a closed lock gate drops the result
  // silently — no caption, no clipboard write — and from the operator's side
  // that is indistinguishable from OCR having failed or never run. This line is
  // the only way to tell "the PIN lock ate it" from the other four candidates.
  const gateClosed = isGateClosed(pinLockScreen.lockState());
  try {
    console.info('[BUG-268] ocr-result received', {
      gateClosed: gateClosed,
      ok: Boolean(msg && msg.payload && msg.payload.ok),
      textLength: String((msg && msg.payload && msg.payload.text) || '').length,
    });
  } catch (_) { /* never break the subscriber to log */ }
  if (gateClosed) return;
  const p = msg.payload || {};
  if (!p.ok) {
    mic.setCaption('OCR failed: ' + (p.error || 'unknown error'), 'error');
    return;
  }
  const text = String(p.text || '');
  const firstLine = text.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '(no text found)';
  mic.setCaption('📋 ' + firstLine, 'info');
  if (text && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    Promise.resolve(navigator.clipboard.writeText(text)).catch(() => { /* unfocused doc — caption only */ });
  }
});

// Close-panel — server-initiated request from the close_panel effector
// (REMEDIATION P1-5: requestClosePanel() in server/index.js, mirroring
// camera_look's cameraFrameProvider round-trip). Closes BOTH overlay panels
// AND floating widgets (previously only overlays — close_panel was
// structurally unable to reach a widget open_web spawned) and acks back the
// real counts so close_panel's return value is honest instead of a
// hardcoded closed:true.
subscribe(['close-panel'], (msg) => {
  const overlaysClosed = msg.all ? overlays.closeAll() : overlays.closeTop();
  const widgetsClosed = widgetApi.closeSpawnedWidgets(Boolean(msg.all));
  if (msg.reqId) {
    sendMessage({ type: 'close-panel-ack', reqId: msg.reqId, overlaysClosed, widgetsClosed });
  }
});

// Widget-command — voice-driven HUD widget hide/show (manage_widget effector).
// Payload {mode, targets} is resolved server-side; widget-host applies + persists.
subscribe(['widget-command'], (msg) => {
  if (msg.payload) widgetApi.applyWidgetCommand(msg.payload);
});

// Open-web — emitted by dispatchAction when an open_web effector call succeeds.
// Routes rich media (YouTube, direct URLs) to the overlay panel; compact results
// (search, weather, flights, images) to floating widgets; iframe-blocking sites
// get smart-routed: 'newtab' opens externally, 'news' navigates to news panel.
// BUG-273 B3 — every branch below now answers the server: did this actually appear?
// Three incidents on 2026-08-18 (`news`, `flights`, and a generic "Dashboard did
// not confirm display") were open_web reporting ok with "the dashboard has not
// confirmed it rendered this", because nothing ever reported back.
//
// `reqId` is absent on the legacy bus relay — from-pc.js and from-widgets.js still
// emit ui.open-web directly — so ackRender is a no-op for those and this stays
// purely additive rather than making them fail for want of an ack.
function ackRender(msg, result) {
  if (!msg || !msg.reqId) return;
  try {
    sendMessage(Object.assign({ type: 'open-web-ack', reqId: msg.reqId }, result || {}));
  } catch (_) { /* socket down — the server times out and reports unverified */ }
}

subscribe(['open-web'], (msg) => {
  const p = msg.payload;
  if (!p || !p.widgetType) {
    ackRender(msg, { mounted: false, reason: 'the descriptor had no widgetType' });
    return;
  }
  if (p.widgetType === 'newtab' || p.widgetType === 'news') {
    // p.url is untrusted: it comes from the open_web tool, whose URLs originate
    // in web-search results, fetched page content and model output. window.open
    // honours javascript:, data: and file: just as happily as http(s), so the
    // scheme has to be gated here and NOT fall back to the default on a reject —
    // opening a different page than the one asked for would be a silent lie.
    const targetUrl = p.url ? safeUrl(p.url) : 'https://news.google.com';
    if (!targetUrl) {
      ackRender(msg, { mounted: false, reason: 'that link was not an http(s) URL, so I did not open it' });
      return;
    }
    // BUG-003/028: noopener can return null even after creating a tab; no handle proves neither outcome.
    const win = window.open(targetUrl, '_blank', 'noopener');
    ackRender(msg, win
      ? { mounted: true, surface: 'new browser tab' }
      : { mounted: false, unverified: true, reason: 'I cannot confirm whether the new tab opened because the browser did not expose a window handle' });
    return;
  }
  if (p.widgetType === 'youtube' || p.widgetType === 'web') {
    try {
      overlays.openPanel('web', p);
      ackRender(msg, { mounted: true, surface: 'dashboard panel' });
    } catch (err) {
      ackRender(msg, { mounted: false, reason: 'the web panel would not open: ' + ((err && err.message) || err) });
    }
    return;
  }
  // dynamic — Item 11 generative UI (spawn_widget effector): declarative
  // stat/list/table/text spec, rendered by kinds/dynamic.js. Same one-off
  // floating-widget lifecycle as search/weather/flights/image below — just a
  // distinct render path inside spawnWebWidget, not a different lifecycle.
  if (p.widgetType === 'dynamic') {
    ackRender(msg, widgetApi.spawnWebWidget(p));
    return;
  }
  ackRender(msg, widgetApi.spawnWebWidget(p));
});
