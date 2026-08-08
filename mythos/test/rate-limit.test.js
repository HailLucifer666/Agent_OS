'use strict';

// H12 — rate-limit.js's bucket Map grew one permanent entry per distinct
// client IP on an always-on process, reachable by anyone who could send
// requests (no auth needed to hit a rate-limited route and add an entry).
// Fixed by evicting expired buckets opportunistically on access — no timer,
// so this can never keep the process alive on its own.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter } = require('../server/rate-limit');

function fakeRes() {
  return {
    setHeader() {},
    status() { return this; },
    json() { return this; },
  };
}

describe('rate-limit — bucket eviction (H12)', () => {
  it('evicts buckets whose window has fully expired on the next access, instead of growing the Map forever', async () => {
    const windowMs = 20;
    const limiter = createLimiter({ windowMs, max: 100, scope: 'h12' });
    const next = () => {};

    for (let i = 0; i < 25; i++) {
      limiter({ ip: `10.0.0.${i}`, socket: {} }, fakeRes(), next);
    }
    assert.equal(limiter._internal.buckets.size, 25, 'sanity: one bucket per distinct IP');

    // Let every existing bucket's window fully expire.
    await new Promise((resolve) => setTimeout(resolve, windowMs * 3));

    // Any single new request is enough to trigger the opportunistic sweep.
    limiter({ ip: '10.0.0.999', socket: {} }, fakeRes(), next);

    assert.equal(
      limiter._internal.buckets.size,
      1,
      'every bucket past its own reset window must be evicted on the next access, leaving only the fresh one'
    );
  });

  it('does not evict a bucket that is still inside its own window', () => {
    const limiter = createLimiter({ windowMs: 60000, max: 100, scope: 'h12b' });
    const next = () => {};
    limiter({ ip: '10.0.0.1', socket: {} }, fakeRes(), next);
    limiter({ ip: '10.0.0.2', socket: {} }, fakeRes(), next);
    assert.equal(limiter._internal.buckets.size, 2, 'live, unexpired buckets must survive a sweep');
  });
});
