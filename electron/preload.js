'use strict';

// electron/preload.js — the security-critical bridge between the Electron
// renderer (the JARVIS HUD, loaded unchanged from http://127.0.0.1:<port>) and
// the privileged main process.
//
// AD-8 (V2 spine §1): "Secrets never reach the renderer." This preload exposes
// a contextBridge surface of EXACTLY nine functions — getKeyNames, setKey,
// hasKey, onHotkey, restartServer, onUpdateStatus, installUpdate, getSettings
// and setSetting — and NOTHING that returns a key VALUE. Names, booleans, short
// strings/numbers (onHotkey, onUpdateStatus — the latter now three plain
// primitives: state, version, percent), status objects (restartServer,
// installUpdate, setSetting) and NON-SECRET configuration (getSettings) are the
// only things that cross.
//
// There is deliberately no getKey / getValue / read / secret function here.
// That omission is the regression gate: mythos/test/anti-drift-no-key-to-client.test.js
// asserts no such function exists on the exposed surface.
//
// WHY getSettings DOES return values, and why that is not an AD-8 breach:
// config.json holds the ~140 non-secret schema keys a packaged install
// previously had no way to set (see electron/main.js's settings IPC block and
// mythos/src/core/config/settings-store.js). Secret-shaped names are refused on
// write by settings-store.js AND filtered again in the main-process handler, so
// no key value can be in what getSettings resolves to. Booleans and port
// numbers are configuration, not credentials.

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
  // restartServer() → { ok, restarting } — re-forks the server child so keys
  // stored through setKey() above reach it (they are injected into the child env
  // at fork() and never afterwards; see electron/main.js decryptedKeysForChild).
  // Takes no arguments and returns no key material: a status object only, which
  // is why it does not widen the AD-8 surface.
  restartServer: function restartServer() {
    return ipcRenderer.invoke('mythos:restart-server');
  },
  // onUpdateStatus(cb) → cb(state, version, percent) whenever the auto-updater's
  // state changes ('idle' | 'available' | 'downloading' | 'ready' | 'error' |
  // 'incomplete'), so the HUD can render an Update button instead of the
  // operator finding out from an OS notification they may never see. percent is
  // only meaningful while state is 'downloading'; every other state resets it to
  // 0 in the main process (see setUpdateState in electron/main.js).
  //
  // Built exactly like onHotkey above and for the same reason: one named
  // channel, no channel parameter, and all three payload fields re-derived as
  // plain primitives here rather than forwarded — a structured event is the
  // shape that could carry something secret into a renderer that also loads
  // remote pages.
  onUpdateStatus: function onUpdateStatus(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('mythos:update-status', function (_event, state, version, percent) {
      callback(String(state || ''), String(version || ''), Number(percent) || 0);
    });
  },
  // installUpdate() → { ok, installing, state, version }. Takes NO arguments on
  // purpose: which version gets installed is decided by the main process from
  // state it owns, so a renderer (or a page loaded in one) cannot nominate an
  // executable. Resolves to a status object; no key material, no paths.
  installUpdate: function installUpdate() {
    return ipcRenderer.invoke('mythos:install-update');
  },
  // getSettings() → { file, values:{KEY:"value"}, unknown[], dropped[], error }
  // for the NON-SECRET config.json layer only. Takes no arguments: the file it
  // reads is decided by the main process from app.getPath('userData'), so a
  // renderer cannot point it at an arbitrary path. See the AD-8 note at the top
  // of this file for why returning these values is in-bounds.
  getSettings: function getSettings() {
    return ipcRenderer.invoke('mythos:get-settings');
  },
  // setSetting(name, value) → { ok, needsRestart } | { ok:false, error }.
  // The main process validates the name against the config SCHEMA and refuses
  // secret-shaped names outright, so this cannot be used to smuggle a credential
  // into plain-text storage or to inject an arbitrary env var into the server
  // child. An empty-string value clears the key rather than storing ''.
  setSetting: function setSetting(name, value) {
    return ipcRenderer.invoke('mythos:set-setting', name, value);
  },
});
