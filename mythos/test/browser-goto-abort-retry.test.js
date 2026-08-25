'use strict';

// BUG-339 (2026-08-24): browser_navigate performed a single page.goto with no
// retry. Redirect-heavy sites abort the commit-phase request once — measured
// in vault/Audit/2026-08-09.jsonl L52-L64: four news.google.com calls in 26s,
// `page.goto: net::ERR_ABORTED … waiting until "commit"`, and a manual retry
// ~25s later succeeded. The model shouldn't have to be the retry logic.
//
// Fix under test: exactly ONE retry after 750ms, only for ERR_ABORTED; every
// other error propagates immediately (a real navigation failure must not be
// stretched into two attempts), and a second consecutive ERR_ABORTED throws.

const test = require('node:test');
const assert = require('node:assert');

const { gotoWithRedirectRetry } = require('../src/core/effectors/browser-goto-retry.js');

const _gotoWithRedirectRetry = gotoWithRedirectRetry; // same seam, real home

function fakePage(script) {
  let call = 0;
  const delays = [];
  return {
    calls: 0,
    urls: [],
    goto(url) {
      this.calls += 1;
      this.urls.push(url);
      const action = script[Math.min(call, script.length - 1)];
      call += 1;
      if (action instanceof Error) {
        const t0 = Date.now();
        return new Promise((_, reject) => setTimeout(() => reject(action), 5));
      }
      return Promise.resolve();
    },
    get delays() { return delays; },
  };
}

const ABORT = () => new Error('page.goto: net::ERR_ABORTED');
const OTHER = () => new Error('net::ERR_NAME_NOT_RESOLVED');

test('an ERR_ABORTED commit-phase failure is retried exactly once after ~750ms', async () => {
  const page = fakePage([ABORT(), null]);
  const t0 = Date.now();
  await _gotoWithRedirectRetry(page, 'https://news.google.com');
  assert.strictEqual(page.calls, 2, `expected one retry, got ${page.calls} attempts`);
  assert.ok(Date.now() - t0 >= 700, `retry fired too early (${Date.now() - t0}ms) — the site needs the settle`);
});

test('any other error fails immediately with a single attempt', async () => {
  const page = fakePage([OTHER(), OTHER()]);
  await assert.rejects(_gotoWithRedirectRetry(page, 'https://nope.example'), /NAME_NOT_RESOLVED/);
  assert.strictEqual(page.calls, 1, 'non-abort errors must not be retried');
});

test('two consecutive ERR_ABORTED still throw — one retry is the whole budget', async () => {
  const page = fakePage([ABORT(), ABORT()]);
  await assert.rejects(_gotoWithRedirectRetry(page, 'https://still-broken.example'), /ERR_ABORTED/);
  assert.strictEqual(page.calls, 2);
});
