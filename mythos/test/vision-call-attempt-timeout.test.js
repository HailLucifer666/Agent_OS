'use strict';

// test/vision-call-attempt-timeout.test.js — 2026-08-14.
//
// THE INCIDENT: two screen_look calls in one voice session failed with "The
// vision model did not answer in time", while all five cloud vision providers
// were keyed and alive. Not the dead-lane case BUG-209 fixed (that one's
// chainFor preflight returns laneEmpty in ~91ms, and is covered by
// test/vision-call-lane-preflight.test.js) — the SLOW-BUT-ALIVE case, which was
// untouched.
//
// THE MECHANISM was a timeout mismatch, not a dead lane. visionThink() raced the
// WHOLE call against VISION_CALL_TIMEOUT_MS = 12000, while chain.js gave EACH
// provider attempt CHAIN_ATTEMPT_TIMEOUT_MS = 30000. So a first-ranked model that
// was merely slow held the entire 12s budget inside attempt #1 and models 2-5
// were never tried. The lane had failover; the budget never let it run. Worse, the
// underlying call is not cancellable, so the slow provider kept running and its
// answer was thrown away.
//
// So the fix is a per-CALL attempt timeout threaded visionThink -> brain.think ->
// chain.js, and the invariant this file exists to pin is the RELATION between the
// two bounds: a per-attempt timeout at or above the total budget is not a
// configuration choice, it is the bug.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  visionThink, DEFAULT_VISION_TIMEOUT_MS, DEFAULT_VISION_ATTEMPT_TIMEOUT_MS,
} = require('../src/core/effectors/vision-call');

const ALIVE = async () => [{ provider: 'mistral', model: 'mistral-small-latest' }];

// Captures what visionThink hands brain.think.
function spyBrain(reply) {
  const calls = [];
  return {
    calls,
    think: async (args) => { calls.push(args); return reply || { content: 'a screen' }; },
  };
}

describe('visionThink threads a per-attempt timeout into the chain', () => {
  it('passes one by default — without it the chain cannot get past attempt #1', async () => {
    const brain = spyBrain();
    await visionThink(brain, { prompt: 'q', b64: 'x', chainFor: ALIVE });
    assert.equal(brain.calls.length, 1);
    assert.equal(brain.calls[0].attemptTimeoutMs, DEFAULT_VISION_ATTEMPT_TIMEOUT_MS);
  });

  it('the default attempt bound leaves room for at least 2 models inside the total budget', () => {
    assert.ok(DEFAULT_VISION_ATTEMPT_TIMEOUT_MS * 2 <= DEFAULT_VISION_TIMEOUT_MS,
      'this is the whole fix: the budget must be able to walk more than one provider. '
      + `Got attempt=${DEFAULT_VISION_ATTEMPT_TIMEOUT_MS} total=${DEFAULT_VISION_TIMEOUT_MS}`);
  });

  it('honours an explicit override (the config seam: VISION_ATTEMPT_TIMEOUT_MS)', async () => {
    const brain = spyBrain();
    await visionThink(brain, { prompt: 'q', b64: 'x', chainFor: ALIVE, attemptTimeoutMs: 2500 });
    assert.equal(brain.calls[0].attemptTimeoutMs, 2500);
  });

  it('clamps the attempt bound below the total bound — the exact shape of the bug', async () => {
    const brain = spyBrain();
    // A misconfiguration in the direction that reproduces the incident: 30s per
    // attempt against a 6s budget.
    await visionThink(brain, {
      prompt: 'q', b64: 'x', chainFor: ALIVE, timeoutMs: 6000, attemptTimeoutMs: 30000,
    });
    assert.equal(brain.calls[0].attemptTimeoutMs, 6000,
      'a per-attempt bound at or above the total bound guarantees attempt #1 consumes the '
      + 'whole budget, which is precisely what failed on 2026-08-14');
  });

  it('ignores a nonsense override rather than sending it to the chain', async () => {
    for (const bad of [0, -1, NaN, 'soon', null]) {
      const brain = spyBrain();
      await visionThink(brain, { prompt: 'q', b64: 'x', chainFor: ALIVE, attemptTimeoutMs: bad });
      assert.equal(brain.calls[0].attemptTimeoutMs, DEFAULT_VISION_ATTEMPT_TIMEOUT_MS,
        'a bad value must fall back to the default, not disable the bound: got ' + String(bad));
    }
  });
});

describe('visionThink per-provider latency telemetry (BUG-209`s missing evidence)', () => {
  it('logs a vision.attempt line for every attempt the chain reports', async () => {
    const lines = [];
    const brain = {
      think: async (args) => {
        args.onAttemptEnd({ provider: 'nim', model: 'slow-vlm', ms: 4001, ok: false, timedOut: true });
        args.onAttemptEnd({ provider: 'mistral', model: 'pixtral', ms: 900, ok: true, timedOut: false });
        return { content: 'a screen', provider: 'mistral', model: 'pixtral' };
      },
    };
    await visionThink(brain, {
      prompt: 'q', b64: 'x', source: 'screen-look', chainFor: ALIVE,
      logger: { info: (evt, data) => lines.push([evt, data]) },
    });

    const attemptLines = lines.filter(([evt]) => evt === 'vision.attempt');
    assert.equal(attemptLines.length, 2,
      'BUG-209 named the absence of per-provider latency as the reason the vision lane could '
      + 'not be reordered on evidence — one line per attempt is that evidence');
    assert.equal(attemptLines[0][1].provider, 'nim');
    assert.equal(attemptLines[0][1].timedOut, true);
    assert.equal(attemptLines[0][1].ms, 4001);
    assert.equal(attemptLines[1][1].ok, true);
    // The source tag has to be on the attempt lines too, or a screen_look and a
    // camera_look interleaved in the same log are indistinguishable.
    assert.equal(attemptLines[0][1].source, 'screen-look');
  });

  it('a timeout reports HOW MANY models were tried, not just that it gave up', async () => {
    const lines = [];
    const brain = {
      think: (args) => {
        args.onAttemptEnd({ provider: 'nim', model: 'slow-vlm', ms: 40, ok: false, timedOut: true });
        args.onAttemptEnd({ provider: 'nim2', model: 'slow-vlm', ms: 40, ok: false, timedOut: true });
        return new Promise(() => {});   // never settles: the uncancellable call
      },
    };
    const res = await visionThink(brain, {
      prompt: 'q', b64: 'x', source: 'screen-look', chainFor: ALIVE,
      timeoutMs: 120, attemptTimeoutMs: 40,
      logger: { info: (evt, data) => lines.push([evt, data]) },
    });

    assert.equal(res.timedOut, true);
    assert.equal(res.attemptsTried, 2,
      'attemptsTried is what distinguishes "one slow model ate the budget" (the 2026-08-14 '
      + 'cause, a threading bug) from "every model was tried and all were slow" (a '
      + 'lane-ordering problem). A bare timedOut:true cannot tell them apart.');

    const call = lines.filter(([evt]) => evt === 'vision.call').pop();
    assert.equal(call[1].timedOut, true);
    assert.equal(call[1].attemptsTried, 2);
    assert.equal(call[1].attemptTimeoutMs, 40);
    assert.ok(Array.isArray(call[1].attempts) && call[1].attempts.length === 2,
      'the log line must name the models, so the lane can be reordered without another session');
  });

  it('a throwing logger cannot take the look down', async () => {
    const brain = {
      think: async (args) => {
        args.onAttemptEnd({ provider: 'mistral', model: 'pixtral', ms: 10, ok: true });
        return { content: 'a screen' };
      },
    };
    const res = await visionThink(brain, {
      prompt: 'q', b64: 'x', chainFor: ALIVE,
      logger: { info: () => { throw new Error('disk full'); } },
    });
    // Found by this test, not in production, and it was ALREADY true of the
    // terminal vision.call line before the per-attempt lines multiplied the
    // chances of hitting it: an info() that throws killed the entire look. The log
    // is an optimisation; the answer is the product (same rule as pcm-player's
    // throwing-callback guard).
    assert.equal(res.content, 'a screen');
  });
});
