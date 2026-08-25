'use strict';

// server/routes/engagements.js — W9 god-file decomposition (Phase 2).
// Extracted from server/index.js per the §4.2 factory contract.
// Deps used: engagementManager, auditRest, sanitizeErrorForClient (closure
// helper from createServer, passed via deps per rule §4.2 #10).
//
// Rebased onto Phase 1: the 4 engagement routes (list/get/transition/create)
// match Phase 1's UI contract exactly (ui/public/js/views/engagements.js):
// list returns a JSON array OR {engagements:[...]}; get returns the record;
// transition body is {event, payload} and returns the updated record; create
// takes {initialIntent, goalId}. All routes degrade to 404 when the manager
// isn't wired rather than crashing.

const { sanitizeRestError } = require('../sanitize-error');

function mountEngagementsRoutes(app, deps) {
  const { engagementManager, auditRest, sanitizeErrorForClient } = deps;
  // The un-injected fallback used to be the RAW err.message — the one path in
  // this file that could disclose an absolute filesystem path to a client. It is
  // now the shared REST policy, so a missing dep degrades to "less specific",
  // never to "leaks more".
  const sanitize = typeof sanitizeErrorForClient === 'function'
    ? sanitizeErrorForClient
    : sanitizeRestError;

  // ---- /api/engagements ---- Engagement Layer (Phase 1)
  app.get('/api/engagements', async (req, res) => {
    if (!engagementManager || !engagementManager.engagement) {
      return res.json({ engagements: [] });
    }
    try {
      const records = await engagementManager.engagement.list();
      res.json(records);
    } catch (err) {
      res.status(500).json({ error: sanitize(err) });
    }
  });
  app.get('/api/engagements/:id', async (req, res) => {
    if (!engagementManager || !engagementManager.engagement) {
      return res.status(404).json({ error: 'engagements unavailable' });
    }
    try {
      const r = await engagementManager.engagement.findById(req.params.id);
      if (!r) return res.status(404).json({ error: 'not found' });
      res.json(r);
    } catch (err) {
      res.status(500).json({ error: sanitize(err) });
    }
  });
  app.post('/api/engagements/:id/transition', async (req, res) => {
    if (!engagementManager || !engagementManager.engagement) {
      return res.status(404).json({ error: 'engagements unavailable' });
    }
    const { event, payload } = req.body || {};
    if (!event) return res.status(400).json({ error: 'event required' });
    try {
      // BUG-343 (found LIVE 2026-08-24): transitioning an id that does not
      // exist threw deep in the manager and surfaced as a sanitized 500
      // ("internal error") — wrong status AND zero information. A missing
      // engagement is a 404, same as the GET above it.
      const existing = await engagementManager.engagement.findById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'not found' });
      const result = await engagementManager.engagement.transition(req.params.id, event, payload);
      res.json(result.record);
      auditRest('rest.engagements.transition', { id: req.params.id, event }, 'ok');
    } catch (err) {
      res.status(400).json({ error: sanitize(err) });
    }
  });
  app.post('/api/engagements', async (req, res) => {
    // Create flow: the UI primarily creates engagements via voice/intent (the
    // conversation gateway), but this route exists for direct API/testing use.
    if (!engagementManager || !engagementManager.engagement) {
      return res.status(404).json({ error: 'engagements unavailable' });
    }
    const { initialIntent, goalId } = req.body || {};
    if (!initialIntent || !String(initialIntent).trim()) {
      return res.status(400).json({ error: 'initialIntent required' });
    }
    try {
      const record = engagementManager.engagement.create({ initialIntent: initialIntent, goalId: goalId });
      res.json(record);
      auditRest('rest.engagements.create', { initialIntent: String(initialIntent).slice(0, 80) }, 'ok');
    } catch (err) {
      res.status(400).json({ error: sanitize(err) });
    }
  });
}

module.exports = { mountEngagementsRoutes };
