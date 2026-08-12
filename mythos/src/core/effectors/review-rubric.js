'use strict';

// effectors/review-rubric.js — C3: scope the review rubric to what's actually
// being reviewed, and require every [reality] finding to cite the artifact
// text it is judging.
//
// 2026-08-12 voice-session finding: a Snake game and an "Asgardian siege"
// mythology visualisation were both graded against ONE hardcoded reviewer
// criterion (agent-actions.js's REVIEWER_PREAMBLE, added 2026-07-31 for a
// news-digest false positive) — "pricing tiers, certification and security
// badges, testimonials and team bios". Applied to a browser game, it
// produced review issues about a missing pricing table. Separately the
// reality-checker asserted that Space Grotesk (a real, shipped Google Fonts
// typeface) "is not a real, widely recognized font" — a hallucination
// detector that hallucinates makes every [reality] verdict worthless.
//
// There is no artifact "type"/"kind" field on the job or card record
// (checked pipeline.js, kanban.js, build-runner.js). The closest thing that
// already exists on every card is its own spec text (card.text, or
// card.title + card.detail), so the type is classified from that text —
// same approach risk-classifier.js already uses to scale gate rigor — rather
// than inventing a new user-facing field.

var TYPE_KEYWORDS = {
  'game': ['game', 'snake', 'arcade', 'puzzle game', 'platformer', 'playable'],
  'visualisation': [
    'visualization', 'visualisation', 'visualize', 'visualise',
    'diagram', 'infographic', 'mythology', 'mythological', 'siege', 'data viz'
  ],
  'landing-page': [
    'landing page', 'marketing site', 'marketing page', 'product page',
    'sales page', 'saas landing'
  ]
};

// Checked in this order — most specific shapes first — so a spec that
// happens to mention several keywords still lands on the one it's actually
// asking for (a "landing page" phrase inside a game brief is unlikely, but
// game/visualisation are checked ahead of landing-page regardless).
var TYPE_ORDER = ['game', 'visualisation', 'landing-page'];

function classifyArtifactType(specText) {
  var text = String(specText || '').toLowerCase();
  for (var i = 0; i < TYPE_ORDER.length; i++) {
    var type = TYPE_ORDER[i];
    var keywords = TYPE_KEYWORDS[type];
    for (var j = 0; j < keywords.length; j++) {
      if (text.indexOf(keywords[j]) !== -1) return type;
    }
  }
  return 'generic';
}

var REVIEWER_BASE_CRITERIA = [
  '1. Does the deliverable actually fulfil the task? Is it complete and self-contained?',
  '2. Does the title use words from the task spec (not an invented brand name)?',
  '3. Is the content topically related to the task (not a generic template)?',
  '4. Are there placeholder texts, fake testimonials, or fabricated statistics?',
  '5. Does it match any design requirements (dark theme, animations, etc.) from the spec?'
];

// Extra criterion applied ONLY to artifacts actually shaped like a landing
// page/marketing site — a game or visualisation is never checked for these.
// That mismatch (a marketing checklist graded onto a Snake game) is exactly
// the 2026-08-12 defect this module fixes.
var LANDING_PAGE_CRITERION =
  '6. Does it contain sections the task never asked for — pricing tiers, certification or ' +
  'security badges, testimonials, team bios? Extra sections are a defect, not a bonus: ' +
  'flag each one.';

function buildReviewerPreamble(artifactType) {
  var criteria = REVIEWER_BASE_CRITERIA.slice();
  if (artifactType === 'landing-page') criteria.push(LANDING_PAGE_CRITERION);
  return [
    'You are the Kanban Reviewer agent. Review the deliverable below against its task.',
    'You are thorough and honest — you never rubber-stamp. Check ALL of these:'
  ].concat(criteria).concat([
    'Respond with ONLY a JSON object, no commentary, no markdown fence:',
    '{"verdict": "approve" | "reject", "issues": ["specific issue 1", ...], "notes": "1-2 sentences"}'
  ]).join(' ');
}

// ---- Reality check: every finding must cite artifact text ----

var REALITY_CHECK_PREAMBLE = [
  'You are the Reality Checker. Verify that content in the deliverable is factually accurate',
  'and not hallucinated. Flag: invented brand names, fabricated testimonials/quotes, made-up',
  'statistics, generic marketing copy that has nothing to do with the task topic. If the',
  'deliverable is about topic X but contains content about topic Y, flag it as off-topic.',
  'EVERY issue you report MUST include a "citation" field quoting the exact text from the',
  'deliverable that the issue is about — a claim you cannot quote verbatim will be discarded.',
  'Respond with ONLY a JSON object:',
  '{"verdict": "approve" | "reject", ' +
    '"issues": [{"claim": "specific problem", "citation": "exact quote from the deliverable"}]}'
].join(' ');

// Drop any reality finding whose citation is missing, or does not actually
// appear in the artifact text. An unsupported [reality] claim (e.g. "Space
// Grotesk is not a real font") is a hallucination about a hallucination —
// worse than no finding at all, because the operator has no way to tell a
// real catch from a fabricated one apart from every other [reality] line.
// Dropped rather than surfaced, per the same best-effort discipline the
// caller already applies to the checker call itself; logged so the drop is
// still visible when debugging the checker's behaviour.
function filterRealityFindings(issues, content) {
  var haystack = String(content || '');
  var list = Array.isArray(issues) ? issues : [];
  var kept = [];
  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    var isObject = entry && typeof entry === 'object';
    var claim = isObject ? entry.claim : entry;
    var citation = isObject ? entry.citation : null;
    if (!claim || typeof claim !== 'string') continue;
    if (!citation || typeof citation !== 'string' || !citation.trim()) {
      console.warn('[reality-check] dropped uncited finding: ' + claim);
      continue;
    }
    if (haystack.indexOf(citation.trim()) === -1) {
      console.warn('[reality-check] dropped finding whose citation is not in the artifact: ' + claim);
      continue;
    }
    kept.push(claim);
  }
  return kept;
}

module.exports = {
  classifyArtifactType: classifyArtifactType,
  buildReviewerPreamble: buildReviewerPreamble,
  REALITY_CHECK_PREAMBLE: REALITY_CHECK_PREAMBLE,
  filterRealityFindings: filterRealityFindings
};
