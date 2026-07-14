'use strict';

// providers/web-search-searxng.js — optional self-hosted SearXNG meta-search.
// Contract: search(query, {baseUrl, count, timeoutMs}) → {ok, results, provider:
// 'searxng', error?, errorKind?}. Requires the instance to allow JSON output
// (settings.yml `formats: [json]`); a non-JSON body → errorKind:'parse'.

const ENDPOINT_SUFFIX = '/search?format=json&q=';

async function search(query, opts) {
  opts = opts || {};
  const baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
  const count = opts.count || 10;
  const timeoutMs = opts.timeoutMs || 10000;
  const q = String(query || '').trim();
  if (!baseUrl) return { ok: false, results: [], provider: 'searxng', error: 'no SEARXNG_URL configured', errorKind: 'config' };
  if (!q) return { ok: true, results: [], provider: 'searxng' };

  let res;
  try {
    res = await fetch(baseUrl + ENDPOINT_SUFFIX + encodeURIComponent(q), {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const kind = err && err.name === 'TimeoutError' ? 'timeout' : 'network';
    return { ok: false, results: [], provider: 'searxng', error: (err && err.message) || 'fetch failed', errorKind: kind };
  }
  if (!res.ok) return { ok: false, results: [], provider: 'searxng', error: 'HTTP ' + res.status, errorKind: 'network' };

  let data;
  try { data = await res.json(); }
  catch (err) { return { ok: false, results: [], provider: 'searxng', error: 'non-JSON response (instance JSON output disabled?)', errorKind: 'parse' }; }

  const rows = Array.isArray(data && data.results) ? data.results : null;
  if (!rows) return { ok: false, results: [], provider: 'searxng', error: 'unexpected JSON shape', errorKind: 'parse' };
  const results = [];
  for (let i = 0; i < rows.length && results.length < count; i++) {
    const r = rows[i] || {};
    if (!r.url) continue;
    results.push({ title: r.title || r.url, url: r.url, snippet: r.content || '' });
  }
  return { ok: true, results: results, provider: 'searxng' };
}

module.exports = { search };
