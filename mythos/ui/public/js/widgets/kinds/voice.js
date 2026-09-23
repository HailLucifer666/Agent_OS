import { voiceConfiguration } from '../../voice/voice-config.js';
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

// BUG-175: the wake word spent a week armed and deaf while every surface said
// "listening". app.js mirrors its state and rolling peak score onto
// documentElement.dataset (wakeword / wakewordPeak); this renders them
// together, because either alone is misleading — "listening" without a score
// is the exact false reassurance that hid the bug, and a score without the
// threshold cannot be judged. Pure, exported for node:test.
export function formatWakeword(state, peakRaw, threshold) {
  if (!state) return { text: UNAVAILABLE, faint: true };
  const peak = Number(peakRaw);
  const thr = typeof threshold === 'number' ? threshold : 0.5;
  if (!Number.isFinite(peak)) return { text: state, faint: state !== 'listening' };
  // Two significant figures is enough to tell 1e-5 from 0.4 at a glance, and
  // an exponent is the honest rendering for a score that small.
  const shown = peak >= 0.01 ? peak.toFixed(2) : peak.toExponential(1);
  return { text: `${state} · peak ${shown} / ${thr}`, faint: peak < thr };
}

const STATE_CLASS = {
  idle: 'text-faint',
  listening: 'text-dim',
  processing: 'text-dim',
  speaking: 'text-gold',
};

// BUG-401 (2026-09-03): the /api/config/s2s handler wrote rows[2] — which is
// `browser tts`, not `live s2s`. So `live s2s` never left its initial
// 'checking…' and the TTS row displayed the S2S boolean under the wrong label.
// Confirmed on the operator's screenshot while the server log showed a Live turn
// completing 14s later. An index cannot be checked by reading it; a key can, so
// the row is addressed BY KEY and this function is pure and exported so
// node:test can drive it with no DOM (ui/public is a no-build ESM tree — see
// ui/CLAUDE.md). Same class as BUG-175, inverted: false discouragement rather
// than false reassurance, in the file whose header is about BUG-175.
//
// cfg is the parsed /api/config/s2s body, or null when the route was
// unreachable. Unreachable is NOT 'disabled' — we never learned the setting,
// and reporting it as disabled would be a synthesized fact (AD-5).
export function applyS2sResult(rows, cfg) {
  const row = (rows || []).find((r) => r && r.key === 's2s');
  if (!row) return rows;
  if (cfg === null || cfg === undefined) row.value = UNAVAILABLE;
  else row.value = cfg.enabled ? 'enabled' : 'disabled';
  return rows;
}

// BUG-401: app.js mounts widgets before createComposeBar creates its pill.
// Observing only an already-existing pill misses normal boot permanently.
// Observe the stable compose container so late creation, replacement and removal
// use the same source of truth. No pill means unknown, never invented idle.
// Verified with the real compose module mounted after this widget in Chromium.
export function observeVoiceState(root, onState) {
  function read() {
    const pill = root && root.querySelector('[data-voice-state]');
    onState(pill ? pill.dataset.voiceState : null);
  }
  read();
  if (!root) return () => {};
  const observer = new MutationObserver(read);
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-voice-state'],
  });
  return () => observer.disconnect();
}

export function mountVoice(el, ctx) {
  const bag = cleanupBag();

  const stateEl = h('div', { class: 'widget-value-text mono text-faint' }, 'idle');
  const list = h('div', { class: 'widget-lanes' });
  el.replaceChildren(stateEl, list);

  const caps = readVoiceCapabilities(window);
  const rows = [
    { key: 'wakeword', label: 'wake word', value: UNAVAILABLE },
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

  bag.add(observeVoiceState(document.getElementById('compose-bar'), (state) => {
    if (state === null) {
      stateEl.textContent = UNAVAILABLE;
      stateEl.className = 'widget-value-text mono text-faint';
    } else paintState(state);
  }));

  // BUG-175: watch the wake word's own dataset attributes on <html>, the same
  // observe-don't-rebroadcast pattern this widget already uses for the voice
  // pill. app.js owns those attributes; nothing new is plumbed.
  const root = document.documentElement;
  function paintWakeword() {
    const ww = formatWakeword(root.dataset.wakeword, root.dataset.wakewordPeak, wakewordThreshold);
    rows[0].value = ww.text;
    paintRows();
  }
  let wakewordThreshold = 0.5;
  paintWakeword();
  const wwObserver = new MutationObserver(paintWakeword);
  wwObserver.observe(root, { attributes: true, attributeFilter: ['data-wakeword', 'data-wakeword-peak'] });
  bag.add(() => wwObserver.disconnect());

  let disposed = false;
  bag.add(() => { disposed = true; });

  bag.add(voiceConfiguration.subscribe(({ wakeword, s2s }) => {
    if (disposed) return;
    if (typeof wakeword.value?.threshold === 'number') wakewordThreshold = wakeword.value.threshold;
    applyS2sResult(rows, s2s.value);
    paintWakeword();
  }));

  return () => bag.run();
}
