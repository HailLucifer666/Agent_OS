'use strict';

// promoted-rank-anomaly.js — BUG-275 H1, the reporting half.
//
// WHY THIS IS A MODULE AND NOT FOUR LINES IN THE ADAPTER. Two reasons, and the
// second is the important one. live-tool-adapter.js is at its file-size ratchet
// ceiling, so new logic has to leave it. And the adapter's four other turn
// audits all run through reportTurnAudit, whose every path ends in
// sendSystemNotice — MYTHOS telling the operator aloud that it was wrong. This
// one must NOT, and a loop sitting among those four is one careless edit away
// from being "tidied" into the same helper. A separate file with this comment on
// top is the cheapest way to make that edit visible.
//
// THE DECISION, operator, 2026-09-10: H1 gets a prompt rule plus a SILENT
// anomaly, never a spoken retraction. The RANK RULE in voice-agent.js does the
// live work. This is telemetry for the next corpus replay.
//
// WHY SPEECH WOULD BE WRONG HERE, specifically. The other detectors prove a
// tool did or did not run; this one reads a structure classification of web
// prose, which is a model of a document and can be wrong in a way a tool
// outcome cannot. A false positive would tell MYTHOS to retract a TRUE
// statement — the single error claim-check.js's header forbids outright.
// Promoting this to a spoken correction re-opens that question and needs its own
// review; it is not a one-line change, by construction.

const { detectPromotedRankedEntities } = require('./ranked-claim-check');

function reasonFor(promoted) {
  const them = promoted.length > 1 ? 'them' : 'it';
  return 'the reply gave ' + promoted.join(', ') + ' a rank position, but the evidence only '
    + 'mentioned ' + them + ' in passing rather than ranking ' + them;
}

// `reason` is mandatory and not decorative: immune/explainer.js narrates an
// unplaybooked anomaly from `target` + `reason`, so an anomaly without one is
// announced as an unexplained fault (2026-08-10). It is also what
// bug-275-evidence-digest-reaches-the-ledger.test.js asserts for every detector
// in this family.
function reportPromotedRanks({ bus, assistantText, actionsThisTurn, recentActions }) {
  if (!bus || typeof bus.emit !== 'function') return 0;
  const hits = detectPromotedRankedEntities(assistantText, actionsThisTurn, recentActions);
  for (const hit of hits) {
    bus.emit('health.anomaly', {
      kind: hit.kind, tool: 'promoted-ranked-entity', target: 'promoted-ranked-entity',
      claim: hit.sentence, promoted: hit.promoted, sawTools: hit.sawTools,
      reason: reasonFor(hit.promoted),
    });
  }
  return hits.length;
}

module.exports = { reportPromotedRanks, reasonFor };
