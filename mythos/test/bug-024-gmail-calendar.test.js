'use strict';

// BUG-024 — Gmail + Calendar integration.
// Two independent code-level guarantees, bundled under one bug id per BUGS.md:
//   1. Gmail tools return a clean, actionable config error when Google creds
//      are unset (and keep returning it on repeated calls — regression guard
//      for a module-level adapter-cache bug found and fixed this session).
//   2. The calendar reminder sensor (src/core/sensors/reminder-sensor.js)
//      actually polls fireDueReminders() on an interval and wires bus.emit
//      through to 'reminder.due' — confirming it is not a dead function.
//
// Neither of these touches real Google APIs — no network, no OAuth.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { fakeBus } = require('./helpers');
const { createCalendarEffector } = require('../src/core/effectors/from-calendar');
const { createReminderSensor } = require('../src/core/sensors/reminder-sensor');

function toolFn(tools, name) {
  return tools.find((t) => t.name === name).fn;
}

function fakeVaultFs() {
  var store = {};
  return {
    readJSON: function (path, fallback) {
      return store[path] !== undefined ? JSON.parse(JSON.stringify(store[path])) : fallback;
    },
    // Aliased: this fake holds parsed objects, so there is no corrupt-JSON case
    // for the strict reader to differ on (see test/silent-data-loss.test.js).
    readJSONStrict: function (path, fallback) {
      return store[path] !== undefined ? JSON.parse(JSON.stringify(store[path])) : fallback;
    },
    writeJSON: function (path, data) {
      store[path] = JSON.parse(JSON.stringify(data));
    },
    ensureDir: function () {},
  };
}

const CLEAN_GMAIL_MSG = 'Gmail is not configured — set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN.';
const GOOGLE_ENV_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];

describe('BUG-024: gmail tools return a clean config error when Google creds are unset', () => {
  const saved = {};

  beforeEach(() => {
    GOOGLE_ENV_KEYS.forEach((k) => {
      saved[k] = process.env[k];
      delete process.env[k];
    });
    // Bust require cache so from-gmail.js's module-level adapter cache starts fresh
    // for every test, regardless of what a previous test in this file did.
    delete require.cache[require.resolve('../src/core/effectors/from-gmail')];
    delete require.cache[require.resolve('../adapters/google')];
  });

  afterEach(() => {
    GOOGLE_ENV_KEYS.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
  });

  it('gmail_unread returns the exact clean config error', async () => {
    const { buildTools } = require('../src/core/effectors/from-gmail');
    const tools = buildTools({ logger: { warn: () => {} } });
    const gmail_unread = toolFn(tools, 'gmail_unread');

    const result = await gmail_unread({});

    assert.equal(result.ok, false);
    assert.equal(result.result.error, CLEAN_GMAIL_MSG);
  });

  it('gmail_send returns the exact clean config error', async () => {
    const { buildTools } = require('../src/core/effectors/from-gmail');
    const tools = buildTools({ logger: { warn: () => {} } });
    const gmail_send = toolFn(tools, 'gmail_send');

    const result = await gmail_send({ to: 'a@b.com', subject: 'hi', body: 'hello' });

    assert.equal(result.ok, false);
    assert.equal(result.result.error, CLEAN_GMAIL_MSG);
  });

  it('keeps returning the clean error on a second call (regression guard: ensureAdapter must not cache the not-ready sentinel)', async () => {
    const { buildTools } = require('../src/core/effectors/from-gmail');
    const tools = buildTools({ logger: { warn: () => {} } });
    const gmail_unread = toolFn(tools, 'gmail_unread');

    const first = await gmail_unread({});
    const second = await gmail_unread({});

    assert.equal(first.result.error, CLEAN_GMAIL_MSG);
    // Before the fix, ensureAdapter() cached the {ready:false} object itself,
    // so this second call would fall through the `if (!a)` guard and crash
    // into a.listUnread() on a non-adapter object — surfacing as a cryptic
    // "Gmail fetch failed: a.listUnread is not a function" instead of this.
    assert.equal(second.result.error, CLEAN_GMAIL_MSG);
  });
});

describe('BUG-024: reminder-sensor polls calendar.fireDueReminders() periodically', () => {
  it('emits reminder.due for a past-due reminder immediately on start, marks it fired, and does not re-fire', (t) => {
    // F2 (2026-08-12, G5 diagnosis): waiting for the first interval tick before
    // ever checking was ITSELF the up-to-30s lateness bug — an already-overdue
    // reminder must fire the instant the sensor starts, not wait out a poll
    // cycle it has no reason to wait for. See reminder-sensor.js.
    t.mock.timers.enable({ apis: ['setInterval'] });

    const bus = fakeBus();
    const fs = fakeVaultFs();
    const now = Date.now();
    fs.writeJSON('Calendar/reminders.json', [
      { id: 'rem-a', text: 'stand up', dueAt: now - 5000, createdAt: now - 10000, fired: false },
    ]);
    const calendar = createCalendarEffector({ fs, bus });
    const sensor = createReminderSensor({ calendar, bus });

    sensor.start();

    const evt = bus._lastEvent('reminder.due');
    assert.ok(evt, 'an already-overdue reminder must fire immediately on start, not wait for a poll tick');
    assert.equal(evt.payload.id, 'rem-a');
    assert.equal(evt.payload.text, 'stand up');

    const stored = fs.readJSON('Calendar/reminders.json', []);
    assert.equal(stored[0].fired, true, 'reminder should be marked fired in the store');

    t.mock.timers.tick(30000);
    const dueEvents = bus._emitted().filter((e) => e.type === 'reminder.due');
    assert.equal(dueEvents.length, 1, 'an already-fired reminder must not fire again on a later tick');

    sensor.stop();
  });

  it('stops polling once stop() is called', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    const bus = fakeBus();
    const fs = fakeVaultFs();
    const now = Date.now();
    const calendar = createCalendarEffector({ fs, bus });
    const sensor = createReminderSensor({ calendar, bus });

    sensor.start();
    sensor.stop();

    // Seed a past-due reminder only after stopping — if the interval were
    // still alive, the next tick would fire it.
    fs.writeJSON('Calendar/reminders.json', [
      { id: 'rem-b', text: 'should not fire', dueAt: now - 1000, createdAt: now - 2000, fired: false },
    ]);

    t.mock.timers.tick(60000);
    assert.equal(bus._lastEvent('reminder.due'), null, 'sensor must not poll after stop()');
  });
});
