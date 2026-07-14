'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createSpecBuilder } = require('../../src/core/engagements/spec-builder');

describe('engagements/spec-builder', () => {
  let specBuilder;

  beforeEach(function() {
    specBuilder = createSpecBuilder({ config: {} });
  });

  describe('build', () => {
    it('throws without interview', async () => {
      await assert.rejects(
        async () => specBuilder.build(),
        /Interview data required/
      );
    });

    it('builds spec from interview answers', async () => {
      var interview = {
        questions: [
          { id: 'q-type', prompt: 'Type?', answer: 'CLI tool' },
          { id: 'q-stack', prompt: 'Stack?', answer: 'Node.js' }
        ]
      };
      var result = await specBuilder.build(interview);
      assert.ok(result.markdown);
      assert.ok(result.schema);
      assert.ok(Array.isArray(result.recommendations));
    });

    it('includes answers in markdown', async () => {
      var interview = {
        questions: [
          { id: 'q-type', prompt: 'Type?', answer: 'CLI tool' }
        ]
      };
      var result = await specBuilder.build(interview);
      assert.ok(result.markdown.includes('CLI tool'));
    });
  });

  describe('toMarkdown', () => {
    it('returns markdown from spec', () => {
      var spec = { markdown: '# My Spec', schema: {} };
      var result = specBuilder.toMarkdown(spec);
      assert.equal(result, '# My Spec');
    });
  });

  describe('toJsonSchema', () => {
    it('returns schema object', () => {
      var spec = { markdown: '# Test', schema: { type: 'object' } };
      var result = specBuilder.toJsonSchema(spec);
      assert.deepEqual(result, { type: 'object' });
    });
  });
});