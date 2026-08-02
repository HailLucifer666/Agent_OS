// voice.js — the voice subsystem's live posture: which engines the browser
// actually has, whether speech-to-speech is enabled server-side, and what the
// voice loop is doing right now.
//
// HOW IT READS STATE WITHOUT NEW PLUMBING: app.js's onVoiceState() is the
// single fan-out for every voice transition (compose, orb, hud), and
// compose-bar.js mirrors that state onto the pill as `data-voice-state`. This
// widget observes that attribute rather than adding a second broadcast
// channel. No new event, no change to app.js, no second source of truth.
//
// WHAT IS NOT HERE, and why: design/mythos-living-core.html's "Voice" panel
// showed a live mic input-level bar. Reading that means opening a SECOND
// getUserMedia stream alongside the one voice-loop.js already owns — a real
// device conflict, for a decoration. voice-loop.js computes RMS internally but
// exposes no getter. So the level bar is dropped rather than faked or forced.
// Latency is not duplicated either; kinds/voice-latency.js already owns p50/p95.

import { h, keyedList, cleanupBag } from '../../dom.js';

const UNAVAILABLE = 'unavailable';
const STATES = ['idle', 'listening', 'processing', 'speaking'];

// Pure. Exported for node:test — the capability matrix must never claim an
// engine the browser does not expose.
export function readVoiceCapabilities(win) {
  const w = win || {};
  return {
    recognition: (w.SpeechRecognition || w.webkitSpeechRecognition) ? 'available' : UNAVAILABLE,
    synthesis: w.speechSynthesis ? 'available' : UNAVAILABLE,
  };
}

export function normalizeState(raw) {
  return STATES.includes(raw) ? raw : 'idle';
}

const STATE_CLASS = {
  idle: 'text-faint',
  listening: 'text-dim',
  processing: 'text-dim',
  speaking: 'text-gold',
};

export function mountVoice(el, ctx) {
  const bag = cleanupBag();

  const stateEl = h('div', { class: 'widget-value-text mono text-faint' }, 'idle');
  const list = h('div', { class: 'widget-lanes' });
  el.replaceChildren(stateEl, list);

  const caps = readVoiceCapabilities(window);
  const rows = [
    { key: 'recognition', label: 'browser stt', value: caps.recognition },
    { key: 'synthesis', label: 'browser tts', value: caps.synthesis },
    { key: 's2s', label: 'live s2s', value: 'checking…' },
  ];

  function paintRows() {
    keyedList(
      list,
      rows,
      (r) => r.key,
      (r) => h('div', { class: 'widget-lane-row' },
        h('span', { class: 'text-faint' }, r.label),
        h('span', { class: r.value === UNAVAILABLE ? 'text-faint mono' : 'mono' }, r.value),
      ),
      (node, r) => {
        const valueEl = node.lastChild;
        valueEl.textContent = r.value;
        valueEl.className = r.value === UNAVAILABLE ? 'text-faint mono' : 'mono';
      },
    );
  }
  paintRows();

  function paintState(raw) {
    const s = normalizeState(raw);
    stateEl.textContent = s;
    stateEl.className = `widget-value-text mono ${STATE_CLASS[s]}`;
  }

  // The pill carries the live state; compose-bar mounts in the same boot pass
  // as the widgets, so it may not exist yet on first paint.
  const pill = document.querySelector('[data-voice-state]');
  if (pill) {
    paintState(pill.dataset.voiceState);
    const observer = new MutationObserver(() => paintState(pill.dataset.voiceState));
    observer.observe(pill, { attributes: true, attributeFilter: ['data-voice-state'] });
    bag.add(() => observer.disconnect());
  } else {
    // No pill means the compose bar has not mounted. Do not invent a state.
    stateEl.textContent = UNAVAILABLE;
  }

  let disposed = false;
  bag.add(() => { disposed = true; });

  // S2S availability is a real server fact — /api/config/s2s exposes only the
  // boolean, never the key or model id (see server/routes/config.js).
  fetch('/api/config/s2s')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((cfg) => {
      if (disposed) return;
      rows[2].value = cfg && cfg.enabled ? 'enabled' : 'disabled';
      paintRows();
    })
    .catch(() => {
      if (disposed) return;
      // The route was unreachable, so we never learned the setting. Distinct
      // from "disabled" and must not be reported as it.
      rows[2].value = UNAVAILABLE;
      paintRows();
    });

  return () => bag.run();
}
