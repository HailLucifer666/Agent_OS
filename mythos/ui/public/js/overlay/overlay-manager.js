// overlay-manager.js — translucent glass panels over the HUD. One panel per id
// at a time; a re-click focuses the existing panel. Escape / backdrop / × close.
// Cleanup contract (anti-drift #8): the view's render(mount) return value IS the
// panel's teardown — closing a panel always runs it. Mutating panels fire a
// statsBus refresh on close so the HUD re-syncs /api/stats.

import { getPanel } from './panel-registry.js';
import { emitRefresh } from '../stats-bus.js';

export function createOverlayManager(root) {
  const open = new Map(); // panelId -> { el, cleanup }
  let zTop = 100;

  function close(panelId) {
    const entry = open.get(panelId);
    if (!entry) return;
    open.delete(panelId);
    if (typeof entry.cleanup === 'function') {
      try { entry.cleanup(); } catch { /* view teardown must never break the HUD */ }
    }
    entry.el.remove();
    if (entry.mutating) emitRefresh(panelId);
  }

  function closeTop() {
    let top = null;
    open.forEach((entry, id) => {
      if (!top || Number(entry.el.style.zIndex) > Number(top.entry.el.style.zIndex)) top = { id, entry };
    });
    if (top) close(top.id);
  }

  function closeAll() {
    [...open.keys()].forEach((id) => close(id));
  }

  function focus(panelId) {
    const entry = open.get(panelId);
    if (entry) entry.el.style.zIndex = String(++zTop);
  }

  async function openPanel(panelId) {
    if (open.has(panelId)) { focus(panelId); return; }
    const panel = getPanel(panelId);
    if (!panel) return;

    const el = document.createElement('div');
    el.className = 'hud-panel-wrap';
    el.style.zIndex = String(++zTop);
    el.innerHTML = `
      <div class="hud-panel-backdrop"></div>
      <div class="hud-panel glass" role="dialog" aria-label="${panel.title}">
        <div class="hud-panel-header">
          <span class="hud-panel-title mono">${panel.title}</span>
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

    try {
      const mod = await panel.loader();
      const body = el.querySelector('.hud-panel-body');
      body.innerHTML = '';
      const result = await mod.render(body);
      if (typeof result === 'function') entry.cleanup = result;
    } catch (err) {
      const body = el.querySelector('.hud-panel-body');
      body.innerHTML = `<div class="text-faint">Failed to load this surface: ${err.message}</div>`;
    }
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
