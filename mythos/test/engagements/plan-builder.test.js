'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createPlanBuilder } = require('../../src/core/engagements/plan-builder');

describe('engagements/plan-builder', () => {
  let planBuilder;

  beforeEach(function() {
    planBuilder = createPlanBuilder({ config: {} });
  });

  describe('build', () => {
    it('rejects spec without markdown', async () => {
      await assert.rejects(
        async () => planBuilder.build({}),
        /Spec with markdown required/
      );
    });

    it('builds plan from spec', async () => {
      var spec = { markdown: '# CLI Tool\n\nBuild a weather CLI' };
      var result = await planBuilder.build(spec);
      assert.ok(Array.isArray(result.stages));
      assert.ok(result.stages.length > 0);
      assert.equal(result.currentStageIndex, 0);
    });

    it('creates stages with required fields', async () => {
      var spec = { markdown: '# Test', recommendations: [{ type: 'build' }] };
      var result = await planBuilder.build(spec);
      var stage = result.stages[0];
      assert.ok(stage.id);
      assert.ok(stage.name);
      // Type may be build or research depending on spec
      assert.ok(['build', 'research'].indexOf(stage.type) !== -1);
      assert.ok(stage.prompt);
      assert.ok(stage.verification);
    });
  });

  describe('createStage', () => {
    it('creates stage with all fields', () => {
      var stage = planBuilder.createStage('test-1', 'Test Stage', 'build', 'Do something', { type: 'file' });
      assert.equal(stage.id, 'test-1');
      assert.equal(stage.name, 'Test Stage');
      assert.equal(stage.type, 'build');
      assert.equal(stage.prompt, 'Do something');
      assert.deepEqual(stage.verification, { type: 'file' });
    });
  });

  describe('addApprovalGate', () => {
    it('adds approval requirement to stage', () => {
      var stage = { id: 's-1', name: 'Test', type: 'build' };
      var gated = planBuilder.addApprovalGate(stage, true);
      assert.equal(gated.requiresApproval, true);
    });

    it('makes requiresApproval false when set', () => {
      var stage = { id: 's-1', name: 'Test', type: 'build', requiresApproval: true };
      var gated = planBuilder.addApprovalGate(stage, false);
      assert.equal(gated.requiresApproval, false);
    });
  });
});