'use strict';

// util/youtube-episode.js — does a candidate video actually claim to be the
// episode that was asked for?
//
// BUG-438 (2026-09-11). WHY THIS EXISTS, MEASURED
//
// The operator asked for "INDIA'S GOT LATENT S2 EP6 ft. Rakhi Sawant, Ashneer
// Grover, Kushagra". Twice. Both times open_web opened
// watch?v=c35fpGWqXnk and returned, in its own result payload:
//
//     "title": "INDIA'S GOT LATENT S2 EP2 ft. Harssh Limbachiya, Kiku Sharda, …"
//
// EP6 requested, EP2 opened, different guests — and `outcome:"ok"` on both rows.
// The resolver had the answer in its hand and never compared it. It took the
// search provider's first hit (`from-dashboard.js` used `candidates[0]`) and
// stopped. The honesty machinery fired on the browser TAB it could not see and
// said nothing about the VIDEO it could: the class GATES.md calls "asking the
// cheaper question".
//
// A MODULE, NOT A WIDENING OF from-dashboard.js. That file is 1331 lines against
// a ratchet ceiling of 1418, so headroom is not the binding reason — this is:
// a marker grammar plus a ranker belongs where a test can reach it without
// constructing a dashboard effector. `util/youtube-id.js:36-41` made exactly
// this argument about exactly this host file, and it was right.
//
// ---------------------------------------------------------------------------
// SCOPE, STATED NARROWLY ON PURPOSE
//
// This answers ONE question: do the season/episode markers in a title agree with
// the markers in the query? It is NOT a video-identity check and must never be
// described as one. Agreement does not prove the video plays, does not prove it
// is the right upload, and does not prove the uploader is who the operator
// meant. Two different rips of the same episode both pass.
//
// It is also deliberately INERT for an unmarked query. "GTA 6", "Bleach
// Thousand-Year Blood War", "best laptop 2026" all return early with today's
// ordering, today's selection and today's display-title fallback untouched.
// General video identity is a bigger problem and is not solved here.
//
// WHY NON-EPISODE VOCABULARY FALLS OUT OF THE GRAMMAR RATHER THAN A BLOCKLIST.
// Every pattern requires an s/e/season/episode prefix in front of the digits, so
// bare numbers ("GTA 6"), years ("2026") and resolutions ("1080p", "4K") cannot
// match. Every captured value is `\d`, so Roman numerals ("GTA VI") cannot
// match. The left boundary refuses a letter before the `s`, so "Windows 11" is
// not season 11. Nothing is special-cased. If something HAD to be, that would be
// the sign the grammar was wrong rather than a reason to add a list.
//
// ONE DEPARTURE, PINNED DELIBERATELY: "E3 2026 highlights" parses as episode 3.
// The consequence is a REFUSAL when no result carries E3 — never the wrong video
// returned as though it were right — so the failure mode is honest, and a
// regression test locks it in so a later session widening this grammar has to
// confront it rather than discover it.
// ---------------------------------------------------------------------------

// Unicode word boundaries, written out. `\b` is ASCII-only and would treat the
// 'S' in a non-Latin-adjacent string as a boundary; these do not.
const L = '(?<![\\p{L}\\p{N}_])';
const R = '(?![\\p{L}\\p{N}_])';

// Order matters: COMBINED runs first so "S2E6" is read as one season+episode
// fact rather than as a season that happens to be followed by an episode.
const RE_COMBINED = new RegExp(L + 's\\s?(\\d{1,2})\\s*[.\\-_x ]?\\s*e(?:p|pisode)?\\s*(\\d{1,3})' + R, 'giu');
const RE_SEASON = new RegExp(L + '(?:s(\\d{1,2})|season\\s*#?\\s*(\\d{1,2}))' + R, 'giu');
const RE_EPISODE = new RegExp(L + '(?:e(\\d{1,3})|ep\\s*[.\\-_]?\\s*(\\d{1,3})|epi\\s*(\\d{1,3})|episode\\s*#?\\s*(\\d{1,3}))' + R, 'giu');
const RE_WORD = /[\p{L}\p{N}]+/gu;

// DELIBERATELY ABSENT: a spaced bare `s 2` and a spaced bare `e 6`. A single
// letter, a space and a number is far more often an initial or a list marker
// than a season, and dropping those two forms removes a whole false-positive
// class at the cost of notation nobody actually writes.

// NFKC first, because it does more than tidy quotes: it folds fullwidth digits,
// so "ＥＰ６" becomes "EP6" and matches. Apostrophes are DELETED rather than
// normalised to ASCII, so "INDIA'S" and "INDIA’S" both become "indias" and
// tokenize as ONE word on both sides of the comparison.
function normalizeForMatch(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .replace(/[‘’ʼ＇']/gu, '')
    .toLowerCase()
    .replace(/\s*[-–—|]\s*youtube\s*$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function pushSpan(spans, match) {
  spans.push([match.index, match.index + match[0].length]);
}

// Returns { season:Set<number>, episode:Set<number>, spans:[[start,end],…] }.
// parseInt is what makes E06 === E6 and S02 === S2 — the leading zero is a
// spelling, not a different episode.
function extractMarkers(normalizedText) {
  const text = String(normalizedText == null ? '' : normalizedText);
  const season = new Set();
  const episode = new Set();
  const spans = [];
  let m;
  RE_COMBINED.lastIndex = 0;
  while ((m = RE_COMBINED.exec(text)) !== null) {
    season.add(parseInt(m[1], 10));
    episode.add(parseInt(m[2], 10));
    pushSpan(spans, m);
  }
  const covered = (i) => spans.some(([a, b]) => i >= a && i < b);
  RE_SEASON.lastIndex = 0;
  while ((m = RE_SEASON.exec(text)) !== null) {
    if (covered(m.index)) continue;
    season.add(parseInt(m[1] !== undefined ? m[1] : m[2], 10));
    pushSpan(spans, m);
  }
  RE_EPISODE.lastIndex = 0;
  while ((m = RE_EPISODE.exec(text)) !== null) {
    if (covered(m.index)) continue;
    const raw = [m[1], m[2], m[3], m[4]].find((v) => v !== undefined);
    episode.add(parseInt(raw, 10));
    pushSpan(spans, m);
  }
  return { season, episode, spans };
}

function requestedMarkers(query) {
  const normalized = normalizeForMatch(query);
  const found = extractMarkers(normalized);
  return { season: found.season, episode: found.episode, spans: found.spans, normalized };
}

function hasAnyMarker(markers) {
  return markers.season.size > 0 || markers.episode.size > 0;
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// A title agrees only if, for EVERY requested class, it explicitly carries that
// class AND carries no other value of it. "S2 EP5 & EP6" has episodes {5,6},
// which is not {6}, so it is out — it is a compilation, not the episode.
// Classes that were NOT requested are ignored entirely, which is what lets an
// episode-only query be indifferent to whatever season a title names.
function markersAgree(found, requested) {
  for (const key of ['season', 'episode']) {
    if (requested[key].size === 0) continue;
    if (found[key].size === 0) return false;
    if (!setsEqual(found[key], requested[key])) return false;
  }
  return true;
}

function titleMatchesMarkers(rawTitle, requested) {
  if (typeof rawTitle !== 'string' || !rawTitle.trim()) return false;
  return markersAgree(extractMarkers(normalizeForMatch(rawTitle)), requested);
}

// Distinct word overlap, with the marker spans REMOVED from both sides first so
// that "s2" and "ep6" cannot count as evidence of relevance — they are the thing
// being matched, not context. Single-character tokens are dropped as noise.
function contentWords(normalized, spans) {
  let text = normalized;
  // Blank the spans rather than splice them, so indices stay valid while looping.
  for (const [a, b] of spans) text = text.slice(0, a) + ' '.repeat(b - a) + text.slice(b);
  const out = new Set();
  let m;
  RE_WORD.lastIndex = 0;
  while ((m = RE_WORD.exec(text)) !== null) if (m[0].length > 1) out.add(m[0]);
  return out;
}

function overlapScore(queryWords, rawTitle) {
  const normalized = normalizeForMatch(rawTitle);
  const found = extractMarkers(normalized);
  const titleWords = contentWords(normalized, found.spans);
  let n = 0;
  for (const w of titleWords) if (queryWords.has(w)) n += 1;
  return n;
}

function describeMarkers(requested) {
  const parts = [];
  const seasons = [...requested.season].sort((a, b) => a - b);
  const episodes = [...requested.episode].sort((a, b) => a - b);
  if (seasons.length) parts.push('season ' + seasons.join(' and '));
  if (episodes.length) parts.push('episode ' + episodes.join(' and '));
  return parts.join(', ');
}

// selectEpisodeCandidates(query, candidates) -> { candidates, closest, missing }
//
// `candidates` is the ORDERED ELIGIBLE list every downstream path must consume —
// newtab, the oEmbed probe loop, and the fallback. One list, so the three cannot
// drift apart, which is how the original defect survived: newtab used
// candidates[0] and the embed loop used a different rule.
//
// For an UNMARKED query this returns the input array, same objects, same order,
// and `missing: null`. That single early return is the whole preservation
// guarantee for today's behaviour.
function selectEpisodeCandidates(query, candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const requested = requestedMarkers(query);
  if (!hasAnyMarker(requested)) return { candidates: list, closest: null, missing: null };

  // Deduplicate by video id. Two rows for one id are the same video; the only
  // question is whether they agree about WHICH episode it is. Conflict is
  // defined on MARKER SETS, not on raw strings, deliberately — one of the two
  // titles is often simply truncated, and a display difference is not a
  // contradiction. Where they genuinely disagree the id is dropped entirely
  // rather than resolved by picking whichever came first.
  const byId = new Map();
  const conflicted = new Set();
  list.forEach((cand, index) => {
    const id = cand && cand.id;
    if (!id) return;
    const markers = extractMarkers(normalizeForMatch(cand.rawTitle));
    if (!byId.has(id)) { byId.set(id, { cand, index, markers }); return; }
    const seen = byId.get(id);
    if (!setsEqual(seen.markers.season, markers.season) || !setsEqual(seen.markers.episode, markers.episode)) {
      conflicted.add(id);
    }
  });

  const queryWords = contentWords(requested.normalized, requested.spans);
  const eligible = [];
  const rejected = [];
  for (const [id, entry] of byId) {
    if (conflicted.has(id)) continue;
    const raw = entry.cand.rawTitle;
    // A titleless result is INELIGIBLE, never a pass. It is not evidence of
    // anything, and the display-title fallback would otherwise hand the guard
    // the QUERY back — markers and all — and it would match itself.
    const titled = typeof raw === 'string' && raw.trim().length > 0;
    const record = { entry, score: titled ? overlapScore(queryWords, raw) : -1, titled };
    if (titled && markersAgree(extractMarkers(normalizeForMatch(raw)), requested)) eligible.push(record);
    else rejected.push(record);
  }

  // Overlap is a RANKING signal only, never an eligibility gate — that is the
  // honest reading of "an episode-only query needs no extra word overlap", and
  // it avoids inventing a threshold nobody measured. Ties keep provider order.
  eligible.sort((a, b) => (b.score - a.score) || (a.entry.index - b.entry.index));
  rejected.sort((a, b) => (b.score - a.score) || (a.entry.index - b.entry.index));

  const closestRecord = rejected.find((r) => r.titled) || null;
  return {
    candidates: eligible.map((r) => r.entry.cand),
    closest: closestRecord ? closestRecord.entry.cand.rawTitle : null,
    missing: eligible.length
      ? null
      : {
        season: [...requested.season].sort((a, b) => a - b),
        episode: [...requested.episode].sort((a, b) => a - b),
        phrase: describeMarkers(requested),
      },
  };
}

// The refusal prose lives HERE, not in from-dashboard.js, for two reasons: the
// effector file is content-hashed by remedy-prose-ratchet (which scans only
// src/core/effectors), and this is the module that knows what was missing.
//
// It names a tool nowhere. The failure envelope is fixed at
// { ok:false, result:<reason>, code } — there is no structured place for a
// remedy, and prose that teaches a tool call is the debt BUG-425 froze.
function episodeRefusal(query, selection) {
  const missing = selection && selection.missing;
  const phrase = (missing && missing.phrase) || 'the episode requested';
  const asked = 'I could not find ' + phrase + ' for "' + String(query) + '".';
  const caveat = ' Matching season and episode markers in a title would not prove the video plays, '
    + 'or that it is the right upload — but none of the results claimed to be this episode at all, '
    + 'so I am not going to open one and call it the answer.';
  if (selection && typeof selection.closest === 'string' && selection.closest.trim()) {
    return asked + ' The closest result was "' + selection.closest.trim() + '", which is a different '
      + 'episode.' + caveat;
  }
  return asked + ' None of the results carried a title I could check against the request, so there '
    + 'is nothing to compare and I will not guess.' + caveat;
}

module.exports = {
  normalizeForMatch,
  extractMarkers,
  requestedMarkers,
  hasAnyMarker,
  describeMarkers,
  titleMatchesMarkers,
  selectEpisodeCandidates,
  episodeRefusal,
};
