// auto-layout.js — computes the STARTING position of every widget card.
//
// BUG-176. Until now every defaultPos was a literal px offset typed into
// widget-registry.js, and that could not be made correct: .widget-card is
// min-width:170px but CONTENT-sized above that, so real cards render anywhere
// from 64px to 413px tall and 170px to 640px wide, and their height depends on
// live data (the news card grows with headline count). A previous attempt
// shipped a table of offsets that looked evenly spaced in the source and
// overlapped badly in a browser — the test asserting they "clear each other
// vertically" was comparing declared offsets, which say nothing about rendered
// size. Measure, then place.
//
// WHAT THIS DELIBERATELY DOES NOT DO:
//  - It never runs for a card the user has already dragged. A stored position
//    always wins, exactly as before.
//  - It never writes its result to localStorage. If it did, the first computed
//    layout would be indistinguishable from a deliberate user drag, and every
//    future adjustment to this file would be silently overridden for everyone
//    who had ever loaded the HUD.
//  - It does not re-flow on resize, or when a card is opened/closed at runtime.
//    Re-flowing moves cards the operator did not touch, which is exactly the
//    surprise a "starting layout" is supposed to avoid.

export const EDGE_INSET = 24; // px from the viewport's left/right edge
export const TOP_MARGIN = 24; // px above the first card in a column
export const GAP = 24;        // px between stacked cards
export const BOTTOM_MARGIN = 24;

// packColumns(cards, opts) -> { [id]: {left|right, top} }
//
// `cards` is [{ id, column: 'left'|'right', width, height }] in the order they
// should stack, already filtered to the ones that need placing (visible, and
// with no stored position). `opts.viewportHeight` bounds the clamp below.
//
// Pure and deterministic: same input, same output. No DOM, no globals — which
// is what makes the overlap rule testable at all, since the thing that broke
// last time was untestable by construction.
export function packColumns(cards, opts) {
  const o = opts || {};
  const viewportHeight = Number.isFinite(o.viewportHeight) ? o.viewportHeight : 1080;
  const inset = Number.isFinite(o.edgeInset) ? o.edgeInset : EDGE_INSET;
  const gap = Number.isFinite(o.gap) ? o.gap : GAP;
  const top0 = Number.isFinite(o.topMargin) ? o.topMargin : TOP_MARGIN;
  const bottom = Number.isFinite(o.bottomMargin) ? o.bottomMargin : BOTTOM_MARGIN;

  const out = {};
  const nextTop = { left: top0, right: top0 };

  for (const card of cards || []) {
    if (!card || !card.id) continue;
    const column = card.column === 'right' ? 'right' : 'left';
    const height = Number.isFinite(card.height) ? card.height : 0;

    let top = nextTop[column];

    // Overflow: CLAMP, do not spill into the other column and do not shrink the
    // gaps. Spilling would make a card's side depend on runtime measurement —
    // the exact nondeterminism the explicit column hint exists to remove — and
    // shrinking gaps produces its worst cramping in the case (many cards) where
    // legibility matters most. A clamped card overlaps its predecessor, which is
    // visible, rare, and fixed forever by one drag.
    const maxTop = viewportHeight - height - bottom;
    if (top > maxTop) top = Math.max(top0, maxTop);

    out[card.id] = column === 'left' ? { left: inset, top } : { right: inset, top };
    nextTop[column] = top + height + gap;
  }

  return out;
}

// measureCards(entries) -> the shape packColumns wants, read from the live DOM.
// Split out so packColumns itself stays pure and node-testable; this half is
// the part that genuinely needs a browser.
export function measureCards(entries) {
  return (entries || []).map(function (e) {
    const rect = e.el.getBoundingClientRect();
    return { id: e.id, column: e.column, width: Math.round(rect.width), height: Math.round(rect.height) };
  });
}
