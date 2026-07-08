'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createBus, createEvent } = require('../src/core/bus');

describe('bus', () => {
  it('creates and subscribes to events', () => {
    const bus = createBus();
    let received = null;
    bus.subscribe('tick', function(e) { received = e; });
    bus.emit('tick', { count: 1 });
    assert.ok(received);
    assert.equal(received.type, 'tick');
    assert.equal(received.channel, 'tick');
    assert.equal(received.payload.count, 1);
    assert.ok(received.id.startsWith('evt-'));
    assert.ok(received.traceId);
  });

  it('unsubscribe stops delivery', () => {
    const bus = createBus();
    let count = 0;
    const unsub = bus.subscribe('tick', function() { count++; });
    bus.emit('tick', {});
    assert.equal(count, 1);
    unsub();
    bus.emit('tick', {});
    assert.equal(count, 1);
  });

  it('wildcard * matches all types', () => {
    const bus = createBus();
    const types = [];
    bus.subscribe('*', function(e) { types.push(e.type); });
    bus.emit('tick', {});
    bus.emit('health.anomaly', {});
    bus.emit('action.completed', {});
    assert.deepEqual(types, ['tick', 'health.anomaly', 'action.completed']);
  });

  it('dot-prefix wildcard matches channel', () => {
    const bus = createBus();
    const events = [];
    bus.subscribe('health.*', function(e) { events.push(e.type); });
    bus.emit('health.anomaly', {});
    bus.emit('health.ok', {});
    bus.emit('tick', {});
    assert.deepEqual(events, ['health.anomaly', 'health.ok']);
  });

  it('middleware can drop events', () => {
    const bus = createBus();
    let received = false;
    bus.use(function(e) { return null; });  // drop everything
    bus.subscribe('*', function() { received = true; });
    bus.emit('tick', {});
    assert.equal(received, false);
  });

  it('middleware can transform events', () => {
    const bus = createBus();
    bus.use(function(e) {
      e.payload.transformed = true;
      return e;
    });
    let received = null;
    bus.subscribe('tick', function(e) { received = e; });
    bus.emit('tick', {});
    assert.equal(received.payload.transformed, true);
  });

  it('causal chain propagates traceId', () => {
    const bus = createBus();
    const root = createEvent('tick', { beat: 1 }, { source: 'timer' });
    const child = createEvent('action.completed', { tool: 'test' }, { cause: root, source: 'cortex' });
    assert.equal(child.traceId, root.id);
    assert.equal(child.causeId, root.id);
    assert.equal(child.depth, 1);
  });

  it('causal depth cap prevents loops', () => {
    const bus = createBus({ maxDepth: 3 });
    const events = [];
    bus.subscribe('*', function(e) { events.push(e.type); });

    let root = createEvent('tick', {}, { source: 'timer' });
    let child = createEvent('action.a', {}, { cause: root });
    let grandchild = createEvent('action.b', {}, { cause: child });
    let greatgrandchild = createEvent('action.c', {}, { cause: grandchild });

    bus.publish(root);
    bus.publish(child);
    bus.publish(grandchild);
    bus.publish(greatgrandchild);  // depth=3, maxDepth=3, should be blocked

    // root(0), child(1), grandchild(2) published, greatgrandchild(3) blocked
    assert.ok(events.includes('tick'));
    assert.ok(events.includes('action.a'));
    assert.ok(events.includes('action.b'));
    // greatgrandchild blocked — instead health.anomaly emitted
    assert.ok(events.includes('health.anomaly'));
  });

  it('history records events', () => {
    const bus = createBus({ historySize: 5 });
    bus.emit('tick', { n: 1 });
    bus.emit('tick', { n: 2 });
    bus.emit('tick', { n: 3 });
    assert.equal(bus.stats().historySize, 3);

    bus.emit('tick', { n: 4 });
    bus.emit('tick', { n: 5 });
    bus.emit('tick', { n: 6 });
    // History capped at 5 — first evicted
    assert.equal(bus.stats().historySize, 5);
    const h = bus.history();
    assert.equal(h[0].payload.n, 2);
  });

  it('stats returns correct values', () => {
    const bus = createBus();
    bus.emit('tick', {});
    bus.subscribe('tick', function() {});
    const stats = bus.stats();
    assert.equal(stats.seq, 1);
    assert.equal(stats.historySize, 1);
    assert.ok(stats.subs >= 1);
  });

  it('handler errors are isolated', () => {
    const bus = createBus();
    let secondCalled = false;
    bus.subscribe('tick', function() { throw new Error('boom'); });
    bus.subscribe('tick', function() { secondCalled = true; });
    bus.emit('tick', {});
    assert.equal(secondCalled, true);
  });
});
