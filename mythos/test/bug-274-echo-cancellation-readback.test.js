'use strict';
// bug-274-echo-cancellation-readback.test.js — W1 Step 1, Q5.
//
// The whole own-voice plan rests on `echoCancellation: true` being HONOURED by
// Chromium. Nothing verified that. `micConstraintShape()` reports
// `echoCancellation: true` unconditionally because it describes the REQUEST, and
// a request is not a grant — a browser may silently drop a constraint. So the
// one datum that could refute the plan's premise was being reported as a
// constant, on every path, in a field that looks exactly like a measurement.
//
// The readback itself was not missing. `trackSettingsOf()` existed, privately,
// inside wakeword.js — reading the real `getSettings()` for the WAKE WORD's
// stream. The Live conversation opens a SEPARATE stream (s2s-bridge.js's
// `openMicWithFallback()` call) and recorded nothing about it. So the answer was
// available for the one path where echo does not matter and unavailable for the
// path where the operator hears itself.
//
// Q3 — WHO ACTUALLY READS THIS? A field that stops at the client is not a
// measurement. `voice-capture-suspend` is assembled in TWO places (client
// payload + a hand-maintained server allowlist) and forgetting the second is
// silent; that seam has already cost three bugs and two live sessions. The
// class-level guard for it is bug-273-suspend-fields-reach-the-log.test.js, and
// it covers the new field automatically once the field is on the payload — which
// is exactly why this test asserts the field reaches the payload rather than
// re-implementing that check.
//
// Q6 — WHAT CLASS IS THIS? "A constant that looks like a measurement." Same
// class as the verifier that printed PASS on a number it could not read. The
// standing rule from the BUG-274 plan applies: a mechanism that cannot be
// observed failing is not a mechanism. Hence assertion 2 — the readback must
// report `false` when the browser refuses, not fall back to the requested value.
//
// Deliberately NOT here: any judgement about what the value SHOULD be. This test
// pins that the truth is measured and delivered, not that AEC is on. If a live
// session reports `false`, that is a finding, not a test failure.
//
// Run: cd mythos && node --test test/bug-274-echo-cancellation-readback.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const UI = (...p) => path.join(__dirname, '..', 'ui', 'public', 'js', ...p);
// CRLF-safe: sources on this machine are mixed, and a bare \n scan silently
// matches nothing (same class as the vault CRLF parser bug).
const readSrc = (...p) => fs.readFileSync(UI(...p), 'utf8').replace(/\r\n/g, '\n');
const MIC_DEVICE_URL = pathToFileURL(UI('voice', 'mic-device.js')).href;

// A MediaStream stand-in whose single audio track reports whatever the browser
// is pretending to have granted.
function fakeStream(settings) {
  return { getAudioTracks: () => [{ getSettings: () => settings }] };
}

describe('BUG-274 W1 Q5: the granted echoCancellation is measured, not assumed', () => {
  it('mic-device.js owns the readback, so both capture paths share one door', async () => {
    const mod = await import(MIC_DEVICE_URL);
    assert.equal(typeof mod.trackSettingsOf, 'function',
      'trackSettingsOf must be exported from mic-device.js — the Live stream needs it too');
  });

  it('reports what the browser actually granted, including a refusal', async () => {
    const { trackSettingsOf } = await import(MIC_DEVICE_URL);
    const granted = trackSettingsOf(fakeStream({
      echoCancellation: false, noiseSuppression: true, autoGainControl: false,
      sampleRate: 48000, channelCount: 1,
    }));
    // The point of the whole exercise: a refused constraint must surface as
    // false. If this ever reports the requested `true`, the measurement is a
    // constant again and the plan's premise is unfalsifiable.
    assert.equal(granted.echoCancellation, false);
    assert.equal(granted.autoGainControl, false);
    assert.equal(granted.sampleRate, 48000);
  });

  it('never carries the device id or groupId into a log line', async () => {
    const { trackSettingsOf } = await import(MIC_DEVICE_URL);
    const granted = trackSettingsOf(fakeStream({
      echoCancellation: true, deviceId: 'abc-secret-hardware-id', groupId: 'grp-1',
    }));
    // Q4 (what is standing next to it?) — MediaTrackSettings puts the operator's
    // hardware id one field away from the flag we want. Explicit picks only;
    // never spread this object.
    assert.equal(granted.deviceId, undefined);
    assert.equal(granted.groupId, undefined);
  });

  it('missing/absent tracks degrade to null instead of throwing', async () => {
    const { trackSettingsOf } = await import(MIC_DEVICE_URL);
    assert.equal(trackSettingsOf(null), null);
    assert.equal(trackSettingsOf({ getAudioTracks: () => [] }), null);
    assert.equal(trackSettingsOf({ getAudioTracks: () => [{}] }), null);
  });

  it('openMicWithFallback returns the grant alongside the request', async () => {
    const { openMicWithFallback } = await import(MIC_DEVICE_URL);
    const opened = await openMicWithFallback({
      getUserMedia: async () => fakeStream({ echoCancellation: false, sampleRate: 16000 }),
    });
    assert.equal(opened.requested.echoCancellation, true, 'the request is unchanged');
    assert.ok(opened.actual, 'the grant must ride back with the stream');
    assert.equal(opened.actual.echoCancellation, false,
      'requested-vs-actual is the pair that makes this diagnosable — neither alone');
  });

  it('wakeword.js uses the shared readback rather than a private copy', () => {
    const src = readSrc('voice', 'wakeword.js');
    assert.ok(/import\s*\{[^}]*trackSettingsOf[^}]*\}\s*from\s*'\.\/mic-device\.js'/.test(src),
      'wakeword.js must import trackSettingsOf, not redefine it');
    assert.ok(!/function\s+trackSettingsOf\s*\(/.test(src),
      'a second copy is how the Live path ended up with no readback at all');
  });

  it('the Live path puts the grant on the wire, where a verifier can read it', () => {
    const src = readSrc('voice', 's2s-bridge.js');
    assert.ok(/trackSettingsOf|openedMic\.actual/.test(src),
      's2s-bridge.js must capture the granted settings for the Live stream');
    // The transition payload is the only channel that reaches the server log.
    // Presence of the field name is asserted, not a line window — widening a
    // window is safe, narrowing an invariant is not.
    assert.ok(/micEchoCancellation/.test(src),
      'the granted flag must be named on the voice-capture-suspend payload');
  });
});
