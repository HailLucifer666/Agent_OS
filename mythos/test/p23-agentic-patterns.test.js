'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { classify, gatePath, requiresReview, requiresResearch, requiresVisual, createRiskClassifier } = require('../src/core/effectors/risk-classifier');
const { createEvidenceValidator } = require('../src/core/effectors/evidence-validator');
const { scan, createCredentialScanner } = require('../src/core/effectors/credential-scanner');

describe('P23: Risk Classifier', () => {
  it('classifies typo fixes as tiny-fix', () => {
    assert.equal(classify('fix a typo'), 'tiny-fix');
    assert.equal(classify('rename variable'), 'tiny-fix');
    assert.equal(classify('quick fix for color'), 'tiny-fix');
  });

  it('classifies refactors as architecture-change', () => {
    assert.equal(classify('refactor the auth module'), 'architecture-change');
    assert.equal(classify('redesign the UI'), 'architecture-change');
    assert.equal(classify('migrate database'), 'architecture-change');
  });

  it('classifies new builds as feature', () => {
    assert.equal(classify('build a landing page'), 'feature');
    assert.equal(classify('create a dashboard'), 'feature');
  });

  it('classifies modifications as quick-win', () => {
    assert.equal(classify('update the text'), 'quick-win');
    assert.equal(classify('add a button'), 'quick-win');
  });

  it('defaults to feature for ambiguous text', () => {
    assert.equal(classify('something'), 'feature');
    assert.equal(classify(''), 'feature');
    assert.equal(classify(null), 'feature');
  });

  it('gatePath returns correct phases per risk class', () => {
    assert.deepEqual(gatePath('tiny-fix'), ['artifact']);
    assert.deepEqual(gatePath('quick-win'), ['artifact', 'verify']);
    assert.deepEqual(gatePath('feature'), ['research', 'artifact', 'visual', 'review']);
    // 'adr' was removed from this path on 2026-08-20. It was declared here and
    // enforced nowhere — evidence-validator.js's adr block held only comments —
    // and nothing in the repo produces an ADR artifact, so enforcing it would
    // have deadlocked every architecture-change card. The disposition and its
    // revisit trigger live in test/evidence-gate-visual-and-adr.test.js.
    assert.deepEqual(gatePath('architecture-change'), ['research', 'artifact', 'visual', 'review']);
  });

  it('requiresReview/research/visual flags are correct', () => {
    assert.ok(!requiresReview('tiny-fix'));
    assert.ok(!requiresResearch('tiny-fix'));
    assert.ok(!requiresVisual('tiny-fix'));

    assert.ok(requiresReview('feature'));
    assert.ok(requiresResearch('feature'));
    assert.ok(requiresVisual('feature'));

    assert.ok(requiresReview('architecture-change'));
    assert.ok(requiresResearch('architecture-change'));
    assert.ok(requiresVisual('architecture-change'));
  });

  it('createRiskClassifier returns working instance', () => {
    var c = createRiskClassifier();
    assert.equal(typeof c.classify, 'function');
    assert.equal(c.classify('fix typo'), 'tiny-fix');
  });
});

describe('P23: Evidence Validator', () => {
  var ev = createEvidenceValidator();

  it('passes when all required phases have evidence', () => {
    var result = ev.verify({
      card: { id: 'test' },
      artifact: { path: '/vault/builds/test.html' },
      review: { verdict: 'approve', issues: [] },
      job: { _reviewRetried: false },
      requiredPhases: ['artifact', 'review']
    });
    assert.ok(result.pass);
    assert.equal(result.missing.length, 0);
  });

  it('fails when artifact is missing', () => {
    var result = ev.verify({
      card: {},
      artifact: null,
      review: null,
      job: {},
      requiredPhases: ['artifact']
    });
    assert.ok(!result.pass);
    assert.ok(result.missing.includes('no artifact produced'));
  });

  it('fails when review is missing for feature risk', () => {
    var result = ev.verify({
      card: {},
      artifact: { path: '/test.html' },
      review: null,
      job: {},
      requiredPhases: ['artifact', 'review']
    });
    assert.ok(!result.pass);
    assert.ok(result.missing.includes('no review recorded'));
  });

  it('fails when review rejected but no retry attempted', () => {
    var result = ev.verify({
      card: {},
      artifact: { path: '/test.html' },
      review: { verdict: 'reject', issues: ['bad'] },
      job: { _reviewRetried: false },
      requiredPhases: ['artifact', 'review']
    });
    assert.ok(!result.pass);
    assert.ok(result.missing.some(function(m) { return m.includes('retry'); }));
  });

  it('passes tiny-fix with only artifact (no review needed)', () => {
    var result = ev.verify({
      card: { risk: 'tiny-fix' },
      artifact: { path: '/test.html' },
      review: null,
      job: {},
      requiredPhases: ['artifact']
    });
    assert.ok(result.pass);
  });
});

describe('P23: Credential Scanner', () => {
  it('detects AWS access key', () => {
    var result = scan({ data: 'AKIAIOSFODNN7EXAMPLE' });
    assert.ok(result.found);
    assert.equal(result.matches[0].name, 'aws-access-key');
  });

  it('detects GitHub token', () => {
    // Use string concat so secret scanners don't flag the test file
    var fakeToken = 'ghp' + '_1234567890abcdefghijklmnopqrstuvwxyz';
    var result = scan({ key: fakeToken });
    assert.ok(result.found);
    assert.equal(result.matches[0].name, 'github-token');
  });

  it('detects Slack token', () => {
    // Use string concat so secret scanners don't flag the test file
    var fakeToken = 'xoxb' + '-1234567890-abcdef';
    var result = scan({ webhook: fakeToken });
    assert.ok(result.found);
    assert.equal(result.matches[0].name, 'slack-token');
  });

  it('detects Stripe key', () => {
    // Use string concat so GitHub push protection doesn't flag the test file
    var fakeKey = 'sk_' + 'live_' + 'fakekeyfortestingonlyxxxx';
    var result = scan({ key: fakeKey });
    assert.ok(result.found);
    assert.equal(result.matches[0].name, 'stripe-key');
  });

  it('detects nested secrets in objects', () => {
    var result = scan({ config: { auth: { token: 'AKIAIOSFODNN7EXAMPLE' } } });
    assert.ok(result.found);
  });

  it('redacts secrets — full value never in output', () => {
    var result = scan({ key: 'AKIAIOSFODNN7EXAMPLE' });
    var serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('IOSFODNN7'), 'full secret must not appear');
    assert.ok(result.matches[0].sample.length < 10, 'sample should be short');
  });

  it('does not flag clean text', () => {
    var result = scan({ text: 'build me a landing page', query: 'AI news' });
    assert.ok(!result.found);
    assert.equal(result.matches.length, 0);
  });

  it('handles non-object args gracefully', () => {
    assert.doesNotThrow(function() { scan(null); });
    assert.doesNotThrow(function() { scan('string'); });
    assert.doesNotThrow(function() { scan(42); });
  });

  it('createCredentialScanner returns working instance', () => {
    var s = createCredentialScanner();
    assert.equal(typeof s.scan, 'function');
    var result = s.scan({ key: 'AKIAIOSFODNN7EXAMPLE' });
    assert.ok(result.found);
  });
});
