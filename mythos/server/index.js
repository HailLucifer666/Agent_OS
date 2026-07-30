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
// createNewsFeed moved to routes/news.js (W9 god-file decomposition).
const pcChild = require('../adapters/pc-child');
const version = require('../src/core/identity/version');
const { isProviderDown } = require('../src/core/immune/probes');

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

// Item A (Phase-1 hardening): memory.recallHybrid() embeds the query via
// providers/embeddings.js's Ollama-then-Mistral chain, each attempt bounded by
// its own 8s TIMEOUT_MS — a provider that HANGS (not errors) can stack up to
// ~16s of latency onto a live voice turn before the user hears anything.
// This bound is independent and tighter, applied only at this hot-path call
// site (Promise.race below): a slow/hung recall degrades to no memory context,
// never a stalled turn. recallHybrid()/embeddings.js's own timeouts are left
// untouched for other callers (e.g. memory.reindex()'s batch backfill), which
// have no such latency budget.
const RECALL_TIMEOUT_MS = Number(process.env.VOICE_RECALL_TIMEOUT_MS) || 3500;
const RECALL_TIMED_OUT = Symbol('recall-timed-out');
function recallWithTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(RECALL_TIMED_OUT), ms);
      if (t.unref) t.unref();
    }),
  ]);
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
  const reflection = deps.reflection;             // P4 learning loop — .noteTurn() per conversation turn (may be undefined in tests)
  const engagementStore = deps.engagementStore;         // Engagement layer — persistent record store (may be undefined in tests)
  const engagementManager = deps.engagementManager;     // Engagement layer — .engagement.{list,findById,transition}, .handleEngagementAction; Phase 1 executor lives on it (may be undefined in tests)
  const conversationGateway = deps.conversationGateway; // Engagement layer — .receive()/.classify()/.route() utterance classification
  const getCapabilityDigest = deps.getCapabilityDigest; // B2 — pre-context live capability digest (may be undefined in tests)

  // Server-initiated camera look: broadcast a frame request; any connected UI
  // with the camera actively watching answers with one JPEG frame. 8s timeout.
  const pendingFrames = new Map(); // frameReqId -> { resolve, timer }

  // Item B (barge-in stretch): AbortController per in-flight TTS synthesis
  // request, keyed by reqId. sendSpokenReply()'s and proactiveSpeak()'s
  // chunk-synthesis loops register here; the WS 'stop' handler aborts by
  // reqId when the client barges in, so not-yet-sent chunks stop synthesizing
  // (previously the loop kept calling edge-tts for audio nobody would hear).
  const inflightSpeech = new Map(); // reqId -> AbortController
  function requestCameraFrame() {
    return new Promise(function(resolve) {
      const id = 'frame-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
      const timer = setTimeout(function() { pendingFrames.delete(id); resolve(null); }, 8000);
      pendingFrames.set(id, { resolve: resolve, timer: timer });
      broadcastAll({ type: 'camera-frame-request', frameReqId: id });
    });
  }

  // REMEDIATION P1-5: server-initiated close_panel ack, mirroring
  // requestCameraFrame's request/response shape exactly. close_panel used to
  // broadcast 'close-panel' fire-and-forget and immediately report
  // {closed:true} regardless of what (if anything) actually closed. Now the
  // connected dashboard(s) close what they can (overlay panels AND floating
  // widgets) and report real counts back; a client with nothing connected
  // (or that never answers within the timeout) resolves null, and close_panel
  // surfaces that honestly instead of fabricating success.
  const pendingClosePanel = new Map(); // reqId -> { resolve, timer }
  function requestClosePanel(all) {
    return new Promise(function(resolve) {
      const id = 'closepanel-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
      const timer = setTimeout(function() { pendingClosePanel.delete(id); resolve(null); }, 3000);
      pendingClosePanel.set(id, { resolve: resolve, timer: timer });
      broadcastAll({ type: 'close-panel', all: !!all, reqId: id });
    });
  }

  // REMEDIATION P0-3 (2026-07-29 audit, item 10): audio ducking. Council
  // verdict (Torvalds/Feynman/Musashi, unanimous): STT transcribing Spotify
  // lyrics as commands is a state-coordination bug, not a signal-processing
  // one — duck (lower) system volume for exactly the VAD-confirmed recording
  // window (voice-loop.js's startRecording()/stopRecording(), the mic-hot
  // boundary) via the REAL Windows master-volume API (get_volume/set_volume,
  // added for item 4) instead of AEC or speaker verification, both of which
  // solve problems this single-user desktop assistant doesn't have.
  // preDuckVolume is process-global (single desktop, single mic) — guarded
  // so a second duck (e.g. barge-in re-arming mid-utterance) never overwrites
  // the real original level with an already-ducked one.
  const DUCK_VOLUME_LEVEL = 15;
  const UNDUCK_SAFETY_MS = 15000; // restore even if the client never sends unduck (dropped connection, crash)
  let preDuckVolume = null;
  let unduckSafetyTimer = null;
  // AD-1: these three calls used to go straight to the effector hub's
  // invoke() method, bypassing the single execution surface (dispatchAction,
  // defined below —
  // a hoisted function declaration, safe to reference here). Now every duck/
  // unduck volume change gets the same audit + episodic trail as any other
  // dispatched action, tagged channel:'voice-ducking' so it's distinguishable
  // from an operator-driven volume change.
  async function duckAudio() {
    if (preDuckVolume !== null) return; // already ducked
    if (!effectors || typeof effectors.invoke !== 'function') return;
    try {
      const current = await dispatchAction({ tool: 'get_volume', args: {} }, { tier: 0, channel: 'voice-ducking' });
      if (!current.ok || !current.result || typeof current.result.level !== 'number') return;
      preDuckVolume = current.result.level;
      await dispatchAction({ tool: 'set_volume', args: { level: DUCK_VOLUME_LEVEL } }, { tier: 2, channel: 'voice-ducking' });
      clearTimeout(unduckSafetyTimer);
      unduckSafetyTimer = setTimeout(function() { unduckAudio(); }, UNDUCK_SAFETY_MS);
    } catch (err) {
      preDuckVolume = null;
      logger.warn('audio-duck-failed', { error: err.message });
    }
  }
  async function unduckAudio() {
    if (preDuckVolume === null) return;
    const restoreLevel = preDuckVolume;
    preDuckVolume = null;
    clearTimeout(unduckSafetyTimer);
    if (!effectors || typeof effectors.invoke !== 'function') return;
    try {
      await dispatchAction({ tool: 'set_volume', args: { level: restoreLevel } }, { tier: 2, channel: 'voice-ducking' });
    } catch (err) {
      logger.warn('audio-unduck-failed', { error: err.message });
    }
  }

  const PORT = config.MYTHOS_PORT;
  const BIND = config.MYTHOS_BIND;

  // V2 §7.2 — the worst hole found: no login, no API key, no bearer check on
  // any route; the only gate was origin allow-listing (verifyClient below),
  // which any non-browser client spoofs with a header. Dockerfile and
  // render.yaml both set MYTHOS_BIND=0.0.0.0. Fail closed, loudly, at boot,
  // rather than silently exposing 107 tools (including T3 confirm-and-execute)
  // to anyone who finds the URL.
  const AUTH_TOKEN = config.MYTHOS_AUTH_TOKEN || '';
  const isLoopbackBind = /^(127\.|::1|localhost)/i.test(String(BIND));
  if (!isLoopbackBind && !AUTH_TOKEN) {
    throw new Error(
      `MYTHOS_BIND is non-loopback (${BIND}) but MYTHOS_AUTH_TOKEN is unset. ` +
      'Refusing to expose 107 tools unauthenticated. Set MYTHOS_AUTH_TOKEN (see mythos/.env.example) or bind 127.0.0.1.'
    );
  }

  // Timing-safe compare — the one place in this file where timing matters.
  // No token configured => loopback-only mode, every request passes (total
  // back-compat: the default config exercises none of the branches below).
  function tokenOk(presented) {
    if (!AUTH_TOKEN) return true;
    const a = Buffer.from(String(presented || ''));
    const b = Buffer.from(AUTH_TOKEN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // Shared by the /api|/vault/builds HTTP gate and the WS verifyClient below.
  // Order: Authorization: Bearer header (any client) -> ?token= query (the
  // §18.2 fix — a browser WebSocket cannot set headers, so this is how a
  // remote HUD tab authenticates the WS upgrade) -> mythos_token cookie (set
  // by the HUD once the operator enters the token, reused on plain HTTP nav).
  function extractToken(req) {
    const auth = req.headers && req.headers.authorization;
    if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
    try {
      const fromQuery = new URL(req.url, 'http://internal').searchParams.get('token');
      if (fromQuery) return fromQuery;
    } catch (_) { /* malformed url — fall through to cookie */ }
    const cookieHeader = req.headers && req.headers.cookie;
    if (cookieHeader) {
      const parts = cookieHeader.split(';');
      for (let i = 0; i < parts.length; i++) {
        const kv = parts[i].trim().split('=');
        if (kv[0] === 'mythos_token') return decodeURIComponent(kv.slice(1).join('=') || '');
      }
    }
    return null;
  }

  function requireToken(req, res, next) {
    if (!tokenOk(extractToken(req))) {
      return res.status(401).json({ error: 'Unauthorized — set MYTHOS_AUTH_TOKEN via Authorization: Bearer <token> or the mythos_token cookie.' });
    }
    next();
  }

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

  // W4 (Phase 2 — Wiring Integrity): audit helper for REST mutations. Every
  // POST/DELETE on /api/goals, /api/kanban, /api/pipeline, /api/engagements
  // writes an audit line via this helper so REST mutations leave a trace
  // (task-957 §24 W4). tool:'rest.<route>' so the audit panel can distinguish
  // REST-driven mutations from cortex/voice dispatches. tier:1 — these are
  // local writes, no leash check added here (the broader auth story is P1,
  // Phase 5). Best-effort: a failure to audit never blocks the response.
  function auditRest(tool, args, outcome) {
    if (!memory || !memory.audit || typeof memory.audit.write !== 'function') return;
    try {
      memory.audit.write({
        tool: tool,
        tier: 1,
        decision: 'completed',
        outcome: outcome || 'ok',
        args: args || {},
        source: 'rest',
      });
    } catch (_) { /* best-effort — never block a REST response on audit */ }
  }

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

  // security-reviewer finding (2026-07-30, step 2): globalLimit used to be
  // mounted AFTER requireToken, so every unauthenticated/wrong-token request
  // got rejected by the 401 before ever reaching the rate limiter — a flood
  // of bad-token requests had no cap. Moved ahead of the auth gate so
  // RATE_LIMIT_GLOBAL applies to all /api/* traffic regardless of auth outcome.
  app.use('/api', globalLimit);

  // V2 §7.2 / §18.2 — gate every /api/* route and /vault/builds (real
  // generated content). The UI shell static mount below is deliberately left
  // OPEN and unauthenticated: a remote browser must be able to load the app
  // before it can enter a token, and no secret lives in those assets (AD-8).
  app.use('/api', requireToken);
  app.use('/vault/builds', requireToken);

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

  // onnxruntime-web WASM runtime + ESM bundle (wake-word detection runs fully
  // client-side; served from node_modules so the app never loads from a CDN —
  // same convention as the mediapipe mount above).
  app.use('/vendor/onnxruntime', express.static(path.join(__dirname, '..', 'node_modules', 'onnxruntime-web', 'dist'), { etag: false, maxAge: 0, lastModified: false }));

  app.get('/health', (req, res) => { res.json({ ok: true, uptime: process.uptime() }); });

  app.get('/api/status', async (req, res) => {
    try {
      res.json(await probes.getStatus());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- /api/config (vad + wakeword) + /api/stats (W9: extracted to routes/config.js) ----
  require('./routes/config').mountConfigRoutes(app, {
    config, memory, goalsEffector, kanbanEffector, pipelineEffector
  });

  // ---- /api/media — Windows SMTC now-playing (W9: extracted to routes/media.js) ----
  // REMEDIATION P2-12: dispatchAction (this file's shared wrapper, defined
  // below — hoisted, safe to reference here) replaces a raw effectors.invoke
  // so /api/media/control's dispatches (the HUD media widget's play/pause/
  // volume buttons) get an audit line + episodic record like every other
  // dispatch surface. Previously this route bypassed dispatchAction entirely:
  // 42 of 43 media_key audit records from the 2026-07-29 incident had no
  // outcome at all — this route is why.
  require('./routes/media').mountMediaRoutes(app, { pcChild, leash, effectors, dispatchAction });

  // CONSISTENCY FIX (P7 vs NOVA UI, documented in ROADMAP.md P9): the byte-identical
  // ---- W9 (Phase 2 — Wiring Integrity): REST families extracted to
  // server/routes/<family>.js factories. Each factory mounts its routes on
  // `app` and pulls only what it needs from `deps`. See routes/*.js. ----
  require('./routes/goals').mountGoalsRoutes(app, { goalsEffector, auditRest });
  require('./routes/news').mountNewsRoutes(app);

  // ---- P22 — Forge build projects + checkpoint approval gates (W9: extracted) ----
  require('./routes/forge').mountForgeRoutes(app, { forge });
  require('./routes/checkpoints').mountCheckpointsRoutes(app, { checkpoints });

  // ---- kanban + kanban agent routes (W9: extracted to routes/kanban.js) ----
  require('./routes/kanban').mountKanbanRoutes(app, { kanbanEffector, agentActions, auditRest });

  // ---- pipeline + jobs (W9: extracted to routes/pipeline.js) ----
  require('./routes/pipeline').mountPipelineRoutes(app, { pipelineEffector, buildRunner, auditRest });

  // ---- /api/memory + /api/audit/recent (W9: extracted to routes/memory.js) ----
  require('./routes/memory').mountMemoryRoutes(app, { memory });

  // ---- /api/engagements — Engagement Layer (Phase 1 contract, W9: extracted) ----
  // Factory matches Phase 1's UI contract exactly (ui/public/js/views/
  // engagements.js): list returns a JSON array OR {engagements:[...]}; get
  // returns the record; transition body is {event, payload} and returns the
  // updated record; create takes {initialIntent, goalId}. All routes degrade
  // to 404 when the manager isn't wired. sanitizeErrorForClient passed via deps.
  require('./routes/engagements').mountEngagementsRoutes(app, {
    engagementManager, auditRest, sanitizeErrorForClient
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
        // Groq failed — surface it honestly; the UI shows a caption and the
        // operator knows to retry instead of hearing dead silence.
        bus.emit('health.anomaly', { kind: 'stt-failed', error: String(groqErr && groqErr.message || groqErr) });
        return res.status(503).json({ ok: false, error: 'stt-down', fallback: 'browser', message: 'Speech-to-text service is temporarily unavailable. Use browser speech recognition.' });
      }
      res.json({ ok: true, text });
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
  // security-reviewer finding (2026-07-30, step 2): the first version of this
  // function only called tokenOk() inside the `if (origin)` branch, so a
  // client presenting NO Origin header (any non-browser client, or — the
  // real-world case that matters — every connection MYTHOS ever sees when
  // it sits behind a reverse proxy that terminates the public connection and
  // forwards to Node over loopback) fell through to the isLoopback(info.req)
  // check and was accepted unconditionally, even with MYTHOS_AUTH_TOKEN set.
  // isLoopback() itself isn't spoofable (keys off req.socket.remoteAddress,
  // never a header), but "the TCP peer is 127.0.0.1" stopped being a safe
  // proxy for "this is the operator" the moment a reverse proxy is in the
  // picture — exactly the deployment this feature exists to protect. Fixed:
  // origin/loopback are now pure accept/reject gates layered UNDER a single
  // unconditional tokenOk() check, so a configured token is required on every
  // branch; tokenOk() itself is a no-op when no MYTHOS_AUTH_TOKEN is set, so
  // the loopback-no-token back-compat path is unaffected either way.
  function verifyClient(info, callback) {
    const origin = info.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      logger.warn('ws-upgrade-rejected', { reason: 'foreign origin', origin });
      return callback(false, 403, 'Forbidden');
    }
    if (!origin && !isLoopback(info.req)) {
      logger.warn('ws-upgrade-rejected', { reason: 'no origin, non-loopback' });
      return callback(false, 403, 'Forbidden');
    }
    if (!tokenOk(extractToken(info.req))) {
      logger.warn('ws-upgrade-rejected', { reason: 'bad or missing token' });
      return callback(false, 401, 'Unauthorized');
    }
    return callback(true);
  }

  const wss = new WebSocketServer({ server: httpServer, path: '/ws', verifyClient });

  function broadcastAll(msg) {
    const payload = JSON.stringify(msg);
    wss.clients.forEach((client) => {
      if (client.readyState === 1) client.send(payload);
    });
  }

  // Proactive speech — the entity speaks without an inbound utterance.
  // Synthesizes via edge-tts (same as reactive sendSpokenReply) and delivers
  // to a single connection as a synthetic reqId'd turn (see targeting below).
  // The browser voice-loop treats 'proactive-speech' like a turn start
  // without a user utterance. Falls back gracefully if edge-tts is down
  // (client uses speechSynthesis). Never throws — proactive speech is
  // best-effort.
  let proactiveSeq = 0;
  // Targeted delivery (same bug class as 27b2115/0af423f's boot-greeting
  // fix, generalized): tracks the most-recently-active WS connection (last
  // inbound message, set in ws.on('message') below) so reminders/nudges/
  // health speech reach the tab the operator is actually using instead of
  // every open tab at once. Explicit targetWs callers (the boot greeting)
  // are unaffected.
  let lastActiveWs = null;
  async function proactiveSpeak(text, targetWs) {
    if (!text || !wss) return;
    targetWs = targetWs || lastActiveWs;
    // Optional single-client delivery: the boot greeting passes the connection
    // that triggered it, and every other caller now defaults to the last
    // active connection, so a second open dashboard tab doesn't ALSO play the
    // same audio (two overlapping voices). If that client is gone by the time
    // we fire, fall back to the normal broadcast so the speech isn't lost.
    const sendOut = (targetWs && targetWs.readyState === 1)
      ? (msg) => { try { targetWs.send(JSON.stringify(msg)); } catch (_) { /* client vanished mid-send */ } }
      : broadcastAll;
    const reqId = 'proactive-' + Date.now() + '-' + (++proactiveSeq);
    const speak = sanitizeSpoken(text);
    sendOut({ type: 'proactive-speech', reqId, text, speak });
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
    // Item B: register an abort controller so a 'stop' for this reqId (barge-in
    // mid-proactive-speech) can cancel remaining chunk synthesis below.
    const ctrl = new AbortController();
    inflightSpeech.set(reqId, ctrl);
    try {
      if (ttsUp) {
        const chunks = splitSentences(speak);
        for (let i = 0; i < chunks.length; i++) {
          if (ctrl.signal.aborted) break;
          let audioB64 = null;
          try {
            const buf = await edgeTts.synthesize({ text: chunks[i], voice: config.VOICE_TTS_VOICE });
            audioB64 = buf.toString('base64');
          } catch (err) {
            logger.warn('edge-tts.proactive-chunk-failed', { error: err.message, index: i });
          }
          if (ctrl.signal.aborted) break;
          sendOut({ type: 'speech-chunk', reqId, index: i, total: chunks.length, audioB64, text: chunks[i] });
        }
      }
      // chunked forced true on abort (even with zero chunks sent): routes the
      // client's 'done' handling through the session-checked chunk-queue path,
      // never the non-chunked speechSynthesis fallback (which would otherwise
      // speak the just-barged-in-on reply after the fact).
      sendOut({ type: 'done', reqId, say: text, speak, chunked: ctrl.signal.aborted ? true : ttsUp, proactive: true });
    } finally {
      inflightSpeech.delete(reqId);
    }
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
      // REMEDIATION P2-12: this hardcoded 'voice' unconditionally, even for
      // handleConfirmReply's confirm-accept path below (a T3+ action a human
      // approved via a HUD click, not something voice itself decided) —
      // callers now pass the real channel; 'voice' stays the default so the
      // primary (and originally only) caller is unaffected.
      channel: ctx.channel || 'voice',
      traceId: ctx.traceId || null,
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
    // BUG-017: pass the real effector hub so the voice catalog is built from
    // actual registrations (see buildCatalogFromHub in voice-agent.js) instead
    // of the hand-maintained CATALOG_RAW list alone — this is what makes a
    // newly-registered effector (e.g. capture_screenshot) show up on the voice
    // channel automatically.
    voiceAgent = createVoiceAgent({ brain, leash, dispatch: dispatchAction, bus, config: config, hub: effectors, getCapabilityDigest: getCapabilityDigest });
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

  // ---- Boot greeting (JARVIS-style) ----
  // Fired once per boot, on the FIRST dashboard connection: a persona-voiced
  // spoken greeting with a one-line situational brief, delivered through the
  // same proactiveSpeak() path as every other entity-initiated speech. The
  // "upgraded since last boot" check compares the current git ref against
  // Identity/last-boot.json (written at construction, so the diff survives
  // even if the brain is offline when the client connects).
  // Disable with BOOT_GREETING=false (env, same passthrough convention as
  // VOICE_INTAKE_IDLE_MS above). Also suppressed under the node test runner
  // (NODE_TEST_CONTEXT): the greeting fires 2.5s after a WS connection and
  // its TTS-probe/brain fetches leave sockets open past the last test, which
  // wedges the test-file child process (the runner then waits forever).
  let bootGreetingFired = process.env.BOOT_GREETING === 'false' || !!process.env.NODE_TEST_CONTEXT;
  const LAST_BOOT_PATH = 'Identity/last-boot.json';
  const bootUpgrade = { upgraded: false, changes: [] };
  try {
    const v = version.getVersion();
    const prev = memory.fs.readJSON(LAST_BOOT_PATH, null);
    if (prev && prev.gitRef && prev.gitRef !== v.gitRef) {
      bootUpgrade.upgraded = true;
      // Commit subjects newer than the previous boot's ref (newest first,
      // capped at 3). If the old ref scrolled out of the 15-line window,
      // fall back to the newest 3.
      const prevHash = String(prev.gitRef).replace(/-dirty$/, '');
      let cut = v.recentChanges.length;
      for (let i = 0; i < v.recentChanges.length; i++) {
        if (prevHash && v.recentChanges[i].indexOf(prevHash) === 0) { cut = i; break; }
      }
      bootUpgrade.changes = v.recentChanges
        .slice(0, Math.min(cut, 3))
        .map((line) => line.replace(/^\S+\s+/, ''));
    }
    memory.fs.writeJSON(LAST_BOOT_PATH, { gitRef: v.gitRef, bootDate: v.bootDate });
  } catch (err) {
    logger.warn('boot-greeting.version-check-failed', { error: err.message });
  }

  async function deliverBootGreeting(targetWs) {
    const hour = new Date().getHours();
    const salutation = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const facts = [];
    try {
      facts.push('Local time: ' + new Date().toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' }));
    } catch (_) {}
    try {
      if (goalsEffector && typeof goalsEffector.stats === 'function') {
        const gs = goalsEffector.stats();
        facts.push('Goals: ' + gs.active + ' active, ' + gs.done + ' done');
      }
    } catch (_) {}
    try {
      if (probes) {
        const st = await probes.getStatus();
        const down = ['nim', 'groq', 'mistral'].filter((id) => {
          try { return isProviderDown(id, st.providers); } catch (_) { return false; }
        });
        facts.push(down.length ? 'AI providers down: ' + down.join(', ') : 'All AI providers online');
      }
    } catch (_) {}
    if (bootUpgrade.upgraded) {
      facts.push('You received a code upgrade since your last boot' +
        (bootUpgrade.changes.length ? ' — recent changes: ' + bootUpgrade.changes.join('; ') : ''));
    }
    let text = null;
    try {
      const result = await Promise.race([
        brain.think({
          lane: 'simple',
          messages: [{
            role: 'user',
            content: 'You just finished booting and your operator opened the dashboard. ' +
              'Greet them aloud the way JARVIS greets Tony Stark: brief, in character, ' +
              'with a one-line situational status woven in naturally. Facts you may use:\n- ' +
              facts.join('\n- ') + '\n' +
              'Reply with ONLY the spoken greeting: one to three short sentences, plain natural speech, no markdown, no quotes.',
          }],
          source: 'boot-greeting',
        }),
        new Promise((resolve) => {
          const t = setTimeout(() => resolve(null), 12000);
          if (t.unref) t.unref();
        }),
      ]);
      if (result && !result.offline && result.content) {
        text = String(result.content).trim().replace(/^["']+|["']+$/g, '').slice(0, 400);
      }
    } catch (err) {
      logger.warn('boot-greeting.brain-failed', { error: err.message });
    }
    if (!text) {
      // Canned persona fallback — the greeting must never depend on the brain.
      text = salutation + ', sir. ' + (config.MYTHOS_NAME || 'MYTHOS') + ' online.' +
        (bootUpgrade.upgraded ? ' I have received an upgrade since we last spoke.' : ' All systems nominal.');
    }
    await proactiveSpeak(text, targetWs);
  }

  // Calendar reminders — proactive speech when a reminder fires due.
  bus.subscribe('reminder.due', (e) => {
    if (e && e.payload && e.payload.text) proactiveSpeak('Reminder: ' + e.payload.text);
  });

  // Daily planner (Phase 3 Jarvis upgrade) — proactive speech for the morning
  // brief, stall check-ins, and evening review. Same bus.subscribe +
  // proactiveSpeak() pattern as reminder.due above.
  bus.subscribe('plan.morning-brief', (e) => {
    if (e && e.payload && e.payload.text) proactiveSpeak(e.payload.text);
  });
  bus.subscribe('plan.checkin', (e) => {
    if (e && e.payload && e.payload.text) proactiveSpeak(e.payload.text);
  });
  bus.subscribe('plan.evening-review', (e) => {
    if (e && e.payload && e.payload.text) proactiveSpeak(e.payload.text);
  });

  // Gmail triage — proactive speech when the gmail-sensor finds genuinely new
  // unread mail. Mirrors the reminder.due wiring above: same bus.subscribe +
  // proactiveSpeak() pattern, different event/payload shape.
  bus.subscribe('gmail.unread-batch', (e) => {
    if (!e || !e.payload || !e.payload.count) return;
    const count = e.payload.count;
    const messages = e.payload.messages || [];
    const subjects = messages.slice(0, 3).map((m) => m.subject).filter(Boolean);
    const noun = count === 1 ? 'email' : 'emails';
    let text = `You have ${count} new ${noun}`;
    if (subjects.length) text += `, including ${subjects.join(', ')}`;
    proactiveSpeak(text);
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

    // First dashboard connection this boot → spoken greeting + status brief.
    // Small delay so the client finishes wiring its WS handlers and voice
    // machinery before the proactive-speech broadcast lands.
    if (!bootGreetingFired) {
      bootGreetingFired = true;
      const greetTimer = setTimeout(() => {
        // Deliver to THIS connection only — with two dashboard tabs open, a
        // broadcast greeting plays twice in overlap ("two voices").
        deliverBootGreeting(ws).catch((err) => logger.warn('boot-greeting.failed', { error: err.message }));
      }, 2500);
      if (greetTimer.unref) greetTimer.unref();
    }

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
      // Item B: register an abort controller so a 'stop' for this reqId
      // (barge-in) can cancel remaining chunk synthesis below — otherwise
      // edge-tts keeps synthesizing chunks nobody will hear after the client
      // has already stopped playback locally.
      const ctrl = new AbortController();
      inflightSpeech.set(reqId, ctrl);
      try {
        if (ttsUp && chunks.length) {
          for (let i = 0; i < chunks.length; i++) {
            if (ctrl.signal.aborted) break;
            let audioB64 = null;
            try {
              const buf = await edgeTts.synthesize({ text: chunks[i], voice: config.VOICE_TTS_VOICE });
              audioB64 = buf.toString('base64');
            } catch (err) {
              logger.warn('edge-tts.chunk-failed', { error: err.message, index: i });
            }
            if (ctrl.signal.aborted) break;
            send({ type: 'speech-chunk', reqId, index: i, total: chunks.length, audioB64, text: chunks[i] });
          }
        }
        // chunked forced true on abort (even with zero chunks sent): routes the
        // client's 'done' handling through the session-checked chunk-queue path,
        // never the non-chunked speechSynthesis fallback (which would otherwise
        // speak the just-barged-in-on reply after the fact).
        send({ type: 'done', reqId, say, speak, chunked: ctrl.signal.aborted ? true : (ttsUp && chunks.length > 0), ...meta });
      } finally {
        inflightSpeech.delete(reqId);
      }
    }

    // Engagement gateway wiring (Phase 5a): creates a new engagement record
    // from the utterance's text as its initial intent, then immediately
    // transitions it DRAFT -> INTERVIEWING so the first question is ready.
    // engagement.draft / engagement.interviewing bus events (emitted inside
    // create()/transition()) relay to WS clients via the engagement.* bus
    // subscriptions below, so the dashboard Engagements view picks this up
    // live with no extra plumbing here. Mirrors voiceAgent.handleUtterance's
    // return shape ({say, actions}) so the rest of handleUtterance (history,
    // episodic write, sendSpokenReply) needs no special-casing.
    async function startEngagementInterview(text) {
      try {
        const record = engagementManager.engagement.create({ initialIntent: text, goalId: null });
        const started = await engagementManager.engagement.transition(record.id, 'startInterview', {});
        // transition()'s own event payload carries the first question, but
        // that payload isn't threaded back through its return value — reuse
        // the same interview sub-module (pure/stateless given the record) to
        // get it here too, for the spoken reply.
        const int = engagementManager.interview.start({ id: record.id, initialIntent: text });
        const question = engagementManager.interview.getNextQuestion(int);
        const say = question
          ? `Got it — I've started an engagement to build this. First question: ${question.prompt}`
          : `Got it — I've started an engagement to build this.`;
        return {
          say,
          actions: [{ tool: 'engagement_start', args: {}, ok: true, summary: `engagement ${started.record.id} started` }],
        };
      } catch (err) {
        logger.warn('engagement-interview-start-failed', { error: err.message });
        return { say: `I couldn't start that engagement: ${sanitizeErrorForClient(err)}`, actions: [] };
      }
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
          // FIX G: exclude the boot greeting's own episodic record from being
          // recalled back into context and re-spoken on a fresh conversation
          // (empty history / idle-TTL wipe).
          var recalled = await recallWithTimeout(memory.recallHybrid(text, { limit: 8, excludeKinds: ['proactive-speech'] }), RECALL_TIMEOUT_MS);
          if (recalled === RECALL_TIMED_OUT) {
            logger.warn('memory-recall-timeout', { store: 'hybrid', timeoutMs: RECALL_TIMEOUT_MS });
            recalled = [];
          }
          if (recalled.length > 0) {
            var parts = [];
            for (var i = 0; i < recalled.length; i++) {
              var r = recalled[i];
              var snip = r.snippet || (r.record && r.record.summary) || '';
              if (snip) parts.push(r.store === 'semantic' ? '(fact) ' + snip : snip);
            }
            if (parts.length > 0) memoryContext = parts.join('\n');
          }
        } catch (err) { logger.warn('memory-recall-failed', { store: 'hybrid', error: err.message }); }

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

        // Engagement gateway (Phase 5a wiring): classify before handing off
        // to the general voice-agent/cortex path. "Build me X, interview me"
        // style utterances create an engagement record and start its
        // interview instead of being treated as ad-hoc chat/tool-calling.
        // Everything else — small talk, existing tool calls — is completely
        // unaffected and falls through to voiceAgent exactly as before.
        const gwClassification = conversationGateway ? conversationGateway.classify(text) : null;
        const result = (gwClassification && gwClassification.type === 'action' && gwClassification.action === 'startInterview' && engagementManager)
          ? await startEngagementInterview(text)
          : await voiceAgent.handleUtterance({
              text,
              // REMEDIATION P2-12: thread the WS message's own reqId through
              // as traceId so every action this turn dispatches can be
              // correlated back to it in the audit trail.
              ctx: { history: historyGet(), connectionId, memoryContext: memoryContext, traceId: msg.reqId },
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

        // P4 learning loop — count the completed turn; every ~15th fires a
        // background reflection pass (never blocks the reply).
        if (reflection && typeof reflection.noteTurn === 'function') {
          try { reflection.noteTurn(); } catch (_) {}
        }

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
        // REMEDIATION P2-12: this is a confirm-accept (a human clicked "yes"
        // on a T3+ popup), not the voice agent deciding on its own — label it
        // as such instead of the wrapper's default, and correlate it back to
        // the specific confirm popup that was approved.
        await dispatchAction(decision, { goalId: action.goalId, tier: action.tier, channel: 'confirm-accept', traceId: confirmId });
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
      // Targeted proactive speech (Phase 3c): the most-recently-active
      // connection is whichever tab last sent ANY message, not just an
      // utterance — keeps a silently-idle-but-focused tab as the target
      // over a tab that's just replaying subscriptions on load.
      lastActiveWs = ws;
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
      else if (msg.type === 'duck-audio') {
        duckAudio().catch(function() {}); // best-effort — never let a duck failure break voice
      }
      else if (msg.type === 'unduck-audio') {
        unduckAudio().catch(function() {});
      }
      else if (msg.type === 'close-panel-ack') {
        const p = pendingClosePanel.get(msg.reqId);
        if (p) {
          clearTimeout(p.timer);
          pendingClosePanel.delete(msg.reqId);
          p.resolve({ overlaysClosed: Number(msg.overlaysClosed) || 0, widgetsClosed: Number(msg.widgetsClosed) || 0 });
        }
      }
      // Item B: barge-in cancel — abort not-yet-sent TTS synthesis for this
      // reqId (sendSpokenReply's or proactiveSpeak's chunk loop). A stop for
      // an already-finished or unknown reqId is a harmless no-op.
      else if (msg.type === 'stop') {
        const ctrl = inflightSpeech.get(msg.reqId);
        if (ctrl) ctrl.abort();
      }
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
  // REMEDIATION P1-4: cortex.start() (which emits 'lifecycle.started') also
  // runs as part of ORDINARY boot sequencing, before later boot steps — if
  // one of those later steps then fails fast, the process exits without
  // 'lifecycle.alive' ever firing (src/core/lifecycle/index.js emits it
  // exactly once, only at the very end of a fully successful boot). Gate
  // honoring a cortex 'lifecycle.started' as "alive" on having already seen
  // a genuine 'lifecycle.alive' at least once — otherwise a mid-boot cortex
  // start could paint the HUD falsely alive moments before boot aborts.
  let bootComplete = false;
  bus.subscribe('lifecycle.*', (e) => {
    if (e.type === 'lifecycle.alive') { entityStatus = 'alive'; bootComplete = true; }
    // FIX B: a self-heal restart (healer's 'restart-cortex') calls cortex.stop()
    // then start() — start() emits 'lifecycle.started', not 'lifecycle.alive'
    // (that fires once at boot only), so without this the bridge never left
    // 'stopped' and the orb stuck on "ENTITY OFFLINE" for the rest of the process.
    if (bootComplete && e.type === 'lifecycle.started' && e.payload && e.payload.component === 'cortex') entityStatus = 'alive';
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
    // Bug found live-verifying BUG-040: this read `p.payload.text` — but `p`
    // IS the emitted payload already (bus.emit(type, payload) -> e.payload),
    // there is no nested `.payload` on it, so that was always undefined for
    // every sensor, not just screen-sensor. Every sensor sets `summary`;
    // perception.voice additionally sets `text` (the untruncated original,
    // vs. summary's 200-char clip) — prefer it when present, else summary.
    broadcastAll({ type: 'perception', payload: { channel: p.channel, kind: p.kind, salience: p.salience, text: p.text || p.summary } });
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

  // REMEDIATION P1-5: close_panel no longer relays through the bus — it calls
  // requestClosePanel() directly (below) and awaits the client's ack, so the
  // effector's return value can be honest about what actually closed.

  // Open-web events — relay web content payload (YouTube embed, weather, search
  // cards, etc.) so the dashboard opens a panel or floating widget.
  bus.subscribe('ui.open-web', (e) => {
    broadcastAll({ type: 'open-web', payload: e.payload });
  });

  // Widget commands — voice-driven HUD widget hide/show (manage_widget
  // effector, from-widgets.js). Payload is a pre-resolved {mode, targets}
  // list; widget-host.js applies it verbatim and persists visibility.
  bus.subscribe('ui.widget-command', (e) => {
    broadcastAll({ type: 'widget-command', payload: e.payload });
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
  // Recoveries — the other half of BUG-030: 'health.anomaly' feeds
  // anomalyLog/broadcast above, but 'health.healed' (probes.js down->up
  // transition, healer.js recovery emits) was never subscribed, so the health
  // card only ever accumulated "down" entries. Mirrors the anomaly
  // subscription exactly.
  bus.subscribe('health.healed', (e) => {
    anomalyLog.push(Object.assign({ healed: true }, e.payload));
    if (anomalyLog.length > 200) anomalyLog.shift();
    broadcastHealth(lastStatus);
    try {
      memory.episodic.write({
        kind: 'anomaly', channel: 'immune',
        summary: 'healed: ' + (e.payload.kind || 'unknown') + ' — ' + (e.payload.target || ''),
        detail: { kind: e.payload.kind, target: e.payload.target, playbookId: e.payload.playbookId, outcome: e.payload.outcome },
        outcome: 'healed', salience: 0.6,
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

  // Engagement layer WS relay (Phase 5a wiring): ui/public/js/views/engagements.js
  // calls ws.js's subscribe([...these exact 16 names], handleEngagementEvent) and
  // reads fields directly off the message (msg.engagementId, msg.status, ...) —
  // no {type, payload} envelope like most of this file's other relays, and the
  // WS message `type` must be the literal dotted event name itself so the
  // client's per-type broadcastHandlers map matches it. Every emit site for
  // these names already includes engagementId in its payload (index.js,
  // events.js, store.js), so spreading the payload onto the message is enough.
  // List matches ui/public/js/views/engagements.js's subscribe() call exactly.
  const ENGAGEMENT_WS_EVENTS = [
    'engagement.draft', 'engagement.interviewing', 'engagement.spec_ready',
    'engagement.plan_ready', 'engagement.approval_requested', 'engagement.approved',
    'engagement.stage_started', 'engagement.stage_completed', 'engagement.stage_failed',
    'engagement.repairing', 'engagement.verification_passed', 'engagement.verification_failed',
    'engagement.blocked', 'engagement.failed', 'engagement.completed', 'engagement.artifact_created',
  ];
  ENGAGEMENT_WS_EVENTS.forEach((name) => {
    bus.subscribe(name, (e) => {
      broadcastAll(Object.assign({ type: name }, e.payload));
    });
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
  return { app, httpServer, wss, stop, dispatchAction, ready, requestCameraFrame, requestClosePanel };
}

module.exports = { createServer };
