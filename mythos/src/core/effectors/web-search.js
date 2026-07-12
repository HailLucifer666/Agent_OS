'use strict';

// effectors/web-search.js — web search effector. Uses Exa's free search API
// (no key needed for basic tier), falls back to DuckDuckGo HTML scraping if
// Exa is unavailable. Returns titles, URLs, and snippets.

var EXA_SEARCH_URL = 'https://api.exa.ai/search';
var DDG_HTML_URL = 'https://html.duckduckgo.com/html/?q=';

async function web_search({ query, numResults }) {
  try {
    if (!query || !String(query).trim()) return { ok: false, result: 'A search query is required.' };
    var q = String(query).trim();
    var maxResults = Math.min(numResults || 5, 10);

    // Try Exa first (free tier, no key required for basic search)
    try {
      var controller = new AbortController();
      var timer = setTimeout(function() { controller.abort(); }, 10000);
      var exaRes = await fetch(EXA_SEARCH_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: q,
          numResults: maxResults,
          contents: { text: true },
        }),
      });
      clearTimeout(timer);
      if (exaRes.ok) {
        var exaData = await exaRes.json();
        if (exaData.results && exaData.results.length) {
          var results = exaData.results.map(function(r) {
            return {
              title: r.title || '',
              url: r.url || '',
              snippet: (r.text || '').slice(0, 300),
            };
          });
          return { ok: true, result: { query: q, results: results.slice(0, maxResults), source: 'exa' } };
        }
      }
    } catch (_) { /* Exa unavailable — fall through to DuckDuckGo */ }

    // Fallback: DuckDuckGo HTML scraping via Jina Reader for clean text
    try {
      var ddgController = new AbortController();
      var ddgTimer = setTimeout(function() { ddgController.abort(); }, 12000);
      var ddgRes = await fetch('https://r.jina.ai/' + DDG_HTML_URL + encodeURIComponent(q), {
        signal: ddgController.signal,
        headers: { 'Accept': 'text/plain' },
      });
      clearTimeout(ddgTimer);
      if (ddgRes.ok) {
        var ddgText = await ddgRes.text();
        // Parse DuckDuckGo result snippets from the markdown text
        var ddgResults = [];
        var lines = ddgText.split('\n');
        for (var i = 0; i < lines.length && ddgResults.length < maxResults; i++) {
          var line = lines[i].trim();
          // Jina returns links as [text](url) — extract result links
          var linkMatch = line.match(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/);
          if (linkMatch && !linkMatch[2].includes('duckduckgo.com')) {
            ddgResults.push({
              title: linkMatch[1],
              url: linkMatch[2],
              snippet: (lines[i + 1] || '').trim().slice(0, 300),
            });
          }
        }
        if (ddgResults.length) {
          return { ok: true, result: { query: q, results: ddgResults, source: 'duckduckgo' } };
        }
      }
    } catch (_) { /* DuckDuckGo also unavailable */ }

    return { ok: false, result: 'All search providers are unavailable.' };
  } catch (err) {
    return { ok: false, result: 'Search failed: ' + err.message };
  }
}

module.exports = { web_search: web_search };
