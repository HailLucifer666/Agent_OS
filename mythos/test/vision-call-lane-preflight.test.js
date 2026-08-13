'use strict';

// test/vision-call-lane-preflight.test.js — Wave 5 (2026-08-13).
//
// The 2026-08-12/13 session's ×4 screen_look/camera_look failures: with the
// fast vision providers down, the lane degraded to 90-185s NIM models and
// visionThink's own 12s timeout always lost — reported as timedOut:true with
// no hint the whole lane was actually unreachable. registry.js's chainFor()
// already computes the alive-only chain brain.think's own walk uses
// internally; checking it here turns "waited 12s, got silence" into an
// honest, FAST failure naming the real cause instead.
//
// chainFor is injected via opts (default: the real registry.chainFor) so
// this suite tests the mechanism without depending on real env/API keys.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { visionThink } = require('../src/core/effectors/vision-call');

describe('visionThink lane preflight', () => {
  it('fails fast with laneEmpty:true when chainFor reports nothing alive — never calls brain.think', async () => {
    let thinkCalled = false;
    const brain = { think: async () => { thinkCalled = true; return { content: 'should never see this' }; } };
    const res = await visionThink(brain, {
      prompt: 'q', b64: 'x', source: 'screen-look',
      chainFor: async () => [],
    });
    assert.equal(res.laneEmpty, true);
    assert.equal(res.content, null);
    assert.equal(res.offline, true);
    assert.equal(res.timedOut, false);
    assert.match(res.reason, /no live provider/i);
    assert.equal(thinkCalled, false, 'brain.think must never run once the lane is known empty');
  });

  it('proceeds normally when chainFor reports at least one alive provider', async () => {
    const brain = { think: async () => ({ content: 'a screen', provider: 'mistral', model: 'mistral-small-latest' }) };
    const res = await visionThink(brain, {
      prompt: 'q', b64: 'x',
      chainFor: async () => [{ provider: 'mistral', model: 'mistral-small-latest' }],
    });
    assert.equal(res.laneEmpty, undefined);
    assert.equal(res.content, 'a screen');
  });

  it('a throwing chainFor is best-effort — the real call still proceeds rather than failing the whole look', async () => {
    const brain = { think: async () => ({ content: 'still works' }) };
    const res = await visionThink(brain, {
      prompt: 'q', b64: 'x',
      chainFor: async () => { throw new Error('registry unavailable'); },
    });
    assert.equal(res.content, 'still works');
    assert.equal(res.laneEmpty, undefined);
  });

  it('logs a vision.call line for the fast laneEmpty failure, same as every other outcome', async () => {
    const lines = [];
    const res = await visionThink({ think: async () => ({ content: 'x' }) }, {
      prompt: 'q', b64: 'x', source: 'camera-look',
      chainFor: async () => [],
      logger: { info: (msg, fields) => lines.push({ msg, fields }) },
    });
    assert.equal(res.laneEmpty, true);
    const call = lines.find((l) => l.msg === 'vision.call');
    assert.ok(call, 'the laneEmpty path must still emit instrumentation');
    assert.equal(call.fields.ok, false);
    assert.equal(call.fields.laneEmpty, true);
  });

  it('defaults to the real registry.chainFor when no override is given — does not throw in a bare require', async () => {
    // Exercises the actual default wiring (real registry.js), just proving it
    // resolves without throwing regardless of what env/keys this machine has.
    const brain = { think: async () => ({ content: 'x' }) };
    await assert.doesNotReject(visionThink(brain, { prompt: 'q', b64: 'x', timeoutMs: 500 }));
  });
});
