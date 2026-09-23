// test/security-state.test.js — pure node:test coverage for the SECURITY
// panel's decisions (views/security-state.js). No DOM, no fetch — the module is
// pure by construction, so the tests are the module.
//
// Rewritten 2026-09-23. The panel used to set the local PIN; the PIN was
// removed, and the panel now reports remote access and signs this browser out
// (BUG-444). The old PIN-panel cases went with the feature they described.
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const STATE_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'views', 'security-state.js')
).href;

describe('deriveRemoteAccessStatus (GET /health -> what the panel says)', () => {
  it('a token-configured server says remote access is ON and explains sign-out', async () => {
    const { deriveRemoteAccessStatus } = await import(STATE_URL);
    const st = deriveRemoteAccessStatus({ ok: true, authRequired: true });
    assert.equal(st.state, 'remote');
    assert.match(st.text, /ON/);
    assert.match(st.text, /changing the token signs every device out/);
  });

  it('a loopback-only server says OFF — never offers a sign-out there is nothing to end', async () => {
    const { deriveRemoteAccessStatus } = await import(STATE_URL);
    assert.equal(deriveRemoteAccessStatus({ ok: true, authRequired: false }).state, 'local');
  });

  it('an unreachable server is indeterminate, never rendered as OFF', async () => {
    const { deriveRemoteAccessStatus } = await import(STATE_URL);
    for (const health of [null, undefined, 'nope', 42]) {
      assert.equal(deriveRemoteAccessStatus(health).state, 'indeterminate', JSON.stringify(health));
    }
  });

  it('only a literal true means remote — a truthy string is not a configured token', async () => {
    const { deriveRemoteAccessStatus } = await import(STATE_URL);
    assert.equal(deriveRemoteAccessStatus({ authRequired: 'true' }).state, 'local');
  });

  it('never mentions a PIN — there is none', async () => {
    const { deriveRemoteAccessStatus } = await import(STATE_URL);
    for (const h of [{ authRequired: true }, { authRequired: false }, null]) {
      assert.doesNotMatch(deriveRemoteAccessStatus(h).text, /\bPIN\b/);
    }
  });
});

describe('interpretLogout (POST /api/auth/logout -> what the panel says)', () => {
  it('a revoked session is signed out', async () => {
    const { interpretLogout } = await import(STATE_URL);
    const out = interpretLogout({ ok: true, status: 200, body: { ok: true, revoked: true } }, '');
    assert.equal(out.signedOut, true);
  });

  it('ok but nothing revoked (a bearer-header client) is said plainly, not as a success', async () => {
    const { interpretLogout } = await import(STATE_URL);
    const out = interpretLogout({ ok: true, status: 200, body: { ok: true, revoked: false } }, '');
    assert.equal(out.signedOut, false);
    assert.match(out.message, /nothing to end/);
  });

  it('a network failure names itself', async () => {
    const { interpretLogout } = await import(STATE_URL);
    const out = interpretLogout(null, 'the server did not answer');
    assert.equal(out.signedOut, false);
    assert.match(out.message, /did not answer/);
  });

  it('a refusal shows the server text verbatim (AD-5)', async () => {
    const { interpretLogout } = await import(STATE_URL);
    const out = interpretLogout({ ok: false, status: 401, body: { error: 'Unauthorized — exact server words.' } }, '');
    assert.equal(out.message, 'Unauthorized — exact server words.');
  });

  it('a refusal with no usable body still says something true', async () => {
    const { interpretLogout } = await import(STATE_URL);
    assert.equal(interpretLogout({ ok: false, status: 500, body: null }, '').signedOut, false);
  });
});
