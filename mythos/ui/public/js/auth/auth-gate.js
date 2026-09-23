// auth-gate.js — the token prompt. The missing client half of the mechanism
// server/index.js's extractToken() has documented since Task 6: "mythos_token
// cookie (set by the HUD once the operator enters the token, reused on plain
// HTTP nav)". The server already read that cookie; nothing ever set it.
//
// Why this exists at all: MYTHOS_BIND=0.0.0.0 (required for the phone node to
// reach the server) makes MYTHOS_AUTH_TOKEN mandatory at boot. A browser tab
// cannot attach an Authorization header to its own navigation, and cannot
// attach headers to a WebSocket upgrade at all — so with a token configured
// the dashboard loaded (the static shell is deliberately open, AD-8) and then
// silently 401'd on every /api/… fetch and every WS upgrade. This prompt is
// how the operator presents the secret once; POST /api/auth/session turns it
// into the cookie, and the browser then sends it automatically on both
// channels, including the WS upgrade.
//
// WHAT THIS IS NOT: a security boundary of its own, and not a way around one.
// It sends the operator's typed secret to a server that timing-safe-compares
// it. A wrong token gets nothing, and nothing is ever auto-issued to a
// loopback caller. Deleting this overlay from the DOM gains an attacker
// exactly nothing, because the enforcement is server-side in tokenOk().
//
// Shape follows pin/pin-lock-screen.js deliberately (same overlay-in-a-root,
// same shared a11y/focus-trap.js, same clear-the-field-on-answer discipline,
// same "all decisions live in a pure module" split — see auth-gate-state.js).
// Escape does NOT dismiss it: nothing behind it works until it is satisfied.

import { trapFocus } from '../a11y/focus-trap.js';
import { deriveAuthGate, interpretExchangeResponse, validateTokenInput } from './auth-gate-state.js';
import { advanceRecoveryGeneration, clearUnauthorized, onUnauthorized, setTokenRequired } from './auth-state.js';

// The PIN overlay lives in its own root at a lower z-index. If both were ever
// live at once they would fight for focus, so the token gate — which must be
// satisfied first, since the PIN check itself needs an authenticated /api —
// makes that root inert while it is up.
const INERT_SELECTOR = '#hud-canvas, #core-orb, #hud-a11y-root, #widget-root, #overlay-root, #confirm-root, #compose-bar, #camera-preview, #pin-root';

let openCurrentGate = null;

function buildOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'auth-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'auth-title');
  // xss-safe: static template, no interpolation
  overlay.innerHTML = `
    <form class="auth-modal glass" novalidate>
      <div class="auth-orb"></div>
      <h1 class="auth-title" id="auth-title">MYTHOS needs your access token</h1>
      <p class="auth-note">This server is bound to the network, so it requires the token from
        <code>MYTHOS_AUTH_TOKEN</code> in <code>mythos/.env</code>. Entered once per browser.</p>
      <label class="auth-label" for="auth-input">Access token</label>
      <input class="auth-input mono" id="auth-input" type="password"
             autocomplete="off" autocapitalize="off" spellcheck="false"
             aria-describedby="auth-message" />
      <div class="auth-actions">
        <button class="auth-submit" type="submit">Connect</button>
      </div>
      <div class="auth-message mono" id="auth-message" role="alert" aria-live="assertive"></div>
    </form>
  `;
  return overlay;
}

// mountAuthGate(root, opts) -> { open, isOpen, cleanup }
// Non-blocking, exactly like mountPinLockScreen: returns immediately and paints
// (or doesn't) once the probes answer, so HUD boot never waits on a round trip.
export function mountAuthGate(root, opts) {
  const doFetch = (opts && opts.fetchImpl) || ((...args) => fetch(...args));
  const reloadImpl = (opts && opts.reloadImpl) || (() => window.location.reload());

  let overlay = null;
  let releaseTrap = null;
  let disposed = false;
  let inerted = [];

  function setInert(on) {
    if (on) {
      inerted = Array.from(document.querySelectorAll(INERT_SELECTOR));
      inerted.forEach((el) => { el.inert = true; });
    } else {
      inerted.forEach((el) => { el.inert = false; });
      inerted = [];
    }
  }

  function teardown() {
    if (releaseTrap) { releaseTrap(); releaseTrap = null; }
    if (overlay) { overlay.remove(); overlay = null; }
    setInert(false);
  }

  async function probe(url) {
    try {
      const res = await doFetch(url);
      let body = null;
      try { body = await res.json(); } catch (_) { /* interpret by status */ }
      return { ok: res.ok, status: res.status, body };
    } catch (_) {
      return null;
    }
  }

  async function postExchange(token) {
    try {
      const res = await doFetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      let body = null;
      try { body = await res.json(); } catch (_) { /* interpret by status */ }
      return interpretExchangeResponse({ status: res.status, body });
    } catch (_) {
      return { authenticated: false, message: 'Could not reach the server — try again.' };
    }
  }

  function open() {
    if (disposed || overlay) return;
    overlay = buildOverlay();
    root.appendChild(overlay);
    setInert(true);

    const form = overlay.querySelector('form');
    const input = overlay.querySelector('.auth-input');
    const submit = overlay.querySelector('.auth-submit');
    const message = overlay.querySelector('.auth-message');

    let inFlight = false;

    async function attempt() {
      if (inFlight) return;
      const entered = input.value;
      const shape = validateTokenInput(entered);
      if (!shape.ok) {
        message.textContent = shape.error;
        input.focus();
        return;
      }
      inFlight = true;
      submit.disabled = true;
      message.textContent = 'Checking…';
      const state = await postExchange(entered.trim());
      // The token lives only in that request body — cleared the moment the
      // request is answered, never persisted, never kept in closure state.
      input.value = '';
      inFlight = false;
      if (disposed) return;
      submit.disabled = false;
      if (state.authenticated) {
        clearUnauthorized();
        // BUG-442: the token is re-established, so 401s still in flight from
        // before this moment must not re-open the prompt that was just
        // satisfied. (The reload below usually beats them, but not always —
        // and "usually" is not a mechanism.)
        advanceRecoveryGeneration();
        message.textContent = 'Connected — reloading…';
        // A full reload rather than re-driving every module: most of the HUD
        // fetches once at boot with no retry path (app.js's VAD/wake-word
        // config, the widgets' first paint), so one reload is far smaller than
        // making every one of those retryable. The cookie is already set.
        reloadImpl();
        return;
      }
      // Server text verbatim: 'Incorrect token.', the real 429 line, or the
      // 409 explaining that a combined PIN+token deployment needs the header.
      message.textContent = state.message;
      input.focus();
    }

    form.addEventListener('submit', (e) => { e.preventDefault(); attempt(); });

    // No onEscape: dismissing this leaves a dashboard that cannot load anything.
    releaseTrap = trapFocus(overlay, {});
  }

  // Any later 401 (net-guard.js) reopens the gate — e.g. the cookie expired
  // mid-session, or the operator restarted the server with a new token.
  //
  // BUG-400: REGISTERED ONLY ONCE THE PROBE HAS SAID A TOKEN IS CONFIGURED,
  // which is why this is a holder and not the subscription itself. It used to
  // subscribe HERE, above the probe, while the 'not-required' branch below
  // returned out of the async IIFE only — so on a deployment with NO
  // MYTHOS_AUTH_TOKEN the listener survived and every /api/ 401 reopened a
  // prompt whose own exchange endpoint answers 404 ('nothing to enter').
  // A PIN-only deployment emits exactly those 401s, so the token overlay
  // masked pin/pin-lock-screen.js and the operator could not get in by ANY
  // input — measured on the packaged build 2026-09-03, where the userData
  // vault carries Identity/pin.json and the repo vault does not.
  //
  // The comment on the 'not-required' branch already promised 'do nothing at
  // all, ever'; this is the code finally keeping that promise. Not subscribing
  // beats subscribing behind a guard: it leaves no state that can fail open.
  let offUnauthorized = null;

  (async () => {
    const health = await probe('/health');
    if (disposed) return;
    // Default install, no token configured: do nothing at all, ever.
    const early = deriveAuthGate({ health, status: null });
    if (early.reason === 'not-required') {
      // BUG-400: tell the store, so a 401 from a PIN-only deployment can never
      // raise the token flag for ANY subscriber — status-banner.js included,
      // which would otherwise offer 'Enter token' for a token that does not
      // exist. Also clears a flag raised by a 401 that raced this probe.
      setTokenRequired(false);
      return;
    }
    setTokenRequired(true);
    // Past this line a token IS configured, so an expiring cookie must be able
    // to reopen the gate. Covers reason 'authenticated' too, deliberately.
    offUnauthorized = onUnauthorized(() => { if (!disposed) open(); });
    const status = await probe('/api/status');
    if (disposed) return;
    const gate = deriveAuthGate({ health, status });
    if (gate.show) open();
    else if (gate.reason === 'indeterminate') {
      // Loud enough to diagnose, quiet enough not to demand a credential the
      // server never actually asked for. See auth-gate-state.js's honesty note.
      console.warn('[auth] could not determine whether this server requires a token — no prompt shown');
    }
  })();

  const handle = {
    open,
    isOpen: () => Boolean(overlay),
    cleanup() { disposed = true; if (offUnauthorized) offUnauthorized(); teardown(); openCurrentGate = null; },
  };
  openCurrentGate = open;
  return handle;
}

// Module-level accessor so status-banner.js can offer "click to re-enter the
// token" without app.js having to thread the handle through to it.
export function openAuthGate() {
  if (openCurrentGate) openCurrentGate();
}
