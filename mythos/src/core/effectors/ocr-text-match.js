'use strict';

// ocr-text-match.js — the ONE place OCR text is compared with wanted text.
//
// BUG-471 (2026-10-06). Pure, no I/O, on purpose: it is shared by
// see-and-click-match.js (finding the label), see-and-click-settle.js (checking
// `expect`, which click_at also reaches through click-at-evidence.js) and
// ui-target.js (the wording), and it is worth testing without a screen.
//
// Measured cause: screen_look read "Tyga, Ariana Grande – Zoom Zoom" with an en
// dash, the query carried a hyphen, and the matchers only trimmed + lower-cased,
// so every tier missed ("I cannot see ... on screen") seconds after the text had
// been read aloud. Derived set (gate D): every compare of OCR text with wanted
// text in src/ goes through normalizeOcrText — matchRegions' three tiers and
// settleForChange's `expect` include; click_at's own compare IS the settle one.
//
// ATTACK, 2026-10-06 (core.md §11):
//  1. What else matches? OCR text and page titles are untrusted. Folding is
//     limited to characters that are VISUALLY the same mark (the dash family ->
//     "-", curly quotes -> straight, any whitespace run -> one space, invisible
//     zero-width characters dropped). Dashes, quotes and spaces are NEVER
//     deleted, so "A-B" != "AB", "Zoom-Zoom" != "Zoom Zoom", and "Dont" !=
//     "Don't". Stripping punctuation wholesale would merge different titles.
//  2. Hide evidence? No: the callers still report the ORIGINAL text of the
//     matched region; only the comparison key is folded.
//  8. Pinned disposition: "a-b" vs "a - b" (spaces around a dash) are still
//     different. Looser than this would start merging real distinct strings.

const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032\u02BC]/g;
const DOUBLE_QUOTES = /[\u201C-\u201F\u2033]/g;
const INVISIBLES = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;

function normalizeOcrText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(INVISIBLES, '')
    .replace(DASHES, '-')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// An `expect` is checked as LITERAL text on screen. Some callers pass a
// description of the outcome instead ("Video starts playing", "Playing video…")
// — nothing on a screen reads that, so it can never match, and the old wording
// ("did not appear") blamed the screen.
//
// Deliberately narrow, and it only changes WORDING, never the verdict: a
// flagged expect that IS on screen still verifies; one that is not is reported
// as "not checkable" instead of "missing". No confidence value is invented.
// Needs two or more words so a one-word label ("Loading…", "Subscribe") is never
// flagged. Known blind spot: a description with none of these cues is just
// reported as "did not appear", as before.
const OUTCOME_CUE = /\b(starts?|starting|begins?|should|will|appears?)\b/i;
const TRAILING_ELLIPSIS = /(\u2026|\.{3})\s*$/;

function looksLikeOutcomeDescription(expect) {
  const text = String(expect == null ? '' : expect).trim();
  if (!text || text.split(/\s+/).length < 2) return false;
  return TRAILING_ELLIPSIS.test(text) || OUTCOME_CUE.test(text);
}

// Appended to an unverified/unconfirmed reason when `expect` was not found.
function expectMissNote(expect) {
  if (!looksLikeOutcomeDescription(expect)) return '';
  return '. Note: "' + String(expect).trim() + '" reads like a description of what should happen, '
    + 'not text that appears on screen, so it was not checkable; pass words that are literally '
    + 'visible afterwards (a title, a button label), or omit expect';
}

module.exports = { normalizeOcrText, looksLikeOutcomeDescription, expectMissNote };
