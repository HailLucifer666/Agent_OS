'use strict';

// test/design-query-intent.test.js — the design system must be resolved from the
// design INTENT, never from the article copy.
//
// Operator-reported 2026-07-31, with the artifact to prove it
// (vault/Builds/pipeline/ai-news-digest-openai-ai-went-rogue-2.html): a
// news-digest card whose copy mentioned "price-performance", "security tests"
// and "agents" made ui-ux-pro-max's search.py return pattern "Pricing Page +
// CTA", style "Trust & Authority" (certificate/security badges) and JetBrains
// Mono for both heading and body. The page shipped with a <section id="pricing">,
// an ISO/SOC2/GDPR badge carousel and terminal typography — for a news site.
//
// search.py keyword-matches the whole query string, so the fix is upstream of the
// skill: strip the content, keep the design sentence, and keep any style word
// that appears later so "dark-themed" is not lost with it.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { designQuery, _ROUTES } = require('../src/core/skills/build-pack');

const REAL_BRIEF =
  'Single-page, dark-themed Tailwind landing page styled as a news digest, using UI/UX Pro Max ' +
  "guidelines. Main feature headline: 'OpenAI AI Went Rogue', based on reports of agents " +
  'compromising other systems during security tests. Supporting stories: Microsoft valuation ' +
  'surge, OpenAI advancing price-performance with GPT-5.6, Anthropic security breach incidents, ' +
  "and Google DeepMind's Gemini Robotics 2.";

describe('designQuery keeps the design intent and drops the content', () => {
  it('strips the article copy that chose a pricing page', () => {
    const q = designQuery(REAL_BRIEF);
    assert.match(q, /news digest/i, 'the deliverable type must survive');
    assert.match(q, /dark-themed/i, 'the theme must survive');
    // The three words that misrouted the real build.
    assert.doesNotMatch(q, /price-performance/i);
    assert.doesNotMatch(q, /security tests/i);
    assert.doesNotMatch(q, /Gemini Robotics/i);
  });

  it('caps the query so a long single sentence cannot smuggle content in', () => {
    const q = designQuery(REAL_BRIEF);
    assert.ok(q.length <= 160, 'query was ' + q.length + ' chars');
  });

  it('keeps a style word that only appears after the content marker', () => {
    const q = designQuery(
      'Landing page for the launch. Main feature headline: whatever. Make it glassmorphism and premium.'
    );
    assert.match(q, /landing page/i);
    assert.match(q, /glassmorphism/);
    assert.match(q, /premium/);
    assert.doesNotMatch(q, /whatever/);
  });

  it('leaves a short brief that is already pure intent alone', () => {
    assert.equal(designQuery('dark minimal dashboard'), 'dark minimal dashboard');
  });

  it('falls back to a usable query for empty or punctuation-only input', () => {
    assert.equal(designQuery(''), 'web landing page');
    assert.equal(designQuery(null), 'web landing page');
    assert.equal(designQuery('   ...   '), 'web landing page');
  });

  it('collapses newlines and tabs — a multi-line card must not become a multi-line argv', () => {
    const q = designQuery('Dark\n\tnews digest page.\nMain feature headline: x');
    assert.equal(q, 'Dark news digest page');
  });

  it('the ui route passes the trimmed query and the real target stack', () => {
    const args = _ROUTES.ui.buildArgs(REAL_BRIEF);
    assert.equal(args[0], designQuery(REAL_BRIEF), 'argv[0] must be the trimmed query');
    assert.ok(args.includes('--design-system'));
    assert.deepEqual(
      args.slice(-2), ['--stack', 'html-tailwind'],
      'the pipeline emits one self-contained Tailwind HTML file — ask for that stack'
    );
  });
});

describe('build prompts subordinate the design system to the request', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'core', 'effectors', 'agent-actions.js'), 'utf8'
  );

  it('tells the model the idea wins over the design block section list', () => {
    assert.match(src, /the IDEA WINS/);
    assert.match(src, /pricing tiers, certification/);
  });

  it('tells the model how to derive a dark theme instead of inverting a light palette', () => {
    assert.match(src, /do NOT simply/);
    assert.match(src, /near-black neutral surface/);
  });

  it('makes the reviewer flag sections nobody asked for', () => {
    assert.match(src, /Extra sections are a defect/);
  });
});
