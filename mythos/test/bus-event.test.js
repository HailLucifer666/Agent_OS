'use strict';

// bus-event.test.js — the event envelope the causal-loop guard depends on.
//
// WHY THIS FILE EXISTS. bus/event.js is 20 lines and had no direct test, but
// three of its fields are load-bearing safety machinery:
//
//   depth   — bus/index.js:38 refuses to publish at `e.depth >= maxDepth` and
//             emits a 'causal-loop' anomaly instead. That is the only thing
//             stopping a handler-triggers-event-triggers-handler loop from
//             spinning forever, and it is arithmetic done here.
//   traceId — inherited from the cause, so one originating event and everything
//             it provoked share an id. Regenerating it would silently sever
//             every causal chain in the vault.
//   causeId — the link a reader follows backwards.
//
// A defect in the depth increment does not fail loudly; it disarms a guard.
//
// Run: cd mythos && node --test test/bus-event.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createEvent } = require('../src/core/bus/event');

describe('createEvent: the envelope', () => {
  it('derives the channel from the first dot segment', () => {
    assert.equal(createEvent('perception.tick', {}).channel, 'perception');
    assert.equal(createEvent('health.anomaly', {}).channel, 'health');
    // The channel-less control events documented verbatim in the architecture's
    // event catalog — 'tick', 'reflect', 'confirm-request', 'brain-spend' — carry
    // their whole name as the channel. That is intended, not a parse failure.
    assert.equal(createEvent('tick', {}).channel, 'tick');
  });

  it('gives every event a unique prefixed id', () => {
    const ids = new Set();
    for (let i = 0; i < 200; i++) ids.add(createEvent('perception.tick', {}).id);
    assert.equal(ids.size, 200);
    assert.match(createEvent('perception.tick', {}).id, /^evt-[0-9a-f-]{36}$/);
  });

  it('defaults the source rather than leaving it undefined', () => {
    assert.equal(createEvent('perception.tick', {}).source, 'unknown');
    assert.equal(createEvent('perception.tick', {}, { source: 'timer-sensor' }).source, 'timer-sensor');
  });

  it('passes the payload through untouched', () => {
    const payload = { kind: 'provider-down', target: 'nim', nested: { n: 1 } };
    assert.equal(createEvent('health.anomaly', payload).payload, payload,
      'the payload must be carried by reference, not copied or normalised — the ' +
      'bus is a transport, and a copy here is where fields go missing');
  });

  it('throws on a type it cannot parse rather than inventing a channel', () => {
    // Fail loud. A missing type is a programming error at the emit site, and a
    // silent fallback channel would route the event somewhere no subscriber
    // expects while looking like it worked. Pinned as the deliberate behaviour.
    assert.throws(() => createEvent(undefined, {}), TypeError);
    assert.throws(() => createEvent(null, {}), TypeError);
  });
});

describe('createEvent: causality', () => {
  it('a root event has depth 0, no cause, and is its own trace', () => {
    const root = createEvent('perception.tick', {});
    assert.equal(root.depth, 0);
    assert.equal(root.causeId, null);
    assert.equal(root.traceId, root.id, 'a root event begins its own trace');
  });

  it('a caused event increments depth and inherits the trace', () => {
    const root = createEvent('perception.tick', {}, { source: 'timer' });
    const child = createEvent('action.completed', {}, { cause: root });
    assert.equal(child.depth, 1);
    assert.equal(child.causeId, root.id);
    assert.equal(child.traceId, root.traceId, 'the trace must be inherited, never regenerated');
    assert.notEqual(child.id, root.id);
  });

  it('depth counts the whole chain, which is what the guard reads', () => {
    // The mechanism, not the value: bus/index.js:38 compares e.depth against
    // maxDepth. If depth ever stopped accumulating past the first hop, the guard
    // would still be present, still be tested elsewhere, and never fire — the
    // repo's most-repeated defect shape.
    let event = createEvent('perception.tick', {});
    const traceId = event.traceId;
    for (let i = 1; i <= 40; i++) {
      event = createEvent('action.step', {}, { cause: event });
      assert.equal(event.depth, i, 'depth must equal the hop count at hop ' + i);
      assert.equal(event.traceId, traceId, 'one trace across the whole chain');
    }
    // Past the bus's default maxDepth of 32, so a runaway chain is refusable.
    assert.ok(event.depth >= 32);
  });

  it('starts a fresh trace when no cause is given, even mid-chain', () => {
    const root = createEvent('perception.tick', {});
    const caused = createEvent('action.a', {}, { cause: root });
    const unrelated = createEvent('action.b', {});
    assert.notEqual(unrelated.traceId, caused.traceId);
    assert.equal(unrelated.depth, 0, 'an uncaused event must not inherit a depth from anywhere');
  });
});
