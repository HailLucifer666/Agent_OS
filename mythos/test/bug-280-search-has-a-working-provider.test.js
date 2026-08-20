'use strict';

// BUG-280 — web search had ZERO working providers.
//
// All six chain members were measured individually from this machine on
// 2026-08-20, and an example.com control returned HTTP 200 in 234ms in the same
// run, so the machine's network was fine:
//   exa        skipped, no EXA_API_KEY
//   exa-mcp    HTTP 429 — the free tier is 150/day and it was spent
//   ddg-html   fetch failed @ ~10s   (all three DuckDuckGo hosts unreachable
//   ddg-lite   fetch failed @ 10598ms  from here — the block is this host's
//   ddg api    fetch failed @ 10494ms  network, not the provider)
//   jina       HTTP 401 — the vendor removed the free no-key tier
//   wikipedia  HTTP 200, zero hits
//
// The operator's question — "we didn't need a key before, why now?" — has an
// answer: it WAS free, and three independent free routes died within days of
// each other for three unrelated reasons. Not a MYTHOS regression.
//
// TWO changes, and they are different in kind.
//
// 1. Wikipedia was ours to fix. It used action=opensearch, which is
//    TITLE-PREFIX matching and cannot answer a natural-language query by
//    construction. Measured: 'London' -> 3 hits, 'weather in London today' ->
//    0 hits. The same host with action=query&list=search (full text) returned
//    HTTP 200 with 10 hits on the identical query. The old inline comment
//    called the empty answer "CORRECT behaviour, not a fault" — which was true
//    of OpenSearch, and was also the argument for not using OpenSearch.
//
// 2. A working search engine was NOT ours to write. Four previous attempts at
//    hand-rolled scraping are what produced the chain above. open-webSearch
//    (Apache-2.0, 1.7k stars) is adopted instead, spawned by the operator as a
//    local daemon and reached over loopback HTTP — the same optional-external
//    -binary contract cua-driver has: absent daemon means this rung notes its
//    cause and the chain continues.
//
// WHAT THE ADOPTION MEASUREMENT ACTUALLY SAID, because it did not say what the
// scoping document predicted. That document adopted open-webSearch "for Bing's
// reachability, not for stars", having measured a raw fetch to Bing returning
// HTTP 200 with 136 result links. Driven through the repo's own Bing engine,
// from the same machine, the result is HTTP 301 and zero results. Per-engine,
// via its CLI:
//   bing        0 results — HTTP 301
//   baidu       0 results — socket hang up
//   startpage   3 results — RELEVANT (Allrecipes as the top hit)
//   duckduckgo  0 results
//   brave       0 results — HTTP 429
//   sogou       0 results — anti-bot page
//   csdn        0 results
// So the justification for adopting it is void and the adoption still stands,
// on one engine instead of the expected three. Reachability of a service is not
// the same as a repo's parser working against it — that is the lesson, and it is
// why WEB_SEARCH_ENGINES defaults to startpage rather than to bing.
//
// Fixtures are captured wire responses from the running daemon and from
// Wikipedia, not hand-written.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const search = require('../src/core/effectors/web-search');

const FIX = path.join(__dirname, '..', 'test-fixtures', 'web-search');
const DAEMON = JSON.parse(fs.readFileSync(path.join(FIX, 'local-daemon-search.json'), 'utf8'));
const WIKI = JSON.parse(fs.readFileSync(path.join(FIX, 'wikipedia-fulltext.json'), 'utf8'));

const realFetch = global.fetch;

// Every non-local host fails, so nothing in these tests can reach the network
// and quietly pass on a real provider. node --test collects everything under
// test/, so a test that called out would block commits the day a host rate
// -limits.
function stubChain({ local, wiki }) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('127.0.0.1') || u.includes('localhost')) {
      if (local === 'refused') { const e = new Error('connect ECONNREFUSED 127.0.0.1:3100'); throw e; }
      if (local === 'error') return { ok: false, status: 500, text: async () => 'boom' };
      return { ok: true, status: 200, json: async () => DAEMON, text: async () => JSON.stringify(DAEMON) };
    }
    if (u.includes('wikipedia.org')) {
      if (wiki === 'empty') return { ok: true, json: async () => ({ query: { search: [] } }) };
      return { ok: true, json: async () => WIKI };
    }
    throw new Error('fetch failed');
  };
  return calls;
}

describe('BUG-280: the adopted local daemon answers first', () => {
  afterEach(() => { global.fetch = realFetch; });

  it('returns the daemon results and labels the source', async () => {
    stubChain({ local: 'ok' });
    const res = await search.web_search({ query: 'simplest parmesan garlic bread recipe', maxResults: 3 });
    assert.equal(res.ok, true, 'a reachable local daemon must produce a result');
    assert.equal(res.result.source, 'local-websearch');
    assert.equal(res.result.results.length, 3);
    assert.match(res.result.results[0].url, /allrecipes\.com/,
      'the captured wire response has Allrecipes as the top hit — this asserts the parser read it');
  });

  it('maps the daemon field names onto the chain contract', async () => {
    // The daemon calls the snippet `description`; every other provider in this
    // chain calls it `snippet`, and the widget reads `snippet`. A rung that
    // returned `description` would look fine in a count assertion and render
    // blank.
    stubChain({ local: 'ok' });
    const res = await search.web_search({ query: 'x', maxResults: 3 });
    const first = res.result.results[0];
    assert.deepEqual(Object.keys(first).sort(), ['snippet', 'title', 'url']);
    assert.ok(first.snippet.length > 0, 'the snippet must survive the field rename');
  });

  it('short-circuits: no other provider is contacted when the daemon answers', async () => {
    // Assert the MECHANISM. Spending a 150/day Exa quota after a free local
    // engine already answered is backwards, and a result-count assertion would
    // not notice.
    const calls = stubChain({ local: 'ok' });
    await search.web_search({ query: 'x', maxResults: 3 });
    const offHost = calls.filter((u) => !u.includes('127.0.0.1') && !u.includes('localhost'));
    assert.deepEqual(offHost, [], 'nothing beyond loopback should have been contacted');
  });

  it('an absent daemon is diagnosable: the failure names the connection refusal', async () => {
    // The portability contract. No daemon installed must not be silent, and must
    // not be fatal either — the chain has to carry on to the other providers.
    stubChain({ local: 'refused', wiki: 'empty' });
    const res = await search.web_search({ query: 'x', maxResults: 3 });
    assert.equal(res.ok, false);
    assert.match(res.result, /local-websearch/, 'the rung must appear in the tried list');
    assert.match(res.result, /ECONNREFUSED|refused/i,
      'the cause must be the connection refusal, not a generic "no results"');
    assert.match(res.result, /wikipedia/, 'and the chain must have continued past it');
  });

  it('a daemon that errors is reported as an error, not as no results', async () => {
    stubChain({ local: 'error', wiki: 'empty' });
    const res = await search.web_search({ query: 'x', maxResults: 3 });
    assert.match(res.result, /local-websearch HTTP 500/);
  });
});

describe('BUG-280: Wikipedia answers a natural-language query', () => {
  afterEach(() => { global.fetch = realFetch; });

  it('uses full-text search, not title-prefix matching', async () => {
    const calls = stubChain({ local: 'refused' });
    await search.web_search({ query: 'who is Ada Lovelace', maxResults: 3 });
    const wiki = calls.find((u) => u.includes('wikipedia.org'));
    assert.ok(wiki, 'wikipedia must have been reached');
    assert.match(wiki, /action=query/, 'action=opensearch cannot answer a sentence');
    assert.match(wiki, /list=search/);
  });

  it('parses the full-text shape into the chain contract', async () => {
    stubChain({ local: 'refused' });
    const res = await search.web_search({ query: 'who is Ada Lovelace', maxResults: 3 });
    assert.equal(res.ok, true);
    assert.equal(res.result.source, 'wikipedia');
    assert.equal(res.result.results[0].title, WIKI.query.search[0].title);
    assert.match(res.result.results[0].url, /^https:\/\/en\.wikipedia\.org\/wiki\//,
      'list=search returns titles, not URLs — the URL has to be built');
    assert.ok(res.result.results[0].snippet.length > 0);
    assert.ok(!/<span|<\/span>/.test(res.result.results[0].snippet),
      'list=search snippets carry HTML highlight markup; it must be stripped before it is spoken');
  });
});

describe('BUG-280: the loopback guard on WEB_SEARCH_LOCAL_URL', () => {
  // These exist because mutation testing found the guard had NO test: deleting
  // the loopback check left the suite fully green. It is the most
  // security-relevant line in the change — this rung fetches a URL taken from
  // configuration — so a green suite over it was evidence against the change,
  // not for it.
  const realEnv = process.env.WEB_SEARCH_LOCAL_URL;
  const realEngines = process.env.WEB_SEARCH_ENGINES;
  afterEach(() => {
    if (realEnv === undefined) delete process.env.WEB_SEARCH_LOCAL_URL;
    else process.env.WEB_SEARCH_LOCAL_URL = realEnv;
    if (realEngines === undefined) delete process.env.WEB_SEARCH_ENGINES;
    else process.env.WEB_SEARCH_ENGINES = realEngines;
    global.fetch = realFetch;
  });

  it('accepts loopback and builds the /search path', () => {
    for (const host of ['http://127.0.0.1:3100', 'http://localhost:3100', 'http://127.0.0.1:9999']) {
      process.env.WEB_SEARCH_LOCAL_URL = host;
      const r = search._resolveLocalSearchUrl();
      assert.equal(r.ok, true, host + ' is loopback and must be accepted');
      assert.ok(r.url.endsWith('/search'));
    }
  });

  it('refuses a non-loopback host by name', () => {
    process.env.WEB_SEARCH_LOCAL_URL = 'http://evil.example.com:3100';
    const r = search._resolveLocalSearchUrl();
    assert.equal(r.ok, false);
    assert.match(r.reason, /WEB_SEARCH_LOCAL_URL/, 'the operator must be told which key to fix');
    assert.match(r.reason, /evil\.example\.com/, 'and what value was rejected');
  });

  it('refuses a non-loopback host even over https', () => {
    // https is not a safety property here. The guard is about WHERE, not how.
    process.env.WEB_SEARCH_LOCAL_URL = 'https://evil.example.com';
    assert.equal(search._resolveLocalSearchUrl().ok, false);
  });

  it('refuses a host that merely contains a loopback substring', () => {
    // The bypass a substring check would allow.
    process.env.WEB_SEARCH_LOCAL_URL = 'http://127.0.0.1.evil.example.com';
    assert.equal(search._resolveLocalSearchUrl().ok, false);
    process.env.WEB_SEARCH_LOCAL_URL = 'http://localhost.evil.example.com';
    assert.equal(search._resolveLocalSearchUrl().ok, false);
  });

  it('refuses a non-http scheme and an unparseable value', () => {
    process.env.WEB_SEARCH_LOCAL_URL = 'file:///etc/passwd';
    assert.equal(search._resolveLocalSearchUrl().ok, false);
    process.env.WEB_SEARCH_LOCAL_URL = 'not a url at all';
    assert.equal(search._resolveLocalSearchUrl().ok, false);
  });

  it('never issues the request for a rejected host, and says why in the chain failure', async () => {
    // Assert the MECHANISM: a refusal that still made the request would be the
    // guard wearing a fix's clothes.
    process.env.WEB_SEARCH_LOCAL_URL = 'http://evil.example.com';
    const calls = stubChain({ wiki: 'empty' });
    const res = await search.web_search({ query: 'x', maxResults: 3 });
    assert.deepEqual(calls.filter((u) => u.includes('evil.example.com')), [],
      'the rejected host must never be contacted');
    assert.match(res.result, /WEB_SEARCH_LOCAL_URL/,
      'and the chain failure must name the misconfigured key, not report "no results"');
  });

  it('the engine list is read from config, trimmed, and never empty', () => {
    process.env.WEB_SEARCH_ENGINES = ' startpage , bing ,, ';
    assert.deepEqual(search._localSearchEngines(), ['startpage', 'bing']);
    delete process.env.WEB_SEARCH_ENGINES;
    assert.deepEqual(search._localSearchEngines(), ['startpage'],
      'the default must be the engine measured working, not the one that 301s');
  });
});

describe('BUG-280: deliberate non-changes', () => {
  // Q8. Each of these was considered and rejected, so an undocumented choice
  // does not read as an oversight and get "tidied up" later.
  it('the DuckDuckGo rungs are deliberately kept', () => {
    // They are unreachable from THIS machine — three hosts, all `fetch failed`,
    // against a 200-in-234ms control. That is this host's network, not the
    // provider, and other people's clones will reach them. Removing them would
    // be optimising the open-source project for one operator's ISP.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'effectors', 'web-search.js'), 'utf8');
    assert.match(src, /html\.duckduckgo\.com/, 'ddg-html must still be in the chain');
    assert.match(src, /lite\.duckduckgo\.com/, 'ddg-lite must still be in the chain');
    assert.ok(typeof search._ddgHtml === 'function');
    assert.ok(typeof search._ddgLite === 'function');
  });

  it('exa stays in the chain despite the spent free tier', () => {
    // A spent daily quota is a temporary state, and EXA_API_KEY raises it. The
    // rung is not the defect.
    assert.ok(typeof search._exaMcpSearch === 'function');
  });
});

// ---------------------------------------------------------------------------
// BUG-280, second half — a STALE answer returned as a fresh one.
//
// THE INCIDENT, and it is the sibling of BUG-291. 2026-08-20: web_search ran for
// "Durand Cup East Bengal vs Mohun Bagan result August 20 2026", came back
// ok:true with source:'wikipedia', and the five results were Durand Cup pages
// from 2023 and 2025. MYTHOS read them correctly at first — "the search results
// show Durand Cup finals of previous years, not today's result" — and then, two
// turns later, told the operator Mohun Bagan had won and WROTE THAT TO A NOTE.
//
// The chain did nothing wrong: Wikipedia is the last rung and, on that host, the
// only live one. The defect is that ok:true + source:'wikipedia' carries no
// signal that an encyclopaedia cannot answer "what was today's result", so the
// model had a success and a gap and filled the gap. Same missing-signal class as
// BUG-291 (a successful navigate that read no page) — one is an empty body, this
// one is a body from the wrong decade.
// ---------------------------------------------------------------------------
describe('BUG-280: a stale source is labelled stale', () => {
  afterEach(() => { global.fetch = realFetch; });

  const LIVE_QUERY = 'Durand Cup East Bengal vs Mohun Bagan result August 20 2026';

  it('a time-sensitive query answered from Wikipedia carries an explicit caution', async () => {
    stubChain({ local: 'refused' });
    const res = await search.web_search({ query: LIVE_QUERY, maxResults: 5 });
    assert.equal(res.ok, true, 'the results are real results — this must not become a failure');
    assert.equal(res.result.source, 'wikipedia');
    assert.ok(res.result.caution, 'a time-sensitive query answered by an encyclopaedia must say so');
    // AMENDED by BUG-294's review. The first version of this asserted the word
    // "encyclopaedia", because the guard was keyed on a list of source NAMES. That
    // was wrong: a name list leaves every rung added later silently exempt, and it
    // cost a real defect inside one commit — the local daemon returns UNDATED
    // results, was not on the list, and answered a live football question with a
    // fixture that never took place. The invariant is provable recency, so the
    // caution names the missing date rather than the source's genre.
    assert.match(res.result.caution, /NO publication date/i,
      'the caution has to name WHY the answer cannot be shown to be current');
    assert.match(res.result.caution, /do NOT/i,
      'and it has to forbid the invented answer — that is the behaviour being fixed');
  });

  it('the results themselves are untouched — the caution adds, it does not redact', async () => {
    stubChain({ local: 'refused' });
    const res = await search.web_search({ query: LIVE_QUERY, maxResults: 5 });
    assert.ok(res.result.results.length > 0, 'the operator still gets what was found');
    assert.equal(res.result.results[0].title, WIKI.query.search[0].title);
  });

  // AMENDED by BUG-294's review, and the amendment IS the finding. This used to
  // assert that the local daemon answering a live query carried no caution, on the
  // reasoning that a live engine is the right source for a live question. It is
  // not, if it cannot say WHEN: localWebSearch maps { title, url, snippet } with no
  // date field at all, so its answer to "what was today's result" is
  // indistinguishable from its answer about last season. That is not hypothetical
  // — commit f34be26 recorded the daemon returning "Mohun Bagan edge past East
  // Bengal", a fixture that never took place, and it was accepted as proof the
  // freshness fix worked.
  it('an UNDATED live engine answering a live question IS cautioned', async () => {
    stubChain({ local: 'ok' });
    const res = await search.web_search({ query: LIVE_QUERY, maxResults: 3 });
    assert.equal(res.result.source, 'local-websearch');
    assert.ok(res.result.caution,
      'being a live engine is not the same as being able to prove recency');
  });

  // NEGATIVE CONTROL 1 — the real one. Hedging every search result teaches the
  // model to distrust all of them, which is a worse failure than the one being
  // fixed, so a source that CAN prove recency must come through clean.
  it('a DATED source answering the same question carries no caution', async () => {
    stubChain({ local: 'ok' });
    const res = await search.web_search({ query: 'x', maxResults: 3 });
    const dated = search._succeed(LIVE_QUERY, res.result.results.map(
      (r) => Object.assign({}, r, { published: '5h ago' })), 'google-news-rss');
    assert.equal(dated.result.caution, undefined,
      'a per-result date is the exemption — do not invent doubt about a dated answer');
  });

  // NEGATIVE CONTROL 2 — Wikipedia is the RIGHT source for a timeless question.
  // Without this the guard degenerates into "always distrust Wikipedia".
  it('a timeless query answered from Wikipedia carries no caution', async () => {
    stubChain({ local: 'refused' });
    const res = await search.web_search({ query: 'who is Ada Lovelace', maxResults: 3 });
    assert.equal(res.result.source, 'wikipedia');
    assert.equal(res.result.caution, undefined,
      'an encyclopaedia answering an encyclopaedia question is not a defect');
  });

  it('the freshness test is on the QUERY, and it is exported so it can be argued with', () => {
    // Q1 — WHAT ELSE MATCHES THIS? It is a word list over attacker-adjacent
    // input (the operator's own speech, via STT that produced "आदिए" that day),
    // so it will over-match: "the result of the French Revolution" trips it and
    // gets a caution it does not need. That is deliberate — the failure mode of
    // a false positive is one extra sentence of hedging, and the failure mode of
    // a false negative is a fabricated football score written to a note.
    assert.equal(typeof search._isTimeSensitive, 'function');
    assert.equal(search._isTimeSensitive(LIVE_QUERY), true);
    assert.equal(search._isTimeSensitive('what is the score'), true);
    assert.equal(search._isTimeSensitive('weather in Kolkata today'), true);
    assert.equal(search._isTimeSensitive('latest news'), true);
    assert.equal(search._isTimeSensitive('who is Ada Lovelace'), false);
    assert.equal(search._isTimeSensitive('parmesan garlic bread recipe'), false);
  });
});
