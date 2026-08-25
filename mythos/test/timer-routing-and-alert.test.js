'use strict';

// test/timer-routing-and-alert.test.js — Task F2 (G5 diagnosis, 2026-08-12).
//
// Measured: due 02:07:58 -> spoken 02:08:09 (+11s); due 02:09:17 -> spoken
// 02:09:39 (+22s). Both silent. Two separate defects, both proved here:
//
//   1. Routing: reminder_add defaults alertSound:false, and timer_add (which
//      sets alertSound:true) existed but was never called — "set a timer for
//      N minutes" landed on the wrong tool because the two tool descriptions
//      didn't say not to. Fixed by sharpening both descriptions.
//   2. Lag: reminder-sensor.js was a bare setInterval(..., 30000) anchored to
//      boot time, giving every reminder a uniform 0-30s detection delay
//      depending on where its dueAt fell inside that window. There was never
//      a turn-boundary gate to remove — proactiveSpeak() already fires
//      immediately on the reminder.due bus event. The fix is due-time
//      scheduling (a precise wake timer per reminder), not a shorter poll.
//   3. The 01:36 bug: the fired notice was 'Reminder: <text>' — grammatically
//      an instruction to CREATE one. On Live that notice necessarily arrives
//      as user-role realtimeInput (BUG-117: no system channel exists after
//      setup), so the model read its own completed-reminder notice as a
//      fresh request and called reminder_add on it. Fixed by rewording the
//      notice to read as a completed-event report, plus an explicit clause in
//      LIVE_SYSTEM_NOTICE_INSTRUCTION.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildCalendarTools, createCalendarEffector } = require('../src/core/effectors/from-calendar');
const { createReminderSensor } = require('../src/core/sensors/reminder-sensor');
const { LIVE_SYSTEM_NOTICE_INSTRUCTION } = require('../src/core/voice/live-tool-adapter');
const { fakeBus } = require('./helpers');

function fakeVaultFs() {
  const store = {};
  return {
    readJSON: (p, fb) => (store[p] !== undefined ? JSON.parse(JSON.stringify(store[p])) : fb),
    readJSONStrict: (p, fb) => (store[p] !== undefined ? JSON.parse(JSON.stringify(store[p])) : fb),
    writeJSON: (p, d) => { store[p] = JSON.parse(JSON.stringify(d)); },
    ensureDir: () => {},
  };
}

function toolDesc(tools, name) {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `${name} must be registered`);
  return t.description;
}

describe('F2 step 1/RED: "timer" cannot land on reminder_add', () => {
  test('reminder_add explicitly refuses timer/countdown/alarm phrasing and points at timer_add', () => {
    const tools = buildCalendarTools({ fs: fakeVaultFs(), bus: null });
    const desc = toolDesc(tools, 'reminder_add');
    assert.match(desc, /do not use this for a timer/i);
    assert.match(desc, /timer_add/);
  });

  test('timer_add explicitly claims "set a timer for N minutes" phrasing and forbids reminder_add', () => {
    const tools = buildCalendarTools({ fs: fakeVaultFs(), bus: null });
    const desc = toolDesc(tools, 'timer_add');
    assert.match(desc, /set a timer for n minutes/i);
    assert.match(desc, /never reminder_add/i);
    assert.match(desc, /rings an audible alert/i);
  });
});

describe('F2 step 1/RED: a fired reminder is delivered on its own schedule, not a fixed poll wait', () => {
  test('a reminder due well inside the 30s safety-poll window fires at its own due time', (t) => {
    // 'Date' is mocked alongside the timers so fireDueReminders()'s own
    // Date.now() comparison advances in step with tick() — without it the
    // wake timer fires on schedule but the due-time check still sees real
    // (barely-advanced) wall-clock time and declines to fire.
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });

    const bus = fakeBus();
    const fsStore = fakeVaultFs();
    const calendar = createCalendarEffector({ fs: fsStore, bus });
    const sensor = createReminderSensor({ calendar, bus });

    sensor.start(); // nothing pending yet — arms the safety-poll-length wake

    // Simulate a reminder created while the sensor is already running, due
    // 5s out — far short of the 30s safety-poll cadence the old fixed
    // setInterval would have made every reminder wait out.
    const dueAt = Date.now() + 5000;
    fsStore.writeJSON('Calendar/reminders.json', [
      { id: 'rem-soon', text: 'stretch', dueAt, createdAt: Date.now(), fired: false, alertSound: false },
    ]);
    bus.emit('calendar.reminder-added', { id: 'rem-soon', dueAt });

    assert.equal(bus._lastEvent('reminder.due'), null, 'must not have fired yet — it is not due for 5s');

    t.mock.timers.tick(5000);

    const evt = bus._lastEvent('reminder.due');
    assert.ok(evt, 'expected the reminder to fire once its own due time arrived, well before a 30s poll would have');
    assert.equal(evt.payload.id, 'rem-soon');

    sensor.stop();
  });

  test('an overdue reminder fires the instant the sensor starts — no turn-boundary gate, no fixed poll wait', (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });

    const bus = fakeBus();
    const fsStore = fakeVaultFs();
    const now = Date.now();
    fsStore.writeJSON('Calendar/reminders.json', [
      { id: 'rem-late', text: 'walk the dog', dueAt: now - 1000, createdAt: now - 5000, fired: false },
    ]);
    const calendar = createCalendarEffector({ fs: fsStore, bus });
    const sensor = createReminderSensor({ calendar, bus });

    sensor.start();

    const evt = bus._lastEvent('reminder.due');
    assert.ok(evt, 'an overdue reminder must fire synchronously on start(), before any timer tick at all');
    assert.equal(evt.payload.id, 'rem-late');

    sensor.stop();
  });
});

describe('F2 step 1/RED: a fired reminder cannot be mistaken for a request to create a new one', () => {
  test('the fired-reminder notice built in server/index.js no longer reads as a creation instruction', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    // The 01:36 bug: 'Reminder: <text>' is grammatically indistinguishable
    // from an instruction to set one. It must be gone.
    assert.doesNotMatch(src, /'Reminder: ' \+ e\.payload\.text/,
      'the old creation-shaped notice text must no longer be built');
    assert.match(src, /has just fired and is now complete/i,
      'the notice must read as a report of a completed event, not a request');
  });

  test('LIVE_SYSTEM_NOTICE_INSTRUCTION names reminder/timer firings and forbids treating them as a create request', () => {
    assert.match(LIVE_SYSTEM_NOTICE_INSTRUCTION, /reminder or timer/i);
    assert.match(LIVE_SYSTEM_NOTICE_INSTRUCTION, /never.*call reminder_add or timer_add/i);
  });
});
