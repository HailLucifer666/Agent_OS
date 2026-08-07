// system.js — the whole machine in one card: host CPU / RAM / disk / uptime,
// per-core load, GPU identity, and the browser-visible device facts.
//
// BUG-176: this was four separate widgets (SYSTEM, CORES, GPU, SENSORS) taking
// four gutter slots to answer one question. Merged on operator request into
// four labelled sections of a single card. The other three modules keep their
// PURE exports at their existing paths (readRenderer, probe, readSensors,
// formatBattery) and are imported here rather than copied, so there is exactly
// one implementation of each. Only their mount* entry points went away.
//
// Sections degrade INDEPENDENTLY, which is why they do not share one error
// state: HOST and CORES come from /api/system, so an unreachable server blanks
// both — while GPU and SENSORS are browser-local and must stay populated,
// because their data has nothing to do with whether the server answered.
//
// Ported from design/mythos-living-core.html's "System" panel MINUS its
// temperature, power-draw and network-throughput rows: Node exposes none of
// those, so the mockup's figures for them were invented. See
// server/routes/system.js for the full reasoning.
//
// Every value here can legitimately be null (the first request of a process
// has no CPU delta yet; fs.statfs is missing before Node 18.15). null renders
// as "unavailable", never as 0% — a 0% CPU bar is indistinguishable from a
// real idle reading, which is exactly the confident lie the honest-inert
// contract exists to prevent.

import { h, keyedList, cleanupBag } from '../../dom.js';
import { fetchSystem } from './system-source.js';
import { probe as probeGpu } from './gpu.js';
import { readSensors, formatBattery } from './sensors.js';

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

// A labelled meter row. When `percent` is null the bar is HIDDEN and the value
// reads "unavailable" — an empty bar would read as 0.
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

// A quiet section label. Sections stay visibly present even when their content
// is unavailable — a section that vanished would read as "this machine has no
// GPU" rather than "this reading could not be taken".
function sectionLabel(text) {
  return h('div', { class: 'widget-section' }, text);
}

// Per-core bar, lifted verbatim from the old cores.js so the unavailable-vs-0%
// behaviour is unchanged: a core whose delta could not be computed reads
// "unavailable", because a row of empty bars looks exactly like an idle machine.
function setCore(node, item) {
  const value = node.querySelector('.widget-lane-row span:last-child');
  const bar = node.querySelector('.widget-bar');
  const fill = bar.firstChild;
  const known = Number.isFinite(item.percent);
  value.textContent = known ? item.percent + '%' : UNAVAILABLE;
  value.className = known ? 'mono' : 'mono text-faint';
  bar.style.display = known ? '' : 'none';
  if (known) {
    fill.style.width = Math.max(0, Math.min(100, item.percent)) + '%';
    fill.classList.toggle('warn', item.percent > 85);
  }
}

export function mountSystem(el, ctx) {
  const bag = cleanupBag();

  // --- HOST ---
  const cpu = barRow('cpu');
  const mem = barRow('memory');
  const disk = barRow('disk');
  const sub = h('div', { class: 'widget-sub mono' }, '');

  // --- CORES ---
  const coreHead = h('div', { class: 'widget-sub mono text-faint' }, 'awaiting first sample');
  const coreList = h('div', { class: 'widget-lanes' });

  // --- GPU: one-shot, the GPU does not change under a running page ---
  const gpuInfo = probeGpu();
  const gpuKnown = gpuInfo.renderer !== UNAVAILABLE;

  // --- SENSORS ---
  const sensorList = h('div', { class: 'widget-lanes' });

  el.replaceChildren(
    sectionLabel('host'),
    cpu.root, mem.root, disk.root, sub,
    sectionLabel('cores'),
    coreHead, coreList,
    sectionLabel('gpu'),
    h('div', {
      class: gpuKnown ? 'widget-value-text mono' : 'widget-value-text mono text-faint',
      title: gpuKnown ? gpuInfo.renderer : '',
    }, gpuInfo.renderer),
    h('div', { class: 'widget-sub mono' }, gpuKnown ? gpuInfo.vendor : (gpuInfo.reason || UNAVAILABLE)),
    sectionLabel('device'),
    sensorList,
  );

  // ONE subscription drives both HOST and CORES, so the two sections are
  // provably painted from the same sample. system-source.js is a shared
  // stateful poller by design — each /api/system request consumes the CPU delta
  // window, which is why two independent POLLERS would corrupt each other.
  function paint(data) {
    if (!data) {
      cpu.set(null, UNAVAILABLE);
      mem.set(null, UNAVAILABLE);
      disk.set(null, UNAVAILABLE);
      sub.textContent = 'host metrics unreachable';
      coreHead.textContent = 'host metrics unreachable';
      keyedList(coreList, [], function (x) { return x; }, function () { return h('div'); });
      return;
    }

    const c = data.cpu || {};
    cpu.set(c.loadPercent, Number.isFinite(c.loadPercent) ? c.loadPercent + '%' : UNAVAILABLE);

    const m = data.mem || {};
    mem.set(
      m.usedPercent,
      Number.isFinite(m.usedPercent)
        ? formatBytes(m.totalBytes - m.freeBytes) + ' / ' + formatBytes(m.totalBytes)
        : UNAVAILABLE,
    );

    const d = data.disk;
    if (d && Number.isFinite(d.totalBytes) && d.totalBytes > 0) {
      const usedPercent = Math.round((1 - d.freeBytes / d.totalBytes) * 100);
      disk.set(usedPercent, formatBytes(d.totalBytes - d.freeBytes) + ' / ' + formatBytes(d.totalBytes));
    } else {
      disk.set(null, UNAVAILABLE);
    }

    const parts = [];
    if (data.platform) parts.push(data.platform + '/' + (data.arch || '?'));
    if (Number.isFinite(data.uptimeSec)) parts.push('up ' + formatUptime(data.uptimeSec));
    sub.textContent = parts.join(' · ');

    const perCore = Array.isArray(c.perCore) ? c.perCore : [];
    if (!perCore.length) {
      coreHead.textContent = 'awaiting first sample';
      keyedList(coreList, [], function (x) { return x; }, function () { return h('div'); });
      return;
    }
    coreHead.textContent = c.model
      ? perCore.length + ' threads · ' + c.model
      : perCore.length + ' threads';
    coreHead.title = c.model || '';
    keyedList(
      coreList,
      perCore.map(function (percent, i) { return { i: i, percent: percent }; }),
      function (item) { return item.i; },
      function (item) {
        const fill = h('i');
        const value = h('span', { class: 'mono' }, '');
        const row = h('div', { class: 'widget-bar-row' },
          h('div', { class: 'widget-lane-row' },
            h('span', { class: 'text-faint' }, 'core ' + item.i),
            value,
          ),
          h('div', { class: 'widget-bar' }, fill),
        );
        setCore(row, item);
        return row;
      },
      function (node, item) { setCore(node, item); },
    );
  }

  bag.add(fetchSystem.subscribe(paint));

  // --- SENSORS: browser-local, independent of the server entirely ---
  let batteryRow = null;
  function paintSensors() {
    const rows = readSensors(navigator, window);
    if (batteryRow) rows.push(batteryRow);
    keyedList(
      sensorList,
      rows,
      function (r) { return r.key; },
      function (r) {
        return h('div', { class: 'widget-lane-row' },
          h('span', { class: 'text-faint' }, r.label),
          h('span', { class: r.value === UNAVAILABLE ? 'text-faint mono' : 'mono' }, r.value),
        );
      },
      function (node, r) {
        const valueEl = node.lastChild;
        valueEl.textContent = r.value;
        valueEl.className = r.value === UNAVAILABLE ? 'text-faint mono' : 'mono';
      },
    );
  }
  paintSensors();

  // Viewport and pixel ratio genuinely change at runtime (resize, or moving the
  // window between displays with different scaling).
  const onResize = function () { paintSensors(); };
  window.addEventListener('resize', onResize);
  bag.add(function () { window.removeEventListener('resize', onResize); });

  let disposed = false;
  bag.add(function () { disposed = true; });

  if (typeof navigator.getBattery === 'function') {
    navigator.getBattery().then(function (battery) {
      if (disposed) return;
      const update = function () {
        if (disposed) return;
        batteryRow = { key: 'battery', label: 'battery', value: formatBattery(battery) };
        paintSensors();
      };
      update();
      battery.addEventListener('levelchange', update);
      battery.addEventListener('chargingchange', update);
      bag.add(function () {
        battery.removeEventListener('levelchange', update);
        battery.removeEventListener('chargingchange', update);
      });
    }).catch(function () {
      if (disposed) return;
      // The API exists but was refused (permissions policy). Different fact
      // from "missing", same honest conclusion: we don't know.
      batteryRow = { key: 'battery', label: 'battery', value: UNAVAILABLE };
      paintSensors();
    });
  } else {
    batteryRow = { key: 'battery', label: 'battery', value: UNAVAILABLE };
    paintSensors();
  }

  return function () { bag.run(); };
}
