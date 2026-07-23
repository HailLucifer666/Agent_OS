'use strict';

// REMEDIATION P2-8: FIX H set job.spec (the clean topic) in buildKanbanCard so
// build-runner's verifier sees the real spec instead of the boilerplate-laden
// builder prompt — but executePipelineCard (the capture_idea -> pipeline
// stage's own build path) has the IDENTICAL basePrompt-pollution shape
// (DELIVERABLE_PREAMBLE + card.text, plus skill-pack/design-system injection)
// and was never given the same fix, so its build ALSO gets verified against
// boilerplate. Pipeline cards only carry {id, text} (no title/detail — see
// pipeline.js's capture()), so the clean spec here is simply card.text.

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

function waitForJobFinished(buildRunner, jobId, timeoutMs) {
  timeoutMs = timeoutMs || 4000;
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const unsubscribe = buildRunner.onJobUpdate((job) => {
      if (job.id === jobId && (job.status === 'done' || job.status === 'failed')) { unsubscribe(); resolve(job); }
    });
    const poll = setInterval(() => {
      const job = buildRunner.getJob(jobId);
      if (job && (job.status === 'done' || job.status === 'failed')) { clearInterval(poll); unsubscribe(); resolve(job); }
      else if (Date.now() - start > timeoutMs) { clearInterval(poll); unsubscribe(); reject(new Error('timed out waiting for job ' + jobId)); }
    }, 10);
  });
}

describe('REMEDIATION: executePipelineCard sets a clean job.spec, not the boilerplate builder prompt', () => {
  it("verifier.verify() receives card.text, not the DELIVERABLE_PREAMBLE-prefixed prompt", async () => {
    const IDEA_TEXT = 'Build a simple calculator';
    const dir = tempVaultDir();
    const vaultFs = createFsStore(() => dir, null);
    nodeFs.mkdirSync(path.join(dir, 'builds', 'pipeline'), { recursive: true });

    const brain = {
      think: async (args) => {
        if (args.source && args.source.indexOf('build-runner:') === 0) {
          return { content: '<!DOCTYPE html><html><head><title>Simple Calculator</title></head><body>calculator</body></html>', offline: false, parsed: null };
        }
        if (args.source === 'reviewer-agent') return { content: '{"verdict":"approve","issues":[]}', offline: false, parsed: { verdict: 'approve', issues: [] } };
        if (args.source === 'reality-check') return { content: '{"verdict":"approve","issues":[]}', offline: false, parsed: { verdict: 'approve', issues: [] } };
        if (args.source === 'visual-verify') return { content: '{"match":true,"issues":[],"description":"looks good"}', offline: false, parsed: { match: true, issues: [], description: 'looks good' } };
        return { content: '{}', offline: false, parsed: {} };
      }
    };

    const pipeline = createPipelineEffector({ fs: vaultFs });
    const kanban = createKanbanEffector({ fs: vaultFs });

    let receivedSpec = null;
    let receivedSpecLooksLikePrompt = false;
    const verifier = {
      verify: async (raw, spec) => {
        receivedSpec = spec;
        receivedSpecLooksLikePrompt = typeof spec === 'string' && spec.indexOf('DESIGN SYSTEM') !== -1;
        return { pass: true, issues: [] };
      }
    };
    const buildRunner = createBuildRunner({ config: {}, brain, bus: fakeBus(), vault: vaultFs, verifier });
    const agentActions = createAgentActions({ fs: vaultFs, pipeline, kanban, buildRunner, brain, webSearch: async () => ({ ok: true, result: { results: [] } }), webFetch: async () => ({ ok: true, result: { content: '' } }) });

    try {
      const card = pipeline.capture(IDEA_TEXT, 'test');
      pipeline.approve(card.id);

      const execResult = agentActions.executePipelineCard(card.id, null);
      const jobId = execResult.job.id;

      // job.spec must be set synchronously, right after enqueue — before the
      // async run() even starts.
      const jobRightAfterEnqueue = buildRunner.getJob(jobId);
      assert.equal(jobRightAfterEnqueue.spec, IDEA_TEXT, 'job.spec must be the clean card.text, set synchronously at enqueue time');

      await waitForJobFinished(buildRunner, jobId);

      assert.equal(receivedSpec, IDEA_TEXT, 'verifier.verify() must receive the clean card.text, not the full builder prompt');
      assert.equal(receivedSpecLooksLikePrompt, false, 'the spec verifier received must not contain builder/design-system boilerplate');
    } finally {
      cleanupVaultDir(dir);
    }
  });
});
