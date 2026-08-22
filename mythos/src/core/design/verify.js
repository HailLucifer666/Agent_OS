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
// Shared with risk-classifier.js — see keyword-match.js's header for why
// String.includes was wrong here in both directions.
var keywordMatch = require('../effectors/keyword-match');

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
  // BUG-173: these were hand-written-CSS patterns only, so an artifact that
  // animates through a LIBRARY — Tailwind/animate.css utility classes, a
  // framer-motion or GSAP import, a Web Animations API call — matched nothing
  // and the whole build hard-failed as "missing required design element:
  // animation". Two of the 2026-08-07 session's builds died exactly there
  // while being visibly animated. Broadened to what animation actually looks
  // like in shipped markup; see SOFT_ELEMENTS below for why a miss here is
  // now a warning rather than a hard fail.
  'animation': [
    /@keyframes/i,
    /animation[-:]/i,
    /transition[-:]/i,
    /\banimate[-_]/i,              // animate-fade-in, animate__animated, animate-bounce
    /framer-motion|gsap|anime\.js|motion\/react|@motionone/i,
    /\.animate\s*\(/i,             // Web Animations API / jQuery
    /data-aos[=\s]/i,              // AOS (animate-on-scroll)
    /\btransform:\s*(?!none)/i,
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

// BUG-173: elements whose absence warns instead of failing the build. All
// four are MOTION — expressible a dozen ways, so an unmatched pattern is
// far more likely to mean "the list does not know this library" than "the
// artifact is broken". Structural elements deliberately stay out of this set.
var SOFT_ELEMENTS = new Set(['animation', 'fade-in', 'scroll-reveal', 'particle']);

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

      // BUG-312 (requirement half): these were String.includes, which is wrong
      // in two separate ways and both were live on 2026-08-22.
      //
      // Too loose: 'cta' matched inside "spectacular" (and "octagonal"), 'neon'
      // inside "neonatal", 'mobile' inside "automobile" — so a page could be
      // required to have a call-to-action because the brief called it
      // spectacular. Fixed by matching whole words (keyword-match.js).
      //
      // Negation-blind: a spec reading "light theme, not dark" pushed
      // 'dark.theme' onto requiredElements and then hard-failed the artifact for
      // not being dark. That is the verifier demanding the opposite of the
      // brief, so the requirement side asks negationAware and an explicitly
      // ruled-out element is not required. The PATTERN side (what counts as
      // satisfying the requirement) is a separate defect, handled separately.
      var needs = function (words) {
        return keywordMatch.matchesAny(specLower, words, { negationAware: true });
      };

      if (needs(['hero', 'hero-centric', 'hero section'])) {
        requiredElements.push('hero');
      }
      if (needs(['cta', 'call to action', 'primary action'])) {
        requiredElements.push('cta');
      }
      if (needs(['animation', 'animate', 'fade', 'smooth'])) {
        requiredElements.push('animation');
      }
      // 'fade.in' was a literal dot in a String.includes call, so it could only
      // ever match the exact text "fade.in", which no brief writes. Dropped
      // rather than carried forward as a dead alternative; 'fade-in'/'fade in'
      // are the real spellings and matchesAny normalises the separator.
      if (needs(['fade-in', 'fade in'])) {
        requiredElements.push('fade-in');
      }
      // Same for 'scroll.reveal', and 'reveal on scroll' was listed twice.
      if (needs(['scroll-reveal', 'scroll reveal', 'reveal on scroll'])) {
        requiredElements.push('scroll-reveal');
      }
      if (needs(['particle', 'synapse', 'neon'])) {
        requiredElements.push('particle');
      }
      if (needs(['dark', 'dark theme', 'dark mode'])) {
        requiredElements.push('dark.theme');
      }
      if (needs(['responsive', 'mobile'])) {
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
          var message = 'missing required design element: ' + elem +
            ' (spec mentions it but not found in deliverable)';
          // BUG-173: an unmatched MOTION element is a warning, not a hard
          // fail. Motion is expressed a dozen ways and any pattern list is a
          // guess about which one was used, so a miss here is much more likely
          // to be an incomplete list than a defective artifact — and the cost
          // of being wrong is throwing away a finished build. Structural
          // elements (hero, cta, dark theme, responsive) stay hard-fails:
          // those are concrete things the spec asked for, and their absence is
          // the artifact genuinely not being what was ordered.
          if (SOFT_ELEMENTS.has(elem)) warnings.push(message + ' — shipped with a warning');
          else issues.push(message);
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
      // lane 'reasoning' (2026-08-14). The comment above records that this
      // LLM-judge "tends to veto legitimate stylistic variation" — a weak model
      // is exactly what produces that, and it was running on the weakest one.
      // Its findings stay ADVISORY regardless; a better judge makes the advice
      // worth reading, it does not promote it to a hard fail.
      var result = await brain.think({
        lane: 'reasoning',
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
