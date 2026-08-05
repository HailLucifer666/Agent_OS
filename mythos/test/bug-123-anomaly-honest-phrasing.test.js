'use strict';

// test/bug-123-anomaly-honest-phrasing.test.js — BUG-123 (AD-5).
//
// conversation/announcer.js narrated health anomalies and diagnoses by handing a
// free-text prompt to brain.think and speaking whatever came back. A health
// anomaly payload is thin — often just a `kind` — and a model asked to turn that
// into one natural sentence fills the gap with a plausible cause the payload
// never contained. The operator then hears an invented explanation for a real
// fault in their own machine, which is precisely what AD-5 forbids.
//
// The fix is not better prompt wording; it is removing the brain call from this
// event class. Only fields actually present are interpolated, and an absent
// cause is stated out loud rather than left as a silence the listener fills in.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('../src/core/bus');
const { createConversationAnnouncer } = require('../src/core/conversation/announcer');

function harness() {
  const spoken = [];
  const brainCalls = [];
  const bus = createBus({ historySize: 50 });
  const announcer = createConversationAnnouncer({
    bus,
    brain: {
      think: async (req) => {
        brainCalls.push(req);
        // Exactly the failure mode: asked to narrate naturally, the model
        // supplies a cause nothing in the payload supports.
        return { content: 'The provider went down because your network dropped out.', offline: false };
      },
    },
    config: {},
    speak: (t) => spoken.push(t),
  });
  announcer.start();
  return { bus, spoken, brainCalls, announcer };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('BUG-123 — an anomaly is narrated from the payload, never invented', () => {
  test('a payload with no reason says the cause is unknown, and invents nothing', async () => {
    const { bus, spoken, brainCalls, announcer } = harness();

    bus.emit('health.anomaly', { kind: 'provider-down' });
    await settle();

    assert.equal(spoken.length, 1);
    assert.match(spoken[0], /provider-down/, 'the real condition must be named');
    assert.match(spoken[0], /do not yet know the cause/i,
      'an absent cause must be stated, not papered over');
    assert.doesNotMatch(spoken[0], /because/i, 'no causal claim the payload never made');
    assert.doesNotMatch(spoken[0], /network dropped/i, 'the model\'s invented cause must not reach the operator');
    assert.equal(brainCalls.length, 0, 'this event class must not consult the brain at all');

    announcer.stop();
  });

  test('a reason that IS on the payload is reported verbatim', async () => {
    const { bus, spoken, announcer } = harness();

    bus.emit('health.anomaly', { kind: 'effector-flapping', reason: 'breaker opened 4 times in 60s' });
    await settle();

    assert.match(spoken[0], /breaker opened 4 times in 60s/,
      'real evidence must survive — this is an honesty fix, not a muzzle');
    assert.doesNotMatch(spoken[0], /do not yet know/i);

    announcer.stop();
  });

  test('a target is named when present and never duplicated when it equals the kind', async () => {
    const { bus, spoken, announcer } = harness();

    bus.emit('health.anomaly', { kind: 'provider-down', target: 'openrouter' });
    await settle();
    assert.match(spoken[0], /provider-down in openrouter/);

    announcer.stop();
  });

  test('a critical diagnosis gets the same deterministic treatment', async () => {
    const { bus, spoken, brainCalls, announcer } = harness();

    bus.emit('health.diagnosed', { severity: 'critical', syndrome: 'cortex-stalled' });
    await settle();

    assert.equal(spoken.length, 1);
    assert.match(spoken[0], /cortex-stalled/);
    assert.match(spoken[0], /do not yet know the cause/i);
    assert.equal(brainCalls.length, 0);

    announcer.stop();
  });

  test('build and goal announcements still go through the brain — no over-correction', async () => {
    const { bus, brainCalls, announcer } = harness();

    bus.emit('goal.updated', { status: 'done', id: 'g1', title: 'ship the report' });
    await settle();

    assert.equal(brainCalls.length, 1,
      'a completed goal has no cause to invent; only the anomaly class loses the brain call');

    announcer.stop();
  });
});
