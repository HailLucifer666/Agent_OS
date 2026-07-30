// app.js — HUD boot entry: hud -> overlays -> widgets -> confirm -> voice.
// Voice initializes on first pointerdown (Chrome's user-gesture policy for
// mic/AudioContext); everything else mounts immediately.

import { subscribe, visionQuery, registerReplyHandler, sendMessage, utterance } from './ws.js';
import { onRefresh } from './stats-bus.js';
import { mountHud } from './neural-map/hud-canvas.js';
import { mountCoreOrb } from './neural-map/core-orb.js';
import { createOverlayManager } from './overlay/overlay-manager.js';
import { mountWidgets } from './widgets/widget-host.js';
import { mountConfirmModal } from './confirm/confirm-modal.js';
import { createVoiceLoop } from './voice/voice-loop.js';
import { decideVoiceTransport } from './voice/voice-transport.js';
import { createCameraLoop } from './vision/camera.js';
import { createComposeBar } from './compose-bar.js';
import { mountInitScreen } from './init-screen.js';
import { mountPinLockScreen } from './pin/pin-lock-screen.js';
import { isGateClosed } from './pin/pin-gate.js';
import { isEntityAlive } from './entity-status.js';

const ctx = { subscribe, onRefresh };

// Cinematic boot overlay — mounted before anything else so the HUD build-up
// (orb/widgets/panels initializing underneath) is hidden behind it. Skips
// itself once the entity reports alive (or after a hard timeout if the
// server never answers) — see init-screen.js for the reveal timing.
mountInitScreen({ subscribe });

// §7.3 local PIN lock — the enforcement point the backend never had. Mounted
// here (before the HUD builds) but NON-BLOCKING: it asks GET /api/pin/status
// and only paints an overlay if a PIN is actually configured. With no PIN
// configured — the default — nothing changes at all. See pin/pin-lock-screen.js.
const pinLockScreen = mountPinLockScreen(document.getElementById('pin-root'));

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

// BUG-020: VAD tuning fetched once at boot. Voice initializes lazily (first
// mic click), so this almost always resolves first; if it hasn't, ensureVoice()
// just falls back to voice-loop.js's built-in defaults — never blocks first use.
let _vadOverrides = null;
fetch('/api/config/vad')
  .then((r) => (r.ok ? r.json() : null))
  .then((cfg) => { if (cfg) _vadOverrides = cfg; })
  .catch(() => {});

// Wake-word ("hey jarvis") config, fetched once at boot alongside VAD tuning
// above. armOnce (below) lazily imports wakeword.js only when enabled AND the
// models are actually present on disk.
let _wakewordCfg = null;
fetch('/api/config/wakeword')
  .then((r) => (r.ok ? r.json() : null))
  .then((cfg) => { if (cfg) _wakewordCfg = cfg; })
  .catch(() => {});

// Gemini Live speech-to-speech (VOICE_S2S_ENABLED, server/routes/config.js),
// fetched once at boot like the two above. Stays FALSE unless the server says
// otherwise — a fetch that fails, 404s, or never resolves leaves the mature
// batch-STT path (voice-loop.js) in charge, which is the honest default
// (schema.js defaults VOICE_S2S_ENABLED to false). Until this fetch existed
// the client had no way to learn the flag at all, so voice/s2s-bridge.js —
// complete and protocol-correct — had no consumer.
let _s2sEnabled = false;
fetch('/api/config/s2s')
  .then((r) => (r.ok ? r.json() : null))
  .then((cfg) => { if (cfg && cfg.enabled) _s2sEnabled = true; })
  .catch(() => {});

// overlays
const overlays = createOverlayManager(document.getElementById('overlay-root'));

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
  onMicSettings: () => {
    // Ensure the voice loop exists so its setMicDevice/getMicDevice are live,
    // then open the panel with them threaded through the overlay payload. The
    // panel works even if voice is idle — it owns its own diagnostic AudioContext.
    const v = ensureVoice();
    overlays.openPanel('mic-settings', { voice: { setMicDevice: (id) => v.setMicDevice(id), getMicDevice: () => v.getMicDevice() } });
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

function onVoiceState(s) {
  _voiceState = s;
  compose.setVoiceState(s);
  orb.setVoiceState(s);
  hud.setVoiceState(s);
}

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
      vad: _vadOverrides || undefined,
    });
  }
  return voice;
}

// ---- S2S (Gemini Live duplex) transport, additive and flag-gated ----------
// voice/s2s-bridge.js self-wires its own live-audio-out/live-interrupted/
// live-state/live-transcript listeners through ws.js's onBroadcast, so all it
// needs from here is onState/onCaption and a start/stop call. Lazily imported
// (same pattern as wakeword.js below) so a HUD with the flag off never fetches
// the bridge or pcm-player at all.
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

// One entry point for every voice affordance (compose-bar button, orb click,
// wake word). decideVoiceTransport() owns the choice AND the mic-exclusivity
// invariant — the two transports each open their own getUserMedia stream, so
// both capturing at once would have the Live model hearing itself and the
// batch loop transcribing MYTHOS's own replies. See voice/voice-transport.js
// and test/voice-transport-decision.test.js.
async function toggleVoice() {
  // No voice affordance (compose-bar button, orb click, wake word) may open
  // the mic while the PIN lock screen is locked OR its status check hasn't
  // answered yet — see isGateClosed()'s doc comment in pin/pin-gate.js.
  if (isGateClosed(pinLockScreen.lockState())) return;
  const plan = decideVoiceTransport({
    s2sEnabled: _s2sEnabled,
    s2sActive: Boolean(s2s && s2s.isActive()),
    batchActive: Boolean(voice && voice.isActive()),
  });

  // Release the transport that must not hold the mic, FIRST and always —
  // including on a stop, so no stray capture is left running.
  if (plan.stopOther === 'batch' && voice) voice.stop();
  if (plan.stopOther === 's2s' && s2s) await s2s.stop();

  if (plan.transport === 'batch') {
    if (plan.action === 'start') ensureVoice().start();
    else if (voice) voice.stop();
    return;
  }

  const bridge = await ensureS2S();
  if (!bridge) { ensureVoice().start(); return; } // import failed — batch fallback
  if (plan.action === 'start') await bridge.start();
  else await bridge.stop();
}

// Orb click still toggles voice (legacy affordance)
// (onClick already wired in mountCoreOrb above)

// camera + hand-gesture control (Part A/B, P16). Camera is OFF by default,
// same privacy posture as the mic — only starts on an explicit toggle click.
// State renders through the compose-bar's cam button (compose.setCamState);
// the old standalone floating ring is gone.
let camera = null;

// Gesture -> action map. Confirm accept/reject reuse the LIVE modal buttons
// (confirm-modal.js) — same code path as a human click, zero new approval
// surface. Selectors return null harmlessly when no confirm is showing.
const GESTURE_ACTIONS = {
  Thumb_Up:    () => { const b = document.querySelector('.confirm-accept'); if (b) { b.click(); mic.setCaption('👍 approved by gesture', 'reply'); } },
  Closed_Fist: () => { const b = document.querySelector('.confirm-reject'); if (b) { b.click(); mic.setCaption('✊ denied by gesture', 'reply'); } },
  Open_Palm:   () => {
    // Whichever transport currently holds the mic (see toggleVoice) — the
    // gesture has to be able to mute an S2S session too, not just the batch loop.
    if (voice && voice.isActive()) { voice.stop(); mic.setCaption('🖐 mic muted by gesture', 'info'); }
    if (s2s && s2s.isActive()) { s2s.stop(); mic.setCaption('🖐 mic muted by gesture', 'info'); }
  },
  Victory:     () => describeScene('Describe what you see, briefly.'),
};

// Vision Q&A reply reuses the voice loop's own chunk-queue/barge-in playback
// machinery (beginTurn/onExternalChunk/deliverExternalReply) so a "what do
// you see" answer is spoken exactly like a voice reply, chunk-by-chunk.
function describeScene(text) {
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
function sendTextMessage(text) {
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

// Chrome gesture policy: SpeechRecognition/AudioContext need a user gesture, so
// the loop object is constructed on the FIRST pointerdown (any click) — but
// listening still starts only when the user explicitly clicks the mic or orb.
const armOnce = () => {
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
  document.removeEventListener('pointerdown', armOnce);
  ensureVoice();
  ensureWakeWord();
};
document.addEventListener('pointerdown', armOnce);

// Wake-word ("hey jarvis") — hands-free activation. Lazily imported (like
// voice-loop.js above) only on the same first-gesture arm, and only when the
// server reports it enabled AND the on-device models are actually present
// (scripts/setup-wakeword.js). Deliberately NOT paused on visibilitychange —
// unlike hud-canvas.js's render-pause pattern, always-on standby listening is
// the entire point of this feature, so a backgrounded tab must keep listening.
function ensureWakeWord() {
  if (wakeword) return;
  if (!_wakewordCfg || !_wakewordCfg.enabled) return;
  if (!_wakewordCfg.modelsPresent) {
    mic.setCaption('Wake word enabled but models missing — run scripts/setup-wakeword.js', 'error');
    return;
  }
  import('./voice/wakeword.js').then(({ createWakeWord }) => {
    wakeword = createWakeWord({
      threshold: _wakewordCfg.threshold,
      onWake: () => {
        // Never react to a spoken wake word at a locked (or not-yet-known)
        // machine — a bystander who knows the wake phrase must not be able
        // to open a full voice turn, including server-side tool dispatch,
        // just by speaking at a locked HUD.
        if (isGateClosed(pinLockScreen.lockState())) return;
        if (voice && voice.isActive()) return;   // already in a conversation
        if (s2s && s2s.isActive()) return;        // ...or already in a live S2S session
        if (s2s && s2s.isSpeaking()) return;      // Live model is talking — no re-trigger
        if (_voiceState === 'speaking') return;   // MYTHOS is talking — no re-trigger
        if (orb.flashAction) orb.flashAction('wake', true);
        toggleVoice();                             // same path as clicking the orb
      },
      onStatus: (s, msg) => { if (s === 'error') mic.setCaption('Wake word offline: ' + msg, 'error'); },
    });
    wakeword.start();
  }).catch((err) => {
    mic.setCaption('Wake word failed to load: ' + (err && err.message || err), 'error');
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
subscribe(['open-web'], (msg) => {
  const p = msg.payload;
  if (!p || !p.widgetType) return;
  if (p.widgetType === 'newtab' || p.widgetType === 'news') {
    const targetUrl = p.url || 'https://news.google.com';
    window.open(targetUrl, '_blank', 'noopener');
    return;
  }
  if (p.widgetType === 'youtube' || p.widgetType === 'web') {
    overlays.openPanel('web', p);
    return;
  }
  // dynamic — Item 11 generative UI (spawn_widget effector): declarative
  // stat/list/table/text spec, rendered by kinds/dynamic.js. Same one-off
  // floating-widget lifecycle as search/weather/flights/image below — just a
  // distinct render path inside spawnWebWidget, not a different lifecycle.
  if (p.widgetType === 'dynamic') {
    widgetApi.spawnWebWidget(p);
    return;
  }
  widgetApi.spawnWebWidget(p);
});
