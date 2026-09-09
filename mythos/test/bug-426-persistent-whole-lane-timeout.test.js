'use strict';
// BUG-426: Sept 9 replay found six memoryless whole-lane exemptions (nim+nim2).
// Mutation probes 2026-09-10: limit Infinity (3 fails), omit success reset (1),
// omit 429 reset (1), omit late-loaded env (1). Absolute copy + matching SHA256 restored each.
// Accepted: a real shared outage can bench hot pairs for 60s after recovery.
const { it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const chain = require('../src/core/brain/chain');
const registry = require('../src/core/brain/registry');
const health = require('../src/core/brain/provider-health');
const savedRank = registry.chainFor;
const saved = Object.fromEntries(['mistral', 'google'].map(p => [p, { ...chain._internal.LANES[p] }]));
const hangs = (_m, { signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
const pair = [{ provider: 'mistral', model: 'A' }, { provider: 'google', model: 'B' }];
const events = [];
async function walk() {
  return chain.complete({ brain: 'reasoning', messages: [], attemptTimeoutMs: 5,
    config: { BREAKER_FAIL_THRESHOLD: 1, CHAIN_BREAKERS_ENABLED: true },
    bus: { emit: (type, data) => events.push({ type, data }) } });
}
beforeEach(() => {
  chain._internal._resetCooldowns(); chain._internal._resetBreakers(); health._reset();
  if (chain._internal.wholeLaneTimeoutStreaks) chain._internal.wholeLaneTimeoutStreaks.clear();
  registry.chainFor = async () => pair;
  for (const p of Object.keys(saved)) Object.assign(chain._internal.LANES[p], { isAvailable: () => true, chat: hangs });
  events.length = 0;
});
after(() => { registry.chainFor = savedRank; for (const p of Object.keys(saved)) Object.assign(chain._internal.LANES[p], saved[p]); });
it('walks 1 and 2 preserve C3; walk 3 cools both and trips their breakers', async () => {
  for (let n = 0; n < 2; n++) { await assert.rejects(walk); assert.equal(chain._internal.cooldowns.size, 0); }
  await assert.rejects(walk);
  assert.equal(chain._internal.cooldowns.size, 2);
  for (const breaker of chain._internal.getBreakers().values()) assert.equal(breaker.state, 'open');
  const rows = events.filter(e => e.data.kind === 'chain-whole-lane-timeout');
  assert.equal(rows.length, 2, 'no exemption anomaly once every pair is cooled');
  assert.equal(rows[0].data.forcedCooldowns, 0);
});
it('a success mid-streak resets that pair', async () => {
  await assert.rejects(walk); await assert.rejects(walk);
  registry.chainFor = async () => [pair[0]];
  chain._internal.LANES.mistral.chat = async () => 'answer';
  await walk();
  registry.chainFor = async () => pair; chain._internal.LANES.mistral.chat = hangs;
  await assert.rejects(walk);
  assert.equal(chain._internal.cooldowns.has('mistral:A'), false);
  assert.equal(chain._internal.cooldowns.has('google:B'), true);
  assert.equal(events.filter(e => e.data.kind === 'chain-whole-lane-timeout').at(-1).data.forcedCooldowns, 1);
});
it('429 mid-streak resets only the failing pair', async () => {
  await assert.rejects(walk); await assert.rejects(walk);
  registry.chainFor = async () => [pair[0]];
  chain._internal.LANES.mistral.chat = async () => { throw Object.assign(new Error('rate limit'), { status: 429 }); };
  await assert.rejects(walk);
  chain._internal.cooldowns.clear(); chain._internal._resetBreakers();
  registry.chainFor = async () => pair; chain._internal.LANES.mistral.chat = hangs;
  await assert.rejects(walk);
  assert.equal(chain._internal.cooldowns.has('mistral:A'), false);
  assert.equal(chain._internal.cooldowns.has('google:B'), true);
});
it('the env kill switch works when loaded after imports, matching main boot order', async () => {
  const previous = process.env.CHAIN_WHOLE_LANE_TIMEOUT_STREAK_LIMIT;
  try {
    process.env.CHAIN_WHOLE_LANE_TIMEOUT_STREAK_LIMIT = 'Infinity';
    for (let n = 0; n < 4; n++) await assert.rejects(walk);
    assert.equal(chain._internal.cooldowns.size, 0);
  } finally { if (previous === undefined) delete process.env.CHAIN_WHOLE_LANE_TIMEOUT_STREAK_LIMIT; else process.env.CHAIN_WHOLE_LANE_TIMEOUT_STREAK_LIMIT = previous; }
});
