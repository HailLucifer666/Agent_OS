'use strict';

// providers/web-search-brave.js — Brave Search API (optional, key-gated).
// Contract: search(query, {apiKey, count, timeoutMs}) → {ok, results, provider:
// 'brave', error?, errorKind?}. The API key arrives via opts.apiKey and is
// NEVER logged, echoed, or placed in any output field — only the literal string
// 'brave' identifies this provider. 401/403 → errorKind:'auth'.

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search?q=';

async function search(query, opts) {
  opts = opts || {};
  const apiKey = opts.apiKey || '';
  const count = opts.count || 10;
  const timeoutMs = opts.timeoutMs || 10000;
  const q = String(query || '').trim();
  if (!apiKey) return { ok: false, results: [], provider: 'brave', error: 'no Brave API key configured', errorKind: 'config' };
  if (!q) return { ok: true, results: [], provider: 'brave' };

  let res;
  try {
    res = await fetch(ENDPOINT + encodeURIComponent(q) + '&count=' + Math.min(count, 20), {
      headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const kind = err && err.name === 'TimeoutError' ? 'timeout' : 'network';
    return { ok: false, results: [], provider: 'brave', error: (err && err.message) || 'fetch failed', errorKind: kind };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, results: [], provider: 'brave', error: 'Brave API rejected the request (HTTP ' + res.status + ')', errorKind: 'auth' };
  if (!res.ok) return { ok: false, results: [], provider: 'brave', error: 'HTTP ' + res.status, errorKind: 'network' };

  let data;
  try { data = await res.json(); }
  catch (err) { return { ok: false, results: [], provider: 'brave', error: 'non-JSON response', errorKind: 'parse' }; }

  const rows = data && data.web && Array.isArray(data.web.results) ? data.web.results : null;
  if (!rows) return { ok: true, results: [], provider: 'brave' };
  const results = [];
  for (let i = 0; i < rows.length && results.length < count; i++) {
    const r = rows[i] || {};
    if (!r.url) continue;
    results.push({ title: r.title || r.url, url: r.url, snippet: r.description || '' });
  }
  return { ok: true, results: results, provider: 'brave' };
}

module.exports = { search };
