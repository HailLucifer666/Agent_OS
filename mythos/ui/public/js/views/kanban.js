// kanban.js — Agent Kanban surface: static Phase-1 chrome + real drag-and-drop CRUD board via /api/kanban.

import { h, keyedList } from '../dom.js';

const LANES = [
  { id: 'backlog', label: 'BACKLOG', dot: 'amber', empty: 'Give the team a goal above — the Planner fills this column with cards.' },
  { id: 'building', label: 'BUILDING', dot: 'amber', empty: '' },
  { id: 'review', label: 'REVIEW', dot: 'blue', empty: '' },
  { id: 'done', label: 'DONE', dot: 'green', empty: '' },
];

let cards = [];
let jobs = {}; // cardId -> latest job record
let jobTimer = null;

// cardBody/cardNode/updateCardNode: built with dom.js's h() instead of an
// innerHTML template. A card's visible content depends on job status (busy/
// failed/verdict) as much as on the card record itself, and either can change
// independently (a poll tick can flip busy->failed with no card-array change
// at all) — rather than hand-patch which optional blocks are currently present
// (title/detail/status/artifact/verdict/actions all conditional), updateFn
// rebuilds this ONE card's children in place via replaceChildren(). The outer
// <div class="kanban-card"> node itself is never destroyed or recreated, so
// keyedList still delivers the actual fix: a status change on one card no
// longer rebuilds every sibling card in the lane (losing scroll/hover/
// in-flight drag state on cards nothing happened to).
function cardBody(card) {
  const job = jobs[card.id];
  const busy = job && (job.status === 'running' || job.status === 'queued');
  const failed = job && job.status === 'failed';
  const children = [h('div', { class: 'kanban-card-title' }, card.title)];

  if (card.detail) children.push(h('div', { class: 'kanban-card-detail' }, card.detail));
  if (busy) children.push(h('div', { class: 'kanban-card-status mono' }, `agent: ${job.stage}`));
  if (failed) children.push(h('div', { class: 'kanban-card-status kanban-card-error' }, job.error || 'agent failed'));
  if (card.artifact && card.artifact.path) {
    children.push(h('a', { class: 'kanban-card-artifact', href: card.artifact.path, target: '_blank', rel: 'noopener' },
      `▷ ${card.artifact.title || 'view build'}`));
  }
  if (card.reviewVerdict) {
    children.push(h('div', { class: `kanban-card-verdict ${card.reviewVerdict}` },
      `${card.reviewVerdict === 'approve' ? '✅' : '❌'} ${card.reviewNotes || ''}`));
  }

  const actions = [];
  if (card.lane === 'backlog' && !busy) {
    actions.push(h('button', { class: 'kanban-card-action', type: 'button', onClick: () => buildCard(card.id) }, '🛠 Build'));
  }
  if (card.lane === 'review' && !card.reviewVerdict && !busy) {
    actions.push(h('button', { class: 'kanban-card-action', type: 'button', onClick: () => reviewCard(card.id) }, '✅ Review'));
  }
  if (card.lane === 'review' && card.reviewVerdict === 'approve') {
    actions.push(h('button', { class: 'kanban-card-action', type: 'button', onClick: () => acceptCard(card.id, 'done') }, '✓ Accept → Done'));
  }
  if (card.lane === 'review' && card.reviewVerdict === 'reject') {
    actions.push(h('button', { class: 'kanban-card-action', type: 'button', onClick: () => acceptCard(card.id, 'backlog') }, '↩ Send back'));
  }
  actions.push(h('button', { class: 'kanban-card-delete', type: 'button', 'aria-label': 'Delete card', onClick: () => deleteCard(card.id) }, '×'));
  children.push(h('div', { class: 'kanban-card-footer' }, ...actions));

  return children;
}

function cardNode(card) {
  // draggable must be the literal string 'true' — it's an HTML enumerated
  // attribute (like contenteditable), not a boolean attribute like disabled;
  // h()'s boolean shorthand would emit draggable="" which browsers do not
  // treat the same as draggable="true".
  return h('div', { class: 'kanban-card fade-in', draggable: 'true', 'data-id': card.id }, ...cardBody(card));
}

function updateCardNode(node, card) {
  node.replaceChildren(...cardBody(card));
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
      body.replaceChildren(...(lane.empty ? [h('div', { class: 'kanban-empty' }, lane.empty)] : []));
      return;
    }
    keyedList(body, items, (c) => c.id, cardNode, updateCardNode);
  });
}

async function buildCard(id) {
  try {
    const res = await fetch(`/api/kanban/cards/${id}/build`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    jobs[id] = data.job;
    cards = (data && data.board && (Array.isArray(data.board) ? data.board : data.board.cards)) || [];
    renderBoard();
    watchJobs();
  } catch (err) {
    jobs[id] = { status: 'failed', stage: 'failed', error: err.message };
    renderBoard();
  }
}

async function reviewCard(id) {
  try {
    const res = await fetch(`/api/kanban/cards/${id}/review`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    jobs[id] = data.job;
    renderBoard();
    watchJobs();
  } catch (err) {
    jobs[id] = { status: 'failed', stage: 'failed', error: err.message };
    renderBoard();
  }
}

async function acceptCard(id, lane) {
  try {
    const res = await fetch(`/api/kanban/cards/${id}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lane }),
    });
    const data = await res.json();
    cards = (data && data.board && (Array.isArray(data.board) ? data.board : data.board.cards)) || [];
    renderBoard();
  } catch (err) {
    console.error('accept failed', err);
  }
}

async function deleteCard(id) {
  try {
    const res = await fetch(`/api/kanban/cards/${id}`, { method: 'DELETE' });
    const data = await res.json();
    cards = (data && data.board && (Array.isArray(data.board) ? data.board : data.board.cards)) || [];
    renderBoard();
  } catch (err) {
    console.error('delete card failed', err);
  }
}

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

async function load() {
  try {
    const res = await fetch('/api/kanban');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cards = (data && Array.isArray(data.cards)) ? data.cards : [];
    renderBoard();
  } catch (err) {
    console.error('kanban load failed', err);
    cards = [];
    renderBoard();
    const note = document.getElementById('kanban-note');
    if (note) note.textContent = `Could not load the board: ${err.message}`;
  }
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
            <span class="kanban-team-pill">&#9986; local team</span>
          </div>
          <div class="kanban-subtitle">A team of local agents plans, builds + reviews &mdash; live, on your machine</div>
        </div>
      </div>
      <div class="kanban-header-right">
        <div class="kanban-toggle-group">
          <button class="kanban-toggle active" type="button">&#9638; Board</button>
          <span class="kanban-toggle">&#128193; Workspace</span>
        </div>
        <div class="kanban-role-pills">
          <span class="kanban-role-pill">&#8853; Planner</span>
          <span class="kanban-role-pill">&#128736; Builder</span>
          <span class="kanban-role-pill">&#9989; Reviewer</span>
        </div>
      </div>
    </div>

    <div class="kanban-goal-row fade-in">
      <input type="text" id="kanban-goal-input" class="kanban-goal-input" placeholder="Give the team a goal — e.g. 'a set of fun neon web toys' or 'a tiny finance toolkit'" />
      <button class="kanban-assemble-btn" id="kanban-assemble-btn" type="button">&#10148; Assemble board</button>
    </div>
    <div class="kanban-note" id="kanban-note" aria-live="polite"></div>

    <div class="kanban-board">
      ${LANES.map(laneColumn).join('')}
    </div>
  `;

  async function addCard(lane, title) {
    if (!title.trim()) return;
    try {
      const res = await fetch('/api/kanban/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), lane }),
      });
      const data = await res.json();
      cards = (data && data.board && (Array.isArray(data.board) ? data.board : data.board.cards)) || [];
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
      cards = (data && data.board && (Array.isArray(data.board) ? data.board : data.board.cards)) || [];
      renderBoard();
    } catch (err) {
      console.error('move card failed', err);
    }
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

  // Drag and drop + per-lane add inputs, delegated on the board container.
  // Card action buttons (build/review/accept/delete) bind their own click
  // handlers directly at creation time now (see cardBody() above) — there is
  // no longer a delegated board-level click handler for them.
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

  board.querySelectorAll('.kanban-add-input').forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        addCard(input.dataset.lane, input.value);
        input.value = '';
      }
    });
  });

  await load();

  return () => {
    if (jobTimer) clearInterval(jobTimer);
    jobTimer = null;
  };
}
