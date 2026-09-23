'use strict';
// claim-overlap.js — BUG-448: one action described by two claim categories is
// judged once. Pure; claim-check.js is the only caller. It lives apart from
// claim-check.js because that file sits at the 800-line house limit.
//
// THE INCIDENT, 2026-09-23 13:59:49 (attended run). After a SUCCESSFUL
// launch_app, "Opening a new Notepad window right now." was retracted aloud.
// Two categories matched the same words: `opening` ("Opening … right now",
// backed by launch_app) and `window-control` ("Opening a new Notepad window" —
// "window" means an application window AND a HUD panel, and the category table
// cannot tell them apart). Each was judged alone, so the unbacked one retracted.
//
// THE RULE. Within one sentence, matches whose TEXT OVERLAPS are one action
// described twice. If any of them is backed, the others are excused — except a
// match carrying counter-evidence (its own category's tool failed this turn, or
// it came from the evidence-gated elliptical tier), because that is evidence
// about the very action claimed and a sibling's success must never overrule it.
// Matches that do not overlap are independent claims and stay independent:
// "I launched Notepad, and I closed the news widget" is two. So this is NOT
// "any launch backs any panel" — a sentence that only window-control matches
// is still judged by window-control's own tools alone.

// Spans [start, end) that overlap, transitively, form one group. Touching spans
// do not overlap. Groups come back in order of their first start.
function groupOverlapping(spans) {
  const sorted = spans.slice().sort((a, b) => a.start - b.start);
  const groups = [];
  let group = null;
  let groupEnd = -1;
  for (const span of sorted) {
    if (group && span.start < groupEnd) {
      group.push(span);
      groupEnd = Math.max(groupEnd, span.end);
    } else {
      group = [span];
      groups.push(group);
      groupEnd = span.end;
    }
  }
  return groups;
}

// The hits (each {backed, counterEvidence, start, end, …}) that must be flagged,
// in their original order.
function unexcusedHits(hits) {
  const groupBacked = new Map();
  for (const group of groupOverlapping(hits)) {
    const isBacked = group.some((h) => h.backed);
    for (const h of group) groupBacked.set(h, isBacked);
  }
  return hits.filter((h) => !h.backed && !(groupBacked.get(h) && !h.counterEvidence));
}

module.exports = { groupOverlapping, unexcusedHits };
