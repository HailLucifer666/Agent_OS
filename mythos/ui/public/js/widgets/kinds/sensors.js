// sensors.js — what the BROWSER can honestly tell us about the machine the HUD
// is running on. Every row here is a real `navigator.*` reading; there is no
// server involvement at all (no /api route exposes any of this).
//
// The honesty rule matters more here than anywhere else in the widget set,
// because these APIs are the ones browsers most aggressively gate. deviceMemory
// is Chromium-only. connection is Chromium-only. getBattery() was removed from
// Firefox entirely and is permission-gated elsewhere. When a reading is absent
// this renders the word "unavailable" — never a 0, never a dash, never a
// plausible-looking default. A fabricated 8 GB is worse than an admitted gap.
//
// Ported from design/mythos-living-core.html's "Sensors" panel, one of only
// three widgets in that mockup reading real data rather than its SIM object.

import { h, keyedList, cleanupBag } from '../../dom.js';

const UNAVAILABLE = 'unavailable';

// Pure: takes navigator/window-shaped objects, returns display rows. Exported
// so the absent-API branches are node-testable without a browser.
export function readSensors(nav, win) {
  const n = nav || {};
  const w = win || {};
  const rows = [];

  rows.push({
    key: 'cores',
    label: 'cpu threads',
    value: Number.isFinite(n.hardwareConcurrency) ? String(n.hardwareConcurrency) : UNAVAILABLE,
  });

  // deviceMemory is a coarse power-of-two GB bucket, not a precise figure —
  // label it approximate so nobody reads it as the real installed total.
  rows.push({
    key: 'memory',
    label: 'device memory',
    value: Number.isFinite(n.deviceMemory) ? `~${n.deviceMemory} GB` : UNAVAILABLE,
  });

  const conn = n.connection;
  rows.push({
    key: 'network',
    label: 'network',
    value: conn && conn.effectiveType
      ? `${conn.effectiveType}${Number.isFinite(conn.downlink) ? ` · ${conn.downlink} Mb/s` : ''}`
      : UNAVAILABLE,
  });

  rows.push({
    key: 'dpr',
    label: 'pixel ratio',
    value: Number.isFinite(w.devicePixelRatio) ? String(w.devicePixelRatio) : UNAVAILABLE,
  });

  rows.push({
    key: 'viewport',
    label: 'viewport',
    value: Number.isFinite(w.innerWidth) && Number.isFinite(w.innerHeight)
      ? `${w.innerWidth}×${w.innerHeight}`
      : UNAVAILABLE,
  });

  // Battery arrives asynchronously (getBattery() returns a promise), so the
  // caller appends it once resolved rather than reading it here.
  return rows;
}

export function formatBattery(battery) {
  if (!battery) return UNAVAILABLE;
  if (!Number.isFinite(battery.level)) return UNAVAILABLE;
  const pct = `${Math.round(battery.level * 100)}%`;
  return battery.charging ? `${pct} · charging` : pct;
}

export function mountSensors(el, ctx) {
  const bag = cleanupBag();
  const list = h('div', { class: 'widget-lanes' });
  el.replaceChildren(list);

  let batteryRow = null;

  function paint() {
    const rows = readSensors(navigator, window);
    if (batteryRow) rows.push(batteryRow);
    keyedList(
      list,
      rows,
      (r) => r.key,
      (r) => h('div', { class: 'widget-lane-row' },
        h('span', { class: 'text-faint' }, r.label),
        h('span', { class: r.value === UNAVAILABLE ? 'text-faint mono' : 'mono' }, r.value),
      ),
      (node, r) => {
        const valueEl = node.lastChild;
        valueEl.textContent = r.value;
        valueEl.className = r.value === UNAVAILABLE ? 'text-faint mono' : 'mono';
      },
    );
  }

  paint();

  // Viewport and pixel ratio genuinely change at runtime (resize, moving the
  // window between displays with different scaling), so repaint rather than
  // pretending the boot-time reading stays true.
  const onResize = () => paint();
  window.addEventListener('resize', onResize);
  bag.add(() => window.removeEventListener('resize', onResize));

  let disposed = false;
  bag.add(() => { disposed = true; });

  if (typeof navigator.getBattery === 'function') {
    navigator.getBattery().then((battery) => {
      if (disposed) return;
      const update = () => {
        if (disposed) return;
        batteryRow = { key: 'battery', label: 'battery', value: formatBattery(battery) };
        paint();
      };
      update();
      battery.addEventListener('levelchange', update);
      battery.addEventListener('chargingchange', update);
      bag.add(() => {
        battery.removeEventListener('levelchange', update);
        battery.removeEventListener('chargingchange', update);
      });
    }).catch(() => {
      if (disposed) return;
      // Rejection means the API exists but was refused (permissions policy).
      // Different fact from "missing", same honest conclusion: we don't know.
      batteryRow = { key: 'battery', label: 'battery', value: UNAVAILABLE };
      paint();
    });
  } else {
    batteryRow = { key: 'battery', label: 'battery', value: UNAVAILABLE };
    paint();
  }

  return () => bag.run();
}
