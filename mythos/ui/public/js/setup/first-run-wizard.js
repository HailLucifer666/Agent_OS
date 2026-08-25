// first-run-wizard.js — the screen a brand-new install actually needs.
//
// What was wrong before this file existed:
//   1. The only first-run surface was setup-screen.js, a LIST of gaps titled
//      "This machine is not finished yet". It offered an input box only for keys
//      named inside a REQUIRED gap, so there was no way to enter the providers
//      the operator intended to use — only the ones doctor.js was complaining
//      about.
//   2. There was no way to set a PIN from the product at all (see
//      pin/pin-setup-screen.js).
//   3. Neither surface said what to do afterwards, and a stored key does not
//      reach a running server: keys are decrypted into the child's env at
//      fork() (electron/main.js), so the last step here offers the restart.
//
// Design follows the HUD's existing language rather than inventing a second one:
// the same glass panel, the same accent, the same fadeInUp entry, the shared
// focus trap, textContent everywhere. It reads as one product because the
// tokens are the product's (css/tokens.css), not this screen's.
//
// It is DISMISSIBLE, like the gap screen it replaces on first run: an incomplete
// install still runs, and a modal the operator cannot escape would be worse than
// the gaps it reports. What it must never do is imply something is configured
// that is not — every claim below is one the server confirmed.

import { trapFocus } from '../a11y/focus-trap.js';
import { createKeyField } from './key-field.js';
import { buildProviderCatalog, planGapActions, wizardCanFinish } from './setup-state.js';
import { createPinSetupForm } from '../pin/pin-setup-screen.js';
import { createVoicePicker } from '../voice/voice-picker.js';

const INERT_SELECTOR = '#hud-canvas, #core-orb, #hud-a11y-root, #widget-root, #overlay-root, #confirm-root, #compose-bar, #camera-preview';

const STEPS = [
  { id: 'welcome', title: 'Welcome' },
  // SECOND, before anything is typed by hand (installer parity, 2026-08-11). The
  // operator's fresh install had none of the ~140 non-secret keys that only ever
  // lived in mythos/.env, and none of the identity files that only ever lived in
  // the dev run's vault — which was a different directory entirely, because
  // electron/main.js never called app.setName. Offering the import BEFORE the key
  // and component steps means the rest of the wizard starts from what the operator
  // already has rather than from schema defaults.
  { id: 'import', title: 'Import' },
  { id: 'lock', title: 'Local lock' },
  { id: 'brain', title: 'Provider keys' },
  { id: 'components', title: 'Components' },
  { id: 'finish', title: 'Finish' },
];

// mountFirstRunWizard(root, {status, pinStatus, fetchImpl, bridge, onClose})
//   status    — the parsed GET /api/setup/status body (required; the caller has
//               already probed, so this screen never re-races the server boot)
//   pinStatus — the parsed GET /api/pin/status body, or null if it did not answer
export function mountFirstRunWizard(root, opts) {
  if (!root) return { dispose() {} };
  const o = opts || {};
  const body = o.status || {};
  const pinStatus = o.pinStatus || null;
  const doFetch = o.fetchImpl || ((...args) => fetch(...args));
  const bridge = o.bridge !== undefined ? o.bridge : (typeof window !== 'undefined' ? window.mythos : null);
  const hasKeyStore = Boolean(bridge && typeof bridge.setKey === 'function');

  // Names of keys stored during THIS run, so the finish step can tell the
  // operator what actually landed instead of re-reading a server that will not
  // see them until it restarts.
  const storedThisRun = new Set();
  // Components installed during this run, so the finish step reports what really
  // landed rather than what was ticked.
  const componentsInstalled = new Set();
  let pinWasSet = false;
  // Whether the operator imported from an existing MYTHOS on this run, so the
  // finish step can say that the restart is what makes those settings live.
  let importedFromExisting = false;
  let index = 0;
  // The voice picker mounted on the finish step, and the things that must run
  // once the server child has actually restarted (the picker asks the server what
  // it can speak with, and a key stored in this run only reaches it at that fork).
  let voicePicker = null;
  const restartedHooks = [];

  const catalog = buildProviderCatalog(body, hasKeyStore);
  const storedNames = Array.isArray(body.keyStoreNames) ? body.keyStoreNames : [];

  let overlay = null;
  let releaseTrap = null;
  let inerted = [];
  let stepBody = null;
  let dotEls = [];
  let backBtn = null;
  let nextBtn = null;

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
    // Stops a sample that is still playing — closing the wizard while a voice is
    // mid-sentence should end it, not leave it talking to an empty screen.
    if (voicePicker) { voicePicker.dispose(); voicePicker = null; }
    if (releaseTrap) { releaseTrap(); releaseTrap = null; }
    setInert(false);
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    if (typeof o.onClose === 'function') o.onClose();
  }

  // ---- step bodies ---------------------------------------------------------

  function h(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function stepWelcome() {
    const frag = document.createDocumentFragment();
    frag.append(
      h('h2', 'wiz-step-title', 'Finish setting up MYTHOS'),
      h('p', 'wiz-lede', 'Nothing is configured on this machine yet. Five short steps: bring an existing MYTHOS across if you have one, a local PIN, at least one LLM provider key, whatever optional capabilities you want, then a restart so the server picks it all up.'),
    );

    const list = h('ul', 'wiz-facts');
    const facts = [
      'Keys are encrypted on this machine (safeStorage/DPAPI) and never written into the repo.',
      'The PIN is stored as a salted scrypt hash in the vault, never in plain text.',
      'You can reopen this from the key button in the compose bar at any time.',
    ];
    for (const text of facts) list.appendChild(h('li', null, text));
    frag.appendChild(list);
    return frag;
  }

  // ---- import from an existing MYTHOS ---------------------------------------
  // Installer parity (2026-08-11). The operator installed MYTHOS.exe and got a
  // second, empty brain: ~140 non-secret keys at their schema defaults (mythos/.env
  // is excluded from package.json build.files, and it was the ONLY place that ever
  // set VOICE_S2S_ENABLED, VOICE_TTS_PROVIDER, WAKEWORD_ENABLED, the AETHER_*/
  // DSH_* block and the local tool paths), and a vault with no
  // Identity/boundaries.md, no operator profile or style, no contacts and none of
  // the 8 learned skills. Four incidents in under two minutes followed.
  //
  // The scan is read-only, nothing is copied over an existing file, and no secret
  // VALUE is ever carried — secrets go in the encrypted key store, and their names
  // are listed here so the operator knows what they still have to re-enter.
  function stepImport() {
    const frag = document.createDocumentFragment();
    frag.append(h('h2', 'wiz-step-title', 'Bring your existing setup across'));
    const lede = h('p', 'wiz-lede', 'Looking for another MYTHOS on this machine…');
    frag.appendChild(lede);

    const list = h('ul', 'wiz-cards');
    const status = h('p', 'wiz-restart-status');
    status.setAttribute('role', 'status');
    frag.append(list, status);

    (async () => {
      let payload = null;
      try {
        const res = await doFetch('/api/setup/import/scan', { headers: { Accept: 'application/json' } });
        if (res.ok) payload = await res.json();
      } catch { /* handled below */ }

      if (!payload || !Array.isArray(payload.sources)) {
        // Never a guess: an unanswered probe says so and offers nothing to press.
        lede.textContent = 'The server did not answer the scan, so nothing is offered here. You can skip this step.';
        return;
      }
      if (!payload.sources.length) {
        lede.textContent = 'No other MYTHOS installation or source checkout was found on this machine. Nothing to import — skip ahead.';
        return;
      }

      lede.textContent = 'These were found on this machine. Importing copies non-secret settings and the files that '
        + 'shape who MYTHOS is (boundaries, your profile and style, contacts, learned skills). Nothing already set here is overwritten.';

      for (const source of payload.sources) {
        const card = h('li', 'wiz-card');
        const head = h('div', 'wiz-card-head');
        head.append(h('span', 'wiz-card-label', source.label));
        head.appendChild(h('span', 'wiz-badge', `${source.settingsCount} setting(s)`));
        if (source.vault) head.appendChild(h('span', 'wiz-badge', `${source.vault.identity.length} identity file(s)`));
        card.append(head, h('p', 'wiz-card-why', source.dir));

        if (source.secrets.length) {
          // NAMES, never values. This is the honest half of the import: these are
          // the credentials the operator still has to type in on the next step.
          card.appendChild(h('p', 'wiz-card-fix',
            `Not imported (secrets belong in the encrypted key store): ${source.secrets.join(', ')}`));
        }
        if (source.unknown.length) {
          card.appendChild(h('p', 'wiz-card-fix',
            `Ignored, not settings MYTHOS recognises: ${source.unknown.slice(0, 6).join(', ')}`));
        }

        const rowStatus = h('p', 'wiz-comp-status');
        rowStatus.setAttribute('role', 'status');
        const importBtn = h('button', 'wiz-primary', 'Import from here');
        importBtn.type = 'button';
        importBtn.addEventListener('click', async () => {
          importBtn.disabled = true;
          rowStatus.classList.remove('is-error');
          rowStatus.textContent = 'importing…';
          let result = null;
          let failure = '';
          try {
            const res = await doFetch('/api/setup/import', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({ dir: source.dir }),
            });
            const parsed = await res.json().catch(() => null);
            if (res.ok && parsed) result = parsed;
            else failure = (parsed && parsed.error) || `the server refused the import (HTTP ${res.status})`;
          } catch (err) {
            failure = (err && err.message) || 'the request never completed';
          }

          if (!result) {
            rowStatus.textContent = failure;
            rowStatus.classList.add('is-error');
            importBtn.disabled = false;
            return;
          }
          const settingsCount = result.settings ? result.settings.imported.length : 0;
          const vaultCount = result.vault ? result.vault.copied.length : 0;
          const skipped = (result.settings ? result.settings.skipped.length : 0)
            + (result.vault ? result.vault.skipped.length : 0);
          // "Imported" is not "in effect": settings reach the server in its env at
          // fork() time, exactly like keys. The finish step performs that restart.
          rowStatus.textContent = `Imported ${settingsCount} setting(s) and ${vaultCount} identity file(s)`
            + (skipped ? `; ${skipped} skipped because they are already set here.` : '.')
            + ' They take effect at the restart on the last step.';
          importedFromExisting = true;
          renderFooter();
        });

        card.append(importBtn, rowStatus);
        list.appendChild(card);
      }
    })();

    return frag;
  }

  function stepLock() {
    const frag = document.createDocumentFragment();
    frag.append(
      h('h2', 'wiz-step-title', pinStatus && pinStatus.configured ? 'Replace the local PIN' : 'Set a local PIN'),
      h('p', 'wiz-lede', 'The PIN is asked for when the HUD opens, so someone at this keyboard cannot just start talking to MYTHOS. It is separate from the network token and can be skipped.'),
    );

    if (!pinStatus) {
      // Honest, not optimistic: the status probe failed, so we cannot say
      // whether a PIN exists. The form is still offered — the server is the
      // authority and will refuse if it disagrees.
      frag.appendChild(h('p', 'wiz-warn', 'The server did not report PIN state. Setting one may fail; nothing changes until it confirms.'));
    }

    const form = createPinSetupForm({
      fetchImpl: doFetch,
      configured: Boolean(pinStatus && pinStatus.configured),
      hasWindowsHello: pinStatus ? Boolean(pinStatus.hasWindowsHello) : undefined,
      onDone: () => { pinWasSet = true; renderFooter(); },
    });
    frag.appendChild(form.el);
    return frag;
  }

  function providerCard(row) {
    const card = h('li', 'wiz-card');
    const head = h('div', 'wiz-card-head');
    head.append(h('span', 'wiz-card-label', row.label));

    // Two independent facts, never merged into one badge: whether the
    // requirement is satisfied, and whether it is required at all.
    const state = h('span', row.ok ? 'wiz-badge wiz-badge-ok' : 'wiz-badge wiz-badge-gap', row.ok ? 'configured' : 'not set');
    head.appendChild(state);
    if (row.required) head.appendChild(h('span', 'wiz-badge wiz-badge-required', 'required'));
    card.append(head, h('p', 'wiz-card-why', row.why || ''));

    if (row.action === 'store') {
      if (row.keyNames.length > 1) {
        card.appendChild(h('p', 'wiz-card-note', 'Any one of these is enough — add more for fallback.'));
      }
      for (const keyName of row.keyNames) {
        card.appendChild(createKeyField({
          keyName,
          storedNames,
          bridge,
          onStored: (name) => { storedThisRun.add(name); renderFooter(); },
        }));
      }
    } else {
      // No key store (a plain browser tab) or an asset row: describe the fix
      // rather than showing an input that would silently do nothing.
      card.appendChild(h('p', 'wiz-card-fix', row.fix || ''));
    }
    return card;
  }

  function stepBrain() {
    const frag = document.createDocumentFragment();
    frag.append(
      h('h2', 'wiz-step-title', 'Provider keys'),
      h('p', 'wiz-lede', hasKeyStore
        ? 'Paste the keys you intend to use. Every provider is listed, not only the missing ones, so you can add fallbacks now instead of hunting for this screen later.'
        : 'This is a browser tab, which has no key store. Open MYTHOS as the desktop app to save keys here, or put them in mythos/.env.'),
    );

    const required = catalog.filter((r) => r.required);
    const optional = catalog.filter((r) => !r.required);

    const list = h('ul', 'wiz-cards');
    for (const row of required) list.appendChild(providerCard(row));
    frag.appendChild(list);

    if (optional.length) {
      const details = document.createElement('details');
      details.className = 'wiz-more';
      details.appendChild(h('summary', null, `${optional.length} more provider${optional.length === 1 ? '' : 's'} (optional)`));
      const moreList = h('ul', 'wiz-cards');
      for (const row of optional) moreList.appendChild(providerCard(row));
      details.appendChild(moreList);
      frag.appendChild(details);
    }
    return frag;
  }

  // The components step. Pre-checked from the choices made on the installer's
  // own component page (build/installer.nsh wrote them to
  // %APPDATA%\MYTHOS\install-selection.json; routes/components.js reads them),
  // and it INSTALLS here rather than in NSIS, because this is the only place a
  // 60-second download can show progress and a failure can be retried.
  function stepComponents() {
    const frag = document.createDocumentFragment();
    frag.append(h('h2', 'wiz-step-title', 'Components'));

    const lede = h('p', 'wiz-lede', 'Loading what this machine has…');
    frag.appendChild(lede);

    const list = h('ul', 'wiz-cards');
    const installBtn = h('button', 'wiz-primary', 'Install selected');
    installBtn.type = 'button';
    installBtn.disabled = true;
    const status = h('p', 'wiz-restart-status');
    status.setAttribute('role', 'status');

    // Also list the gaps this step CANNOT act on (pc-child missing means a
    // broken clone) so they are visible rather than silently absent from a
    // screen titled "Components". Piper used to be listed here for want of an
    // installer; it has a real one now and appears as a checkbox like the rest.
    const notAutomated = h('div', 'wiz-manual');

    frag.append(list, installBtn, status, notAutomated);

    (async () => {
      let payload = null;
      try {
        const res = await doFetch('/api/setup/components', { headers: { Accept: 'application/json' } });
        if (res.ok) payload = await res.json();
      } catch { /* handled below */ }

      if (!payload || !Array.isArray(payload.components)) {
        // Never a guess: an unanswered probe says so and offers nothing to press.
        lede.textContent = 'The server did not report component state, so nothing can be installed from here yet. Reopen this from the key button in the compose bar once MYTHOS is running.';
        return;
      }

      lede.textContent = payload.selectionSource === 'installer'
        ? 'Pre-selected from the choices you made in the installer. Anything already present is unchecked.'
        : 'Pick what to set up now. Each one is a download or a local install, and MYTHOS runs without them by taking a fallback.';

      const boxes = [];
      for (const row of payload.components) {
        const card = h('li', 'wiz-card');
        const head = h('div', 'wiz-card-head');

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'wiz-check';
        box.id = `wiz-comp-${row.id}`;
        box.checked = row.selected === true;
        box.disabled = row.available === false || row.installed === true;

        const label = document.createElement('label');
        label.className = 'wiz-card-label';
        label.setAttribute('for', box.id);
        label.textContent = row.label;

        head.append(box, label);
        if (row.installed === true) head.appendChild(h('span', 'wiz-badge wiz-badge-ok', 'installed'));
        else if (row.installed === false) head.appendChild(h('span', 'wiz-badge wiz-badge-gap', 'not installed'));

        card.append(head, h('p', 'wiz-card-why', row.note || ''));
        if (row.available === false && row.unavailableReason) {
          card.appendChild(h('p', 'wiz-card-fix', row.unavailableReason));
        }

        const rowStatus = h('p', 'wiz-comp-status');
        rowStatus.setAttribute('role', 'status');
        card.appendChild(rowStatus);

        list.appendChild(card);
        boxes.push({ row, box, rowStatus });
      }

      const selectedIds = () => boxes.filter((b) => b.box.checked && !b.box.disabled).map((b) => b.row.id);
      const syncButton = () => { installBtn.disabled = selectedIds().length === 0; };
      boxes.forEach((b) => b.box.addEventListener('change', syncButton));
      syncButton();

      installBtn.addEventListener('click', async () => {
        const ids = selectedIds();
        if (!ids.length) return;
        installBtn.disabled = true;
        boxes.forEach((b) => { b.box.disabled = true; });
        status.classList.remove('is-error');
        // Named, not "Installing…": Hermes can take minutes and a silent screen
        // reads as a hang.
        status.textContent = `Installing ${ids.length} component(s). Hermes and adb can take several minutes — this screen stays open.`;
        boxes.filter((b) => ids.includes(b.row.id)).forEach((b) => { b.rowStatus.textContent = 'installing…'; });

        let results = null;
        let failure = '';
        try {
          const res = await doFetch('/api/setup/components/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ ids }),
          });
          const parsed = await res.json().catch(() => null);
          if (res.ok && parsed && Array.isArray(parsed.results)) results = parsed.results;
          else failure = (parsed && parsed.error) || `the server refused the install (HTTP ${res.status})`;
        } catch (err) {
          failure = (err && err.message) || 'the request never completed';
        }

        if (!results) {
          status.textContent = failure;
          status.classList.add('is-error');
          boxes.forEach((b) => { b.box.disabled = b.row.available === false || b.row.installed === true; });
          syncButton();
          return;
        }

        let failed = 0;
        for (const result of results) {
          const entry = boxes.find((b) => b.row.id === result.id);
          if (!entry) continue;
          if (result.ok) {
            entry.rowStatus.textContent = 'installed';
            entry.rowStatus.classList.remove('is-error');
            componentsInstalled.add(result.id);
          } else {
            failed += 1;
            // The installer's own last lines, not a generic "failed" — that is
            // the difference between a retry and a shrug.
            entry.rowStatus.textContent = result.error || 'failed';
            entry.rowStatus.classList.add('is-error');
            entry.box.disabled = false;
          }
        }
        status.textContent = failed
          ? `${results.length - failed} installed, ${failed} failed. Fix the cause and press Install again.`
          : 'Done. All selected components installed.';
        status.classList.toggle('is-error', failed > 0);
        syncButton();
        renderFooter();
      });

      // Gaps this step cannot fix, listed rather than hidden.
      const assets = Array.isArray(body.assets) ? body.assets.filter((r) => r && r.ok === false) : [];
      const manual = planGapActions(assets, false).filter((g) => !payload.components.some((c) => c.id === g.id));
      if (manual.length) {
        notAutomated.appendChild(h('p', 'wiz-lede', 'These have no installer here and must be done by hand:'));
        const manualList = h('ul', 'wiz-cards');
        for (const gap of manual) {
          const card = h('li', 'wiz-card');
          const head = h('div', 'wiz-card-head');
          head.append(h('span', 'wiz-card-label', gap.label));
          head.appendChild(h('span', gap.required ? 'wiz-badge wiz-badge-required' : 'wiz-badge', gap.required ? 'required' : 'optional'));
          card.append(head, h('p', 'wiz-card-why', gap.why || ''), h('p', 'wiz-card-fix', gap.fix || ''));
          manualList.appendChild(card);
        }
        notAutomated.appendChild(manualList);
      }
    })();

    return frag;
  }

  function stepFinish() {
    const frag = document.createDocumentFragment();
    frag.append(h('h2', 'wiz-step-title', 'One restart to apply'));

    const summary = h('ul', 'wiz-facts');
    summary.appendChild(h('li', null, storedThisRun.size
      ? `Stored on this machine now: ${Array.from(storedThisRun).join(', ')}.`
      : 'No key was stored in this run.'));
    summary.appendChild(h('li', null, componentsInstalled.size
      ? `Components installed: ${Array.from(componentsInstalled).join(', ')}.`
      : 'No component was installed in this run.'));
    // Which voice the operator will actually hear, derived from the same rule the
    // server uses (src/core/config/voice-defaults.js) rather than asserted. Same
    // honesty rule as interpretStoreResult: a key stored a moment ago is not live
    // until the restart below, so this says "after the restart", never "now".
    const hasGoogleKey = storedThisRun.has('GOOGLE_API_KEY') || storedNames.includes('GOOGLE_API_KEY');
    summary.appendChild(h('li', null, hasGoogleKey
      ? 'Replies will speak in the Gemini voice (Aoede) after the restart below — pick a different one there if you prefer.'
      : 'Replies will speak in the local voice — or the browser voice if no local engine is installed. Store GOOGLE_API_KEY to get the Gemini voices instead.'));
    summary.appendChild(h('li', null, pinWasSet
      ? 'A PIN is set — it is asked for the next time the HUD opens.'
      : 'No PIN was set. Anyone at this keyboard can use the HUD.'));
    if (importedFromExisting) {
      summary.appendChild(h('li', null,
        'Settings and identity files were imported from an existing MYTHOS. Like keys, the settings reach the server at the restart below.'));
    }
    frag.appendChild(summary);

    const verdict = wizardCanFinish(catalog, storedThisRun);
    if (!verdict.ok) frag.appendChild(h('p', 'wiz-warn', verdict.reason));

    // The way into every OTHER setting (installer parity, 2026-08-11). Until this
    // existed, a packaged install had no UI at all for a non-secret schema key —
    // the wizard's key store only ever handled provider API keys, and mythos/.env
    // does not ship. ~140 keys were unreachable, which is what left the install
    // running on defaults it never told anyone about.
    const settingsBtn = h('button', 'wiz-secondary', 'Open all settings…');
    settingsBtn.type = 'button';
    settingsBtn.addEventListener('click', async () => {
      settingsBtn.disabled = true;
      try {
        const mod = await import('./settings-panel.js');
        mod.mountSettingsPanel(document.body, {
          fetchImpl: doFetch,
          bridge,
          onClose: () => { settingsBtn.disabled = false; },
        });
      } catch (err) {
        settingsBtn.disabled = false;
        frag.appendChild(h('p', 'wiz-warn', `The settings panel could not be opened: ${(err && err.message) || 'unknown error'}`));
      }
    });
    frag.appendChild(settingsBtn);

    frag.appendChild(h('p', 'wiz-lede', 'Keys are handed to the server when its process starts, so a key stored a moment ago is not live yet. Restarting the server child applies them without closing the HUD.'));

    const canRestart = Boolean(bridge && typeof bridge.restartServer === 'function');
    if (canRestart) {
      const restart = h('button', 'wiz-primary', 'Restart server now');
      restart.type = 'button';
      const status = h('p', 'wiz-restart-status');
      status.setAttribute('role', 'status');
      restart.addEventListener('click', async () => {
        restart.disabled = true;
        status.textContent = 'Restarting the server child…';
        let ok = false;
        let message = '';
        try {
          const res = await bridge.restartServer();
          ok = Boolean(res && res.ok);
          message = (res && typeof res.error === 'string') ? res.error : '';
        } catch (err) {
          message = (err && err.message) || 'the main process refused the restart';
        }
        restart.disabled = false;
        status.textContent = ok
          ? 'Server restarted. Your keys are in its environment now.'
          : (message || 'The restart failed — close and reopen MYTHOS instead.');
        status.classList.toggle('is-error', !ok);
        if (ok) restartedHooks.forEach((fn) => { try { fn(); } catch (_) { /* a hook must not break the restart report */ } });
      });
      frag.append(restart, status);
      // The picker lists what the server can speak with RIGHT NOW, so a key
      // stored seconds ago does not appear in it until the restart above has
      // actually happened — hence the reload on success rather than on mount.
      restartedHooks.push(() => { if (voicePicker) voicePicker.reload(); });
    } else {
      frag.appendChild(h('p', 'wiz-card-fix', 'This build cannot restart the server from here — close MYTHOS and open it again.'));
    }

    frag.appendChild(h('h3', 'wiz-sub-title', 'Voice'));
    frag.appendChild(h('p', 'wiz-lede', 'Press ▶ to hear a voice, then "use" to keep it. Changing it later lives behind the speaker button on the compose bar.'));
    const voiceMount = h('div', 'wiz-voice-mount');
    frag.appendChild(voiceMount);
    if (voicePicker) voicePicker.dispose();
    voicePicker = createVoicePicker(voiceMount, { fetchImpl: doFetch, compact: true });
    return frag;
  }

  const RENDERERS = {
    welcome: stepWelcome,
    import: stepImport,
    lock: stepLock,
    brain: stepBrain,
    components: stepComponents,
    finish: stepFinish,
  };

  // ---- shell --------------------------------------------------------------

  function renderStep() {
    stepBody.textContent = '';
    stepBody.appendChild(RENDERERS[STEPS[index].id]());
    stepBody.scrollTop = 0;
    dotEls.forEach((dot, i) => {
      dot.classList.toggle('is-current', i === index);
      dot.classList.toggle('is-done', i < index);
      dot.setAttribute('aria-current', i === index ? 'step' : 'false');
    });
    renderFooter();
    const focusTarget = stepBody.querySelector('input, button, summary') || nextBtn;
    if (focusTarget) focusTarget.focus();
  }

  function renderFooter() {
    if (!nextBtn) return;
    const last = index === STEPS.length - 1;
    backBtn.disabled = index === 0;
    nextBtn.textContent = last ? 'Done' : 'Next';
    // The skip label is the honest one for a step the operator has not acted on:
    // calling it "Next" on the PIN step would imply the PIN got set.
    if (!last && STEPS[index].id === 'lock' && !pinWasSet) nextBtn.textContent = 'Skip for now';
  }

  function paint() {
    overlay = document.createElement('div');
    overlay.className = 'wiz-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'wiz-title');

    const modal = h('section', 'wiz-modal glass');

    const header = h('header', 'wiz-header');
    const title = h('h1', 'wiz-title', 'MYTHOS · first run');
    title.id = 'wiz-title';

    const rail = h('ol', 'wiz-rail');
    dotEls = STEPS.map((step, i) => {
      const li = h('li', 'wiz-dot');
      li.append(h('span', 'wiz-dot-mark', String(i + 1)), h('span', 'wiz-dot-label', step.title));
      rail.appendChild(li);
      return li;
    });
    header.append(title, rail);

    stepBody = h('div', 'wiz-body');

    const footer = h('footer', 'wiz-footer');
    backBtn = h('button', 'wiz-ghost', 'Back');
    backBtn.type = 'button';
    backBtn.addEventListener('click', () => { if (index > 0) { index -= 1; renderStep(); } });

    nextBtn = h('button', 'wiz-primary', 'Next');
    nextBtn.type = 'button';
    nextBtn.addEventListener('click', () => {
      if (index < STEPS.length - 1) { index += 1; renderStep(); } else teardown();
    });

    const later = h('button', 'wiz-ghost wiz-later', 'Do this later');
    later.type = 'button';
    later.addEventListener('click', teardown);

    footer.append(later, backBtn, nextBtn);
    modal.append(header, stepBody, footer);
    overlay.appendChild(modal);
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') teardown(); });

    root.appendChild(overlay);
    setInert(true);
    releaseTrap = trapFocus(modal);
    renderStep();
  }

  paint();
  return { dispose: teardown };
}
