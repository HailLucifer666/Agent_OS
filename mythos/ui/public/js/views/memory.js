import { escapeHtml } from '../url.js';
// memory.js — browse 5 stores (episodic, semantic, skills, identity, audit).
// Spec Full Code, adapted only to the P9 panel mount contract (render(mount) is
// invoked inside an overlay panel body instead of a routed view mount).
const STORES = ['episodic', 'semantic', 'skills', 'identity', 'audit'];

export async function render(mount) {
  // xss-safe: static template, no interpolation
  mount.innerHTML = `
    <div class="memory-tabs" id="memory-tabs">
      ${STORES.map((s) => `<button class="memory-tab" data-store="${s}">${s}</button>`).join('')}
    </div>
    <div class="memory-list" id="memory-list"></div>
  `;

  async function loadStore(store) {
    const list = mount.querySelector('#memory-list');
    // xss-safe: static template, no interpolation
    list.innerHTML = '<div class="text-faint mono">Loading&hellip;</div>';
    try {
      const res = await fetch(`/api/memory/${store}?limit=100`);
      const data = await res.json();
      // xss-safe: all interpolated fields escaped
      list.innerHTML = (data.entries || [])
        .map((e) => `<div class="memory-entry"><span class="mono text-faint">${e.ts ? new Date(e.ts).toLocaleString() : '—'}</span> ${escapeHtml(e.summary || e.text || '')}</div>`)
        .join('') || '<div class="text-faint">Empty.</div>';
    } catch (err) {
      // xss-safe: all interpolated fields escaped
      list.innerHTML = `<div class="text-faint">Failed to load ${escapeHtml(store)}: ${escapeHtml(err && err.message ? err.message : err)}</div>`;
    }
  }

  mount.querySelector('#memory-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.memory-tab');
    if (!tab) return;
    mount.querySelectorAll('.memory-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    loadStore(tab.dataset.store);
  });

  mount.querySelector('.memory-tab').classList.add('active');
  loadStore(STORES[0]);
}
