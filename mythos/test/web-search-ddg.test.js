'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ddg = require('../providers/web-search-ddg');

const FIXTURE = `<!doctype html><html><body>
  <div class="result results_links">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1&amp;rut=abc">First &amp; Best Result</a>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1">Snippet one describing the page.</a>
  </div>
  <div class="result results_links">
    <a href="/l/?uddg=https%3A%2F%2Fexample.org%2Fpage2&amp;rut=def" class="result__a">Second Result</a>
    <td class="result__snippet">Snippet two.</td>
  </div>
</body></html>`;

function mockFetch(fn) {
  const orig = global.fetch;
  global.fetch = fn;
  return () => { global.fetch = orig; };
}

test('parses DDG fixture into title/url/snippet triples and unwraps uddg', async () => {
  const restore = mockFetch(async () => ({ ok: true, status: 200, text: async () => FIXTURE }));
  try {
    const r = await ddg.search('anything', { minIntervalMs: 0 });
    assert.equal(r.ok, true);
    assert.equal(r.provider, 'ddg');
    assert.equal(r.results.length, 2);
    assert.equal(r.results[0].title, 'First & Best Result');
    assert.equal(r.results[0].url, 'https://example.com/page1');
    assert.equal(r.results[0].snippet, 'Snippet one describing the page.');
    assert.equal(r.results[1].url, 'https://example.org/page2');
  } finally { restore(); }
});

test('count caps the number of returned results', async () => {
  const restore = mockFetch(async () => ({ ok: true, status: 200, text: async () => FIXTURE }));
  try {
    const r = await ddg.search('q', { count: 1, minIntervalMs: 0 });
    assert.equal(r.results.length, 1);
  } finally { restore(); }
});

test('genuine zero-results page → ok:true, empty results', async () => {
  const html = '<html><body><div class="no-results">No results found for that query.</div></body></html>';
  const restore = mockFetch(async () => ({ ok: true, status: 200, text: async () => html }));
  try {
    const r = await ddg.search('zzznothing', { minIntervalMs: 0 });
    assert.equal(r.ok, true);
    assert.equal(r.results.length, 0);
  } finally { restore(); }
});

test('markup drift (no result__a, no no-results marker) → parse error', async () => {
  const html = '<html><body><div class="results"><div class="renamed_class">stuff</div></div></body></html>';
  const restore = mockFetch(async () => ({ ok: true, status: 200, text: async () => html }));
  try {
    const r = await ddg.search('q', { minIntervalMs: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, 'parse');
  } finally { restore(); }
});

test('blocked/challenge page marker → parse error', async () => {
  const html = '<html><body><div class="anomaly-modal">We detected unusual traffic from your network.</div></body></html>';
  const restore = mockFetch(async () => ({ ok: true, status: 200, text: async () => html }));
  try {
    const r = await ddg.search('q', { minIntervalMs: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, 'parse');
  } finally { restore(); }
});

test('fetch throwing → network error', async () => {
  const restore = mockFetch(async () => { throw new Error('socket hang up'); });
  try {
    const r = await ddg.search('q', { minIntervalMs: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, 'network');
  } finally { restore(); }
});

test('module-level throttle spaces requests by minIntervalMs', async () => {
  const restore = mockFetch(async () => ({ ok: true, status: 200, text: async () => FIXTURE }));
  try {
    await ddg.search('warmup', { minIntervalMs: 0 }); // reset lastRequestAt to now
    const start = Date.now();
    await ddg.search('a', { minIntervalMs: 120 });
    await ddg.search('b', { minIntervalMs: 120 });
    const delta = Date.now() - start;
    assert.ok(delta >= 100, 'second request waited for the throttle window, delta=' + delta);
  } finally { restore(); }
});
