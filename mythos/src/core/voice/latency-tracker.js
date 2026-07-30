'use strict';
// latency-tracker.js — Task 12 (V2 Decision 1, merged-order step 4): a capped
// ring buffer of REAL mic-stop -> first-audio-frame deltas, feeding
// /api/status's voiceLatency: {p50, p95, sampleCount}.
//
// AD-5: an unmeasured turn contributes NO sample rather than an estimate —
// record() silently drops anything that isn't a real, finite, non-negative
// millisecond delta. There is no synthesized fallback value anywhere in this
// file; sampleCount:0 / p50:null / p95:null IS the honest answer when nothing
// has been measured yet.

function createLatencyTracker({ capacity = 200 } = {}) {
  const samples = []; // oldest first; capped ring buffer

  function record(deltaMs) {
    if (typeof deltaMs !== 'number' || !Number.isFinite(deltaMs) || deltaMs < 0) return;
    samples.push(deltaMs);
    if (samples.length > capacity) samples.shift();
  }

  function percentile(p) {
    const sorted = samples.slice().sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
  }

  function stats() {
    if (!samples.length) return { p50: null, p95: null, sampleCount: 0 };
    return { p50: percentile(50), p95: percentile(95), sampleCount: samples.length };
  }

  return { record, stats };
}

module.exports = { createLatencyTracker };
