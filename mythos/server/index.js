'use strict';

// server/index.js — RW from app/server.js (1533 lines) per §14. Reuses: 127.0.0.1
// bind, CORS allowlist pattern, verifyWsClient, broadcastAll, graceful-shutdown drain.
// Everything NOVA had that isn't in the Migration Map (builds.js, radar/, video-render/,
// free-claude/, game/music/video/thumbnail studios, voice s2s/pc/browser child processes)
// is intentionally NOT ported — those stay in archive/nova/ per §16 "LEAVE in NOVA".

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');           // static-asset gzip (no `compression` dep)
const express = require('express');
const { WebSocketServer } = require('ws');
const { createLimiter } = require('./rate-limit');
const { createTtsChain } = require('../providers/tts');
const sttChain = require('../providers/stt');
const { splitSentences, createSentenceStreamer, truncateAtSentenceBoundary } = require('../src/core/effectors/voice');
const { sanitizeSpoken } = require('../src/core/voice/spoken-text');
const { createVoiceAgent, RULES } = require('../src/core/voice/voice-agent');
const { createConversationAnnouncer } = require('../src/core/conversation/announcer');
const spend = require('../src/core/brain/spend');
const { dispatchAction: sharedDispatch } = require('../src/core/effectors/dispatch-action');
// S2S (V2 §6-§10, merged-order step 4, Phase 5 wiring): Gemini Live transport,
// hub->functionDeclarations conversion, and the tool-adapter safety seam.
const { createLiveSession } = require('../src/core/voice/live-session');
const { buildFunctionDeclarations } = require('../src/core/voice/live-tools');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');
// BUG-113: a spoken first-person commitment ("I'll check X") must leave a
// record — logCommitmentIfPresent is a no-op unless the text matches the
// explicit commitment-phrase list, so ordinary replies are unaffected.
const { logCommitmentIfPresent } = require('../src/core/effectors/from-calendar');
const { createLatencyTracker } = require('../src/core/voice/latency-tracker');
const skillsLoader = require('../src/core/skills/loader');
// createNewsFeed moved to routes/news.js (W9 god-file decomposition).
const pcChild = require('../adapters/pc-child');
const version = require('../src/core/identity/version');
const { isProviderDown } = require('../src/core/immune/probes');
const { createPinSessionStore } = require('../src/core/security/pin-session');

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
  const identity = deps.identity;                      // S2S (Phase 5) — identity.persona() for buildLiveSystemInstruction (may be undefined in tests)
  const pinLock = deps.pinLock;                        // §7.3 — local PIN lock (may be undefined in tests)
  // Test-only seam, undefined in production (mirrors live-session.js's own
  // createSocket seam one level up): lets test/server-live-wiring.test.js
  // drive a fake Gemini socket through the real connection wiring without a
  // real network call. Passed straight through to createLiveSession's
  // createSocket option, which no-ops to the real 'ws' library when absent.
  const createLiveSocket = deps.createLiveSocket;

  // Phase 2 (AETHER-WIRING.md): nearest-device voice routing. aetherSpeak is
  // the aether sensor's speak() sink, wired in main.js only when the sensor
  // exists; speakViaAether() sends the text to the aggregator as {type:'say'}
  // and reports whether it actually went on the wire, so callers can fail
  // open to the local TTS chain when the aggregator socket is down.
  const aetherSpeak = (typeof deps.aetherSpeak === 'function') ? deps.aetherSpeak : null;
  const aetherAudioRoute = !!(config.AETHER_ENABLED && config.AETHER_AUDIO_ROUTE && aetherSpeak);
  function speakViaAether(text) {
    if (!aetherAudioRoute || !text) return false;
    try { return !!aetherSpeak(String(text)); } catch (_) { return false; }
  }

  // Task 12 (latency instrumentation, V2 Decision 1): a capped ring buffer of
  // real mic-stop -> first-audio-frame deltas, shared across both the batch
  // and S2S voice paths, surfaced honestly via /api/status (AD-5 — an
  // unmeasured turn contributes no sample rather than an estimate).
  const voiceLatencyTracker = createLatencyTracker();

  // V2 §11 row 5 (persona unclamp, deferred from step 3 to here because
  // live-session.js didn't exist yet): compose the FULL system prompt ONCE
  // per Live session rather than once per turn — RULES (not OUTPUT_CONTRACT;
  // Live's tool-calling is native functionDeclarations, not the batch path's
  // embedded-JSON contract) + persona + version + capability digest + skills
  // catalog. Same content as today's per-turn voice prompt, assembled once —
  // V2 estimates ~50x cheaper under S2S (today ~3,524 tokens x every turn).
  function buildLiveSystemInstruction() {
    const parts = [RULES];
    try {
      const persona = identity && typeof identity.persona === 'function' ? identity.persona() : null;
      if (persona) parts.push(persona);
    } catch (err) { logger.warn('live.persona-compose-failed', { error: err.message }); }
    try { parts.push(version.contextLine()); } catch (err) { logger.warn('live.version-compose-failed', { error: err.message }); }
    try {
      const digest = getCapabilityDigest ? getCapabilityDigest() : null;
      if (digest) parts.push(digest);
    } catch (err) { logger.warn('live.capability-digest-failed', { error: err.message }); }
    try { parts.push(skillsLoader.catalogBlock()); } catch (err) { logger.warn('live.skills-catalog-failed', { error: err.message }); }
    // BUG-079 (Stage 6, item #19): with no local time anywhere in the prompt,
    // MYTHOS said "have a good afternoon" at ~01:50 local — the operator had
    // to correct "a.m. not p.m." live-session.js's buildSetup() calls this
    // function fresh on every open()/reconnect (idle/max rotation, goAway),
    // so a long-running session's notion of "now" doesn't go stale either.
    try {
      const now = new Date();
      parts.push('Current local date/time: ' + now.toString());
    } catch (err) { logger.warn('live.time-compose-failed', { error: err.message }); }
    return parts.filter(Boolean).join('\n\n');
  }

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
  // Slice-2 (2026-07-31): env-overridable so the operator can tune the duck
  // depth and safety window without a code change. The restore path already
  // captures and restores the real pre-duck level (server/index.js duckAudio/
  // unduckAudio), so these only control the duck TARGET and the fallback timer.
  // Defaults unchanged (15 / 15000). Verify live before altering restore logic.
  const DUCK_VOLUME_LEVEL = Number(process.env.DUCK_VOLUME_LEVEL) || 15;
  const UNDUCK_SAFETY_MS = Number(process.env.UNDUCK_SAFETY_MS) || 15000; // restore even if the client never sends unduck (dropped connection, crash)
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

  // Track B1 — the PIN-unlock session store. Always constructed (cheap: one
  // closure, no I/O) so tokenOk() below has a stable thing to ask; whether it
  // can ever actually gate a request depends on pinSessionRequired() below,
  // which stays false (see it) unless the operator has both opted in via
  // PIN_SESSION_ENFORCE AND configured a real PIN.
  const pinSession = createPinSessionStore({ ttlMs: config.PIN_SESSION_TTL_MS });

  // True only once there is something real to enforce: the operator opted
  // in AND a PIN actually exists. Guards against two failure modes: (1) the
  // flag flipped on with no PIN yet would otherwise lock the operator out of
  // their own fresh install with no way to unlock; (2) a deployment with no
  // pinLock wired at all (tests, or a build that never constructs one) must
  // not change behavior just because the flag happens to be set.
  function pinSessionRequired() {
    return !!config.PIN_SESSION_ENFORCE && !!pinLock && typeof pinLock.isConfigured === 'function' && pinLock.isConfigured();
  }

  // Timing-safe compare — the one place in this file where timing matters.
  // No token configured => loopback-only mode, every request passes (total
  // back-compat: the default config exercises none of the branches below).
  //
  // Track B1 extends this rather than adding a fourth parallel auth
  // mechanism: a valid PIN-session token (issued by POST /api/pin/verify,
  // see routes/pin.js) travels through the EXACT SAME extractToken() chain
  // as the bearer token below (Authorization header -> ?token= -> the
  // mythos_token cookie) and is accepted here as an alternative credential.
  // It does not weaken the bearer-token path: a caller who already holds the
  // real MYTHOS_AUTH_TOKEN is unaffected either way (that secret gates the
  // network surface; the PIN gates local physical presence — see
  // pin-lock.js's header for why these stay two independent layers rather
  // than one subsuming the other).
  function tokenOk(presented) {
    if (pinSession.isValid(presented)) return true;
    if (!AUTH_TOKEN) return !pinSessionRequired();
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
  //
  // 2026-08-02: this was flattening EVERY non-matching message to the generic
  // fallback, including an effector's own honest fail() text (e.g. app_reply's
  // "whatsapp is not open, so there is no conversation to reply to"), which the
  // model then received as "An internal error occurred." — a real, spoken-safe
  // answer thrown away. live-tool-adapter.js's sanitizeResultError routes EVERY
  // effector failure through this same function, and now tags those values
  // effectorReason:true — set at the origin, the only place that knows a value is
  // a fail() string rather than a thrown exception. Everything untagged is still
  // generalized, so this stays deny-by-default. Tagged text is still scanned for
  // accidental path/stack/secret leakage (e.g. run_command's raw stderr) before
  // being allowed through unmodified.
  function looksLikeUnsafeLeak(msg) {
    return /[a-zA-Z]:\\|(?:^|[\s(])\/(?:home|Users|root|var|etc|tmp)\//.test(msg) ||
      /\bat\s+.+\(.+:\d+:\d+\)/.test(msg) ||
      /\b(?:api[_-]?key|secret|token|password|bearer)\b\s*[:=]/i.test(msg);
  }
  function sanitizeErrorForClient(err) {
    const msg = (err && err.message) || 'Unknown error';
    // Map common internal errors to safe user-facing strings
    if (/EACCES|EPERM/.test(msg)) return 'Permission denied — check file permissions.';
    if (/ENOSPC/.test(msg)) return 'Disk full — unable to write data.';
    if (/ENOENT/.test(msg)) return 'File not found.';
    if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(msg)) return 'Network request failed.';
    if (/all models failed/.test(msg)) return 'All AI providers are currently unavailable.';
    // An effector's own honest failure reason, EXPLICITLY tagged as such by
    // live-tool-adapter.js's sanitizeResultError — the one call site that knows
    // the value is a fail() string and not a thrown exception. Let it through so
    // the operator hears what actually went wrong, still scanned for accidental
    // path/stack/secret leakage (run_command hands back raw stderr) and still
    // capped so a pathological effector cannot ship an unbounded string.
    //
    // Deliberately gated on the tag rather than on "this has no .stack": that
    // inference would flip this whole function from deny-by-default to
    // allow-by-default for every hand-built error object anywhere in the server,
    // which is not a trade a WS-facing sanitizer should make.
    const isEffectorReason = typeof err === 'object' && err !== null && err.effectorReason === true;
    if (isEffectorReason && !looksLikeUnsafeLeak(msg)) {
      return msg.length > 500 ? msg.slice(0, 500) + '…' : msg;
    }
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
  //
  // Track B1 exemption: /api/pin/status and /api/pin/verify must stay
  // reachable with NO session, or PIN_SESSION_ENFORCE creates a lockout with
  // no way in — the lock screen can't even check whether a PIN is configured,
  // and the operator can't submit the PIN that would unlock everything else.
  // This is the standard "login endpoint stays public" shape, deliberately
  // narrow: /api/pin/set (changing an existing PIN) is NOT exempted, so once
  // a PIN is configured, changing it requires an already-unlocked session on
  // top of pin-lock.js's own currentPin proof. Both routes still pass
  // through globalLimit above (rate-limited) and pinLock's own 5-attempt/60s
  // lockout (src/core/security/pin-lock.js) unchanged.
  // NOTE: req.path inside an app.use('/api', ...) handler is already
  // relative to that mount point (e.g. '/pin/verify', not '/api/pin/verify')
  // — matched against the full path here would silently never hit and this
  // exemption would do nothing.
  const PIN_UNLOCK_EXEMPT_PATHS = new Set(['/pin/status', '/pin/verify']);
  app.use('/api', (req, res, next) => {
    if (PIN_UNLOCK_EXEMPT_PATHS.has(req.path)) return next();
    return requireToken(req, res, next);
  });
  app.use('/vault/builds', requireToken);

  // ---- static asset delivery: compression + caching -----------------------
  //
  // MEASURED 2026-07-31, and the reason the HUD felt slow to load. Every static
  // mount below used to be { etag: false, maxAge: 0, lastModified: false } with
  // no compression anywhere, so a browser re-downloaded EVERY byte, uncompressed,
  // on every single load:
  //   node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm   13.5 MB
  //     (the .jsep variant is 26.8 MB, ort.all.mjs another 5.9 MB)
  //   ui/public/models/wakeword/*.onnx                                 3.6 MB
  //   ui/public/js + css                                             489 KB -> 129 KB gzipped (73% off)
  // Two fixes, both standard and neither touching app logic:
  //
  // 1. CACHING. Version-pinned immutable assets (vendored node_modules runtimes,
  //    the wake-word ONNX models) get a long immutable max-age, so the multi-MB
  //    WASM is fetched once instead of every load. App JS/CSS keeps max-age 0 —
  //    the operator must never see a stale HUD after an edit — but now sends an
  //    ETag, so a reload revalidates and gets a 304 instead of re-sending the
  //    whole file. Fresh-content guarantee unchanged; bytes on the wire collapse.
  //
  // 2. COMPRESSION, for the TEXT assets only (js/mjs/css/html/svg — 489 KB raw,
  //    129 KB gzipped, a 73% cut on first load). Done by gzipping each file ONCE
  //    on first request and caching the buffer, then serving it with an explicit
  //    Content-Length. That shape is deliberate: the first attempt wrapped
  //    res.write/res.end around a zlib stream ahead of express.static, and it
  //    HUNG every request — static had already set Content-Length to the RAW
  //    size, so the browser sat waiting for bytes that the shorter gzipped body
  //    never delivered. Precompressing sidesteps stream interception entirely.
  //    No `compression` dep: this repo gates its dependency count (7, and
  //    ROADMAP tracks growth as a regression).
  //    WASM/ONNX are deliberately NOT compressed here — they are 13.5 MB and
  //    3.6 MB, so holding gzipped copies in memory is a poor trade when the
  //    immutable caching above already removes them from every load after the
  //    first.
  const IMMUTABLE_MAX_AGE = '365d';
  const TEXT_ASSET_RE = /\.(js|mjs|css|html|svg)$/i;
  const UI_PUBLIC_DIR = path.join(__dirname, '..', 'ui', 'public');
  const NODE_MODULES_DIR = path.join(__dirname, '..', 'node_modules');
  // URL prefix -> directory, longest prefix first. The vendor roots are included
  // because onnxruntime's ort.all.mjs alone is 5.8 MB of plain JavaScript, and
  // first-load time is the actual complaint; .wasm stays out of TEXT_ASSET_RE, so
  // the 13.5 MB binaries are handled by immutable caching rather than by holding
  // compressed copies in memory.
  const GZIP_ROOTS = [
    { prefix: '/vendor/onnxruntime', dir: path.join(NODE_MODULES_DIR, 'onnxruntime-web', 'dist'), immutable: true },
    { prefix: '/vendor/mediapipe', dir: path.join(NODE_MODULES_DIR, '@mediapipe', 'tasks-vision'), immutable: true },
    { prefix: '', dir: UI_PUBLIC_DIR, immutable: false },
  ];
  const gzipCache = new Map(); // absolute path -> { buf, mtimeMs }

  function immutableHeaders(res) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }

  // Revalidate-always for app assets: max-age 0 + ETag => 304 on an unchanged
  // file. `models/` is exempt because those ONNX blobs are version-pinned
  // binaries, not editable source.
  function appAssetHeaders(res, filePath) {
    if (filePath && /[\\/]models[\\/]/.test(filePath)) return immutableHeaders(res);
    res.setHeader('Cache-Control', 'no-cache');
  }

  // Serve a gzipped UI text asset with an explicit Content-Length, or fall
  // through to express.static untouched. Never throws: any miss, unreadable
  // file, or path escape hands off to the normal static handler.
  function gzipTextAssets(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!TEXT_ASSET_RE.test(req.path)) return next();
    if (!/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) return next();

    let decoded;
    try {
      decoded = decodeURIComponent(req.path);
    } catch (_) {
      return next();                       // malformed percent-encoding
    }

    const root = GZIP_ROOTS.find((r) => r.prefix === '' || decoded.startsWith(r.prefix + '/'));
    if (!root) return next();
    const sub = root.prefix ? decoded.slice(root.prefix.length) : decoded;
    const abs = path.resolve(root.dir, '.' + sub);

    // Path-escape guard: never serve outside the matched root, even though
    // express.static would also refuse — this handler reads the file itself.
    const rel = path.relative(root.dir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return next();

    let stat;
    try {
      stat = fs.statSync(abs);
      if (!stat.isFile()) return next();
    } catch (_) {
      return next();                       // not found -> let static 404 it
    }

    let entry = gzipCache.get(abs);
    if (!entry || entry.mtimeMs !== stat.mtimeMs) {
      // mtime keyed, so editing a file invalidates its cached copy — the
      // no-cache/ETag policy above is worthless if the server itself serves a
      // stale compressed body.
      try {
        entry = { buf: zlib.gzipSync(fs.readFileSync(abs)), mtimeMs: stat.mtimeMs };
      } catch (_) {
        return next();
      }
      gzipCache.set(abs, entry);
    }

    const etag = 'W/"' + stat.size.toString(16) + '-' + stat.mtimeMs.toString(16) + '-gzip"';
    res.setHeader('Vary', 'Accept-Encoding');
    // Same caching policy the matching express.static mount would have applied:
    // version-pinned vendor bytes are immutable, editable app source revalidates.
    res.setHeader('Cache-Control', root.immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.setHeader('ETag', etag);
    res.setHeader('Content-Type', express.static.mime.lookup(abs) || 'application/octet-stream');
    res.setHeader('Content-Encoding', 'gzip');

    if (req.headers['if-none-match'] === etag) {
      res.removeHeader('Content-Encoding');
      return res.status(304).end();
    }
    res.setHeader('Content-Length', entry.buf.length);
    if (req.method === 'HEAD') return res.end();
    return res.end(entry.buf);
  }

  app.use(gzipTextAssets);

  app.use(express.static(path.join(__dirname, '..', 'ui', 'public'), {
    etag: true, lastModified: true, maxAge: 0, setHeaders: appAssetHeaders,
  }));

  // Build artifacts (open_artifact spawns the OS browser pointed at these
  // URLs) — scoped to exactly vault/builds, not the whole vault root, which
  // also holds Episodic/Semantic/Identity/Audit/Checkpoints that should never
  // be served as plain static files. Generated content the operator iterates on,
  // so it must never be cached beyond revalidation.
  app.use('/vault/builds', express.static(memory.fs.vaultPath('builds'), {
    etag: true, lastModified: true, maxAge: 0,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));

  // MediaPipe tasks-vision runtime assets (gesture recognition runs fully
  // client-side; these are the WASM runtime + ESM bundle served from
  // node_modules so the app never loads from a CDN). Immutable: the version is
  // pinned in package.json, so the only way these bytes change is a dep bump.
  app.use('/vendor/mediapipe', express.static(path.join(__dirname, '..', 'node_modules', '@mediapipe', 'tasks-vision'), {
    etag: true, lastModified: true, maxAge: IMMUTABLE_MAX_AGE, immutable: true, setHeaders: immutableHeaders,
  }));

  // onnxruntime-web WASM runtime + ESM bundle (wake-word detection runs fully
  // client-side; served from node_modules so the app never loads from a CDN —
  // same convention as the mediapipe mount above). This is the single heaviest
  // thing the HUD loads; caching it is the largest load-time win available.
  app.use('/vendor/onnxruntime', express.static(path.join(__dirname, '..', 'node_modules', 'onnxruntime-web', 'dist'), {
    etag: true, lastModified: true, maxAge: IMMUTABLE_MAX_AGE, immutable: true, setHeaders: immutableHeaders,
  }));

  app.get('/health', (req, res) => { res.json({ ok: true, uptime: process.uptime() }); });

  // BUG-111: the Gmail sensor is constructed AFTER createServer() (main.js's
  // 'sensors' step runs later than 'server'), so main.js injects the poll-count
  // getter via setGmailPollCountGetter below — same setter-injection pattern
  // already used for requestCameraFrame/requestClosePanel above.
  let gmailPollCountGetter = null;
  function setGmailPollCountGetter(fn) { gmailPollCountGetter = typeof fn === 'function' ? fn : null; }

  app.get('/api/status', async (req, res) => {
    try {
      const status = await probes.getStatus();
      // Task 12: real voiceLatency samples only — see latency-tracker.js.
      // BUG-111: surface real Gmail triage poll count so quota burn is visible
      // instead of inferred after the fact — null when the sensor never ran
      // (unconfigured, or GMAIL_TRIAGE_MODE:'off').
      res.json(Object.assign({}, status, {
        voiceLatency: voiceLatencyTracker.stats(),
        gmailTriagePollCount: gmailPollCountGetter ? gmailPollCountGetter() : null,
      }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- /api/config (vad + wakeword) + /api/stats (W9: extracted to routes/config.js) ----
  require('./routes/config').mountConfigRoutes(app, {
    config, memory, goalsEffector, kanbanEffector, pipelineEffector,
    // Undefined in production — routes/config.js then resolves the real
    // ui/public/models/wakeword path. Only test/wakeword.test.js sets it, so
    // that test no longer has to move the operator's real models aside; see
    // the comment at the resolution site for the EPERM data-loss it prevents.
    wakewordModelsDir: deps.wakewordModelsDir,
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
  // Host CPU/RAM/disk for the SYSTEM and CORES widgets. Nothing in the repo
  // read os.cpus()/totalmem() before this — sensors/metric.js is provider
  // health despite the name. No deps: it reads the OS directly.
  require('./routes/system').mountSystemRoutes(app);

  // ---- P22 — Forge build projects + checkpoint approval gates (W9: extracted) ----
  require('./routes/forge').mountForgeRoutes(app, { forge });
  require('./routes/checkpoints').mountCheckpointsRoutes(app, { checkpoints });

  // ---- kanban + kanban agent routes (W9: extracted to routes/kanban.js) ----
  require('./routes/kanban').mountKanbanRoutes(app, { kanbanEffector, agentActions, auditRest });

  // ---- pipeline + jobs (W9: extracted to routes/pipeline.js) ----
  require('./routes/pipeline').mountPipelineRoutes(app, { pipelineEffector, buildRunner, agentActions, auditRest });

  // ---- /api/memory + /api/audit/recent (W9: extracted to routes/memory.js) ----
  require('./routes/memory').mountMemoryRoutes(app, { memory });

  // ---- /api/pin — §7.3 local PIN lock (separate from Task 6's token gate
  // both of these routes already sit behind). pinSession (Track B1) lets a
  // successful /api/pin/verify issue the real session tokenOk() above
  // checks, so the PIN screen becomes actual access control instead of a
  // visual deterrent. ----
  require('./routes/pin').mountPinRoutes(app, { pinLock, pinSession });

  // ---- /api/engagements — Engagement Layer (Phase 1 contract, W9: extracted) ----
  // Factory matches Phase 1's UI contract exactly (ui/public/js/views/
  // engagements.js): list returns a JSON array OR {engagements:[...]}; get
  // returns the record; transition body is {event, payload} and returns the
  // updated record; create takes {initialIntent, goalId}. All routes degrade
  // to 404 when the manager isn't wired. sanitizeErrorForClient passed via deps.
  require('./routes/engagements').mountEngagementsRoutes(app, {
    engagementManager, auditRest, sanitizeErrorForClient
  });

  // Speech-to-text — VOICE_STT_CHAIN decides who transcribes (providers/stt.js;
  // default 'groq', unchanged behavior for anyone who sets nothing). Replaces
  // the browser's own SpeechRecognition: Google's cloud speech backend and
  // Chrome's on-device model download are both unreachable on this network
  // ('network' error / stalled 'downloading' state, confirmed live); Groq's host
  // is the same one already proven reachable all session for chat completions.
  // express.raw() is scoped to this one route only — the global express.json()
  // above only matches 'application/json' and won't consume this body.
  app.post('/api/voice/transcribe', express.raw({ type: '*/*', limit: '15mb' }), expensiveLimit, async (req, res) => {
    try {
      let text;
      try {
        text = await sttChain.transcribe(req.body, req.headers['content-type'], config);
      } catch (sttErr) {
        // Every provider in the chain failed — surface it honestly; the UI
        // shows a caption and the operator knows to retry instead of hearing
        // dead silence.
        bus.emit('health.anomaly', { kind: 'stt-failed', error: String(sttErr && sttErr.message || sttErr) });
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

  // ONE VOICE PER SESSION. The chain resolves once and sticks, so the boot greeting,
  // every proactive announcement and every batch reply all come from the SAME engine
  // — the operator must never hear the voice change partway through a session. It
  // only moves on a real provider failure, and then stays moved (see providers/tts.js).
  // synthesize() returns { audio, mime, provider }: the engines emit different
  // containers (edge=MP3, gemini/piper=WAV) so the mime travels PER CHUNK.
  const tts = createTtsChain({ config, logger });
  logger.info('tts.chain', { chain: tts.chainNames.join(',') });
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
  // Task 5 (step 5, alarms/timers) — the bundled audible-alert tone. Loaded
  // once and cached as base64 (a small static asset, never re-read per call).
  // REMINDER_ALERT_SOUND overrides the path; default is the bundled WAV.
  // Missing/unreadable file degrades honestly: no alert chunk gets sent, the
  // reminder still speaks normally — never throws.
  let _alertToneB64;
  function alertToneBase64() {
    if (_alertToneB64 !== undefined) return _alertToneB64;
    try {
      const p = process.env.REMINDER_ALERT_SOUND || path.join(__dirname, '..', 'ui', 'public', 'audio', 'alert.wav');
      _alertToneB64 = fs.readFileSync(p).toString('base64');
    } catch (err) {
      logger.warn('reminder.alert-sound-unavailable', { error: err.message });
      _alertToneB64 = null;
    }
    return _alertToneB64;
  }
  // Targeted delivery (same bug class as 27b2115/0af423f's boot-greeting
  // fix, generalized): tracks the most-recently-active WS connection (last
  // inbound message, set in ws.on('message') below) so reminders/nudges/
  // health speech reach the tab the operator is actually using instead of
  // every open tab at once. Explicit targetWs callers (the boot greeting)
  // are unaffected.
  let lastActiveWs = null;
  async function proactiveSpeak(text, targetWs, opts) {
    if (!text || !wss) return;
    targetWs = targetWs || lastActiveWs;
    // Stage 2 (BUG-060, "two voices speaking simultaneously" —
    // vault/Incidents/2026-07-31.jsonl): if this connection has an open Gemini
    // Live session, Live's own PCM playback (pcm-player.js) is already the
    // entity's voice — emitting edge-tts speech-chunk audio on top of it is
    // what produced the second, overlapping voice. Route the text through the
    // SAME [SYSTEM] sendText channel reportLateOutcome() uses
    // (src/core/voice/live-tool-adapter.js ~line 232) so Gemini itself speaks
    // it, and skip edge-tts entirely for this connection. No Live session open
    // (the pre-existing/legacy path) behaves exactly as before.
    const liveSession = (targetWs && typeof targetWs.getLiveSession === 'function') ? targetWs.getLiveSession() : null;
    if (liveSession && liveSession.isOpen()) {
      liveSession.sendText(`[SYSTEM] ${text}`);
      try {
        memory.episodic.write({
          kind: 'proactive-speech', channel: 'proactive',
          summary: text.slice(0, 100),
          detail: { text: text, proactive: true, via: 'live' },
          salience: 0.5,
        });
      } catch (_) {}
      return;
    }
    const alertB64 = (opts && opts.alertSound) ? alertToneBase64() : null;
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
    // Phase 2 (AETHER-WIRING): when enabled, the announcement goes to the
    // Aether aggregator (nearest-device TTS) instead of the local chain. The
    // client still gets its 'proactive-speech' + caption-only 'done' pair
    // (chunked:true, zero chunks — voice-loop.js deliverReply finishes the
    // turn silently) so the HUD shows what was said without the local machine
    // speaking it. Aggregator down -> speakViaAether() false -> local TTS.
    if (speakViaAether(speak)) {
      sendOut({ type: 'proactive-speech', reqId, text, speak });
      sendOut({ type: 'done', reqId, say: text, speak, chunked: true, proactive: true });
      return;
    }
    sendOut({ type: 'proactive-speech', reqId, text, speak });
    let ttsUp = false;
    try {
      ttsUp = await tts.isAvailable();
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
      // Always split — same fix and same reason as sendSpokenReply() below (see
      // its comment). With TTS down this used to send zero text chunks, so the
      // client spoke the whole thing as one SpeechSynthesisUtterance and Chrome
      // clipped the tail. The boot greeting rides this path, which is why the
      // operator heard the greeting cut short too.
      const textChunks = splitSentences(speak);
      // Alert tone counts as chunk 0 of the SAME reqId's sequence (not a
      // separate turn) so it plays through the existing chunk-queue ordering
      // instead of racing a second, unregistered reqId on the client.
      const totalChunks = (alertB64 ? 1 : 0) + textChunks.length;
      let idx = 0;
      if (alertB64 && !ctrl.signal.aborted) {
        sendOut({ type: 'speech-chunk', reqId, index: idx, total: totalChunks, audioB64: alertB64, mime: 'audio/wav', text: '' });
        idx++;
      }
      for (let i = 0; i < textChunks.length; i++) {
        if (ctrl.signal.aborted) break;
        let audioB64 = null;
        let chunkMime;
        if (ttsUp) {
          try {
            const out = await tts.synthesize({ text: textChunks[i], signal: ctrl.signal });
            audioB64 = out.audio.toString('base64');
            chunkMime = out.mime;
          } catch (err) {
            logger.warn('tts.proactive-chunk-failed', { error: err.message, index: i });
          }
        }
        if (ctrl.signal.aborted) break;
        sendOut({ type: 'speech-chunk', reqId, index: idx, total: totalChunks, audioB64, mime: chunkMime, text: textChunks[i] });
        idx++;
      }
      // chunked forced true on abort, or when the alert tone alone was sent
      // (even with edge-tts down): routes the client's 'done' handling through
      // the session-checked chunk-queue path, never the non-chunked
      // speechSynthesis fallback (which would otherwise speak the just-
      // barged-in-on reply after the fact, or skip the alert chunk's queue).
      const chunked = ctrl.signal.aborted ? true : (totalChunks > 0);
      sendOut({ type: 'done', reqId, say: text, speak, chunked, proactive: true });
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

  // Two-brain key separation (.env.example's HERMES_PROVIDER_KEY block): the
  // Hermes build engine and the Mythos brain must not share one Mistral
  // workspace key — a 20-60-call build then eats the same rate limit as voice,
  // vision and memory consolidation, and voice turns fall back to the weakest
  // model in the chain mid-conversation. Logs a BOOLEAN only; never a key value.
  if (config.MISTRAL_API_KEY && process.env.HERMES_PROVIDER_KEY &&
      config.MISTRAL_API_KEY === process.env.HERMES_PROVIDER_KEY) {
    logger.warn('hermes.shared-provider-key', { sameAsMistral: true });
  }

  // BUG-112: one greeting-shaped announcement per session, shared across every
  // source (boot greeting here, the daily planner's morning brief below) via
  // conversationAnnouncer's own isRecent/markAnnounced dedup map — reusing its
  // existing 5-minute window instead of inventing a second dedup mechanism.
  const GREETING_DEDUP_KEY = 'greeting:session';

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
    // Session carryover: greet by picking up the thread instead of booting
    // cold. recall('') with a kind filter scores by recency alone (episodic.js),
    // so this is simply the three most recent conversation records — no new
    // query path. Best-effort: a greeting must never depend on memory.
    try {
      const recent = memory.episodic.recall('', { kind: 'conversation', limit: 3, windowDays: 3 }) || [];
      const lines = recent
        .map((hit) => (hit.record && hit.record.summary) || hit.snippet || '')
        .filter(Boolean)
        .slice(0, 3);
      if (lines.length) facts.push('Last time we spoke: ' + lines.join(' / '));
    } catch (_) { /* no vault, fake fs, or empty history — greet cold */ }
    let text = null;
    try {
      const result = await Promise.race([
        brain.think({
          lane: 'simple',
          messages: [{
            role: 'user',
            content: 'You just finished booting and your operator opened the dashboard. ' +
              'Greet them aloud the way JARVIS greets Tony Stark: brief, in character, ' +
              'with a one-line situational status woven in naturally. ' +
              // BUG-112: the model previously free-guessed the time of day ("now that
              // the evening's begun") and contradicted the correctly-computed
              // salutation sitting unused in this same function. Give it the real
              // answer and forbid inventing another one — same no-fabrication
              // pattern as immune/explainer.js's tool-naming clause.
              'The correct greeting for right now is exactly "' + salutation + '" — open with it or a natural ' +
              'equivalent for that same time of day, and do not invent, guess, or state a different time of day ' +
              '(do not say "morning" if the salutation says afternoon or evening, and so on). ' +
              'Facts you may use:\n- ' +
              facts.join('\n- ') + '\n' +
              'If a "Last time we spoke" fact is present, open by picking up that thread in half a sentence, ' +
              'the way someone resumes a conversation rather than starting one.\n' +
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
        // Cap at a sentence (or at worst a word) boundary, never mid-word.
        // truncateAtSentenceBoundary() exists for exactly this and was dead code
        // — defined, exported, and called by nothing — while both spoken paths
        // hard-sliced. A greeting chopped to "...and your calendar is cle" is a
        // cut the operator hears.
        text = truncateAtSentenceBoundary(String(result.content).trim().replace(/^["']+|["']+$/g, ''), 400);
      }
    } catch (err) {
      logger.warn('boot-greeting.brain-failed', { error: err.message });
    }
    if (!text) {
      // Canned persona fallback — the greeting must never depend on the brain.
      text = salutation + ', sir. ' + (config.MYTHOS_NAME || 'MYTHOS') + ' online.' +
        (bootUpgrade.upgraded ? ' I have received an upgrade since we last spoke.' : ' All systems nominal.');
    }
    // Mark THE canonical "session opened" greeting so any other greeting-shaped
    // source (the daily planner's morning brief) sharing this dedup key is
    // suppressed for conversationAnnouncer's dedup window (BUG-112).
    try {
      if (conversationAnnouncer && typeof conversationAnnouncer.markAnnounced === 'function') {
        conversationAnnouncer.markAnnounced(GREETING_DEDUP_KEY);
      }
    } catch (_) {}
    await proactiveSpeak(text, targetWs);
  }

  // Calendar reminders — proactive speech when a reminder fires due.
  bus.subscribe('reminder.due', (e) => {
    if (e && e.payload && e.payload.text) {
      proactiveSpeak('Reminder: ' + e.payload.text, undefined, { alertSound: Boolean(e.payload.alertSound) });
    }
  });

  // Daily planner (Phase 3 Jarvis upgrade) — proactive speech for the morning
  // brief, stall check-ins, and evening review. Same bus.subscribe +
  // proactiveSpeak() pattern as reminder.due above.
  bus.subscribe('plan.morning-brief', (e) => {
    if (!e || !e.payload || !e.payload.text) return;
    // BUG-112: this handler used to call proactiveSpeak() directly with no
    // dedup check at all — the actual bypass that let a greeting-shaped
    // morning brief past conversationAnnouncer's dedup mechanism entirely
    // (that module never subscribes to plan.morning-brief, so its isRecent
    // guard never even ran for this source). Route it through the SAME
    // shared greeting key the boot greeting marks, so a morning brief firing
    // close to a boot greeting (or a re-fire of itself) is suppressed instead
    // of producing a second/third/fourth greeting-shaped utterance.
    try {
      if (conversationAnnouncer && typeof conversationAnnouncer.isRecent === 'function' &&
          conversationAnnouncer.isRecent(GREETING_DEDUP_KEY)) {
        return;
      }
    } catch (_) {}
    proactiveSpeak(e.payload.text);
    try {
      if (conversationAnnouncer && typeof conversationAnnouncer.markAnnounced === 'function') {
        conversationAnnouncer.markAnnounced(GREETING_DEDUP_KEY);
      }
    } catch (_) {}
  });
  bus.subscribe('plan.checkin', (e) => {
    if (e && e.payload && e.payload.text) proactiveSpeak(e.payload.text);
  });
  bus.subscribe('plan.evening-review', (e) => {
    if (e && e.payload && e.payload.text) proactiveSpeak(e.payload.text);
  });

  // Idle-mull follow-ups (cortex/index.js emits 'cortex.thought' after every
  // mull that produces something). Until now this event had ZERO subscribers:
  // the entity formed follow-up thoughts and never said one — the loose end you
  // asked it to track only surfaced if you happened to speak first, as prompt
  // context. Same delivery path and event class as reminder.due above.
  //
  // Four guards keep "alive" from becoming "annoying": only high-priority
  // thoughts (the mull prompt reserves that for an unanswered question or a
  // stalled goal/build — medium/low stay next-turn context), never within
  // FOLLOWUP_QUIET_MS of the operator's last turn (don't interrupt), at most one
  // per FOLLOWUP_MIN_GAP_MS (don't nag; 0 disables), and non-empty text.
  bus.subscribe('cortex.thought', (e) => {
    if (!e || !e.payload || !e.payload.text) return;
    if (e.payload.priority !== 'high') return;
    const quietMs = config.FOLLOWUP_QUIET_MS != null ? config.FOLLOWUP_QUIET_MS : 120000;
    const gapMs = config.FOLLOWUP_MIN_GAP_MS != null ? config.FOLLOWUP_MIN_GAP_MS : 3600000;
    if (!gapMs) return; // 0 = feature off
    const now = Date.now();
    if (lastTurnAt && now - lastTurnAt < quietMs) return;
    if (lastFollowupAt && now - lastFollowupAt < gapMs) return;
    lastFollowupAt = now;
    proactiveSpeak(String(e.payload.text));
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

  // Conversation memory (CA of NOVA app/lib/voice/intake.js). SERVER-scoped, not
  // per-connection: the browser reconnects on every network blip or tab sleep
  // (ui/public/js/ws.js scheduleReconnect), and while this lived inside
  // wss.on('connection') each reconnect silently erased the entire conversation
  // mid-chat. Server scope also means two open dashboards share ONE conversation
  // — desired for a single-operator loopback-bound entity ("same conversation,
  // different device"), so don't "fix" it back to per-connection.
  //
  // Deliberately NOT wiped after start_project succeeds — an earlier version
  // cleared it on the theory that the intake conversation shouldn't bleed into
  // post-build turns, but that also erased the only record that a build was ever
  // started: "is it done?" a few turns later had zero context and the voice-agent
  // asked what to build, as if starting fresh.
  //
  // Budget: capped by BOTH turn count and TOTAL chars. Real voice turns run
  // 50-400 chars, so 12000 chars holds ~12-18 exchanges (vs 4-6 under the old
  // 12-entry cap) while costing LESS in the worst case than the old ceiling of
  // 12 x 2000 = 24000 chars — which rivalled the whole tool catalog.
  // Literal fallbacks mirror the schema defaults: a fixture (or any partial
  // config object) must not silently disable the caps by yielding undefined,
  // which compares false in every bound check below.
  const HISTORY_MAX_TURNS = config.VOICE_HISTORY_MAX_TURNS || 40;
  const HISTORY_MAX_CHARS = config.VOICE_HISTORY_MAX_CHARS || 12000;
  const HISTORY_IDLE_TTL_MS = config.VOICE_INTAKE_IDLE_MS || 45 * 60 * 1000;
  const SESSION_PATH = 'Conversation/session.json';
  let history = [];
  let historyAt = 0;
  // Cortex-thought bookkeeping: which thought has already been shown as context
  // (see the injection site), when the operator last spoke, and when a proactive
  // follow-up last fired (both gate the cortex.thought subscriber below).
  let lastThoughtRef = null;
  let lastTurnAt = 0;
  let lastFollowupAt = 0;

  // Survive a restart: the conversation shouldn't die because the process did.
  // The try/catch is load-bearing, not garnish — test fakes expose only
  // memory.fs.vaultPath, so an unguarded call is a TypeError across the server
  // suite (same guard shape as the LAST_BOOT_PATH read above).
  try {
    const saved = memory.fs.readJSON(SESSION_PATH, null);
    if (saved && Array.isArray(saved.turns) && Date.now() - (saved.savedAt || 0) < HISTORY_IDLE_TTL_MS) {
      history = saved.turns.filter((t) => t && typeof t.content === 'string' && t.role);
      historyAt = saved.savedAt;
    }
  } catch (_) { /* no vault, unreadable, or a fake fs — start fresh */ }

  function historyGet() {
    if (Date.now() - historyAt > HISTORY_IDLE_TTL_MS) history = [];
    return history;
  }
  function historyTrim() {
    if (history.length > HISTORY_MAX_TURNS) history = history.slice(-HISTORY_MAX_TURNS);
    let chars = 0;
    for (let i = 0; i < history.length; i++) chars += history[i].content.length;
    // Always keep the newest entry even if it alone exceeds the char budget.
    while (history.length > 1 && chars > HISTORY_MAX_CHARS) {
      chars -= history[0].content.length;
      history.shift();
    }
  }
  function historyAppend(role, content) {
    if (!content) return;
    historyGet(); // apply TTL first
    history.push({ role, content: String(content).slice(0, 2000) });
    historyTrim();
    historyAt = Date.now();
    try { memory.fs.writeJSON(SESSION_PATH, { turns: history, savedAt: historyAt }); } catch (_) {}
  }

  wss.on('connection', (ws) => {
    const connectionId = crypto.randomUUID();
    const subscriptions = new Set(); // which OUT types this client wants relayed

    // A2 FIX: prevent unhandled 'error' events from crashing the process.
    ws.on('error', (err) => {
      logger.warn('ws-connection-error', { error: err.message, connectionId });
    });

    // C3: Serialize utterances per-connection to prevent concurrent races.
    let turnChain = Promise.resolve();
    function queueTurn(fn) {
      const next = turnChain.then(fn, fn);
      turnChain = next.catch(function() {});
      return next;
    }

    // Stage 3 (BUG-063): extracted to src/core/voice/action-outcome-summary.js
    // so it's independently testable and the "started" in-progress marker
    // (WAVE 3 slow tools) doesn't get conflated with a real failure — see
    // that module's header for the exact defect this closed.

    function send(msg) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); }

    // ---- S2S Live voice (V2 §10, merged-order step 4, Phase 5) ----
    // One session per WS connection, created LAZILY on liveOpen() (wake-word/
    // cost gate) — never at boot, never at connection time. liveAdapter is
    // lazy for the same reason: constructing it unconditionally for every
    // connection would require every test fixture's fake `leash` to implement
    // `.check()` even when the S2S path is never exercised, breaking back-
    // compat with existing fixtures (and wasting a real allocation on a path
    // most connections never touch).
    let liveSession = null;
    let liveAdapter = null;
    // Stage 2 (BUG-060): expose this connection's Live session to proactiveSpeak(),
    // which lives outside this closure — a plain getter on the ws itself, re-read
    // on every call so it always reflects the current (possibly reassigned, possibly
    // still-null) liveSession variable above.
    ws.getLiveSession = () => liveSession;
    // Task 12: latency instrumentation for the S2S path. Live has no discrete
    // "recording stopped" moment the way batch STT does (the model's own VAD
    // decides that internally) — the honest reference point available here is
    // the first user-speech transcription CONFIRMED for this turn. Reset on
    // every turnComplete so a slow turn never bleeds its timing into the next.
    let liveTurnUserSpeechAt = null;
    let liveTurnAudioRecorded = false;

    async function liveOpen() {
      if (!config.VOICE_S2S_ENABLED) {
        send({ type: 'live-state', state: 'closed', reason: 'disabled' });
        return;
      }
      if (liveSession && liveSession.isOpen()) return;
      if (!liveAdapter) {
        // AD-1/AD-2/AD-4: identical gate -> dispatch path as this connection's
        // own executeAction()/handleConfirmReply() — leash.check() -> dispatchAction().
        liveAdapter = createLiveToolAdapter({
          leash, dispatchAction, bus, logger, connectionId,
          memory, historyAppend, reflection,
          summarizeActionsForResult,
          getLiveSession: () => liveSession,
          sanitizeErrorForClient,
          goals, // BUG-113: commitment-ledger logging in onLiveTurnComplete
        });
      }
      if (!liveSession) {
        const { declarations, withheld } = buildFunctionDeclarations(effectors, {
          allowlist: String(config.LIVE_TOOL_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean),
          log: (m) => logger.info('live-tools', { detail: m }),
        });
        if (withheld.length) logger.info('live-tools.withheld', { count: withheld.length });
        liveSession = createLiveSession({
          config, bus, logger, spend, breakers: effectors.breakers,
          createSocket: createLiveSocket, // test-only seam; undefined in production
          // BUG-079: pass the FUNCTION, not its one-time result — live-session.js's
          // buildSetup() calls it fresh on every open()/reconnect so the local
          // time (and anything else composed here) never goes stale across a
          // long-running or rotated session.
          systemInstruction: buildLiveSystemInstruction,
          functionDeclarations: declarations,
          onToolCall: liveAdapter.handleLiveToolCalls,
          onAudioOut: (b64) => {
            send({ type: 'live-audio-out', data: b64 });
            if (liveTurnUserSpeechAt !== null && !liveTurnAudioRecorded) {
              voiceLatencyTracker.record(Date.now() - liveTurnUserSpeechAt);
              liveTurnAudioRecorded = true;
            }
          },
          onTranscript: (t) => {
            send({ type: 'live-transcript', role: t.role, text: t.text });
            if (t.role === 'user' && liveTurnUserSpeechAt === null) liveTurnUserSpeechAt = Date.now();
          },
          onState: (s) => send({ type: 'live-state', state: s.state, reason: s.reason }),
          onTurnComplete: (turn) => {
            liveAdapter.onLiveTurnComplete(turn);
            liveTurnUserSpeechAt = null;
            liveTurnAudioRecorded = false;
          },
          // Direct per-connection barge-in callback — NOT the shared bus (see
          // live-session.js's onInterrupted comment: a bare bus.subscribe here
          // would fire for every OTHER connection's interruption too).
          onInterrupted: () => send({ type: 'live-interrupted' }),
        });
      }
      const ok = await liveSession.open();
      // Honest-inert: never claim S2S is up when it isn't.
      if (!ok) send({ type: 'live-state', state: 'closed', reason: 'open-failed' });
    }

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
    async function sendSpokenReply(reqId, say, meta, micStoppedAt) {
      const speak = sanitizeSpoken(say);
      // Phase 2 (AETHER-WIRING): route the reply to the nearest device instead
      // of the local TTS chain. The client still gets its caption-only 'done'
      // (chunked:true, zero chunks — voice-loop.js finishes the turn silently)
      // so the HUD shows the reply without the local machine speaking it.
      // BUG-060 guard (mirrors proactiveSpeak): with a Gemini Live session open
      // on this connection, Live's PCM playback is already the entity's voice —
      // never ALSO route the batch reply to the Aether device (two voices).
      const liveSession = (typeof ws.getLiveSession === 'function') ? ws.getLiveSession() : null;
      if (!(liveSession && liveSession.isOpen()) && speakViaAether(speak)) {
        try { send({ type: 'done', reqId, say, speak, chunked: true, ...meta }); } catch (_) { /* client gone */ }
        return;
      }
      const ttsUp = await tts.isAvailable();
      // ALWAYS split, even with TTS down. This used to be `ttsUp ? split : []`,
      // which contradicted the comment directly above and truncated the entity's
      // speech: with no chunks the client fell through to speaking the WHOLE
      // reply as one SpeechSynthesisUtterance, and Chrome clips long ones. The
      // operator reported it as "consistently cut off at the end, losing the last
      // one or two words" on 2026-07-31 — a session where edge-tts happened to be
      // uninstalled for every turn, so every reply took that path. The text was
      // never at fault (all 29 replies round-trip splitSentences losslessly).
      // Chunk-per-sentence keeps each utterance short enough to finish.
      const chunks = splitSentences(speak);
      // Item B: register an abort controller so a 'stop' for this reqId
      // (barge-in) can cancel remaining chunk synthesis below — otherwise
      // edge-tts keeps synthesizing chunks nobody will hear after the client
      // has already stopped playback locally.
      const ctrl = new AbortController();
      inflightSpeech.set(reqId, ctrl);
      // Task 12: record the real mic-stop -> first-audio-frame delta exactly
      // once, on the first chunk that actually ships real audio (AD-5 — a
      // turn with no client-supplied micStoppedAt, or that never produces
      // real audio, contributes no sample rather than an estimate).
      let latencyRecorded = false;
      try {
        if (chunks.length) {
          for (let i = 0; i < chunks.length; i++) {
            if (ctrl.signal.aborted) break;
            let audioB64 = null;
        let chunkMime;
            // Only synthesize when the sidecar is actually up. A TTS-down chunk
            // ships text with audioB64:null and the client speaks it via
            // speechSynthesis (playNextChunk's existing else-branch) — one
            // sentence per utterance instead of one utterance per reply.
            if (ttsUp) {
              try {
                const out = await tts.synthesize({ text: chunks[i], signal: ctrl.signal });
                audioB64 = out.audio.toString('base64');
                chunkMime = out.mime;
              } catch (err) {
                logger.warn('tts.chunk-failed', { error: err.message, index: i });
              }
            }
            if (ctrl.signal.aborted) break;
            if (audioB64 && typeof micStoppedAt === 'number' && !latencyRecorded) {
              voiceLatencyTracker.record(Date.now() - micStoppedAt);
              latencyRecorded = true;
            }
            send({ type: 'speech-chunk', reqId, index: i, total: chunks.length, audioB64, mime: chunkMime, text: chunks[i] });
          }
        }
        // chunked forced true on abort (even with zero chunks sent): routes the
        // client's 'done' handling through the session-checked chunk-queue path,
        // never the non-chunked speechSynthesis fallback (which would otherwise
        // speak the just-barged-in-on reply after the fact).
        send({ type: 'done', reqId, say, speak, chunked: ctrl.signal.aborted ? true : chunks.length > 0, ...meta });
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
          // limit 12 / windowDays 21 (was 8 / the 7-day default): measured at
          // +20ms against a real 2.2MB vault, well inside RECALL_TIMEOUT_MS, and
          // 21 days stays inside EPISODIC_RETENTION_DAYS (30). Cheapest available
          // fix for "it forgot what we discussed last week".
          var recalled = await recallWithTimeout(memory.recallHybrid(text, { limit: 12, windowDays: 21, excludeKinds: ['proactive-speech'] }), RECALL_TIMEOUT_MS);
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
          // Inject each thought ONCE. There is no consumption marker on the
          // record, so without this guard the same mull thought is prepended to
          // every prompt for a full 24h — prompt waste, and an "earlier I
          // noticed..." that reads like a stuck record. Also a prerequisite for
          // the cortex.thought follow-up speech below: a spoken thought must not
          // then be re-injected as context on the next turn.
          if (pending.length > 0 && pending[0].record && pending[0].record.detail &&
              pending[0].ref !== lastThoughtRef) {
            var thoughtText = pending[0].record.detail.text || pending[0].record.summary;
            if (thoughtText) {
              lastThoughtRef = pending[0].ref;
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
              // channel:'voice' is what entitles this turn to a SPOKEN send
              // confirm instead of the HUD modal (Wave 8). It is an explicit
              // allowlist in voice-agent.js — an absent or unknown channel falls
              // back to the modal, so no non-operator caller can inherit it.
              ctx: { history: historyGet(), connectionId, memoryContext: memoryContext, traceId: msg.reqId, channel: 'voice' },
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

        // BUG-113: capture a spoken commitment as an inert, queryable ledger
        // entry (status:'proposed' — invisible to the autonomous arbiter,
        // same anchor pattern as from-calendar.js's reminder-action goals) so
        // "where are we on X" is answerable from state, not memory. Best-
        // effort: a ledger miss must never break the turn.
        try { logCommitmentIfPresent(say, { goals: goals }); } catch (_) {}

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
        // Task 12: thread the client's real mic-stop timestamp through, if any.
        const micStoppedAt = typeof msg.micStoppedAt === 'number' ? msg.micStoppedAt : undefined;
        await sendSpokenReply(msg.reqId, say, meta, micStoppedAt);
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

        const ttsUp = await tts.isAvailable();
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
        let chunkMime;
            try {
              const out = await tts.synthesize({ text: spoken });
              audioB64 = out.audio.toString('base64');
              chunkMime = out.mime;
            } catch (err) {
              logger.warn('tts.chunk-failed', { error: err.message, index: i });
            }
            send({ type: 'speech-chunk', reqId: msg.reqId, index: i, total: null, audioB64, mime: chunkMime, text: spoken });
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
        // Sentence-boundary cap, not a mid-word chop — see the boot greeting above.
        const say = truncateAtSentenceBoundary(String(result.content).trim(), 400);
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
        // S2S (Phase 5): tell the Live session the operator declined, so the
        // model reports that accurately instead of waiting silently. A no-op
        // if this confirmId never came from the voice-live path, or if S2S
        // was never engaged on this connection at all (liveAdapter is lazy).
        if (liveAdapter) { try { await liveAdapter.resolveLiveConfirm(confirmId, null, false); } catch (_) {} }
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
        const outcome = await dispatchAction(decision, { goalId: action.goalId, tier: action.tier, channel: 'confirm-accept', traceId: confirmId });
        // S2S (Phase 5): feed the real outcome back to the Live session as a
        // realtimeInput text turn, so the model reports what ACTUALLY
        // happened (AD-4) rather than whatever it assumed while waiting. A
        // no-op if this confirmId never came from the voice-live path, or if
        // S2S was never engaged on this connection at all (liveAdapter is lazy).
        if (liveAdapter) { try { await liveAdapter.resolveLiveConfirm(confirmId, outcome, true); } catch (_) {} }
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
      // Quiet-gate reference for proactive follow-ups: an unprompted remark must
      // never land while the operator is mid-conversation.
      if (msg.type === 'utterance' || msg.type === 'vision-query') lastTurnAt = Date.now();
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
      // ---- S2S Live voice (V2 §10, Phase 5) ----
      else if (msg.type === 'live-open') { queueTurn(function () { return liveOpen(); }); }
      else if (msg.type === 'live-audio') { if (liveSession) liveSession.sendAudio(msg.data); }
      // Slice 3 screen share. Same guard shape as live-audio: a frame arriving
      // before live-open (or after a close) is a silent no-op, never a throw —
      // the HUD's capture loop and the session lifecycle are independent timers
      // and will always race at the edges.
      else if (msg.type === 'live-video') { if (liveSession) liveSession.sendVideoFrame(msg.data); }
      else if (msg.type === 'live-close') { if (liveSession) liveSession.close('client-request'); }
      else if (msg.type === 'live-text') { if (liveSession) liveSession.sendText(String(msg.text || '')); }
    });

    // Tear down any open Live session when the socket itself closes — a
    // dangling Gemini socket would otherwise keep billing for open-mic time
    // with no client left to hear the reply.
    ws.on('close', () => {
      if (liveSession) liveSession.close('ws-closed');
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
    // `unverified` is relayed alongside `ok` (Wave 0 evidence contract): the HUD
// must be able to draw "attempted, unconfirmed" as its own state. Dropping it
    // here is what made the Agent Actions panel tick three ui_type calls that had
    // typed nothing into a visibly empty Notepad.
    const payload = {
      tool: e.payload.tool, ok: e.payload.ok, goalId: e.payload.goalId,
      reason: e.payload.reason, unverified: e.payload.unverified,
    };
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
    // Stage 5 (BUG-075): "open YouTube on the Electron app" (operator,
    // verbatim) needs a real second BrowserWindow, which only electron/main.js
    // (a SEPARATE OS process — the fork() parent) can create. The broadcast
    // above only ever reaches this process's own WS clients (the dashboard's
    // browser JS), never the Electron main process. process.send() is the
    // fork() IPC channel already set up for lifecycle when running under
    // Electron (stdio slot 3, 'ipc') — reused here, not a new channel. Absent
    // under a plain `node mythos/src/main.js` boot (no send()), which is fine:
    // there is no Electron window to open in that mode anyway.
    if (typeof process.send === 'function') {
      try { process.send({ channel: 'mythos:ui.open-web', payload: e.payload }); }
      catch { /* no parent listening (non-Electron boot) — nothing to relay to */ }
    }
  });

  // Stage 5 (BUG-075) — the Electron-side counterpart of requestClosePanel's
  // request/ack shape (same 3s-timeout pattern), but over the fork IPC channel
  // instead of the WS broadcast: process.send() the close request, resolve
  // when electron/main.js acks back on the same channel name + '-ack'. Only
  // one media window exists at a time, so a single pending slot (not a Map
  // keyed by reqId, unlike requestClosePanel/requestCameraFrame) is enough.
  let pendingCloseMediaWindow = null; // { resolve, timer }
  if (typeof process.on === 'function') {
    process.on('message', (msg) => {
      if (msg && msg.channel === 'mythos:close-media-window-ack' && pendingCloseMediaWindow) {
        clearTimeout(pendingCloseMediaWindow.timer);
        const pending = pendingCloseMediaWindow;
        pendingCloseMediaWindow = null;
        pending.resolve(Boolean(msg.closed));
        return;
      }
      // Slice 2 (Electron shell): Ctrl+Alt+X pressed in the Electron main
      // process → OCR the screen via the pc-child adapter's screen_read_text
      // effector, then broadcast the text back to the HUD. channel:'hotkey'
      // so the audit trail attributes it to the keypress, not the cortex.
      // Fire-and-forget: a globalShortcut callback can't await, and a failure
      // must surface as an honest ocr-result, never crash the server.
      if (msg && msg.channel === 'mythos:ocr-grab') {
        (async () => {
          try {
            const r = await dispatchAction({ tool: 'screen_read_text', args: {} }, { tier: 0, channel: 'hotkey' });
            const ok = Boolean(r && r.ok);
            broadcastAll({
              type: 'ocr-result',
              payload: {
                ok: ok,
                text: ok ? String((r.result && r.result.text) || '') : '',
                error: ok ? undefined : String((r && r.result && r.result.error) || (r && r.error) || 'OCR failed'),
              },
            });
          } catch (err) {
            try {
              broadcastAll({ type: 'ocr-result', payload: { ok: false, text: '', error: String((err && err.message) || err || 'OCR failed') } });
            } catch { /* no clients connected — nothing to report to */ }
          }
        })();
      }
    });
  }
  function requestCloseMediaWindow() {
    return new Promise((resolve) => {
      if (typeof process.send !== 'function') { resolve(false); return; } // not under Electron
      if (pendingCloseMediaWindow) { clearTimeout(pendingCloseMediaWindow.timer); pendingCloseMediaWindow.resolve(false); }
      const timer = setTimeout(() => { pendingCloseMediaWindow = null; resolve(false); }, 3000);
      pendingCloseMediaWindow = { resolve, timer };
      try { process.send({ channel: 'mythos:close-media-window' }); }
      catch { pendingCloseMediaWindow = null; clearTimeout(timer); resolve(false); }
    });
  }

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
        // BUG-105: `tool` is read too — a late-outcome anomaly used to persist
        // as "anomaly: live-tool-outcome-late-for-turn — " with the one fact
        // worth having (which tool) missing from the record entirely.
        summary: 'anomaly: ' + (e.payload.kind || 'unknown') + ' — ' + (e.payload.error || e.payload.target || e.payload.tool || ''),
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
    const p = e.payload || {};
    // Stage 3 (BUG-069): healer.js's onDiagnosed emits 'health.healed' on
    // EVERY diagnosis outcome, not just a real fix — 'no-match' (no playbook
    // recognized the anomaly) and 'cooldown'/'error' all go out on the same
    // event name, carrying an explicit `outcome` field that says so. This
    // subscriber used to ignore that field entirely and label every one of
    // them 'healed:<kind>' — 36 such no-match pairs were found in the
    // episodic logs, each claiming a fix that never happened. probes.js's
    // own 'provider-recovered' event (a genuine down->up transition) carries
    // NO `outcome` field at all, so its absence still means "yes, this really
    // recovered" — only an EXPLICIT outcome other than 'applied' means the
    // healer took no corrective action.
    const actuallyHealed = !('outcome' in p) || p.outcome === 'applied';
    anomalyLog.push(Object.assign({ healed: actuallyHealed }, p));
    if (anomalyLog.length > 200) anomalyLog.shift();
    broadcastHealth(lastStatus);
    try {
      const label = actuallyHealed ? 'healed' : 'unhandled';
      memory.episodic.write({
        kind: 'anomaly', channel: 'immune',
        summary: label + ': ' + (p.kind || 'unknown') + ' — ' + (p.target || ''),
        detail: { kind: p.kind, target: p.target, playbookId: p.playbookId, outcome: p.outcome },
        outcome: label, salience: actuallyHealed ? 0.6 : 0.5,
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
  return {
    app, httpServer, wss, stop, dispatchAction, ready, requestCameraFrame, requestClosePanel,
    requestCloseMediaWindow, setGmailPollCountGetter,
    // Test-only introspection (Task 12) — never used by production callers.
    _internal: { voiceLatencyTracker, sanitizeErrorForClient, deliverBootGreeting, conversationAnnouncer, GREETING_DEDUP_KEY },
  };
}

module.exports = { createServer };
