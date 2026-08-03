// system.js — host CPU / RAM / disk, from GET /api/system.
//
// Ported from design/mythos-living-core.html's "System" panel MINUS its
// temperature, power-draw and network-throughput rows: Node exposes none of
// those, so the mockup's figures for them were invented. See
// server/routes/system.js for the full reasoning.
//
// Every value here can be legitimately null (first request of a process has no
// CPU delta yet; fs.statfs is missing before Node 18.15). null renders as
// "unavailable", never as 0% — a 0% CPU bar is indistinguishable from a real
// idle reading, which is exactly the kind of confident lie the honest-inert
// contract exists to prevent.

import { h, cleanupBag } from '../../dom.js';
import { fetchSystem } from './system-source.js';

const UNAVAILABLE = 'unavailable';

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return UNAVAILABLE;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatUptime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return UNAVAILABLE;
  const d = Math.floor(sec / 86400);
  const hrs = Math.floor((sec % 86400) / 3600);
  const min = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${hrs}h`;
  if (hrs > 0) return `${hrs}h ${min}m`;
  return `${min}m`;
}

// Builds a labelled bar row. `percent` null => the bar is omitted entirely and
// the value reads "unavailable"; an empty bar would read as 0.
function barRow(label) {
  const fill = h('i');
  const bar = h('div', { class: 'widget-bar' }, fill);
  const value = h('span', { class: 'mono' }, UNAVAILABLE);
  const root = h('div', { class: 'widget-bar-row' },
    h('div', { class: 'widget-lane-row' },
      h('span', { class: 'text-faint' }, label),
      value,
    ),
    bar,
  );
  return {
    root,
    set(percent, valueText) {
      const known = Number.isFinite(percent);
      value.textContent = valueText;
      value.className = known ? 'mono' : 'mono text-faint';
      bar.style.display = known ? '' : 'none';
      if (known) {
        fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        fill.classList.toggle('warn', percent > 85);
      }
    },
  };
}

export function mountSystem(el, ctx) {
  const bag = cleanupBag();

  const cpu = barRow('cpu');
  const mem = barRow('memory');
  const disk = barRow('disk');
  const sub = h('div', { class: 'widget-sub mono' }, '');

  el.replaceChildren(cpu.root, mem.root, disk.root, sub);

  function paint(data) {
    if (!data) {
      cpu.set(null, UNAVAILABLE);
      mem.set(null, UNAVAILABLE);
      disk.set(null, UNAVAILABLE);
      sub.textContent = 'host metrics unreachable';
      return;
    }
    const c = data.cpu || {};
    cpu.set(c.loadPercent, Number.isFinite(c.loadPercent) ? `${c.loadPercent}%` : UNAVAILABLE);

    const m = data.mem || {};
    mem.set(
      m.usedPercent,
      Number.isFinite(m.usedPercent)
        ? `${formatBytes(m.totalBytes - m.freeBytes)} / ${formatBytes(m.totalBytes)}`
        : UNAVAILABLE,
    );

    const d = data.disk;
    if (d && Number.isFinite(d.totalBytes) && d.totalBytes > 0) {
      const usedPercent = Math.round((1 - d.freeBytes / d.totalBytes) * 100);
      disk.set(usedPercent, `${formatBytes(d.totalBytes - d.freeBytes)} / ${formatBytes(d.totalBytes)}`);
    } else {
      disk.set(null, UNAVAILABLE);
    }

    const parts = [];
    if (data.platform) parts.push(`${data.platform}/${data.arch || '?'}`);
    if (Number.isFinite(data.uptimeSec)) parts.push(`up ${formatUptime(data.uptimeSec)}`);
    sub.textContent = parts.join(' · ');
  }

  bag.add(fetchSystem.subscribe(paint));
  return () => bag.run();
}
