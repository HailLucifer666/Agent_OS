// key-field.js — one "paste a provider key" control, shared by the gap screen
// (setup-screen.js) and the first-run wizard (first-run-wizard.js).
//
// Extracted rather than copied because AD-8 lives in here: the value goes from
// the input straight to window.mythos.setKey and the field is cleared on every
// outcome. Two copies of that discipline would be two places for it to rot.
//
// The honesty rule about "stored" versus "live" is in interpretStoreResult
// (setup-state.js), not here: keys are decrypted into the server child's env at
// fork() (electron/main.js), so a key saved now reaches the brain when the
// server child next starts — not the moment the button is pressed.

import { validateKeyValue, interpretStoreResult } from './setup-state.js';

// createKeyField({keyName, storedNames, bridge, onStored}) -> HTMLElement
export function createKeyField(opts) {
  const o = opts || {};
  const keyName = String(o.keyName || '');
  const storedNames = Array.isArray(o.storedNames) ? o.storedNames : [];
  const bridge = o.bridge;
  const onStored = typeof o.onStored === 'function' ? o.onStored : () => {};

  const wrap = document.createElement('div');
  wrap.className = 'setup-field';

  const label = document.createElement('label');
  label.className = 'setup-field-label';
  label.textContent = keyName;
  const inputId = `setup-key-${keyName}`;
  label.setAttribute('for', inputId);

  const input = document.createElement('input');
  // type=password so a screen-share or a shoulder does not read the key;
  // autocomplete off so the browser never offers to remember it.
  input.type = 'password';
  input.id = inputId;
  input.className = 'setup-field-input';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = storedNames.includes(keyName) ? 'already stored — enter to replace' : 'paste the key';

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'setup-field-save';
  save.textContent = 'Save';

  const status = document.createElement('p');
  status.className = 'setup-field-status';
  status.setAttribute('role', 'status');

  save.addEventListener('click', async () => {
    const check = validateKeyValue(keyName, input.value);
    if (!check.ok) {
      status.textContent = check.error;
      status.classList.add('is-error');
      return;
    }
    status.classList.remove('is-error');
    status.textContent = 'Storing…';
    save.disabled = true;

    let result = null;
    let thrown = '';
    try {
      result = await bridge.setKey(keyName, input.value);
    } catch (err) {
      thrown = (err && err.message) || 'the key store refused the request';
    }
    // Cleared whatever happened — a stored key must not sit in the DOM, and a
    // refused one is usually a typo worth retyping rather than editing.
    input.value = '';
    save.disabled = false;

    const outcome = interpretStoreResult(result, thrown);
    status.textContent = outcome.message;
    status.classList.toggle('is-error', !outcome.stored);
    if (outcome.stored) {
      wrap.classList.add('is-stored');
      onStored(keyName);
    }
  });

  wrap.append(label, input, save, status);
  return wrap;
}
