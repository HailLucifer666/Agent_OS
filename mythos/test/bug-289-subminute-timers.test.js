'use strict';

// BUG-289 — a sub-minute timer was unsettable, and the model covered for it by
// pretending to count.
//
// FROM THE OPERATOR'S OWN LOGS, 2026-08-20. Two calls, seconds apart, both fail:
//
//   19:15:40  timer_add    {"minutes":0.5}
//             -> fail: Could not parse that time. Try ISO date, "in 20 minutes",
//                      "tomorrow 9am", or "HH:MM".
//   19:15:59  reminder_add {"when":"in 30 seconds","text":"30 seconds are up"}
//             -> fail: (the same string)
//
// and at 19:16:44 the operator filed an incident:
//
//   "following timer_add and reminder_add failures, assistant claimed successful
//    'manual internal count' of 30 seconds, which was subjective and inaccurate."
//
// TWO SEPARATE DEFECTS produced that, and the hallucination is downstream of
// both. Fixing the model's behaviour is not on the table; removing the dead end
// it was papering over is.
//
//   1. timer_add builds `'in ' + minutes + ' minutes'` and hands that string to
//      parseWhen, whose relative pattern captures `(\d+)`. For minutes:0.5 the
//      string is "in 0.5 minutes" and the tool cannot read its own output. Any
//      fractional minute — the only way this tool can express a sub-minute
//      duration at all — was unsettable.
//   2. parseWhen's unit list is (minute|hour|day). There is no seconds unit, so
//      the natural phrasing fails too.
//
// And the error message names four formats, none of which can express seconds,
// so nothing in the failure told the model that seconds were the problem. It
// read as "you phrased it wrong" when the truth was "this cannot be done".
//
// The scheduler was never the constraint: reminder-sensor.js arms a precise
// setTimeout against the next due time and re-arms on calendar.reminder-added,
// so a 30s reminder fires at 30s rather than on the 30s safety-poll boundary.
// Checked before widening the parser, because a parser that accepts a duration
// the scheduler rounds up would replace a loud failure with a quiet one.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createCalendarEffector, buildCalendarTools } = require('../src/core/effectors/from-calendar');

function fakeFs() {
  var store = {};
  return {
    readJSON: function (path, fallback) { return store[path] !== undefined ? JSON.parse(JSON.stringify(store[path])) : fallback; },
    readJSONStrict: function (path, fallback) { return store[path] !== undefined ? JSON.parse(JSON.stringify(store[path])) : fallback; },
    writeJSON: function (path, data) { store[path] = JSON.parse(JSON.stringify(data)); },
    ensureDir: function () {},
    vaultPath: function () { return '/vault'; },
  };
}

describe('BUG-289: sub-minute durations', () => {
  it('parses "in 30 seconds" — the exact string reminder_add was given', () => {
    const now = Date.UTC(2026, 7, 20, 13, 45, 59);
    const effector = createCalendarEffector({ fs: fakeFs() });
    assert.equal(effector.parseWhen('in 30 seconds', now), now + 30000);
  });

  it('parses the singular "in 1 second"', () => {
    const now = Date.now();
    const effector = createCalendarEffector({ fs: fakeFs() });
    assert.equal(effector.parseWhen('in 1 second', now), now + 1000);
  });

  it('parses "in 0.5 minutes" — the exact string timer_add builds for minutes:0.5', () => {
    // The round trip is the defect: a numeric parameter is rendered into a
    // sentence and then read back by a natural-language parser. Until the tool
    // stops doing that, the parser has to be able to read what it writes.
    const now = Date.now();
    const effector = createCalendarEffector({ fs: fakeFs() });
    assert.equal(effector.parseWhen('in 0.5 minutes', now), now + 30000);
  });

  it('parses fractional hours', () => {
    const now = Date.now();
    const effector = createCalendarEffector({ fs: fakeFs() });
    assert.equal(effector.parseWhen('in 1.5 hours', now), now + 5400000);
  });

  it('still parses every whole-unit form it always did', () => {
    const now = Date.now();
    const effector = createCalendarEffector({ fs: fakeFs() });
    assert.equal(effector.parseWhen('in 20 minutes', now), now + 20 * 60000);
    assert.equal(effector.parseWhen('in 2 hours', now), now + 2 * 3600000);
    assert.equal(effector.parseWhen('in 3 days', now), now + 3 * 86400000);
    assert.equal(effector.parseWhen('in an hour', now), now + 3600000);
    assert.equal(effector.parseWhen('in half an hour', now), now + 1800000);
  });

  it('still refuses the genuinely ambiguous phrasings', () => {
    // Widening the number pattern must not turn "in a few minutes" into a guess.
    const now = Date.now();
    const effector = createCalendarEffector({ fs: fakeFs() });
    assert.equal(effector.parseWhen('in a few minutes', now), null);
    assert.equal(effector.parseWhen('in a couple hours', now), null);
    assert.equal(effector.parseWhen('sometime later', now), null);
    assert.equal(effector.parseWhen('in minutes', now), null);
    assert.equal(effector.parseWhen('in 5', now), null);
  });

  it('returns an integer timestamp even for a sub-millisecond fraction', () => {
    // n * 1000 is not necessarily an integer once decimals are allowed, and a
    // fractional epoch leaks into dueAt, JSON and every `>=` comparison the
    // sensor makes. Rounded at the source rather than defended downstream.
    const now = Date.now();
    const effector = createCalendarEffector({ fs: fakeFs() });
    const at = effector.parseWhen('in 1.0005 seconds', now);
    assert.equal(Number.isInteger(at), true, 'got a non-integer timestamp: ' + at);
    assert.equal(at, now + 1001);
  });

  it('refuses a malformed decimal rather than reading part of it', () => {
    const now = Date.now();
    const effector = createCalendarEffector({ fs: fakeFs() });
    assert.equal(effector.parseWhen('in 0..5 minutes', now), null);
    assert.equal(effector.parseWhen('in .5 minutes', now), null);
    assert.equal(effector.parseWhen('in 5. minutes', now), null);
  });
});

describe('BUG-289: timer_add end to end', () => {
  // One tool set per call would mean one fake vault per call, so timer_add and
  // reminder_list would write to and read from different stores — the list would
  // come back empty and read like a lost write. Build the set once and take both
  // tools out of it.
  function toolset() {
    const tools = buildCalendarTools({ fs: fakeFs() });
    return function (name) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, name + ' tool not registered');
      return tool;
    };
  }

  function toolNamed(name) {
    return toolset()(name);
  }

  it('timer_add {minutes: 0.5} succeeds — the call the operator actually made', async () => {
    const res = await toolNamed('timer_add').fn({ minutes: 0.5, label: '30 seconds are up' });
    assert.equal(res.ok, true, 'expected ok, got: ' + JSON.stringify(res));
  });

  it('a sub-minute timer is scheduled sub-minute, not rounded up to one', async () => {
    // The point of the whole ticket. A timer that reports success and then fires
    // at 60s is the same lie in a different place.
    const before = Date.now();
    const res = await toolNamed('timer_add').fn({ minutes: 0.5, label: 'half a minute' });
    assert.equal(res.ok, true);
    // addReminder returns {reminder: record}; the due timestamp is record.dueAt.
    const due = res.result && res.result.reminder && res.result.reminder.dueAt;
    assert.ok(typeof due === 'number', 'timer_add must report when it will fire, got: ' + JSON.stringify(res.result));
    const delta = due - before;
    assert.ok(delta > 25000 && delta < 35000, 'expected ~30s, got ' + delta + 'ms');
  });

  it('timer_add still rings — the alert flag is what separates it from reminder_add', async () => {
    const tool = toolset();
    const res = await tool('timer_add').fn({ minutes: 0.5 });
    assert.equal(res.ok, true);
    const list = await tool('reminder_list').fn({});
    const items = (list.result && (list.result.reminders || list.result.items)) || [];
    assert.ok(items.length >= 1, 'the timer should be listed: ' + JSON.stringify(list.result));
    assert.ok(items.some((r) => r.alertSound === true), 'a timer must keep alertSound: ' + JSON.stringify(items));
  });
});

describe('BUG-289: the failure names the real limit', () => {
  it('the parse failure tells the caller seconds are supported', async () => {
    // The old message listed ISO, "in 20 minutes", "tomorrow 9am" and "HH:MM" —
    // four formats, not one of which can express seconds. A model reading it
    // learns "rephrase", not "this is impossible", which is how a dead end turns
    // into an invented workaround.
    const res = await buildCalendarTools({ fs: fakeFs() })
      .find((t) => t.name === 'reminder_add').fn({ text: 'x', when: 'whenever' });
    assert.equal(res.ok, false);
    const msg = String(res.error || (res.result && res.result.error) || '');
    assert.match(msg, /second/i, 'the failure must name seconds as a supported unit, got: ' + msg);
  });
});
