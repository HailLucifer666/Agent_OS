'use strict';

// design/verify.js — P22: post-generation verification for build deliverables.
// Structural checks (title, viewport, responsive, placeholder detection) +
// LLM self-check on first 2000 chars (up from 500). Returns {pass, issues}.
// build-runner.js blocks shipment on failure after retry (P22 change).

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

function createVerifier({ brain }) {
  if (!brain || typeof brain.think !== 'function') {
    return { verify: function() { return Promise.resolve({ pass: true, issues: [] }); } };
  }

  async function verify(raw, spec) {
    var issues = [];
    var content = String(raw || '');

    if (!content.trim()) {
      return { pass: false, issues: ['empty output'] };
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

    // LLM self-check on first 2000 chars (up from 500 — checks more meaningful content)
    if (issues.length === 0) {
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
            issues = issues.concat(result.parsed.issues);
          }
        }
      } catch (_) { /* verifier LLM call is best-effort */ }
    }

    return { pass: issues.length === 0, issues: issues };
  }

  return { verify: verify };
}

module.exports = { createVerifier: createVerifier, _PLACEHOLDER_PATTERNS: PLACEHOLDER_PATTERNS };
