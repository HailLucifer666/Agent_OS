'use strict';

// server/routes/goals.js — W9 god-file decomposition (Phase 2 — Wiring Integrity).
// Extracted from server/index.js per the §4.2 factory contract. Byte-for-byte
// identical behavior; only the route registration moved out of the god-file.
//
// Deps used: goalsEffector, auditRest (closure helpers from createServer).

// NOVA goals view renders stats.{total,active,completed,progress} (app/lib/goals.js
// shape), but the P7 goals-effector bridge ships stats() -> {total,done,active}.
// The REST seam translates so the copied view needs zero changes (Ambiguity #1's
// own promise). Translation lives HERE, never inside the effector — the bridge's
// shape is already consumed by from-dashboard.js tools.
function novaGoalsStats(goalsEffector) {
  const s = goalsEffector.stats();
  const completed = s.done || 0;
  const total = s.total || 0;
  return {
    total: total,
    active: s.active || 0,
    completed: completed,
    progress: total === 0 ? 0 : Math.round((completed / total) * 100),
  };
}

function mountGoalsRoutes(app, deps) {
  const { goalsEffector, auditRest } = deps;

  // ---- goals REST — CA, unchanged surface, see Ambiguity #1 ----
  app.get('/api/goals', (req, res) => {
    res.json({ goals: goalsEffector.listGoals(), stats: novaGoalsStats(goalsEffector) });
  });
  app.post('/api/goals', (req, res) => {
    const { text, category } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
    const list = goalsEffector.addGoal(text, category);
    auditRest('rest.goals.add', { text: String(text).slice(0, 80), category }, 'ok');
    res.json({ goals: list, stats: novaGoalsStats(goalsEffector) });
  });
  app.post('/api/goals/:id/toggle', (req, res) => {
    const list = goalsEffector.toggleGoal(req.params.id);
    auditRest('rest.goals.toggle', { id: req.params.id }, 'ok');
    res.json({ goals: list, stats: novaGoalsStats(goalsEffector) });
  });
  app.delete('/api/goals/:id', (req, res) => {
    const list = goalsEffector.deleteGoal(req.params.id);
    auditRest('rest.goals.delete', { id: req.params.id }, 'ok');
    res.json({ goals: list, stats: novaGoalsStats(goalsEffector) });
  });
}

module.exports = { mountGoalsRoutes, novaGoalsStats };
