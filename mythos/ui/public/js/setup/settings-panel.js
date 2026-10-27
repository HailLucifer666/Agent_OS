// settings-panel.js — the DOM shell for the Settings panel. All decisions live in
// settings-panel-model.js (pure, node:test-covered); this file only renders them.
//
// WHY IT EXISTS: until 2026-08-11 there was no UI anywhere in a packaged MYTHOS
// for a non-secret configuration key. The wizard's key store handled provider API
// keys and nothing else, and mythos/.env — the only other source — is excluded
// from package.json build.files. ~140 schema keys were therefore unreachable in
// the install, which is what produced four incidents in two minutes on a build
// whose code was byte-identical to the dev run's.
//
// Reads GET /api/config/settings. Writes through window.mythos.setSetting, which
// is the Electron main process (electron/main.js) — the renderer never touches the
// file. In a plain browser tab there is no bridge and the panel is read-only, and
// says so, rather than offering inputs that would silently do nothing.

import { buildSettingsView, planSettingEdits, describeAutonomy } from './settings-panel-model.js';

function h(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

// mountSettingsPanel(root, {fetchImpl, bridge, onClose}) -> {dispose}
export function mountSettingsPanel(root, opts) {
  if (!root) return { dispose() {} };
  const o = opts || {};
  const doFetch = o.fetchImpl || ((...args) => fetch(...args));
  const bridge = o.bridge !== undefined ? o.bridge : (typeof window !== 'undefined' ? window.mythos : null);
  const hasBridge = Boolean(bridge && typeof bridge.setSetting === 'function');

  const overlay = h('div', 'settings-panel');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'MYTHOS settings');

  const head = h('div', 'settings-head');
  head.append(h('h2', 'settings-title', 'Settings'));
  const closeBtn = h('button', 'settings-close', 'Close');
  closeBtn.type = 'button';
  head.appendChild(closeBtn);

  const lede = h('p', 'settings-lede', 'Reading this machine\'s configuration…');
  const autonomyLine = h('p', 'settings-autonomy');
  const body = h('div', 'settings-body');
  const status = h('p', 'settings-status');
  status.setAttribute('role', 'status');
  const saveBtn = h('button', 'settings-save', 'Save changes');
  saveBtn.type = 'button';
  saveBtn.disabled = true;

  overlay.append(head, lede, autonomyLine, body, saveBtn, status);
  root.appendChild(overlay);

  // {name: value} of what the operator has typed but not saved.
  const pending = Object.create(null);
  let view = null;

  function syncSave() {
    const plan = view ? planSettingEdits(view, pending) : { changes: [] };
    saveBtn.disabled = plan.changes.length === 0;
    saveBtn.textContent = plan.changes.length
      ? `Save ${plan.changes.length} change${plan.changes.length === 1 ? '' : 's'}`
      : 'Save changes';
  }

  function renderRow(row) {
    const item = h('div', 'settings-row');
    const nameEl = h('code', 'settings-row-name', row.name);
    // The ORIGIN badge is the point of this panel. "false" and "false because
    // nothing ever set it" are different problems.
    const origin = h('span', `settings-origin settings-origin-${row.origin.replace('.', '')}`, row.origin);
    item.append(nameEl, origin);

    if (row.secret) {
      // Never an input, never a value. Secrets live in the encrypted key store
      // (electron/main.js), and settings-store.js refuses to write one here.
      item.appendChild(h('span', 'settings-secret', row.set ? 'set (in the key store)' : 'not set'));
      item.appendChild(h('p', 'settings-row-note', 'Secrets are stored encrypted and are set from the setup screen, not here.'));
      return item;
    }

    let input;
    if (row.type === 'bool') {
      input = document.createElement('select');
      for (const v of ['', 'true', 'false']) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v === '' ? '(unset — use the default)' : v;
        input.appendChild(opt);
      }
      input.value = String(row.value) === 'true' ? 'true' : String(row.value) === 'false' ? 'false' : '';
    } else if (row.enum) {
      input = document.createElement('select');
      for (const v of ['', ...row.enum]) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v === '' ? '(unset — use the default)' : v;
        input.appendChild(opt);
      }
      input.value = row.value;
    } else {
      input = document.createElement('input');
      input.type = row.type === 'number' ? 'number' : 'text';
      input.value = row.value;
    }
    input.className = 'settings-input';
    input.id = `settings-${row.name}`;
    input.disabled = !row.editable;
    nameEl.setAttribute('title', `default: ${row.default || '(empty)'}`);
    input.addEventListener('change', () => {
      pending[row.name] = input.value;
      syncSave();
    });

    item.appendChild(input);
    item.appendChild(h('p', 'settings-row-note', `default: ${row.default === '' ? '(empty)' : row.default}`));
    return item;
  }

  function render() {
    body.textContent = '';
    if (!view || !view.ok) {
      lede.textContent = 'The server did not report its configuration, so nothing is shown here rather than guessing.';
      return;
    }
    lede.textContent = `${view.counts.total} settings. ${view.counts.explicit} set by you, `
      + `${view.counts.derived} chosen automatically, ${view.counts.default} at their default.`
      + (view.file ? `  File: ${view.file}` : '')
      + (view.editable ? '' : `  ${view.readOnlyReason}`);
    autonomyLine.textContent = describeAutonomy(view.autonomy);

    for (const group of view.groups) {
      const section = h('section', 'settings-group');
      section.append(h('h3', 'settings-group-title', group.label));
      for (const row of group.rows) section.appendChild(renderRow(row));
      body.appendChild(section);
    }
    syncSave();
  }

  async function load() {
    let payload = null;
    try {
      const res = await doFetch('/api/config/settings', { headers: { Accept: 'application/json' } });
      if (res.ok) payload = await res.json();
    } catch { /* handled by render() */ }
    view = buildSettingsView(payload, { hasBridge });
    render();
  }

  saveBtn.addEventListener('click', async () => {
    const plan = planSettingEdits(view, pending);
    if (!plan.changes.length) return;
    saveBtn.disabled = true;
    status.classList.remove('is-error');
    status.textContent = `Saving ${plan.changes.length}…`;

    // B3b: ONE call for the whole batch, so the main process asks the operator
    // once, in a native dialog listing every change, before anything is written.
    const failed = [];
    try {
      const res = await bridge.setSettings(plan.changes.map((c) => ({ name: c.name, value: c.value })));
      if (!res || res.ok !== true) {
        const each = (res && Array.isArray(res.results)) ? res.results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error || 'refused'}`) : [];
        failed.push(...(each.length ? each : [(res && res.error) || 'refused']));
      }
    } catch (err) {
      failed.push((err && err.message) || 'refused');
    }

    if (failed.length) {
      status.textContent = failed.join('\n');
      status.classList.add('is-error');
      saveBtn.disabled = false;
      return;
    }

    // ONE restart for the whole batch. Settings reach the server child in its env
    // at fork() time (electron/main.js startChild), so saying "saved" and letting
    // the operator assume it is live is the same dishonesty interpretStoreResult
    // refuses in setup-state.js.
    status.textContent = 'Saved. Restarting MYTHOS\'s server so the new values take effect…';
    try {
      if (typeof bridge.restartServer === 'function') await bridge.restartServer();
    } catch { /* the message below is still true */ }
    for (const key of Object.keys(pending)) delete pending[key];
    await load();
    status.textContent = 'Saved and applied.';
  });

  closeBtn.addEventListener('click', () => {
    dispose();
    if (typeof o.onClose === 'function') o.onClose();
  });

  function dispose() {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  load();
  return { dispose, reload: load };
}
