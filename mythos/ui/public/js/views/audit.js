// audit.js — scrollable leash trail: every decision with tier/outcome.
// Spec Full Code, adapted to the P9 panel mount contract. WS-only (anti-drift #6).
import { subscribe } from '/js/ws.js';

export async function render(mount) {
  mount.innerHTML = `<div class="audit-list" id="audit-list"></div>`;
  const rows = [];

  function renderList() {
    mount.querySelector('#audit-list').innerHTML = rows
      .slice(-200).reverse()
      .map((r) => `<div class="audit-row"><span class="mono">T${r.tier}</span> <span class="mono">${r.decision}</span> ${r.tool}</div>`)
      .join('') || '<div class="text-faint">No decisions yet.</div>';
  }

  const unsub = subscribe(['audit'], (msg) => {
    rows.push(msg.payload);
    if (rows.length > 500) rows.shift();
    renderList();
  });

  renderList();
  return unsub;
}
