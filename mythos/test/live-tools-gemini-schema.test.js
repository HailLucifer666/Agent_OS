'use strict';

// live-tools-gemini-schema.test.js — every generated functionDeclaration must be a
// VALID Gemini Schema, not merely a well-formed JS object.
//
// FOUND LIVE 2026-07-31, on the first real Gemini Live connection ever made from
// this repo. The setup frame was rejected outright:
//
//   close code=1007  BidiGenerateContentRequest.setup.tools[0]
//   .function_declarations[5].parameters.properties[elementPath].items: missing field
//
// `parseParam()` emitted `{type:'array', description}` with no `items`. Gemini's
// Schema requires `items` for ARRAY, so the API rejected the WHOLE setup — not just
// the offending tool. Every S2S session therefore failed to open, always, with the
// default allowlist. Unit tests passed the entire time because they only ever
// checked the declarations' JS shape; nothing asserted API validity.
//
// This file is the gate for that class of bug. It runs over the REAL registry
// (AD-3), so a future effector that declares an array param without an item type
// fails here instead of silently killing voice in production.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildFunctionDeclarations } = require('../src/core/voice/live-tools');

// Registry stand-in. buildCatalogFromHub() reads hub.catalog() — an EMPTY catalog
// is not an empty result, it falls through to voice-agent's own CATALOG_RAW, which
// is exactly what the shipped default sends to Gemini.
function hubWith(entries) {
  return { catalog: () => entries };
}

function declarationsFor(entries, allowlist) {
  const { declarations } = buildFunctionDeclarations(hubWith(entries), {
    allowlist: allowlist || entries.map((e) => e.name),
    log() {},
  });
  return declarations;
}

// Walks a Gemini Schema the way the API's validator does. Returns a list of
// violation strings; empty means valid.
function schemaViolations(schema, path) {
  const bad = [];
  if (!schema || typeof schema !== 'object') return bad;
  const type = String(schema.type || '').toLowerCase();
  if (type === 'array' && !schema.items) {
    bad.push(path + '.items: missing field (ARRAY requires an item schema)');
  }
  if (schema.items) bad.push(...schemaViolations(schema.items, path + '.items'));
  if (schema.properties) {
    for (const k of Object.keys(schema.properties)) {
      bad.push(...schemaViolations(schema.properties[k], path + '.properties[' + k + ']'));
    }
  }
  return bad;
}

describe('live-tools: generated declarations are valid Gemini Schemas', () => {
  test('an array param carries items — the exact defect that closed the socket with 1007', () => {
    const decls = declarationsFor([{
      name: 'ui_click',
      description: 'Click a UI element.',
      params: { elementPath: 'array of number strings - element indices from root to target' },
    }]);
    const p = decls[0].parameters.properties.elementPath;
    assert.equal(p.type, 'array');
    assert.ok(p.items, 'ARRAY schema must carry items — Gemini rejects the whole setup without it');
    assert.equal(p.items.type, 'string');
  });

  test('all three real array params in the catalog produce valid schemas', () => {
    const decls = declarationsFor([
      { name: 'ui_click', description: 'c', params: { pid: 'number', elementPath: 'array of number strings - element indices from root to target' } },
      { name: 'ui_type', description: 't', params: { text: 'string', elementPath: 'array (optional) - target element path' } },
      { name: 'run_command', description: 'r', params: { command: 'string', args: 'array (optional) — arg flags must be allowlisted' } },
    ]);
    assert.equal(decls.length, 3);
    for (const d of decls) {
      const bad = schemaViolations(d.parameters, d.name + '.parameters');
      assert.deepEqual(bad, [], 'invalid schema: ' + bad.join('; '));
    }
  });

  test('an optional array is still a valid array — optionality must not skip items', () => {
    const decls = declarationsFor([{
      name: 'ui_type', description: 't', params: { elementPath: 'array (optional) - target element path' },
    }]);
    const p = decls[0].parameters.properties.elementPath;
    assert.ok(p.items, 'an optional array still needs items');
    // and it must NOT be listed as required
    assert.ok(!(decls[0].parameters.required || []).includes('elementPath'));
  });

  test('non-array params are untouched — no items smuggled onto strings/numbers', () => {
    const decls = declarationsFor([{
      name: 'spotify_volume', description: 'v', params: { level: 'number - exact target 0-100', device: 'string (optional)' },
    }]);
    const props = decls[0].parameters.properties;
    assert.equal(props.level.type, 'number');
    assert.ok(!('items' in props.level), 'a number must not carry items');
    assert.ok(!('items' in props.device), 'a string must not carry items');
  });

  test('THE REGRESSION GATE: the REAL registered catalog is schema-valid end to end', () => {
    // Not a fixture. A real createEffectorHub with real from-pc registrations and
    // the real DEFAULT_ALLOWLIST — i.e. what a default install actually puts in the
    // setup frame, which is the configuration that failed live with close code 1007.
    // A fixture-only version of this test passed while production was broken,
    // because voice-agent's CATALOG_RAW fallback declares no array params; only the
    // genuine registry does. from-pc takes pcChild:null and degrades (AD-9), so this
    // needs no adapter, no PowerShell and no network.
    const { createEffectorHub } = require('../src/core/effectors/hub');
    const { registerFromPc } = require('../src/core/effectors/from-pc');
    const quiet = { info() {}, warn() {}, error() {}, debug() {} };
    const hub = createEffectorHub({ logger: quiet, bus: { emit() {}, subscribe() {} } });
    registerFromPc(hub, { pcChild: null, logger: quiet });

    const catalog = hub.catalog();
    assert.ok(catalog.length > 10, 'expected a real registered catalog, got ' + catalog.length);
    assert.ok(catalog.some((c) => c.name === 'ui_click'),
      'fixture guard: ui_click must be registered — it owns the array param that broke the socket');

    const { declarations } = buildFunctionDeclarations(hub, { log() {} });
    const violations = [];
    for (const d of declarations) {
      if (!d.parameters) continue;
      violations.push(...schemaViolations(d.parameters, d.name + '.parameters'));
    }
    assert.deepEqual(violations, [], 'invalid Gemini schemas found:\n  ' + violations.join('\n  '));
  });
});
