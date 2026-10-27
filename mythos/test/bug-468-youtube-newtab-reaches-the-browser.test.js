'use strict';

// test/bug-468-youtube-newtab-reaches-the-browser.test.js
//
// BUG-468. On the attended machine YOUTUBE_MODE=newtab, so open_web
// {type:'youtube'} returned openWebResult({widgetType:'newtab', url}) for every
// video (and for the "no embeddable candidate" fallback). Under Electron that
// descriptor has no surface: the media window accepts only youtube/web and the
// HUD's window.open is denied for every url. The renderer round-trip therefore
// resolved null ("the dashboard did not answer") and the call was recorded
// UNVERIFIED while nothing played. browser:true already had a working route (the
// external opener, BUG-272 T2); the youtube branch never used it.
//
// THE FIX: when an external opener exists (the Electron shell), the youtube
// newtab result is handed to that same opener, and a refusal is a FAILURE with
// the shell's reason. With no opener (plain browser HUD, where the HUD's own
// newtab branch can still window.open) the old renderer path is kept.
//
// REWRITTEN ON PURPOSE (2026-10-06): test/bug-006-youtube-mode.test.js pinned
// "newtab mode returns widgetType newtab" through the RENDERER path. That is the
// dead end this ticket is about, so those assertions now run with an opener
// installed and assert the url reached it (see the comment in that file).
//
// MUTATION PROBES, 2026-10-06 (each applied once, diffed, restored from a copy):
//   (a) mode call site back to openWebResult(newtab)      -> reds "hands the watch url ...", "a refusing opener ...", "a THROWING opener ..."
//   (b) `if (!handoff.opened)` -> `if (false)`              -> reds "a refusing opener is a FAILURE ..."
//   (c) fallback call site back to openWebResult(newtab)   -> reds "the no-embeddable fallback ..."
//   (d) always take the external route (drop the no-opener guard) -> reds the ADJACENT "NO opener keeps the renderer path"
//   (e) drop the call-site `await` on openYoutubeNewtab    -> reds "a THROWING opener ..." (a thrown opener escaped open_web's try/catch)
//   (f) drop the `await` on handToBrowser in the browser:true branch -> reds bug-272-open-external's "a thrown opener ..."
//   (g) NO_EMBED web call site back to openWebResult(newtab) (2026-10-06 gate B) -> reds both "NO_EMBED web newtab" opener tests
//   SURVIVOR (gate F): an `await` on handToBrowser INSIDE openYoutubeNewtab is redundant once the call
//   site awaits the async function, so it was removed rather than kept as dead defence.
//   Each applied once, diffed, restored from a copy and hash-verified.
//
// REMOVED 2026-10-27 (review of #156): an `ack.opened === false` branch and the two
// tests that fed it. Nothing in production can produce that field, so the branch was
// unreachable and the tests pinned a fabricated ack shape:
//   - The only widgetRenderer ever installed is serverHandle.requestWidgetRender
//     (src/main.js:930). For widgetType youtube/web under Electron it resolves null
//     immediately (server/index.js:430) - before any ack - so openWebResult takes the
//     silence branch.
//   - The HUD's own ack (ui/public/js/app.js:1069-1102) carries only
//     {mounted, unverified, surface, reason}, and the resolver at
//     server/index.js:3867 rebuilds exactly those four keys - `opened` is dropped.
//   - The Electron media-window ack that DOES carry `opened`
//     (electron/main.js:982, channel 'mythos:ui.open-web-ack') has no handler in
//     server/index.js, whose child channels are close-media-window-ack,
//     confirm-import-answer, input-inhibit, open-external-ack, open-path-ack, ocr-grab.
// Wiring it would not be a drop-in: handleOpenWeb returns opened:true straight after
// loadURL (electron/media-window.js:84-86,102-104) with no did-finish-load, so
// "accepted" is not "rendered" and mapping it onto `mounted` would fabricate
// verification. The branch also sat BEFORE the `mounted` check, so a future
// {opened:false, mounted:true} would have been a false failure. Deleted rather than
// guessed at; if that ack is ever wired, the mapping belongs on the load event.
//
// ADJACENT CASES THAT MUST KEEP PASSING: electron mode still renders in the HUD
// and never touches the opener; newtab mode with NO opener still goes to the
// renderer (a plain-browser HUD can window.open it); a verified ack stays
// verified.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { buildTools } = require('../src/core/effectors/from-dashboard');

const VID = 'dQw4w9WgXcQ';
const TITLE = 'Stub Video Title';
const WATCH = 'https://www.youtube.com/watch?v=' + VID;

function stubFetch({ embeddable }) {
  return async (url) => {
    const u = String(url);
    if (u.includes('duckduckgo.com')) {
      return { ok: true, status: 200, text: async () => '<div class="result"><a class="result__a" href="' + WATCH + '">' + TITLE + '</a><a class="result__snippet">s</a></div>' };
    }
    if (u.includes('youtube.com/oembed')) {
      return embeddable ? { ok: true, status: 200, json: async () => ({ title: TITLE }) } : { ok: false, status: 403 };
    }
    throw new Error('unstubbed network call in bug-468 test: ' + u);
  };
}

function build(config) {
  const built = buildTools({ bus: { emit() {}, subscribe() {} }, config, logger: { info() {}, warn() {}, error() {} } });
  const open_web = built.TOOLS.find((t) => t.name === 'open_web').fn;
  return { built, open_web };
}

describe('BUG-468 — youtube newtab goes to the external opener', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  describe('mode newtab, opener installed', () => {
    let seen, rendered, built, open_web;
    beforeEach(() => {
      global.fetch = stubFetch({ embeddable: true });
      seen = []; rendered = [];
      ({ built, open_web } = build({ YOUTUBE_MODE: 'newtab' }));
      built.setExternalOpener(async (u) => { seen.push(u); return { opened: true, reason: null }; });
      built.setWidgetRenderer(async (p) => { rendered.push(p); return null; });
    });

    // (a)
    it('hands the watch url to the opener, and never to the renderer (which has no newtab surface)', async () => {
      const res = await open_web({ type: 'youtube', query: TITLE });
      assert.deepEqual(seen, [WATCH], 'the url must reach the shell opener');
      assert.equal(rendered.length, 0, 'the renderer round-trip is the dead end; it must not be asked');
      assert.equal(res.ok, true);
      assert.equal(res.result.widgetType, 'newtab');
      assert.equal(res.result.url, WATCH);
      assert.equal(res.result.handedToBrowser, true);
    });

    // (b2) the hand-off is awaited inside open_web's try/catch (a missing `await` here
    // let a thrown opener escape as a rejection; bug-272's browser:true twin caught it)
    it('a THROWING opener is a failure, not an unhandled rejection', async () => {
      built.setExternalOpener(async () => { throw new Error('IPC round trip failed'); });
      const res = await open_web({ type: 'youtube', query: TITLE });
      assert.equal(res.ok, false);
    });

    // (b)
    it('a refusing opener is a FAILURE carrying the shell reason, not an unverified ok', async () => {
      built.setExternalOpener(async () => ({ opened: false, reason: 'the Electron shell did not acknowledge the request' }));
      const res = await open_web({ type: 'youtube', query: TITLE });
      assert.equal(res.ok, false);
      assert.match(String(res.error || res.result), /did not acknowledge the request/);
      assert.equal(rendered.length, 0);
    });
  });

  // (c) the fallback (no embeddable candidate) shares the same dead end
  it('the no-embeddable fallback also reaches the opener, in the default electron mode', async () => {
    global.fetch = stubFetch({ embeddable: false });
    const seen = []; const rendered = [];
    const { built, open_web } = build({});
    built.setExternalOpener(async (u) => { seen.push(u); return { opened: true }; });
    built.setWidgetRenderer(async (p) => { rendered.push(p); return null; });
    const res = await open_web({ type: 'youtube', query: TITLE });
    assert.deepEqual(seen, [WATCH]);
    assert.equal(rendered.length, 0);
    assert.equal(res.ok, true);
    assert.equal(res.result.widgetType, 'newtab');
  });

  // ADJACENT (must keep passing)
  it('electron mode still renders in the HUD and never calls the opener', async () => {
    global.fetch = stubFetch({ embeddable: true });
    const seen = []; const rendered = [];
    const { built, open_web } = build({ YOUTUBE_MODE: 'electron' });
    built.setExternalOpener(async (u) => { seen.push(u); return { opened: true }; });
    built.setWidgetRenderer(async (p) => { rendered.push(p); return { mounted: true, surface: 'media-window' }; });
    const res = await open_web({ type: 'youtube', query: TITLE });
    assert.equal(seen.length, 0);
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0].widgetType, 'youtube');
    assert.equal(res.ok, true);
    assert.notEqual(res.unverified, true, 'a mounted ack stays verified');
  });

  it('newtab mode with NO opener (plain browser HUD) keeps the renderer path', async () => {
    global.fetch = stubFetch({ embeddable: true });
    const rendered = [];
    const { built, open_web } = build({ YOUTUBE_MODE: 'newtab' });
    built.setWidgetRenderer(async (p) => { rendered.push(p); return { mounted: false, unverified: true, reason: 'the popup could not be confirmed' }; });
    const res = await open_web({ type: 'youtube', query: TITLE });
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0].widgetType, 'newtab');
    assert.equal(res.ok, true);
    assert.equal(res.unverified, true);
  });

});

// Gate B follow-up (2026-10-06): the reason ("a newtab result has no surface under
// Electron") covers the NO_EMBED `web` branch too, so it takes the same hand-off.
describe('BUG-468 gate B — the NO_EMBED web newtab branch', () => {
  const GH = 'https://github.com/example/repo';
  it('hands a no-embed domain to the opener and never to the renderer', async () => {
    const seen = []; const rendered = [];
    const { built, open_web } = build({});
    built.setExternalOpener(async (u) => { seen.push(u); return { opened: true }; });
    built.setWidgetRenderer(async (p) => { rendered.push(p); return null; });
    const res = await open_web({ type: 'web', url: GH });
    assert.deepEqual(seen, [GH]);
    assert.equal(rendered.length, 0);
    assert.equal(res.ok, true);
    assert.equal(res.result.widgetType, 'newtab');
  });
  it('a refusing opener is a failure with its reason', async () => {
    const { built, open_web } = build({});
    built.setExternalOpener(async () => ({ opened: false, reason: 'refused scheme' }));
    const res = await open_web({ type: 'web', url: GH });
    assert.equal(res.ok, false);
    assert.match(String(res.error || res.result), /refused scheme/);
  });
  // ADJACENT: decision recorded 2026-10-06 - with NO opener (plain browser HUD) the renderer path stays.
  it('with no opener the renderer still gets the newtab descriptor', async () => {
    const rendered = [];
    const { built, open_web } = build({});
    built.setWidgetRenderer(async (p) => { rendered.push(p); return { mounted: false, unverified: true, reason: 'popup unconfirmed' }; });
    const res = await open_web({ type: 'web', url: GH });
    assert.equal(rendered[0].widgetType, 'newtab');
    assert.equal(res.unverified, true);
  });
  // ADJACENT: an embeddable domain is untouched.
  it('an embeddable domain still renders as a web panel and never calls the opener', async () => {
    const seen = []; const rendered = [];
    const { built, open_web } = build({});
    built.setExternalOpener(async (u) => { seen.push(u); return { opened: true }; });
    built.setWidgetRenderer(async (p) => { rendered.push(p); return { mounted: true }; });
    await open_web({ type: 'web', url: 'https://example.org/page' });
    assert.equal(seen.length, 0);
    assert.equal(rendered[0].widgetType, 'web');
  });
});
