'use strict';

// test/rate-limit-prune.test.js — F6 (go-live proof plan).
//
// rate-limit.js's bucket Map used to grow UNBOUNDED: a key was only ever
// overwritten when the SAME key recurred, so every distinct IP added a
// permanent entry. Irrelevant for a single-user desktop; on a public deploy
// (Render) the health-check host plus crawlers add distinct IPs forever.
// This test proves expired buckets actually go away, so the map stays
// bounded over mixed in-window/expired traffic.
//
// RED-FIRST: run against the pre-fix limiter (no sweep), the bound assertion
// below FAILED with all ten keys from both windows retained. The 429 guard is
// green on both sides — it pins that pruning never changes in-window
// behavior.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter } = require('../server/rate-limit');

function fakeReq(ip) {
  return { ip, socket: { remoteAddress: ip } };
}

function fakeRes() {
  return { setHeader() {}, status() { return this; }, json() {} };
}

function pass(ip, limiter) {
  let called = false;
  limiter(fakeReq(ip), fakeRes(), () => { called = true; });
  return called;
}

describe('F6 · rate-limit buckets are pruned, so the map stays bounded', () => {
  test('expired buckets are swept on traffic at a bounded cadence (map size <= one window of live keys + slack)', async () => {
    const limiter = createLimiter({ windowMs: 50, max: 1000, scope: 'prune-test' });
    const ipsA = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5'];

    // Window 1: five distinct IPs — bucket count is 5.
    for (const ip of ipsA) assert.equal(pass(ip, limiter), true);

    // Wait past the window so those five expire.
    await new Promise((r) => setTimeout(r, 80));

    // Window 2: five MORE distinct IPs.
    const ipsB = ['10.0.1.1', '10.0.1.2', '10.0.1.3', '10.0.1.4', '10.0.1.5'];
    for (const ip of ipsB) assert.equal(pass(ip, limiter), true);

    // The five expired entries from window 1 must be gone. Worst case after a
    // sweep boundary, the map holds one window's worth of live keys plus the
    // five added before the next cadence — never N + N. The pre-fix code
    // retains all ten and this fails.
    const size = limiter._bucketCount();
    assert.ok(size <= 6, `expected <= 6 buckets (5 live + boundary slack), got ${size}`);
  });

  test('in-window throttling is unchanged: the over-limit request still gets a 429 with Retry-After', async () => {
    const limiter = createLimiter({ windowMs: 60000, max: 3, scope: 'prune-test-429' });
    const res = fakeRes();
    let retryAfter = null;
    let statusCode = 200;
    res.setHeader = (name, value) => { if (name === 'Retry-After') retryAfter = value; };
    res.status = (code) => { statusCode = code; return res; };

    for (let i = 0; i < 3; i++) assert.equal(pass('10.9.9.9', limiter), true);
    limiter(fakeReq('10.9.9.9'), res, () => {});
    assert.equal(statusCode, 429);
    assert.ok(retryAfter !== null, 'the 429 must carry a Retry-After header');
  });
});
