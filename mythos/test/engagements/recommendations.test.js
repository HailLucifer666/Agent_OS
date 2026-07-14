'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createRecommendations } = require('../../src/core/engagements/recommendations');

describe('engagements/recommendations', () => {
  let recommendations;

  beforeEach(function() {
    recommendations = createRecommendations({ config: {} });
  });

  describe('generate', () => {
    it('returns empty array for null spec', async () => {
      var result = await recommendations.generate(null);
      assert.deepEqual(result, []);
    });

    it('generates recommendations from spec', async () => {
      var spec = { markdown: '# Build a CLI tool' };
      var result = await recommendations.generate(spec);
      assert.ok(Array.isArray(result));
      assert.ok(result.length > 0);
    });

    it('generates build recommendation for build spec', async () => {
      var spec = { markdown: '# Build an API with Node.js' };
      var result = await recommendations.generate(spec);
      assert.ok(result.some(function(r) { return r.type === 'build'; }));
    });

    it('generates research recommendation for research spec', async () => {
      var spec = { markdown: '# Research React patterns' };
      var result = await recommendations.generate(spec);
      assert.ok(result.some(function(r) { return r.type === 'research'; }));
    });

    it('generates hybrid when both indicators present', async () => {
      var spec = { markdown: '# Research and build React app' };
      var result = await recommendations.generate(spec);
      assert.ok(result.some(function(r) { return r.type === 'hybrid'; }));
    });
  });

  describe('select', () => {
    it('throws for invalid index', () => {
      var recs = [{ type: 'build' }];
      assert.throws(function() {
        recommendations.select(recs, 5);
      }, /out of range/);
    });

    it('selects recommendation by index', () => {
      var recs = [{ type: 'build' }, { type: 'research' }];
      var result = recommendations.select(recs, 1);
      assert.equal(result.type, 'research');
    });

    it('throws for missing recommendations array', () => {
      assert.throws(function() {
        recommendations.select(null, 0);
      }, /Recommendations array required/);
    });
  });

  describe('scoreConfidence', () => {
    it('returns 0 for null recommendation', () => {
      var result = recommendations.scoreConfidence(null);
      assert.equal(result, 0);
    });

    it('returns confidence value', () => {
      var rec = { confidence: 0.85 };
      var result = recommendations.scoreConfidence(rec);
      assert.equal(result, 0.85);
    });

    it('clamps confidence to 0-1', () => {
      var rec = { confidence: 1.5 };
      var result = recommendations.scoreConfidence(rec);
      assert.equal(result, 1);
    });
  });
});