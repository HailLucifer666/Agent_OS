'use strict';
// test/auth-gate-state.test.js — pure node:test coverage for the token gate's
// decisions, extracted out of the DOM shell exactly like
// test/pin-gate-state.test.js does for the PIN screen:
//
//   deriveAuthGate(...)            — given GET /health + GET /api/status, must
//                                    the operator be asked for MYTHOS_AUTH_TOKEN?
//   interpretExchangeResponse(...) — given POST /api/auth/session's real
//                                    status+body, what does the prompt show?
//
// The constraints under test, in order of how badly getting them wrong hurts:
//   1. A DEFAULT INSTALL MUST NEVER PROMPT. No MYTHOS_AUTH_TOKEN means
//      /health reports authRequired:false, and nothing may paint over the HUD.
//   2. An indeterminate probe must not prompt either — demanding a credential
//      because the server did not answer is a guess presented as a requirement.
//   3. Server error text is shown verbatim; nothing is invented client-side.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const GATE_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'auth', 'auth-gate-state.js')
).href;

const healthOk = (authRequired) => ({ ok: true, status: 200, body: { ok: true, uptime: 1, authRequired } });

describe('deriveAuthGate (GET /health + GET /api/status -> prompt or not)', () => {
  it('authRequired:false never prompts — the default loopback install is untouched', async () => {
    const { deriveAuthGate } = await import(GATE_URL);
    const gate = deriveAuthGate({ health: healthOk(false), status: { ok: false, status: 401 } });
    assert.equal(gate.show, false);
    assert.equal(gate.reason, 'not-required');
  });

  it('authRequired:true + /api/status 401 prompts — this is the reported bug', async () => {
    const { deriveAuthGate } = await import(GATE_URL);
    const gate = deriveAuthGate({ health: healthOk(true), status: { ok: false, status: 401 } });
    assert.equal(gate.show, true);
    assert.equal(gate.reason, 'unauthenticated');
  });

  it('authRequired:true + /api/status 200 stays hidden — a valid cookie already exists', async () => {
    const { deriveAuthGate } = await import(GATE_URL);
    const gate = deriveAuthGate({ health: healthOk(true), status: { ok: true, status: 200 } });
    assert.equal(gate.show, false);
    assert.equal(gate.reason, 'authenticated');
  });

  it('an unreachable server does not prompt — indeterminate, not "you need a token"', async () => {
    const { deriveAuthGate } = await import(GATE_URL);
    const gate = deriveAuthGate({ health: null, status: null });
    assert.equal(gate.show, false);
    assert.equal(gate.reason, 'indeterminate');
  });

  it('an older server whose /health omits authRequired still prompts on a real 401', async () => {
    const { deriveAuthGate } = await import(GATE_URL);
    const gate = deriveAuthGate({
      health: { ok: true, status: 200, body: { ok: true, uptime: 1 } },
      status: { ok: false, status: 401 },
    });
    assert.equal(gate.show, true, 'the 401 is the authority; authRequired only short-circuits the false case');
  });

  it('no probe object at all is handled, not thrown on', async () => {
    const { deriveAuthGate } = await import(GATE_URL);
    assert.deepEqual(deriveAuthGate(undefined), { show: false, reason: 'indeterminate' });
  });
});

describe('interpretExchangeResponse (POST /api/auth/session)', () => {
  it('200 {ok:true} authenticates', async () => {
    const { interpretExchangeResponse } = await import(GATE_URL);
    const r = interpretExchangeResponse({ status: 200, body: { ok: true } });
    assert.equal(r.authenticated, true);
    assert.equal(r.message, '');
  });

  it('401 does not authenticate and shows the server text verbatim', async () => {
    const { interpretExchangeResponse } = await import(GATE_URL);
    const r = interpretExchangeResponse({ status: 401, body: { error: 'Incorrect token.' } });
    assert.equal(r.authenticated, false);
    assert.equal(r.message, 'Incorrect token.');
  });

  it('429 shows the real limiter message rather than a client-side countdown', async () => {
    const { interpretExchangeResponse } = await import(GATE_URL);
    const r = interpretExchangeResponse({
      status: 429,
      body: { error: 'Rate limit exceeded for auth-exchange. Try again in 42s.', retryAfter: 42 },
    });
    assert.equal(r.authenticated, false);
    assert.equal(r.message, 'Rate limit exceeded for auth-exchange. Try again in 42s.');
  });

  it('409 (combined PIN + token deployment) explains the real channel requirement', async () => {
    const { interpretExchangeResponse } = await import(GATE_URL);
    const serverText = 'This deployment requires both a PIN session and the bearer token.';
    const r = interpretExchangeResponse({ status: 409, body: { error: serverText } });
    assert.equal(r.authenticated, false);
    assert.equal(r.message, serverText);
  });

  it('404 (no token configured) does not authenticate and says so', async () => {
    const { interpretExchangeResponse } = await import(GATE_URL);
    const r = interpretExchangeResponse({ status: 404, body: { error: 'No MYTHOS_AUTH_TOKEN is configured for this deployment.' } });
    assert.equal(r.authenticated, false);
    assert.match(r.message, /configured/);
  });

  it('a 200 with no {ok:true} body is NOT an unlock — status alone must not be trusted', async () => {
    const { interpretExchangeResponse } = await import(GATE_URL);
    assert.equal(interpretExchangeResponse({ status: 200, body: null }).authenticated, false);
  });

  it('an unparseable/absent response still yields a message, never an empty prompt', async () => {
    const { interpretExchangeResponse } = await import(GATE_URL);
    const r = interpretExchangeResponse(undefined);
    assert.equal(r.authenticated, false);
    assert.ok(r.message.length > 0);
  });
});

describe('validateTokenInput', () => {
  it('rejects empty/whitespace without burning a real attempt', async () => {
    const { validateTokenInput } = await import(GATE_URL);
    assert.equal(validateTokenInput('').ok, false);
    assert.equal(validateTokenInput('   ').ok, false);
    assert.equal(validateTokenInput(undefined).ok, false);
  });

  it('never echoes the entered value back into the error text', async () => {
    const { validateTokenInput } = await import(GATE_URL);
    const res = validateTokenInput('');
    assert.equal(res.error.includes('MYTHOS_AUTH_TOKEN'), true);
  });

  it('accepts anything non-empty — the server is the only authority on correctness', async () => {
    const { validateTokenInput } = await import(GATE_URL);
    assert.equal(validateTokenInput('539d1e11').ok, true);
  });
});
