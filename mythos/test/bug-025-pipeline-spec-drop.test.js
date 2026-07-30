'use strict';

// BUG-025 regression: the build reviewer was reporting "the deliverable does not match
// the task spec as the task is undefined" even when capture_idea received a detailed
// spec. Root cause: agent-actions.js's fullReview() unconditionally read
// card.title/card.detail (the kanban card shape) instead of card.text (the pipeline
// card shape set by pipeline.capture()), so specText silently became the literal
// string "undefined" for every pipeline build. This file verifies the exact spec text
// set at capture_idea time survives all the way into the brain.think() call arguments
// for the reviewer stage, and that build-runner now refuses to enqueue a build-kind
// job whose prompt is empty/undefined instead of silently building on garbage.

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

  const calls = [];
  const brain = {
    think: async (args) => {
      calls.push(args);
      return brainThinkImpl(args);
    }
  };

  // No classifier passed — capture() defaults every card to risk 'feature', same as
  // the P22 quality-gate test suite (mythos/test/p22-quality-gate.test.js).
  const pipeline = createPipelineEffector({ fs: vaultFs });
  const kanban = createKanbanEffector({ fs: vaultFs });

  const webSearch = async () => ({
    ok: true,
    result: { results: [{ title: 'Result', url: 'https://example.com/a', snippet: 'snippet text' }] }
  });
  const webFetch = async () => ({ ok: true, result: { content: 'fetched body' } });

  const buildRunner = createBuildRunner({ config: {}, brain, bus: fakeBus(), vault: vaultFs });
  const agentActions = createAgentActions({ fs: vaultFs, pipeline, kanban, buildRunner, brain, webSearch, webFetch });

  const tools = buildTools({ pipeline, kanban, agentActions, buildRunner, config: {}, fs: vaultFs });
  const toolFn = (name) => tools.TOOLS.find((t) => t.name === name).fn;

  return { dir, vaultFs, pipeline, kanban, buildRunner, agentActions, toolFn, calls };
}

function cleanup(env) { cleanupVaultDir(env.dir); }

// waitForJobFinished comes from ./helpers — this was the fourth copy of the same
// 4000ms-bounded waiter. Three of the four flaked under full-suite load on a
// busy Windows box (this one had not been observed failing yet, but is the same
// latent bug). The shared version allows 30s and reports the job's last observed
// status/stage/error so a genuine hang is still distinguishable from slowness.

describe('BUG-025: captured spec survives capture_idea -> pipeline_execute -> brain.think()', () => {
  it('the exact idea text set at capture_idea time reaches the reviewer prompt sent to brain.think', async () => {
    const IDEA_TEXT = 'Build a landing page for an AI newsletter with dark theme and hero section';

    const env = setup((args) => {
      if (args.source && args.source.indexOf('build-runner:') === 0) {
        return { content: '<!DOCTYPE html><html><head><title>AI Newsletter Landing Page</title></head><body>hero</body></html>', offline: false, parsed: null };
      }
      if (args.source && args.source.indexOf('pipeline-grounded:') === 0) {
        return { content: '<!DOCTYPE html><html><head><title>AI Newsletter Landing Page</title></head><body>hero grounded</body></html>', offline: false, parsed: null };
      }
      if (args.source === 'reviewer-agent' || args.source === 'reality-check') {
        return { content: '{"verdict":"approve","issues":[]}', offline: false, parsed: { verdict: 'approve', issues: [] } };
      }
      return { content: '{}', offline: false, parsed: {} };
    });

    try {
      const captureRes = env.toolFn('capture_idea')({ text: IDEA_TEXT });
      assert.equal(captureRes.ok, true);
      const card = captureRes.result.card;
      assert.equal(card.text, IDEA_TEXT, 'pipeline.capture() must store the captured text verbatim under .text');

      env.pipeline.approve(card.id); // move capture -> execute

      const execRes = env.toolFn('pipeline_execute')({ query: IDEA_TEXT.slice(0, 15) }, {});
      assert.equal(execRes.ok, true, 'pipeline_execute should succeed: ' + JSON.stringify(execRes));
      const jobId = execRes.result.job.id;

      const finished = await waitForJobFinished(env.buildRunner, jobId);
      assert.equal(finished.status, 'done', 'job should finish done, got error: ' + finished.error);

      const reviewerCall = env.calls.find((c) => c.source === 'reviewer-agent');
      assert.ok(reviewerCall, 'a reviewer-agent brain.think() call should have happened');
      const promptText = reviewerCall.messages[0].content;

      assert.ok(promptText.includes(IDEA_TEXT), 'reviewer prompt must contain the exact captured spec text, got: ' + promptText.slice(0, 200));
      assert.ok(!/TASK:\s*undefined/.test(promptText), 'reviewer prompt must never degrade to "TASK: undefined" (BUG-025)');
    } finally {
      cleanup(env);
    }
  });
});

describe('BUG-025: build-runner refuses to enqueue with an empty/undefined spec', () => {
  it('enqueue() returns a fail() result and queues nothing when prompt is undefined', () => {
    const dir = tempVaultDir();
    const vaultFs = createFsStore(() => dir, null);
    const brain = { think: async () => ({ content: 'x', offline: false }) };
    const buildRunner = createBuildRunner({ config: {}, brain, bus: fakeBus(), vault: vaultFs });

    const result = buildRunner.enqueue({ kind: 'test', prompt: undefined, run: async () => ({}) });
    assert.equal(result.ok, false);
    assert.match(result.result.error, /No spec/i);
    assert.equal(buildRunner.listJobs().length, 0, 'no job should have been queued for an undefined prompt');

    cleanupVaultDir(dir);
  });

  it('enqueue() returns a fail() result and queues nothing when prompt is empty/whitespace', () => {
    const dir = tempVaultDir();
    const vaultFs = createFsStore(() => dir, null);
    const brain = { think: async () => ({ content: 'x', offline: false }) };
    const buildRunner = createBuildRunner({ config: {}, brain, bus: fakeBus(), vault: vaultFs });

    const result = buildRunner.enqueue({ kind: 'test', prompt: '   ', run: async () => ({}) });
    assert.equal(result.ok, false);
    assert.match(result.result.error, /No spec/i);
    assert.equal(buildRunner.listJobs().length, 0, 'no job should have been queued for a whitespace-only prompt');

    cleanupVaultDir(dir);
  });

  it('enqueue() still returns a normal job record for a non-empty prompt', () => {
    const dir = tempVaultDir();
    const vaultFs = createFsStore(() => dir, null);
    const brain = { think: async () => ({ content: 'x', offline: false }) };
    const buildRunner = createBuildRunner({ config: {}, brain, bus: fakeBus(), vault: vaultFs });

    const job = buildRunner.enqueue({ kind: 'test', prompt: 'do the thing', run: async () => ({}) });
    assert.equal(job.ok, undefined, 'a successfully queued job is the raw job record, not a fail() wrapper');
    assert.equal(job.status, 'queued');

    cleanupVaultDir(dir);
  });
});
