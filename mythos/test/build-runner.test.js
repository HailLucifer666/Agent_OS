'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createBuildRunner } = require('../src/core/effectors/build-runner');

function waitForStatus(buildRunner, jobId, targetStatuses, timeoutMs) {
  timeoutMs = timeoutMs || 2000;
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const unsubscribe = buildRunner.onJobUpdate((job) => {
      if (job.id === jobId && targetStatuses.indexOf(job.status) !== -1) {
        unsubscribe();
        resolve(job);
      }
    });
    const poll = setInterval(() => {
      const job = buildRunner.getJob(jobId);
      if (job && targetStatuses.indexOf(job.status) !== -1) {
        clearInterval(poll);
        unsubscribe();
        resolve(job);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(poll);
        unsubscribe();
        reject(new Error('timed out waiting for job status ' + targetStatuses.join('|')));
      }
    }, 10);
  });
}

describe('effectors/build-runner: createBuildRunner', () => {
  it('throws in the constructor if brain.think is missing', () => {
    const dir = tempVaultDir();
    const fs = createFsStore(() => dir, null);
    assert.throws(() => createBuildRunner({ config: {}, brain: null, bus: fakeBus(), vault: fs }));
    cleanupVaultDir(dir);
  });

  it('throws in the constructor if vault readJSON/writeJSON is missing', () => {
    assert.throws(() => createBuildRunner({ config: {}, brain: { think: async () => ({}) }, bus: fakeBus(), vault: null }));
  });

  it('queued -> done: enqueue() returns a queued job synchronously and drives to done', async () => {
    const dir = tempVaultDir();
    const fs = createFsStore(() => dir, null);
    const bus = fakeBus();
    const brain = { think: async () => ({ content: 'ok', offline: false }) };
    const buildRunner = createBuildRunner({ config: {}, brain, bus, vault: fs });

    const transitions = [];
    buildRunner.onJobUpdate((job) => { transitions.push(job.status); });

    const job = buildRunner.enqueue({ kind: 'test', prompt: 'do the thing', run: async () => ({ artifact: { path: '/x' } }) });
    assert.equal(job.status, 'queued');

    const done = await waitForStatus(buildRunner, job.id, ['done', 'failed']);
    assert.equal(done.status, 'done');
    assert.deepEqual(done.artifact, { path: '/x' });
    assert.ok(transitions.indexOf('running') !== -1);
    assert.ok(transitions.indexOf('done') !== -1);

    cleanupVaultDir(dir);
  });

  it('restart-failed: a running job persisted at crash time is marked failed on restart', async () => {
    const dir = tempVaultDir();
    const fs = createFsStore(() => dir, null);
    fs.writeJSON('Checkpoints/build-jobs.json', {
      jobs: [{ id: 'job-crashed-1', kind: 'test', status: 'running', stage: 'generating', createdAt: Date.now(), finishedAt: null, artifact: null, error: null }]
    });

    const bus = fakeBus();
    const brain = { think: async () => ({ content: 'ok', offline: false }) };
    const buildRunner = createBuildRunner({ config: {}, brain, bus, vault: fs });

    const job = buildRunner.getJob('job-crashed-1');
    assert.equal(job.status, 'failed');
    assert.match(job.error, /restarted/);

    cleanupVaultDir(dir);
  });
});
