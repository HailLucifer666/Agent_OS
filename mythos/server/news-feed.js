'use strict';

// news-feed.js — server-side Google News RSS fetch for the HUD NEWS widget.
// The browser cannot load news sites in an iframe (X-Frame-Options) nor fetch
// their RSS directly (CORS), so the server fetches https://news.google.com/rss
// and hands the HUD plain JSON. Zero new deps (node:https), 5-minute cache,
// never throws — a network failure returns { ok:false, error } (or the last
// good cache marked stale) and the widget renders an honest offline state.

const https = require('https');

const FEED_URL = 'https://news.google.com/rss';
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

// deps.get is injectable for tests; defaults to the real HTTPS fetch.
function createNewsFeed(deps) {
  const get = (deps && deps.get) || httpGet;
  let cache = null; // { at, items }

  async function fetchNews() {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return { ok: true, items: cache.items, cached: true };
    }
    try {
      const xml = await get(FEED_URL);
      const items = parseRss(xml, Date.now());
      if (!items.length) throw new Error('no items parsed from feed');
      cache = { at: Date.now(), items };
      return { ok: true, items };
    } catch (err) {
      if (cache) return { ok: true, items: cache.items, stale: true };
      return { ok: false, error: err.message, items: [] };
    }
  }

  return { fetchNews };
}

module.exports = { parseRss, createNewsFeed, agoLabel };
