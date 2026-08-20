'use strict';

// risk-classifier.js — classifies work at capture time to scale gate rigor.
// tiny-fix: typo/rename → build only, skip review
// quick-win: add/update → build → verify → ship
// feature: new page/build/create → full P22 gate (research → build → visual → review)
// architecture-change: refactor/redesign/migrate → full gate + ADR

var KEYWORDS = {
  'tiny-fix': ['typo', 'rename', 'fix spelling', 'fix a bug', 'small fix', 'quick fix', 'cosmetic', 'text change', 'color change'],
  'architecture-change': ['refactor', 'architect', 'redesign', 'migrate', 'rewrite', 'restructure', 'overhaul', 're-architect'],
  'feature': ['new page', 'build', 'create', 'design', 'develop', 'implement', 'landing page', 'dashboard', 'application', 'platform', 'system'],
  'quick-win': ['add', 'update', 'modify', 'change', 'improve', 'enhance', 'extend', 'adjust', 'configure'],
};

// Gate path definitions — what phases are required for each risk class
var GATE_PATHS = {
  'tiny-fix': ['artifact'],
  'quick-win': ['artifact', 'verify'],
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

function classify(text) {
  if (!text) return 'feature';
  var lower = String(text).toLowerCase();

  // Check in order of specificity (most specific first)
  // architecture-change: check before feature because "redesign" could contain "design"
  for (var i = 0; i < KEYWORDS['architecture-change'].length; i++) {
    if (lower.indexOf(KEYWORDS['architecture-change'][i]) !== -1) return 'architecture-change';
  }
  // tiny-fix: highest priority for low-risk work
  for (var j = 0; j < KEYWORDS['tiny-fix'].length; j++) {
    if (lower.indexOf(KEYWORDS['tiny-fix'][j]) !== -1) return 'tiny-fix';
  }
  // feature: new creation
  for (var k = 0; k < KEYWORDS['feature'].length; k++) {
    if (lower.indexOf(KEYWORDS['feature'][k]) !== -1) return 'feature';
  }
  // quick-win: modifications
  for (var l = 0; l < KEYWORDS['quick-win'].length; l++) {
    if (lower.indexOf(KEYWORDS['quick-win'][l]) !== -1) return 'quick-win';
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
