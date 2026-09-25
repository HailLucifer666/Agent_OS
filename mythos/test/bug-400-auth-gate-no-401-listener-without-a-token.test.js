'use strict';

// BUG-400 — the token prompt reopened itself on a deployment that has no token,
// and masked the PIN screen that was the actual credential surface.
//
// MEASURED ON THE PACKAGED BUILD, 2026-09-03. The operator could not get into
// the HUD by any input at all:
//
//   GET  /health            -> 200 {"authRequired":false}    (no token configured)
//   GET  /api/pin/status    -> 200 {"configured":true}       (a PIN IS configured)
//   GET  /api/health        -> 401 "...set MYTHOS_AUTH_TOKEN..."  (PIN session missing)
//   POST /api/auth/session  -> 404 "No MYTHOS_AUTH_TOKEN is configured..."
//
// So the one overlay on screen asked for a secret this deployment does not
// have, and its own exchange endpoint answered 404. Typing the correct former
// token produced the 404 text; typing anything else produced the same. The PIN
// lock screen never got its turn.
//
// WHY ONLY THE .exe. The packaged app resolves its vault to userData, which
// carries Identity/pin.json; the repo vault has none. So pinSessionRequired()
// is true only in the packaged build, and `npm start` cannot reproduce this.
//
// THREE DEFECTS, ONE SYMPTOM (FIX-PROTOCOL stage 1 #4):
//
//   1. auth-gate.js subscribed to onUnauthorized ABOVE its probe, and the
//      not-required branch returned out of the async IIFE only, so the
//      subscription outlived the decision that said to do nothing. The file's
//      own comment on that branch read "do nothing at all, ever."
//   2. status-banner.js reads the same store and offered "Enter token" for the
//      same 401s — a second door to the same unsatisfiable prompt. Found by
//      GATES.md gate B: the reason covers every subscriber, not the one in the
//      ticket. Fixed at the STORE (auth-state.js): once /health has said no
//      token is configured, markUnauthorized() cannot raise the flag at all,
//      so no present or future subscriber can misread it.
//   3. server/index.js's requireToken() collapsed three deployments into two
//      sentences; PIN-only got "set MYTHOS_AUTH_TOKEN", naming a secret the
//      server does not hold. Class 6 — the error hid its own cause. (Moot
//      since 2026-09-23: the PIN was removed, one sentence is left.)
//
// The DECISION layer (deriveAuthGate) was right all along; the last describe
// block pins that as the adjacent behaviour that must keep passing.
//
// No jsdom in this repo and ui/public is a no-build ES-module tree, so the
// gate's wiring half is a source-shape assertion — same convention as
// bug-290-goals-panel-live-refresh.test.js, written as an ORDER comparison
// between two anchors rather than a line match because this repo has already
// had source-shape guards broken by an added comment. The store and the server
// are pure/real and are tested behaviourally.
//
// Run: cd mythos && node --test test/bug-400-auth-gate-no-401-listener-without-a-token.test.js

const { describe, it, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AUTH_DIR = path.join(__dirname, '..', 'ui', 'public', 'js', 'auth');
const GATE = path.join(AUTH_DIR, 'auth-gate.js');
const src = fs.readFileSync(GATE, 'utf8');

// Deliberately the long form: the bare words "not-required" also appear in
// prose in this file, and an anchor that matches a comment is not an anchor.
const NOT_REQUIRED = "early.reason === 'not-required'";
const SUBSCRIBE = 'onUnauthorized(() =>';

const occurrences = (needle) => src.split(needle).length - 1;

// ES modules are singletons per URL; a query string gives each test its own
// fresh store so state cannot leak between cases.
let importSeq = 0;
function freshModule(name) {
  const p = path.join(AUTH_DIR, name).replace(/\\/g, '/');
  importSeq += 1;
  return import('file:///' + p.replace(/^\/+/, '') + '?bug400=' + importSeq);
}

describe('BUG-400 defect 1 — the gate subscribes only after it knows a token exists', () => {
  it('subscribes to onUnauthorized only AFTER the not-required branch has returned', () => {
    assert.equal(occurrences(NOT_REQUIRED), 1, 'the early-return anchor moved; re-read the file');
    assert.equal(occurrences(SUBSCRIBE), 1, 'more than one subscription site — which one runs?');
    const notRequiredAt = src.indexOf(NOT_REQUIRED);
    const subscribeAt = src.indexOf(SUBSCRIBE);
    assert.ok(
      subscribeAt > notRequiredAt,
      'auth-gate.js subscribes to onUnauthorized BEFORE it knows whether a token is '
      + 'configured. On an authRequired:false deployment every /api/ 401 then reopens a '
      + 'prompt whose exchange endpoint answers 404, and it masks the PIN lock screen. '
      + 'not-required at ' + notRequiredAt + ', subscribe at ' + subscribeAt,
    );
  });

  it('BOUND: the subscription still exists, so an expiring cookie can still reopen the gate', () => {
    // Without this, deleting the listener outright would satisfy the assertion
    // above while silently removing the behaviour it is ordered around: a token
    // deployment whose cookie expires mid-session must get the prompt back.
    assert.equal(occurrences(SUBSCRIBE), 1,
      'the reopen-on-401 subscription is gone entirely — a token deployment whose cookie '
      + 'expires mid-session would now sit on a dead dashboard with no way to re-authenticate');
    assert.match(src, /let offUnauthorized = null;/,
      'the holder is gone; cleanup() closes over the subscription and needs it');
  });

  it('cleanup() tolerates a subscription that was never made', () => {
    assert.doesNotMatch(src, /;\s*offUnauthorized\(\);/,
      'cleanup() calls the holder unguarded; on a not-required deployment it is null');
    assert.match(src, /if \(offUnauthorized\) offUnauthorized\(\);/,
      'cleanup() must null-check the holder');
  });

  it('the gate tells the store what it learned, in both directions', () => {
    // The store fix (defect 2) is inert unless the probe feeds it.
    assert.match(src, /setTokenRequired\(false\);/, 'not-required must be reported to the store');
    assert.match(src, /setTokenRequired\(true\);/, 'a configured token must be reported too');
  });
});

describe('BUG-400 defect 2 — the store cannot raise a token flag on a token-less deployment', () => {
  it('after setTokenRequired(false), markUnauthorized() is a no-op and notifies nobody', async () => {
    const st = await freshModule('auth-state.js');
    let notified = 0;
    st.onUnauthorized(() => { notified += 1; });
    st.setTokenRequired(false);
    st.markUnauthorized();
    st.markUnauthorized();
    assert.equal(st.isUnauthorized(), false,
      'a 401 on a deployment with no token is a PIN 401, not a token one — the flag must stay down');
    assert.equal(notified, 0,
      'a subscriber was told "unauthorized" and will offer a token prompt that answers 404');
  });

  it('a 401 that raced the probe is cleared when the probe says no token', async () => {
    // First paint fires ~20 /api/ fetches before /health answers. On the
    // packaged build every one of them 401s. Without this, the banner keeps
    // "Enter token" alive after the gate has correctly decided not to prompt.
    const st = await freshModule('auth-state.js');
    st.markUnauthorized();
    assert.equal(st.isUnauthorized(), true, 'precondition: the race really set the flag');
    st.setTokenRequired(false);
    assert.equal(st.isUnauthorized(), false, 'the stale token flag must be cleared');
  });

  it('BOUND: with a token configured, a 401 still raises the flag and notifies (unchanged behaviour)', async () => {
    const st = await freshModule('auth-state.js');
    let notified = 0;
    st.onUnauthorized(() => { notified += 1; });
    st.setTokenRequired(true);
    st.markUnauthorized();
    assert.equal(st.isUnauthorized(), true);
    assert.equal(notified, 1, 'an expiring cookie on a real token deployment must still reopen the gate');
  });

  it('BOUND: before the probe has answered, a 401 behaves exactly as it did before this fix', async () => {
    // null = unknown. Failing closed here (treat as token) is the pre-existing
    // behaviour and the safe one: the worst case is a prompt that clears when
    // the probe lands, never a dead dashboard with no prompt.
    const st = await freshModule('auth-state.js');
    let notified = 0;
    st.onUnauthorized(() => { notified += 1; });
    assert.equal(st.isTokenRequired(), null);
    st.markUnauthorized();
    assert.equal(st.isUnauthorized(), true);
    assert.equal(notified, 1);
  });
});

// Defect 3's server cases were deleted on 2026-09-23 with the PIN: they pinned
// the PIN-only and combined 401 sentences, and there is now exactly one
// (credentials.UNAUTHORIZED_HINT), asserted against a real 401 in
// test/pin-removal-access.test.js. Probe (e) below went with them.

describe('BUG-400 — the decision layer was already right (adjacent, must keep passing)', () => {
  it('authRequired:false wins even when a 401 is also in the probe', async () => {
    // This is the case the wiring ignored. If it ever fails, the bug has moved
    // from the shell into the pure function and this whole file is aimed wrong.
    const { deriveAuthGate } = await freshModule('auth-gate-state.js');
    const gate = deriveAuthGate({
      health: { ok: true, status: 200, body: { ok: true, uptime: 1, authRequired: false } },
      status: { ok: false, status: 401 },
    });
    assert.deepEqual(gate, { show: false, reason: 'not-required' });
  });

  it('a token IS still demanded when the server says it needs one', async () => {
    const { deriveAuthGate } = await freshModule('auth-gate-state.js');
    const gate = deriveAuthGate({
      health: { ok: true, status: 200, body: { ok: true, uptime: 1, authRequired: true } },
      status: { ok: false, status: 401 },
    });
    assert.deepEqual(gate, { show: true, reason: 'unauthenticated' });
  });

  it('the 404 this deployment actually returns is reported as nothing-to-enter', async () => {
    // Why the prompt must not open rather than merely be tolerated: there is
    // provably nothing the operator could type that would satisfy it.
    const { interpretExchangeResponse } = await freshModule('auth-gate-state.js');
    const res = interpretExchangeResponse({
      status: 404,
      body: { error: 'No MYTHOS_AUTH_TOKEN is configured for this deployment.' },
    });
    assert.equal(res.authenticated, false);
    assert.match(res.message, /No MYTHOS_AUTH_TOKEN is configured/);
  });
});

// MUTATION PROOF, run 2026-09-03. Every mutation verified applied by
// re-reading the mutated text before trusting its red; every file restored by
// full-path copy and the restore verified by this file going green again.
//
//   (a) Restore the ORIGINAL auth-gate.js (eager subscription above the probe,
//       no holder, bare offUnauthorized() in cleanup) -> reds ALL THREE wiring
//       cases in defect 1 and leaves the decision-layer cases green. This is
//       the shipped bug, reproduced. (Earlier draft of this note claimed two
//       reds; the original has no holder either, so it is three.)
//   (b) DELETE the subscription line entirely -> reds the BOUND case ("gone
//       entirely"), NOT the ordering case, which would otherwise pass
//       vacuously on a file that no longer reopens the gate for anyone.
//   (c) Change `if (offUnauthorized) offUnauthorized();` back to the bare
//       call -> reds only "cleanup() tolerates a subscription that was never
//       made".
//   (d) In auth-state.js delete `if (tokenRequired === false) return;` from
//       markUnauthorized() -> reds "markUnauthorized() is a no-op and notifies
//       nobody" and "a 401 that raced the probe is cleared" stays GREEN (the
//       clear is a separate line) — proving the two store cases watch
//       different statements.
//   (e) [retired 2026-09-23 with the PIN-only server case it probed]
//
// Probe (b) is the one that matters for defect 1: without the BOUND case the
// ordering assertion is satisfied by deleting the feature.
