// security-state.js — the pure decisions behind the SECURITY panel, split out
// of the DOM shell (views/security.js) so node:test can cover them with no
// browser. Same split, and the same reasoning, as pin/pin-gate.js vs
// pin/pin-lock-screen.js. See test/security-state.test.js.
//
// Backed by server/routes/pin.js:
//   GET  /api/pin/status  -> 200 {configured, hasWindowsHello} | 404 if unwired
//   POST /api/pin/set     -> 200 {ok:true}
//                          | 400 {error} (bad shape) | 401 (wrong current PIN)
//                          | 429 (lockout — 5 attempts / 60s)
//
// Honesty rules, inherited from the PIN lock screen and the setup screen:
//   - an INDETERMINATE status probe (server unreachable, unparseable body,
//     401 from the auth gate) reports "could not check" rather than asserting
//     a state — a guess dressed as a finding is exactly what this file exists
//     to refuse;
//   - a PIN VALUE is never echoed into any message, and the panel clears the
//     inputs after every attempt (same rule as setup-screen.js);
//   - server refusal text is shown VERBATIM, never reworded (AD-5 — the
//     backend owns the error contract).

// derivePinPanelStatus(probe) -> {state, reason}
//   probe: {ok, status, body} from GET /api/pin/status, or null if it failed
//   state: 'configured' | 'not-configured' | 'unavailable' | 'indeterminate'
export function derivePinPanelStatus(probe) {
  const p = probe || {};
  const body = p.body && typeof p.body === 'object' ? p.body : null;

  if (p.status === 404) {
    return { state: 'unavailable', reason: 'PIN lock is not available in this deployment.' };
  }
  if (!p.ok || p.status !== 200 || !body || typeof body.configured !== 'boolean') {
    return { state: 'indeterminate', reason: 'Could not reach the server — try again.' };
  }
  return body.configured
    ? { state: 'configured', reason: '' }
    : { state: 'not-configured', reason: '' };
}

// derivePinSectionNeed(probe) -> {show, configured} | {show:false, configured:false}
// The first-run setup screen's decision about whether to render its PIN
// section. Only a DETERMINATE status answer renders it: 'configured' shows a
// change-PIN form, 'not-configured' a set-PIN form. An indeterminate answer
// (server unreachable, 401 from the auth gate, unparseable body) or a 404
// (pinLock unwired in this deployment) renders nothing — same fail-open-on-
//-doubt rule as the setup screen's own deriveSetupNeed, and the same reason:
// painting a form that cannot work is a guess dressed as a finding.
export function derivePinSectionNeed(probe) {
  const st = derivePinPanelStatus(probe);
  if (st.state === 'configured') return { show: true, configured: true };
  if (st.state === 'not-configured') return { show: true, configured: false };
  return { show: false, configured: false };
}

// confirmMatches(a, b) -> boolean — exact string equality for the
// "type it twice" guard. Deliberately strict: a whitespace-only mismatch is
// still a mismatch.
export function confirmMatches(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a === b;
}

// interpretSetResult(res, thrownMessage) -> {set, message}
// res is whatever POST /api/pin/set resolved to ({ok, status, body}) or null.
// The main authority is the server's own error text, shown verbatim.
export function interpretSetResult(res, thrownMessage) {
  if (thrownMessage) {
    return { set: false, message: String(thrownMessage) };
  }
  const r = res || {};
  const body = r.body && typeof r.body === 'object' ? r.body : null;
  if (r.ok && body && body.ok === true) {
    // Deliberately not "unlocked": the PIN takes effect immediately on the
    // server (pin-lock.js reads its store per verify), but the HUD's lock
    // screen only re-checks /api/pin/status on reload — so the honest claim
    // is what the operator can observe, not what we wish were true.
    return { set: true, message: 'PIN saved. The lock screen will appear on the next reload.' };
  }
  const serverError = body && typeof body.error === 'string' && body.error ? body.error : '';
  if (r.status === 429) {
    return { set: false, message: serverError || 'Too many attempts — try again later.' };
  }
  if (r.status === 401) {
    return { set: false, message: serverError || 'Current PIN was not accepted.' };
  }
  return { set: false, message: serverError || 'The server refused that PIN.' };
}
