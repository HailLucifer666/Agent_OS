'use strict';

// electron/preload.js — the security-critical bridge between the Electron
// renderer (the JARVIS HUD, loaded unchanged from http://127.0.0.1:<port>) and
// the privileged main process.
//
// AD-8 (V2 spine §1): "Secrets never reach the renderer." This preload exposes
// a contextBridge surface of EXACTLY three functions — getKeyNames, setKey,
// hasKey — and NOTHING that returns a key VALUE. Names and booleans only.
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
});
