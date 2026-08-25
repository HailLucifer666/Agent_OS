'use strict';

// test/think-deeply.test.js — the only route from a conversation to a strong
// reasoning model.
//
// Context, because it is what makes the tool worth testing at all: the Live
// voice path (voice/live-session.js, voice/live-tool-adapter.js) contains ZERO
// brain.think calls, and its own conversation model is capped at Flash tier on a
// free key. So no lane re-ranking anywhere in lanes.default.js can change a
// spoken answer by one word. A tool is the mechanism. That makes three things
// load-bearing and each is asserted here: the tool is REACHABLE from voice, its
// brain is actually WIRED at boot, and it degrades with a reason a person can
// act on rather than a bare "Failed".

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fromComputer = require('../src/core/effectors/from-computer');
const { deepThink, DEFAULT_DEEP_THINK_TIMEOUT_MS, DEFAULT_DEEP_THINK_ATTEMPT_TIMEOUT_MS } = require('../src/core/effectors/deep-think');
const { tierOf } = require('../src/core/leash/tiers');
const liveTools = require('../src/core/voice/live-tools');

const aliveChain = async () => [{ provider: 'cerebras', model: 'gpt-oss-120b' }];

describe('deep-think.js — bounds and honest failure', function () {
  it('clamps the per-attempt bound below the total bound', async function () {
    // The invariant vision-call.js paid for: a per-attempt bound at or above the
    // total means the chain never gets past attempt #1, so its failover exists
    // but can never run. Two real screen_look calls failed exactly that way.
    let seen = null;
    const brain = { think: (o) => { seen = o; return Promise.resolve({ content: 'ok' }); } };
    await deepThink(brain, { question: 'q', timeoutMs: 3000, attemptTimeoutMs: 9000, chainFor: aliveChain });
    assert.equal(seen.attemptTimeoutMs, 3000, 'must clamp to the total, never exceed it');
  });

  it('defaults leave room for the chain to walk more than one provider', function () {
    assert.ok(DEFAULT_DEEP_THINK_ATTEMPT_TIMEOUT_MS < DEFAULT_DEEP_THINK_TIMEOUT_MS);
    assert.ok(DEFAULT_DEEP_THINK_TIMEOUT_MS / DEFAULT_DEEP_THINK_ATTEMPT_TIMEOUT_MS >= 2,
      'the total budget must fit at least two attempts or the lane ranking is decoration');
  });

  it('asks the reasoning lane, not simple', async function () {
    let seen = null;
    const brain = { think: (o) => { seen = o; return Promise.resolve({ content: 'ok' }); } };
    await deepThink(brain, { question: 'q', chainFor: aliveChain });
    assert.equal(seen.lane, 'reasoning');
  });

  it('says the lane is empty instead of spending the whole budget on silence', async function () {
    const brain = { think: () => new Promise(() => {}) }; // never settles
    const started = Date.now();
    const r = await deepThink(brain, { question: 'q', timeoutMs: 5000, chainFor: async () => [] });
    assert.equal(r.laneEmpty, true);
    assert.match(r.reason, /no live provider/);
    assert.ok(Date.now() - started < 2000, 'the preflight must fail fast, not wait out the budget');
  });

  it('reports a timeout as a timeout, with how many providers it got through', async function () {
    const brain = {
      think: (o) => {
        o.onAttemptEnd({ provider: 'cerebras', model: 'gpt-oss-120b', ms: 40, ok: false, timedOut: true });
        return new Promise(() => {});
      },
    };
    const r = await deepThink(brain, { question: 'q', timeoutMs: 120, attemptTimeoutMs: 60, chainFor: aliveChain });
    assert.equal(r.timedOut, true);
    assert.equal(r.attemptsTried, 1);
    assert.match(r.reason, /did not answer within/);
  });

  it('a throwing logger cannot fail the call it is measuring', async function () {
    // Same guard vision-call.js added after a throwing logger took a whole look
    // down. The log is an optimisation; the answer is the product.
    const brain = {
      think: (o) => {
        o.onAttemptEnd({ provider: 'cerebras', model: 'gpt-oss-120b', ms: 5, ok: true });
        return Promise.resolve({ content: 'the answer', provider: 'cerebras', model: 'gpt-oss-120b' });
      },
    };
    const logger = { info: () => { throw new Error('logger exploded'); } };
    const r = await deepThink(brain, { question: 'q', logger, chainFor: aliveChain });
    assert.equal(r.content, 'the answer');
  });

  it('refuses an empty question without burning a provider call', async function () {
    let called = false;
    const brain = { think: () => { called = true; return Promise.resolve({ content: 'x' }); } };
    const r = await deepThink(brain, { question: '   ', chainFor: aliveChain });
    assert.equal(called, false);
    assert.match(r.reason, /no question/);
  });
});

describe('think_deeply effector', function () {
  it('is registered, T0, and needs_result', function () {
    const tool = fromComputer.TOOLS.find((t) => t.name === 'think_deeply');
    assert.ok(tool, 'think_deeply is not in from-computer.js TOOLS');
    assert.equal(tool.danger, false);
    assert.equal(tool.needs_result, true, 'a tool whose whole output IS the answer must return its result to the model');
    assert.equal(tierOf('think_deeply'), 0, 'without a tier entry the unknown-tool fail-safe puts a confirm prompt in front of a question');
  });

  it('is reachable from the Live voice surface', function () {
    // The tool exists FOR this surface. Unreachable, it is dead code that looks
    // like a capability — the shape live-tools.js is a monument to.
    const reachable = (liveTools.DEFAULT_ALLOWLIST || []).includes('think_deeply');
    assert.ok(reachable, 'think_deeply must be in live-tools.js DEFAULT_ALLOWLIST');
  });

  it('names WHEN to use it, and what to use instead', function () {
    // A vague description is why open_web got `query` where its contract
    // demanded `url`, five times out of five. The alternatives have to be named
    // or the model reaches here for everything, at 5 req/min.
    const tool = fromComputer.TOOLS.find((t) => t.name === 'think_deeply');
    const d = tool.description;
    assert.match(d, /web_search/, 'must name the lookup tool it is not');
    assert.match(d, /screen_look/, 'must name the vision tool it is not');
    assert.ok(tool.params.question, 'question is required');
    assert.match(String(tool.params.context), /optional/, 'context must be optional');
  });

  it('declines with a named reason when no brain is wired', async function () {
    // Registering with no ctx is what every existing test does, and what
    // main.js did until 2026-08-14. It must not throw, and it must not report a
    // bare "Failed" — the operator can act on "no brain wired".
    const registered = [];
    fromComputer.registerFromComputer({ register: (e) => registered.push(e) });
    const r = await fromComputer.think_deeply({ question: 'why' });
    assert.equal(r.ok, false);
    assert.match(String(r.result), /brain/i);
  });

  it('main.js actually passes a brain — the wiring, not just the tool', function () {
    // camera_look's `ctx.brain` was ALWAYS null for weeks because this exact key
    // was never passed, and it reported as "no vision brain", which sounded like
    // lane exhaustion rather than a wiring gap. A source-shape assertion is the
    // only automated guard available for a boot-time wiring call.
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    assert.match(mainSrc, /registerFromComputer\(hub,\s*\{[^}]*brain:\s*brain/,
      'main.js must pass brain into registerFromComputer or think_deeply can only decline');
  });
});
