'use strict';

// BUG-147 — the orb must react to the CLICK, not to the network round-trip.
//
// s2s-bridge.js runs in the browser and its own header explains why it has no
// behavioural unit test: getUserMedia, AudioWorkletNode and the live socket have
// no Node double that wouldn't just re-assert the mocks. Per the root CLAUDE.md's
// Electron lesson ("source-shape assertions are the only automated guard
// available"), these pin the three invariants the fix depends on, so a later edit
// cannot quietly restore the blank-stare behaviour.
//
// What was wrong:
//   1. Nothing repainted until a live-state arrived from the server, so a click
//      whose live-open produced no reply looked identical to a click that never
//      registered — the operator's "the gold button does nothing at all".
//   2. The auto-reopen guard tested `active`, which is still false during the
//      ~100ms of getUserMedia + worklet setup, so a `closed` arriving in that
//      window was dropped and the session was never retried.
//
// Run: cd mythos && node --test test/bug-147-orb-click-feedback.test.js

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 's2s-bridge.js');
const src = fs.readFileSync(SRC, 'utf8');

describe('BUG-147: the orb reacts to the click, and a silent failure becomes visible', () => {
  test('start() sets a visible state BEFORE awaiting the network or the microphone', () => {
    const startIdx = src.indexOf('async function start()');
    assert.ok(startIdx !== -1, 'start() must still exist');
    const sendIdx = src.indexOf("sendMessage({ type: 'live-open' })", startIdx);
    assert.ok(sendIdx !== -1, 'start() must still send live-open');

    const preamble = src.slice(startIdx, sendIdx);
    assert.match(preamble, /setState\(/,
      'start() must paint a state before the live-open round-trip — that repaint IS the click feedback');
    assert.match(preamble, /startRequested\s*=\s*true/,
      'start() must record that a start was requested before any await');
  });

  test("the click state is one core-orb.js actually renders", () => {
    // core-orb.js maps anything outside listening/processing/speaking to 'idle',
    // so an invented state name (e.g. 'connecting') would render as no change at
    // all — which is precisely the bug being fixed.
    const orb = fs.readFileSync(path.join(__dirname, '..', 'ui', 'public', 'js', 'neural-map', 'core-orb.js'), 'utf8');
    const rendered = ['listening', 'processing', 'speaking'].filter((s) => orb.includes("'" + s + "'"));
    assert.deepEqual(rendered.sort(), ['listening', 'processing', 'speaking'],
      'core-orb.js must still recognise exactly these three non-idle states');

    const startIdx = src.indexOf('async function start()');
    const sendIdx = src.indexOf("sendMessage({ type: 'live-open' })", startIdx);
    const preamble = src.slice(startIdx, sendIdx);
    const used = rendered.filter((s) => preamble.includes("setState('" + s + "')"));
    assert.ok(used.length > 0,
      'the pre-await setState must use a state core-orb.js renders, or the click is still invisible ' +
      '(found none of: ' + rendered.join(', ') + ')');
  });

  test('an unanswered live-open turns into a visible failure rather than silence', () => {
    assert.match(src, /OPEN_ACK_TIMEOUT_MS/,
      'there must be a bounded wait for the server to answer a live-open');
    assert.match(src, /armOpenAckTimer\(\)/,
      'the timer must actually be armed on the live-open path');
    assert.match(src, /clearOpenAckTimer\(\)/,
      'and cleared when a live-state arrives, or a healthy session would report a false failure');

    // The clear must happen inside the live-state handler — arming without
    // clearing (or clearing somewhere unrelated) would make every session report
    // a failure a few seconds in.
    const handlerIdx = src.indexOf('onLiveStateMsg = (msg)');
    assert.ok(handlerIdx !== -1, 'the live-state handler must still exist');
    const handler = src.slice(handlerIdx, handlerIdx + 800);
    assert.match(handler, /clearOpenAckTimer\(\)/,
      'the live-state handler must cancel the pending "no answer" fallback');
  });

  test('the auto-reopen guard no longer depends on capture already running', () => {
    const guardIdx = src.indexOf("if (s === 'closed'");
    assert.ok(guardIdx !== -1, 'the BUG-059 auto-reopen guard must still exist');
    const guard = src.slice(guardIdx, src.indexOf('\n', guardIdx + 200) + 1);
    assert.match(guard, /startRequested/,
      'the guard must accept a close that arrives while the mic is still being set up, ' +
      'or a startup failure is silently dropped and the session never retried');
  });

  test('stop() clears the request flag and the pending timer, so a give-up cannot fire a late caption', () => {
    const stopIdx = src.indexOf('async function stop()');
    assert.ok(stopIdx !== -1, 'stop() must still exist');
    // Must be before stop()'s own early return, otherwise a stop during startup
    // leaves the flag set and the timer armed.
    const earlyReturn = src.indexOf('if (!active && !stream && !audioCtx) return;', stopIdx);
    assert.ok(earlyReturn !== -1, "stop()'s early return must still exist");
    const beforeReturn = src.slice(stopIdx, earlyReturn);
    assert.match(beforeReturn, /startRequested\s*=\s*false/,
      'stop() must clear startRequested before its early return');
    assert.match(beforeReturn, /clearOpenAckTimer\(\)/,
      'stop() must cancel the pending ack timer before its early return');
  });
});
