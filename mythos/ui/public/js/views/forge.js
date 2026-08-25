// forge.js — P22 Build panel. Live view of Forge build projects: per-project
// stage badge, per-file progress list, a plan/final approve-deny card (feedback
// textarea; feedback is required to deny a final review — it becomes the revision
// instruction), and an <iframe> preview once a build is awaiting review or done.
// WS-driven (subscribe ['forge','checkpoint']), no polling.
import { subscribe, checkpointReply } from '/js/ws.js';
import { safeSameOriginUrl, escapeAttr } from '/js/url.js';

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

const FILE_ICON = { done: '&#10003;', failed: '&#10007;', generating: '&#9881;', pending: '&#8230;' };

export async function render(mount) {
  // xss-safe: static template, no interpolation
  mount.innerHTML = `<div class="forge-list" id="forge-list"><div class="text-faint">Loading…</div></div>`;
  const projects = new Map(); // id -> project public view
  const pending = new Map();  // projectId -> { id, title, kind }

  function stageBadge(p) {
    return `<span class="forge-stage mono forge-stage-${escapeHtml(p.stage || p.status)}">${escapeHtml(p.stage || p.status)}</span>`;
  }

  function fileRow(f) {
    return `<li class="forge-file forge-file-${escapeHtml(f.status)}">
      <span class="forge-file-icon" aria-hidden="true">${FILE_ICON[f.status] || '&#8226;'}</span>
      <span class="forge-file-path mono">${escapeHtml(f.path)}</span>
      ${f.error ? `<span class="forge-file-err">${escapeHtml(f.error)}</span>` : ''}
    </li>`;
  }

  function previewFrame(p) {
    const showPreview = p.previewUrl && (p.status === 'awaiting-final-review' || p.status === 'done');
    if (!showPreview) return '';
    // escapeHtml() below is the textContent/innerHTML trick, which leaves `"`
    // intact — fine in text position, a break-out in an attribute. The project
    // name is model-authored, so `" onload=…` would land as a real attribute.
    // previewUrl additionally gets a scheme gate: an iframe src honours
    // javascript:/data: exactly like a link does.
    const src = safeSameOriginUrl(p.previewUrl);
    if (!src) return '';
    return `<iframe class="forge-preview" src="${escapeAttr(src)}" title="preview of ${escapeAttr(p.name)}"></iframe>`;
  }

  function approvalCard(p) {
    const gate = pending.get(p.id);
    if (!gate) return '';
    const isFinal = gate.kind === 'final-review';
    return `<div class="forge-gate" data-cid="${escapeHtml(gate.id)}">
      <div class="forge-gate-title">${escapeHtml(gate.title || 'Approval needed')}</div>
      ${isFinal ? '<textarea class="forge-feedback" placeholder="To deny: describe the change you want (used as the revision instruction)"></textarea>' : ''}
      <div class="forge-gate-actions">
        <button class="forge-btn forge-approve" type="button">Approve</button>
        <button class="forge-btn forge-deny" type="button">Deny</button>
      </div>
    </div>`;
  }

  function projectCard(p) {
    const files = (p.files || []).map(fileRow).join('');
    return `<div class="forge-project" data-id="${escapeHtml(p.id)}">
      <div class="forge-project-head">
        <span class="forge-project-name">${escapeHtml(p.name || 'project')}</span>
        ${stageBadge(p)}
        <span class="forge-count mono">${p.filesDone || 0}/${p.filesTotal || 0}</span>
      </div>
      ${p.error ? `<div class="forge-error">${escapeHtml(p.error)}</div>` : ''}
      <ul class="forge-files">${files}</ul>
      ${approvalCard(p)}
      ${previewFrame(p)}
    </div>`;
  }

  function renderAll() {
    const el = mount.querySelector('#forge-list');
    if (!el) return;
    const list = Array.from(projects.values()).reverse();
    // xss-safe: content assembled from escaped parts above
    el.innerHTML = list.length
      ? list.map(projectCard).join('')
      : '<div class="text-faint">No builds yet. Ask MYTHOS to build you something.</div>';
    wireGates(el);
  }

  function wireGates(el) {
    el.querySelectorAll('.forge-gate').forEach((g) => {
      const cid = g.dataset.cid;
      const feedbackEl = g.querySelector('.forge-feedback');
      g.querySelector('.forge-approve').onclick = () => resolveGate(cid, true, feedbackEl ? feedbackEl.value : undefined);
      g.querySelector('.forge-deny').onclick = () => {
        if (feedbackEl && !feedbackEl.value.trim()) { feedbackEl.focus(); return; }
        resolveGate(cid, false, feedbackEl ? feedbackEl.value : undefined);
      };
    });
  }

  function resolveGate(cid, accept, feedback) {
    checkpointReply(cid, accept, feedback);
    for (const [pid, gate] of pending) { if (gate.id === cid) pending.delete(pid); }
    renderAll();
  }

  async function loadInitial() {
    try {
      const [pRes, cRes] = await Promise.all([
        fetch('/api/forge/projects'),
        fetch('/api/checkpoints?status=pending'),
      ]);
      const pData = await pRes.json();
      (pData.projects || []).forEach((p) => projects.set(p.id, p));
      const cData = await cRes.json();
      (cData.checkpoints || []).forEach((c) => {
        if (c.projectId) pending.set(c.projectId, { id: c.id, title: c.title, kind: c.kind });
      });
    } catch (_) { /* initial load is best-effort; WS backfills */ }
    renderAll();
  }

  await loadInitial();

  const unsub = subscribe(['forge', 'checkpoint'], (msg) => {
    if (msg.type === 'forge') {
      const u = msg.payload || {};
      const existing = projects.get(u.projectId) || { id: u.projectId, files: [] };
      // Prefer a full status fetch for file detail; the update carries the summary fields.
      Object.assign(existing, {
        id: u.projectId, name: u.name || existing.name, status: u.stage, stage: u.stage,
        filesDone: u.filesDone, filesTotal: u.filesTotal, error: u.error, previewUrl: u.previewUrl,
      });
      projects.set(u.projectId, existing);
      refreshProject(u.projectId);
      return;
    }
    if (msg.type === 'checkpoint') {
      const c = msg.payload || {};
      if (!c.projectId) return;
      if (c.event === 'created') pending.set(c.projectId, { id: c.id, title: c.title, kind: c.kind });
      else if (c.event === 'resolved') pending.delete(c.projectId);
      renderAll();
    }
  });

  async function refreshProject(id) {
    try {
      const res = await fetch(`/api/forge/projects/${id}`);
      if (res.ok) { const data = await res.json(); if (data.project) projects.set(id, data.project); }
    } catch (_) { /* keep the summary-only view */ }
    renderAll();
  }

  return unsub;
}
