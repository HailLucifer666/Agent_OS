'use strict';

// local-search-daemon.js — the open-webSearch rung of the web_search chain.
//
// EXTRACTED FROM web-search.js on 2026-08-26, not rewritten: every line below
// moved verbatim. The file-size ratchet refused the BUG-361 change with
// "an already-oversized file got bigger. The baseline number is a ceiling, not
// a suggestion — do not raise it to make this pass. Move the new code somewhere
// else." This rung is the natural piece to move: it is the only one that owns a
// configured URL, an SSRF-shaped validation of it, an engine list and a response
// parser, so it is cohesive on its own and leaves the chain in web-search.js.
//
// Exported for web-search.js and for the tests that already reach these by name
// (bug-280 asserts _resolveLocalSearchUrl and the engine list directly).
// BUG-280: the adopted local search daemon (open-webSearch, Apache-2.0). Treated
// exactly like cua-driver — an OPTIONAL external binary the operator installs and
// runs. Absent daemon means this rung records why and the chain continues; it is
// never fatal and never silent. Install/run instructions live in .env.example.
//
// Loopback only, and validated rather than trusted: this rung takes a URL from
// configuration and fetches it, which is an SSRF-shaped surface. A non-loopback
// value is refused by name instead of being defaulted away, because a wrong
// default that quietly 404s makes a broken install look like "no results".
// How long any one provider gets before the chain gives up on it. Defined HERE
// rather than in web-search.js because the extraction on 2026-08-26 left it
// behind and this rung referenced it across the module boundary — caught only by
// a test, because the reference sat inside the rung's try/catch and surfaced as
// the provider failure string "PROVIDER_TIMEOUT is not defined" instead of a
// crash. One definition, imported by the chain, so the two cannot drift.
var PROVIDER_TIMEOUT = 10000

var WEB_SEARCH_LOCAL_URL_DEFAULT = 'http://127.0.0.1:3100'
var WEB_SEARCH_ENGINES_DEFAULT = 'startpage'

// The loopback test is the SHARED classifier, not a list local to this file.
// This rung originally carried its own four-entry exact-match array while
// web-fetch.js already held a full one — IPv6 expansion, IPv4-mapped-IPv6
// unwrapping, zone-id stripping, two recorded bypasses closed. That is one
// invariant with two implementations, which is the defect class this repo hits
// most often. Note the POLICY here is the inverse of web-fetch's: that one
// refuses private addresses, this one REQUIRES loopback, and 'private' is
// strictly larger than 'loopback' — so they share the classification and keep
// their own policies. See net-address.js.
var isLoopbackHost = require('./net-address').isLoopbackHost
var isLoopbackHost = require('./net-address').isLoopbackHost

function localSearchBase() {
  return String(process.env.WEB_SEARCH_LOCAL_URL || WEB_SEARCH_LOCAL_URL_DEFAULT).trim()
}

// Returns { ok:true, url } or { ok:false, reason } — never throws, so a typo in
// the operator's .env cannot take out the whole chain.
function resolveLocalSearchUrl() {
  var raw = localSearchBase()
  var parsed
  try { parsed = new URL(raw) } catch (_) {
    return { ok: false, reason: 'WEB_SEARCH_LOCAL_URL is not a URL: "' + raw + '"' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'WEB_SEARCH_LOCAL_URL must be http or https, got ' + parsed.protocol }
  }
  if (!isLoopbackHost(parsed.hostname)) {
    return { ok: false, reason: 'WEB_SEARCH_LOCAL_URL must point at loopback (127.0.0.1 or localhost), got "' + parsed.hostname + '"' }
  }
  return { ok: true, url: parsed.origin + '/search' }
}

function localSearchEngines() {
  return String(process.env.WEB_SEARCH_ENGINES || WEB_SEARCH_ENGINES_DEFAULT)
    .split(',').map(function(s) { return s.trim() }).filter(Boolean)
}

// Local open-webSearch daemon. Its REST contract, re-captured from the running
// daemon on 2026-08-26 (was 2026-08-20; the shape had grown three fields we were
// parsing straight past — see the partialFailures handling below):
//   POST /search {query, limit, engines[]}
//   -> {status:'ok', error:null, hint:null,
//       data:{query, engines, totalResults,
//             results:[{title, url, description, source, engine}],
//             partialFailures:[{engine, code, message}]}}
// `status:'ok'` describes the REQUEST, not the search: a run where every engine
// failed still answers 'ok' with an empty results array. Read partialFailures.
// Note the field name: 'description', not 'snippet'. Every other provider in this chain returns
// 'snippet' and the widget reads 'snippet', so the rename below is load-bearing:
// passing the daemon's shape straight through would render a blank line under
// every result while every count assertion still passed.
async function localWebSearch(q, maxResults, bus) {
  var target = resolveLocalSearchUrl()
  if (!target.ok) {
    if (bus) bus.emit('health.anomaly', { kind: 'search-provider-failed', provider: 'local-websearch', error: target.reason })
    return null
  }
  var controller = new AbortController()
  var timer = setTimeout(function() { controller.abort() }, PROVIDER_TIMEOUT)
  try {
    var res = await fetch(target.url, {
      method: 'POST',
      signal: controller.signal,
      // No redirect following: this is a loopback daemon, and a redirect is the
      // one way a validated loopback URL can still reach somewhere else.
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, limit: maxResults, engines: localSearchEngines() })
    })
    clearTimeout(timer)
    if (!res.ok) {
      if (bus) bus.emit('health.anomaly', { kind: 'search-provider-failed', provider: 'local-websearch', error: 'HTTP ' + res.status })
      return null
    }
    var body = await res.json()
    if (!body || body.status !== 'ok' || !body.data || !Array.isArray(body.data.results)) {
      var why = body && body.error && body.error.message ? body.error.message : 'unexpected response shape'
      if (bus) bus.emit('health.anomaly', { kind: 'search-provider-failed', provider: 'local-websearch', error: why })
      return null
    }
    // THE DAEMON REPORTS ITS OWN FAILURES AND WE THREW THEM AWAY (2026-08-26).
    // The contract comment above was captured 2026-08-20 and is stale: the
    // daemon also returns `partialFailures`, `error` and `hint`. Measured today
    // against the healthy running daemon, every engine returned zero results —
    // and `bing` said exactly why, `{engine:'bing', code:'engine_error',
    // message:'Request failed with status code 301'}`, while `startpage` (the
    // configured default) and `duckduckgo` returned an EMPTY partialFailures
    // array with zero results and no explanation at all.
    //
    // So the one honest diagnostic in the whole chain was parsed past, and a
    // total scrape failure arrived here indistinguishable from "nothing matched
    // your query". Surface it: an empty result set WITH a named engine error is
    // a broken provider, and it must say so.
    var partial = Array.isArray(body.data.partialFailures) ? body.data.partialFailures : []
    if (!body.data.results.length) {
      var engineErrors = partial.map(function(f) {
        return (f && f.engine ? f.engine : 'engine') + ': ' + ((f && f.message) || (f && f.code) || 'failed')
      })
      // Named cause when the daemon gave one; otherwise say plainly that it
      // reported none, rather than inventing "no results for this query" — the
      // engines are silently anti-botted and a query-shaped excuse is wrong.
      var reason = engineErrors.length
        ? 'every engine failed — ' + engineErrors.join('; ')
        : 'all engines returned 0 results and reported no error (engines: '
          + localSearchEngines().join(', ') + ')'
      if (bus) bus.emit('health.anomaly', { kind: 'search-provider-failed', provider: 'local-websearch', error: reason })
      return null
    }
    // A PARTIAL failure still yields results, so it is not a rung failure — but
    // it is the early warning that an engine is dying, and silence here is how
    // the total failure above arrived with no history behind it.
    if (partial.length && bus) {
      bus.emit('health.anomaly', {
        kind: 'search-engine-degraded', provider: 'local-websearch',
        engines: partial.map(function(f) { return f && f.engine }).filter(Boolean),
        error: partial.map(function(f) { return (f && f.engine) + ': ' + ((f && f.message) || (f && f.code)) }).join('; ')
      })
    }
    return body.data.results.slice(0, maxResults).map(function(r) {
      return {
        title: r.title || '',
        url: r.url || '',
        snippet: String(r.description || '').slice(0, 300)
      }
    })
  } catch (err) {
    clearTimeout(timer)
    if (bus) bus.emit('health.anomaly', { kind: 'search-provider-failed', provider: 'local-websearch', error: err.message })
    return null
  }
}


module.exports = {
  PROVIDER_TIMEOUT: PROVIDER_TIMEOUT,
  WEB_SEARCH_LOCAL_URL_DEFAULT: WEB_SEARCH_LOCAL_URL_DEFAULT,
  WEB_SEARCH_ENGINES_DEFAULT: WEB_SEARCH_ENGINES_DEFAULT,
  localSearchBase: localSearchBase,
  resolveLocalSearchUrl: resolveLocalSearchUrl,
  localSearchEngines: localSearchEngines,
  localWebSearch: localWebSearch,
};
