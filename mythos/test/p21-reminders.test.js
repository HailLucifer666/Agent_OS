'use strict';

// P21 — calendar/reminder effector: parseWhen + CRUD + fire-due

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createCalendarEffector } = require('../src/core/effectors/from-calendar');

function fakeFs() {
  var store = {};
  return {
    readJSON: function(path, fallback) { return store[path] !== undefined ? JSON.parse(JSON.stringify(store[path])) : fallback; },
    writeJSON: function(path, data) { store[path] = JSON.parse(JSON.stringify(data)); },
    ensureDir: function() {},
    vaultPath: function() { return '/vault'; }
  };
}

describe('P21: parseWhen', () => {
  it('parses "in 20 minutes"', () => {
    var now = Date.now();
    var effector = createCalendarEffector({ fs: fakeFs() });
    var result = effector.parseWhen('in 20 minutes', now);
    assert.ok(result !== null);
    assert.ok(result >= now + 1199000 && result <= now + 1201000, 'should be ~20min from now');
  });

  it('parses "in 2 hours"', () => {
    var now = Date.now();
    var effector = createCalendarEffector({ fs: fakeFs() });
    var result = effector.parseWhen('in 2 hours', now);
    assert.ok(result !== null);
    assert.ok(result >= now + 7199000 && result <= now + 7201000);
  });

  it('parses "in 1 day"', () => {
    var now = Date.now();
    var effector = createCalendarEffector({ fs: fakeFs() });
    var result = effector.parseWhen('in 1 day', now);
    assert.ok(result !== null);
    assert.ok(result >= now + 86399000 && result <= now + 86401000);
  });

  it('parses ISO datetime', () => {
    var now = Date.now();
    var effector = createCalendarEffector({ fs: fakeFs() });
    var future = new Date(now + 3600000);
    var iso = future.getFullYear() + '-' + String(future.getMonth()+1).padStart(2,'0') + '-' +
              String(future.getDate()).padStart(2,'0') + ' ' +
              String(future.getHours()).padStart(2,'0') + ':' +
              String(future.getMinutes()).padStart(2,'0');
    var result = effector.parseWhen(iso, now);
    assert.ok(result !== null, 'parsed ISO: ' + iso);
    assert.ok(result > now);
  });

  it('parses "tomorrow 9am"', () => {
    var now = Date.now();
    var effector = createCalendarEffector({ fs: fakeFs() });
    var result = effector.parseWhen('tomorrow 9am', now);
    assert.ok(result !== null);
    assert.ok(result > now);
    var d = new Date(result);
    assert.ok(d.getHours() === 9, 'hour should be 9, got ' + d.getHours());
  });

  it('parses "tomorrow 9:30pm"', () => {
    var now = Date.now();
    var effector = createCalendarEffector({ fs: fakeFs() });
    var result = effector.parseWhen('tomorrow 9:30pm', now);
    assert.ok(result !== null);
    var d = new Date(result);
    assert.equal(d.getHours(), 21);
    assert.equal(d.getMinutes(), 30);
  });

  it('parses "today 15:30"', () => {
    var now = Date.now();
    var effector = createCalendarEffector({ fs: fakeFs() });
    // set now to early morning so "today 15:30" is in the future
    var morning = new Date(now);
    morning.setHours(6, 0, 0, 0);
    var result = effector.parseWhen('today 15:30', morning.getTime());
    assert.ok(result !== null);
    var d = new Date(result);
    assert.equal(d.getHours(), 15);
    assert.equal(d.getMinutes(), 30);
  });

  it('parses bare "14:00"', () => {
    var now = Date.now();
    var effector = createCalendarEffector({ fs: fakeFs() });
    var result = effector.parseWhen('14:00', now);
    assert.ok(result !== null);
    var d = new Date(result);
    assert.equal(d.getHours(), 14);
    assert.equal(d.getMinutes(), 0);
    assert.ok(result > now, 'should be next occurrence');
  });

  it('parses bare "9:30pm"', () => {
    var now = Date.now();
    var effector = createCalendarEffector({ fs: fakeFs() });
    var result = effector.parseWhen('9:30pm', now);
    assert.ok(result !== null);
    var d = new Date(result);
    assert.equal(d.getHours(), 21);
    assert.equal(d.getMinutes(), 30);
  });

  it('parses "tomorrow" as tomorrow 9am', () => {
    var now = Date.now();
    var effector = createCalendarEffector({ fs: fakeFs() });
    var result = effector.parseWhen('tomorrow', now);
    assert.ok(result !== null);
    var d = new Date(result);
    assert.equal(d.getHours(), 9);
  });

  it('returns null for unparseable input', () => {
    var effector = createCalendarEffector({ fs: fakeFs() });
    assert.equal(effector.parseWhen('next tuesday'), null);
    assert.equal(effector.parseWhen('soon'), null);
    assert.equal(effector.parseWhen(''), null);
    assert.equal(effector.parseWhen(null), null);
    assert.equal(effector.parseWhen(undefined), null);
  });
});

describe('P21: reminder CRUD', () => {
  it('adds and lists a reminder', () => {
    var effector = createCalendarEffector({ fs: fakeFs() });
    var result = effector.addReminder({ text: 'stretch', when: 'in 2 minutes' });
    assert.ok(result.ok);
    assert.ok(result.result.reminder.id);
    assert.equal(result.result.reminder.text, 'stretch');
    assert.ok(!result.result.reminder.fired);

    var list = effector.listReminders();
    assert.equal(list.result.reminders.length, 1);
    assert.equal(list.result.reminders[0].text, 'stretch');
  });

  it('rejects empty text', () => {
    var effector = createCalendarEffector({ fs: fakeFs() });
    var result = effector.addReminder({ text: '' });
    assert.ok(!result.ok);
    assert.ok(result.error.indexOf('text required') !== -1);
  });

  it('rejects unparseable time', () => {
    var effector = createCalendarEffector({ fs: fakeFs() });
    var result = effector.addReminder({ text: 'test', when: 'someday' });
    assert.ok(!result.ok);
    assert.ok(result.error.indexOf('Could not parse') !== -1);
  });

  it('cancels a reminder by text match', () => {
    var effector = createCalendarEffector({ fs: fakeFs() });
    effector.addReminder({ text: 'take a break', when: 'in 30 minutes' });
    effector.addReminder({ text: 'call mom', when: 'in 1 hour' });

    var cancel = effector.cancelReminder({ query: 'break' });
    assert.ok(cancel.ok);
    assert.equal(cancel.result.cancelled.text, 'take a break');

    var list = effector.listReminders();
    assert.equal(list.result.reminders.length, 1);
    assert.equal(list.result.reminders[0].text, 'call mom');
  });

  it('fires due reminders and emits bus event', () => {
    var events = [];
    var bus = { emit: function(evt, data) { events.push({ evt: evt, data: data }); } };
    var now = Date.now();
    var fs = fakeFs();
    // Pre-seed a past-due reminder
    fs.writeJSON('Calendar/reminders.json', [
      { id: 'rem-past', text: 'overdue', dueAt: now - 1000, createdAt: now - 5000, fired: false },
      { id: 'rem-future', text: 'not yet', dueAt: now + 100000, createdAt: now, fired: false }
    ]);

    var effector = createCalendarEffector({ fs: fs, bus: bus });
    var fired = effector.fireDueReminders();
    assert.equal(fired.length, 1);
    assert.equal(fired[0].text, 'overdue');
    assert.equal(events.length, 1);
    assert.equal(events[0].evt, 'reminder.due');
    assert.equal(events[0].data.text, 'overdue');

    // Second call should not re-fire
    var fired2 = effector.fireDueReminders();
    assert.equal(fired2.length, 0);
  });
});
