'use strict';

// test/artifact-path-echo.test.js — Task C5 (46-finding voice-session audit,
// 2026-08-12). At 02:26:07 and 02:27:00 the model asked open_artifact to open
// two filenames that had never existed, after four pipeline_status calls had
// already put the real artifact path in its context — then told the operator
// the pipeline had returned "erroneous data" (it fabricated the paths itself).
//
// The old failure message ("Call pipeline_status or job_status to get a real
// artifact path") was useless advice to a model that had already called
// pipeline_status four times. This pins two fixes:
//   1. A wrong path's failure now NAMES the real artifact path(s) recorded on
//      known jobs (buildRunner.listJobs()), so the model can self-correct
//      without another round trip.
//   2. open_artifact also accepts jobId directly and resolves the path
//      server-side from the job record, so the model never retypes a
//      filename at all.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('node:module');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { buildTools } = require('../src/core/effectors/from-dashboard');

function toolFn(built, name) {
  const tool = built.TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error('tool not found: ' + name);
  return tool.fn;
}

function withoutAmbientPort(fn) {
  const savedPort = process.env.PORT;
  delete process.env.PORT;
  return Promise.resolve()
    .then(fn)
    .finally(() => { if (savedPort !== undefined) process.env.PORT = savedPort; });
}

// Stubs child_process.spawn AND global.fetch for the duration of fn so no
// real OS opener/network call ever fires. Same idiom as
// open-artifact-auth.test.js / p1-honesty-fixes.test.js.
function withStubs(fn) {
  const originalRequire = Module.prototype.require;
  const spawnCalls = [];
  Module.prototype.require = function (id) {
    if (id === 'child_process') {
      return {
        spawn: function (cmd, args) {
          spawnCalls.push({ cmd, args });
          return { on: function () {}, unref: function () {} };
        },
      };
    }
    return originalRequire.apply(this, arguments);
  };
  const origFetch = global.fetch;
  global.fetch = async function () { return { ok: true, status: 200 }; };
  return Promise.resolve()
    .then(() => fn(spawnCalls))
    .finally(() => {
      Module.prototype.require = originalRequire;
      global.fetch = origFetch;
    });
}

// A minimal fake buildRunner exposing exactly what open_artifact needs:
// getJob(id) and listJobs(). Real records look like { id, artifact: { path,
// title, name } | null, ... } — see effectors/build-runner.js + agent-actions.js.
function fakeBuildRunner(jobs) {
  return {
    getJob: (id) => jobs.find((j) => j.id === id) || null,
    listJobs: () => jobs.slice(),
  };
}

describe('open_artifact: resolves paths from the job record, not the model (C5)', () => {
  let dir, fs;

  before(() => {
    dir = tempVaultDir();
    fs = createFsStore(() => dir, null);
    fs.writeText('builds/pipeline/asgardian-siege-story-visualization-2.html', '<!DOCTYPE html><title>Real</title>');
  });

  after(() => cleanupVaultDir(dir));

  it('a wrong path fails with a message naming the one recorded job artifact (not "call pipeline_status")', () => withoutAmbientPort(() => withStubs(async (spawnCalls) => {
    const jobs = [
      { id: 'job-1', status: 'done', createdAt: 1, finishedAt: 2, artifact: { path: '/vault/builds/pipeline/asgardian-siege-story-visualization-2.html', title: 'Asgardian Siege', name: 'asgardian-siege-story-visualization-2.html' } },
    ];
    const built = buildTools({ fs, bus: fakeBus(), config: {}, buildRunner: fakeBuildRunner(jobs) });
    const open_artifact = toolFn(built, 'open_artifact');

    const result = await open_artifact({ path: '/vault/builds/pipeline/asgardian-siege-story-visualization.html' });

    assert.equal(result.ok, false);
    assert.ok(
      String(result.result).includes('/vault/builds/pipeline/asgardian-siege-story-visualization-2.html'),
      'failure must name the real path, got: ' + result.result
    );
    assert.ok(!/call pipeline_status/i.test(String(result.result)), 'must not just repeat advice the model already followed: ' + result.result);
    assert.equal(spawnCalls.length, 0, 'must never open anything for an unresolved path');
  })));

  it('when several jobs have artifacts, the failure lists the candidates instead of guessing one', () => withoutAmbientPort(() => withStubs(async (spawnCalls) => {
    const jobs = [
      { id: 'job-1', status: 'done', createdAt: 1, finishedAt: 10, artifact: { path: '/vault/builds/pipeline/first-build.html', title: 'First', name: 'first-build.html' } },
      { id: 'job-2', status: 'done', createdAt: 2, finishedAt: 20, artifact: { path: '/vault/builds/pipeline/second-build.html', title: 'Second', name: 'second-build.html' } },
    ];
    const built = buildTools({ fs, bus: fakeBus(), config: {}, buildRunner: fakeBuildRunner(jobs) });
    const open_artifact = toolFn(built, 'open_artifact');

    const result = await open_artifact({ path: '/vault/builds/pipeline/nonexistent.html' });

    assert.equal(result.ok, false);
    assert.ok(String(result.result).includes('/vault/builds/pipeline/first-build.html'), 'must list first candidate: ' + result.result);
    assert.ok(String(result.result).includes('/vault/builds/pipeline/second-build.html'), 'must list second candidate: ' + result.result);
    assert.equal(spawnCalls.length, 0);
  })));

  it('with no buildRunner (or no known artifacts), the old fallback advice still applies and still says "does not exist"', () => withoutAmbientPort(() => withStubs(async (spawnCalls) => {
    const built = buildTools({ fs, bus: fakeBus(), config: {} });
    const open_artifact = toolFn(built, 'open_artifact');

    const result = await open_artifact({ path: '/vault/builds/pipeline/fabricated-slug.html' });

    assert.equal(result.ok, false);
    assert.ok(String(result.result).includes('does not exist'));
    assert.equal(spawnCalls.length, 0);
  })));

  it('accepts jobId and resolves the real path server-side, without the model ever retyping a filename', () => withoutAmbientPort(() => withStubs(async (spawnCalls) => {
    const jobs = [
      { id: 'job-1', status: 'done', createdAt: 1, finishedAt: 2, artifact: { path: '/vault/builds/pipeline/asgardian-siege-story-visualization-2.html', title: 'Asgardian Siege', name: 'asgardian-siege-story-visualization-2.html' } },
    ];
    const built = buildTools({ fs, bus: fakeBus(), config: {}, buildRunner: fakeBuildRunner(jobs) });
    const open_artifact = toolFn(built, 'open_artifact');

    const result = await open_artifact({ jobId: 'job-1' });

    assert.equal(result.ok, true, 'expected success, got: ' + JSON.stringify(result));
    assert.equal(result.result.opened, true);
    assert.ok(String(result.result.url).includes('asgardian-siege-story-visualization-2.html'));
    assert.equal(spawnCalls.length, 1);
  })));

  it('a jobId for a job with no artifact yet fails honestly instead of opening nothing silently', () => withoutAmbientPort(() => withStubs(async (spawnCalls) => {
    const jobs = [
      { id: 'job-1', status: 'running', createdAt: 1, finishedAt: null, artifact: null },
    ];
    const built = buildTools({ fs, bus: fakeBus(), config: {}, buildRunner: fakeBuildRunner(jobs) });
    const open_artifact = toolFn(built, 'open_artifact');

    const result = await open_artifact({ jobId: 'job-1' });

    assert.equal(result.ok, false);
    assert.ok(/no artifact/i.test(String(result.result)), 'must explain the job has no artifact yet: ' + result.result);
    assert.equal(spawnCalls.length, 0);
  })));

  it('an unknown jobId fails honestly', () => withoutAmbientPort(() => withStubs(async (spawnCalls) => {
    const built = buildTools({ fs, bus: fakeBus(), config: {}, buildRunner: fakeBuildRunner([]) });
    const open_artifact = toolFn(built, 'open_artifact');

    const result = await open_artifact({ jobId: 'job-does-not-exist' });

    assert.equal(result.ok, false);
    assert.ok(/no job found/i.test(String(result.result)));
    assert.equal(spawnCalls.length, 0);
  })));
});
