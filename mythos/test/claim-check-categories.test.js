'use strict';

// F1b (2026-08-15) — the claim-check category table is a hand-maintained copy of
// tool names that the system already knows from leash/tiers.js's TIER_TABLE.
// In the 2026-08-14 session the `searching` category listed only the two
// code-search tools, so a turn that really called web_search was scored
// `claimed-action-not-taken` and MYTHOS was told to retract a TRUE statement.
//
// These tests derive from the source of truth rather than restating the list, so
// a renamed or removed tool fails here instead of silently degrading the
// detector into a liar.

const test = require('node:test');
const assert = require('node:assert');

const { CLAIM_CATEGORIES, detectUnbackedClaims } = require('../src/core/voice/claim-check');
const { TIER_TABLE } = require('../src/core/leash/tiers');

test('every tool named in a claim category is a real tool', () => {
  const unknown = [];
  for (const cat of CLAIM_CATEGORIES) {
    // BUG-434 (2026-09-10): backingTools joined the table and this guard read
    // only cat.tools, so the new list was the one thing in the file nothing
    // derived from TIER_TABLE — F1b again, in the guard against F1b.
    for (const tool of [...cat.tools, ...(cat.backingTools || [])]) {
      if (!Object.prototype.hasOwnProperty.call(TIER_TABLE, tool)) {
        unknown.push(cat.name + ':' + tool);
      }
    }
  }
  assert.deepStrictEqual(unknown, [],
    'claim-check names tools that do not exist in TIER_TABLE: ' + unknown.join(', '));
});

test('a backing tool is never also an owned tool of any category', () => {
  // BUG-434: backingTools back a claim without being the category own tools.
  // If a tool were both, `owned by exactly one category` and `backs another`
  // would disagree about what a failure of it means, and the elliptical tier
  // (gated on an owned tool attempted-and-unproven) would silently change shape.
  const owned = new Set(CLAIM_CATEGORIES.flatMap((c) => c.tools));
  const clash = [];
  for (const cat of CLAIM_CATEGORIES) {
    for (const tool of cat.backingTools || []) if (owned.has(tool)) clash.push(cat.name + ":" + tool);
  }
  assert.deepStrictEqual(clash, [], 'a backing tool is owned by a category: ' + clash.join(', '));
});

test('no tool is claimed by two categories', () => {
  const owner = new Map();
  const dupes = [];
  for (const cat of CLAIM_CATEGORIES) {
    for (const tool of cat.tools) {
      if (owner.has(tool)) dupes.push(tool + ' in ' + owner.get(tool) + ' and ' + cat.name);
      else owner.set(tool, cat.name);
    }
  }
  assert.deepStrictEqual(dupes, [], 'overlapping claim categories: ' + dupes.join('; '));
});

test('the searching category covers the web tools, not only code search', () => {
  const searching = CLAIM_CATEGORIES.find((c) => c.name === 'searching');
  assert.ok(searching, 'searching category must exist');
  for (const tool of ['web_search', 'web_fetch']) {
    assert.ok(searching.tools.includes(tool),
      tool + ' must be in the searching category — this is the exact regression '
      + 'that made MYTHOS retract a true "I searched the web" claim');
  }
});

test('a successful web_search backs an "I searched" claim', () => {
  const claims = detectUnbackedClaims(
    'I searched the web for the latest release notes.',
    [{ tool: 'web_search', ok: true }],
  );
  assert.deepStrictEqual(claims, [],
    'a real web_search must back the claim — flagging it injects a false correction');
});

test('an "I searched" claim with no search tool at all is still flagged', () => {
  const claims = detectUnbackedClaims(
    'I searched the web for the latest release notes.',
    [{ tool: 'media_status', ok: true }],
  );
  assert.strictEqual(claims.length, 1, 'the detector must still catch a genuinely unbacked claim');
  assert.strictEqual(claims[0].category, 'searching');
});

test('a FAILED web_search does not back an "I searched" claim', () => {
  const claims = detectUnbackedClaims(
    'I searched the web for the latest release notes.',
    [{ tool: 'web_search', ok: false }],
  );
  assert.strictEqual(claims.length, 1, 'ok:false is not backing');
});
