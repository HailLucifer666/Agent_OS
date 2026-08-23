'use strict';

// test/news-route-honours-topic.test.js — BUG-326, the /api/news half.
//
// WHAT WAS ACTUALLY WRONG. routes/news.js called newsFeed.fetchNews() with no
// arguments, and fetchNews() had no parameter to pass one to. A caller asking
// about a subject got the world's top stories back and no way to tell.
//
// SAID PLAINLY, BECAUSE IT CHANGES WHAT THIS FILE IS: the population of
// affected requests before the change was ZERO. The only caller is the HUD
// widget, ui/public/js/widgets/kinds/news.js, which does fetch('/api/news')
// with no query and has no topic concept. So this pins a new capability, not a
// live failure — and the interesting assertions are the two ways the capability
// could lie.
//
// LIE 1: THE GENERAL FEED AS A FALLBACK. Google News RSS answers essentially any
// query with something plausible; news-rung.js's header records that the
// unwindowed endpoint never returns zero, which is the entire reason the voice
// search chain gates it on a freshness marker. A topic with no coverage that
// silently returned the world's headlines would be indistinguishable from a real
// answer about that topic.
//
// LIE 2: ONE CACHE SLOT. fetchNews held a single `cache` variable. The moment it
// learns topics, the general feed and every topic share it: ask about one
// subject, then open the HUD, and those headlines render as the world's top
// stories. Worse on the failure path — a topical miss would fall back to the
// general feed's STALE items and read as a real, if old, answer.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createNewsFeed, normalizeQuery, MAX_QUERY_CHARS } = require('../server/news-feed');

function rss(titles) {
  return '<rss><channel>' + titles.map((t) =>
    '<item><title>' + t + '</title><link>https://example.invalid/' +
    encodeURIComponent(t) + '</link><pubDate>' + new Date().toUTCString() + '</pubDate></item>'
  ).join('') + '</channel></rss>';
}

// A fake fetcher that answers per URL and records what it was asked for.
function fakeGet(answers) {
  const seen = [];
  return {
    seen,
    get: async (url) => {
      seen.push(url);
      for (const [needle, body] of answers) {
        if (url.includes(needle)) return body;
      }
      throw new Error('unexpected url: ' + url);
    },
  };
}

describe('BUG-326 — /api/news honours its topic', () => {
  it('sends the topic to the feed instead of dropping it', async () => {
    const f = fakeGet([['rss/search', rss(['Nvidia raises AI prices'])]]);
    const feed = createNewsFeed({ get: f.get });
    const res = await feed.fetchNews('AI news this week');
    assert.equal(res.ok, true);
    assert.equal(res.items[0].title, 'Nvidia raises AI prices');
    assert.match(f.seen[0], /rss\/search\?q=AI%20news%20this%20week/);
  });

  it('still serves the general feed when no topic is given', async () => {
    // A fresh feed per argument, because the second call would otherwise be a
    // cache hit and record no URL at all — which is what the first version of
    // this test asserted against, and it read as a pass on undefined.
    for (const arg of [undefined, '', '   ', ['a', 'b'], 42, null]) {
      const f = fakeGet([['news.google.com/rss', rss(['World news'])]]);
      const feed = createNewsFeed({ get: f.get });
      const res = await feed.fetchNews(arg);
      assert.equal(res.ok, true, 'arg ' + JSON.stringify(arg));
      assert.equal(res.query, undefined, 'the general feed must not claim a topic');
      assert.equal(f.seen.length, 1);
      assert.doesNotMatch(f.seen[0], /rss\/search/, 'arg ' + JSON.stringify(arg));
    }
  });

  // THE ASSERTION THIS FILE EXISTS FOR.
  it('returns empty for a topic with no coverage — never the general feed', async () => {
    const f = fakeGet([
      ['rss/search', '<rss><channel></channel></rss>'],
      ['news.google.com/rss', rss(['World news', 'Other world news'])],
    ]);
    const feed = createNewsFeed({ get: f.get });
    const res = await feed.fetchNews('a subject nobody has written about');
    assert.equal(res.ok, false, 'an uncovered topic must not report success');
    assert.deepEqual(res.items, []);
    assert.match(res.error, /no items for topic/);
  });

  it('does not fall back to the general feed even when the general feed is warm', async () => {
    const f = fakeGet([
      ['rss/search', '<rss><channel></channel></rss>'],
      ['news.google.com/rss', rss(['World news'])],
    ]);
    const feed = createNewsFeed({ get: f.get });
    // Warm the general slot first, so a shared cache would have something to
    // hand back on the topical miss.
    const general = await feed.fetchNews();
    assert.equal(general.items[0].title, 'World news');

    const topical = await feed.fetchNews('nothing here');
    assert.equal(topical.ok, false);
    assert.deepEqual(topical.items, [], 'the general feed leaked into a topical answer');
  });

  it('caches per topic, so one subject never renders as another', async () => {
    const f = fakeGet([
      ['q=alpha', rss(['Alpha headline'])],
      ['q=beta', rss(['Beta headline'])],
      ['news.google.com/rss', rss(['World news'])],
    ]);
    const feed = createNewsFeed({ get: f.get });
    assert.equal((await feed.fetchNews('alpha')).items[0].title, 'Alpha headline');
    assert.equal((await feed.fetchNews('beta')).items[0].title, 'Beta headline');
    assert.equal((await feed.fetchNews()).items[0].title, 'World news');
    // And each one still answers from its OWN slot on the second ask.
    const again = await feed.fetchNews('alpha');
    assert.equal(again.items[0].title, 'Alpha headline');
    assert.equal(again.cached, true);
  });

  // The failure path, which is where a single cache slot did the most damage: a
  // topic whose fetch DIES must not be answered out of another topic's warm
  // slot and labelled stale, because "stale" reads as "old but about this".
  it('a failing topic is not answered from another topic\'s cache', async () => {
    const feed = createNewsFeed({
      get: async (url) => {
        if (url.includes('q=alpha')) return rss(['Alpha headline']);
        throw new Error('network down');
      },
    });
    const warm = await feed.fetchNews('alpha');
    assert.equal(warm.items[0].title, 'Alpha headline');

    const dead = await feed.fetchNews('beta');
    assert.equal(dead.ok, false, 'a dead fetch must not report success');
    assert.deepEqual(dead.items, []);
    assert.notEqual(dead.stale, true, 'nothing about beta is stale — nothing about beta was ever known');
  });

  describe('the one shape a caller may pass', () => {
    it('ignores a repeated ?q= (Express hands back an array)', () => {
      // String(['a','b']) is "a,b" — a query nobody asked for, silently.
      assert.equal(normalizeQuery(['ai', 'news']), '');
      assert.equal(normalizeQuery({ evil: true }), '');
      assert.equal(normalizeQuery(null), '');
      assert.equal(normalizeQuery(42), '');
    });

    it('collapses whitespace and bounds the length', () => {
      assert.equal(normalizeQuery('  AI   news  '), 'AI news');
      assert.equal(normalizeQuery('x'.repeat(500)).length, MAX_QUERY_CHARS);
    });
  });
});
