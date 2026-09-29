'use strict';

// test/electron-hud-trust.test.js — one answer to "is this the HUD itself?" for
// every Electron surface that grants authority (2026-09-29 audit, B3a).
//
// MEASURED FIRST, 2026-09-29, with a throwaway Electron 43.4.1 probe (a page and a
// same-origin iframe served from loopback, handlers logging what they receive):
//   - The HUD window WILL navigate to /vault/builds/x/index.html: will-navigate
//     fired for it, and main.js's check — url.startsWith(hudOrigin) — lets any
//     same-origin path through, so a generated page could load in the window
//     that carries the key-store bridge. The same prefix check also admits
//     http://127.0.0.1:4478@evil.example/ and http://127.0.0.1:44780/.
//   - A permission REQUEST from an iframe reports isMainFrame:false and the
//     iframe's own URL; the window-only check granted it, because the iframe
//     lives in the HUD's webContents.
//   - Early permission CHECKS arrive with requestingUrl "" — refusing those is
//     safe: Chromium then asks the request handler, which was observed.
//   - IPC sent by an iframe through window.parent's bridge reports the MAIN frame
//     as senderFrame. So the frame fact cannot stop a same-origin iframe from
//     scripting its parent; only isolating generated content can (B3c). It does
//     stop any frame or document that is not the HUD's own main document.
//
// These tests use fake Electron-shaped objects for the adapters and read
// electron/main.js as text for the wiring — the suite does not boot Electron.
//
// STAGE 1, 2026-09-29: the wiring tests (5) and the full-origin tests (2) failed
// on the unfixed main.js and boot-guards.js; the old checks were reproduced
// directly (all three bypass URLs passed url.startsWith(hudOrigin); an https
// Origin passed crossOriginRefusal on the http HUD host).
// LIVE, same day: this branch's app booted with a throwaway profile and was
// driven over a local DevTools port — the HUD's own bridge calls worked
// (getKeyNames, getSettings), and navigating the HUD window to
// /vault/builds/b3a-probe/index.html and to http://127.0.0.1:44780/ was denied
// (the window stayed on "/", main.log named both denials).
// PROVEN ABLE TO FAIL, same day: eleven mutations, each red here — drop the
// document check; drop the frame check; compare host only; trust a detached
// frame; ignore userinfo; let display-media assume the HUD when fromFrame
// fails; revert one IPC handler to the window-only check; drop will-redirect;
// revert the permission check to window-only; make crossOriginRefusal host-only
// again; and one FIXTURE mutation (fromFrame answering "HUD" for every frame).
// After independent review (Opus), same day: the live check was extended to the
// paths whose rules changed — permissions.query("microphone") "granted", the
// HUD's own getUserMedia granted (tracks stopped at once), input device labels
// present, and the SAME request from an iframe inside the HUD refused with
// NotAllowedError. Screen capture was not triggered live (it would capture the
// operator's screen); its adapter is covered here. Three more mutations, each
// red: hudOriginFor throwing again; req.secure trusted as the server's scheme;
// will-redirect dropped.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const trust = require(path.join(ROOT, 'electron', 'hud-trust.js'));
const MAIN = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
const { crossOriginRefusal } = require('../src/core/server/boot-guards.js');

const ORIGIN = 'http://127.0.0.1:4478';
function world() {
  const hudWc = { id: 'hud' };
  const mediaWc = { id: 'media' };
  const t = trust.createHudTrust({ getHudWebContents: () => hudWc, origin: ORIGIN });
  const mainFrame = (url = ORIGIN + '/') => ({ parent: null, url, detached: false });
  const childFrame = (url = ORIGIN + '/vault/builds/p/index.html') => ({ parent: mainFrame(), url, detached: false });
  return { hudWc, mediaWc, t, mainFrame, childFrame };
}

describe('the predicate', () => {
  test('the HUD main frame on its own document is trusted', () => {
    const { t, hudWc } = world();
    for (const url of [ORIGIN + '/', ORIGIN + '/index.html', ORIGIN + '/?x=1#settings']) {
      assert.deepEqual(t.evaluate({ webContents: hudWc, isMainFrame: true, url }), { ok: true, reason: 'hud' }, url);
    }
  });

  test('every missing fact is a refusal, never a pass', () => {
    const { t, hudWc } = world();
    assert.equal(t.evaluate(null).reason, 'no-facts');
    assert.equal(t.evaluate({ isMainFrame: true, url: ORIGIN + '/' }).reason, 'no-window');
    assert.equal(t.evaluate({ webContents: hudWc, url: ORIGIN + '/' }).reason, 'no-frame');
    assert.equal(t.evaluate({ webContents: hudWc, isMainFrame: true }).reason, 'no-document-url');
    assert.equal(t.evaluate({ webContents: hudWc, isMainFrame: true, url: '' }).reason, 'no-document-url');
    assert.equal(t.evaluate({ webContents: hudWc, isMainFrame: true, url: 'not a url' }).reason, 'unparseable-url');
    const noHud = trust.createHudTrust({ getHudWebContents: () => null, origin: ORIGIN });
    assert.equal(noHud.evaluate({ webContents: hudWc, isMainFrame: true, url: ORIGIN + '/' }).reason, 'no-hud-window');
  });

  test('another window, a subframe, a foreign origin or a generated document is refused', () => {
    const { t, hudWc, mediaWc } = world();
    assert.equal(t.evaluate({ webContents: mediaWc, isMainFrame: true, url: ORIGIN + '/' }).reason, 'not-hud-window');
    assert.equal(t.evaluate({ webContents: hudWc, isMainFrame: false, url: ORIGIN + '/' }).reason, 'subframe');
    for (const url of ['http://127.0.0.1:44780/', 'http://127.0.0.1:4478@evil.example/', 'https://127.0.0.1:4478/',
      'http://localhost:4478/', 'http://evil.example/']) {
      assert.equal(t.evaluate({ webContents: hudWc, isMainFrame: true, url }).reason, 'foreign-origin', url);
    }
    assert.equal(t.evaluate({ webContents: hudWc, isMainFrame: true, url: 'http://user:pw@127.0.0.1:4478/' }).reason, 'userinfo');
    for (const url of [ORIGIN + '/vault/builds/p/index.html', ORIGIN + '/media-embed.html', ORIGIN + '/api/status']) {
      assert.equal(t.evaluate({ webContents: hudWc, isMainFrame: true, url }).reason, 'not-a-hud-document', url);
    }
  });

  test('verdicts are frozen, so a caller cannot flip one', () => {
    const { t, hudWc } = world();
    const v = t.evaluate({ webContents: hudWc, isMainFrame: true, url: ORIGIN + '/' });
    assert.throws(() => { 'use strict'; v.ok = false; });
    assert.ok(Object.isFrozen(trust.HUD_DOCUMENT_PATHS));
  });
});

describe('the adapters turn each Electron shape into the same facts', () => {
  test('IPC: event.sender + event.senderFrame', () => {
    const { t, hudWc, mediaWc, mainFrame, childFrame } = world();
    assert.equal(t.ipc({ sender: hudWc, senderFrame: mainFrame() }).ok, true);
    assert.equal(t.ipc({ sender: hudWc, senderFrame: null }).reason, 'no-frame', 'a navigated-away frame reports null');
    assert.equal(t.ipc({ sender: hudWc, senderFrame: childFrame() }).reason, 'subframe');
    assert.equal(t.ipc({ sender: hudWc, senderFrame: { ...mainFrame(), detached: true } }).reason, 'no-frame');
    assert.equal(t.ipc({ sender: mediaWc, senderFrame: mainFrame() }).reason, 'not-hud-window');
    assert.equal(t.ipc({ sender: hudWc, senderFrame: mainFrame(ORIGIN + '/vault/builds/x.html') }).reason, 'not-a-hud-document');
    assert.equal(t.ipc(undefined).reason, 'no-window');
  });

  test('permission request: details.isMainFrame + details.requestingUrl (the measured iframe case is refused)', () => {
    const { t, hudWc } = world();
    assert.equal(t.permissionRequest(hudWc, { isMainFrame: true, requestingUrl: ORIGIN + '/' }).ok, true);
    assert.equal(t.permissionRequest(hudWc, { isMainFrame: false, requestingUrl: ORIGIN + '/child.html' }).reason, 'subframe');
    assert.equal(t.permissionRequest(hudWc, undefined).reason, 'no-frame');
  });

  test('permission check: an empty requestingUrl (measured on early checks) is refused', () => {
    const { t, hudWc } = world();
    assert.equal(t.permissionCheck(hudWc, { isMainFrame: true, requestingUrl: ORIGIN + '/' }).ok, true);
    assert.equal(t.permissionCheck(hudWc, { isMainFrame: true, requestingUrl: '' }).reason, 'no-document-url');
    assert.equal(t.permissionCheck(null, { isMainFrame: true, requestingUrl: ORIGIN + '/' }).reason, 'no-window');
  });

  test('display media: request.frame, mapped to its window with webContents.fromFrame', () => {
    const { t, hudWc, mediaWc, mainFrame, childFrame } = world();
    const frames = new Map();
    const wcModule = { fromFrame: (f) => frames.get(f) || null };
    const top = mainFrame();
    frames.set(top, hudWc);
    assert.equal(t.displayMedia({ frame: top }, wcModule).ok, true);
    const child = childFrame();
    frames.set(child, hudWc);
    assert.equal(t.displayMedia({ frame: child }, wcModule).reason, 'subframe');
    const media = mainFrame();
    frames.set(media, mediaWc);
    assert.equal(t.displayMedia({ frame: media }, wcModule).reason, 'not-hud-window');
    assert.equal(t.displayMedia({ frame: null }, wcModule).reason, 'no-window');
    assert.equal(t.displayMedia({ frame: top }, {}).reason, 'no-window', 'no fromFrame means the requester cannot be named');
    assert.equal(t.displayMedia({ frame: top }, { fromFrame: () => { throw new Error('gone'); } }).reason, 'no-window');
  });

  test('navigation: only a HUD document on the HUD origin may load in the HUD window', () => {
    const { t } = world();
    assert.equal(t.navigation(ORIGIN + '/').ok, true);
    for (const url of [ORIGIN + '/vault/builds/x/index.html', 'http://127.0.0.1:4478@evil.example/',
      'http://127.0.0.1:44780/', 'https://example.com/', 'file:///C:/x.html', 'javascript:alert(1)']) {
      assert.equal(t.navigation(url).ok, false, url);
    }
  });

  // Independent review, 2026-09-29: a strict origin parse THREW for a legal but
  // non-canonical MYTHOS_BIND, and main.js builds this while it is still loading —
  // Electron would have stayed up with no window at all.
  test('hudOriginFor normalises any bind the URL parser accepts, and never throws', () => {
    assert.equal(trust.hudOriginFor('127.0.0.1', 4478), 'http://127.0.0.1:4478');
    assert.equal(trust.hudOriginFor('LOCALHOST', 4478), 'http://localhost:4478');
    assert.equal(trust.hudOriginFor('127.1', 4478), 'http://127.0.0.1:4478');
    assert.equal(trust.hudOriginFor('::1', 4478), 'http://[::1]:4478');
    assert.equal(trust.hudOriginFor('[::1]', 4478), 'http://[::1]:4478');
    assert.equal(trust.hudOriginFor('127.0.0.1', 80), 'http://127.0.0.1');
    for (const bad of ['[[::1]]', 'a b', 'x/y', 'u@h', '']) {
      assert.equal(trust.hudOriginFor(bad, 4478), trust.UNUSABLE_BIND_ORIGIN, JSON.stringify(bad));
    }
    // and whatever it returns is accepted by createHudTrust
    for (const b of ['LOCALHOST', '127.1', '::1', '[[::1]]']) {
      assert.doesNotThrow(() => trust.createHudTrust({ getHudWebContents: () => null, origin: trust.hudOriginFor(b, 4478) }));
    }
  });

  test('documentUrl is the one URL the HUD window loads, and it passes its own predicate', () => {
    const { t } = world();
    assert.equal(t.documentUrl(), ORIGIN + '/');
    assert.equal(t.navigation(t.documentUrl()).ok, true);
    assert.throws(() => trust.createHudTrust({ getHudWebContents: () => null, origin: 'http://127.0.0.1:4478/x' }), /origin/);
  });
});

describe('electron/main.js routes every authority callback through the predicate', () => {
  test('every ipcMain.handle / ipcMain.on handler checks hudTrust.ipc(event)', () => {
    // Every registration shape, not only the two in use today (independent
    // review, 2026-09-29): a future handleOnce/once, or a double-quoted channel,
    // must not escape the gate.
    const handlers = [...MAIN.matchAll(/ipcMain\.(handle|handleOnce|on|once)\(\s*['"`]([^'"`]+)/g)].map((m) => ({ at: m.index, name: m[2] }));
    assert.ok(handlers.length >= 8, `found ${handlers.length}`);
    for (const h of handlers) {
      const body = MAIN.slice(h.at, h.at + 400);
      assert.match(body, /hudTrust\.ipc\(event\)\.ok/, `${h.name} must check the IPC sender through hudTrust`);
    }
    assert.doesNotMatch(MAIN, /isHudContents\(event\.sender\)/, 'the window-only check is gone from IPC');
  });

  test('both permission handlers take details and use the adapters', () => {
    assert.match(MAIN, /setPermissionRequestHandler\(\(wc, permission, callback, details\) =>/);
    assert.match(MAIN, /hudTrust\.permissionRequest\(wc, details\)\.ok/);
    assert.match(MAIN, /setPermissionCheckHandler\(\(wc, permission, requestingOrigin, details\) =>/);
    assert.match(MAIN, /hudTrust\.permissionCheck\(wc, details\)/);
  });

  test('display media goes through the adapter', () => {
    const at = MAIN.indexOf('setDisplayMediaRequestHandler((request, callback)');
    assert.ok(at > 0);
    assert.match(MAIN.slice(at, at + 1500), /hudTrust\.displayMedia\(request, webContents\)/);
  });

  test('navigation: no prefix check; will-navigate AND will-redirect use one predicate-backed handler', () => {
    assert.doesNotMatch(MAIN, /startsWith\(hudOrigin\)/, 'a prefix compare admits 127.0.0.1:44780 and user@host tricks');
    for (const ev of ['will-navigate', 'will-redirect']) {
      assert.match(MAIN, new RegExp(`mainWindow\\.webContents\\.on\\('${ev}', denyForeignHudLoad\\)`), `${ev} must be handled`);
    }
    const at = MAIN.indexOf('const denyForeignHudLoad = (navEvent, url) =>');
    assert.ok(at > 0, 'the shared handler must exist');
    const body = MAIN.slice(at, at + 400);
    assert.match(body, /hudTrust\.navigation\(url\)\.ok/);
    assert.match(body, /navEvent\.preventDefault\(\)/);
    assert.match(body, /navEvent\.isMainFrame !== false/, 'will-redirect fires for iframes; only the main frame carries the preload');
  });

  test('every HUD load uses hudTrust.documentUrl()', () => {
    const loads = [...MAIN.matchAll(/mainWindow\.loadURL\((.*?)\);/g)].map((m) => m[1]);
    assert.ok(loads.length >= 2, `found ${loads.length}`);
    for (const arg of loads) assert.equal(arg, 'hudTrust.documentUrl()');
  });
});

describe('crossOriginRefusal compares the full origin (B3a)', () => {
  const req = (origin, host = '127.0.0.1:4478', extra = {}) => ({ headers: { origin, host, ...extra }, socket: {} });
  test('same scheme, host and port is same-origin', () => {
    assert.equal(crossOriginRefusal(req('http://127.0.0.1:4478')), null);
    assert.equal(crossOriginRefusal(req('http://127.0.0.1:4478', '127.0.0.1:4478'), new Set()), null);
  });
  test('the same host under another scheme is NOT same-origin', () => {
    assert.equal(crossOriginRefusal(req('https://127.0.0.1:4478')), 'origin');
  });
  test('a TLS-terminating proxy is an explicit ALLOWED_ORIGINS entry, not an implicit pass', () => {
    assert.equal(crossOriginRefusal(req('https://mythos.lan'), new Set(['https://mythos.lan'])), null);
    assert.equal(crossOriginRefusal(req('https://mythos.lan', 'mythos.lan')), 'origin');
  });
  test('a request the server itself received over TLS compares as https', () => {
    assert.equal(crossOriginRefusal({ headers: { origin: 'https://127.0.0.1:4478', host: '127.0.0.1:4478' }, socket: { encrypted: true } }), null);
  });
});
