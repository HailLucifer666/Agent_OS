'use strict';

// implicit-target.js — the window a pid-omitted ui_type/ui_click aims at.
//
// THE CLASS, not the instance. This repo has now been bitten three times by the
// same shape: shared mutable state with no owner and no expiry, read back as
// authoritative. The capabilities manifest froze at CONNECTING because only the
// success paths rewrote it (BUG-366); the Live prompt froze its adapter snapshot
// at session open and labelled it current (BUG-046/136); and this. If a fourth
// appears, the question to ask first is not "what wrote the wrong value" but
// "who owns this, and when does it stop being true".
//
// WHY THIS IS ITS OWN MODULE. from-pc.js used to hold this as a bare
// module-scope `lastLaunchedPid`, set by launch_app and read by ui_type and
// ui_click. Two independent defects lived in that one variable (BUG-353), and
// both are the same shape: an implicit target that nothing bounds.
//
// 1. ANY launch overwrote it, including launches the operator never asked for.
//    The original comment called this a "known scope limit" and guessed at a
//    hypothetical future caller — "e.g. from-spotify.js's own auto-launch path,
//    IF it ever routes through this same function". It already did. Measured
//    2026-08-27 by driving the real effector with a stubbed pc-child:
//
//      launch_app('notepad')            -> implicit target 1111   (the operator)
//      launch_app('whatsapp')           -> implicit target 2222   (from-whatsapp
//                                          resolving its OWN window, internally)
//      ui_type('dear diary')  no pid    -> typed into 2222, ok:true
//
//    from-whatsapp.js and from-spotify.js call launch_app purely to resolve a
//    window they then address by EXPLICIT pid — neither has ever read the
//    implicit target. They were writing to a slot only the operator reads.
//
//    Worth naming precisely, because it explains why no honesty guard caught
//    it: ui_type's target cross-check compares pc-child's typedIntoPid against
//    the pid ui_type was TOLD to target. Those agreed. A cross-check on the
//    delivered target cannot see a target that was swapped before it ran.
//
// 2. It never expired. A pid recorded an hour ago was still the default for the
//    next pid-omitted call. close_window's own comment already made the
//    argument — "Windows recycles PIDs, so a stale value could target an
//    unrelated process" — and then applied it only to closes. A process that
//    dies without close_window (crash, operator clicks X, Task Manager) leaves
//    the pid behind to be recycled by something else.
//
// WHAT SCOPING KEY THIS DELIBERATELY DOES NOT USE. Binding the target to
// ctx.goalId is the obvious fix and it would be INERT where it matters:
// live-tool-adapter.js:833 dispatches every Live-voice tool call as
// `dispatchAction(decision, { tier, channel, traceId })` with no goalId at all,
// so on the voice path — the path that says "open notepad and type this" — the
// key would be null on both sides and match everything. traceId is no better:
// it is per tool CALL, so launch_app and the ui_type after it carry different
// ones and would never match. A mechanism that cannot see the traffic it exists
// to separate is not a guard, it is a comment with a runtime cost.
//
// So the split is made where the knowledge actually is: the internal callers
// declare themselves (see INTERNAL below), and the TTL bounds everything else
// including any future caller that forgets to.

// Two minutes. The implicit target exists to bridge one flow — launch_app, then
// the ui_type/ui_click that acts on what was launched. That is seconds of
// machine time, but the human confirm step sits inside it (ui_type's own FIX E
// comment records OS focus drifting during that round trip), and launch_app
// itself polls up to 6-8s for a windowed process. Two minutes clears a slow
// confirm with room to spare and still expires long before a pid can plausibly
// be recycled. It is not a security boundary; it is the difference between
// "the app you just opened" and "an app you opened at some point today".
var TTL_MS = 120000;

// THE TOOL DESCRIPTIONS WERE DELIBERATELY NOT CHANGED. ui_type and ui_click tell
// the model "If you just called launch_app, OMIT pid — the last-launched window is
// targeted automatically", and that stays true for the usage it describes: the
// target is live immediately after a SUCCESSFUL launch. The cases this module adds
// — expired, or cleared by a failed launch — are ones where the model already
// received a failure result from launch_app and should not be typing at all. Naming
// a 120s window in a tool description would invite the model to reason about clock
// time it cannot observe, and every edit to those strings moves behaviour on the
// live voice path. Pinned here so the omission reads as a decision, not an oversight.

// Pass as the ctx of a launch_app call made to resolve a window for the
// CALLER's own use, addressed afterwards by explicit pid. Such a launch must
// not become the operator's implicit target.
var INTERNAL = Object.freeze({ implicitTarget: false });

var current = null;      // { pid, at } or null
var clock = Date.now;    // injectable for tests; see _setClock

// True when this ctx belongs to a caller resolving its own window. Only an
// explicit `implicitTarget: false` opts out — an absent ctx (a direct call, a
// test) still records, which keeps every existing caller behaving as it did.
function isInternal(ctx) {
  return Boolean(ctx && ctx.implicitTarget === false);
}

// The only caller today (launch_app) has ALREADY established typeof pid ===
// 'number' via its byProcess check, so this guard is not mirroring that rule and
// must not grow into a second definition of "what counts as a pid" — from-pc's
// coercePid is the single one, and two resolvers disagreeing is the defect this
// whole repair pass exists to remove. It is here because remember() is public and
// a wrong pid recorded silently is the worst outcome available: ui_type would send
// it down for PowerShell to reject at Int32 binding, or worse, send a recycled
// number that binds fine. Anything that is not a pid records NOTHING.
function remember(pid) {
  // Number.isInteger, not typeof+isFinite: a pid is a positive integer, and the
  // isFinite form accepted 1.5 — caught by this module's own test, not by review.
  // Deliberately STRICTER on fractions than from-pc's coercePid, which shares that
  // laxness (pre-existing, left alone: it is a caller's one-shot argument, whereas a
  // value stored here outlives its call and gets aimed at a window later).
  if (!Number.isInteger(pid) || pid <= 0) return;
  current = { pid: pid, at: clock() };
}

// The live implicit target, or null. Expiry is evaluated on READ rather than on
// a timer: a timer would have to be unref'd not to hold the process open, and
// an unref'd timer that never fires is exactly how the capabilities manifest
// stayed wrong in BUG-366. Nothing here needs to happen at a moment in time —
// it only needs to be true whenever somebody asks.
function get() {
  if (!current) return null;
  if (clock() - current.at > TTL_MS) { current = null; return null; }
  return current.pid;
}

// Called on three occasions, and the third is the one BUG-353 asked for and
// nothing implemented: "clear on launch". A launch ATTEMPT moves the operator
// intent, so the previous target stops being what they mean whether or not the
// launch succeeds. Without that, an "open Spotify" that FAILED left Notepad as
// the implicit target and the next pid-omitted ui_type typed confidently into
// Notepad — a wrong-window WRITE, not merely a stale default. Clearing first
// means a failed launch leaves NO target, so ui_type falls through to its
// focused-window branch, which carries its own typedIntoTitle cross-check. No
// target beats a stale one. INTERNAL callers are exempt: from-whatsapp failing
// to resolve its own window is not the operator changing their mind.
//
// The other two: from-pc.js calls it at MODULE LOAD, and tests reset with it.
// The module-load call looks like a hack and is not — in production it runs once
// at boot with nothing launched to point at, and it is there because this state
// used to be declared IN from-pc.js, so the ~20 test files that reset it by
// dropping from-pc from the require cache would otherwise inherit a target from
// whichever test ran before them. "A fresh module instance owns no target" is
// better stated than depended upon.
function forget() { current = null; }

// Drop the target only if it is this pid. Used where a pid is proven dead (a
// focus that fails twice) or deliberately closed: clearing unconditionally
// would throw away a still-valid target that merely happens to be a different
// window from the one that just failed.
function forgetIf(pid) {
  if (current && Number(pid) === current.pid) current = null;
}

// Test seam. Pass a function returning ms; pass nothing to restore Date.now.
// Deliberately a clock the caller advances rather than fake timers: there is no
// timer here to fire, so a frozen clock would be measuring nothing.
function _setClock(fn) {
  clock = typeof fn === 'function' ? fn : Date.now;
  return clock;
}

module.exports = { TTL_MS, INTERNAL, isInternal, remember, get, forget, forgetIf, _setClock };
