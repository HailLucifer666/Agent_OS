'use strict';

// test/widget-auto-layout.test.js — BUG-176.
//
// The HUD's widget positions used to be literal px offsets typed into
// widget-registry.js, and a test asserted the visible ones "clear each other
// vertically" by comparing those declared offsets. That assertion could not
// work: .widget-card is min-width:170px but CONTENT-sized above it, so real
// cards render 64-413px tall and 170-640px wide, and the news card's height
// moves with its headline count. The offsets looked evenly spaced in source
// and the cards overlapped in the browser.
//
// auto-layout.js measures first and places second. Splitting the pure packing
// math out from the DOM measurement is what makes the overlap rule assertable
// at all — the previous design was untestable by construction, which is why it
// shipped broken twice.
//
// The DOM half (measureCards + the requestAnimationFrame pass in
// widget-host.js) is verified in a real browser, not here.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let layout;
before(async () => {
  layout = await import(pathToFileURL(
    path.join(__dirname, '..', 'ui', 'public', 'js', 'widgets', 'auto-layout.js')
  ).href);
});

// Rectangles as the browser would see them, given a packed position.
function boxes(cards, positions) {
  return cards.map((c) => {
    const p = positions[c.id];
    return { id: c.id, column: c.column, top: p.top, bottom: p.top + c.height };
  });
}

function overlappingPairs(rects) {
  const bad = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (a.column !== b.column) continue; // different gutters never collide
      if (a.top < b.bottom && b.top < a.bottom) bad.push(`${a.id} x ${b.id}`);
    }
  }
  return bad;
}

describe('BUG-176 — packColumns stacks a gutter without overlap', () => {
  it('cards in the same column never overlap, at the real measured sizes', () => {
    // These are MEASURED heights, read out of a real browser at 1920x1080
    // after the fix — not estimates. The first version of this test used
    // plausible-looking guesses, and they were wrong enough to hide a genuine
    // overflow: the estimate for SYSTEM was 420 and it rendered 679 until its
    // body was bounded. If these numbers ever need changing, re-measure; do not
    // adjust them to make the assertion pass.
    const cards = [
      { id: 'system', column: 'left', height: 365 },
      { id: 'tokens', column: 'left', height: 222 },
      { id: 'agents', column: 'left', height: 64 },
      { id: 'voice', column: 'left', height: 157 },
      { id: 'wip', column: 'left', height: 139 },
      { id: 'clock', column: 'right', height: 97 },
      { id: 'weather', column: 'right', height: 116 },
      { id: 'media', column: 'right', height: 339 },
      { id: 'news', column: 'right', height: 398 },
    ];
    const pos = layout.packColumns(cards, { viewportHeight: 1080 });
    const bad = overlappingPairs(boxes(cards, pos));
    assert.deepEqual(bad, [], 'overlaps: ' + bad.join('; '));
  });

  it('leaves a real gap between stacked cards rather than butting them together', () => {
    const cards = [
      { id: 'a', column: 'left', height: 100 },
      { id: 'b', column: 'left', height: 100 },
    ];
    const pos = layout.packColumns(cards, { viewportHeight: 1080 });
    assert.equal(pos.b.top - (pos.a.top + 100), layout.GAP);
  });

  it('anchors each column to its own edge, so the two gutters are independent', () => {
    const pos = layout.packColumns([
      { id: 'l', column: 'left', height: 100 },
      { id: 'r', column: 'right', height: 100 },
    ], { viewportHeight: 1080 });
    assert.equal(pos.l.left, layout.EDGE_INSET);
    assert.equal(pos.l.right, undefined, 'a left card must not also set right');
    assert.equal(pos.r.right, layout.EDGE_INSET);
    assert.equal(pos.r.left, undefined);
    assert.equal(pos.l.top, pos.r.top, 'each column starts at the top margin independently');
  });

  it('an unknown column falls to the left gutter rather than vanishing', () => {
    const pos = layout.packColumns([{ id: 'x', column: 'middle', height: 50 }], { viewportHeight: 1080 });
    assert.equal(pos.x.left, layout.EDGE_INSET);
  });

  it('clamps a card that would run off the bottom instead of placing it off-screen', () => {
    // Overflow policy: clamp. Not spill (which would make a card's SIDE depend
    // on runtime measurement — the nondeterminism the explicit column hint
    // exists to prevent) and not shrink-the-gaps (worst cramping exactly when
    // there are most cards). A clamped card overlaps visibly and is fixed
    // forever by one drag.
    const cards = [
      { id: 'tall', column: 'left', height: 900 },
      { id: 'next', column: 'left', height: 400 },
    ];
    const pos = layout.packColumns(cards, { viewportHeight: 1000 });
    assert.equal(pos.next.top + 400, 1000 - layout.BOTTOM_MARGIN, 'clamped to the bottom margin');
    assert.ok(pos.next.top >= layout.TOP_MARGIN, 'never clamped above the top margin');
  });

  it('never clamps a card above the top margin, even in an absurdly short viewport', () => {
    const pos = layout.packColumns([{ id: 'a', column: 'left', height: 800 }], { viewportHeight: 200 });
    assert.equal(pos.a.top, layout.TOP_MARGIN);
  });

  it('is deterministic — the same input packs identically every time', () => {
    const cards = [
      { id: 'a', column: 'left', height: 120 },
      { id: 'b', column: 'right', height: 300 },
      { id: 'c', column: 'left', height: 90 },
    ];
    const first = layout.packColumns(cards, { viewportHeight: 1080 });
    const second = layout.packColumns(cards, { viewportHeight: 1080 });
    assert.deepEqual(first, second);
  });

  it('places only what it is given — a card with a stored position is simply absent from the input', () => {
    // widget-host.js filters those out before calling; this pins that the
    // packer itself has no opinion about them and cannot resurrect one.
    const pos = layout.packColumns([{ id: 'a', column: 'left', height: 100 }], { viewportHeight: 1080 });
    assert.deepEqual(Object.keys(pos), ['a']);
  });

  it('tolerates an empty or malformed list rather than throwing into the boot path', () => {
    assert.deepEqual(layout.packColumns([], {}), {});
    assert.deepEqual(layout.packColumns(null, {}), {});
    assert.deepEqual(layout.packColumns([null, { column: 'left' }], {}), {}, 'entries with no id are skipped');
  });

  it('treats a missing height as zero rather than NaN-poisoning every later card', () => {
    const pos = layout.packColumns([
      { id: 'a', column: 'left' },
      { id: 'b', column: 'left', height: 100 },
    ], { viewportHeight: 1080 });
    assert.equal(pos.a.top, layout.TOP_MARGIN);
    assert.equal(pos.b.top, layout.TOP_MARGIN + layout.GAP);
  });
});
