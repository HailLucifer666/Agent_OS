// cores.js — per-core CPU load, one bar per core, from the shared
// /api/system poller.
//
// Shares system-source.js with the SYSTEM widget deliberately: /api/system is
// stateful (each request consumes the CPU delta window), so two independent
// pollers would corrupt each other's readings. See system-source.js.
//
// A core whose delta could not be computed renders as unavailable rather than
// 0% — on the first request of a server process there is no previous sample to
// diff against, and a row of empty bars would look exactly like a genuinely
// idle machine.

import { h, keyedList, cleanupBag } from '../../dom.js';
import { fetchSystem } from './system-source.js';

export function mountCores(el, ctx) {
  const bag = cleanupBag();

  const headline = h('div', { class: 'widget-value-text mono text-faint' }, 'awaiting first sample');
  const list = h('div', { class: 'widget-lanes' });
  el.replaceChildren(headline, list);

  function paint(data) {
    const cpu = (data && data.cpu) || null;
    const perCore = (cpu && Array.isArray(cpu.perCore)) ? cpu.perCore : [];

    if (!data) {
      headline.textContent = 'host metrics unreachable';
      keyedList(list, [], (x) => x, () => h('div'));
      return;
    }
    if (!perCore.length) {
      headline.textContent = 'awaiting first sample';
      keyedList(list, [], (x) => x, () => h('div'));
      return;
    }

    headline.textContent = cpu.model
      ? `${perCore.length} threads · ${cpu.model}`
      : `${perCore.length} threads`;
    headline.title = cpu.model || '';

    const items = perCore.map((percent, i) => ({ i, percent }));
    keyedList(
      list,
      items,
      (item) => item.i,
      (item) => {
        const fill = h('i');
        const value = h('span', { class: 'mono' }, '');
        const row = h('div', { class: 'widget-bar-row' },
          h('div', { class: 'widget-lane-row' },
            h('span', { class: 'text-faint' }, `core ${item.i}`),
            value,
          ),
          h('div', { class: 'widget-bar' }, fill),
        );
        setCore(row, item);
        return row;
      },
      (node, item) => setCore(node, item),
    );
  }

  function setCore(node, item) {
    const value = node.querySelector('.widget-lane-row span:last-child');
    const bar = node.querySelector('.widget-bar');
    const fill = bar.firstChild;
    const known = Number.isFinite(item.percent);
    value.textContent = known ? `${item.percent}%` : 'unavailable';
    value.className = known ? 'mono' : 'mono text-faint';
    bar.style.display = known ? '' : 'none';
    if (known) {
      fill.style.width = `${Math.max(0, Math.min(100, item.percent))}%`;
      fill.classList.toggle('warn', item.percent > 85);
    }
  }

  bag.add(fetchSystem.subscribe(paint));
  return () => bag.run();
}
