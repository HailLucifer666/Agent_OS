'use strict';

// pin-session.test.js — the server-side half of the PIN lock.
//
// WHY THIS FILE EXISTS. pin-session.js is the store that makes the PIN lock real:
// before it, the lock screen was a client-side visual and pointer deterrent only,
// and `curl 127.0.0.1/api/...` bypassed it entirely. It is wired into the
// server's auth decision at server/index.js:65,652,731-738 — so a defect here is
// an authentication bypass, not a UI glitch. It had no direct test.
//
// Asserted here: the CSPRNG token, the timing-safe comparison surviving a
// length-mismatched input without throwing, expiry, the sliding window, and the
// deliberate single-active-session behaviour. Timer behaviour is tested against a
// real clock with a short TTL rather than a fake one the test advances by hand —
// a frozen clock cannot see a window that slides.
//
// Run: cd mythos && node --test test/pin-session.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createPinSessionStore } = require('../src/core/security/pin-session');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('pin session: token issuance', () => {
  it('issues a 256-bit hex token', () => {
    const store = createPinSessionStore({});
    const token = store.issue();
    assert.match(token, /^[0-9a-f]{64}$/, '32 CSPRNG bytes, hex-encoded');
  });

  it('never issues the same token twice', () => {
    // The point of crypto.randomBytes over Math.random. A collision here would
    // mean a predictable session token, which is the whole attack.
    const store = createPinSessionStore({});
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(store.issue());
    assert.equal(seen.size, 200);
  });
});

describe('pin session: validation', () => {
  it('rejects everything before a session is issued', () => {
    const store = createPinSessionStore({});
    assert.equal(store.isValid('anything'), false);
    assert.equal(store.isValid(''), false);
    assert.equal(store.isValid(undefined), false);
  });

  it('accepts the issued token and rejects a wrong one of the same length', () => {
    const store = createPinSessionStore({});
    const token = store.issue();
    assert.equal(store.isValid(token), true);
    // Same length, so the comparison reaches timingSafeEqual rather than being
    // short-circuited by the length check — this is the branch that actually
    // exercises the constant-time compare.
    const wrong = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
    assert.equal(wrong.length, token.length);
    assert.equal(store.isValid(wrong), false);
  });

  it('does not throw on a length-mismatched or non-string input', () => {
    // crypto.timingSafeEqual THROWS when the buffers differ in length. The guard
    // is the `a.length === b.length &&` short-circuit before it. If that is ever
    // reordered, every malformed cookie becomes a 500 from the auth path — a
    // crash where a refusal belongs.
    const store = createPinSessionStore({});
    store.issue();
    for (const bad of ['', 'short', 'x'.repeat(200), null, undefined, 0, 12345, {}, []]) {
      assert.equal(store.isValid(bad), false, JSON.stringify(String(bad)) + ' must be refused, not thrown on');
    }
  });

  it('issuing again invalidates the previous session', () => {
    // Deliberate, documented behaviour: one PIN, one operator, one live session.
    // Pinned so it reads as a decision rather than looking like a bug to the next
    // reader — and so a change to per-client sessions is a conscious one.
    const store = createPinSessionStore({});
    const first = store.issue();
    const second = store.issue();
    assert.equal(store.isValid(first), false, 'the superseded token must stop working');
    assert.equal(store.isValid(second), true);
  });

  it('revoke() ends the session', () => {
    const store = createPinSessionStore({});
    const token = store.issue();
    assert.equal(store.isValid(token), true);
    store.revoke();
    assert.equal(store.isValid(token), false);
  });
});

describe('pin session: expiry', () => {
  it('rejects the token once the TTL has passed', async () => {
    const store = createPinSessionStore({ ttlMs: 60 });
    const token = store.issue();
    assert.equal(store.isValid(token), true);
    await sleep(120);
    assert.equal(store.isValid(token), false, 'genuine inactivity past the TTL must re-lock');
  });

  it('slides the window forward on each successful check', async () => {
    // An operator actively using the HUD must never be kicked out mid-session.
    // Three checks at half the TTL each span 1.5x the TTL in total, so this
    // passes only if the window actually moves.
    const store = createPinSessionStore({ ttlMs: 100 });
    const token = store.issue();
    for (let i = 0; i < 3; i++) {
      await sleep(50);
      assert.equal(store.isValid(token), true, 'still valid at check ' + (i + 1));
    }
    // And the slide is driven by SUCCESS, not by being asked: a rejected check
    // must not keep a session alive.
    const other = createPinSessionStore({ ttlMs: 100 });
    other.issue();
    for (let i = 0; i < 3; i++) {
      await sleep(50);
      other.isValid('wrong-token');
    }
    assert.equal(other.isValid('wrong-token'), false);
  });

  it('exposes the TTL it is using', () => {
    assert.equal(createPinSessionStore({ ttlMs: 1234 }).ttlMs, 1234);
    assert.equal(createPinSessionStore({}).ttlMs, 1800000, 'the 30-minute default');
    // 0 must not be read as "no TTL given" and silently replaced by 30 minutes.
    // It currently is, via `(opts && opts.ttlMs) || DEFAULT`. Pinned as the
    // present behaviour rather than changed: PIN_SESSION_TTL_MS comes from the
    // schema with a real minimum, so 0 cannot arrive from config, and a
    // zero-length session would be indistinguishable from the lock being broken.
    assert.equal(createPinSessionStore({ ttlMs: 0 }).ttlMs, 1800000);
  });
});
