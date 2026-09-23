'use strict';

// electron-talk-hotkey.test.js — the global push-to-talk accelerator.
//
// A web page cannot claim an OS-wide hotkey, so this only exists under Electron:
// electron/main.js registers the accelerator and forwards it to the HUD as a
// 'talk' action, which app.js routes into toggleVoice().
//
// electron/main.js is an Electron entry point — it calls app.whenReady() and
// requires the real `electron` module at load, so it cannot be require()d here
// (electron is not installed for a bare `node --test`, and even when it is,
// loading it would try to start an app). These are therefore SOURCE-SHAPE guards
// on the specific properties that broke in similar features before: a hotkey
// that silently fails to register is indistinguishable from a broken mic, and a
// hotkey that bypasses toggleVoice() would bypass the PIN gate with it.
//
// The behavioural half — that the preload actually delivers the event, with a
// stringified payload — is covered by electron-preload-surface.test.js against a
// stubbed electron module.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'preload.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'ui', 'public', 'js', 'app.js'), 'utf8');
const VOICE_LOOP = fs.readFileSync(path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'voice-loop.js'), 'utf8');

describe('Electron push-to-talk hotkey', () => {
  it('imports globalShortcut and registers a talk accelerator', () => {
    assert.match(MAIN, /globalShortcut/, 'main.js must use globalShortcut');
    assert.match(MAIN, /globalShortcut\.register\(/);
    assert.match(MAIN, /mythos:hotkey/, 'the accelerator must forward to the renderer channel');
    assert.match(MAIN, /'talk'/, "the forwarded action must be 'talk'");
  });

  it('defaults to Alt+Space and falls back when the accelerator is already claimed', () => {
    // Alt+Space is the push-to-talk convention but is frequently taken (window
    // menu, launcher apps). register() returns false in that case, which is easy
    // to ignore — hence a fallback list plus an explicit isRegistered check.
    assert.match(MAIN, /Alt\+Space/);
    assert.match(MAIN, /Control\+Alt\+Space/, 'at least one fallback accelerator must exist');
    assert.match(MAIN, /globalShortcut\.isRegistered\(/,
      "register()'s return value alone is not authoritative — isRegistered must confirm it");
  });

  it('is configurable and can be turned off entirely', () => {
    assert.match(MAIN, /MYTHOS_HOTKEY_TALK/, 'the accelerator must be overridable by env');
    assert.match(MAIN, /'false'|"false"/, 'there must be a documented way to disable it');
  });

  it('releases the OS-wide claim on quit', () => {
    // RE-POINTED 2026-09-18 (BUG-437). This used to assert `/will-quit/` against
    // the whole file. That handler is gone — every quit now ends in the quit
    // sequence's app.exit(), which does not emit will-quit, so keeping it would
    // have been a release that never ran. Worse, the bare /will-quit/ match
    // would still have PASSED against the comment recording its deletion: a
    // green check structurally unable to see the thing it was guarding.
    assert.match(MAIN, /cleanup: \(\) => globalShortcut\.unregisterAll\(\)/,
      'a global accelerator left registered stays unavailable to other apps — the release must be wired '
      + 'into the quit sequence, which is the only thing that now runs on the way out');
  });

  it('routes the hotkey through toggleVoice, not at the mic directly', () => {
    // toggleVoice() owns transport selection AND the PIN-gate refusal. A hotkey
    // that started capture directly would let a keypress open the mic on a
    // locked HUD.
    assert.match(APP_JS, /onHotkey/, 'app.js must subscribe to the hotkey bridge');
    const block = APP_JS.slice(APP_JS.indexOf('onHotkey('));
    const window = block.slice(0, 400);
    assert.match(window, /toggleVoice\(\)/, 'the hotkey must go through toggleVoice()');
  });

  it('degrades silently in a plain browser tab, where window.mythos is absent', () => {
    assert.match(APP_JS, /window\.mythos\s*&&\s*typeof window\.mythos\.onHotkey === 'function'/,
      'the wiring must be feature-detected, since only Electron exposes this bridge');
  });

  // ---- BUG-269 defect 1: the lost-IPC race --------------------------------
  // The accelerator is claimed right after loadURL(), but the renderer's
  // onHotkey listener does not exist until app.js evaluates — Electron does
  // not queue IPC for unregistered listeners, so a press in that window was
  // lost forever. The fix: the renderer announces itself ready, and presses
  // before that are latched (behaviour pinned in electron-hotkey-latch.test.js).
  it('main.js latches presses until the renderer reports ready (BUG-269)', () => {
    assert.match(MAIN, /hotkey-latch/, 'main.js must use the extracted hotkey-latch module');
    assert.match(MAIN, /mythos:renderer-ready/, 'main.js must listen for the renderer-ready signal');
    assert.match(MAIN, /did-start-loading/,
      'a reload destroys the renderer listeners — the latch must re-arm or the bug returns after every refresh');
  });

  it('preload exposes notifyReady and app.js calls it after registering onHotkey (BUG-269)', () => {
    assert.match(PRELOAD, /notifyReady/, 'preload must expose a ready signal');
    assert.match(PRELOAD, /ipcRenderer\.send\('mythos:renderer-ready'\)/,
      'notifyReady must be a payload-free send on one named channel, same narrow style as onHotkey');
    const block = APP_JS.slice(APP_JS.indexOf('onHotkey('));
    const window = block.slice(0, 600);
    assert.match(window, /notifyReady\(\)/,
      'app.js must announce ready immediately after registering the hotkey listener');
  });

  // ---- BUG-269 defect 2: no re-entrancy guard ------------------------------
  it('app.js wraps toggleVoice in the in-flight guard and awaits the batch start (BUG-269)', () => {
    assert.match(APP_JS, /toggle-guard/, 'app.js must use the extracted toggle-guard module');
    assert.match(APP_JS, /createToggleGuard\(/);
    assert.match(APP_JS, /await ensureVoice\(\)\.start\(\)/,
      'the un-awaited start() let two presses interleave their async re-entry');
  });

  // ---- BUG-269 defect 3: variable lag --------------------------------------
  it('voice-loop start() gives instant feedback: synchronous arming state + immediate first VAD tick (BUG-269)', () => {
    const startIdx = VOICE_LOOP.indexOf('async function start()');
    assert.ok(startIdx !== -1, 'voice-loop.js must define an async start()');
    const startBody = VOICE_LOOP.slice(startIdx, startIdx + 1400);
    assert.match(startBody, /setState\('arming'\)/,
      "start() must flip the visible state to 'arming' synchronously — a slow press must not look like a lost one");
    // The arming flip must precede the first await in start(): compare their
    // positions directly (no fixed-width window, which a longer comment could
    // silently break).
    const armingAt = startBody.indexOf("setState('arming')");
    const firstAwait = startBody.indexOf('await');
    assert.ok(firstAwait === -1 || armingAt < firstAwait,
      "setState('arming') must precede the first await in start()");
    assert.match(startBody, /setInterval\(vadTick, VAD_TICK_MS\);\s*\n\s*vadTick\(\);/,
      'the first VAD tick must run immediately, not up to a full 100ms tick later');
  });
});
