// gesture-confirm.js — the ONE decision that says whether a recognised
// Thumb_Up may approve a pending leash confirm. Extracted as a pure function
// for the same reason gesture-mic.js is: app.js's GESTURE_ACTIONS map touches
// the DOM, so the *decision* is the only part node:test can exercise — see
// test/gesture-confirm-tier.test.js.
//
// WHY A TIER CEILING (operator decision, 2026-08-12). Thumb_Up called
// .confirm-accept.click() for ANY pending confirm, including tier 3 and 4 —
// sending, deleting, running commands. The existing safeguards are real but
// they are all anti-flicker, not anti-false-positive: MediaPipe top-1 must be
// Thumb_Up at score >= 0.6 for 3 consecutive ~150ms detections (~450ms hold),
// and one pose is one press (vision/gesture-debounce.js). None of that
// distinguishes "the operator meant to approve" from "the recogniser read a
// resting hand as a thumbs-up for half a second". Attribution in the audit
// (surface: 'gesture') records which surface approved; it does not prevent the
// approval. So the destructive tiers now require a real click or the phone,
// and the hands-free path keeps the low-risk ones.
//
// FAIL CLOSED. A missing, non-numeric or unparseable tier refuses. The modal
// renders `TIER ?` in exactly that case, so an unknown tier is a real state,
// not a theoretical one — and an unknown tier is precisely when a silent
// gesture approval is least defensible.
export const MAX_GESTURE_ACCEPT_TIER = 2;

// A bare Number() coercion is NOT enough here and the first draft of this
// function got it wrong: Number(null), Number(''), Number(' ') and Number([])
// are all 0, which is finite and <= the ceiling, so every one of those absent-
// tier cases would have READ AS TIER 0 AND APPROVED. The whole point of the
// gate is that an unknown tier refuses, so accept only a real number or a
// string that is entirely digits.
export function canGestureAccept(tier) {
  let n;
  if (typeof tier === 'number') n = tier;
  else if (typeof tier === 'string' && /^\d+$/.test(tier.trim())) n = Number(tier.trim());
  else return false;
  if (!Number.isFinite(n)) return false;
  return n <= MAX_GESTURE_ACCEPT_TIER;
}
