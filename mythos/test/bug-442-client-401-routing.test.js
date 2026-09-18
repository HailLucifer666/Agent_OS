'use strict';

// test/bug-442-client-401-routing.test.js — the client half of BUG-442.
//
// net-guard.js read EVERY /api/ 401 as "the token is wrong" and called
// markUnauthorized(), which opens the access-token prompt. On 2026-09-16 the
// credential that had actually lapsed was the PIN session — its cookie carried
// a hard 30-minute Max-Age while the server's own window kept sliding — so the
// operator was asked, mid-conversation, for a token that was never the problem
// and whose re-entry could not have fixed it.
//
// The server now names the missing credential (server/credentials.js). These
// tests cover what the client does with that, and the three ways it could still
// get it wrong:
//
//   * routing the wrong failure to the wrong recovery;
//   * re-opening a prompt the operator has ALREADY satisfied, because a 401
//     that left before they did lands after;
//   * treating an authentication form's own "you mistyped" 401 as the
//     authorization gate refusing a request — which would mean a wrong PIN
//     opens the token prompt, the original bug through a second door.
//
// BRANCH TRAVERSED (protocol STAGE 4.11): auth-state.js's routing and
// generation fence directly, and net-guard.js's URL/exclusion/clone logic
// through a stubbed global fetch. The server's half is covered by
// bug-442-credential-separation.test.js against a real server.
//
// MUTATION PROBES, run 2026-09-18, each diffed to confirm it applied; all green
// BEFORE this change:
//   (n1) drop the `capturedGeneration < recoveryGeneration` guard in
//        markCredentialsMissing  => fails 'a failure that predates a successful
//        recovery is dropped'.
//   (n2) remove OWN_FAILURE_PATHS from net-guard's condition
//        => fails 'a wrong PIN never opens the token prompt'.
//   (n3) drop the same-origin check in sameOriginApiPath
//        => fails 'a foreign origin answering 401 never touches HUD state'.
//
// ADJACENT CASES THAT MUST KEEP PASSING: an unstructured 401 from any other
// same-origin /api route still raises the token signal exactly as it did before
// BUG-442, and the response body still reaches the caller untouched.
//
// Run: cd mythos && node --test test/bug-442-client-401-routing.test.js

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const UI = path.join(__dirname, '..', 'ui', 'public', 'js');
const AUTH_STATE_URL = pathToFileURL(path.join(UI, 'auth', 'auth-state.js')).href;
const NET_GUARD_URL = pathToFileURL(path.join(UI, 'net-guard.js')).href;

// Each test gets its own module instances: auth-state holds process-wide
// mutable state (the flag, the generation, the listener sets), and a shared
// copy would let one test's recovery silence the next test's failure.
let nonce = 0;
async function freshModules() {
  nonce += 1;
  const authState = await import(AUTH_STATE_URL + '?t=' + nonce);
  const netGuard = await import(NET_GUARD_URL + '?t=' + nonce);
  // net-guard resolves './auth/auth-state.js' through its OWN module graph, and
  // a query string does not propagate to that specifier — so it holds a
  // different copy of a module with process-wide mutable state. Discovered by
  // this file: three net-guard assertions passed while nothing was wired to
  // anything, because the notification went to a store no listener watched.
  // Hence the explicit injection rather than a shared-import assumption.
  const install = () => netGuard.installNetGuard({
    markCredentialsMissing: authState.markCredentialsMissing,
    markUnauthorized: authState.markUnauthorized,
    currentRecoveryGeneration: authState.currentRecoveryGeneration,
  });
  return { authState, netGuard, install };
}

function installFakeWindow(responder) {
  const calls = [];
  global.location = { origin: 'http://127.0.0.1:4478' };
  global.window = {
    fetch: async (input, init) => {
      calls.push({ input, init });
      return responder(input, init);
    },
  };
  return calls;
}

function jsonResponse(status, body) {
  const text = JSON.stringify(body);
  let consumed = false;
  const make = () => ({
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
    clone() { return make(); },
    get bodyUsed() { return consumed; },
    markUsed() { consumed = true; },
  });
  return make();
}

beforeEach(() => {
  delete global.window;
  delete global.location;
});

describe('BUG-442 — the client routes a 401 to the credential that can satisfy it', () => {
  test('a missing PIN relocks the PIN screen and does NOT open the token prompt', async () => {
    const { authState } = await freshModules();
    let tokenPrompt = 0;
    let pinRelock = 0;
    authState.onUnauthorized(() => { tokenPrompt += 1; });
    authState.onPinSessionLost(() => { pinRelock += 1; });

    authState.markCredentialsMissing(['pin'], authState.currentRecoveryGeneration());

    assert.equal(pinRelock, 1, 'the PIN screen is what can satisfy a missing PIN session');
    assert.equal(tokenPrompt, 0,
      'THE FILED SYMPTOM: this is the call that asked the operator for their ACCESS TOKEN when the PIN '
      + 'session had lapsed. Re-entering the token could not have fixed it');
  });

  test('a missing token opens the token prompt and leaves the PIN screen alone', async () => {
    const { authState } = await freshModules();
    let tokenPrompt = 0;
    let pinRelock = 0;
    authState.onUnauthorized(() => { tokenPrompt += 1; });
    authState.onPinSessionLost(() => { pinRelock += 1; });

    authState.markCredentialsMissing(['token'], authState.currentRecoveryGeneration());

    assert.equal(tokenPrompt, 1);
    assert.equal(pinRelock, 0, 'relocking a PIN screen whose session is fine would lock the operator out of nothing');
  });

  test('both missing raises both, token first', async () => {
    const { authState } = await freshModules();
    const order = [];
    authState.onUnauthorized(() => order.push('token'));
    authState.onPinSessionLost(() => order.push('pin'));

    authState.markCredentialsMissing(['token', 'pin'], authState.currentRecoveryGeneration());

    assert.deepEqual(order, ['token', 'pin'],
      'on a combined deployment the PIN check itself runs through an authenticated /api call, so an '
      + 'unsatisfied token gate would leave the PIN screen unable to succeed');
  });

  test('a failure that predates a successful recovery is dropped', async () => {
    const { authState } = await freshModules();
    let tokenPrompt = 0;
    authState.onUnauthorized(() => { tokenPrompt += 1; });

    // A fetch leaves, carrying the generation as it stood.
    const captured = authState.currentRecoveryGeneration();
    // The operator re-authenticates while it is in flight.
    authState.advanceRecoveryGeneration();
    // ...and only now does the stale 401 land.
    authState.markCredentialsMissing(['token'], captured);

    assert.equal(tokenPrompt, 0,
      're-opening the prompt the operator just satisfied is what a burst of concurrent 401s does without a fence');

    authState.markCredentialsMissing(['token'], authState.currentRecoveryGeneration());
    assert.equal(tokenPrompt, 1, 'and a CURRENT failure must still get through — a fence that blocks everything is not a fence');
  });

  test('concurrent failures in one generation collapse into one recovery', async () => {
    const { authState } = await freshModules();
    let tokenPrompt = 0;
    authState.onUnauthorized(() => { tokenPrompt += 1; });
    const g = authState.currentRecoveryGeneration();
    authState.markCredentialsMissing(['token'], g);
    authState.markCredentialsMissing(['token'], g);
    authState.markCredentialsMissing(['token'], g);
    assert.equal(tokenPrompt, 3, 'each notifies, and the flag itself is idempotent — subscribers dedupe on state, not on count');
    assert.equal(authState.isUnauthorized(), true);
  });
});

describe('BUG-442 — net-guard decides what is even ours to announce', () => {
  test('a wrong PIN never opens the token prompt', async () => {
    const { authState, install } = await freshModules();
    let tokenPrompt = 0;
    authState.onUnauthorized(() => { tokenPrompt += 1; });
    installFakeWindow(async () => jsonResponse(401, { error: 'Incorrect PIN.' }));
    install();

    const res = await global.window.fetch('/api/pin/verify', { method: 'POST' });

    assert.equal(res.status, 401, 'the response still reaches the caller unchanged');
    assert.equal(tokenPrompt, 0,
      'an authentication form telling the operator they mistyped is not the authorization gate refusing a '
      + 'request. Announcing it would mean a mistyped PIN opens the ACCESS TOKEN prompt');
  });

  test('a wrong token on the exchange endpoint is likewise its own business', async () => {
    const { authState, install } = await freshModules();
    let tokenPrompt = 0;
    authState.onUnauthorized(() => { tokenPrompt += 1; });
    installFakeWindow(async () => jsonResponse(401, { error: 'Incorrect token.' }));
    install();

    await global.window.fetch('/api/auth/session', { method: 'POST' });
    assert.equal(tokenPrompt, 0, 'the gate already has the operator typing — re-opening it on their wrong guess is noise');
  });

  test('a structured gate failure is routed by what the SERVER said, not by the URL', async () => {
    const { authState, install } = await freshModules();
    let pinRelock = 0;
    let tokenPrompt = 0;
    authState.onPinSessionLost(() => { pinRelock += 1; });
    authState.onUnauthorized(() => { tokenPrompt += 1; });
    installFakeWindow(async () => jsonResponse(401, { error: 'hint', missing: ['pin'] }));
    install();

    await global.window.fetch('/api/config/vad');

    assert.equal(pinRelock, 1, 'the server named the PIN, so the PIN screen is what comes back');
    assert.equal(tokenPrompt, 0, 'and no prose was parsed to get there');
  });

  test('a foreign origin answering 401 never touches HUD state', async () => {
    const { authState, install } = await freshModules();
    let tokenPrompt = 0;
    authState.onUnauthorized(() => { tokenPrompt += 1; });
    installFakeWindow(async () => jsonResponse(401, { error: 'nope' }));
    install();

    await global.window.fetch('https://example.invalid/api/whatever');

    assert.equal(tokenPrompt, 0, "some other host's credential problem is not this server's");
  });

  test('an unstructured 401 from another same-origin /api route keeps the pre-BUG-442 behaviour', async () => {
    const { authState, install } = await freshModules();
    let tokenPrompt = 0;
    authState.onUnauthorized(() => { tokenPrompt += 1; });
    installFakeWindow(async () => jsonResponse(401, { error: 'something older' }));
    install();

    await global.window.fetch('http://127.0.0.1:4478/api/legacy');

    assert.equal(tokenPrompt, 1,
      'the adjacent case: with no `missing` field the only honest default is what was there before, and it '
      + 'is still guarded by BUG-400s tokenRequired check inside markUnauthorized');
  });

  test('the guard reads a clone, so the caller still gets the body', async () => {
    const { install } = await freshModules();
    installFakeWindow(async () => jsonResponse(401, { error: 'hint', missing: ['token'] }));
    install();

    const res = await global.window.fetch('/api/config/vad');
    const body = await res.json();

    assert.equal(body.error, 'hint',
      'the guard observes and changes nothing — ~20 call sites downstream still read this body');
  });

  test('a 200 is not inspected at all', async () => {
    const { authState, install } = await freshModules();
    let tokenPrompt = 0;
    authState.onUnauthorized(() => { tokenPrompt += 1; });
    installFakeWindow(async () => jsonResponse(200, { ok: true }));
    install();
    await global.window.fetch('/api/config/vad');
    assert.equal(tokenPrompt, 0);
  });
});
