'use strict';

// server/routes/news.js — W9 god-file decomposition (Phase 2 — Wiring Integrity).
// Extracted from server/index.js per the §4.2 factory contract: one function,
// mounts its routes on the passed-in app, pulls only what it needs from deps.
// Behavior is byte-for-byte identical to the inline handler it replaces.
//
// Deps used: none at mount time — the news feed is constructed inside the
// factory (matching the prior inline `const newsFeed = createNewsFeed()`).

const { createNewsFeed } = require('../news-feed');

// Client-facing error text goes through sanitizeRestError: a raw err.message
// here disclosed absolute filesystem paths (ENOENT/EACCES carry them) over HTTP
// while the WS path had been sanitizing the same errors all along. Validation
// messages this route raises itself still pass through unchanged.
const { sanitizeRestError } = require('../sanitize-error');

function mountNewsRoutes(app) {
  // ---- /api/news — Google News RSS fetched server-side for the NEWS widget
  // (browsers can't: CORS on the feed, X-Frame-Options on the site) ----
  const newsFeed = createNewsFeed();
  // BUG-326: ?q=<topic> reaches the feed. It used to be dropped on the floor —
  // fetchNews() took no argument, so a caller asking about one subject was
  // answered with the world's top stories and had no way to tell.
  //
  // SAID PLAINLY: NOTHING SENDS ?q= TODAY. The HUD widget
  // (ui/public/js/widgets/kinds/news.js) calls fetch('/api/news') with no query
  // and has no topic concept, so the population of affected requests before this
  // change was zero — this adds a capability rather than repairing a live
  // failure, and the honest thing is to write that here instead of implying a
  // bug was biting somebody.
  //
  // A topic with no coverage comes back ok:false with an empty list. The
  // general feed is NOT a fallback for it: Google News RSS answers essentially
  // any query plausibly (news-rung.js's header records the unwindowed endpoint
  // never returning zero), so a topical miss silently served the world's
  // headlines would be indistinguishable from a real answer about that topic.
  // The cache is keyed per topic for the same reason.
  app.get('/api/news', (req, res) => {
    newsFeed.fetchNews(req.query && req.query.q)
      .then((r) => res.json(r))
      .catch((err) => res.json({ ok: false, error: sanitizeRestError(err), items: [] }));
  });
}

module.exports = { mountNewsRoutes };
