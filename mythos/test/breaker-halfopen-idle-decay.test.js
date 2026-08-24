'use strict';

// BUG-338 (2026-08-24): a breaker that reached HALF_OPEN and then saw no
// traffic stayed HALF_OPEN forever — recordSuccess() is the only traffic-
// driven path back to CLOSED, and a tool nobody calls again never takes it.
// The HUD's core-orb derives "ENTITY DEGRADED" from `some(b => b.state !==
// 'closed')`, so one transient trip pinned the whole entity as degraded for
// the rest of the session (vault: gmail_unread's invalid_grant incident,
// hub.js's own comment records the same shape for terminal failures).
//
// Fix under test: HALF_OPEN decays to CLOSED after 30 minutes of idleness,
// lazily on read (stats getter) — no timer needed, because the only consumer
// that matters IS the reader. The decay is cosmetic-safe by construction: if
// the tool is still broken, the next real call re-trips it through the normal
// FSM, which is exactly what a probe would have done.

const test = require('node:test');
const assert = require('node:assert');

const { createBreaker } = require('../src/core/immune/breakers.js');

const NULL_BUS = { emit() {} };
const CFG = { BREAKER_FAIL_THRESHOLD: 2, BREAKER_WINDOW_MS: 30000, BREAKER_RESET_MS: 10 };

function makeBreaker(overrides) {
  return createBreaker(Object.assign({ name: 'test-tool', bus: NULL_BUS, config: CFG }, overrides));
}

async function tripToHalfOpen(breaker) {
  // OPEN: failThreshold failures inside the window...
  breaker.recordFailure(); breaker.recordFailure();
  assert.strictEqual(breaker.state, 'open');
  // ...then allow() past resetAt flips it to HALF_OPEN. RESET_MS is 10ms in
  // this fixture, so actually let it elapse — allow() called too early is
  // correctly refused, and the refusal looks exactly like a broken breaker.
  await new Promise((resolve) => setTimeout(resolve, 15));
  const admitted = breaker.allow();
  assert.strictEqual(admitted, true, 'probe must be admitted once resetAt has passed');
  assert.strictEqual(breaker.state, 'half-open');
}

test('a HALF_OPEN breaker with no traffic reports closed after the idle window', async () => {
  const breaker = makeBreaker({ halfOpenIdleDecayMs: 50 });
  await tripToHalfOpen(breaker);

  const before = breaker.stats;
  assert.strictEqual(before.state, 'half-open', 'sanity: still half-open immediately after tripping');

  const t0 = Date.now();
  const after = breaker.statsAt(t0 + 60); // read the future: 60ms idle > 50ms window
  assert.strictEqual(after.state, 'closed', 'idle HALF_OPEN must decay to CLOSED on read');
  assert.strictEqual(after.decayReason, 'half-open-idle-decay');
});

test('before the idle window elapses, HALF_OPEN stays HALF_OPEN', async () => {
  const breaker = makeBreaker({ halfOpenIdleDecayMs: 60000 });
  await tripToHalfOpen(breaker);
  const stats = breaker.statsAt(Date.now() + 1000);
  assert.strictEqual(stats.state, 'half-open', 'must not decay early — a pending probe is still meaningful');
});

test('decay does not mask a still-broken tool: next failure re-trips normally', async () => {
  const breaker = makeBreaker({ halfOpenIdleDecayMs: 50 });
  await tripToHalfOpen(breaker);
  breaker.statsAt(Date.now() + 60);
  assert.strictEqual(breaker.state, 'closed');

  breaker.recordFailure(); breaker.recordFailure();
  assert.strictEqual(breaker.state, 'open', 'a decayed breaker must trip again like any other');
});

test('stats carries name and since so the HUD can say WHICH circuit and when', async () => {
  const breaker = makeBreaker({});
  await tripToHalfOpen(breaker);
  const stats = breaker.stats;
  assert.strictEqual(stats.name, 'test-tool');
  assert.ok(typeof stats.since === 'number' && stats.since > 0, 'since (last state transition) missing from stats');
});
