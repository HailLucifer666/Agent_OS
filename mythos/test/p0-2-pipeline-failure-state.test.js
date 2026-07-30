'use strict';

// REMEDIATION P0-2 (2026-07-29 audit): a build job that fails BEFORE run()
// ever executes (build engine offline, brain.think() returns offline:true —
// exactly what happened when Hermes was unreachable) previously left the
// pipeline card sitting at execute/progress:25 forever, with no trace that
// anything had failed. pipeline_status then kept reporting "still building"
// indefinitely — the operator was told a build was in progress 18 minutes
// after the job had already died. Two independent fixes are pinned here:
//   1. build-runner's onFailed hook (agent-actions.js) writes buildFailed
//      metadata onto the card the moment the job dies.
//   2. from-dashboard.js's pipeline_status() reconciles ANY execute-stage
//      card's jobId against the build runner's real job status, so a card
//      that somehow missed the hook (or predates this fix) self-heals too.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const nodeFs = require('fs');

const { tempVaultDir, cleanupVaultDir, fakeBus, waitForJobFinished } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createPipelineEffector } = require('../src/core/effectors/pipeline');
const { createKanbanEffector } = require('../src/core/effectors/kanban');
const { createBuildRunner } = require('../src/core/effectors/build-runner');
const { createAgentActions } = require('../src/core/effectors/agent-actions');
const { buildTools } = require('../src/core/effectors/from-dashboard');

function setup(brainThinkImpl) {
  const dir = tempVaultDir();
  const vaultFs = createFsStore(() => dir, null);
  nodeFs.mkdirSync(path.join(dir, 'builds', 'pipeline'), { recursive: true });

  const brain = { think: async (args) => brainThinkImpl(args) };
  const pipeline = createPipelineEffector({ fs: vaultFs });
  const kanban = createKanbanEffector({ fs: vaultFs });
  const webSearch = async () => ({
    ok: true,
    result: { results: [{ title: 'Result', url: 'https://example.com/a', snippet: 'snippet text' }] }
  });
  const webFetch = async () => ({ ok: true, result: { content: 'fetched body' } });
  const buildRunner = createBuildRunner({ config: {}, brain, bus: fakeBus(), vault: vaultFs });
  const agentActions = createAgentActions({ fs: vaultFs, pipeline, kanban, buildRunner, brain, webSearch, webFetch });
  return { dir, vaultFs, pipeline, kanban, buildRunner, agentActions };
}

// The 4000ms hand-rolled wait that used to live here was smaller than the
// bounded worst case of the path it waits on (see helpers.js's
// waitForJobFinished) and reported flake as failure with a message that could
// not be told apart from a real hang. Shared helper now owns both.

describe('P0-2: a job that fails before run() ever executes still marks the card failed', () => {
  it('onFailed writes buildFailed + buildError onto the pipeline card (Hermes-offline shape)', async () => {
    const env = setup(() => ({ offline: true, error: 'hermes-agent OFFLINE: not installed/running' }));
    try {
      const card = env.pipeline.capture('Build an AI news digest', 'test');
      env.pipeline.approve(card.id);

      const execResult = env.agentActions.executePipelineCard(card.id, null);
      const finishedJob = await waitForJobFinished(env.buildRunner, execResult.job.id);
      assert.equal(finishedJob.status, 'failed');

      const after = env.pipeline.findCard(card.id);
      assert.equal(after.stage, 'execute', 'card stays in execute (existing retry-build UI reads job.status off it)');
      assert.equal(after.card.buildFailed, true);
      assert.ok(String(after.card.buildError).includes('hermes-agent OFFLINE'));
    } finally {
      cleanupVaultDir(env.dir);
    }
  });

  it('a successful retry clears the stale buildFailed flag', async () => {
    let attempt = 0;
    const env = setup((args) => {
      attempt += 1;
      if (attempt === 1) return { offline: true, error: 'hermes-agent OFFLINE' };
      return { content: '<!DOCTYPE html><html><head><title>AI News Digest</title></head><body>news</body></html>', offline: false, parsed: null };
    });
    try {
      const card = env.pipeline.capture('AI news digest page', 'test');
      env.pipeline.approve(card.id);

      const firstRun = env.agentActions.executePipelineCard(card.id, null);
      await waitForJobFinished(env.buildRunner, firstRun.job.id);
      assert.equal(env.pipeline.findCard(card.id).card.buildFailed, true);

      const secondRun = env.agentActions.executePipelineCard(card.id, null);
      await waitForJobFinished(env.buildRunner, secondRun.job.id);
      const after = env.pipeline.findCard(card.id);
      assert.equal(after.card.buildFailed, false, 'a successful rebuild must clear the prior failure flag');
    } finally {
      cleanupVaultDir(env.dir);
    }
  });
});

describe('P0-2: pipeline_status self-heals a stale card pipeline_status was never told about', () => {
  it('reconciles an execute-stage card against buildRunner.getJob() even without the onFailed hook', async () => {
    const dir = tempVaultDir();
    const vaultFs = createFsStore(() => dir, null);
    try {
      const pipeline = createPipelineEffector({ fs: vaultFs });
      const brain = { think: async () => ({ offline: true, error: 'engine offline' }) };
      const buildRunner = createBuildRunner({ config: {}, brain, bus: fakeBus(), vault: vaultFs });

      // Simulate a card whose job already failed, but the card itself was
      // never patched (e.g. it predates this fix, or the process crashed
      // between the job dying and the onFailed hook running) — enqueue a
      // real job with no onFailed hook at all, then point the card at it.
      const card = pipeline.capture('Stale card from a dead build', 'test');
      const realJob = buildRunner.enqueue({ kind: 'pipeline-execute', prompt: 'anything', run: async () => ({}) });
      pipeline.moveCard(card.id, 'execute', { jobId: realJob.id, progress: 25 });

      const tools = buildTools({ fs: vaultFs, bus: fakeBus(), config: {}, pipeline, buildRunner });
      // Wait for the enqueued job to actually fail so getJob() reflects it.
      // (Was an UNBOUNDED poll — a hang here wedged the runner with no message
      // at all; the shared helper bounds it and reports the job's last state.)
      await waitForJobFinished(buildRunner, realJob.id);

      const statusResult = await tools.TOOLS.find((t) => t.name === 'pipeline_status').fn({});
      assert.equal(statusResult.ok, true);
      const reconciled = statusResult.result.board.execute.find((c) => c.id === card.id);
      assert.equal(reconciled.buildFailed, true, 'pipeline_status must reconcile a stale card against the real job status');

      // And the reconciliation is persisted, not just patched in the response.
      const onDisk = pipeline.findCard(card.id);
      assert.equal(onDisk.card.buildFailed, true);
    } finally {
      cleanupVaultDir(dir);
    }
  });
});
