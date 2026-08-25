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

  // job.artifact is an OBJECT ({path, …}) on the job record — job_status,
  // agent-actions and from-dashboard all read artifact.path. The perception
  // must carry the PATH STRING: the announcer composes the spoken completion
  // sentence from it, and the object stringified to "[object Object]" there,
  // so the operator and the model heard a garbage artifact name on every
  // announced build.
  it('emits the artifact PATH string, never the artifact object', () => {
    const bus = fakeBus();
    const buildRunner = fakeBuildRunner();
    const sensor = createJobSensor({ bus, buildRunner });
    sensor.start();

    buildRunner._fire({
      id: 'job-a', kind: 'build', status: 'done', stage: 'done', error: null,
      artifact: { path: '/vault/Builds/2026-08-17/report.html', kind: 'html' },
    });

    const evt = bus._lastEvent('perception.job');
    assert.equal(evt.payload.artifact, '/vault/Builds/2026-08-17/report.html');
    buildRunner._fire({ id: 'job-b', kind: 'build', status: 'done', stage: 'done', error: null, artifact: null });
    assert.equal(bus._lastEvent('perception.job').payload.artifact, null,
      'a job with no artifact must stay null, not become "undefined"');
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
