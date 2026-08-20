'use strict';
// aec-route-probe-scoring.test.js — pins the arithmetic in scripts/probe-aec-routes.js.
//
// WHY THIS FILE EXISTS, AND WHAT IT DELIBERATELY CANNOT COVER. The probe's
// measurement half needs a real speaker, a real room and a real microphone, so
// CI can never run it. That is exactly the condition under which this repo keeps
// shipping mechanisms that exist, are documented, and do nothing — so the half
// that CAN be pinned is pinned: the arithmetic that turns microphone frames into
// a verdict, and specifically its refusal to convert "nothing measurable" into
// good news.
//
// Every fixture below is real measured data from the 2026-08-20 runs (Electron
// 43.3.0 and Chrome 151 on the same machine, same room, same deterministic
// signal), not invented numbers. Where a synthetic array is used it is called out
// and it is testing an arithmetic property, not a physical claim.
//
// WHAT CI STRUCTURALLY CANNOT CATCH, stated so nobody mistakes a green run for a
// working probe: that the page actually opens the microphone, that the worklet
// yields frames, that the routes actually reach the speakers, that Chrome and
// Electron are still launchable, and that the operator's speakers are not muted.
// Only running it in a room does that.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const probe = require('../scripts/probe-aec-routes.js');

// --- real frames, electron-b, 2026-08-20 (first 12 of each 50-frame cell) -----
const REAL = {
  silencePre: [0.00225, 0.0376, 0.00571, 0.0036, 0.00199, 0.003, 0.01281, 0.01096, 0.00198, 0.00354, 0.00272, 0.00225],
  silencePost: [0.00887, 0.05664, 0.00944, 0.00923, 0.02247, 0.00505, 0.00325, 0.00794, 0.00826, 0.00393, 0.00237, 0.00198],
  acOn: [0.0012, 0.00184, 0.00105, 0.00119, 0.00116, 0.00111, 0.00106, 0.00104, 0.00099, 0.00106, 0.00134, 0.00106],
  acOff: [0.1002, 0.07163, 0.11962, 0.0601, 0.10824, 0.10052, 0.06692, 0.12981, 0.06274, 0.11076, 0.10377, 0.06217],
  ttsOn: [0.07816, 0.0715, 0.08833, 0.04305, 0.06982, 0.03807, 0.09983, 0.05311, 0.07178, 0.08413, 0.05898, 0.0315],
  ttsOff: [0.05537, 0.0607, 0.0171, 0.05434, 0.00534, 0.06126, 0.06682, 0.08341, 0.06715, 0.04416, 0.03704, 0.02894],
};

const pass = (conditions, granted) => ({
  granted: granted || { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  sampleRate: 48000,
  conditions,
});
const cells = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { frames: v }]));

function runFixture(onCells, offCells) {
  return {
    env: 'fixture',
    ua: 'fixture',
    passes: {
      'aec-on': pass(cells(Object.assign({ 'silence-pre': REAL.silencePre, 'silence-post': REAL.silencePost }, onCells))),
      'aec-off': pass(cells(Object.assign({ 'silence-pre': REAL.silencePre, 'silence-post': REAL.silencePost }, offCells)),
        { echoCancellation: false, noiseSuppression: true, autoGainControl: true }),
    },
  };
}

describe('probe-aec-routes: the arithmetic', () => {
  it('aggregates POWER, not mean RMS, so loud frames keep their weight', () => {
    // Synthetic on purpose: eleven near-silent frames and one loud one. The mean
    // of the RMS values is 0.0842; the RMS of the power is 0.2887. The barge-in
    // policy reacts to the loud frame, so the power figure is the correct one.
    const spiky = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const meanOfRms = spiky.reduce((t, x) => t + x, 0) / spiky.length;
    const rmsOfPower = Math.sqrt(probe.framePower(spiky));
    assert.ok(Math.abs(meanOfRms - 1 / 12) < 1e-9);
    assert.ok(Math.abs(rmsOfPower - Math.sqrt(1 / 12)) < 1e-9);
    assert.ok(rmsOfPower > meanOfRms * 3,
      'a single loud frame must not be averaged into invisibility');
  });

  it('takes the QUIETER silence window as the floor and reports the disagreement', () => {
    const f = probe.floorOf(pass(cells({ 'silence-pre': REAL.silencePre, 'silence-post': REAL.silencePost })));
    assert.equal(f.power, Math.min(f.pre, f.post),
      'a transient in one window must not be allowed to inflate the floor and erase a real leak');
    assert.ok(f.spreadDb > 0, 'the two windows disagreed and that has to be visible');
    // electron-b's real aec-off pass moved 12.4dB between its two silence windows
    // (the operator was at the keyboard). The report warns above 6dB.
    assert.ok(f.spreadDb < 20, 'sanity: fixture spread should be a few dB, got ' + f.spreadDb);
  });

  it('a missing silence reading yields no floor rather than a wrong one', () => {
    const f = probe.floorOf(pass(cells({ audiocontext: REAL.acOn })));
    assert.equal(f.power, null);
    const scored = probe.scorePass(pass(cells({ audiocontext: REAL.acOn })));
    assert.equal(scored.routes.audiocontext.excessRms, null,
      'without a floor there is no excess, and guessing one would fabricate a reduction');
    assert.equal(scored.routes.audiocontext.driven, false);
  });
});

describe('probe-aec-routes: the validity gate is the whole design', () => {
  it('refuses to score a route whose AEC-off reference is not above the room', () => {
    // This is run 1 of the real probe: the signal played ~20dB below the OS TTS
    // voice, so nothing was driven. Headphones, muted speakers, or a mic on
    // another device produce this same shape, and it reads exactly like perfect
    // cancellation. It must not.
    const quiet = REAL.silencePre.map((x) => x * 1.1);
    const r = probe.scoreRoute(
      probe.scorePass(pass(cells({ 'silence-pre': REAL.silencePre, 'silence-post': REAL.silencePost, audiocontext: quiet }))).routes.audiocontext,
      probe.scorePass(pass(cells({ 'silence-pre': REAL.silencePre, 'silence-post': REAL.silencePost, audiocontext: REAL.acOn }))).routes.audiocontext,
    );
    assert.equal(r.state, 'UNDER-DRIVEN');
    assert.equal(r.reductionDb, null, 'an unscorable cell must not emit a reduction figure');
  });

  it('a whole run of under-driven routes verdicts INVALID, never as cancellation', () => {
    const quiet = REAL.silencePre.map((x) => x * 1.1);
    const scored = probe.scoreRun(runFixture(
      { audiocontext: REAL.acOn, 'audio-element': REAL.acOn },
      { audiocontext: quiet, 'audio-element': quiet },
    ));
    const v = probe.verdictOf(scored);
    assert.equal(v.verdict, 'INVALID');
    assert.match(v.detail, /NOT evidence of\s+working cancellation/,
      'the verdict has to say out loud that a clean sweep proves nothing');
    assert.notEqual(v.verdict, 'NO ECHO PATH');
  });
});

describe('probe-aec-routes: verdicts against the real 2026-08-20 measurements', () => {
  it('an AEC-on reading below the floor is reported as a BOUND, not a value', () => {
    const scored = probe.scoreRun(runFixture({ audiocontext: REAL.acOn }, { audiocontext: REAL.acOff }));
    const r = scored.routes.audiocontext;
    assert.equal(r.state, 'CANCELLED');
    assert.equal(r.belowFloor, true);
    assert.equal(r.reductionDb, null,
      'below the floor the residue is smaller than the room; a point estimate there is '
      + 'what made two runs of this probe look 15dB apart when both measured room noise');
    assert.ok(r.lowerBoundDb > 12, 'the bound itself must still be reported, got ' + r.lowerBoundDb);
  });

  it('speechSynthesis reads NOT CANCELLED on its own real frames', () => {
    // The finding, from four runs across Chrome and Electron: browser AEC removes
    // nothing from the OS voice. Both figures here are AGC-on, so this is not the
    // AGC artefact that made an earlier run unscorable.
    const scored = probe.scoreRun(runFixture({ 'speech-synthesis': REAL.ttsOn }, { 'speech-synthesis': REAL.ttsOff }));
    const r = scored.routes['speech-synthesis'];
    assert.equal(r.state, 'NOT CANCELLED');
    assert.ok(r.reductionDb < probe.SNR_GATE,
      'measured reduction was -1.1 to -1.5dB; anything at or above +6dB here means the '
      + 'fixture or the thresholds moved');
  });

  it('page audio cancelled + OS voice leaking verdicts ROUTING DIFFERENCE and names the leak', () => {
    const scored = probe.scoreRun(runFixture(
      { audiocontext: REAL.acOn, 'speech-synthesis': REAL.ttsOn },
      { audiocontext: REAL.acOff, 'speech-synthesis': REAL.ttsOff },
    ));
    const v = probe.verdictOf(scored);
    assert.equal(v.verdict, 'ROUTING DIFFERENCE');
    assert.deepEqual(v.leaking, ['speech-synthesis']);
    assert.match(v.detail, /not to add an echo canceller/,
      'BUG-274 T4 spent its budget looking for a missing canceller; the verdict must say '
      + 'the remedy is routing');
  });

  it('every route leaking verdicts CAPABILITY GAP', () => {
    const scored = probe.scoreRun(runFixture(
      { audiocontext: REAL.ttsOn, 'speech-synthesis': REAL.ttsOn },
      { audiocontext: REAL.ttsOff, 'speech-synthesis': REAL.ttsOff },
    ));
    assert.equal(probe.verdictOf(scored).verdict, 'CAPABILITY GAP');
  });

  it('nothing leaking verdicts NO ECHO PATH and still points elsewhere for high bleed', () => {
    const scored = probe.scoreRun(runFixture(
      { audiocontext: REAL.acOn, 'audio-element': REAL.acOn },
      { audiocontext: REAL.acOff, 'audio-element': REAL.acOff },
    ));
    const v = probe.verdictOf(scored);
    assert.equal(v.verdict, 'NO ECHO PATH');
    assert.match(v.detail, /playback level/,
      'a clean sweep must not close the live-session bleed question by implication');
  });

  it('an unavailable engine is carried as unavailable, not scored as cancelled', () => {
    const scored = probe.scoreRun({
      env: 'f',
      passes: {
        'aec-on': pass(Object.assign(cells({ 'silence-pre': REAL.silencePre, 'silence-post': REAL.silencePost }),
          { 'speech-synthesis': { unavailable: 'no speechSynthesis' } })),
        'aec-off': pass(Object.assign(cells({ 'silence-pre': REAL.silencePre, 'silence-post': REAL.silencePost }),
          { 'speech-synthesis': { unavailable: 'no speechSynthesis' } })),
      },
    });
    assert.equal(scored.routes['speech-synthesis'].state, 'UNAVAILABLE');
    assert.equal(probe.verdictOf(scored).verdict, 'INVALID',
      'a run where the only route was unavailable has measured nothing');
  });

  it('a pass that failed to open the microphone surfaces the error instead of a verdict', () => {
    const scored = probe.scoreRun({
      env: 'f',
      passes: { 'aec-on': { error: 'NotAllowedError: permission denied' }, 'aec-off': pass(cells({ audiocontext: REAL.acOff })) },
    });
    assert.equal(scored.on.error, 'NotAllowedError: permission denied');
    assert.deepEqual(scored.routes, {}, 'no microphone means no routes, not zero-reduction routes');
    assert.equal(probe.verdictOf(scored).verdict, 'INVALID');
  });
});

describe('probe-aec-routes: the report says what it cannot know', () => {
  it('names the floor-moved condition when the room drifts mid-pass', () => {
    // electron-b really did drift: silence-pre 0.0067 -> silence-post 0.0281.
    const drifting = REAL.silencePost.map((x) => x * 4);
    const scored = probe.scoreRun({
      env: 'drift',
      ua: 'fixture',
      passes: {
        'aec-on': pass(cells({ 'silence-pre': REAL.silencePre, 'silence-post': drifting, audiocontext: REAL.acOn })),
        'aec-off': pass(cells({ 'silence-pre': REAL.silencePre, 'silence-post': REAL.silencePost, audiocontext: REAL.acOff })),
      },
    });
    assert.match(probe.report(scored), /floor moved [\d.]+dB during this pass/,
      'a room that moved mid-pass makes the cells incomparable and the reader must be told');
  });
});
