'use strict';

const { isTimeSensitive, entersNewsRung } = require('./search-intent.js');

// effectors/web-search.js — web search effector with a provider chain.
// 0. Local open-webSearch daemon (BUG-280) — POST http://127.0.0.1:3100/search
// 1. Exa (only when EXA_API_KEY is set) — POST with x-api-key header
// 2. DuckDuckGo HTML direct — https://html.duckduckgo.com/html/?q=
// 3. DuckDuckGo Lite — https://lite.duckduckgo.com/lite/?q=
// 4. Wikipedia full-text — https://en.wikipedia.org/w/api.php?action=query&list=search
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
// BUG-280 (2026-08-20): action=opensearch is TITLE-PREFIX matching, so it could
// not answer a natural-language query by construction. Measured on the same
// host: 'London' returned 3 hits, 'weather in London today' returned 0, and the
// same host with action=query&list=search returned HTTP 200 with 10 hits on that
// identical query. The old comment further down called the empty answer "CORRECT
// behaviour, not a fault" — true of OpenSearch, and also the argument against
// using OpenSearch.
var WIKI_SEARCH_URL = 'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit='
var WIKI_ARTICLE_URL = 'https://en.wikipedia.org/wiki/'
var PROVIDER_TIMEOUT = require('./local-search-daemon').PROVIDER_TIMEOUT

// BUG-280, second half — 2026-08-20. A STALE answer returned as a fresh one.
//
// web_search ran for "Durand Cup East Bengal vs Mohun Bagan result August 20
// 2026" and returned ok:true, source:'wikipedia', five Durand Cup pages from
// 2023 and 2025. The chain behaved correctly — Wikipedia is the last rung and,
// on that host, the only reachable one. But ok:true carried no signal that an
// encyclopaedia cannot answer "what was today's result", so the model had a
// success with a gap in it and filled the gap: two turns later it told the
// operator Mohun Bagan had won, congratulated him, and wrote it to a note.
//
// This is the sibling of BUG-295's missing NO_CONTENT_CLAIM. One is an empty
// body; this is a body from the wrong decade. Both are a successful tool result
// that does not answer the question asked, with nothing in the payload saying so.
// KEYED ON PROVABLE RECENCY, NOT ON A LIST OF SOURCE NAMES. The first version of
// this guard held `{ wikipedia: true }`, and that was wrong for a reason worth
// writing down: a name list has to be extended by hand for every rung added
// afterwards, so every new provider arrives silently EXEMPT. That is this repo's
// phantom-allowlist class — a list that names things nothing emits, or fails to
// name the thing that matters. It cost a real defect here within one commit: the
// local daemon returns undated results, was not in the list, and therefore
// answered a live football question with a fixture that never took place.
//
// The real invariant is whether the winning source can PROVE recency, and the
// evidence for that is in the results themselves: a rung that knows when its
// items were published stamps `published` on them. `.some` rather than `.every`
// on purpose — one dated item demonstrates the SOURCE carries dates, and Defect 4
// below makes any individual undated item say so in its own snippet, so a mixed
// batch is fully described rather than silently averaged.
function carriesPublicationDates(results) {
  return Array.isArray(results) && results.some(function(r) { return r && r.published })
}

// Q1 — WHAT ELSE MATCHES THIS? A word list over the operator's transcribed
// Freshness markers + the news-rung gate live in ./search-intent.js
// (single source; ratchet-ceiling extraction). _isTimeSensitive below is
// that module's function, re-exported for its existing tests.
var STALE_SOURCE_CAUTION = 'These results carry NO publication date, so none of them can be shown '
  + 'to be current — they may describe a different year entirely. Say plainly that you could not '
  + 'find dated, current information, and do NOT state, guess or infer an answer that is not '
  + 'written in these results — not now, and not later in this conversation either.'


// The one success door for every rung. Seven rungs used to build this object
// themselves, which is exactly why a signal like the caution below could be
// added to none of them — Q3: the model reads `result`, so the caution has to
// ride there, on every provider, or it is a mechanism that covers one rung.
// DELIBERATE NON-CHANGE (2026-08-26), recorded so it is not "fixed" again.
//
// This rung was nearly given a second, provenance-based caution: with every
// general provider dead on this network, 'who is the CEO of Anthropic' returns
// ok:true from Wikipedia, and that looked like the same missing-signal class as
// the staleness bug above.
//
// It is not, and bug-280-search-has-a-working-provider.test.js says so in a test
// written before this attempt: "an encyclopaedia answering an encyclopaedia
// question is not a defect". Two things settled it. Wikipedia's Anthropic
// article DOES name the CEO, so the rung answered the question and the snippet
// merely did not show it — the chain was not wrong. And a caution keyed on "the
// rest of the chain is down" would fire on every timeless query on a degraded
// machine, which is precisely the over-warning that trains an operator to ignore
// cautions.
//
// The real gap it was reaching for — nobody could tell the chain had silently
// lost every general provider — belongs on the HEALTH channel, not in a success
// payload, and localWebSearch's partialFailures reporting below now puts it
// there. The caution contract is unchanged: staleness only.
function succeed(q, results, source) {
  var payload = { query: q, results: results, source: source }
  if (isTimeSensitive(q) && !carriesPublicationDates(results)) payload.caution = STALE_SOURCE_CAUTION
  return { ok: true, result: payload }
}

// The open-webSearch daemon rung lives in its own module: it owns a configured
// URL, an SSRF-shaped validation of that URL, an engine list and a response
// parser, which is more surface than any other rung here. Moved out on
// 2026-08-26 when the file-size ratchet refused BUG-361 — see that file.
var daemon = require('./local-search-daemon')
var WEB_SEARCH_LOCAL_URL_DEFAULT = daemon.WEB_SEARCH_LOCAL_URL_DEFAULT
var WEB_SEARCH_ENGINES_DEFAULT = daemon.WEB_SEARCH_ENGINES_DEFAULT
var localSearchBase = daemon.localSearchBase
var resolveLocalSearchUrl = daemon.resolveLocalSearchUrl
var localSearchEngines = daemon.localSearchEngines
var localWebSearch = daemon.localWebSearch
var newsRung = require('./news-rung')

// Stop paying a full PROVIDER_TIMEOUT for a provider that is gone. Measured
// 2026-08-26: of a 32.4s web_search call, 20s was ddg-html + ddg-lite each
// timing out against a host this network cannot reach (both resolve to
// 20.204.244.192 via the local resolver AND Cloudflare DoH, and TCP :443
// blackholes). healer.js's suppression could not help — it is a flat 30s AND it
// is driven by a bus anomaly, while most callers here pass no bus, so on the
// autonomous path it never fired at all. See provider-cooldown.js for why this
// is behavioural rather than a hardcoded disable list: MYTHOS is open source and
// DuckDuckGo is reachable from most networks.
//
// Module-level on purpose. The point is memory ACROSS calls — a per-call
// instance would forget the timeout it just paid and pay it again.
var providerCooldown = require('./provider-cooldown').createProviderCooldown()

var disabledProviders = require('./provider-cooldown').disabledProviders
// --- helpers (exported for testing) ---

// stripTags moved to html-text.js on 2026-08-20. web-fetch.js had a weaker
// near-duplicate of it, so the same page produced different text depending on
// which effector read it. Kept as a local alias so every call site below is
// untouched.
const { stripTags } = require('./html-text');

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

// Jina AI search — s.jina.ai returns readable text results. A good third-tier
// fallback before Wikipedia.
//
// BUG-302 (2026-08-21): this rung had no way to present a credential at all. It
// sent Accept and X-Return-Format and nothing else, and EXA_API_KEY was the only
// key the whole chain read — so once Jina withdrew its no-key tier the rung was
// permanently HTTP 401 and got written off as dead, when it was one free API key
// away from working. That mattered more than one rung: by this date every
// keyless engine the local daemon supports was refusing too (startpage token
// extraction, bing 301, brave 429, DuckDuckGo CAPTCHA, baidu socket hang up), so
// reviving a rung that takes a key beats adopting another scraper that gets
// blocked the same way.
//
// The keyless attempt is deliberately NOT removed. It costs one fast 401 that the
// rung already reports honestly, and deleting it would bake a two-machine
// measurement into a permanent refusal to try. This adds a capability and takes
// nothing away.
var JINA_SEARCH_URL = 'https://s.jina.ai/'

// Built per call, not captured at module load: the key may be injected after this
// file is required, and a header object shared across calls is a place for one
// request's credential to outlive it.
function jinaHeaders() {
  var headers = { 'Accept': 'application/json', 'X-Return-Format': 'text' }
  var key = String(process.env.JINA_API_KEY || '').trim()
  // Only when non-empty — an absent key must not become "Bearer undefined",
  // which reads to the server as a malformed credential rather than none.
  if (key) headers['Authorization'] = 'Bearer ' + key
  return headers
}

function jinaSearch(q, maxResults, bus) {
  return new Promise(function(resolve) {
    var controller = new AbortController()
    var timer = setTimeout(function() { controller.abort() }, PROVIDER_TIMEOUT)
    fetch(JINA_SEARCH_URL + encodeURIComponent(q), {
      method: 'GET',
      signal: controller.signal,
      // The key rides in the Authorization header, never in the URL — a query
      // string ends up in logs, proxies and the anomaly payloads this rung emits.
      headers: jinaHeaders()
    })
    .then(function(res) {
      clearTimeout(timer)
      // BUG-276 F4 (2026-08-20): a non-OK status used to fall straight into the parser
      // below, find no URLs in the error body, and resolve([]) — indistinguishable from
      // "this provider answered and matched nothing". Measured on this machine: the free
      // no-key tier this comment promises now returns **HTTP 401**, so the provider was
      // failing on every single call and reporting it as an empty result set. Emitting the
      // same anomaly the transport catch below emits is what makes it visible to the
      // failure message AND to the search-provider-degrade playbook, which can now rest a
      // provider that is refusing us rather than paying its timeout every call.
      if (!res.ok) {
        if (bus) bus.emit('health.anomaly', { kind: 'search-provider-failed', provider: 'jina', error: 'HTTP ' + res.status })
        return null
      }
      return res.text()
    })
    .then(function(text) {
      if (text === null) { resolve([]); return }
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

// Wikipedia full-text search — last resort for factual queries.
function wikiSearch(q, maxResults, bus) {
  return new Promise(function(resolve) {
    var controller = new AbortController()
    var timer = setTimeout(function() { controller.abort() }, PROVIDER_TIMEOUT)
    fetch(WIKI_SEARCH_URL + maxResults + '&srsearch=' + encodeURIComponent(q), {
      signal: controller.signal,
      headers: { 'User-Agent': BROWSER_UA }
    })
    .then(function(res) { clearTimeout(timer); return res.json() })
    .then(function(data) {
      // list=search returns { query: { search: [ {title, snippet, ...} ] } }.
      // Two differences from the OpenSearch shape this replaced, both easy to get
      // wrong quietly: there is no url field (it has to be built from the title),
      // and the snippet carries <span class="searchmatch"> highlight markup that
      // would otherwise be read out loud verbatim.
      var hits = data && data.query && Array.isArray(data.query.search) ? data.query.search : null
      if (!hits) { resolve([]); return }
      var results = []
      for (var i = 0; i < hits.length && results.length < maxResults; i++) {
        var title = hits[i] && hits[i].title ? String(hits[i].title) : ''
        if (!title) continue
        results.push({
          title: title,
          url: WIKI_ARTICLE_URL + encodeURIComponent(title.replace(/ /g, '_')),
          snippet: stripTags(String(hits[i].snippet || '')).slice(0, 300)
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
      // BUG-276 F4: the same silent swallow as jina's. A bare `return null` here made a
      // 429/402/500 from the free MCP tier read as "no results" upstream.
      if (!res.ok) {
        if (bus) bus.emit('health.anomaly', { kind: 'search-provider-failed', provider: 'exa-mcp', error: 'HTTP ' + res.status })
        return null
      }
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

    // BUG-276 F4 (2026-08-20) — WHAT WAS TRIED, AND WHY EACH ONE FAILED.
    //
    // This chain has six members and, when all six came up empty, said exactly one thing:
    // "All search providers are unavailable." The audited session lost four user-visible
    // searches to that sentence. Measured here the same day, the six outcomes were:
    // exa skipped for a missing key, exa-mcp empty, ddg-html and ddg-lite both `fetch
    // failed` at ~10s, jina **HTTP 401**, wikipedia 200-with-no-match — six different
    // facts, five of them actionable, all discarded.
    //
    // Q2 of the fix checklist. No retry, no new provider, no new mechanism: the chain
    // already knew all of this and threw it away at the last line. Now it is in the
    // failure string, so the next four-miss session is diagnosable from its own log.
    var tried = []
    var disabled = disabledProviders()
    function note(provider, cause) { tried.push(provider + ' ' + cause) }
    function outcome(provider) { return seen[provider] || 'no results' }

    // The helpers already emit `search-provider-failed` for a transport fault, so their
    // causes are collected by wrapping the bus rather than by threading a new parameter
    // through five signatures. This forwards every event untouched — the real bus keeps
    // driving the search-provider-degrade playbook exactly as before. It also exists
    // unconditionally, because the helpers guard their emits on `if (bus)`: with no bus
    // passed (the autonomous path and most tests) the causes would otherwise be lost
    // again, which is the bug this fixes.
    // A provider that was never called has a cause too, and it is a different cause from
    // failing: "no key configured" is the operator's to fix, and "suppressed" means the
    // immune system is deliberately resting it. Reporting either as a failure is how a
    // working self-heal gets read as a broken chain.
    function skipReason(provider, keyEnv) {
      if (keyEnv && !process.env[keyEnv]) return 'no ' + keyEnv + ' set'
      if (disabled.indexOf(provider) !== -1) return 'disabled by WEB_SEARCH_DISABLED_PROVIDERS'
      if (isSearchProviderSuppressed(provider)) return 'suppressed by the immune system'
      // Reported as its own cause, NOT merged with the immune system's. Those two
      // mean different things to an operator: one is a deliberate rest, the other
      // is this chain's own memory that the provider has failed N times running.
      // See provider-cooldown.js.
      var cooling = providerCooldown.reason(provider)
      if (cooling) return cooling
      return null
    }

    // Called instead of `note(provider, outcome(provider))` on every path where a
    // provider was actually ATTEMPTED and produced nothing. Kept separate from
    // note() because note() is also used for SKIPS, and charging a skip as a
    // failure would let a provider escalate its own cooldown while never once
    // being tried — a cooldown that feeds itself.
    function failed(provider) {
      var cause = outcome(provider)
      note(provider, cause)
      // ONLY A REAL FAULT COOLS A PROVIDER DOWN. `seen[provider]` is populated
      // exclusively by a `search-provider-failed` anomaly — a transport error, a
      // non-200, a timeout. Its absence means the provider answered correctly and
      // simply matched nothing, which is not a fault and must not be punished:
      // Wikipedia returning zero rows for a shopping query is CORRECT behaviour,
      // and this file's own comment at the wikipedia rung says so.
      //
      // The first version of this function cooled down on any empty outcome. That
      // is the exact trap bug-276-f4's test was written to catch — "flattening
      // every empty outcome into failed would then suppress a healthy provider"
      // — and it duly caught it here. Charging a correct empty answer as a
      // failure would have taken the last honest rung out of the chain for an
      // hour after four ordinary queries.
      if (seen[provider]) providerCooldown.recordFailure(provider, cause)
    }

    // Every `return succeed(...)` is preceded by this. It takes the provider KEY
    // rather than the source label because the two differ ('ddg-html' vs
    // 'duckduckgo-html') and the cooldown is keyed on the former.
    function worked(provider) {
      providerCooldown.recordSuccess(provider)
    }

    var seen = {}
    var traceBus = {
      emit: function(type, payload) {
        if (type === 'health.anomaly' && payload && payload.kind === 'search-provider-failed' && payload.provider) {
          seen[payload.provider] = payload.error || 'failed'
        }
        if (bus) return bus.emit(type, payload)
      }
    }

    // 0a. Google News RSS (BUG-294) — FIRST, ahead of the local daemon, and ONLY
    // for a question carrying a freshness marker.
    //
    // IT WAS AT 0b, BEHIND THE DAEMON, AND THAT MADE IT UNREACHABLE FOR EVERY
    // QUERY IT EXISTS FOR. Since BUG-288 the daemon autostarts, so a live question
    // hit it first, and localWebSearch maps { title, url, snippet: description }
    // with NO DATE FIELD — a non-empty undated answer returned immediately and the
    // news rung never ran. This branch's own commit f34be26 recorded the daemon
    // answering "Mohun Bagan edge past East Bengal with a hard-fought win" as
    // proof the freshness fix worked; on 2026-08-20 Mohun Bagan played NORTHEAST
    // UNITED, and the two clubs had not met at all. An older fixture, undated,
    // accepted as evidence of freshness. Ordering was the whole defect.
    //
    // The freshness gate is still the safety property (see the no-second-position
    // note further down): RSS never returns zero, so it must never be a catch-all.
    // A timeless query does not enter this block at all and the chain below is
    // byte-for-byte the order it always had.
    //
    // Freshness + BUG-276 F3 site-scope gate: see search-intent.js (single source).
    if (entersNewsRung(q)) {
      var newsSkip = skipReason('google-news-rss')
      if (newsSkip) note('google-news-rss', newsSkip)
      else {
        try {
          var newsResults = await newsRung.newsRssSearch(q, max, traceBus,
            { timeoutMs: PROVIDER_TIMEOUT, userAgent: BROWSER_UA })
          if (newsResults && newsResults.length) {
            // BUG-315: this rung LEADS but no longer silences the chain. It is a
            // general-news index, so on "global AI news past week" it answered
            // with China/Indonesia, Guterres/India and India/APAC adoption — all
            // genuinely AI news, none of it the model releases the operator
            // asked for — and because it returned here, nothing else was ever
            // consulted. The same session's specific query fell through to
            // DuckDuckGo and got the real answer.
            //
            // One free general provider now runs alongside it and the two are
            // merged, RSS first so the dated answer still wins (BUG-294). It is
            // additive: if the second provider has nothing, this rung answers
            // alone exactly as before, and the source label says which happened.
            // 2026-08-26: this corroboration call went STRAIGHT to ddgHtml,
            // around skipReason. So on a machine where DuckDuckGo is
            // unreachable it charged every freshness query a full 10s
            // PROVIDER_TIMEOUT for a merge partner that could never arrive —
            // measured as the bulk of an 11s news query here. Corroboration is
            // additive by design ("if the second provider has nothing, this rung
            // answers alone"), so skipping it costs nothing but the merge.
            //
            // Routed through the SAME gate as every other attempt, and its
            // failure charged to the same cooldown, so one dead endpoint is
            // learned once rather than once per rung.
            var corroborating = []
            var corroborateSkip = skipReason('ddg-html')
            if (corroborateSkip) note('ddg-html', corroborateSkip + ' (news corroboration)')
            else {
              try {
                corroborating = await ddgHtml(q, max, traceBus) || []
                if (corroborating.length) worked('ddg-html')
                else failed('ddg-html')
              } catch (_) { corroborating = []; failed('ddg-html') }
            }
            var merged = newsRung.mergeSearchResults(newsResults, corroborating, max)
            worked('google-news-rss'); return succeed(q, merged,
              corroborating.length ? 'google-news-rss+duckduckgo-html' : 'google-news-rss')
          }
        } catch (err) { traceBus.emit('health.anomaly', { kind: 'search-provider-failed', provider: 'google-news-rss', error: err.message }); }
        failed('google-news-rss')
      }
    }

    // 0. Local open-webSearch daemon — FIRST on purpose. It is free, unmetered
    // and on loopback; spending Exa's 150-a-day free quota before trying a free
    // local engine is backwards. A missing daemon costs one refused TCP connect.
    var localSkip = skipReason('local-websearch')
    if (localSkip) note('local-websearch', localSkip)
    else {
      try {
        var localResults = await localWebSearch(q, max, traceBus)
        if (localResults && localResults.length) {
          worked('local-websearch'); return succeed(q, localResults.slice(0, max), 'local-websearch')
        }
      } catch (err) { traceBus.emit('health.anomaly', { kind: 'search-provider-failed', provider: 'local-websearch', error: err.message }); }
      failed('local-websearch')
    }

    // 1a. Exa REST API — only if EXA_API_KEY is configured (higher rate limits)
    var exaSkip = skipReason('exa', 'EXA_API_KEY')
    if (exaSkip) note('exa', exaSkip)
    else {
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
            worked('exa'); return succeed(q, results.slice(0, max), 'exa')
          }
        }
      } catch (err) { traceBus.emit('health.anomaly', { kind: 'search-provider-failed', provider: 'exa', error: err.message }); }
      failed('exa')
    }

    // 1b. Exa MCP free tier — zero-config default (no key needed, 150 calls/day)
    var mcpSkip = skipReason('exa-mcp')
    if (mcpSkip) note('exa-mcp', mcpSkip)
    else {
      try {
        var mcpResults = await exaMcpSearch(q, max, traceBus)
        if (mcpResults.length) {
          worked('exa-mcp'); return succeed(q, mcpResults.slice(0, max), 'exa-mcp')
        }
      } catch (err) { traceBus.emit('health.anomaly', { kind: 'search-provider-failed', provider: 'exa-mcp', error: err.message }); }
      failed('exa-mcp')
    }

    // 2. DuckDuckGo HTML direct (+ fallback parser if primary returns nothing).
    // Suppression key matches the anomaly's own `provider` field ('ddg-html'),
    // not the success-path `source` label ('duckduckgo-html') — they differ.
    var ddgHtmlSkip = skipReason('ddg-html')
    if (ddgHtmlSkip) note('ddg-html', ddgHtmlSkip)
    else {
      try {
        var ddgResults = await ddgHtml(q, max, traceBus)
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
          worked('ddg-html'); return succeed(q, ddgResults, 'duckduckgo-html')
        }
      } catch (err) { traceBus.emit('health.anomaly', { kind: 'search-provider-failed', provider: 'ddg-html', error: err.message }); }
      failed('ddg-html')
    }

    // 3. DuckDuckGo Lite (suppression key: 'ddg-lite', matching the anomaly's provider field)
    var ddgLiteSkip = skipReason('ddg-lite')
    if (ddgLiteSkip) note('ddg-lite', ddgLiteSkip)
    else {
      try {
        var liteResults = await ddgLite(q, max, traceBus)
        if (liteResults.length) {
          worked('ddg-lite'); return succeed(q, liteResults, 'duckduckgo-lite')
        }
      } catch (err) { traceBus.emit('health.anomaly', { kind: 'search-provider-failed', provider: 'ddg-lite', error: err.message }); }
      failed('ddg-lite')
    }

    // 4. Jina AI search — NOT key-free any more; measured HTTP 401 on 2026-08-20.
    var jinaSkip = skipReason('jina')
    if (jinaSkip) note('jina', jinaSkip)
    else {
      try {
        var jinaResults = await jinaSearch(q, max, traceBus)
        if (jinaResults.length) {
          worked('jina'); return succeed(q, jinaResults, 'jina')
        }
      } catch (err) { traceBus.emit('health.anomaly', { kind: 'search-provider-failed', provider: 'jina', error: err.message }); }
      failed('jina')
    }

    // NO SECOND NEWS POSITION HERE, AND THAT IS THE SAFETY PROPERTY — not an
    // omission. Measured 2026-08-21: Google News RSS NEVER returns zero. It
    // answered "FIFA World Cup 2030 host countries" correctly, answered
    // "Argentina FIFA ranking" with a related-but-wrong power-rankings headline,
    // and answered "how to fix a leaking tap" with a content farm (59 items).
    // A source that always produces something plausible is the worst possible
    // partner for a model that already fabricates: unlike an empty result, it can
    // never trigger the "I don't have this" path. So the rung fires ONLY on a
    // freshness-marked query, never as a catch-all, never when an earlier
    // provider came back empty, and never in the last-resort slot.
    //
    // Wikipedia keeps that slot DELIBERATELY: an encyclopaedia miss is honest,
    // and an RSS miss is not.
    //
    // 5. Wikipedia full-text search (BUG-280). This used to be action=opensearch, whose
    // title-prefix matching could not answer a sentence at all — 'weather in London today'
    // scored 0 hits against 3 for the bare word 'London'. It is still a last resort and
    // still an encyclopaedia, so an empty answer for a shopping or recipe query remains
    // CORRECT behaviour rather than a fault, which is why its note falls through to
    // 'no results' and it emits no anomaly.
    var wikiSkip = skipReason('wikipedia')
    if (wikiSkip) note('wikipedia', wikiSkip)
    else {
      try {
        var wikiResults = await wikiSearch(q, max, traceBus)
        if (wikiResults.length) {
          worked('wikipedia'); return succeed(q, wikiResults, 'wikipedia')
        }
      } catch (err) { traceBus.emit('health.anomaly', { kind: 'search-provider-failed', provider: 'wikipedia', error: err.message }); }
      failed('wikipedia')
    }

    // The failure now carries the evidence instead of discarding it. Note the shape: the
    // caller contract is unchanged ({ ok:false, result:<string> }) — this is a more
    // informative string in the same field, not a new response shape, so no consumer or
    // widget needs to change.
    return { ok: false, result: 'All search providers are unavailable (tried: ' + tried.join('; ') + ').' }
  } catch (err) {
    return { ok: false, result: 'Search failed: ' + err.message }
  }
}

module.exports = {
  web_search: web_search,
  // Exports for testing
  // The cooldown is module-level because its whole purpose is memory ACROSS
  // calls. That makes web_search order-dependent inside one process, so a test
  // that wants a known starting state has to be able to say so — a module with
  // hidden cross-call state and no way to clear it is untestable by
  // construction. Production never calls this.
  _resetProviderCooldown: function() { providerCooldown.reset() },
  _providerCooldownSnapshot: function() { return providerCooldown.snapshot() },
  _stripTags: stripTags,
  _unwrapDdgHref: unwrapDdgHref,
  _ddgHtml: ddgHtml,
  _ddgHtmlFallback: ddgHtmlFallback,
  _ddgLite: ddgLite,
  _jinaSearch: jinaSearch,
  _wikiSearch: wikiSearch,
  _localWebSearch: localWebSearch,
  _resolveLocalSearchUrl: resolveLocalSearchUrl,
  _localSearchEngines: localSearchEngines,
  _exaMcpSearch: exaMcpSearch,
  _parseExaMcpText: parseExaMcpText,
  _isTimeSensitive: isTimeSensitive,
  _succeed: succeed
}
