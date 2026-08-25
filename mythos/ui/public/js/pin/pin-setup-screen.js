// pin-setup-screen.js — CREATING a PIN, which the HUD previously had no way to
// do at all.
//
// The backend has had POST /api/pin/set since §7.3 (server/routes/pin.js, and
// pinLock.setPin() in src/core/security/pin-lock.js enforces 4–12 digits plus
// the current-PIN check on a replace). Nothing in the renderer ever called it:
// the only PIN client was pin-lock-screen.js, which VERIFIES. So on a fresh
// install pin/status answered {configured:false}, pin-gate.js correctly failed
// open, and the operator was never offered a PIN — the lock could not be turned
// on from the product. That is the gap this file closes.
//
// Shape follows the house pattern: decisions live in setup/setup-state.js
// (validatePinPair / interpretPinSetResult, both node:test-able), this file is
// the DOM shell, fetch is injectable, and every dynamic string goes in via
// textContent.
//
// The PIN itself is treated like a key: read from the input, posted, and the
// fields are cleared whatever happened. It is never stored in a variable that
// outlives the submit, never put in the DOM, and never logged.

import { validatePinPair, interpretPinSetResult } from '../setup/setup-state.js';

// createPinSetupForm({fetchImpl, configured, hasWindowsHello, onDone}) -> {el, focus}
// A bare form rather than an overlay of its own: the first-run wizard hosts it as
// step 2, and the wizard is also the "change my PIN later" path (reopened from
// the compose bar), so a second standalone screen would be a duplicate of the
// same three fields. onDone(true) fires only after the server confirms.
export function createPinSetupForm(opts) {
  const o = opts || {};
  const doFetch = o.fetchImpl || ((...args) => fetch(...args));
  const configured = Boolean(o.configured);
  const onDone = typeof o.onDone === 'function' ? o.onDone : () => {};

  const form = document.createElement('form');
  form.className = 'pinset-form';
  form.noValidate = true;

  const fields = [];

  function field(labelText, id, helpText) {
    const wrap = document.createElement('div');
    wrap.className = 'pinset-field';

    const label = document.createElement('label');
    label.className = 'pinset-label';
    label.textContent = labelText;
    label.setAttribute('for', id);

    const input = document.createElement('input');
    // type=password (not number): a numeric input renders spinners, accepts
    // "1e5", and shoulder-reads. inputmode gets the phone keypad without any of
    // that. maxLength mirrors pin-lock.js's 12-digit ceiling.
    input.type = 'password';
    input.id = id;
    input.className = 'pinset-input';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.maxLength = 12;

    wrap.append(label, input);
    if (helpText) {
      const help = document.createElement('p');
      help.className = 'pinset-help';
      help.textContent = helpText;
      wrap.appendChild(help);
    }
    fields.push(input);
    return { wrap, input };
  }

  const current = configured
    ? field('Current PIN', 'pinset-current', 'Required to replace a PIN that is already set.')
    : null;
  const next = field('New PIN', 'pinset-new', '4 to 12 digits. Asked for when MYTHOS starts.');
  const confirm = field('Confirm PIN', 'pinset-confirm');

  const status = document.createElement('p');
  status.className = 'pinset-status';
  status.setAttribute('role', 'alert');
  status.setAttribute('aria-live', 'polite');

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'pinset-submit';
  submit.textContent = configured ? 'Replace PIN' : 'Set PIN';

  if (current) form.appendChild(current.wrap);
  form.append(next.wrap, confirm.wrap, status, submit);

  if (o.hasWindowsHello === false) {
    const note = document.createElement('p');
    note.className = 'pinset-help';
    // Said out loud rather than implied: pin-lock.js's hasWindowsHello() is
    // false because the Hello path was never built, not because a sensor probe
    // failed. A greyed-out "Use Windows Hello" button would imply otherwise.
    note.textContent = 'Windows Hello is not wired in this build — PIN only.';
    form.appendChild(note);
  }

  function fail(message, focusInput) {
    status.textContent = message;
    status.classList.add('is-error');
    if (focusInput) focusInput.focus();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const check = validatePinPair(next.input.value, confirm.input.value);
    if (!check.ok) {
      fail(check.error, check.field === 'pin' ? next.input : confirm.input);
      return;
    }
    if (current && !current.input.value) {
      fail('Enter the current PIN to replace it.', current.input);
      return;
    }

    status.classList.remove('is-error');
    status.textContent = 'Setting…';
    submit.disabled = true;

    const body = { pin: next.input.value };
    if (current) body.currentPin = current.input.value;

    let res = null;
    let parsed = null;
    try {
      res = await doFetch('/api/pin/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      try { parsed = await res.json(); } catch { /* unparseable — handled below */ }
    } catch {
      res = null;
    }

    // Clear the fields whatever happened: a set PIN must not sit in the DOM, and
    // a refused one is usually a typo worth retyping.
    fields.forEach((input) => { input.value = ''; });
    submit.disabled = false;

    const outcome = interpretPinSetResult(res ? { status: res.status } : null, parsed);
    status.textContent = outcome.message;
    status.classList.toggle('is-error', !outcome.ok);
    if (outcome.ok) {
      form.classList.add('is-done');
      submit.disabled = true;
      onDone(true);
    }
  });

  return {
    el: form,
    focus() { (current ? current.input : next.input).focus(); },
  };
}
