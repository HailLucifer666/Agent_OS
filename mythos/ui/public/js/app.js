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

// neural map + core orb
mountHud(document.getElementById('hud-canvas'), {
  ...ctx,
  onNodeClick: (panelId) => overlays.openPanel(panelId),
});
const orb = mountCoreOrb(document.getElementById('core-orb'), {
  ...ctx,
  onClick: () => toggleVoice(),
});

// floating widgets
mountWidgets(document.getElementById('widget-root'), ctx);

// global confirm modal (mounted once, never routed)
mountConfirmModal(document.getElementById('confirm-root'), {
  onResolved: () => orb.notifyConfirmResolved && orb.notifyConfirmResolved(),
});

// voice — created lazily on first user gesture, then toggled via mic/orb clicks
const micEl = document.getElementById('mic-indicator');
const mic = createMicIndicator(micEl);
let voice = null;

function toggleVoice() {
  if (!voice) voice = createVoiceLoop({ onState: (s) => mic.setState(s), openPanel: (id) => overlays.openPanel(id) });
  voice.toggle();
}

micEl.addEventListener('click', toggleVoice);

// Chrome gesture policy: SpeechRecognition/AudioContext need a user gesture, so
// the loop object is constructed on the FIRST pointerdown (any click) — but
// listening still starts only when the user explicitly clicks the mic or orb.
const armOnce = () => {
  document.removeEventListener('pointerdown', armOnce);
  if (!voice) voice = createVoiceLoop({ onState: (s) => mic.setState(s), openPanel: (id) => overlays.openPanel(id) });
};
document.addEventListener('pointerdown', armOnce);
