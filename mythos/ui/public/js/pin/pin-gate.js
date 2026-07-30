// pin-gate.js — the two pure decisions behind the PIN lock screen, split out
// of the DOM shell (pin-lock-screen.js) so node:test can cover them with no
// browser — same pattern as voice-loop.js's decideBargeIn(). See
// test/pin-gate-state.test.js.
//
// Backed by server/routes/pin.js + src/core/security/pin-lock.js:
//   GET  /api/pin/status  -> 200 {configured, hasWindowsHello} | 404 if unwired
//   POST /api/pin/verify  -> 200 {ok:true}
//                          | 401 {error:'Incorrect PIN.'}
//                          | 429 {error:'Too many attempts — locked for Ns.'}
//
// Honesty rules encoded here (AD-5):
//   - The backend does NOT report a remaining-attempts count, so the screen
//     never shows one. Its 5-attempt threshold is a server-side detail.
//   - The 429 message happens to contain a duration, but that string is
//     displayed VERBATIM and never parsed into a client-side countdown clock:
//     a ticking timer the server never sent would be a synthesized metric.
//
// Scope note, deliberate and important: this overlay is a client-side
// visual/pointer lock, not a security boundary — see pin-lock-screen.js's
// header for why (verified against the real server/index.js: the /api
// surface has no bearer gate at all on a default local install). Nothing
// server-side is unlocked or locked by this overlay either way, so an
// INDETERMINATE status answer (network failure, 401, 500, unparseable body)
// deliberately fails OPEN with a console warning rather than bricking the HUD
// behind a screen whose verify call would fail too. Only an explicit
// configured:true locks.
//
// That "fails open" policy is about the overlay's own paint decision once
// the status check has answered. It is a DIFFERENT question from what
// app.js's mic-arming / wake-word / proactive-speech / navigate guards do
// with the WINDOW BEFORE that answer arrives — those guard real capabilities
// (mic capture, TTS playback), so they must fail SAFE instead. isGateClosed()
// below is that guard.

const PIN_RE = /^\d{4,12}$/; // mirrors PIN_RE in src/core/security/pin-lock.js

// derivePinGate({ok, status, body}) -> {locked, reason}
//   reason: 'configured' | 'not-configured' | 'unavailable' | 'indeterminate'
export function derivePinGate(res) {
  const r = res || {};
  const body = r.body && typeof r.body === 'object' ? r.body : null;

  if (r.status === 404) return { locked: false, reason: 'unavailable' };
  if (!r.ok || r.status !== 200 || !body || typeof body.configured !== 'boolean') {
    return { locked: false, reason: 'indeterminate' };
  }
  return body.configured
    ? { locked: true, reason: 'configured' }
    : { locked: false, reason: 'not-configured' };
}

// interpretVerifyResponse({status, body}) -> {unlocked, lockedOut, message}
// Deliberately returns NO lockedUntil/retryAfterMs: the server sends neither.
export function interpretVerifyResponse(res) {
  const r = res || {};
  const body = r.body && typeof r.body === 'object' ? r.body : null;
  const serverError = body && typeof body.error === 'string' && body.error ? body.error : '';

  if (r.status === 200 && body && body.ok === true) {
    return { unlocked: true, lockedOut: false, message: '' };
  }
  if (r.status === 429) {
    return {
      unlocked: false,
      lockedOut: true,
      message: serverError || 'Too many attempts — locked out. Try again later.',
    };
  }
  if (r.status === 401) {
    return { unlocked: false, lockedOut: false, message: serverError || 'Incorrect PIN.' };
  }
  return {
    unlocked: false,
    lockedOut: false,
    message: serverError || 'Could not check that PIN — the server did not answer.',
  };
}

// validatePinInput(str) -> {ok} | {ok:false, error}
// Client-side shape check only, purely to avoid a pointless round-trip that
// would burn one of the five real attempts. The server re-validates. The
// entered value is NEVER echoed into the error text.
export function validatePinInput(pin) {
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) {
    return { ok: false, error: 'PIN must be 4-12 digits.' };
  }
  return { ok: true };
}

// isGateClosed(lockState) -> should a real capability (mic arming, a spoken
// wake word, proactive TTS playback, a server-driven navigate) be refused
// right now?
//
// lockState is pin-lock-screen.js's tri-state, exposed via mountPinLockScreen's
// lockState():
//   'unknown'  — GET /api/pin/status is still in flight (or the check never
//                ran at all). mountPinLockScreen is non-blocking by design
//                (HUD boot must not wait on that round trip), which opens a
//                real window where a pointerdown can land before the screen
//                has decided whether to lock.
//   'locked'   — a PIN is configured and not yet verified this session.
//   'unlocked' — verified this session, or the status check answered with no
//                PIN configured/available/indeterminate (see the scope note
//                above for why indeterminate resolves to unlocked here).
//
// Only an explicit 'unlocked' opens the gate. Treating 'unknown' as open
// (the bug this closes) let a pointerdown during that round trip permanently
// arm always-on wake-word mic capture behind a HUD that then painted locked
// a moment later — armed once, staying armed even after the screen locks.
export function isGateClosed(lockState) {
  return lockState !== 'unlocked';
}
