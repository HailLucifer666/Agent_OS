'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWebFetch } = require('../src/core/effectors/web-fetch');

// Public IP literal so guardUrl passes without any DNS lookup.
const PUB = 'http://93.184.216.34/';

function resp({ status = 200, type = 'text/html', location, body = '' }) {
  const headers = { 'content-type': type };
  if (location) headers['location'] = location;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] },
    arrayBuffer: async () => {
      const buf = Buffer.from(body, 'utf8');
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  };
}

function mockFetch(fn) {
  const orig = global.fetch;
  global.fetch = fn;
  return () => { global.fetch = orig; };
}

test('rejects a disallowed content-type', async () => {
  const restore = mockFetch(async () => resp({ type: 'image/png', body: 'binary' }));
  try {
    const svc = createWebFetch({ config: {} });
    const r = await svc.webFetch({ url: PUB });
    assert.equal(r.ok, false);
    assert.match(r.result, /content type/i);
  } finally { restore(); }
});

test('extracts title + text from HTML', async () => {
  const html = '<html><head><title>My Page</title></head><body><h1>Hi</h1><p>Hello world.</p><script>evil()</script></body></html>';
  const restore = mockFetch(async () => resp({ type: 'text/html', body: html }));
  try {
    const svc = createWebFetch({ config: {} });
    const r = await svc.webFetch({ url: PUB });
    assert.equal(r.ok, true);
    assert.equal(r.result.title, 'My Page');
    assert.ok(r.result.text.includes('Hello world.'));
    assert.ok(!r.result.text.includes('evil()'));
  } finally { restore(); }
});

test('pretty-prints JSON', async () => {
  const restore = mockFetch(async () => resp({ type: 'application/json', body: '{"a":1,"b":[2,3]}' }));
  try {
    const svc = createWebFetch({ config: {} });
    const r = await svc.webFetch({ url: PUB });
    assert.equal(r.ok, true);
    assert.ok(r.result.text.includes('\n'), 'JSON is indented across lines');
    assert.ok(r.result.text.includes('"a": 1'));
  } finally { restore(); }
});

test('caps body size and flags truncated', async () => {
  const big = 'x'.repeat(5000);
  const restore = mockFetch(async () => resp({ type: 'text/plain', body: big }));
  try {
    const svc = createWebFetch({ config: { WEB_FETCH_MAX_BYTES: 1000 } });
    const r = await svc.webFetch({ url: PUB });
    assert.equal(r.ok, true);
    assert.equal(r.result.truncated, true);
    assert.ok(r.result.text.length <= 1000);
  } finally { restore(); }
});

test('timeout → honest ok:false', async () => {
  const restore = mockFetch(async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; });
  try {
    const svc = createWebFetch({ config: {} });
    const r = await svc.webFetch({ url: PUB });
    assert.equal(r.ok, false);
    assert.match(r.result, /timed out/i);
  } finally { restore(); }
});

test('redirect to a private IP is blocked on the second hop', async () => {
  let hop = 0;
  const restore = mockFetch(async () => {
    hop += 1;
    if (hop === 1) return resp({ status: 302, location: 'http://169.254.169.254/latest/meta-data/' });
    return resp({ type: 'text/html', body: '<html><body>secrets</body></html>' });
  });
  try {
    const svc = createWebFetch({ config: {} });
    const r = await svc.webFetch({ url: PUB });
    assert.equal(r.ok, false);
    assert.match(r.result, /Blocked for safety/);
  } finally { restore(); }
});

test('too many redirects → ok:false', async () => {
  const restore = mockFetch(async () => resp({ status: 302, location: PUB }));
  try {
    const svc = createWebFetch({ config: {} });
    const r = await svc.webFetch({ url: PUB });
    assert.equal(r.ok, false);
    assert.match(r.result, /redirect/i);
  } finally { restore(); }
});

test('missing URL → ok:false', async () => {
  const svc = createWebFetch({ config: {} });
  const r = await svc.webFetch({});
  assert.equal(r.ok, false);
});
