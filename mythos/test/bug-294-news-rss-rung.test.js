'use strict';

// test/bug-294-news-rss-rung.test.js — BUG-294.
//
// WHY SEARCH FAILS TODAY, measured on this host 2026-08-21. Every free provider
// except Wikipedia is dead: exa skipped (no EXA_API_KEY), exa-mcp HTTP 429 (the
// 150/day free cap, spent), ddg-html + ddg-lite + api.duckduckgo.com all `fetch
// failed` at ~10.5s (host-blocked), jina HTTP 401 (the vendor removed the free
// no-key tier). Control in the same run: example.com HTTP 200 in 234ms, so the
// network is fine and none of this is a MYTHOS regression. Audit for 2026-08-20:
// web_search 8 ok / 8 fail, and the "ok" that mattered was source:wikipedia
// answering a 2026 live-score question with 2023 and 2025 pages.
//
// THE FIX, AND WE ALREADY OWN THE CODE. server/news-feed.js has pointed at
// news.google.com/rss since the HUD news card shipped: a pure parseRss(), an
// agoLabel(), MAX_ITEMS 12 and an 8s timeout, all inside the search chain's own
// provider budget. Exactly two things were missing — the module never passed a
// QUERY (the same host accepts /rss/search?q=), and it was wired to the HUD card
// only, so the voice path could not reach it.
//
// CAPTURED, NOT INVENTED. test-fixtures/news-rss/search-mohun-bagan.xml is a real
// response for q=Mohun+Bagan+Durand+Cup, taken 2026-08-21 (92 items live, trimmed
// to the first 6 for the repo). Its first title is the whole reason this rung
// works:
//   "Durand Cup 2026 semifinal Highlights: Mohun Bagan beats NorthEast United on
//    penalties to reach final - Sportstar"
// Who played, what happened, how, and the publisher — all in the title string. So
// the headline IS the answer and no article is ever fetched.
//
// AND THE LINK IS NOT A CITATION. Google News RSS <link> is an opaque Google
// redirector (https://news.google.com/rss/articles/CBMiigJBVV95cUxPc3J1…). It
// passes parseRss's ^https?:// guard and therefore flows through looking like a
// normal URL, and news-feed.js's httpGet already follows redirects — so fetching
// one would walk an attacker-influenced redirect chain, the same shape as the two
// SSRF bypasses already recorded in web-fetch.js. It is display/attribution only,
// and the publisher name is already in the title suffix.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const search = require('../src/core/effectors/web-search');
const newsFeed = require('../../mythos/server/news-feed');

const FIXTURE = fs.readFileSync(
  path.join(__dirname, '..', 'test-fixtures', 'news-rss', 'search-mohun-bagan.xml'), 'utf8');

const realFetch = global.fetch;

// Records every URL the chain asks for. Only news.google.com answers; everything
// else fails, so nothing here can reach the network and quietly pass on a real
// provider. node --test collects everything under test/, so a network-dependent
// test would block every commit the day Google rate-limits.
function stubNews(opts) {
  const o = opts || {};
  const calls = [];
  global.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('news.google.com')) {
      if (o.news === 'error') return { ok: false, status: 503, text: async () => 'unavailable' };
      return { ok: true, status: 200, text: async () => (o.body === undefined ? FIXTURE : o.body) };
    }
    if (u.includes('wikipedia.org')) {
      return { ok: true, json: async () => ({ query: { search: [{ title: 'Durand Cup', snippet: 'old', pageid: 1 }] } }) };
    }
    throw new Error('fetch failed');
  };
  return calls;
}

describe('BUG-294: the query actually reaches Google News', () => {
  afterEach(() => { global.fetch = realFetch; });

  it('a freshness-marked search requests /rss/search with the encoded terms', async () => {
    const calls = stubNews({});
    await search.web_search({ query: 'Mohun Bagan Durand Cup result today', maxResults: 5 });
    const news = calls.find((u) => u.includes('news.google.com'));
    assert.ok(news, 'the news rung must have been reached at all');
    assert.match(news, /\/rss\/search\?q=/,
      'the module has always pointed at the generic FRONT PAGE — a rung that never sends the '
      + 'query answers a different question than the one asked');
    assert.match(news, /Mohun\+Bagan|Mohun%20Bagan/, 'the search terms must actually be in the URL');
  });

  // Portability, per the root CLAUDE.md rule. Measured 2026-08-21 on the same
  // query: no locale params -> 92 items; hl=en-IN&gl=IN -> 92 items, identical
  // top result; hl=en-US&gl=US -> 100 items, different ranking. Identical results
  // with NO locale, and the en-US row proves it is a real knob — which is exactly
  // why it must be the operator's choice rather than a baked-in constant that
  // degrades results for every other clone of this open-source repo.
  it('no locale is hardcoded into the feed URL', async () => {
    const calls = stubNews({});
    await search.web_search({ query: 'latest news', maxResults: 5 });
    const news = calls.find((u) => u.includes('news.google.com'));
    assert.doesNotMatch(news, /[?&]hl=/, 'hl= is a user-specific value and must not be hardcoded');
    assert.doesNotMatch(news, /[?&]gl=/, 'gl= is a machine-specific value and must not be hardcoded');
  });

  it('the HUD news card is unchanged: no query still means the bare front page', () => {
    assert.equal(typeof newsFeed.feedUrl, 'function', 'the URL builder must be exported to be testable');
    assert.equal(newsFeed.feedUrl(), 'https://news.google.com/rss');
    assert.equal(newsFeed.feedUrl(''), 'https://news.google.com/rss');
    assert.equal(newsFeed.feedUrl('   '), 'https://news.google.com/rss',
      'a whitespace-only query is not a query — the card must not silently start searching for it');
    assert.equal(newsFeed.feedUrl('Kolkata news'),
      'https://news.google.com/rss/search?q=Kolkata%20news');
  });
});

describe('BUG-294: the rung is preferred over the encyclopaedia for a live question', () => {
  afterEach(() => { global.fetch = realFetch; });

  it('a freshness-marked query never reaches Wikipedia', async () => {
    // Assert the MECHANISM. A result-count assertion would pass just as happily
    // with the rung sitting after Wikipedia, which is the arrangement that
    // produced the 2023 Durand Cup answer in the first place.
    const calls = stubNews({});
    const res = await search.web_search({ query: 'Durand Cup result August 20 2026', maxResults: 5 });
    assert.equal(res.ok, true);
    assert.equal(res.result.source, 'google-news-rss');
    assert.deepEqual(calls.filter((u) => u.includes('wikipedia.org')), [],
      'Wikipedia must not even be contacted once a live source has answered');
  });

  it('the answer carries the headline verbatim — the headline IS the answer', async () => {
    stubNews({});
    const res = await search.web_search({ query: 'Mohun Bagan result today', maxResults: 5 });
    assert.match(res.result.results[0].title,
      /Mohun Bagan beats NorthEast United on penalties to reach final/,
      'who played, what happened and how are all in the title string — that is why no article '
      + 'is ever fetched');
  });

  it('each result carries its age, so a stale item cannot pass as current', async () => {
    stubNews({});
    const res = await search.web_search({ query: 'Mohun Bagan result today', maxResults: 5 });
    const withAge = res.result.results.filter((r) => /\b\d+[mhd] ago\b/.test(String(r.snippet)));
    assert.ok(withAge.length > 0,
      'agoLabel() is the freshness signal, and it is better than a raw timestamp for a spoken '
      + 'answer — without it the model cannot tell today from last year');
  });

  it('a timeless query still lets the encyclopaedia answer', async () => {
    // The negative control. Google News is the wrong source for "who is Ada
    // Lovelace", and a rung that hijacks every query is its own defect.
    const calls = stubNews({});
    const res = await search.web_search({ query: 'who is Ada Lovelace', maxResults: 3 });
    assert.equal(res.result.source, 'wikipedia');
    assert.ok(calls.some((u) => u.includes('wikipedia.org')));
  });

  // CORRECTION 6, and this is the safety property of the whole rung rather than
  // a tidiness preference. Measured 2026-08-21: Google News RSS NEVER returns
  // zero. "FIFA World Cup 2030 host countries" -> 100 items, correct and useful.
  // "Argentina FIFA ranking" -> 100 items, top hit a World Cup power-rankings
  // piece: related, and NOT the answer. "how to fix a leaking tap" -> 59 items,
  // top hit a content farm. A source that always produces something plausible is
  // the worst possible partner for a model that already fabricates, because
  // unlike an empty result it can never trigger an "I don't have this" path.
  it('a how-to question never reaches the RSS rung at all', async () => {
    // Assert the MECHANISM. "the answer came from elsewhere" would pass just as
    // happily with RSS sitting in the chain as a catch-all and merely losing a
    // race, which is the arrangement this test exists to forbid.
    const calls = stubNews({});
    await search.web_search({ query: 'how to fix a leaking tap', maxResults: 5 });
    assert.deepEqual(calls.filter((u) => u.includes('news.google.com')), [],
      'no freshness marker means no RSS request — not "RSS tried and lost"');
  });

  it('RSS does not occupy the last-resort slot: there is no second attempt after Wikipedia', () => {
    // Deliberately the ONLY source-shape assertion left in this file, and it is a
    // negative one (no second occurrence), which is the shape least sensitive to
    // a comment edit — this repo has been bitten by brittle source-position
    // windows before. Everything about ORDER is asserted behaviourally below.
    const chain = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'effectors', 'web-search.js'), 'utf8');
    const wikiRung = chain.indexOf('5. Wikipedia full-text search');
    assert.ok(wikiRung > 0);
    assert.equal(chain.slice(wikiRung).indexOf("'google-news-rss'"), -1,
      'there must be no second RSS attempt after Wikipedia — that would be the catch-all '
      + 'Correction 6 forbids');
  });

  it('a news result is never labelled with the stale-source caution', async () => {
    stubNews({});
    const res = await search.web_search({ query: 'Durand Cup result today', maxResults: 5 });
    assert.equal(res.result.caution, undefined,
      'the caution exists for encyclopaedic answers to live questions — hedging a live source '
      + 'would teach the model to distrust the one rung that can answer');
  });
});

describe('BUG-294: the redirector link is never fetched', () => {
  afterEach(() => { global.fetch = realFetch; });

  it('no request is issued for any item link', async () => {
    // Correction 3, and the reason this is asserted on the MECHANISM rather than
    // on the result: news-feed.js's httpGet follows up to 3 redirects, so one
    // fetch of an opaque /rss/articles/ blob walks an attacker-influenced
    // redirect chain — the exact shape of the two SSRF bypasses already recorded
    // in web-fetch.js (IPv4-mapped loopback, and a 302 to cloud metadata).
    const calls = stubNews({});
    await search.web_search({ query: 'Mohun Bagan result today', maxResults: 5 });
    assert.deepEqual(calls.filter((u) => u.includes('/rss/articles/')), [],
      'the item link is display/attribution only — the publisher is already in the title suffix');
    assert.equal(calls.filter((u) => u.includes('news.google.com')).length, 1,
      'exactly one request: the feed itself');
  });

  it('the links still reach the operator for attribution', async () => {
    stubNews({});
    const res = await search.web_search({ query: 'Mohun Bagan result today', maxResults: 5 });
    assert.match(res.result.results[0].url, /^https:\/\//,
      'display-only does not mean dropped — the card still shows where it came from');
  });
});

describe('BUG-294: failure and non-changes', () => {
  afterEach(() => { global.fetch = realFetch; });

  it('a dead feed is named in the failure and the chain continues', async () => {
    const calls = stubNews({ news: 'error' });
    global.fetch = (function (inner) {
      return async (url) => {
        const u = String(url);
        if (u.includes('wikipedia.org')) return { ok: true, json: async () => ({ query: { search: [] } }) };
        return inner(url);
      };
    })(global.fetch);
    const res = await search.web_search({ query: 'result today', maxResults: 5 });
    assert.equal(res.ok, false);
    assert.match(res.result, /google-news-rss/, 'the rung must appear in the tried list');
    assert.match(res.result, /wikipedia/, 'and the chain must have carried on past it');
    assert.ok(calls.length > 0);
  });

  // Correction 4. parseRss already returns everything needed and the HUD card
  // depends on it. Leaving it untouched keeps that card safe by construction
  // rather than by test, so this pins that it was not "improved" in passing.
  it('parseRss was not modified — the HUD card is safe by construction', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'news-feed.js'), 'utf8');
    const body = (src.match(/function parseRss\(xml, now\) \{[\s\S]*?\n\}/) || [])[0];
    assert.ok(body, 'parseRss(xml, now) must still exist with its original signature');
    assert.match(body, /items\.length < MAX_ITEMS/);
    assert.match(body, /if \(!\/\^https\?:\\\/\\\/\/i\.test\(url\)\) continue;/);
    assert.match(body, /ago: agoLabel\(pub, now \|\| Date\.now\(\)\),/);
  });

  // Correction 5. A newly created effector is invisible to the Live model unless
  // it is in DEFAULT_ALLOWLIST, which is how nine previous fixes in this repo went
  // inert. Routing through web_search sidesteps that entirely — this pins that it
  // stays routed that way.
  it('the rung ships inside web_search, which is already in the Live allowlist', () => {
    const liveTools = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'voice', 'live-tools.js'), 'utf8');
    assert.match(liveTools, /'web_search'/,
      'web_search must still be in DEFAULT_ALLOWLIST, or the voice path cannot reach this rung');
    // BUG-315 moved the rung's body from web-search.js into news-rung.js, so
    // this can no longer look for the require in one named file — that pinned a
    // LOCATION where the invariant is "reuse server/news-feed, do not
    // reimplement parseRss". Read both files: the chain must reach the rung, and
    // the rung must reach the module we already own.
    const chain = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'effectors', 'web-search.js'), 'utf8');
    const rung = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'effectors', 'news-rung.js'), 'utf8');
    assert.match(chain, /news-rung/, 'web_search must still reach the news rung');
    assert.match(rung, /news-feed/, 'the rung must call the module we already own, not a copy of it');
    assert.doesNotMatch(rung, /function parseRss/,
      'parseRss must stay in server/news-feed.js — a second copy is the defect this guards');
  });
});

// ---------------------------------------------------------------------------
// BUG-294 review round 2. The rung was correct and UNREACHABLE for the exact
// queries it was built for, because it sat at 0b — AFTER the local daemon at 0a.
// Since BUG-288 the daemon autostarts, so this was armed, not latent:
//
//   1. isTimeSensitive("...result today") -> true
//   2. rung 0a ran anyway, because the gate was only on 0b
//   3. localWebSearch maps { title, url, snippet: r.description } — NO DATE
//   4. non-empty -> returned immediately as 'local-websearch'
//   5. 'local-websearch' was not in the caution's name list -> NO CAUTION
//   6. the RSS rung never executed
//
// EVIDENCE THIS IS REAL, from this branch's own commit f34be26: its end-to-end
// verification reported the daemon returning "Mohun Bagan edge past East Bengal
// with a hard-fought win". On 2026-08-20 Mohun Bagan played NORTHEAST UNITED —
// the captured RSS title from the same day says so. East Bengal and Mohun Bagan
// had not met; MB was qualifying to face them. So an undated older fixture was
// accepted as proof that the freshness fix worked, which is the precise failure
// the caution exists to prevent.
//
// AND THE CAUTION WAS KEYED ON THE WRONG PROPERTY. A list of source NAMES has to
// be extended by hand for every new rung — this repo's phantom-allowlist class,
// where a name list outlives the thing it names. The real invariant is whether
// the winning source can PROVE recency, i.e. whether its results carry a date.
// ---------------------------------------------------------------------------
describe('BUG-294: the daemon must not preempt the news rung on a live question', () => {
  afterEach(() => { global.fetch = realFetch; });

  const DAEMON_UNDATED = {
    status: 'ok',
    data: {
      query: 'x',
      engines: ['bing'],
      totalResults: 2,
      results: [
        { title: 'Mohun Bagan edge past East Bengal with a hard-fought win',
          url: 'https://example.com/a', description: 'Match report.', source: 'example.com', engine: 'bing' },
        { title: 'Durand Cup preview', url: 'https://example.com/b',
          description: 'Preview.', source: 'example.com', engine: 'bing' },
      ],
    },
  };

  function stubWithDaemon() {
    const calls = [];
    global.fetch = async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('127.0.0.1') || u.includes('localhost')) {
        return { ok: true, status: 200, json: async () => DAEMON_UNDATED,
          text: async () => JSON.stringify(DAEMON_UNDATED) };
      }
      if (u.includes('news.google.com')) return { ok: true, status: 200, text: async () => FIXTURE };
      if (u.includes('wikipedia.org')) return { ok: true, json: async () => ({ query: { search: [] } }) };
      throw new Error('fetch failed');
    };
    return calls;
  }

  it('a live question reaches the news rung even when the daemon has plausible results', async () => {
    const calls = stubWithDaemon();
    const res = await search.web_search({ query: 'East Bengal vs Mohun Bagan result today', maxResults: 5 });
    assert.ok(calls.some((u) => u.includes('news.google.com')),
      'the RSS fetch must have been ISSUED — asserting only the final source would pass with '
      + 'the rung merely losing a race it should never have entered');
    assert.equal(res.result.source, 'google-news-rss',
      'a dated source must win a dated question, whatever the undated one found first');
  });

  it('a timeless question still lets the daemon answer first', async () => {
    // The negative control for the reordering: moving the news rung above 0a must
    // not demote the daemon for everything else.
    const calls = stubWithDaemon();
    const res = await search.web_search({ query: 'parmesan garlic bread recipe', maxResults: 5 });
    assert.equal(res.result.source, 'local-websearch');
    assert.deepEqual(calls.filter((u) => u.includes('news.google.com')), []);
  });

  it('an undated source answering a live question is cautioned, whatever its name', async () => {
    // Defect 2. The caution must key on "can this source prove recency", not on a
    // hardcoded list of names — otherwise every new rung silently arrives exempt.
    const calls = stubWithDaemon();
    global.fetch = (function (inner) {
      return async (url) => {
        if (String(url).includes('news.google.com')) throw new Error('fetch failed');
        return inner(url);
      };
    })(global.fetch);
    const res = await search.web_search({ query: 'East Bengal vs Mohun Bagan result today', maxResults: 5 });
    assert.equal(res.ok, true);
    assert.equal(res.result.source, 'local-websearch');
    assert.ok(res.result.caution,
      'an undated result set answering a dated question is exactly the shape that produced '
      + '"Mohun Bagan edge past East Bengal" — a fixture that never took place');
    assert.ok(calls.length > 0);
  });

  it('a dated source answering a live question is NOT cautioned', async () => {
    stubWithDaemon();
    const res = await search.web_search({ query: 'Mohun Bagan result today', maxResults: 5 });
    assert.equal(res.result.source, 'google-news-rss');
    assert.equal(res.result.caution, undefined,
      'the exemption belongs to sources that carry a date, and RSS does');
  });

  it('Defect 4 — an item with no usable pubDate is labelled, never returned looking normal', async () => {
    // agoLabel() returns '' for a missing/unparseable pubDate. For a rung whose
    // entire safety property is freshness, a silently undated item is the one
    // result the model must not read as current.
    const noDate = FIXTURE.replace(/<pubDate>[\s\S]*?<\/pubDate>/g, '');
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('news.google.com')) return { ok: true, status: 200, text: async () => noDate };
      if (u.includes('wikipedia.org')) return { ok: true, json: async () => ({ query: { search: [] } }) };
      throw new Error('fetch failed');
    };
    const res = await search.web_search({ query: 'Mohun Bagan result today', maxResults: 5 });
    assert.equal(res.result.source, 'google-news-rss');
    for (const r of res.result.results) {
      assert.notEqual(r.snippet, '', 'an empty snippet is an item with no freshness signal at all');
      assert.match(String(r.snippet), /date unknown/i);
    }
    assert.ok(res.result.caution,
      'if not one item can prove its age, the batch cannot prove recency and must be cautioned');
  });
});

// ---------------------------------------------------------------------------
// BUG-294 follow-up — the recency window. Shipped after the first round measured
// the rung answering "Kolkata local news today" with items 85, 52 and 107 days
// old: Google ranks by relevance, not recency, and "today" in the query text
// carries no weight with it. The age labels made that honest, but honest and
// useless is still useless.
//
// MEASURED 2026-08-21, three real queries x four windows:
//
//   "Kolkata local news today"        (none) 12 items, top 85d ago
//                                     when:1d 12 items, top 1h ago
//                                     when:3d 12 items, top 2d ago
//                                     when:7d 12 items, top 2d ago
//   "…Durand Cup result today"        (none) 12 items, top 6h ago
//                                     when:1d 12 items, top 6h ago
//                                     when:7d 12 items, but 4d-old items admitted
//   "Bengal panchayat election news"  (none) 12 items, top 26d ago
//                                     when:1d  2 items, top 6h ago
//                                     when:7d  5 items, top 2d ago
//
// Two things follow, and they are why this is an escalation rather than one
// constant. A tight window is right for "today" and starves a slower topic (the
// panchayat query drops from 12 to 2); a loose one re-admits 2-4 day old items
// into a question that said today. So: ask for 1 day, and widen to 7 only when 1
// came back empty.
//
// AND IT REPAIRS THE SAFETY PROPERTY RATHER THAN WEAKENING IT. The unwindowed
// endpoint NEVER returns zero — that is why the freshness gate exists at all. A
// windowed one can, and does (2 items, and 0 for a quiet topic), so the rung can
// now decline instead of always producing something plausible. The chain then
// continues, which is the honest outcome.
//
// The window is added by the RUNG, never by feedUrl() — the HUD news card must
// keep asking for exactly what it always asked for.
// ---------------------------------------------------------------------------
describe('BUG-294 follow-up: the recency window', () => {
  afterEach(() => { global.fetch = realFetch; });

  const EMPTY_FEED = '<rss><channel><title>x</title></channel></rss>';

  function stubWindows(byWindow) {
    const calls = [];
    global.fetch = async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('news.google.com')) {
        const key = /when%3A1d|when:1d/.test(u) ? '1d' : (/when%3A7d|when:7d/.test(u) ? '7d' : 'none');
        const body = byWindow[key];
        return { ok: true, status: 200, text: async () => (body === undefined ? EMPTY_FEED : body) };
      }
      if (u.includes('wikipedia.org')) return { ok: true, json: async () => ({ query: { search: [] } }) };
      throw new Error('fetch failed');
    };
    return calls;
  }

  it('a freshness-marked query asks for the last day first', async () => {
    const calls = stubWindows({ '1d': FIXTURE });
    await search.web_search({ query: 'Kolkata local news today', maxResults: 5 });
    const news = calls.filter((u) => u.includes('news.google.com'));
    assert.equal(news.length, 1, 'one request when the tight window answers');
    assert.match(news[0], /when%3A1d|when:1d/,
      'without a window Google ranks by relevance and answered "today" with an 85-day-old item');
  });

  it('an empty day widens to a week, once', async () => {
    const calls = stubWindows({ '7d': FIXTURE });
    const res = await search.web_search({ query: 'Bengal panchayat election news', maxResults: 5 });
    const news = calls.filter((u) => u.includes('news.google.com'));
    assert.equal(news.length, 2, 'exactly two attempts — tight, then wide, and no further');
    assert.match(news[1], /when%3A7d|when:7d/);
    assert.equal(res.result.source, 'google-news-rss');
  });

  it('a productive day window is NOT widened — assert the mechanism', async () => {
    // A result-count assertion would pass just as happily with both requests
    // issued and the second discarded, which is a wasted round-trip on the voice
    // path's critical latency.
    const calls = stubWindows({ '1d': FIXTURE, '7d': FIXTURE });
    await search.web_search({ query: 'Kolkata local news today', maxResults: 5 });
    assert.deepEqual(calls.filter((u) => /when%3A7d|when:7d/.test(u)), []);
  });

  it('both windows empty: the rung declines and the chain carries on', async () => {
    // The repaired safety property. The unwindowed endpoint never returns zero;
    // a windowed one can, so the rung is now able to have no answer.
    const calls = stubWindows({});
    const res = await search.web_search({ query: 'some very quiet topic today', maxResults: 5 });
    assert.equal(calls.filter((u) => u.includes('news.google.com')).length, 2);
    assert.ok(calls.some((u) => u.includes('wikipedia.org')), 'the chain must continue past it');
    assert.equal(res.ok, false);
    assert.match(res.result, /google-news-rss/, 'and the rung must be named in the tried list');
  });

  it('the HUD news card never gets a window', () => {
    // feedUrl is the card's own URL builder. The window belongs to the rung.
    assert.equal(newsFeed.feedUrl('Kolkata news'), 'https://news.google.com/rss/search?q=Kolkata%20news');
    assert.equal(newsFeed.feedUrl(), 'https://news.google.com/rss');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'news-feed.js'), 'utf8');
    assert.equal(src.indexOf('when:'), -1,
      'the recency window must not leak into the module the HUD card shares');
  });
});
