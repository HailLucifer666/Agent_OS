'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { fakeBus } = require('./helpers');
const { createJobSensor } = require('../src/core/sensors/job');

function fakeBuildRunner() {
  var listeners = [];
  return {
    onJobUpdate: function(fn) {
      listeners.push(fn);
      return function unsubscribe() {
        var idx = listeners.indexOf(fn);
        if (idx !== -1) listeners.splice(idx, 1);
      };
    },
    _fire: function(job) { listeners.forEach(function(fn) { fn(job); }); }
  };
}

describe('sensors/job: createJobSensor', () => {
  it('throws in the constructor if bus is missing', () => {
    assert.throws(() => createJobSensor({ bus: null, buildRunner: fakeBuildRunner() }));
  });

  it('throws in the constructor if buildRunner.onJobUpdate is missing', () => {
    assert.throws(() => createJobSensor({ bus: fakeBus(), buildRunner: {} }));
  });

  it('emits perception.job with salience 0.7 for a failed job', () => {
    const bus = fakeBus();
    const buildRunner = fakeBuildRunner();
    const sensor = createJobSensor({ bus, buildRunner });
    sensor.start();

    buildRunner._fire({ id: 'job-1', kind: 'test', status: 'failed', stage: 'failed', error: 'boom' });

    const evt = bus._lastEvent('perception.job');
    assert.ok(evt, 'expected a perception.job event');
    assert.equal(evt.payload.salience, 0.7);
    assert.equal(evt.payload.jobId, 'job-1');
    assert.equal(evt.payload.status, 'failed');
  });

  it('emits perception.job with salience 0.5 for a non-failed job', () => {
    const bus = fakeBus();
    const buildRunner = fakeBuildRunner();
    const sensor = createJobSensor({ bus, buildRunner });
    sensor.start();

    buildRunner._fire({ id: 'job-2', kind: 'test', status: 'done', stage: 'done', error: null });

    const evt = bus._lastEvent('perception.job');
    assert.equal(evt.payload.salience, 0.5);
  });

  it('does not emit after stop()', () => {
    const bus = fakeBus();
    const buildRunner = fakeBuildRunner();
    const sensor = createJobSensor({ bus, buildRunner });
    sensor.start();
    sensor.stop();
    assert.equal(sensor.isRunning(), false);

    buildRunner._fire({ id: 'job-3', kind: 'test', status: 'done', stage: 'done', error: null });
    const evt = bus._lastEvent('perception.job');
    assert.equal(evt, null);
  });
});
