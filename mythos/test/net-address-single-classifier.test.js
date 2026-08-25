'use strict';

// ONE address classifier, two opposite policies.
//
// BUG-280 shipped a loopback check in web-search.js — a four-entry exact-match
// array — while web-fetch.js already carried a mature address classifier with
// IPv6 expansion, IPv4-mapped-IPv6 unwrapping, zone-id stripping and two
// recorded, fixed bypasses behind it. One invariant, two implementations, which
// is this repo's most frequently recurring defect class. That duplication was
// introduced by the same change that fixed the search chain, and this file is
// the guard that stops it coming back.
//
// The two callers want OPPOSITE answers from the same primitive, and conflating
// them would be a real widening rather than a tidy-up:
//
//   web-fetch.js   REFUSES private/internal addresses  (a denylist)
//   web-search.js  REQUIRES loopback                   (an allowlist)
//
// "Private" is strictly larger than "loopback". Reusing isPrivateAddress() to
// answer "is this loopback?" would accept the whole of 10/8, 172.16/12 and
// 192.168/16 as a valid local search daemon — a widening dressed as reuse. So
// what is shared is the CLASSIFICATION, and each caller keeps its own policy.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const netAddress = require('../src/core/effectors/net-address');
const webFetch = require('../src/core/effectors/web-fetch');

describe('net-address: loopback is recognised in every spelling', () => {
  // The forms the four-entry array in web-search.js could not recognise. Each
  // one is a real loopback address a person could reasonably put in a .env, and
  // each was refused before this module existed. Failing closed was safe, but
  // it was still wrong.
  const LOOPBACK = [
    '127.0.0.1',
    '127.0.0.2',          // all of 127.0.0.0/8 is loopback, not just .1
    '127.255.255.254',
    'localhost',
    'LOCALHOST',          // hostnames are case-insensitive
    '::1',
    '[::1]',              // the form Node's URL.hostname actually returns
    '[0:0:0:0:0:0:0:1]',  // ::1 written out
    '[::ffff:127.0.0.1]', // IPv4-mapped IPv6 — the shape of a recorded bypass
    '[::ffff:7f00:1]',    // the same address, hex spelling
  ];

  for (const host of LOOPBACK) {
    it('accepts ' + host, () => {
      assert.equal(netAddress.isLoopbackHost(host), true, host + ' is loopback');
    });
  }
});

describe('net-address: everything else is not loopback', () => {
  const NOT_LOOPBACK = [
    'example.com',
    '8.8.8.8',
    '10.0.0.5',                     // private, but NOT loopback — the widening
    '192.168.1.10',                 //   this distinction exists to prevent
    '172.16.0.1',
    '169.254.169.254',              // cloud metadata: private, not loopback
    '127.0.0.1.evil.example.com',   // substring bypass
    'localhost.evil.example.com',   // substring bypass
    'notlocalhost',
    '0.0.0.0',                      // binds everywhere; not a loopback target
    '',
  ];

  for (const host of NOT_LOOPBACK) {
    it('rejects ' + (host || '(empty)'), () => {
      assert.equal(netAddress.isLoopbackHost(host), false, host + ' must not pass as loopback');
    });
  }

  it('the private ranges are still classified private, just not loopback', () => {
    // The negative control for the pair above: if isPrivateAddress had also
    // stopped recognising these, the tests above would pass for the wrong
    // reason and web-fetch's SSRF guard would be wide open.
    for (const ip of ['10.0.0.5', '192.168.1.10', '172.16.0.1', '169.254.169.254', '127.0.0.1']) {
      assert.equal(netAddress.isPrivateAddress(ip), true, ip + ' is private');
    }
    assert.equal(netAddress.isPrivateAddress('8.8.8.8'), false);
  });
});

describe('net-address: web-fetch still refuses what it always refused', () => {
  // web-fetch.js keeps its own exports as aliases, so its existing suite is
  // untouched. This asserts the aliases actually reach the shared module rather
  // than a surviving local copy.
  it('_isPrivateIp is the shared classifier', () => {
    assert.equal(webFetch._isPrivateIp, netAddress.isPrivateAddress,
      'web-fetch must delegate, not keep a second implementation');
  });

  it('_isBlockedHostname is the shared classifier', () => {
    assert.equal(webFetch._isBlockedHostname, netAddress.isBlockedHostname);
  });

  it('the recorded IPv4-mapped-IPv6 bypass stays closed', () => {
    // VERIFIED BYPASS, 2026-08-19. Re-asserted here because the extraction
    // moved the code that closes it.
    assert.equal(webFetch._isPrivateIp('::ffff:127.0.0.1'), true);
    assert.equal(webFetch._isPrivateIp('0:0:0:0:0:ffff:7f00:1'), true);
  });
});

describe('the classifier exists in exactly one place', () => {
  // The class assertion. Source-scanning, because the failure being guarded
  // against is a SECOND definition appearing somewhere — which no behavioural
  // test can see, since both copies would agree on the day they were written.
  const REPO = path.join(__dirname, '..');
  const CALLERS = [
    'src/core/effectors/web-fetch.js',
    'src/core/effectors/web-search.js',
  ];

  function strippedCode(rel) {
    return fs.readFileSync(path.join(REPO, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/\r?\n/)
      // Whole-line comments only. A regex that strips trailing `//` comments
      // deletes the rest of any line containing a URL, because `https://`
      // matches — that mistake has now been made twice in this repo.
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n');
  }

  it('no caller re-implements the address ranges', () => {
    for (const rel of CALLERS) {
      const code = strippedCode(rel);
      assert.ok(!/parts\[0\]\s*===\s*127/.test(code),
        rel + ' re-implements the loopback range; require net-address.js instead');
      assert.ok(!/LOOPBACK_HOSTS\s*=\s*\[/.test(code),
        rel + ' declares its own loopback list; require net-address.js instead');
    }
  });

  it('both callers actually require the shared module (negative control)', () => {
    // Without this, the assertion above passes vacuously the day a caller stops
    // doing address checks at all — which would be a much worse bug than the
    // duplication it is guarding against.
    for (const rel of CALLERS) {
      assert.match(strippedCode(rel), /require\(['"]\.\/net-address['"]\)/,
        rel + ' must reach the shared classifier');
    }
  });
});
