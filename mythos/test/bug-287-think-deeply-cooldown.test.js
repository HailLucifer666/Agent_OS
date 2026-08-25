'use strict';

// BUG-287 — think_deeply had no rate limit, and the operator hit the loop it
// creates.
//
// Reproduced from the 2026-08-20 audit vault, not inferred. Eight think_deeply
// calls that day, every one actor:"cortex", with these gaps between them:
//
//   20:06:46  ->  20:07:47   61s
//   20:07:47  ->  20:07:59   12s
//   20:07:59  ->  20:08:16   17s
//   20:08:16  ->  20:10:49  153s
//   20:10:49  ->  20:17:45  416s
//   13:35:31  ->  13:35:53   22s
//
// Four calls inside 91 seconds, each restating the same browser-offline
// diagnosis. The operator said so twice, in those words: "Why are you repeating
// yourself? You just told me that." and "why are you thinking deeply for
// everything?", then ordered it logged — which is incident inc-1787170098385-1,
// "repeating myself aloud due to diagnostic loop".
//
// The loop is visible in the arguments themselves. At 20:07:59 the question is
// "Operator calls out MYTHOS for repeating the exact same sentence... Why did
// the pre[vious]..." and at 20:08:16 it is "Operator asks why MYTHOS repeated
// themselves and why they call think_deeply frequently". It called the slow,
// expensive reasoning lane to think about why it had called the slow, expensive
// reasoning lane — adding the latency that caused the next repetition.
//
// WHY A RATE LIMIT AND NOT A CONTENT DIFF-GATE. This repo already has
// diff-gate.js, and cortex's mull() uses it to speak only when its thought
// changed, so reusing it was the obvious first idea. The arguments refute it:
// all eight questions are textually DIFFERENT. They are different questions
// about the same stuck situation, so a same-text gate would have caught none of
// them. The thing they share is being seconds apart.
//
// 60s would have blocked exactly the three rapid calls (12s, 17s, 22s) and
// allowed the four spaced ones (61s, 153s, 416s). That is the cut this default
// is chosen to make, and it is the whole justification for the number.
//
// The previous remedy was prose in the tool description — "DEFAULT TO ANSWERING
// IT YOURSELF... this call is expensive... Only reach for it when you would
// otherwise GUESS". It is still there and still right, and it lost. Prose
// losing to a tool call is a recorded pattern in this repo.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const FROM_COMPUTER = path.resolve(__dirname, '../src/core/effectors/from-computer.js');
const DEEP_THINK = path.resolve(__dirname, '../src/core/effectors/deep-think.js');

// A fresh module per test: the cooldown timestamp is module state, so a stale
// one would leak between cases and make them pass or fail on ordering.
function freshModule() {
  delete require.cache[FROM_COMPUTER];
  return require(FROM_COMPUTER);
}

function fakeHub() {
  return { register() {} };
}

// Stubbed at the deep-think MODULE boundary rather than at brain.think.
//
// A brain stub does not work here and the reason is worth keeping: deepThink()
// preflights the REAL provider registry (`chainFor('reasoning')`) before it
// calls brain.think at all, and think_deeply passes no chainFor override. With
// no live reasoning provider in a test environment the preflight short-circuits
// and returns "the reasoning lane has no live provider right now" — so a brain
// stub is never reached, and a test written against one measures nothing.
//
// The boundary below is also the one the invariant is actually about: the
// cooldown's job is that the expensive reasoning path is not ENTERED. The
// return shape is deepThink's documented one.
function stubDeepThink(behaviour) {
  const calls = [];
  require.cache[DEEP_THINK] = {
    id: DEEP_THINK,
    filename: DEEP_THINK,
    loaded: true,
    exports: {
      deepThink: async (brain, opts) => {
        calls.push(opts);
        if (behaviour === 'offline') {
          return { content: null, provider: null, model: null, offline: true, timedOut: false, ms: 1, reason: 'the reasoning lane is down' };
        }
        return { content: 'the considered answer', provider: 'p', model: 'm', offline: false, timedOut: false, ms: 5 };
      },
    },
  };
  return calls;
}

// think_deeply only checks that a brain object with think() exists; the stub
// above stands in for everything past that point.
const A_BRAIN = { think: () => Promise.resolve({ content: 'unused' }) };

function wire(mod, { brain, config }) {
  mod.registerFromComputer(fakeHub(), { brain, config, logger: null });
  return mod;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('BUG-287: think_deeply refuses a second call inside the cooldown', () => {
  let mod;
  beforeEach(() => { mod = freshModule(); });
  afterEach(() => { delete require.cache[FROM_COMPUTER]; delete require.cache[DEEP_THINK]; });

  it('answers the first call', async () => {
    const calls = stubDeepThink();
    wire(mod, { brain: A_BRAIN, config: { DEEP_THINK_MIN_INTERVAL_MS: 60000 } });
    const res = await mod.think_deeply({ question: 'a real question' });
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
  });

  it('refuses an immediate second call', async () => {
    const calls = stubDeepThink();
    wire(mod, { brain: A_BRAIN, config: { DEEP_THINK_MIN_INTERVAL_MS: 60000 } });
    await mod.think_deeply({ question: 'first' });
    const res = await mod.think_deeply({ question: 'second, seconds later' });
    assert.equal(res.ok, false, 'the second call inside the window must be refused');
  });

  it('never reaches the reasoning lane on a refusal', async () => {
    // The MECHANISM, not the return value. Returning false while still having
    // spent the scarce request would be the bug wearing a fix's clothes: the
    // whole point is that the expensive call does not happen.
    const calls = stubDeepThink();
    wire(mod, { brain: A_BRAIN, config: { DEEP_THINK_MIN_INTERVAL_MS: 60000 } });
    await mod.think_deeply({ question: 'first' });
    await mod.think_deeply({ question: 'second' });
    await mod.think_deeply({ question: 'third' });
    assert.equal(calls.length, 1, 'only the first call may reach the reasoning path');
  });

  it('tells the model to answer it itself, and how long is left', async () => {
    // A refusal the model cannot act on just becomes an apology to the operator.
    const calls = stubDeepThink();
    wire(mod, { brain: A_BRAIN, config: { DEEP_THINK_MIN_INTERVAL_MS: 60000 } });
    await mod.think_deeply({ question: 'first' });
    const res = await mod.think_deeply({ question: 'second' });
    const msg = String(res.result);
    // Specifically the REMAINING time, not just any number. The first version of
    // this assertion was /\d+\s*s/, which the "used 0s ago" clause satisfied on
    // its own — mutation testing removed the remaining-time clause entirely and
    // the test still passed. A countdown the model cannot read is not a countdown.
    const remaining = /another\s+(\d+)\s*s/.exec(msg);
    assert.ok(remaining, 'the message must say how much longer to wait, e.g. "another 45s": ' + msg);
    assert.ok(Number(remaining[1]) > 0, 'a remaining time of 0 would tell the model to retry immediately');
    assert.match(msg, /answer this yourself/i,
      'the message must tell the model to answer from its own knowledge');
    assert.doesNotMatch(msg, /fail|error|broken/i,
      'this is a cooldown, not a fault — saying so would send the model diagnosing a healthy system');
  });

  it('allows the next call once the window has passed', async () => {
    // A real clock and a short window: the gate is a timestamp comparison, and a
    // hand-moved clock proves less than simply waiting 60ms.
    const calls = stubDeepThink();
    wire(mod, { brain: A_BRAIN, config: { DEEP_THINK_MIN_INTERVAL_MS: 40 } });
    await mod.think_deeply({ question: 'first' });
    assert.equal((await mod.think_deeply({ question: 'too soon' })).ok, false);
    await sleep(60);
    const res = await mod.think_deeply({ question: 'after the window' });
    assert.equal(res.ok, true, 'the cooldown must expire — this must not become "never twice"');
    assert.equal(calls.length, 2);
  });
});

describe('BUG-287: the cooldown starts even when the call fails', () => {
  let mod;
  beforeEach(() => { mod = freshModule(); });
  afterEach(() => { delete require.cache[FROM_COMPUTER]; delete require.cache[DEEP_THINK]; });

  it('a lane that answers offline still starts the window', async () => {
    // The failing case is the one worth rate-limiting most: a broken reasoning
    // lane burns the full timeout on every attempt, so hammering it is strictly
    // worse than hammering a working one.
    const calls = stubDeepThink('offline');
    wire(mod, { brain: A_BRAIN, config: { DEEP_THINK_MIN_INTERVAL_MS: 60000 } });
    const first = await mod.think_deeply({ question: 'first' });
    assert.equal(first.ok, false, 'an offline lane fails, as before');
    const second = await mod.think_deeply({ question: 'second' });
    assert.equal(second.ok, false);
    assert.equal(calls.length, 1, 'the failed attempt must still hold the window shut');
  });

  it('no brain wired is reported as no brain, not as a cooldown', async () => {
    // Order matters. Telling the operator to wait 45 seconds for a lane that is
    // not wired at all would be a confident wrong answer.
    stubDeepThink();
    wire(mod, { brain: null, config: { DEEP_THINK_MIN_INTERVAL_MS: 60000 } });
    const res = await mod.think_deeply({ question: 'anything' });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /brain/i);
  });
});

describe('BUG-287: the threshold cannot silently switch the guard off', () => {
  let mod;
  beforeEach(() => { mod = freshModule(); });
  afterEach(() => { delete require.cache[FROM_COMPUTER]; delete require.cache[DEEP_THINK]; });

  it('an unparseable value falls back to the default, leaving the guard ON', async () => {
    // The failure mode this exists for: a threshold that parses to NaN makes
    // every comparison false, so the guard never fires again and looks enabled.
    // Falling back to the default keeps it on; falling back to 0 would not.
    const calls = stubDeepThink();
    wire(mod, { brain: A_BRAIN, config: { DEEP_THINK_MIN_INTERVAL_MS: 'sixty seconds' } });
    await mod.think_deeply({ question: 'first' });
    const res = await mod.think_deeply({ question: 'second' });
    assert.equal(res.ok, false, 'a garbage threshold must not disable the cooldown');
    assert.equal(calls.length, 1);
  });

  it('a negative value also falls back to the default', async () => {
    const calls = stubDeepThink();
    wire(mod, { brain: A_BRAIN, config: { DEEP_THINK_MIN_INTERVAL_MS: -5 } });
    await mod.think_deeply({ question: 'first' });
    assert.equal((await mod.think_deeply({ question: 'second' })).ok, false);
  });

  it('an explicit 0 disables it — the deliberate opt-out', async () => {
    // Distinct from a broken value on purpose: someone who writes 0 means it.
    const calls = stubDeepThink();
    wire(mod, { brain: A_BRAIN, config: { DEEP_THINK_MIN_INTERVAL_MS: 0 } });
    await mod.think_deeply({ question: 'first' });
    const res = await mod.think_deeply({ question: 'second' });
    assert.equal(res.ok, true, '0 must mean off, or there is no way to turn it off');
    assert.equal(calls.length, 2);
  });

  it('an absent config still enforces the default, not no limit', async () => {
    // registerFromComputer is called with no config in several paths. The guard
    // must not depend on configuration being present to exist.
    const calls = stubDeepThink();
    wire(mod, { brain: A_BRAIN, config: null });
    await mod.think_deeply({ question: 'first' });
    assert.equal((await mod.think_deeply({ question: 'second' })).ok, false,
      'no config must not mean no cooldown');
  });
});

describe('BUG-287: the default is the measured one', () => {
  it('is 60000ms, and the schema agrees with the code', () => {
    // 60s is not a round number picked for looking sensible: it is the cut that
    // blocks the three rapid calls from the incident (12s, 17s, 22s) and allows
    // the four spaced ones (61s, 153s, 416s). If either place changes alone, the
    // documented reasoning stops matching what runs.
    const { SCHEMA } = require('../src/core/config/schema');
    assert.equal(SCHEMA.DEEP_THINK_MIN_INTERVAL_MS.default, 60000);
    assert.equal(SCHEMA.DEEP_THINK_MIN_INTERVAL_MS.min, 0, '0 is the deliberate opt-out');

    const mod = freshModule();
    assert.equal(mod._deepThinkMinIntervalDefaultMs(), 60000);
    delete require.cache[FROM_COMPUTER];
  });
});
