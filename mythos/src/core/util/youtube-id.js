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

const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;

// Null means the search result does not identify a YouTube video.
function youtubeVideoId(url) {
  if (typeof url !== 'string') return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  // Search results are untrusted. Match the actual host and the entire ID;
  // substrings in a redirect query or a longer identifier are not evidence.
  const host = parsed.hostname;
  const short = host === 'youtu.be';
  const youtube = host === 'youtube.com' || host.endsWith('.youtube.com');
  const privacy = host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com');
  if (!short && !youtube && !privacy) return null;
  let id = null;
  if (youtube && /^\/watch\/?$/.test(parsed.pathname)) {
    const values = parsed.searchParams.getAll('v');
    if (values.length === 1) id = values[0];
  } else {
    const pattern = short ? /^\/([^/]+)\/?$/
      : privacy ? /^\/embed\/([^/]+)\/?$/ : /^\/(?:embed|shorts|live|v)\/([^/]+)\/?$/;
    id = pattern.exec(parsed.pathname)?.[1];
  }
  return typeof id === 'string' && VIDEO_ID.test(id) ? id : null;
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
  // Upstream returned playable videos and NONE of them claims to be the thing
  // that was asked for. BUG-438, added 2026-09-11.
  //
  // This is the odd one out and the header above says four codes for a reason:
  // the other four were derived from the 25 logged failures of the 2026-08-27
  // vault read. This fifth one is NOT a fifth cause group in that data — it
  // could not be, because at the time this refusal did not exist and the call
  // that needed it was recorded as `outcome:"ok"`. It is a NEW refusal for a
  // case that used to succeed wrongly, which is a different reason for the
  // count to change, and worth saying out loud so nobody re-derives "five
  // measured causes" from a number that only has four behind it.
  NO_MATCH: 'no-matching-result',
};

const ALL_OPEN_WEB_CODES = Object.freeze(Object.values(OPEN_WEB_CODES));

module.exports = {
  youtubeVideoId,
  OPEN_WEB_CODES,
  ALL_OPEN_WEB_CODES,
};
