'use strict';

// news-feed.test.js — server/news-feed.js: pure RSS parsing, cache behavior,
// and honest degradation when the network is down.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseRss, createNewsFeed, agoLabel } = require('../server/news-feed');

const NOW = Date.parse('2026-07-15T12:00:00Z');

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Top stories - Google News</title>
<item>
  <title>Markets rally as rates hold &amp; tech leads</title>
  <link>https://news.google.com/rss/articles/abc123</link>
  <pubDate>Wed, 15 Jul 2026 09:00:00 GMT</pubDate>
</item>
<item>
  <title><![CDATA[Storm warning issued for <coastal> regions]]></title>
  <link>https://news.google.com/rss/articles/def456</link>
  <pubDate>Tue, 14 Jul 2026 12:00:00 GMT</pubDate>
</item>
<item>
  <title>Item with no link is skipped</title>
</item>
<item>
  <title>Bad link scheme is skipped</title>
  <link>javascript:alert(1)</link>
</item>
</channel></rss>`;

describe('parseRss (pure)', () => {
  it('extracts title/link/ago, decodes entities and CDATA, skips bad items', () => {
    const items = parseRss(FIXTURE, NOW);
    assert.equal(items.length, 2, 'linkless and non-http items are skipped');
    assert.equal(items[0].title, 'Markets rally as rates hold & tech leads');
    assert.equal(items[0].link, 'https://news.google.com/rss/articles/abc123');
    assert.equal(items[0].ago, '3h ago');
    assert.equal(items[1].title, 'Storm warning issued for <coastal> regions');
    assert.equal(items[1].ago, '1d ago');
  });

  it('empty/garbage xml -> empty list, never throws', () => {
    assert.deepEqual(parseRss('', NOW), []);
    assert.deepEqual(parseRss('not xml at all', NOW), []);
    assert.deepEqual(parseRss(null, NOW), []);
  });

  it('caps items at 12', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      `<item><title>t${i}</title><link>https://x.test/${i}</link></item>`).join('');
    assert.equal(parseRss(`<rss>${many}</rss>`, NOW).length, 12);
  });
});

describe('agoLabel', () => {
  it('minutes / hours / days / missing', () => {
    assert.equal(agoLabel(new Date(NOW - 5 * 60000).toUTCString(), NOW), '5m ago');
    assert.equal(agoLabel(new Date(NOW - 2 * 3600000).toUTCString(), NOW), '2h ago');
    assert.equal(agoLabel(new Date(NOW - 48 * 3600000).toUTCString(), NOW), '2d ago');
    assert.equal(agoLabel(undefined, NOW), '');
    assert.equal(agoLabel('garbage', NOW), '');
  });
});

describe('createNewsFeed', () => {
  it('fetches, parses, then serves from cache without re-fetching', async () => {
    let calls = 0;
    const feed = createNewsFeed({ get: async () => { calls++; return FIXTURE; } });
    const first = await feed.fetchNews();
    assert.equal(first.ok, true);
    assert.equal(first.items.length, 2);
    assert.equal(calls, 1);
    const second = await feed.fetchNews();
    assert.equal(second.ok, true);
    assert.equal(second.cached, true);
    assert.equal(calls, 1, 'second call served from cache');
  });

  it('network failure with no cache -> ok:false with error, empty items', async () => {
    const feed = createNewsFeed({ get: async () => { throw new Error('ENOTFOUND'); } });
    const r = await feed.fetchNews();
    assert.equal(r.ok, false);
    assert.match(r.error, /ENOTFOUND/);
    assert.deepEqual(r.items, []);
  });

  it('unparseable feed (zero items) degrades like a failure', async () => {
    const feed = createNewsFeed({ get: async () => '<rss></rss>' });
    const r = await feed.fetchNews();
    assert.equal(r.ok, false);
    assert.match(r.error, /no items/);
  });
});
