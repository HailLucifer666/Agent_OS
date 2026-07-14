'use strict';

// util/ssrf-guard.js — SECURITY-CRITICAL. guardUrl(rawUrl) is the single gate
// every outbound web-fetch hop must pass. It MUST always read `.hostname` off a
// real `new URL()` — never regex the raw string. Node normalizes decimal/hex/
// octal IPv4 (2130706433 → 127.0.0.1) and resolves userinfo-vs-host tricks
// (http://127.0.0.1:80@evil.com → hostname evil.com) only through URL parsing.
// Blocks: non-http(s) schemes, localhost, all private/loopback/link-local IPv4
// ranges, IPv6 loopback/ULA/link-local + IPv4-mapped-v6, and any hostname that
// DNS-resolves to a blocked address (fail-closed on DNS error). Residual
// DNS-rebinding risk (resolve ≠ connect atomically) is accepted/documented —
// pinning needs an undici dispatcher (a new dep, out of scope).

const dns = require('dns');
const net = require('net');

const BLOCKED_V4_RANGES = [
  ['0.0.0.0', 8], ['127.0.0.0', 8], ['10.0.0.0', 8],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16],
];

function ipv4ToInt(ip) {
  var p = ip.split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function inV4Range(ip, base, bits) {
  var mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

function isBlockedV4(ip) {
  return BLOCKED_V4_RANGES.some(function (r) { return inV4Range(ip, r[0], r[1]); });
}

function isBlockedV6(ip) {
  var l = ip.toLowerCase();
  if (l === '::1') return true;
  if (/^fe[89ab][0-9a-f]:/.test(l)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(l)) return true;
  // IPv4-mapped in dotted form (::ffff:1.2.3.4 or ::1.2.3.4).
  var m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(l) || /^::(\d+\.\d+\.\d+\.\d+)$/i.exec(l);
  if (m) return isBlockedV4(m[1]);
  // IPv4-mapped in Node-normalized hex form (new URL() rewrites ::ffff:127.0.0.1
  // as ::ffff:7f00:1). Reconstruct the embedded v4 and re-check it — without this
  // a bracketed loopback URL would slip past the guard.
  var h = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(l);
  if (h) {
    var hi = parseInt(h[1], 16), lo = parseInt(h[2], 16);
    var v4 = [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.');
    return isBlockedV4(v4);
  }
  return false;
}

function isBlockedIp(ip) {
  var k = net.isIP(ip);
  if (k === 4) return isBlockedV4(ip);
  if (k === 6) return isBlockedV6(ip);
  return true;
}

async function guardUrl(rawUrl) {
  var u;
  try { u = new URL(String(rawUrl)); }
  catch (err) { return { ok: false, reason: 'invalid URL: ' + err.message }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'blocked scheme: ' + u.protocol };
  var hostname = u.hostname;
  if (hostname.charAt(0) === '[' && hostname.charAt(hostname.length - 1) === ']') hostname = hostname.slice(1, -1);
  if (hostname.toLowerCase() === 'localhost') return { ok: false, reason: 'blocked host: localhost' };
  var lit = net.isIP(hostname);
  if (lit) {
    if (isBlockedIp(hostname)) return { ok: false, reason: 'blocked IP literal: ' + hostname };
    return { ok: true, url: u };
  }
  var addrs;
  try { addrs = await dns.promises.lookup(hostname, { all: true, verbatim: true }); }
  catch (err) { return { ok: false, reason: 'DNS resolution failed: ' + err.message }; }
  if (!addrs.length) return { ok: false, reason: 'DNS returned no addresses' };
  for (var i = 0; i < addrs.length; i++) {
    if (isBlockedIp(addrs[i].address)) return { ok: false, reason: 'hostname resolves to blocked address: ' + addrs[i].address };
  }
  return { ok: true, url: u };
}

module.exports = { guardUrl, isBlockedIp, isBlockedV4, isBlockedV6 };
