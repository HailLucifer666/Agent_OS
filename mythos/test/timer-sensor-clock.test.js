'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function fakeBus() {
  const { createBus } = require('../src/core/bus');
  const bus = createBus({ historySize: 100 });
  var emitted = [];
  var origEmit = bus.emit.bind(bus);
  bus.emit = function(type, payload, opts) {
    emitted.push({ type: type, payload: payload });
    return origEmit(type, payload, opts);
  };
  bus._emitted = function() { return emitted.slice(); };
  bus._clearEmitted = function() { emitted.length = 0; };
  return bus;
}

describe('cortex/sensors/timer', function() {
  it('emits sensor.timer events at tick cadence', function(t) {
    // Wall-clock stalls coalesce intervals; assert the configured cadence under
    // a controlled scheduler instead of assuming CPU time within 180 ms.
    t.mock.timers.enable({ apis: ['setInterval'] });
    var bus = fakeBus();
    var { createTimerSensor } = require('../src/core/sensors/timer');
    var timer = createTimerSensor({ bus: bus, config: { MYTHOS_TICK_MS: 50 } });
    t.after(function() { timer.stop(); });
    timer.start();
    t.mock.timers.tick(49);
    assert.equal(bus._emitted().length, 0, 'must not emit before the configured interval');
    t.mock.timers.tick(1);
    assert.equal(bus._emitted().length, 1, 'first tick must occur at 50 ms');
    t.mock.timers.tick(100);
    timer.stop();
    var events = bus._emitted().filter(function(e) { return e.type === 'perception.tick'; });
    assert.equal(events.length, 3, 'expected ticks at 50, 100 and 150 ms');
    for (var i = 0; i < events.length; i++) {
      assert.ok(events[i].payload.ts, 'event ' + i + ' missing ts');
      assert.ok(typeof events[i].payload.generation === 'number', 'event ' + i + ' missing generation');
      assert.equal(events[i].payload.kind, 'timer', 'event ' + i + ' missing kind');
      assert.equal(events[i].payload.salienceHint, 0.1, 'event ' + i + ' missing salienceHint');
    }
  });

  it('stops and does not emit after stop()', function(t) {
    t.mock.timers.enable({ apis: ['setInterval'] });
    var bus = fakeBus();
    var { createTimerSensor } = require('../src/core/sensors/timer');
    var timer = createTimerSensor({ bus: bus, config: { MYTHOS_TICK_MS: 50 } });
    t.after(function() { timer.stop(); });
    timer.start();
    t.mock.timers.tick(130);
    timer.stop();
    var countAtStop = bus._emitted().filter(function(e) { return e.type === 'perception.tick'; }).length;
    assert.equal(countAtStop, 2, 'stop check must follow real emitted ticks');
    t.mock.timers.tick(130);
    var countAfter = bus._emitted().filter(function(e) { return e.type === 'perception.tick'; }).length;
    assert.equal(countAfter, countAtStop, 'new events appeared after stop()');
  });

  it('a restarted timer emits only the current generation', function(t) {
    t.mock.timers.enable({ apis: ['setInterval'] });
    var bus = fakeBus();
    var { createTimerSensor } = require('../src/core/sensors/timer');
    var timer = createTimerSensor({ bus: bus, config: { MYTHOS_TICK_MS: 50 } });
    t.after(function() { timer.stop(); });
    timer.start();
    t.mock.timers.tick(30);
    timer.stop();
    timer.start();
    t.mock.timers.tick(130);
    timer.stop();
    var events = bus._emitted().filter(function(e) { return e.type === 'perception.tick'; });
    assert.equal(events.length, 2, 'restart must produce ticks from its new schedule');
    // All events should have the second generation
    var lastGen = events[events.length - 1].payload.generation;
    for (var i = 0; i < events.length; i++) {
      assert.equal(events[i].payload.generation, lastGen,
        'event ' + i + ' has stale generation ' + events[i].payload.generation + ' vs ' + lastGen);
    }
  });
});

