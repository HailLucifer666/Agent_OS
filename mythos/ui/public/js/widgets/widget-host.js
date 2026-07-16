// widget-host.js — mounts every registry widget as a floating glass card in
// #widget-root: drag anywhere, positions persisted to localStorage
// 'mythos.widgets.v1' on pointerup ONLY (never per-move — no write storms).
// Every mount returns a cleanup; host cleanup tears all widgets down (anti-drift #8).
//
// spawnWebWidget(payload) creates a one-off dynamic widget card (not in the
// boot registry) for web content: search results, weather cards, flight cards.
// These have a × close button and are not persisted — close them and they're gone.

import { WIDGETS } from './widget-registry.js';
import { mountWebResult } from './kinds/web-result.js';
import { mountDynamicWidget } from './kinds/dynamic.js';

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

// Shared drag logic — used by both boot widgets and spawned web widgets.
function makeDraggable(card, title) {
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
    const top  = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.dy));
    applyPos(card, { left, top });
  });
  title.addEventListener('pointerup', (e) => {
    if (!drag) return;
    drag = null;
    card.classList.remove('dragging');
    title.releasePointerCapture(e.pointerId);
  });
}

// Shared resize logic — drag the bottom-right corner handle to resize.
// Mirrors makeDraggable's Pointer Events + setPointerCapture pattern.
// stopPropagation on pointerdown prevents the title drag from hijacking.
const MIN_W = 170, MIN_H = 80;
function makeResizable(card, handle) {
  let rz = null;
  handle.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    const rect = card.getBoundingClientRect();
    rz = { sx: e.clientX, sy: e.clientY, w: rect.width, h: rect.height };
    handle.setPointerCapture(e.pointerId);
    card.classList.add('resizing');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!rz) return;
    const w = Math.max(MIN_W, rz.w + (e.clientX - rz.sx));
    const h = Math.max(MIN_H, rz.h + (e.clientY - rz.sy));
    card.style.width = w + 'px';
    card.style.height = h + 'px';
  });
  handle.addEventListener('pointerup', (e) => {
    if (!rz) return;
    rz = null;
    card.classList.remove('resizing');
    handle.releasePointerCapture(e.pointerId);
  });
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
      <div class="widget-resize" aria-label="Resize"></div>
    `;
    applyPos(card, saved[widget.id] || widget.defaultPos);
    // Restore saved size (width/height) if previously resized.
    const sv = saved[widget.id];
    if (sv && sv.width) card.style.width = sv.width + 'px';
    if (sv && sv.height) card.style.height = sv.height + 'px';
    root.appendChild(card);

    const title = card.querySelector('.widget-title');
    makeDraggable(card, title);
    makeResizable(card, card.querySelector('.widget-resize'));
    // Persist position + size for boot widgets (they reload on refresh).
    const persist = () => {
      const rect = card.getBoundingClientRect();
      const positions = loadPositions();
      positions[widget.id] = {
        left: Math.round(rect.left), top: Math.round(rect.top),
        width: Math.round(rect.width), height: Math.round(rect.height),
      };
      savePositions(positions);
    };
    title.addEventListener('pointerup', persist);
    card.querySelector('.widget-resize').addEventListener('pointerup', persist);

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

  // Stash the spawn function on root so app.js can call it via the returned API.
  const spawnedCleanups = [];

  function spawnWebWidget(payload) {
    if (!payload || !payload.widgetType) return;
    const card = document.createElement('div');
    card.className = 'widget-card glass web-widget-card';
    card.dataset.widgetType = payload.widgetType;
    card.innerHTML = `
      <div class="widget-title mono">
        <span>${payload.title || payload.query || 'Web Result'}</span>
        <button class="web-widget-close" aria-label="Close">&times;</button>
      </div>
      <div class="widget-body web-result-body"></div>
      <div class="widget-resize" aria-label="Resize"></div>
    `;
    // Position: stagger so multiple spawned widgets don't overlap exactly.
    const offset = spawnedCleanups.length * 30;
    applyPos(card, { left: 40 + offset, top: 120 + offset });
    root.appendChild(card);

    const title = card.querySelector('.widget-title');
    makeDraggable(card, title);
    makeResizable(card, card.querySelector('.widget-resize'));

    // Close button — tears down and removes.
    // Stop pointerdown propagation so makeDraggable's setPointerCapture
    // doesn't hijack the click away from the button.
    const closeBtn = card.querySelector('.web-widget-close');
    const teardown = () => {
      let idx = spawnedCleanups.indexOf(teardown);
      if (idx !== -1) spawnedCleanups.splice(idx, 1);
      card.remove();
    };
    closeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    closeBtn.addEventListener('click', teardown);

    // Render content via the matching kind module — 'dynamic' (Item 11
    // generative-UI, from the spawn_widget effector) gets its own fixed
    // renderer; every other widgetType keeps going through web-result.js
    // unchanged.
    try {
      if (payload.widgetType === 'dynamic') {
        mountDynamicWidget(card.querySelector('.web-result-body'), payload);
      } else {
        mountWebResult(card.querySelector('.web-result-body'), payload);
      }
    } catch (err) {
      card.querySelector('.web-result-body').innerHTML = `<span class="widget-sub mono">failed: ${err.message}</span>`;
    }
    spawnedCleanups.push(teardown);
  }

  return {
    cleanup: () => { cleanups.forEach((fn) => fn()); spawnedCleanups.forEach((fn) => fn()); },
    spawnWebWidget,
  };
}
