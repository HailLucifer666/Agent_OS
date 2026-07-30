// latency-format.js — /api/status's voiceLatency -> the two lines of the
// VOICE LATENCY HUD tile. Pure, so node:test can cover it without a DOM
// (test/voice-latency-format.test.js); the tile shell is
// widgets/kinds/voice-latency.js.
//
// AD-5 is the entire reason this is a separate, tested function.
// src/core/voice/latency-tracker.js returns {p50:null, p95:null,
// sampleCount:0} when no real mic-stop -> first-audio-frame delta has ever
// been measured, and that is the HONEST answer — so the tile says "no samples
// yet" in words. Never a 0, never a bare '—' (which reads as zero/nothing),
// never a placeholder number, never an estimate. A contradictory payload
// (sampleCount > 0 but p50 null) is also treated as unmeasured rather than
// coerced to a number.
//
// "No samples yet" and "unreadable" are DIFFERENT claims and must not share
// wording: "no samples yet" means /api/status WAS read and the tracker is
// genuinely empty; "unreadable" means /api/status itself could not be read
// (network failure, non-OK response), so we never actually observed the
// sample count at all. Pass { unreadable: true } for the latter — see
// widgets/kinds/voice-latency.js's catch branch.

const NO_SAMPLES_VALUE = 'no samples yet';
const NO_SAMPLES_DETAIL = 'voice turns not yet measured';
const UNREADABLE_VALUE = 'not available';
const UNREADABLE_DETAIL = 'status unreachable';

function isMeasured(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

export function formatVoiceLatency(voiceLatency, opts) {
  if (opts && opts.unreadable) {
    return { hasSamples: false, value: UNREADABLE_VALUE, detail: UNREADABLE_DETAIL };
  }
  const v = voiceLatency && typeof voiceLatency === 'object' ? voiceLatency : null;
  const count = v && typeof v.sampleCount === 'number' && Number.isFinite(v.sampleCount)
    ? v.sampleCount
    : 0;

  if (!v || count <= 0 || !isMeasured(v.p50)) {
    return { hasSamples: false, value: NO_SAMPLES_VALUE, detail: NO_SAMPLES_DETAIL };
  }

  const p95 = isMeasured(v.p95) ? `p95 ${Math.round(v.p95)} ms` : 'p95 not measured';
  return {
    hasSamples: true,
    value: `${Math.round(v.p50)} ms`,
    detail: `${p95} · ${count} sample${count === 1 ? '' : 's'}`,
  };
}
