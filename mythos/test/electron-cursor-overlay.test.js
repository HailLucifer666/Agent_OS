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
  assert.throws(() => createCursorOverlayController({ BrowserWindowCtor: function () {} }),
    /screenModule/);
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
  assert.match(MAIN, /registerTalkHotkey\(\);\s*\n\s*registerOcrGrabHotkey\(\);\s*\n\s*registerCursorOverlayHotkey\(\);/,
    'must be registered in app.whenReady() alongside the existing hotkeys');
  const quitBlock = MAIN.slice(MAIN.indexOf("app.on('before-quit'"));
  assert.match(quitBlock.slice(0, 300), /cursorOverlayController\.destroy\(\)/,
    'the overlay window must be released on quit, not left dangling');
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
