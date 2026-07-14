'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns');
const { guardUrl, isBlockedIp, isBlockedV4, isBlockedV6 } = require('../src/core/util/ssrf-guard');

// Swap dns.promises.lookup for the duration of a callback. ssrf-guard reads
// dns.promises.lookup at call time off the shared module object, so this works.
async function withDnsLookup(fn, body) {
  const orig = dns.promises.lookup;
  dns.promises.lookup = fn;
  try { return await body(); }
  finally { dns.promises.lookup = orig; }
}

test('isBlockedV4 covers every private/loopback/link-local range', () => {
  ['0.0.0.0', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1'].forEach((ip) => {
    assert.equal(isBlockedV4(ip), true, ip + ' must be blocked');
  });
  ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34'].forEach((ip) => {
    assert.equal(isBlockedV4(ip), false, ip + ' must be allowed');
  });
});

test('isBlockedV6 covers loopback, ULA, link-local, and IPv4-mapped', () => {
  ['::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1'].forEach((ip) => {
    assert.equal(isBlockedV6(ip), true, ip + ' must be blocked');
  });
  assert.equal(isBlockedV6('2606:4700:4700::1111'), false, 'public v6 allowed');
  assert.equal(isBlockedV6('::ffff:8.8.8.8'), false, 'mapped public v4 allowed');
});

test('isBlockedIp treats non-IP input as blocked (fail-closed)', () => {
  assert.equal(isBlockedIp('not-an-ip'), true);
  assert.equal(isBlockedIp('8.8.8.8'), false);
});

test('literal loopback/private IPv4 is blocked without DNS', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.0.1', '169.254.169.254', '0.0.0.0']) {
    const r = await guardUrl('http://' + ip + '/');
    assert.equal(r.ok, false, ip + ' blocked');
  }
});

test('Node URL-normalized decimal/hex/octal/short IPv4 are blocked', async () => {
  const forms = ['http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/'];
  for (const url of forms) {
    const r = await guardUrl(url);
    assert.equal(r.ok, false, url + ' normalizes to loopback and must be blocked');
  }
});

test('IPv6 loopback/ULA literals are blocked', async () => {
  for (const url of ['http://[::1]/', 'http://[fc00::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/']) {
    const r = await guardUrl(url);
    assert.equal(r.ok, false, url + ' blocked');
  }
});

test('non-http(s) schemes are blocked', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'gopher://x/', 'data:text/html,x']) {
    const r = await guardUrl(url);
    assert.equal(r.ok, false, url + ' blocked');
    assert.match(r.reason, /scheme/);
  }
});

test('localhost hostname is blocked before any DNS lookup', async () => {
  const r = await guardUrl('http://localhost:8080/');
  assert.equal(r.ok, false);
  assert.match(r.reason, /localhost/);
});

test('userinfo trick: http://127.0.0.1:80@evil.com has hostname evil.com (public → ok)', async () => {
  await withDnsLookup(async () => [{ address: '93.184.216.34', family: 4 }], async () => {
    const r = await guardUrl('http://127.0.0.1:80@evil.com/');
    assert.equal(r.ok, true, 'host is evil.com, which resolves public');
    assert.equal(r.url.hostname, 'evil.com');
  });
});

test('userinfo trick reversed: http://evil.com@127.0.0.1 is blocked (host is loopback literal)', async () => {
  const r = await guardUrl('http://evil.com@127.0.0.1/');
  assert.equal(r.ok, false);
});

test('a hostname that resolves to a private address is blocked', async () => {
  await withDnsLookup(async () => [{ address: '10.0.0.5', family: 4 }], async () => {
    const r = await guardUrl('http://internal.example.com/');
    assert.equal(r.ok, false);
    assert.match(r.reason, /blocked address/);
  });
});

test('a public hostname is allowed', async () => {
  await withDnsLookup(async () => [{ address: '93.184.216.34', family: 4 }], async () => {
    const r = await guardUrl('https://example.com/page');
    assert.equal(r.ok, true);
    assert.equal(r.url.hostname, 'example.com');
  });
});

test('DNS lookup throwing fails closed (blocked)', async () => {
  await withDnsLookup(async () => { throw new Error('ENOTFOUND'); }, async () => {
    const r = await guardUrl('http://does-not-resolve.example/');
    assert.equal(r.ok, false);
    assert.match(r.reason, /DNS/);
  });
});

test('DNS returning any blocked address among several blocks the whole host', async () => {
  await withDnsLookup(async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }], async () => {
    const r = await guardUrl('http://rebind.example/');
    assert.equal(r.ok, false);
  });
});
