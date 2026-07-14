'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  createSummary,
  summarizeSpec,
  summarizePlan
} = require('../../src/core/assistant/summary');

describe('assistant/summary', () => {
  describe('createSummary', () => {
    it('returns default for null engagement', () => {
      var result = createSummary(null);
      assert.equal(result.status, 'unknown');
      assert.equal(result.title, 'No engagement');
    });

    it('extracts title from spec markdown', () => {
      var eng = {
        id: 'eng-123',
        status: 'EXECUTING',
        spec: { markdown: '# My Project\n\nDetails here' },
        plan: { stages: [], currentStageIndex: 0 }
      };
      var result = createSummary(eng);
      assert.equal(result.title, 'My Project');
      assert.equal(result.status, 'EXECUTING');
    });

    it('calculates progress', () => {
      var eng = {
        id: 'eng-123',
        status: 'EXECUTING',
        plan: { stages: [{}, {}, {}], currentStageIndex: 2 },
        execution: { stageResults: [] }
      };
      var result = createSummary(eng);
      assert.equal(result.progress, 67); // 2/3 ~ 67%
    });

    it('counts stages', () => {
      var eng = {
        id: 'eng-123',
        plan: { stages: [{}, {}, {}] }
      };
      var result = createSummary(eng);
      assert.equal(result.stageCount, 3);
    });
  });

  describe('summarizeSpec', () => {
    it('returns summary of markdown', () => {
      var spec = { markdown: '# Title\n\nLong spec content here...' };
      var result = summarizeSpec(spec);
      assert.ok(result.includes('Title'));
    });

    it('returns default for null spec', () => {
      var result = summarizeSpec(null);
      assert.equal(result, 'No spec content');
    });
  });

  describe('summarizePlan', () => {
    it('counts build and research stages', () => {
      var plan = {
        stages: [
          { type: 'build', name: 'Setup' },
          { type: 'build', name: 'Core' },
          { type: 'research', name: 'Research' }
        ]
      };
      var result = summarizePlan(plan);
      assert.ok(result.includes('2 build'));
      assert.ok(result.includes('1 research'));
    });

    it('returns default for null plan', () => {
      var result = summarizePlan(null);
      assert.equal(result, 'No stages defined');
    });
  });
});