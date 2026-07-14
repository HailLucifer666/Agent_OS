// conversation.js — P21 transcript panel. Scrollback of user/assistant turns
// (durable backlog via /api/conversation, live tail via WS 'conversation-turn'),
// plus a distinct "MYTHOS is asking you" block with Approve/Deny cards for a
// pending confirm (confirm-request) or workflow checkpoint (checkpoint created).
// Spoken "yes"/"no" resolves the same gate server-side; the buttons are the HUD half.
import { subscribe, confirmReply, checkpointReply } from '/js/ws.js';

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

export async function render(mount) {
  mount.innerHTML = `
    <div class="conv-pending" id="conv-pending" hidden></div>
    <div class="conv-list" id="conv-list"><div class="text-faint">Loading…</div></div>
  `;
  const turns = [];
  let pending = null; // { kind:'confirm'|'checkpoint', id, title }

  function renderTurns() {
    const el = mount.querySelector('#conv-list');
    if (!el) return;
    el.innerHTML = turns.slice(-200).map((t) =>
      `<div class="conv-turn conv-${t.role}"><span class="mono text-faint">${new Date(t.ts || Date.now()).toLocaleTimeString()}</span> ${escapeHtml(t.text || t.content)}</div>`
    ).join('') || '<div class="text-faint">No conversation yet. Click the orb and speak.</div>';
  }

  function renderPending() {
    const el = mount.querySelector('#conv-pending');
    if (!el) return;
    if (!pending) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const needsFeedback = pending.kind === 'checkpoint';
    el.innerHTML = `
      <div class="conv-asking">MYTHOS is asking you:</div>
      <div class="conv-question">${escapeHtml(pending.title)}</div>
      ${needsFeedback ? '<textarea class="conv-feedback" placeholder="Optional: what to change (used if you deny)"></textarea>' : ''}
      <div class="conv-actions"><button class="conv-approve">Approve</button><button class="conv-deny">Deny</button></div>
    `;
    const feedbackEl = el.querySelector('.conv-feedback');
    el.querySelector('.conv-approve').onclick = () => resolve(true, feedbackEl ? feedbackEl.value : undefined);
    el.querySelector('.conv-deny').onclick = () => resolve(false, feedbackEl ? feedbackEl.value : undefined);
  }

  function resolve(accept, feedback) {
    if (!pending) return;
    if (pending.kind === 'confirm') confirmReply(pending.id, accept);
    else checkpointReply(pending.id, accept, feedback);
    pending = null;
    renderPending();
  }

  try {
    const res = await fetch('/api/conversation?limit=100');
    const data = await res.json();
    turns.push(...(data.turns || []));
  } catch (_) { /* backlog is best-effort */ }
  renderTurns();
  renderPending();

  const unsub = subscribe(['conversation-turn', 'confirm-request', 'checkpoint'], (msg) => {
    if (msg.type === 'conversation-turn') { turns.push(msg.payload); renderTurns(); return; }
    if (msg.type === 'confirm-request') {
      pending = { kind: 'confirm', id: msg.payload.id, title: msg.payload.summary || msg.payload.tool };
      renderPending();
      return;
    }
    if (msg.type === 'checkpoint') {
      const c = msg.payload || {};
      if (c.event === 'created') { pending = { kind: 'checkpoint', id: c.id, title: c.title || c.body || 'Approval needed' }; renderPending(); }
      else if (c.event === 'resolved' && pending && pending.id === c.id) { pending = null; renderPending(); }
    }
  });

  return unsub;
}
