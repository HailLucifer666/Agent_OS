'use strict';

// Pure OCR-hit matcher + geometry for see_and_click, extracted from
// from-pc.js (file-size-ratchet ceiling; BUG-349 needed the room).
// Progressively looser so an exact label always beats a coincidental
// substring — "Mou" must not win over "Mousumi" when both are present.

const { normalizeOcrText } = require('./ocr-text-match.js');

function matchRegions(regions, query) {
  // BUG-471: one shared normaliser (dash/quote/whitespace folding, nothing deleted).
  const want = normalizeOcrText(query);
  if (!want) return [];
  const usable = (regions || []).filter((r) =>
    r && typeof r.x === 'number' && typeof r.y === 'number' &&
    r.width > 0 && r.height > 0 && String(r.text || '').trim());
  const norm = (r) => normalizeOcrText(r.text);

  const exact = usable.filter((r) => norm(r) === want);
  if (exact.length) return exact;
  const startsWith = usable.filter((r) => norm(r).startsWith(want));
  if (startsWith.length) return startsWith;
  return usable.filter((r) => norm(r).includes(want));
}

function centreOf(r) {
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}

module.exports = { matchRegions, centreOf };
