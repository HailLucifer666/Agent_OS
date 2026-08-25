'use strict';

// risk-classifier.js — classifies work at capture time to scale gate rigor.
// tiny-fix: typo/rename → build only, skip review
// quick-win: add/update → build → verify → ship
// feature: new page/build/create → full P22 gate (research → build → visual → review)
// architecture-change: refactor/redesign/migrate → full gate + ADR

var keywordMatch = require('./keyword-match');

var KEYWORDS = {
  'tiny-fix': ['typo', 'rename', 'fix spelling', 'fix a bug', 'small fix', 'quick fix', 'cosmetic', 'text change', 'color change'],
  'architecture-change': ['refactor', 'architect', 'redesign', 'migrate', 'rewrite', 'restructure', 'overhaul', 're-architect'],
  'feature': ['new page', 'build', 'create', 'design', 'develop', 'implement', 'landing page', 'dashboard', 'application', 'platform', 'system'],
  'quick-win': ['add', 'update', 'modify', 'change', 'improve', 'enhance', 'extend', 'adjust', 'configure'],
};

// Gate path definitions — what phases are required for each risk class
var GATE_PATHS = {
  'tiny-fix': ['artifact'],
  // 2026-08-22, BUG-304: 'verify' REMOVED, on the same precedent as 'adr' below
  // and for a stronger version of the same reason. 'adr' at least named a
  // document someone might one day produce; 'verify' appeared in exactly two
  // places in the whole of src/ — this table, demanding it, and
  // evidence-validator.js's header comment, listing it. No code produced it and
  // no code checked it, so quick-win advertised a two-phase gate and ran a
  // one-phase one. The validator now throws on a phase it cannot check, so
  // re-adding this name without its check is no longer possible quietly.
  'quick-win': ['artifact'],
  'feature': ['research', 'artifact', 'visual', 'review'],
  // 2026-08-20: 'adr' REMOVED from architecture-change. It is deliberately not
  // required: no ADR generator exists in this repo, so gating on an artifact
  // nothing produces is a deadlock, not a stricter gate. Re-add to gatePath()
  // in the same commit that adds a producer — and add the matching check in
  // evidence-validator.js, which is where the phase was declared-but-unenforced
  // for as long as it sat here. test/evidence-gate-visual-and-adr.test.js fails
  // if 'adr' reappears in any gate path.
  'architecture-change': ['research', 'artifact', 'visual', 'review'],
};

// Checked in order of specificity, most specific first. architecture-change
// before feature so a "redesign" is not merely a "design"; tiny-fix before
// feature so genuine low-risk work is not over-gated.
var ORDER = ['architecture-change', 'tiny-fix', 'feature', 'quick-win'];

// BUG-309: this used String.indexOf, with no word boundary. A spec saying
// "base 16px typography using Geist font pairing" therefore matched the
// tiny-fix keyword 'typo', and a from-scratch landing-page build was gated as
// a typo fix — gatePath() collapsed to ['artifact'], so research, review and
// the visual gate were all skipped and the resolved design system was thrown
// away. Measured on the shipped card pipe-1787402245811-455.json, risk
// "tiny-fix", against two near-identical earlier cards that read "feature".
//
// indexOf was ALSO too tight in the other direction, which the regression test
// for this found: 'migrate' never matched "migrating" or "migration", so
// architecture-change missed its own most common phrasing. keyword-match.js
// fixes both directions at once — see its header for why a plain \bword\b
// would have broken "adding" / "updated" / "renamed".
function classify(text) {
  if (!text) return 'feature';
  for (var i = 0; i < ORDER.length; i++) {
    if (keywordMatch.matchesAny(text, KEYWORDS[ORDER[i]])) return ORDER[i];
  }
  // Default: feature-level rigor (safer to over-check than under-check)
  return 'feature';
}

function gatePath(riskClass) {
  return GATE_PATHS[riskClass] || GATE_PATHS['feature'];
}

function requiresReview(riskClass) {
  var path = gatePath(riskClass);
  return path.indexOf('review') !== -1;
}

function requiresResearch(riskClass) {
  var path = gatePath(riskClass);
  return path.indexOf('research') !== -1;
}

function requiresVisual(riskClass) {
  var path = gatePath(riskClass);
  return path.indexOf('visual') !== -1;
}

function createRiskClassifier() {
  return { classify: classify, gatePath: gatePath, requiresReview: requiresReview, requiresResearch: requiresResearch, requiresVisual: requiresVisual };
}

module.exports = { createRiskClassifier: createRiskClassifier, classify: classify, gatePath: gatePath, requiresReview: requiresReview, requiresResearch: requiresResearch, requiresVisual: requiresVisual, _KEYWORDS: KEYWORDS, _GATE_PATHS: GATE_PATHS };
