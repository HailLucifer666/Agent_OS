'use strict';

// server/routes/config.js — W9 god-file decomposition (Phase 2).
// Extracted from server/index.js per the §4.2 factory contract.
// Deps used: config, memory, goalsEffector, kanbanEffector, pipelineEffector,
// novaGoalsStats (the shared helper exported from routes/goals.js).
//
// Groups the HUD-config surface (/api/config/vad, /api/config/wakeword) with
// the density-snapshot route (/api/stats) — both are read-only GETs feeding
// the dashboard. One mechanical move, no behavior change.

const path = require('path');
const fs = require('fs');
const { novaGoalsStats } = require('./goals');

function mountConfigRoutes(app, deps) {
  const { config, memory, goalsEffector, kanbanEffector, pipelineEffector } = deps;

  // ---- /api/config/vad — BUG-020: voice-loop.js VAD tuning, read once at HUD
  // boot so mic sensitivity can be tuned via env without a client rebuild.
  // Shape matches createVoiceLoop's `vad` option exactly (see voice-loop.js).
  app.get('/api/config/vad', (req, res) => {
    res.json({
      speechRms: config.VAD_SPEECH_RMS,
      minPeakRms: config.VAD_MIN_PEAK_RMS,
      holdTicks: config.VAD_HOLD_TICKS,
      silenceMs: config.VAD_SILENCE_MS,
    });
  });

  // ---- /api/config/wakeword — hands-free "hey jarvis" activation. modelsPresent
  // is a live statSync check (not a cached boot-time flag) so running
  // scripts/setup-wakeword.js and reloading the HUD picks it up without a
  // server restart. Models are CC BY-NC-SA and gitignored — see
  // scripts/setup-wakeword.js and THIRD_PARTY_NOTICES.md.
  app.get('/api/config/wakeword', (req, res) => {
    const dir = path.join(__dirname, '..', '..', 'ui', 'public', 'models', 'wakeword');
    const files = ['melspectrogram.onnx', 'embedding_model.onnx', 'hey_jarvis_v0.1.onnx'];
    const modelsPresent = files.every((f) => {
      try { return fs.statSync(path.join(dir, f)).size > 0; } catch { return false; }
    });
    res.json({ enabled: config.WAKEWORD_ENABLED, threshold: config.WAKEWORD_THRESHOLD, modelsPresent });
  });

  // ---- /api/stats — NEW (P9 HUD density source): one snapshot of how much the
  // entity has lived. Drives the neural map's data-grown node weights. ----
  app.get('/api/stats', (req, res) => {
    try {
      const m = memory.stats();
      const g = novaGoalsStats(goalsEffector);
      const board = kanbanEffector.listBoard();
      const byLane = {};
      (board.cards || []).forEach((c) => { byLane[c.lane] = (byLane[c.lane] || 0) + 1; });
      const pipe = pipelineEffector.listAll();
      const byStage = {};
      let pipeTotal = 0;
      Object.keys(pipe).forEach((stage) => {
        byStage[stage] = (pipe[stage] || []).length;
        pipeTotal += byStage[stage];
      });
      res.json({
        memory: {
          episodic: { count: (m.episodic && m.episodic.count) || 0 },
          semantic: { count: (m.semantic && m.semantic.count) || 0 },
          skills: { count: (m.skills && m.skills.count) || 0 },
          identity: { count: (m.identity && m.identity.count) || 0 },
          audit: { count: (m.audit && m.audit.count) || 0 },
        },
        goals: { total: g.total, active: g.active, completed: g.completed },
        kanban: { total: (board.cards || []).length, byLane },
        pipeline: { total: pipeTotal, byStage },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { mountConfigRoutes };
