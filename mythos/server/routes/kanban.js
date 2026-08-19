'use strict';

// Client-facing error text goes through sanitizeRestError: a raw err.message
// here disclosed absolute filesystem paths (ENOENT/EACCES carry them) over HTTP
// while the WS path had been sanitizing the same errors all along. Validation
// messages this route raises itself still pass through unchanged.
const { sanitizeRestError } = require('../sanitize-error');

// server/routes/kanban.js — W9 god-file decomposition (Phase 2).
// Extracted from server/index.js per the §4.2 factory contract.
// Deps used: kanbanEffector, agentActions, auditRest.

function mountKanbanRoutes(app, deps) {
  const { kanbanEffector, agentActions, auditRest } = deps;

  app.get('/api/kanban', (req, res) => { res.json(kanbanEffector.listBoard()); });

  app.post('/api/kanban/cards', (req, res) => {
    const { title, lane } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: 'title required' });
    res.json({ card: kanbanEffector.addCard(title, lane), board: kanbanEffector.listBoard() });
    auditRest('rest.kanban.addCard', { title: String(title).slice(0, 80), lane }, 'ok');
  });
  app.post('/api/kanban/cards/:id/move', (req, res) => {
    try {
      const card = kanbanEffector.moveCard(req.params.id, req.body.lane);
      res.json({ card, board: kanbanEffector.listBoard() });
      auditRest('rest.kanban.moveCard', { id: req.params.id, lane: req.body.lane }, 'ok');
    } catch (err) { res.status(400).json({ error: sanitizeRestError(err) }); }
  });
  app.delete('/api/kanban/cards/:id', (req, res) => {
    kanbanEffector.deleteCard(req.params.id);
    res.json({ board: kanbanEffector.listBoard() });
    auditRest('rest.kanban.deleteCard', { id: req.params.id }, 'ok');
  });

  // ---- kanban agent routes: assemble / build / review / accept + job polling ----
  app.post('/api/kanban/assemble', (req, res) => {
    const { goal } = req.body || {};
    if (!goal || !goal.trim()) return res.status(400).json({ error: 'goal required' });
    try {
      res.json(agentActions.assembleKanbanPlan(goal.trim()));
      auditRest('rest.kanban.assemble', { goal: String(goal).slice(0, 80) }, 'ok');
    } catch (err) { res.status(400).json({ error: sanitizeRestError(err) }); }
  });

  app.post('/api/kanban/cards/:id/build', (req, res) => {
    try {
      res.json(agentActions.buildKanbanCard(req.params.id));
      auditRest('rest.kanban.buildCard', { id: req.params.id }, 'ok');
    } catch (err) { res.status(400).json({ error: sanitizeRestError(err) }); }
  });

  app.post('/api/kanban/cards/:id/review', (req, res) => {
    try {
      res.json(agentActions.reviewKanbanCard(req.params.id));
      auditRest('rest.kanban.reviewCard', { id: req.params.id }, 'ok');
    } catch (err) { res.status(400).json({ error: sanitizeRestError(err) }); }
  });

  app.post('/api/kanban/cards/:id/accept', (req, res) => {
    const lane = (req.body || {}).lane === 'backlog' ? 'backlog' : 'done';
    try {
      kanbanEffector.moveCard(req.params.id, lane);
      kanbanEffector.patchCard(req.params.id, { reviewVerdict: null, reviewNotes: null });
      res.json({ board: kanbanEffector.listBoard() });
      auditRest('rest.kanban.acceptCard', { id: req.params.id, lane }, 'ok');
    } catch (err) { res.status(400).json({ error: sanitizeRestError(err) }); }
  });
}

module.exports = { mountKanbanRoutes };
