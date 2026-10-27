'use strict';

// test/electron-key-store-security.test.js — B2/H6 fix (security review,
// 2026-08-08).
//
// B2: electron/preload.js exposes window.mythos.{getKeyNames,setKey,hasKey}
// to EVERY renderer that loads it. electron/media-window.js used to attach
// that SAME preload to a second BrowserWindow that loadURL()s a
// caller-supplied URL — the open_web tool payload (Tier 0 auto-allowed, see
// mythos/src/core/effectors/from-dashboard.js + mythos/src/core/leash/tiers.js).
// An attacker page (or a prompt-injected tool call) reachable through that
// window could call setKey('GEMINI_API_KEY', attacker_key) to reroute all
// model traffic, or setKey('NODE_OPTIONS', '--inspect=0.0.0.0:9229') — which
// passed the old name-charset validator — toward RCE in the forked child.
//
// H6: electron/main.js's HUD BrowserWindow had a setWindowOpenHandler denying
// new-window opens, but nothing stopped a top-level will-navigate away from
// its own origin, which would carry the privileged preload's trust to
// whatever page loaded next.
//
// electron/main.js cannot be require()d under plain `node --test` (it loads
// the real `electron` module and calls app.whenReady()) — same constraint as
// electron-talk-hotkey.test.js and electron-cursor-overlay.test.js's Layer 2 —
// so the main.js half here is SOURCE-SHAPE assertions, matching that
// precedent. electron/media-window.js and electron/media-preload.js have no
// such constraint and are exercised directly.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');

function readSource(...segs) {
  return fs.readFileSync(path.join(...segs), 'utf8');
}

const MAIN = readSource(REPO_ROOT, 'electron', 'main.js');

// ---------------------------------------------------------------------------
// B2 — the three key-store IPC handlers must gate on the HUD predicate. Since
// 2026-09-29 (audit B3a) that is hudTrust.ipc(event): window, frame AND
// document (electron/hud-trust.js). The window-only isHudContents(event.sender)
// it replaced also answered a /vault page loaded inside the HUD window.
// ---------------------------------------------------------------------------

test('B2: mythos:set-key is gated on hudTrust.ipc and denies loudly', () => {
  const idx = MAIN.indexOf("ipcMain.handle('mythos:set-key'");
  assert.ok(idx !== -1, 'the set-key handler must still be registered');
  const handler = MAIN.slice(idx, idx + 900);
  assert.match(handler, /hudTrust\.ipc\(event\)\.ok/,
    'set-key must check the sender against the HUD-identity predicate — this is the exact channel B2 abused');
  assert.match(handler, /throw new Error/,
    'a non-HUD sender must be denied loudly (thrown), not with a silent {ok:false} that looks like a working no-op');
});

test('B2: mythos:get-key-names is gated on hudTrust.ipc', () => {
  const idx = MAIN.indexOf("ipcMain.handle('mythos:get-key-names'");
  assert.ok(idx !== -1, 'the get-key-names handler must still be registered');
  const handler = MAIN.slice(idx, idx + 300);
  assert.match(handler, /hudTrust\.ipc\(event\)\.ok/);
  assert.match(handler, /throw new Error/);
});

test('B2: mythos:has-key is gated on hudTrust.ipc', () => {
  const idx = MAIN.indexOf("ipcMain.handle('mythos:has-key'");
  assert.ok(idx !== -1, 'the has-key handler must still be registered');
  const handler = MAIN.slice(idx, idx + 300);
  assert.match(handler, /hudTrust\.ipc\(event\)\.ok/);
  assert.match(handler, /throw new Error/);
});

test('B2: isHudContents still compares real webContents identity against mainWindow (not widened to true)', () => {
  const predStart = MAIN.indexOf('const isHudContents');
  assert.ok(predStart !== -1, 'isHudContents must exist');
  const pred = MAIN.slice(predStart, predStart + 500);
  assert.match(pred, /mainWindow/, 'isHudContents must compare against mainWindow');
  assert.match(pred, /webContents/, 'isHudContents must compare webContents identity, not a URL or a title');
});

// ---------------------------------------------------------------------------
// B2 — env-injection denylist, even when the charset check passes.
// ---------------------------------------------------------------------------

test('B2: an env-injection denylist exists and blocks NODE_OPTIONS-class names', () => {
  assert.match(MAIN, /ENV_INJECTION_DENYLIST/, 'a denylist constant must exist');
  const denyIdx = MAIN.indexOf('ENV_INJECTION_DENYLIST = new Set');
  assert.ok(denyIdx !== -1);
  const denyBlock = MAIN.slice(denyIdx, denyIdx + 400);
  for (const name of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'LD_PRELOAD']) {
    assert.ok(denyBlock.includes(name), `denylist must include ${name}`);
  }
  const setKeyIdx = MAIN.indexOf("ipcMain.handle('mythos:set-key'");
  const setKeyBlock = MAIN.slice(setKeyIdx, setKeyIdx + 1200);
  assert.match(setKeyBlock, /ENV_INJECTION_DENYLIST\.has\(/,
    'set-key must actually consult the denylist, not just declare it');
});

// A regression test proving the exact PoC from the finding would now be
// refused: NODE_OPTIONS passes /^[A-Za-z0-9_]{1,64}$/ but must still be denied.
test('B2: "NODE_OPTIONS" itself passes the name-charset regex (so the denylist is load-bearing, not redundant)', () => {
  assert.match('NODE_OPTIONS', /^[A-Za-z0-9_]{1,64}$/,
    'sanity check on the finding: the charset validator alone does NOT reject NODE_OPTIONS');
});

// ---------------------------------------------------------------------------
// B2 — the media window must not share the HUD's key-bearing preload.
// ---------------------------------------------------------------------------

test('B2: the media window controller is wired with its own preload, not preload.js', () => {
  const idx = MAIN.indexOf('createMediaWindowController(');
  assert.ok(idx !== -1, 'the media window controller must still be constructed');
  const block = MAIN.slice(idx, idx + 500);
  assert.match(block, /media-preload\.js/,
    'the media window must use its own preload file');
  assert.doesNotMatch(block, /preloadPath:\s*path\.join\(__dirname,\s*'preload\.js'\)/,
    'the media window must NOT reuse the HUD preload — that is exactly how B2 exposed setKey to open_web content');
});

test('B2: electron/media-preload.js exists and exposes no contextBridge surface at all', () => {
  const src = readSource(REPO_ROOT, 'electron', 'media-preload.js');
  // Strip comments before scanning for code: the file's own explanatory
  // comments mention setKey/contextBridge by name (describing what B2 was and
  // why this file avoids it) — the assertion is about executable code, not prose.
  const codeOnly = src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(codeOnly, /contextBridge/,
    'the media window needs nothing from the main process — no bridge means no setKey/getKeyNames/hasKey reachable from arbitrary open_web content');
  assert.doesNotMatch(codeOnly, /require\(/,
    'the media preload should require nothing at all — it has no work to do');
});

// ---------------------------------------------------------------------------
// H6 — the HUD window must not navigate away from its own origin.
// ---------------------------------------------------------------------------

test('H6: the HUD window registers a will-navigate guard that denies off-origin navigation', () => {
  assert.match(MAIN, /webContents\.on\('will-navigate', denyForeignHudLoad\)/, 'a will-navigate handler must be registered on the HUD webContents');
  const idx = MAIN.indexOf('const denyForeignHudLoad = (navEvent, url) =>');
  assert.ok(idx !== -1, 'the handler it names must exist');
  const block = MAIN.slice(idx, idx + 500);
  assert.match(block, /preventDefault\(\)/,
    'off-origin navigation must be prevented, not merely logged');
  // A prefix compare admitted 127.0.0.1:44780, user@host tricks and /vault
  // pages (B3a, 2026-09-29); the guard asks the shared predicate instead.
  assert.doesNotMatch(MAIN, /startsWith\(hudOrigin\)/, 'no prefix compare may decide what loads in the HUD window');
  assert.match(block, /hudTrust\.navigation\(url\)\.ok/,
    'the guard must ask the HUD predicate whether the destination is a HUD document');
});

test('H6: setWindowOpenHandler is still present alongside the new will-navigate guard', () => {
  assert.match(MAIN, /setWindowOpenHandler\(/,
    'the existing new-window guard must not have been removed while adding will-navigate');
});
