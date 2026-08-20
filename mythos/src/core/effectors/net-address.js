'use strict';

// net-address.js — one address classifier, shared by every caller that needs to
// know WHERE a URL points before fetching it.
//
// Extracted from web-fetch.js on 2026-08-20, for the reason html-text.js was
// extracted from it the same day: a second, weaker near-duplicate had appeared
// elsewhere. BUG-280's search chain added a local-daemon rung whose loopback
// check was a four-entry exact-match array, while this classifier — with IPv6
// expansion, IPv4-mapped-IPv6 unwrapping, zone-id stripping and two recorded
// bypasses closed behind it — already existed a directory away. One invariant
// with two implementations is this repo's most frequently recurring defect
// class, and both copies always agree on the day they are written.
//
// TWO POLICIES, DELIBERATELY SEPARATE, over one classification:
//
//   isPrivateAddress / isBlockedHostname   web-fetch.js's SSRF DENYLIST —
//                                          refuse anything internal
//   isLoopbackHost                         web-search.js's ALLOWLIST —
//                                          require loopback
//
// They are not interchangeable and collapsing them would be a widening, not a
// simplification: "private" is strictly larger than "loopback", so answering
// "is this loopback?" with isPrivateAddress() would accept the whole of 10/8,
// 172.16/12 and 192.168/16 as a valid local search daemon.
//
// No dependency on purpose. This is deliberately NOT the place to adopt an IP
// library: the value here is that one function answers the question, and a
// library swap is a separate, now-single-site change.

var net = require('net');

// --- SSRF protection --------------------------------------------------------
// Block requests targeting private/internal/loopback/metadata networks.

function isPrivateAddress(ip) {
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
    if (embedded) return isPrivateAddress(embedded);
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
  var h = String(hostname || '').toLowerCase();
  if (h === 'localhost' || h === 'local' || h.endsWith('.local')) return true;
  if (h === '[::1]' || h === '::1') return true;
  // Cloud metadata endpoints
  if (h === '169.254.169.254' || h === 'metadata.google.internal') return true;
  return false;
}

// --- the opposite policy ----------------------------------------------------
// True only for an address that reaches THIS machine's loopback interface.
//
// An allowlist, so every unrecognised spelling fails closed. That is the right
// direction here: the caller is deciding whether to send a request to something
// it believes is a local sidecar, and refusing a legitimate-but-exotic spelling
// costs a config error message, while accepting a wrong one is an SSRF.
//
// Bracket stripping is not cosmetic — `new URL('http://[::1]:3100').hostname`
// returns '[::1]' WITH the brackets, and net.isIPv6() says false for that.
function isLoopbackHost(hostname) {
  var h = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost') return true;
  if (net.isIPv4(h)) {
    // All of 127.0.0.0/8, not just 127.0.0.1 — a sidecar bound to 127.0.0.2 is
    // just as local, and the exact-match list this replaced refused it.
    return h.split('.').map(Number)[0] === 127;
  }
  if (net.isIPv6(h)) {
    var v6 = h.replace(/%.*$/, '');
    var g = expandIPv6(v6);
    // Compare the expanded 128 bits rather than the string: '::1' and
    // '0:0:0:0:0:0:0:1' are the same address, and a string test only catches
    // whichever spelling the author happened to think of.
    if (g && g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0
        && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1) return true;
    // ::ffff:127.0.0.1 and its hex spelling reach loopback too — the same shape
    // as the bypass recorded against isPrivateAddress above. '::' unwraps to
    // 0.0.0.0, which is every interface rather than loopback, and correctly
    // falls through to false.
    var embedded = embeddedIPv4(v6);
    if (embedded) return isLoopbackHost(embedded);
  }
  return false;
}

module.exports = {
  isPrivateAddress: isPrivateAddress,
  isBlockedHostname: isBlockedHostname,
  isLoopbackHost: isLoopbackHost,
  expandIPv6: expandIPv6,
  embeddedIPv4: embeddedIPv4,
};
