'use strict';

// test/bug-315-news-marker-is-not-a-topic.test.js — BUG-315.
//
// THE BUG. web-search.js puts the bare word 'news' in FRESHNESS_MARKERS, and
// rung 0a — Google News RSS — is first in the chain and returns on any non-empty
// answer. The file's own comment states the property that makes that decisive:
// "the UNWINDOWED endpoint never returns zero". So ANY query containing the word
// "news" is answered by a general news aggregator and no other provider is ever
// consulted.
//
// WHY NOT HYPOTHETICAL. On 2026-08-22 the operator asked for AI news from the
// past week. Re-running the exact query MYTHOS used, "global AI news past week",
// returns China/Indonesia, Guterres/India, CNBC "No one saw this coming!" and
// India/APAC adoption — which are, in order, the four stories that ended up on
// the shipped landing page. Meanwhile the SAME session's more specific query,
// "global AI model releases August 15-22 2026 Qwen DeepSeek Claude", came back
// empty from RSS, fell through to DuckDuckGo, and returned the real answer:
// Qwen3.8-27B on Aug 15, Gemini 3.7 Flash, Claude Opus 5 updates.
//
// A MEASUREMENT KILLED THE FIRST PLANNED FIX. The audit proposed gating the rung
// on topical relevance — require the RSS titles to share subject terms with the
// query. That does not work here and would have shipped as a no-op: those
// headlines DO contain "AI" and "global". They are genuinely AI news; they are
// just policy and adoption news rather than the technical releases the operator
// wanted, and no keyword check can separate those. What is actually wrong is
// that one general-news index gets to be the ONLY voice on the topic.
//
// SO THE FIX IS CORROBORATION, NOT FILTERING. On a freshness query the RSS rung
// still leads — that ordering is the BUG-294 fix and it is what makes a dated,
// current answer win over an undated fixture — but it no longer silences the
// chain. One free general provider runs alongside it and the two are merged, RSS
// first. That also repairs the raw material for BUG-314: the RSS rung returns
// snippet "Published Nh ago." and nothing else, which is why every story
// paragraph on the shipped page had to be invented.
//
// THE SAFETY PROPERTY IS UNCHANGED AND PINNED BELOW: a query with no freshness
// marker still never reaches rung 0a.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const { web_search, _isTimeSensitive } = require('../src/core/effectors/web-search');

const RSS_TITLES = [
  'China urges Indonesia to back global AI initiative amid US rivalry - Anadolu',
  'UN Secretary-General says India is right place to host AI Summit - News On AIR',
];
const DDG_TITLE = 'Qwen3.8-27B: Runs Locally, Nears Claude Opus (Aug 2026) - explainx.ai';
const DDG_SNIPPET = 'Qwen3.8-27B-FP8 landed Aug 15, 2026: dense 27B, vision-language, 262K context.';

function rssXml(titles) {
  const pub = new Date(Date.now() - 3 * 60 * 60 * 1000).toUTCString();
  const items = titles.map((t, i) => [
    '<item>',
    '<title>' + t + '</title>',
    '<link>https://news.google.com/rss/articles/FIXTURE' + i + '?oc=5</link>',
    '<pubDate>' + pub + '</pubDate>',
    '</item>',
  ].join('')).join('');
  return '<?xml version="1.0"?><rss version="2.0"><channel>' + items + '</channel></rss>';
}

const DDG_HTML = [
  '<html><body>',
  '<a class="result__a" href="https://www.explainx.ai/blog/qwen-3-8-27b">' + DDG_TITLE + '</a>',
  '<a class="result__snippet">' + DDG_SNIPPET + '</a>',
  '</body></html>',
].join('');

// Records every URL the chain requests, and serves canned bodies. Any host not
// named here answers empty, so a rung reaching the real internet would show up
// as a missing result rather than a slow, flaky pass.
let requested;
let realFetch;

function installFetchStub(opts) {
  const o = opts || {};
  requested = [];
  realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    requested.push(u);
    if (u.indexOf('news.google.com') !== -1) {
      const empty = o.rssEmpty || (o.emptyOnWindow && u.indexOf(o.emptyOnWindow) !== -1);
      return { ok: true, status: 200, text: async () => rssXml(empty ? [] : RSS_TITLES) };
    }
    if (u.indexOf('html.duckduckgo.com') !== -1) {
      return { ok: true, status: 200, text: async () => (o.ddgEmpty ? '<html></html>' : DDG_HTML) };
    }
    // Everything else — the local daemon, exa, jina, wikipedia — answers nothing.
    return { ok: false, status: 503, text: async () => '', json: async () => ({}) };
  };
}

function titlesOf(res) {
  return (res.result.results || []).map((r) => r.title);
}

describe('BUG-315 — "news" must not make one aggregator the only voice', () => {
  beforeEach(() => { installFetchStub(); });
  afterEach(() => { global.fetch = realFetch; });

  test('a news query is corroborated by a second provider, not answered alone', async () => {
    const res = await web_search({ query: 'global AI news past week', maxResults: 5 });
    assert.strictEqual(res.ok, true);
    const titles = titlesOf(res);
    assert.ok(titles.some((t) => t.indexOf('China urges Indonesia') !== -1),
      'the RSS lead must still be present: ' + JSON.stringify(titles));
    assert.ok(titles.some((t) => t.indexOf('Qwen3.8-27B') !== -1),
      'RSS short-circuited the chain, so the technical result never appeared: ' + JSON.stringify(titles));
  });

  test('the RSS lead stays FIRST — freshness must still win', async () => {
    // This is the BUG-294 ordering property. Corroboration must not demote the
    // dated, current answer beneath an undated one.
    const res = await web_search({ query: 'global AI news past week', maxResults: 5 });
    assert.ok(String(titlesOf(res)[0]).indexOf('China urges Indonesia') !== -1,
      'first result should be the dated RSS item');
  });

  test('the merged answer carries real snippets, not only "Published Nh ago."', async () => {
    // BUG-314's raw material: with RSS alone every snippet is a date label, so a
    // builder asked for story summaries has nothing to work from and invents them.
    const res = await web_search({ query: 'global AI news past week', maxResults: 5 });
    const snippets = res.result.results.map((r) => r.snippet || '');
    assert.ok(snippets.some((s) => /Qwen3\.8-27B-FP8 landed/.test(s)),
      'no substantive snippet reached the caller: ' + JSON.stringify(snippets));
  });

  test('the source label names both providers so the mix is auditable', async () => {
    const res = await web_search({ query: 'global AI news past week', maxResults: 5 });
    assert.match(String(res.result.source), /google-news-rss/);
    assert.match(String(res.result.source), /duckduckgo|ddg/);
  });

  test('a week query asks Google for a week, not a day', async () => {
    // NEWS_WINDOWS is ['when:1d','when:7d'] and stops at the first window that
    // answers — and when:1d always answers. So "last one week" was structurally
    // served with the last 24 hours.
    await web_search({ query: 'global AI news past week', maxResults: 5 });
    const newsUrls = requested.filter((u) => u.indexOf('news.google.com') !== -1);
    assert.ok(newsUrls.length > 0, 'the news rung must have been asked');
    assert.ok(newsUrls.some((u) => /when%3A7d|when:7d/.test(decodeURIComponent(u))),
      'a query naming a week never requested a 7-day window: ' + JSON.stringify(newsUrls));
  });

  test('a today query still asks for a day', async () => {
    await web_search({ query: 'AI news today', maxResults: 5 });
    const newsUrls = requested.filter((u) => u.indexOf('news.google.com') !== -1);
    assert.ok(newsUrls.some((u) => /when%3A1d|when:1d/.test(decodeURIComponent(u))),
      'a "today" query must still use the tight window');
  });

  test('RSS alone still answers when the corroborating provider is empty', async () => {
    // No regression: corroboration is additive. If the second provider has
    // nothing, the freshness answer must still come back.
    installFetchStub({ ddgEmpty: true });
    const res = await web_search({ query: 'global AI news past week', maxResults: 5 });
    assert.strictEqual(res.ok, true);
    assert.ok(titlesOf(res).some((t) => t.indexOf('China urges Indonesia') !== -1));
    assert.strictEqual(String(res.result.source), 'google-news-rss',
      'with nothing to merge the source must not claim a second provider');
  });

  test('THE SAFETY PROPERTY: a timeless query never reaches the news rung', async () => {
    // RSS never returns zero on an unwindowed request, which is the entire
    // reason for the freshness gate. This must not be weakened by the fix.
    assert.strictEqual(_isTimeSensitive('who wrote the iliad'), false);
    await web_search({ query: 'who wrote the iliad', maxResults: 3 });
    assert.deepStrictEqual(requested.filter((u) => u.indexOf('news.google.com') !== -1), [],
      'a query with no freshness marker must never hit Google News');
  });

  test('the freshness marker list itself is unchanged', () => {
    assert.strictEqual(_isTimeSensitive('global AI news past week'), true);
    assert.strictEqual(_isTimeSensitive('latest AI releases'), true);
    assert.strictEqual(_isTimeSensitive('AI model architecture explained'), false);
  });
});
