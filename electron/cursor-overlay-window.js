'use strict';

// electron/cursor-overlay-window.js — Track A2, Step 7 / Slice 5 of 6
// (MYTHOS-IRIS-Synthesis-Plan.md's "Floating cursor overlay (summon at
// cursor, OS-level)" — absent before this file, needs globalShortcut, so it
// rides Electron same as the talk/OCR hotkeys).
//
// A frameless, transparent, always-on-top, click-through window that appears
// centered on the OS cursor when summoned (a global hotkey, gated OFF by
// default — see electron/main.js's MYTHOS_CURSOR_OVERLAY_ENABLED), then
// auto-hides. It carries no dynamic data: the content is a static, inline
// data: URL, so there is nothing for a preload bridge to carry and none is
// added (AD-8) — same reasoning electron/main.js's Slice 3 comment already
// gives for screen share.
//
// Kept in its own requireable module, with NO top-level `require('electron')`
// and INJECTED BrowserWindow + screen modules, so this is testable under plain
// `node --test` with fakes — the same seam pattern as media-window.js
// (createMediaWindowController). electron/main.js is the one file that wires
// the real `BrowserWindow`/`screen` in.

const OVERLAY_SIZE = 56; // px, square — small enough to read as "at the cursor", not a window
const AUTO_HIDE_MS = 1500;

// Inline, self-contained: a soft pulsing ring. No external asset, no fetch,
// no preload channel — there is nothing here that needs main-process data.
const OVERLAY_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden;}
.ring{position:absolute;left:50%;top:50%;width:32px;height:32px;margin:-16px 0 0 -16px;
  border-radius:50%;border:3px solid rgba(120,200,255,0.9);
  box-shadow:0 0 12px rgba(120,200,255,0.6);
  animation:pulse 1.1s ease-out infinite;}
@keyframes pulse{
  0%{transform:scale(0.4);opacity:0.9;}
  70%{transform:scale(1.15);opacity:0.25;}
  100%{transform:scale(1.15);opacity:0;}
}
</style></head><body><div class="ring"></div></body></html>`;
const OVERLAY_HTML_DATA_URL = 'data:text/html,' + encodeURIComponent(OVERLAY_HTML);

// Pure and unit-testable without any Electron module: given a cursor screen
// point, returns the window bounds that center a `size`-px square overlay on
// it. Returns null on a malformed point rather than producing NaN bounds.
function overlayBoundsForCursor(point, size = OVERLAY_SIZE) {
  if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') return null;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return {
    x: Math.round(point.x - size / 2),
    y: Math.round(point.y - size / 2),
    width: size,
    height: size,
  };
}

// Builds the controller electron/main.js wires to the summon hotkey. Tracks
// one overlay window, created lazily on first show() (never at boot — an
// always-on-top window appearing unasked is exactly the failure mode this
// slice must avoid) and reused across summons.
function createCursorOverlayController({ BrowserWindowCtor, screenModule, autoHideMs = AUTO_HIDE_MS }) {
  if (typeof BrowserWindowCtor !== 'function') {
    throw new Error('createCursorOverlayController requires a BrowserWindowCtor');
  }
  // Presence only — deliberately NOT `typeof screenModule.getCursorScreenPoint`.
  //
  // Electron's `screen` export is a lazy getter that THROWS until app.ready, so
  // reading any property off it counts as "using" it. This guard used to do that
  // type-check here, and it took the entire Electron shell down on the first real
  // boot: "The 'screen' module can't be used before the app 'ready' event", raised
  // from this line via main.js's module-scope construction. The defensive check
  // was itself the crash.
  //
  // Contract, enforced by a throwing-getter test in
  // test/electron-cursor-overlay.test.js: constructing this controller touches NO
  // property of any injected Electron module. Shape validation happens at first
  // use, below, where the call is about to happen anyway.
  if (!screenModule) {
    throw new Error('createCursorOverlayController requires a screenModule with getCursorScreenPoint()');
  }
  let win = null;
  let hideTimer = null;

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindowCtor({
      width: OVERLAY_SIZE,
      height: OVERLAY_SIZE,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      focusable: false, // never eligible to receive keyboard/focus at all
      hasShadow: false,
      show: false, // shown explicitly by show(), never on construction
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // No `preload` here at all (AD-8): the overlay's content is a static
        // inline data: URL with nothing dynamic to bridge in.
      },
    });
    // Click-through by default: forward:true keeps mouse enter/leave/move
    // events flowing to whatever is really under the cursor instead of the
    // overlay swallowing them — an attention indicator must never block the
    // click it's decorating.
    win.setIgnoreMouseEvents(true, { forward: true });
    win.loadURL(OVERLAY_HTML_DATA_URL);
    win.on('closed', () => { win = null; });
    return win;
  }

  // Summons the overlay centered on the current OS cursor position, then
  // auto-hides after autoHideMs. Repeated calls (rapid re-presses) just
  // reposition + reset the hide timer rather than stacking windows.
  function show() {
    // Deferred shape check — see the construction guard above for why this
    // cannot live in the constructor. By the time show() runs, app.ready has
    // fired (main.js registers the summon hotkey inside whenReady), so touching
    // the property is safe here and nowhere earlier.
    if (typeof screenModule.getCursorScreenPoint !== 'function') {
      throw new Error('cursor overlay: screenModule has no getCursorScreenPoint()');
    }
    const point = screenModule.getCursorScreenPoint();
    const bounds = overlayBoundsForCursor(point);
    if (!bounds) return false;
    const w = ensureWindow();
    w.setBounds(bounds);
    // showInactive(), not show(): the whole point of a global hotkey is not
    // stealing focus from whatever the operator was doing — same rationale as
    // main.js's push-to-talk and OCR-grab hotkeys.
    w.showInactive();
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, autoHideMs);
    return true;
  }

  function hide() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (win && !win.isDestroyed()) win.hide();
  }

  // Full teardown for app quit — releases the window rather than just hiding it.
  function destroy() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (win && !win.isDestroyed()) win.close();
    win = null;
  }

  function getWindow() { return win; }

  return { show, hide, destroy, getWindow };
}

module.exports = {
  overlayBoundsForCursor,
  createCursorOverlayController,
  OVERLAY_SIZE,
  AUTO_HIDE_MS,
  OVERLAY_HTML_DATA_URL,
};
