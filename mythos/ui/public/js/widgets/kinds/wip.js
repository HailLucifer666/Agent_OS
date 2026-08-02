// wip.js — work-in-progress: kanban lane counts. One REST fetch on mount (a CRUD
// surface, allowed per anti-drift #6) + statsBus 'refresh' resync after panel
// mutations. Never on an interval.

export function mountWip(el, ctx) {
  // xss-safe: static template, no interpolation
  el.innerHTML = `<div class="widget-lanes mono" data-role="lanes">loading…</div>`;
  const lanesEl = el.querySelector('[data-role="lanes"]');
  let disposed = false;

  async function load() {
    try {
      const res = await fetch('/api/kanban');
      const board = await res.json();
      if (disposed) return;
      const byLane = {};
      (board.cards || []).forEach((c) => { byLane[c.lane] = (byLane[c.lane] || 0) + 1; });
      const lanes = ['backlog', 'building', 'review', 'done'];
      // xss-safe: static template, no interpolation (local lane names + counts)
      lanesEl.innerHTML = lanes
        .map((l) => `<div class="widget-lane-row"><span class="text-faint">${l}</span><span>${byLane[l] || 0}</span></div>`)
        .join('');
    } catch {
      if (!disposed) lanesEl.textContent = 'kanban offline';
    }
  }

  load();
  const offRefresh = ctx.onRefresh(() => load());

  return () => { disposed = true; offRefresh(); };
}
