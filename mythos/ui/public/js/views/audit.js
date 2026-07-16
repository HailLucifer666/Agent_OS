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

  // Fetch historical audit entries on mount (BUG-019)
  try {
    const res = await fetch('/api/audit/recent?limit=50');
    if (res.ok) {
      const data = await res.json();
      if (data.error) {
        console.warn('audit-api-error', data.error);
      } else if (data.entries && Array.isArray(data.entries)) {
        // API returns newest-first; reverse to oldest-first so live events append correctly
        rows.push(...data.entries.reverse());
      }
    } else {
      console.warn('audit-fetch-status', res.status, await res.text().catch(() => ''));
    }
  } catch (err) {
    console.warn('audit-fetch-failed', err.message);
  }

  // Render historical entries
  renderList();

  // Subscribe to live updates (appended in newest order, existing logic handles display)
  const unsub = subscribe(['audit'], (msg) => {
    rows.push(msg.payload);
    if (rows.length > 500) rows.shift();
    renderList();
  });

  return unsub;
}
