'use strict';

// BUG-400 — the 401 sentence, driven directly.
//
// server/auth-hint.js was extracted from server/index.js's requireToken() on
// 2026-09-03 because index.js is on the file-size ratchet's oversized list and
// that baseline is a ceiling, not a suggestion. The extraction bought something
// beyond the line count: index.js is one large closure over per-server state,
// so almost nothing in it is unit-testable, while this decision depends on
// exactly two booleans and no state at all.
//
// TWO ROUTES, ONE ANSWER. The integration proof lives in
// test/bug-400-auth-gate-no-401-listener-without-a-token.test.js, which boots
// three real servers and reads the sentence off a real 401 response. This file
// drives the pure function. The last case below points BOTH routes at the same
// input and diffs them, so the model and the running system cannot drift — the
// failure mode where a helper is corrected and its caller still passes the
// wrong arguments would otherwise be invisible to both.
//
// Run: cd mythos && node --test test/bug-400-auth-hint.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { unauthorizedHint } = require('../server/auth-hint');

describe('BUG-400 — unauthorizedHint names the credential that is actually missing', () => {
  it('PIN-only: says PIN-locked, names the route, and denies a token exists', () => {
    const h = unauthorizedHint({ hasToken: false, pinRequired: true });
    assert.match(h, /PIN-locked/);
    assert.match(h, /POST \/api\/pin\/verify/, 'name the route that mints the credential');
    assert.match(h, /no token to enter/,
      'the operator went hunting through .env for a token that does not exist; say so');
    assert.doesNotMatch(h, /set MYTHOS_AUTH_TOKEN/,
      'this is the exact sentence that caused the wild goose chase');
  });

  it('token-only: the original sentence, unchanged', () => {
    const h = unauthorizedHint({ hasToken: true, pinRequired: false });
    assert.match(h, /^Unauthorized — set MYTHOS_AUTH_TOKEN via/);
    assert.doesNotMatch(h, /PIN/);
  });

  it('combined: demands both, and pins each to its own channel', () => {
    const h = unauthorizedHint({ hasToken: true, pinRequired: true });
    assert.match(h, /BOTH/);
    // BUG-442 (2026-09-18): the bearer may now also arrive on its own cookie,
    // because the PIN session no longer occupies that name. The header and
    // query channels still matter and are still named — a browser cannot set a
    // header on a WS upgrade — so this widens rather than replaces.
    assert.match(h, /Authorization: Bearer <token>, \?token=, or the mythos_token cookie/,
      'the bearer channels, all three of them');
    // BUG-442 (2026-09-18): the PIN session moved to its own cookie. Naming the
    // old one here would send an operator looking for a credential under a name
    // nothing issues any more — the hint's whole job is to be followable.
    assert.match(h, /mythos_pin cookie from POST \/api\/pin\/verify/, 'the PIN channel');
  });

  it('neither configured: still returns a sentence rather than throwing', () => {
    // Unreachable through requireToken (tokenOk returns true in that state), but
    // a 401 handler must always produce a string. Pinned so nobody "tidies" it
    // into a throw and turns an impossible state into a 500.
    const h = unauthorizedHint({ hasToken: false, pinRequired: false });
    assert.equal(typeof h, 'string');
    assert.ok(h.length > 0);
  });

  it('BOUND: missing, null and undefined arguments do not throw', () => {
    for (const arg of [undefined, null, {}]) {
      assert.equal(typeof unauthorizedHint(arg), 'string');
    }
  });

  it('every branch returns a distinct sentence', () => {
    // Three deployments collapsed into two sentences was the whole defect. If
    // two of these ever coincide, the collapse is back and the tests above
    // would each still pass on their own.
    const seen = new Set([
      unauthorizedHint({ hasToken: false, pinRequired: true }),
      unauthorizedHint({ hasToken: true, pinRequired: false }),
      unauthorizedHint({ hasToken: true, pinRequired: true }),
    ]);
    assert.equal(seen.size, 3, 'two deployments are being told the same thing again');
  });

  it('TWO ROUTES, ONE ANSWER: index.js passes the arguments this module expects', () => {
    // The gap neither route sees alone. A correct helper called with swapped or
    // stale arguments produces a confidently wrong sentence, and every unit test
    // here would still pass. Read the single call site and confirm it maps
    // AUTH_TOKEN -> hasToken and pinSessionRequired() -> pinRequired, in that
    // order. Deliberately narrow: this asserts the WIRING only; the sentences
    // themselves are asserted above and against a live server in the sibling
    // file.
    const idx = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    const calls = idx.match(/unauthorizedHint\(\{[^}]*\}\)/g) || [];
    assert.equal(calls.length, 1, 'expected exactly one call site in index.js');
    assert.match(calls[0], /hasToken:\s*!!AUTH_TOKEN/,
      'hasToken must be MYTHOS_AUTH_TOKEN being CONFIGURED, not a presented credential');
    assert.match(calls[0], /pinRequired:\s*pinSessionRequired\(\)/,
      'pinRequired must be pinSessionRequired() — PIN_SESSION_ENFORCE alone defaults true '
      + 'and gates nothing without a PIN actually configured');
  });
});

// MUTATION PROOF, run 2026-09-03. Restores verified by re-running this file
// green.
//
//   (a) Delete the `if (pinRequired)` branch from auth-hint.js so PIN-only
//       falls through to the generic sentence — the shipped bug -> reds
//       "PIN-only: says PIN-locked…" on all four of its assertions and reds
//       "every branch returns a distinct sentence" (the set collapses to 2).
//   (b) Swap the call site's arguments in index.js to
//       `{ hasToken: pinSessionRequired(), pinRequired: !!AUTH_TOKEN }` -> reds
//       ONLY "TWO ROUTES, ONE ANSWER", and every other case in this file plus
//       every sentence assertion stays green. That is exactly the blind spot
//       that case exists for: the helper is perfect and the caller is wrong.
//   (c) Add a second `unauthorizedHint({...})` call anywhere in index.js ->
//       reds the call-site count, so a future second caller has to be
//       considered rather than silently unasserted.
