'use strict';

// see-and-click-settle.js — how long to wait before believing a click did nothing.
//
// BUG-396. see_and_click's oracle is "re-read the screen; if the text is
// identical, the click hit nothing that mattered". That is the right oracle and
// it was sampled at the wrong moment: once, immediately, with zero settle time.
//
// MEASURED on the operator's machine, 2026-08-28 (Episodic lines 40-45): the
// whole call — one full-desktop OCR read, the match, the click, a second
// full-desktop OCR read — took 1,474 ms, so the verifying read began roughly
// 700 ms after the click. A browser navigating to a new page does not repaint
// inside that window. The click had worked; the measurement had not.
//
// WHY A POLL AND NOT A SLEEP. A fixed delay would tax every fast UI to pay for
// the slow one. Polling costs nothing extra when the screen has already changed
// (the first read returns and the loop exits), and the budget is only spent when
// the answer is genuinely still "no change".
//
// WHY IT STAYS BOUNDED, AND WHAT THAT DELIBERATELY GIVES UP. Three attempts,
// 500 ms apart: about 3 s of wall clock once the OCR round trips are counted. A
// page slower than that is still reported UNVERIFIED — a false negative, which is
// the safe direction. Widening the window to catch it would widen the window in
// which some UNRELATED repaint (a clock, a notification, MYTHOS's own animating
// HUD on an unscoped whole-desktop read) satisfies `after.text !== beforeText`
// and turns a dead click into a claimed success. That trade is why the ceiling is
// low and why 'changed' keeps its weak wording while only `expect` reports
// `confirmed`.
//
// WHY `attempts` IS REPORTED BACK, on the UNVERIFIED result as much as the ok
// ones. "I looked three times across three seconds and it never moved" and "I
// looked once" are different amounts of evidence for the same sentence, and the
// caller cannot tell them apart from the wording alone. Reporting the count is
// the cheap half of not hiding how hard the oracle actually tried.
//
// This module is separate from from-pc.js for the same reason
// see-and-click-match.js is: the logic is worth testing without a screen, and
// from-pc.js sits on a one-directional size ceiling.

// Three post-click attempts. Raising this widens the false-positive window
// described above — see the block comment before changing it.
const SETTLE_ATTEMPTS = 3;
const SETTLE_BACKOFF_MS = 500;

// REF'D on purpose. from-pc.js's delegateWithRetry carries the same note and the
// history behind it (BUG-259): an unref'd timer never fires in a process with
// nothing else holding the event loop, which strands the promise at loop drain
// and gets the test killed by the runner rather than failing honestly.
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// read()      -> the same { ok, text, regions } shape readScreenRegions returns.
// beforeText  -> the pre-click OCR text, compared verbatim.
// expect      -> optional strong oracle; its presence short-circuits on a match.
// wait        -> test seam. The pure tests inject a counter so the logic runs
//                instantly; the effector's own tests still pay the real timer, so
//                neither the arithmetic nor the wiring is proven by fiat alone.
//
// Returns { kind, after, attempts } where kind is one of:
//   'unreadable' — a re-read failed. Distinct from 'unchanged': "I could not
//                  look" and "I looked and nothing moved" are different facts and
//                  collapsing them hides which one happened.
//   'expected'   — `expect` appeared. The strong oracle.
//   'changed'    — the screen text differs. Weak: something moved, not
//                  necessarily the thing that was clicked.
//   'unchanged'  — the budget ran out with the screen identical every time.
async function settleForChange(opts) {
  const options = opts || {};
  const read = options.read;
  const beforeText = options.beforeText;
  const attempts = (Number.isFinite(options.attempts) && options.attempts > 0)
    ? options.attempts : SETTLE_ATTEMPTS;
  const backoffMs = Number.isFinite(options.backoffMs) ? options.backoffMs : SETTLE_BACKOFF_MS;
  const wait = options.wait || sleep;
  const want = options.expect ? String(options.expect).trim().toLowerCase() : '';

  let after = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    after = await read();
    if (!after || !after.ok) return { kind: 'unreadable', after: after, attempts: attempt };
    if (want && String(after.text || '').toLowerCase().includes(want)) {
      return { kind: 'expected', after: after, attempts: attempt };
    }
    if (after.text !== beforeText) return { kind: 'changed', after: after, attempts: attempt };
    // No trailing wait after the final look — it would be latency nobody reads.
    if (attempt < attempts) await wait(backoffMs);
  }
  return { kind: 'unchanged', after: after, attempts: attempts };
}

module.exports = { settleForChange, SETTLE_ATTEMPTS, SETTLE_BACKOFF_MS };
