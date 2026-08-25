'use strict';

// whatsapp-contact-save-args.test.js — Task E4.
//
// The recorded failure (2026-08-12 installed-build session, 01:23:58):
// whatsapp_contact_save fired as {name: "", number: ""} — dispatched on
// intent before the operator had actually given a name. The tool went ahead
// and failed several steps in (a generic "not a phone number" for an empty
// string, or an unwritable-vault message), which does not tell the MODEL
// which argument was actually missing.
//
// The fix validates both arguments before touching the vault at all, and the
// message names the specific missing field so the model knows what to ask
// the operator for next.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { registerFromWhatsapp, whatsapp_contact_save } = require('../src/core/effectors/from-whatsapp');

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

describe('E4: whatsapp_contact_save requires its arguments', () => {
  let vault;
  beforeEach(() => { vault = wire({}); });

  it('fails naming "name" as the missing field when both are empty', async () => {
    const res = await whatsapp_contact_save({ number: '', name: '' });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /ask the operator for the missing name/i);
    assert.deepEqual(vault._files['Contacts/contacts.json'], {}, 'nothing must be written');
  });

  it('fails naming "name" as the missing field when name is missing but number is present', async () => {
    const res = await whatsapp_contact_save({ number: '+15551234567', name: '' });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /ask the operator for the missing name/i);
  });

  it('fails naming "number" as the missing field when number is missing but name is present', async () => {
    const res = await whatsapp_contact_save({ number: '', name: 'Mousumi' });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /ask the operator for the missing number/i);
    assert.deepEqual(vault._files['Contacts/contacts.json'], {}, 'nothing must be written');
  });

  it('whitespace-only name or number is treated as missing, not as a value', async () => {
    const nameRes = await whatsapp_contact_save({ number: '+15551234567', name: '   ' });
    assert.equal(nameRes.ok, false);
    assert.match(String(nameRes.result), /missing name/i);

    const numberRes = await whatsapp_contact_save({ number: '   ', name: 'Mousumi' });
    assert.equal(numberRes.ok, false);
    assert.match(String(numberRes.result), /missing number/i);
  });

  it('name and number both present still succeeds (unaffected by the new guard)', async () => {
    const res = await whatsapp_contact_save({ number: '+15551234567', name: 'Mousumi' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.result.saved, 'Mousumi');
  });

  it('missing-argument checks run BEFORE the vault-writable check, so the message names the field, not an unrelated infrastructure problem', async () => {
    registerFromWhatsapp({ register() {} }, { memory: {}, logger: { warn() {}, info() {} } }); // no writable vault
    const res = await whatsapp_contact_save({ number: '', name: '' });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /missing name/i, 'the missing-arg message must win over the vault message');
  });
});
