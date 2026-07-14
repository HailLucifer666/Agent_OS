'use strict';

// effectors/web-search.js — ranked web-search provider chain (P23). Mirrors
// brain/chain.js ethos: try providers in preference order, fall through ONLY on
// an unavailable provider (ok:false). A reachable provider that returns zero
// results is FINAL — an honest empty answer, not a reason to try the next one.
// Chain: brave (if BRAVE_API_KEY) → searxng (if SEARXNG_URL) → ddg (always).
// A parse-class failure (markup drift, JSON disabled) fires
// bus.emit('health.anomaly',{kind:'web-search-parse'}) so drift is loud.
// Exports createWebSearch (reusable core — research uses it directly, no hub
// round-trip) + registerWebSearch(hub, ctx). Tool web_search is T0 (read-only).

const { effectorFromTool } = require('./adapter');
const ddg = require('../../../providers/web-search-ddg');
const searxng = require('../../../providers/web-search-searxng');
const brave = require('../../../providers/web-search-brave');

function createWebSearch({ config, bus }) {
  config = config || {};
  const maxResults = config.WEB_SEARCH_MAX_RESULTS || 10;
  const timeoutMs = config.WEB_SEARCH_TIMEOUT_MS || 10000;
  const minIntervalMs = config.WEB_SEARCH_MIN_INTERVAL_MS != null ? config.WEB_SEARCH_MIN_INTERVAL_MS : 2000;

  function buildChain() {
    const chain = [];
    if (config.BRAVE_API_KEY) chain.push({ provider: 'brave', run: function (q, count) { return brave.search(q, { apiKey: config.BRAVE_API_KEY, count: count, timeoutMs: timeoutMs }); } });
    if (config.SEARXNG_URL) chain.push({ provider: 'searxng', run: function (q, count) { return searxng.search(q, { baseUrl: config.SEARXNG_URL, count: count, timeoutMs: timeoutMs }); } });
    chain.push({ provider: 'ddg', run: function (q, count) { return ddg.search(q, { count: count, timeoutMs: timeoutMs, minIntervalMs: minIntervalMs }); } });
    return chain;
  }

  async function search({ query, count }) {
    const q = String(query || '').trim();
    if (!q) return { ok: false, result: 'A search query is required.' };
    const want = Math.min(count || maxResults, maxResults);
    const chain = buildChain();
    const tried = [];
    for (let i = 0; i < chain.length; i++) {
      const link = chain[i];
      let res;
      try { res = await link.run(q, want); }
      catch (err) { res = { ok: false, provider: link.provider, error: (err && err.message) || 'threw', errorKind: 'network' }; }
      if (res.errorKind === 'parse' && bus) {
        bus.emit('health.anomaly', { kind: 'web-search-parse', provider: link.provider, error: res.error });
      }
      if (res.ok) {
        return { ok: true, result: { query: q, provider: res.provider, results: res.results || [], count: (res.results || []).length } };
      }
      tried.push(link.provider + ' (' + (res.errorKind || 'error') + ')');
    }
    return { ok: false, result: 'All search providers unavailable: ' + tried.join(', ') + '.' };
  }

  return { search: search };
}

function registerWebSearch(hub, ctx) {
  const svc = createWebSearch(ctx);
  hub.register(effectorFromTool({
    name: 'web_search',
    description: 'Quick web lookup: returns a ranked list of result titles, URLs, and snippets for a query. Use this for a fast fact or a link. For a thorough, cited, synthesized report on a topic, use run_research instead.',
    params: { query: 'string - the search query', count: 'number (optional) - max results' },
    danger: false,
    fn: function (params) { return svc.search(params || {}); },
  }));
  return svc;
}

module.exports = { createWebSearch, registerWebSearch };
