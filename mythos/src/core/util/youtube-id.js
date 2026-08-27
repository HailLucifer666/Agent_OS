'use strict';

// util/youtube-id.js — pull the 11-character video id out of any YouTube URL,
// and the typed reason codes open_web reports alongside its prose.
//
// BUG-381 (2026-08-27). WHY THIS EXISTS, MEASURED
//
// Track D-4 named `open_web (widget)` and `YouTube embed` as sharing one cause.
// Measured against the operator's live vault first: 160 completed open_web calls,
// 135 ok, 25 fail (the map said 131/19 — stale, and it UNDER-counted failures),
// with 17 distinct failure strings rather than the twelve the work order
// expected. Grouped by actual cause:
//
//   9   a correct refusal of a malformed call (no url, no type, no query)
//   10  upstream genuinely returned nothing for the query
//   3   "Found results but could not extract a YouTube video ID"   <-- D-4's cause
//   3   a provider fetch failure (weather)
//
// So the named cause is the SMALLEST of four. It is still real, and the regex it
// lived in was the reason: it recognised four URL shapes and missed five.
// Measured against the shapes YouTube actually serves:
//
//   MATCH  youtube.com/watch?v=ID          MISS  youtube.com/live/ID
//   MATCH  youtu.be/ID                     MISS  youtube.com/watch?app=desktop&v=ID
//   MATCH  youtube.com/shorts/ID           MISS  youtube.com/watch?feature=share&v=ID
//   MATCH  m.youtube.com/watch?v=ID        MISS  youtube-nocookie.com/embed/ID
//                                          MISS  youtube.com/v/ID
//
// Two of those misses explain the logged failures directly. `/live/` is what a
// news livestream resolves to, and the failing queries included "CNN live news",
// "CNN news dashboard" and "today's news". And `watch?v=` required `v` to be the
// FIRST query parameter, so any URL carrying `app=desktop` or `feature=share`
// ahead of it — which is what a share sheet or a mobile redirect produces — was
// unreadable.
//
// A MODULE RATHER THAN A WIDER REGEX IN PLACE: from-dashboard.js is 1417 lines
// against a file-size ratchet ceiling of 1418, so there was exactly one line of
// headroom. The ratchet was right again — a parser with nine cases belongs
// somewhere a test can reach it without constructing a dashboard effector.

// Ordered longest-prefix-first so `/embed/` cannot be shadowed by a looser arm.
// Each entry is (why it exists) -> pattern.
const ID = '([a-zA-Z0-9_-]{11})';

const PATH_FORMS = [
  // youtu.be/ID — the share-sheet short form.
  new RegExp('youtu\\.be/' + ID),
  // /embed/ID — including youtube-nocookie.com, which is what a privacy-mode
  // embed serves and which the old pattern did not know about.
  new RegExp('youtube(?:-nocookie)?\\.com/embed/' + ID),
  // /shorts/ID
  new RegExp('youtube\\.com/shorts/' + ID),
  // /live/ID — a livestream. This is the miss that produced the logged failures:
  // a news channel's "live" result is served from this path, never from /watch.
  new RegExp('youtube\\.com/live/' + ID),
  // /v/ID — the legacy embed path. Still served by old links.
  new RegExp('youtube\\.com/v/' + ID),
];

// `v` ANYWHERE in the query string, not only immediately after `watch?`. A share
// link is routinely `watch?app=desktop&v=ID` or `watch?feature=share&v=ID`.
const QUERY_V = new RegExp('[?&]v=' + ID);

// Returns the 11-char id, or null. Null means "this is not a YouTube video URL",
// which is a different fact from "the search found nothing" — open_web reports
// them with different codes for exactly that reason.
function youtubeVideoId(url) {
  const text = String(url == null ? '' : url);
  if (!text) return null;
  // The host has to look like YouTube before any path arm is trusted, so an
  // unrelated URL that happens to contain `/live/<11 chars>` is not mistaken for
  // a video. Checked on the raw text rather than by parsing, because callers pass
  // search-result URLs that may be relative or malformed.
  const looksLikeYouTube = /(?:^|\/\/|\.)(?:youtu\.be|(?:[a-z0-9-]+\.)?youtube(?:-nocookie)?\.com)/i.test(text);
  if (!looksLikeYouTube) return null;
  for (const re of PATH_FORMS) {
    const m = re.exec(text);
    if (m) return m[1];
  }
  const q = QUERY_V.exec(text);
  return q ? q[1] : null;
}

// ---------------------------------------------------------------------------
// TYPED REASON CODES.
//
// The other half of D-4: "twelve ways of saying no is twelve things a caller
// cannot branch on" — measured as seventeen. The prose stays exactly as it is,
// because it is good prose and the voice layer speaks it; what is added is a
// machine-readable code beside it, so a caller can tell "you called me wrong"
// from "the world had nothing" from "I could not parse what the world returned".
//
// Four codes, derived from the four measured cause groups above rather than
// invented. Deliberately coarse: a caller branches on what it can DO about a
// failure, and these are the four different things to do.
const OPEN_WEB_CODES = {
  // The call itself was malformed — a missing url, type or query. The model can
  // fix this by calling again correctly. 9 of the 25 logged failures.
  BAD_REQUEST: 'bad-request',
  // Upstream answered, and had nothing. Retrying the same query will not help;
  // rephrasing or a different tool might. 10 of 25.
  NO_RESULTS: 'no-results',
  // Upstream had results but none of them was a playable video. This is the one
  // D-4 named, and the one this module's parser widening addresses. 3 of 25.
  UNPLAYABLE: 'unplayable-results',
  // A provider failed — network, fetch, upstream error. Transient; a retry is
  // reasonable. 3 of 25.
  PROVIDER_ERROR: 'provider-error',
};

const ALL_OPEN_WEB_CODES = Object.freeze(Object.values(OPEN_WEB_CODES));

module.exports = {
  youtubeVideoId,
  OPEN_WEB_CODES,
  ALL_OPEN_WEB_CODES,
};
