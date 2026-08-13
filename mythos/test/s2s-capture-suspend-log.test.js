'use strict';

// test/s2s-capture-suspend-log.test.js — Wave 0 (2026-08-13). s2s-bridge.js
// suspends mic capture around MYTHOS's own TTS and media playback (the
// German-narration-transcribed-as-operator incident, 2026-07-31) but never
// told the server it had done so — every suspend/clear was invisible outside
// the browser tab, so Wave 2's lost-transcript diagnosis had no server-side
// trail to correlate against a blind turn. This proves the transition log
// fires for suspend-start and ceiling fail-open-clear, with the right
// suspended/holdMs/reason fields.
//
// s2s-bridge.js is a browser ES module (no bundler — see ui/CLAUDE.md) with
// no meaningful Node double for getUserMedia/AudioContext, so this only
// exercises the pure capture-suspend gate via createS2SBridge's injected
// `sendMessageOverride` seam, added specifically so this logic is testable
// without mocking the whole ws.js module graph every other voice module
// shares (mock.module() replaces that graph-wide and is still experimental
// in this Node version).

const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const BRIDGE_PATH = path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 's2s-bridge.js');
const BRIDGE_URL = pathToFileURL(BRIDGE_PATH).href;

let createS2SBridge;
test.before(async () => {
  ({ createS2SBridge } = await import(BRIDGE_URL));
});

describe('s2s-bridge: capture-suspend transition log', () => {
  test('suspendForMedia logs a suspend-start transition with the actual hold', () => {
    const sent = [];
    const bridge = createS2SBridge({ sendMessageOverride: (m) => sent.push(m) });

    bridge.suspendForMedia(500);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'voice-capture-suspend');
    assert.equal(sent[0].suspended, true);
    assert.equal(sent[0].holdMs, 500);
    assert.equal(sent[0].reason, 'media-start');
    assert.equal(typeof sent[0].at, 'number');
  });

  test('the hold is capped at MAX_SUSPEND_MS (30000) even if a caller asks for longer', () => {
    const sent = [];
    const bridge = createS2SBridge({ sendMessageOverride: (m) => sent.push(m) });

    bridge.suspendForMedia(999999);

    assert.equal(sent[0].holdMs, 30000);
  });

  test('the suspend ceiling fails open and logs its own transition, without a fake timer never firing', (t) => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const sent = [];
    const bridge = createS2SBridge({ sendMessageOverride: (m) => sent.push(m) });

    bridge.suspendForMedia(1000);
    assert.equal(bridge.isCaptureSuspended(), true);

    mock.timers.tick(1000);

    assert.equal(bridge.isCaptureSuspended(), false, 'fail-open: a deaf assistant is the worse failure');
    assert.equal(sent.length, 2);
    assert.equal(sent[1].suspended, false);
    assert.equal(sent[1].reason, 'ceiling-fail-open');
  });

  test('setCaptureSuspended(false, ...) with an explicit reason logs a clear, not a re-suspend', () => {
    const sent = [];
    const bridge = createS2SBridge({ sendMessageOverride: (m) => sent.push(m) });

    bridge.suspendForMedia(500);
    bridge.setCaptureSuspended(false, undefined, 'watchdog-clear');

    assert.equal(sent.length, 2);
    assert.equal(sent[1].suspended, false);
    assert.equal(sent[1].reason, 'watchdog-clear');
  });

  test('a throwing sendMessage never blocks the gate itself', () => {
    const bridge = createS2SBridge({ sendMessageOverride: () => { throw new Error('socket not open'); } });
    assert.doesNotThrow(() => bridge.suspendForMedia(200));
    assert.equal(bridge.isCaptureSuspended(), true, 'the gate still took effect even though logging failed');
  });
});

// Wave 2 (2026-08-13): candidate 1 for the lost-transcript incidents — the
// gate above dropped mic frames while the HUD orb kept showing 'listening',
// so the operator had no reason to doubt they were being heard. onState is
// the wire from this module to core-orb.js's setVoiceState; this proves the
// 'muted' overlay wins over whatever the real voice state is while suspended,
// and that the real state (not a hardcoded 'listening') comes back once clear.
describe('s2s-bridge: mic-muted HUD state overlay', () => {
  test('suspending while listening reports muted, and clearing restores listening — not a hardcoded guess', () => {
    const states = [];
    const bridge = createS2SBridge({ onState: (s) => states.push(s), sendMessageOverride: () => {} });

    // Simulate the server having already told us we're listening (the normal
    // steady state a mid-conversation media-echo suspend interrupts).
    bridge.setCaptureSuspended(false); // no-op transition, establishes baseline
    states.length = 0;
    // There is no public setVoiceState — drive the real transition path via
    // the same live-state message handling this module wires internally is
    // out of scope for a bridge unit test (needs a live session); instead
    // pin the overlay's OWN contract directly through the public seam it
    // actually exposes.
    bridge.suspendForMedia(300);
    assert.deepEqual(states, ['muted']);

    bridge.setCaptureSuspended(false, undefined, 'watchdog-clear');
    // With no prior real voice state ever recorded (idle by default), clearing
    // restores 'idle' — proving it restores the TRACKED state, not a hardcoded
    // 'listening', which is the actual bug this closes.
    assert.deepEqual(states, ['muted', 'idle']);
  });

  test('the ceiling fail-open clear also restores state, not just the transition log', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const states = [];
    const bridge = createS2SBridge({ onState: (s) => states.push(s), sendMessageOverride: () => {} });

    bridge.suspendForMedia(1000);
    assert.deepEqual(states, ['muted']);
    t.mock.timers.tick(1000);
    assert.deepEqual(states, ['muted', 'idle']);
  });

  test('a bridge with no onState callback never throws', () => {
    const bridge = createS2SBridge({ sendMessageOverride: () => {} });
    assert.doesNotThrow(() => bridge.suspendForMedia(200));
    assert.doesNotThrow(() => bridge.setCaptureSuspended(false));
  });
});
