'use strict';

// news-feed.js — server-side Google News RSS fetch for the HUD NEWS widget.
// The browser cannot load news sites in an iframe (X-Frame-Options) nor fetch
// their RSS directly (CORS), so the server fetches https://news.google.com/rss
// and hands the HUD plain JSON. Zero new deps (node:https), 5-minute cache,
// never throws — a network failure returns { ok:false, error } (or the last
// good cache marked stale) and the widget renders an honest offline state.

const https = require('https');

const FEED_URL = 'https://news.google.com/rss';
// BUG-294: the same host answers a QUERY, and it always has — this module simply
// never sent one. Measured 2026-08-21: /rss/search?q=Mohun+Bagan+Durand+Cup
// returned 92 items whose first title was the entire answer to the operator's
// question. That is why the voice search chain now reaches this module too.
const SEARCH_URL = 'https://news.google.com/rss/search?q=';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_ITEMS = 12;
const FETCH_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// "3h ago" style label; empty string when pubDate is missing/unparseable.
function agoLabel(pubDate, now) {
  const t = Date.parse(pubDate || '');
  if (isNaN(t)) return '';
  const mins = Math.max(0, Math.round((now - t) / 60000));
  if (mins < 60) return mins + 'm ago';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + 'h ago';
  return Math.round(hours / 24) + 'd ago';
}

// Pure — regex-parse <item> blocks into [{title, link, ago}]. Google News RSS
// puts plain text in <title> and a bare URL in <link>; CDATA handled anyway.
function parseRss(xml, now) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(String(xml || ''))) && items.length < MAX_ITEMS) {
    const block = m[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1];
    const pub = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
    if (!title || !link) continue;
    const url = decodeEntities(link).trim();
    if (!/^https?:\/\//i.test(url)) continue;
    items.push({
      title: decodeEntities(title).trim(),
      link: url,
      ago: agoLabel(pub, now || Date.now()),
    });
  }
  return items;
}

// BUG-294 — the one change this module needed: a URL builder instead of a
// constant. No query means the bare front page, byte-for-byte what the HUD news
// card has always requested, so that card is unaffected by construction.
//
// NO LOCALE, DELIBERATELY. Measured 2026-08-21 on one query, three ways: with no
// locale params, 92 items; with hl=en-IN&gl=IN, 92 items and an identical top
// result; with hl=en-US&gl=US, 100 items and a different ranking. So the params
// change nothing for the operator who reported this, and the en-US row proves
// they are a real knob — which is exactly why baking one in would violate the
// root CLAUDE.md portability rule and quietly degrade results for every other
// clone of this repo. If it is ever wanted, it is ONE optional config key
// defaulting to empty, and empty must omit the parameters entirely rather than
// send blank ones.
function feedUrl(query) {
  const q = String(query == null ? '' : query).trim();
  return q ? SEARCH_URL + encodeURIComponent(q) : FEED_URL;
}

// Minimal GET with redirect-follow and timeout; resolves to the body string.
function httpGet(url, redirectsLeft) {
  if (redirectsLeft === undefined) redirectsLeft = MAX_REDIRECTS;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'MYTHOS-HUD/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        resolve(httpGet(new URL(res.headers.location, url).href, redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error('news fetch timeout')));
  });
}

// BUG-326: a topic is a DIFFERENT feed, so it needs a different cache slot.
// fetchNews() took no argument at all and held one `cache` variable, so the
// moment it learned to answer a topic the general feed and every topic would
// share one slot: ask for "AI news", then open the HUD, and the widget renders
// AI headlines as the world's top stories — or worse, a topic with no coverage
// falls back to the general feed's stale items and reads as a real answer for
// that topic. That is the failure mode news-rung.js's header already names: an
// endpoint that never returns zero cannot be trusted about freshness or
// relevance. Keyed, bounded, and a miss stays a miss.
const MAX_CACHE_KEYS = 8;
// A topic long enough to matter is a topic somebody typed by mistake. The feed
// URL is fixed and the query is encoded into it, so this is a size bound rather
// than a safety one.
const MAX_QUERY_CHARS = 120;

// The one shape a caller may pass. Express hands back an ARRAY for a repeated
// parameter (?q=a&q=b), and an array coerced through String() becomes "a,b" —
// a query nobody asked for, silently. Anything that is not a plain non-empty
// string is the general feed.
function normalizeQuery(query) {
  if (typeof query !== 'string') return '';
  return query.trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY_CHARS);
}

// deps.get is injectable for tests; defaults to the real HTTPS fetch.
function createNewsFeed(deps) {
  const get = (deps && deps.get) || httpGet;
  const cache = new Map(); // normalised query -> { at, items }

  function remember(key, items) {
    cache.set(key, { at: Date.now(), items });
    // Insertion-ordered, so the oldest key goes first. The general feed ('') is
    // re-fetched every 5 minutes by the widget, so it re-enters immediately;
    // there is no need to pin it.
    while (cache.size > MAX_CACHE_KEYS) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  // query: optional topic. Omitted/empty means the general feed, exactly as
  // before. A topic with no coverage returns ok:false with an empty list — never
  // the general feed, and never another topic's items.
  async function fetchNews(query) {
    const key = normalizeQuery(query);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return { ok: true, items: hit.items, cached: true, query: key || undefined };
    }
    try {
      const xml = await get(feedUrl(key));
      const items = parseRss(xml, Date.now());
      if (!items.length) throw new Error(key ? 'no items for topic' : 'no items parsed from feed');
      remember(key, items);
      return { ok: true, items, query: key || undefined };
    } catch (err) {
      // Stale is only ever stale for THIS key.
      if (hit) return { ok: true, items: hit.items, stale: true, query: key || undefined };
      return { ok: false, error: err.message, items: [], query: key || undefined };
    }
  }

  return { fetchNews };
}

module.exports = { parseRss, createNewsFeed, agoLabel, feedUrl, normalizeQuery, MAX_QUERY_CHARS };
