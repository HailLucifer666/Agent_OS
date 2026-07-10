// widget-host.js — mounts every registry widget as a floating glass card in
// #widget-root: drag anywhere, positions persisted to localStorage
// 'mythos.widgets.v1' on pointerup ONLY (never per-move — no write storms).
// Every mount returns a cleanup; host cleanup tears all widgets down (anti-drift #8).

import { WIDGETS } from './widget-registry.js';

const STORE_KEY = 'mythos.widgets.v1';

function loadPositions() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}

function savePositions(positions) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(positions)); } catch { /* quota — non-fatal */ }
}

function applyPos(card, pos) {
  card.style.left = pos.left !== undefined ? `${pos.left}px` : 'auto';
  card.style.top = pos.top !== undefined ? `${pos.top}px` : 'auto';
  card.style.right = pos.right !== undefined ? `${pos.right}px` : 'auto';
  card.style.bottom = pos.bottom !== undefined ? `${pos.bottom}px` : 'auto';
}

export function mountWidgets(root, ctx) {
  const saved = loadPositions();
  const cleanups = [];

  WIDGETS.forEach((widget) => {
    const card = document.createElement('div');
    card.className = 'widget-card glass';
    card.dataset.widgetId = widget.id;
    card.innerHTML = `
      <div class="widget-title mono">${widget.title}</div>
      <div class="widget-body"></div>
    `;
    applyPos(card, saved[widget.id] || widget.defaultPos);
    root.appendChild(card);

    // drag — pointer events on the title bar; converts to absolute left/top on
    // first drag so right/bottom-anchored defaults become free-floating.
    const title = card.querySelector('.widget-title');
    let drag = null;
    title.addEventListener('pointerdown', (e) => {
      const rect = card.getBoundingClientRect();
      drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      title.setPointerCapture(e.pointerId);
      card.classList.add('dragging');
    });
    title.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const left = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - drag.dx));
      const top = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.dy));
      applyPos(card, { left, top });
    });
    title.addEventListener('pointerup', (e) => {
      if (!drag) return;
      drag = null;
      card.classList.remove('dragging');
      title.releasePointerCapture(e.pointerId);
      const rect = card.getBoundingClientRect();
      const positions = loadPositions();
      positions[widget.id] = { left: Math.round(rect.left), top: Math.round(rect.top) };
      savePositions(positions); // write on pointerup only
    });

    let cleanup = null;
    try {
      cleanup = widget.mount(card.querySelector('.widget-body'), ctx);
    } catch (err) {
      card.querySelector('.widget-body').innerHTML = `<span class="widget-sub mono">failed: ${err.message}</span>`;
    }
    cleanups.push(() => {
      if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
      card.remove();
    });
  });

  return () => cleanups.forEach((fn) => fn());
}
