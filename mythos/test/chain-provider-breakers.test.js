'use strict';

// chain-provider-breakers.test.js — B1 of the 2026-08-14 session repair.
//
// FILED AS "screen_look timeout, measure before touching". Measured, it was not a
// timeout problem at all — it was 8 seconds a call spent on two providers that
// answered nothing all day.
//
//   screen_look  n=5   median 10,254ms  max 12,341ms   (budget 12,000ms)
//   camera_look  n=13  median  9,484ms  max  9,793ms
//
// The 40 vision.attempt lines name the cause. PREF_VISION[0] is NVIDIA NIM:
//   nim   nvidia/nemotron-nano-12b-v2-vl  ms:4015  timedOut:true
//   nim2  nvidia/nemotron-nano-12b-v2-vl  ms:4002  timedOut:true
//   nim   nvidia/nemotron-nano-12b-v2-vl  ms:2431  "500 EngineCore encountered an issue"
//   mistral mistral-small-latest          ms:1943  ok:true
// 4s + 4s + 1.5s = the 9,457ms the log records, of which 8s bought nothing. Two
// screen_look calls (14:11:36, 14:13:52) blew the budget outright, both while
// MYTHOS was hunting the Notepad Save dialog — so it ran that sequence blind.
//
// TWO root causes, and the wave plan named only the second:
//
//   1. chain.js ALREADY had a per-(lane,model) cooldown, and it never fired,
//      because an attempt hitting its OWN per-attempt timeout matches none of
//      429 / 5xx / network. `attemptTimedOut` was computed for telemetry and
//      never consulted for the decision.
//   2. Even fixed, a flat 60s cooldown lapses between calls minutes apart —
//      which is exactly the observed spacing. Escalating backoff is what closes
//      it, and breakers.js already implements that FSM.
//
// Both are tested here, separately, because they fail independently.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const chain = require('../src/core/brain/chain');
const registry = require('../src/core/brain/registry');
const { LANES } = chain._internal;

// --- harness -------------------------------------------------------------
// The real providers are swapped at the LANES map (already exported for tests)
// and the ranked list at registry.chainFor, so nothing here touches a network.
const saved = { chainFor: null, lanes: {} };

function stubLane(name, impl) {
  if (!saved.lanes[name]) saved.lanes[name] = { chat: LANES[name].chat, isAvailable: LANES[name].isAvailable };
  LANES[name].isAvailable = () => true;
  LANES[name].chat = impl;
}

function rank(entries) {
  registry.chainFor = async () => entries;
}

// A provider that hangs until its attempt timer aborts it — the measured NIM
// failure, and the one the old cooldown could not see.
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

function answers(text) {
  return async () => text;
}

function fails(message) {
  return async () => { throw new Error(message); };
}

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

// Runs one chain walk and returns every attempt outcome, skips included.
async function walk(opts) {
  const attempts = [];
  const result = await chain.complete(Object.assign({
    messages: [{ role: 'user', content: 'hi' }],
    brain: 'vision',
    attemptTimeoutMs: 30,
    onAttemptEnd: (a) => attempts.push(a),
    config: { CHAIN_BREAKERS_ENABLED: true, BREAKER_FAIL_THRESHOLD: 2, BREAKER_RESET_MS: 40 },
  }, opts || {}));
  return { result, attempts };
}

describe('B1 root cause 1: a per-attempt timeout is a provider fault', () => {
  it('a timed-out attempt now takes a cooldown — it never used to', () => {
    // The regression that matters most: this is why NIM was retried on every
    // single call for a whole day. The cooldown mechanism was present and
    // correct; "This operation was aborted" simply matched none of its patterns.
    stubLane('nim', hangs());
    stubLane('mistral', answers('ok'));
    rank([{ provider: 'nim', model: 'v-model' }, { provider: 'mistral', model: 'm-model' }]);

    return walk().then(({ result, attempts }) => {
      assert.equal(result.provider, 'mistral', 'the good provider must still answer');
      const timedOut = attempts.find((a) => a.provider === 'nim');
      assert.equal(timedOut.timedOut, true, 'the attempt must be reported as a timeout');
      assert.ok(chain._internal.cooldowns.has('nim:v-model'),
        'a provider that will not answer inside its OWN step budget is faulty by definition. '
        + 'Without this the 40 measured timeouts took no cooldown at all.');
    });
  });

  it('a caller abort is still NOT a provider fault', async () => {
    // C7's original point, which must survive: a caller giving up says nothing
    // about the provider. Both are AbortError; only the attempt timer is evidence.
    //
    // Note on the thrown error, which is pre-existing behaviour and deliberately
    // pinned rather than changed: the catch block swallows the abort like any
    // other attempt failure, and the AbortError is only re-thrown at the TOP of
    // the NEXT iteration. So a caller abort during the LAST attempt surfaces as
    // chain-exhausted, and during an earlier one as AbortError. Both are asserted;
    // what matters for B1 is that neither takes a cooldown or trips a breaker.
    stubLane('mistral', hangs());
    stubLane('groq', hangs());
    rank([{ provider: 'mistral', model: 'm-model' }]);

    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10);
    await assert.rejects(() => chain.complete({
      messages: [{ role: 'user', content: 'hi' }], brain: 'vision',
      attemptTimeoutMs: 5000, signal: ctrl.signal,
      config: { CHAIN_BREAKERS_ENABLED: true, BREAKER_FAIL_THRESHOLD: 2, BREAKER_RESET_MS: 40 },
    }));
    assert.equal(chain._internal.cooldowns.has('mistral:m-model'), false,
      'penalising a provider for the caller changing its mind would evict healthy models');
    const breakers = chain._internal.getBreakers();
    if (breakers && breakers.has('mistral:m-model')) {
      assert.equal(breakers.get('mistral:m-model').stats.failCount, 0,
        'and it must not count towards a trip either');
    }

    // With an attempt still to come, the abort propagates as AbortError.
    chain._internal._resetCooldowns();
    chain._internal._resetBreakers();
    rank([{ provider: 'mistral', model: 'm-model' }, { provider: 'groq', model: 'g-model' }]);
    const ctrl2 = new AbortController();
    setTimeout(() => ctrl2.abort(), 10);
    await assert.rejects(() => chain.complete({
      messages: [{ role: 'user', content: 'hi' }], brain: 'vision',
      attemptTimeoutMs: 5000, signal: ctrl2.signal,
      config: { CHAIN_BREAKERS_ENABLED: true },
    }), (err) => err.name === 'AbortError');
    assert.equal(chain._internal.cooldowns.size, 0, 'still no provider blamed for the caller');
  });

  it('a 400 bad-request is still not a fault, and a 500 still is', async () => {
    stubLane('groq', fails('groq chat failed: 400 bad request'));
    stubLane('mistral', answers('ok'));
    rank([{ provider: 'groq', model: 'g-model' }, { provider: 'mistral', model: 'm-model' }]);
    await walk();
    assert.equal(chain._internal.cooldowns.has('groq:g-model'), false,
      'a 400 means the provider is healthy and the request was wrong');

    chain._internal._resetCooldowns();
    stubLane('groq', fails('groq chat failed: 500 EngineCore encountered an issue'));
    await walk();
    assert.ok(chain._internal.cooldowns.has('groq:g-model'),
      'the measured NIM 500 — this half already worked and must keep working');
  });
});

describe('B1 root cause 2: escalating backoff, because a flat cooldown lapses', () => {
  it('a provider that fails failThreshold times is SKIPPED on the next call', async () => {
    stubLane('nim', hangs());
    stubLane('mistral', answers('ok'));
    rank([{ provider: 'nim', model: 'v-model' }, { provider: 'mistral', model: 'm-model' }]);

    // Two failures at threshold 2 opens the breaker. The cooldown is cleared
    // between walks on purpose — this isolates the BREAKER, since otherwise the
    // 60s cooldown would be doing the skipping and prove nothing.
    await walk();
    chain._internal._resetCooldowns();
    await walk();
    chain._internal._resetCooldowns();

    const { result, attempts } = await walk();
    assert.equal(result.provider, 'mistral');
    const nimAttempt = attempts.find((a) => a.provider === 'nim');
    assert.equal(nimAttempt.skipped, 'breaker-open',
      'the third call must not pay the 4s again — this is the 8s of dead time per look');
    assert.equal(nimAttempt.ms, 0, 'a skipped attempt costs nothing');
  });

  it('the skip is LOGGED, never silent', async () => {
    // The one real hazard in this change. A breaker that silently skips turns a
    // loud 8s failure into an invisible one, and B2 exists precisely because a
    // diagnostic was built and then discarded. Both skip paths report.
    stubLane('nim', hangs());
    stubLane('mistral', answers('ok'));
    rank([{ provider: 'nim', model: 'v-model' }, { provider: 'mistral', model: 'm-model' }]);

    await walk();
    // No cooldown reset this time: the cooldown is what skips here, and it must
    // report too — it used to `continue` in silence.
    const { attempts } = await walk();
    const skipped = attempts.find((a) => a.provider === 'nim');
    assert.ok(skipped, 'a skipped provider must still produce an attempt-end record');
    assert.ok(skipped.skipped === 'cooldown' || skipped.skipped === 'breaker-open',
      'and it must say WHY it was skipped, or the next investigation sees a fast call with no trace '
      + 'that the head of the lane is broken; got ' + JSON.stringify(skipped));
  });

  it('a recovered provider is let back in after the reset delay (HALF_OPEN)', async () => {
    let hanging = true;
    stubLane('nim', (messages, opts) => (hanging ? hangs()(messages, opts) : Promise.resolve('nim is back')));
    stubLane('mistral', answers('ok'));
    rank([{ provider: 'nim', model: 'v-model' }, { provider: 'mistral', model: 'm-model' }]);

    await walk();
    chain._internal._resetCooldowns();
    await walk();
    chain._internal._resetCooldowns();
    assert.equal((await walk()).attempts.find((a) => a.provider === 'nim').skipped, 'breaker-open');

    // BREAKER_RESET_MS is 40 in the harness.
    await new Promise((r) => setTimeout(r, 60));
    hanging = false;
    chain._internal._resetCooldowns();

    const { result } = await walk();
    assert.equal(result.provider, 'nim',
      'HALF_OPEN must give one probe, so a provider that comes back returns to the head of the lane '
      + 'on its own — no hand-edit of lanes.default.js, no restart');
    const breaker = chain._internal.getBreakers().get('nim:v-model');
    assert.equal(breaker.state, 'closed', 'and a successful probe closes the breaker');
  });

  it('a still-broken provider backs off further instead of probing every reset', async () => {
    stubLane('nim', hangs());
    stubLane('mistral', answers('ok'));
    rank([{ provider: 'nim', model: 'v-model' }, { provider: 'mistral', model: 'm-model' }]);

    await walk(); chain._internal._resetCooldowns();
    await walk(); chain._internal._resetCooldowns();
    const breaker = chain._internal.getBreakers().get('nim:v-model');
    const firstResetAt = breaker.stats.resetAt;

    await new Promise((r) => setTimeout(r, 60));
    await walk(); chain._internal._resetCooldowns();   // the HALF_OPEN probe fails
    assert.ok(breaker.stats.resetAt > firstResetAt + 40,
      'a failed probe must double the delay, or an all-day outage is probed every 40ms forever');
  });
});

describe('B1 the breaker is keyed per (provider, model), not per provider', () => {
  it('a dead vision model does not close the same provider\'s text lane', async () => {
    // chain.js serves EVERY lane. Keying on the provider alone would mean one
    // broken vision model taking out that provider's text answers too.
    stubLane('mistral', (messages, opts) => {
      if (opts.model === 'vision-model') return hangs()(messages, opts);
      return Promise.resolve('text answer');
    });
    rank([{ provider: 'mistral', model: 'vision-model' }, { provider: 'mistral', model: 'text-model' }]);

    await walk(); chain._internal._resetCooldowns();
    await walk(); chain._internal._resetCooldowns();

    const { result, attempts } = await walk();
    assert.equal(result.model, 'text-model');
    assert.equal(attempts.find((a) => a.model === 'vision-model').skipped, 'breaker-open');
    assert.equal(attempts.find((a) => a.model === 'text-model').ok, true,
      'the same provider\'s other model must be unaffected');
    assert.equal(chain._internal.getBreakers().has('mistral:text-model'), true);
    assert.equal(chain._internal.getBreakers().get('mistral:text-model').state, 'closed');
  });

  it('a trip does not emit effector-flapping, which would reach the suppress-tool playbook', async () => {
    // healer.js's effector-flapping-breaker playbook runs suppress-tool with
    // tool:'$target'. A brain breaker named "nim:nvidia/nemotron-nano-12b-v2-vl"
    // is not an effector, so sharing that kind would hand a remediation a tool
    // name that does not exist.
    const emitted = [];
    stubLane('nim', hangs());
    stubLane('mistral', answers('ok'));
    rank([{ provider: 'nim', model: 'v-model' }, { provider: 'mistral', model: 'm-model' }]);

    const bus = { emit: (type, payload) => emitted.push({ type, payload }) };
    await walk({ bus }); chain._internal._resetCooldowns();
    await walk({ bus }); chain._internal._resetCooldowns();

    const anomalies = emitted.filter((e) => e.type === 'health.anomaly');
    assert.ok(anomalies.length >= 1, 'a trip must still be announced — it means a provider is down');
    assert.equal(anomalies[0].payload.kind, 'brain-provider-flapping');
    assert.equal(anomalies.some((a) => a.payload.kind === 'effector-flapping'), false,
      'sharing effector-flapping would trigger suppress-tool on a non-existent tool');
    assert.equal(anomalies[0].payload.target, 'nim:v-model', 'and it must name what actually failed');
  });

  it('a missing bus does not throw — skipping a dead provider matters more than announcing it', async () => {
    stubLane('nim', hangs());
    stubLane('mistral', answers('ok'));
    rank([{ provider: 'nim', model: 'v-model' }, { provider: 'mistral', model: 'm-model' }]);
    // createBreaker throws without a bus; the chain must supply a null one.
    await assert.doesNotReject(() => walk());
    await assert.doesNotReject(() => walk());
  });
});

describe('B1 the kill switch, and the Slice-5 construction rule', () => {
  it('with the flag off, no breaker exists at all', async () => {
    stubLane('nim', hangs());
    stubLane('mistral', answers('ok'));
    rank([{ provider: 'nim', model: 'v-model' }, { provider: 'mistral', model: 'm-model' }]);

    await walk({ config: { CHAIN_BREAKERS_ENABLED: false } });
    assert.equal(chain._internal.getBreakers(), null,
      'the Map must be constructed INSIDE the flag check. Slice 5 shipped a subsystem built above '
      + 'the line that read its flag, and the app died for everyone including with the feature off.');
  });

  it('with the flag off, a repeatedly failing provider is still attempted (cooldown aside)', async () => {
    stubLane('nim', hangs());
    stubLane('mistral', answers('ok'));
    rank([{ provider: 'nim', model: 'v-model' }, { provider: 'mistral', model: 'm-model' }]);

    const off = { config: { CHAIN_BREAKERS_ENABLED: false } };
    await walk(off); chain._internal._resetCooldowns();
    await walk(off); chain._internal._resetCooldowns();
    const { attempts } = await walk(off);
    const nimAttempt = attempts.find((a) => a.provider === 'nim');
    assert.equal(nimAttempt.skipped, undefined, 'no breaker skip may happen with the flag off');
    assert.equal(nimAttempt.timedOut, true, 'it pays the timeout again — that is what "off" means');
  });

  it('the flag defaults ON when neither config nor env says otherwise', () => {
    const { breakersEnabledFor } = chain._internal;
    const savedEnv = process.env.CHAIN_BREAKERS_ENABLED;
    delete process.env.CHAIN_BREAKERS_ENABLED;
    try {
      assert.equal(breakersEnabledFor(undefined), true);
      assert.equal(breakersEnabledFor({}), true, 'a config without the key must not read as false');
      assert.equal(breakersEnabledFor({ CHAIN_BREAKERS_ENABLED: false }), false);
      process.env.CHAIN_BREAKERS_ENABLED = 'false';
      assert.equal(breakersEnabledFor(undefined), false, 'env is the kill switch when there is no config');
      assert.equal(breakersEnabledFor({ CHAIN_BREAKERS_ENABLED: true }), true, 'config wins over env');
    } finally {
      if (savedEnv === undefined) delete process.env.CHAIN_BREAKERS_ENABLED;
      else process.env.CHAIN_BREAKERS_ENABLED = savedEnv;
    }
  });

  it('CHAIN_BREAKERS_ENABLED is a real schema key, so it is settable from .env', () => {
    const { SCHEMA } = require('../src/core/config/schema');
    assert.ok(SCHEMA.CHAIN_BREAKERS_ENABLED, 'an undocumented env read is not a kill switch anyone can find');
    assert.equal(SCHEMA.CHAIN_BREAKERS_ENABLED.type, 'boolean');
    assert.equal(SCHEMA.CHAIN_BREAKERS_ENABLED.default, true);
  });

  it('brain/index.js forwards config and bus, or the flag could never arrive', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'brain', 'index.js'), 'utf8');
    const call = src.slice(src.indexOf('chain.complete({'), src.indexOf('chain.complete({') + 900);
    assert.match(call, /\bconfig,/, 'config was never forwarded — CHAIN_COOLDOWN_MS silently fell back too');
    assert.match(call, /\bbus,/, 'and without bus a trip cannot be announced');
  });
});

describe('B1 the stale measurement that caused this is dated now', () => {
  it('lanes.default.js no longer presents the NIM vision entry as the fastest', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'brain', 'lanes.default.js'), 'utf8');
    assert.doesNotMatch(src, /386ms — fastest vision measured/,
      'that comment was true once and then kept a dead provider at the head of the lane for a day');
    const visionBlock = src.slice(src.indexOf('const PREF_VISION'), src.indexOf('const PREF_EMBED'));
    assert.match(visionBlock, /2026-08-14/,
      'a latency number with no date cannot be recognised as stale by the next reader');
  });
});
