'use strict';

// BUG-350 (2026-08-24): retry guidance. The verifier's hard-fail rules were
// echoed back to the builder as bare rule names ('missing required design
// element: cta') — the measured @media wave (2/9 -> 8/9 once the contract was
// stated in the prompt) proved builds comply when the requirement is spelled
// out. retryGuidanceFor() maps each violated rule to its contract clause; the
// build-runner appends it to the regenerate prompt.

const test = require('node:test');
const assert = require('node:assert/strict');
const { retryGuidanceFor } = require('../src/core/design/verify.js');

test('each known rule maps to its contract clause', () => {
  const out = retryGuidanceFor([
    'missing required design element: cta',
    'no @media queries (not responsive)',
    "Title 'Major AI News' is an invented brand/topic",
    'placeholder content detected (lorem ipsum)',
  ]);
  assert.match(out, /class contains "cta"/);
  assert.match(out, /@media breakpoints/);
  assert.match(out, /words taken from the spec itself/);
  assert.match(out, /lorem-ipsum fragment/);
  assert.match(out, /Contract clauses your regenerated output must satisfy:/);
});

test('unknown issues fall through to a verbatim fix instruction — nothing softens', () => {
  const out = retryGuidanceFor(['mystery rule alpha']);
  assert.match(out, /Fix this exactly as stated: mystery rule alpha/);
});

test('empty issues produce empty guidance (no noise on a pass)', () => {
  assert.strictEqual(retryGuidanceFor([]), '');
});
