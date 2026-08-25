'use strict';

// test/web-fetch-ssrf.test.js — the SSRF boundary of the shared URL fetcher.
//
// This module owns the only outbound-fetch security decision in the codebase
// and, until 2026-08-19, had no test referencing it at all. Two live bypasses
// were found the moment one was written, both reproduced against a real
// loopback HTTP server before being fixed:
//
//   1. IPv4-mapped IPv6. http://[::ffff:127.0.0.1]:PORT/ and its hex spelling
//      http://[0:0:0:0:0:ffff:7f00:1]/ matched none of the IPv6 prefixes, and
//      net.isIPv4() is false for a bracketed literal, so the address reached
//      fetch() unexamined and returned the body of a loopback service.
//
//   2. Redirects. The guard ran once, against the FIRST url, and then handed
//      the request to undici with redirect:'follow' — so a 302 to a private
//      address was followed and its body returned.
//
// Everything below is offline: DNS and fetch are stubbed where a network would
// otherwise be needed, and the one end-to-end case uses a loopback server this
// test starts itself.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dns = require('node:dns');
const webFetch = require('../src/core/effectors/web-fetch');

const { _isPrivateIp, _isBlockedHostname, _isInternalUrl, _guardedFetch, _embeddedIPv4, web_fetch } = webFetch;

// ---------------------------------------------------------------------------
// isPrivateIp — the ranges, and their edges
// ---------------------------------------------------------------------------

test('isPrivateIp covers every private and special IPv4 range', () => {
  for (const ip of [
    '127.0.0.1', '127.255.255.254',      // loopback
    '10.0.0.1', '10.255.255.255',        // RFC1918 /8
    '172.16.0.1', '172.31.255.255',      // RFC1918 /12
    '192.168.0.1', '192.168.255.255',    // RFC1918 /16
    '169.254.169.254',                   // link-local / cloud metadata
    '0.0.0.0',
  ]) {
    assert.equal(_isPrivateIp(ip), true, ip + ' must be treated as private');
  }
});

test('isPrivateIp does not over-block the addresses either side of 172.16/12', () => {
  // A guard that blocks 172.15 and 172.32 is broken in the other direction —
  // it silently makes real public hosts unreachable.
  for (const ip of ['172.15.255.255', '172.32.0.1', '8.8.8.8', '1.1.1.1', '93.184.216.34']) {
    assert.equal(_isPrivateIp(ip), false, ip + ' is public and must not be blocked');
  }
});

test('isPrivateIp covers the IPv6 ranges', () => {
  for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1']) {
    assert.equal(_isPrivateIp(ip), true, ip + ' must be treated as private');
  }
  assert.equal(_isPrivateIp('2001:4860:4860::8888'), false, 'a public IPv6 must not be blocked');
});

test('isPrivateIp unwraps IPv4-mapped and IPv4-compatible IPv6 — bypass 1', () => {
  assert.equal(_embeddedIPv4('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(_embeddedIPv4('0:0:0:0:0:ffff:7f00:1'), '127.0.0.1', 'the hex spelling is the same address');
  assert.equal(_embeddedIPv4('::7f00:1'), '127.0.0.1', 'IPv4-compatible form, no ffff group');
  assert.equal(_embeddedIPv4('2001:4860:4860::8888'), null, 'a real IPv6 address embeds no IPv4');

  for (const ip of ['::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254']) {
    assert.equal(_isPrivateIp(ip), true, ip + ' resolves to a private IPv4 and must be blocked');
  }
  assert.equal(_isPrivateIp('::ffff:8.8.8.8'), false,
    'a mapped PUBLIC address must still be allowed — the fix must not become a blanket ban');
});

// ---------------------------------------------------------------------------
// isBlockedHostname
// ---------------------------------------------------------------------------

test('isBlockedHostname covers localhost, .local and the metadata endpoints', () => {
  for (const h of ['localhost', 'LOCALHOST', 'local', 'printer.local', '::1', '169.254.169.254', 'metadata.google.internal']) {
    assert.equal(_isBlockedHostname(h), true, h + ' must be blocked');
  }
});

test('isBlockedHostname does not block a public host that merely contains a keyword', () => {
  for (const h of ['localhost.example.com', 'notlocal', 'mylocal.com', 'example.com']) {
    assert.equal(_isBlockedHostname(h), false, h + ' is a public hostname');
  }
});

// ---------------------------------------------------------------------------
// isInternalUrl — literals, DNS, and the fail-closed default
// ---------------------------------------------------------------------------

test('isInternalUrl blocks private IP literals without touching DNS', async () => {
  for (const url of [
    'http://127.0.0.1/', 'http://10.0.0.5/', 'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/', 'http://[::1]/',
    'http://[::ffff:127.0.0.1]/', 'http://[0:0:0:0:0:ffff:7f00:1]/',
  ]) {
    assert.equal(await _isInternalUrl(url), true, url + ' must be blocked');
  }
});

test('isInternalUrl fails closed when DNS cannot answer', async () => {
  // A name that cannot resolve is not evidence that the target is public.
  assert.equal(await _isInternalUrl('http://this-name-does-not-exist.invalid/'), true);
});

test('isInternalUrl blocks a public NAME that resolves to a private address (DNS rebinding)', async () => {
  const real = dns.promises.lookup;
  dns.promises.lookup = async () => [{ address: '10.1.2.3', family: 4 }];
  try {
    assert.equal(await _isInternalUrl('http://rebind.example/'), true,
      'the hostname looks public; only the resolved address gives it away');
  } finally {
    dns.promises.lookup = real;
  }
});

test('isInternalUrl allows a name that resolves publicly', async () => {
  const real = dns.promises.lookup;
  dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  try {
    assert.equal(await _isInternalUrl('http://public.example/'), false);
  } finally {
    dns.promises.lookup = real;
  }
});

// ---------------------------------------------------------------------------
// Redirects — bypass 2
// ---------------------------------------------------------------------------
//
// 2026-08-22, BUG-303: these three used to stub global.fetch. web-fetch.js no
// longer calls it — fetch() re-resolves the hostname at connect time, which was
// the rebinding hole, so the transport is now Node's built-in client with a
// guarded resolver (see bug-303-ssrf-rebinding.test.js). The seam moved to
// _transport.request; what these tests assert about the redirect loop is
// unchanged, because the loop is unchanged.

test('guardedFetch re-checks every redirect hop, not just the first URL', async () => {
  const realLookup = dns.promises.lookup;
  const realRequest = webFetch._transport.request;
  const seen = [];
  // The first hop is a public name; the server then points at a private one.
  dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  webFetch._transport.request = async (url) => {
    seen.push(String(url));
    return {
      status: 302,
      headers: { get: (h) => (h.toLowerCase() === 'location' ? 'http://169.254.169.254/latest/meta-data/' : null) },
    };
  };
  try {
    await assert.rejects(
      () => _guardedFetch('http://public.example/start', {}),
      (err) => {
        assert.equal(err.ssrfBlocked, true, 'the refusal must be tagged so the Jina fallback does not retry it');
        assert.match(err.message, /redirect targets a private or internal network/);
        return true;
      },
      'redirect:"follow" would have fetched the metadata endpoint here',
    );
    assert.equal(seen.length, 1, 'the private hop must never be requested; got ' + JSON.stringify(seen));
  } finally {
    dns.promises.lookup = realLookup;
    webFetch._transport.request = realRequest;
  }
});

test('guardedFetch stops after a bounded number of hops', async () => {
  const realLookup = dns.promises.lookup;
  const realRequest = webFetch._transport.request;
  let hops = 0;
  dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  webFetch._transport.request = async () => {
    hops++;
    return { status: 302, headers: { get: () => 'http://public.example/next' } };
  };
  try {
    await assert.rejects(() => _guardedFetch('http://public.example/start', {}), /too many redirects/);
    assert.ok(hops <= 6, 'a redirect loop must not spin forever; made ' + hops + ' requests');
  } finally {
    dns.promises.lookup = realLookup;
    webFetch._transport.request = realRequest;
  }
});

test('guardedFetch returns a normal response untouched', async () => {
  const realLookup = dns.promises.lookup;
  const realRequest = webFetch._transport.request;
  dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  webFetch._transport.request = async () => ({ status: 200, ok: true, headers: { get: () => null } });
  try {
    const res = await _guardedFetch('http://public.example/page', {});
    assert.equal(res.status, 200, 'the guard must not interfere with an ordinary fetch');
  } finally {
    dns.promises.lookup = realLookup;
    webFetch._transport.request = realRequest;
  }
});

// ---------------------------------------------------------------------------
// End to end, against a real loopback service
// ---------------------------------------------------------------------------

test('web_fetch cannot read a loopback service through a mapped IPv6 literal', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('INTERNAL-SECRET');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    for (const host of ['127.0.0.1', '[::ffff:127.0.0.1]', '[0:0:0:0:0:ffff:7f00:1]']) {
      const result = await web_fetch({ url: `http://${host}:${port}/creds` });
      assert.equal(result.ok, false, host + ' reached the loopback service');
      assert.match(result.error, /private or internal network/);
      assert.ok(!JSON.stringify(result).includes('INTERNAL-SECRET'),
        host + ' leaked the internal response body');
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('web_fetch still refuses a non-http scheme before any of this runs', async () => {
  for (const url of ['file:///C:/Windows/win.ini', 'ftp://example.com/x', 'javascript:alert(1)', '']) {
    const result = await web_fetch({ url });
    assert.equal(result.ok, false, url + ' must be refused');
  }
});

// ---------------------------------------------------------------------------
// The tool the MODEL can call — the copy that actually mattered
// ---------------------------------------------------------------------------

test('the model-callable web_fetch tool is the guarded fetcher, not a twin of it', async () => {
  // Found 2026-08-19 while writing the tests above: from-dashboard.js carried a
  // second, complete copy of this fetcher — same UA, same Jina fallback, same
  // 15s bounds — with no SSRF guard at all, and THAT was the one registered as
  // the `web_fetch` tool (danger:false, tier 0). The guarded implementation was
  // reachable only from the P22 research gate. Reproduced against HEAD before
  // the fix: the tool returned the body of a loopback HTTP server verbatim.
  const { buildTools } = require('../src/core/effectors/from-dashboard');
  const built = buildTools({ config: {}, bus: { emit() {} } });
  const tool = built.TOOLS.find((t) => t.name === 'web_fetch');
  assert.ok(tool, 'the web_fetch tool must still exist');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('INTERNAL-SECRET');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    for (const url of [
      `http://127.0.0.1:${port}/secrets`,
      `http://[::ffff:127.0.0.1]:${port}/secrets`,
      'http://169.254.169.254/latest/meta-data/',
    ]) {
      const result = await tool.fn({ url });
      const body = JSON.stringify(result);
      assert.ok(!body.includes('INTERNAL-SECRET'), url + ' leaked an internal response to the model');
      assert.equal(result.ok, false, url + ' must be refused');
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the guarded fetcher has exactly one implementation', () => {
  // A source guard, because the failure mode here was duplication, not logic:
  // two functions that agreed about everything except the security check.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'effectors', 'from-dashboard.js'), 'utf8');
  assert.match(src, /require\('\.\/web-fetch'\)/,
    'from-dashboard must delegate rather than reimplement');
  assert.doesNotMatch(src, /r\.jina\.ai/,
    'the Jina fallback belongs to web-fetch.js alone — a second copy here is the duplicate coming back');
});

// --- 2026-08-20: the guard failed OPEN on a URL it could not parse -----------
//
// isInternalUrl began `try { parsed = new URL(raw) } catch (_) { return false }`
// — an unparseable URL was reported as NOT internal, which is the permissive
// answer. Measured, not theorised: `new URL('http://[fe80::1%25eth0]/')` throws
// ERR_INVALID_URL, so every IPv6 zone-id form reached that catch and was
// approved by the one function whose entire job is refusing.
//
// HONEST BOUNDING OF THE RISK, both halves. No live exploit path existed: undici
// rejects the same input with the same ERR_INVALID_URL, so the request died one
// layer later and no internal service was reached. What was broken is the
// control, not the outcome — a security guard whose refusal depended on Node's
// URL parser and undici's parser continuing to agree about every malformed
// input, forever, with the permissive branch as the default when they diverge.
// Fixed by failing closed, which costs nothing: a URL neither parser accepts
// cannot be fetched anyway, so nothing legitimate is refused.
//
// WHAT THIS IS NOT. A measurement of 18 exotic address spellings against the
// pre-existing guard — decimal (2130706433), hex (0x7f000001), octal
// (0177.0.0.1), short form (127.1), mixed (0x7f.1), bare 0, 0.0.0.0, IPv4-mapped
// and IPv4-compatible IPv6, [::], trailing dot, uppercase LOCALHOST, and the
// public resolver 127.0.0.1.nip.io — found 17 already blocked. The DNS-resolution
// fallback is what catches them: dns.lookup('2130706433') answers 127.0.0.1, and
// the resolved address is classified. So the address-classification core was NOT
// the defect, and replacing it with an IP-parsing library would not have found
// this one — no such library parses URLs.
//
// KNOWN LIMIT, stated rather than implied: the DNS check and the connect are two
// separate resolutions, so a record whose TTL expires in between can still be
// re-pointed (classic rebinding). That is not fixable here without owning the
// socket, and no library closes it either.

test('an unparseable URL is refused, not approved', async () => {
  // Every one of these throws in new URL(). Before the fix each returned false.
  const unparseable = [
    'http://[fe80::1%25eth0]/',   // IPv6 link-local with a zone id
    'http://[fd00::1%252]/',      // unique-local with a numeric zone
    'http://[::1%251]/',          // loopback with a zone
    'http://[:::1]/',             // malformed literal
  ];
  for (const url of unparseable) {
    assert.throws(() => new URL(url), 'fixture is wrong: ' + url + ' parses fine, so it proves nothing');
    assert.equal(await _isInternalUrl(url), true,
      url + ' could not be parsed and was approved. A guard that cannot read its ' +
      'input must refuse it, not wave it through.');
  }
});

test('a zone-id address is classified as private once it can be read', () => {
  // The classification itself was always right — net.isIPv6 accepts a zoned
  // address and isPrivateIp matches the fe80:/fc/fd prefixes. Pinned so a future
  // "cleanup" of the prefix checks cannot quietly drop the zoned spelling while
  // the fail-closed path above hides the regression.
  for (const ip of ['fe80::1%eth0', 'fe80::1%1', 'fd00::1%2', '::1%1']) {
    assert.equal(_isPrivateIp(ip), true, ip + ' is a private address with a zone id');
  }
});

test('the exotic address spellings stay blocked', async () => {
  // A regression fence around the measurement above. These are the forms the
  // remediation plan expected to be bypasses; they are not, and this test is
  // what makes that true tomorrow as well as today. Offline: every one resolves
  // through the numeric parser rather than a nameserver.
  const numeric = [
    'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/',
    'http://127.1/', 'http://0x7f.1/', 'http://0/', 'http://0.0.0.0/',
    'http://[::1]/', 'http://[::]/', 'http://[::ffff:127.0.0.1]/',
    'http://[0:0:0:0:0:ffff:7f00:1]/', 'http://[::ffff:169.254.169.254]/',
    'http://127.0.0.1./', 'http://LOCALHOST/', 'http://169.254.169.254/',
  ];
  for (const url of numeric) {
    assert.equal(await _isInternalUrl(url), true, url + ' reached the network');
  }
});
