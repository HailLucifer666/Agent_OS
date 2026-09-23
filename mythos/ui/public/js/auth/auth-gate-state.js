// auth-gate-state.js — the two pure decisions behind the token prompt, split
// out of the DOM shell (auth-gate.js) so node:test can cover them with no
// browser. See test/auth-gate-state.test.js.
//
// Backed by server/routes/auth.js + server/index.js:
//   GET  /health              -> 200 {ok, uptime, authRequired}
//   GET  /api/status          -> 200 (a valid credential is already present)
//                              | 401 (none is)
//   POST /api/auth/session    -> 200 {ok:true}  + Set-Cookie mythos_session (a random id, BUG-444)
//                              | 400 {error} — no token in the body
//                              | 401 {error:'Incorrect token.'}
//                              | 404 {error} — no MYTHOS_AUTH_TOKEN configured
//                              | 429 {error} — 5/min exchange limit
//
// Honesty rules (AD-5):
//   - server error text is displayed VERBATIM; nothing is invented client-side,
//     no remaining-attempts count (the server sends none), no countdown clock
//     parsed out of the 429 message.
//   - an INDETERMINATE probe (server unreachable, unparseable body) does NOT
//     paint the prompt. Asking the operator for a credential because the
//     server did not answer would be a guess presented as a requirement; the
//     status banner reports the real condition instead, and any later 401
//     opens this gate through markUnauthorized() anyway.

// deriveAuthGate({health, status}) -> {show, reason}
//   health: {ok, status, body} from GET /health, or null if it failed
//   status: {ok, status}        from GET /api/status, or null if it failed
//   reason: 'not-required' | 'authenticated' | 'unauthenticated' | 'indeterminate'
export function deriveAuthGate(probe) {
  const p = probe || {};
  const health = p.health || null;
  const healthBody = health && health.body && typeof health.body === 'object' ? health.body : null;

  // A default install (no MYTHOS_AUTH_TOKEN, loopback bind) must be completely
  // unaffected — no prompt, no probe result second-guessed.
  if (health && health.ok && healthBody && healthBody.authRequired === false) {
    return { show: false, reason: 'not-required' };
  }

  const status = p.status || null;
  if (status && status.status === 401) return { show: true, reason: 'unauthenticated' };
  if (status && status.ok) return { show: false, reason: 'authenticated' };
  return { show: false, reason: 'indeterminate' };
}

// interpretExchangeResponse({status, body}) -> {authenticated, message}
export function interpretExchangeResponse(res) {
  const r = res || {};
  const body = r.body && typeof r.body === 'object' ? r.body : null;
  const serverError = body && typeof body.error === 'string' && body.error ? body.error : '';

  if (r.status === 200 && body && body.ok === true) {
    return { authenticated: true, message: '' };
  }
  if (r.status === 401) {
    return { authenticated: false, message: serverError || 'Incorrect token.' };
  }
  if (r.status === 404) {
    return {
      authenticated: false,
      message: serverError || 'This server has no token configured — nothing to enter.',
    };
  }
  if (r.status === 409 || r.status === 429 || r.status === 400) {
    return { authenticated: false, message: serverError || 'That request was refused.' };
  }
  return {
    authenticated: false,
    message: serverError || 'Could not check that token — the server did not answer.',
  };
}

// validateTokenInput(str) -> {ok} | {ok:false, error}
// Shape check only, purely to avoid burning one of the five real attempts per
// minute on an empty field. The server re-validates and is the only authority.
// The entered value is NEVER echoed into the error text.
export function validateTokenInput(token) {
  if (typeof token !== 'string' || !token.trim()) {
    return { ok: false, error: 'Enter the token from MYTHOS_AUTH_TOKEN.' };
  }
  return { ok: true };
}
