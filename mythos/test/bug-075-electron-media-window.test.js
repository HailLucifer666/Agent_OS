'use strict';

// bug-075-electron-media-window.test.js — Stage 5 of 7.
//
// Operator, verbatim: "I did not ask you to play on YouTube widget. I
// specifically said, open YouTube on the Electron app." Then
// launch_app("youtube") failed 3x (nothing named YouTube is a Windows app —
// every launch tier honestly missed). Separately, a YouTube video "could not
// be stopped with standard playback controls" — no close path existed.
//
// electron/main.js requires the real `electron` module at load and cannot be
// require()d under plain `node --test` (see electron-talk-hotkey.test.js's
// header) — so the actual window-opening/closing logic lives in
// electron/media-window.js instead: a plain module with an INJECTED
// BrowserWindow constructor, testable here with a fake one. This is the real
// IPC/signal-boundary test the stage's success criterion calls for — not a
// regex check on main.js's source text.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  resolveMediaUrl,
  createMediaWindowController,
} = require('../../electron/media-window');
const { buildTools } = require('../src/core/effectors/from-dashboard');
const { fakeBus } = require('./helpers');

const MAIN = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'main.js'), 'utf8');

function toolFn(built, name) {
  const tool = built.TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error('tool not found: ' + name);
  return tool.fn;
}

// A fake BrowserWindow: enough surface for media-window.js to drive (webPreferences
// passthrough not asserted here — that's covered by the real Electron window shape
// elsewhere in this repo's electron-* tests).
function makeFakeBrowserWindowCtor() {
  const instances = [];
  function FakeBrowserWindow(opts) {
    this.opts = opts;
    this.loadedUrls = [];
    this.destroyed = false;
    this.focused = false;
    this._closedHandlers = [];
    instances.push(this);
  }
  FakeBrowserWindow.prototype.loadURL = function (url) { this.loadedUrls.push(url); };
  FakeBrowserWindow.prototype.focus = function () { this.focused = true; };
  FakeBrowserWindow.prototype.isDestroyed = function () { return this.destroyed; };
  FakeBrowserWindow.prototype.on = function (evt, handler) {
    if (evt === 'closed') this._closedHandlers.push(handler);
  };
  FakeBrowserWindow.prototype.close = function () {
    this.destroyed = true;
    this._closedHandlers.forEach((h) => h());
  };
  FakeBrowserWindow.instances = instances;
  return FakeBrowserWindow;
}

describe('BUG-075 — resolveMediaUrl (which open-web payloads become a real window)', () => {
  it('picks up youtube embedUrl payloads', () => {
    const url = resolveMediaUrl({ widgetType: 'youtube', embedUrl: 'https://www.youtube-nocookie.com/embed/abc', videoId: 'abc' });
    assert.equal(url, 'https://www.youtube-nocookie.com/embed/abc');
  });

  it('picks up web embedUrl payloads', () => {
    const url = resolveMediaUrl({ widgetType: 'web', embedUrl: 'https://example.com' });
    assert.equal(url, 'https://example.com');
  });

  it('does NOT promote search/weather/flights/image widgets — those stay floating dashboard widgets', () => {
    assert.equal(resolveMediaUrl({ widgetType: 'search', cards: [] }), null);
    assert.equal(resolveMediaUrl({ widgetType: 'weather', weatherUrl: 'x' }), null);
    assert.equal(resolveMediaUrl({ widgetType: 'flights', cards: [] }), null);
    assert.equal(resolveMediaUrl({ widgetType: 'image', cards: [] }), null);
  });

  it('does NOT promote newtab/news — those already mean "leave MYTHOS entirely"', () => {
    assert.equal(resolveMediaUrl({ widgetType: 'newtab', url: 'https://youtube.com/watch?v=x' }), null);
    assert.equal(resolveMediaUrl({ widgetType: 'news' }), null);
  });

  it('rejects malformed payloads without throwing', () => {
    assert.equal(resolveMediaUrl(null), null);
    assert.equal(resolveMediaUrl(undefined), null);
    assert.equal(resolveMediaUrl({}), null);
    assert.equal(resolveMediaUrl({ widgetType: 'youtube' }), null); // no url/embedUrl
  });
});

describe('BUG-075 — createMediaWindowController (the IPC-boundary handler electron/main.js wires up)', () => {
  let FakeBrowserWindow;
  let controller;

  beforeEach(() => {
    FakeBrowserWindow = makeFakeBrowserWindowCtor();
    controller = createMediaWindowController({ BrowserWindowCtor: FakeBrowserWindow, preloadPath: '/fake/preload.js' });
  });

  it('opens a real (fake) BrowserWindow for a youtube open-web payload — this is the actual fix', () => {
    const res = controller.handleOpenWeb({ widgetType: 'youtube', embedUrl: 'https://www.youtube-nocookie.com/embed/xyz', videoId: 'xyz' });
    assert.equal(res.opened, true);
    assert.equal(res.reused, false);
    assert.equal(FakeBrowserWindow.instances.length, 1, 'exactly one window must be created');
    assert.deepEqual(FakeBrowserWindow.instances[0].loadedUrls, ['https://www.youtube-nocookie.com/embed/xyz']);
  });

  it('reuses the existing window for a second open, instead of stacking a new one every time', () => {
    controller.handleOpenWeb({ widgetType: 'youtube', embedUrl: 'https://example.com/first' });
    const res = controller.handleOpenWeb({ widgetType: 'web', embedUrl: 'https://example.com/second' });
    assert.equal(res.reused, true);
    assert.equal(FakeBrowserWindow.instances.length, 1, 'a second open must NOT create a second window');
    assert.deepEqual(FakeBrowserWindow.instances[0].loadedUrls, ['https://example.com/first', 'https://example.com/second']);
  });

  it('creates a new window if the previous one was already closed', () => {
    controller.handleOpenWeb({ widgetType: 'youtube', embedUrl: 'https://example.com/first' });
    controller.closeMediaWindow();
    const res = controller.handleOpenWeb({ widgetType: 'youtube', embedUrl: 'https://example.com/second' });
    assert.equal(res.reused, false);
    assert.equal(FakeBrowserWindow.instances.length, 2);
  });

  it('does nothing for a non-media widgetType (search stays a dashboard widget)', () => {
    const res = controller.handleOpenWeb({ widgetType: 'search', cards: [] });
    assert.equal(res.opened, false);
    assert.equal(FakeBrowserWindow.instances.length, 0);
  });

  it('close path (the German-video fix): closes the tracked window and reports true', () => {
    controller.handleOpenWeb({ widgetType: 'youtube', embedUrl: 'https://example.com/vid' });
    const closed = controller.closeMediaWindow();
    assert.equal(closed, true);
    assert.equal(FakeBrowserWindow.instances[0].destroyed, true);
    assert.equal(controller.getWindow(), null);
  });

  it('close is a safe no-op when nothing is open (no window ever launched)', () => {
    assert.equal(controller.closeMediaWindow(), false);
  });

  it('throws loudly if wired without a real constructor, rather than failing silently later', () => {
    assert.throws(() => createMediaWindowController({ preloadPath: '/x' }), /BrowserWindowCtor/);
  });
});

describe('BUG-075 — electron/main.js wires the fork IPC channel to the controller (source-shape, matching electron-talk-hotkey.test.js\'s pattern for code that requires the real `electron` module)', () => {
  it('listens for child messages and routes ui.open-web / close-media-window', () => {
    assert.match(MAIN, /child\.on\('message'/, 'main.js must listen on the existing fork() IPC channel');
    assert.match(MAIN, /mythos:ui\.open-web/, 'must route the open-web relay channel');
    assert.match(MAIN, /mythos:close-media-window/, 'must route the close-media-window channel');
    assert.match(MAIN, /mediaWindowController\.handleOpenWeb\(/);
    assert.match(MAIN, /mediaWindowController\.closeMediaWindow\(/);
  });

  it('acks the close request back over the same channel, so close_panel can report the truth', () => {
    assert.match(MAIN, /close-media-window-ack/);
  });

  it('does not invent a new npm dependency or IPC transport — reuses createMediaWindowController', () => {
    assert.match(MAIN, /require\('\.\/media-window'\)/);
  });
});

describe('BUG-075 — server/index.js relays ui.open-web over the SAME fork channel (no new channel invented)', () => {
  const SERVER_INDEX = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');

  it('forwards the bus event via process.send on the existing "ipc" stdio slot', () => {
    assert.match(SERVER_INDEX, /bus\.subscribe\('ui\.open-web'/);
    assert.match(SERVER_INDEX, /process\.send\(\{ channel: 'mythos:ui\.open-web'/);
  });

  it('exposes requestCloseMediaWindow with the same request/ack shape as requestClosePanel', () => {
    assert.match(SERVER_INDEX, /function requestCloseMediaWindow/);
    assert.match(SERVER_INDEX, /mythos:close-media-window-ack/);
    assert.match(SERVER_INDEX, /requestCloseMediaWindow,/);
  });
});

describe('BUG-075 — close_panel also closes the Electron media window (the German-video fix, no new close_media_window tool)', () => {
  it('reports mediaWindowClosed:true and closed:true when only the media window was open (no overlay/widget)', async () => {
    const built = buildTools({ fs: null, bus: fakeBus(), config: {} });
    built.setClosePanelProvider(async () => ({ overlaysClosed: 0, widgetsClosed: 0 }));
    built.setMediaWindowCloser(async () => true);
    const result = await toolFn(built, 'close_panel')({ all: false });
    assert.equal(result.ok, true);
    assert.equal(result.result.mediaWindowClosed, true);
    assert.equal(result.result.closed, true, 'closed must be true even though overlaysClosed/widgetsClosed are both 0');
  });

  it('reports mediaWindowClosed:false when no media window was open, without failing the whole call', async () => {
    const built = buildTools({ fs: null, bus: fakeBus(), config: {} });
    built.setClosePanelProvider(async () => ({ overlaysClosed: 1, widgetsClosed: 0 }));
    built.setMediaWindowCloser(async () => false);
    const result = await toolFn(built, 'close_panel')({ all: false });
    assert.equal(result.ok, true);
    assert.equal(result.result.mediaWindowClosed, false);
    assert.equal(result.result.overlaysClosed, 1);
  });

  it('degrades to mediaWindowClosed:false, not an error, when not running under Electron (closer unset)', async () => {
    const built = buildTools({ fs: null, bus: fakeBus(), config: {} });
    built.setClosePanelProvider(async () => ({ overlaysClosed: 1, widgetsClosed: 0 }));
    // setMediaWindowCloser deliberately not called — mirrors a plain non-Electron boot.
    const result = await toolFn(built, 'close_panel')({ all: false });
    assert.equal(result.ok, true);
    assert.equal(result.result.mediaWindowClosed, false);
  });

  it('a throwing media-window closer does not fail the whole close_panel call', async () => {
    const built = buildTools({ fs: null, bus: fakeBus(), config: {} });
    built.setClosePanelProvider(async () => ({ overlaysClosed: 1, widgetsClosed: 0 }));
    built.setMediaWindowCloser(async () => { throw new Error('IPC round trip failed'); });
    const result = await toolFn(built, 'close_panel')({ all: false });
    assert.equal(result.ok, true);
    assert.equal(result.result.mediaWindowClosed, false);
  });
});
