// kanban.js — Agent Kanban surface: static Phase-1 chrome + real drag-and-drop CRUD board via /api/kanban.

const LANES = [
  { id: 'backlog', label: 'BACKLOG', dot: 'amber', empty: 'Give the team a goal above &mdash; the Planner fills this column with cards.' },
  { id: 'building', label: 'BUILDING', dot: 'amber', empty: '' },
  { id: 'review', label: 'REVIEW', dot: 'blue', empty: '' },
  { id: 'done', label: 'DONE', dot: 'green', empty: '' },
];

let cards = [];
let jobs = {}; // cardId -> latest job record

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function cardTemplate(card) {
  const job = jobs[card.id];
  const busy = job && (job.status === 'running' || job.status === 'queued');
  const failed = job && job.status === 'failed';
  const actions = [];
  if (card.lane === 'backlog' && !busy) {
    actions.push(`<button class="kanban-card-action" data-action="build" data-id="${card.id}" type="button">&#128736; Build</button>`);
  }
  // P24: the Review / Accept buttons were removed — no reviewer effector was ever
  // built, so /api/kanban/cards/:id/review and /accept have no backing and only
  // failed cleanly. Cards still show their build artifact + any verdict note.
  const artifactLink = card.artifact && card.artifact.path
    ? `<a class="kanban-card-artifact" href="${escapeHtml(card.artifact.path)}" target="_blank" rel="noopener">&#9655; ${escapeHtml(card.artifact.title || 'view build')}</a>`
    : '';
  const verdictNote = card.reviewVerdict
    ? `<div class="kanban-card-verdict ${card.reviewVerdict}">${card.reviewVerdict === 'approve' ? '&#9989;' : '&#10060;'} ${escapeHtml(card.reviewNotes || '')}</div>`
    : '';
  return `
    <div class="kanban-card fade-in" draggable="true" data-id="${card.id}">
      <div class="kanban-card-title">${escapeHtml(card.title)}</div>
      ${card.detail ? `<div class="kanban-card-detail">${escapeHtml(card.detail)}</div>` : ''}
      ${busy ? `<div class="kanban-card-status mono">agent: ${escapeHtml(job.stage)}</div>` : ''}
      ${failed ? `<div class="kanban-card-status kanban-card-error">${escapeHtml(job.error || 'agent failed')}</div>` : ''}
      ${artifactLink}
      ${verdictNote}
      <div class="kanban-card-footer">
        ${actions.join('')}
        <button class="kanban-card-delete" data-action="delete" data-id="${card.id}" aria-label="Delete card">&times;</button>
      </div>
    </div>
  `;
}

function laneCards(laneId) {
  return cards.filter((c) => c.lane === laneId);
}

function renderBoard() {
  LANES.forEach((lane) => {
    const items = laneCards(lane.id);
    const countEl = document.querySelector(`.kanban-count[data-lane="${lane.id}"]`);
    if (countEl) countEl.textContent = items.length;

    const body = document.querySelector(`.kanban-lane-body[data-lane="${lane.id}"]`);
    if (!body) return;
    if (items.length === 0) {
      body.innerHTML = lane.empty
        ? `<div class="kanban-empty">${lane.empty}</div>`
        : '';
    } else {
      body.innerHTML = items.map(cardTemplate).join('');
    }
  });
}

function laneColumn(lane) {
  return `
    <div class="kanban-lane" data-lane="${lane.id}">
      <div class="kanban-lane-head">
        <span class="kanban-lane-dot ${lane.dot}"></span>
        <span class="kanban-lane-label mono">${lane.label}</span>
        <span class="kanban-count mono" data-lane="${lane.id}">0</span>
      </div>
      <div class="kanban-lane-body" data-lane="${lane.id}"></div>
      <div class="kanban-add-row">
        <input type="text" class="kanban-add-input" data-lane="${lane.id}" placeholder="+ Add card" />
      </div>
    </div>
  `;
}

export async function render(mount) {
  mount.innerHTML = `
    <div class="kanban-header fade-in">
      <div class="kanban-header-left">
        <div class="kanban-avatar">&#10024;</div>
        <div>
          <div class="kanban-name-row">
            <span class="kanban-name">Agent Kanban</span>
            <span class="kanban-team-pill">&#9986; offline team</span>
          </div>
          <div class="kanban-subtitle">A team of local agents plans, builds + reviews &mdash; live, on your machine</div>
        </div>
      </div>
      <div class="kanban-header-right">
        <div class="kanban-toggle-group">
          <button class="kanban-toggle active" type="button">&#9638; Board</button>
          <button class="kanban-toggle" type="button" disabled>&#128193; Workspace <span class="kanban-badge">11</span></button>
        </div>
        <div class="kanban-role-pills">
          <button class="kanban-role-pill" type="button" disabled>&#8853; Planner</button>
          <button class="kanban-role-pill" type="button" disabled>&#128736; Builder</button>
          <button class="kanban-role-pill" type="button" disabled>&#9989; Reviewer</button>
        </div>
      </div>
    </div>

    <div class="kanban-goal-row fade-in">
      <input type="text" id="kanban-goal-input" class="kanban-goal-input" placeholder="Give the team a goal — e.g. 'a set of fun neon web toys' or 'a tiny finance toolkit'" />
      <button class="kanban-assemble-btn" id="kanban-assemble-btn" type="button">&#10148; Assemble board</button>
    </div>
    <div class="kanban-note" id="kanban-note"></div>

    <div class="kanban-board">
      ${LANES.map(laneColumn).join('')}
    </div>
  `;

  async function load() {
    try {
      const res = await fetch('/api/kanban');
      const data = await res.json();
      cards = data.cards;
      renderBoard();
    } catch (err) {
      console.error('kanban load failed', err);
    }
  }

  async function addCard(lane, title) {
    if (!title.trim()) return;
    try {
      const res = await fetch('/api/kanban/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), lane }),
      });
      const data = await res.json();
      cards = Array.isArray(data.board) ? data.board : data.board.cards;
      renderBoard();
    } catch (err) {
      console.error('add card failed', err);
    }
  }

  async function moveCard(id, lane) {
    try {
      const res = await fetch(`/api/kanban/cards/${id}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lane }),
      });
      const data = await res.json();
      cards = Array.isArray(data.board) ? data.board : data.board.cards;
      renderBoard();
    } catch (err) {
      console.error('move card failed', err);
    }
  }

  async function deleteCard(id) {
    try {
      const res = await fetch(`/api/kanban/cards/${id}`, { method: 'DELETE' });
      const data = await res.json();
      cards = Array.isArray(data.board) ? data.board : data.board.cards;
      renderBoard();
    } catch (err) {
      console.error('delete card failed', err);
    }
  }

  let jobTimer = null;
  function watchJobs() {
    if (jobTimer) return;
    jobTimer = setInterval(async () => {
      const active = Object.values(jobs).filter((j) => j.status === 'running' || j.status === 'queued');
      if (!active.length) { clearInterval(jobTimer); jobTimer = null; return; }
      let stale = false;
      for (const j of active) {
        try {
          const res = await fetch(`/api/jobs/${j.id}`);
          if (!res.ok) continue;
          const data = await res.json();
          if (data.job.cardId) jobs[data.job.cardId] = data.job;
          else jobs['__plan__'] = data.job;
          if (data.job.status === 'done' || data.job.status === 'failed') stale = true;
        } catch { /* transient */ }
      }
      if (stale) await load(); else renderBoard();
    }, 2500);
  }

  document.getElementById('kanban-assemble-btn').addEventListener('click', async () => {
    const input = document.getElementById('kanban-goal-input');
    const goal = input.value.trim();
    const note = document.getElementById('kanban-note');
    if (!goal) { input.focus(); return; }
    try {
      const res = await fetch('/api/kanban/assemble', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'assemble failed');
      jobs['__plan__'] = data.job;
      note.textContent = 'Planner agent working — runs on your Claude Code CLI…';
      watchJobs();
      const poll = setInterval(async () => {
        const j = jobs['__plan__'];
        if (!j || j.status === 'done' || j.status === 'failed') {
          clearInterval(poll);
          note.textContent = j && j.status === 'failed' ? `Planner failed: ${j.error}` : '';
          if (j && j.status === 'done') { input.value = ''; await load(); }
        }
      }, 1000);
    } catch (err) {
      note.textContent = `Assemble failed: ${err.message}`;
    }
  });

  async function buildCard(id) {
    try {
      const res = await fetch(`/api/kanban/cards/${id}/build`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      jobs[id] = data.job;
      cards = Array.isArray(data.board) ? data.board : data.board.cards;
      renderBoard();
      watchJobs();
    } catch (err) {
      jobs[id] = { status: 'failed', stage: 'failed', error: err.message };
      renderBoard();
    }
  }

  // P24: reviewCard/acceptCard removed — no reviewer effector backs them.

  // Drag and drop + per-lane add inputs + delete, delegated on the board container.
  const board = mount.querySelector('.kanban-board');

  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.kanban-card');
    if (!card) return;
    e.dataTransfer.setData('text/plain', card.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
  });

  board.querySelectorAll('.kanban-lane').forEach((laneEl) => {
    laneEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      laneEl.classList.add('drag-over');
    });
    laneEl.addEventListener('dragleave', () => {
      laneEl.classList.remove('drag-over');
    });
    laneEl.addEventListener('drop', (e) => {
      e.preventDefault();
      laneEl.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      const targetLane = laneEl.dataset.lane;
      if (id) moveCard(id, targetLane);
    });
  });

  board.addEventListener('click', (e) => {
    const del = e.target.closest('[data-action="delete"]');
    if (del) return deleteCard(del.dataset.id);
    const build = e.target.closest('[data-action="build"]');
    if (build) return buildCard(build.dataset.id);
  });

  board.querySelectorAll('.kanban-add-input').forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        addCard(input.dataset.lane, input.value);
        input.value = '';
      }
    });
  });

  load();

  return () => {
    if (jobTimer) clearInterval(jobTimer);
    jobTimer = null;
  };
}
