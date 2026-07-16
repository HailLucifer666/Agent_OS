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
import { createCameraLoop } from './vision/camera.js';
import { createComposeBar } from './compose-bar.js';

const ctx = { subscribe, onRefresh };

// D5: Track brain availability from entity-state broadcasts.
// When entity reports offline/degraded, voice loop skips transcription to save API calls.
let _brainOnline = true;
subscribe(['entity-state'], (msg) => {
  const state = msg.state || msg.status || '';
  _brainOnline = state !== 'offline' && state !== 'error';
});

// BUG-020: VAD tuning fetched once at boot. Voice initializes lazily (first
// mic click), so this almost always resolves first; if it hasn't, ensureVoice()
// just falls back to voice-loop.js's built-in defaults — never blocks first use.
let _vadOverrides = null;
fetch('/api/config/vad')
  .then((r) => (r.ok ? r.json() : null))
  .then((cfg) => { if (cfg) _vadOverrides = cfg; })
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
const orbEl = document.getElementById('core-orb');
mountHud(document.getElementById('hud-canvas'), {
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
  onVoiceState: (s) => orb.setVoiceState(s),
  onCaption: (text, kind) => {},
  onActivity: () => {},
  onSubmitText: sendTextMessage,
});

// mic indicator API still used by some caption calls below — keep a shim.
const mic = {
  setState: (s) => compose.setVoiceState(s),
  setCaption: (text, kind) => compose.setCaption(text, kind),
  setActivity: (level) => compose.setActivity(level),
};

let voice = null;

function onVoiceState(s) {
  compose.setVoiceState(s);
  orb.setVoiceState(s);
}

function ensureVoice() {
  if (!voice) {
    voice = createVoiceLoop({
      onState: onVoiceState,
      openPanel: (id) => overlays.openPanel(id),
      closePanel: () => overlays.closeAll(),
      onCaption: (text, kind) => compose.setCaption(text, kind),
      onVisionQuery: (text) => describeScene(text),
      onActivity: (level) => compose.setActivity(level),
      brainOnline: () => _brainOnline,
      vad: _vadOverrides || undefined,
    });
  }
  return voice;
}

function toggleVoice() {
  ensureVoice().toggle();
}

// Orb click still toggles voice (legacy affordance)
// (onClick already wired in mountCoreOrb above)

// camera + hand-gesture control (Part A/B, P16). Camera is OFF by default,
// same privacy posture as the mic — only starts on an explicit toggle click.
const camEl = document.getElementById('camera-indicator');
let camera = null;

// Gesture -> action map. Confirm accept/reject reuse the LIVE modal buttons
// (confirm-modal.js) — same code path as a human click, zero new approval
// surface. Selectors return null harmlessly when no confirm is showing.
const GESTURE_ACTIONS = {
  Thumb_Up:    () => { const b = document.querySelector('.confirm-accept'); if (b) { b.click(); mic.setCaption('👍 approved by gesture', 'reply'); } },
  Closed_Fist: () => { const b = document.querySelector('.confirm-reject'); if (b) { b.click(); mic.setCaption('✊ denied by gesture', 'reply'); } },
  Open_Palm:   () => { if (voice && voice.isActive()) { voice.stop(); mic.setCaption('🖐 mic muted by gesture', 'info'); } },
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
        camEl.className = `cam-${s}`;
        camEl.title = `camera ${s}`;
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

camEl.addEventListener('click', () => ensureCamera().toggle());

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
  document.removeEventListener('pointerdown', armOnce);
  ensureVoice();
};
document.addEventListener('pointerdown', armOnce);

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
  const v = ensureVoice();
  const session = v.beginTurn(msg.reqId); // reqId known upfront — barge-in can cancel this turn's TTS synthesis too (Item B)
  mic.setCaption(msg.text || msg.speak || '', 'reply');
  if (orb.flashAction) orb.flashAction('proactive', true);
  registerReplyHandler(msg.reqId, {
    onChunk: (m) => v.onExternalChunk(m, session),
    onDone: () => v.deliverExternalReply({ say: msg.text, speak: msg.speak }, session),
  });
});

// Navigate — emitted by dispatchAction when a brain-driven `navigate` effector
// call succeeds. The voice-loop's NAV_COMMANDS shortcut opens panels directly
// for exact-match phrases, but anything that falls through to the brain needs
// this relay to actually open the panel. Without it, "open the memory panel"
// succeeds server-side but the view never changes.
subscribe(['navigate'], (msg) => {
  if (msg.route) overlays.openPanel(msg.route);
});

// Close-panel — emitted by dispatchAction when a close_panel effector call succeeds.
subscribe(['close-panel'], (msg) => {
  if (msg.all) overlays.closeAll();
  else overlays.closeTop();
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
