'use strict';

// electron/preload.js — the security-critical bridge between the Electron
// renderer (the JARVIS HUD, loaded unchanged from http://127.0.0.1:<port>) and
// the privileged main process.
//
// AD-8 (V2 spine §1): "Secrets never reach the renderer." This preload exposes
// a contextBridge surface of EXACTLY four functions — getKeyNames, setKey,
// hasKey, and onHotkey — and NOTHING that returns a key VALUE. Names, booleans,
// and (for onHotkey) a short action string are the only things that cross.
//
// There is deliberately no getKey / getValue / read / secret function here.
// That omission is the regression gate: mythos/test/anti-drift-no-key-to-client.test.js
// asserts no such function exists on the exposed surface.

const { contextBridge, ipcRenderer } = require('electron');

// setKey(name, value) → stores (the value is encrypted by the main process via
//   safeStorage; we never read it back here). Resolves to { ok: true }; the
//   value is never echoed across the bridge.
// getKeyNames() → resolves to an array of name STRINGS. Never values.
// hasKey(name) → resolves to a boolean.
//
// Every function below forwards to one named IPC channel. There is no catch-all
// invoke and no generic "send"/"on" — the renderer cannot reach into arbitrary
// main-process channels.
contextBridge.exposeInMainWorld('mythos', {
  getKeyNames: function getKeyNames() {
    return ipcRenderer.invoke('mythos:get-key-names');
  },
  setKey: function setKey(name, value) {
    return ipcRenderer.invoke('mythos:set-key', name, value);
  },
  hasKey: function hasKey(name) {
    return ipcRenderer.invoke('mythos:has-key', name);
  },
  // onHotkey(cb) → cb('talk') when the global push-to-talk accelerator fires.
  // The ONLY main→renderer listener on this surface, and deliberately narrow:
  // one named channel, and the payload is re-derived here as a plain string
  // rather than forwarded, so nothing structured (and therefore nothing secret)
  // can ride the event into the renderer. There is no generic `on`, no channel
  // parameter, and no way to subscribe to anything else.
  onHotkey: function onHotkey(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('mythos:hotkey', function (_event, action) {
      callback(String(action || ''));
    });
  },
});
