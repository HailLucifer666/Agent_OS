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
const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'ui', 'public', 'js', 'app.js'), 'utf8');

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
    assert.match(MAIN, /will-quit/);
    assert.match(MAIN, /globalShortcut\.unregisterAll\(\)/,
      'a global accelerator left registered stays unavailable to other apps');
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
});
