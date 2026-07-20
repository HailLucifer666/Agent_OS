'use strict';

// Phase 4 / Area D — V8 calendar upcoming-event perception sensor.
//
// Distinct from reminder-sensor.js (which emits reminder.due for OVERDUE
// events, bypassing the OODA loop). This sensor emits perception.calendar
// for events coming up within LEAD_MS so the cortex can act on them.
//
// We exercise the sensor directly with mocked deps — no Node timer needed
// (we call _internal.poll(myGen) synchronously).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createCalendarUpcomingSensor } = require('../src/core/sensors/calendar-upcoming-sensor');

function fakeCalendar(reminders) {
  return {
    listReminders: function () { return { ok: true, result: { reminders: reminders } }; }
  };
}

function fakeBus() {
  var events = [];
  return { emit: function (n, p) { events.push({ name: n, payload: p }); }, _events: events };
}

function nowPlus(ms) { return Date.now() + ms; }

// Helper: drive a single poll with the sensor's current generation token.
// Tests don't call start() (which would kick off setInterval) — they poll
// synchronously via _internal.poll(gen()).
function pollOnce(sensor) { sensor._internal.poll(sensor._internal.gen()); }

describe('Phase 4 / Area D — calendar-upcoming-sensor (V8)', function () {

  it('emits perception.calendar for an event within LEAD_MS', function () {
    var reminders = [
      { id: 'r1', text: 'standup', dueAt: nowPlus(5 * 60000), fired: false }   // 5min away
    ];
    var bus = fakeBus();
    var sensor = createCalendarUpcomingSensor({
      calendar: fakeCalendar(reminders), bus: bus, config: { CALENDAR_UPCOMING_LEAD_MS: 900000 }
    });
    pollOnce(sensor);
    var cal = bus._events.filter(function (e) { return e.name === 'perception.calendar'; });
    assert.equal(cal.length, 1);
    assert.equal(cal[0].payload.kind, 'calendar');
    assert.equal(cal[0].payload.channel, 'calendar');
    assert.ok(cal[0].payload.summary.indexOf('standup') !== -1);
    assert.ok(cal[0].payload.summary.indexOf('Upcoming event') !== -1);
    assert.ok(cal[0].payload.detail.leadMs > 0);
  });

  it('does NOT emit for an event beyond LEAD_MS (idle-skip)', function () {
    var reminders = [
      { id: 'r1', text: 'far-future meeting', dueAt: nowPlus(2 * 3600000), fired: false }   // 2h away
    ];
    var bus = fakeBus();
    var sensor = createCalendarUpcomingSensor({
      calendar: fakeCalendar(reminders), bus: bus, config: { CALENDAR_UPCOMING_LEAD_MS: 900000 }
    });
    pollOnce(sensor);
    var cal = bus._events.filter(function (e) { return e.name === 'perception.calendar'; });
    assert.equal(cal.length, 0, 'events beyond LEAD_MS must not be perceived');
  });

  it('does NOT emit for already-fired reminders (reminder-sensor\'s domain)', function () {
    var reminders = [
      { id: 'r1', text: 'past event', dueAt: nowPlus(-60000), fired: true }   // 1min ago, fired
    ];
    var bus = fakeBus();
    var sensor = createCalendarUpcomingSensor({
      calendar: fakeCalendar(reminders), bus: bus, config: { CALENDAR_UPCOMING_LEAD_MS: 900000 }
    });
    pollOnce(sensor);
    var cal = bus._events.filter(function (e) { return e.name === 'perception.calendar'; });
    assert.equal(cal.length, 0, 'fired reminders belong to reminder-sensor, not this sensor');
  });

  it('does NOT emit for unfired but past-due reminders (reminder-sensor will fire them)', function () {
    // These would otherwise double-perceive: reminder-sensor emits reminder.due
    // for them, and we'd emit perception.calendar. Skip to avoid the double.
    var reminders = [
      { id: 'r1', text: 'overdue', dueAt: nowPlus(-60000), fired: false }
    ];
    var bus = fakeBus();
    var sensor = createCalendarUpcomingSensor({
      calendar: fakeCalendar(reminders), bus: bus, config: { CALENDAR_UPCOMING_LEAD_MS: 900000 }
    });
    pollOnce(sensor);
    var cal = bus._events.filter(function (e) { return e.name === 'perception.calendar'; });
    assert.equal(cal.length, 0);
  });

  it('does NOT re-perceive the same event on subsequent polls (dedup by id)', function () {
    var reminders = [
      { id: 'r1', text: 'standup', dueAt: nowPlus(5 * 60000), fired: false }
    ];
    var bus = fakeBus();
    var sensor = createCalendarUpcomingSensor({
      calendar: fakeCalendar(reminders), bus: bus, config: { CALENDAR_UPCOMING_LEAD_MS: 900000 }
    });
    pollOnce(sensor);
    pollOnce(sensor);
    pollOnce(sensor);
    var cal = bus._events.filter(function (e) { return e.name === 'perception.calendar'; });
    assert.equal(cal.length, 1, 'each event must be perceived exactly once');
  });

  it('respects a custom CALENDAR_UPCOMING_SALIENCE', function () {
    var reminders = [
      { id: 'r1', text: 'x', dueAt: nowPlus(5 * 60000), fired: false }
    ];
    var bus = fakeBus();
    var sensor = createCalendarUpcomingSensor({
      calendar: fakeCalendar(reminders), bus: bus,
      config: { CALENDAR_UPCOMING_LEAD_MS: 900000, CALENDAR_UPCOMING_SALIENCE: 0.9 }
    });
    pollOnce(sensor);
    var cal = bus._events.find(function (e) { return e.name === 'perception.calendar'; });
    assert.equal(cal.payload.salience, 0.9);
  });

  it('handles ISO-string dueAt values (not just epoch ms)', function () {
    var iso = new Date(nowPlus(5 * 60000)).toISOString();
    var reminders = [{ id: 'r1', text: 'iso event', dueAt: iso, fired: false }];
    var bus = fakeBus();
    var sensor = createCalendarUpcomingSensor({
      calendar: fakeCalendar(reminders), bus: bus, config: { CALENDAR_UPCOMING_LEAD_MS: 900000 }
    });
    pollOnce(sensor);
    var cal = bus._events.filter(function (e) { return e.name === 'perception.calendar'; });
    assert.equal(cal.length, 1, 'ISO-string dueAt must parse correctly');
  });

  it('never throws on calendar errors (best-effort)', function () {
    var badCalendar = { listReminders: function () { throw new Error('disk full'); } };
    var sensor = createCalendarUpcomingSensor({ calendar: badCalendar, bus: fakeBus(), config: {} });
    assert.doesNotThrow(function () { pollOnce(sensor); });
  });

  it('never throws when calendar is null (defensive)', function () {
    var sensor = createCalendarUpcomingSensor({ calendar: null, bus: fakeBus(), config: {} });
    assert.doesNotThrow(function () { pollOnce(sensor); });
  });

});
