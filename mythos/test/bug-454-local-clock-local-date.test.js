'use strict';

// BUG-454 — buildPrompt's `LOCAL CLOCK:` line glued a UTC date to a local time.
//
// The line was built from one `now` but two time zones:
//   sysDate = now.toISOString().slice(0, 10)                    -> UTC calendar date
//   sysTime = now.toLocaleTimeString('en-US', { hour12: false }) -> LOCAL wall time
// Whenever the local calendar date differs from the UTC one, the brain was told
// the wrong day. On a UTC+5:30 machine that is every night from 00:00 to 05:30
// local (yesterday's date); west of UTC it is every evening (tomorrow's date).
// Seen 2026-09-24 in a real full-suite run at 01:49 local, which printed
// `LOCAL CLOCK: 2026-09-23 01:49:57`. The prompt's "machine time — may be wrong"
// caveat does not cover it: the machine clock was right, the formatting was not.
//
// WHY THE ZONE IS PINNED. The bug only exists when local date != UTC date, so a
// test that runs in whatever zone the host happens to use proves nothing on a UTC
// CI runner. Each case assigns process.env.TZ (Node re-reads the zone on
// assignment, on Windows too — measured on v26.1.0) and holds Date with the fake
// clock so the instant is exact. The `zoneTookEffect` precondition makes a broken
// harness fail with its own message instead of passing for the wrong reason.
//
// Mutation probes, run 2026-09-24 (each mutation diffed to confirm it applied,
// then restored from a file copy with an empty diff afterwards):
//  (a) the ORIGINAL line, `now.toISOString().slice(0, 10)`: tests (1) and (3)
//      go red — (1) prints `2026-09-23 01:49:57`, (3) prints
//      `2026-09-24 20:30:00`. Test (2) stays green, as it must: in that case the
//      two dates agree, so it cannot tell the two bases apart.
//  (b) sysDate built from `new Date()` instead of `now` (a second read of the
//      clock): all three stay green under the held clock, which is expected —
//      the fake clock makes both reads return the same instant. This is the
//      bound of this file: it pins WHICH calendar the date comes from, not that
//      it comes from the same read as the time.
//  (c) sysDate from `new Intl.DateTimeFormat('en-CA').format()` with NO
//      argument: (2) and (3) go red, printing `2026-09-24 11:30:00` and
//      `2026-09-24 20:30:00`. Intl ignores the fake clock and reads the real one
//      (2026-09-24 that day), which is why the fix passes `now` explicitly. The
//      three cases expect two different dates, so this mutation is caught on
//      any real day: on 2026-09-23 itself only (1) goes red, and on any day
//      other than those two all three do.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { _internal } = require('../src/core/voice/voice-agent');

// Deleting process.env.TZ does not make Node re-read the zone (measured: the
// last assigned zone stays in force), so restore by assigning back the zone
// that was actually in effect.
const ORIGINAL_TZ = process.env.TZ;
const ORIGINAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
after(() => {
  process.env.TZ = ORIGINAL_ZONE;
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

function clockLineAt(t, zone, isoInstant) {
  process.env.TZ = zone;
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(isoInstant) });
  const prompt = _internal.buildPrompt({ text: 'what day is it', history: [], toolResults: null });
  const match = prompt.match(/LOCAL CLOCK: (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
  assert.ok(match, 'prompt must carry a LOCAL CLOCK line');
  return match[1];
}

function zoneTookEffect(expectedLocalDay, expectedUtcDay) {
  const held = new Date();
  assert.equal(held.getDate(), expectedLocalDay, 'precondition: TZ + held clock must give the expected LOCAL day');
  assert.equal(held.getUTCDate(), expectedUtcDay, 'precondition: held clock must give the expected UTC day');
}

describe('BUG-454: LOCAL CLOCK prints the local calendar date of the same instant', () => {
  it('(1) east of UTC after local midnight: today\'s local date, not yesterday\'s UTC date', (t) => {
    const line = clockLineAt(t, 'Asia/Colombo', '2026-09-23T20:19:57Z');
    zoneTookEffect(24, 23);
    assert.equal(line, '2026-09-24 01:49:57');
  });

  it('(2) adjacent: when local and UTC dates agree, the date is unchanged', (t) => {
    const line = clockLineAt(t, 'Asia/Colombo', '2026-09-23T06:00:00Z');
    zoneTookEffect(23, 23);
    assert.equal(line, '2026-09-23 11:30:00');
  });

  it('(3) west of UTC in the evening: today\'s local date, not tomorrow\'s UTC date', (t) => {
    const line = clockLineAt(t, 'America/Los_Angeles', '2026-09-24T03:30:00Z');
    zoneTookEffect(23, 24);
    assert.equal(line, '2026-09-23 20:30:00');
  });
});
