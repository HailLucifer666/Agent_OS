'use strict';

// test/whatsapp-recipient-prompt.test.js — FIX A: from-whatsapp.js's
// resolveRecipient() used to fail with "Add them to vault/Contacts/contacts.json
// as {...}" — an instruction to hand-edit a file over voice, which is useless,
// and stale: whatsapp_contact_save already ships as the tool for exactly this,
// and whatsapp_contacts lists who is already known. The fix rewrites both
// unresolved-recipient failure branches (no contacts saved at all, and
// contacts saved but no match) to ask for the phone number in international
// form and name the two real tools instead of a JSON file.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { _internal, TOOLS, registerFromWhatsapp } = require('../src/core/effectors/from-whatsapp');

const { resolveRecipient } = _internal;

describe('FIX A — unresolved WhatsApp recipient asks for a number, not a file edit', () => {
  it('the real tools it names actually exist in the effector catalog', () => {
    const names = TOOLS.map((t) => t.name);
    assert.ok(names.includes('whatsapp_contact_save'), 'whatsapp_contact_save must be a registered tool');
    assert.ok(names.includes('whatsapp_contacts'), 'whatsapp_contacts must be a registered tool');
  });

  it('no contacts saved at all: asks for the number, names whatsapp_contact_save, never contacts.json', () => {
    const result = resolveRecipient('dad');
    assert.ok(result.error, 'an unknown name with zero saved contacts must fail');
    assert.match(result.error, /not in my contact list/i);
    assert.match(result.error, /international form/i, 'must ask for the number in international form');
    assert.match(result.error, /\+15551234567|E\.164|international/i);
    assert.match(result.error, /whatsapp_contact_save/, 'must name the tool that remembers it for next time');
    assert.doesNotMatch(result.error, /contacts\.json/i, 'must not point at the JSON file');
    assert.doesNotMatch(result.error, /vault\//i, 'must not point at a vault path to hand-edit');
  });

  it('contacts saved but no match: asks for the number, names whatsapp_contact_save, never contacts.json', () => {
    const store = { mom: '+15559876543' };
    const fakeFs = {
      readJSONStrict: (relPath, fallback) => (relPath === 'Contacts/contacts.json' ? store : fallback),
    };
    registerFromWhatsapp({ register: () => {} }, { memory: { fs: fakeFs } });
    try {
      const result = resolveRecipient('dad');
      assert.ok(result.error, 'a name that matches no saved contact must fail');
      assert.match(result.error, /not in my contact list/i);
      assert.match(result.error, /international form/i);
      assert.match(result.error, /whatsapp_contact_save/);
      assert.match(result.error, /whatsapp_contacts/, 'must point at the way to see who is already known');
      assert.doesNotMatch(result.error, /contacts\.json/i);
      assert.doesNotMatch(result.error, /vault\//i);
    } finally {
      // Reset module-level state so this test cannot leak into others in the
      // same process (from-whatsapp.js keeps vaultFs as module-level state).
      registerFromWhatsapp({ register: () => {} }, { memory: { fs: null } });
    }
  });
});
