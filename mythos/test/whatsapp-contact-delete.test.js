'use strict';

// test/whatsapp-contact-delete.test.js — Wave 4 (2026-08-13), incident
// inc-1786616401736-1. whatsapp_contact_save already deletes-then-rewrites a
// contact internally when replacing one, but there was no way to remove a
// contact WITHOUT immediately re-adding it — a throwaway/test contact could
// only be overwritten, never actually deleted. This adds a real delete tool
// with the same read-back-verify discipline whatsapp_contact_save uses.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { registerFromWhatsapp, whatsapp_contact_delete, whatsapp_contact_save, TOOLS } = require('../src/core/effectors/from-whatsapp');
const { TIER_TABLE } = require('../src/core/leash/tiers');

function wire(contacts) {
  const files = { 'Contacts/contacts.json': contacts || {} };
  const vault = {
    readJSONStrict: (p, fallback) => (p in files ? files[p] : fallback),
    writeJSON: (p, data) => { files[p] = data; return { ok: true }; },
    _files: files,
  };
  registerFromWhatsapp({ register() {} }, { memory: { fs: vault }, logger: { warn() {}, info() {} } });
  return vault;
}

describe('whatsapp_contact_delete', () => {
  let vault;
  beforeEach(() => { vault = wire({ Mousumi: '+15551234567' }); });

  it('requires a name', async () => {
    const res = await whatsapp_contact_delete({ name: '' });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /Ask the operator for the contact name to delete/i);
  });

  it('fails honestly when the name is not a saved contact', async () => {
    const res = await whatsapp_contact_delete({ name: 'Nobody' });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /No saved contact named "Nobody"/);
    assert.deepEqual(vault._files['Contacts/contacts.json'], { Mousumi: '+15551234567' }, 'nothing must be written on a miss');
  });

  it('deletes an existing contact, case-insensitively, and confirms via read-back', async () => {
    const res = await whatsapp_contact_delete({ name: 'mousumi' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.result.deleted, 'Mousumi');
    assert.equal(res.result.evidence, 'read-back');
    assert.deepEqual(vault._files['Contacts/contacts.json'], {}, 'the contact must actually be removed from the vault');
  });

  it('save-then-delete round-trips cleanly (the internal delete-then-rewrite in save is unaffected)', async () => {
    const saved = await whatsapp_contact_save({ name: 'Throwaway', number: '+15559998888' });
    assert.equal(saved.ok, true);
    const deleted = await whatsapp_contact_delete({ name: 'Throwaway' });
    assert.equal(deleted.ok, true);
    assert.equal(vault._files['Contacts/contacts.json'].Throwaway, undefined);
  });

  it('fails when the vault is not writable', async () => {
    registerFromWhatsapp({ register() {} }, { memory: {}, logger: { warn() {}, info() {} } });
    const res = await whatsapp_contact_delete({ name: 'Mousumi' });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /vault is not writable/);
  });
});

describe('whatsapp_contact_delete — tool registration and tiering', () => {
  it('is registered in TOOLS as a destructive tool', () => {
    const tool = TOOLS.find((t) => t.name === 'whatsapp_contact_delete');
    assert.ok(tool, 'whatsapp_contact_delete must be a registered tool');
    assert.equal(tool.danger, true);
  });

  it('is tiered T3, same as whatsapp_contact_save (the save it undoes)', () => {
    assert.equal(TIER_TABLE.whatsapp_contact_delete, 3);
    assert.equal(TIER_TABLE.whatsapp_contact_delete, TIER_TABLE.whatsapp_contact_save);
  });
});
