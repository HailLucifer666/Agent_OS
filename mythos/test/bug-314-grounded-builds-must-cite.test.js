'use strict';

// test/bug-314-grounded-builds-must-cite.test.js — BUG-314.
//
// THE DEFECT AS SHIPPED. The 2026-08-22 AI news digest carried a paragraph under
// every headline, e.g. "India has overtaken other APAC countries in AI adoption,
// with significant investments in AI infrastructure and talent development."
// That sentence exists in no search result. All four "Read more" links were
// href="#", so none of it was checkable, and the hero image was
// picsum.photos/seed/ai-summit captioned alt="UN Secretary-General at the Global
// South AI Summit" — a random stock image presented as a photograph of a real
// person at a real event.
//
// TWO PREMISES MEASUREMENT CORRECTED, WHICH SHRANK THIS FIX A LOT.
//
// 1. The research brief ALREADY fetches sources and ALREADY puts their URLs in
//    the prompt. agent-actions.js's researchForBuild() web_fetches the top three
//    results and emits "N. title — url" lines for every result. Nothing needed
//    building there.
// 2. That fetch is ALREADY the SSRF-hardened path. main.js:488 wires
//    web-fetch.js's web_fetch, whose guardedLookup re-validates every resolved
//    address at dial time with no pooled sockets (BUG-303). The audit's worry
//    that fetching Google News redirectors would reopen a closed hole was
//    misplaced — those fetches already happen, through the guard.
//
// So the page had no sources for one reason only: researchStatus was
// 'not-required'. BUG-309 gated the build as a typo fix, research never ran, and
// the model was left to invent bodies for headlines it had been handed without
// any accompanying text (BUG-315 records the RSS rung returning snippet
// "Published 3h ago." and nothing else).
//
// WHAT IS ACTUALLY MISSING, AND IS WHAT THIS FILE PINS: with research running,
// nothing checks that the artifact USED it. A grounded build could cite none of
// its sources, fill every link with href="#", and caption a stock photo as
// documentary evidence, and every gate passed it.
//
// DELIBERATELY NOT A RULE HERE: picsum.photos itself. DELIVERABLE_PREAMBLE
// instructs the model to use it ("For photographs use
// https://picsum.photos/seed/..."), so banning it would contradict the brief the
// same file issues. The defect is narrower and is what gets checked — a
// placeholder image whose alt asserts something the spec says is real.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const nodeFs = require('fs');

const {
  checkGrounding,
  sourcesFromBrief,
} = require('../src/core/effectors/grounding-check');
const { tempVaultDir, cleanupVaultDir, fakeBus, waitForJobFinished } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createPipelineEffector } = require('../src/core/effectors/pipeline');
const { createKanbanEffector } = require('../src/core/effectors/kanban');
const { createBuildRunner } = require('../src/core/effectors/build-runner');
const { createAgentActions } = require('../src/core/effectors/agent-actions');
const riskClassifier = require('../src/core/effectors/risk-classifier');

const SPEC = [
  'Build a static, single-page AI news digest landing page. Premium dark theme.',
  'Hero section for Top Story: UN Secretary-General labels India primary host for Global South AI Summit.',
  'Secondary Stories: India surges past APAC in AI adoption; China pushes Indonesia for global AI initiative support.',
].join(' ');

// The exact format researchForBuild() emits (agent-actions.js). sourcesFromBrief
// is coupled to it on purpose and this fixture is what pins the coupling: change
// the producer and this test fails rather than the extractor silently returning
// nothing.
const BRIEF = [
  'RESEARCH BRIEF (real web data — use this, do not hallucinate):',
  '1. UN Secretary-General says India is right place to host AI Summit - News On AIR — https://news.google.com/rss/articles/CBMiABC?oc=5',
  '   Published 15h ago.',
  '2. India sets the pace in APAC for AI adoption - ET CIO — https://cio.economictimes.com/news/artificial-intelligence/india-apac',
  '   Published 11h ago.',
  '',
  'KEY CONTENT EXTRACTS:',
  '— UN Secretary-General says India is right place: Guterres told the AI Impact Summit...',
].join('\n');

const SOURCES = sourcesFromBrief(BRIEF);

function page(body) {
  return [
    '<!DOCTYPE html><html><head><title>AI News Digest</title>',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<style>@media (max-width:600px){body{font-size:14px}}</style></head><body>',
    body,
    '</body></html>',
  ].join('');
}

describe('BUG-314 — sourcesFromBrief reads the format researchForBuild writes', () => {
  test('every result URL is recovered', () => {
    assert.strictEqual(SOURCES.length, 2);
    assert.ok(SOURCES.some((s) => s.indexOf('news.google.com/rss/articles/CBMiABC') !== -1));
    assert.ok(SOURCES.some((s) => s.indexOf('cio.economictimes.com') !== -1));
  });

  test('a brief with no results yields no sources rather than throwing', () => {
    assert.deepStrictEqual(sourcesFromBrief(''), []);
    assert.deepStrictEqual(sourcesFromBrief(null), []);
    assert.deepStrictEqual(sourcesFromBrief('RESEARCH BRIEF (real web data):'), []);
  });
});

describe('BUG-314 — a grounded build must cite what it was given', () => {
  test('an artifact citing none of its sources is flagged', () => {
    const html = page([
      '<h1>AI News Digest</h1>',
      '<article><h2>India surges past APAC in AI adoption</h2>',
      '<p>India has overtaken other APAC countries in AI adoption, with significant',
      'investments in AI infrastructure and talent development.</p>',
      '<a href="#">Read more</a></article>',
    ].join(''));
    const issues = checkGrounding(html, { spec: SPEC, sources: SOURCES });
    assert.ok(issues.some((i) => /cites none of the .* sources/i.test(i)),
      'expected an uncited-sources issue, got: ' + JSON.stringify(issues));
  });

  test('dead "Read more" links are flagged by name', () => {
    const html = page([
      '<article><h2>Story</h2><a href="' + SOURCES[0] + '">Source</a></article>',
      '<article><h2>Other</h2><a href="#">Read more</a></article>',
    ].join(''));
    const issues = checkGrounding(html, { spec: SPEC, sources: SOURCES });
    assert.ok(issues.some((i) => /read more/i.test(i) && /href="#"/.test(i)),
      'expected a dead-link issue, got: ' + JSON.stringify(issues));
  });

  test('a placeholder image captioned as a real subject from the spec is flagged', () => {
    const html = page([
      '<a href="' + SOURCES[0] + '">Source</a>',
      '<img src="https://picsum.photos/seed/ai-summit/800/400"',
      ' alt="UN Secretary-General at the Global South AI Summit">',
    ].join(''));
    const issues = checkGrounding(html, { spec: SPEC, sources: SOURCES });
    assert.ok(issues.some((i) => /placeholder image/i.test(i)),
      'expected a placeholder-caption issue, got: ' + JSON.stringify(issues));
  });

  test('a placeholder image with a generic alt is NOT flagged', () => {
    // The preamble mandates picsum for photographs. Only a caption asserting
    // something the spec presents as fact is a problem.
    const html = page([
      '<a href="' + SOURCES[0] + '">Source</a>',
      '<img src="https://picsum.photos/seed/abstract/800/400" alt="Abstract decorative header image">',
    ].join(''));
    const issues = checkGrounding(html, { spec: SPEC, sources: SOURCES });
    assert.deepStrictEqual(issues.filter((i) => /placeholder image/i.test(i)), []);
  });

  test('a properly cited artifact produces no issues', () => {
    const html = page([
      '<h1>AI News Digest</h1>',
      '<article><h2>UN Secretary-General labels India primary host</h2>',
      '<p>Guterres told the AI Impact Summit in New Delhi...</p>',
      '<a href="' + SOURCES[0] + '">Read more</a></article>',
      '<article><h2>India surges past APAC in AI adoption</h2>',
      '<a href="' + SOURCES[1] + '">Read more</a></article>',
    ].join(''));
    assert.deepStrictEqual(checkGrounding(html, { spec: SPEC, sources: SOURCES }), []);
  });

  test('with no sources supplied the check is inert, never a false accusation', () => {
    // An ungrounded build has nothing to cite. This must not invent findings.
    const html = page('<article><a href="#">Read more</a></article>');
    assert.deepStrictEqual(checkGrounding(html, { spec: SPEC, sources: [] }), []);
    assert.deepStrictEqual(checkGrounding(html, { spec: SPEC }), []);
  });

  test('a non-HTML deliverable is not checked', () => {
    // Research-grounded markdown reports are a legitimate deliverable and have
    // no anchors or images to audit.
    const md = '# AI News Digest\n\nGuterres told the summit...\n';
    assert.deepStrictEqual(checkGrounding(md, { spec: SPEC, sources: SOURCES }), []);
  });

  test('in-page anchors that are not source links are left alone', () => {
    // href="#" is legitimate for skip-links and tab controls. Only link TEXT
    // that promises a source is a dead source link.
    const html = page([
      '<a href="' + SOURCES[0] + '">Source</a>',
      '<a href="#main" class="skip">Skip to content</a>',
      '<a href="#" role="tab">Latest</a>',
    ].join(''));
    assert.deepStrictEqual(checkGrounding(html, { spec: SPEC, sources: SOURCES }), []);
  });
});

// The rules above are unit-tested. This proves they are WIRED — an unwired check
// is coverage theatre, and this repo has a recorded history of exactly that
// ("inert mechanisms look like coverage").
describe('BUG-314 — the grounding check is reached by the real ship path', () => {
  function setup(artifactHtml) {
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
        return { content: artifactHtml, offline: false, parsed: null };
      },
    };
    const buildEngine = { generate: async () => ({ content: artifactHtml, engine: 'dsh', offline: false }) };
    const pipeline = createPipelineEffector({ fs: vaultFs, classifier: riskClassifier });
    const kanban = createKanbanEffector({ fs: vaultFs });
    const buildRunner = createBuildRunner({ config: {}, brain, bus: fakeBus(), vault: vaultFs, buildEngine });
    const agentActions = createAgentActions({
      fs: vaultFs, pipeline, kanban, buildRunner, brain, buildEngine,
      // Two dated results, so researchForBuild produces a brief with two URLs.
      webSearch: async () => ({
        ok: true,
        result: {
          source: 'google-news-rss',
          results: [
            { title: 'UN chief on India AI summit', url: 'https://news.example.org/un-india', snippet: 'Published 3h ago.' },
            { title: 'India APAC AI adoption', url: 'https://news.example.org/apac', snippet: 'Published 5h ago.' },
          ],
        },
      }),
      webFetch: async () => ({ ok: true, result: { content: 'article body text' } }),
    });
    return { dir, pipeline, buildRunner, agentActions };
  }

  const UNCITED = [
    '<!DOCTYPE html><html><head><title>AI News Digest Landing Page</title>',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<style>@media (max-width:600px){body{font-size:14px}}</style></head><body>',
    '<h1>AI News Digest</h1>',
    '<article><h2>India surges past APAC in AI adoption</h2>',
    '<p>India has overtaken other APAC countries in AI adoption.</p>',
    '<a href="#">Read more</a></article>',
    '</body></html>',
  ].join('');

  test('a grounded build citing nothing is rejected, not shipped as done', async () => {
    const env = setup(UNCITED);
    try {
      // "Build ... landing page" => risk feature => research runs => grounded.
      const card = env.pipeline.capture('Build an AI news digest landing page for this week', 'test');
      env.pipeline.approve(card.id);
      const jobId = env.agentActions.executePipelineCard(card.id, null).job.id;
      const job = await waitForJobFinished(env.buildRunner, jobId);

      assert.equal(job.researchStatus, 'grounded', 'the harness must actually reach the grounded path');
      const found = env.pipeline.findCard(card.id);
      assert.equal(found.card.reviewStatus, 'failed',
        'an artifact citing none of its sources must not pass review');
      assert.equal(found.card.status, 'needs-work');
      const issues = (found.card.reviewIssues || []).join(' | ');
      assert.match(issues, /cites none of the 2 research sources/);
      assert.match(issues, /href="#"/);
    } finally { cleanupVaultDir(env.dir); }
  });
});
