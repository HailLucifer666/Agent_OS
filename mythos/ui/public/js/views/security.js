// security.js — SECURITY panel: set or change the §7.3 local PIN from the HUD,
// instead of the raw API call that was previously the only way. Opened from the
// SECURITY node on the HUD constellation (graph-model.js) or by saying "open
// the security panel" (voice-loop.js NAV_COMMANDS).
//
// This is the missing SET half of the PIN feature. The lock screen
// (pin/pin-lock-screen.js) could always UNLOCK; the server route
// (server/routes/pin.js) could always SET; nothing in the UI ever called
// /api/pin/set, so a fresh install had no way to configure a PIN at all and
// the whole feature looked dead.
//
// Honesty + privacy rules (AD-5, AD-8), inherited from the PIN lock screen:
//   - a PIN value is never echoed, cached, or stored client-side: it goes
//     straight into one fetch body and the inputs are cleared immediately
//     after every attempt;
//   - lockout text comes from the server's real 429 verbatim — no invented
//     countdown, no remaining-attempts number the backend never sent;
//   - an indeterminate status probe reports "could not check" instead of
//     guessing the machine is configured or not (security-state.js).
//
// Panel contract (overlay-manager.js): `export async function render(mount,
// payload)` returning a teardown fn. h()/cleanupBag() from dom.js, the same
// tooling every other view uses.
import { h, cleanupBag } from '/js/dom.js';
import { validatePinInput } from '/js/pin/pin-gate.js';
import {
  derivePinPanelStatus,
  confirmMatches,
  interpretSetResult,
} from '/js/views/security-state.js';

const STATUS_TEXT = {
  configured: 'A PIN is set. The HUD locks on every reload until you enter it.',
  'not-configured': 'No PIN is set. Set one to lock the HUD behind a 4-12 digit code.',
  unavailable: 'PIN lock is not available in this deployment.',
  indeterminate: 'Could not reach the server — try again.',
};

export async function render(mount, payload) {
  const cleanup = cleanupBag();

  const status = h('div', { class: 'security-status mono text-faint' }, 'Checking…');
  const msg = h('div', { class: 'security-msg mono', role: 'status', 'aria-live': 'polite' });

  let configured = false;

  const currentField = h('div', { class: 'security-field', hidden: true },
    h('label', { class: 'security-label mono', for: 'security-current' }, 'CURRENT PIN (to change)'),
    h('input', {
      class: 'security-input mono',
      id: 'security-current',
      type: 'password',
      inputmode: 'numeric',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: '12',
      placeholder: 'current PIN',
    }),
  );
  const pinField = h('div', { class: 'security-field' },
    h('label', { class: 'security-label mono', for: 'security-pin' }, 'NEW PIN (4-12 digits)'),
    h('input', {
      class: 'security-input mono',
      id: 'security-pin',
      type: 'password',
      inputmode: 'numeric',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: '12',
      placeholder: 'new PIN',
    }),
  );
  const confirmField = h('div', { class: 'security-field' },
    h('label', { class: 'security-label mono', for: 'security-confirm' }, 'CONFIRM NEW PIN'),
    h('input', {
      class: 'security-input mono',
      id: 'security-confirm',
      type: 'password',
      inputmode: 'numeric',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: '12',
      placeholder: 'repeat it',
    }),
  );
  const saveBtn = h('button', { class: 'security-save', type: 'button' }, 'Save PIN');

  async function refreshStatus() {
    let probe = null;
    try {
      const res = await fetch('/api/pin/status', { headers: { Accept: 'application/json' } });
      let body = null;
      try { body = await res.json(); } catch { /* unparseable — indeterminate */ }
      probe = { ok: res.ok, status: res.status, body };
    } catch { probe = null; }
    const state = derivePinPanelStatus(probe);
    configured = state.state === 'configured';
    status.textContent = STATUS_TEXT[state.state] || STATUS_TEXT.indeterminate;
    status.classList.toggle('security-status-error', state.state === 'indeterminate' || state.state === 'unavailable');
    currentField.hidden = !configured;
    saveBtn.textContent = configured ? 'Change PIN' : 'Set PIN';
  }

  async function submit() {
    const pin = pinField.querySelector('input').value;
    const confirm = confirmField.querySelector('input').value;
    const currentPin = currentField.querySelector('input').value;

    const shape = validatePinInput(pin);
    if (!shape.ok) {
      msg.textContent = shape.error;
      msg.classList.add('is-error');
      return;
    }
    if (!confirmMatches(pin, confirm)) {
      msg.textContent = 'The two PINs do not match.';
      msg.classList.add('is-error');
      return;
    }
    if (configured && !validatePinInput(currentPin).ok) {
      msg.textContent = 'Enter your current PIN to change it.';
      msg.classList.add('is-error');
      return;
    }

    msg.classList.remove('is-error');
    msg.textContent = 'Saving…';
    saveBtn.disabled = true;

    const body = { pin };
    if (configured) body.currentPin = currentPin;

    let res = null;
    let thrown = '';
    try {
      const r = await fetch('/api/pin/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let parsed = null;
      try { parsed = await r.json(); } catch { /* non-JSON body — interpret by status */ }
      res = { ok: r.ok, status: r.status, body: parsed };
    } catch (err) {
      thrown = (err && err.message) || 'the server did not answer';
    }

    // Clear the fields whatever happened — a PIN must not sit in the DOM
    // waiting for the next screen-share, and a refused one is worth retyping.
    pinField.querySelector('input').value = '';
    confirmField.querySelector('input').value = '';
    currentField.querySelector('input').value = '';
    saveBtn.disabled = false;

    const outcome = interpretSetResult(res, thrown);
    msg.textContent = outcome.message;
    msg.classList.toggle('is-error', !outcome.set);
    if (outcome.set) await refreshStatus();
  }

  saveBtn.addEventListener('click', submit);
  for (const field of [currentField, pinField, confirmField]) {
    field.querySelector('input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
  }
  cleanup.add(() => saveBtn.removeEventListener('click', submit));

  const header = h('div', { class: 'security-intro mono text-faint' },
    'The PIN locks the HUD behind a code you type on this machine. It is hashed server-side (scrypt) and never stored, echoed, or sent anywhere but this server. To remove the PIN, open the vault directly.');

  mount.appendChild(h('div', { class: 'security' },
    header,
    status,
    currentField,
    pinField,
    confirmField,
    h('div', { class: 'security-actions' }, saveBtn),
    msg,
  ));

  refreshStatus();

  return () => cleanup.run();
}
