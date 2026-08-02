// goals.js — Goals surface: stat tiles, add-goal row, filter chips, goal list. Full CRUD against /api/goals.

import { attachMic } from './speech-to-text.js';
import { h, keyedList } from '../dom.js';

const CATEGORIES = ['General', 'Work', 'Personal', 'Learning', 'Health'];

let state = {
  goals: [],
  stats: { total: 0, active: 0, completed: 0, progress: 0 },
  filter: 'active', // active | done | all
};

function statTile(label, value, extra) {
  return `
    <div class="goals-tile fade-in">
      <div class="goals-tile-label mono">${label}</div>
      <div class="goals-tile-value mono">${value}</div>
      ${extra || ''}
    </div>
  `;
}

function categoryOptions(selected) {
  return CATEGORIES.map((c) => `<option value="${c}" ${c === selected ? 'selected' : ''}>${c}</option>`).join('');
}

// goalRow/updateGoalRow: built with dom.js's h() instead of an innerHTML
// template — text content (goal.text, goal.category) is always a real text
// node, so this is the point where the old hand-rolled escapeHtml() stops
// being needed. onToggle/onDelete are bound once, at row creation, and never
// rebound — keyedList() reuses this same node (via updateGoalRow) for every
// subsequent re-render, so toggling one goal no longer destroys and rebuilds
// every sibling row (losing focus/scroll/hover state on each toggle).
function goalRow(goal, onToggle, onDelete) {
  return h('div', { class: 'goals-row fade-in', 'data-id': goal.id },
    h('button', { class: `goals-check${goal.done ? ' done' : ''}`, 'aria-label': 'Toggle done', onClick: () => onToggle(goal.id) },
      goal.done ? '✓' : ''),
    h('div', { class: `goals-row-text${goal.done ? ' done' : ''}` }, goal.text),
    h('span', { class: 'goals-pill mono' }, goal.category || 'General'),
    h('button', { class: 'goals-delete', 'aria-label': 'Delete goal', onClick: () => onDelete(goal.id) }, '×'),
  );
}

function updateGoalRow(node, goal) {
  const check = node.querySelector('.goals-check');
  check.classList.toggle('done', goal.done);
  check.textContent = goal.done ? '✓' : '';
  const rowText = node.querySelector('.goals-row-text');
  rowText.classList.toggle('done', goal.done);
  rowText.textContent = goal.text;
  node.querySelector('.goals-pill').textContent = goal.category || 'General';
}

async function toggleGoal(id) {
  try {
    const res = await fetch(`/api/goals/${id}/toggle`, { method: 'POST' });
    const data = await res.json();
    applyData(data);
  } catch (err) {
    console.error('toggle goal failed', err);
  }
}

async function deleteGoal(id) {
  try {
    const res = await fetch(`/api/goals/${id}`, { method: 'DELETE' });
    const data = await res.json();
    applyData(data);
  } catch (err) {
    console.error('delete goal failed', err);
  }
}

function filteredGoals() {
  if (state.filter === 'active') return state.goals.filter((g) => !g.done);
  if (state.filter === 'done') return state.goals.filter((g) => g.done);
  return state.goals;
}

function renderGoalsUI() {
  const tiles = document.getElementById('goals-tiles');
  // xss-safe: labels are literals and every interpolated stat is coerced to a
  // number first, so a malformed /api/goals payload can't break out of the
  // style attribute.
  const pct = Number(state.stats.progress) || 0;
  tiles.innerHTML = [
    statTile('TOTAL', Number(state.stats.total) || 0),
    statTile('ACTIVE', Number(state.stats.active) || 0),
    statTile('COMPLETED', Number(state.stats.completed) || 0),
    statTile('PROGRESS', `${pct}%`, `<div class="goals-progress-track"><div class="goals-progress-fill" style="width:${pct}%"></div></div>`),
  ].join('');

  const chips = document.getElementById('goals-chips');
  chips.querySelectorAll('.goals-chip').forEach((chip) => {
    const f = chip.dataset.filter;
    chip.classList.toggle('active', f === state.filter);
    const label = f === 'active' ? 'Active' : f === 'done' ? 'Done' : 'All';
    const count = f === 'active' ? state.stats.active : f === 'done' ? state.stats.completed : state.stats.total;
    chip.textContent = `${label} · ${count}`;
  });

  const list = document.getElementById('goals-list');
  const items = filteredGoals();
  if (items.length === 0) {
    list.replaceChildren(h('div', { class: 'goals-empty' }, 'Nothing to chase right now. Add one above.'));
    return;
  }
  keyedList(list, items, (g) => g.id, (g) => goalRow(g, toggleGoal, deleteGoal), updateGoalRow);
}

function applyData(data) {
  state.goals = (data && Array.isArray(data.goals)) ? data.goals : [];
  state.stats = (data && data.stats) ? data.stats : { total: 0, active: 0, completed: 0, progress: 0 };
  renderGoalsUI();
}

export async function render(mount) {
  // xss-safe: static template, no interpolation
  mount.innerHTML = `
    <div class="goals-tiles" id="goals-tiles"></div>
    <div class="goals-add-panel fade-in">
      <div class="goals-add-head">
        <span class="goals-add-icon">&#9678;</span>
        <span>Add a goal</span>
      </div>
      <div class="goals-add-row">
        <button class="goals-mic-btn" type="button" aria-label="Voice input" disabled>&#127908;</button>
        <input type="text" id="goals-input" class="goals-text-input" placeholder="What's the goal? (Enter to add)" />
        <select id="goals-category" class="goals-category-select">
          <option value="General">No category</option>
          ${CATEGORIES.filter((c) => c !== 'General').map((c) => `<option value="${c}">${c}</option>`).join('')}
        </select>
        <button class="goals-add-btn" id="goals-add-btn" type="button">+ Add</button>
      </div>
    </div>
    <div class="goals-filter-row">
      <div class="goals-chips" id="goals-chips">
        <button class="goals-chip" data-filter="active">Active</button>
        <button class="goals-chip" data-filter="done">Done</button>
        <button class="goals-chip" data-filter="all">All</button>
      </div>
      <div class="goals-saved-label mono">SAVED TO AGENTIC OS/GOALS.MD</div>
    </div>
    <div class="goals-list" id="goals-list"></div>
  `;

  async function load() {
    try {
      const res = await fetch('/api/goals');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      applyData(data);
    } catch (err) {
      console.error('goals load failed', err);
      const list = document.getElementById('goals-list');
      // h() makes the message a text node — err.message is never markup here.
      if (list) list.replaceChildren(h('div', { class: 'goals-empty' },
        `Could not load goals: ${err && err.message ? err.message : err}. Close and reopen this panel to retry.`));
    }
  }

  async function addGoal() {
    const input = document.getElementById('goals-input');
    const select = document.getElementById('goals-category');
    const text = input.value.trim();
    if (!text) return;
    try {
      const res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, category: select.value }),
      });
      const data = await res.json();
      applyData(data);
      input.value = '';
      input.focus();
    } catch (err) {
      console.error('add goal failed', err);
    }
  }

  document.getElementById('goals-add-btn').addEventListener('click', addGoal);
  document.getElementById('goals-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addGoal();
  });

  // Voice drafting into the goal input. Button is disabled in the template; attachMic
  // re-enables it only when the browser exposes SpeechRecognition (honest-disable otherwise).
  attachMic(document.querySelector('.goals-mic-btn'), document.getElementById('goals-input'));

  document.getElementById('goals-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.goals-chip');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    renderGoalsUI();
  });

  await load();
}
