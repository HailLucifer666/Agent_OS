'use strict';

// BUG-346 — a wake word that goes deaf mid-session claimed to be listening
// forever, and the re-arm ladder was structurally unable to help it.
//
// An AudioContext suspended AFTER a successful arm (OS device change,
// sleep/resume) emitted 'degraded' and called resume(). If resume never won,
// nothing else happened: `running` stayed true, so isRunning() kept answering
// yes, the caption kept promising standby, and app.js's scheduleWakewordRearm()
// — which refuses to act on a detector it believes is live — could never fire.
// start()'s else-branch, the only thing that ever scheduled a re-arm, had
// resolved true long before and never runs again.
//
// BOTH HALVES OF THE TICKET'S OWN DESCRIPTION ARE WRONG, and the assertions here
// exist to keep the scope honest. It asks for re-arm on "sustained
// 'degraded'/'silent'":
//   * the other 'degraded' (fallbackFired) means the saved mic was missing and
//     the system default was used. That detector IS listening; re-arming it would
//     tear down a working wake word on a healthy fallback.
//   * 'silent' at start time was ALREADY handled — it calls stop() and returns
//     false, so start() resolves false and the else-branch schedules the re-arm.
//
// SOURCE-SHAPE, and the reason is the same one wakeword-arming.test.js gives:
// app.js reaches for fetch/document/AudioContext at import time and wakeword.js's
// start() needs getUserMedia, an audio worklet and ONNX, so neither can be driven
// under a bare `node --test`. These pin the wiring that was missing. Only
// scripts/verify-wakeword.js and a human suspending a real device can prove the
// detector actually recovers.
//
// Run: cd mythos && node --test test/bug-346-wakeword-suspended-context-rearm.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const UI = path.join(__dirname, '..', 'ui', 'public', 'js');
const WW = fs.readFileSync(path.join(UI, 'voice', 'wakeword.js'), 'utf8');
const APP = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');

// The statechange listener body, so an assertion cannot be satisfied by a
// coincidental match elsewhere in a 500-line module.
function statechangeBody() {
  const at = WW.indexOf("audioCtx.addEventListener('statechange'");
  assert.notStrictEqual(at, -1, 'the statechange listener must still exist');
  return WW.slice(at, at + 700);
}

describe('BUG-346 — a suspended context gets a deadline, not an open promise', () => {
  it('arms a grace timer when the context goes suspended', () => {
    const body = statechangeBody();
    assert.match(body, /armSuspendGrace\(\)/,
      'a suspension must start a deadline; resume() alone is a hope, not a recovery');
  });

  it('cancels the deadline when the context comes back', () => {
    const body = statechangeBody();
    // Window deliberately generous: a tight one breaks the day somebody adds a
    // comment between the branch and the call, which is a documented way tests
    // in this repo have failed against correct code.
    assert.match(body, /state === 'running'[\s\S]{0,400}clearSuspendGrace\(\)/,
      'a context that recovers must not then be declared dead by its own timer');
  });

  it('the deadline reports silent AND stops the detector', () => {
    const at = WW.indexOf('function armSuspendGrace(');
    assert.notStrictEqual(at, -1, 'armSuspendGrace() must exist');
    // Bounded by the function's OWN closing line, not a character count. Found by
    // mutation: a fixed 900-char window ran past the function and matched a
    // `stop()` belonging to something else, so deleting the real one survived.
    const end = WW.indexOf('CONTEXT_RESUME_GRACE_MS);', at);
    assert.ok(end > at, 'armSuspendGrace() must still end at its own timer');
    const body = WW.slice(at, end);
    assert.match(body, /status\('silent'/,
      "it must report the same fact a start-time failure reports: armed, hearing nothing");
    // A STATEMENT, not a mention. Found by mutation: /\bstop\(\)/ matched the word
    // inside this function's own explanatory comment, so deleting the actual call
    // changed nothing the assertion could see.
    assert.match(body, /^\s*stop\(\);\s*$/m,
      'stop() is what makes isRunning() false — without it the re-arm ladder still refuses');
    assert.match(body, /audioCtx\.state !== 'suspended'/,
      'a context that recovered before the deadline must be left alone');
  });

  it('stop() clears the deadline', () => {
    const at = WW.indexOf('function stop(');
    assert.notStrictEqual(at, -1);
    const body = WW.slice(at, at + 600);
    assert.match(body, /clearSuspendGrace\(\)/,
      'a deliberately stopped detector must not later fire silent and re-arm itself');
  });

  it('the grace is a bounded constant, not an open wait', () => {
    assert.match(WW, /const CONTEXT_RESUME_GRACE_MS = (\d+);/);
    const ms = Number(WW.match(/const CONTEXT_RESUME_GRACE_MS = (\d+);/)[1]);
    assert.ok(ms >= 1000 && ms <= 30000,
      `grace of ${ms}ms is outside anything defensible: under a second races a normal `
      + 'device change, over thirty is indistinguishable from the bug');
  });
});

describe('BUG-346 — the HUD half, and what it must NOT do', () => {
  function onStatusBody() {
    const at = APP.indexOf('onStatus: (s, msg, data) =>');
    assert.notStrictEqual(at, -1, 'the wake-word onStatus handler must still exist');
    return APP.slice(at, at + 900);
  }

  it("schedules a re-arm on 'silent'", () => {
    assert.match(onStatusBody(), /s === 'silent'[\s\S]{0,200}scheduleWakewordRearm\(/,
      'a death after a successful arm is invisible to start()\'s else-branch, so the '
      + 'status handler is the only place left that can schedule a re-arm');
  });

  it("does NOT schedule a re-arm on 'degraded'", () => {
    const body = onStatusBody();
    const deg = body.indexOf("s === 'degraded'");
    assert.notStrictEqual(deg, -1, "the 'degraded' branch must still exist");
    const after = body.slice(deg, deg + 200);
    assert.doesNotMatch(after, /scheduleWakewordRearm\(/,
      "'degraded' also covers the healthy mic fallback (saved device missing, system "
      + 'default used). That detector is listening — re-arming it tears down a working '
      + 'wake word, which is the opposite failure and strictly worse');
  });

  it('the ladder still refuses to act on a live detector', () => {
    const at = APP.indexOf('function scheduleWakewordRearm(');
    assert.notStrictEqual(at, -1);
    // Only the part BEFORE a rung is consumed counts. Found by mutation: the
    // setTimeout body carries its own wakewordIsLive() guard, so asserting over
    // the whole function passed while the entry guard was deleted — and the entry
    // guard is the one that stops a live detector being torn down.
    const delayAt = APP.indexOf('const delay = WAKEWORD_REARM_DELAYS_MS', at);
    assert.ok(delayAt > at, 'scheduleWakewordRearm must still pick a delay');
    const body = APP.slice(at, delayAt);
    assert.match(body, /if \(wakewordIsLive\(\)\) return;/,
      'this guard is what stops the new trigger double-booking a rung of a bounded '
      + 'ladder when start-time silent already routed through the else-branch');
  });
});
