'use strict';

// test/live-tools.test.js — Phase 2 (V2 §7, merged-order step 4). Verifies the
// prose->JSON-Schema converter that turns MYTHOS's hand-written param strings
// into Gemini functionDeclarations, plus the allowlist/withheld reporting.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildFunctionDeclarations, DEFAULT_ALLOWLIST, _internal } = require('../src/core/voice/live-tools');
const { parseParam, toDeclaration } = _internal;

function fakeHub(entries) {
  return { catalog: () => entries };
}

describe('live-tools _internal.parseParam — the five prose shapes', () => {
  test("'string (optional)' -> not required, type string", () => {
    const { schema, optional } = parseParam('route', 'string (optional)');
    assert.equal(optional, true);
    assert.equal(schema.type, 'string');
  });

  test("'number (optional) - exact target 0-100' -> {type:'number'} with clean description", () => {
    const { schema, optional } = parseParam('level', 'number (optional) - exact target 0-100');
    assert.equal(optional, true);
    assert.equal(schema.type, 'number');
    assert.equal(schema.description, 'exact target 0-100');
  });

  test('"\'approve\' | \'reject\'" -> enum', () => {
    const { schema, optional } = parseParam('action', "'approve' | 'reject'");
    assert.equal(optional, false);
    assert.deepEqual(schema.enum, ['approve', 'reject']);
  });

  test('plain required string with no type token -> string, required, no silent drop', () => {
    const { schema, optional } = parseParam('text', 'string');
    assert.equal(optional, false);
    assert.equal(schema.type, 'string');
  });

  test('unparseable prose -> falls back to string with the original prose preserved as description, never dropped', () => {
    const { schema, optional } = parseParam('weird', 'some free-form hint nobody typed a type for');
    assert.equal(optional, false);
    assert.equal(schema.type, 'string');
    assert.equal(schema.description, 'some free-form hint nobody typed a type for');
  });
});

describe('live-tools toDeclaration', () => {
  test('required vs optional params split correctly into parameters.required', () => {
    const decl = toDeclaration({
      name: 'spotify_volume',
      description: 'Adjust volume',
      params: { level: 'number (optional) - exact target 0-100', direction: 'string (optional) - up, down, or mute' },
    });
    assert.equal(decl.name, 'spotify_volume');
    assert.ok(!decl.parameters.required || !decl.parameters.required.length, 'both params optional -> no required array (or empty)');
  });

  test('a tool with zero params gets no parameters block at all', () => {
    const decl = toDeclaration({ name: 'read_status', description: 'Read status', params: {} });
    assert.equal(decl.parameters, undefined);
  });
});

describe('live-tools buildFunctionDeclarations — allowlist + withheld reporting', () => {
  // buildCatalogFromHub (voice-agent.js) merges the hub's real registrations
  // with CATALOG_RAW's hub-less pseudo-tools (navigate, close_panel, etc.) —
  // that merge is deliberate production behavior (BUG-017), not something
  // this phase changes, so these tests work WITH it rather than assuming a
  // bare hub of N entries yields exactly N catalog entries.
  test('a hub entry absent from the allowlist is reported in withheld, never silently dropped', () => {
    const hub = fakeHub([
      { name: 'navigate', description: 'nav', params: { route: 'string' } },
      { name: 'some_new_unlisted_tool', description: 'new', params: {} },
    ]);
    const { declarations, withheld } = buildFunctionDeclarations(hub, { allowlist: ['navigate'] });
    assert.equal(declarations.length, 1);
    assert.equal(declarations[0].name, 'navigate');
    assert.ok(withheld.includes('some_new_unlisted_tool'), 'a real hub tool left off the allowlist must show up in withheld');
  });

  test('log callback fires with a non-silent message when anything is withheld', () => {
    const hub = fakeHub([
      { name: 'navigate', description: 'nav', params: {} },
      { name: 'withheld_one', description: 'w', params: {} },
    ]);
    const logs = [];
    buildFunctionDeclarations(hub, { allowlist: ['navigate'], log: (m) => logs.push(m) });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /withheld \d+/);
    assert.match(logs[0], /withheld_one/);
  });

  test('no allowlist option falls back to DEFAULT_ALLOWLIST', () => {
    const hub = fakeHub([{ name: 'navigate', description: 'nav', params: {} }]);
    const { declarations } = buildFunctionDeclarations(hub);
    assert.ok(DEFAULT_ALLOWLIST.includes('navigate'));
    assert.ok(declarations.some((d) => d.name === 'navigate'));
    // Everything else declared came from DEFAULT_ALLOWLIST names present in
    // the merged catalog (CATALOG_RAW's hub-less pseudo-tools), never from a
    // name outside DEFAULT_ALLOWLIST.
    for (const d of declarations) assert.ok(DEFAULT_ALLOWLIST.includes(d.name));
  });
});

// AD-3: "Tool declarations derive from the hub. No hand-maintained parallel list."
// test/anti-drift-live-tools-subset.test.js covers the subset property + the
// newly-registered-effector-shows-up-automatically property in isolation.
