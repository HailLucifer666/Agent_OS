'use strict';

// The client-side barge-in backstop for the Gemini Live path — the piece the V2
// spine specified at MYTHOS-IRIS-Synthesis-Plan-V2-spine.md:1002-1005 ("keep
// decideBargeIn() as a client-side backstop for the case where the server's VAD
// misses") and that was never built. decideBargeIn() existed only in the batch
// path and s2s-bridge.js never imported it, so when Google's VAD missed an
// overlap, nothing on the desktop stopped the audio: the operator's "it talks
// over me".
//
// Everything asserted here is pure — no AudioContext, no socket, no mic. The
// remaining browser wiring in s2s-bridge.js (three lines: observe on each
// outgoing frame, reset on the server signal, reset on stop) is verified live,
// not here.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const path = require('path');
const { pathToFileURL } = require('url');

// Authored as a browser ES module; imported via dynamic import() exactly as
// test/voice-barge-in-decision.test.js does for voice-loop.js. Node's
// ES-module-syntax detection makes this work with no bundler and no
// "type":"module" in package.json.
const BACKSTOP_PATH = path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'barge-in-backstop.js');
const BACKSTOP_URL = pathToFileURL(BACKSTOP_PATH).href;

let rmsFromPcm16, createBargeInBackstop, BACKSTOP_RMS_THRESHOLD, BACKSTOP_HOLD_FRAMES;
before(async () => {
  ({ rmsFromPcm16, createBargeInBackstop, BACKSTOP_RMS_THRESHOLD, BACKSTOP_HOLD_FRAMES } = await import(BACKSTOP_URL));
  LOUD = frame(BACKSTOP_RMS_THRESHOLD * 2);
  QUIET = frame(BACKSTOP_RMS_THRESHOLD / 2);
});

// A 100ms 16kHz mono frame at a given amplitude (0..1), the shape
// pcm-capture-worklet.js emits.
function frame(amplitude) {
  const samples = new Int16Array(1600);
  const peak = Math.round(amplitude * 32768);
  for (let i = 0; i < samples.length; i++) samples[i] = i % 2 === 0 ? peak : -peak;
  return samples.buffer;
}

let LOUD, QUIET;   // built in before(), once the module's real thresholds are known

describe('barge-in backstop: RMS off the outgoing PCM frames', () => {
  it('measures a square wave at its own amplitude, in the -1..1 scale voice-loop uses', () => {
    const level = rmsFromPcm16(frame(0.5));
    assert.ok(Math.abs(level - 0.5) < 0.001, 'expected ~0.5, got ' + level);
  });

  it('silence is zero, and an empty/absent frame does not throw', () => {
    assert.equal(rmsFromPcm16(frame(0)), 0);
    assert.equal(rmsFromPcm16(new ArrayBuffer(0)), 0);
    assert.equal(rmsFromPcm16(null), 0);
  });
});

describe('barge-in backstop: it fires only on SUSTAINED loud speech over playback', () => {
  function harness(opts) {
    const flushes = [];
    const backstop = createBargeInBackstop(
      Object.assign({ onFlush: () => flushes.push(Date.now()) }, opts || {})
    );
    return { backstop, flushes };
  }

  it('does nothing at all while the player is silent — there is nothing to barge into', () => {
    const { backstop, flushes } = harness();
    for (let i = 0; i < BACKSTOP_HOLD_FRAMES * 3; i++) {
      assert.equal(backstop.observe(LOUD, false), false);
    }
    assert.equal(flushes.length, 0);
    assert.equal(backstop.pendingFrames(), 0);
  });

  it('one loud frame is not a barge-in (a cough must not cut MYTHOS off)', () => {
    const { backstop, flushes } = harness();
    assert.equal(backstop.observe(LOUD, true), false);
    assert.equal(flushes.length, 0);
  });

  it('flushes after exactly BACKSTOP_HOLD_FRAMES consecutive loud frames, and only once', () => {
    const { backstop, flushes } = harness();
    for (let i = 0; i < BACKSTOP_HOLD_FRAMES - 1; i++) {
      assert.equal(backstop.observe(LOUD, true), false, 'fired early at frame ' + i);
    }
    assert.equal(backstop.observe(LOUD, true), true, 'must fire on the hold-th frame');
    assert.equal(flushes.length, 1);
    // The run is consumed, so the very next frame cannot re-fire.
    assert.equal(backstop.observe(LOUD, true), false);
    assert.equal(flushes.length, 1);
  });

  it('a quiet frame breaks the run — loudness must be SUSTAINED, not cumulative', () => {
    const { backstop, flushes } = harness();
    for (let i = 0; i < BACKSTOP_HOLD_FRAMES - 1; i++) backstop.observe(LOUD, true);
    backstop.observe(QUIET, true);
    assert.equal(backstop.pendingFrames(), 0);
    assert.equal(backstop.observe(LOUD, true), false);
    assert.equal(flushes.length, 0);
  });

  it('playback ending mid-run clears it, so the next reply does not start half-triggered', () => {
    const { backstop, flushes } = harness();
    for (let i = 0; i < BACKSTOP_HOLD_FRAMES - 1; i++) backstop.observe(LOUD, true);
    backstop.observe(LOUD, false);            // reply finished
    assert.equal(backstop.pendingFrames(), 0);
    assert.equal(backstop.observe(LOUD, true), false, 'next reply must start from zero');
    assert.equal(flushes.length, 0);
  });
});

describe('barge-in backstop: idempotent with the server`s live-interrupted', () => {
  it('a server interrupt (reset) clears a half-accumulated local run', () => {
    const flushes = [];
    const backstop = createBargeInBackstop({ onFlush: () => flushes.push(1) });
    for (let i = 0; i < BACKSTOP_HOLD_FRAMES - 1; i++) backstop.observe(LOUD, true);
    backstop.reset();                          // s2s-bridge's live-interrupted handler
    assert.equal(backstop.pendingFrames(), 0);
    assert.equal(backstop.observe(LOUD, true), false,
      'a server interrupt followed by one loud frame must not immediately re-flush');
    assert.equal(flushes.length, 0);
  });

  it('reset after a local flush is harmless (either signal may arrive first)', () => {
    const flushes = [];
    const backstop = createBargeInBackstop({ onFlush: () => flushes.push(1) });
    for (let i = 0; i < BACKSTOP_HOLD_FRAMES; i++) backstop.observe(LOUD, true);
    assert.equal(flushes.length, 1);
    backstop.reset();
    assert.equal(flushes.length, 1, 'reset must never itself flush');
  });
});

// Source-shape assertions, the repo's standing answer to browser wiring that has
// no honest test double (same precedent as test/electron-cursor-overlay.test.js).
// Every test above passes just as happily with barge-in-backstop.js sitting
// unimported as dead code — which is precisely the failure this fix exists to
// end, one layer up. These three lines ARE the fix; the module is only its body.
describe('barge-in backstop: actually wired into s2s-bridge.js', () => {
  const fs = require('node:fs');
  const uiPath = (f) => path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', f);
  const bridge = () => fs.readFileSync(uiPath('s2s-bridge.js'), 'utf8');

  it('imports the backstop', () => {
    assert.match(bridge(), /import\s*\{[^}]*createBargeInBackstop[^}]*\}\s*from\s*'\.\/barge-in-backstop\.js'/,
      's2s-bridge.js must import createBargeInBackstop — the V2 spine gap was that it never did');
  });

  it('observes every outgoing mic frame against the player`s real speaking state', () => {
    assert.match(bridge(), /observe\(e\.data,\s*player\s*\?\s*player\.isSpeaking\(\)\s*:\s*false\)/,
      'the backstop must run on the capture frames, gated on real playback');
  });

  it('resets on the server`s live-interrupted so the two signals stay idempotent', () => {
    assert.match(bridge(), /onInterruptedMsg\s*=\s*\(\)\s*=>\s*\{[^}]*reset\(\)/,
      'a server interrupt must clear the local run');
  });

  it('never sends a cancel frame from the backstop — local flush only', () => {
    // The one thing that must NOT happen: a false positive that kills a turn the
    // server VAD was correctly keeping alive. onFlush is wired to player.flush()
    // and to nothing else.
    assert.match(bridge(), /createBargeInBackstop\(\{\s*onFlush:\s*\(\)\s*=>\s*\{\s*if\s*\(player\)\s*player\.flush\(\);\s*\}\s*\}\)/,
      'the backstop callback must be exactly player.flush() — no sendMessage, no cancel frame');
  });
});

describe('Live setup pins its own VAD instead of inheriting Google`s defaults', () => {
  const fs = require('node:fs');
  const src = () => fs.readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'voice', 'live-session.js'), 'utf8');

  it('automaticActivityDetection is configured, not bare {}', () => {
    assert.ok(!/automaticActivityDetection:\s*\{\s*\}/.test(src()),
      'a bare {} takes whatever Google defaults to today — the operator`s barge-in '
      + 'behaviour must not be able to change with no release on this side');
  });

  it('start-of-speech sensitivity and the silence window are both explicit', () => {
    assert.match(src(), /startOfSpeechSensitivity:\s*'START_SENSITIVITY_/);
    assert.match(src(), /silenceDurationMs:\s*\d+/);
  });
});

describe('barge-in backstop: thresholds are amplitude-scale on purpose', () => {
  it('the RMS floor is well above ordinary speech level, not at it', () => {
    // voice-loop.js's SPEECH_RMS default is 0.035 — the ordinary "speech is
    // present" floor. The backstop must sit clearly above it, or it would cut
    // MYTHOS off on any room noise loud enough to be voice.
    assert.ok(BACKSTOP_RMS_THRESHOLD > 0.035,
      'backstop floor must exceed the ordinary speech floor, got ' + BACKSTOP_RMS_THRESHOLD);
  });

  it('the hold is at least half a second of 100ms frames', () => {
    assert.ok(BACKSTOP_HOLD_FRAMES >= 5,
      'a shorter hold turns transient noise into a barge-in; got ' + BACKSTOP_HOLD_FRAMES);
  });

  it('the module does NOT import voice-loop`s live thresholds (silero rescales them)', () => {
    // Guard on the source, because the bug this prevents is silent: under
    // VAD_ENGINE=silero, SPEECH_RMS becomes 0.5 (a probability), so a threshold
    // borrowed from there would be an unreachable 0.8 amplitude floor and the
    // backstop would be dead for the operator who tuned their VAD the most.
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'barge-in-backstop.js'), 'utf8');
    assert.ok(!/SPEECH_RMS|BARGE_IN_RMS_MULT/.test(src.replace(/^\s*\/\/.*$/gm, '')),
      'barge-in-backstop.js must not read voice-loop.js\'s runtime-rescaled thresholds');
  });
});
