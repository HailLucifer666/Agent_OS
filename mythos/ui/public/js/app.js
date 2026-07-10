// app.js — HUD boot entry: hud -> overlays -> widgets -> confirm -> voice.
// Voice initializes on first pointerdown (Chrome's user-gesture policy for
// mic/AudioContext); everything else mounts immediately.

import { subscribe } from './ws.js';
import { onRefresh } from './stats-bus.js';
import { mountHud } from './neural-map/hud-canvas.js';
import { mountCoreOrb } from './neural-map/core-orb.js';
import { createOverlayManager } from './overlay/overlay-manager.js';
import { mountWidgets } from './widgets/widget-host.js';
import { mountConfirmModal } from './confirm/confirm-modal.js';
import { createVoiceLoop } from './voice/voice-loop.js';
import { createMicIndicator } from './voice/mic-indicator.js';

const ctx = { subscribe, onRefresh };

// overlays
const overlays = createOverlayManager(document.getElementById('overlay-root'));

// core orb mounts first — hud-canvas's ctx needs orb.flashAction for its
// per-action-type color relay (pure reorder, no visual side effect: DOM
// z-order is CSS-driven, not mount-call-order-driven).
const orb = mountCoreOrb(document.getElementById('core-orb'), {
  ...ctx,
  onClick: () => toggleVoice(),
});

// neural map
mountHud(document.getElementById('hud-canvas'), {
  ...ctx,
  onNodeClick: (panelId) => overlays.openPanel(panelId),
  onAction: (category, ok) => orb.flashAction(category, ok),
});

// floating widgets
mountWidgets(document.getElementById('widget-root'), ctx);

// global confirm modal (mounted once, never routed)
mountConfirmModal(document.getElementById('confirm-root'), {
  onResolved: () => orb.notifyConfirmResolved && orb.notifyConfirmResolved(),
});

// voice — created lazily on first user gesture, then toggled via mic/orb clicks.
// One shared callback feeds both the mic ring and the core orb's voice-reactive
// color (listening/processing), so they never drift into two separate states.
const micEl = document.getElementById('mic-indicator');
const mic = createMicIndicator(micEl);
let voice = null;

function onVoiceState(s) {
  mic.setState(s);
  orb.setVoiceState(s);
}

function ensureVoice() {
  if (!voice) {
    voice = createVoiceLoop({
      onState: onVoiceState,
      openPanel: (id) => overlays.openPanel(id),
      onCaption: (text, kind) => mic.setCaption(text, kind),
    });
  }
  return voice;
}

function toggleVoice() {
  ensureVoice().toggle();
}

micEl.addEventListener('click', toggleVoice);

// Chrome gesture policy: SpeechRecognition/AudioContext need a user gesture, so
// the loop object is constructed on the FIRST pointerdown (any click) — but
// listening still starts only when the user explicitly clicks the mic or orb.
const armOnce = () => {
  document.removeEventListener('pointerdown', armOnce);
  ensureVoice();
};
document.addEventListener('pointerdown', armOnce);
