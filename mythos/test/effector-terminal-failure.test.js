'use strict';

// F1 (2026-08-15) — a terminal effector failure must not be retried and must not
// pin the HUD to DEGRADED.
//
// Measured: gmail_unread failed 5x between 21:03 and 21:30 with `invalid_grant`,
// tripped the effector-flapping breaker at 21:11:22, served its 60s suppression,
// was dispatched again at 21:30:52 and failed identically. core-orb.js:832 reads
// DEGRADED from `state !== 'closed'` over every breaker, so the badge was pinned
// for the whole session and named no cause.

const test = require('node:test');
const assert = require('node:assert');

const { createEffectorHub } = require('../src/core/effectors/hub');

function fakeBus() {
  const events = [];
  return { emit: (type, payload) => events.push({ type, payload }), events };
}

function hubWith(effectorResult) {
  const bus = fakeBus();
  const hub = createEffectorHub({ bus, config: {} });
  let calls = 0;
  hub.register({
    id: 'gmail_unread',
    invoke: async () => { calls++; return effectorResult; },
  });
  return { hub, bus, calls: () => calls };
}

const TERMINAL = {
  ok: false,
  terminal: true,
  result: { error: 'Gmail fetch failed: invalid_grant — needs re-authorising by running `node scripts/google-auth.js`.' },
};

test('a terminal failure is dispatched exactly once', async () => {
  const { hub, calls } = hubWith(TERMINAL);
  await hub.invoke('gmail_unread', {});
  await hub.invoke('gmail_unread', {});
  await hub.invoke('gmail_unread', {});
  assert.strictEqual(calls(), 1, 'the provider must not be called again after a terminal failure');
});

test('later calls still carry the remedy text, not a bare refusal', async () => {
  const { hub } = hubWith(TERMINAL);
  await hub.invoke('gmail_unread', {});
  const second = await hub.invoke('gmail_unread', {});
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.terminal, true);
  assert.match(String(second.result), /google-auth/,
    'the stored reason must name the actual remedy — a bare "circuit-open" tells the operator nothing');
});

test('a terminal failure leaves the breaker CLOSED so the HUD is not pinned to DEGRADED', async () => {
  const { hub } = hubWith(TERMINAL);
  for (let i = 0; i < 6; i++) await hub.invoke('gmail_unread', {});
  const breaker = hub.breakers.get('gmail_unread');
  assert.strictEqual(breaker.state, 'closed',
    'a non-closed breaker is what core-orb.js reads as DEGRADED; a tool that will never be '
    + 'retried must not report itself as flapping');
});

test('a terminal failure announces once, with the reason', async () => {
  const { hub, bus } = hubWith(TERMINAL);
  await hub.invoke('gmail_unread', {});
  await hub.invoke('gmail_unread', {});
  const terminals = bus.events.filter((e) => e.payload && e.payload.kind === 'effector-terminal');
  assert.strictEqual(terminals.length, 1, 'exactly one announcement, not one per call');
  assert.strictEqual(terminals[0].payload.target, 'gmail_unread');
  assert.match(String(terminals[0].payload.reason), /invalid_grant/);
});

test('an ORDINARY failure is unaffected — it still trips the breaker', async () => {
  const { hub, calls } = hubWith({ ok: false, result: 'network timeout' });
  for (let i = 0; i < 3; i++) await hub.invoke('gmail_unread', {});
  assert.strictEqual(calls(), 3, 'transient failures must keep being retried up to the threshold');
  assert.strictEqual(hub.breakers.get('gmail_unread').state, 'open',
    'the flapping path must still work — terminal handling is additive, not a replacement');
});

test('a success is unaffected', async () => {
  const { hub } = hubWith({ ok: true, result: { count: 3 } });
  const r = await hub.invoke('gmail_unread', {});
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(hub.terminalFailures(), {});
});

test('terminalFailures() reports what is disabled and why', async () => {
  const { hub } = hubWith(TERMINAL);
  await hub.invoke('gmail_unread', {});
  const dead = hub.terminalFailures();
  assert.ok(dead.gmail_unread, 'the disabled tool must be nameable');
  assert.match(dead.gmail_unread.reason, /invalid_grant/);
});

test('gmail flags invalid_grant as terminal', () => {
  const { gmailFailure } = require('../src/core/effectors/from-gmail');
  const out = gmailFailure('Gmail fetch failed', new Error('invalid_grant: Token has been expired or revoked.'));
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.terminal, true);
  assert.match(out.result.error, /google-auth/, 'must name the remedy');
});

test('gmail flags an isAuthError-tagged failure as terminal', () => {
  const { gmailFailure } = require('../src/core/effectors/from-gmail');
  const err = new Error('Request failed');
  err.isAuthError = true;
  assert.strictEqual(gmailFailure('Gmail fetch failed', err).terminal, true);
});

test('gmail does NOT flag a transient failure as terminal', () => {
  // rules/core.md §11.1 — the risk of this classifier is over-reach. A network
  // timeout, a 500, and a rate limit must all stay retryable, or one bad minute
  // kills the tool for the session.
  const { gmailFailure } = require('../src/core/effectors/from-gmail');
  for (const msg of ['ETIMEDOUT', 'socket hang up', 'Rate Limit Exceeded', '503 Service Unavailable', 'Request failed with status 403']) {
    const out = gmailFailure('Gmail fetch failed', new Error(msg));
    assert.notStrictEqual(out.terminal, true, msg + ' must NOT be classified terminal');
  }
});
