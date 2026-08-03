// voice.js — the voice subsystem's live posture: which engines the browser
// actually has, whether speech-to-speech is enabled server-side, and what the
// voice loop is doing right now.
//
// HOW IT READS STATE WITHOUT NEW PLUMBING: app.js's onVoiceState() is the
// single fan-out for every voice transition (app.js:149-153 — compose, orb,
// hud). compose-bar.js:141 mirrors that state onto the pill as
// `data-voice-state`. This widget observes that attribute rather than adding a
// second broadcast channel. There is deliberately no new event, no change to
// app.js, and no second source of truth for voice state.
//
// WHAT IS NOT HERE, and why: design/mythos-living-core.html's "Voice" panel
// showed a live mic input-level bar. Reading that would mean opening a SECOND
// getUserMedia stream alongside the one voice-loop.js already owns — a real
// device conflict, for a decoration. voice-loop.js computes RMS internally but
// exposes no getter. So the level bar is dropped rather than faked or forced.
// Latency is not duplicated here either; widgets/kinds/voice-latency.js already
// owns p50/p95 from /api/status.

import { h, keyedList, cleanupBag } from '../../dom.js';

const UNAVAILABLE = 'unavailable';
const STATES = ['idle', 'listening', 'processing', 'speaking'];

// Pure. Exported for node:test — the capability matrix is the part worth
// pinning, and it must never claim an engine the browser does not expose.
export function readVoiceCapabilities(win) {
  const w = win || {};
  const hasRecognition = Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
  const hasSynthesis = Boolean(w.speechSynthesis);
  return {
    recognition: hasRecognition ? 'available' : UNAVAILABLE,
    synthesis: hasSynthesis ? 'available' : UNAVAILABLE,
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

  // The pill carries the live state; it is created by compose-bar.js during the
  // same boot pass that mounts widgets, so it may not exist yet on first paint.
  const pill = document.querySelector('[data-voice-state]');
  if (pill) {
    paintState(pill.dataset.voiceState);
    const observer = new MutationObserver(() => paintState(pill.dataset.voiceState));
    observer.observe(pill, { attributes: true, attributeFilter: ['data-voice-state'] });
    bag.add(() => observer.disconnect());
  } else {
    // No pill means the compose bar has not mounted. Do not invent a state —
    // say the source is missing, same posture as every other row here.
    stateEl.textContent = UNAVAILABLE;
  }

  let disposed = false;
  bag.add(() => { disposed = true; });

  // S2S availability is a real server fact (/api/config/s2s exposes only the
  // boolean, never the key or model id — see server/routes/config.js).
  fetch('/api/config/s2s')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((cfg) => {
      if (disposed) return;
      rows[2].value = cfg && cfg.enabled ? 'enabled' : 'disabled';
      paintRows();
    })
    .catch(() => {
      if (disposed) return;
      // The route was unreachable, so we never learned the setting. That is
      // distinct from "disabled" and must not be reported as it.
      rows[2].value = UNAVAILABLE;
      paintRows();
    });

  return () => bag.run();
}
