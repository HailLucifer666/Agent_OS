'use strict';

// immune/diagnostician.js — classifies raw 'health.anomaly' events into typed
// diagnoses and re-emits 'health.diagnosed'. Both strings are exact, do not paraphrase.
// Subscribes to EVERY 'health.anomaly' event, including ones with no matching
// playbook (e.g. 'causal-loop', already emitted by bus/index.js's own depth guard) —
// diagnosis + audit trail exist independent of whether an automated heal is possible.

const { SEED_PLAYBOOKS } = require('./healer');

const SEVERITY = {
  'cortex-stall':       'critical',
  'causal-loop':        'critical',
  'provider-down':      'major',
  'effector-flapping':  'major',
  'budget-exhausted':   'major',
  // 2026-08-20: 'event-storm' (major) and 'tick-overrun' (minor) were REMOVED,
  // not corrected. Nothing in src/ or server/ ever emitted either one, so both
  // rows classified a condition that cannot occur while reading as coverage of
  // a bus storm and a stalled loop. The real signals are elsewhere and are not
  // anomalies: the storm guard emits 'perception.coalesced' (bus/index.js:49)
  // and the only overrun signal is logger.warn('loop.stalled')
  // (loop-lag.js:51). Deliberately deleted rather than wired — giving either a
  // severity requires a real emitter AND a healer playbook, which is a feature,
  // not a table fix. Re-add in the same commit that adds an emitter.
  // test/anomaly-kind-conformance.test.js now fails on any phantom kind here.
  'memory-growth':      'minor',
  'quota-low':          'minor',
  // reflection.js:215 emits this when reflectOnActions spots a repeated
  // failure pattern. Without an entry it defaulted to 'minor' and — worse —
  // the healer had no playbook for it (the half-built learning loop), so the
  // signal died in the no-match path. Now both the severity and the healer's
  // recurring-failure-record playbook handle it.
  'recurring-failure':  'major',
  // 2026-08-10: the entity answering the operator while storing nothing they
  // said. Not cosmetic and not minor — episodic memory is what recall and
  // session carryover read, so every occurrence is a permanent hole in what
  // MYTHOS can remember of the conversation. live-session.js emits it.
  'live-turn-no-user-transcript': 'major'
};

function severityOf(kind) {
  return SEVERITY[kind] || 'minor';
}

// Best-effort hint only (kind-only match). Healer performs the authoritative,
// target-aware match against the full diagnosis independently — see Spec
// Ambiguities Resolved #13.
function playbookLookup(kind) {
  const hit = SEED_PLAYBOOKS.find(function(p) { return p.when.kind === kind; });
  return hit ? hit.id : null;
}

// B2 (2026-08-14): sourceEventId is the bus id of the health.anomaly event this
// diagnosis came from, threaded through so the healer's health.healed can carry
// it and the two episodic records written for one event (the anomaly, and the
// healer's verdict) become countable as a pair. Without it, every tally made
// from the vault was inflated 2x — 2026-08-14's "238 anomalies" was ~119 events.
// Optional and defaulted, so every existing caller (and test) that passes only
// the payload keeps working and simply gets a null.
function diagnose(anomaly, sourceEventId) {
  anomaly = anomaly || {};
  return {
    kind: anomaly.kind,
    target: anomaly.target,
    evidence: anomaly,
    severity: severityOf(anomaly.kind),
    suggestedAction: playbookLookup(anomaly.kind),
    sourceEventId: sourceEventId || null
  };
}

function createDiagnostician({ bus }) {
  if (!bus) throw new Error('createDiagnostician requires bus');

  function onAnomaly(event) {
    const diagnosis = diagnose(event.payload, event && event.id);
    // 'health.diagnosed' — exact string, do not paraphrase.
    bus.emit('health.diagnosed', diagnosis);
  }

  let unsubscribe = null;

  function start() {
    unsubscribe = bus.subscribe('health.anomaly', onAnomaly);
  }

  function stop() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  }

  return { start: start, stop: stop, diagnose: diagnose, severityOf: severityOf, playbookLookup: playbookLookup };
}

module.exports = { createDiagnostician: createDiagnostician, diagnose: diagnose, severityOf: severityOf, playbookLookup: playbookLookup };
