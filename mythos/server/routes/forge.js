'use strict';

// server/routes/forge.js — W9 god-file decomposition (Phase 2).
// Extracted from server/index.js per the §4.2 factory contract.
// Deps used: forge (the P22 multi-file build pipeline, possibly null).

function mountForgeRoutes(app, deps) {
  const { forge } = deps;

  // ---- P22 — Forge build projects ----
  app.get('/api/forge/projects', (req, res) => { res.json({ projects: forge ? forge.listProjects() : [] }); });
  app.get('/api/forge/projects/:id', (req, res) => {
    if (!forge) return res.status(404).json({ error: 'forge unavailable' });
    const project = forge.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'not found' });
    res.json({ project });
  });
}

module.exports = { mountForgeRoutes };
