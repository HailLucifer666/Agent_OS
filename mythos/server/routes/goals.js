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
  // A `degraded` flag on the returned list means the Goals.md bridge map could
  // not be read, so the mutation did NOT reach disk. Auditing those as 'ok' and
  // answering 200 recorded completed operations that never happened (AD-4), so
  // they now audit 'degraded' and answer 503 with the real reason.
  function respondGoals(res, list, auditName, auditArgs) {
    if (list && list.degraded) {
      auditRest(auditName, auditArgs, 'degraded');
      return res.status(503).json({
        error: 'goals bridge map unreadable — nothing was changed',
        goals: list,
        stats: novaGoalsStats(goalsEffector)
      });
    }
    auditRest(auditName, auditArgs, 'ok');
    return res.json({ goals: list, stats: novaGoalsStats(goalsEffector) });
  }

  app.post('/api/goals', (req, res) => {
    const { text, category } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
    const list = goalsEffector.addGoal(text, category);
    respondGoals(res, list, 'rest.goals.add', { text: String(text).slice(0, 80), category });
  });
  app.post('/api/goals/:id/toggle', (req, res) => {
    const list = goalsEffector.toggleGoal(req.params.id);
    respondGoals(res, list, 'rest.goals.toggle', { id: req.params.id });
  });
  app.delete('/api/goals/:id', (req, res) => {
    const list = goalsEffector.deleteGoal(req.params.id);
    respondGoals(res, list, 'rest.goals.delete', { id: req.params.id });
  });

  // ---- V5 (Phase 4) — proposed-goal queue (one-tap accept/reject) ----
  // The cortex (mull) creates status:'proposed' goals via the propose_goal
  // effector; these routes let the operator accept (→ active + Goals.md) or
  // reject (→ deleted) from the dashboard. Mirrors the W4 audit pattern.
  app.get('/api/goals/proposals', (req, res) => {
    res.json({ proposals: goalsEffector.listProposals() });
  });
  app.post('/api/goals/:id/accept', (req, res) => {
    const proposals = goalsEffector.acceptProposal(req.params.id);
    auditRest('rest.goals.accept', { id: req.params.id }, 'ok');
    res.json({ proposals: proposals, stats: novaGoalsStats(goalsEffector) });
  });
  app.post('/api/goals/:id/reject', (req, res) => {
    const proposals = goalsEffector.rejectProposal(req.params.id);
    auditRest('rest.goals.reject', { id: req.params.id }, 'ok');
    res.json({ proposals: proposals });
  });
}

module.exports = { mountGoalsRoutes, novaGoalsStats };
