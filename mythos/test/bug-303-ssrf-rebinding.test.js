'use strict';

// test/bug-303-ssrf-rebinding.test.js — BUG-303.
//
// THE BUG, in one sentence: the guard looked up the address, approved it, and
// then handed the HOSTNAME to the fetch call, which looked it up a second time
// and connected to whatever came back.
//
// A name whose owner answers the first query with a public address and the
// second with 127.0.0.1 walks straight through. The comment above the check
// said it "catches DNS rebinding attacks"; it was the rebinding hole itself.
// This is reachable from the model: web_fetch is registered danger:false,
// tier 0, in the voice allowlist, and this machine serves the MYTHOS API on
// 4478.
//
// MEASURED AT HEAD before any fix, with the loopback server and the two-answer
// resolver this file sets up:
//
//   ok      = true
//   leaked  = true
//   payload = {"ok":true,"result":{"url":"http://rebind.example:56171/creds",
//              "status":200,"contentType":"text/plain",
//              "content":"INTERNAL-SECRET-/creds",...,"source":"direct"}}
//
// THE FIX. The check and the connection now share one answer. Node lets a
// request supply its own address-resolution function, which runs at the moment
// of connecting — so `guardedLookup` (net-address.js) resolves, classifies
// every address it got back, and refuses the connection itself rather than
// advising someone else to. There is no second resolution left to poison.
//
// WHAT DID NOT CHANGE. The pre-flight `isInternalUrl` check stays: it is what
// produces a readable refusal, and it catches IP literals, which never reach
// the lookup at all because Node skips resolution for an address it can already
// parse. Two layers, each covering what the other cannot.
//
// EVERYTHING HERE IS OFFLINE. The only server is one this file starts on
// loopback, and both resolvers are stubbed for the duration of each test.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const dns = require('node:dns');

const webFetch = require('../src/core/effectors/web-fetch');
const netAddress = require('../src/core/effectors/net-address');

const { web_fetch, _transport, _guardedRequest } = webFetch;

// --- helpers ---------------------------------------------------------------

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

// A resolver that answers with whatever record list it is given, in either of
// the two shapes Node asks for. Node 26 enables autoSelectFamily by default, so
// the socket asks with { all: true } and gets an ARRAY — a lookup replacement
// that only handles the single-address shape breaks every connection it touches.
function fakeResolver(records) {
  return function (hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const list = records.slice();
    if (options && options.all) return process.nextTick(() => callback(null, list));
    return process.nextTick(() => callback(null, list[0].address, list[0].family));
  };
}

function callLookup(hostname, options) {
  return new Promise((resolve, reject) => {
    netAddress.guardedLookup(hostname, options, (err, a, b) => {
      if (err) return reject(err);
      resolve(Array.isArray(a) ? a : { address: a, family: b });
    });
  });
}

async function withStubbedDns(records, fn) {
  const real = dns.lookup;
  dns.lookup = fakeResolver(records);
  try { return await fn(); } finally { dns.lookup = real; }
}

// ---------------------------------------------------------------------------
// guardedLookup on its own
// ---------------------------------------------------------------------------

test('guardedLookup refuses a name that resolves to a private address', async () => {
  await withStubbedDns([{ address: '127.0.0.1', family: 4 }], async () => {
    await assert.rejects(
      () => callLookup('rebind.example', { all: true }),
      (err) => {
        assert.equal(err.ssrfBlocked, true, 'the refusal must be tagged so callers can tell it apart from a network error');
        assert.match(err.message, /private or internal/);
        assert.match(err.message, /127\.0\.0\.1/, 'the refusal must name the address it refused');
        return true;
      },
    );
  });
});

test('guardedLookup refuses if ANY answer is private, not only the first', async () => {
  // getaddrinfo can return several addresses and the stack may pick any of
  // them. Checking only [0] would leave the choice to chance.
  await withStubbedDns([
    { address: '93.184.216.34', family: 4 },
    { address: '169.254.169.254', family: 4 },
  ], async () => {
    await assert.rejects(() => callLookup('mixed.example', { all: true }), /169\.254\.169\.254/);
  });
});

test('guardedLookup passes a public answer through in both shapes', async () => {
  await withStubbedDns([{ address: '93.184.216.34', family: 4 }], async () => {
    const all = await callLookup('public.example', { all: true });
    assert.deepEqual(all, [{ address: '93.184.216.34', family: 4 }],
      'with all:true the socket expects an array of records');

    const one = await callLookup('public.example', {});
    assert.deepEqual(one, { address: '93.184.216.34', family: 4 },
      'without all the socket expects (address, family) as separate arguments');
  });
});

test('guardedLookup accepts the two-argument form', async () => {
  // dns.lookup(hostname, callback) is legal and some callers use it.
  await withStubbedDns([{ address: '8.8.8.8', family: 4 }], async () => {
    const got = await new Promise((resolve, reject) => {
      netAddress.guardedLookup('public.example', (err, address, family) => {
        if (err) return reject(err);
        resolve({ address, family });
      });
    });
    assert.deepEqual(got, { address: '8.8.8.8', family: 4 });
  });
});

test('guardedLookup passes a resolution failure through unchanged', async () => {
  const real = dns.lookup;
  const boom = Object.assign(new Error('getaddrinfo ENOTFOUND nope.invalid'), { code: 'ENOTFOUND' });
  dns.lookup = (h, o, cb) => process.nextTick(() => (typeof o === 'function' ? o : cb)(boom));
  try {
    await assert.rejects(() => callLookup('nope.invalid', { all: true }), (err) => {
      assert.equal(err.code, 'ENOTFOUND', 'a real DNS failure must stay a DNS failure');
      assert.notEqual(err.ssrfBlocked, true, 'a name that does not resolve was not blocked by us');
      return true;
    });
  } finally {
    dns.lookup = real;
  }
});

// ---------------------------------------------------------------------------
// The bug itself, end to end
// ---------------------------------------------------------------------------

test('web_fetch cannot be rebound: approving one address does not connect to another', async () => {
  const { server, port } = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('INTERNAL-SECRET-' + req.url);
  });

  const realPromises = dns.promises.lookup;
  const realLookup = dns.lookup;
  // First answer — what the pre-flight guard sees. Looks entirely public.
  dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  // Second answer — what the socket would dial. This is the rebind.
  dns.lookup = fakeResolver([{ address: '127.0.0.1', family: 4 }]);

  try {
    const result = await web_fetch({ url: 'http://rebind.example:' + port + '/creds' });
    const body = JSON.stringify(result);
    assert.ok(!body.includes('INTERNAL-SECRET'),
      'the loopback service answered and its body reached the caller: ' + body.slice(0, 300));
    assert.equal(result.ok, false, 'a rebound name must be refused, not fetched');
    assert.match(result.error, /private or internal/i,
      'the refusal must say why, so this is not mistaken for the site being down');
  } finally {
    dns.promises.lookup = realPromises;
    dns.lookup = realLookup;
    await close(server);
  }
});

test('a blocked request is not retried through the Jina fallback', async () => {
  // The tag on the refusal existed before this fix and nothing read it: the
  // catch around the direct fetch swallowed every error identically, so a
  // request refused for targeting an internal address was immediately re-sent
  // through r.jina.ai. Answering a blocked request a second time by a different
  // route is not a fallback.
  const realPromises = dns.promises.lookup;
  const realRequest = _transport.request;
  const calls = [];
  dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  _transport.request = async (url) => {
    calls.push(String(url));
    const err = new Error('blocked: rebind.example resolves to a private or internal address (127.0.0.1)');
    err.ssrfBlocked = true;
    throw err;
  };
  try {
    const result = await web_fetch({ url: 'http://rebind.example/creds' });
    assert.equal(result.ok, false);
    assert.match(result.error, /private or internal/i);
    assert.equal(calls.length, 1,
      'the blocked request was re-sent: ' + JSON.stringify(calls));
    assert.ok(!calls.some((u) => u.includes('r.jina.ai')),
      'the Jina reader was asked to fetch what the guard just refused');
  } finally {
    dns.promises.lookup = realPromises;
    _transport.request = realRequest;
  }
});

// ---------------------------------------------------------------------------
// The replacement transport must behave like the one it replaces
// ---------------------------------------------------------------------------
//
// These drive the raw client against a real loopback server, with the guard's
// resolver swapped for the ordinary one — otherwise the server under test is
// exactly the kind of address the guard exists to refuse. The swap is confined
// to this section, and the test below it pins that production uses the guarded
// resolver, so the seam cannot quietly become the default.

async function withPlainLookup(fn) {
  const real = _transport.lookup;
  _transport.lookup = dns.lookup;
  try { return await fn(); } finally { _transport.lookup = real; }
}

test('the transport returns status, content type and body text', async () => {
  const { server, port } = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body>hello world</body></html>');
  });
  try {
    await withPlainLookup(async () => {
      const res = await _guardedRequest('http://127.0.0.1:' + port + '/page', {
        headers: { 'User-Agent': 'test-agent' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.ok, true);
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(res.headers.get('CONTENT-TYPE'), 'text/html; charset=utf-8',
        'header lookup must be case-insensitive, as it was on the old response object');
      assert.equal(await res.text(), '<html><body>hello world</body></html>');
    });
  } finally {
    await close(server);
  }
});

test('the transport decompresses a gzipped response', async () => {
  // The trap in replacing fetch() with the built-in client: fetch un-gzipped
  // silently, the raw client does not. Every compressed page would have come
  // back as binary rubbish and been handed to the brain as research.
  const payload = 'compressed body, definitely not binary rubbish';
  const { server, port } = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' });
    res.end(zlib.gzipSync(Buffer.from(payload, 'utf8')));
  });
  try {
    await withPlainLookup(async () => {
      const res = await _guardedRequest('http://127.0.0.1:' + port + '/gz', {});
      assert.equal(await res.text(), payload);
    });
  } finally {
    await close(server);
  }
});

test('the transport sends the headers it was given and does not follow redirects itself', async () => {
  // guardedFetch re-checks every hop by hand, which only works if the client
  // hands the 3xx back instead of chasing it.
  let seenUa = null;
  const { server, port } = await listen((req, res) => {
    seenUa = req.headers['user-agent'];
    res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
    res.end();
  });
  try {
    await withPlainLookup(async () => {
      const res = await _guardedRequest('http://127.0.0.1:' + port + '/r', {
        headers: { 'User-Agent': 'test-agent' },
      });
      assert.equal(res.status, 302, 'the redirect must be returned, not followed');
      assert.equal(res.ok, false);
      assert.equal(res.headers.get('location'), 'http://169.254.169.254/latest/meta-data/');
      assert.equal(seenUa, 'test-agent', 'the User-Agent header must reach the server');
    });
  } finally {
    await close(server);
  }
});

test('the transport honours an abort signal', async () => {
  const { server, port } = await listen(() => { /* never answers */ });
  try {
    await withPlainLookup(async () => {
      const controller = new AbortController();
      const pending = _guardedRequest('http://127.0.0.1:' + port + '/hang', { signal: controller.signal });
      setTimeout(() => controller.abort(), 50);
      await assert.rejects(() => pending, /abort/i);
    });
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// The seam cannot become the hole
// ---------------------------------------------------------------------------

test('production wiring uses the guarded resolver and the guarded transport', () => {
  // The two tests above swap _transport.lookup deliberately. This is what stops
  // that swap from being made permanent by accident — a holder that tests write
  // to is only safe while something asserts what it holds by default.
  assert.equal(_transport.lookup, netAddress.guardedLookup,
    'the transport must resolve through guardedLookup; anything else reopens BUG-303');
  assert.equal(_transport.request, _guardedRequest,
    'the transport must be the guarded request helper');
  assert.equal(typeof netAddress.guardedLookup, 'function',
    'guardedLookup must be exported from the one address module, not redefined per caller');
});

test('web-fetch no longer calls the global fetch', () => {
  // A source guard, because the defect was structural: fetch() re-resolves the
  // hostname and there is no way to tell it not to. If a fetch() call comes
  // back into this file the hole comes back with it, and every behavioural test
  // above would still pass for whichever request kept using the guarded client.
  const fs = require('node:fs');
  const path = require('node:path');
  const code = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'effectors', 'web-fetch.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    // Whole-line comments only: stripping trailing // comments would delete the
    // rest of any line containing a URL. That mistake has been made twice here.
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  assert.ok(!/[^.\w]fetch\s*\(/.test(code),
    'web-fetch.js calls fetch() again — that call re-resolves the hostname and is BUG-303');
  assert.match(code, /setTimeout\(REQUEST_TIMEOUT_MS/,
    'the request must carry its own timeout: a host that accepts the connection and then says nothing never settles, and web-fetch is on a path a voice turn blocks on');
  assert.match(code, /lookup/,
    'the request must pass a lookup function or it resolves through the default resolver');
});
