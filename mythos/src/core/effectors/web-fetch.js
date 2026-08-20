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

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    var parts = ip.split('.').map(Number);
    if (parts[0] === 127) return true;                                        // 127.0.0.0/8
    if (parts[0] === 10) return true;                                         // 10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;   // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true;                    // 192.168.0.0/16
    if (parts[0] === 169 && parts[1] === 254) return true;                    // 169.254.0.0/16 (link-local / cloud metadata)
    if (parts[0] === 0) return true;                                          // 0.0.0.0
  }
  if (net.isIPv6(ip)) {
    // Drop the zone id before classifying. net.isIPv6 accepts 'fe80::1%eth0' and
    // '::1%1', but every check below is a prefix or exact-string match against
    // the address alone — so '::1%1' matched neither the `=== '::1'` loopback
    // test nor any prefix, and expandIPv6 rejected the '1%1' group, leaving a
    // zoned loopback address classified as public. Found 2026-08-20 while
    // measuring the guard rather than reading it. The zone selects an interface,
    // never a different host, so removing it cannot make a public address look
    // private.
    var v6 = ip.toLowerCase().replace(/%.*$/, '');
    if (v6 === '::1' || v6 === '::') return true;
    if (v6.startsWith('fe80:') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
    // VERIFIED BYPASS, 2026-08-19: http://[::ffff:127.0.0.1]:PORT/ and its
    // hex spelling http://[0:0:0:0:0:ffff:7f00:1]/ both passed every check
    // above and fetched real content off a loopback service. None of the
    // prefixes match, and net.isIPv4() is false for a bracketed literal, so
    // the address reached fetch() unexamined. Unwrap to the IPv4 address the
    // network stack will actually dial, and ask the same question again.
    var embedded = embeddedIPv4(v6);
    if (embedded) return isPrivateIp(embedded);
  }
  return false;
}

// Expand an IPv6 literal to its eight 16-bit groups, or null if it is not one.
// Handles :: elision and a trailing dotted quad. Deliberately not a regex over
// the whole address: the point is to end up with the same 128 bits the stack
// will use, not to recognise a spelling.
function expandIPv6(v6) {
  var s = String(v6).toLowerCase();
  var dotted = s.match(/^(.*:)((?:[0-9]{1,3}[.]){3}[0-9]{1,3})$/);
  if (dotted) {
    if (!net.isIPv4(dotted[2])) return null;
    var b = dotted[2].split(".").map(Number);
    s = dotted[1] + (((b[0] << 8) | b[1]) >>> 0).toString(16) + ":" + (((b[2] << 8) | b[3]) >>> 0).toString(16);
  }
  var halves = s.split("::");
  if (halves.length > 2) return null;
  var left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  var right = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
  var groups;
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    groups = left;
  } else {
    var fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    groups = left.concat(new Array(fill).fill("0"), right);
    if (groups.length !== 8) return null;
  }
  var out = [];
  for (var i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    out.push(parseInt(groups[i], 16));
  }
  return out;
}

// The IPv4 address embedded in an IPv4-mapped (::ffff:a.b.c.d) or
// IPv4-compatible (::a.b.c.d) IPv6 literal, in dotted form, else null.
function embeddedIPv4(v6) {
  var g = expandIPv6(v6);
  if (!g) return null;
  for (var i = 0; i < 5; i++) if (g[i] !== 0) return null;
  if (g[5] !== 0 && g[5] !== 0xffff) return null;
  return [(g[6] >> 8) & 255, g[6] & 255, (g[7] >> 8) & 255, g[7] & 255].join(".");
}

function isBlockedHostname(hostname) {
  var h = hostname.toLowerCase();
  if (h === 'localhost' || h === 'local' || h.endsWith('.local')) return true;
  if (h === '[::1]' || h === '::1') return true;
  // Cloud metadata endpoints
  if (h === '169.254.169.254' || h === 'metadata.google.internal') return true;
  return false;
}

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
