'use strict';

// immune/anomaly-detail.js — B2 (2026-08-14). What survives from a
// `health.anomaly` payload to the permanent episodic record.
//
// THE BUG THIS FILE EXISTS FOR. server/index.js's anomaly subscriber wrote a
// fixed four-field detail — {kind, scope, error, target} — and dropped
// everything else the emitter had attached. That silently defeated
// instrumentation that had been added on purpose: Wave 0 (2026-08-13) attached
// `audioIn`, `scFields`, `turnId` and `reason` to live-turn-no-user-transcript
// specifically so "one anomaly record is a complete diagnosis instead of a bare
// kind", and what reached disk was:
//
//   {"kind":"anomaly","summary":"anomaly: live-turn-no-user-transcript — ",
//    "detail":{"kind":"live-turn-no-user-transcript","playbookId":null,"outcome":"no-match"}}
//
// Every diagnostic field gone, and `reason` — the field
// anomaly-payloads-need-reason establishes as load-bearing for the SPOKEN
// explanation — gone with them, leaving a summary that is a trailing dash.
// Diagnosing the mic-gate bug (BUG-229) then meant correlating a server log by
// proximity, because the join key (turnId) and the discriminator (audioIn) had
// been emitted and thrown away.
//
// WHY AN ALLOWLIST AND NOT `Object.assign({}, payload)`. Anomaly payloads can
// carry operator content — a tool's args, a claim quoted from a reply, a file
// path — and this is a permanent on-disk record. Adding a field here is a
// decision about what MYTHOS keeps forever, so it stays an explicit list. The
// conformance test (test/anomaly-detail-round-trip.test.js) is what keeps this
// list and the ~130 emitters in src/ honest with each other: it reads the real
// emitters and fails when a NAMED diagnostic field would be silently dropped.
//
// Extracted from the server closure rather than left inline so the round-trip is
// testable without booting the whole HTTP/WS server — the same reason
// action-outcome-summary.js and claim-check.js are their own modules.

// The original four, plus the diagnostic fields measured as load-bearing on
// 2026-08-14. `evidence` and `detail` are the two nested values allowed through:
// the diagnostician puts the whole anomaly in `evidence`, and several core
// emitters (leash, probes, goals, reflection, identity) use one or the other as
// their only detail channel. Both are depth-capped by clipValue, not trusted.
const ANOMALY_DETAIL_FIELDS = [
  'kind', 'scope', 'error', 'target',
  'reason', 'turnId', 'audioIn', 'scFields', 'tool', 'evidence',
  'detail', 'provider',
];

// Bounded so one fat payload cannot bloat a vault line. Strings clipped, arrays
// capped, objects serialized-then-clipped — deliberately non-recursive, because
// a recursive walk over an attacker- or model-shaped object is its own hazard.
const FIELD_MAX_CHARS = 500;
const ARRAY_MAX = 40;

function clipValue(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return v.length > FIELD_MAX_CHARS ? v.slice(0, FIELD_MAX_CHARS) : v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.slice(0, ARRAY_MAX).map(clipValue);
  try {
    const json = JSON.stringify(v);
    if (json === undefined) return '[unserializable]';
    if (json.length <= FIELD_MAX_CHARS) return v;
    return json.slice(0, FIELD_MAX_CHARS);
  } catch (_) {
    return '[unserializable]';
  }
}

// `eventId` is the join key for the anomaly/healer-verdict PAIR. Every anomaly is
// written twice — once by the health.anomaly subscriber, once by the
// health.healed subscriber, because the healer emits health.healed on EVERY
// diagnosis outcome including no-match. The two records are not redundant (one is
// "this happened", the other is "the healer's verdict"), so neither is removed;
// but with no shared key, 2026-08-14's "238 anomalies" was really ~119 events
// counted twice and every tally made from the vault was inflated 2x.
function anomalyDetail(payload, eventId) {
  const p = payload || {};
  const out = {};
  for (let i = 0; i < ANOMALY_DETAIL_FIELDS.length; i += 1) {
    const field = ANOMALY_DETAIL_FIELDS[i];
    if (p[field] === undefined) continue;
    out[field] = clipValue(p[field]);
  }
  if (eventId) out.eventId = eventId;
  return out;
}

// The summary's fallback chain, shared so the subscriber and the test agree on
// it. `reason` sits behind `error` and ahead of `target`: a payload carrying only
// a reason used to store a summary that ended in a bare dash.
function anomalySummaryDetail(payload) {
  const p = payload || {};
  return p.error || p.reason || p.target || p.tool || '';
}

module.exports = {
  ANOMALY_DETAIL_FIELDS,
  FIELD_MAX_CHARS,
  ARRAY_MAX,
  anomalyDetail,
  anomalySummaryDetail,
};
