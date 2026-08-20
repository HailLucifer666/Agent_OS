'use strict';

// web-fetch.js — shared URL fetcher. Extracted from from-dashboard.js so both
// the dashboard effector and the agent-actions research gate can use it.
// Direct fetch first (fast, no dep), Jina reader fallback (handles JS-rendered pages).

var dns = require('dns');
var net = require('net');

var BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
var MAX_CHARS = 4000;

// --- SSRF protection --------------------------------------------------------
// Block requests targeting private/internal/loopback/metadata networks.
//
// The classifier moved to net-address.js on 2026-08-20. It had grown a second,
// weaker near-duplicate in web-search.js (BUG-280 added a four-entry
// exact-match loopback list), which is the same reason stripTags moved to
// html-text.js. Two implementations of one invariant always agree on the day
// they are written and diverge silently afterwards. The local aliases below
// keep every call site in this file — and its whole test suite — unchanged.
const { isPrivateAddress, isBlockedHostname, embeddedIPv4 } = require('./net-address');
const isPrivateIp = isPrivateAddress;

async function isInternalUrl(raw) {
  var parsed;
  // FAIL CLOSED on anything this function cannot read. Until 2026-08-20 this
  // catch returned false — "not internal" — so an unparseable URL was approved
  // by the one function whose whole job is refusing. Measured: every IPv6
  // zone-id form ('http://[fe80::1%25eth0]/' and friends) throws ERR_INVALID_URL
  // in new URL() and reached this branch.
  //
  // No live exploit path existed, and saying so is part of the record: undici
  // rejects the same input with the same error, so the request died one layer
  // later. What was broken is the control — a refusal that depended on Node's
  // URL parser and undici's parser agreeing about every malformed input forever,
  // with "allow" as the default when they diverge. Failing closed costs nothing:
  // a URL neither parser accepts cannot be fetched, so nothing legitimate is
  // refused by this line.
  try { parsed = new URL(raw); } catch (_) { return true; }
  // Fast-path: blocked hostnames
  if (isBlockedHostname(parsed.hostname)) return true;
  // Fast-path: IP literals in private ranges
  var host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIPv4(host) || net.isIPv6(host)) return isPrivateIp(host);
  // DNS resolution check (catches DNS rebinding attacks)
  try {
    var addrs = await dns.promises.lookup(parsed.hostname, { all: true });
    return addrs.some(function(a) { return isPrivateIp(a.address); });
  } catch (_) {
    // DNS resolution failed — block by default (fail-closed)
    return true;
  }
}

// Follow redirects by hand so that every hop is re-checked. redirect: "follow"
// hands the decision to undici, and the pre-flight guard only ever sees the
// FIRST url — so a public host answering 302 Location: http://169.254.169.254/
// walks straight through it. VERIFIED BYPASS, 2026-08-19: a 302 pointing at a
// loopback service was followed and its body returned to the caller.
//
// A blocked hop throws with ssrfBlocked set rather than returning a response,
// so the direct-fetch catch below cannot mistake it for "this page needs the
// Jina fallback" — the Jina path is a different request to a different host
// and re-running it would be answering a blocked request a second time.
var MAX_REDIRECTS = 5;
async function guardedFetch(startUrl, init) {
  var current = startUrl;
  for (var hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (await isInternalUrl(current)) {
      var blocked = new Error("blocked: redirect targets a private or internal network");
      blocked.ssrfBlocked = true;
      throw blocked;
    }
    var res = await fetch(current, Object.assign({}, init, { redirect: "manual" }));
    if (res.status < 300 || res.status > 399) return res;
    var location = res.headers.get("location");
    if (!location) return res;
    try {
      current = new URL(location, current).toString();
    } catch (_) {
      return res;   // unparseable Location: treat the 3xx as the final answer
    }
  }
  var tooMany = new Error("blocked: too many redirects");
  tooMany.ssrfBlocked = true;
  throw tooMany;
}

async function web_fetch({ url }) {
  if (!url || !String(url).trim()) return { ok: false, error: 'A URL is required.' };
  var raw = String(url).trim();
  if (!/^https?:\/\//i.test(raw)) return { ok: false, error: 'URL must start with http:// or https://' };

  // SSRF guard: reject URLs targeting internal/private networks
  if (await isInternalUrl(raw)) {
    return { ok: false, error: 'Blocked: URL targets a private or internal network (SSRF protection).' };
  }

  // Direct fetch first
  try {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, 15000);
    var res = await guardedFetch(raw, {
      signal: controller.signal,
      headers: { 'User-Agent': BROWSER_UA },
    });
    clearTimeout(timer);
    if (res.ok) {
      var contentType = res.headers.get('content-type') || '';
      var body = await res.text();
      var text = body;
      if (contentType.includes('text/html')) {
        text = stripHtml(body);
      }
      if (text && text.trim().length > 0) {
        var truncated = text.length > MAX_CHARS;
        return {
          ok: true,
          result: {
            url: raw,
            status: res.status,
            contentType: contentType.split(';')[0].trim(),
            content: text.slice(0, MAX_CHARS),
            truncated: truncated,
            totalLength: text.length,
            source: 'direct',
          }
        };
      }
    }
  } catch (_) { /* fall through to Jina */ }

  // Jina reader fallback (handles JS-rendered pages)
  try {
    var jinaUrl = 'https://r.jina.ai/' + raw.replace(/^https?:\/\//, '');
    var controller2 = new AbortController();
    var timer2 = setTimeout(function() { controller2.abort(); }, 15000);
    var res2 = await guardedFetch(jinaUrl, {
      signal: controller2.signal,
      headers: { 'User-Agent': BROWSER_UA },
    });
    clearTimeout(timer2);
    if (res2.ok) {
      var text2 = await res2.text();
      if (text2 && text2.trim()) {
        var truncated2 = text2.length > MAX_CHARS;
        return {
          ok: true,
          result: {
            url: raw,
            status: res2.status,
            contentType: 'text/plain',
            content: text2.slice(0, MAX_CHARS),
            truncated: truncated2,
            totalLength: text2.length,
            source: 'jina-reader',
          }
        };
      }
    }
  } catch (_) { /* both failed */ }

  return { ok: false, error: 'Could not fetch content from ' + raw };
}

// 2026-08-20: this was a weaker near-duplicate of web-search.js's stripTags. It
// decoded six entities; the search copy also handled numeric (&#8212;) and hex
// (&#x2014;) references, &apos;, &mdash;/&ndash;, and replaced an unrecognised
// entity with a space. So the same page produced different text depending on
// which effector read it — and this path, whose output is handed to the brain as
// research, was the weaker one. Both now call the one implementation in
// html-text.js. Kept as a named local so the export below and its call site do
// not move.
var stripTags = require('./html-text').stripTags;
function stripHtml(html) {
  return stripTags(html);
}

// The SSRF predicates are exported under the same _ convention as _stripHtml:
// they are the security boundary of this module and had no test at all until
// 2026-08-19, which is how two live bypasses survived in them.
module.exports = {
  web_fetch: web_fetch,
  _stripHtml: stripHtml,
  _isPrivateIp: isPrivateIp,
  _isBlockedHostname: isBlockedHostname,
  _isInternalUrl: isInternalUrl,
  _guardedFetch: guardedFetch,
  _embeddedIPv4: embeddedIPv4,
};
