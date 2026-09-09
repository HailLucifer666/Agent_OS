'use strict';

// bug-417-rank-below-the-fold.test.js — BUG-417, the engine half.
//
// THE DEFECT, read out of browser-extension/engine.js on 2026-09-09. snapshot()
// ranked a card only if `visible(card)` AND `refs.has(el)`, and `refs` is filled
// by the targets loop above, which also requires visible(). So the item list was
// VIEWPORT-ONLY and `ordinal` indexed into it. Two consequences:
//
//   * a YouTube search page shows roughly four or five cards, so "play the sixth
//     result" polled until the observation budget ran out and blocked —
//     honestly, but for a reason the operator reads as a bug, because
//     desktop_task_start advertises "result 1 through 20";
//   * on an already-scrolled page "the second video" selected the second card
//     CURRENTLY IN VIEW, which might be result seven. Verification could never
//     catch that: the expected identity is derived from the same observation
//     that made the wrong choice.
//
// WHY THIS FILE EXISTS RATHER THAN AN ADDITION TO browser-extension-engine.test.js.
// That suite stubs Runtime.evaluate, so snapshot() never runs against a DOM
// there — its assertions are about the debugger plumbing, and the ranking rule
// had NO direct coverage at all. snapshot is exported, so it can be run against
// a purpose-built DOM instead. The controller half (bounded scroll-to-reveal)
// lives in desktop-ordinal.test.js.
//
// MUTATION PROBES, run 2026-09-09 against browser-extension/engine.js and
// src/core/desktop/controller.js together (this file plus desktop-ordinal).
// Seven probes, all landed, all fired, no survivors; both sources restored by
// byte copy with matching sha256.
//
// ONE PROBE SURVIVED ON THE FIRST RUN, AND THE FAULT WAS IN THIS FILE. (m3)
// shortened the engine's ad-selector list, and the fixture's `closest()` matched
// it with `sel.includes('ytd-ad-slot-renderer')` — a substring that the
// shortened list still contained. So the fake went on reporting an ad, the guard
// looked healthy and the mutation had changed nothing observable. `closest()`
// now splits the selector and tests membership, and the corrected probe (delete
// the whole ad clause) fires. A mutation that silently fails looks exactly like
// a guard that works; a fixture matching a substring of a selector list is one
// way to get there.
//
//   (m1) restore the `!visible(card)` skip           -> 5 fails, every test here
//   (m2) give an off-screen card a ref anyway        -> 2 fails, led by (b)
//   (m3) delete the ad clause entirely               -> 1 fail: (c)
//   (m4) ordinal counts visible cards, not list ones -> 1 fail: (d)
//   (m5) drop the scroll cap (controller)            -> 1 fail: the budget test
//   (m6) drop the early stop (controller)            -> 1 fail: the growth test
//   (m7) readiness requires a ref again (controller) -> 3 fails; a below-fold
//        card never reaches reveal, which is the pre-fix behaviour exactly

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../browser-extension/engine.js'), 'utf8');

const CARD_SELECTOR = 'ytd-video-renderer,ytd-rich-item-renderer,ytd-grid-video-renderer';
const ROOT_SELECTOR = 'ytd-search,ytd-browse[page-subtype="home"] ytd-rich-grid-renderer';
const TARGET_SELECTOR = 'a[href],button,[role="button"],input,select,textarea,video';
const VIEWPORT = 800;

// A card is `top` pixels down the page. The engine's visible() requires
// bottom > 0 and top < innerHeight, so a card at top >= VIEWPORT is below the
// fold and one at top <= -height is above it — exactly the two states the old
// code silently dropped.
function makeCard(index, top, opts = {}) {
  const height = 200;
  const rect = { top, bottom: top + height, left: 0, width: 400, height };
  const link = {
    tagName: 'A', href: opts.href || ('https://www.youtube.com/watch?v=id-' + index),
    innerText: opts.title || ('Video ' + index), textContent: opts.title || ('Video ' + index),
    getAttribute: () => null,
    getBoundingClientRect: () => rect,
  };
  const card = {
    tagName: 'YTD-VIDEO-RENDERER', href: null, innerText: '', textContent: '',
    getAttribute: () => null,
    getBoundingClientRect: () => rect,
    // An ad card sits inside ytd-ad-slot-renderer. Matched by SPLITTING the
    // selector and testing membership, not by `sel.includes(...)`: the first
    // draft used includes(), and mutation (m3) — which shortened the selector
    // list — left `ytd-ad-slot-renderer` in the string, so the fixture went on
    // reporting an ad and the probe SURVIVED. A mutation that silently fails
    // looks exactly like a guard that works, and a fixture that matches on a
    // substring of a selector list is how that happens.
    closest: (sel) => (opts.ad && sel.split(',').map((s) => s.trim()).includes('ytd-ad-slot-renderer')
      ? { tagName: 'YTD-AD-SLOT-RENDERER' } : null),
    querySelector: (sel) => (sel.includes('a#video-title') ? link : null),
  };
  return { card, link, rect };
}

function run(cards) {
  const root = {
    tagName: 'YTD-SEARCH', href: null, innerText: '', textContent: '',
    getAttribute: () => null,
    getBoundingClientRect: () => ({ top: 0, bottom: VIEWPORT, left: 0, width: 1200, height: VIEWPORT }),
    closest: () => null,
    querySelectorAll: (sel) => (sel === CARD_SELECTOR ? cards.map((c) => c.card) : []),
    querySelector: () => null,
  };
  // Only links inside the viewport reach the targets loop, which is what fills
  // `refs` — modelled here rather than assumed, because it is the mechanism the
  // old code depended on without saying so.
  const document = {
    title: 'search results - YouTube',
    querySelectorAll: (sel) => {
      if (sel === TARGET_SELECTOR) return cards.map((c) => c.link);
      if (sel === ROOT_SELECTOR) return [root];
      return [];
    },
  };
  const sandbox = {
    document,
    location: { hostname: 'www.youtube.com', href: 'https://www.youtube.com/results?search_query=x' },
    innerHeight: VIEWPORT,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    URL,
    console,
    module: { exports: {} },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  // Round-tripped through JSON on purpose. Arrays built inside the VM carry the
  // VM realm's Array.prototype, and assert.deepStrictEqual compares prototypes —
  // so [null,null,null] from in there fails against [null,null,null] out here,
  // printing two identical-looking values. Normalise at the boundary rather than
  // reaching for deepEqual's loose cousin, which would also stop catching the
  // null-vs-undefined distinction this file turns on.
  return JSON.parse(JSON.stringify(sandbox.module.exports.snapshot('obs-1')));
}

test('BUG-417 (a,b,d) — every card in the region is ranked, and only the visible ones get a ref', () => {
  // Four cards on screen, four below the fold: the measured shape of a YouTube
  // search page against a request for result six.
  const cards = [0, 200, 400, 600, 800, 1000, 1200, 1400].map((top, i) => makeCard(i + 1, top));
  const snap = run(cards);

  assert.equal(snap.items.length, 8,
    '(m1) before this, the four cards below the fold were not in the list at all, '
    + 'so "play the sixth result" could never succeed on a page advertising 1 through 20');

  // (d) ordinals count the LIST, not the viewport.
  assert.deepEqual(snap.items.map((i) => i.ordinal), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(snap.items.map((i) => i.videoId),
    ['id-1', 'id-2', 'id-3', 'id-4', 'id-5', 'id-6', 'id-7', 'id-8']);

  // (b) a card below the fold is unclickable BY SHAPE, not by a downstream check.
  assert.deepEqual(snap.items.map((i) => i.visible), [true, true, true, true, false, false, false, false]);
  assert.deepEqual(snap.items.slice(0, 4).map((i) => typeof i.ref), ['string', 'string', 'string', 'string']);
  assert.deepEqual(snap.items.slice(4).map((i) => i.ref), [null, null, null, null],
    '(m2) a ref for an off-screen card would be clickable-looking and actOnNode would refuse it '
    + 'at the last moment — the ordinal must be able to NAME a card it cannot yet click');

  // The offset is what lets a reader see how far away it is.
  assert.equal(snap.items[5].top, 1000);
});

test('BUG-417 (c) — ads are excluded above and below the fold alike', () => {
  // (m3). Widening the ranked set is exactly the change most likely to let an
  // ad in, and an ad ranked as result two would be clicked as one.
  const cards = [
    makeCard(1, 0), makeCard(2, 200, { ad: true }), makeCard(3, 400),
    makeCard(4, 900, { ad: true }), makeCard(5, 1100),
  ];
  const snap = run(cards);
  assert.deepEqual(snap.items.map((i) => i.videoId), ['id-1', 'id-3', 'id-5'],
    'the two ad slots are dropped whether they are on screen or not');
  assert.deepEqual(snap.items.map((i) => i.ordinal), [1, 2, 3],
    'and the ordinals close up, so "the second result" means the second real video');
});

test('BUG-417 — Shorts and duplicates stay excluded now that the set is wider', () => {
  // The adjacent cases that must keep passing. Every one of these was already
  // handled; ranking beyond the fold must not quietly re-admit them.
  const cards = [
    makeCard(1, 0),
    makeCard(2, 200, { href: 'https://www.youtube.com/shorts/aaa' }),
    makeCard(3, 900, { href: 'https://www.youtube.com/shorts/bbb' }),
    makeCard(4, 1100, { href: 'https://www.youtube.com/watch?v=id-1' }),
    makeCard(5, 1300),
  ];
  const snap = run(cards);
  assert.deepEqual(snap.items.map((i) => i.videoId), ['id-1', 'id-5'],
    'two Shorts and one duplicate of id-1 are all still dropped below the fold');
});

test('BUG-417 — a card with no resolvable video id is not ranked at all', () => {
  const cards = [makeCard(1, 0), makeCard(2, 900, { href: 'https://example.com/not-youtube' }), makeCard(3, 1100)];
  const snap = run(cards);
  assert.deepEqual(snap.items.map((i) => i.videoId), ['id-1', 'id-3'],
    'an unrankable card must not consume an ordinal — the operator counts what they can see');
});

test('BUG-417 — an entirely off-screen list still ranks, which is what makes scrolling possible', () => {
  // The page is scrolled past the region, or the region has not been reached
  // yet. Before this the list was empty and the controller had nothing to aim
  // at; now every card is named with a null ref and the controller can scroll.
  const cards = [1200, 1400, 1600].map((top, i) => makeCard(i + 1, top));
  const snap = run(cards);
  assert.equal(snap.items.length, 3);
  assert.deepEqual(snap.items.map((i) => i.ref), [null, null, null]);
  assert.equal(snap.ambiguous, false, 'one region is still one region');
});
