'use strict';

// server/routes/engagements.js — W9 god-file decomposition (Phase 2).
// Extracted from server/index.js per the §4.2 factory contract.
// Deps used: engagementManager, auditRest, express (for the .json() body
// parser on the transition route).
//
// Phase-1 caveat: only the 3 engagement routes that exist on main are extracted
// here. Phase 1's engagement-executor branch adds 4 more engagement routes
// (draft/interview/approve/etc.); those become their own follow-up family
// commit when Phase 1 lands. The factory shape here inherits them cleanly.

const express = require('express');

function mountEngagementsRoutes(app, deps) {
  const { engagementManager, auditRest } = deps;

  // ---- /api/engagements — Engagement layer REST surface (Phase 5a wiring).
  // engagementManager/engagementStore may be undefined (boot-degraded or
  // test deps without them) — every route below answers honest JSON rather
  // than throwing, matching the rest of this file's degraded-dependency style.
  app.get('/api/engagements', async (req, res) => {
    try {
      if (!engagementManager) return res.status(503).json({ ok: false, error: 'engagement layer offline' });
      const records = await engagementManager.engagement.list();
      res.json({ ok: true, engagements: records });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // NOTE: unlike the list route above, engagements.js's loadEngagementDetail()
  // and transitionEngagement() both use the response body AS the record
  // directly (`return data`, `state.engagements[idx] = data`) — no {ok,
  // engagement} wrapper. Matching the UI's actual contract, not this file's
  // usual {ok, ...} envelope, since these two routes were derived from the
  // view's own fetch() call sites, not invented fresh.
  app.get('/api/engagements/:id', async (req, res) => {
    try {
      if (!engagementManager) return res.status(503).json({ ok: false, error: 'engagement layer offline' });
      const record = await engagementManager.engagement.findById(req.params.id);
      if (!record) return res.status(404).json({ ok: false, error: 'engagement not found' });
      res.json(record);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/engagements/:id/transition', express.json(), async (req, res) => {
    try {
      if (!engagementManager) return res.status(503).json({ ok: false, error: 'engagement layer offline' });
      const event = req.body && req.body.event;
      if (!event) return res.status(400).json({ ok: false, error: 'event is required' });
      const result = await engagementManager.engagement.transition(req.params.id, event, req.body && req.body.payload);
      res.json(result.record);
      auditRest('rest.engagements.transition', { id: req.params.id, event }, 'ok');
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });
}

module.exports = { mountEngagementsRoutes };
