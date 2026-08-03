'use strict';

// Phase B — the four engagement-layer content-generation sites (interview
// question generation, spec markdown, plan stages, executor research stages)
// must route through buildEngine (Hermes-Agent, the single build-content
// engine — see src/core/effectors/build-engine.js) instead of brain.think,
// mirroring the pattern already used at executor.js's build stage
// (runBuildStage, L293-324). These tests assert: buildEngine wired → it is
// called and brain.think is NOT; buildEngine absent → the brain.think
// fallback still runs (existing tests wire brain only and must keep working).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createInterview } = require('../../src/core/engagements/interview');
const { createSpecBuilder } = require('../../src/core/engagements/spec-builder');
const { createPlanBuilder } = require('../../src/core/engagements/plan-builder');
const { createEngagementExecutor } = require('../../src/core/engagements/executor');

// A buildEngine fake that records calls and returns brain.think-compatible
// shape ({content, offline, aborted, engine}) — see build-engine.js's header.
function fakeBuildEngine(content) {
  const calls = [];
  return {
    _calls: calls,
    generate: async function (opts) {
      calls.push(opts);
      return { content: content, offline: false, aborted: false, engine: 'fake' };
    }
  };
}

function fakeBrain(bySource) {
  const calls = [];
  return {
    _calls: calls,
    think: async function (opts) {
      calls.push(opts);
      const r = bySource[opts.source];
      if (!r) return { content: null, parsed: null, offline: true };
      if (r instanceof Error) throw r;
      return Object.assign({ offline: false }, r);
    }
  };
}

// ---- 1. interview.generateQuestionsBrain ----

describe('Phase B — interview routes through buildEngine', function () {
  it('calls buildEngine.generate and NOT brain.think when buildEngine is wired', async function () {
    const brain = fakeBrain({}); // would fall back to offline if called
    const engine = fakeBuildEngine(JSON.stringify({
      questions: [{ id: 'q-oauth', prompt: 'Which OAuth flow?', type: 'text' }]
    }));
    const iv = createInterview({ config: {}, brain: brain, buildEngine: engine });
    const qs = await iv.generateQuestionsBrain('spotify integration');
    assert.equal(engine._calls.length, 1);
    assert.equal(brain._calls.length, 0, 'brain.think must not be called when buildEngine is present');
    assert.equal(qs.length, 1);
    assert.equal(qs[0].id, 'q-oauth');
  });

  it('falls back to brain.think when buildEngine is absent', async function () {
    const brain = fakeBrain({
      'engagement:interview': { parsed: { questions: [{ id: 'q-x', prompt: 'X?', type: 'text' }] } }
    });
    const iv = createInterview({ config: {}, brain: brain });
    const qs = await iv.generateQuestionsBrain('x');
    assert.equal(brain._calls.length, 1);
    assert.equal(qs[0].id, 'q-x');
  });
});

// ---- 2. spec-builder.buildBrain ----

describe('Phase B — spec-builder routes through buildEngine', function () {
  function sampleInterview() {
    return { questions: [{ id: 'q-type', prompt: 'Type?', answer: 'CLI tool' }] };
  }

  it('calls buildEngine.generate and NOT brain.think when buildEngine is wired', async function () {
    const brain = fakeBrain({});
    const engine = fakeBuildEngine('## Enriched Spec\n\nDetail about the deliverable and acceptance criteria.');
    const sb = createSpecBuilder({ config: {}, brain: brain, buildEngine: engine });
    const spec = await sb.buildBrain(sampleInterview());
    assert.equal(engine._calls.length, 1);
    assert.equal(brain._calls.length, 0);
    assert.ok(spec.markdown.indexOf('Enriched Spec') !== -1);
  });

  it('falls back to brain.think when buildEngine is absent', async function () {
    const brain = fakeBrain({
      'engagement:spec': { content: '## Brain Spec\n\nEnough content to pass the length gate here.' }
    });
    const sb = createSpecBuilder({ config: {}, brain: brain });
    const spec = await sb.buildBrain(sampleInterview());
    assert.equal(brain._calls.length, 1);
    assert.ok(spec.markdown.indexOf('Brain Spec') !== -1);
  });
});

// ---- 3. plan-builder.build (buildViaBrain) ----

describe('Phase B — plan-builder routes through buildEngine', function () {
  const spec = { markdown: '# Project Spec\n\nBuild a weather CLI.' };

  it('calls buildEngine.generate and NOT brain.think when buildEngine is wired', async function () {
    const brain = fakeBrain({});
    const engine = fakeBuildEngine(JSON.stringify([
      { id: 's1', name: 'Setup', kind: 'build', prompt: 'scaffold the project' }
    ]));
    const pb = createPlanBuilder({ config: {}, brain: brain, buildEngine: engine });
    const plan = await pb.build(spec, { brain: brain });
    assert.equal(engine._calls.length, 1);
    assert.equal(brain._calls.length, 0);
    assert.equal(plan.stages.length, 1);
    assert.equal(plan.stages[0].id, 's1');
  });

  it('falls back to brain.think when buildEngine is absent', async function () {
    const brain = fakeBrain({
      'engagement:plan': { content: JSON.stringify([{ id: 's1', name: 'Setup', kind: 'build', prompt: 'x' }]) }
    });
    const pb = createPlanBuilder({ config: {}, brain: brain });
    const plan = await pb.build(spec, { brain: brain });
    assert.equal(brain._calls.length, 1);
    assert.equal(plan.stages[0].id, 's1');
  });
});

// ---- 4. executor research stage ----

function noopBus() { return { emit: function () {}, subscribe: function () {} }; }
function noopStore() { return { transition: async function () { return { ok: true }; } }; }
function noopEngagementStore() { return { read: function () { return null; } }; }

describe('Phase B — executor research stage routes through buildEngine', function () {
  function makeExecutor(deps) {
    return createEngagementExecutor(Object.assign({
      bus: noopBus(),
      config: {},
      dispatchAction: async function () { return { ok: true }; },
      store: noopStore(),
      engagementStore: noopEngagementStore()
    }, deps));
  }

  it('calls buildEngine.generate and NOT brain.think when buildEngine is wired', async function () {
    const brain = fakeBrain({});
    const engine = fakeBuildEngine('Research findings as prose.');
    const executor = makeExecutor({ brain: brain, buildEngine: engine });
    const record = { id: 'eng-1', goalId: null };
    const stage = { id: 'r1', name: 'Research', kind: 'research', prompt: 'Gather info', verification: { type: 'research', claims: [] } };
    const outcome = await executor.runStage(record, stage);
    assert.equal(engine._calls.length, 1);
    assert.equal(brain._calls.length, 0, 'brain.think must not be called when buildEngine is present');
    assert.equal(outcome.ok, true);
  });

  it('falls back to brain.think when buildEngine is absent', async function () {
    const brain = fakeBrain({ 'engagement:eng-1:research:r1': { content: 'ok' } });
    const executor = makeExecutor({ brain: brain });
    const record = { id: 'eng-1', goalId: null };
    const stage = { id: 'r1', name: 'Research', kind: 'research', prompt: 'Gather info', verification: { type: 'research', claims: [] } };
    const outcome = await executor.runStage(record, stage);
    assert.equal(brain._calls.length, 1);
    assert.equal(outcome.ok, true);
  });
});
