'use strict';

// providers/web-search-ddg.js — DuckDuckGo HTML-endpoint scraper (no API key).
// Contract: search(query, {count, timeoutMs}) → {ok, results:[{title,url,snippet}],
// provider:'ddg', error?, errorKind?}. BRITTLE BY DESIGN: it fails loud. Markup
// mismatch or a blocked/challenge page → {ok:false, errorKind:'parse'} so the
// caller can raise health.anomaly{web-search-parse} rather than silently return
// zero results. A genuinely empty result set → {ok:true, results:[]}.
//
// Parsing is attribute-order-tolerant: it anchors on the stable DDG result
// classes (result__a for the title link, result__snippet for the excerpt) and
// unwraps DDG's /l/?uddg= redirect wrapper. A module-level throttle keeps us a
// good web citizen (WEB_SEARCH_MIN_INTERVAL_MS between requests).

const { decodeEntities, stripTags } = require('../src/core/util/html-text');

const ENDPOINT = 'https://html.duckduckgo.com/html/?q=';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BLOCKED_MARKERS = [/anomaly[- ]?modal/i, /unusual traffic/i, /are you a robot/i, /detected unusual/i];

let lastRequestAt = 0;

async function throttle(minIntervalMs) {
  if (!minIntervalMs) return;
  const wait = lastRequestAt + minIntervalMs - Date.now();
  if (wait > 0) await new Promise(function (r) { setTimeout(r, wait); });
  lastRequestAt = Date.now();
}

// Unwrap DDG's redirect: /l/?uddg=<encoded-real-url>&... or //duckduckgo.com/l/?...
function unwrapUrl(href) {
  if (!href) return '';
  let raw = href;
  if (raw.indexOf('/l/?') !== -1 || raw.indexOf('uddg=') !== -1) {
    const m = /[?&]uddg=([^&]+)/.exec(raw);
    if (m) { try { raw = decodeURIComponent(m[1]); } catch (_) { /* keep raw */ } }
  }
  if (raw.charAt(0) === '/' && raw.charAt(1) === '/') raw = 'https:' + raw;
  return raw;
}

// Extract the inner text + href of an <a class="... result__a ...">…</a>. Tolerant
// of attribute order: finds every anchor tag, keeps ones whose class list carries
// the marker class.
function extractAnchors(html, markerClass) {
  const out = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const attrs = m[1];
    const cls = /class\s*=\s*"([^"]*)"/i.exec(attrs) || /class\s*=\s*'([^']*)'/i.exec(attrs);
    if (!cls || cls[1].split(/\s+/).indexOf(markerClass) === -1) continue;
    const hrefM = /href\s*=\s*"([^"]*)"/i.exec(attrs) || /href\s*=\s*'([^']*)'/i.exec(attrs);
    out.push({ href: hrefM ? hrefM[1] : '', text: decodeEntities(stripTags(m[2])).replace(/\s+/g, ' ').trim() });
  }
  return out;
}

// Snippets live in <a class="result__snippet"> OR <td class="result__snippet"> —
// grab both anchor and non-anchor forms.
function extractSnippets(html) {
  const out = [];
  const re = /<(?:a|td|div)\b[^>]*class\s*=\s*["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|td|div)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push(decodeEntities(stripTags(m[1])).replace(/\s+/g, ' ').trim());
  }
  return out;
}

async function search(query, opts) {
  opts = opts || {};
  const count = opts.count || 10;
  const timeoutMs = opts.timeoutMs || 10000;
  const minIntervalMs = opts.minIntervalMs != null ? opts.minIntervalMs : 2000;
  const q = String(query || '').trim();
  if (!q) return { ok: true, results: [], provider: 'ddg' };

  let html;
  try {
    await throttle(minIntervalMs);
    const res = await fetch(ENDPOINT + encodeURIComponent(q), {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, results: [], provider: 'ddg', error: 'HTTP ' + res.status, errorKind: res.status === 429 ? 'blocked' : 'network' };
    html = await res.text();
  } catch (err) {
    const kind = err && err.name === 'TimeoutError' ? 'timeout' : 'network';
    return { ok: false, results: [], provider: 'ddg', error: (err && err.message) || 'fetch failed', errorKind: kind };
  }

  if (BLOCKED_MARKERS.some(function (re) { return re.test(html); })) {
    return { ok: false, results: [], provider: 'ddg', error: 'blocked/challenge page returned', errorKind: 'parse' };
  }

  const anchors = extractAnchors(html, 'result__a');
  const snippets = extractSnippets(html);

  // A page with results markup but no result__a anchors means the markup drifted
  // (class renamed) — fail loud. A genuinely empty search returns the "no results"
  // container; treat that as an honest empty set.
  if (anchors.length === 0) {
    if (/no-results|no results found|result--no-result/i.test(html)) {
      return { ok: true, results: [], provider: 'ddg' };
    }
    return { ok: false, results: [], provider: 'ddg', error: 'no result__a anchors found — DDG markup likely changed', errorKind: 'parse' };
  }

  const results = [];
  for (let i = 0; i < anchors.length && results.length < count; i++) {
    const url = unwrapUrl(anchors[i].href);
    if (!url || !/^https?:/i.test(url)) continue;
    results.push({ title: anchors[i].text || url, url: url, snippet: snippets[i] || '' });
  }
  return { ok: true, results: results, provider: 'ddg' };
}

module.exports = { search, _internal: { unwrapUrl, extractAnchors, extractSnippets } };
