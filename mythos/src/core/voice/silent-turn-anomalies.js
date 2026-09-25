'use strict';

// silent-turn-anomalies.js — the turn detectors that REPORT and never speak.
//
// live-tool-adapter.js's other turn audits run through reportTurnAudit, and every
// path of that helper ends in sendSystemNotice: MYTHOS saying aloud that it was
// wrong. The detectors here must not, each for a recorded reason — they judge
// the content of prose, so a false positive spoken aloud would make MYTHOS
// retract a true statement:
//
//   promoted-rank-anomaly.js    BUG-275 H1 — a name given a rank its source never
//                               gave it (operator decision, 2026-09-10).
//   spoken-tool-syntax.js       BUG-449 — tool-call syntax spoken aloud; also
//                               never executed.
//   unsearched-current-fact.js  BUG-275 — a changeable fact stated as current
//                               with no web lookup behind it (2026-09-23 replay).
//
// One call site, one module, so a fourth silent detector joins a list whose
// header says why it is silent — instead of a fourth call folded onto one line of
// a file at its size ratchet, which is where the first two lived until
// 2026-09-23. test/bug-275-unsearched-current-fact.test.js pins that nothing this
// file reaches can speak.

const { reportPromotedRanks } = require('./promoted-rank-anomaly');
const { reportSpokenToolSyntax } = require('./spoken-tool-syntax');
const { reportUnsearchedCurrentFacts } = require('./unsearched-current-fact');

function reportSilentTurnAnomalies({ bus, assistantText, actionsThisTurn, recentActions }) {
  return {
    promotedRanks: reportPromotedRanks({ bus, assistantText, actionsThisTurn, recentActions }),
    spokenToolSyntax: reportSpokenToolSyntax({ bus, assistantText, actionsThisTurn }),
    unsearchedCurrentFacts: reportUnsearchedCurrentFacts({ bus, assistantText, actionsThisTurn, recentActions }),
  };
}

module.exports = { reportSilentTurnAnomalies };
