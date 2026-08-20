'use strict';
// Runs the probe inside Electron 43.3.0 — the same major the MYTHOS shell uses —
// so the Chrome-vs-Electron axis (electron#47043: echoCancellation granted but
// inert in Electron while working in Chrome) is measured on one binary at a time.
//
// The three command-line switches are copied from electron/main.js:57-68 so the
// audio stack is configured the way MYTHOS configures it. A probe that differs
// from the shell in a switch that touches renderer scheduling or autoplay would
// answer a question nobody asked.
const { app, BrowserWindow, session } = require('electron');

const URL_ = process.argv[2] || 'http://127.0.0.1:4791/?env=electron';

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(() => {
  // Throwaway window, throwaway grant. Electron permission grants are keyed on
  // the permission NAME and are session-wide, so this scopes to the one
  // webContents rather than blanket-granting.
  const win = new BrowserWindow({ width: 900, height: 620, show: true, title: 'AEC probe (electron)' });
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['media', 'audioCapture', 'microphone'].includes(permission) && wc.id === win.webContents.id);
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => (
    ['media', 'audioCapture', 'microphone'].includes(permission) && !!wc && wc.id === win.webContents.id
  ));
  win.webContents.on('console-message', (_e, _lvl, message) => {
    process.stdout.write('[electron console] ' + message + '\n');
  });
  win.loadURL(URL_);
  // The page POSTs its results to the server before it prints DONE; the server
  // is what records them, so a hard ceiling here only bounds the window's life.
  setTimeout(() => app.quit(), 300000);
});
app.on('window-all-closed', () => app.quit());
