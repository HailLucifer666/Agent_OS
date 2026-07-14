'use strict';

// effectors/web-search.js — web search effector with a four-tier provider chain.
// 1. Exa (only when EXA_API_KEY is set) — POST with x-api-key header
// 2. DuckDuckGo HTML direct — https://html.duckduckgo.com/html/?q=
// 3. DuckDuckGo Lite — https://lite.duckduckgo.com/lite/?q=
// 4. Wikipedia OpenSearch — https://en.wikipedia.org/w/api.php?action=opensearch
//
// Response shape unchanged: { ok, result: { query, results, source } }
// Each result: { title, url, snippet }

var BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
var EXA_SEARCH_URL = 'https://api.exa.ai/search'
var DDG_HTML_URL = 'https://html.duckduckgo.com/html/?q='
var DDG_LITE_URL = 'https://lite.duckduckgo.com/lite/?q='
var WIKI_SEARCH_URL = 'https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit='
var PROVIDER_TIMEOUT = 10000

// --- helpers (exported for testing) ---

function stripTags(s) {
  if (!s) return ''
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(Number(n)) })
    .replace(/&#[xX]([0-9a-fA-F]+);/g, function(_, hex) { return String.fromCharCode(parseInt(hex, 16)) })
    .replace(/&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&\w+;/g, ' ')  // replace remaining unknown entities with space
    .replace(/\s+/g, ' ')
    .trim()
}

// Unwrap a DuckDuckGo redirect URL: //duckduckgo.com/l/?uddg=<encoded>&rut=...
// Decodes the uddg parameter and returns the real URL, or the original if not a DDG redirect.
function unwrapDdgHref(href) {
  if (!href) return ''
  href = String(href).trim()
  if (!href.includes('uddg=')) return href
  try {
    var u = new URL(href.startsWith('//') ? 'https:' + href : href)
    var encoded = u.searchParams.get('uddg')
    if (encoded) return decodeURIComponent(encoded)
  } catch (_) { /* not a valid URL — return as-is */ }
  return href
}

// DuckDuckGo HTML direct parser.
// Fetches https://html.duckduckgo.com/html/?q=<query> and parses result links.
function ddgHtml(q, maxResults, bus) {
  return new Promise(function(resolve) {
    var controller = new AbortController()
    var timer = setTimeout(function() { controller.abort() }, PROVIDER_TIMEOUT)
    fetch(DDG_HTML_URL + encodeURIComponent(q), {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': BROWSER_UA }
    })
    .then(function(res) { clearTimeout(timer); return res.text() })
    .then(function(html) {
      var results = []
      // Parse <a class="result__a" href="...">Title</a> links
      var linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
      // Parse <a class="result__snippet"[^>]*>...</a> for snippets
      var snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
      var titles = []
      var hrefs = []
      var m

      // First pass: extract all result links and titles
      while ((m = linkRe.exec(html)) !== null && titles.length < maxResults) {
        titles.push(stripTags(m[2]))
        hrefs.push(unwrapDdgHref(m[1]))
      }

      // Second pass: extract snippets (they follow their corresponding link)
      var snippets = []
      while ((m = snippetRe.exec(html)) !== null && snippets.length < maxResults) {
        snippets.push(stripTags(m[1]))
      }

      for (var i = 0; i < titles.length; i++) {
        results.push({
          title: titles[i],
          url: hrefs[i],
          snippet: (snippets[i] || '').slice(0, 300)
        })
      }
      resolve(results)
    })
    .catch(function(err) { if (bus) bus.emit('health.anomaly', { kind: 'search-provider-failed', provider: 'ddg-html', error: err.message }); resolve([]) })
  })
}

// DuckDuckGo Lite parser.
// Fetches https://lite.duckduckgo.com/lite/?q=<query> and parses the table rows.
function ddgLite(q, maxResults, bus) {
  return new Promise(function(resolve) {
    var controller = new AbortController()
    var timer = setTimeout(function() { controller.abort() }, PROVIDER_TIMEOUT)
    fetch(DDG_LITE_URL + encodeURIComponent(q), {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': BROWSER_UA }
    })
    .then(function(res) { clearTimeout(timer); return res.text() })
    .then(function(html) {
      var results = []
      // DDG Lite renders results in <a> tags within table cells.
      // Result links have class="result-link" and snippets are in the following <td>.
      var linkRe = /<a[^>]+class="result-link"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
      var snippetRe = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi
      var titles = []
      var hrefs = []
      var m

      while ((m = linkRe.exec(html)) !== null && titles.length < maxResults) {
        titles.push(stripTags(m[2]))
        hrefs.push(unwrapDdgHref(m[1]))
      }

      var snippets = []
      while ((m = snippetRe.exec(html)) !== null && snippets.length < maxResults) {
        snippets.push(stripTags(m[1]))
      }

      for (var i = 0; i < titles.length; i++) {
        results.push({
          title: titles[i],
          url: hrefs[i],
          snippet: (snippets[i] || '').slice(0, 300)
        })
      }
      resolve(results)
    })
    .catch(function(err) { if (bus) bus.emit('health.anomaly', { kind: 'search-provider-failed', provider: 'ddg-lite', error: err.message }); resolve([]) })
  })
}

// Wikipedia OpenSearch — last resort for factual queries.
function wikiSearch(q, maxResults, bus) {
  return new Promise(function(resolve) {
    var controller = new AbortController()
    var timer = setTimeout(function() { controller.abort() }, PROVIDER_TIMEOUT)
    fetch(WIKI_SEARCH_URL + maxResults + '&search=' + encodeURIComponent(q), {
      signal: controller.signal,
      headers: { 'User-Agent': BROWSER_UA }
    })
    .then(function(res) { clearTimeout(timer); return res.json() })
    .then(function(data) {
      // OpenSearch returns [ query, titles[], descriptions[], urls[] ]
      if (!Array.isArray(data) || data.length < 4) { resolve([]); return }
      var results = []
      for (var i = 0; i < data[1].length && results.length < maxResults; i++) {
        results.push({
          title: data[1][i] || '',
          url: data[3][i] || '',
          snippet: (data[2][i] || '').slice(0, 300)
        })
      }
      resolve(results)
    })
    .catch(function(err) { if (bus) bus.emit('health.anomaly', { kind: 'search-provider-failed', provider: 'wikipedia', error: err.message }); resolve([]) })
  })
}

// --- main entry point ---

async function web_search({ query, maxResults, bus }) {
  try {
    if (!query || !String(query).trim()) return { ok: false, result: 'A search query is required.' }
    var q = String(query).trim()
    var max = Math.min(maxResults || 5, 10)

    // 1. Exa — only if API key is configured
    if (process.env.EXA_API_KEY) {
      try {
        var controller = new AbortController()
        var timer = setTimeout(function() { controller.abort() }, PROVIDER_TIMEOUT)
        var exaRes = await fetch(EXA_SEARCH_URL, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.EXA_API_KEY
          },
          body: JSON.stringify({
            query: q,
            numResults: max,
            contents: { text: true }
          })
        })
        clearTimeout(timer)
        if (exaRes.ok) {
          var exaData = await exaRes.json()
          if (exaData.results && exaData.results.length) {
            var results = exaData.results.map(function(r) {
              return {
                title: r.title || '',
                url: r.url || '',
                snippet: (r.text || '').slice(0, 300)
              }
            })
            return { ok: true, result: { query: q, results: results.slice(0, max), source: 'exa' } }
          }
        }
      } catch (err) { if (bus) bus.emit('health.anomaly', { kind: 'search-provider-failed', provider: 'exa', error: err.message }); }
    }

    // 2. DuckDuckGo HTML direct
    try {
      var ddgResults = await ddgHtml(q, max, bus)
      if (ddgResults.length) {
        return { ok: true, result: { query: q, results: ddgResults, source: 'duckduckgo-html' } }
      }
    } catch (_) { /* DDG HTML unavailable — fall through */ }

    // 3. DuckDuckGo Lite
    try {
      var liteResults = await ddgLite(q, max, bus)
      if (liteResults.length) {
        return { ok: true, result: { query: q, results: liteResults, source: 'duckduckgo-lite' } }
      }
    } catch (_) { /* DDG Lite unavailable — fall through */ }

    // 4. Wikipedia OpenSearch
    try {
      var wikiResults = await wikiSearch(q, max, bus)
      if (wikiResults.length) {
        return { ok: true, result: { query: q, results: wikiResults, source: 'wikipedia' } }
      }
    } catch (_) { /* Wikipedia unavailable */ }

    return { ok: false, result: 'All search providers are unavailable.' }
  } catch (err) {
    return { ok: false, result: 'Search failed: ' + err.message }
  }
}

module.exports = {
  web_search: web_search,
  // Exports for testing
  _stripTags: stripTags,
  _unwrapDdgHref: unwrapDdgHref,
  _ddgHtml: ddgHtml,
  _ddgLite: ddgLite,
  _wikiSearch: wikiSearch
}
