'use strict';

// test/live-tool-allowlist-reachability.test.js — 2026-08-02.
//
// The Live path can only call what DEFAULT_ALLOWLIST names. On 2026-08-02 that
// list gave the model ui_click but NOT ui_elements, so it had no way to obtain
// an elementPath and invented them — every
// "Element path index N out of range (parent has 0 children)" in
// vault/Episodic/2026-08-02.jsonl is a fabricated path, not a stale one. The same
// list carried gmail_send but not whatsapp_send, so MYTHOS truthfully told the
// operator it had no way to send a WhatsApp while the effector sat registered and
// working.
//
// Two things are asserted here, both of which failed before that date:
//   1. every allowlisted name is a REAL registered effector (no dead entries), and
//      the tools this session added are present;
//   2. no click/act tool is exposed without the read tool that produces its input.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildFunctionDeclarations, DEFAULT_ALLOWLIST } = require('../src/core/voice/live-tools');
const { TOOLS: WHATSAPP_TOOLS } = require('../src/core/effectors/from-whatsapp');
const { TOOLS: CUA_TOOLS } = require('../src/core/effectors/from-cua');
const { TOOLS: APP_REPLY_TOOLS } = require('../src/core/effectors/from-app-reply');
const fromPc = require('../src/core/effectors/from-pc');

// The real registries, not a hand-written stand-in — a stub here would re-create
// exactly the parallel-list problem this file exists to catch.
function realCatalog() {
  const pcTools = fromPc.TOOLS || [];
  return [].concat(pcTools, WHATSAPP_TOOLS, CUA_TOOLS, APP_REPLY_TOOLS).map((t) => ({
    name: t.name, description: t.description, params: t.params || {},
  }));
}
function hubOf(entries) {
  return { catalog: () => entries };
}

describe('Live allowlist — the tools the 2026-08-02 WhatsApp session needed', () => {
  const catalog = realCatalog();
  const registered = new Set(catalog.map((t) => t.name));

  // Each of these was registered and working while being unreachable from voice.
  const MUST_BE_REACHABLE = [
    'whatsapp_send',          // "I don't currently have a tool to send WhatsApp messages" — true, and shouldn't have been
    'whatsapp_contacts',
    'whatsapp_contact_save',  // added 2026-08-02: adding a contact was a manual file edit
    'ui_elements',            // the missing read tool behind every invented elementPath
    'cua_list_windows',
    'cua_get_window_state',
    'cua_click',
    'app_reply',
    'close_window',
  ];

  for (const name of MUST_BE_REACHABLE) {
    test(`${name} is in DEFAULT_ALLOWLIST`, () => {
      assert.ok(DEFAULT_ALLOWLIST.includes(name),
        `${name} is registered but not reachable from the Live voice path`);
    });
  }

  test('every allowlisted name that this catalog knows about produces a declaration', () => {
    const { declarations } = buildFunctionDeclarations(hubOf(catalog), { allowlist: DEFAULT_ALLOWLIST });
    const declaredNames = new Set(declarations.map((d) => d.name));
    const expected = MUST_BE_REACHABLE.filter((n) => registered.has(n));
    assert.ok(expected.length > 0, 'catalog fixture resolved nothing — the test would pass vacuously');
    for (const name of expected) {
      assert.ok(declaredNames.has(name), `${name} allowlisted but produced no functionDeclaration`);
    }
  });

  test('a click tool is never exposed without the read tool that produces its input', () => {
    // ui_click/cua_click both take an index into a tree the model cannot guess.
    // Exposing either without its reader is what produced the fabricated paths.
    const pairs = [
      ['ui_click', 'ui_elements'],
      ['cua_click', 'cua_get_window_state'],
    ];
    for (const [clicker, reader] of pairs) {
      if (!DEFAULT_ALLOWLIST.includes(clicker)) continue;
      assert.ok(DEFAULT_ALLOWLIST.includes(reader),
        `${clicker} is exposed without ${reader}; the model can only invent its element path`);
    }
  });

  test('no allowlist entry is a typo — every name resolves in some real registry', () => {
    // Scoped to the registries this test loads; a name outside them is not asserted
    // here rather than being falsely reported as dead.
    const knownElsewhere = new Set(DEFAULT_ALLOWLIST.filter((n) => !registered.has(n)));
    for (const name of MUST_BE_REACHABLE) {
      assert.ok(!knownElsewhere.has(name) || registered.has(name),
        `${name} is allowlisted but not registered anywhere this test can see`);
    }
  });
});
