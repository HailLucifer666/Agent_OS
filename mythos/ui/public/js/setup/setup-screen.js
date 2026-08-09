// setup-screen.js — first-run setup. The screen that turns a fresh install into
// a machine at parity with the one it was cloned from, instead of a half-broken
// twin that looks identical until some feature quietly takes its fallback.
//
// Shape follows auth/auth-gate.js deliberately: overlay in its own root, all
// decisions in a pure module (setup-state.js), the shared focus trap, injectable
// fetch/bridge for tests. Two differences, both on purpose:
//
//   - it is DISMISSIBLE (Escape, and a "Continue anyway" button). The auth gate
//     guards something that does not work without it; an incomplete install
//     still runs, just with fewer capabilities, and a modal the operator cannot
//     escape would be worse than the gap it reports.
//   - it only opens itself for REQUIRED gaps. Optional ones are listed once it
//     is open, never a reason to open it.
//
// AD-8: values go from the input straight to window.mythos.setKey and are then
// dropped. Nothing here stores a value in a variable that outlives the call, no
// value is ever put in the DOM, and the server never sends one back. Every
// dynamic string below goes in via textContent — never innerHTML — because the
// HUD's escapeHtml does not escape quotes and attribute interpolation has broken
// out before (see safeHref in the spec renderer).

import { trapFocus } from '../a11y/focus-trap.js';
import {
  deriveSetupNeed,
  planGapActions,
  validateKeyValue,
  interpretStoreResult,
} from './setup-state.js';

const INERT_SELECTOR = '#hud-canvas, #core-orb, #hud-a11y-root, #widget-root, #overlay-root, #confirm-root, #compose-bar, #camera-preview';

export function mountSetupScreen(root, opts) {
  if (!root) return { dispose() {} };
  const doFetch = (opts && opts.fetchImpl) || ((...args) => fetch(...args));
  // The Electron key-store bridge. Absent in a plain browser tab, which is not a
  // failure — it changes what this screen can offer, not whether it runs.
  const bridge = (opts && opts.bridge) !== undefined ? opts.bridge : (typeof window !== 'undefined' ? window.mythos : null);

  let overlay = null;
  let releaseTrap = null;
  let inerted = [];
  let disposed = false;

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
    setInert(false);
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }

  async function probe() {
    try {
      const res = await doFetch('/api/setup/status', { headers: { Accept: 'application/json' } });
      let body = null;
      try { body = await res.json(); } catch { /* unparseable — indeterminate */ }
      return { ok: res.ok, status: res.status, body };
    } catch {
      return null;
    }
  }

  function row(gapAction, keyStoreNames) {
    const li = document.createElement('li');
    li.className = 'setup-row';

    const head = document.createElement('div');
    head.className = 'setup-row-head';
    const name = document.createElement('span');
    name.className = 'setup-row-label';
    name.textContent = gapAction.label;
    const badge = document.createElement('span');
    badge.className = gapAction.required ? 'setup-badge setup-badge-required' : 'setup-badge';
    badge.textContent = gapAction.required ? 'required' : 'optional';
    head.append(name, badge);

    const why = document.createElement('p');
    why.className = 'setup-row-why';
    why.textContent = gapAction.why || '';

    li.append(head, why);

    if (gapAction.action === 'store') {
      for (const keyName of gapAction.keyNames) {
        li.appendChild(keyField(keyName, keyStoreNames));
      }
      const note = document.createElement('p');
      note.className = 'setup-row-note';
      note.textContent = gapAction.keyNames.length > 1
        ? 'Any one of these is enough.'
        : '';
      if (note.textContent) li.appendChild(note);
    } else {
      const fix = document.createElement('p');
      fix.className = 'setup-row-fix';
      // Not a link and not a button: this is a command to run in a terminal, or
      // a line to add to mythos/.env. Presenting it as something clickable would
      // promise an action this screen cannot perform.
      fix.textContent = gapAction.fix || '';
      li.appendChild(fix);
    }

    return li;
  }

  function keyField(keyName, keyStoreNames) {
    const wrap = document.createElement('div');
    wrap.className = 'setup-field';

    const label = document.createElement('label');
    label.className = 'setup-field-label';
    label.textContent = keyName;
    const inputId = `setup-key-${keyName}`;
    label.setAttribute('for', inputId);

    const input = document.createElement('input');
    // type=password so a shoulder/screen-share does not read the key, and
    // autocomplete off so the browser never offers to remember it.
    input.type = 'password';
    input.id = inputId;
    input.className = 'setup-field-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = keyStoreNames.includes(keyName) ? 'already stored — enter to replace' : 'paste the key';

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
      // Clear the field whatever happened. A stored key must not sit in the DOM
      // waiting for the next screen-share, and a refused one is usually a typo
      // worth retyping rather than editing.
      input.value = '';
      save.disabled = false;
      const outcome = interpretStoreResult(result, thrown);
      status.textContent = outcome.message;
      status.classList.toggle('is-error', !outcome.stored);
      if (outcome.stored) wrap.classList.add('is-stored');
    });

    wrap.append(label, input, save, status);
    return wrap;
  }

  function paint(need) {
    const hasKeyStore = Boolean(bridge && typeof bridge.setKey === 'function');
    const keyStoreNames = (need.keyStoreNames || []);

    overlay = document.createElement('div');
    overlay.className = 'setup-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'setup-title');

    const modal = document.createElement('section');
    modal.className = 'setup-modal glass';

    const title = document.createElement('h1');
    title.className = 'setup-title';
    title.id = 'setup-title';
    title.textContent = 'This machine is not finished yet';

    const lede = document.createElement('p');
    lede.className = 'setup-lede';
    lede.textContent = hasKeyStore
      ? 'These are the pieces missing here. Keys are stored encrypted on this machine and never written to the repo.'
      : 'These are the pieces missing here. This tab cannot store keys — open MYTHOS as the desktop app, or add them to mythos/.env.';

    const requiredList = document.createElement('ul');
    requiredList.className = 'setup-list';
    for (const gap of planGapActions(need.requiredGaps, hasKeyStore)) {
      requiredList.appendChild(row(gap, keyStoreNames));
    }

    modal.append(title, lede, requiredList);

    if (need.optionalGaps && need.optionalGaps.length) {
      const details = document.createElement('details');
      details.className = 'setup-optional';
      const summary = document.createElement('summary');
      summary.textContent = `${need.optionalGaps.length} optional capability gap(s)`;
      const optionalList = document.createElement('ul');
      optionalList.className = 'setup-list';
      for (const gap of planGapActions(need.optionalGaps, hasKeyStore)) {
        optionalList.appendChild(row(gap, keyStoreNames));
      }
      details.append(summary, optionalList);
      modal.appendChild(details);
    }

    const footer = document.createElement('div');
    footer.className = 'setup-footer';

    const restartNote = document.createElement('p');
    restartNote.className = 'setup-restart-note';
    // The single most misleading thing this screen could do is imply a stored key
    // is live. It is not: keys are decrypted into the server child's env at
    // fork() (electron/main.js), so they arrive on the next launch.
    restartNote.textContent = 'Stored keys reach the server on the next launch, not immediately.';

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'setup-dismiss';
    dismiss.textContent = 'Continue anyway';
    dismiss.addEventListener('click', teardown);

    footer.append(restartNote, dismiss);
    modal.appendChild(footer);
    overlay.appendChild(modal);

    overlay.addEventListener('keydown', (e) => {
      // Escape closes. Unlike the auth gate, nothing here is a precondition for
      // the rest of the HUD working.
      if (e.key === 'Escape') teardown();
    });

    root.appendChild(overlay);
    setInert(true);
    releaseTrap = trapFocus(modal);
    const firstInput = modal.querySelector('.setup-field-input');
    if (firstInput) firstInput.focus();
    else dismiss.focus();
  }

  (async () => {
    const status = await probe();
    if (disposed) return;
    const need = deriveSetupNeed({ status });
    if (!need.show) return;
    need.keyStoreNames = (status && status.body && Array.isArray(status.body.keyStoreNames))
      ? status.body.keyStoreNames
      : [];
    paint(need);
  })();

  return {
    dispose() {
      disposed = true;
      teardown();
    },
  };
}
