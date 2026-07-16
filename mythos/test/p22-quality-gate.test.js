'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createPipelineEffector } = require('../src/core/effectors/pipeline');
const { createKanbanEffector } = require('../src/core/effectors/kanban');
const { createBuildRunner } = require('../src/core/effectors/build-runner');
const { createAgentActions } = require('../src/core/effectors/agent-actions');
const { createVerifier } = require('../src/core/design/verify');

function setupDeps(opts) {
  opts = opts || {};
  const dir = tempVaultDir();
  const fs = createFsStore(() => dir, null);
  // Create builds dir so saveDeliverable works
  try { require('fs').mkdirSync(path.join(dir, 'builds', 'pipeline'), { recursive: true }); } catch (_) {}
  try { require('fs').mkdirSync(path.join(dir, 'builds', 'kanban'), { recursive: true }); } catch (_) {}

  const pipeline = createPipelineEffector({ fs });
  const kanban = createKanbanEffector({ fs });
  const brain = opts.brain || {
    think: async () => ({ content: '<!DOCTYPE html><html><head><title>Test</title><meta name="viewport" content="width=device-width"><style>@media(max-width:600px){}</style></head><body>hello</body></html>', offline: false, parsed: null })
  };
  const verifier = opts.verifier || createVerifier({ brain: brain });
  const buildRunner = createBuildRunner({ config: {}, brain, bus: fakeBus(), vault: fs, verifier });

  const agentActions = createAgentActions({
    fs: fs,
    pipeline: pipeline,
    kanban: kanban,
    buildRunner: buildRunner,
    brain: brain,
    webSearch: opts.webSearch,
    webFetch: opts.webFetch,
    browserAgent: opts.browserAgent,
  });

  return { dir, fs, pipeline, kanban, brain, buildRunner, agentActions, verifier };
}

function cleanup(deps) {
  cleanupVaultDir(deps.dir);
}

describe('P22: Quality Gate — Research', () => {
  it('researchForBuild returns null when webSearch is not configured', async () => {
    const deps = setupDeps();
    try {
      const result = await deps.agentActions.researchForBuild('AI news', 5);
      assert.equal(result, null);
    } finally { cleanup(deps); }
  });

  it('researchForBuild returns a brief when webSearch returns results', async () => {
    const fakeWebSearch = async () => ({
      ok: true,
      result: {
        results: [
          { title: 'GPT-5 Released', url: 'https://example.com/1', snippet: 'OpenAI releases GPT-5 with major improvements' },
          { title: 'Claude 4 Announced', url: 'https://example.com/2', snippet: 'Anthropic announces Claude 4' },
        ]
      }
    });
    const fakeWebFetch = async () => ({
      ok: true,
      result: { content: 'Full article content about the AI news event.' }
    });
    const deps = setupDeps({ webSearch: fakeWebSearch, webFetch: fakeWebFetch });
    try {
      const result = await deps.agentActions.researchForBuild('AI news June 2026', 5);
      assert.ok(result, 'should return a brief');
      assert.ok(result.includes('RESEARCH BRIEF'), 'should have research brief header');
      assert.ok(result.includes('GPT-5 Released'), 'should include search result title');
      assert.ok(result.includes('Full article content'), 'should include fetched content');
    } finally { cleanup(deps); }
  });

  it('researchForBuild handles webSearch failure gracefully', async () => {
    const failingSearch = async () => ({ ok: false, error: 'network error' });
    const deps = setupDeps({ webSearch: failingSearch });
    try {
      const result = await deps.agentActions.researchForBuild('anything', 5);
      assert.equal(result, null);
    } finally { cleanup(deps); }
  });
});

describe('P22: Quality Gate — Visual Verification', () => {
  it('verifyBuildVisually returns skipped when browserAgent is unavailable', async () => {
    const deps = setupDeps();
    try {
      var result = await deps.agentActions.verifyBuildVisually('/vault/builds/test/test.html', 'test spec');
      assert.equal(result.checked, false);
      assert.equal(result.verdict, 'skipped');
    } finally { cleanup(deps); }
  });

  it('verifyBuildVisually returns skipped when browser is offline', async () => {
    const offlineBrowser = {
      getStatus: () => ({ state: 'OFFLINE' }),
    };
    const deps = setupDeps({ browserAgent: offlineBrowser });
    try {
      var result = await deps.agentActions.verifyBuildVisually('/vault/builds/test/test.html', 'test spec');
      assert.equal(result.checked, false);
      assert.equal(result.verdict, 'skipped');
    } finally { cleanup(deps); }
  });

  it('verifyBuildVisually approves when vision brain sees a matching page', async () => {
    // Write a test artifact to the vault
    const deps = setupDeps({
      brain: {
        think: async (args) => {
          if (args.lane === 'vision') {
            return {
              content: '{"match": true, "description": "Dark themed AI news page", "issues": []}',
              offline: false,
              parsed: { match: true, description: 'Dark themed AI news page', issues: [] }
            };
          }
          return { content: '<!DOCTYPE html><html><head><title>AI News</title></head><body>news</body></html>', offline: false, parsed: null };
        }
      },
      browserAgent: {
        getStatus: () => ({ state: 'ONLINE' }),
        withPage: async (fn) => {
          // Simulate screenshot capture
          return 'dGVzdA=='; // base64 "test"
        }
      }
    });
    try {
      // Write artifact file
      deps.fs.writeText('builds/test/test.html', '<!DOCTYPE html><html><head><title>AI News</title></head><body>news</body></html>');
      var result = await deps.agentActions.verifyBuildVisually('/vault/builds/test/test.html', 'AI news landing page');
      assert.equal(result.checked, true);
      assert.equal(result.verdict, 'approve');
      assert.ok(result.description.includes('AI news'), 'should describe the page');
    } finally { cleanup(deps); }
  });

  it('verifyBuildVisually rejects when vision brain sees a mismatched page', async () => {
    const deps = setupDeps({
      brain: {
        think: async (args) => {
          if (args.lane === 'vision') {
            return {
              content: '{"match": false, "description": "A podcast platform page, not AI news", "issues": ["off-topic: podcast platform instead of AI news"]}',
              offline: false,
              parsed: { match: false, description: 'A podcast platform page', issues: ['off-topic: podcast platform instead of AI news'] }
            };
          }
          return { content: '<!DOCTYPE html><html><body>podcast</body></html>', offline: false, parsed: null };
        }
      },
      browserAgent: {
        getStatus: () => ({ state: 'ONLINE' }),
        withPage: async (fn) => 'dGVzdA==',
      }
    });
    try {
      deps.fs.writeText('builds/test/test.html', '<!DOCTYPE html><html><body>podcast</body></html>');
      var result = await deps.agentActions.verifyBuildVisually('/vault/builds/test/test.html', 'AI news landing page');
      assert.equal(result.checked, true);
      assert.equal(result.verdict, 'reject');
      assert.ok(result.issues.length > 0, 'should have rejection issues');
    } finally { cleanup(deps); }
  });
});

describe('P22: Quality Gate — Full Review', () => {
  it('fullReview approves a good artifact', async () => {
    const deps = setupDeps({
      brain: {
        think: async () => ({
          content: '{"verdict": "approve", "issues": [], "notes": "Good deliverable"}',
          offline: false,
          parsed: { verdict: 'approve', issues: [], notes: 'Good deliverable' }
        })
      }
    });
    try {
      deps.fs.writeText('builds/test/good.html', '<!DOCTYPE html><html><head><title>AI News</title></head><body>Real AI news content</body></html>');
      var card = { title: 'AI News Landing Page', detail: 'Dark themed AI news page' };
      var artifact = { path: '/vault/builds/test/good.html', title: 'AI News' };
      var review = await deps.agentActions.fullReview(card, artifact, deps.brain);
      assert.equal(review.verdict, 'approve');
      assert.equal(review.issues.length, 0);
    } finally { cleanup(deps); }
  });

  it('fullReview rejects when reviewer finds issues', async () => {
    const deps = setupDeps({
      brain: {
        think: async () => ({
          content: '{"verdict": "reject", "issues": ["title is an invented brand name", "content is about a podcast, not AI news"], "notes": "Off-topic"}',
          offline: false,
          parsed: { verdict: 'reject', issues: ['title is an invented brand', 'off-topic content'], notes: 'Off-topic' }
        })
      }
    });
    try {
      deps.fs.writeText('builds/test/bad.html', '<!DOCTYPE html><html><head><title>PodcastPro</title></head><body>Podcast content</body></html>');
      var card = { title: 'AI News Landing Page', detail: 'Dark themed AI news page' };
      var artifact = { path: '/vault/builds/test/bad.html', title: 'PodcastPro' };
      var review = await deps.agentActions.fullReview(card, artifact, deps.brain);
      assert.equal(review.verdict, 'reject');
      assert.ok(review.issues.length > 0, 'should have issues');
    } finally { cleanup(deps); }
  });
});

describe('P22: Quality Gate — Verifier Placeholder Detection', () => {
  it('flags lorem ipsum placeholder text', async () => {
    var brain = { think: async () => ({ content: '{"pass": true}', offline: false, parsed: { pass: true } }) };
    var verifier = createVerifier({ brain });
    var result = await verifier.verify(
      '<!DOCTYPE html><html><head><title>Test</title><meta name="viewport"><style>@media(x){}</style></head><body>Lorem ipsum dolor sit amet</body></html>',
      'test spec'
    );
    assert.equal(result.pass, false);
    assert.ok(result.issues.some(function(i) { return i.includes('placeholder'); }), 'should flag placeholder');
  });

  it('flags generic testimonial pattern', async () => {
    var brain = { think: async () => ({ content: '{"pass": true}', offline: false, parsed: { pass: true } }) };
    var verifier = createVerifier({ brain });
    var result = await verifier.verify(
      '<!DOCTYPE html><html><head><title>App</title><meta name="viewport"><style>@media(x){}</style></head><body>Join 50,000+ users today! Sarah J. says this is great.</body></html>',
      'test spec'
    );
    assert.equal(result.pass, false);
    assert.ok(result.issues.some(function(i) { return i.includes('placeholder'); }), 'should flag generic text');
  });

  it('flags title that shares no words with spec', async () => {
    var brain = { think: async () => ({ content: '{"pass": true}', offline: false, parsed: { pass: true } }) };
    var verifier = createVerifier({ brain });
    var result = await verifier.verify(
      '<!DOCTYPE html><html><head><title>BentoBuilder Pro</title><meta name="viewport"><style>@media(x){}</style></head><body>Content</body></html>',
      'AI news landing page dark theme'
    );
    assert.equal(result.pass, false);
    assert.ok(result.issues.some(function(i) { return i.includes('invented brand'); }), 'should flag title mismatch');
  });

  it('passes clean content with matching title', async () => {
    var brain = { think: async () => ({ content: '{"pass": true}', offline: false, parsed: { pass: true } }) };
    var verifier = createVerifier({ brain });
    var result = await verifier.verify(
      '<!DOCTYPE html><html><head><title>AI News Landing Page</title><meta name="viewport"><style>@media(x){}</style></head><body>Latest AI developments and news</body></html>',
      'AI news landing page'
    );
    assert.equal(result.pass, true);
    assert.equal(result.issues.length, 0);
  });
});

describe('P22: Quality Gate — web_search/web_fetch tiering', () => {
  it('web_search and web_fetch are tier 0 (read-only, auto-allow)', () => {
    const { tierOf } = require('../src/core/leash/tiers');
    assert.equal(tierOf('web_search'), 0, 'web_search should be tier 0');
    assert.equal(tierOf('web_fetch'), 0, 'web_fetch should be tier 0');
  });

  it('gmail_read/gmail_unread are tier 1 (local write w/ side effects), camera_look is tier 0', () => {
    const { tierOf } = require('../src/core/leash/tiers');
    assert.equal(tierOf('gmail_unread'), 1);
    assert.equal(tierOf('gmail_read'), 1);
    assert.equal(tierOf('camera_look'), 0);
  });
});
