// overlay-manager.js — translucent glass panels over the HUD. One panel per id
// at a time; a re-click focuses the existing panel. Escape / backdrop / × close.
// Cleanup contract (anti-drift #8): the view's render(mount) return value IS the
// panel's teardown — closing a panel always runs it. Mutating panels fire a
// statsBus refresh on close so the HUD re-syncs /api/stats.

import { getPanel } from './panel-registry.js';
import { emitRefresh } from '../stats-bus.js';

// Elements to shut out of the tab order (and pointer/click) while any panel
// is open. Panels themselves are NOT modal — the HUD stays interactive
// underneath by deliberate design — so this is `inert`, not a focus trap:
// a keyboard user just shouldn't be able to Tab past the panel into the
// canvas/widgets behind it. Native `inert` handles that with zero JS
// event-handling of its own. Missing elements (e.g. in a DOM-free test
// harness) are silently skipped.
const INERT_WHILE_OPEN_IDS = ['widget-root', 'hud-canvas', 'core-orb'];

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function setBackgroundInert(isInert) {
  for (const id of INERT_WHILE_OPEN_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (isInert) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }
}

// opts.onChange(panelId, isOpen) fires whenever a panel opens or closes, by ANY
// route — the header ×, the backdrop, Escape/closeTop, closeAll, or a tool call.
// A chat-bar button that reflects a panel's open state (F7's transcript toggle)
// cannot be kept honest from its own click handler alone: every one of those
// other routes closes the panel without the button ever hearing about it, and
// the button then reports aria-pressed="true" over a panel that is gone.
export function createOverlayManager(root, opts) {
  const onChange = (opts && typeof opts.onChange === 'function') ? opts.onChange : null;
  const open = new Map(); // panelId -> { el, cleanup }
  let zTop = 100;

  function notifyChange(panelId, isOpen) {
    if (!onChange) return;
    // A listener throwing must never leave a panel half-closed.
    try { onChange(panelId, isOpen); } catch { /* observer errors are not the HUD's problem */ }
  }

  function close(panelId) {
    const entry = open.get(panelId);
    if (!entry) return;
    open.delete(panelId);
    if (typeof entry.cleanup === 'function') {
      try { entry.cleanup(); } catch { /* view teardown must never break the HUD */ }
    }
    entry.el.remove();
    if (entry.mutating) emitRefresh(panelId);
    if (open.size === 0) setBackgroundInert(false);
    notifyChange(panelId, false);
  }

  // REMEDIATION P1-5: return how many panels were actually closed — close_panel
  // used to report closed:true unconditionally with no way to verify it.
  function closeTop() {
    let top = null;
    open.forEach((entry, id) => {
      if (!top || Number(entry.el.style.zIndex) > Number(top.entry.el.style.zIndex)) top = { id, entry };
    });
    if (top) { close(top.id); return 1; }
    return 0;
  }

  function closeAll() {
    const ids = [...open.keys()];
    ids.forEach((id) => close(id));
    return ids.length;
  }

  function focus(panelId) {
    const entry = open.get(panelId);
    if (entry) entry.el.style.zIndex = String(++zTop);
  }

  async function openPanel(panelId, payload) {
    if (open.has(panelId)) { focus(panelId); return; }
    const panel = getPanel(panelId);
    if (!panel) return;

    // panel.title is static, but payload.title comes from the open_web tool
    // (web/model-derived) and lands in both an aria-label attribute and element
    // text — so it needs the attribute-safe escape, not just the text one.
    const displayTitle = (payload && payload.title) ? payload.title : panel.title;
    const safeTitleText = escapeHtml(displayTitle);
    const safeTitleAttr = escapeAttr(displayTitle);
    const el = document.createElement('div');
    el.className = 'hud-panel-wrap';
    el.style.zIndex = String(++zTop);
    // xss-safe: all interpolated fields escaped
    el.innerHTML = `
      <div class="hud-panel-backdrop"></div>
      <div class="hud-panel glass" role="dialog" aria-label="${safeTitleAttr}">
        <div class="hud-panel-header">
          <span class="hud-panel-title mono">${safeTitleText}</span>
          <button class="hud-panel-close" aria-label="Close">&times;</button>
        </div>
        <div class="hud-panel-body"><div class="text-faint mono">Loading&hellip;</div></div>
      </div>
    `;
    root.appendChild(el);
    el.querySelector('.hud-panel-close').addEventListener('click', () => close(panelId));
    el.querySelector('.hud-panel-backdrop').addEventListener('click', () => close(panelId));
    el.querySelector('.hud-panel').addEventListener('pointerdown', () => focus(panelId));

    const entry = { el, cleanup: null, mutating: panel.mutating };
    open.set(panelId, entry);
    setBackgroundInert(true); // no-op if already set from an earlier open panel
    // Announced here, before the awaited render below — the panel IS open at
    // this point (it is in the map and on screen as 'Loading…'), and a render
    // that throws still leaves it open showing its failure message.
    notifyChange(panelId, true);

    try {
      const mod = await panel.loader();
      // BUG-019: loading/rendering can outlive close or close-and-reopen.
      // Ownership belongs to this entry, not merely another panel with its id.
      if (open.get(panelId) !== entry) return;
      const body = el.querySelector('.hud-panel-body');
      // xss-safe: static template, no interpolation
      body.innerHTML = '';
      // Pass payload to render() for panels that need it (e.g. web-panel gets
      // the embed URL/cards). Existing views ignore the second arg — backward compatible.
      const result = await mod.render(body, payload);
      if (open.get(panelId) !== entry) {
        if (typeof result === 'function') result();
        return;
      }
      if (typeof result === 'function') entry.cleanup = result;
    } catch (err) {
      if (open.get(panelId) !== entry) return;
      const body = el.querySelector('.hud-panel-body');
      const msg = document.createElement('div');
      msg.className = 'text-faint';
      msg.textContent = `Failed to load this surface: ${err && err.message ? err.message : err}`;
      body.replaceChildren(msg);
    }
    // Focus-on-open (containment-lite, not a full trap — panels stay
    // non-modal by design). Only steps in if the rendered body didn't already
    // claim focus itself (e.g. a panel that autofocuses its own input).
    if (!el.contains(document.activeElement)) el.querySelector('.hud-panel-close')?.focus();
  }

  function onKey(e) {
    if (e.key === 'Escape') closeTop();
  }
  document.addEventListener('keydown', onKey);

  return {
    openPanel,
    close,
    closeTop,
    closeAll,
    isOpen: (id) => open.has(id),
    cleanup() {
      document.removeEventListener('keydown', onKey);
      [...open.keys()].forEach((id) => close(id));
    },
  };
}
