'use strict';

// test/electron-cursor-overlay.test.js — Step 7 / Track A2, Slice 5 of 6:
// the floating cursor overlay ("summon at cursor, OS-level" in the roadmap's
// feature-parity table — MYTHOS-IRIS-Synthesis-Plan.md).
//
// Two layers, each tested at the level it can honestly be tested at:
//
//   1. electron/cursor-overlay-window.js — the controller. No top-level
//      `require('electron')` and an INJECTED BrowserWindow + screen module
//      (media-window.js's testability pattern), so this is a REAL unit test
//      against fakes, not a source-shape guard — the bulk of the behavior
//      that matters (click-through, no stolen focus, no window at boot,
//      reuse-not-stack, auto-hide, teardown) is asserted directly.
//
//   2. electron/main.js — the hotkey registration + opt-in gate. main.js
//      cannot be require()d under a bare `node --test` (it loads the real
//      `electron` module and calls app.whenReady()), so this half is guarded
//      by SOURCE-SHAPE assertions, the same pattern as
//      electron-ocr-hotkey.test.js and electron-screen-share.test.js.
//
// Plus an AD-8 regression test: this slice must add NO preload channel.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const MYTHOS_DIR = path.join(__dirname, '..');

function readSource(...segs) {
  return fs.readFileSync(path.join(...segs), 'utf8');
}

const {
  overlayBoundsForCursor,
  createCursorOverlayController,
  OVERLAY_SIZE,
} = require('../../electron/cursor-overlay-window');

// ---------------------------------------------------------------------------
// Layer 1a — overlayBoundsForCursor: pure math, no fakes needed.
// ---------------------------------------------------------------------------

test('Slice 5 / overlayBoundsForCursor: centers a size-px square on the cursor point', () => {
  const bounds = overlayBoundsForCursor({ x: 500, y: 300 }, 56);
  assert.deepEqual(bounds, { x: 472, y: 272, width: 56, height: 56 });
});

test('Slice 5 / overlayBoundsForCursor: rejects a malformed point instead of producing NaN bounds', () => {
  for (const bad of [null, undefined, {}, { x: 1 }, { x: 'a', y: 2 }, { x: NaN, y: 2 }, { x: Infinity, y: 2 }]) {
    assert.equal(overlayBoundsForCursor(bad), null, `must refuse ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// Layer 1b — createCursorOverlayController: real behavior against fakes.
// ---------------------------------------------------------------------------

class FakeOverlayWindow {
  constructor(opts) {
    this.opts = opts;
    this.destroyed = false;
    this.bounds = null;
    this.visible = false;
    this.loadedUrl = null;
    this.ignoreMouseEventsCalls = [];
    this._closedHandlers = [];
  }
  setBounds(b) { this.bounds = b; }
  loadURL(u) { this.loadedUrl = u; }
  setIgnoreMouseEvents(ignore, opts) { this.ignoreMouseEventsCalls.push([ignore, opts]); }
  showInactive() { this.visible = true; this.wasShownActive = false; }
  show() { this.visible = true; this.wasShownActive = true; }
  hide() { this.visible = false; }
  isDestroyed() { return this.destroyed; }
  close() { this.destroyed = true; this._closedHandlers.forEach((h) => h()); }
  on(event, handler) { if (event === 'closed') this._closedHandlers.push(handler); }
}

function fakeController(overrides) {
  const created = [];
  let cursorPoint = { x: 100, y: 200 };
  const BrowserWindowCtor = function (opts) {
    const w = new FakeOverlayWindow(opts);
    created.push(w);
    return w;
  };
  const screenModule = { getCursorScreenPoint: () => cursorPoint };
  const controller = createCursorOverlayController(Object.assign(
    { BrowserWindowCtor, screenModule, autoHideMs: 20 },
    overrides,
  ));
  return { controller, created, setCursor: (p) => { cursorPoint = p; } };
}

test('Slice 5 / controller: requires a BrowserWindowCtor and a screenModule', () => {
  assert.throws(() => createCursorOverlayController({ screenModule: { getCursorScreenPoint: () => ({}) } }),
    /BrowserWindowCtor/);
  // A MISSING screenModule is still a construction-time error — that check is
  // safe because it never reads a property off the object (see the test below
  // for why that distinction is the whole ballgame).
  assert.throws(() => createCursorOverlayController({ BrowserWindowCtor: function () {} }),
    /screenModule/);
});

// REGRESSION — this is the bug that took MYTHOS's whole Electron shell down on
// the first real boot (commit 3050889, found by the operator in Track C):
//
//   Error: The 'screen' module can't be used before the app 'ready' event
//       at createCursorOverlayController (electron/cursor-overlay-window.js:63)
//       at Object.<anonymous> (electron/main.js:227)
//
// Electron's `screen` export is a LAZY GETTER that throws until app.ready, so
// merely *reading a property off it* is "using" it. The original constructor
// validated with `typeof screenModule.getCursorScreenPoint !== 'function'`, and
// that read fired the getter — meaning the defensive guard itself was the crash.
// The old version of the test above actively REQUIRED that eager read, so 16
// passing tests could not have caught this; one of them mandated it.
//
// The contract is therefore stricter than "don't call it early": construction
// must touch NO property of an injected Electron module. A throwing getter is
// the faithful way to express that in a unit test, with no Electron involved.
test('Slice 5 / controller: construction touches NO property of screenModule (app-ready lazy getter)', () => {
  let reads = 0;
  const preReadyScreen = {};
  Object.defineProperty(preReadyScreen, 'getCursorScreenPoint', {
    configurable: true,
    get() {
      reads += 1;
      throw new Error("The 'screen' module can't be used before the app 'ready' event");
    },
  });

  let controller;
  assert.doesNotThrow(
    () => { controller = createCursorOverlayController({ BrowserWindowCtor: function () {}, screenModule: preReadyScreen }); },
    'constructing the controller must not read any property of screenModule — that is what crashed the shell',
  );
  assert.equal(reads, 0, 'no property of screenModule may be read at construction time');

  // And when the property IS finally touched (at show(), after app.ready in
  // production), a throw must be surfaced as a failed show rather than an
  // uncaught exception — a globalShortcut callback that throws takes down the
  // entire main process.
  assert.throws(() => controller.show(), /app 'ready' event|screenModule/);
  assert.ok(reads > 0, 'show() is where the property access belongs');
});

test('Slice 5 / controller: no window is created until show() is called', () => {
  const { created } = fakeController();
  assert.equal(created.length, 0, 'construction alone must never spawn a window — opt-in means opt-in');
});

test('Slice 5 / controller: show() creates a click-through, never-focused window centered on the cursor', () => {
  const { controller, created } = fakeController();
  const ok = controller.show();
  assert.equal(ok, true);
  assert.equal(created.length, 1);
  const w = created[0];

  assert.deepEqual(w.bounds, { x: 100 - OVERLAY_SIZE / 2, y: 200 - OVERLAY_SIZE / 2, width: OVERLAY_SIZE, height: OVERLAY_SIZE });
  assert.deepEqual(w.ignoreMouseEventsCalls[0], [true, { forward: true }],
    'click-through must be the default, with forward:true so hover state still reaches the real target underneath');
  assert.equal(w.opts.transparent, true);
  assert.equal(w.opts.alwaysOnTop, true);
  assert.equal(w.opts.frame, false);
  assert.equal(w.opts.focusable, false, 'the overlay must never be eligible to receive keyboard focus');
  assert.equal(w.opts.show, false, 'must not auto-show on construction');
  assert.equal(w.opts.webPreferences.sandbox, true);
  assert.equal(w.opts.webPreferences.preload, undefined, 'AD-8: no preload script for this window at all');
  assert.equal(w.visible, true);
  assert.equal(w.wasShownActive, false, 'must use showInactive(), never show() — a global hotkey must not steal focus');
  assert.match(String(w.loadedUrl), /^data:text\/html,/, 'content must be a static inline data: URL, nothing fetched');
});

test('Slice 5 / controller: a second show() reuses the window and repositions it, never stacking', () => {
  const { controller, created, setCursor } = fakeController();
  controller.show();
  setCursor({ x: 900, y: 50 });
  controller.show();
  assert.equal(created.length, 1, 'must reuse the existing window rather than creating a second');
  assert.deepEqual(created[0].bounds, { x: 900 - OVERLAY_SIZE / 2, y: 50 - OVERLAY_SIZE / 2, width: OVERLAY_SIZE, height: OVERLAY_SIZE });
});

test('Slice 5 / controller: show() on a malformed cursor point is a no-op, not a throw', () => {
  const created = [];
  const BrowserWindowCtor = function (opts) { const w = new FakeOverlayWindow(opts); created.push(w); return w; };
  const screenModule = { getCursorScreenPoint: () => null };
  const controller = createCursorOverlayController({ BrowserWindowCtor, screenModule });
  const ok = controller.show();
  assert.equal(ok, false);
  assert.equal(created.length, 0, 'a bad cursor read must never spawn an unpositioned window');
});

test('Slice 5 / controller: auto-hides after autoHideMs without an explicit hide() call', async () => {
  const { controller, created } = fakeController({ autoHideMs: 15 });
  controller.show();
  assert.equal(created[0].visible, true);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(created[0].visible, false, 'the overlay must not linger forever — it auto-hides');
});

test('Slice 5 / controller: hide() before the timer clears it, and is safe with no window', () => {
  const { controller, created } = fakeController();
  controller.hide(); // no window yet — must not throw
  controller.show();
  controller.hide();
  assert.equal(created[0].visible, false);
});

test('Slice 5 / controller: destroy() closes the window and clears state', () => {
  const { controller, created } = fakeController();
  controller.show();
  controller.destroy();
  assert.equal(created[0].destroyed, true);
  assert.equal(controller.getWindow(), null);
});

// ---------------------------------------------------------------------------
// Layer 2 — electron/main.js wiring (source-shape, per Slice 2/3 precedent).
// ---------------------------------------------------------------------------

const MAIN = readSource(REPO_ROOT, 'electron', 'main.js');

test('Slice 5 / electron: cursor overlay is opt-in and defaults OFF', () => {
  assert.match(MAIN, /MYTHOS_CURSOR_OVERLAY_ENABLED/, 'must be gated by an explicit env flag');
  const flagBlock = MAIN.slice(MAIN.indexOf('CURSOR_OVERLAY_ENABLED = false'), MAIN.indexOf('CURSOR_OVERLAY_ENABLED = false') + 400);
  assert.match(flagBlock, /=== 'true'/, 'only the literal string "true" may enable it — anything else (missing/garbled) stays off');
  assert.match(MAIN, /createCursorOverlayController\(/, 'must wire the real controller');
});

test('Slice 5 / electron: registers a Control+Alt+C accelerator with fallbacks and an env override, only when enabled', () => {
  assert.match(MAIN, /Control\+Alt\+C/, 'the documented default accelerator');
  assert.match(MAIN, /Control\+Shift\+C/, 'at least one fallback accelerator must exist');
  assert.match(MAIN, /MYTHOS_HOTKEY_CURSOR_OVERLAY/, 'the accelerator must be overridable by env');
  const fnStart = MAIN.indexOf('function cursorOverlayHotkeyCandidates');
  assert.ok(fnStart > -1, 'cursorOverlayHotkeyCandidates must exist');
  const fn = MAIN.slice(fnStart, MAIN.indexOf('\n}', fnStart));
  assert.match(fn, /if \(!CURSOR_OVERLAY_ENABLED\) return \[\]/,
    'must return zero candidates when the opt-in flag is off — fail-closed, not fail-open');
});

test('Slice 5 / electron: the hotkey callback never throws, and show() runs behind a guard', () => {
  const block = MAIN.slice(MAIN.indexOf('function registerCursorOverlayHotkey'));
  assert.match(block, /cursorOverlayController\.show\(\)/);
  assert.match(block, /catch \(err\)/, 'a globalShortcut callback that throws takes down the whole main process');
  assert.match(block, /globalShortcut\.isRegistered\(/,
    "register()'s return value alone is not authoritative — isRegistered must confirm it");
});

test('Slice 5 / electron: registered alongside the other hotkeys, and torn down on quit', () => {
  // Deliberately NOT an adjacent-lines regex any more. The controller is now
  // built between registerOcrGrabHotkey() and registerCursorOverlayHotkey()
  // (see the boot-ordering test below), so requiring the three calls to be
  // consecutive would forbid the fix. What actually matters is that all three
  // run inside whenReady, before the block ends.
  const readyStart = MAIN.indexOf('app.whenReady()');
  assert.ok(readyStart > -1, 'app.whenReady() must exist');
  const readyBlock = MAIN.slice(readyStart, MAIN.indexOf("app.on('window-all-closed'", readyStart));
  for (const fn of ['registerTalkHotkey()', 'registerOcrGrabHotkey()', 'registerCursorOverlayHotkey()']) {
    assert.ok(readyBlock.includes(fn), `${fn} must be called inside app.whenReady()`);
  }
  // RE-POINTED 2026-09-18 (BUG-437). The teardown moved out of the before-quit
  // handler and into the quit sequence's closeSecondaryWindows step, which runs
  // at the same point in the shutdown — early, before the child stop — so the
  // window does not sit on screen for the length of the quit. The pin's point
  // was never WHERE it sits: it is that the destroy call exists and is guarded,
  // because cursorOverlayController is null whenever the overlay is disabled,
  // which is the default. Both are still asserted, at the new location.
  const teardown = MAIN.slice(MAIN.indexOf('closeSecondaryWindows:'), MAIN.indexOf('killTree,'));
  assert.ok(teardown.length > 0, 'the quit sequence must have a closeSecondaryWindows step');
  assert.match(teardown, /cursorOverlayController\) cursorOverlayController\.destroy\(\)/,
    'the overlay must be released on quit, and guarded — it is null when disabled');
  assert.match(teardown, /mediaWindowController\.closeMediaWindow\(\)/,
    'and the media window goes with it — a secondary window left open pins the app past the quit');
});

// BOOT-ORDERING REGRESSION GUARD (the crash that took the shell down, commit
// 3050889). No unit test can observe Electron main-process module-load order —
// the controller's own tests inject a fake screenModule and so are blind to it —
// so this is asserted on the source text, the same way Slices 2 and 3 pin their
// Electron halves. Cheap, and it is the only automated thing standing between a
// future edit and another unbootable app.
test('Slice 5 / electron: `screen` is never reached at module scope, and the controller is built inside whenReady', () => {
  const readyStart = MAIN.indexOf('app.whenReady()');
  const moduleScope = MAIN.slice(0, readyStart);

  // The exact shape that crashed: destructuring `screen` off require('electron')
  // at module scope. `screen` is a lazy getter that throws until app.ready.
  assert.doesNotMatch(moduleScope, /const\s*\{[^}]*\bscreen\b[^}]*\}\s*=\s*require\('electron'\)/,
    "`screen` must not be destructured from require('electron') at module scope — it throws before app.ready");

  // And the controller must not be CONSTRUCTED at module scope either, because
  // construction is what reached into screen in the first place.
  assert.doesNotMatch(moduleScope, /createCursorOverlayController\(/,
    'the controller must not be constructed at module scope — build it inside app.whenReady()');

  const readyBlock = MAIN.slice(readyStart);
  assert.match(readyBlock, /createCursorOverlayController\(/,
    'the controller must be constructed inside app.whenReady()');
  // Gated on the opt-in flag, so a disabled feature builds nothing at all. The
  // original bug constructed unconditionally and the flag was read afterwards,
  // which is why the app died even with the overlay off (the default).
  assert.match(readyBlock, /if \(CURSOR_OVERLAY_ENABLED\)[\s\S]{0,400}?createCursorOverlayController\(/,
    'construction must be gated on CURSOR_OVERLAY_ENABLED, not merely followed by a flag check');
});

// ---------------------------------------------------------------------------
// AD-8 — the preload contextBridge surface must not grow for this slice.
// ---------------------------------------------------------------------------

test('Slice 5 / AD-8: cursor overlay adds NO new preload contextBridge channel', () => {
  const src = readSource(REPO_ROOT, 'electron', 'preload.js');
  for (const forbidden of ['cursorOverlay', 'cursor-overlay', 'getCursorScreenPoint', 'overlay']) {
    assert.ok(!src.toLowerCase().includes(forbidden.toLowerCase()),
      `preload.js must not mention ${forbidden} — the overlay carries no dynamic data, so no bridge channel is needed`);
  }
});

// ---------------------------------------------------------------------------
// Config surface: portability (CLAUDE.md) requires every new env key documented.
// ---------------------------------------------------------------------------

test('Slice 5 / config: both new env keys are documented in .env.example', () => {
  const env = readSource(MYTHOS_DIR, '.env.example');
  for (const key of ['MYTHOS_CURSOR_OVERLAY_ENABLED', 'MYTHOS_HOTKEY_CURSOR_OVERLAY']) {
    assert.ok(env.includes(key), `${key} must be documented in .env.example (repo portability rule)`);
  }
});
