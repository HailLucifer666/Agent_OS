'use strict';

// test/from-calendar-timer.test.js — Task 5, alarms/timers with an audible
// alert. A timer is a reminder whose `when` is always relative and which
// rings — riding the EXISTING parseWhen()/reminder-sensor.js/reminder.due
// path (no new store, no new sensor, no new file format). See CLAUDE.md /
// roadmap Task 5 for the conflict-resolution note on why this stays
// in-process rather than becoming Windows Scheduled Tasks (§7.12).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCalendarTools } = require('../src/core/effectors/from-calendar');

function fakeVaultFs() {
  const store = {};
  return {
    readJSON: (p, fb) => (store[p] !== undefined ? JSON.parse(JSON.stringify(store[p])) : fb),
    writeJSON: (p, d) => { store[p] = JSON.parse(JSON.stringify(d)); },
    ensureDir: () => {},
  };
}

function toolFn(tools, name) {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `${name} must be registered`);
  return t.fn;
}

test('timer_add creates a reminder flagged for an audible alert', async () => {
  const tools = buildCalendarTools({ fs: fakeVaultFs(), bus: null });
  const fn = toolFn(tools, 'timer_add');

  const res = await fn({ minutes: 5, label: 'tea' });
  assert.equal(res.ok, true);
  assert.equal(res.result.reminder.alertSound, true);
  assert.match(res.result.reminder.text, /tea/i);
});

test('timer_add defaults the label to "Timer" when omitted', async () => {
  const tools = buildCalendarTools({ fs: fakeVaultFs(), bus: null });
  const fn = toolFn(tools, 'timer_add');

  const res = await fn({ minutes: 1 });
  assert.equal(res.ok, true);
  assert.match(res.result.reminder.text, /timer/i);
});

test('a plain reminder_add (no timer) is NOT flagged for an audible alert', async () => {
  const tools = buildCalendarTools({ fs: fakeVaultFs(), bus: null });
  const addFn = toolFn(tools, 'reminder_add');

  const res = await addFn({ text: 'call mom', when: 'in 10 minutes' });
  assert.equal(res.ok, true);
  assert.equal(res.result.reminder.alertSound, false, 'ordinary reminders must not ring the audible alert');
});

test('timer_cancel cancels a pending timer by text match', async () => {
  const tools = buildCalendarTools({ fs: fakeVaultFs(), bus: null });
  const addFn = toolFn(tools, 'timer_add');
  const cancelFn = toolFn(tools, 'timer_cancel');

  await addFn({ minutes: 5, label: 'tea' });
  const res = await cancelFn({ query: 'tea' });
  assert.equal(res.ok, true);
  assert.match(res.result.cancelled.text, /tea/i);
});

test('fireDueReminders emits reminder.due with alertSound carried through the payload', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { createCalendarEffector } = require('../src/core/effectors/from-calendar');
  const { createReminderSensor } = require('../src/core/sensors/reminder-sensor');

  const emitted = [];
  const bus = { emit: (type, payload) => emitted.push({ type, payload }) };
  const fs = fakeVaultFs();
  const now = Date.now();
  fs.writeJSON('Calendar/reminders.json', [
    { id: 'rem-timer', text: 'Timer: tea', dueAt: now - 1000, createdAt: now - 2000, fired: false, alertSound: true },
    { id: 'rem-plain', text: 'call mom', dueAt: now - 1000, createdAt: now - 2000, fired: false, alertSound: false },
  ]);
  const calendar = createCalendarEffector({ fs, bus });
  const sensor = createReminderSensor({ calendar, bus });

  sensor.start();
  t.mock.timers.tick(30000);
  sensor.stop();

  const dueEvents = emitted.filter((e) => e.type === 'reminder.due');
  assert.equal(dueEvents.length, 2);
  const timerEvent = dueEvents.find((e) => e.payload.id === 'rem-timer');
  const plainEvent = dueEvents.find((e) => e.payload.id === 'rem-plain');
  assert.equal(timerEvent.payload.alertSound, true);
  assert.equal(plainEvent.payload.alertSound, false);
});
