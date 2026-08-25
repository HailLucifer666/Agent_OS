'use strict';

// build-single-engine-regeneration.test.js — every content generation in a
// pipeline/kanban build goes through the ONE build engine.
//
// THE BUG THIS FILE EXISTS FOR (found 2026-07-31).
// commit 37953ca made Hermes-Agent the single build-content engine "so there is
// one engine with one behaviour", because the brain-backed generators had a
// documented habit of inventing titles and topics — the fabricated
// "Week of November 20, 2023" landing page quoted in build-engine.js's header,
// and live job failures like a "DESIGN SYSTEM" spec that shipped as
// "Kinetic Depth | Parallax Engine".
//
// That commit wired build-runner.js and the engagement executor. It never
// touched agent-actions.js. So the FIRST draft came from Hermes and was then
// OVERWRITTEN by a direct brain.think({lane:'build'}) call in two places:
//   * the research-grounded regeneration, and
//   * the review-rejection retry.
// Both fire for risk='feature', which risk-classifier.js assigns to nearly every
// real request — "landing page", "dashboard", and the verbs build/create/design.
// The net effect: the operator's shipped artifact came from the exact engine the
// swap existed to retire, which is why "I asked for X and got Y" survived it.
//
// These tests assert the regenerations route through buildEngine.generate(), and
// that brain.think is never used for build CONTENT when an engine is present.
// brain legitimately stays in use for the review/reality-check/visual machinery.

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

// Sources that generate ARTIFACT CONTENT, as opposed to the review/verify
// machinery that legitimately reasons with the brain.
//
// BUG-329 UPDATED THIS FILE'S SUBJECT, NOT ITS THESIS. The grounded
// regeneration this file was written around no longer exists: research moved
// into the preparePrompt hook, so the FIRST generation is the grounded one and
// `pipeline-grounded:` / `kanban-grounded:` are never emitted. The thesis —
// every artifact byte comes from the build engine and brain.think never
// generates content — is unchanged, and the assertions now make it at the first
// generation. The two dead tags stay in this pattern deliberately: if either
// ever reappears it is a content generation and must be counted.
const CONTENT_SOURCE_RE = /^(build-runner:|pipeline-grounded:|pipeline-retry:|kanban-grounded:|kanban-retry:)/;

function setup(opts) {
  const o = opts || {};
  const dir = tempVaultDir();
  const vaultFs = createFsStore(() => dir, null);
  nodeFs.mkdirSync(path.join(dir, 'builds', 'pipeline'), { recursive: true });
  nodeFs.mkdirSync(path.join(dir, 'builds', 'kanban'), { recursive: true });

  const brainCalls = [];
  const brain = {
    think: async (args) => {
      brainCalls.push(args);
      if (args.source === 'reviewer-agent') {
        const verdict = o.reject ? 'reject' : 'approve';
        const issues = o.reject ? ['Missing dark theme CSS'] : [];
        return { content: JSON.stringify({ verdict, issues }), offline: false, parsed: { verdict, issues } };
      }
      if (args.source === 'reality-check') {
        return { content: '{"verdict":"approve","issues":[]}', offline: false, parsed: { verdict: 'approve', issues: [] } };
      }
      if (args.source === 'visual-verify') {
        return { content: '{"match":true,"issues":[],"description":"ok"}', offline: false, parsed: { match: true, issues: [], description: 'ok' } };
      }
      // Anything else would be build CONTENT — the bug. Titled to satisfy the
      // verifier's spec-word check so a failure here is attributed to the
      // routing under test, not to the verifier rejecting the fixture.
      return {
        content: '<!DOCTYPE html><title>Pet Shop Landing Page</title><body>FROM BRAIN</body>',
        offline: false,
        parsed: null,
      };
    },
  };

  const engineCalls = [];
  const buildEngine = {
    generate: async (args) => {
      engineCalls.push(args);
      const n = engineCalls.length;
      // The title must contain spec words or build-runner's verifier rejects the
      // artifact — that check is real and independent of what this file tests.
      return {
        content: '<!DOCTYPE html><title>Pet Shop Landing Page</title><body>FROM HERMES ' + n + '</body>',
        engine: 'hermes',
        offline: false,
      };
    },
  };

  const pipeline = createPipelineEffector({ fs: vaultFs });
  const kanban = createKanbanEffector({ fs: vaultFs });
  const webSearch = async () => ({
    ok: true,
    result: { results: [{ title: 'Result', url: 'https://example.com/a', snippet: 'snippet text' }] },
  });
  const webFetch = async () => ({ ok: true, result: { content: 'fetched body' } });

  const buildRunner = createBuildRunner({ config: {}, brain, bus: fakeBus(), vault: vaultFs, buildEngine });
  const agentActions = createAgentActions({
    fs: vaultFs, pipeline, kanban, buildRunner, brain, buildEngine, webSearch, webFetch,
  });

  return { dir, vaultFs, pipeline, kanban, buildRunner, agentActions, brainCalls, engineCalls };
}

function contentBrainCalls(env) {
  return env.brainCalls.filter((c) => CONTENT_SOURCE_RE.test(String(c.source || '')));
}

describe('builds use one engine end to end (no brain.think for content)', () => {
  it('the research brief reaches the FIRST engine generation, through no other engine', async () => {
    const env = setup();
    try {
      // "landing page" classifies as risk=feature, which is what turns the
      // research gate on.
      const card = env.pipeline.capture('Build a landing page for a pet shop, dark premium theme', 'test');
      env.pipeline.approve(card.id);
      const jobId = env.agentActions.executePipelineCard(card.id, null).job.id;
      const job = await waitForJobFinished(env.buildRunner, jobId);
      assert.equal(job.status, 'done');

      // BUG-329: the grounded generation is now the FIRST one, not a rebuild
      // after it. Before the move, the verifier judged the ungrounded draft and
      // the grounded rebuild shipped without ever passing the gate.
      const first = env.engineCalls[0];
      assert.ok(first, 'no generation happened at all');
      assert.match(String(first.source), /^build-runner:/, 'source was ' + first.source);
      assert.match(first.prompt, /pet shop/, 'the spec must survive into the prompt');
      assert.match(first.prompt, /example\.com|snippet text|fetched body/,
        'the research brief must be in the FIRST prompt, otherwise grounding is theatre');
      assert.equal(job.researchStatus, 'grounded');

      const grounded = env.engineCalls.filter((c) => /-grounded:/.test(String(c.source)));
      assert.deepEqual(grounded, [],
        'the second, post-verification generation is gone — one draft, grounded, verified');

      assert.deepEqual(contentBrainCalls(env), [],
        'brain.think must never generate build content when an engine is present');

      const artifactPath = job.artifact && job.artifact.path;
      assert.ok(artifactPath, 'a finished job must carry an artifact path');
      // artifact.path is a /vault/... URL for the dashboard; the store wants a
      // vault-relative path (same strip fullReview() does).
      const html = env.vaultFs.readText(String(artifactPath).replace(/^\/vault\//, ''), '');
      assert.match(html, /FROM HERMES/, 'the shipped artifact must be the engine output');
      assert.doesNotMatch(html, /FROM BRAIN/);
    } finally { cleanupVaultDir(env.dir); }
  });

  it('the review-rejection retry also goes through the build engine', async () => {
    const env = setup({ reject: true });
    try {
      const card = env.pipeline.capture('Build a landing page for a pet shop, dark premium theme', 'test');
      env.pipeline.approve(card.id);
      const jobId = env.agentActions.executePipelineCard(card.id, null).job.id;
      const job = await waitForJobFinished(env.buildRunner, jobId);
      assert.equal(job.status, 'done', 'a rejected review still completes the job, flagged');

      const retries = env.engineCalls.filter((c) => String(c.source).indexOf('pipeline-retry:') === 0);
      assert.equal(retries.length, 1, 'the retry must call buildEngine.generate exactly once');
      assert.match(retries[0].prompt, /rejected by review/, 'the retry prompt must carry the review issues');
      assert.match(retries[0].prompt, /Missing dark theme CSS/);
      assert.deepEqual(contentBrainCalls(env), [], 'the retry must not fall back to brain.think');
    } finally { cleanupVaultDir(env.dir); }
  });

  it('the kanban builder routes its regeneration through the engine and keeps its persona', async () => {
    const env = setup();
    try {
      // addCards (plural) is the shape that carries a detail field; addCard
      // takes a bare title string.
      const card = env.kanban.addCards([{
        title: 'Build a landing page for a pet shop',
        detail: 'Dark premium theme with a hero section',
      }])[0];
      const jobId = env.agentActions.buildKanbanCard(card.id).job.id;
      await waitForJobFinished(env.buildRunner, jobId);

      // BUG-329: same move as the pipeline test above — the grounded generation
      // is the first one, so that is where these assertions belong.
      const first = env.engineCalls[0];
      assert.ok(first, 'no generation happened at all');
      assert.match(String(first.source), /^build-runner:/, 'source was ' + first.source);
      assert.match(first.prompt, /pet shop/);
      assert.match(first.prompt, /example\.com|snippet text|fetched body/,
        'the kanban research brief must reach the first prompt too');
      // The build engine has no persona parameter, so the builder voice must be
      // folded into the prompt rather than silently dropped on the way through.
      assert.ok(first.prompt.length > 200, 'persona + base prompt must both reach the engine');
      assert.deepEqual(env.engineCalls.filter((c) => /-grounded:/.test(String(c.source))), []);
      assert.deepEqual(contentBrainCalls(env), []);
    } finally { cleanupVaultDir(env.dir); }
  });

  it('with no engine injected, content still generates via the brain (back-compat for unit callers)', async () => {
    // Older tests and any caller that wires no engine must keep working rather
    // than silently producing nothing.
    const dir = tempVaultDir();
    try {
      const vaultFs = createFsStore(() => dir, null);
      nodeFs.mkdirSync(path.join(dir, 'builds', 'pipeline'), { recursive: true });
      const calls = [];
      const brain = {
        think: async (args) => {
          calls.push(args);
          if (args.source === 'reviewer-agent') return { content: '{"verdict":"approve","issues":[]}', offline: false, parsed: { verdict: 'approve', issues: [] } };
          if (args.source === 'reality-check') return { content: '{"verdict":"approve","issues":[]}', offline: false, parsed: { verdict: 'approve', issues: [] } };
          if (args.source === 'visual-verify') return { content: '{"match":true,"issues":[],"description":"ok"}', offline: false, parsed: { match: true, issues: [], description: 'ok' } };
          return { content: '<!DOCTYPE html><title>Pet Shop Landing Page</title>', offline: false, parsed: null };
        },
      };
      const pipeline = createPipelineEffector({ fs: vaultFs });
      const kanban = createKanbanEffector({ fs: vaultFs });
      const buildRunner = createBuildRunner({ config: {}, brain, bus: fakeBus(), vault: vaultFs });
      const agentActions = createAgentActions({
        fs: vaultFs, pipeline, kanban, buildRunner, brain,
        webSearch: async () => ({ ok: true, result: { results: [{ title: 'r', url: 'https://example.com/a', snippet: 's' }] } }),
        webFetch: async () => ({ ok: true, result: { content: 'body' } }),
      });

      const card = pipeline.capture('Build a landing page for a pet shop', 'test');
      pipeline.approve(card.id);
      const jobId = agentActions.executePipelineCard(card.id, null).job.id;
      const job = await waitForJobFinished(buildRunner, jobId);
      assert.equal(job.status, 'done');
      // BUG-329: there is no separate grounded rebuild to look for any more. The
      // back-compat claim this test makes is that a caller wiring no engine still
      // gets its content generated — through the brain, on the build-runner
      // source, with the research brief in it.
      const content = calls.filter((c) => String(c.source).indexOf('build-runner:') === 0);
      assert.ok(content.length >= 1, 'without an engine the brain must still generate the content');
      assert.match(String(content[0].messages[0].content), /example\.com|body/,
        'and it must still be grounded in the research');
    } finally { cleanupVaultDir(dir); }
  });
});
