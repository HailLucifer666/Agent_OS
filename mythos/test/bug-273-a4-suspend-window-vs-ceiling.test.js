'use strict';

// bug-273-a4-suspend-window-vs-ceiling.test.js — BUG-273 A4.
//
// FILED AS: "suspend-ceiling-fail-open fired 8x — the media/TTS capture-suspend
// ceiling is being reached routinely, not exceptionally. Check whether media
// suspends are armed and never cleared."
//
// MEASURED in mythos-server.log for 2026-08-18:
//   reason "media-start"                8
//   reason "suspend-ceiling-fail-open"  8
//   reason "watchdog-clear"             0
//
// So they ARE armed and never cleared — and that is the DESIGN, not a leak.
// suspendForMedia() asks for MEDIA_START_SUSPEND_MS (8s) precisely because only the
// opening burst of a track is suppressed; there is no event that clears it and there
// is not meant to be one. The expiry therefore fired on 100% of the designed path
// while wearing a name that reads as an exceptional safety net catching a stuck
// state, and reading those 8 as 8 fail-opens is what filed A4 as a leak in the first
// place.
//
// Q6 — this is the same defect BUG-272 fixed one level up. There, the own-voice hold
// ceiling and the media-suspend ceiling both emitted a bare 'ceiling-fail-open' from
// unrelated timers, so a count of 16 could not be attributed to either. Same shape,
// one level down: ONE timer serving two purposes under one label.
//
// Q8 — WHAT DELIBERATELY DOES NOT CHANGE. The gate still fails open, still after the
// same durations, and MAX_SUSPEND_MS keeps the fail-open name because there it means
// what it says: a 'speaking' state that never cleared, which without the net would
// leave Live permanently deaf with no symptom except silence. Only the reporting is
// split. Nothing about when the mic reopens moves.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = () => fs.readFileSync(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 's2s-bridge.js'), 'utf8',
).replace(/\r\n/g, '\n');

describe('BUG-273 A4 — one timer, two meanings, two names', () => {
  it('the arm site decides which expiry this will be, from the caller\'s own hold', () => {
    const s = src();
    assert.match(s, /const isDeliberateWindow = ceiling < MAX_SUSPEND_MS;/,
      'a caller-chosen hold is shorter than the net by construction, and that is the '
      + 'whole distinction. Reconstructing it from elapsed time in the timer would be a '
      + 'guess about what the caller meant.');
  });

  it('a routine window elapsing and a real fail-open use different reasons', () => {
    const s = src();
    assert.match(s, /reason: isDeliberateWindow \? 'suspend-window-elapsed' : 'suspend-ceiling-fail-open'/,
      'a count that mixes 8 routine 8s windows with a genuine stuck-state rescue tells '
      + 'the next reader nothing, which is exactly what happened here');
  });

  it('the expiry reports the window it actually served', () => {
    assert.match(src(), /heldMs: ceiling,/,
      'without it a log shows that a window ended but not which one, and the two are '
      + '8000ms and 30000ms apart');
  });

  it('Q8 — the gate still fails open, and the clamp is untouched', () => {
    const s = src();
    assert.match(s, /captureSuspended = false;\s+\/\/ fail open: a deaf assistant is the worse failure/,
      'the behaviour was never the bug — a deaf assistant is still the worse failure');
    assert.match(s, /const ceiling = Math\.min\(Number\(holdMs\) \|\| MAX_SUSPEND_MS, MAX_SUSPEND_MS\);/,
      'and the clamp must stay, or a caller could ask for an unbounded mute');
  });

  it('Q8 — suspendForMedia still asks for the 8s opening-burst window, unchanged', () => {
    const s = src();
    assert.match(s, /const MEDIA_START_SUSPEND_MS = 8000;/,
      'A4 is about what the log CALLS this, not about how long the mic stays shut. '
      + 'Shortening the window would be a different change with a different argument.');
    assert.match(s, /setCaptureSuspended\(true, Number\(holdMs\) \|\| MEDIA_START_SUSPEND_MS, 'media-start'\)/);
  });
});

describe('BUG-273 A4 — the verifier stops counting design as failure', () => {
  const vs = () => fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'verify-voice-session.js'), 'utf8',
  ).replace(/\r\n/g, '\n');

  it('counts routine expiries separately from fail-opens', () => {
    assert.match(vs(), /const suspendElapsed = byReason\['suspend-window-elapsed'\] \|\| 0;/);
    assert.match(vs(), /routine media-window expiry/,
      'the two numbers have to appear side by side, or the split buys nothing for a reader');
  });

  it('a real fail-open is now its own pass/fail criterion', () => {
    assert.match(vs(), /the media-suspend safety net never had to fire \(BUG-273 A4\)/,
      'reaching MAX_SUSPEND_MS means a speaking state never cleared — a fault, not a rhythm');
  });

  it('Q5 — an OLD log is labelled as old rather than scored as clean', () => {
    // A log written before the split shows every expiry under the fail-open name, so
    // the new criterion would read as 8 faults. Absent-vs-zero again: say which it is.
    assert.match(vs(), /predates the BUG-273 A4 split/,
      'silently reporting a pre-split log against post-split names is how a false red '
      + '(or a false green) gets believed');
  });
});
