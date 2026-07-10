// stats-bus.js — client-side refresh channel. Panels fire 'refresh' after a CRUD
// mutation; the HUD and data widgets re-fetch /api/stats in response. Event-driven,
// never polled (anti-drift #6 — the WS push replaces NOVA's setInterval pattern).

export const statsBus = new EventTarget();

export function emitRefresh(source) {
  statsBus.dispatchEvent(new CustomEvent('refresh', { detail: { source: source || 'unknown' } }));
}

export function onRefresh(fn) {
  const handler = (e) => fn(e.detail);
  statsBus.addEventListener('refresh', handler);
  return () => statsBus.removeEventListener('refresh', handler);
}
