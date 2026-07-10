// pipeline.js — Pipeline surface: capture bar + 4-stage board (Capture, Human Gate, Execute, Shipped),
// wired to /api/pipeline*. Gallery toggle shows shipped cards as a grid.

const STAGES = [
  {
    key: 'capture',
    num: '01',
    name: 'Capture',
    caption: 'Raw input — no structure',
    icon: '&#9673;',
  },
  {
    key: 'human-gate',
    num: '03',
    name: 'Human Gate',
    caption: 'The one checkpoint',
    icon: '&#9737;',
  },
  {
    key: 'execute',
    num: '04',
    name: 'Execute',
    caption: 'PM + subagents build it',
    icon: '&#9881;',
  },
  {
    key: 'shipped',
    num: '05',
    name: 'Shipped & Filed',
    caption: 'Done',
    icon: '&#10003;',
  },
];

let state = {
  board: { capture: [], 'human-gate': [], execute: [], shipped: [] },
  view: 'pipeline', // pipeline | gallery
  shapedIds: new Set(), // capture cards that showed the "Phase 2" note
  jobs: {}, // cardId -> latest job record (pipeline-execute builds)
};

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function tagPills(tags) {
  if (!tags || !tags.length) return '';
  return tags.map((t) => `<span class="pipeline-tag mono">#${escapeHtml(t)}</span>`).join('');
}

function progressPill(progress) {
  if (progress === undefined || progress === null) return '';
  return `<span class="pipeline-progress-pill mono">project ${progress}%</span>`;
}

function captureCard(card) {
  const showNote = state.shapedIds.has(card.id);
  return `
    <div class="pipeline-card fade-in" data-id="${card.id}" data-stage="capture">
      <div class="pipeline-card-title">${escapeHtml(card.text)}</div>
      <button class="pipeline-btn pipeline-btn-shape" data-action="shape" type="button">Shape it &#8594;</button>
      ${showNote ? '<div class="pipeline-shape-note">Auto-routing to Human Gate lands in Phase 2.</div>' : ''}
    </div>
  `;
}

function humanGateCard(card) {
  return `
    <div class="pipeline-card fade-in" data-id="${card.id}" data-stage="human-gate">
      <div class="pipeline-card-title">${escapeHtml(card.text)}</div>
      <div class="pipeline-card-meta">
        ${progressPill(card.progress)}
        ${tagPills(card.tags)}
      </div>
      <div class="pipeline-card-actions">
        <button class="pipeline-btn pipeline-btn-approve" data-action="approve" type="button">&#10003; Approve</button>
        <button class="pipeline-btn-icon pipeline-btn-reject" data-action="reject" type="button" aria-label="Reject">&#10060;</button>
      </div>
    </div>
  `;
}

function executeCard(card) {
  const job = state.jobs[card.id];
  const busy = job && (job.status === 'running' || job.status === 'queued');
  const failed = job && job.status === 'failed';
  const label = busy ? 'Building…' : failed ? 'Retry the build' : 'Build the deliverable';
  return `
    <div class="pipeline-card fade-in" data-id="${card.id}" data-stage="execute">
      <div class="pipeline-card-title">${escapeHtml(card.text)}</div>
      <div class="pipeline-card-meta">
        ${progressPill(card.progress)}
        ${tagPills(card.tags)}
      </div>
      <button class="pipeline-btn pipeline-btn-ship" data-action="execute" type="button" ${busy ? 'disabled' : ''} title="Runs on your Claude Code CLI">&#9881; ${label}</button>
      ${busy ? `<div class="pipeline-shape-note mono">agent: ${escapeHtml(job.stage)} &middot; runs on your Claude Code CLI</div>` : ''}
      ${failed ? `<div class="pipeline-shape-note">Build failed: ${escapeHtml(job.error || 'unknown error')}</div>` : ''}
    </div>
  `;
}

function shippedCard(card) {
  return `
    <div class="pipeline-card fade-in" data-id="${card.id}" data-stage="shipped">
      <div class="pipeline-card-star" aria-hidden="true">&#9733;</div>
      <div class="pipeline-card-title">${escapeHtml(card.text)}</div>
      <div class="pipeline-card-meta">
        ${progressPill(card.progress)}
        ${tagPills(card.tags)}
      </div>
      ${card.artifact && card.artifact.path
        ? `<a class="pipeline-btn pipeline-btn-view" href="${escapeHtml(card.artifact.path)}" target="_blank" rel="noopener">&#9655; View what was built</a>`
        : `<button class="pipeline-btn pipeline-btn-view" type="button" disabled title="Shipped before the build agent existed — no artifact on file">&#9655; View what was built</button>`}
    </div>
  `;
}

function renderColumn(stage) {
  const cards = state.board[stage.key] || [];
  const renderer = { capture: captureCard, 'human-gate': humanGateCard, execute: executeCard, shipped: shippedCard }[stage.key];

  const staticCard = stage.key === 'capture'
    ? `
      <div class="pipeline-card pipeline-static-card">
        <div class="pipeline-static-head">
          <span class="pipeline-static-icon" aria-hidden="true">&#10022;</span>
          <span class="mono">inbox-classifier &middot; on demand</span>
        </div>
        <div class="pipeline-static-desc">5-way fork &#8594; project &middot; action &middot; idea &middot; reference &middot; escalate</div>
      </div>
    `
    : '';

  const body = cards.length === 0 && stage.key !== 'capture'
    ? `<div class="pipeline-empty">Nothing here yet.</div>`
    : cards.map(renderer).join('');

  return `
    <div class="pipeline-column">
      <div class="pipeline-column-head">
        <span class="pipeline-stage-icon" aria-hidden="true">${stage.icon}</span>
        <div>
          <div class="pipeline-stage-num mono">STAGE ${stage.num}</div>
          <div class="pipeline-stage-name">${stage.name}</div>
        </div>
      </div>
      <div class="pipeline-stage-caption">${stage.caption}</div>
      <div class="pipeline-column-body">
        ${staticCard}
        ${body}
      </div>
    </div>
  `;
}

function renderGallery() {
  const cards = state.board.shipped || [];
  if (cards.length === 0) {
    return `<div class="pipeline-empty">Nothing shipped yet.</div>`;
  }
  return `
    <div class="pipeline-gallery-grid">
      ${cards.map((card) => `
        <div class="pipeline-gallery-tile fade-in">
          <div class="pipeline-card-star" aria-hidden="true">&#9733;</div>
          <div class="pipeline-card-title">${escapeHtml(card.text)}</div>
          <div class="pipeline-card-meta">
            ${progressPill(card.progress)}
            ${tagPills(card.tags)}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderBoard() {
  const boardEl = document.getElementById('pipeline-board');
  const galleryEl = document.getElementById('pipeline-gallery');
  const toggleBtns = document.querySelectorAll('.pipeline-toggle-btn');

  toggleBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.view === state.view));

  if (state.view === 'gallery') {
    boardEl.hidden = true;
    galleryEl.hidden = false;
    galleryEl.innerHTML = renderGallery();
  } else {
    galleryEl.hidden = true;
    boardEl.hidden = false;
    boardEl.innerHTML = STAGES.map(renderColumn).join('');
  }
}

function applyBoard(board) {
  state.board = board;
  renderBoard();
}

export async function render(mount) {
  mount.innerHTML = `
    <div class="pipeline-particles" aria-hidden="true"></div>
    <div class="pipeline-subheader fade-in">
      <div class="pipeline-subheader-top">
        <div>
          <h2 class="pipeline-subheader-title">From Inbox to <span class="pipeline-accent">Shipped</span></h2>
          <div class="pipeline-subheader-caption mono">one human agent &middot; everything else is agents</div>
        </div>
        <div class="pipeline-view-toggle" id="pipeline-view-toggle">
          <button class="pipeline-toggle-btn" data-view="pipeline" type="button">&#9635; Pipeline</button>
          <button class="pipeline-toggle-btn" data-view="gallery" type="button">&#9636; Gallery</button>
        </div>
      </div>
      <p class="pipeline-subheader-sub">Drop an idea &#8594; agents classify it, route it, and draft a plan &#8594; you approve once &#8594; a PM + subagents build it. It all lives in your Obsidian vault under Agentic OS/Pipeline/.</p>
    </div>

    <div class="pipeline-capture-bar fade-in">
      <span class="pipeline-capture-icon" aria-hidden="true">&#10022;</span>
      <input type="text" id="pipeline-capture-input" class="pipeline-capture-input" placeholder="Drop an idea — a project, a thought, a link, anything. Agents take it from here…" />
      <button class="pipeline-capture-btn" id="pipeline-capture-btn" type="button">&#10148; Capture</button>
    </div>

    <div class="pipeline-board" id="pipeline-board"></div>
    <div class="pipeline-gallery" id="pipeline-gallery" hidden></div>
  `;

  async function load() {
    try {
      const res = await fetch('/api/pipeline');
      const data = await res.json();
      applyBoard(data);
    } catch (err) {
      console.error('pipeline load failed', err);
    }
  }

  async function captureIdea() {
    const input = document.getElementById('pipeline-capture-input');
    const text = input.value.trim();
    if (!text) return;
    try {
      const res = await fetch('/api/pipeline/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      applyBoard(data.board);
      input.value = '';
      input.focus();
    } catch (err) {
      console.error('capture failed', err);
    }
  }

  async function approveCard(id) {
    try {
      const res = await fetch(`/api/pipeline/${id}/approve`, { method: 'POST' });
      const data = await res.json();
      applyBoard(data.board);
    } catch (err) {
      console.error('approve failed', err);
    }
  }

  async function rejectCard(id) {
    try {
      const res = await fetch(`/api/pipeline/${id}/reject`, { method: 'POST' });
      const data = await res.json();
      applyBoard(data.board);
    } catch (err) {
      console.error('reject failed', err);
    }
  }

  let jobTimer = null;

  function watchJobs() {
    if (jobTimer) return;
    jobTimer = setInterval(async () => {
      const active = Object.values(state.jobs).filter((j) => j.status === 'running' || j.status === 'queued');
      if (!active.length) {
        clearInterval(jobTimer);
        jobTimer = null;
        return;
      }
      let boardStale = false;
      for (const j of active) {
        try {
          const res = await fetch(`/api/jobs/${j.id}`);
          if (!res.ok) continue;
          const data = await res.json();
          state.jobs[data.job.cardId] = data.job;
          if (data.job.status === 'done' || data.job.status === 'failed') boardStale = true;
        } catch { /* transient; next tick retries */ }
      }
      if (boardStale) {
        await load();
      } else {
        renderBoard();
      }
    }, 2500);
  }

  async function executeBuild(id) {
    try {
      const res = await fetch(`/api/pipeline/${id}/execute`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `execute failed (${res.status})`);
      state.jobs[id] = data.job;
      applyBoard(data.board);
      watchJobs();
    } catch (err) {
      state.jobs[id] = { id: null, cardId: id, status: 'failed', stage: 'failed', error: err.message };
      renderBoard();
    }
  }

  async function shapeCard(id) {
    try {
      const res = await fetch(`/api/pipeline/${id}/shape`, { method: 'POST' });
      const data = await res.json();
      applyBoard(data.board);
    } catch (err) {
      console.error('shape failed', err);
      state.shapedIds.add(id);
      renderBoard();
    }
  }

  document.getElementById('pipeline-capture-btn').addEventListener('click', captureIdea);
  document.getElementById('pipeline-capture-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') captureIdea();
  });

  document.getElementById('pipeline-view-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.pipeline-toggle-btn');
    if (!btn) return;
    state.view = btn.dataset.view;
    renderBoard();
  });

  document.getElementById('pipeline-board').addEventListener('click', (e) => {
    const card = e.target.closest('.pipeline-card[data-id]');
    if (!card) return;
    const id = card.dataset.id;
    if (e.target.closest('[data-action="shape"]')) shapeCard(id);
    if (e.target.closest('[data-action="approve"]')) approveCard(id);
    if (e.target.closest('[data-action="reject"]')) rejectCard(id);
    if (e.target.closest('[data-action="execute"]')) executeBuild(id);
  });

  await load();
  // Pick up builds that were mid-flight when the view last unmounted (cards carry jobId).
  const executeCards = state.board.execute || [];
  for (const card of executeCards) {
    if (!card.jobId || state.jobs[card.id]) continue;
    try {
      const res = await fetch(`/api/jobs/${card.jobId}`);
      if (res.ok) {
        const data = await res.json();
        state.jobs[card.id] = data.job;
      }
    } catch { /* job record gone — button just shows the default label */ }
  }
  renderBoard();
  watchJobs();

  return () => {
    if (jobTimer) clearInterval(jobTimer);
    jobTimer = null;
  };
}
