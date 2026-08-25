'use strict';

// test/leash-confirm-expiry.test.js — Wave 1 (2026-08-13). A T3+ confirm that
// nobody answers used to vanish silently once its TTL passed: only the
// opportunistic sweep in create() ever removed it, with no audit row, no
// anomaly, and no signal to whatever was waiting on the outcome (a Live
// session that asked "operator, can I send this?" and never heard back). The
// 2026-08-12/13 session's gmail_send confirm — 1 created, 0 completed, no
// trace anywhere of why — is exactly this gap. A per-entry timer now makes
// expiry an EVENT: audit decision:'deny' reason:'confirm-ttl-expired',
// health.anomaly kind:'confirm-expired-silently', and a routable
// 'confirm-expired' bus event server/index.js uses to tell the specific Live
// session EXPIRED rather than a bare, indistinguishable DECLINED.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createConfirmRegistry } = require('../src/core/leash/confirm');
const { createLeash } = require('../src/core/leash');

function fakeBus() {
  const { createBus } = require('../src/core/bus');
  return createBus({ historySize: 100 });
}

function fakeConfig(overrides) {
  return Object.assign({ AUTONOMOUS_MAX_TIER: 2, MYTHOS_DRY_RUN: false, LEASH_CONFIRM_TTL_MS: 1000 }, overrides);
}

function noopIdentity() {
  return { checkBoundary: () => null, getMaxAutonomousTier: () => 4 };
}

function noopEffectors() {
  return { get: () => undefined };
}

function recordingAuditWriter() {
  const writes = [];
  return { write: (entry) => { writes.push(entry); return { ok: true }; }, _writes: () => writes };
}

describe('leash/confirm.js — per-entry expiry timer', () => {
  it('fires onExpire exactly once, after the real TTL, and removes the entry', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fired = [];
    const registry = createConfirmRegistry({
      config: fakeConfig({ LEASH_CONFIRM_TTL_MS: 500 }),
      onExpire: (id, entry) => fired.push({ id, entry }),
    });
    const confirmId = registry.create('send the email', { tool: 'gmail_send', args: {} }, 'conn-A');

    t.mock.timers.tick(499);
    assert.equal(fired.length, 0, 'must not fire before the real TTL');
    t.mock.timers.tick(1);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].id, confirmId);
    assert.equal(fired[0].entry.action.tool, 'gmail_send');
    assert.equal(registry.peek(confirmId), null, 'the entry must be gone once expired');
  });

  it('accept() before the TTL cancels the timer — onExpire never fires', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fired = [];
    const registry = createConfirmRegistry({
      config: fakeConfig({ LEASH_CONFIRM_TTL_MS: 500 }),
      onExpire: () => fired.push(true),
    });
    const confirmId = registry.create('send the email', { tool: 'gmail_send', args: {} }, 'conn-A');
    registry.accept(confirmId, 'conn-A');

    t.mock.timers.tick(1000);
    assert.equal(fired.length, 0, 'a resolved confirm must never also report as expired');
  });

  it('reject() before the TTL also cancels the timer', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fired = [];
    const registry = createConfirmRegistry({
      config: fakeConfig({ LEASH_CONFIRM_TTL_MS: 500 }),
      onExpire: () => fired.push(true),
    });
    const confirmId = registry.create('send the email', { tool: 'gmail_send', args: {} }, 'conn-A');
    registry.reject(confirmId, 'conn-A');

    t.mock.timers.tick(1000);
    assert.equal(fired.length, 0);
  });

  it('a throwing onExpire never leaves the entry stuck — it is still removed', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const registry = createConfirmRegistry({
      config: fakeConfig({ LEASH_CONFIRM_TTL_MS: 500 }),
      onExpire: () => { throw new Error('boom'); },
    });
    const confirmId = registry.create('send the email', { tool: 'gmail_send', args: {} }, 'conn-A');
    assert.doesNotThrow(() => t.mock.timers.tick(500));
    assert.equal(registry.peek(confirmId), null);
  });
});

describe('leash/index.js — confirm expiry is loud, not silent', () => {
  it('writes an audit deny row and emits both health.anomaly and confirm-expired on the bus', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const bus = fakeBus();
    const anomalies = [];
    const expiredEvents = [];
    bus.subscribe('health.anomaly', (e) => anomalies.push(e.payload));
    bus.subscribe('confirm-expired', (e) => expiredEvents.push(e.payload));
    const auditWriter = recordingAuditWriter();

    const leash = createLeash({
      bus, config: fakeConfig({ LEASH_CONFIRM_TTL_MS: 500 }),
      identity: noopIdentity(), auditWriter, goals: { get: () => null }, effectors: noopEffectors(),
    });
    const confirmId = leash.confirm.create('send the email', { tool: 'gmail_send', args: {} }, 'conn-A');

    t.mock.timers.tick(500);

    const deny = auditWriter._writes().find((w) => w.reason === 'confirm-ttl-expired');
    assert.ok(deny, 'must write an audit row for the expiry');
    assert.equal(deny.decision, 'deny');
    assert.equal(deny.tool, 'gmail_send');
    assert.equal(deny.confirmId, confirmId);

    assert.equal(anomalies.length, 1);
    assert.equal(anomalies[0].kind, 'confirm-expired-silently');
    assert.equal(anomalies[0].target, 'gmail_send');

    assert.equal(expiredEvents.length, 1);
    assert.equal(expiredEvents[0].confirmId, confirmId);
    assert.equal(expiredEvents[0].connectionId, 'conn-A', 'the routable event must carry which connection raised it');
  });

  it('a confirm that IS answered before its TTL never triggers any of the expiry side-effects', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const bus = fakeBus();
    const anomalies = [];
    bus.subscribe('health.anomaly', (e) => anomalies.push(e.payload));
    const auditWriter = recordingAuditWriter();
    const leash = createLeash({
      bus, config: fakeConfig({ LEASH_CONFIRM_TTL_MS: 500 }),
      identity: noopIdentity(), auditWriter, goals: { get: () => null }, effectors: noopEffectors(),
    });
    const confirmId = leash.confirm.create('send the email', { tool: 'gmail_send', args: {} }, 'conn-A');
    leash.confirm.accept(confirmId, 'conn-A');

    t.mock.timers.tick(1000);

    assert.equal(anomalies.filter((a) => a.kind === 'confirm-expired-silently').length, 0);
    assert.equal(auditWriter._writes().filter((w) => w.reason === 'confirm-ttl-expired').length, 0);
  });
});
