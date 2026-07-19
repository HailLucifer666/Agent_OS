'use strict';

// server/routes/checkpoints.js — W9 god-file decomposition (Phase 2).
// Extracted from server/index.js per the §4.2 factory contract.
// Deps used: checkpoints (the P22 checkpoint registry, possibly null).

function mountCheckpointsRoutes(app, deps) {
  const { checkpoints } = deps;

  app.get('/api/checkpoints', (req, res) => {
    res.json({ checkpoints: checkpoints ? checkpoints.list({ status: req.query.status }) : [] });
  });
  app.get('/api/checkpoints/:id', (req, res) => {
    if (!checkpoints) return res.status(404).json({ error: 'checkpoints unavailable' });
    const c = checkpoints.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json({ checkpoint: c });
  });
}

module.exports = { mountCheckpointsRoutes };
