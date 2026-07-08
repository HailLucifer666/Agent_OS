'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('../src/core/bus');
const { createLifecycle } = require('../src/core/lifecycle');
const { createLogger } = require('../src/core/logger');

function makeCtx() {
  const bus = createBus();
  const logger = createLogger('debug');
  return { bus, logger };
}

describe('lifecycle', () => {
  it('boots through all steps', async () => {
    const { bus, logger } = makeCtx();
    const lc = createLifecycle({ bus, logger });
    const order = [];

    lc.setSteps([
      { name: 'one', fn: function() { order.push('one'); } },
      { name: 'two', fn: function() { order.push('two'); } },
      { name: 'three', fn: function() { order.push('three'); } }
    ]);

    await lc.boot();
    assert.deepEqual(order, ['one', 'two', 'three']);
    assert.equal(lc.getState(), 'alive');
  });

  it('emits lifecycle events on bus', async () => {
    const { bus, logger } = makeCtx();
    const lc = createLifecycle({ bus, logger });
    const events = [];
    bus.subscribe('lifecycle.boot.step', function(e) { events.push(e); });
    bus.subscribe('lifecycle.alive', function(e) { events.push(e); });

    lc.setSteps([
      { name: 'a', fn: function() {} },
      { name: 'b', fn: function() {} }
    ]);

    await lc.boot();
    assert.equal(events.length, 3);  // 2 steps + 1 alive
    assert.equal(events[0].payload.step, 'a');
    assert.equal(events[0].payload.status, 'ok');
    assert.equal(events[2].type, 'lifecycle.alive');
  });

  it('fail-fast step throws and stops', async () => {
    const { bus, logger } = makeCtx();
    const lc = createLifecycle({ bus, logger });
    const order = [];

    lc.setSteps([
      { name: 'ok', fn: function() { order.push('ok'); } },
      { name: 'fail', fn: function() { order.push('fail'); throw new Error('boom'); }, fail: 'fast' },
      { name: 'never', fn: function() { order.push('never'); } }
    ]);

    await assert.rejects(function() { return lc.boot(); }, { message: 'boom' });
    assert.deepEqual(order, ['ok', 'fail']);
    assert.equal(lc.getState(), 'dead');
  });

  it('degraded step continues on error', async () => {
    const { bus, logger } = makeCtx();
    const lc = createLifecycle({ bus, logger });
    const order = [];

    lc.setSteps([
      { name: 'ok', fn: function() { order.push('ok'); } },
      { name: 'degrade', fn: function() { order.push('degrade'); throw new Error('warn'); }, fail: 'degraded' },
      { name: 'after', fn: function() { order.push('after'); } }
    ]);

    await lc.boot();
    assert.deepEqual(order, ['ok', 'degrade', 'after']);
    assert.equal(lc.getState(), 'alive');
  });

  it('shutdown changes state', async () => {
    const { bus, logger } = makeCtx();
    const lc = createLifecycle({ bus, logger });
    lc.setSteps([{ name: 'a', fn: function() {} }]);
    await lc.boot();
    assert.equal(lc.getState(), 'alive');

    await lc.shutdown(1000);
    assert.equal(lc.getState(), 'dead');
  });
});
