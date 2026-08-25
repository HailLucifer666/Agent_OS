'use strict';

// test/bug-329-researched-build-uses-its-research.test.js
//
// THE BUG. The research gate lived inside run(). build-runner calls run() only
// after the first generation has been produced AND has passed the verifier — so
// a brief that CANNOT be satisfied without live data was rejected by the
// verifier and the research gate never executed at all. The gate that supplies
// the data ran after the gate that checks for it.
//
// WHY NOT HYPOTHETICAL. Measured 2026-08-23. Asked in one task to research this
// week's AI news and build a digest page, MYTHOS said it could not reach the web
// — honestly, because nothing had handed it anything — the verifier rejected
// that as not the requested landing page, the single retry failed the same way,
// and the job ended with no artifact. `web_search` was wired the whole time and
// works: called directly it returned five stories, the freshest three hours old.
// The capability was present, the ordering made it unreachable.
//
// A SECOND DEFECT FELL OUT OF THE SAME ORDERING, and it is the quieter one. When
// research DID run, run() regenerated the artifact with the brief and saved that
// regeneration — after verification. So on every researched build the artifact
// that shipped was not the artifact that was verified. The gate had judged a
// draft that was then thrown away.
//
// THE FIX uses the seam BUG-310 already built for exactly this shape:
// preparePrompt, awaited before the first generation, whose return value feeds
// the first draft, the verification retry and every refine regeneration. One
// grounded draft, verified, shipped. One fewer generation on the happy path.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const nodeFs = require('node:fs');

const { tempVaultDir, cleanupVaultDir, fakeBus, waitForJobFinished } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createPipelineEffector } = require('../src/core/effectors/pipeline');
const { createKanbanEffector } = require('../src/core/effectors/kanban');
const { createBuildRunner } = require('../src/core/effectors/build-runner');
const { createAgentActions } = require('../src/core/effectors/agent-actions');
const riskClassifier = require('../src/core/effectors/risk-classifier');
const groundingCheck = require('../src/core/effectors/grounding-check');

const STORY = {
  title: 'World leaders to attend the India-AI Impact Summit in New Delhi',
  url: 'https://news.example.invalid/india-ai-summit',
  snippet: 'Published 3h ago.',
};

// opts.search: 'ok' | 'empty' — whether web_search returns anything.
// opts.title: the <title> the fake engine emits. It has to share words with the
// card, or design/verify.js rejects the artifact for an invented brand name and
// the test measures the title check instead of the research gate.
function setup(opts) {
  const o = opts || {};
  const dir = tempVaultDir();
  const vaultFs = createFsStore(() => dir, null);
  nodeFs.mkdirSync(path.join(dir, 'builds', 'pipeline'), { recursive: true });
  nodeFs.mkdirSync(path.join(dir, 'builds', 'kanban'), { recursive: true });

  const brain = {
    think: async (args) => {
      if (args.source === 'reviewer-agent' || args.source === 'reality-check') {
        return { content: '{"verdict":"approve","issues":[]}', offline: false, parsed: { verdict: 'approve', issues: [] } };
      }
      if (args.source === 'visual-verify') {
        return { content: '{"match":true,"issues":[],"description":"ok"}', offline: false, parsed: { match: true, issues: [], description: 'ok' } };
      }
      return { content: '<!DOCTYPE html><title>AI News Digest</title><body>BRAIN</body>', offline: false, parsed: null };
    },
  };

  const engineCalls = [];
  const buildEngine = {
    generate: async (args) => {
      engineCalls.push(args);
      // The artifact cites whatever it was given, so grounding-check can judge it.
      const cited = /news\.example\.invalid/.test(String(args.prompt || ''))
        ? '<a href="' + STORY.url + '">' + STORY.title + '</a>' : '<p>no sources</p>';
      return {
        content: '<!DOCTYPE html><html><head><title>' + (o.title || 'AI News Digest') + '</title>'
          + '<meta name="viewport" content="width=device-width">'
          + '<style>@media(min-width:1px){body{font-size:16px}}h1{font-size:4rem}</style></head>'
          + '<body><h1>' + (o.title || 'AI News Digest') + '</h1>' + cited + '</body></html>',
        engine: 'dsh',
        offline: false,
      };
    },
  };

  const bus = fakeBus();
  const pipeline = createPipelineEffector({ fs: vaultFs, classifier: riskClassifier });
  const kanban = createKanbanEffector({ fs: vaultFs });

  const searchCalls = [];
  const webSearch = async (args) => {
    searchCalls.push(args);
    if (o.search === 'empty') return { ok: true, result: { query: args.query, results: [] } };
    // THE ENVELOPE SHAPE MATTERS AND IT COST TIME TODAY: web_search returns
    // { ok, result: { query, results } }. Reading r.results yields undefined and
    // looks like an honest "no coverage".
    return { ok: true, result: { query: args.query, results: [STORY] } };
  };
  const webFetch = async () => ({ ok: true, result: { content: 'Summit opens in New Delhi.' } });

  const buildRunner = createBuildRunner({ config: {}, brain, bus, vault: vaultFs, buildEngine });
  const agentActions = createAgentActions({
    fs: vaultFs, pipeline, kanban, buildRunner, brain, buildEngine, webSearch, webFetch, bus,
    designSystem: false,
  });

  return { dir, vaultFs, pipeline, kanban, buildRunner, agentActions, engineCalls, searchCalls, bus };
}

const ONE_SHOT_BRIEF =
  "Research the live web for today's AI news, pick five, and build a premium dark AI-digest landing page";

describe('BUG-329 — the research reaches the draft that gets verified', () => {
  it('puts the research in the FIRST generation, before the verifier sees anything', async () => {
    const env = setup();
    try {
      const card = env.pipeline.capture(ONE_SHOT_BRIEF, 'test');
      env.pipeline.approve(card.id);
      const jobId = env.agentActions.executePipelineCard(card.id, null).job.id;
      const job = await waitForJobFinished(env.buildRunner, jobId);

      assert.equal(job.status, 'done', job.error || '');
      assert.equal(env.searchCalls.length >= 1, true, 'web_search was never called');
      assert.match(String(env.engineCalls[0].source), /^build-runner:/);
      assert.match(env.engineCalls[0].prompt, /news\.example\.invalid/,
        'the FIRST prompt must carry the research brief — that is the whole bug');
      assert.equal(job.researchStatus, 'grounded');
    } finally { cleanupVaultDir(env.dir); }
  });

  it('ships exactly one grounded draft, not a verified draft plus an unverified rebuild', async () => {
    const env = setup();
    try {
      const card = env.pipeline.capture(ONE_SHOT_BRIEF, 'test');
      env.pipeline.approve(card.id);
      const jobId = env.agentActions.executePipelineCard(card.id, null).job.id;
      const job = await waitForJobFinished(env.buildRunner, jobId);
      assert.equal(job.status, 'done', job.error || '');

      // The old flow generated twice: an ungrounded draft for the verifier and a
      // grounded one to actually ship.
      assert.equal(env.engineCalls.length, 1,
        'sources: ' + env.engineCalls.map((c) => c.source).join(', '));
      const ungrounded = env.engineCalls.filter((c) => !/news\.example\.invalid/.test(String(c.prompt)));
      assert.deepEqual(ungrounded, [], 'no generation may run without the research');
    } finally { cleanupVaultDir(env.dir); }
  });

  // BUG-314's checker, pointed at the artifact this flow produces. It asserts a
  // grounded build actually cited its research rather than merely receiving it.
  it('the shipped artifact cites the research, by BUG-314\'s own checker', async () => {
    const env = setup();
    try {
      const card = env.pipeline.capture(ONE_SHOT_BRIEF, 'test');
      env.pipeline.approve(card.id);
      const jobId = env.agentActions.executePipelineCard(card.id, null).job.id;
      const job = await waitForJobFinished(env.buildRunner, jobId);
      assert.equal(job.status, 'done', job.error || '');

      const html = env.vaultFs.readText(String(job.artifact.path).replace(/^\/vault\//, ''), '');
      const issues = groundingCheck.checkGrounding(html, {
        spec: ONE_SHOT_BRIEF,
        sources: groundingCheck.sourcesFromBrief(job.researchBrief),
      });
      assert.deepEqual(issues, [], 'grounding issues: ' + issues.join(' | '));
    } finally { cleanupVaultDir(env.dir); }
  });
});

describe('BUG-329 — a brief that names live data is never built from nothing', () => {
  it('fails honestly when the search comes back empty, and ships no artifact', async () => {
    const env = setup({ search: 'empty' });
    try {
      const card = env.kanban.addCards([{
        title: 'AI news digest landing page',
        detail: "Five of today's biggest AI stories, premium dark theme",
      }])[0];
      const jobId = env.agentActions.buildKanbanCard(card.id).job.id;
      const job = await waitForJobFinished(env.buildRunner, jobId);

      assert.equal(job.status, 'failed');
      assert.match(job.error, /research gate failed/i);
      assert.match(job.error, /invented facts/i, 'the reason must say why, not just that');
      assert.equal(job.researchStatus, 'skipped');
      assert.equal(job.artifact, null, 'a refused build must leave no artifact behind');
      // And nothing was generated: the refusal happens before the engine is asked.
      assert.deepEqual(env.engineCalls, [],
        'a doomed job must not cost a generation — that was the old flow');
    } finally { cleanupVaultDir(env.dir); }
  });

  it('still builds a brief that never asked for live data, and says it was ungrounded', async () => {
    // OFFLINE MUST WORK. "build a snake game" classifies as a feature, so
    // research is nominally required — failing every such build when the network
    // is down would be far worse than building it and saying so. The kanban path
    // keeps the tolerance it already had.
    const env = setup({ search: 'empty', title: 'Playable Snake Game' });
    try {
      const card = env.kanban.addCards([{
        title: 'Build a playable snake game',
        detail: 'Single file, keyboard controls, dark theme',
      }])[0];
      const jobId = env.agentActions.buildKanbanCard(card.id).job.id;
      const job = await waitForJobFinished(env.buildRunner, jobId);

      assert.equal(job.status, 'done', job.error || '');
      assert.equal(job.researchStatus, 'skipped', 'the honest label, not "grounded"');
      assert.equal(env.engineCalls.length, 1);
      const anomalies = env.bus._emitted().filter((e) => e.type === 'health.anomaly'
        && e.payload && e.payload.kind === 'research-skipped');
      assert.equal(anomalies.length, 1, 'a skipped search must be said out loud on the bus');
      assert.match(anomalies[0].payload.reason, /no usable results/,
        'an anomaly with no reason is spoken as "I do not know the cause"');
    } finally { cleanupVaultDir(env.dir); }
  });

  it('a time word inside another word is not a live-data request', async () => {
    // 'live' inside "delivery" and 'current' inside "concurrent" are the
    // BUG-309/312 trap. The markers go through the shared whole-word matcher, so
    // this brief must build rather than be refused for a substring.
    const env = setup({ search: 'empty', title: 'Delivery Tracking Page' });
    try {
      const card = env.kanban.addCards([{
        title: 'Build a delivery tracking page',
        detail: 'Concurrent shipments, dark theme, no external data',
      }])[0];
      const job = await waitForJobFinished(env.buildRunner,
        env.agentActions.buildKanbanCard(card.id).job.id);
      assert.equal(job.status, 'done', job.error || '');
    } finally { cleanupVaultDir(env.dir); }
  });

  it('the pipeline keeps its stricter policy, and now pays for it before generating', async () => {
    // executePipelineCard already refused to ship a feature build with no
    // research. It refused AFTER a generation and a verification; now it refuses
    // first.
    const env = setup({ search: 'empty', title: 'Pet Shop Landing Page' });
    try {
      const card = env.pipeline.capture('Build a landing page for a pet shop, dark premium theme', 'test');
      env.pipeline.approve(card.id);
      const jobId = env.agentActions.executePipelineCard(card.id, null).job.id;
      const job = await waitForJobFinished(env.buildRunner, jobId);

      assert.equal(job.status, 'failed');
      assert.match(job.error, /research gate failed/i);
      assert.deepEqual(env.engineCalls, []);
    } finally { cleanupVaultDir(env.dir); }
  });
});

describe('BUG-329 — an absent capability is not an empty result', () => {
  // Class 7 out of the audit list: a plausible wrong value where an honest
  // unknown belonged. The first version of this fix reported "the search found
  // nothing" when there was no web_search effector wired at all, so the
  // pipeline's fatal-on-missing policy refused EVERY feature build for a search
  // that was never performed. It broke a real caller —
  // test/p18-goal-job-mapping.test.js constructs agent-actions without one — and
  // would break any deployment missing the effector.
  const research = require('../src/core/effectors/build-research');

  function jobRecord() { return {}; }

  it('reports "unavailable" and builds on, when nothing can be asked', async () => {
    const r = research.createBuildResearch({});           // no webSearch at all
    const job = jobRecord();
    const out = await r.researchIntoPrompt('PROMPT', job, 'Build a pet shop landing page', 'feature', true);
    assert.equal(job.researchStatus, 'unavailable',
      'not "skipped" — nothing was skipped, nothing could be attempted');
    assert.equal(out, 'PROMPT', 'the prompt must pass through untouched');
  });

  it('still refuses a live-data brief when there is nothing to ask', async () => {
    const r = research.createBuildResearch({});
    await assert.rejects(
      () => r.researchIntoPrompt('PROMPT', jobRecord(), "today's AI news digest", 'feature', false),
      (err) => {
        assert.match(err.message, /no web search available/);
        assert.equal(err.fatal, true, 'without .fatal build-runner treats it as cosmetic');
        return true;
      });
  });

  it('distinguishes the two states in what it emits', async () => {
    const seen = [];
    const bus = { emit: (type, payload) => seen.push({ type, payload }) };
    await research.createBuildResearch({ bus })
      .researchIntoPrompt('P', jobRecord(), 'a pet shop landing page', 'feature', false);
    await research.createBuildResearch({
      bus,
      webSearch: async () => ({ ok: true, result: { results: [] } }),
    }).researchIntoPrompt('P', jobRecord(), 'a pet shop landing page', 'feature', false);
    assert.deepEqual(seen.map((e) => e.payload.kind), ['research-unavailable', 'research-skipped']);
    assert.ok(seen.every((e) => e.payload.reason), 'an anomaly with no reason is spoken as "cause unknown"');
  });

  it('says not-required rather than anything else when the risk class needs no research', async () => {
    const job = jobRecord();
    await research.createBuildResearch({}).researchIntoPrompt('P', job, 'fix a typo', 'tiny-fix', true);
    assert.equal(job.researchStatus, 'not-required');
  });
});

describe('BUG-329 — the ordering fact that made the old placement useless', () => {
  it('run() is never reached when verification fails, so anything inside it cannot rescue a build', async () => {
    // Not a change — a pin. This is WHY research had to move: everything in
    // run() is downstream of the verifier, so a brief that needs research to
    // pass verification could never get it.
    const dir = tempVaultDir();
    try {
      const vaultFs = createFsStore(() => dir, null);
      let runCalls = 0;
      const runner = createBuildRunner({
        config: {},
        bus: fakeBus(),
        vault: vaultFs,
        buildEngine: { generate: async () => ({ content: 'I cannot reach the web.', engine: 'dsh' }) },
        verifier: { verify: async () => ({ pass: false, issues: ['not the requested HTML landing page'], warnings: [] }) },
      });
      const job = runner.enqueue({
        kind: 'test',
        prompt: 'research today and build a digest',
        run: async () => { runCalls += 1; return {}; },
      });
      const done = await waitForJobFinished(runner, job.id);

      assert.equal(done.status, 'failed');
      assert.match(done.error, /failed verification/);
      assert.equal(runCalls, 0,
        'run() executed after a failed verification — if this ever passes, research could have lived there');
    } finally { cleanupVaultDir(dir); }
  });
});
