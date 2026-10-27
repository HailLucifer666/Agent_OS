// focus-trap.js — shared modal focus containment: Tab/Shift+Tab cycle within
// the given root, Escape invokes onEscape, focus returns to the trigger
// element on release. Replaces the ad hoc focus handling duplicated across
// confirm-modal.js (had none) and ApprovalGateModal.js (manual
// cancelBtn.focus() + a leaked document keydown listener whose cleanup was
// dead code — see ApprovalGateModal.js's git history).
//
// Scope note: this is for the two actual modals (confirm-modal.js,
// ApprovalGateModal.js). Overlay/glass panels (overlay-manager.js) are
// deliberately NOT modal — the HUD stays interactive underneath by design —
// so they use native `inert` + focus-on-open instead of a full trap. Do not
// wire this into overlay-manager.js's openPanel().
const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// initialFocus: a selector inside root to focus first instead of the first
// focusable element — the confirm modal starts on Deny (see confirm-modal.js).
export function trapFocus(root, { onEscape, initialFocus } = {}) {
  const trigger = document.activeElement;

  function focusables() {
    // offsetParent === null excludes display:none elements that still match
    // the selector (e.g. ApprovalGateModal.js's feedback textarea, present in
    // the DOM but display:none outside the "requesting-changes" state) —
    // without this they'd wrongly count as the Tab-wrap boundary while never
    // actually being reachable by a real Tab press.
    return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null);
  }

  function onKeydown(e) {
    if (e.key === 'Escape' && onEscape) { onEscape(); return; }
    if (e.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  document.addEventListener('keydown', onKeydown);
  const first = (initialFocus && root.querySelector(initialFocus)) || focusables()[0];
  if (first) first.focus();

  return function release() {
    document.removeEventListener('keydown', onKeydown);
    if (trigger && trigger.focus) trigger.focus();
  };
}
