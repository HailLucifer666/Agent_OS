'use strict';

// test/bug-276-f3-site-scoped-search-skips-news-rung.test.js
//
// BUG-276 F3, modern form. The 2026-08-19 incident saw a NEWS request routed to
// VIDEO search; BUG-294's Google News RSS rung (2026-08-21) flipped that failure
// around and introduced the mirror image: a NON-news request carrying a single
// freshness word in its title now gets routed to the NEWS provider.
//
// Mechanism, read from source at affd38b:
//   - web_search's news rung gates ONLY on isTimeSensitive(q). Its own comment
//     admits the marker list over-matches ("the result of the French Revolution
//     trips it") and calls that deliberate FOR A PLAIN QUERY, where the worst
//     case is an unnecessary hedge.
//   - But two callers send SITE-SCOPED queries where the intent is explicitly
//     NOT general news:
//       from-dashboard.js  open_web(type:'youtube') -> q + ' site:youtube.com'
//       from-installer.js  repo resolution          -> name + ' site:github.com'
//   - A video titled "Breaking Bad trailer" (matches /breaking/), or a repo
//     named "score-board" (matches /score/), enters the news rung. Google News
//     RSS ignores the site: operator entirely, so the answer is ordinary news
//     articles with zero youtube.com/github.com URLs, and the caller fails hard:
//     open_web returns "could not extract a YouTube video ID" for a request the
//     old chain would have answered.
//
// THE FIX UNDER TEST: a site-scoped query does not enter the news rung at all —
// the scope IS the intent statement. Nothing else about the gate moves; a plain
// freshness-marked query keeps the rung (negative controls below).
//
// Offline by construction, same harness as bug-294-news-rss-rung.test.js: only
// news.google.com and wikipedia.org answer; everything else throws, so nothing
// here can reach the network and quietly pass on a real provider.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const search = require('../src/core/effectors/web-search');

const realFetch = global.fetch;

function stubChain() {
  const calls = [];
  global.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('news.google.com')) {
      return { ok: true, status: 200, text: async () => '<rss><channel><title>x</title></channel></rss>' };
    }
    if (u.includes('wikipedia.org')) {
      return { ok: true, json: async () => ({ query: { search: [{ title: 'Breaking Bad', snippet: 'an American crime drama', pageid: 1 }] } }) };
    }
    throw new Error('fetch failed');
  };
  return calls;
}

describe('BUG-276 F3: a site-scoped query never enters the news rung', () => {
  afterEach(() => { global.fetch = realFetch; });

  it('a freshness word inside a site:youtube.com query does not consult Google News RSS', async () => {
    // "Breaking Bad trailer" matches FRESHNESS_MARKERS via /breaking/. Pre-fix,
    // the news rung ran first on exactly this query.
    const calls = stubChain();
    const res = await search.web_search({ query: 'Breaking Bad trailer site:youtube.com', maxResults: 6 });
    assert.equal(
      calls.filter((u) => u.includes('news.google.com')).length, 0,
      'the site: scope states the intent is youtube.com — the news rung must not intercept it');
    assert.ok(calls.some((u) => u.includes('wikipedia.org')),
      'the chain must continue past where the news rung would have been');
    assert.notEqual(res.result && res.result.source, 'google-news-rss');
  });

  it('the second site-scoped caller: a repo lookup on site:github.com is likewise exempt', async () => {
    // from-installer.js resolves "<name> site:github.com". "score-board"
    // matches /score/. Pre-fix this returned news articles as the repo answer.
    const calls = stubChain();
    await search.web_search({ query: 'score-board site:github.com', maxResults: 5 });
    assert.equal(
      calls.filter((u) => u.includes('news.google.com')).length, 0,
      'site:github.com is a repository lookup — the news rung must not intercept it');
  });

  it('NEGATIVE CONTROL (source shape): the exemption exists AND the plain-query gate still fires first', () => {
    // Pins the guard narrow at the source level: the site: check may only ever
    // appear as an AND-clause on the freshness gate, never as a standalone
    // early-return that could starve plain news queries.
    //
    // BUG-350-sibling extraction (2026-08-24): the predicate now lives in
    // search-intent.js as entersNewsRung() — same conjunction, single source —
    // and web-search.js calls it at the rung. Both halves are pinned.
    const intentSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'effectors', 'search-intent.js'), 'utf8');
    assert.match(intentSrc, /return isTimeSensitive\(q\) && !\/\\bsite:\\S\+\/i\.test\(q\)/,
      'the site: exemption must be conjoined with the freshness gate, not separate');

    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'effectors', 'web-search.js'), 'utf8');
    assert.match(src, /if \(entersNewsRung\(q\)\) \{/,
      'the news-rung gate must go through the shared predicate, not a local re-derivation');
  });

  it('NEGATIVE CONTROL, behavioural: plain news query reaches news.google.com', async () => {
    const calls = stubChain();
    // Empty channel body -> rung declines -> but the REQUEST must have been made.
    await search.web_search({ query: 'Kolkata local news today', maxResults: 5 });
    assert.ok(calls.some((u) => u.includes('news.google.com')),
      'without a site: scope the freshness-marked query must still try the news rung');
  });

  it('Q1 residual: a false-positive site: match degrades gracefully, not fatally', async () => {
    // An attacker-controlled or STT-garbled query can carry "site:<word>" in
    // prose ("latest news about site:reliability"). The exemption then skips
    // the news rung for what is really a news question — accepted over-match,
    // worst case is ordinary chain results instead of RSS. What must NEVER
    // happen is an error: the query falls through the remaining rungs and
    // returns honestly.
    const calls = stubChain();
    const res = await search.web_search({ query: 'latest news about site:reliability', maxResults: 5 });
    assert.equal(calls.filter((u) => u.includes('news.google.com')).length, 0);
    assert.equal(res.ok, true, 'the chain must still answer, not fail');
    assert.ok(Array.isArray(res.result.results) && res.result.results.length > 0,
      'a skipped news rung must not become a failed search');
  });
});
