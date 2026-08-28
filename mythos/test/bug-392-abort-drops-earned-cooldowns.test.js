'use strict';

// bug-392-abort-drops-earned-cooldowns.test.js — the THIRD exit from the chain walk.
//
// BUG-392: `chain.js`'s loop-top caller-abort check threw straight out of the walk
// without calling settleDeferredTimeouts(), so every cooldown a provider had
// ALREADY earned on its own merits was discarded — and discarded in silence: no
// markCooldown, no recordFailure, no whole-lane-timeout warn, no health.anomaly.
//
// WHY THIS FILE EXISTS RATHER THAN A THIRD PATCH. settleDeferredTimeouts has now
// been forgotten on an exit path twice before:
//   1. the first version ran it ONLY on the exhausted path, dropping the cooldown
//      for every run that eventually answered (chain.js's own comment calls that
//      the common case);
//   2. fixed by adding the success path — and the comment written then claims it
//      is "Called on EVERY exit from the walk", which was already false: the abort
//      exit existed and was not covered.
// Twice is a class, not an instance, so the fix is structural — the walk is
// wrapped in try/finally and the settle runs as the loop unwinds, whatever the
// reason. These tests assert the OBSERVABLE consequence (cooldown state, breaker
// failCount, emitted anomaly) rather than that a particular line is present, so
// they hold against any future restructuring of the same guarantee.
//
// REACHABILITY, MEASURED 2026-08-28 — this is a LATENT defect, not a live one, and
// the ticket's own claim that "the window is wide" is wrong. Exactly one call site
// in the tree passes a caller signal to brain.think (voice-agent.js:413) and it
// does not override attemptTimeoutMs, so the per-attempt ceiling and the voice
// turn's own ceiling are BOTH 30000ms (chain.js ATTEMPT_TIMEOUT_MS default;
// .env:182 leaves CHAIN_ATTEMPT_TIMEOUT_MS commented out) — and the caller's timer
// is armed first, at server/index.js:3300, before the memory-recall work. So the
// caller aborts before any attempt can reach its own ceiling, attemptTimedOut
// stays false, and nothing is ever deferred to drop. The precondition that makes
// it live is an operator setting CHAIN_ATTEMPT_TIMEOUT_MS below 30000, which
// schema.js:553 supports (min 1000). Fixed on the mechanism, not on the incident.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const chain = require('../src/core/brain/chain');
const registry = require('../src/core/brain/registry');
const { LANES } = chain._internal;

// --- harness -------------------------------------------------------------
// Deliberately the same shape as chain-provider-breakers.test.js: the real
// providers are swapped at the LANES map and the ranked list at
// registry.chainFor, so nothing here touches a network and nothing here is
// timing-dependent beyond the attempt ceiling it sets itself.
//
// Registry entries are { provider, model }, NOT { lane, model } — expand() maps
// one to the other. Getting that wrong yields an empty walk that looks like a
// passing assertion.
const saved = { chainFor: null, lanes: {} };

function stubLane(name, impl) {
  if (!saved.lanes[name]) saved.lanes[name] = { chat: LANES[name].chat, isAvailable: LANES[name].isAvailable };
  LANES[name].isAvailable = () => true;
  LANES[name].chat = impl;
}

function rank(entries) {
  registry.chainFor = async () => entries;
}

// Hangs until its OWN attempt timer aborts it. This is the provider that EARNS a
// cooldown: attemptTimedOut is set by chain.js's timer before attemptCtrl.abort(),
// so the catch block classifies it as a timeout, not as a caller abort.
function hangs() {
  return (messages, opts) => new Promise((_resolve, reject) => {
    if (!opts || !opts.signal) return;
    opts.signal.addEventListener('abort', () => {
      const e = new Error('This operation was aborted');
      e.name = 'AbortError';
      reject(e);
    }, { once: true });
  });
}

// Same, but trips the CALLER's controller on its way out. This is what makes the
// reproduction deterministic instead of a millisecond race: the abort is guaranteed
// to be visible at the next loop-top check, because it is set from inside the
// handler for this attempt's own ceiling.
function hangsAndAbortsCaller(ctrl) {
  return (messages, opts) => new Promise((_resolve, reject) => {
    if (!opts || !opts.signal) return;
    opts.signal.addEventListener('abort', () => {
      ctrl.abort();
      const e = new Error('This operation was aborted');
      e.name = 'AbortError';
      reject(e);
    }, { once: true });
  });
}

function answers(text) {
  return async () => text;
}

function collectingBus() {
  const events = [];
  return { events, emit: (name, payload) => events.push({ name, payload }) };
}

const BREAKER_CONFIG = { CHAIN_BREAKERS_ENABLED: true, BREAKER_FAIL_THRESHOLD: 5, BREAKER_RESET_MS: 40 };

before(() => { saved.chainFor = registry.chainFor; });
after(() => {
  registry.chainFor = saved.chainFor;
  for (const name of Object.keys(saved.lanes)) Object.assign(LANES[name], saved.lanes[name]);
  chain._internal._resetCooldowns();
  chain._internal._resetBreakers();
});
beforeEach(() => {
  chain._internal._resetCooldowns();
  chain._internal._resetBreakers();
});

describe('BUG-392: a caller abort must not discard cooldowns already earned', () => {
  it('CONTROL: with no abort, the timed-out provider IS cooled down', async () => {
    // The negative control the reproduction needs. Without it, test B below could
    // pass for the wrong reason — a rig that never defers a cooldown at all would
    // also show "no cooldown after abort", and would prove nothing.
    //
    // Exactly ONE provider times out on purpose: sharedCauseLikely requires
    // deferredTimeoutCooldowns.length > 1, so the whole-lane-timeout exemption does
    // NOT apply here and the cooldown is genuinely owed.
    stubLane('zcode', hangs());
    stubLane('groq', answers('ok'));
    rank([{ provider: 'zcode', model: 'slow-one' }, { provider: 'groq', model: 'fast-one' }]);

    const result = await chain.complete({
      messages: [{ role: 'user', content: 'hi' }], brain: 'vision',
      attemptTimeoutMs: 40, config: BREAKER_CONFIG,
    });

    assert.equal(result.provider, 'groq', 'the walk must still answer from the good provider');
    assert.ok(chain._internal.cooldowns.has('zcode:slow-one'),
      'a provider that blew its own per-attempt ceiling is at fault on its own merits');
  });

  it('a caller abort must NOT discard that same earned cooldown', async () => {
    // The reproduction. Identical lane to the control; the only difference is that
    // the caller's signal is tripped as zcode's own ceiling fires, so the next
    // loop-top check throws AbortError before groq is ever attempted.
    //
    // Pre-fix this asserted false: deferredTimeoutCooldowns held zcode:slow-one and
    // the throw left the function without settling it.
    const ctrl = new AbortController();
    stubLane('zcode', hangsAndAbortsCaller(ctrl));
    stubLane('groq', answers('ok'));
    rank([{ provider: 'zcode', model: 'slow-one' }, { provider: 'groq', model: 'fast-one' }]);

    await assert.rejects(() => chain.complete({
      messages: [{ role: 'user', content: 'hi' }], brain: 'vision',
      attemptTimeoutMs: 40, signal: ctrl.signal, config: BREAKER_CONFIG,
    }), (err) => err.name === 'AbortError',
    'the abort must still reach the caller as an AbortError — settling is not a reason to swallow it');

    assert.ok(chain._internal.cooldowns.has('zcode:slow-one'),
      'zcode blew its OWN ceiling before any abort existed. The caller changing its mind '
      + 'is an unrelated event and must not refund a cooldown that was already earned.');
  });

  it('and the breaker failure is recorded too, not just the cooldown', async () => {
    // ASSERT THE MECHANISM, NOT THE RETURN VALUE. markCooldown and
    // breaker.recordFailure are two separate side effects of settling, and B1's
    // whole argument was that the flat cooldown alone lapses between calls minutes
    // apart. A fix that restored only the cooldown would look correct here and
    // still leave the escalating half disabled on the abort path.
    const ctrl = new AbortController();
    stubLane('zcode', hangsAndAbortsCaller(ctrl));
    stubLane('groq', answers('ok'));
    rank([{ provider: 'zcode', model: 'slow-one' }, { provider: 'groq', model: 'fast-one' }]);

    await assert.rejects(() => chain.complete({
      messages: [{ role: 'user', content: 'hi' }], brain: 'vision',
      attemptTimeoutMs: 40, signal: ctrl.signal, config: BREAKER_CONFIG,
    }), (err) => err.name === 'AbortError');

    const breakers = chain._internal.getBreakers();
    assert.ok(breakers && breakers.has('zcode:slow-one'), 'the breaker must exist to be asserted about');
    assert.equal(breakers.get('zcode:slow-one').stats.failCount, 1,
      'the escalating half of B1 must count this failure as well');
  });

  it('when the exemption applies on an abort, the dropped decision is still REPORTED', async () => {
    // The other half of the ticket title — "and says nothing". With more than one
    // deferred timeout, nothing answering and no provider-naming failure,
    // sharedCauseLikely is true and the cooldowns are deliberately NOT taken. That
    // is correct (BUG-273 C3), but the DECISION has to surface: chain.js's own note
    // says "an invisible non-cooldown is how the opposite bug would hide for a
    // week". Pre-fix the abort exit dropped the report along with the decision.
    const ctrl = new AbortController();
    stubLane('zcode', hangs());
    stubLane('nim', hangsAndAbortsCaller(ctrl));
    stubLane('groq', answers('ok'));
    rank([
      { provider: 'zcode', model: 'slow-one' },
      { provider: 'nim', model: 'slow-two' },
      { provider: 'groq', model: 'fast-one' },
    ]);
    const bus = collectingBus();

    await assert.rejects(() => chain.complete({
      messages: [{ role: 'user', content: 'hi' }], brain: 'vision',
      attemptTimeoutMs: 40, signal: ctrl.signal, config: BREAKER_CONFIG, bus,
    }), (err) => err.name === 'AbortError');

    const anomalies = bus.events.filter((e) => e.name === 'health.anomaly'
      && e.payload && e.payload.kind === 'chain-whole-lane-timeout');
    assert.equal(anomalies.length, 1,
      'the shared-cause exemption must announce itself on the abort exit as it does on the other two');
    assert.equal(anomalies[0].payload.attempts, 2, 'and name how many cooldowns it declined to take');
    assert.equal(chain._internal.cooldowns.size, 0,
      'the exemption itself is unchanged — two timeouts with nothing answering is one local fault');
  });

  it('DISPOSITION PINNED: a provider interrupted BY the abort still earns nothing', async () => {
    // Deliberately NOT changed, and pinned here so the next reader does not "fix"
    // it. chain-provider-breakers.test.js:130-142 already rules that a caller
    // giving up says nothing about the provider it interrupted — "penalising a
    // provider for the caller changing its mind would evict healthy models".
    //
    // That ruling and this ticket are about DIFFERENT providers, and the
    // discriminator is attemptTimedOut: a provider killed by the caller's signal
    // never sets it, so it never enters deferredTimeoutCooldowns and settling
    // cannot reach it. A fix that cooled down whatever was in flight at abort time
    // would pass this file's other tests and break that ruling.
    stubLane('zcode', hangs());
    stubLane('groq', hangs());
    rank([{ provider: 'zcode', model: 'slow-one' }, { provider: 'groq', model: 'fast-one' }]);

    const ctrl = new AbortController();
    // Aborts well INSIDE the 5000ms attempt ceiling, so zcode is killed by the
    // caller and not by its own timer — the opposite of hangsAndAbortsCaller.
    setTimeout(() => ctrl.abort(), 10);

    await assert.rejects(() => chain.complete({
      messages: [{ role: 'user', content: 'hi' }], brain: 'vision',
      attemptTimeoutMs: 5000, signal: ctrl.signal, config: BREAKER_CONFIG,
    }), (err) => err.name === 'AbortError');

    assert.equal(chain._internal.cooldowns.size, 0,
      'nothing had earned a cooldown, so settling on the abort exit must take none');
    const breakers = chain._internal.getBreakers();
    if (breakers && breakers.has('zcode:slow-one')) {
      assert.equal(breakers.get('zcode:slow-one').stats.failCount, 0,
        'and it must not count towards a trip either');
    }
  });
});

describe('BUG-392 class guard: every exit from the walk settles', () => {
  it('each return/throw that leaves complete() is covered by a settle', () => {
    // THE ASSERTION, not another patched instance. This invariant has now been
    // broken twice on two different exits:
    //   - the original settleDeferredTimeouts ran only on the exhausted path, so
    //     every run that eventually answered dropped its cooldowns (B1's fix
    //     disabled almost entirely);
    //   - the caller-abort exit was never covered at all, and the comment above the
    //     function asserted full coverage while it was false (BUG-392).
    // A behavioural test cannot see an exit that does not exist yet, so this one is
    // deliberately structural: it counts the exits and fails when a new one appears.
    // Its job is not to prove the existing three work — the tests above do that — it
    // is to make a FOURTH exit impossible to add silently.
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'brain', 'chain.js'), 'utf8');

    // Isolate complete()'s body by brace matching, then strip comments — this file
    // discusses `throw` and `settleDeferredTimeouts` in prose at length, and a
    // comment mentioning a thing is not the code doing it. (That confusion has bitten
    // this repo repeatedly; assert over code only.)
    const start = src.indexOf('async function complete(');
    assert.ok(start > -1, 'complete() must be findable, or this guard is vacuous');
    // The body starts after the PARAMETER list, which is itself a destructuring
    // brace — brace-matching from the first `{` after `start` slices the parameters
    // and nothing else. The first draft of this guard did exactly that and was
    // caught only by the deferredTimeoutCooldowns precondition below, which is the
    // whole reason that precondition is asserted rather than assumed.
    const paramsEnd = src.indexOf(')', src.indexOf('(', start));
    assert.ok(paramsEnd > -1, 'the parameter list must close, or the body cannot be located');
    let i = src.indexOf('{', paramsEnd), depth = 0, end = i;
    for (; end < src.length; end++) {
      if (src[end] === '{') depth++;
      else if (src[end] === '}') { depth--; if (depth === 0) break; }
    }
    const body = src.slice(i, end + 1)
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    // Exits that leave the walk with attempts possibly deferred. The early
    // guard-clause returns above the walk (empty lane, etc.) run BEFORE any attempt,
    // so nothing can be deferred yet — they are identified by appearing before the
    // deferredTimeoutCooldowns declaration and excluded.
    const walkStart = body.indexOf('deferredTimeoutCooldowns');
    assert.ok(walkStart > -1, 'the deferred list must be findable, or the split below is meaningless');
    const walk = body.slice(walkStart);

    const settles = (walk.match(/settleDeferredTimeouts\(\)/g) || []).length;
    const exits = (walk.match(/(^|[\s;{}])(return|throw)[\s(]/g) || []).length;

    // 3 exits (success return, abort throw, exhaustion throw) and 3 settles. The
    // guard is a comparison, not two hardcoded numbers, so it survives a
    // restructuring that keeps the invariant and fails one that does not.
    assert.ok(settles >= 3,
      'the three known exits — success, caller abort, exhaustion — must each settle; found ' + settles);
    assert.ok(exits <= settles + 1,
      'a new exit from the walk appeared (' + exits + ' exits vs ' + settles + ' settles). '
      + 'If it can be reached with a deferred cooldown outstanding it MUST call '
      + 'settleDeferredTimeouts() first — that omission is BUG-392 and its predecessor, '
      + 'and both were silent. The +1 allowance is settleDeferredTimeouts\'s own early '
      + 'return guards, which are inside this slice.');
  });
});

describe('BUG-392 sibling: instrumentation must not be able to break the walk', () => {
  it('a throwing onAttempt callback does not take the chain walk down', async () => {
    // The parity gap BUG-392's entry flags as "the same class of defect one line
    // away". chain.js states this invariant about itself twice — "Telemetry must
    // never be able to break the chain walk it is measuring" — and wraps
    // reportSkip and reportAttemptEnd accordingly. onAttempt was the one callback
    // left bare. In production it is bus.emit('brain-spend', ...), so any throwing
    // subscriber killed the turn with an error that named neither the chain nor the
    // subscriber.
    stubLane('groq', answers('ok'));
    rank([{ provider: 'groq', model: 'fast-one' }]);

    const result = await chain.complete({
      messages: [{ role: 'user', content: 'hi' }], brain: 'vision',
      attemptTimeoutMs: 40, config: BREAKER_CONFIG,
      onAttempt: () => { throw new Error('a brain-spend subscriber threw'); },
    });

    assert.equal(result.provider, 'groq',
      'the walk must complete: instrumentation is measured, not load-bearing');
    assert.equal(result.content, 'ok');
  });
});
