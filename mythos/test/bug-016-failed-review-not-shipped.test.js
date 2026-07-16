'use strict';

// BUG-016: Pipeline card with failed review should NOT move to 'shipped'.
// Instead, it should move back to 'execute' with reviewStatus: 'failed' and
// reviewIssues populated, so the user can see the build needs attention.
// Previously, the card was unconditionally moved to 'shipped' even when
// review.verdict was 'reject', silently hiding failures from the user.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const nodeFs = require('fs');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createPipelineEffector } = require('../src/core/effectors/pipeline');
const { createKanbanEffector } = require('../src/core/effectors/kanban');
const { createBuildRunner } = require('../src/core/effectors/build-runner');
const { createAgentActions } = require('../src/core/effectors/agent-actions');

function setup(brainThinkImpl) {
  const dir = tempVaultDir();
  const vaultFs = createFsStore(() => dir, null);
  nodeFs.mkdirSync(path.join(dir, 'builds', 'pipeline'), { recursive: true });

  const calls = [];
  const brain = {
    think: async (args) => {
      calls.push(args);
      return brainThinkImpl(args);
    }
  };

  const pipeline = createPipelineEffector({ fs: vaultFs });
  const kanban = createKanbanEffector({ fs: vaultFs });
  const webSearch = async () => ({
    ok: true,
    result: { results: [{ title: 'Result', url: 'https://example.com/a', snippet: 'snippet text' }] }
  });
  const webFetch = async () => ({ ok: true, result: { content: 'fetched body' } });

  const buildRunner = createBuildRunner({ config: {}, brain, bus: fakeBus(), vault: vaultFs });
  const agentActions = createAgentActions({ fs: vaultFs, pipeline, kanban, buildRunner, brain, webSearch, webFetch });

  return { dir, vaultFs, pipeline, kanban, buildRunner, agentActions, calls };
}

function cleanup(env) { cleanupVaultDir(env.dir); }

function waitForJobFinished(buildRunner, jobId, timeoutMs) {
  timeoutMs = timeoutMs || 4000;
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const unsubscribe = buildRunner.onJobUpdate((job) => {
      if (job.id === jobId && (job.status === 'done' || job.status === 'failed')) {
        unsubscribe();
        resolve(job);
      }
    });
    const poll = setInterval(() => {
      const job = buildRunner.getJob(jobId);
      if (job && (job.status === 'done' || job.status === 'failed')) {
        clearInterval(poll);
        unsubscribe();
        resolve(job);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(poll);
        unsubscribe();
        reject(new Error('timed out waiting for job ' + jobId + ' to finish'));
      }
    }, 10);
  });
}

describe('BUG-016: Pipeline card with failed review should stay in execute, not move to shipped', () => {
  it('when review.verdict is reject, card moves back to execute with reviewStatus failed', async () => {
    const IDEA_TEXT = 'Build a dashboard with dark theme';

    const env = setup((args) => {
      // Initial build generation
      if (args.source && args.source.indexOf('build-runner:') === 0) {
        return { content: '<!DOCTYPE html><html><head><title>Dark Dashboard</title></head><body>dashboard</body></html>', offline: false, parsed: null };
      }
      // Grounded rebuild (if research happens)
      if (args.source && args.source.indexOf('pipeline-grounded:') === 0) {
        return { content: '<!DOCTYPE html><html><head><title>Dark Dashboard</title></head><body>grounded</body></html>', offline: false, parsed: null };
      }
      // Reviewer rejects the build
      if (args.source === 'reviewer-agent') {
        return {
          content: '{"verdict":"reject","issues":["Missing dark theme CSS","Dashboard is placeholder only"]}',
          offline: false,
          parsed: { verdict: 'reject', issues: ['Missing dark theme CSS', 'Dashboard is placeholder only'] }
        };
      }
      // Reality check passes
      if (args.source === 'reality-check') {
        return { content: '{"verdict":"approve","issues":[]}', offline: false, parsed: { verdict: 'approve', issues: [] } };
      }
      // Visual verify (if enabled)
      if (args.source === 'visual-verify') {
        return { content: '{"match":false,"issues":["Missing dark styling"],"description":"Page missing dark theme"}', offline: false, parsed: { match: false, issues: ['Missing dark styling'], description: 'Page missing dark theme' } };
      }
      return { content: '{}', offline: false, parsed: {} };
    });

    try {
      // Capture the idea
      const card = env.pipeline.capture(IDEA_TEXT, 'test');
      assert.equal(card.stage, 'capture');

      // Approve the card to move to execute
      env.pipeline.approve(card.id);
      let cardInExecute = env.pipeline.findCard(card.id);
      assert.equal(cardInExecute.stage, 'execute', 'card should be in execute stage after approval');

      // Execute the pipeline build
      const execResult = env.agentActions.executePipelineCard(card.id, null);
      const jobId = execResult.job.id;

      // Wait for the job to finish
      const finishedJob = await waitForJobFinished(env.buildRunner, jobId);
      assert.equal(finishedJob.status, 'done', 'job should complete with status done, even when review fails');
      assert.equal(finishedJob.reviewVerdict, 'reject', 'job should capture reviewVerdict as reject');
      assert.ok(Array.isArray(finishedJob.reviewIssues), 'job should capture reviewIssues as array');
      assert.ok(finishedJob.reviewIssues.length > 0, 'job should have at least one review issue');

      // THE KEY ASSERTION: card should still be in 'execute', NOT 'shipped'
      const cardAfterBuild = env.pipeline.findCard(card.id);
      assert.equal(cardAfterBuild.stage, 'execute', 'BUG-016 FIX: card with failed review must stay in execute, not move to shipped');

      // Verify the card has the failure metadata
      assert.equal(cardAfterBuild.card.reviewStatus, 'failed', 'card should have reviewStatus failed');
      assert.ok(Array.isArray(cardAfterBuild.card.reviewIssues), 'card should have reviewIssues array');
      assert.ok(cardAfterBuild.card.reviewIssues.length > 0, 'card should have at least one issue');
      assert.ok(cardAfterBuild.card.reviewIssues.some(i => i.includes('dark theme') || i.includes('Missing')),
        'card should include actual review issues from the reviewer');
    } finally {
      cleanup(env);
    }
  });

  it('when review.verdict is approve, card moves to shipped with reviewStatus approved', async () => {
    const IDEA_TEXT = 'Build a simple calculator';

    const env = setup((args) => {
      // Initial build generation
      if (args.source && args.source.indexOf('build-runner:') === 0) {
        return { content: '<!DOCTYPE html><html><head><title>Simple Calculator</title></head><body>calculator</body></html>', offline: false, parsed: null };
      }
      // Grounded rebuild
      if (args.source && args.source.indexOf('pipeline-grounded:') === 0) {
        return { content: '<!DOCTYPE html><html><head><title>Simple Calculator</title></head><body>grounded</body></html>', offline: false, parsed: null };
      }
      // Reviewer approves the build
      if (args.source === 'reviewer-agent') {
        return {
          content: '{"verdict":"approve","issues":[]}',
          offline: false,
          parsed: { verdict: 'approve', issues: [] }
        };
      }
      // Reality check passes
      if (args.source === 'reality-check') {
        return { content: '{"verdict":"approve","issues":[]}', offline: false, parsed: { verdict: 'approve', issues: [] } };
      }
      // Visual verify passes
      if (args.source === 'visual-verify') {
        return { content: '{"match":true,"issues":[],"description":"Calculator looks good"}', offline: false, parsed: { match: true, issues: [], description: 'Calculator looks good' } };
      }
      return { content: '{}', offline: false, parsed: {} };
    });

    try {
      // Capture, approve, and execute
      const card = env.pipeline.capture(IDEA_TEXT, 'test');
      env.pipeline.approve(card.id);

      const execResult = env.agentActions.executePipelineCard(card.id, null);
      const jobId = execResult.job.id;

      const finishedJob = await waitForJobFinished(env.buildRunner, jobId);
      assert.equal(finishedJob.status, 'done');
      assert.equal(finishedJob.reviewVerdict, 'approve', 'job should capture reviewVerdict as approve');

      // When review passes, card should move to 'shipped'
      const cardAfterBuild = env.pipeline.findCard(card.id);
      assert.equal(cardAfterBuild.stage, 'shipped', 'card with approved review should move to shipped');
      assert.equal(cardAfterBuild.card.reviewStatus, 'approved', 'card should have reviewStatus approved');
    } finally {
      cleanup(env);
    }
  });
});
