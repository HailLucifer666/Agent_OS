'use strict';

// server/index.js — RW from app/server.js (1533 lines) per §14. Reuses: 127.0.0.1
// bind, CORS allowlist pattern, verifyWsClient, broadcastAll, graceful-shutdown drain.
// Everything NOVA had that isn't in the Migration Map (builds.js, radar/, video-render/,
// free-claude/, game/music/video/thumbnail studios, voice s2s/pc/browser child processes)
// is intentionally NOT ported — those stay in archive/nova/ per §16 "LEAVE in NOVA".

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createLimiter } = require('./rate-limit');
const edgeTts = require('../providers/edge-tts');
const groqStt = require('../providers/groq-stt');
const { splitSentences, createSentenceStreamer } = require('../src/core/effectors/voice');
const { sanitizeSpoken } = require('../src/core/voice/spoken-text');
const { createVoiceAgent } = require('../src/core/voice/voice-agent');
const { createConversationAnnouncer } = require('../src/core/conversation/announcer');
const spend = require('../src/core/brain/spend');
const { dispatchAction: sharedDispatch } = require('../src/core/effectors/dispatch-action');
const { createNewsFeed } = require('./news-feed');

// WS v2 message types — exact strings, do not paraphrase:
// IN (reqId):  'utterance', 'command', 'confirm-reply', 'subscribe', 'stop', 'vision-query'
// OUT (broadcast): 'entity-state', 'tick', 'goal-update', 'perception', 'action',
//                  'health', 'audit', 'confirm-request', 'brain-spend', 'log', 'job', 'mission'
//                  'proactive-speech' (entity-initiated, no inbound utterance)
// OUT (per-reqId reply stream): 'speech-chunk' (0..N) then 'done' (1, metadata only)

function isLoopback(req) {
  const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
  return LOOPBACK.has(ip);
}

function createServer(deps) {
  const bus = deps.bus;
  const config = deps.config;
  const logger = deps.logger;
  const memory = deps.memory;
  const goalsEffector = deps.goalsEffector;     // P7 effectors/goals.js — Goals.md surface
  const kanbanEffector = deps.kanbanEffector;    // P7 effectors/kanban.js
  const pipelineEffector = deps.pipelineEffector; // P7 effectors/pipeline.js
  const effectors = deps.effectors;              // hub — .invoke, .breakers, .effectors
  const leash = deps.leash;                      // P5 — .check, .confirm.{create,accept,reject}
  const goals = deps.goals;                       // cognitive GoalSystem — .debitBudget
  const probes = deps.probes;                     // P6 immune/probes.js — .getStatus()
  const brain = deps.brain;                       // P2 brain — .think({lane, messages, ...})
  const buildRunner = deps.buildRunner;           // P7 build-runner — .onJobUpdate (job WS relay)
  const agentActions = deps.agentActions;         // P7 agent-actions — assemble/build/review kanban agents
  const checkpoints = deps.checkpoints;           // P22 checkpoint approval registry (may be undefined in tests)
  const forge = deps.forge;                       // P22 Forge build pipeline (may be undefined in tests)

  // Server-initiated camera look: broadcast a frame request; any connected UI
  // with the camera actively watching answers with one JPEG frame. 8s timeout.
  const pendingFrames = new Map(); // frameReqId -> { resolve, timer }
  function requestCameraFrame() {
    return new Promise(function(resolve) {
      const id = 'frame-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
      const timer = setTimeout(function() { pendingFrames.delete(id); resolve(null); }, 8000);
      pendingFrames.set(id, { resolve: resolve, timer: timer });
      broadcastAll({ type: 'camera-frame-request', frameReqId: id });
    });
  }

  const PORT = config.MYTHOS_PORT;
  const BIND = config.MYTHOS_BIND;

  // ALLOWED_ORIGINS mirrors NOVA exactly: comma-sep env passthrough, NOT schema-ized —
  // matches NOVA's own precedent of leaving this outside the coerced-type config.
  // A5 FIX: validate env-sourced origins to prevent injection of malicious origins.
  function isValidOrigin(o) { return /^https?:\/\/[a-zA-Z0-9._-]+(:\d+)?$/.test(o); }
  const ALLOWED_ORIGINS = new Set([
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    ...(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean).filter(isValidOrigin),
  ]);

  // A4 FIX: sanitize error messages before sending to WS clients.
  // Prevents leaking internal paths, dependency details, stack fragments.
  function sanitizeErrorForClient(err) {
    const msg = (err && err.message) || 'Unknown error';
    // Map common internal errors to safe user-facing strings
    if (/EACCES|EPERM/.test(msg)) return 'Permission denied — check file permissions.';
    if (/ENOSPC/.test(msg)) return 'Disk full — unable to write data.';
    if (/ENOENT/.test(msg)) return 'File not found.';
    if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(msg)) return 'Network request failed.';
    if (/all models failed/.test(msg)) return 'All AI providers are currently unavailable.';
    // Generic fallback — strip any paths or technical details
    return 'An internal error occurred. Check server logs for details.';
  }

  const app = express();
  app.use((req, res, next) => { req.id = crypto.randomUUID(); next(); });
  app.use(express.json({ limit: '1mb' }));

  const globalLimit = createLimiter({ windowMs: 60000, max: Number(process.env.RATE_LIMIT_GLOBAL) || 240, scope: 'global-api' });
  const expensiveLimit = createLimiter({ windowMs: 60000, max: Number(process.env.RATE_LIMIT_EXPENSIVE) || 8, scope: 'expensive' });

  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(express.static(path.join(__dirname, '..', 'ui', 'public'), { etag: false, maxAge: 0, lastModified: false }));

  // Build artifacts (open_artifact spawns the OS browser pointed at these
  // URLs) — scoped to exactly vault/builds, not the whole vault root, which
  // also holds Episodic/Semantic/Identity/Audit/Checkpoints that should never
  // be served as plain static files.
  app.use('/vault/builds', express.static(memory.fs.vaultPath('builds'), { etag: false, maxAge: 0, lastModified: false }));

  // MediaPipe tasks-vision runtime assets (gesture recognition runs fully
  // client-side; these are the WASM runtime + ESM bundle served from
  // node_modules so the app never loads from a CDN).
  app.use('/vendor/mediapipe', express.static(path.join(__dirname, '..', 'node_modules', '@mediapipe', 'tasks-vision'), { etag: false, maxAge: 0, lastModified: false }));

  app.use('/api', globalLimit);
  app.get('/health', (req, res) => { res.json({ ok: true, uptime: process.uptime() }); });

  app.get('/api/status', async (req, res) => {
    try {
      res.json(await probes.getStatus());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // CONSISTENCY FIX (P7 vs NOVA UI, documented in ROADMAP.md P9): the byte-identical
  // NOVA goals view renders stats.{total,active,completed,progress} (app/lib/goals.js
  // shape), but the P7 goals-effector bridge ships stats() -> {total,done,active}.
  // The REST seam translates so the copied view needs zero changes (Ambiguity #1's
  // own promise). Translation lives HERE, never inside the effector — the bridge's
  // shape is already consumed by from-dashboard.js tools.
  function novaGoalsStats() {
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

  // ---- goals / kanban / pipeline REST — CA, unchanged surface, see Ambiguity #1 ----
  app.get('/api/goals', (req, res) => {
    res.json({ goals: goalsEffector.listGoals(), stats: novaGoalsStats() });
  });
  app.post('/api/goals', (req, res) => {
    const { text, category } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
    const list = goalsEffector.addGoal(text, category);
    res.json({ goals: list, stats: novaGoalsStats() });
  });
  app.post('/api/goals/:id/toggle', (req, res) => {
    const list = goalsEffector.toggleGoal(req.params.id);
    res.json({ goals: list, stats: novaGoalsStats() });
  });
  app.delete('/api/goals/:id', (req, res) => {
    const list = goalsEffector.deleteGoal(req.params.id);
    res.json({ goals: list, stats: novaGoalsStats() });
  });

  app.get('/api/kanban', (req, res) => { res.json(kanbanEffector.listBoard()); });

  // ---- /api/news — Google News RSS fetched server-side for the NEWS widget
  // (browsers can't: CORS on the feed, X-Frame-Options on the site) ----
  const newsFeed = createNewsFeed();
  app.get('/api/news', (req, res) => {
    newsFeed.fetchNews()
      .then((r) => res.json(r))
      .catch((err) => res.json({ ok: false, error: err.message, items: [] }));
  });

  // ---- P22 — Forge build projects + checkpoint approval gates ----
  app.get('/api/forge/projects', (req, res) => { res.json({ projects: forge ? forge.listProjects() : [] }); });
  app.get('/api/forge/projects/:id', (req, res) => {
    if (!forge) return res.status(404).json({ error: 'forge unavailable' });
    const project = forge.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'not found' });
    res.json({ project });
  });
  app.get('/api/checkpoints', (req, res) => {
    res.json({ checkpoints: checkpoints ? checkpoints.list({ status: req.query.status }) : [] });
  });
  app.get('/api/checkpoints/:id', (req, res) => {
    if (!checkpoints) return res.status(404).json({ error: 'checkpoints unavailable' });
    const c = checkpoints.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json({ checkpoint: c });
  });
  app.post('/api/kanban/cards', (req, res) => {
    const { title, lane } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: 'title required' });
    res.json({ card: kanbanEffector.addCard(title, lane), board: kanbanEffector.listBoard() });
  });
  app.post('/api/kanban/cards/:id/move', (req, res) => {
    try {
      const card = kanbanEffector.moveCard(req.params.id, req.body.lane);
      res.json({ card, board: kanbanEffector.listBoard() });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });
  app.delete('/api/kanban/cards/:id', (req, res) => {
    kanbanEffector.deleteCard(req.params.id);
    res.json({ board: kanbanEffector.listBoard() });
  });

  // ---- kanban agent routes: assemble / build / review / accept + job polling ----
  app.post('/api/kanban/assemble', (req, res) => {
    const { goal } = req.body || {};
    if (!goal || !goal.trim()) return res.status(400).json({ error: 'goal required' });
    try {
      res.json(agentActions.assembleKanbanPlan(goal.trim()));
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/kanban/cards/:id/build', (req, res) => {
    try {
      res.json(agentActions.buildKanbanCard(req.params.id));
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/kanban/cards/:id/review', (req, res) => {
    try {
      res.json(agentActions.reviewKanbanCard(req.params.id));
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/kanban/cards/:id/accept', (req, res) => {
    const lane = (req.body || {}).lane === 'backlog' ? 'backlog' : 'done';
    try {
      kanbanEffector.moveCard(req.params.id, lane);
      kanbanEffector.patchCard(req.params.id, { reviewVerdict: null, reviewNotes: null });
      res.json({ board: kanbanEffector.listBoard() });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

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
  });
  app.post('/api/pipeline/:id/approve', (req, res) => {
    try { res.json({ card: pipelineEffector.approve(req.params.id), board: pipelineEffector.listAll() }); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });
  app.post('/api/pipeline/:id/reject', (req, res) => {
    try { pipelineEffector.reject(req.params.id); res.json({ board: pipelineEffector.listAll() }); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });
  app.post('/api/pipeline/:id/ship', (req, res) => {
    try { res.json({ card: pipelineEffector.ship(req.params.id), board: pipelineEffector.listAll() }); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });

  // ---- /api/memory/:store — spec-mandated route ("omitted above for space"),
  // backed by each store's real browse surface: episodic.tail, semantic/skills/
  // identity recall('') (empty query matches every entry — verified against the
  // shipped scorers), audit.query. Entries are normalized to {ts, summary, kind}
  // so the memory view renders every store identically. ----
  const MEMORY_STORES = new Set(['episodic', 'semantic', 'skills', 'identity', 'audit']);
  app.get('/api/memory/:store', (req, res) => {
    const store = req.params.store;
    if (!MEMORY_STORES.has(store)) return res.status(404).json({ error: `unknown store: ${store}` });
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    try {
      let entries = [];
      if (store === 'episodic') {
        entries = memory.episodic.tail(limit).filter(Boolean).map((e) => ({
          ts: e.ts, summary: e.summary || '', kind: e.kind || 'episode',
        }));
      } else if (store === 'audit') {
        // Not every audit entry is a leash decision — immune heal records carry
        // no tier/tool, so both fields degrade to placeholders, never 'undefined'.
        entries = memory.audit.query({ limit }).map((e) => ({
          ts: e.ts, summary: `T${e.tier !== undefined && e.tier !== null ? e.tier : '-'} ${e.decision || '?'} ${e.tool || ''}`.trim(), kind: 'decision',
        }));
      } else {
        entries = memory[store].recall('', { limit }).map((r) => ({
          ts: (r.record && (r.record.ts || (r.record.sidecar && r.record.sidecar.updated))) || null,
          summary: (r.record && r.record.topic ? r.record.topic + ': ' : '') + (r.snippet || ''),
          kind: store,
        }));
      }
      res.json({ store, entries });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- /api/stats — NEW (P9 HUD density source): one snapshot of how much the
  // entity has lived. Drives the neural map's data-grown node weights. ----
  app.get('/api/stats', (req, res) => {
    try {
      const m = memory.stats();
      const g = novaGoalsStats();
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

  // Speech-to-text — Groq Whisper transcribes audio recorded client-side.
  // Replaces the browser's own SpeechRecognition: Google's cloud speech backend
  // and Chrome's on-device model download are both unreachable on this network
  // ('network' error / stalled 'downloading' state, confirmed live); Groq's host
  // is the same one already proven reachable all session for chat completions.
  // express.raw() is scoped to this one route only — the global express.json()
  // above only matches 'application/json' and won't consume this body.
  app.post('/api/voice/transcribe', express.raw({ type: '*/*', limit: '15mb' }), expensiveLimit, async (req, res) => {
    try {
      if (!groqStt.isAvailable()) return res.status(503).json({ error: 'Speech-to-text unavailable — GROQ_API_KEY missing.' });
      let text;
      try {
        text = await groqStt.transcribe(req.body, req.headers['content-type']);
      } catch (groqErr) {
        // Groq failed — try browser fallback hint
        return res.status(200).json({ ok: false, error: 'stt-down', fallback: 'browser', message: 'Speech-to-text service is temporarily unavailable. Use browser speech recognition.' });
      }
      res.json({ text });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Unknown /api routes answer honest JSON (the byte-identical NOVA views probe a
  // few NOVA-era routes — /api/kanban/assemble, /api/pipeline/:id/execute — whose
  // backing now lives in P7 effectors, not this REST surface; see ROADMAP.md P9).
  app.use('/api', (req, res) => {
    res.status(404).json({ error: `No such route in the MYTHOS REST surface: ${req.method} ${req.path}` });
  });

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(__dirname, '..', 'ui', 'public', 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error('unhandled route error', { requestId: req.id, path: req.path, error: err.message });
    res.status(500).json({ error: 'Internal server error.', requestId: req.id });
  });

  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const httpServer = app.listen(PORT, BIND, () => {
    logger.info('server.listening', { url: `http://${BIND}:${PORT}`, bind: BIND });
    resolveReady();
  });

  // ---- WS v2 ----
  function verifyClient(info, callback) {
    const origin = info.origin;
    if (origin) {
      if (ALLOWED_ORIGINS.has(origin)) return callback(true);
      logger.warn('ws-upgrade-rejected', { reason: 'foreign origin', origin });
      return callback(false, 403, 'Forbidden');
    }
    if (isLoopback(info.req)) return callback(true);
    logger.warn('ws-upgrade-rejected', { reason: 'no origin, non-loopback' });
    return callback(false, 403, 'Forbidden');
  }

  const wss = new WebSocketServer({ server: httpServer, path: '/ws', verifyClient });

  function broadcastAll(msg) {
    const payload = JSON.stringify(msg);
    wss.clients.forEach((client) => {
      if (client.readyState === 1) client.send(payload);
    });
  }

  // Proactive speech — the entity speaks without an inbound utterance.
  // Synthesizes via edge-tts (same as reactive sendSpokenReply) and broadcasts
  // to ALL connected clients as a synthetic reqId'd turn. The browser
  // voice-loop treats 'proactive-speech' like a turn start without a user
  // utterance. Falls back gracefully if edge-tts is down (client uses
  // speechSynthesis). Never throws — proactive speech is best-effort.
  let proactiveSeq = 0;
  async function proactiveSpeak(text) {
    if (!text || !wss) return;
    const reqId = 'proactive-' + Date.now() + '-' + (++proactiveSeq);
    const speak = sanitizeSpoken(text);
    broadcastAll({ type: 'proactive-speech', reqId, text, speak });
    let ttsUp = false;
    try {
      ttsUp = await edgeTts.isAvailable();
    } catch (err) {
      // The availability probe itself can throw (network error hitting the TTS
      // endpoint, provider init failure). Previously this rejected out of
      // proactiveSpeak unhandled — and the announcer had already called
      // markAnnounced(key), so the event was deduped as "announced" though the
      // operator never heard it. Treat a failed probe as "TTS down" and still
      // deliver the done message so the client falls back to speechSynthesis.
      logger.warn('edge-tts.proactive-availability-probe-failed', { error: err.message });
    }
    if (ttsUp) {
      const chunks = splitSentences(speak);
      for (let i = 0; i < chunks.length; i++) {
        let audioB64 = null;
        try {
          const buf = await edgeTts.synthesize({ text: chunks[i], voice: config.VOICE_TTS_VOICE });
          audioB64 = buf.toString('base64');
        } catch (err) {
          logger.warn('edge-tts.proactive-chunk-failed', { error: err.message, index: i });
        }
        broadcastAll({ type: 'speech-chunk', reqId, index: i, total: chunks.length, audioB64, text: chunks[i] });
      }
    }
    broadcastAll({ type: 'done', reqId, say: text, speak, chunked: ttsUp, proactive: true });
    // B6: Persist proactive speech to episodic memory for conversation continuity.
    try {
      memory.episodic.write({
        kind: 'proactive-speech', channel: 'proactive',
        summary: text.slice(0, 100),
        detail: { text: text, proactive: true },
        salience: 0.5,
      });
    } catch (_) {}
  }

  // Shared dispatch — the ONE place that executes an already-gated action, whether
  // called from a confirm-accept (below) or any future caller. Steps stay
  // byte-for-byte identical to cortex/act()'s steps 3-6 (Anti-Drift #4): breaker
  // check, invoke, episodic write, budget debit, action.completed emit.
  // F1: Delegate to shared dispatch-action module — single dispatch surface
  // shared between cortex autonomous loop, voice confirm-accept, and REST.
  async function dispatchAction(decision, ctx) {
    return sharedDispatch(decision, {
      effectors: effectors,
      bus: bus,
      goals: goals,
      memory: memory,
      config: config,
      goalId: ctx.goalId || null,
      tier: ctx.tier || 0,
      channel: 'voice',
    });
  }

  // Voice tool-calling agent: leash-gated actions dispatched through the same
  // dispatchAction path as confirm-accepts — one execution surface, no shadow.
  // createVoiceAgent() fail-fasts on a missing brain/leash/bus (real deps
  // always have these — see main.js); caught here so a partial dep set (unit
  // tests exercising unrelated server surface, e.g. server.test.js's baseDeps)
  // degrades to voice-offline instead of throwing mid-construction, after
  // app.listen() has already opened a socket nothing would ever close.
  let voiceAgent = null;
  try {
    voiceAgent = createVoiceAgent({ brain, leash, dispatch: dispatchAction, bus, config: config });
  } catch (err) {
    logger.warn('voice-agent.unavailable', { error: err.message });
  }

  // Proactive conversation announcer — listens for build completions, goal
  // completions, and critical anomalies, generates natural speech via brain,
  // delivers through proactiveSpeak(). This is what fixes the "is it done?"
  // gap: when a build finishes, MYTHOS says so without being asked.
  let conversationAnnouncer = null;
  try {
    conversationAnnouncer = createConversationAnnouncer({
      bus: bus, brain: brain, config: config, speak: proactiveSpeak
    });
    conversationAnnouncer.start();
  } catch (err) {
    logger.warn('conversation-announcer.unavailable', { error: err.message });
  }

  // Fix the dead wire: the immune announcer's speak() shim in main.js emits
  // 'action.speak-requested' but nothing subscribed to it — so health-driven
  // speech was silently dropped. Route it through proactiveSpeak() so the
  // immune system has a real voice for critical health events.
  bus.subscribe('action.speak-requested', (e) => {
    if (e && e.payload && e.payload.text) proactiveSpeak(e.payload.text);
  });

  // Calendar reminders — proactive speech when a reminder fires due.
  bus.subscribe('reminder.due', (e) => {
    if (e && e.payload && e.payload.text) proactiveSpeak('Reminder: ' + e.payload.text);
  });

  // Live build-job progress relay ('job' OUT type). build-runner's onJobUpdate
  // fires on every status/stage transition (queued -> generating ->
  // writing-artifact -> done|failed); the perception pipeline stays untouched.
  if (buildRunner && typeof buildRunner.onJobUpdate === 'function') {
    buildRunner.onJobUpdate((job) => {
      broadcastAll({ type: 'job', payload: { id: job.id, kind: job.kind, status: job.status, stage: job.stage, error: job.error, artifact: job.artifact } });
    });
  }

  wss.on('connection', (ws) => {
    const connectionId = crypto.randomUUID();
    const subscriptions = new Set(); // which OUT types this client wants relayed

    // A2 FIX: prevent unhandled 'error' events from crashing the process.
    ws.on('error', (err) => {
      logger.warn('ws-connection-error', { error: err.message, connectionId });
    });

    // Per-connection conversation memory (CA of NOVA app/lib/voice/intake.js,
    // folded into the connection closure): last 12 turns, 2000 chars each,
    // 10-minute idle TTL. Deliberately NOT wiped after start_project succeeds —
    // an earlier version cleared it here on the theory that the intake
    // conversation shouldn't bleed into post-build turns, but that also erased
    // the only record that a build was ever started: "is it done?" a few turns
    // later had zero context and the voice-agent asked what to build, as if
    // starting fresh. The rolling window (already capped at 12 turns / 10 min
    // idle) is exactly the mechanism that should carry "I started building X"
    // forward to a later "is it done" — so it's left alone.
    const HISTORY_MAX_TURNS = 12;
    const HISTORY_IDLE_TTL_MS = Number(process.env.VOICE_INTAKE_IDLE_MS) || 10 * 60 * 1000;
    let history = [];
    let historyAt = 0;

    function historyGet() {
      if (Date.now() - historyAt > HISTORY_IDLE_TTL_MS) history = [];
      return history;
    }
    function historyAppend(role, content) {
      if (!content) return;
      historyGet(); // apply TTL first
      history.push({ role, content: String(content).slice(0, 2000) });
      history = history.slice(-HISTORY_MAX_TURNS);
      historyAt = Date.now();
    }

    // C3: Serialize utterances per-connection to prevent concurrent races.
    let turnChain = Promise.resolve();
    function queueTurn(fn) {
      const next = turnChain.then(fn, fn);
      turnChain = next.catch(function() {});
      return next;
    }

    // Build a system-note summarizing action outcomes for the history and
    // episodic record. Returns null when there are no actions (pure chat turns
    // produce no note). Failed actions are flagged explicitly so future turns
    // know the model's spoken claim was wrong — this is the anti-fabrication
    // fix: without it, MYTHOS recalls "deleting now" as fact after a failed delete.
    function summarizeActionsForResult(actions) {
      if (!actions || !actions.length) return null;
      var parts = [];
      for (var i = 0; i < actions.length; i++) {
        var a = actions[i];
        if (!a || !a.tool) continue;
        if (a.confirmPending) continue; // confirm-pending = deferred, not an outcome
        var status = a.ok ? 'succeeded' : 'FAILED';
        parts.push(a.tool + ' ' + status + (a.summary ? ': ' + a.summary : ''));
      }
      if (!parts.length) return null;
      return 'Action outcomes: ' + parts.join('; ') + '.';
    }

    function send(msg) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); }

    // Initial entity-state snapshot: lifecycle.* events are broadcast-only, so a
    // client connecting AFTER boot would otherwise sit on 'booting' forever.
    send({ type: 'entity-state', payload: { name: config.MYTHOS_NAME, status: entityStatus, tick: memory.working.tick } });

    // CONSISTENCY FIX (spec vs shipped brain, documented in ROADMAP.md P9): the
    // spec's handleUtterance calls brain.interpret(), which no shipped phase ever
    // built — the P2 brain's real surface is think({lane, messages, ...}). The
    // 'voice' lane is the shipped conversational lane (persona-injected). Offline
    // brain degrades honestly: the client gets told, never a silent empty reply.
    // Chunked spoken reply: split into sentences, synthesize each in order,
    // and send each chunk the moment ITS audio is ready — the client starts
    // playing chunk 0 while chunk 1..n are still synthesizing. The final
    // 'done' carries text/metadata only (audio already streamed). If edge-tts
    // is down, chunks are sent with audioB64:null and the client falls back
    // to browser speechSynthesis exactly as before. Shared by handleUtterance
    // and handleVisionQuery — one reply-emission path, one protocol.
    async function sendSpokenReply(reqId, say, meta) {
      const speak = sanitizeSpoken(say);
      const ttsUp = await edgeTts.isAvailable();
      const chunks = ttsUp ? splitSentences(speak) : [];
      if (ttsUp && chunks.length) {
        for (let i = 0; i < chunks.length; i++) {
          let audioB64 = null;
          try {
            const buf = await edgeTts.synthesize({ text: chunks[i], voice: config.VOICE_TTS_VOICE });
            audioB64 = buf.toString('base64');
          } catch (err) {
            logger.warn('edge-tts.chunk-failed', { error: err.message, index: i });
          }
          send({ type: 'speech-chunk', reqId, index: i, total: chunks.length, audioB64, text: chunks[i] });
        }
      }
      send({ type: 'done', reqId, say, speak, chunked: ttsUp && chunks.length > 0, ...meta });
    }

    async function handleUtterance(msg) {
      if (!voiceAgent) {
        send({ type: 'done', reqId: msg.reqId, say: 'Brain is offline.', offline: true });
        return;
      }
      // 30s hard ceiling — matches CHAIN_ATTEMPT_TIMEOUT_MS so the voice agent
      // is never left hanging after chain.js has already exhausted all providers.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      try {
        const text = String(msg.text || '');

        // Recall relevant memories before responding — gives the entity long-term
        // context: past conversations, user facts, and actions relevant to this query.
        // Best-effort: failures degrade to no memory context (amnesia), never crash.
        var memoryContext = null;
        try {
          var recalled = memory.episodic.recall(text, { limit: 8, windowDays: 7 });
          // Also pull semantic user-facts for durable preferences
          var semanticHits = memory.semantic.recall(text, { limit: 3 });
          if (recalled.length > 0 || semanticHits.length > 0) {
            var parts = [];
            for (var i = 0; i < recalled.length; i++) {
              parts.push(recalled[i].snippet || recalled[i].record.summary);
            }
            for (var j = 0; j < semanticHits.length; j++) {
              if (semanticHits[j].snippet) parts.push('(fact) ' + semanticHits[j].snippet);
            }
            if (parts.length > 0) memoryContext = parts.join('\n');
          }
        } catch (err) { logger.warn('memory-recall-failed', { store: 'episodic+semantic', error: err.message }); }

        // Surface pending thoughts from idle reasoning — if the entity formed a
        // thought during a quiet moment, inject it as context so it can be
        // mentioned naturally ("earlier I noticed that...").
        try {
          var pending = memory.episodic.recall('', { kind: 'thought', limit: 1, windowDays: 1 });
          if (pending.length > 0 && pending[0].record && pending[0].record.detail) {
            var thoughtText = pending[0].record.detail.text || pending[0].record.summary;
            if (thoughtText) {
              memoryContext = (memoryContext ? memoryContext + '\n' : '') +
                'YOU NOTED EARLIER (mention naturally if relevant, do not force): ' + thoughtText;
            }
          }
        } catch (err) { logger.warn('memory-recall-failed', { store: 'thoughts', error: err.message }); }

        const result = await voiceAgent.handleUtterance({
          text,
          ctx: { history: historyGet(), connectionId, memoryContext: memoryContext },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (result.offline) {
          send({ type: 'done', reqId: msg.reqId, say: result.say || 'All providers are offline right now.', offline: true });
          return;
        }
        const say = result.say || 'Done.';
        historyAppend('user', text);
        historyAppend('assistant', say);

        // Record action OUTCOMES into history — not just the model's claim.
        // Without this, MYTHOS recalls its own lie as fact: it said "deleting
        // now", the delete failed, but history only stored the claim. Later
        // turns see "deleting now" and treat it as accomplished. Now a system
        // note records the actual result so future turns know the truth.
        var actionSummary = summarizeActionsForResult(result.actions);
        if (actionSummary) {
          historyAppend('system', actionSummary);
        }

        // Persist conversation turn to episodic memory — this is what gives the
        // entity memory across sessions. The in-RAM history (12 turns, 10min TTL)
        // carries context within a session; this episodic write makes it durable.
        // Written AFTER historyAppend so the reply is final (no later corrective
        // pass can overwrite it — handleUtterance already ran to completion here).
        // Includes action outcomes in detail so recall surfaces the truth, not
        // just the model's spoken claim.
        try {
          var turnId = 'turn-' + Date.now();
          memory.episodic.write({
            kind: 'conversation', tick: memory.working.tick,
            summary: 'User: ' + text.slice(0, 100) + ' | MYTHOS: ' + say.slice(0, 100),
            detail: {
              role: 'user', text: text.slice(0, 2000), reply: say.slice(0, 1000), turnId: turnId,
              actions: (result.actions || []).map(function(a) {
                return { tool: a.tool, ok: a.ok, summary: a.summary };
              })
            },
            salience: 0.6, channel: 'voice'
          });
        } catch (_) { /* persistence is best-effort */ }

        const meta = {
          actions: (result.actions || []).map((a) => ({ tool: a.tool, ok: a.ok, summary: a.summary })),
          confirmPending: result.confirmPending ? { confirmId: result.confirmPending.confirmId, summary: result.confirmPending.summary } : null,
        };
        await sendSpokenReply(msg.reqId, say, meta);
      } catch (err) {
        clearTimeout(timer);
        logger.warn('voice-utterance-error', { error: err.message, reqId: msg.reqId });
        send({ type: 'done', reqId: msg.reqId, say: `Error: ${sanitizeErrorForClient(err)}`, error: true });
      }
    }

    // vision-query: one-shot multimodal ask — first real caller of the
    // 'vision' brain lane (PREF_VISION, lanes.default.js). Read-only (no tool
    // dispatch, no leash tier needed — same class as a plain chat reply).
    //
    // P20 token-level streaming lands here, not in handleUtterance: this
    // reply is plain prose straight off brain.think({lane:'vision'}) — no
    // JSON tool-calling contract, no needs_result/corrective-pass loop that
    // could still overwrite `say` after we'd already started speaking it.
    // brain.think's onToken (now threaded through chain.js into every
    // provider, all of which already speak SSE/NDJSON streaming — see
    // ROADMAP.md P20) feeds a createSentenceStreamer(); each sentence that
    // completes mid-stream is synthesized and sent as its own speech-chunk
    // immediately, in order, while the model is still generating the next
    // one — sentence 1 can be playing in the browser before sentence 2 has
    // finished generating, instead of waiting for the whole reply first.
    // handleUtterance (the voice-agent tool-calling path) deliberately stays
    // full-buffer: it constrains the model to one JSON object per call
    // ({"say","actions","needs_result"}), and finalSay can be overwritten by
    // a later needs_result iteration or the one-shot corrective pass — there
    // is no point in the JSON-tool-calling loop where "the content generated
    // so far is provably the final spoken reply" until the whole turn (all
    // iterations) has resolved, at which point streaming buys nothing.
    const MAX_IMAGE_B64 = 4 * 1024 * 1024; // ~3MB decoded — a 640x480 JPEG is ~50-100KB
    async function handleVisionQuery(msg) {
      if (!brain || typeof brain.think !== 'function') {
        send({ type: 'done', reqId: msg.reqId, say: 'Vision is offline.', offline: true });
        return;
      }
      try {
        const image = String(msg.image || '');
        if (!image || image.length > MAX_IMAGE_B64) {
          send({ type: 'done', reqId: msg.reqId, say: 'I could not read that image.', error: true });
          return;
        }
        const text = String(msg.text || 'Describe what you see, briefly.').slice(0, 500);

        const ttsUp = await edgeTts.isAvailable();
        const streamer = createSentenceStreamer();
        let chunkIndex = 0;
        let sendChain = Promise.resolve(); // serializes synth+send so chunks stay in order
        // total is unknown until the stream ends; the client's own barge-in-aware
        // finish (voice-loop.js maybeFinishTurn) already falls back to "queue
        // drained" rather than relying solely on index===total-1, so an unknown
        // total here does not stall turn completion.
        function enqueueChunk(rawText) {
          const i = chunkIndex++;
          sendChain = sendChain.then(async () => {
            const spoken = sanitizeSpoken(rawText);
            if (!spoken) return;
            let audioB64 = null;
            try {
              const buf = await edgeTts.synthesize({ text: spoken, voice: config.VOICE_TTS_VOICE });
              audioB64 = buf.toString('base64');
            } catch (err) {
              logger.warn('edge-tts.chunk-failed', { error: err.message, index: i });
            }
            send({ type: 'speech-chunk', reqId: msg.reqId, index: i, total: null, audioB64, text: spoken });
          });
        }

        const result = await brain.think({
          lane: 'vision',
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: text + ' Answer in at most two short spoken sentences, plain text, no markdown.' },
              { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + image } },
            ],
          }],
          source: 'vision-query',
          onToken: ttsUp ? (delta) => { for (const s of streamer.push(delta)) enqueueChunk(s); } : undefined,
        });

        if (result.offline || !result.content) {
          send({ type: 'done', reqId: msg.reqId, say: 'All my vision providers are offline right now.', offline: true });
          return;
        }
        const say = String(result.content).trim().slice(0, 400);
        historyAppend('user', '[showed camera] ' + text);
        historyAppend('assistant', say);          // vision answers join conversation memory

        // Persist vision conversation turn to episodic memory (same as voice path)
        try {
          memory.episodic.write({
            kind: 'conversation', tick: memory.working.tick,
            summary: 'Vision query: ' + text.slice(0, 80) + ' | MYTHOS: ' + say.slice(0, 100),
            detail: { role: 'user', text: '[showed camera] ' + text, reply: say, modality: 'vision' },
            salience: 0.5, channel: 'voice'
          });
        } catch (_) { /* best-effort */ }

        if (ttsUp) {
          const tail = streamer.flush();
          if (tail) enqueueChunk(tail);
          await sendChain;
        }
        send({ type: 'done', reqId: msg.reqId, say, speak: sanitizeSpoken(say), chunked: ttsUp && chunkIndex > 0 });
      } catch (err) {
        logger.warn('vision-query-error', { error: err.message, reqId: msg.reqId });
        send({ type: 'done', reqId: msg.reqId, say: `Error: ${sanitizeErrorForClient(err)}`, error: true });
      }
    }

    function handleCommand(msg) {
      send({ type: 'done', reqId: msg.reqId, command: msg.command });
    }

    async function handleConfirmReply(msg) {
      const { confirmId, accept } = msg;
      if (!accept) {
        // B3: Audit-log the rejection for security accountability.
        // Peek BEFORE reject — once rejected, the entry is deleted and peek() returns null.
        var rejectInfo = null;
        try {
          if (typeof leash.confirm.peek === 'function') rejectInfo = leash.confirm.peek(confirmId);
        } catch (_) {}
        var rejectTier = null;
        try {
          if (typeof leash.confirm.peekTier === 'function') rejectTier = leash.confirm.peekTier(confirmId);
        } catch (_) {}
        // Try this connection's scope first, then the cortex 'system' sentinel —
        // a wrong-scope reject never deletes the entry (leash/confirm.js), so the
        // two-step probe cannot DoS another connection's pending confirm.
        if (!leash.confirm.reject(confirmId, connectionId)) leash.confirm.reject(confirmId, 'system');
        // Write audit entry after reject so the record reflects the final decision.
        try {
          if (rejectInfo && memory && memory.audit && typeof memory.audit.write === 'function') {
            memory.audit.write({
              tool: '(confirm-rejected)', tier: rejectTier || 0,
              decision: 'deny', reason: 'user-rejected',
              args: { confirmId: confirmId, summary: rejectInfo.summary },
            });
          }
        } catch (_) {}
        return;
      }
      // A3 FIX: only allow 'system' scope fallback for low-risk (T0-T2) actions.
      // T3/T4 actions require the originating connection to approve — prevents
      // any local WS client from approving dangerous actions (browser_evaluate, etc.)
      let action = leash.confirm.accept(confirmId, connectionId);
      if (!action) {
        const tier = typeof leash.confirm.peekTier === 'function' ? leash.confirm.peekTier(confirmId) : null;
        if (tier === null || tier <= 2) {
          action = leash.confirm.accept(confirmId, 'system');
        }
      }
      if (!action) return; // expired / already consumed / wrong connection — silent no-op, matches NOVA
      // Cortex stores {decision, goalId, tier} envelopes (cortex/index.js act());
      // a bare {tool, args} decision (the spec's own test 2 fixture) passes through
      // unchanged — one normalization, no shadow dispatch paths.
      const decision = action.decision || { tool: action.tool, args: action.args };
      try {
        await dispatchAction(decision, { goalId: action.goalId, tier: action.tier });
      } catch (err) {
        // dispatchAction awaits effectors.invoke + memory.episodic.write +
        // goals.debitBudget — any of these can throw (disk full, EPERM, vault
        // locked). This handler is fired un-awaited from ws.on('message'), so
        // an unhandled rejection here crashes the process. Catch, surface to
        // the client, and emit an anomaly — the confirm was already consumed
        // in accept(), so the outcome MUST be reported honestly.
        send({ type: 'done', reqId: confirmId, say: `Action failed: ${sanitizeErrorForClient(err)}`, error: true });
        bus.emit('health.anomaly', { kind: 'confirm-dispatch-failed', error: err.message, confirmId });
      }
    }

    // P22 — resolve a Forge workflow checkpoint (plan/mid/final approval). Checkpoints
    // are connectionId:'system', so any connected client may approve (Voice+HUD parity).
    // The 'checkpoint' broadcast (checkpoint.resolved) tells every client the outcome.
    async function handleCheckpointReply(msg) {
      if (!checkpoints) return;
      const { id, accept, feedback } = msg;
      try {
        if (accept) await checkpoints.accept(id, connectionId, feedback);
        else await checkpoints.reject(id, connectionId, feedback);
      } catch (err) {
        bus.emit('health.anomaly', { kind: 'checkpoint-reply-failed', error: err.message, id });
      }
    }

    function handleSubscribe(msg) {
      (msg.types || []).forEach((t) => {
        const isNew = !subscriptions.has(t);
        subscriptions.add(t);
        // Replay history only when the client asked for it (backend-terminal
        // panel) — an unconditional replay would re-fire 200 'action' events
        // into hud-canvas's burst FX on every page load.
        if (msg.replay && isNew && replayBuffers[t]) {
          replayBuffers[t].forEach((entry) => send(entry));
        }
      });
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'utterance') queueTurn(function() { return handleUtterance(msg); });
      else if (msg.type === 'vision-query') handleVisionQuery(msg);
      else if (msg.type === 'command') handleCommand(msg);
      else if (msg.type === 'confirm-reply') handleConfirmReply(msg);
      else if (msg.type === 'checkpoint-reply') handleCheckpointReply(msg);
      else if (msg.type === 'subscribe') handleSubscribe(msg);
      else if (msg.type === 'camera-frame') {
        const p = pendingFrames.get(msg.frameReqId);
        if (p) { clearTimeout(p.timer); pendingFrames.delete(msg.frameReqId); p.resolve(String(msg.image || '') || null); }
      }
      // 'stop' — no in-flight per-connection controllers to abort yet in this
      // phase's scope (utterance/command are not streamed); reserved for parity.
    });
  });

  // Replay buffers for the backend-terminal panel: it only sees LIVE broadcasts,
  // so an idle entity leaves it permanently on "Awaiting…". Keep the last 200 of
  // each stream; a {type:'subscribe', replay:true} message replays them to that
  // one connection (oldest first) so the panel opens with history.
  const REPLAY_MAX = 200;
  const replayBuffers = { log: [], action: [], 'brain-spend': [] };
  function pushReplay(type, payload) {
    const buf = replayBuffers[type];
    buf.push({ type, payload });
    if (buf.length > REPLAY_MAX) buf.shift();
  }

  // ---- Bus → WS v2 OUT relay (the anti-drift table, in code) ----
  // Every subscribe() below names the EXACT spec/shipped bus event string.
  // 'tick' — exact string, no dot-prefix (see Ambiguity #6), do not paraphrase.
  bus.subscribe('tick', (e) => {
    broadcastAll({ type: 'tick', payload: { tick: e.payload.tick, perceptions: e.payload.perceptions, activeGoal: memory.working.activeGoalId } });
  });

  // 'lifecycle.started' / 'lifecycle.stopped' / 'lifecycle.alive' feed entity-state.
  let entityStatus = 'booting';
  bus.subscribe('lifecycle.*', (e) => {
    if (e.type === 'lifecycle.alive') entityStatus = 'alive';
    if (e.type === 'lifecycle.stopped') entityStatus = 'stopped';
    broadcastAll({ type: 'entity-state', payload: { name: config.MYTHOS_NAME, status: entityStatus, tick: memory.working.tick } });
  });

  // 'goal.created' | 'goal.updated' | 'goal.removed' | 'goal.budget-debited' — exact
  // strings from the shipped P4 goals/index.js — all four collapse to OUT 'goal-update'.
  bus.subscribe('goal.*', (e) => {
    broadcastAll({ type: 'goal-update', payload: { id: e.payload.id, status: e.payload.status, title: e.payload.title } });
  });

  // 'perception.*' — relay only human-initiated ('ws' channel, always) or salience
  // above config.MYTHOS_IDLE_SALIENCE (config-read, not a new magic number — Lesson #6).
  // Field is `.salience`, never `.salienceHint` (cross-phase consistency fix, P6 vs P9).
  bus.subscribe('perception.*', (e) => {
    const p = e.payload;
    if (p.channel !== 'ws' && (p.salience || 0) < config.MYTHOS_IDLE_SALIENCE) return;
    broadcastAll({ type: 'perception', payload: { channel: p.channel, kind: p.kind, salience: p.salience, text: p.payload && p.payload.text } });
  });

  // 'action.denied' | 'action.blocked' | 'action.completed' — exact strings from cortex/index.js.
  bus.subscribe('action.*', (e) => {
    const payload = { tool: e.payload.tool, ok: e.payload.ok, goalId: e.payload.goalId, reason: e.payload.reason };
    pushReplay('action', payload);
    broadcastAll({ type: 'action', payload });
  });

  // Navigate events — emitted by dispatchAction when a navigate effector call
  // succeeds. Relays the resolved route to all clients so the panel opens.
  bus.subscribe('ui.navigate', (e) => {
    broadcastAll({ type: 'navigate', route: e.payload.route });
  });

  // Close-panel events — relay to all clients to close panels.
  bus.subscribe('ui.close-panel', (e) => {
    broadcastAll({ type: 'close-panel', all: e.payload.all });
  });

  // health — synthesized snapshot per Ambiguity #4; triggered by 'perception.metric'
  // (existing 4s Metric Sensor cadence) and immediately on 'health.anomaly'.
  //
  // FEEDBACK-STORM FIX (found in P9 live smoke, documented in ROADMAP.md): the
  // spec's broadcastHealth() called probes.getStatus() on EVERY trigger — but
  // getStatus() itself emits 'health.anomaly' for provider-down/quota-low on
  // every call (probes.js, documented no-dedupe). One down provider then recurses
  // anomaly -> getStatus -> anomaly forever, saturating the event loop and
  // starving HTTP. Fix: only the 4s perception.metric trigger runs a fresh
  // getStatus(); the health.anomaly trigger rebroadcasts immediately with the
  // last-known provider status — the anomaly payload it exists to surface is
  // already in anomalyLog, no fresh probe needed. Both spec triggers preserved.
  const anomalyLog = [];
  let lastStatus = null; // last probes.getStatus() result ({providers, quotas, probedAt})
  bus.subscribe('health.anomaly', (e) => {
    anomalyLog.push(e.payload);
    if (anomalyLog.length > 200) anomalyLog.shift();
    broadcastHealth(lastStatus);
    // B2: Persist anomalies to episodic memory for long-term health tracking.
    try {
      memory.episodic.write({
        kind: 'anomaly', channel: 'immune',
        summary: 'anomaly: ' + (e.payload.kind || 'unknown') + ' — ' + (e.payload.error || e.payload.target || ''),
        detail: { kind: e.payload.kind, scope: e.payload.scope, error: e.payload.error, target: e.payload.target },
        outcome: 'anomaly', salience: 0.8,
      });
    } catch (_) {}
  });
  bus.subscribe('perception.metric', () => {
    probes.getStatus().then((status) => {
      lastStatus = status;
      broadcastHealth(status);
      // Token-usage snapshot for the widget — real per-provider token data,
      // piggybacked on the existing 4s metric tick so no new polling infra is needed.
      broadcastAll({ type: 'token-usage', payload: spend.getStats() });
    }).catch(() => {});
  });

  function broadcastHealth(status) {
    // `status` is probes.getStatus()'s { providers, quotas, probedAt } — unwrap
    // here so the HUD gets flat `providers` + `quotas` instead of a nested blob
    // (the old shape made views/health.js JSON-dump the whole object).
    const breakers = {};
    for (const [name, breaker] of effectors.breakers) breakers[name] = breaker.stats;
    broadcastAll({
      type: 'health',
      payload: {
        breakers,
        providers: (status && status.providers) || {},
        quotas: (status && status.quotas) || [],
        anomalies: anomalyLog.slice(-20),
      },
    });
  }

  // audit.decision — exact string P5 emits alongside auditWriter.write() (Ambiguity #3).
  bus.subscribe('audit.decision', (e) => {
    broadcastAll({ type: 'audit', payload: { tool: e.payload.tool, tier: e.payload.tier, decision: e.payload.decision } });
  });

  // confirm-request — exact string, cortex act() (Ambiguity #2: P9's cortex diff embeds confirmId).
  // mission — orchestrator's plan/build/synthesize transitions (agent team)
  bus.subscribe('mission.update', (e) => {
    broadcastAll({ type: 'mission', payload: e.payload });
  });

  // P22 — Forge build progress + checkpoint approval gates -> WS.
  bus.subscribe('forge.update', (e) => {
    broadcastAll({ type: 'forge', payload: e.payload });
  });
  bus.subscribe('checkpoint.created', (e) => {
    broadcastAll({ type: 'checkpoint', payload: Object.assign({}, e.payload, { event: 'created' }) });
  });
  bus.subscribe('checkpoint.resolved', (e) => {
    broadcastAll({ type: 'checkpoint', payload: Object.assign({}, e.payload, { event: 'resolved' }) });
  });

  bus.subscribe('confirm-request', (e) => {
    broadcastAll({ type: 'confirm-request', payload: { id: e.payload.confirmId, tool: e.payload.tool, summary: e.payload.summary, tier: e.payload.tier } });
  });

  // brain-spend — exact string with hyphen (D-28 fixed).
  bus.subscribe('brain-spend', (e) => {
    pushReplay('brain-spend', e.payload);
    broadcastAll({ type: 'brain-spend', payload: e.payload });
  });

  // log — NOT a bus event; a logger hook (see logger.js onLog(fn) diff).
  if (typeof logger.onLog === 'function') {
    logger.onLog((line) => {
      pushReplay('log', line);
      broadcastAll({ type: 'log', payload: line });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      try {
        for (const client of wss.clients) {
          try { client.terminate(); } catch (_) { /* best-effort */ }
        }
        wss.close();
      } catch (_) { /* best-effort */ }
      httpServer.close(() => resolve());
    });
  }

  // `ready` resolves once the ephemeral port is bound — httpServer.address() is
  // null until the 'listening' event fires (async on Windows), so tests await it.
  return { app, httpServer, wss, stop, dispatchAction, ready, requestCameraFrame };
}

module.exports = { createServer };
