// health.js — breakers/providers/anomaly log.
// Spec Full Code, adapted to the P9 panel mount contract. WS-only (anti-drift #6).
import { subscribe } from '/js/ws.js';

export async function render(mount) {
  mount.innerHTML = `
    <div class="health-breakers" id="health-breakers"><div class="text-faint mono">Awaiting first health broadcast&hellip;</div></div>
    <div class="health-providers" id="health-providers"></div>
    <div class="health-anomalies" id="health-anomalies"></div>
  `;

  function breakerRow(name, b) {
    const cls = b.state === 'closed' ? 'status-ok' : b.state === 'half-open' ? 'status-degraded' : 'status-warn';
    return `<div class="health-row"><span>${name}</span><span class="${cls} mono">${b.state.toUpperCase()}</span></div>`;
  }

  const unsub = subscribe(['health'], (msg) => {
    const { breakers, providers, anomalies } = msg.payload;
    mount.querySelector('#health-breakers').innerHTML =
      Object.entries(breakers || {}).map(([name, b]) => breakerRow(name, b)).join('') || '<div class="text-faint">No effectors registered.</div>';
    mount.querySelector('#health-providers').innerHTML =
      Object.entries(providers || {}).map(([name, p]) => `<div class="health-row"><span>${name}</span><span class="mono">${JSON.stringify(p)}</span></div>`).join('');
    mount.querySelector('#health-anomalies').innerHTML =
      (anomalies || []).slice().reverse().map((a) => `<div class="health-anomaly-row mono">${a.kind} — ${JSON.stringify(a)}</div>`).join('') || '<div class="text-faint">No anomalies.</div>';
  });

  return unsub;
}
