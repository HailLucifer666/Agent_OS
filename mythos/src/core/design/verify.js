'use strict';

// design/verify.js — post-generation verification for build deliverables.
// Runs a quick brain.think({lane:'simple'}) self-check against the generated
// content. Returns {pass, issues}. If fail, the build runner retries once with
// the issues appended to the prompt.

function createVerifier({ brain }) {
  if (!brain || typeof brain.think !== 'function') {
    return { verify: function() { return Promise.resolve({ pass: true, issues: [] }); } };
  }

  async function verify(raw, spec) {
    // Quick structural checks first (no LLM call)
    var issues = [];
    var content = String(raw || '');

    if (!content.trim()) {
      return { pass: false, issues: ['empty output'] };
    }
    if (/<!DOCTYPE html/i.test(content)) {
      if (!/<title>[^<]+<\/title>/i.test(content)) issues.push('missing <title> tag');
      if (!/<meta[^>]+viewport/i.test(content)) issues.push('missing viewport meta tag (not responsive)');
      if (!/@media/i.test(content)) issues.push('no @media queries (not responsive)');
    }

    // If structural checks pass, do a quick LLM self-check
    if (issues.length === 0) {
      try {
        var result = await brain.think({
          lane: 'simple',
          messages: [{ role: 'user', content:
            'Check this HTML deliverable against the spec. Spec: "' +
            String(spec || '').slice(0, 200) +
            '". Does the deliverable match the spec topic? Is the title derived from the spec (not an invented brand name)? ' +
            'Respond as JSON: {"pass": true/false, "issues": ["issue1", "issue2"]}\n\n' +
            'Deliverable (first 500 chars): ' + content.slice(0, 500)
          }],
          schemaHint: '{ pass: boolean, issues: string[] }',
          source: 'build-verifier',
        });
        if (result && !result.offline && result.parsed) {
          if (result.parsed.pass === false && Array.isArray(result.parsed.issues)) {
            issues = issues.concat(result.parsed.issues);
          }
        }
      } catch (_) { /* verifier LLM call is best-effort — don't block builds on it */ }
    }

    return { pass: issues.length === 0, issues: issues };
  }

  return { verify: verify };
}

module.exports = { createVerifier: createVerifier };
