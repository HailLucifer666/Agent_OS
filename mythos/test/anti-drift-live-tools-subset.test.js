'use strict';

// test/anti-drift-live-tools-subset.test.js — AD-3 from
// mythos/Plans/MYTHOS-IRIS-Synthesis-Plan-V2-spine.md §1: "Tool declarations
// derive from the hub. Gemini functionDeclarations are generated from
// buildCatalogFromHub(effectors). No hand-maintained parallel list."
// Executable check, verbatim from the spine's own table: assert every
// declared name is in hub.catalog() names, and that a fake newly-registered
// effector shows up automatically with zero changes to live-tools.js.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildFunctionDeclarations } = require('../src/core/voice/live-tools');

function fakeHub(entries) {
  return { catalog: () => entries };
}

describe('AD-3: declared tool names are always a subset of hub.catalog()', () => {
  test('subset property holds for an arbitrary hub + allowlist', () => {
    const hubEntries = [
      { name: 'navigate', description: 'nav', params: {} },
      { name: 'get_time', description: 'time', params: {} },
      { name: 'not_on_allowlist', description: 'x', params: {} },
    ];
    const hub = fakeHub(hubEntries);
    const hubNames = new Set(hubEntries.map((e) => e.name));
    const { declarations } = buildFunctionDeclarations(hub, { allowlist: ['navigate', 'get_time', 'nonexistent_tool'] });

    for (const decl of declarations) {
      assert.ok(hubNames.has(decl.name), `declared name "${decl.name}" must exist in hub.catalog()`);
    }
    // 'nonexistent_tool' was allowlisted but never registered on the hub — it
    // must never appear as a declaration (AD-3: no hand-maintained parallel list).
    assert.ok(!declarations.some((d) => d.name === 'nonexistent_tool'));
  });

  test('a brand-new effector reaches Live with zero changes to live-tools.js, as long as it is allowlisted', () => {
    // Simulates: an engineer registers a new effector on the real hub tomorrow.
    // buildFunctionDeclarations must pick it up automatically via
    // buildCatalogFromHub(hub) — never by someone remembering to add a line here.
    const hub = fakeHub([
      { name: 'navigate', description: 'nav', params: {} },
      { name: 'brand_new_tool_nobody_wrote_here_yet', description: 'A tool added tomorrow.', params: { thing: 'string' } },
    ]);
    const { declarations, withheld } = buildFunctionDeclarations(hub, {
      allowlist: ['navigate', 'brand_new_tool_nobody_wrote_here_yet'],
    });
    const names = declarations.map((d) => d.name);
    assert.ok(names.includes('brand_new_tool_nobody_wrote_here_yet'), 'a newly-registered, allowlisted effector must be declared automatically');
    assert.ok(!withheld.includes('brand_new_tool_nobody_wrote_here_yet'));
  });

  test('an effector absent from the allowlist is withheld, not silently vanished', () => {
    const hub = fakeHub([
      { name: 'navigate', description: 'nav', params: {} },
      { name: 'quietly_new_tool', description: 'new', params: {} },
    ]);
    const { withheld } = buildFunctionDeclarations(hub, { allowlist: ['navigate'] });
    assert.ok(withheld.includes('quietly_new_tool'), 'a real hub tool not on the allowlist must show up in withheld, not disappear');
  });
});
