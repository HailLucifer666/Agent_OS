'use strict';

// C1: A failed review cannot be announced as a success.
//
// Job -531 (2026-08-12 voice-session finding) carried reviewStatus:'failed'
// with buildFailed:false, evidence.pass:true, progress:100, and was
// announced as done. evidence.pass meant "the gate phases ran", which reads
// to a human as "the thing works" — those are not the same fact.
//
// This pins the shared completion-status rule (effectors/completion-status.js)
// that both the pipeline/kanban ship path (agent-actions.js) and the spoken/
// HUD announcer (conversation/announcer.js) now derive from: a job record
// with reviewStatus:'failed' must produce a completion payload whose status
// is 'needs-work' (never 'done') and whose evidence.pass is false. The same
// must hold when the artifact came from the brain fallback engine rather
// than the real one, even if the review itself approved.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const nodeFs = require('fs');

const { deriveCompletionPayload } = require('../src/core/effectors/completion-status');
const { tempVaultDir, cleanupVaultDir, fakeBus, waitForJobFinished } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createPipelineEffector } = require('../src/core/effectors/pipeline');
const { createKanbanEffector } = require('../src/core/effectors/kanban');
const { createBuildRunner } = require('../src/core/effectors/build-runner');
const { createAgentActions } = require('../src/core/effectors/agent-actions');
const { buildTools } = require('../src/core/effectors/from-dashboard');

describe('C1: failed review / fallback-engine builds must never be announced as done', () => {
  it('reviewStatus "failed" -> needs-work, evidence.pass false', () => {
    var payload = deriveCompletionPayload({ reviewStatus: 'failed', buildEngine: 'hermes' });
    assert.equal(payload.status, 'needs-work', 'a failed review must never read as done');
    assert.equal(payload.evidence.pass, false, 'evidence.pass must not mean "the phases ran" when review failed');
  });

  it('reviewStatus "approved" on the real engine -> done, evidence.pass true', () => {
    var payload = deriveCompletionPayload({ reviewStatus: 'approved', buildEngine: 'hermes' });
    assert.equal(payload.status, 'done');
    assert.equal(payload.evidence.pass, true);
  });

  it('buildEngine "brain-fallback" degrades status even when review approved', () => {
    var payload = deriveCompletionPayload({ reviewStatus: 'approved', buildEngine: 'brain-fallback' });
    assert.equal(payload.status, 'needs-work', 'artifact did not come from the real engine — never announce it as finished');
    assert.equal(payload.evidence.pass, false);
  });

  it('legacy literal buildEngine "fallback" is also treated as not-the-real-engine', () => {
    var payload = deriveCompletionPayload({ reviewStatus: 'approved', buildEngine: 'fallback' });
    assert.equal(payload.status, 'needs-work');
    assert.equal(payload.evidence.pass, false);
  });

  it('both signals failing at once still yields exactly one needs-work payload', () => {
    var payload = deriveCompletionPayload({ reviewStatus: 'failed', buildEngine: 'brain-fallback' });
    assert.equal(payload.status, 'needs-work');
    assert.equal(payload.evidence.pass, false);
  });
});

// Wiring check (coordinator follow-up): the pure function above was correct on
// its own, but executePipelineCard's stage transition gated on `reviewed`
// (review.verdict === 'approve') alone, never on completion.status. A
// fallback-engine build whose review happens to approve landed in 'shipped'
// -- pipeline.js's STAGES array treats that as the one finished stage -- while
// carrying shipMeta.status === 'needs-work'. Same setup() pattern as
// bug-016-failed-review-not-shipped.test.js, which this mirrors.
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

  // No buildEngine passed -> createBuildRunner falls back to brain.think, and
  // build-runner.js:182 stamps job.engine from result.engine when the mock
  // supplies one (exactly how build-engine.js's real brainFallback() tags a
  // brain-produced result 'brain-fallback' when Hermes is unreachable).
  const buildRunner = createBuildRunner({ config: {}, brain, bus: fakeBus(), vault: vaultFs });
  const agentActions = createAgentActions({ fs: vaultFs, pipeline, kanban, buildRunner, brain, webSearch, webFetch });

  return { dir, pipeline, kanban, buildRunner, agentActions };
}

function cleanup(env) { cleanupVaultDir(env.dir); }

describe('C1 wiring: a fallback-engine build must not reach the shipped stage', () => {
  it('brain-fallback engine + approving review -> stays in execute, status needs-work, evidence.pass false', async () => {
    const IDEA_TEXT = 'Build a simple pricing page';

    const env = setup((args) => {
      if (args.source && args.source.indexOf('build-runner:') === 0) {
        return {
          content: '<!DOCTYPE html><html><head><title>Pricing Page</title></head><body>pricing</body></html>',
          offline: false, parsed: null,
          engine: 'brain-fallback' // the real content came from the fallback engine
        };
      }
      if (args.source && args.source.indexOf('pipeline-grounded:') === 0) {
        return {
          content: '<!DOCTYPE html><html><head><title>Pricing Page</title></head><body>grounded pricing</body></html>',
          offline: false, parsed: null
        };
      }
      // Review approves outright -- the case the original `reviewed` gate missed.
      if (args.source === 'reviewer-agent') {
        return { content: '{"verdict":"approve","issues":[]}', offline: false, parsed: { verdict: 'approve', issues: [] } };
      }
      if (args.source === 'reality-check') {
        return { content: '{"verdict":"approve","issues":[]}', offline: false, parsed: { verdict: 'approve', issues: [] } };
      }
      if (args.source === 'visual-verify') {
        return { content: '{"match":true,"issues":[],"description":"looks fine"}', offline: false, parsed: { match: true, issues: [], description: 'looks fine' } };
      }
      return { content: '{}', offline: false, parsed: {} };
    });

    try {
      const card = env.pipeline.capture(IDEA_TEXT, 'test');
      env.pipeline.approve(card.id);

      const execResult = env.agentActions.executePipelineCard(card.id, null);
      const finishedJob = await waitForJobFinished(env.buildRunner, execResult.job.id);
      assert.equal(finishedJob.status, 'done', 'the job itself still ran to completion (BUG-016 meaning, unchanged)');
      assert.equal(finishedJob.reviewVerdict, 'approve', 'review genuinely approved this build');

      const cardAfterBuild = env.pipeline.findCard(card.id);
      assert.equal(cardAfterBuild.stage, 'execute',
        'a fallback-engine artifact must never reach shipped, even with an approving review');
      assert.equal(cardAfterBuild.card.status, 'needs-work');
      assert.equal(cardAfterBuild.card.reviewStatus, 'approved', 'the review verdict itself is reported honestly');
      assert.ok(cardAfterBuild.card.evidence === undefined || cardAfterBuild.card.evidence.pass === false,
        'evidence.pass must not read as true for a fallback-engine build');
    } finally {
      cleanup(env);
    }
  });
});

// Coordinator follow-up #2: the pull path (job_status, queried on demand by
// voice/dashboard) returned the raw job verbatim -- including job.status
// (BUG-016's "the job ran to completion" claim, left untouched here) -- with
// nothing telling the model that reviewVerdict/engine also matter. This pins
// that job_status's payload now carries the same derived fact the announcer
// already speaks, as an ADDITIONAL field (completionStatus), not a rename.
function fakeBuildRunnerWithJob(job) {
  return { getJob: (id) => (id === job.id ? job : null), listJobs: () => [job] };
}

describe('C1 pull-path: job_status carries the same completion fact the announcer speaks', () => {
  it('job.status stays "done" (BUG-016) while completionStatus reads needs-work on a rejected review', () => {
    const job = { id: 'job-x', status: 'done', reviewVerdict: 'reject', reviewIssues: ['bad'], engine: 'hermes' };
    const built = buildTools({ fs: {}, bus: fakeBus(), config: {}, buildRunner: fakeBuildRunnerWithJob(job) });
    const job_status = built.TOOLS.find((t) => t.name === 'job_status').fn;

    const result = job_status({ jobId: 'job-x' });
    assert.equal(result.ok, true);
    assert.equal(result.result.job.status, 'done', 'BUG-016 meaning of job.status must not be renamed/repurposed');
    assert.equal(result.result.job.completionStatus, 'needs-work');
  });

  it('completionStatus reads needs-work for a fallback-engine job even with an approved review', () => {
    const job = { id: 'job-y', status: 'done', reviewVerdict: 'approve', engine: 'brain-fallback' };
    const built = buildTools({ fs: {}, bus: fakeBus(), config: {}, buildRunner: fakeBuildRunnerWithJob(job) });
    const job_status = built.TOOLS.find((t) => t.name === 'job_status').fn;

    const result = job_status({ jobId: 'job-y' });
    assert.equal(result.result.job.status, 'done');
    assert.equal(result.result.job.completionStatus, 'needs-work');
  });

  it('completionStatus reads done for a real-engine, approved-review job', () => {
    const job = { id: 'job-z', status: 'done', reviewVerdict: 'approve', engine: 'hermes' };
    const built = buildTools({ fs: {}, bus: fakeBus(), config: {}, buildRunner: fakeBuildRunnerWithJob(job) });
    const job_status = built.TOOLS.find((t) => t.name === 'job_status').fn;

    const result = job_status({ jobId: 'job-z' });
    assert.equal(result.result.job.status, 'done');
    assert.equal(result.result.job.completionStatus, 'done');
  });

  it('the "most recent job" (no jobId) path also carries completionStatus', () => {
    const job = { id: 'job-w', status: 'done', reviewVerdict: 'reject', engine: 'hermes' };
    const built = buildTools({ fs: {}, bus: fakeBus(), config: {}, buildRunner: fakeBuildRunnerWithJob(job) });
    const job_status = built.TOOLS.find((t) => t.name === 'job_status').fn;

    const result = job_status({});
    assert.equal(result.result.job.completionStatus, 'needs-work');
  });
});
