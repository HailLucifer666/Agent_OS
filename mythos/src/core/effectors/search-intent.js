'use strict';

// Search-intent predicates extracted from web-search.js (file-size-ratchet:
// that file sits on a recorded ceiling; BUG-276 F3 needed the room).
// Single source of truth for "does this query enter the Google News rung".

// Freshness marker list, moved verbatim from web-search.js. Exported so the
// list can be argued with in a test rather than guessed at. `news` and
// `headlines` were missing from the first version and the spec named `news`
// explicitly; the recency-window test caught it ("Bengal panchayat election
// news" never entered the rung at all). They are also the two safest possible
// additions - Correction 6's hazard case ("how to fix a leaking tap")
// contains neither.
var FRESHNESS_MARKERS = /\b(news|headlines|today|tonight|tomorrow|yesterday|now|current|currently|latest|live|recent|breaking|score|scores|result|results|final|standings|who won|price|prices|weather|forecast|this (?:morning|afternoon|evening|week|month|year))\b|\b20[2-9][0-9]\b/i

function isTimeSensitive(query) {
  return FRESHNESS_MARKERS.test(String(query || ''))
}

// BUG-276 F3 (2026-08-24): only freshness AND absence of a site: operator
// admits a query to Google News RSS. A site-scoped query has a narrower intent
// than news headlines; RSS ignores site: entirely, which is how open_web's
// "<q> site:youtube.com" got newspaper links with zero youtube.com URLs, and
// repo lookups were answered by newspapers. The scope IS the intent statement;
// the marker list's deliberate over-matching was only ever acceptable for
// queries with no narrower intent. Intentionally narrow: ONLY the site:
// operator exempts a query - every other over-match keeps existing behaviour,
// because there the worst case remains one wasted request plus an honest hedge.
function entersNewsRung(q) {
  return isTimeSensitive(q) && !/\bsite:\S+/i.test(q);
}

module.exports = { isTimeSensitive, entersNewsRung };
