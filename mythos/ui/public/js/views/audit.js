// audit.js — scrollable leash trail: every decision with tier/outcome.
// P9 panel contract: HTTP history plus live WS audit decisions. Optional WS
// id/ts fields identify persisted rows; older payloads still render unchanged.
import { subscribe } from '/js/ws.js';

// Audit rows carry model-driven values: `tool` is whatever the brain asked to
// call, `decision` the leash verdict for it. Neither is operator-typed.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function render(mount) {
  // xss-safe: static template, no interpolation
  mount.innerHTML = `<div class="audit-list" id="audit-list"></div>`;
  const rows = [];
  const controller = new AbortController();
  let disposed = false;

  // Wave 0 (2026-08-13): healer.js's audit rows are deliberately tool:null —
  // a heal is a playbook decision, not a dispatch, and there is no tool to
  // name (BUG-125's comment on the write side). Rendering `null` as nothing
  // made every heal row look like a dispatch that lost its tool name, which
  // is exactly the failure BUG-125 already ruled out on the write side.
  function toolLabel(r) {
    if (r.tool != null) return r.tool;
    return r.decision === 'heal' ? 'heal' : '';
  }

  function renderList() {
    // xss-safe: all interpolated fields escaped
    mount.querySelector('#audit-list').innerHTML = rows
      .slice(-200).reverse()
      .map((r) => `<div class="audit-row"><span class="mono">T${escapeHtml(r.tier)}</span> <span class="mono">${escapeHtml(r.decision)}</span> ${escapeHtml(toolLabel(r))}</div>`)
      .join('') || '<div class="text-faint">No decisions yet.</div>';
  }

  // BUG-019: subscribe before requesting the snapshot. Otherwise decisions
  // made while the response is in flight disappear from both sources.
  const unsub = subscribe(['audit'], (msg) => {
    if (disposed) return;
    if (msg.payload.id && rows.some((r) => r.id === msg.payload.id)) return;
    rows.push(msg.payload);
    if (rows.length > 500) rows.shift();
    renderList();
  });
  renderList();

  // Return teardown immediately: a closed panel must not wait for the fetch.
  (async () => {
   try {
    const res = await fetch('/api/audit/recent?limit=50', { signal: controller.signal });
    if (res.ok) {
      const data = await res.json();
      if (disposed) return;
      if (data.error) {
        console.warn('audit-api-error', data.error);
      } else if (data.entries && Array.isArray(data.entries)) {
        // API returns newest-first; reverse to oldest-first so live events append correctly
        // Snapshot and live stream can overlap. Only real ids establish
        // identity; legacy id-less events remain distinct rather than guessed.
        const merged = new Map();
        for (const row of [...data.entries].reverse().concat(rows)) merged.set(row.id || row, row);
        rows.splice(0, rows.length, ...[...merged.values()].slice(-500));
      }
    } else {
      console.warn('audit-fetch-status', res.status, await res.text().catch(() => ''));
    }
   } catch (err) {
    if (!disposed) console.warn('audit-fetch-failed', err.message);
   }
   if (!disposed) renderList();
  })();

  return () => {
    disposed = true;
    controller.abort();
    unsub();
  };
}
