'use strict';

// test/parse-when-widening.test.js — Wave 7 (2026-08-13).
//
// parseWhen() (from-calendar.js, shared by reminder_add's free-form `when`
// and timer_add's internally-built one) only covered ISO, "in N units",
// "today/tomorrow H(:MM)(am/pm)", bare "HH:MM(am/pm)", and literal
// "tomorrow" — every one of them either needing a colon or a today/tomorrow
// prefix. Ordinary phrasing like a bare "5pm", "at 9:30", "noon", or "in an
// hour" fell through to "Could not parse that time" with no fixture proving
// it either way. Widened via addReminder()/buildCalendarTools() (parseWhen
// itself is not exported) so this exercises the real tool contract, not a
// reimplementation of the regex.

const { test, describe } = require('node:test');
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

async function due(when) {
  const tools = buildCalendarTools({ fs: fakeVaultFs(), bus: null });
  const fn = toolFn(tools, 'reminder_add');
  const res = await fn({ text: 'x', when });
  return res;
}

describe('parseWhen widening — new patterns', () => {
  test('a bare hour with am/pm and no colon parses ("5pm")', async () => {
    const res = await due('5pm');
    assert.equal(res.ok, true, JSON.stringify(res));
    const d = new Date(res.result.reminder.dueAt);
    assert.equal(d.getHours(), 17);
    assert.equal(d.getMinutes(), 0);
  });

  test('a bare hour, am, no colon ("9am")', async () => {
    const res = await due('9am');
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(new Date(res.result.reminder.dueAt).getHours(), 9);
  });

  test('12am/12pm still normalize correctly with no colon', async () => {
    const midnight = await due('12am');
    assert.equal(new Date(midnight.result.reminder.dueAt).getHours(), 0);
    const noonRes = await due('12pm');
    assert.equal(new Date(noonRes.result.reminder.dueAt).getHours(), 12);
  });

  test('a leading "at " is tolerated on every existing pattern shape', async () => {
    const r1 = await due('at 5pm');
    assert.equal(r1.ok, true);
    assert.equal(new Date(r1.result.reminder.dueAt).getHours(), 17);

    const r2 = await due('at tomorrow 9am');
    assert.equal(r2.ok, true);
    assert.equal(new Date(r2.result.reminder.dueAt).getHours(), 9);
  });

  test('"noon" and "midnight" parse to the next occurrence of 12:00/00:00', async () => {
    const noonRes = await due('noon');
    assert.equal(noonRes.ok, true, JSON.stringify(noonRes));
    assert.equal(new Date(noonRes.result.reminder.dueAt).getHours(), 12);

    const midnightRes = await due('midnight');
    assert.equal(midnightRes.ok, true, JSON.stringify(midnightRes));
    assert.equal(new Date(midnightRes.result.reminder.dueAt).getHours(), 0);
  });

  test('"in an hour" and "in half an hour" parse without a digit to anchor on', async () => {
    const before = Date.now();
    const hourRes = await due('in an hour');
    assert.equal(hourRes.ok, true, JSON.stringify(hourRes));
    const hourDelta = hourRes.result.reminder.dueAt - before;
    assert.ok(hourDelta > 3500000 && hourDelta <= 3600000 + 5000, 'expected ~1 hour, got ' + hourDelta);

    const halfRes = await due('in half an hour');
    assert.equal(halfRes.ok, true);
    const halfDelta = halfRes.result.reminder.dueAt - before;
    assert.ok(halfDelta > 1700000 && halfDelta <= 1800000 + 5000, 'expected ~30 minutes, got ' + halfDelta);
  });

  test('a bare hour with no am/pm and no colon is still honestly refused — genuinely ambiguous, not guessed at', async () => {
    const res = await due('5');
    assert.equal(res.ok, false);
    assert.match(res.error, /Could not parse that time/);
  });

  test('existing patterns are unaffected by the widening (no regression)', async () => {
    const iso = await due('2027-01-01T09:00:00');
    assert.equal(iso.ok, true);

    const rel = await due('in 10 minutes');
    assert.equal(rel.ok, true);

    const dayTime = await due('tomorrow 3pm');
    assert.equal(dayTime.ok, true);
    assert.equal(new Date(dayTime.result.reminder.dueAt).getHours(), 15);

    const bareColon = await due('9:30am');
    assert.equal(bareColon.ok, true);
    assert.equal(new Date(bareColon.result.reminder.dueAt).getHours(), 9);
    assert.equal(new Date(bareColon.result.reminder.dueAt).getMinutes(), 30);

    const literalTomorrow = await due('tomorrow');
    assert.equal(literalTomorrow.ok, true);
  });
});
