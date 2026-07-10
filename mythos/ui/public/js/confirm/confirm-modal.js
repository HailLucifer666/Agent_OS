// confirm-modal.js — the tier-3/4 approval gate. CA of the spec's confirm.js,
// mounted ONCE globally at app init (never routed — a confirm-request must be
// visible whatever the user is looking at). Approve/Deny round-trips through
// ws.confirmReply -> server -> leash.confirm -> dispatchAction.

import { subscribe, confirmReply } from '../ws.js';

export function mountConfirmModal(root, opts) {
  const onResolved = (opts && opts.onResolved) || (() => {});
  let overlay = null;

  function closeModal() {
    if (overlay) { overlay.remove(); overlay = null; }
    onResolved();
  }

  function showModal(payload) {
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-modal glass">
        <div class="confirm-orb"></div>
        <div class="confirm-summary"></div>
        <div class="confirm-tier mono">TIER ${Number(payload.tier) || '?'}</div>
        <div class="confirm-actions">
          <button class="confirm-accept">Approve</button>
          <button class="confirm-reject">Deny</button>
        </div>
      </div>
    `;
    // textContent, not innerHTML — the summary embeds tool args (untrusted data).
    overlay.querySelector('.confirm-summary').textContent = payload.summary || payload.tool || 'Confirm action?';
    overlay.querySelector('.confirm-accept').addEventListener('click', () => {
      confirmReply(payload.id, true);
      closeModal();
    });
    overlay.querySelector('.confirm-reject').addEventListener('click', () => {
      confirmReply(payload.id, false);
      closeModal();
    });
    root.appendChild(overlay);
  }

  const unsub = subscribe(['confirm-request'], (msg) => showModal(msg.payload));

  return () => {
    unsub();
    if (overlay) { overlay.remove(); overlay = null; }
  };
}
