'use strict';

// web-fetch.js — shared URL fetcher. Extracted from from-dashboard.js so both
// the dashboard effector and the agent-actions research gate can use it.
// Direct request first (Node's built-in client, no dependency), Jina reader
// fallback (handles JS-rendered pages).

var dns = require('dns');
var net = require('net');
var http = require('http');
var https = require('https');
var zlib = require('zlib');

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
const { isPrivateAddress, isBlockedHostname, embeddedIPv4, guardedLookup } = require('./net-address');
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
  // rejected the same input with the same error, so the request died one layer
  // later. What was broken is the control — a refusal that depended on Node's
  // URL parser and undici's parser agreeing about every malformed input forever,
  // with "allow" as the default when they diverge. Failing closed costs nothing:
  // a URL neither parser accepts cannot be fetched, so nothing legitimate is
  // refused by this line.
  //
  // BUG-303 removed undici from this path entirely, which makes the point
  // sharper rather than moot: the second parser that used to catch this by
  // accident is no longer there to.
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

// --- the transport ----------------------------------------------------------
//
// BUG-303, fixed 2026-08-22. This was a plain fetch() call, and that call is
// what made the guard above bypassable. isInternalUrl resolves the hostname and
// approves the ADDRESS; fetch() is then handed the NAME and resolves it again,
// at connect time, with no way to be told which address was approved. Two
// resolutions, and an attacker who owns the domain only has to make them
// differ: a public address for the first query, 127.0.0.1 for the second.
//
// Measured at HEAD before this change, against a loopback server: ok=true, and
// the internal service's body came back to the caller. The comment on the DNS
// check claimed it "catches DNS rebinding attacks"; it was the rebinding hole.
//
// So the request is built here, on Node's built-in client, with guardedLookup
// as its resolver — the answer that is classified is the answer that is
// dialled, and there is no second lookup left to poison. Nothing was added to
// package.json: undici would have made this a three-line change, and the SSRF
// path is the last place to take on supply-chain surface in the name of safety.
//
// The object handed back is the part of the fetch interface this file actually
// used — status, ok, case-insensitive headers.get, text(). Keeping that shape
// is why the redirect loop below and both call sites are unchanged.
var REQUEST_TIMEOUT_MS = 15000;
// Nothing downstream can use more than MAX_CHARS of any page, so capping the
// body costs no content and stops a hostile server streaming until memory runs
// out. fetch() had no such bound.
var MAX_BODY_BYTES = 8 * 1024 * 1024;

// A holder rather than a bare call: the redirect tests drive the loop without a
// network, and the transport tests drive the client without the guard, by
// writing here. What it holds by default is pinned by a test — a seam nothing
// asserts is a hole with a comment on it.
var transport = { request: guardedRequest, lookup: guardedLookup };

function decodeBody(buf, contentType) {
  // fetch() honoured the charset and the raw client hands back bytes. Only the
  // one legacy family is worth special-casing; everything else current is UTF-8
  // and Buffer has no decoder for the rest in any case.
  if (/charset\s*=\s*"?(iso-8859-1|latin1|windows-1252)/i.test(contentType || '')) {
    return buf.toString('latin1');
  }
  return buf.toString('utf8');
}

function guardedRequest(rawUrl, init) {
  init = init || {};
  return new Promise(function (resolve, reject) {
    var target;
    try { target = new URL(rawUrl); } catch (err) { reject(err); return; }
    var client = target.protocol === 'https:' ? https : http;
    var settled = false;

    function finish(fn, value) {
      if (settled) return;
      settled = true;
      if (init.signal && init.signal.removeEventListener) {
        init.signal.removeEventListener('abort', onAbort);
      }
      fn(value);
    }
    function onAbort() {
      req.destroy(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    }

    var req = client.request(target, {
      method: init.method || 'GET',
      // Ask for compression and undo it below. Refusing it outright would make
      // this client look unlike the browser its User-Agent claims to be.
      headers: Object.assign({ 'Accept-Encoding': 'gzip, deflate, br' }, init.headers || {}),
      // THE WHOLE POINT OF THE CHANGE. This runs at connect time and refuses
      // the connection itself.
      lookup: transport.lookup,
      // No pooled sockets: a reused connection skips the lookup entirely. Every
      // request doing its own guarded resolution is worth more here than
      // keep-alive is on an effector that runs a few times a minute.
      agent: false,
    }, function (res) {
      var encoding = String(res.headers['content-encoding'] || '').toLowerCase();
      var stream = res;
      // THE TRAP IN LEAVING fetch(): it un-gzipped silently and this client does
      // not. Without these three lines every compressed page returns as binary
      // rubbish and is handed to the brain as research.
      if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());

      var chunks = [];
      var size = 0;

      function deliver() {
        var contentType = res.headers['content-type'] || '';
        var buf = Buffer.concat(chunks);
        finish(resolve, {
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          headers: {
            get: function (name) {
              var v = res.headers[String(name).toLowerCase()];
              if (v === undefined) return null;
              return Array.isArray(v) ? v.join(', ') : v;
            },
          },
          text: function () { return Promise.resolve(decodeBody(buf, contentType)); },
        });
      }

      stream.on('data', function (chunk) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          chunks.push(chunk.slice(0, chunk.length - (size - MAX_BODY_BYTES)));
          res.destroy();
          deliver();
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', function (err) { finish(reject, err); });
      stream.on('end', deliver);
    });

    req.on('error', function (err) { finish(reject, err); });
    req.setTimeout(REQUEST_TIMEOUT_MS, function () {
      req.destroy(new Error('request timed out after ' + REQUEST_TIMEOUT_MS + 'ms'));
    });
    if (init.signal) {
      // Already aborted before we started: destroy and stop. Calling end() on a
      // destroyed request only produces a second error to ignore.
      if (init.signal.aborted) { onAbort(); return; }
      if (init.signal.addEventListener) init.signal.addEventListener('abort', onAbort);
    }
    req.end();
  });
}

// Follow redirects by hand so that every hop is re-checked. Letting the client
// follow them hands the decision to the transport, and the pre-flight guard only
// ever sees the FIRST url — so a public host answering 302 Location:
// http://169.254.169.254/ walks straight through it. VERIFIED BYPASS,
// 2026-08-19: a 302 pointing at a loopback service was followed and its body
// returned to the caller. Written against fetch()'s redirect:"follow"; the
// built-in client that replaced it in BUG-303 never follows a 3xx on its own, so
// this loop is now the only thing that can — which does not make it optional,
// it makes it the whole mechanism.
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
    // redirect:"manual" is gone because the raw client never follows a 3xx by
    // itself — the hand-rolled loop here is the only thing that can, and it
    // re-checks each hop before it does.
    var res = await transport.request(current, init);
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
  } catch (err) {
    // A REFUSAL IS NOT A REASON TO TRY THE OTHER ROUTE. The ssrfBlocked tag has
    // existed since 2026-08-19 and nothing ever read it: this catch treated
    // "blocked for targeting an internal address" exactly like "the site is
    // slow", and re-sent the same target through r.jina.ai. Answering a blocked
    // request by a different road is not a fallback. The comment above
    // guardedFetch already claimed this worked, which is what kept it hidden.
    if (err && err.ssrfBlocked) {
      return { ok: false, error: 'Blocked: ' + String(err.message).replace(/^blocked:\s*/i, '') + ' (SSRF protection).' };
    }
    /* otherwise fall through to Jina */
  }

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
  _transport: transport,
  _guardedRequest: guardedRequest,
};
