'use strict';

// Phase 4 / Area E — V6 brain-driven engagement cognition.
//
// Pre-Phase-4: the engagement manager constructed interview/specBuilder/
// planBuilder with {config} only — the brain was never threaded through.
// plan-builder.js already supported an optional opts.brain seam, but it was
// unreachable in production. interview.js + spec-builder.js had no brain
// seam at all — every engagement got the canned 5 default questions and
// the deterministic markdown template. Spec calls this V6.
//
// Phase 4 fix: thread brain into all three builders. Each gains a
// *Brain() method that asks the brain for tailored output, with the
// canned template as honest-inert fallback when the brain is absent /
// offline / returns garbage.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createInterview } = require('../src/core/engagements/interview');
const { createSpecBuilder } = require('../src/core/engagements/spec-builder');
const { createPlanBuilder } = require('../src/core/engagements/plan-builder');

function fakeBrain(bySource) {
  return {
    think: async function (opts) {
      var r = bySource[opts.source];
      if (!r) return { content: null, parsed: null, offline: true };
      if (r instanceof Error) throw r;
      return Object.assign({ offline: false }, r);
    }
  };
}

describe('Phase 4 / Area E — interview.generateQuestionsBrain (V6)', function () {

  it('falls back to DEFAULT_QUESTIONS when brain is absent', async function () {
    var iv = createInterview({ config: { ENGAGEMENT_INTERVIEW_MAX_Q: 3 } });
    var qs = await iv.generateQuestionsBrain('build a spotify integration');
    assert.ok(Array.isArray(qs));
    assert.ok(qs.length > 0);
    assert.ok(qs.length <= 3);
    // Default questions have well-known ids
    assert.equal(qs[0].id, 'q-type');
  });

  it('falls back to DEFAULT_QUESTIONS when brain returns offline', async function () {
    var brain = { think: async function () { return { offline: true }; } };
    var iv = createInterview({ config: {}, brain: brain });
    var qs = await iv.generateQuestionsBrain('x');
    assert.ok(qs.length > 0);
    assert.equal(qs[0].id, 'q-type');
  });

  it('returns brain-tailored questions when the brain responds', async function () {
    var brain = fakeBrain({
      'engagement:interview': {
        parsed: {
          questions: [
            { id: 'q-oauth', prompt: 'Which OAuth flow?', type: 'choice', options: ['auth-code', 'implicit'] },
            { id: 'q-audio-api', prompt: 'Which audio API?', type: 'text' }
          ]
        }
      }
    });
    var iv = createInterview({ config: {}, brain: brain });
    var qs = await iv.generateQuestionsBrain('spotify integration');
    assert.equal(qs.length, 2);
    assert.equal(qs[0].id, 'q-oauth');
    assert.equal(qs[0].type, 'choice');
    assert.deepEqual(qs[0].options, ['auth-code', 'implicit']);
    assert.equal(qs[1].type, 'text');
  });

  it('falls back when brain returns empty questions array', async function () {
    var brain = fakeBrain({ 'engagement:interview': { parsed: { questions: [] } } });
    var iv = createInterview({ config: {}, brain: brain });
    var qs = await iv.generateQuestionsBrain('x');
    assert.ok(qs.length > 0);
    assert.equal(qs[0].id, 'q-type', 'empty brain response falls back to defaults');
  });

  it('falls back when brain throws (defensive)', async function () {
    var brain = fakeBrain({ 'engagement:interview': new Error('network down') });
    var iv = createInterview({ config: {}, brain: brain });
    var qs = await iv.generateQuestionsBrain('x');
    assert.ok(qs.length > 0);
    assert.equal(qs[0].id, 'q-type');
  });

});

describe('Phase 4 / Area E — specBuilder.buildBrain (V6)', function () {

  function sampleInterview() {
    return {
      questions: [
        { id: 'q-type', prompt: 'Type?', answer: 'CLI tool' },
        { id: 'q-stack', prompt: 'Stack?', answer: 'Node.js' }
      ]
    };
  }

  it('falls back to canned markdown when brain is absent', async function () {
    var sb = createSpecBuilder({ config: {} });
    var spec = await sb.buildBrain(sampleInterview());
    assert.ok(spec.markdown);
    assert.ok(spec.markdown.indexOf('# Project Spec') !== -1, 'canned template marker');
  });

  it('returns brain-enriched markdown when the brain responds', async function () {
    var brain = fakeBrain({
      'engagement:spec': { content: '## Enriched Spec\n\n- Edge case: handle SIGINT\n- Acceptance: passes all tests' }
    });
    var sb = createSpecBuilder({ config: {}, brain: brain });
    var spec = await sb.buildBrain(sampleInterview());
    assert.ok(spec.markdown.indexOf('Enriched Spec') !== -1);
    assert.ok(spec.markdown.indexOf('Edge case') !== -1);
    // recommendations + schema still come from the canned build
    assert.ok(Array.isArray(spec.recommendations));
  });

  it('falls back when brain returns too-short content', async function () {
    var brain = fakeBrain({ 'engagement:spec': { content: 'short' } });   // < 50 chars
    var sb = createSpecBuilder({ config: {}, brain: brain });
    var spec = await sb.buildBrain(sampleInterview());
    assert.ok(spec.markdown.indexOf('# Project Spec') !== -1, 'too-short brain response falls back');
  });

  it('falls back when brain is offline', async function () {
    var brain = { think: async function () { return { offline: true }; } };
    var sb = createSpecBuilder({ config: {}, brain: brain });
    var spec = await sb.buildBrain(sampleInterview());
    assert.ok(spec.markdown.indexOf('# Project Spec') !== -1);
  });

  it('preserves the canned build() shape (schema + recommendations untouched)', async function () {
    var brain = fakeBrain({ 'engagement:spec': { content: '## Brain-Driven\n\nLots of detail here about the project.' } });
    var sb = createSpecBuilder({ config: {}, brain: brain });
    var canned = await sb.build(sampleInterview());
    var brainDriven = await sb.buildBrain(sampleInterview());
    assert.deepEqual(brainDriven.schema, canned.schema);
    assert.deepEqual(brainDriven.recommendations, canned.recommendations);
    assert.notEqual(brainDriven.markdown, canned.markdown, 'markdown should differ');
  });

});

describe('Phase 4 / Area E — planBuilder brain seam already exists (V6)', function () {

  it('planBuilder.build accepts opts.brain and uses it when present', async function () {
    var brain = fakeBrain({
      'engagement:plan': {
        content: JSON.stringify([
          { id: 's1', name: 'Setup', kind: 'build', prompt: 'scaffold the project' },
          { id: 's2', name: 'Core', kind: 'build', prompt: 'implement the feature' }
        ])
      }
    });
    var pb = createPlanBuilder({ config: {}, brain: brain });
    var spec = { markdown: '# Project Spec\n\nSome content for the build.' };
    var plan = await pb.build(spec, { brain: brain });
    assert.ok(Array.isArray(plan.stages));
    assert.ok(plan.stages.length >= 1);
  });

  it('planBuilder.build falls back to canned stages when brain is offline', async function () {
    var pb = createPlanBuilder({ config: {} });
    var spec = { markdown: '# Project Spec\n\nSome content.' };
    var plan = await pb.build(spec);   // no brain passed
    assert.ok(Array.isArray(plan.stages));
    assert.ok(plan.stages.length >= 1);
    // Canned stages have well-known ids
    var ids = plan.stages.map(function (s) { return s.id; });
    assert.ok(ids.indexOf('stage-setup') !== -1 || ids.indexOf('stage-core') !== -1,
      'canned fallback stages must be present');
  });

});
