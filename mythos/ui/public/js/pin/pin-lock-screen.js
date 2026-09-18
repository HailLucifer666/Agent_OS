// pin-lock-screen.js — a client-side visual/pointer lock for §7.3's PIN.
// server/routes/pin.js + src/core/security/pin-lock.js (real scrypt, real
// 5-attempt/60s lockout) shipped complete and TESTED, but nothing in ui/ ever
// called /api/pin, so a configured PIN painted no overlay at all. This file
// is that overlay: it calls /api/pin/status and /api/pin/verify and, while a
// configured PIN is unverified, covers the screen and `inert`s everything
// else so a casual bystander can't see or touch the HUD underneath.
//
// WHAT THIS IS NOT, stated plainly (AD-4 — do not let this drift back into a
// security claim it can't back): this is NOT an access-control boundary. It
// does not gate any server route. Verified by reading server/index.js:
// tokenOk() returns true unconditionally when MYTHOS_AUTH_TOKEN is unset, and
// that IS the shipped default — mythos/.env.example ships
// MYTHOS_BIND=127.0.0.1 with MYTHOS_AUTH_TOKEN commented out, and the
// boot-time fail-closed check only throws for a non-loopback bind. So on a
// default local install there is no bearer gate behind this screen at all:
// `curl http://127.0.0.1:<port>/api/...` reaches the full tool surface with
// no PIN prompt. And a person standing at the keyboard — the exact adversary
// a PIN exists to stop — has DevTools too and can delete this overlay from
// the DOM in one line. Real enforcement would need a server-side PIN session
// gating the /api surface itself; that does not exist and is out of scope here.
//
// Shape/behaviour follows confirm-modal.js, the repo's other full-screen
// modal, deliberately:
//   - one overlay element appended to a dedicated root, removed on unlock;
//   - focus containment via the shared a11y/focus-trap.js helper (NOT a new
//     one — see that file's header for why overlay panels don't use it and
//     modals do). onEscape is deliberately NOT passed: a lock screen you can
//     dismiss with Escape is not a lock screen.
//
// Honesty + privacy rules:
//   - The PIN is never stored, cached, or persisted anywhere client-side: the
//     input's value goes straight into one fetch body and the field is cleared
//     immediately after. No localStorage, no sessionStorage, no closure copy,
//     no "remember this device".
//   - Lockout state comes from the server's real 429 and its message is shown
//     VERBATIM. No client-side countdown, no invented remaining-attempts
//     count — the backend sends neither (AD-5). All of that decision logic is
//     in pin/pin-gate.js, unit-tested in test/pin-gate-state.test.js.
//   - Indeterminate /api/pin/status answers fail OPEN — see pin-gate.js's
//     scope note for why (this screen deters a bystander; it was never a
//     security boundary a network failure needed to fail closed against).
//     app.js's mic-arming / wake-word / proactive-speech / navigate guards
//     use a separate tri-state lockState() (below) that fails SAFE instead,
//     because those guard real capabilities (mic capture, TTS playback) —
//     see pin-gate.js's isGateClosed().

import { trapFocus } from '../a11y/focus-trap.js';
import { derivePinGate, interpretVerifyResponse, validatePinInput } from './pin-gate.js';
import { advanceRecoveryGeneration, onPinSessionLost } from '../auth/auth-state.js';

// Elements outside the overlay that must be unreachable while locked. `inert`
// removes them from the tab order AND from hit-testing in one attribute —
// the same native primitive overlay-manager.js already relies on.
const INERT_SELECTOR = '#hud-canvas, #core-orb, #hud-a11y-root, #widget-root, #overlay-root, #confirm-root, #compose-bar, #camera-preview';

function buildOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'pin-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'pin-title');
  // xss-safe: static template, no interpolation
  overlay.innerHTML = `
    <form class="pin-modal glass" novalidate>
      <div class="pin-orb"></div>
      <h1 class="pin-title" id="pin-title">MYTHOS is locked</h1>
      <label class="pin-label" for="pin-input">Enter your PIN to unlock</label>
      <input class="pin-input mono" id="pin-input" type="password" inputmode="numeric"
             autocomplete="off" autocapitalize="off" spellcheck="false"
             maxlength="12" aria-describedby="pin-message" />
      <div class="pin-actions">
        <button class="pin-submit" type="submit">Unlock</button>
      </div>
      <div class="pin-message mono" id="pin-message" role="alert" aria-live="assertive"></div>
    </form>
  `;
  return overlay;
}

// mountPinLockScreen(root, { onUnlock }) -> { cleanup }
// Non-blocking: returns immediately and locks (or doesn't) once
// GET /api/pin/status answers, so HUD boot is never gated on the round-trip.
export function mountPinLockScreen(root, opts) {
  const onUnlock = (opts && opts.onUnlock) || (() => {});
  // BUG-442 seam: tests drive the relock subscription without a real store.
  const subscribeSessionLost = (opts && opts.onPinSessionLostImpl) || onPinSessionLost;
  // Test/injection seam, mirroring live-session.js's createSocket convention:
  // defaults to the real fetch.
  const doFetch = (opts && opts.fetchImpl) || ((...args) => fetch(...args));

  let overlay = null;
  let releaseTrap = null;
  let disposed = false;
  let inerted = [];
  // Tri-state, exposed via lockState() below — see pin-gate.js's
  // isGateClosed() for why 'unknown' (the window before GET /api/pin/status
  // has answered) must NOT be treated as open by callers guarding a real
  // capability (mic arming, wake word, proactive speech).
  let lockState = 'unknown';

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

  async function postVerify(pin) {
    try {
      const res = await doFetch('/api/pin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      let body = null;
      try { body = await res.json(); } catch { /* non-JSON body — interpret by status */ }
      return interpretVerifyResponse({ status: res.status, body });
    } catch (err) {
      // A failed request is NOT an unlock, and is reported as what it is.
      return { unlocked: false, lockedOut: false, message: 'Could not reach the server — try again.' };
    }
  }

  function lock() {
    if (disposed || overlay) return;
    overlay = buildOverlay();
    root.appendChild(overlay);
    setInert(true);

    const form = overlay.querySelector('form');
    const input = overlay.querySelector('.pin-input');
    const submit = overlay.querySelector('.pin-submit');
    const message = overlay.querySelector('.pin-message');

    let inFlight = false;

    async function attempt() {
      if (inFlight) return;
      const entered = input.value;
      const shape = validatePinInput(entered);
      if (!shape.ok) {
        message.textContent = shape.error;
        input.focus();
        return;
      }
      inFlight = true;
      submit.disabled = true;
      message.textContent = 'Checking…';
      const state = await postVerify(entered);
      // Clear the field the moment the request is answered — the PIN lives
      // only in that request body, never in DOM state we keep around.
      input.value = '';
      inFlight = false;
      if (disposed) return;
      submit.disabled = false;
      if (state.unlocked) {
        lockState = 'unlocked';
        // BUG-442: a credential has actually been re-established, so every 401
        // still in flight from before this moment is stale news about a solved
        // problem. Advancing the generation is what stops those late arrivals
        // relocking the screen the operator just satisfied.
        advanceRecoveryGeneration();
        teardown();
        onUnlock();
        return;
      }
      // Verbatim server text: 'Incorrect PIN.' or the real 429 lockout line.
      message.textContent = state.message;
      overlay.classList.toggle('pin-locked-out', state.lockedOut);
      input.focus();
    }

    form.addEventListener('submit', (e) => { e.preventDefault(); attempt(); });

    // No onEscape — a lock screen must not be dismissible by keyboard. Tab
    // still cycles inside the overlay (input <-> Unlock) and initial focus
    // lands on the input, both from the shared helper.
    releaseTrap = trapFocus(overlay, {});
  }

  (async () => {
    let gate;
    try {
      const res = await doFetch('/api/pin/status');
      let body = null;
      try { body = await res.json(); } catch { /* fall through as indeterminate */ }
      gate = derivePinGate({ ok: res.ok, status: res.status, body });
    } catch (err) {
      gate = derivePinGate(undefined);
    }
    if (disposed) return;
    if (gate.locked) { lockState = 'locked'; lock(); return; }
    // not-configured / unavailable / indeterminate all resolve the 'unknown'
    // window to 'unlocked' — only an explicit configured:true ever locks.
    //
    // ONLY out of 'unknown', and the security review of 2026-09-18 found why.
    // This probe runs concurrently with the BUG-442 relock subscriber below. If
    // a `missing:['pin']` 401 arrived first and locked the screen, an
    // indeterminate probe answer landing afterwards wrote 'unlocked' WITHOUT
    // tearing the overlay down — leaving the lock visibly on screen while
    // lockState() reported unlocked, so mic arming, wake word and proactive
    // speech would all re-enable behind it.
    if (lockState !== 'unknown') return;
    lockState = 'unlocked';
    if (gate.reason === 'indeterminate') {
      // Loud enough to diagnose, quiet enough not to block the HUD. See
      // pin-gate.js's scope note for why this fails open.
      console.warn('[pin] could not determine lock state from /api/pin/status — HUD left unlocked');
    }
  })();

  // BUG-442: the server said the PIN session is what is missing, so put the PIN
  // screen back up. Before this, that 401 reached the token prompt instead and
  // asked the operator for an access token that was never the problem.
  //
  // Guarded on lockState rather than on overlay presence: relocking while
  // already locked would tear down a live focus trap under the operator's
  // hands, and 'unknown' means the status probe has not answered yet, which
  // lock() itself is about to resolve.
  const releaseSessionLost = subscribeSessionLost(() => {
    if (disposed || lockState === 'locked') return;
    lockState = 'locked';
    lock();
  });

  return {
    cleanup() { disposed = true; if (releaseSessionLost) releaseSessionLost(); teardown(); },
    // Boolean overlay-presence check — kept for existing callers/tests. Do
    // NOT use this to guard a real capability (mic arming, wake word,
    // proactive speech): it reads false during the 'unknown' window before
    // GET /api/pin/status has answered, which is exactly the race
    // lockState()/isGateClosed() (pin-gate.js) exists to close.
    isLocked: () => Boolean(overlay),
    // Tri-state 'unknown' | 'locked' | 'unlocked' — see pin-gate.js's
    // isGateClosed() doc comment. app.js's mic-arming, wake-word,
    // proactive-speech, and navigate guards all read this instead of
    // isLocked() so they fail safe during the status-check race.
    lockState: () => lockState,
  };
}
