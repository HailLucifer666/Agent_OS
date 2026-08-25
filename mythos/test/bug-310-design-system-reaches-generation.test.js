'use strict';

// test/bug-310-design-system-reaches-generation.test.js — BUG-310.
//
// THE BUG. agent-actions.js resolves a real design system (ui-ux-pro-max's
// scripts/search.py, via build-pack.resolveDesignSystemTool) and prepends it to
// `basePrompt` — but it does so INSIDE run(). build-runner.js calls run() at the
// very END of pump(), after:
//   1. the first generation                       (build-runner.js:188)
//   2. source verification and its retry          (:231-256)
//   3. the entire refine loop, every regeneration (:347)
// All of those use the string captured at enqueue(). JavaScript strings are
// values, so reassigning basePrompt inside run() cannot reach anything already
// generated. The only generations that CAN see it are the research-grounded
// rebuild (:581) and the review retry (:599).
//
// WHY NOT HYPOTHETICAL. On 2026-08-22 the AI-news-digest build was gated as
// risk=tiny-fix (BUG-309), so research was skipped and review was skipped. Both
// of the generations that could have read the design system therefore never ran,
// and a 30-second Python subprocess produced a full palette, an Inter font
// pairing and a live Google Fonts @import that were discarded in their entirety.
// The shipped page declares font-family 'Geist' and never loads it — an unloaded
// font falling back to the OS default is most of why the operator described the
// result as looking like an 1800s website.
//
// The code comment at agent-actions.js:506-511 asserts the opposite — "the
// grounded rebuild in run() prepends the real design system before the model
// sees the prompt" — which is true only on the research path, and was written
// as though it were true on all of them.
//
// WHAT THIS FILE PINS. That the design system reaches the FIRST generation, on
// every risk class, and that it survives into the refine regenerations — because
// a refine pass that rebuilds from a design-system-less prompt undoes the fix on
// the one path that exists to improve the artifact's appearance.

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
const buildPack = require('../src/core/skills/build-pack');
const riskClassifier = require('../src/core/effectors/risk-classifier');

// The marker the stubbed design-system tool emits. Long and unmistakable so a
// substring check cannot pass by accident.
const DS_MARKER = '### MYTHOS-TEST-DESIGN-SYSTEM-BLOCK ###';

// Stub resolveDesignSystemTool rather than let the real one run. Two reasons,
// both about the test being honest: the real tool shells out to Python and takes
// ~30s, and whether it is installed differs per machine — a test that passes
// only where ui-ux-pro-max happens to be present is not a test of this wiring.
// agent-actions.js looks the function up on the module object at call time, so
// replacing the export is a real seam, not a fiction.
function withStubbedDesignSystem(fn) {
  const original = buildPack.resolveDesignSystemTool;
  buildPack.resolveDesignSystemTool = async () => DS_MARKER + '\nPrimary: #78716C\nHeading: Inter';
  return (async () => {
    try { return await fn(); } finally { buildPack.resolveDesignSystemTool = original; }
  })();
}

function setup(opts) {
  const o = opts || {};
  const dir = tempVaultDir();
  const vaultFs = createFsStore(() => dir, null);
  nodeFs.mkdirSync(path.join(dir, 'builds', 'pipeline'), { recursive: true });
  nodeFs.mkdirSync(path.join(dir, 'builds', 'kanban'), { recursive: true });

  const brain = {
    think: async (args) => {
      if (args.source === 'reviewer-agent') {
        return { content: '{"verdict":"approve","issues":[]}', offline: false, parsed: { verdict: 'approve', issues: [] } };
      }
      if (args.source === 'reality-check') {
        return { content: '{"verdict":"approve","issues":[]}', offline: false, parsed: { verdict: 'approve', issues: [] } };
      }
      if (args.source === 'visual-verify') {
        return { content: '{"match":true,"issues":[],"description":"ok"}', offline: false, parsed: { match: true, issues: [], description: 'ok' } };
      }
      return { content: '<!DOCTYPE html><title>Pet Shop Landing Page</title><body>BRAIN</body>', offline: false, parsed: null };
    },
  };

  // Records the full prompt of every content generation, in order.
  const engineCalls = [];
  const buildEngine = {
    generate: async (args) => {
      engineCalls.push(args);
      return {
        content: '<!DOCTYPE html><title>Pet Shop Landing Page</title><body>ENGINE '
          + engineCalls.length + '</body>',
        engine: 'dsh',
        offline: false,
      };
    },
  };

  // Only constructed when a test asks for it — an always-failing critique, so
  // the refine loop regenerates and we can inspect that regeneration's prompt.
  const refiner = o.refine ? {
    available: () => true,
    unavailableReason: () => 'not applicable',
    looksRenderable: () => true,
    render: async () => ({
      ok: true, screenshotB64: '', screenshotPath: null,
      consoleErrors: [], pageErrors: [], observations: null,
    }),
    critique: async () => ({ pass: false, verdict: 'FAIL', issues: ['looks too plain'], model: 'fake-vision' }),
  } : undefined;

  // The classifier is REQUIRED for a faithful harness. pipeline.js:50 reads
  // `risk: classifier ? classifier.classify(text) : 'feature'`, so a pipeline
  // built without one stamps every card 'feature' — which silently turns the
  // research gate on and made the first draft of this test measure a path it
  // was not trying to measure. Also confirms BUG-309's fix lands on the field
  // that is actually persisted, rather than on a classify() nobody calls.
  const pipeline = createPipelineEffector({ fs: vaultFs, classifier: riskClassifier });
  const kanban = createKanbanEffector({ fs: vaultFs });
  const webSearch = async () => ({
    ok: true,
    result: { results: [{ title: 'Result', url: 'https://example.com/a', snippet: 'snippet text' }] },
  });
  const webFetch = async () => ({ ok: true, result: { content: 'fetched body' } });

  const buildRunner = createBuildRunner({
    config: { BUILD_REFINE_MAX_ITERATIONS: 1 },
    brain, bus: fakeBus(), vault: vaultFs, buildEngine, refiner,
  });
  const agentActions = createAgentActions({
    // designSystem is a dependency-present FLAG, not a UI check — passing it is
    // what production does (main.js), and what every existing test omitted,
    // which is why none of them could see this defect.
    fs: vaultFs, pipeline, kanban, buildRunner, brain, buildEngine, webSearch, webFetch,
    designSystem: true,
  });

  return { dir, vaultFs, pipeline, kanban, buildRunner, agentActions, engineCalls };
}

function promptsContaining(engineCalls, marker) {
  return engineCalls.map((c, i) => ({ i, has: String(c.prompt || '').includes(marker) }));
}

describe('BUG-310 — the resolved design system reaches the model', () => {
  it('reaches the FIRST generation on a tiny-fix build (no research, no review)', async () => {
    await withStubbedDesignSystem(async () => {
      const env = setup();
      try {
        // 'typo' makes this tiny-fix, which is exactly the shipped card's class:
        // research skipped, review skipped, so neither of the two generations
        // that HEAD lets see the design system ever runs.
        const card = env.pipeline.capture('fix a typo on the pet shop landing page', 'test');
        env.pipeline.approve(card.id);
        const jobId = env.agentActions.executePipelineCard(card.id, null).job.id;
        await waitForJobFinished(env.buildRunner, jobId);

        assert.ok(env.engineCalls.length >= 1, 'the build must have generated at least once');
        assert.ok(String(env.engineCalls[0].prompt).includes(DS_MARKER),
          'the first generation was made without the design system: '
          + JSON.stringify(promptsContaining(env.engineCalls, DS_MARKER)));
      } finally { cleanupVaultDir(env.dir); }
    });
  });

  it('reaches the FIRST generation on a feature build too, not only the rebuild', async () => {
    await withStubbedDesignSystem(async () => {
      const env = setup();
      try {
        const card = env.pipeline.capture('Build a landing page for a pet shop, dark premium theme', 'test');
        env.pipeline.approve(card.id);
        const jobId = env.agentActions.executePipelineCard(card.id, null).job.id;
        await waitForJobFinished(env.buildRunner, jobId);

        assert.ok(String(env.engineCalls[0].prompt).includes(DS_MARKER),
          'HEAD only prepends the design system for the grounded rebuild, so call 0 is blind: '
          + JSON.stringify(promptsContaining(env.engineCalls, DS_MARKER)));
      } finally { cleanupVaultDir(env.dir); }
    });
  });

  it('survives into the refine regeneration', async () => {
    await withStubbedDesignSystem(async () => {
      const env = setup({ refine: true });
      try {
        const card = env.pipeline.capture('fix a typo on the pet shop landing page', 'test');
        env.pipeline.approve(card.id);
        const jobId = env.agentActions.executePipelineCard(card.id, null).job.id;
        const job = await waitForJobFinished(env.buildRunner, jobId);

        // The critique always fails, so the loop regenerates once.
        assert.ok((job.refinePasses || []).length >= 1, 'the refine loop must have run');
        assert.ok(env.engineCalls.length >= 2, 'a refine regeneration must have happened');
        const refineCall = env.engineCalls.find((c) => /build-runner-refine/.test(String(c.source || '')));
        assert.ok(refineCall, 'expected a build-runner-refine generation');
        assert.ok(String(refineCall.prompt).includes(DS_MARKER),
          'the refine regeneration rebuilt from the original design-system-less prompt, '
          + 'undoing the fix on the one path meant to improve appearance');
      } finally { cleanupVaultDir(env.dir); }
    });
  });

  it('a kanban card build gets it on the first generation as well', async () => {
    await withStubbedDesignSystem(async () => {
      const env = setup();
      try {
        const created = env.kanban.addCards([{ title: 'Pet Shop Landing Page', detail: 'fix a typo, dark theme' }], 'backlog');
        const cardId = created[0].id;
        const jobId = env.agentActions.buildKanbanCard(cardId, null).job.id;
        await waitForJobFinished(env.buildRunner, jobId);

        assert.ok(env.engineCalls.length >= 1, 'the kanban build must have generated at least once');
        assert.ok(String(env.engineCalls[0].prompt).includes(DS_MARKER),
          'buildKanbanCard has the identical late-prepend shape: '
          + JSON.stringify(promptsContaining(env.engineCalls, DS_MARKER)));
      } finally { cleanupVaultDir(env.dir); }
    });
  });

  it('records on the job whether the prompt was actually prepared', async () => {
    // The reason this bug survived so long is that a DISCARDED design system
    // looked exactly like one that was never resolved. Both states are now
    // written down, so the degraded path is visible instead of inferred.
    await withStubbedDesignSystem(async () => {
      const env = setup();
      try {
        const card = env.pipeline.capture('fix a typo on the pet shop landing page', 'test');
        env.pipeline.approve(card.id);
        const jobId = env.agentActions.executePipelineCard(card.id, null).job.id;
        const job = await waitForJobFinished(env.buildRunner, jobId);
        assert.equal(job.promptPrepared, true);
      } finally { cleanupVaultDir(env.dir); }
    });
  });

  it('a thrown preparePrompt degrades honestly: build proceeds, anomaly emitted', async () => {
    const original = buildPack.resolveDesignSystemTool;
    // Throw from inside the resolver. design-system-prompt catches it and
    // returns the prompt unchanged, so promptPrepared must read false rather
    // than the build silently looking like it had guidance.
    buildPack.resolveDesignSystemTool = async () => { throw new Error('search.py exploded'); };
    const env = setup();
    try {
      const card = env.pipeline.capture('fix a typo on the pet shop landing page', 'test');
      env.pipeline.approve(card.id);
      const jobId = env.agentActions.executePipelineCard(card.id, null).job.id;
      const job = await waitForJobFinished(env.buildRunner, jobId);
      assert.equal(job.status, 'done', 'a broken design-system resolver must not fail the build');
      assert.equal(job.promptPrepared, false, 'and it must not claim the prompt was prepared');
    } finally {
      buildPack.resolveDesignSystemTool = original;
      cleanupVaultDir(env.dir);
    }
  });

  it('a build with no design system available still runs and is not blocked', async () => {
    // The design system is an enhancement, never a gate. If the tool and the
    // fallback both come back empty the build must proceed — otherwise this fix
    // converts a cosmetic weakness into an outage.
    const original = buildPack.resolveDesignSystemTool;
    buildPack.resolveDesignSystemTool = async () => null;
    const env = setup();
    try {
      const card = env.pipeline.capture('fix a typo on the pet shop landing page', 'test');
      env.pipeline.approve(card.id);
      const jobId = env.agentActions.executePipelineCard(card.id, null).job.id;
      const job = await waitForJobFinished(env.buildRunner, jobId);
      assert.equal(job.status, 'done', 'a missing design system must not fail the build');
    } finally {
      buildPack.resolveDesignSystemTool = original;
      cleanupVaultDir(env.dir);
    }
  });
});
