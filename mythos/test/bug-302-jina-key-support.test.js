'use strict';

// BUG-302 — the Jina rung could not present a key, so it was permanently 401.
//
// Measured 2026-08-20 and again on 2026-08-21: every call to this rung returns
// HTTP 401. The rung's own comment already says "NOT key-free any more". What it
// did NOT say is that the rung has no way to present a credential at all — it
// sends `Accept` and `X-Return-Format` and nothing else, and EXA_API_KEY is the
// only key the entire chain reads. So a provider that is one free API key away
// from working was written off as dead.
//
// That matters more than one rung, because as of tonight every keyless engine
// the local daemon supports is refusing too (startpage token extraction, bing
// 301, brave 429, DuckDuckGo's CAPTCHA, baidu hangs up). Reviving a rung that
// takes a free key is cheaper than adopting another scraper that will be blocked
// the same way.
//
// Deliberately minimal: the keyless attempt is NOT removed. It costs one fast
// 401 that the rung already reports honestly, and removing it would bake a
// two-machine measurement into a permanent skip. This adds a capability; it
// takes nothing away.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { _jinaSearch } = require('../src/core/effectors/web-search.js');

const KEY = 'jina_test_key_do_not_use_9f3a';

let calls;
let realFetch;
let savedKey;

function stubFetch(response) {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return response;
  };
}

function textResponse(body, ok = true, status = 200) {
  return { ok, status, text: async () => body };
}

function headerOf(opts, name) {
  const h = (opts && opts.headers) || {};
  // Support both a plain object and a Headers instance.
  if (typeof h.get === 'function') return h.get(name);
  const hit = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return hit ? h[hit] : undefined;
}

beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
  savedKey = process.env.JINA_API_KEY;
  delete process.env.JINA_API_KEY;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedKey === undefined) delete process.env.JINA_API_KEY; else process.env.JINA_API_KEY = savedKey;
});

describe('BUG-302: the Jina rung can present a key', () => {
  it('sends Authorization: Bearer when JINA_API_KEY is set', async () => {
    process.env.JINA_API_KEY = KEY;
    stubFetch(textResponse('https://example.com/a\nExample A\n'));
    await _jinaSearch('anything', 3, null);
    assert.equal(calls.length, 1);
    assert.equal(headerOf(calls[0].opts, 'authorization'), 'Bearer ' + KEY);
  });

  it('sends NO Authorization header when the key is absent', async () => {
    stubFetch(textResponse('https://example.com/a\nExample A\n'));
    await _jinaSearch('anything', 3, null);
    assert.equal(calls.length, 1);
    assert.equal(headerOf(calls[0].opts, 'authorization'), undefined,
      'an absent key must not become the literal string "Bearer undefined"');
  });

  it('still attempts the call with no key — the rung is not skipped', async () => {
    // The keyless path stays. It is one fast 401 that the rung already reports,
    // and removing it would turn a measurement taken on two machines into a
    // permanent refusal to try.
    stubFetch(textResponse('unauthorized', false, 401));
    const out = await _jinaSearch('anything', 3, null);
    assert.equal(calls.length, 1, 'the request must still be attempted');
    assert.deepEqual(out, []);
  });

  it('a 401 is still reported as a provider failure, key or no key', async () => {
    process.env.JINA_API_KEY = KEY;
    const seen = [];
    const bus = { emit: (type, p) => seen.push({ type, p }) };
    stubFetch(textResponse('unauthorized', false, 401));
    await _jinaSearch('anything', 3, bus);
    const anomaly = seen.find((e) => e.p && e.p.kind === 'search-provider-failed' && e.p.provider === 'jina');
    assert.ok(anomaly, 'must still emit the anomaly: ' + JSON.stringify(seen));
    assert.match(String(anomaly.p.error), /401/);
  });

  it('never leaks the key into an anomaly, an error or the query string', async () => {
    // The repo has a secret-leak sentinel for broadcast payloads; this is the
    // same rule one layer down. A credential in a health.anomaly ends up in the
    // vault and in the HUD.
    process.env.JINA_API_KEY = KEY;
    const seen = [];
    const bus = { emit: (type, p) => seen.push({ type, p }) };
    stubFetch(textResponse('nope', false, 500));
    await _jinaSearch('anything', 3, bus);
    assert.equal(calls[0].url.includes(KEY), false, 'key must never travel in the URL');
    assert.equal(JSON.stringify(seen).includes(KEY), false, 'key must never reach the bus');
  });

  it('still parses results the same way once authorised', async () => {
    // Guard: adding a header must not disturb the existing parse.
    process.env.JINA_API_KEY = KEY;
    stubFetch(textResponse([
      'https://example.com/one',
      'First result',
      '',
      'https://example.com/two',
      'Second result',
    ].join('\n')));
    const out = await _jinaSearch('anything', 5, null);
    assert.ok(Array.isArray(out));
    assert.ok(out.length >= 1, 'expected parsed results, got: ' + JSON.stringify(out));
    assert.ok(out.every((r) => typeof r.url === 'string' && r.url.startsWith('http')));
  });
});
