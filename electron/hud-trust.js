'use strict';

// electron/hud-trust.js — ONE answer to "is this request the HUD itself?", for
// every Electron surface that grants authority: the key-store and settings IPC,
// microphone and camera permission, screen capture, navigation of the HUD window
// and the loads main.js performs (2026-09-29 audit, B3a).
//
// Pure: no require('electron'). Each adapter turns one Electron callback shape
// into the same three facts, and evaluate() decides on those facts alone:
//   webContents  — the window asking (must be the HUD's own webContents)
//   isMainFrame  — true only for the HUD window's top frame
//   url          — the requesting document (must be a HUD document on the HUD
//                  origin: scheme, host and port equal, no userinfo)
// A fact that is missing, unreadable or detached is a refusal, never a pass.
//
// WHAT THE FRAME FACT CAN AND CANNOT DO. Measured 2026-09-29 on Electron 43.4.1
// with a throwaway probe (test/electron-hud-trust.test.js records it): a
// permission request from an iframe reports isMainFrame:false with the iframe's
// URL, so it is refused here — the window-only check that preceded this granted
// it. But IPC sent by a same-origin iframe through window.parent's bridge reports
// the MAIN frame as senderFrame: the iframe is running the parent's function. So
// this cannot stop a same-origin document from scripting the HUD. Isolating
// generated content from the HUD origin (B3c) is what closes that; this closes
// every frame, window and document that is not the HUD's own main document.
//
// WHY THE DOCUMENT PATH. The HUD is one page. The same probe navigated the HUD
// window to /vault/builds/x/index.html and will-navigate fired for it; the old
// url.startsWith(hudOrigin) check let it through, and a generated page would have
// loaded in the one window whose preload holds setKey/setSetting. The same prefix
// compare also admitted http://127.0.0.1:4478@evil.example/ (userinfo trick) and
// http://127.0.0.1:44780/ (a longer port).

// The HUD's documents. ui/public holds index.html (served at "/") and
// media-embed.html, which belongs to the media window and must NOT count.
const HUD_DOCUMENT_PATHS = Object.freeze(['/', '/index.html']);

const TRUSTED = Object.freeze({ ok: true, reason: 'hud' });
function refuse(reason) { return Object.freeze({ ok: false, reason }); }

function parseOrigin(origin) {
  let u;
  try { u = new URL(origin); } catch (_) { u = null; }
  if (!u || u.origin === 'null' || `${u.origin}` !== String(origin)) {
    throw new Error(`hud-trust: origin must be a bare scheme://host:port origin, got ${JSON.stringify(origin)}`);
  }
  return u.origin;
}

// facts: { webContents, isMainFrame, url }; hud: { webContents, origin }
function evaluateHudTrust(facts, hud) {
  if (!hud || !hud.webContents) return refuse('no-hud-window');
  if (!facts || typeof facts !== 'object') return refuse('no-facts');
  if (!facts.webContents) return refuse('no-window');
  if (facts.webContents !== hud.webContents) return refuse('not-hud-window');
  if (facts.isMainFrame !== true) return refuse(facts.isMainFrame === false ? 'subframe' : 'no-frame');
  if (typeof facts.url !== 'string' || facts.url === '') return refuse('no-document-url');
  let u;
  try { u = new URL(facts.url); } catch (_) { return refuse('unparseable-url'); }
  if (u.origin !== hud.origin) return refuse('foreign-origin');
  if (u.username || u.password) return refuse('userinfo');
  if (!HUD_DOCUMENT_PATHS.includes(u.pathname)) return refuse('not-a-hud-document');
  return TRUSTED;
}

// A WebFrameMain as facts. frame.parent === null is the top frame; a detached
// frame (navigated away or destroyed mid-call) is no frame at all.
function frameFacts(webContents, frame) {
  if (!frame) return { webContents, isMainFrame: undefined, url: undefined };
  try {
    if (frame.detached === true) return { webContents, isMainFrame: undefined, url: undefined };
    return { webContents, isMainFrame: frame.parent === null, url: frame.url };
  } catch (_) {
    return { webContents, isMainFrame: undefined, url: undefined };
  }
}

// The HUD origin for MYTHOS_BIND + port, normalised the way the URL parser will
// see it ("LOCALHOST", "127.1", a bare IPv6 address, :80 elided). It NEVER
// throws: main.js calls it while the module is still loading, and a throw there
// leaves Electron running with no window and nothing on screen (independent
// review, 2026-09-29 — an uppercase bind that worked before would have done
// exactly that). A bind the parser cannot use yields an origin that matches
// nothing, so the HUD fails closed and visibly instead.
const UNUSABLE_BIND_ORIGIN = 'http://unusable-bind.invalid';
function hudOriginFor(bind, port) {
  const host = String(bind || '');
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  try {
    const u = new URL(`http://${bracketed}:${port}`);
    if (u.pathname === '/' && !u.search && !u.hash && !u.username && !u.password) return u.origin;
  } catch (_) { /* fall through */ }
  return UNUSABLE_BIND_ORIGIN;
}

// getHudWebContents: () => the HUD window's webContents, or null while there is
// none (before creation, after close). origin: the HUD origin main.js loads.
function createHudTrust({ getHudWebContents, origin }) {
  const hudOrigin = parseOrigin(origin);
  const hud = () => {
    let wc = null;
    try { wc = getHudWebContents(); } catch (_) { wc = null; }
    return { webContents: wc, origin: hudOrigin };
  };
  const evaluate = (facts) => evaluateHudTrust(facts, hud());
  return Object.freeze({
    evaluate,
    // ipcMain.handle / ipcMain.on: (event) — event.sender, event.senderFrame.
    ipc: (event) => evaluate(frameFacts(event && event.sender, event && event.senderFrame)),
    // setPermissionRequestHandler: (wc, permission, callback, details)
    permissionRequest: (wc, details) => evaluate({
      webContents: wc, isMainFrame: details && details.isMainFrame, url: details && details.requestingUrl,
    }),
    // setPermissionCheckHandler: (wc, permission, requestingOrigin, details).
    // requestingUrl is "" on the early checks (measured); that refuses, and
    // Chromium then asks the request handler, which decides with a URL.
    permissionCheck: (wc, details) => evaluate({
      webContents: wc, isMainFrame: details && details.isMainFrame, url: details && details.requestingUrl,
    }),
    // setDisplayMediaRequestHandler: (request, callback) — request.frame is a
    // WebFrameMain; webContents.fromFrame names its window. No mapping, no grant.
    displayMedia: (request, webContentsModule) => {
      const frame = request && request.frame;
      let wc = null;
      try {
        if (frame && webContentsModule && typeof webContentsModule.fromFrame === 'function') wc = webContentsModule.fromFrame(frame);
      } catch (_) { wc = null; }
      return evaluate(frameFacts(wc, frame));
    },
    // will-navigate / will-redirect of the HUD window: the destination must be a
    // HUD document, because whatever loads there inherits the privileged preload.
    navigation: (url) => { const h = hud(); return evaluateHudTrust({ webContents: h.webContents, isMainFrame: true, url }, h); },
    // The one URL main.js loads into the HUD window.
    documentUrl: () => `${hudOrigin}/`,
  });
}

module.exports = { createHudTrust, evaluateHudTrust, hudOriginFor, HUD_DOCUMENT_PATHS, UNUSABLE_BIND_ORIGIN };
