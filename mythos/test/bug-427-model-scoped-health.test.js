'use strict';
// BUG-420/427: Sept 9 mistral-large-2512 403 did not invalidate working siblings.
// Accepted: a suspended account returning 403 costs one attempt per model.
// Mutation probes 2026-09-10: sibling-wide clear (2 fails), no TTL (2),
// no late-loaded env (1), no anomaly dedupe (1), no registry gate (2), no chain recorder (1),
// family-wide NIM bench (1), missing concrete NIM pair gate (2). All fired;
// each source restored by absolute-path byte copy with matching SHA256.
const { it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const health = require('../src/core/brain/provider-health');
const registry = require('../src/core/brain/registry');
beforeEach(() => health._reset());

it('403 benches only model A; a sibling success cannot erase its refusal', () => {
  health.recordModelFailure('mistral', 'A', { status: 403 });
  health.recordFailure('mistral', { status: 403 });
  assert.equal(health.failureFor('mistral'), null);
  assert.equal(registry._internal.isProviderAlive('mistral', 'A', { mistralAlive: true }), false);
  assert.equal(registry._internal.isProviderAlive('mistral', 'B', { mistralAlive: true }), true);
  health.recordModelSuccess('mistral', 'B');
  assert.ok(health.modelFailureFor('mistral', 'A'));
  health.recordModelSuccess('mistral', 'A');
  assert.equal(health.modelFailureFor('mistral', 'A'), null);
});
it('404 outranks a catalog listing and expires exactly at its own TTL', () => {
  const t0 = Date.now();
  health.recordModelFailure('mistral', 'A', { status: 404 }, t0);
  assert.equal(registry._internal.isProviderAlive('mistral', 'A', { mistralAlive: true }), false);
  assert.ok(health.modelFailureFor('mistral', 'A', t0 + health.MODEL_HEALTH_TTL_MS - 1));
  assert.equal(health.modelFailureFor('mistral', 'A', t0 + health.MODEL_HEALTH_TTL_MS), null);
});
it('401 and 402 still exclude every model; transient errors never bench one', () => {
  for (const status of [401, 402]) {
    health.recordFailure('mistral', { status });
    for (const model of ['A', 'B']) assert.equal(registry._internal.isProviderAlive('mistral', model, { mistralAlive: true }), false);
    health._reset();
  }
  for (const status of [400, 401, 402, 429, 500, 503]) assert.equal(health.recordModelFailure('mistral', 'A', { status }), null);
});
it('model bench anomaly fires once per active pair and status exposes the refusal', async () => {
  const events = [], bus = { emit: (type, data) => events.push({ type, data }) };
  for (let n = 0; n < 2; n++) health.recordModelFailure('mistral', 'A', { status: 403 }, undefined, bus);
  health.recordModelFailure('mistral', 'B', { status: 404 }, undefined, bus);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].data, { kind: 'model-benched', provider: 'mistral', model: 'A', status: 403 });
  assert.equal(health.modelSnapshot()['mistral:A'].status, 403);
  assert.equal((await registry.getStatus()).modelFailures['mistral:B'].status, 404);
});
it('chain records the real refusal, and a successful sibling clears only itself', async () => {
  const chain = require('../src/core/brain/chain');
  const provider = chain._internal.LANES.mistral;
  const saved = { ...provider }, savedRank = registry.chainFor;
  try {
    registry.chainFor = async () => [{ provider: 'mistral', model: 'A' }, { provider: 'mistral', model: 'B' }];
    provider.isAvailable = () => true;
    provider.chat = async (_messages, options) => {
      if (options.model === 'A') throw Object.assign(new Error('forbidden'), { status: 403 });
      return 'answer';
    };
    assert.equal((await chain.complete({ messages: [] })).model, 'B');
    assert.ok(health.modelFailureFor('mistral', 'A'));
    assert.equal(health.failureFor('mistral'), null);
  } finally { registry.chainFor = savedRank; Object.assign(provider, saved); }
});
it('model bench kill switch leaves catalog-backed availability untouched', () => {
  const previous = process.env.PROVIDER_MODEL_HEALTH_ENABLED;
  try {
    health.recordModelFailure('mistral', 'A', { status: 403 });
    process.env.PROVIDER_MODEL_HEALTH_ENABLED = 'false';
    assert.equal(health.recordModelFailure('mistral', 'B', { status: 404 }), null);
    assert.equal(registry._internal.isProviderAlive('mistral', 'A', { mistralAlive: true }), true);
  } finally { if (previous === undefined) delete process.env.PROVIDER_MODEL_HEALTH_ENABLED; else process.env.PROVIDER_MODEL_HEALTH_ENABLED = previous; }
});
it('model TTL set after require is honored, as main loads .env after imports', () => {
  const previous = process.env.PROVIDER_MODEL_HEALTH_TTL_MS;
  try {
    process.env.PROVIDER_MODEL_HEALTH_TTL_MS = '7';
    health.recordModelFailure('mistral', 'A', { status: 403 }, 1000);
    assert.ok(health.modelFailureFor('mistral', 'A', 1006));
    assert.equal(health.modelFailureFor('mistral', 'A', 1007), null);
  } finally { if (previous === undefined) delete process.env.PROVIDER_MODEL_HEALTH_TTL_MS; else process.env.PROVIDER_MODEL_HEALTH_TTL_MS = previous; }
});

for (const refused of ['nim', 'nim2']) it(`NIM key rotation excludes only ${refused}'s refused model and restores both at TTL`, async () => {
  const chain = require('../src/core/brain/chain'), lanes = chain._internal.LANES;
  const saved = { nim: { ...lanes.nim }, nim2: { ...lanes.nim2 }, mistral: { ...lanes.mistral } };
  const savedRank = registry.chainFor, savedNow = Date.now;
  const keys = ['NIM_API_KEY', 'NIM_API_KEY_2'], prior = keys.map(key => process.env[key]);
  let now = 1000;
  const calls = [], cache = { nimModels: ['A'], mistralAlive: true };
  try {
    Date.now = () => now;
    keys.forEach(key => { process.env[key] = 'fake-local-test-key'; });
    registry.chainFor = async () => [
      ...(registry._internal.isProviderAlive('nim', 'A', cache) ? [{ provider: 'nim', model: 'A' }] : []),
      { provider: 'mistral', model: 'fallback' },
    ];
    for (const id of ['nim', 'nim2', 'mistral']) {
      lanes[id].isAvailable = () => true;
      lanes[id].chat = async () => {
        calls.push(id);
        if (id !== 'mistral') throw Object.assign(new Error('temporary outage'), { status: 502 });
        return 'answer';
      };
    }
    health.recordModelFailure(refused, 'A', { status: 403 });
    await chain.complete({ messages: [] });
    assert.deepEqual(calls, [refused === 'nim' ? 'nim2' : 'nim', 'mistral']);
    health.recordModelFailure(refused === 'nim' ? 'nim2' : 'nim', 'A', { status: 404 });
    chain._internal._resetCooldowns(); calls.length = 0;
    await chain.complete({ messages: [] });
    assert.deepEqual(calls, ['mistral'], 'both refused pairs leave the catalog lane');
    now += health.MODEL_HEALTH_TTL_MS;
    chain._internal._resetCooldowns(); calls.length = 0;
    await chain.complete({ messages: [] });
    assert.deepEqual(calls, ['nim', 'nim2', 'mistral'], 'each expired key/model pair becomes eligible again');
  } finally {
    registry.chainFor = savedRank; Date.now = savedNow;
    for (const id of Object.keys(saved)) Object.assign(lanes[id], saved[id]);
    keys.forEach((key, i) => { if (prior[i] === undefined) delete process.env[key]; else process.env[key] = prior[i]; });
    chain._internal._resetCooldowns(); health._reset();
  }
});
