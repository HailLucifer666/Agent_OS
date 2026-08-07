'use strict';

// test/bug-175-wakeword-mel-transform.test.js — BUG-175.
//
// "Hey Jarvis" did nothing for a week. The mic was never the problem: BUG-150's
// gate means the HUD only claims standby after a real audio frame arrives, so
// the microphone was provably live the whole time. The DETECTOR was deaf.
//
// wakeword.js ports openWakeWord and reproduces every tensor SHAPE from
// openwakeword/utils.py + model.py — 1280-sample chunks, 32 mel bins, a
// 76-frame embedding window at stride 8, 96-dim embeddings, classifier window
// read from the model. It missed the one VALUE transform in the same source:
//
//     spec = np.squeeze(outputs[0])
//     spec = spec/10 + 2      # "Arbitrary transform of melspectrogram"
//
// The embedding model was trained on features in that scale, so without it the
// classifier reads out-of-distribution input and floors near zero.
//
// MEASURED through the real three ONNX models on real synthesized speech
// (2026-08-07, a node harness replicating onFrame()):
//
//     "hey jarvis"        without: 0.0073    with: 0.998     threshold 0.5
//     unrelated speech    without: 0.00019   with: 0.0000305
//
// 137x on the target AND the non-target score falls — a corrected feature
// scale, not a sensitivity trade. That measurement is the real oracle and
// cannot live in this suite (it needs onnxruntime-node, ~40s of inference, and
// a committed audio fixture). What CAN be pinned here is the transform itself,
// by value — which is the whole bug.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const uiUrl = (rel) => pathToFileURL(path.join(__dirname, '..', 'ui', 'public', 'js', rel)).href;

let wakeword, voiceWidget;

before(async () => {
  wakeword = await import(uiUrl('voice/wakeword.js'));
  voiceWidget = await import(uiUrl('widgets/kinds/voice.js'));
});

// onnxruntime hands back { data, dims }; this is the shape reshapeMelOutput consumes.
const melOut = (data, dims) => ({ data: Float32Array.from(data), dims });

describe('BUG-175 — the melspectrogram transform openWakeWord requires', () => {
  it('applies exactly x/10 + 2 to every mel bin', () => {
    const bins = 4;
    const raw = [-100, -50, 0, 6.61];
    const rows = wakeword.reshapeMelOutput(melOut(raw, [1, 1, 1, bins]));

    assert.equal(rows.length, 1);
    assert.deepEqual(
      Array.from(rows[0]).map((v) => Number(v.toFixed(4))),
      raw.map((v) => Number((v / 10 + 2).toFixed(4)))
    );
  });

  it('maps the real observed mel range onto openWakeWord\'s expected scale', () => {
    // Measured raw range on real speech through melspectrogram.onnx was about
    // [-100, 7]; the transform must land it near [-8, 2.7], which is what the
    // embedding model was trained on. A regression here would silently restore
    // the dead-detector behaviour while every test about shapes still passed.
    const rows = wakeword.reshapeMelOutput(melOut([-100, 6.98], [1, 2]));
    assert.equal(rows[0][0], -8);
    assert.ok(Math.abs(rows[0][1] - 2.698) < 1e-3, 'got ' + rows[0][1]);
  });

  it('the transform constants are openWakeWord\'s, not tunable knobs', () => {
    assert.equal(wakeword.MEL_SCALE_DIV, 10);
    assert.equal(wakeword.MEL_SCALE_ADD, 2);
    assert.equal(wakeword.MEL_BINS, 32);
  });

  it('still strips singleton dims and splits rows by the last real dimension', () => {
    // The pre-existing reshape contract, kept intact by the fix.
    const rows = wakeword.reshapeMelOutput(melOut([0, 0, 0, 0, 0, 0], [1, 3, 1, 2]));
    assert.equal(rows.length, 3, 'three frames of two bins');
    assert.equal(rows[0].length, 2);
    for (const row of rows) for (const v of row) assert.equal(v, 2, '0/10 + 2 === 2');
  });

  it('falls back to MEL_BINS when every dimension is singleton', () => {
    const rows = wakeword.reshapeMelOutput(melOut(new Array(32).fill(0), [1, 1]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].length, 32);
  });
});

describe('BUG-175 — the peak score is visible, not just logged', () => {
  it('renders the score against the threshold, because neither is judgeable alone', () => {
    const dead = voiceWidget.formatWakeword('listening', '0.0000305', 0.5);
    assert.match(dead.text, /listening/);
    assert.match(dead.text, /3\.0e-5/, 'a 1e-5 score must not round to 0.00 — that is what hid this bug');
    assert.match(dead.text, /0\.5/, 'the threshold must be shown beside the score');
    assert.equal(dead.faint, true, 'below threshold reads as inactive');
  });

  it('a working detector reads as working', () => {
    const live = voiceWidget.formatWakeword('listening', '0.998', 0.5);
    assert.match(live.text, /1\.00|0\.99/);
    assert.equal(live.faint, false);
  });

  it('no state at all is "unavailable", never a fabricated zero', () => {
    assert.deepEqual(voiceWidget.formatWakeword('', null, 0.5), { text: 'unavailable', faint: true });
  });

  it('a state with no score yet shows the state alone rather than inventing one', () => {
    const r = voiceWidget.formatWakeword('starting', undefined, 0.5);
    assert.equal(r.text, 'starting');
  });
});

describe('BUG-175 — a stopped detector can be re-armed', () => {
  const APP = fs.readFileSync(path.join(__dirname, '..', 'ui', 'public', 'js', 'app.js'), 'utf8');

  it('ensureWakeWord() drops a non-running detector instead of treating it as armed', () => {
    // The old guard was a bare `if (wakeword)`, so a detector that had stopped
    // was permanently unrecoverable — every later gesture saw a non-null object
    // and returned. Source-shape assertion because arming needs a real
    // AudioContext/getUserMedia, which node has no double for (root CLAUDE.md's
    // Electron rule; precedent test/bug-147-orb-click-feedback.test.js).
    assert.match(
      APP,
      /wakeword && typeof wakeword\.isRunning === 'function' && !wakeword\.isRunning\(\)/,
      'ensureWakeWord must check isRunning(), not just non-null'
    );
    const guard = APP.indexOf("!wakeword.isRunning()");
    const gate = APP.indexOf('if (wakeword || _wakewordArming) return;');
    assert.ok(guard > -1 && gate > guard, 'the reset must run BEFORE the early return, or it can never fire');
  });

  it('the peak score is mirrored onto the DOM for the VOICE widget to read', () => {
    assert.match(APP, /dataset\.wakewordPeak/, 'app.js must publish the peak, not only ship it to the server log');
  });
});
