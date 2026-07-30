'use strict';

// FLAKE FIX (2026-07-31): p0-2-pipeline-failure-state.test.js and
// pipeline-execute-clean-spec.test.js each hand-rolled a poll-until-terminal
// helper with a 4000ms bound and the message "timed out waiting for job <id>".
// Under a loaded full-suite run that bound was exceeded and the suite reported
// a failure that was not a regression — and the message gave a reader no way to
// tell slowness from a genuine hang. The wait now lives in test/helpers.js with
// a generous bound and a message that reports the job's LAST OBSERVED state, so
// a real hang (stale updatedAt, stuck stage) is distinguishable from a slow
// machine (fresh updatedAt). These tests pin that contract.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { tempVaultDir, cleanupVaultDir, fakeBus, waitForJobFinished } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createBuildRunner } = require('../src/core/effectors/build-runner');

function runnerWith(brainThink) {
  const dir = tempVaultDir();
  const vaultFs = createFsStore(() => dir, null);
  const buildRunner = createBuildRunner({
    config: {}, brain: { think: brainThink }, bus: fakeBus(), vault: vaultFs
  });
  return { dir, buildRunner };
}

describe('waitForJobFinished (shared test helper)', () => {
  it('resolves with the job record once it reaches a terminal state', async () => {
    const env = runnerWith(async () => ({ offline: true, error: 'engine offline' }));
    try {
      const job = env.buildRunner.enqueue({ kind: 'test', prompt: 'anything', run: async () => ({}) });
      const finished = await waitForJobFinished(env.buildRunner, job.id);
      assert.equal(finished.id, job.id);
      assert.equal(finished.status, 'failed');
    } finally {
      cleanupVaultDir(env.dir);
    }
  });

  it('a timeout reports the last observed status and stage, not just "timed out"', async () => {
    // brain.think() never settles → the job is parked at running/generating for
    // the whole wait. That is the shape a REAL hang has, and the message must
    // say so rather than only naming the job id.
    const env = runnerWith(() => new Promise(function() { /* never settles */ }));
    try {
      const job = env.buildRunner.enqueue({ kind: 'test', prompt: 'anything', run: async () => ({}) });
      await assert.rejects(
        () => waitForJobFinished(env.buildRunner, job.id, 200),
        (err) => {
          assert.match(err.message, /timed out/);
          assert.ok(err.message.includes(job.id), 'message must name the job: ' + err.message);
          assert.ok(err.message.includes('status=running'), 'message must report last observed status: ' + err.message);
          assert.ok(err.message.includes('stage=generating'), 'message must report last observed stage: ' + err.message);
          assert.match(err.message, /\d+ms/, 'message must report elapsed/staleness in ms: ' + err.message);
          return true;
        }
      );
    } finally {
      cleanupVaultDir(env.dir);
    }
  });

  it('a job id that does not exist is reported as a missing record, not as a hang', async () => {
    const env = runnerWith(async () => ({ offline: true, error: 'engine offline' }));
    try {
      await assert.rejects(
        () => waitForJobFinished(env.buildRunner, 'job-does-not-exist', 100),
        (err) => {
          assert.ok(err.message.includes('job-does-not-exist'), err.message);
          assert.match(err.message, /no such job record/);
          return true;
        }
      );
    } finally {
      cleanupVaultDir(env.dir);
    }
  });
});
