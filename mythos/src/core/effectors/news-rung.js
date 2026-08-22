'use strict';

// effectors/news-rung.js — the Google News RSS rung of the web-search chain,
// plus the two pieces BUG-315 added to it: a recency window derived from the
// question, and result merging so this rung leads without silencing the chain.
//
// Moved out of web-search.js rather than grown inside it: that file sits at its
// recorded ceiling in test/file-size-ratchet.test.js, and the ratchet is
// one-directional by design.
//
// ---------------------------------------------------------------------------
// BUG-294 — WHY THIS RUNG EXISTS AND WHY IT IS FIRST. We already own this code:
// server/news-feed.js has fetched news.google.com/rss for the HUD news card
// since it shipped, with a PURE parseRss(), an agoLabel(), MAX_ITEMS 12 and an
// 8s timeout that already fits inside this chain's provider budget. Exactly two
// things were missing — the module never sent a QUERY, and the voice path could
// not reach it.
//
// parseRss IS NOT TOUCHED. It already returns everything this rung needs, the
// HUD card depends on it, and leaving it alone keeps that card safe by
// construction rather than by test.
//
// IT USED TO SIT BEHIND THE LOCAL DAEMON, WHICH MADE IT UNREACHABLE FOR EVERY
// QUERY IT EXISTS FOR. Since BUG-288 the daemon autostarts, so a live question
// hit it first, and localWebSearch maps { title, url, snippet } with NO DATE
// FIELD — a non-empty undated answer returned immediately and the news rung
// never ran. commit f34be26 recorded the daemon answering "Mohun Bagan edge past
// East Bengal with a hard-fought win" as proof the freshness fix worked; on
// 2026-08-20 Mohun Bagan played NORTHEAST UNITED, and the two clubs had not met
// at all. An older fixture, undated, accepted as evidence of freshness.
//
// THE HEADLINE IS THE ENTIRE ANSWER, so no article is ever fetched from here.
// Google News RSS hands back an opaque redirector
// (https://news.google.com/rss/articles/CBMiigJBVV95cUxPc3J1…), NOT the
// publisher URL, and news-feed.js's httpGet follows up to 3 redirects — so
// fetching one would walk an attacker-influenced redirect chain, the same shape
// as the two SSRF bypasses recorded in web-fetch.js. The publisher name is
// already in the title suffix, so attribution costs no request at all.
//
// `ago` rides in `snippet` on purpose: it is the freshness signal, and snippet
// is the field both the model and the HUD result card already read.
// ---------------------------------------------------------------------------

var newsFeed = require('../../../server/news-feed');

// THE RECENCY WINDOW. Google ranks by relevance, not recency, and the word
// "today" inside the query text carries no weight with it: the first version of
// this rung answered "Kolkata local news today" with items 85, 52 and 107 days
// old. Measured 2026-08-21 across three real queries — 'when:1d' turned that 85d
// top hit into 1h, while 'when:7d' re-admitted 2-4 day old items into a question
// that said today. But a tight window starves a slower topic ("Bengal panchayat
// election news": 12 items unwindowed, 2 at one day, 5 at seven).
//
// BUG-315: one constant could not serve both, and the constant that shipped
// could not serve the operator either. NEWS_WINDOWS was ['when:1d','when:7d']
// and the loop stops at the first window that ANSWERS — and when:1d essentially
// always answers. So "what AI news happened in the last one week" was
// structurally served with the last 24 hours, every time. The window now comes
// from the question.
var WEEK_RE = /\b(?:this|past|last)\s+week\b|\b(?:7|seven)\s+days\b|\bweekly\b|\bweek\b/i;
var MONTH_RE = /\b(?:this|past|last)\s+month\b|\b30\s+days\b|\bmonthly\b|\bmonth\b/i;
var DAY_WINDOWS = ['when:1d', 'when:7d'];
var WEEK_WINDOWS = ['when:7d'];
var MONTH_WINDOWS = ['when:30d', 'when:7d'];

// Ordered windows to try for a question. Widest-first when the question names a
// span, because a 7-day window is a superset of a 1-day one: asking for the day
// first and stopping on a hit is exactly how a week-shaped question got a
// day-shaped answer.
function newsWindowsFor(query) {
  var q = String(query || '');
  if (MONTH_RE.test(q)) return MONTH_WINDOWS;
  if (WEEK_RE.test(q)) return WEEK_WINDOWS;
  return DAY_WINDOWS;
}

// AND THE WINDOW REPAIRS THE SAFETY PROPERTY RATHER THAN WEAKENING IT. The
// UNWINDOWED endpoint never returns zero, which is the entire reason web-search
// gates this rung on a freshness marker. A windowed one can, and does — so the
// rung is able to have no answer and let the chain continue, instead of always
// producing something plausible for a model that fabricates.
async function newsRssSearch(q, max, traceBus, opts) {
  var o = opts || {};
  var windows = newsWindowsFor(q);
  var items = [];
  for (var w = 0; w < windows.length; w++) {
    var res = await fetch(newsFeed.feedUrl(q + ' ' + windows[w]), {
      signal: AbortSignal.timeout(o.timeoutMs || 10000),
      headers: { 'user-agent': o.userAgent || '' },
    });
    if (!res.ok) {
      traceBus.emit('health.anomaly', {
        kind: 'search-provider-failed', provider: 'google-news-rss', error: 'HTTP ' + res.status,
      });
      return [];
    }
    items = newsFeed.parseRss(await res.text(), Date.now());
    // Stop at the first window that answers: widening after a productive window
    // is a wasted round-trip on the voice path's critical latency.
    if (items.length) break;
  }
  return items.slice(0, max).map(function(item) {
    // agoLabel() returns '' for a missing or unparseable pubDate. For a rung
    // whose ENTIRE safety property is freshness, an item that silently loses its
    // age is the one result the model must not read as current — so a dateless
    // item says so, and `published` stays null, which is what the caution keys
    // on.
    return {
      title: item.title,
      url: item.link,
      published: item.ago || null,
      snippet: item.ago ? 'Published ' + item.ago + '.' : 'Publication date unknown.',
    };
  });
}

function normUrl(u) {
  return String(u || '').trim().toLowerCase().replace(/[#?].*$/, '').replace(/\/+$/, '');
}

function normTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// BUG-315: merge a leading result set with a corroborating one, lead first,
// de-duplicated by URL and by title.
//
// WHY CORROBORATION AND NOT FILTERING. The audit's first proposal was to gate
// this rung on topical relevance — require the RSS titles to share subject terms
// with the query — and measurement killed it. On "global AI news past week" the
// headlines returned were China/Indonesia on a global AI initiative,
// Guterres/India on an AI summit, and India/APAC AI adoption. Every one of them
// IS about AI. They are policy and adoption news rather than the technical
// releases the operator wanted, and no keyword check separates those two. What
// was actually wrong is that a single general-news index, which the file's own
// comment notes never returns zero, got to be the only voice on the subject.
//
// LEAD ORDER IS LOAD-BEARING. The lead is the dated, windowed answer; that
// ordering is the BUG-294 fix. Corroboration is additive and must never demote
// it — an undated fixture must not outrank a result carrying a real age.
function mergeSearchResults(lead, extra, max) {
  var out = [];
  var seenUrl = Object.create(null);
  var seenTitle = Object.create(null);
  var lists = [Array.isArray(lead) ? lead : [], Array.isArray(extra) ? extra : []];
  for (var l = 0; l < lists.length; l++) {
    for (var i = 0; i < lists[l].length; i++) {
      if (out.length >= max) return out;
      var r = lists[l][i];
      if (!r) continue;
      var u = normUrl(r.url);
      var t = normTitle(r.title);
      if (u && seenUrl[u]) continue;
      if (t && seenTitle[t]) continue;
      if (u) seenUrl[u] = true;
      if (t) seenTitle[t] = true;
      out.push(r);
    }
  }
  return out;
}

module.exports = {
  newsRssSearch: newsRssSearch,
  newsWindowsFor: newsWindowsFor,
  mergeSearchResults: mergeSearchResults,
};
