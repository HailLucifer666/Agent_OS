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
let BACKSTOP_RELEASE_RMS_THRESHOLD, BACKSTOP_RELEASE_HOLD_FRAMES;
before(async () => {
  ({
    rmsFromPcm16, createBargeInBackstop, BACKSTOP_RMS_THRESHOLD, BACKSTOP_HOLD_FRAMES,
    BACKSTOP_RELEASE_RMS_THRESHOLD, BACKSTOP_RELEASE_HOLD_FRAMES,
  } = await import(BACKSTOP_URL));
  LOUD = frame(BACKSTOP_RMS_THRESHOLD * 2);
  QUIET = frame(BACKSTOP_RELEASE_RMS_THRESHOLD / 2);
  // Between the two tiers: reopens the mic, must never stop MYTHOS speaking.
  MID = frame((BACKSTOP_RELEASE_RMS_THRESHOLD + BACKSTOP_RMS_THRESHOLD) / 2);
});

// A 100ms 16kHz mono frame at a given amplitude (0..1), the shape
// pcm-capture-worklet.js emits.
function frame(amplitude) {
  const samples = new Int16Array(1600);
  const peak = Math.round(amplitude * 32768);
  for (let i = 0; i < samples.length; i++) samples[i] = i % 2 === 0 ? peak : -peak;
  return samples.buffer;
}

let LOUD, QUIET, MID;   // built in before(), once the module's real thresholds are known

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

// The 2026-08-14 split. One threshold used to decide both "stop MYTHOS" and "let
// the operator's audio reach Gemini", and the second of those is the one whose
// failure is silent: s2s-bridge's half-duplex gate only opens on a verdict from
// here, so a miss discards the sentence rather than delaying it.
describe('barge-in backstop: two independent tiers', () => {
  function harness(opts) {
    const flushes = [];
    const releases = [];
    const backstop = createBargeInBackstop(Object.assign({
      onFlush: (lvl) => flushes.push(lvl),
      onRelease: (lvl) => releases.push(lvl),
    }, opts || {}));
    return { backstop, flushes, releases };
  }

  it('mid-level speech reopens the mic without cutting MYTHOS off', () => {
    const { backstop, flushes, releases } = harness();
    for (let i = 0; i < BACKSTOP_HOLD_FRAMES * 4; i++) backstop.observe(MID, true);
    assert.equal(releases.length, 1, 'the gate must open on ordinary speaking level');
    assert.equal(flushes.length, 0,
      'and it must NOT stop playback — Gemini`s own VAD decides whether this is a real '
      + 'interruption, which is the whole point of releasing early');
  });

  it('the release lands no later than the flush on a loud interruption', () => {
    const { backstop, flushes, releases } = harness();
    let releasedAt = -1;
    let flushedAt = -1;
    for (let i = 0; i < BACKSTOP_HOLD_FRAMES; i++) {
      backstop.observe(LOUD, true);
      if (releasedAt === -1 && releases.length) releasedAt = i;
      if (flushedAt === -1 && flushes.length) flushedAt = i;
    }
    assert.ok(releasedAt !== -1 && flushedAt !== -1, 'both tiers must fire on sustained loud speech');
    // <=, not <: since BUG-271 raised the eager tier to 3 frames (the flush
    // tier's hold), both can tip on the SAME frame. That is still correct —
    // observe() evaluates the release tier first within a frame, so the mic
    // reopens no later than the frame playback stops, never after it.
    assert.ok(releasedAt <= flushedAt,
      'the mic must reopen no later than the frame playback stops, never after it — '
      + `released at frame ${releasedAt}, flushed at ${flushedAt}`);
  });

  it('the release fires once per run, not once every release-hold frames', () => {
    const { backstop, releases } = harness();
    for (let i = 0; i < BACKSTOP_RELEASE_HOLD_FRAMES * 5; i++) backstop.observe(MID, true);
    assert.equal(releases.length, 1,
      'releaseOwnVoiceGate is idempotent, but a log line per 200ms of speech would bury '
      + 'the one measurement this instrumentation exists to produce');
  });

  it('a quiet frame ends the run, so the NEXT sentence releases again', () => {
    const { backstop, releases } = harness();
    for (let i = 0; i < BACKSTOP_RELEASE_HOLD_FRAMES * 2; i++) backstop.observe(MID, true);
    assert.equal(releases.length, 1);
    backstop.observe(QUIET, true);                    // the operator drew breath
    for (let i = 0; i < BACKSTOP_RELEASE_HOLD_FRAMES * 2; i++) backstop.observe(MID, true);
    assert.equal(releases.length, 2, 'a second utterance must be able to reopen the gate too');
  });

  it('quiet room: neither tier fires, so a silent operator is never mistaken for one', () => {
    const { backstop, flushes, releases } = harness();
    for (let i = 0; i < 50; i++) backstop.observe(QUIET, true);
    assert.equal(releases.length, 0);
    assert.equal(flushes.length, 0);
  });

  it('both tiers are independently tunable, in both dimensions', () => {
    // s2s-bridge reads four localStorage keys and spreads them into these exact
    // option names; an operator walking eager barge-in back must be able to move
    // the release tier without touching the flush tier, and vice versa.
    const { backstop, flushes, releases } = harness({
      releaseThreshold: 0.9, releaseHoldFrames: 1,   // unreachable release
      threshold: BACKSTOP_RELEASE_RMS_THRESHOLD / 2, holdFrames: 1,   // trivially reachable flush
    });
    assert.equal(backstop.observe(MID, true), true, 'the flush override must be honoured');
    assert.equal(flushes.length, 1);
    assert.equal(releases.length, 0, 'the release override must be honoured independently');
  });

  it('reports the level it measured, so the peak can be logged per held gate', () => {
    const { backstop } = harness();
    backstop.observe(frame(0.25), true);
    assert.ok(Math.abs(backstop.lastLevel() - 0.25) < 0.001,
      'the 2026-08-14 analysis could only INFER the threshold was too high because no '
      + 'RMS figure was recorded anywhere; got ' + backstop.lastLevel());
    // Measured even in the states that take no decision — a peak of 0 must mean
    // silence, never "we never looked".
    backstop.observe(frame(0.4), false);
    assert.ok(Math.abs(backstop.lastLevel() - 0.4) < 0.001);
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

  it('never sends a cancel frame from the backstop — local flush, plus the gate release', () => {
    // The one thing that must NOT happen: a false positive that kills a turn the
    // server VAD was correctly keeping alive.
    //
    // Widened 2026-08-14 (BUG-224). onFlush now also opens the half-duplex
    // own-voice gate. That is deliberately NOT the thing this test forbids:
    // releasing the gate replays the operator's OWN held mic frames as ordinary
    // `live-audio`, which is the same audio that would have been streaming
    // anyway had the gate not been holding it. It sends no control frame and
    // cancels nothing. The local backstop is the only detector that runs while
    // the gate is held, so if it could not open the gate, barge-in would be
    // impossible for exactly as long as MYTHOS is speaking.
    //
    // Widened again 2026-08-14 (the two-tier split): asserting the constructor
    // call's exact source text made this test a formatting pin rather than a
    // safety pin, and it broke on a change that added no send at all. What must
    // hold is the PROPERTY — nothing inside the backstop's callbacks talks to the
    // server — so that is what is asserted now.
    const src = bridge();
    const ctorAt = src.indexOf('createBargeInBackstop({');
    assert.ok(ctorAt !== -1, 'the backstop must be constructed with options');
    const ctorBody = src.slice(ctorAt, src.indexOf('\n  });', ctorAt));
    assert.match(ctorBody, /onFlush:[\s\S]*stopAssistantSpeech\('barge-in'\)/,
      'the flush tier must stop OUR OWN playback and open the half-duplex gate — the '
      + 'local backstop is the only detector running while the gate is held, so without '
      + 'this, interrupting MYTHOS is impossible');
    // BUG-272 renamed 'barge-in-eager' -> 'barge-in-confirmed'. The reason string is
    // load-bearing in the log, and 'eager' had become a lie: the tier no longer
    // releases on level alone. It releases only when barge-in-policy.js has CONFIRMED
    // a sustained interruption above this room's learned bleed floor — 46 of these
    // fired on speaker bleed in the 2026-08-17 session precisely because eager meant
    // eager.
    //
    // BUG-274 step 5, 2026-08-19 — THIS ASSERTION USED TO READ "the eager tier must
    // open the gate WITHOUT stopping playback", AND THAT WAS THE BUG. The 2026-08-14
    // split gave the eager tier the job of reopening the mic fast and left stopping the
    // speech to the flush tier "for extra evidence". Since BUG-272 the policy supplies
    // that evidence — the protected window, the floor and the full sustain test all run
    // BEFORE either callback is allowed to act — so a second level threshold is no
    // longer a second opinion, just a higher bar. Meanwhile the two tiers fire on the
    // same frame above BACKSTOP_RMS_THRESHOLD, so the split only ever mattered inside
    // the band between them, where it silently produced the operator's exact complaint:
    // the 2026-08-19 log has a hold released as 'barge-in-confirmed' at peak 0.0935 with
    // zero vetoes, counted as a landed barge-in, while MYTHOS talked on.
    //
    // Both tiers now go through stopAssistantSpeech(). The property that must NOT change
    // is the one below: neither callback may send anything to the server.
    assert.match(ctorBody, /onRelease:[\s\S]*stopAssistantSpeech\('barge-in-confirmed'\)/,
      'the eager tier must ALSO stop playback (2026-08-19) — reopening the mic while '
      + 'MYTHOS keeps talking is the failure the operator reports, logged as a success');
    assert.ok(!/\bsend(Message)?\(/.test(ctorBody),
      'no frame of any kind may be sent from the backstop callbacks: a false positive must '
      + 'never kill a turn the server VAD was correctly keeping alive. Got: ' + ctorBody);

    const release = bridge().slice(bridge().indexOf('function releaseOwnVoiceGate'));
    const body = release.slice(0, release.indexOf('\n  }') + 1);
    const sends = [...body.matchAll(/type:\s*'([a-z-]+)'/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(sends)].sort(), ['live-audio'],
      'the gate release may only replay captured mic audio; any other frame type here would '
      + 'be the backstop talking to the server, which is what this test exists to forbid');
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

  // WAS "the hold is at least half a second of 100ms frames" (>= 5 frames), and
  // that assertion was measured wrong on 2026-08-14: with 0.0875 / 6 frames the
  // backstop fired ZERO times across a whole session in which the operator
  // repeatedly talked over MYTHOS, and because this module's verdict is the only
  // thing that reopens s2s-bridge's half-duplex gate, their sentences were
  // discarded from the 1.2s preroll ring instead of merely arriving late. The
  // operator's explicit instruction was "stop as soon as I speak" — accepting the
  // occasional cough-triggered cut as the cheaper of the two failures. So the
  // requirement is now RELATIVE (flush is the more conservative tier of the two)
  // rather than an absolute floor that outlawed being eager at all.
  it('the flush tier is the more conservative of the two, in both dimensions', () => {
    assert.ok(BACKSTOP_RMS_THRESHOLD > BACKSTOP_RELEASE_RMS_THRESHOLD,
      'stopping MYTHOS mid-word must take more than merely reopening the mic');
    assert.ok(BACKSTOP_HOLD_FRAMES >= BACKSTOP_RELEASE_HOLD_FRAMES,
      'ditto for the hold: got flush=' + BACKSTOP_HOLD_FRAMES + ' release=' + BACKSTOP_RELEASE_HOLD_FRAMES);
  });

  it('the release tier is eager but not instant — one frame is still not speech', () => {
    assert.ok(BACKSTOP_RELEASE_HOLD_FRAMES >= 2,
      'a single 100ms frame is a click or a keystroke, not the operator starting a '
      + 'sentence; got ' + BACKSTOP_RELEASE_HOLD_FRAMES);
    assert.ok(BACKSTOP_RELEASE_HOLD_FRAMES <= 4,
      'the release tier exists to be fast — beyond ~400ms the preroll ring is already '
      + 'losing the start of the sentence; got ' + BACKSTOP_RELEASE_HOLD_FRAMES);
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

// BUG-271 (2026-08-17): the eager tier was 0.035 / 2 frames (200ms), and the
// operator's own session log proved speaker bleed clears 0.035 in that room —
// every ~7s own-voice-hold -> barge-in-eager cycle was MYTHOS releasing its own
// half-duplex gate on the echo of its voice, then replaying the buffered bleed
// to Gemini. The tier moved to 0.05 / 3 frames (300ms): still eager, still
// below the flush tier (0.056), and the localStorage override
// (MYTHOS_BARGE_RELEASE_RMS) remains the walk-back for a real barge-in that a
// different room's noise floor outruns.
describe('barge-in backstop: BUG-271 eager tier is 0.05 / 300ms', () => {
  it('the release threshold is 0.05 — above measured speaker bleed, below the flush tier', () => {
    assert.equal(BACKSTOP_RELEASE_RMS_THRESHOLD, 0.05,
      '0.035 was cleared by speaker bleed in the operator\'s room (BUG-271); the tier must '
      + 'sit above it. Got ' + BACKSTOP_RELEASE_RMS_THRESHOLD);
    assert.ok(BACKSTOP_RELEASE_RMS_THRESHOLD < BACKSTOP_RMS_THRESHOLD,
      'the eager tier must stay strictly below the flush tier (0.056), or a release IS a flush');
  });

  it('the release hold is 3 frames (300ms of 100ms frames)', () => {
    assert.equal(BACKSTOP_RELEASE_HOLD_FRAMES, 3,
      '200ms tripped on bleed bursts; got ' + BACKSTOP_RELEASE_HOLD_FRAMES);
  });

  it('the flush tier is UNCHANGED by BUG-271', () => {
    assert.equal(BACKSTOP_RMS_THRESHOLD, 0.035 * 1.6,
      'only the eager tier moved — the flush tier is the one that cuts MYTHOS off mid-word');
    assert.equal(BACKSTOP_HOLD_FRAMES, 3);
  });
});
