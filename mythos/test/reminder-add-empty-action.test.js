'use strict';

// test/reminder-add-empty-action.test.js — BUG-100. The Live voice model sends
// `action: {}` for a plain reminder (the schema says "object (optional)", and an
// empty object reads as "omitted"), which made addReminder() take the
// fire-action validation branch and reject the whole reminder with
// "action.tool required". Logged live on 2026-08-05: two failed attempts at a
// vet appointment reminder, both surfaced to the operator as a bare "Failed".
//
// An action object with no keys means NO action. A non-empty action object
// missing `tool` is still a real caller mistake and still errors.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCalendarTools } = require('../src/core/effectors/from-calendar');

function fakeVaultFs() {
  const store = {};
  return {
    readJSON: (p, fb) => (store[p] !== undefined ? JSON.parse(JSON.stringify(store[p])) : fb),
    readJSONStrict: (p, fb) => (store[p] !== undefined ? JSON.parse(JSON.stringify(store[p])) : fb),
    writeJSON: (p, d) => { store[p] = JSON.parse(JSON.stringify(d)); },
    ensureDir: () => {},
  };
}

function toolFn(tools, name) {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `${name} must be registered`);
  return t.fn;
}

test('reminder_add accepts an ISO datetime with the standard uppercase T separator', async () => {
  // The observed 2026-08-05 failure. parseWhen() lowercases its input and then
  // matched an uppercase-only [T ] class, so EVERY ISO `when` returned null.
  const tools = buildCalendarTools({ fs: fakeVaultFs(), bus: null });
  const fn = toolFn(tools, 'reminder_add');

  const res = await fn({ text: 'Vet appointment', when: '2126-08-05T16:00:00' });

  assert.equal(res.ok, true, 'an ISO datetime with an uppercase T must parse');
  const due = new Date(res.result.reminder.dueAt);
  assert.equal(due.getFullYear(), 2126);
  assert.equal(due.getMonth(), 7, 'August');
  assert.equal(due.getDate(), 5);
  assert.equal(due.getHours(), 16);
  assert.equal(due.getMinutes(), 0);
});

test('reminder_add still accepts the space-separated ISO form', async () => {
  const tools = buildCalendarTools({ fs: fakeVaultFs(), bus: null });
  const fn = toolFn(tools, 'reminder_add');

  const res = await fn({ text: 'standup', when: '2126-08-05 09:30' });

  assert.equal(res.ok, true);
  assert.equal(new Date(res.result.reminder.dueAt).getHours(), 9);
});

test('reminder_add treats an empty action object as no action at all', async () => {
  const tools = buildCalendarTools({ fs: fakeVaultFs(), bus: null });
  const fn = toolFn(tools, 'reminder_add');

  // The exact call the Live model made on 2026-08-05.
  const res = await fn({ text: 'Vet appointment', action: {}, when: '2126-08-05T16:00:00' });

  assert.equal(res.ok, true, 'an empty action object must not fail the reminder');
  assert.equal(res.result.reminder.action, null, 'no action should be recorded');
  assert.equal(res.result.reminder.actionApproved, true, 'nothing to approve');
  assert.equal(res.result.needsApproval, undefined, 'must not demand approval for a plain reminder');
  assert.match(res.result.reminder.text, /vet/i);
});

test('reminder_add still rejects a non-empty action object with no tool', async () => {
  const tools = buildCalendarTools({ fs: fakeVaultFs(), bus: null });
  const fn = toolFn(tools, 'reminder_add');

  const res = await fn({ text: 'ping someone', when: 'in 10 minutes', action: { args: { to: 'x' } } });

  assert.equal(res.ok, false, 'an action carrying args but no tool is a real caller mistake');
  assert.match(String(res.error || res.result && res.result.error), /action\.tool required/i);
});

test('reminder_add ignores an empty action passed as an empty array too', async () => {
  // Some models emit [] for an "object (optional)" slot. Same meaning: absent.
  const tools = buildCalendarTools({ fs: fakeVaultFs(), bus: null });
  const fn = toolFn(tools, 'reminder_add');

  const res = await fn({ text: 'water the plants', when: 'in 30 minutes', action: [] });

  assert.equal(res.ok, true);
  assert.equal(res.result.reminder.action, null);
});
