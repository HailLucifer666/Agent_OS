'use strict';

// server/routes/setup.js — GET /api/setup/status.
//
// The HUD cannot read process.env, so without this route the desktop setup
// screen would have to ask the operator which keys they had set — which is the
// question they came to the screen to have answered. This reports it from the
// one place that already knows how to work it out: scripts/doctor.js.
//
// AD-8 holds across this boundary. doctor.js reports key NAMES and booleans and
// never a value, and test/setup-route.test.js pins that a planted canary value
// cannot appear in this response. That is the whole security argument for
// exposing it to the renderer at all.
//
// Behind the same auth as every other /api route: with MYTHOS_AUTH_TOKEN set,
// an unauthenticated caller gets 401 here like anywhere else, so "which keys is
// this machine missing" is not public. On a default loopback install it is as
// open as the rest of /api, deliberately and consistently.

const path = require('path');

function mountSetupRoutes(app, deps) {
  // Injected in tests so a case can describe a machine other than this one.
  // Production passes nothing and gets the real report.
  const buildReport = (deps && deps.buildReport)
    || require(path.join(__dirname, '..', '..', 'scripts', 'doctor.js')).buildReport;

  app.get('/api/setup/status', (req, res) => {
    let report;
    try {
      report = buildReport();
    } catch (err) {
      // A report that cannot be built is a server condition, not a verdict about
      // the install. Answering 200 with "no gaps" would be a lie in the safest-
      // looking direction; the client treats a non-200 as indeterminate and
      // paints nothing.
      return res.status(500).json({ error: 'setup report failed: ' + err.message });
    }

    // Explicit projection rather than passing `report` through. A future field
    // added to doctor's report (a path, a hostname, one day a value) then has to
    // be added here on purpose to reach the renderer, instead of arriving by
    // accident the moment doctor grows.
    const project = (row) => ({
      id: row.id,
      label: row.label,
      required: row.required === true,
      ok: row.ok === true,
      detail: row.detail || null,
      why: row.why,
      fix: row.fix,
    });

    res.json({
      needsSetup: report.requiredGaps.length > 0,
      keys: report.keys.map(project),
      assets: report.assets.map(project),
      // Names only, and only so the screen can say "already stored on this
      // machine" next to a key the operator set through a previous run.
      keyStoreNames: (report.keyStore && report.keyStore.names) || [],
    });
  });
}

module.exports = { mountSetupRoutes };
