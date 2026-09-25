'use strict';

// cut-evidence.js — cut a model-visible text field to a budget without ending it
// mid-sentence, and say when it was cut.
//
// BUG-275, 2026-09-23 (attended run). screen_look's vision description was cut
// at 600 characters with a plain slice before the model saw it, so the text the
// model narrated from ended "…verifying that the Brave browser and expected side
// effects" — half a fact, which a language model completes from imagination. The
// vault stores exactly what the model saw (the whole result, OCR lines included),
// so the audit trail held the same half. Measured from the 09-23 Episodic row.
//
// THE RULE. Under the budget, the text is untouched. Over it, cut at the last
// sentence end that fits — unless that keeps under half the budget, which would
// throw away more evidence than a mid-sentence cut; then cut at the last word
// boundary and mark the cut with an ellipsis. Either way `truncated` is true, so
// the caller can tell the model it holds part of the text, not all of it.
//
// Reuses effectors/voice.js's truncateAtSentenceBoundary (the TTS path's cutter)
// rather than a second copy of the boundary rule.

const { truncateAtSentenceBoundary } = require('../effectors/voice');

const ELLIPSIS = ' …';

function cutEvidence(text, maxChars) {
  const s = String(text == null ? '' : text).trim();
  if (s.length <= maxChars) return { text: s, truncated: false, fullChars: s.length };
  const atSentence = truncateAtSentenceBoundary(s, maxChars);
  if (atSentence.length >= maxChars / 2 && /[.!?]$/.test(atSentence)) {
    return { text: atSentence, truncated: true, fullChars: s.length };
  }
  const room = s.slice(0, maxChars - ELLIPSIS.length);
  const space = room.lastIndexOf(' ');
  return { text: (space > 0 ? room.slice(0, space) : room).trim() + ELLIPSIS, truncated: true, fullChars: s.length };
}

module.exports = { cutEvidence };
