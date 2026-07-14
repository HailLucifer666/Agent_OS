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
    if (ip === '::1' || ip === '::') return true;
    if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  }
  return false;
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
  try { parsed = new URL(raw); } catch (_) { return false; }
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
    var res = await fetch(raw, {
      signal: controller.signal,
      headers: { 'User-Agent': BROWSER_UA },
      redirect: 'follow',
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
    var res2 = await fetch(jinaUrl, {
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
          }
        };
      }
    }
  } catch (_) { /* both failed */ }

  return { ok: false, error: 'Could not fetch content from ' + raw };
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { web_fetch: web_fetch, _stripHtml: stripHtml };
