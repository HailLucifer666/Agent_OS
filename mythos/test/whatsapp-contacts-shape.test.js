'use strict';

// test/whatsapp-contacts-shape.test.js — 2026-08-02.
//
// vault/Contacts/contacts.json held [["alex","+..."]] — an array of pairs — while
// loadContacts() accepted ONLY the documented object shape and discarded anything
// else as {}. So MYTHOS answered "I have no contacts saved" over a file that
// plainly had a contact in it, and no name could ever resolve. A reader that
// silently throws away real data is the same failure class as an effector
// reporting success it did not earn.
//
// Also covers whatsapp_contact_save, added the same day: before it, the only way
// to add a contact was hand-editing that file mid-conversation.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const whatsapp = require('../src/core/effectors/from-whatsapp');
const { registerFromWhatsapp, whatsapp_contacts, whatsapp_contact_save, _internal } = whatsapp;
const { resolveRecipient, CONTACTS_PATH } = _internal;

// Minimal in-memory vault: same two methods from-whatsapp actually calls.
function fakeVault(initial) {
  const files = { [CONTACTS_PATH]: initial };
  return {
    readJSONStrict(p, fallback) {
      return Object.prototype.hasOwnProperty.call(files, p) ? files[p] : fallback;
    },
    writeJSON(p, data) { files[p] = data; return { ok: true }; },
    _files: files,
  };
}
function wire(initial) {
  const vault = fakeVault(initial);
  registerFromWhatsapp({ register() {} }, { memory: { fs: vault }, logger: null });
  return vault;
}

describe('loadContacts — the array-of-pairs file on disk (2026-08-02)', () => {
  test('RED before the fix: [["alex","+..."]] resolves "alex" instead of vanishing', () => {
    wire([['alex', '+15551234567']]);
    const got = resolveRecipient('alex');
    assert.equal(got.error, undefined, got.error);
    assert.equal(got.number, '+15551234567');
  });

  test('the documented object shape still works, unchanged', () => {
    wire({ dad: '+15559876543' });
    assert.equal(resolveRecipient('dad').number, '+15559876543');
  });

  test('whatsapp_contacts reports the array-shaped contact instead of "none saved"', async () => {
    wire([['alex', '+15551234567'], ['mousumi', '+919876543210']]);
    const res = await whatsapp_contacts();
    assert.equal(res.ok, true);
    assert.deepEqual(res.result.contacts.sort(), ['alex', 'mousumi']);
    // Names only — a tool result is spoken aloud and written to the episodic log.
    assert.ok(!JSON.stringify(res.result).includes('9876543210'),
      'a phone number leaked into a spoken/logged tool result');
  });

  test('malformed array entries are skipped, not turned into junk contacts', () => {
    wire([['alex', '+15551234567'], 'nonsense', [], ['', '+15550000000']]);
    assert.equal(resolveRecipient('alex').number, '+15551234567');
    // The bare string and the empty name must not become addressable contacts.
    assert.ok(/do not have a number|no contacts/i.test(resolveRecipient('nonsense').error || ''));
  });
});

describe('whatsapp_contact_save', () => {
  let vault;
  beforeEach(() => { vault = wire({}); });

  test('saves a new contact and it resolves immediately afterwards', async () => {
    const res = await whatsapp_contact_save({ name: 'Mousumi', number: '+919876543210' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.result.saved, 'Mousumi');
    assert.equal(res.result.evidence, 'read-back');
    assert.equal(resolveRecipient('Mousumi').number, '+919876543210');
    assert.equal(resolveRecipient('mousumi').number, '+919876543210', 'lookup must be case-insensitive');
  });

  test('writes the documented OBJECT shape, never an array', async () => {
    await whatsapp_contact_save({ name: 'Mousumi', number: '+919876543210' });
    const written = vault._files[CONTACTS_PATH];
    assert.ok(!Array.isArray(written), 'contact_save put an array back on disk');
    assert.equal(typeof written, 'object');
  });

  test('updating an existing name replaces the number rather than duplicating it', async () => {
    await whatsapp_contact_save({ name: 'Mousumi', number: '+919876543210' });
    const res = await whatsapp_contact_save({ name: 'mousumi', number: '+919811111111' });
    assert.equal(res.ok, true);
    assert.equal(res.result.replaced, true);
    assert.equal(Object.keys(vault._files[CONTACTS_PATH]).length, 1, 'duplicate entry for the same person');
    assert.equal(resolveRecipient('Mousumi').number, '+919811111111');
  });

  test('a number that is not usable is refused, and nothing is written', async () => {
    const res = await whatsapp_contact_save({ name: 'Mousumi', number: 'call her mobile' });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /not a phone number/i);
    assert.deepEqual(vault._files[CONTACTS_PATH], {});
  });

  test('a missing name is refused', async () => {
    const res = await whatsapp_contact_save({ name: '   ', number: '+15551234567' });
    assert.equal(res.ok, false);
  });

  test('the result never carries the phone number', async () => {
    const res = await whatsapp_contact_save({ name: 'Mousumi', number: '+919876543210' });
    assert.ok(!JSON.stringify(res.result).includes('9876543210'));
  });
});
