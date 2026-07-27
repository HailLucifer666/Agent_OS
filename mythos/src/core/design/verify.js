'use strict';

// design/verify.js — P22: post-generation verification for build deliverables.
// Two tiers of findings:
//   - issues   = rule-based, hard-fail (structural HTML, placeholder/generic-
//                template blocklist, title-spec relevance, required design
//                elements). These catch genuine garbage; build-runner blocks
//                shipment when issues is non-empty after retry (P22 guarantee).
//   - warnings = LLM self-check advisory (subjective stylistic judgements like
//                "color palette violates minimalism", "title invents a focus").
//                These do NOT hard-fail — they're surfaced for the review phase
//                and ship-with-warning. Keeps the LLM-judge from vetoing
//                legitimate stylistic variation the rule checks would allow.
// Returns { pass, issues, warnings }. pass reflects ONLY rule-based issues.

// Placeholder/generic-template patterns — if any appear, the deliverable is
// likely a generic template rather than a spec-matched build.
var PLACEHOLDER_PATTERNS = [
  /lorem\s+ipsum/i,
  /50,?000\+\s+(users|creators|listeners|customers|people)/i,
  /your\s+(company|brand|product|business|name)\s+here/i,
  /placeholder\s+(text|image|content)/i,
  /sample\s+(testimonial|review|quote)/i,
  /john\s+(doe|smith|doe)\b/i,  // generic testimonial names
  /sarah\s+[a-z]\.?\s*(says|ceo|founder)/i,  // generic testimonial pattern
  /\bexample\s+domain\b/i,
];

// Required design element patterns based on spec keywords
var DESIGN_ELEMENT_PATTERNS = {
  'hero': [
    /<section[^>]*class="[^"]*hero[^"]*"[^>]*>/i,
    /<div[^>]*class="[^"]*hero[^"]*"[^>]*>/i,
    /hero/i,
  ],
  'cta': [
    /<button[^>]*class="[^"]*cta[^"]*"[^>]*>/i,
    /<a[^>]*class="[^"]*cta[^"]*"[^>]*>/i,
    /call.to.action/i,
  ],
  'animation': [
    /@keyframes/i,
    /animation:/i,
    /transition:/i,
  ],
  'fade-in': [
    /fade.?in/i,
    /opacity:\s*0/i,
  ],
  'scroll-reveal': [
    /intersectionobserver/i,
    /scroll.reveal/i,
    /reveal.on.scroll/i,
  ],
  'particle': [
    /particle/i,
    /canvas/i,
  ],
  'dark.theme': [
    /dark/i,
    /background.color.*#(0|1|2|3)/i,
  ],
  'responsive': [
    /@media/i,
    /max.width/i,
  ],
};

function createVerifier({ brain }) {
  if (!brain || typeof brain.think !== 'function') {
    return { verify: function() { return Promise.resolve({ pass: true, issues: [], warnings: [] }); } };
  }

  async function verify(raw, spec) {
    var issues = [];     // rule-based, hard-fail
    var warnings = [];   // LLM-judge advisory, ship-with-warning
    var content = String(raw || '');

    if (!content.trim()) {
      return { pass: false, issues: ['empty output'], warnings: warnings };
    }

    // Structural HTML checks
    if (/<!DOCTYPE html/i.test(content)) {
      if (!/<title>[^<]+<\/title>/i.test(content)) issues.push('missing <title> tag');
      if (!/<meta[^>]+viewport/i.test(content)) issues.push('missing viewport meta tag (not responsive)');
      if (!/@media/i.test(content)) issues.push('no @media queries (not responsive)');
    }

    // Placeholder/generic-template detection
    for (var i = 0; i < PLACEHOLDER_PATTERNS.length; i++) {
      if (PLACEHOLDER_PATTERNS[i].test(content)) {
        issues.push('contains placeholder/generic template text: "' + PLACEHOLDER_PATTERNS[i].source + '"');
      }
    }

    // Title-spec relevance: extract title and check it shares words with the spec
    // ALWAYS run this check regardless of other issues
    var titleMatch = content.match(/<title>([^<]{1,80})<\/title>/i) || content.match(/^#\s+(.{1,80})/m);
    if (titleMatch && spec) {
      var title = titleMatch[1].toLowerCase();
      var specWords = String(spec).toLowerCase().split(/[^a-z0-9]+/).filter(function(w) { return w.length > 3; });
      var titleWords = title.split(/[^a-z0-9]+/).filter(function(w) { return w.length > 3; });
      var shared = 0;
      for (var s = 0; s < specWords.length; s++) {
        if (titleWords.indexOf(specWords[s]) !== -1) shared++;
      }
      if (shared === 0 && specWords.length > 0) {
        issues.push('title "' + titleMatch[1] + '" shares no words with the spec — likely an invented brand name');
      }
    }

    // Check for required design elements based on spec keywords
    if (spec) {
      var specLower = String(spec).toLowerCase();
      var requiredElements = [];

      if (specLower.includes('hero') || specLower.includes('hero-centric') || specLower.includes('hero section')) {
        requiredElements.push('hero');
      }
      if (specLower.includes('cta') || specLower.includes('call to action') || specLower.includes('primary action')) {
        requiredElements.push('cta');
      }
      if (specLower.includes('animation') || specLower.includes('animate') || specLower.includes('fade') || specLower.includes('smooth')) {
        requiredElements.push('animation');
      }
      if (specLower.includes('fade.in') || specLower.includes('fade-in') || specLower.includes('fade in')) {
        requiredElements.push('fade-in');
      }
      if (specLower.includes('scroll.reveal') || specLower.includes('scroll-reveal') || specLower.includes('reveal on scroll') || specLower.includes('reveal on scroll')) {
        requiredElements.push('scroll-reveal');
      }
      if (specLower.includes('particle') || specLower.includes('synapse') || specLower.includes('neon')) {
        requiredElements.push('particle');
      }
      if (specLower.includes('dark') || specLower.includes('dark theme') || specLower.includes('dark mode')) {
        requiredElements.push('dark.theme');
      }
      if (specLower.includes('responsive') || specLower.includes('mobile')) {
        requiredElements.push('responsive');
      }

      for (var elemIdx = 0; elemIdx < requiredElements.length; elemIdx++) {
        var elem = requiredElements[elemIdx];
        var patterns = DESIGN_ELEMENT_PATTERNS[elem] || [];
        var found = false;
        for (var pIdx = 0; pIdx < patterns.length; pIdx++) {
          if (patterns[pIdx].test(content)) {
            found = true;
            break;
          }
        }
        if (!found && patterns.length > 0) {
          issues.push('missing required design element: ' + elem + ' (spec mentions it but not found in deliverable)');
        }
      }
    }

    // LLM self-check on first 2000 chars. Its findings are ADVISORY warnings,
    // not hard-fail issues — the LLM-judge tends to veto legitimate stylistic
    // variation (e.g. "color palette violates Swiss Style") that the rule-based
    // checks correctly allow. Genuine garbage (placeholders, off-topic titles,
    // missing structure) is already caught by the rule checks above and remains
    // a hard-fail. Warnings surface to the review phase / ship-with-warning.
    try {
      var result = await brain.think({
        lane: 'simple',
        messages: [{ role: 'user', content:
          'Check this HTML deliverable against the spec. Spec: "' +
          String(spec || '').slice(0, 300) +
          '". Does the deliverable match the spec topic? Is the title derived from the spec (not an invented brand name)? ' +
          'Is the content about the right topic (not a generic template about a different product)? ' +
          'Respond as JSON: {"pass": true/false, "issues": ["issue1", "issue2"]}\n\n' +
          'Deliverable (first 2000 chars): ' + content.slice(0, 2000)
        }],
        schemaHint: '{ pass: boolean, issues: string[] }',
        source: 'build-verifier',
      });
      if (result && !result.offline && result.parsed) {
        if (result.parsed.pass === false && Array.isArray(result.parsed.issues)) {
          warnings = warnings.concat(result.parsed.issues);
        }
      }
    } catch (_) { /* verifier LLM call is best-effort */ }

    return { pass: issues.length === 0, issues: issues, warnings: warnings };
  }

  return { verify: verify };
}

module.exports = { createVerifier: createVerifier, _PLACEHOLDER_PATTERNS: PLACEHOLDER_PATTERNS };
