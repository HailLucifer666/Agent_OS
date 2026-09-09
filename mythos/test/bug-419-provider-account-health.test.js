'use strict';

// bug-419-provider-account-health.test.js — BUG-419.
//
// MEASURED LIVE ON THIS MACHINE 2026-09-09, before writing anything:
//
//   registry.getStatus() -> cerebras: { configured: true, aliveModels: 3 }
//   chainFor('build')    -> [...mistral x3, { cerebras, gpt-oss-120b }]
//   chainFor('simple')   -> [...,          { cerebras, gemma-4-31b  }]
//
// Cerebras answers `402 Payment required` on every completion from this
// unbilled account. Nine dated comments in lanes.default.js say so. The
// registry still called it ALIVE, so it held the last cloud rung of every lane
// and every exhausted fallback walked into it.
//
// WHY NOTHING CAUGHT IT, and it is three separate failures stacked:
//
//  1. GATE E. `probeCerebras()` fetches `/models`. A catalog listing is free
//     and answers 200 on an unbilled account; the 402 only comes back from
//     `/chat/completions`. The liveness probe asked the cheaper question
//     standing next to the one that mattered — the same shape as GATES.md's
//     `createPublicKey()` case.
//  2. 402 WAS NOT CLASSIFIED AT ALL. chain.js's classifyProviderError knows
//     429, 5xx and network. A 402 fell through every arm, so no cooldown and no
//     breaker tick were taken and the provider was retried on every single call.
//  3. /KEE CLASS 10 — THE CONFIDENT COMMENT THAT IS WRONG. chain.js said "Auth
//     failures (401/403) won't recover in 60s — let isAvailable() handle them."
//     isAvailable() is chainFor('text').length > 0, which resolves through the
//     same catalog probe. Nothing handled them anywhere. That sentence is why
//     nine dated comments never turned into a fix.
//
// THE BOUNDARY IS THE DESIGN, so it is tested from both sides. 401/402/403 are
// facts about the ACCOUNT and do not clear on their own. 429 and 5xx are facts
// about the MOMENT and are already handled by chain.js's cooldown and breaker —
// recording one here would remove a working rung from every lane for fifteen
// minutes over a quota that resets in one.
//
// MUTATION PROBES, run 2026-09-09 across provider-health.js and registry.js.
// All five confirmed landed before running, all five fired, no survivors; both
// sources restored by byte copy with matching sha256. Counts are the measured
// ones, not the predicted ones:
//   (m1) ACCOUNT_STATUSES gains 429
//        -> 3 fails, led by (b). Also takes the no-op-recording test and the
//           rate-limited-provider-stays-alive test, which is the point: one
//           wrong entry in that list reaches the lane.
//   (m2) the prose anchor drops its colon, becoming a bare number match
//        -> 1 fail: (c) "a number inside a model id is not a status"
//   (m3) recordSuccess stops deleting the entry
//        -> 3 fails: (d), the per-provider isolation test, and the
//           returns-the-moment-a-call-succeeds test in the lane suite
//   (m4) isProviderAlive stops consulting providerHealth
//        -> 2 fails: (e) and its recovery case
//   (m5) failureFor stops expiring entries
//        -> 1 fail: (f) "the verdict expires on its own"

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const providerHealth = require('../src/core/brain/provider-health');
const registry = require('../src/core/brain/registry');

beforeEach(() => providerHealth._reset());

describe('BUG-419 (a,b,c) — only an ACCOUNT refusal counts, and only when it really is one', () => {
  it('(a) reads a typed status and the prose fallback the same way', () => {
    assert.equal(providerHealth.accountStatusOf({ status: 402 }), 402);
    assert.equal(providerHealth.accountStatusOf({ status: 401 }), 401);
    assert.equal(providerHealth.accountStatusOf({ status: 403 }), 403);
    // BUG-336 attached typed statuses at the openai-compat/ollama/openrouter
    // throw sites, but not every provider is re-pointed, so prose still has to
    // work — in the same `: <code>` shape classifyProviderError already uses.
    assert.equal(providerHealth.accountStatusOf({ message: 'Cerebras error: 402 Payment Required' }), 402);
    assert.equal(providerHealth.accountStatusOf({ message: 'groq: 401 invalid api key' }), 401);
  });

  it('(b) a rate limit or an outage is never an account failure', () => {
    // (m1). THE ADJACENT CASE THAT MUST KEEP PASSING. A 429 clears by itself in
    // seconds; holding the provider down for fifteen minutes would delete a
    // working rung from every lane, which is a worse bug than the one being
    // fixed.
    for (const err of [{ status: 429 }, { status: 500 }, { status: 503 }, { status: 400 }, { status: 404 }]) {
      assert.equal(providerHealth.accountStatusOf(err), null,
        'status ' + err.status + ' is about the moment, not the account');
    }
    assert.equal(providerHealth.accountStatusOf({ message: 'groq: 429 rate limit exceeded' }), null);
    assert.equal(providerHealth.accountStatusOf({ message: 'fetch failed' }), null);
    assert.equal(providerHealth.accountStatusOf(null), null);
    assert.equal(providerHealth.accountStatusOf(undefined), null);
  });

  it('(c) a number that happens to contain 402 is not a status', () => {
    // (m2). A bare /402/ would match all of these. A provider wrongly held down
    // is worse than one wrongly kept, so the anchor stays.
    assert.equal(providerHealth.accountStatusOf({ message: 'model gpt-402x is unavailable' }), null);
    assert.equal(providerHealth.accountStatusOf({ message: 'completed in 402ms' }), null);
    assert.equal(providerHealth.accountStatusOf({ message: 'used 1402 tokens' }), null);
  });

  it('a non-account error is not recorded at all, rather than recorded as unknown', () => {
    // A present entry MEANS unusable. Storing a 429 with a null status would let
    // the presence check take a healthy provider out.
    assert.equal(providerHealth.recordFailure('groq', { status: 429 }), null);
    assert.equal(providerHealth.failureFor('groq'), null);
    assert.deepEqual(providerHealth.snapshot(), {});
  });
});

describe('BUG-419 (d,f) — the verdict clears, both ways', () => {
  it('(d) a success clears the verdict immediately, not on the next TTL', () => {
    // (m3). An operator who has just added billing must not wait fifteen
    // minutes, and a real completion is proof the account is fine.
    providerHealth.recordFailure('cerebras', { status: 402, message: 'Payment Required' });
    assert.ok(providerHealth.failureFor('cerebras'));
    providerHealth.recordSuccess('cerebras');
    assert.equal(providerHealth.failureFor('cerebras'), null);
    assert.deepEqual(providerHealth.snapshot(), {});
  });

  it('(f) the verdict expires on its own, so a broken recorder degrades to today', () => {
    // (m5). Expiry is applied on READ so nothing has to run a timer. If
    // recordSuccess ever stops firing, this is what stops a provider being
    // removed forever.
    const t0 = 1_000_000;
    providerHealth.recordFailure('cerebras', { status: 402 }, t0);
    assert.ok(providerHealth.failureFor('cerebras', t0 + 1000), 'still live a second later');
    assert.ok(providerHealth.failureFor('cerebras', t0 + providerHealth.HEALTH_TTL_MS - 1));
    assert.equal(providerHealth.failureFor('cerebras', t0 + providerHealth.HEALTH_TTL_MS), null,
      'expired exactly at the TTL, not one tick after');
  });

  it('a success for one provider does not clear another', () => {
    providerHealth.recordFailure('cerebras', { status: 402 });
    providerHealth.recordFailure('zcode', { status: 401 });
    providerHealth.recordSuccess('cerebras');
    assert.equal(providerHealth.failureFor('cerebras'), null);
    assert.ok(providerHealth.failureFor('zcode'), 'zcode said nothing, so its verdict stands');
  });
});

describe('BUG-419 (e) — a refusing account leaves the lane', () => {
  const cache = {
    nimModels: [], ollamaModels: [], groqAlive: true, mistralAlive: true,
    cerebrasModels: ['gpt-oss-120b', 'gemma-4-31b'], googleModels: [], openrouterAlive: true,
  };
  const alive = registry._internal.isProviderAlive;

  it('(e) the catalog says yes and the account says no, and the account wins', () => {
    // (m4). This is the measured state: aliveModels 3, every completion 402.
    process.env.CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY || 'test-key';
    assert.equal(alive('cerebras', 'gpt-oss-120b', cache), true,
      'precondition: the catalog probe lists it, which is what made this invisible');
    providerHealth.recordFailure('cerebras', { status: 402, message: 'Payment Required' });
    assert.equal(alive('cerebras', 'gpt-oss-120b', cache), false,
      'a real completion refused; the free catalog listing does not outrank that');
  });

  it('a rate-limited provider stays in the lane', () => {
    // The false-positive half of (e). Recording a 429 is a no-op by design, so
    // groq must still be alive after one.
    providerHealth.recordFailure('groq', { status: 429, message: 'rate limit' });
    assert.equal(alive('groq', 'anything', cache), true,
      'a quota that resets in a minute must not remove a working rung');
  });

  it('and returns the moment a call succeeds', () => {
    process.env.CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY || 'test-key';
    providerHealth.recordFailure('cerebras', { status: 402 });
    assert.equal(alive('cerebras', 'gemma-4-31b', cache), false);
    providerHealth.recordSuccess('cerebras');
    assert.equal(alive('cerebras', 'gemma-4-31b', cache), true, 'no restart, no hand-edit');
  });
});

describe('BUG-419 — the operator can finally be told', () => {
  it('the snapshot carries a spoken reason, not just a status code', () => {
    // The whole ticket is that nine source comments recorded the 402 and nothing
    // MYTHOS could say out loud did. read_status returns probes.getStatus(),
    // which returns registry.getStatus(), which carries this.
    providerHealth.recordFailure('cerebras', { status: 402, message: 'Payment Required' });
    const snap = providerHealth.snapshot();
    assert.equal(snap.cerebras.status, 402);
    assert.match(snap.cerebras.reason, /402 Payment Required/);
    assert.match(snap.cerebras.reason, /no billing/, 'name the cause, not the code');
    assert.match(snap.cerebras.reason, /Add billing, or remove it from the lane tables/,
      'and the remedy, in the failure itself — the pattern this codebase already proves works');
  });

  it('each status gets its own remedy, because they need different actions', () => {
    providerHealth.recordFailure('groq', { status: 401 });
    providerHealth.recordFailure('nim', { status: 403 });
    const snap = providerHealth.snapshot();
    assert.match(snap.groq.reason, /\.env\.example/, '401 is a key problem, so point at the key');
    assert.match(snap.nim.reason, /plan or region/, '403 is a permission problem, not a missing key');
  });

  it('healthy is an empty object, which reads as healthy', () => {
    assert.deepEqual(providerHealth.snapshot(), {},
      'a null or a sentinel string would have to be interpreted; an empty object does not');
  });

  it('registry.getStatus surfaces it, so read_status does too with no change there', async () => {
    providerHealth.recordFailure('cerebras', { status: 402, message: 'Payment Required' });
    const status = await registry.getStatus();
    assert.ok(status.accountFailures, 'the field must exist even when empty');
    assert.equal(status.accountFailures.cerebras.status, 402);
    // And the field it contradicts is still reported, deliberately: "the catalog
    // lists three models AND the account refuses" is the full truth, and hiding
    // the first half would make the contradiction unreadable.
    assert.ok(Object.prototype.hasOwnProperty.call(status.cerebras, 'aliveModels'));
  });
});
