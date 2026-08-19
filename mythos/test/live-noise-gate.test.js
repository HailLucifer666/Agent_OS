'use strict';

// live-noise-gate.test.js — BUG-271 Commit 2. The Live send path streamed EVERY
// 100ms mic frame to Gemini with no noise gate (the batch path gates at 0.035
// RMS before sending anything), so Gemini's START_SENSITIVITY_HIGH VAD fired on
// room noise and its STT fabricated words the operator never said ("with the",
// "Victor", a Hindi phrase, "인도네시아"). The fix is a client-side gate that
// ZEROES below-floor frames to silence instead of dropping them: the stream
// stays continuous, so Gemini's VAD timeline and the wire format (frame count,
// size, rate) are untouched. Hysteresis keeps raw frames passing between words
// once the operator's voice has cleared the floor, re-zeroing only after 800ms
// (8 frames) of continuous quiet.
//
// The pure module is tested through dynamic import exactly like
// test/s2s-barge-in-backstop.test.js does for its browser ES module sibling;
// the s2s-bridge wiring is source-shape assertions, the repo's standing answer
// to browser glue with no honest Node double (same precedent as
// test/s2s-preroll-ring.test.js and test/live-half-duplex-gate.test.js).

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const VOICE_DIR = path.join(__dirname, '..', 'ui', 'public', 'js', 'voice');
const GATE_URL = pathToFileURL(path.join(VOICE_DIR, 'live-noise-gate.js')).href;

let createLiveNoiseGate, LIVE_NOISE_GATE_FLOOR_RMS, LIVE_NOISE_GATE_QUIET_FRAMES;
before(async () => {
  ({ createLiveNoiseGate, LIVE_NOISE_GATE_FLOOR_RMS, LIVE_NOISE_GATE_QUIET_FRAMES } =
    await import(GATE_URL));
});

// A 100ms 16kHz mono frame at a given amplitude (0..1), the shape
// pcm-capture-worklet.js emits — same helper as s2s-barge-in-backstop.test.js.
function frame(amplitude) {
  const samples = new Int16Array(1600);
  const peak = Math.round(amplitude * 32768);
  for (let i = 0; i < samples.length; i++) samples[i] = i % 2 === 0 ? peak : -peak;
  return samples.buffer;
}

describe('BUG-271 live noise gate: zero, never drop', () => {
  it('a below-floor frame is zeroed, not dropped — same byteLength, all samples zero', () => {
    const gate = createLiveNoiseGate({ rms: () => 0.01 });
    const buf = frame(0.01);
    const d = gate.process(buf);
    assert.equal(d.zero, true);
    assert.equal(d.buffer.byteLength, buf.byteLength,
      'the wire frame must keep its exact size — dropping frames would move Gemini\'s '
      + 'VAD timeline, which is the whole point of zeroing instead');
    const samples = new Int16Array(d.buffer);
    assert.ok(samples.every((s) => s === 0), 'the replacement must be digital silence');
  });

  it('a frame at or above the floor passes through as the ORIGINAL buffer', () => {
    const buf = frame(0.3);
    const gate = createLiveNoiseGate({ rms: () => 0.3 });
    const d = gate.process(buf);
    assert.equal(d.zero, false);
    assert.equal(d.buffer, buf,
      'voice frames must reach the wire untouched — the gate may not re-encode speech');
  });

  it('zeroing never mutates the captured buffer — the preroll ring holds references to it', () => {
    const gate = createLiveNoiseGate({ rms: () => 0.01 });
    const buf = frame(0.01);
    const before = new Int16Array(buf).slice();
    gate.process(buf);
    assert.deepEqual(new Int16Array(buf), before,
      's2s-bridge buffers the ORIGINAL frame for the gate-release replay; zeroing it in '
      + 'place would silence the operator\'s held speech too');
  });

  it('the rms function is injectable and decides the outcome', () => {
    const seen = [];
    const gate = createLiveNoiseGate({ rms: (b) => { seen.push(b); return 0.5; } });
    const buf = frame(0.5);
    assert.equal(gate.process(buf).zero, false);
    assert.equal(seen.length, 1);
    assert.equal(seen[0], buf, 'the gate must measure the exact frame it was handed');
  });
});

describe('BUG-271 live noise gate: hysteresis', () => {
  it('once voice clears the floor, dips between words stay raw until 8 consecutive quiet frames', () => {
    const gate = createLiveNoiseGate({ floorRms: 0.02, quietFrames: 8, rms: (b) => amp(b) });
    const loud = frame(0.3);
    const quiet = frame(0.005);

    assert.equal(gate.process(loud).zero, false, 'voice clears the floor');
    for (let i = 0; i < 7; i++) {
      assert.equal(gate.process(quiet).zero, false,
        'quiet frame ' + (i + 1) + ' of 7 must still pass raw — a dip between words is not silence');
    }
    assert.equal(gate.process(quiet).zero, true,
      'the 8th consecutive quiet frame (800ms) re-zeros');
  });

  it('a below-floor frame mid-tail resets the quiet count — the run must be continuous', () => {
    const gate = createLiveNoiseGate({ floorRms: 0.02, quietFrames: 8, rms: (b) => amp(b) });
    gate.process(frame(0.3));
    for (let i = 0; i < 7; i++) gate.process(frame(0.005));   // tail at 7 of 8
    assert.equal(gate.process(frame(0.3)).zero, false, 'voice again');
    for (let i = 0; i < 7; i++) {
      assert.equal(gate.process(frame(0.005)).zero, false,
        'the tail restarted with the new run; quiet frame ' + (i + 1) + ' of 7 passes');
    }
    assert.equal(gate.process(frame(0.005)).zero, true);
  });

  it('before any voice, every below-floor frame is zeroed from the first frame', () => {
    const gate = createLiveNoiseGate({ floorRms: 0.02, quietFrames: 8, rms: (b) => amp(b) });
    for (let i = 0; i < 20; i++) {
      assert.equal(gate.process(frame(0.005)).zero, true,
        'room noise must never reach Gemini raw, even before the operator has spoken');
    }
  });

  it('reset() re-arms the gate AND clears framesZeroed — the count is per session', () => {
    const gate = createLiveNoiseGate({ floorRms: 0.02, quietFrames: 8, rms: (b) => amp(b) });
    gate.process(frame(0.005));                    // zeroed
    gate.process(frame(0.005));                    // zeroed
    assert.equal(gate.framesZeroed(), 2);
    gate.process(frame(0.3));                      // voice opens the gate
    gate.reset();                                  // s2s-bridge's stop()
    assert.equal(gate.framesZeroed(), 0,
      'the count feeds one session\'s transition logs and must not carry into the next — '
      + 'the bridge is constructed once and survives start/stop cycles');
    assert.equal(gate.process(frame(0.005)).zero, true,
      'after reset the hysteresis tail must not carry over either');
    assert.equal(gate.framesZeroed(), 1, 'counting restarts from zero');
  });

  it('framesZeroed counts exactly the frames that were zeroed', () => {
    const gate = createLiveNoiseGate({ floorRms: 0.02, quietFrames: 8, rms: (b) => amp(b) });
    gate.process(frame(0.005));                    // zeroed
    gate.process(frame(0.3));                      // passes, opens the gate
    gate.process(frame(0.005));                    // tail: passes raw
    gate.process(frame(0.005));                    // tail: passes raw
    assert.equal(gate.framesZeroed(), 1,
      'tail frames pass raw and must not count — the number measures what Gemini never heard');
  });
});

describe('BUG-271 live noise gate: defaults', () => {
  it('the floor is 0.02 RMS — below the batch path\'s 0.035 speech floor', () => {
    assert.equal(LIVE_NOISE_GATE_FLOOR_RMS, 0.02,
      'room noise sits below ordinary speech; a floor at or above the speech floor would '
      + 'zero the operator');
  });

  it('the quiet tail is 8 frames — 800ms of 100ms frames', () => {
    assert.equal(LIVE_NOISE_GATE_QUIET_FRAMES, 8);
  });

  it('a zero-or-negative floor disables the gate entirely (the localStorage escape hatch)', () => {
    const gate = createLiveNoiseGate({ floorRms: 0, rms: () => 0.001 });
    const buf = frame(0.001);
    const d = gate.process(buf);
    assert.equal(d.zero, false);
    assert.equal(d.buffer, buf, 'MYTHOS_LIVE_NOISE_GATE_FLOOR=0 must restore the pre-BUG-271 raw stream');
    assert.equal(gate.framesZeroed(), 0);
  });
});

// amp() — reads a frame's real amplitude back out, so the hysteresis tests run
// against the actual PCM content rather than a stubbed rms. Reuses the module's
// own Int16 layout (square wave at `amplitude`, same helper as above).
function amp(buf) {
  const samples = new Int16Array(buf);
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

// Source-shape assertions for the s2s-bridge wiring. The gate module above
// passes just as happily with the bridge never importing it — and the defect
// lives in the bridge's two send points, not in the module.
describe('BUG-271 live noise gate: wired into BOTH s2s-bridge send points', () => {
  const bridge = () => fs.readFileSync(path.join(VOICE_DIR, 's2s-bridge.js'), 'utf8');

  it('imports and constructs the gate with the rms helper reused from barge-in-backstop', () => {
    assert.match(bridge(), /import\s*\{[^}]*createLiveNoiseGate[^}]*\}\s*from\s*'\.\/live-noise-gate\.js'/,
      'the bridge must import the gate module');
    assert.match(bridge(), /import\s*\{[^}]*rmsFromPcm16[^}]*\}\s*from\s*'\.\/barge-in-backstop\.js'/,
      'rmsFromPcm16 already exists in barge-in-backstop.js — a second RMS function would drift');
    assert.match(bridge(), /createLiveNoiseGate\(\{/,
      'the gate must be constructed, not merely imported');
    assert.match(bridge(), /rms:\s*rmsFromPcm16/,
      'the gate must measure frames with the SAME rms the barge-in backstop uses');
  });

  it('the live send goes through the gate', () => {
    const handler = bridge().indexOf('captureNode.port.onmessage');
    assert.ok(handler !== -1);
    // BUG-274: bounded by a CODE SENTINEL rather than a character count. This window
    // has now been widened twice (2200 -> 3800 -> broken again) purely because prose
    // grew inside the handler, while the assertions below never changed.
    // `source.connect(captureNode)` is the first statement after the handler closes.
    const end = bridge().indexOf('source.connect(captureNode)', handler);
    assert.ok(end !== -1, 'the statement that follows the frame handler must exist');
    const body = bridge().slice(handler, end);
    assert.match(body, /noiseGate\.process\(e\.data\)/,
      'every captured frame must be gated on its way to Gemini');
    assert.match(body, /sendMessage\(\{\s*type:\s*'live-audio',\s*data:\s*arrayBufferToBase64\((?!e\.data\))/,
      'the send must use the gate\'s decision buffer, not the raw captured frame');
  });

  it('the gate-release replay goes through the gate too — replayed speaker bleed must arrive as silence', () => {
    const release = bridge().slice(bridge().indexOf('function releaseOwnVoiceGate'));
    const body = release.slice(0, release.indexOf('\n  }') + 1);
    assert.match(body, /noiseGate\.process\(frame\)/,
      'the replay replays every buffered preroll frame — including MYTHOS\'s own voice that '
      + 'leaked through the mic; without the gate here the echo is replayed verbatim');
    assert.match(body, /arrayBufferToBase64\((?!frame\))/,
      'the replayed frame must be the gate\'s decision buffer, not the stored original');
  });

  it('the noise-gate floor is tunable from localStorage, same idiom as MYTHOS_BARGE_*', () => {
    assert.match(bridge(), /MYTHOS_LIVE_NOISE_GATE_FLOOR/,
      'an acoustic constant that cannot be walked back in the field is not one the operator '
      + 'really chose — same reasoning as the MYTHOS_BARGE_* overrides');
    assert.match(bridge(), /lsNumber\('MYTHOS_LIVE_NOISE_GATE_FLOOR'\)/,
      'the key must be read through the existing lsNumber() helper');
  });

  it('the release log carries framesZeroed, so the evidence chain lands in one line per hold', () => {
    const release = bridge().slice(bridge().indexOf('function releaseOwnVoiceGate'));
    const body = release.slice(0, release.indexOf('\n  }') + 1);
    assert.match(body, /framesZeroed/,
      'Task 3 logs this server-side; the count belongs in the same transition line as '
      + 'framesDropped and peakRms');
  });

  it('the gate is reset on stop, like the backstop', () => {
    const stop = bridge().slice(bridge().indexOf('async function stop'));
    assert.match(stop, /noiseGate\.reset\(\)/,
      'a stale hysteresis tail must not carry into the next session');
  });
});
