// research.js — P23 Research panel. Two sub-views in one panel: a list of
// research runs (stage badge, source count, headline) and a report viewer
// (<iframe src=reportUrl>). Initial state via GET /api/research; live updates
// via WS subscribe(['research']). WS-driven, no polling.
import { subscribe } from '/js/ws.js';

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

export async function render(mount) {
  mount.innerHTML = `
    <div class="research-wrap">
      <div class="research-list" id="research-list"><div class="text-faint">Loading…</div></div>
      <div class="research-report" id="research-report" hidden></div>
    </div>`;
  const runs = new Map(); // id -> public view
  let viewing = null;     // id currently shown in the report iframe

  function stageBadge(r) {
    return `<span class="research-stage mono research-stage-${escapeHtml(r.stage)}">${escapeHtml(r.stage)}</span>`;
  }

  function runRow(r) {
    const canView = r.reportUrl && (r.stage === 'done' || r.stage === 'interrupted');
    return `<div class="research-run" data-id="${escapeHtml(r.id)}">
      <div class="research-run-head">
        <span class="research-topic">${escapeHtml(r.topic)}</span>
        ${stageBadge(r)}
        ${r.degraded ? '<span class="research-degraded">degraded</span>' : ''}
      </div>
      ${r.headline ? `<div class="research-headline">${escapeHtml(r.headline)}</div>` : ''}
      <div class="research-run-meta mono">${r.sourceCount || 0} sources${r.error ? ' · ' + escapeHtml(r.error) : ''}</div>
      ${canView ? `<button class="research-view" type="button" data-url="${escapeHtml(r.reportUrl)}">View report &rarr;</button>` : ''}
    </div>`;
  }

  function renderList() {
    const el = mount.querySelector('#research-list');
    if (!el) return;
    const list = Array.from(runs.values()).reverse();
    el.innerHTML = list.length
      ? list.map(runRow).join('')
      : '<div class="text-faint">No research yet. Ask MYTHOS to research a topic.</div>';
    el.querySelectorAll('.research-view').forEach((b) => {
      b.onclick = () => showReport(b.dataset.url, b.closest('.research-run').dataset.id);
    });
  }

  function showReport(url, id) {
    viewing = id;
    const listEl = mount.querySelector('#research-list');
    const repEl = mount.querySelector('#research-report');
    if (!repEl || !listEl) return;
    listEl.hidden = true;
    repEl.hidden = false;
    repEl.innerHTML = `
      <button class="research-back" type="button">&larr; Back to runs</button>
      <iframe class="research-frame" src="${escapeHtml(url)}" title="research report"></iframe>`;
    repEl.querySelector('.research-back').onclick = () => {
      repEl.hidden = true; listEl.hidden = false; viewing = null;
    };
  }

  try {
    const res = await fetch('/api/research');
    const data = await res.json();
    (data.runs || []).forEach((r) => runs.set(r.id, r));
  } catch (_) { /* initial load best-effort; WS backfills */ }
  renderList();

  const unsub = subscribe(['research'], (msg) => {
    const r = msg.payload || {};
    if (!r.id) return;
    runs.set(r.id, Object.assign(runs.get(r.id) || {}, r));
    if (viewing !== r.id) renderList();
  });

  return unsub;
}
