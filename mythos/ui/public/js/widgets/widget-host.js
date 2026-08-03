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
import { h } from '../dom.js';

const STORE_KEY = 'mythos.widgets.v1';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Mount failures render through h() rather than innerHTML: err.message can carry
// arbitrary text (including a URL or response body from a widget's own fetch),
// and a text node needs no escaping at all.
function failureNode(err) {
  return h('span', { class: 'widget-sub mono' }, `failed: ${err && err.message ? err.message : err}`);
}

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

// Update one widget's stored entry without clobbering the rest of it —
// position, size, and the hidden flag are written by different code paths.
function patchStored(id, patch) {
  const positions = loadPositions();
  positions[id] = Object.assign({}, positions[id], patch);
  savePositions(positions);
}

export function mountWidgets(root, ctx) {
  const saved = loadPositions();
  const cleanups = [];
  const cards = new Map(); // boot widget id -> card element

  WIDGETS.forEach((widget) => {
    const card = document.createElement('div');
    card.className = 'widget-card glass';
    card.dataset.widgetId = widget.id;
    // xss-safe: the only interpolation is widget.title, which comes from the
    // hardcoded WIDGETS registry in this repo — never from the server or model.
    // Spawned (payload-driven) titles take the escaped path further down.
    card.innerHTML = `
      <div class="widget-title mono">
        <span>${escapeHtml(widget.title)}</span>
        <button class="web-widget-close widget-hide" aria-label="Hide">&times;</button>
      </div>
      <div class="widget-body"></div>
      <div class="widget-resize" aria-label="Resize"></div>
    `;
    applyPos(card, saved[widget.id] || widget.defaultPos);
    // Restore saved size (width/height) if previously resized.
    const sv = saved[widget.id];
    if (sv && sv.width) card.style.width = sv.width + 'px';
    if (sv && sv.height) card.style.height = sv.height + 'px';
    // Restore hidden state — voice "open <widget>" (or the ✕ hover button)
    // toggles it; nothing is ever unrecoverable.
    //
    // `defaultHidden` covers widgets that exist for when you go looking (SYSTEM,
    // CORES, GPU, SENSORS, TERMINAL, MEMORY, VOICE) rather than ones worth a
    // permanent corner. Without it, adding those seven put 18 cards on screen at
    // boot, overlapping each other and burying the orb. It is only a DEFAULT:
    // the stored flag wins in both directions, so once the operator shows one it
    // stays shown, and `setWidgetHidden` records the choice the same as always.
    const hiddenDefault = sv && typeof sv.hidden === 'boolean' ? sv.hidden : Boolean(widget.defaultHidden);
    if (hiddenDefault) card.classList.add('widget-hidden');
    root.appendChild(card);
    cards.set(widget.id, card);

    const title = card.querySelector('.widget-title');
    makeDraggable(card, title);
    makeResizable(card, card.querySelector('.widget-resize'));
    // Persist position + size for boot widgets (they reload on refresh).
    const persist = () => {
      const rect = card.getBoundingClientRect();
      patchStored(widget.id, {
        left: Math.round(rect.left), top: Math.round(rect.top),
        width: Math.round(rect.width), height: Math.round(rect.height),
      });
    };
    title.addEventListener('pointerup', persist);
    card.querySelector('.widget-resize').addEventListener('pointerup', persist);

    // Hover ✕ — hides (never destroys) the widget; same stopPropagation
    // pattern as the spawned web-widget close button so drag doesn't hijack.
    const hideBtn = card.querySelector('.widget-hide');
    hideBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    hideBtn.addEventListener('click', () => setWidgetHidden(widget.id, true));

    let cleanup = null;
    try {
      cleanup = widget.mount(card.querySelector('.widget-body'), ctx);
    } catch (err) {
      card.querySelector('.widget-body').replaceChildren(failureNode(err));
    }
    cleanups.push(() => {
      if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
      card.remove();
    });
  });

  function setWidgetHidden(id, hidden) {
    const card = cards.get(id);
    if (!card) return;
    card.classList.toggle('widget-hidden', hidden);
    patchStored(id, { hidden: !!hidden });
  }

  // Narrow-viewport auto-hide (Phase 6 responsive, see css/tokens/semantic.css
  // for the 600px "narrow" tier). Hides non-essential widgets so they don't
  // fight the compose bar/HUD canvas for room below 600px, WITHOUT touching
  // a user's own explicit hidden choice (hover ✕ or a voice command, both of
  // which go through setWidgetHidden -> patchStored above). autoHidden tracks
  // only the ids THIS mechanism hid, so: a widget the user hid stays hidden
  // through a narrow round-trip (never added to autoHidden, so widening never
  // touches it), and a widget the user never hid reappears when widened back
  // out (removed from autoHidden, class cleared).
  const NARROW_QUERY = '(max-width: 600px)';
  const AUTO_HIDE_EXEMPT = new Set(['clock']);
  const autoHidden = new Set();

  function isUserHidden(id) {
    const stored = loadPositions()[id];
    return !!(stored && stored.hidden);
  }

  function applyNarrowAutoHide(isNarrow) {
    cards.forEach((card, id) => {
      if (AUTO_HIDE_EXEMPT.has(id)) return;
      if (isNarrow) {
        if (isUserHidden(id) || autoHidden.has(id)) return;
        autoHidden.add(id);
        card.classList.add('widget-hidden'); // transient — never persisted
      } else if (autoHidden.has(id)) {
        autoHidden.delete(id);
        if (!isUserHidden(id)) card.classList.remove('widget-hidden');
      }
    });
  }

  const narrowQuery = window.matchMedia(NARROW_QUERY);
  applyNarrowAutoHide(narrowQuery.matches);
  const onNarrowChange = (e) => applyNarrowAutoHide(e.matches);
  narrowQuery.addEventListener('change', onNarrowChange);

  // Voice-driven widget command (manage_widget effector → 'widget-command'
  // WS broadcast → app.js). Payload is pre-resolved server-side:
  // {mode:'close'|'open', targets:[ids]} or {mode:'solo', targets:[keepId]}.
  function applyWidgetCommand(payload) {
    if (!payload || !payload.mode || !Array.isArray(payload.targets)) return;
    if (payload.mode === 'solo') {
      const keep = payload.targets[0];
      cards.forEach((_, id) => setWidgetHidden(id, id !== keep));
      return;
    }
    const hidden = payload.mode === 'close';
    payload.targets.forEach((id) => setWidgetHidden(id, hidden));
  }

  // Stash the spawn function on root so app.js can call it via the returned API.
  const spawnedCleanups = [];
  // BUG-081 (Stage 7): widgetType -> teardown, so a second open_web call for
  // the SAME surface reuses/replaces it instead of stacking a new card. Only
  // tracked for non-'dynamic' types — Item 11's generative-UI cards are
  // deliberately multi-instance (several independent stat panels can be
  // live at once), so 'dynamic' keeps the old stack-a-new-card behavior.
  const spawnedByType = new Map();

  function spawnWebWidget(payload) {
    if (!payload || !payload.widgetType) return;
    const dedupeKey = payload.widgetType !== 'dynamic' ? payload.widgetType : null;
    if (dedupeKey && spawnedByType.has(dedupeKey)) {
      spawnedByType.get(dedupeKey)(); // tear down the stale card for this surface first
    }
    const card = document.createElement('div');
    card.className = 'widget-card glass web-widget-card';
    card.dataset.widgetType = payload.widgetType;
    // payload.title/query come from the open_web tool — web search results and
    // model output — so the title is escaped here even though the rest of this
    // template is static.
    // xss-safe: all interpolated fields escaped
    card.innerHTML = `
      <div class="widget-title mono">
        <span>${escapeHtml(payload.title || payload.query || 'Web Result')}</span>
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
      if (dedupeKey && spawnedByType.get(dedupeKey) === teardown) spawnedByType.delete(dedupeKey);
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
      card.querySelector('.web-result-body').replaceChildren(failureNode(err));
    }
    spawnedCleanups.push(teardown);
    if (dedupeKey) spawnedByType.set(dedupeKey, teardown);
  }

  // REMEDIATION P1-5: close_panel was structurally unable to reach floating
  // widgets (search/weather/flights/image cards spawned by open_web) — it
  // only ever touched overlay panels. all:true tears down every spawned
  // widget; all:false (the default "close the top one") closes the
  // most-recently-spawned card, mirroring overlay-manager's closeTop().
  // Returns the real count closed so close_panel can report it honestly.
  function closeSpawnedWidgets(all) {
    if (!spawnedCleanups.length) return 0;
    if (all) {
      const count = spawnedCleanups.length;
      spawnedCleanups.slice().forEach((fn) => fn());
      return count;
    }
    spawnedCleanups[spawnedCleanups.length - 1]();
    return 1;
  }

  return {
    cleanup: () => {
      narrowQuery.removeEventListener('change', onNarrowChange);
      cleanups.forEach((fn) => fn());
      spawnedCleanups.forEach((fn) => fn());
    },
    spawnWebWidget,
    applyWidgetCommand,
    closeSpawnedWidgets,
  };
}
