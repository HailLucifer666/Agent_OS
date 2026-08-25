// confirm-modal.js — the tier-3/4 approval gate. CA of the spec's confirm.js,
// mounted ONCE globally at app init (never routed — a confirm-request must be
// visible whatever the user is looking at). Approve/Deny round-trips through
// ws.confirmReply -> server -> leash.confirm -> dispatchAction.

import { subscribe, confirmReply } from '../ws.js';
import { trapFocus } from '../a11y/focus-trap.js';

export function mountConfirmModal(root, opts) {
  const onResolved = (opts && opts.onResolved) || (() => {});
  let overlay = null;
  let releaseTrap = null;
  let shownId = null;

  function closeModal() {
    shownId = null;
    if (releaseTrap) { releaseTrap(); releaseTrap = null; }
    if (overlay) { overlay.remove(); overlay = null; }
    onResolved();
  }

  function showModal(payload) {
    if (overlay) {
      if (releaseTrap) { releaseTrap(); releaseTrap = null; }
      overlay.remove();
    }
    shownId = payload.id;
    overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    // xss-safe: static template, no interpolation
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
    // The tier travels on the button itself so app.js's Thumb_Up handler — which
    // only ever sees `document.querySelector('.confirm-accept')` — can refuse to
    // approve a high tier by gesture. It reads the raw payload value, not the
    // rendered 'TIER ?' text, so canGestureAccept() sees a real absent tier as
    // absent and fails closed rather than parsing a placeholder.
    const accept = overlay.querySelector('.confirm-accept');
    if (payload.tier !== undefined && payload.tier !== null) accept.dataset.mythosTier = String(payload.tier);
    accept.addEventListener('click', (ev) => {
      // G4 (unattributable-consent finding): a real human click and app.js's
      // Thumb_Up gesture handler both fire this SAME 'click' event (it calls
      // .confirm-accept.click(), a genuine synchronous DOM click) — nothing
      // about the event itself tells the two apart. app.js tags the button
      // with data-mythos-surface='gesture' immediately before calling
      // .click(); since click() dispatches synchronously, that attribute is
      // already set by the time this listener runs. Read + clear it here so
      // a later, unrelated human click on the (re-created, per-showModal)
      // button never inherits a stale tag.
      const target = ev.currentTarget;
      const surface = target.dataset.mythosSurface === 'gesture' ? 'gesture' : 'click';
      delete target.dataset.mythosSurface;
      confirmReply(payload.id, true, surface);
      closeModal();
    });
    overlay.querySelector('.confirm-reject').addEventListener('click', () => {
      confirmReply(payload.id, false);
      closeModal();
    });
    root.appendChild(overlay);
    // Tab now cycles Approve/Deny inside the modal, Escape closes it, and
    // focus returns to whatever had focus before this popped up — none of
    // which existed before (a keyboard user could previously tab straight
    // out of a live confirm dialog into the HUD canvas behind it).
    releaseTrap = trapFocus(overlay, { onEscape: closeModal });
  }

  const unsub = subscribe(['confirm-request'], (msg) => showModal(msg.payload));

  // Approvals now have more than one surface (the phone answers the same
  // confirm-request), and the modal used to close only when THIS screen
  // clicked. Whoever resolves it, everyone else's prompt is dead — dismiss
  // rather than keep offering a button that is a silent no-op.
  const unsubResolved = subscribe(['confirm-resolved'], (msg) => {
    const p = msg && msg.payload;
    if (p && overlay && p.id === shownId) closeModal();
  });

  return () => {
    unsub();
    unsubResolved();
    if (releaseTrap) { releaseTrap(); releaseTrap = null; }
    if (overlay) { overlay.remove(); overlay = null; }
  };
}
