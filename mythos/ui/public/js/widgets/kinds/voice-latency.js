// voice-latency.js — mic-stop -> first-audio-frame latency, straight from
// /api/status's voiceLatency ({p50, p95, sampleCount}, fed by
// src/core/voice/latency-tracker.js on both the batch and S2S paths).
//
// Same two-line shape as tick-rate.js (widget-value headline + widget-sub
// detail), and the same honesty posture as its "awaiting first tick" empty
// state: when the tracker has no samples, this tile says "no samples yet" in
// words. All the AD-5 formatting decisions live in voice/latency-format.js so
// they are node-testable (test/voice-latency-format.test.js) — this file is
// only the fetch + paint shell.
//
// Refresh model: /api/status is a REST snapshot with no WS broadcast behind
// it, so unlike tick-rate.js there is nothing to subscribe to. It re-reads on
// the shared stats-bus 'refresh' event (ctx.onRefresh, same channel the HUD
// density model uses) plus a slow poll — voice latency only changes when a
// voice turn completes, so a fast interval would be pure waste.

import { formatVoiceLatency } from '../../voice/latency-format.js';

const POLL_MS = 30000;

export function mountVoiceLatency(el, ctx) {
  // xss-safe: static template, no interpolation
  el.innerHTML = `
    <div class="widget-value mono" data-role="p50">no samples yet</div>
    <div class="widget-sub mono" data-role="detail">voice turns not yet measured</div>
  `;
  const p50El = el.querySelector('[data-role="p50"]');
  const detailEl = el.querySelector('[data-role="detail"]');

  let disposed = false;

  function paint(out) {
    p50El.textContent = out.value;
    detailEl.textContent = out.detail;
    // Smaller type for the wordy empty state — 'no samples yet' at the
    // 22px .widget-value size would wrap out of the card.
    p50El.classList.toggle('widget-value-text', !out.hasSamples);
  }

  async function load() {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const status = await res.json();
      if (disposed) return;
      paint(formatVoiceLatency(status && status.voiceLatency));
    } catch {
      if (disposed) return;
      // Honest-offline: the fetch failed or returned non-OK, so the tracker
      // was never actually read — a DIFFERENT claim from "no samples yet"
      // (which asserts the tracker WAS read and is genuinely empty). See
      // latency-format.js's { unreadable: true } branch.
      paint(formatVoiceLatency(null, { unreadable: true }));
    }
  }

  load();
  const timer = setInterval(load, POLL_MS);
  const offRefresh = ctx && typeof ctx.onRefresh === 'function' ? ctx.onRefresh(() => load()) : null;

  return () => {
    disposed = true;
    clearInterval(timer);
    if (offRefresh) offRefresh();
  };
}
