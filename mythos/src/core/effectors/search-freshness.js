'use strict';

// search-freshness.js — the freshness vocabulary extracted from web-search.js
// (2026-08-25). The file-size ratchet caught web-search.js growing past its
// recorded ceiling when main's BUG-276-F3 fix landed, and prescribed moving
// code rather than raising the number; this predicate cluster was the cohesive
// piece that belonged together anyway.
//
// Consumers: web-search.js gates the Google News rung on it, attaches
// STALE_SOURCE_CAUTION through succeed() when a fresh-shaped query returns
// undated results, and exempts site:-scoped queries (BUG-276-F3).

// Q1 — WHAT ELSE MATCHES THIS? A word list over the operator's transcribed
// speech, i.e. over input this project has already watched STT mangle into
// "आदिए". It WILL over-match: "the result of the French Revolution" trips it and
// earns a caution it does not need. That asymmetry is deliberate and is the whole
// design — a false positive costs one extra sentence of hedging, a false negative
// costs a fabricated football score written to a note. Re-exported as
// _isTimeSensitive by web-search.js so the list can be argued with in a test
// rather than guessed at.
// `news` and `headlines` were missing from the first version of this list and the
// spec named `news` explicitly. The recency-window test caught it: "Bengal
// panchayat election news" never entered the rung at all, so a plainly
// news-shaped question was answered by an encyclopaedia. They are also the two
// safest possible additions — Correction 6's hazard case ("how to fix a leaking
// tap") contains neither.
var FRESHNESS_MARKERS = /\b(news|headlines|today|tonight|tomorrow|yesterday|now|current|currently|latest|live|recent|breaking|score|scores|result|results|final|standings|who won|price|prices|weather|forecast|this (?:morning|afternoon|evening|week|month|year))\b|\b20[2-9][0-9]\b/i

function isTimeSensitive(query) {
  return FRESHNESS_MARKERS.test(String(query || ''))
}

module.exports = { isTimeSensitive, FRESHNESS_MARKERS };
