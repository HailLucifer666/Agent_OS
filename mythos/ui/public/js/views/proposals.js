import { escapeHtml, escapeAttr } from '../url.js';
// proposals.js — V5 (Phase 4): MYTHOS goal-proposal queue.
//
// The cortex's mull() loop sometimes proposes goals via the propose_goal
// effector (status:'proposed' — inert, the arbiter ignores them). This view
// surfaces that queue for one-tap accept (→ active + Goals.md) or reject
// (→ deleted). Mirrors goals.js view shape.

const API = {
  list: () => fetch('/api/goals/proposals').then((r) => r.json()),
  accept: (id) => fetch(`/api/goals/${id}/accept`, { method: 'POST' }).then((r) => r.json()),
  reject: (id) => fetch(`/api/goals/${id}/reject`, { method: 'POST' }).then((r) => r.json()),
};

let state = { proposals: [], busy: false };

function proposalRow(p) {
  const when = p.createdAt ? new Date(p.createdAt).toLocaleString() : '';
  const driveChip = p.drive ? `<span class="goals-pill mono">${escapeHtml(p.drive)}</span>` : '';
  const catChip = p.category ? `<span class="goals-pill mono">${escapeHtml(p.category)}</span>` : '';
  return `
    <div class="goals-row fade-in" data-id="${escapeAttr(p.id)}">
      <div class="goals-row-text">
        ${escapeHtml(p.text)}
        ${p.reason ? `<div class="muted small">${escapeHtml(p.reason)}</div>` : ''}
        ${when ? `<div class="muted small">${escapeHtml(when)}</div>` : ''}
      </div>
      ${catChip}
      ${driveChip}
      <button class="hud-btn small ok" data-action="accept" aria-label="Accept proposal">Accept</button>
      <button class="hud-btn small danger" data-action="reject" aria-label="Reject proposal">Reject</button>
    </div>
  `;
}

function renderUI(mount) {
  // xss-safe: all interpolated fields escaped
  mount.innerHTML = `
    <div class="hud-section">
      <div class="hud-section-header">
        <h3>MYTHOS PROPOSALS</h3>
        <button class="hud-btn small" id="proposals-refresh">Refresh</button>
      </div>
      <p class="muted small">
        Goals MYTHOS has suggested during quiet moments. Accept to activate
        (it joins your Goals list); reject to dismiss. The cortex never
        activates goals without your confirmation.
      </p>
      <div id="proposals-list">
        ${state.proposals.length === 0
          ? '<div class="muted">No pending proposals. MYTHOS will surface suggestions here as it mulls.</div>'
          : state.proposals.map(proposalRow).join('')}
      </div>
    </div>
  `;

  mount.querySelector('#proposals-refresh')?.addEventListener('click', () => refresh(mount));
  mount.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      if (state.busy) return;
      const row = ev.currentTarget.closest('[data-id]');
      if (!row) return;
      const id = row.getAttribute('data-id');
      const action = ev.currentTarget.getAttribute('data-action');
      state.busy = true;
      try {
        if (action === 'accept') await API.accept(id);
        else if (action === 'reject') await API.reject(id);
        await refresh(mount);
      } catch (err) {
        console.error('proposal action failed', err);
      } finally {
        state.busy = false;
      }
    });
  });
}

async function refresh(mount) {
  try {
    const data = await API.list();
    state.proposals = Array.isArray(data.proposals) ? data.proposals : [];
  } catch (err) {
    state.proposals = [];
    console.error('proposal list failed', err);
  }
  renderUI(mount);
}

export async function render(mount) {
  await refresh(mount);
  // No teardown needed — event listeners live on mount, which gets replaced on close.
  return null;
}
