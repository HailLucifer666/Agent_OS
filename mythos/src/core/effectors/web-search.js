'use strict';

// effectors/web-search.js — web search effector with a four-tier provider chain.
// 1. Exa (only when EXA_API_KEY is set) — POST with x-api-key header
// 2. DuckDuckGo HTML direct — https://html.duckduckgo.com/html/?q=
// 3. DuckDuckGo Lite — https://lite.duckduckgo.com/lite/?q=
// 4. Wikipedia OpenSearch — https://en.wikipedia.org/w/api.php?action=opensearch
//
// Response shape unchanged: { ok, result: { query, results, source } }
// Each result: { title, url, snippet }

// REMEDIATION P2-10 (2026-07-29 audit, item 11): search-provider-degrade
// playbook (immune/healer.js) suppresses a provider that just failed for
// SUPPRESS_TTL_MS so the NEXT call skips straight past it instead of paying
// its full PROVIDER_TIMEOUT again — this file's own within-call chain below
// already handles "retry via the next provider" for the CURRENT call.
var isSearchProviderSuppressed = require('../immune/healer').isSearchProviderSuppressed

var BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
var EXA_SEARCH_URL = 'https://api.exa.ai/search'
var EXA_MCP_URL = 'https://mcp.exa.ai/mcp'
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

// DDG HTML fallback parser — handles markup variants DDG rotates through.
// The primary ddgHtml parser targets class="result__a"; this catches the
// alternative result__url + h2 pattern and bare redirect links. Runs only if
// the primary parser returned zero results.
function ddgHtmlFallback(html, maxResults) {
  var results = []
  // Variant 1: <a class="result__url" href="..."> + sibling <h2> title
  var urlRe = /<a[^>]+class="[^"]*result__url[^"]*"[^>]+href="([^"]*)"/gi
  var hrefs = []
  var m
  while ((m = urlRe.exec(html)) !== null && hrefs.length < maxResults) {
    hrefs.push(unwrapDdgHref(m[1]))
  }
  // Variant 2: any redirect link containing uddg= (DDG's universal redirect)
  if (!hrefs.length) {
    var redirectRe = /href="([^"]*uddg=[^"]*)"/gi
    while ((m = redirectRe.exec(html)) !== null && hrefs.length < maxResults) {
      hrefs.push(unwrapDdgHref(m[1]))
    }
  }
  // Titles: grab result headings
  var titleRe = /<h2[^>]*>([\s\S]*?)<\/h2>|<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>/gi
  var titles = []
  while ((m = titleRe.exec(html)) !== null && titles.length < maxResults) {
    titles.push(stripTags(m[1] || m[2]))
  }
  // Snippets
  var snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
  var snippets = []
  while ((m = snipRe.exec(html)) !== null && snippets.length < maxResults) {
    snippets.push(stripTags(m[1]))
  }
  for (var i = 0; i < hrefs.length; i++) {
    if (hrefs[i]) results.push({
      title: (titles[i] || hrefs[i]).slice(0, 200),
      url: hrefs[i],
      snippet: (snippets[i] || '').slice(0, 300)
    })
  }
  return results
}

// Jina AI search — free, no key. Uses s.jina.ai/q/<query> which returns
// readable text results. A good third-tier fallback before Wikipedia.
var JINA_SEARCH_URL = 'https://s.jina.ai/'
function jinaSearch(q, maxResults, bus) {
  return new Promise(function(resolve) {
    var controller = new AbortController()
    var timer = setTimeout(function() { controller.abort() }, PROVIDER_TIMEOUT)
    fetch(JINA_SEARCH_URL + encodeURIComponent(q), {
      method: 'GET',
      signal: controller.signal,
      headers: { 'Accept': 'application/json', 'X-Return-Format': 'text' }
    })
    .then(function(res) { clearTimeout(timer); return res.text() })
    .then(function(text) {
      var results = []
      // Jina returns either JSON or plain text with URL: Title: patterns.
      // Try JSON first.
      try {
        var data = JSON.parse(text)
        if (data && data.data) {
          var items = Array.isArray(data.data) ? data.data : [data.data]
          for (var i = 0; i < items.length && results.length < maxResults; i++) {
            if (items[i] && items[i].url) {
              results.push({
                title: items[i].title || items[i].url,
                url: items[i].url,
                snippet: String(items[i].content || '').slice(0, 300)
              })
            }
          }
        }
      } catch (_) {
        // Plain text fallback: parse "Title: ... URL: ..." blocks
        var blocks = text.split(/\n\n+/)
        for (var j = 0; j < blocks.length && results.length < maxResults; j++) {
          var urlM = blocks[j].match(/https?:\/\/\S+/)
          var titleM = blocks[j].match(/Title:\s*(.+)/i)
          if (urlM) {
            results.push({
              title: titleM ? titleM[1].trim() : urlM[0],
              url: urlM[0],
              snippet: blocks[j].slice(0, 300)
            })
          }
        }
      }
      resolve(results)
    })
    .catch(function(err) { if (bus) bus.emit('health.anomaly', { kind: 'search-provider-failed', provider: 'jina', error: err.message }); resolve([]) })
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

// --- Exa MCP free tier (zero-config, no API key required) ---
// The hosted MCP endpoint at https://mcp.exa.ai/mcp offers an unauthenticated
// free tier (3 QPS, 150 calls/day) via JSON-RPC over Server-Sent Events.
// This is the reliable default — DuckDuckGo HTML scraping below is the
// brittle fallback. Verified working 2026-07.
//
// Flow: initialize handshake -> notifications/initialized -> tools/call.
// The SSE response carries the JSON-RPC reply on a `data:` line.
async function exaMcpSearch(q, maxResults, bus) {
  var rpcId = 1
  function parseSse(txt) {
    var m = String(txt).match(/data:\s*(\{[\s\S]*?\})\s*\n/)
    return m ? JSON.parse(m[1]) : null
  }
  async function rpc(method, params, includeId) {
    var body = { jsonrpc: '2.0', method: method }
    if (includeId) { body.id = rpcId++; body.params = params || {}; }
    var controller = new AbortController()
    var timer = setTimeout(function() { controller.abort() }, PROVIDER_TIMEOUT)
    try {
      var res = await fetch(EXA_MCP_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
        body: JSON.stringify(body)
      })
      clearTimeout(timer)
      if (!res.ok) return null
      return parseSse(await res.text())
    } catch (err) {
      clearTimeout(timer)
      if (bus) bus.emit('health.anomaly', { kind: 'search-provider-failed', provider: 'exa-mcp', error: err.message })
      return null
    }
  }

  // 1. Handshake
  var init = await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'mythos', version: '0.1.0' }
  }, true)
  if (!init || !init.result) return []

  // 2. Notification (no id, no response expected)
  await rpc('notifications/initialized', {}, false)

  // 3. Search
  var search = await rpc('tools/call', {
    name: 'web_search_exa',
    arguments: { query: q, numResults: maxResults }
  }, true)
  if (!search || !search.result || !search.result.content) return []

  // The MCP tool returns content as [{type:'text', text:'Title: ...\nURL: ...'}].
  // Parse the text block into structured results.
  var textBlock = ''
  for (var i = 0; i < search.result.content.length; i++) {
    if (search.result.content[i].type === 'text') {
      textBlock += search.result.content[i].text + '\n'
    }
  }
  return parseExaMcpText(textBlock)
}

// Parse the Exa MCP text response into {title, url, snippet} objects.
// Format observed: "Title: <t>\nURL: <u>\nPublished: ...\nHighlights:\n<snip>\n\n---\n"
function parseExaMcpText(text) {
  var blocks = String(text).split(/\n*---\n*/)
  var results = []
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i].trim()
    if (!b) continue
    var titleM = b.match(/Title:\s*(.+)/)
    var urlM = b.match(/URL:\s*(\S+)/)
    var hlM = b.match(/Highlights:\s*\n([\s\S]*?)$/)
    if (titleM && urlM) {
      results.push({
        title: titleM[1].trim(),
        url: urlM[1].trim(),
        snippet: hlM ? hlM[1].trim().slice(0, 300) : ''
      })
    }
  }
  return results
}

// --- main entry point ---

async function web_search({ query, maxResults, bus }) {
  try {
    if (!query || !String(query).trim()) return { ok: false, result: 'A search query is required.' }
    var q = String(query).trim()
    var max = Math.min(maxResults || 5, 10)

    // 1a. Exa REST API — only if EXA_API_KEY is configured (higher rate limits)
    if (process.env.EXA_API_KEY && !isSearchProviderSuppressed('exa')) {
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

    // 1b. Exa MCP free tier — zero-config default (no key needed, 150 calls/day)
    if (!isSearchProviderSuppressed('exa-mcp')) {
      try {
        var mcpResults = await exaMcpSearch(q, max, bus)
        if (mcpResults.length) {
          return { ok: true, result: { query: q, results: mcpResults.slice(0, max), source: 'exa-mcp' } }
        }
      } catch (err) { if (bus) bus.emit('health.anomaly', { kind: 'search-provider-failed', provider: 'exa-mcp', error: err.message }); }
    }

    // 2. DuckDuckGo HTML direct (+ fallback parser if primary returns nothing).
    // Suppression key matches the anomaly's own `provider` field ('ddg-html'),
    // not the success-path `source` label ('duckduckgo-html') — they differ.
    if (!isSearchProviderSuppressed('ddg-html')) {
      try {
        var ddgResults = await ddgHtml(q, max, bus)
        if (!ddgResults.length) {
          // A2: try the fallback parser against the same HTML — DDG rotates
          // markup variants and the primary class-targeted regex misses sometimes.
          try {
            var controller2 = new AbortController()
            var timer2 = setTimeout(function() { controller2.abort() }, PROVIDER_TIMEOUT)
            var htmlRes = await fetch(DDG_HTML_URL + encodeURIComponent(q), {
              signal: controller2.signal, headers: { 'User-Agent': BROWSER_UA }
            })
            clearTimeout(timer2)
            if (htmlRes.ok) ddgResults = ddgHtmlFallback(await htmlRes.text(), max)
          } catch (_) { /* fallback parse failed — continue to next provider */ }
        }
        if (ddgResults.length) {
          return { ok: true, result: { query: q, results: ddgResults, source: 'duckduckgo-html' } }
        }
      } catch (_) { /* DDG HTML unavailable — fall through */ }
    }

    // 3. DuckDuckGo Lite (suppression key: 'ddg-lite', matching the anomaly's provider field)
    if (!isSearchProviderSuppressed('ddg-lite')) {
      try {
        var liteResults = await ddgLite(q, max, bus)
        if (liteResults.length) {
          return { ok: true, result: { query: q, results: liteResults, source: 'duckduckgo-lite' } }
        }
      } catch (_) { /* DDG Lite unavailable — fall through */ }
    }

    // 4. Jina AI search (free, no key)
    if (!isSearchProviderSuppressed('jina')) {
      try {
        var jinaResults = await jinaSearch(q, max, bus)
        if (jinaResults.length) {
          return { ok: true, result: { query: q, results: jinaResults, source: 'jina' } }
        }
      } catch (_) { /* Jina unavailable — fall through */ }
    }

    // 5. Wikipedia OpenSearch
    if (!isSearchProviderSuppressed('wikipedia')) {
      try {
        var wikiResults = await wikiSearch(q, max, bus)
        if (wikiResults.length) {
          return { ok: true, result: { query: q, results: wikiResults, source: 'wikipedia' } }
        }
      } catch (_) { /* Wikipedia unavailable */ }
    }

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
  _ddgHtmlFallback: ddgHtmlFallback,
  _ddgLite: ddgLite,
  _jinaSearch: jinaSearch,
  _wikiSearch: wikiSearch,
  _exaMcpSearch: exaMcpSearch,
  _parseExaMcpText: parseExaMcpText
}
