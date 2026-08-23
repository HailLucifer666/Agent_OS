'use strict';

// test/bug-330-search-the-subject-not-the-artifact.test.js
//
// FOUND BY RUNNING THE FIX FROM BUG-329 END TO END, which is the only way it
// could be found: until research reached the model there was nothing to look at.
//
// THE BUG. researchForBuild searched with the whole card text, so the query
// described the ARTIFACT and the search obliged:
//
//   "AI digest landing page Research the live web for today's AI news, pick the
//    five biggest stories, and build a premium dark AI-digest landing page"
//
//   -> 5 results, all UNDATED, every one a site that PUBLISHES AI digests:
//      "The Daily AI Digest", "AI Daily News Digest", "GIST: AI News Digest",
//      "Top AI News Today · Daily AI Digest".
//
// The model was handed five homepages of rival products and asked for five news
// stories, so it invented them — "AI Breakthrough in Healthcare", "New AI Chip
// Revolutionizes Computing", "AI in Education: Personalized Learning". The
// reality-check reviewer said so in as many words, five times: "Fabricated AI
// news stories (not sourced from live web research as required by the task)".
//
// THE MECHANISM. web-search puts the dated Google News RSS rung first for a
// time-sensitive question, and Google News matches a QUERY STRING. A
// 130-character sentence inside a `when:1d` window matches nothing, so the rung
// honestly returns zero and the chain falls through to a semantic search, which
// answers "pages about AI digests" very well. Measured the same minute:
//
//   130 characters (the full brief)      -> exa-mcp,   0 of 5 dated
//   "today's AI news"                    -> news rung, 5 of 5 dated, 1-5h old
//   "AI news today"                      -> news rung, 5 of 5 dated
//   "artificial intelligence news today" -> news rung, 5 of 5 dated
//
// and after the fix, the query derived from that same brief — "AI live todays
// news" — returns 5 of 5 dated, 2-6h old.
//
// This file pins the derivation, not the network: the live measurements are
// recorded above and in the module header, and a test that depends on today's
// headlines would be a test that fails tomorrow for the wrong reason.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const research = require('../src/core/effectors/build-research');
const { searchQueryFor } = research;

const ONE_SHOT =
  "AI digest landing page Research the live web for today's AI news, pick the five biggest stories, "
  + 'and build a premium dark AI-digest landing page';

describe('BUG-330 — the search query names the subject', () => {
  it('drops the deliverable and keeps the subject', () => {
    const q = searchQueryFor(ONE_SHOT);
    assert.match(q, /\bAI\b/, 'the subject must survive');
    assert.match(q, /news/i);
    assert.doesNotMatch(q, /landing/i, 'the artifact must not be searched for');
    assert.doesNotMatch(q, /\bpage\b/i);
    assert.doesNotMatch(q, /premium|dark|digest/i, 'design vocabulary narrows nothing');
    assert.doesNotMatch(q, /\bbuild\b|\bpick\b|\bresearch\b/i);
  });

  it('keeps the time word, which is what routes the question to the dated rung', () => {
    // Dropping these as ordinary stopwords would undo the whole fix: web-search
    // only tries Google News first when the question looks time-sensitive.
    assert.match(searchQueryFor(ONE_SHOT), /todays/i);
    assert.match(searchQueryFor('Build a digest of AI news from the past week'), /past week/i);
    assert.match(searchQueryFor('landing page for this week in AI'), /this week/i);
  });

  it('turns a possessive into one word, not a word plus a stray s', () => {
    // "today's" split on the apostrophe put a bare "s" in the middle of the query.
    const q = searchQueryFor("today's AI news");
    assert.doesNotMatch(q, /(^|\s)s(\s|$)/, 'stray token in ' + JSON.stringify(q));
    assert.match(q, /todays/);
  });

  it('splits hyphenated deliverable words so they can be dropped', () => {
    // "AI-digest" and "dark-theme" survived as single tokens before.
    const q = searchQueryFor('Premium dark-theme AI-digest landing page about robotics');
    assert.doesNotMatch(q, /digest|dark|theme/i);
    assert.match(q, /robotics/i);
  });

  it('stays inside the length that the dated rung actually matches', () => {
    // 130 characters matched nothing; every query measured to work was 13-49.
    const long = 'Build a premium dark single-page landing page covering quantum computing, '
      + 'semiconductor supply chains, robotics, biotech funding and space launch news this week';
    assert.ok(searchQueryFor(long).length <= 60, 'was ' + searchQueryFor(long).length);
  });

  it('does not repeat a word', () => {
    assert.equal(searchQueryFor('AI news AI news AI news'), 'AI news');
  });

  it('leaves a non-news subject alone', () => {
    const q = searchQueryFor('Build a playable snake game, single file, keyboard controls, dark theme');
    assert.match(q, /snake game/i);
    assert.match(q, /keyboard controls/i);
    assert.doesNotMatch(q, /\bbuild\b|\bdark\b|\bfile\b/i);
  });
});

describe('BUG-330 — a brief with no subject is not a failed search', () => {
  // Strip the deliverable words out of "build a landing page" and nothing is
  // left. Searching anyway is what returned rival product homepages; applying
  // the caller's fatal-on-missing policy to it would refuse a build over a
  // search that never happened.
  it('derives an empty query rather than falling back to the whole brief', () => {
    assert.equal(searchQueryFor('build a landing page'), '');
    assert.equal(searchQueryFor('create a website'), '');
    assert.equal(searchQueryFor(''), '');
  });

  it('reports its own reason and never refuses the build', async () => {
    const seen = [];
    const r = research.createBuildResearch({
      bus: { emit: (type, payload) => seen.push(payload) },
      webSearch: async () => { throw new Error('must not be called'); },
    });
    const job = {};
    const out = await r.researchIntoPrompt('PROMPT', job, 'build a landing page', 'feature', true);
    assert.equal(out, 'PROMPT');
    assert.equal(job.researchStatus, 'skipped');
    assert.match(seen[0].reason, /no searchable subject/);
  });

  it('records the query it actually used, so a bad one is visible on the job', async () => {
    const r = research.createBuildResearch({
      webSearch: async () => ({ ok: true, result: { results: [{ title: 't', url: 'https://e.invalid/a', snippet: 's' }] } }),
    });
    const job = {};
    await r.researchIntoPrompt('P', job, ONE_SHOT, 'feature', false);
    assert.equal(job.researchStatus, 'grounded');
    assert.match(job.researchQuery, /news/i);
    assert.doesNotMatch(job.researchQuery, /landing/i);
  });

  it('sends the derived query to web_search, not the brief', async () => {
    const asked = [];
    const r = research.createBuildResearch({
      webSearch: async (args) => { asked.push(args.query); return { ok: true, result: { results: [] } }; },
    });
    await r.researchIntoPrompt('P', {}, ONE_SHOT, 'feature', false).catch(() => {});
    assert.equal(asked.length, 1);
    assert.ok(asked[0].length <= 60, 'sent ' + asked[0].length + ' chars: ' + asked[0]);
    assert.doesNotMatch(asked[0], /landing page/i);
  });
});
