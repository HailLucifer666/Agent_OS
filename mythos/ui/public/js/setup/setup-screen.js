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
  chooseSetupScreen,
  shouldRetryProbe,
  retryDelayMs,
} from './setup-state.js';
import { createKeyField } from './key-field.js';
import { mountFirstRunWizard } from './first-run-wizard.js';

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
        li.appendChild(createKeyField({ keyName, storedNames: keyStoreNames, bridge }));
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

  async function probePin() {
    try {
      const res = await doFetch('/api/pin/status', { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // MAX_PROBES exists because of the real first-run failure: in the packaged
  // .exe the BrowserWindow loads before the fork()ed server child is listening,
  // so the single boot-time probe returned null, deriveSetupNeed said
  // 'indeterminate' — correctly, it knew nothing — and the screen was never
  // shown again. A fresh install therefore never asked for a key. Retrying only
  // the indeterminate case keeps the honesty rule (never paint on a guess) while
  // removing the race: an answer that arrives four seconds late still counts.
  const MAX_PROBES = 12;

  async function resolveNeed() {
    for (let attempt = 1; attempt <= MAX_PROBES; attempt += 1) {
      const status = await probe();
      if (disposed) return null;
      const need = deriveSetupNeed({ status });
      if (!shouldRetryProbe(need.reason, attempt, MAX_PROBES)) {
        return { need, status };
      }
      await sleep(retryDelayMs(attempt));
      if (disposed) return null;
    }
    return null;
  }

  let wizard = null;

  function openWizard(statusBody, pinStatus) {
    if (wizard) wizard.dispose();
    wizard = mountFirstRunWizard(root, {
      status: statusBody,
      pinStatus,
      fetchImpl: doFetch,
      bridge,
      onClose() { wizard = null; },
    });
  }

  (async () => {
    const resolved = await resolveNeed();
    if (!resolved || disposed) return;
    const { need, status } = resolved;
    const statusBody = (status && status.body) || {};
    need.keyStoreNames = Array.isArray(statusBody.keyStoreNames) ? statusBody.keyStoreNames : [];

    const pinStatus = await probePin();
    if (disposed) return;

    const screen = chooseSetupScreen({
      need,
      keyStoreNames: need.keyStoreNames,
      pinConfigured: Boolean(pinStatus && pinStatus.configured),
    });

    if (screen === 'wizard') openWizard(statusBody, pinStatus);
    else if (screen === 'gaps') paint(need);
  })();

  return {
    // open() — the manual entry point (the key button in the compose bar). The
    // wizard is not only for a fresh machine: "add the provider I just signed up
    // for" is the same flow, and the gap screen could never serve it because it
    // showed inputs for required gaps only.
    async open() {
      if (disposed) return;
      teardown();
      const status = await probe();
      const pinStatus = await probePin();
      if (disposed) return;
      openWizard((status && status.body) || {}, pinStatus);
    },
    dispose() {
      disposed = true;
      if (wizard) { wizard.dispose(); wizard = null; }
      teardown();
    },
  };
}
