'use strict';

// electron/media-window.js — Stage 5 of 7 (BUG-075).
//
// Operator, verbatim: "I did not ask you to play on YouTube widget. I
// specifically said, open YouTube on the Electron app." Before this file,
// 'ui.open-web' (emitted by dispatch-action.js on a successful open_web call,
// see from-dashboard.js) only ever reached the SAME renderer the dashboard
// already runs in — server/index.js's bus.subscribe('ui.open-web', ...)
// broadcasts it over the WS the HUD's own browser JS (app.js) is already
// listening on, which routes YouTube/web to overlays.openPanel('web', ...) —
// an overlay ON TOP of the dashboard, not a separate window. Electron's main
// process (this file's caller) never saw the event at all: it is a different
// OS process from the forked mythos server, connected only by fork()'s IPC
// channel, which nothing was using for this. So "the Electron app" — a real,
// second BrowserWindow — genuinely could not have opened before this file
// existed, regardless of which client-side branch app.js took.
//
// Kept in its own requireable module, with NO top-level `require('electron')`
// and an INJECTED BrowserWindow constructor, so this is testable under plain
// `node --test` with a fake constructor — matching the seam pattern this
// codebase already uses for untestable-by-default surfaces (createSocket in
// live-session.js takes an injectable WebSocket ctor for the same reason).
// electron/main.js is the one file that wires the real `BrowserWindow` in.

// ponytail: only widgetTypes that represent an actual page/video get promoted
// to a real window. search/weather/flights/image stay floating dashboard
// widgets (compact glance cards, not "an app" in the operator's sense) —
// promoting every open_web call to a new OS window would spawn a window per
// utterance. Upgrade path: add a widgetType here if the operator later asks
// for one of those to open as its own window too.
const MEDIA_WIDGET_TYPES = new Set(['youtube', 'web']);

// A ui.open-web payload carries either `embedUrl` (youtube/web) or `url`
// (newtab/news — deliberately NOT promoted; those already mean "open outside
// MYTHOS", and newtab already opens the operator's own external browser via
// window.open, per app.js). Returns null when this payload isn't one Electron
// should turn into a real window.
//
// BUG-166 (mediaBaseUrl): a YouTube EMBED URL must never be loaded as this
// window's top-level document — a top-level embed carries no referer and
// YouTube's player answers "Error 153: video player configuration error"
// (operator incident 2026-08-07 04:04; reproduced in headless Chromium, where
// the same URL iframed from a local page shows no 153). When mediaBaseUrl is
// provided, youtube payloads route to the server-hosted wrapper page
// (ui/public/media-embed.html) which iframes the pre-checked embed — the same
// shape the dashboard panel already plays through. `web` payloads are real
// top-level pages and load directly, as before.
function resolveMediaUrl(payload, mediaBaseUrl) {
  if (!payload || typeof payload !== 'object') return null;
  if (!MEDIA_WIDGET_TYPES.has(payload.widgetType)) return null;
  const url = payload.embedUrl || payload.url;
  if (typeof url !== 'string' || !url) return null;
  if (payload.widgetType === 'youtube' && mediaBaseUrl) {
    return mediaBaseUrl.replace(/\/$/, '') + '/media-embed.html?src=' + encodeURIComponent(url)
      + (payload.title ? '&title=' + encodeURIComponent(String(payload.title).slice(0, 120)) : '');
  }
  return url;
}

// Builds the handler electron/main.js wires to child.on('message'). Tracks
// one media window: a second "open" reuses/navigates the existing window
// (loadURL) instead of stacking a new one every time, per the Stage 5 spec.
function createMediaWindowController({ BrowserWindowCtor, preloadPath, backgroundThrottling = false, mediaBaseUrl = '' }) {
  if (typeof BrowserWindowCtor !== 'function') {
    throw new Error('createMediaWindowController requires a BrowserWindowCtor');
  }
  let win = null;

  function handleOpenWeb(payload) {
    const url = resolveMediaUrl(payload, mediaBaseUrl);
    if (!url) return { opened: false, reason: 'not a media widgetType' };

    if (win && !win.isDestroyed()) {
      win.loadURL(url);
      win.focus();
      return { opened: true, reused: true, url };
    }

    win = new BrowserWindowCtor({
      width: 960,
      height: 640,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Same fix as the main HUD window (main.js): a backgrounded media
        // window must not have its audio/video throttled.
        backgroundThrottling,
      },
    });
    win.loadURL(url);
    win.on('closed', () => { win = null; });
    return { opened: true, reused: false, url };
  }

  // The close path for "close that"/close_panel (server/index.js's
  // requestCloseMediaWindow -> this, via the same fork IPC channel). Reuses
  // close_panel's existing vocabulary — no new close_media_window tool.
  function closeMediaWindow() {
    if (win && !win.isDestroyed()) {
      win.close();
      win = null;
      return true;
    }
    return false;
  }

  function getWindow() { return win; }

  return { handleOpenWeb, closeMediaWindow, getWindow };
}

module.exports = { resolveMediaUrl, createMediaWindowController, MEDIA_WIDGET_TYPES };
