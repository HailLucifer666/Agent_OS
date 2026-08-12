'use strict';

// sensors/job.js — Job Sensor: subscribes to build-runner's onJobUpdate() and turns
// every job-state transition into a `perception.job` bus event. This is what closes
// the loop the header comment in build-runner.js promises: Cortex never awaits a build
// directly, it finds out a build finished (or failed) the same way it finds out about
// anything else — as a perception drained from working memory on the next tick.
//
// Matches the real, already-shipped sensor shape (create*Sensor({bus,...}) -> {start,
// stop, isRunning}, zero-arg start()) established by timer.js — see Spec Ambiguities #3.

function createJobSensor({ bus, buildRunner }) {
  if (!bus || typeof bus.emit !== 'function') {
    throw new Error('createJobSensor requires a bus');
  }
  if (!buildRunner || typeof buildRunner.onJobUpdate !== 'function') {
    throw new Error('createJobSensor requires a buildRunner with onJobUpdate()');
  }

  var running = false;
  var unsubscribe = null;

  function handleJobUpdate(job) {
    if (!running) return;
    // salience: 0.5 normal, 0.7 failed — field is `.salience`, never `.salienceHint`
    // (this is the flat shape working memory/orient() actually consumes; see
    // Spec Ambiguities discussion of the Perception Envelope vs. the real orient()).
    var salience = job.status === 'failed' ? 0.7 : 0.5;
    bus.emit('perception.job', {
      kind: 'job',
      summary: job.kind + ' job ' + job.id + ' ' + job.status,
      channel: 'build',
      salience: salience,
      jobId: job.id,
      status: job.status,
      stage: job.stage,
      error: job.error,
      // artifact path — included so the conversation announcer and cortex know
      // WHAT to open/announce on completion, not just that "a job finished".
      artifact: job.artifact || null,
      // BUG-016: include review verdict and issues so announcer can notify the user
      // if a build completed but failed review (as opposed to build execution failure)
      reviewVerdict: job.reviewVerdict || null,
      reviewIssues: job.reviewIssues || null,
      // C1: include the engine so the announcer can also degrade a build
      // that came from the fallback engine, not just one the reviewer
      // rejected — job.engine is stamped by build-runner.js's pump() before
      // run() ever returns (see completion-status.js for why both signals
      // matter).
      engine: job.engine || null
    });
  }

  function start() {
    running = true;
    unsubscribe = buildRunner.onJobUpdate(handleJobUpdate);
  }

  function stop() {
    running = false;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  }

  return {
    start: start,
    stop: stop,
    isRunning: function() { return running; }
  };
}

module.exports = { createJobSensor };
