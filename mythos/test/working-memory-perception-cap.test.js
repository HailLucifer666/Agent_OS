'use strict';

// BUG-138: the perception queue (mythos/src/core/memory/working.js) had no cap.
// The camera producer runs ~7fps while cortex/index.js skips an entire tick
// when the previous one is still in flight, and slow brain lanes in this
// repo take 90-185s — so one stalled tick could queue 600-1300 unconsumed
// payloads with nothing to bound it. This test pins: a hard cap
// (PERCEPTION_QUEUE_MAX), drop-oldest eviction, and exactly one
// health.anomaly per overflow burst (not one per dropped item).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createWorkingMemory } = require('../src/core/memory/working');

const PERCEPTION_QUEUE_MAX = 200;

function fakeBus() {
  const emitted = [];
  return {
    emit: function (name, payload) { emitted.push({ name: name, payload: payload }); },
    _emitted: function () { return emitted; },
  };
}

describe('BUG-138 — working memory perception queue is bounded', function () {

  it('caps the queue at PERCEPTION_QUEUE_MAX, dropping the OLDEST entries first', function () {
    const bus = fakeBus();
    const wm = createWorkingMemory({ bus: bus });
    const total = PERCEPTION_QUEUE_MAX + 50;
    for (let i = 0; i < total; i++) {
      wm.pushPerception({ id: i });
    }
    const queue = wm.perceptionQueue;
    assert.equal(queue.length, PERCEPTION_QUEUE_MAX, 'queue must never exceed the cap');
    // The first 50 pushed (ids 0..49) must be gone; the newest 200 (ids 50..249) survive.
    assert.equal(queue[0].id, 50, 'oldest surviving entry should be the first one not dropped');
    assert.equal(queue[queue.length - 1].id, total - 1, 'newest entry must survive');
  });

  it('emits exactly ONE health.anomaly across a sustained overflow burst', function () {
    const bus = fakeBus();
    const wm = createWorkingMemory({ bus: bus });
    const total = PERCEPTION_QUEUE_MAX + 50;
    for (let i = 0; i < total; i++) {
      wm.pushPerception({ id: i });
    }
    const anomalies = bus._emitted().filter((e) => e.name === 'health.anomaly');
    assert.equal(anomalies.length, 1, 'a sustained overflow burst must not spam the bus');
    assert.equal(anomalies[0].payload.source, 'working.pushPerception');
    assert.ok(anomalies[0].payload.dropped >= 1, 'the anomaly payload must include a drop count');
  });

  it('emits again on a SECOND overflow burst after the queue has been drained', function () {
    const bus = fakeBus();
    const wm = createWorkingMemory({ bus: bus });
    const total = PERCEPTION_QUEUE_MAX + 50;
    for (let i = 0; i < total; i++) wm.pushPerception({ id: i });
    wm.drainPerceptions();
    for (let i = 0; i < total; i++) wm.pushPerception({ id: i });
    const anomalies = bus._emitted().filter((e) => e.name === 'health.anomaly');
    assert.equal(anomalies.length, 2, 'draining back under the cap must reset the burst flag for the next overflow');
  });

  it('a bus.emit failure never breaks pushPerception', function () {
    const bus = { emit: function () { throw new Error('bus down'); } };
    const wm = createWorkingMemory({ bus: bus });
    assert.doesNotThrow(function () {
      for (let i = 0; i < PERCEPTION_QUEUE_MAX + 5; i++) wm.pushPerception({ id: i });
    });
    assert.equal(wm.perceptionQueue.length, PERCEPTION_QUEUE_MAX);
  });

});
