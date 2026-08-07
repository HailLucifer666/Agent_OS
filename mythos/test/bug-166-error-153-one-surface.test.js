'use strict';

// BUG-166 — YouTube Error 153 + two fighting windows (operator incident
// 2026-08-07 04:04: "open_web(type:'youtube') creates conflicting windows: an
// Electron overlay showing Error 153, and a dashboard panel that is
// non-interactive").
//
// Two defects, both reproduced before fixing:
// 1. server/index.js's ui.open-web subscriber both broadcast to the HUD (panel
//    opens) AND relayed to Electron (media window opens) — two players per
//    call. Under Electron the media window is the designed surface for
//    youtube/web (BUG-075's operator ask), so the panel broadcast is now
//    suppressed for exactly those two types.
// 2. electron/media-window.js loaded the EMBED URL as the window's top-level
//    document. A top-level embed carries no referer and YouTube answers
//    "Error 153: video player configuration error" — reproduced in headless
//    Chromium (bare embed URL -> 153; same URL iframed from a local page ->
//    no 153). youtube payloads now route to ui/public/media-embed.html, which
//    iframes the pre-checked embed from the server origin.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveMediaUrl, createMediaWindowController } = require('../../electron/media-window');

describe('BUG-166: youtube loads via the local wrapper page, never top-level', () => {
  const payload = {
    widgetType: 'youtube',
    embedUrl: 'https://www.youtube-nocookie.com/embed/abc123?autoplay=1',
    title: 'A Song',
  };

  it('with a mediaBaseUrl, a youtube payload resolves to media-embed.html with the embed encoded', () => {
    const url = resolveMediaUrl(payload, 'http://127.0.0.1:4478');
    assert.ok(url.startsWith('http://127.0.0.1:4478/media-embed.html?src='), url);
    assert.ok(url.includes(encodeURIComponent(payload.embedUrl)), 'the embed URL must survive, encoded');
    assert.ok(url.includes('title=A%20Song'));
  });

  it('a `web` payload still loads directly — real pages are top-level documents', () => {
    const url = resolveMediaUrl({ widgetType: 'web', embedUrl: 'https://example.com/page' }, 'http://127.0.0.1:4478');
    assert.equal(url, 'https://example.com/page');
  });

  it('without a mediaBaseUrl the old direct behaviour is unchanged (non-Electron callers)', () => {
    assert.equal(resolveMediaUrl(payload), payload.embedUrl);
  });

  it('the controller passes its mediaBaseUrl through on open and reuse', () => {
    const loaded = [];
    function FakeWin() {
      this.loadURL = (u) => loaded.push(u);
      this.focus = () => {};
      this.isDestroyed = () => false;
      this.on = () => {};
    }
    const ctl = createMediaWindowController({ BrowserWindowCtor: FakeWin, preloadPath: 'x', mediaBaseUrl: 'http://127.0.0.1:4478' });
    ctl.handleOpenWeb(payload);
    ctl.handleOpenWeb(payload); // reuse path
    assert.equal(loaded.length, 2);
    for (const u of loaded) assert.ok(u.includes('/media-embed.html?src='), u);
  });
});

describe('BUG-166: the wrapper page is not a frame-anything gadget', () => {
  const page = fs.readFileSync(path.resolve(__dirname, '..', 'ui', 'public', 'media-embed.html'), 'utf8');

  it('allowlists YouTube embed origins only', () => {
    assert.match(page, /youtube\\\.com|youtube\.com/);
    assert.match(page, /youtube-nocookie/);
    assert.match(page, /\/embed\\?\//, 'the path must be pinned to /embed/, not just the host');
    assert.match(page, /Refused to embed/, 'a non-allowlisted src must be refused visibly');
  });

  it('renders the refusal with textContent, never innerHTML (src is untrusted)', () => {
    assert.ok(!/innerHTML/.test(page));
    assert.match(page, /textContent/);
  });
});

describe('BUG-166: one surface per open_web call (server relay shape)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'server', 'index.js'), 'utf8');

  it('the ui.open-web subscriber suppresses the panel broadcast when Electron handles youtube/web', () => {
    const idx = src.indexOf("bus.subscribe('ui.open-web'");
    assert.ok(idx !== -1);
    const block = src.slice(idx, idx + 2600);
    assert.match(block, /electronHandles/, 'the one-surface gate must exist');
    assert.match(block, /widgetType === 'youtube' \|\| e\.payload\.widgetType === 'web'/);
    assert.match(block, /if \(!electronHandles\) broadcastAll/, 'the broadcast must be conditional on Electron NOT handling it');
    assert.match(block, /typeof process\.send === 'function'/, 'a plain node boot must keep broadcasting (no Electron parent)');
  });
});
