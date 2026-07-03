// memory.js — Memory (Obsidian Vault) surface: real notes from /api/memory/notes
// rendered as Recent / Notes / Omi / Graph tabs, with Graph as a canvas starfield.

import { createGalaxy } from './memory-galaxy-canvas.js';

let notes = [];
let count = 0;
let activeTab = 'graph';
let galaxy = null;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function formatModified(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function noteRow(note) {
  return `
    <div class="memory-note-row" data-name="${escapeHtml(note.name)}">
      <div class="memory-note-main">
        <span class="memory-note-name">${escapeHtml(note.name)}</span>
        <span class="memory-note-excerpt">${escapeHtml(note.excerpt || '')}</span>
      </div>
      <div class="memory-note-meta">
        <span class="memory-note-links mono">${(note.links || []).length} links</span>
        <span class="memory-note-date mono">${formatModified(note.modified)}</span>
      </div>
    </div>
  `;
}

function renderList(container, list, emptyMsg) {
  if (!list.length) {
    container.innerHTML = `<div class="memory-empty">${emptyMsg}</div>`;
    return;
  }
  container.innerHTML = list.map(noteRow).join('');
}

function renderCountPill(mount) {
  const pill = mount.querySelector('.memory-count-pill');
  if (pill) pill.textContent = `— OMI · ${count} NOTES`;
}

function renderRecentBadge(mount) {
  const badge = mount.querySelector('[data-tab="recent"] .memory-chip-badge');
  if (badge) badge.textContent = String(Math.min(count, 12));
}

function selectNote(mount, note) {
  const panel = mount.querySelector('.memory-detail');
  if (!panel) return;
  panel.hidden = false;
  panel.innerHTML = `
    <div class="memory-detail-name">${escapeHtml(note.name)}</div>
    <div class="memory-detail-meta mono">${formatModified(note.modified)} &middot; ${(note.links || []).length} links</div>
    <div class="memory-detail-excerpt">${escapeHtml(note.excerpt || 'No excerpt available.')}</div>
  `;
}

function setActiveTab(mount, tab) {
  activeTab = tab;
  mount.querySelectorAll('.memory-chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.tab === tab);
  });
  mount.querySelectorAll('.memory-panel-view').forEach((el) => {
    el.hidden = el.dataset.view !== tab;
  });
}

export async function render(mount) {
  mount.innerHTML = `
    <div class="memory-panel fade-in">
      <div class="memory-panel-head">
        <div class="memory-panel-title">
          <span class="memory-title-bar"></span>
          <span class="memory-brain-icon">&#10711;</span>
          <span class="memory-title-text">Memory &mdash; Obsidian Vault</span>
        </div>
        <span class="memory-count-pill mono">&mdash; OMI &middot; 0 NOTES</span>
      </div>

      <div class="memory-chip-row">
        <button class="memory-chip" type="button" data-tab="recent">
          <span>Recent</span><span class="memory-chip-badge mono">0</span>
        </button>
        <button class="memory-chip" type="button" data-tab="notes">Notes</button>
        <button class="memory-chip" type="button" data-tab="omi">Omi</button>
        <button class="memory-chip" type="button" data-tab="graph">Graph</button>
        <div class="memory-chip-spacer"></div>
        <button class="memory-galaxy-pill active" type="button" data-tab="graph">&#10022; Galaxy</button>
      </div>

      <div class="memory-panel-body">
        <div class="memory-panel-view" data-view="recent" hidden>
          <div class="memory-list" id="memory-recent-list"></div>
        </div>
        <div class="memory-panel-view" data-view="notes" hidden>
          <div class="memory-list" id="memory-notes-list"></div>
        </div>
        <div class="memory-panel-view" data-view="omi" hidden>
          <div class="memory-empty">Omi sync lands in Phase 2 &mdash; no memories captured yet.</div>
        </div>
        <div class="memory-panel-view" data-view="graph">
          <div class="memory-galaxy-caption">
            <div class="mono memory-galaxy-caption-title">&#10022; MEMORY GALAXY</div>
            <div class="mono memory-galaxy-caption-stats" id="memory-galaxy-stats">0 stars &middot; 0 links</div>
            <div class="memory-galaxy-caption-hint">drag to orbit &middot; scroll to zoom &middot; click a star &middot; double-click to pause flight</div>
            <div class="memory-galaxy-caption-hint">&#10022; brighter &amp; whiter = more recently touched</div>
          </div>
          <div class="memory-galaxy-wrap">
            <canvas id="memory-galaxy-canvas" class="memory-galaxy-canvas"></canvas>
            <div id="memory-galaxy-tooltip" class="memory-galaxy-tooltip" hidden></div>
            <div id="memory-galaxy-empty" class="memory-empty memory-galaxy-empty-overlay" hidden>
              No notes yet &mdash; seed vault/Memories/ with markdown files to populate the galaxy.
            </div>
          </div>
          <div class="memory-detail" hidden></div>
        </div>
      </div>
    </div>
  `;

  mount.querySelectorAll('.memory-chip, .memory-galaxy-pill').forEach((el) => {
    el.addEventListener('click', () => setActiveTab(mount, el.dataset.tab));
  });

  setActiveTab(mount, activeTab);

  const canvas = mount.querySelector('#memory-galaxy-canvas');
  const tooltip = mount.querySelector('#memory-galaxy-tooltip');
  const emptyOverlay = mount.querySelector('#memory-galaxy-empty');

  galaxy = createGalaxy(canvas, tooltip, {
    onSelect: (note) => selectNote(mount, note),
  });

  async function load() {
    try {
      const res = await fetch('/api/memory/notes');
      const data = await res.json();
      notes = data.notes || [];
      count = data.count ?? notes.length;

      renderCountPill(mount);
      renderRecentBadge(mount);

      const recent = [...notes]
        .filter((n) => n.modified)
        .sort((a, b) => new Date(b.modified) - new Date(a.modified))
        .slice(0, 12);
      renderList(mount.querySelector('#memory-recent-list'), recent, 'No recently modified notes yet.');

      const alpha = [...notes].sort((a, b) => a.name.localeCompare(b.name));
      renderList(mount.querySelector('#memory-notes-list'), alpha, 'No notes yet.');

      const linkCount = notes.reduce((sum, n) => sum + (n.links || []).length, 0);
      mount.querySelector('#memory-galaxy-stats').textContent = `${notes.length} stars · ${linkCount} links`;

      if (!notes.length) {
        emptyOverlay.hidden = false;
      } else {
        emptyOverlay.hidden = true;
        galaxy.setNotes(notes);
        mount.querySelector('#memory-galaxy-stats').textContent = `${notes.length} stars · ${galaxy.linkCount()} links`;
      }
    } catch (err) {
      console.error('memory notes load failed', err);
      emptyOverlay.hidden = false;
      emptyOverlay.textContent = 'Could not load notes — check that the server is running.';
    }
  }

  mount.querySelector('.memory-panel-body').addEventListener('click', (e) => {
    const row = e.target.closest('.memory-note-row');
    if (!row) return;
    const note = notes.find((n) => n.name === row.dataset.name);
    if (note) {
      setActiveTab(mount, 'graph');
      selectNote(mount, note);
    }
  });

  load();

  return () => {
    if (galaxy) galaxy.destroy();
  };
}
