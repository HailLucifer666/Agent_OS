'use strict';

// server/routes/news.js — W9 god-file decomposition (Phase 2 — Wiring Integrity).
// Extracted from server/index.js per the §4.2 factory contract: one function,
// mounts its routes on the passed-in app, pulls only what it needs from deps.
// Behavior is byte-for-byte identical to the inline handler it replaces.
//
// Deps used: none at mount time — the news feed is constructed inside the
// factory (matching the prior inline `const newsFeed = createNewsFeed()`).

const { createNewsFeed } = require('../news-feed');

function mountNewsRoutes(app) {
  // ---- /api/news — Google News RSS fetched server-side for the NEWS widget
  // (browsers can't: CORS on the feed, X-Frame-Options on the site) ----
  const newsFeed = createNewsFeed();
  app.get('/api/news', (req, res) => {
    newsFeed.fetchNews()
      .then((r) => res.json(r))
      .catch((err) => res.json({ ok: false, error: err.message, items: [] }));
  });
}

module.exports = { mountNewsRoutes };
