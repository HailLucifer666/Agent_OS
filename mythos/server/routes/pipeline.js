'use strict';

// Client-facing error text goes through sanitizeRestError: a raw err.message
// here disclosed absolute filesystem paths (ENOENT/EACCES carry them) over HTTP
// while the WS path had been sanitizing the same errors all along. Validation
// messages this route raises itself still pass through unchanged.
const { sanitizeRestError } = require('../sanitize-error');

// server/routes/pipeline.js — W9 god-file decomposition (Phase 2).
// Extracted from server/index.js per the §4.2 factory contract.
// Deps used: pipelineEffector, buildRunner, agentActions, auditRest.
// Note: /api/jobs/:id lives here (adjacent in the source + conceptually the
// pipeline's job-polling surface — build jobs originate from kanban/assemble
// and pipeline/ship). One mechanical move, no behavior change.

function mountPipelineRoutes(app, deps) {
  const { pipelineEffector, buildRunner, agentActions, auditRest } = deps;

  app.get('/api/jobs/:id', (req, res) => {
    const job = buildRunner && buildRunner.getJob ? buildRunner.getJob(req.params.id) : null;
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json({ job });
  });

  app.get('/api/pipeline', (req, res) => { res.json(pipelineEffector.listAll()); });
  app.post('/api/pipeline/capture', (req, res) => {
    const { text } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
    res.json({ card: pipelineEffector.capture(text), board: pipelineEffector.listAll() });
    auditRest('rest.pipeline.capture', { text: String(text).slice(0, 80) }, 'ok');
  });
  app.post('/api/pipeline/:id/execute', (req, res) => {
    if (!agentActions || typeof agentActions.executePipelineCard !== 'function') {
      return res.status(503).json({ error: 'pipeline execution unavailable' });
    }
    try {
      const goalId = req.body && req.body.goalId;
      res.json(agentActions.executePipelineCard(req.params.id, goalId));
    } catch (err) {
      res.status(400).json({ error: sanitizeRestError(err) });
      return;
    }
    auditRest('rest.pipeline.execute', { id: req.params.id }, 'ok');
  });
  app.post('/api/pipeline/:id/shape', (req, res) => {
    const found = pipelineEffector.findCard(req.params.id);
    if (!found) return res.status(404).json({ error: 'card not found' });
    try {
      const card = pipelineEffector.moveCard(req.params.id, found.stage, { shaped: true });
      res.json({ card, board: pipelineEffector.listAll() });
    } catch (err) {
      res.status(400).json({ error: sanitizeRestError(err) });
      return;
    }
    auditRest('rest.pipeline.shape', { id: req.params.id }, 'ok');
  });
  app.post('/api/pipeline/:id/approve', (req, res) => {
    try { res.json({ card: pipelineEffector.approve(req.params.id), board: pipelineEffector.listAll() }); }
    catch (err) { res.status(400).json({ error: sanitizeRestError(err) }); return; }
    auditRest('rest.pipeline.approve', { id: req.params.id }, 'ok');
  });
  app.post('/api/pipeline/:id/reject', (req, res) => {
    try { pipelineEffector.reject(req.params.id); res.json({ board: pipelineEffector.listAll() }); }
    catch (err) { res.status(400).json({ error: sanitizeRestError(err) }); return; }
    auditRest('rest.pipeline.reject', { id: req.params.id }, 'ok');
  });
  app.post('/api/pipeline/:id/delete', (req, res) => {
    try { pipelineEffector.reject(req.params.id); res.json({ board: pipelineEffector.listAll() }); }
    catch (err) { res.status(400).json({ error: sanitizeRestError(err) }); return; }
    auditRest('rest.pipeline.delete', { id: req.params.id }, 'ok');
  });
  app.post('/api/pipeline/:id/ship', (req, res) => {
    try { res.json({ card: pipelineEffector.ship(req.params.id), board: pipelineEffector.listAll() }); }
    catch (err) { res.status(400).json({ error: sanitizeRestError(err) }); return; }
    auditRest('rest.pipeline.ship', { id: req.params.id }, 'ok');
  });
}

module.exports = { mountPipelineRoutes };
