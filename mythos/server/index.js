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
const { mountTtsVoiceRoutes } = require('./routes/tts-voices');
const { recordLiveVoiceSwitch, popPreviousLiveVoice } = require('../src/core/config/voice-choice');
const sttChain = require('../providers/stt');
const { splitSentences, createSentenceStreamer, truncateAtSentenceBoundary } = require('../src/core/effectors/voice');
const { sanitizeSpoken } = require('../src/core/voice/spoken-text');
const { createVoiceAgent, RULES } = require('../src/core/voice/voice-agent');
const { createConversationAnnouncer } = require('../src/core/conversation/announcer');
const { buildBriefingFacts, GREETING_FACT_DISCIPLINE, greetingRelationshipClause } = require('../src/core/conversation/briefing');
const { TOOL_RESPONSE_DISCIPLINE } = require('../src/core/voice/narration-claims');
const { snapshotSystemMetrics } = require('./routes/system');
const spend = require('../src/core/brain/spend');
const { dispatchAction: sharedDispatch } = require('../src/core/effectors/dispatch-action');
const { reasonText } = require('../src/core/util/reason-text');
// A2: reuse credential-scanner's curated pattern list (single source of truth)
// to scrub secret-shaped values out of the client-bound log copy.
const { _PATTERNS: LOG_SECRET_PATTERNS } = require('../src/core/effectors/credential-scanner');
// S2S (V2 §6-§10, merged-order step 4, Phase 5 wiring): Gemini Live transport,
// hub->functionDeclarations conversion, and the tool-adapter safety seam.
const { createLiveSession } = require('../src/core/voice/live-session');
// Installer parity (2026-08-11): do not DECLARE a tool whose adapter or
// credentials do not exist on this machine — the fresh install fired
// gmail_unread/media_status/spotify_status against neither. See tool-capability.js.
const { buildCapabilitySnapshot } = require('../src/core/voice/tool-capability');
// Where downloaded model weights live now that the install tree cannot hold them.
const { userDataModelsDir } = require('../src/core/setup/model-paths');
const {
  createLiveToolAdapter, SYSTEM_NOTICE_PREFIX, LIVE_SYSTEM_NOTICE_INSTRUCTION,
} = require('../src/core/voice/live-tool-adapter');
const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');
// B2: the anomaly persist allowlist. See its header — the previous fixed
// four-field detail dropped every diagnostic field its emitters attached.
const { anomalyDetail, anomalySummaryDetail } = require('../src/core/immune/anomaly-detail');
// BUG-113: a spoken first-person commitment ("I'll check X") must leave a
// record — logCommitmentIfPresent is a no-op unless the text matches the
// explicit commitment-phrase list, so ordinary replies are unaffected.
const { logCommitmentIfPresent } = require('../src/core/effectors/from-calendar');
const { createLatencyTracker } = require('../src/core/voice/latency-tracker');
const skillsLoader = require('../src/core/skills/loader');
// createNewsFeed moved to routes/news.js (W9 god-file decomposition).
const pcChild = require('../adapters/pc-child');
// Read-only status singletons for the Live capability snapshot above. Requiring
// an adapter module starts nothing — each one only spawns on its explicit
// start*/connect call, which main.js owns.
const browserAgentAdapter = require('../adapters/browser-agent');
const cuaDriverAdapter = require('../adapters/cua-driver');
const androidChildAdapter = require('../adapters/android-child');
const version = require('../src/core/identity/version');
const { getUpdateReport } = require('../src/core/identity/update-report');
const { isProviderDown } = require('../src/core/immune/probes');
// BUG-442/BUG-444: one owner for the cookie names, the channel rules and the policy.
const credentials = require('./credentials');
const { createAuthSessionStore } = require('./auth-sessions');

// WS v2 message types — exact strings, do not paraphrase:
// IN (reqId):  'utterance', 'command', 'confirm-reply', 'subscribe', 'stop', 'vision-query'
// IN (voice nodes, no reqId): 'node-reading' {nodeId, rssi, name} — a phone's BLE
//                  observation of the tracked beacon, republished by the
//                  scanner-proxy in Aether §4.1 shape; 'node-lost' {nodeId};
//                  'node-wake' {nodeId} — this node heard the wake phrase (a
//                  report, not a claim: Aether decides who answers)
// OUT (voice nodes): 'wake-outcome' {arbitrated, owner, results}, 'conversation'
//                  {phase, from, speakingScanner}, 'cancel' {reqId}, 'identified'
// OUT (broadcast): 'entity-state', 'tick', 'goal-update', 'perception', 'action',
//                  'health', 'audit', 'confirm-request', 'brain-spend', 'log', 'job', 'mission'
//                  'proactive-speech' (entity-initiated, no inbound utterance)
//                  'confirm-resolved' {id, outcome} — a pending confirm is over
//                  (accepted | rejected | expired), so every OTHER surface
//                  showing it can dismiss instead of offering a dead button.
//                  Also sent to one connection with outcome 'not-permitted'
//                  when it replied to a confirm scoped to a different one.
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

// BUG-251: ceiling for the OPERATOR FACTS block in the Live setup frame.
// user-facts.md is append-only and unbounded; without a cap a long-lived vault
// would grow the once-per-session system instruction without limit.
//
// BUG-256: raised 4000 -> 8000. At 4000 the operator's real vault already had
// 11 of its 37 facts falling off the front after two days of use, and a fact
// the model cannot see is one it asks a tool for — `recall_memory` is a second
// inference pass, which on a rate-limited free tier costs far more than the
// tokens do. The whole composed instruction is ~35K chars and is built ONCE per
// session (BUG-136), while a tool round-trip is paid per turn, so trading
// prompt size for round-trips is the right direction here. Still a hard cap:
// unbounded growth would eventually crowd the frame, and at that point the
// answer is distillation, not a bigger number.
const LIVE_FACTS_MAX_CHARS = 8000;
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

// A2 — logger redaction at the WS relay choke point. The onLog relay below is
// the ONE seam feeding both broadcastAll({type:'log'}) and pushReplay('log'),
// so scrubbing here covers every live client AND the replay buffer in a single
// place. stdout/container logging is untouched: logger.js writes its own line
// to stdout before notifying listeners, and redactLogEntry returns a NEW object
// (never mutates the entry), so the operator still sees the full record.
//
// Key-name list duplicated from src/core/memory/audit-writer.js's REDACT_KEYS
// (closure-scoped there, not exported; hoisting it would be a refactor the task
// brief explicitly discourages). Keep the two lists in sync. Value patterns are
// NOT duplicated — they reuse credential-scanner's exported _PATTERNS so there
// is one source of truth. Over-matching (e.g. a benign 'token' substring) is
// acceptable: redaction errs safe.
//
// PINNED DISPOSITION (2026-08-17 review): the substring semantics STAY, and the
// list is deliberately NOT narrowed. Reviewed because 'session' and 'token' are
// the kind of words that appear in ordinary diagnostic field names, so the
// over-match risked the failure mode that matters most here — a fix that hides
// the evidence trail (rules/core.md §11.2). Three things settled it:
//   * Measured, not assumed: a sweep of every real logger/anomaly payload key in
//     src/ + server/ found exactly ONE collateral key, `sessionsClosed`, a
//     counter that nothing read programmatically. It is now `closedCount`.
//   * audit-writer.js's REDACT_KEYS is byte-identical AND matches by substring
//     too. Narrowing one list would leave two redaction rules with different
//     semantics, which is strictly worse than one over-broad rule — the comment
//     above already asks for them to be kept in sync.
//   * The blast radius is one frame type. redactLogEntry is applied only to the
//     logger.onLog relay, not to /api responses or any other WS frame.
// So the enforcement is a gate, not a narrower list:
// test/log-redaction-collateral.test.js sweeps the real emitters and fails when a
// NEW payload key would be swallowed — the drift becomes a red commit instead of
// something noticed by eye months later. If a future key legitimately collides,
// rename the key; do not narrow this list without also narrowing audit-writer's.
const LOG_REDACT_KEYS = ['apiKey', 'api_key', 'token', 'authorization', 'password', 'secret', 'cookie', 'credential', 'session'];

function redactLogValue(str) {
  for (let i = 0; i < LOG_SECRET_PATTERNS.length; i++) {
    const re = LOG_SECRET_PATTERNS[i].re;
    re.lastIndex = 0; // patterns carry the global flag; reset before each use
    str = str.replace(re, '[REDACTED]');
  }
  return str;
}

// Recursive copy-and-redact. Bounded by credential-scanner's depth cap (5) so a
// pathological/circular object cannot stall the hot log path.
function redactLogEntry(obj, depth) {
  depth = depth || 0;
  if (depth > 5) return obj;
  if (typeof obj === 'string') return redactLogValue(obj);
  if (Array.isArray(obj)) return obj.map((item) => redactLogEntry(item, depth + 1));
  if (!obj || typeof obj !== 'object') return obj;
  const copy = {};
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (LOG_REDACT_KEYS.some((r) => k.toLowerCase().includes(r.toLowerCase()))) {
      copy[k] = '[REDACTED]';
    } else {
      copy[k] = redactLogEntry(obj[k], depth + 1);
    }
  }
  return copy;
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
  const geminiLiveBreakers = require('../src/core/voice/live-breakers.js').ensureGeminiLiveBreakerWired({ bus: bus, config: config, effectors }); // BUG-340: wiring lives in voice/live-breakers.js
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
  const stopBrowserOfflineNotice = browserAgentAdapter.onOffline(p => { if (config.LIVE_VOICE_HONESTY_ENABLED !== false) bus.emit('health.anomaly', { kind: 'browser-automation-offline', reason: p.reason, target: 'browser automation' }); });
  const identity = deps.identity;                      // S2S (Phase 5) — identity.persona() for buildLiveSystemInstruction (may be undefined in tests)
  // Voice Nodes — the per-phone Aether scanner-proxy (src/core/aether/
  // scanner-proxy.js), undefined unless AETHER_PROXY_ENABLED. The server's only
  // job here is transport: a phone's inbound 'node-reading' becomes an
  // updateReading() call, and the proxy owns all the protocol shape.
  const scannerProxy = deps.scannerProxy;
  // Inbound types that are pure telemetry, not operator activity — see the
  // lastActiveWs guard in ws.on('message').
  const NODE_TELEMETRY_TYPES = new Set(['node-reading', 'node-lost']);
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
  function buildLiveSystemInstruction(extra) {
    // BUG-117: the transport has no system role after setup, so every pipeline
    // injection arrives as user-role realtimeInput and the model attributed it
    // to the operator. This clause is the other half of SYSTEM_NOTICE_PREFIX —
    // both live in live-tool-adapter.js so they cannot drift apart.
    const parts = [RULES, config.LIVE_VOICE_HONESTY_ENABLED === false ? LIVE_SYSTEM_NOTICE_INSTRUCTION.replace(TOOL_RESPONSE_DISCIPLINE, '') : LIVE_SYSTEM_NOTICE_INSTRUCTION];
    try {
      const persona = identity && typeof identity.persona === 'function' ? identity.persona() : null;
      if (persona) parts.push(persona);
    } catch (err) { logger.warn('live.persona-compose-failed', { error: err.message }); }
    try {
      parts.push(version.contextLine() +
        ' (as of session-start — a code upgrade since then would not be reflected here; re-check with a tool before relying on it.)');
    } catch (err) { logger.warn('live.version-compose-failed', { error: err.message }); }
    // BUG-136: this frame is composed once per open()/rotation and can then ride
    // unrefreshed for up to ~10 minutes (Gemini Live's own connection ceiling) —
    // any per-turn-fresh value baked in here goes stale but keeps LOOKING live to
    // the model. The batch path (voice-agent.js) calls getCapabilityDigest() fresh
    // every turn and is genuinely live; this is the only composition point where
    // it is not, so it asks for the labelled `asOf` form instead of the "live —
    // trust this" default. `version.contextLine()` and the skills catalog below
    // share the same trap and are now labelled the same way (Task B3) — the
    // local time below is the one prior fix for this class (refreshed on every
    // open(), with its own comment explaining why).
    try {
      const digest = getCapabilityDigest ? getCapabilityDigest({ asOf: 'session-start' }) : null;
      if (digest) parts.push(digest);
    } catch (err) { logger.warn('live.capability-digest-failed', { error: err.message }); }
    try {
      const skillsBlock = skillsLoader.catalogBlock();
      if (skillsBlock) {
        parts.push(skillsBlock +
          '\n(as of session-start — a skill added/removed since would not be reflected here; re-check with a tool before relying on it.)');
      }
    } catch (err) { logger.warn('live.skills-catalog-failed', { error: err.message }); }
    // BUG-251: the Live path had no memory of the operator at all. Everything
    // durable the vault knew (Semantic/user-facts.md) was reachable only from
    // handleUtterance()'s recallHybrid() — the TYPED path — so the primary
    // SPOKEN surface was structurally amnesiac and "you never remember my
    // songs" was correct about the surface even though the facts were on disk.
    // BUG-249 fixed the write side (habit promotion); this is the read side.
    //
    // Deliberately a direct topic() read, not recallHybrid(): this composer is
    // called synchronously from live-session.js's buildSetup() on every
    // open()/rotation and cannot await, and an embeddings round-trip on the
    // session-open path would add latency to every reconnect. There is also no
    // query to score against here — the whole file IS the relevant context.
    // Labelled session-start per BUG-136, and capped: user-facts.md is
    // append-only and unbounded, so the TAIL (newest facts) is what survives.
    try {
      if (config.LIVE_MEMORY_INJECT !== false) {
        const semantic = memory && memory.semantic;
        const factsTopic = (semantic && typeof semantic.topic === 'function') ? semantic.topic('user-facts') : null;
        const facts = factsTopic && Array.isArray(factsTopic.facts) ? factsTopic.facts : [];
        if (facts.length) {
          const header = 'OPERATOR FACTS (as of session-start — durable memory, may have changed since; ' +
            'use recall_memory for anything not here):';
          const lines = [];
          let used = header.length;
          for (let i = facts.length - 1; i >= 0; i--) {
            const line = '- ' + facts[i];
            if (used + line.length + 1 > LIVE_FACTS_MAX_CHARS) break;
            used += line.length + 1;
            lines.unshift(line);
          }
          if (lines.length) parts.push(header + '\n' + lines.join('\n'));
        }
      }
    } catch (err) { logger.warn('live.facts-compose-failed', { error: err.message }); }
    // BUG-079 (Stage 6, item #19): with no local time anywhere in the prompt,
    // MYTHOS said "have a good afternoon" at ~01:50 local — the operator had
    // to correct "a.m. not p.m." live-session.js's buildSetup() calls this
    // function fresh on every open()/reconnect (idle/max rotation, goAway),
    // so a long-running session's notion of "now" doesn't go stale either.
    try {
      const now = new Date();
      parts.push('Current local date/time: ' + now.toString());
    } catch (err) { logger.warn('live.time-compose-failed', { error: err.message }); }
    return parts.filter(Boolean).join('\n\n') + (extra || '');
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

  // Server-initiated camera POWER-ON, same request/ack shape as
  // requestCameraFrame above. Exists because withholding the ability to ask is
  // what produced the 2026-08-10 incident: with the camera off and no way to
  // request it, "can you see me?" had no honest path at all, and the model
  // substituted a desktop screenshot and described that instead.
  //
  // Three properties, in order of importance:
  //   1. The HUD decides, not the server. It answers with the state the camera
  //      loop ACTUALLY reached — getUserMedia can be denied and the gesture model
  //      can fail to load, and both already return false from start(). A hopeful
  //      `on: true` here would recreate the exact class of bug this whole change
  //      is about.
  //   2. camera_on is T3 + NEVER_TRUSTABLE (leash/tiers.js, leash/index.js), so
  //      the operator has confirmed before this function is ever reached. Nothing
  //      on the autonomous path can call it.
  //   3. The timeout is longer than requestCameraFrame's 8s: this waits for the
  //      permission prompt AND MediaPipe's first model load, which the frame
  //      request never has to (by the time anything asks for a frame, the loop is
  //      already warm). The HUD acks only once the loop reports 'watching', so a
  //      camera_look issued immediately afterwards does not race the warm-up.
  const pendingCameraPower = new Map(); // reqId -> { resolve, timer }
  const CAMERA_POWER_TIMEOUT_MS = 20000;
  function requestCameraPower() {
    return new Promise(function(resolve) {
      const id = 'campower-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
      const timer = setTimeout(function() { pendingCameraPower.delete(id); resolve(null); }, CAMERA_POWER_TIMEOUT_MS);
      pendingCameraPower.set(id, { resolve: resolve, timer: timer });
      broadcastAll({ type: 'camera-power-request', reqId: id });
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
  // BUG-273 B3: the same shape, for "did the widget actually mount". A separate
  // map because the two round-trips can be in flight at once (a close_panel while
  // a spawn is still resolving); sharing one keyed by reqId would work and would
  // read as if they were the same conversation.
  const pendingWidgetRender = new Map(); // reqId -> { resolve, timer }
  // BUG-273 B3 — send a widget descriptor to the HUD and wait to be told whether
  // it mounted. Modelled on requestClosePanel below, including the 3s timeout
  // resolving NULL rather than throwing: "no answer" and "did not mount" are
  // different facts, and from-dashboard.js reports them differently.
  //
  // This becomes the ONLY path that broadcasts open-web for the open_web effector
  // — dispatch-action.js skips its bus relay for a descriptor marked
  // renderDispatched — so a widget cannot render twice. The Electron media-window
  // relay is kept verbatim from the bus subscriber, BUG-166's rule included: under
  // Electron, youtube/web are handled by the media window INSTEAD of a panel
  // broadcast, and that window has its own ack channel, so there is no HUD panel
  // to wait for and this resolves null rather than pretending to have asked one.
  function requestWidgetRender(payload) {
    return new Promise(function (resolve) {
      const electronHandles = typeof process.send === 'function'
        && payload && (payload.widgetType === 'youtube' || payload.widgetType === 'web');
      if (typeof process.send === 'function') {
        try { process.send({ channel: 'mythos:ui.open-web', payload: payload }); }
        catch (_) { /* no parent listening (non-Electron boot) */ }
      }
      if (electronHandles) { resolve(null); return; }
      const id = 'openweb-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
      const timer = setTimeout(function () { pendingWidgetRender.delete(id); resolve(null); }, 3000);
      pendingWidgetRender.set(id, { resolve: resolve, timer: timer });
      broadcastAll({ type: 'open-web', payload: payload, reqId: id });
    });
  }

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
  // From config, not process.env, for the reason spelled out at DUCK_MIN_HOLD_MS
  // below: a key read straight from the environment cannot be set in a packaged
  // install at all. Default unchanged (15).
  const DUCK_VOLUME_LEVEL = Number(config.DUCK_VOLUME_LEVEL) || 15;
  const UNDUCK_SAFETY_MS = Number(config.UNDUCK_SAFETY_MS) || 15000; // restore even if the client never sends unduck (dropped connection, crash)
  // HYSTERESIS (operator, 2026-08-11). Ducking is self-cancelling with media
  // playing: the duck quiets the room, the RMS VAD then sees silence and stops
  // recording, the unduck restores full volume, and the music immediately
  // re-arms the mic. The operator's installed build logged 58 set_volume calls
  // in one session doing exactly that — it described it as the volume being a
  // "ping-pong ball", and the entity itself filed an incident calling it a
  // "volume control feedback loop".
  //
  // Two bounds break the cycle without touching the VAD or the duck depth:
  //   DUCK_MIN_HOLD_MS  — once ducked, stay ducked this long. An unduck arriving
  //                       sooner is deferred, not dropped, so a genuinely short
  //                       utterance still restores; it just does not flap.
  //   DUCK_COOLDOWN_MS  — after restoring, ignore a re-duck for this long. This
  //                       is the half that matters: the re-trigger is the music
  //                       coming back up, and it arrives within milliseconds.
  // Both env-overridable in the same style as DUCK_VOLUME_LEVEL above. Note that
  // an operator running with VOICE_S2S_ENABLED (the dev configuration, and now
  // the derived default when a Google key is present) never reaches this code at
  // all — Live duplex has no record-window ducking.
  // Hysteresis alone only RATE-LIMITS the loop (measured: a storm collapses from
  // dozens of cycles to one per hold+cooldown), so it is paired below with the
  // one signal that actually classifies the trigger: a mic-hot window that ends
  // without an utterance being dispatched was not a person. Two of those in a row
  // and ducking backs off entirely for DUCK_SUPPRESS_MS — the loop stops instead
  // of merely slowing down. A single real utterance clears the count.
  // Read from CONFIG, not straight from process.env (installer parity,
  // 2026-08-11). These four were `Number(process.env.X) || default`, which means
  // they were invisible to the config schema and therefore unsettable from
  // userData/config.json — the only place a PACKAGED install can put a setting.
  // So the very bounds that stop the volume feedback loop could not be tuned on
  // the build that reported the loop. Found by scripts/parity-check.js naming them
  // as "not reported by /api/config/settings"; now in schema.js with these exact
  // defaults, so .env keeps working and config.json works too.
  // The `|| default` is kept for one specific reason: several tests construct
  // createServer with a hand-built partial `config` object rather than a validated
  // one, and an undefined here would silently become NaN in every comparison
  // below — a hysteresis that never engages, with no error anywhere. The defaults
  // are the same values schema.js now carries.
  const DUCK_MIN_HOLD_MS = Number(config.DUCK_MIN_HOLD_MS) || 800;
  const DUCK_COOLDOWN_MS = Number(config.DUCK_COOLDOWN_MS) || 1200;
  const DUCK_FALSE_MAX = Number(config.DUCK_FALSE_MAX) || 2;
  const DUCK_SUPPRESS_MS = Number(config.DUCK_SUPPRESS_MS) || 30000;
  let preDuckVolume = null;
  let unduckSafetyTimer = null;
  let duckedAt = 0;          // when the current duck started
  let lastUnduckAt = 0;      // when the last restore completed
  let pendingUnduckTimer = null;
  let utteranceSinceDuck = false;  // did this mic-hot window produce a real turn?
  let falseDuckCycles = 0;
  let duckSuppressedUntil = 0;
  // Called from the WS 'utterance' handler: proof that the window that just
  // ducked was a person talking, not the speakers.
  function noteUtteranceHeard() {
    utteranceSinceDuck = true;
    falseDuckCycles = 0;
    duckSuppressedUntil = 0;
  }
  // AD-1: these three calls used to go straight to the effector hub's
  // invoke() method, bypassing the single execution surface (dispatchAction,
  // defined below —
  // a hoisted function declaration, safe to reference here). Now every duck/
  // unduck volume change gets the same audit + episodic trail as any other
  // dispatched action, tagged channel:'voice-ducking' so it's distinguishable
  // from an operator-driven volume change.
  async function duckAudio() {
    if (preDuckVolume !== null) {
      // Already ducked, and a fresh mic-hot window means the operator is still
      // talking — cancel any deferred restore rather than letting it fire mid-
      // utterance.
      if (pendingUnduckTimer) { clearTimeout(pendingUnduckTimer); pendingUnduckTimer = null; }
      return;
    }
    // Inside the cooldown this duck request is almost certainly the media we
    // just un-ducked re-triggering the VAD, not a person. Refuse it.
    if (lastUnduckAt && (Date.now() - lastUnduckAt) < DUCK_COOLDOWN_MS) return;
    // Backed off after repeated windows that produced no speech at all.
    if (duckSuppressedUntil && Date.now() < duckSuppressedUntil) return;
    if (!effectors || typeof effectors.invoke !== 'function') return;
    try {
      const current = await dispatchAction({ tool: 'get_volume', args: {} }, { tier: 0, channel: 'voice-ducking' });
      if (!current.ok || !current.result || typeof current.result.level !== 'number') return;
      preDuckVolume = current.result.level;
      duckedAt = Date.now();
      utteranceSinceDuck = false;
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
    // Hold the duck for its minimum window. Deferred, never dropped: the timer
    // below performs the same restore once the window closes, so a one-word
    // utterance still gets its volume back — just not fast enough to bounce.
    const heldFor = Date.now() - duckedAt;
    if (heldFor < DUCK_MIN_HOLD_MS) {
      if (pendingUnduckTimer) return;   // a restore is already scheduled
      pendingUnduckTimer = setTimeout(function() {
        pendingUnduckTimer = null;
        unduckAudio().catch(function() {});
      }, DUCK_MIN_HOLD_MS - heldFor);
      // unref: a pending restore must never be the reason the process stays
      // alive at shutdown (the same courtesy the rest of the server's timers
      // extend). The volume is restored on the next boot's duck cycle anyway,
      // and UNDUCK_SAFETY_MS still covers a dropped connection.
      if (typeof pendingUnduckTimer.unref === 'function') pendingUnduckTimer.unref();
      return;
    }
    if (pendingUnduckTimer) { clearTimeout(pendingUnduckTimer); pendingUnduckTimer = null; }
    // Classify the window that just closed. No utterance means the VAD armed on
    // something that was not a person — with music playing, that is the loop.
    if (!utteranceSinceDuck) {
      falseDuckCycles++;
      if (falseDuckCycles >= DUCK_FALSE_MAX && !duckSuppressedUntil) {
        duckSuppressedUntil = Date.now() + DUCK_SUPPRESS_MS;
        logger.warn('audio-duck-suppressed', {
          cycles: falseDuckCycles,
          forMs: DUCK_SUPPRESS_MS,
          note: 'mic-hot windows keep closing with no speech — ducking is arming on playback, not on you',
        });
      }
    } else {
      falseDuckCycles = 0;
    }
    const restoreLevel = preDuckVolume;
    preDuckVolume = null;
    lastUnduckAt = Date.now();
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
  // rather than silently exposing the full effector set (including T3 confirm-and-execute)
  // to anyone who finds the URL.
  const AUTH_TOKEN = config.MYTHOS_AUTH_TOKEN || '';
  const isLoopbackBind = /^(127\.|::1|localhost)/i.test(String(BIND));
  if (!isLoopbackBind && !AUTH_TOKEN) {
    throw new Error(
      `MYTHOS_BIND is non-loopback (${BIND}) but MYTHOS_AUTH_TOKEN is unset. ` +
      'Refusing to expose the full effector set unauthenticated. Set MYTHOS_AUTH_TOKEN (see mythos/.env.example) or bind 127.0.0.1.'
    );
  }

  // H3(b) (security audit, 2026-08-08) — MYTHOS_AUTH_TOKEN had no minimum
  // length or entropy requirement, yet it is the ONLY thing standing between
  // the public internet and the full effector set including tier-3 confirm-and-execute
  // once MYTHOS_BIND is non-loopback (see the guard just above). Reject an
  // obviously weak token at boot with the same fail-loud posture — but ONLY
  // when a token is actually configured. Running with NO token at all on
  // loopback is the documented, intentional back-compat default (every
  // pre-existing test depends on it) and is completely untouched by this;
  // this only tightens what counts as a VALID token once the operator has
  // chosen to set one.
  // H3(b) (security audit, 2026-08-08) — weak-token rejection at boot; the
  // check itself lives in src/core/server/boot-guards.js (ratchet extraction,
  // BUG-337). Running with NO token on loopback stays the documented default.
  const { weakAuthTokenReason, MIN_AUTH_TOKEN_LENGTH } = require('../src/core/server/boot-guards.js');
  if (AUTH_TOKEN) {
    const weakReason = weakAuthTokenReason(AUTH_TOKEN);
    if (weakReason) {
      throw new Error(
        `MYTHOS_AUTH_TOKEN is set but too weak (${weakReason}). ` +
        `Use a random token of at least ${MIN_AUTH_TOKEN_LENGTH} characters, e.g. ` +
        `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
      );
    }
  }

  // One credential (2026-09-23: the PIN was removed on the operator's decision,
  // and BUG-444 replaced the raw-token cookie with a session id). The policy,
  // cookie names and 401 sentence live in server/credentials.js; sessions in
  // server/auth-sessions.js. With no token configured every request passes —
  // which is only ever a loopback bind (guard above), so the cross-origin and
  // Host guards below are what stop a web page from driving the API.
  const authSessions = createAuthSessionStore({
    authToken: AUTH_TOKEN,
    file: deps.authSessionsFile,
    ttlMs: config.AUTH_SESSION_COOKIE_TTL_MS,
    logger,
  });

  // Timing-safe compare — the one place in this file where timing matters.
  // MYTHOS_AUTH_TOKEN and ONLY it: the AETHER node-trust branch of verifyClient
  // uses this directly, because a browser session proves nothing about being an
  // enrolled device on the LAN.
  function authTokenMatches(presented) {
    if (!AUTH_TOKEN) return false;
    const a = Buffer.from(String(presented || ''));
    const b = Buffer.from(AUTH_TOKEN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function credentialCheck(req) {
    return credentials.evaluate(req, { authToken: AUTH_TOKEN, authTokenMatches, sessionValid: authSessions.isValid });
  }

  function tokenOk(req) {
    return credentialCheck(req).ok;
  }

  // The bearer specifically (header or query) — verifyClient's node-trust branch.
  function extractToken(req) {
    return credentials.extractBearer(req);
  }

  function requireToken(req, res, next) {
    const verdict = credentialCheck(req);
    if (!verdict.ok) return res.status(401).json({ error: credentials.UNAUTHORIZED_HINT, missing: verdict.missing });
    next();
  }

  // A cookie that was once a credential — the raw token (BUG-444) or the removed
  // PIN session — is cleared on sight and never read. Logged by NAME, once per
  // name per process; the value never reaches a log line.
  const legacyCookiesLogged = new Set();
  function clearLegacyCookies(req, res, next) {
    for (const name of credentials.legacyCookiesPresent(req)) {
      res.clearCookie(name, { path: '/' });
      if (!legacyCookiesLogged.has(name)) {
        legacyCookiesLogged.add(name);
        logger.warn('auth.legacy-cookie-rejected', { cookie: name });
      }
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

  // Error sanitization moved to server/sanitize-error.js so the extracted REST
  // routes can share it — as a closure here it was reachable only from the WS
  // result path, and routes/*.js answered failures with a raw err.message.
  // The function bodies are unchanged; see that file for the two policies.
  const { sanitizeErrorForClient } = require('./sanitize-error');

  const app = express();
  app.use((req, res, next) => { req.id = crypto.randomUUID(); next(); });

  // H7 (security audit, 2026-08-08) — no Content-Security-Policy anywhere in
  // the response pipeline. Not independently exploitable today (no
  // reflected-XSS route was found), but it is the layer that would have
  // contained a B2-style key-theft chain — an attacker-influenced string
  // (open_web/model output) becoming script instead of just being displayed.
  //
  // Two headers, split deliberately after grepping ui/public/js for every
  // pattern that would make a strict policy break the HUD:
  //
  // 1. ENFORCING now, narrow, and verified safe: no <base>/<object>/<embed>
  //    exists anywhere in the HUD, and nothing legitimately frames it from
  //    another origin. These three directives cost the app nothing.
  // 2. REPORT-ONLY, broader, for everything that CANNOT be safely turned on
  //    yet without breaking a real, documented feature:
  //      - style-src needs 'unsafe-inline': views/conversation.js sets
  //        element.style.cssText directly, which CSP treats as inline style
  //        with no nonce mechanism for JS-set style attributes.
  //      - frame-src has to stay wide open (https:/http:): views/web-panel.js
  //        embeds ARBITRARY URLs from the open_web tool (YouTube videos and
  //        general web pages) — that is the feature, not a bug, and no scoped
  //        allowlist can express "any URL the operator asked to open."
  //      - connect-src needs the two geo-IP fallback hosts
  //        widgets/kinds/weather.js calls directly from the browser
  //        (ipapi.co, ip-api.com).
  //    script-src itself DID come back clean — no eval()/new Function() and
  //    no inline <script>/on*= handlers exist anywhere in ui/public/js or
  //    index.html — so it rides along in the report-only line as 'self'
  //    'wasm-unsafe-eval' (the latter only for onnxruntime-web's WASM
  //    compile step, ui/public/js/voice/{wakeword,silero-vad}.js) to observe
  //    whether anything trips it before it is ever made enforcing for real.
  //
  // UNVERIFIED, left alone rather than guessed at: no COOP/COEP headers are
  // set here (deliberately — they would break web-panel's third-party iframe
  // embeds by requiring every framed origin to opt in), so onnxruntime-web's
  // cross-origin-isolation-gated threaded WASM variant should never be
  // selected — matching today's un-isolated behaviour either way, but not
  // independently re-verified by this change.
  function setCspHeaders(req, res, next) {
    res.setHeader('Content-Security-Policy', "object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
    res.setHeader(
      'Content-Security-Policy-Report-Only',
      "default-src 'self'; " +
      "script-src 'self' 'wasm-unsafe-eval'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob: https: http:; " +
      "media-src 'self' blob:; " +
      "font-src 'self'; " +
      "worker-src 'self' blob:; " +
      "connect-src 'self' ws: wss: https://ipapi.co https://ip-api.com http://ip-api.com; " +
      "frame-src https: http:; " +
      "object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
    );
    next();
  }
  app.use(setCspHeaders);

  app.use(express.json({ limit: '1mb' }));

  // BUG-337: DNS-rebinding guard — implementation in boot-guards.js; loopback binds only (behind a proxy Host IS foreign and tokens are mandatory anyway).
  const { createLoopbackHostGuard } = require('../src/core/server/boot-guards.js');
  if (isLoopbackBind) app.use(createLoopbackHostGuard({ configuredPort: PORT }));

  const globalLimit = createLimiter({ windowMs: 60000, max: Number(process.env.RATE_LIMIT_GLOBAL) || 240, scope: 'global-api' });
  const expensiveLimit = createLimiter({ windowMs: 60000, max: Number(process.env.RATE_LIMIT_EXPENSIVE) || 8, scope: 'expensive' });

  // H3(a) (security audit, 2026-08-08) — globalLimit above covers /api/* only;
  // the /ws upgrade (verifyClient below) had NO rate limit at all, so a wrong
  // MYTHOS_AUTH_TOKEN guess against the WS auth path could be retried at full
  // LAN speed. createLimiter is Express (req,res,next) middleware and the WS
  // upgrade path is a plain (info, callback) verifyClient — same token-bucket
  // shape as rate-limit.js, applied directly here rather than adapting that
  // module to a second calling convention. Keyed by remote IP only (there is
  // no authenticated identity yet at upgrade time); scoped separately from the
  // /api limiters so a noisy REST client can never exhaust a legitimate
  // client's WS reconnect budget or vice versa.
  const WS_UPGRADE_LIMIT_WINDOW_MS = 60000;
  const WS_UPGRADE_LIMIT_MAX = Number(process.env.RATE_LIMIT_WS_UPGRADE) || 30;
  const wsUpgradeBuckets = new Map(); // ip -> { count, resetAt }
  // Same opportunistic eviction rate-limit.js's createLimiter uses (H12): the
  // bucket Map would otherwise keep one permanent entry per distinct client IP
  // for the life of an always-on process, which is the exact unbounded-growth
  // defect H12 fixed — reintroducing it here, in the same change that adds the
  // WS limiter, would be a straight regression. Throttled to one sweep per
  // window so it never becomes an O(n) tax per upgrade, and only entries past
  // their own resetAt are removed, so no live bucket is disturbed early.
  let wsUpgradeLastSweepAt = 0;
  function wsUpgradeEvictExpired(now) {
    if (now - wsUpgradeLastSweepAt < WS_UPGRADE_LIMIT_WINDOW_MS) return;
    wsUpgradeLastSweepAt = now;
    wsUpgradeBuckets.forEach((bucket, k) => {
      if (now >= bucket.resetAt) wsUpgradeBuckets.delete(k);
    });
  }
  function wsUpgradeRateLimited(req) {
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
    const now = Date.now();
    wsUpgradeEvictExpired(now);
    let bucket = wsUpgradeBuckets.get(ip);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + WS_UPGRADE_LIMIT_WINDOW_MS };
      wsUpgradeBuckets.set(ip, bucket);
    }
    bucket.count += 1;
    return bucket.count > WS_UPGRADE_LIMIT_MAX;
  }

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

  // Refuse a request another website made (boot-guards.js explains why the PIN
  // removal made this load-bearing), before CORS headers or any handler. The same
  // instance guards /vault/builds below (security review 2026-09-23).
  const crossOriginGuard = require('../src/core/server/boot-guards.js').createCrossOriginGuard({ allowedOrigins: ALLOWED_ORIGINS, logger });
  app.use('/api', crossOriginGuard);
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
  // /auth/session is the one exempt path: it is the login endpoint for the
  // token itself (routes/auth.js), so gating it behind that token would be a
  // closed loop. It presents the secret in its own body and rate-limits itself.
  // NOTE: req.path inside app.use('/api', ...) is relative to the mount point
  // ('/auth/session', not '/api/auth/session').
  const AUTH_EXEMPT_PATHS = new Set(['/auth/session']);
  app.use('/api', clearLegacyCookies);
  app.use('/api', (req, res, next) => {
    if (AUTH_EXEMPT_PATHS.has(req.path)) return next();
    return requireToken(req, res, next);
  });
  // BUG-317: a signed artifact link substitutes for the bearer token.
  app.use('/vault/builds', crossOriginGuard);
  app.use('/vault/builds', require('../src/core/effectors/artifact-token').createArtifactAccess({ secret: AUTH_TOKEN, requireToken }));

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
  const { TEXT_ASSET_TYPES, TEXT_ASSET_RE } = require('./text-asset-types'); // NOT express.static.mime — gone in Express 5; see that file
  const UI_PUBLIC_DIR = deps.uiPublicDir || path.join(__dirname, '..', 'ui', 'public'); // injectable like routes/config.js's wakewordModelsDir — the SPA fallback below is untestable without it. BUG-360, test/spa-fallback-dot-path.test.js
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
  // F7 (go-live proof plan, 2026-08-08): gzipCache is bounded BY CONSTRUCTION
  // — keyed by absolute path, and the key space is the finite set of on-disk
  // text assets under GZIP_ROOTS (UI_PUBLIC_DIR + two vendor dirs), so it can
  // never grow without bound. Do NOT "fix" this into an eviction/cap scheme
  // without a measurement: a cap here would be premature optimization over a
  // provably finite set.
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
    res.setHeader('Content-Type', TEXT_ASSET_TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream');
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

  // Downloaded model weights, from the userData-scoped models directory.
  //
  // MOUNTED BEFORE ui/public ON PURPOSE, and this mount is what actually makes
  // the wake word work in a packaged install. The browser-side loaders fetch
  // '/models/wakeword/*.onnx' (ui/public/js/voice/wakeword.js) and
  // '/models/silero/silero_vad.onnx' (voice/silero-vad.js) over HTTP — so a
  // weight file that is not SERVED is a weight file that does not exist, however
  // correctly it was downloaded. package.json build.files excludes
  // mythos/ui/public/models, and scripts/setup-wakeword.js / setup-silero.js now
  // write to userData instead (the install tree is replaced by every update), so
  // without this mount the download would succeed and the feature would still be
  // dead. The ui/public mount below still serves a dev checkout's own models.
  const userModelsDir = userDataModelsDir();
  if (userModelsDir) {
    app.use('/models', express.static(userModelsDir, {
      // Content-addressed in practice: these files are pinned release assets that
      // only change when a downloader is re-run, and they are multi-megabyte.
      etag: true, lastModified: true, maxAge: IMMUTABLE_MAX_AGE, immutable: true, setHeaders: immutableHeaders,
      // A missing file must fall through to the ui/public mount below, not 404
      // here — that is how a machine holding its models in the OLD location keeps
      // working with no migration step.
      fallthrough: true,
    }));
    logger.info('models.served', { dir: userModelsDir });
  }

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

  // Deliberately public, and deliberately carries authRequired: the HUD needs a
  // definitive answer to "must I ask the operator for a token?" before it can
  // decide whether to paint the auth gate. This discloses nothing new — the
  // same boolean is already inferable from a 401 vs 200 on any /api/* route.
  app.get('/health', (req, res) => { res.json({ ok: true, uptime: process.uptime(), authRequired: !!AUTH_TOKEN }); });

  // BUG-111: the Gmail sensor is constructed AFTER createServer() (main.js's
  // 'sensors' step runs later than 'server'), so main.js injects the poll-count
  // getter via setGmailPollCountGetter below — same setter-injection pattern
  // already used for requestCameraFrame/requestClosePanel above.
  let gmailPollCountGetter = null;
  function setGmailPollCountGetter(fn) { gmailPollCountGetter = typeof fn === 'function' ? fn : null; }

  // F7: the two halves of the session transcript, for the conversation panel.
  // vault/Conversation/session.json is a ROLLING WINDOW (HISTORY_MAX_TURNS,
  // and it is dropped entirely once HISTORY_IDLE_TTL_MS passes), so it alone
  // shows only the last few turns — which is exactly the complaint. The day's
  // Episodic jsonl carries the rest. They overlap, so the client merges and
  // de-duplicates them (ui/public/js/views/transcript-model.js); this route
  // deliberately does no merging of its own, keeping that logic in one
  // unit-tested place rather than reimplemented on both sides of the wire.
  //
  // Raw text, not parsed: the jsonl may contain a torn final line if the
  // process died mid-write, and the client's parser already skips unparseable
  // lines without dropping the rest of the file. Parsing here would mean
  // choosing between throwing away a good file for one bad line, or
  // duplicating that tolerance.
  app.get('/api/conversation/history', (req, res) => {
    // Today only. The panel is a SESSION transcript, not an archive, and
    // reading the whole Episodic directory would grow unbounded with vault
    // age for a view that shows one day.
    const today = new Date().toISOString().slice(0, 10);
    let session = null;
    let episodic = '';
    try { session = memory.fs.readJSON('Conversation/session.json', null); } catch (_) { /* no vault, or unreadable */ }
    try { episodic = (memory.fs.readLines('Episodic/' + today + '.jsonl') || []).filter(Boolean).join('\n'); } catch (_) { /* no file yet today */ }
    // Each half degrades on its own: a missing session.json still yields the
    // episodic history, and vice versa. The panel renders whatever arrives.
    res.json({ session: session, episodic: episodic });
  });

  app.get('/api/status', async (req, res) => {
    try {
      const status = await probes.getStatus();
      // Task 12: real voiceLatency samples only — see latency-tracker.js.
      // BUG-111: surface real Gmail triage poll count so quota burn is visible
      // instead of inferred after the fact — null when the sensor never ran
      // (unconfigured, or GMAIL_TRIAGE_MODE:'off').
      // Build identity, for the HUD's version badge. recentChanges is
      // deliberately NOT included — it is a 15-commit git log, this endpoint is
      // polled, and the badge needs four short fields.
      let build = null;
      try {
        const v = version.getVersion();
        build = { version: v.version, gitRef: v.gitRef, buildTime: v.buildTime, packaged: v.packaged };
      } catch (err) {
        logger.warn('status.version-read-failed', { error: err.message });
      }
      res.json(Object.assign({}, status, {
        voiceLatency: voiceLatencyTracker.stats(),
        gmailTriagePollCount: gmailPollCountGetter ? gmailPollCountGetter() : null,
        build,
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
    // Installer parity — loadConfig's origin map (src/core/config/index.js) so
    // /api/config/settings can report which layer set each key. Undefined in
    // tests and any caller that did not thread it through; the route then says
    // origin:'unknown' rather than guessing.
    configOrigins: deps.configOrigins,
    settingsFile: deps.settingsFile,
    // For /api/config/settings' autonomy block — the effective ceiling and
    // whether it came from a real boundaries.md, a fresh vault, or the tier-1
    // malformed fail-safe. Already a createServer dep; passed through, not new.
    identity,
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

  // ---- /api/auth/session + /api/auth/logout — sign a browser in with the
  // token and out again (BUG-444: the cookie is a session id, never the token).
  // Logout closes that session's sockets, tagged in the 'connection' handler. ----
  require('./routes/auth').mountAuthRoutes(app, {
    authToken: AUTH_TOKEN,
    authTokenMatches,
    sessions: authSessions,
    onSessionRevoked: (hash) => closeSocketsForSession(hash),
    logger,
  });

  // ---- /api/setup/status — what this machine is still missing ----
  // The HUD cannot read process.env, so the first-run setup screen has no way to
  // know which keys/models are absent without asking the server. Reports names
  // and booleans only (AD-8) — see routes/setup.js for why that is safe to hand
  // to the renderer, and test/setup-route.test.js for the canary that pins it.
  require('./routes/setup').mountSetupRoutes(app, {});

  // ---- /api/setup/components — the optional components the installer's own
  // component page recorded a choice for (build/installer.nsh writes
  // %APPDATA%\MYTHOS\install-selection.json; the wizard pre-checks exactly
  // those). The installs run HERE rather than in NSIS so progress, failure and
  // retry are visible in the app instead of happening behind a copy-files
  // progress bar. IDs only over the wire — src/core/setup/components.js is the
  // allowlist mapping an id to a fixed script + argv, so no request string ever
  // reaches spawn(). See routes/components.js. ----
  require('./routes/components').mountComponentsRoutes(app, {});

  // ---- /api/setup/import — bring configuration and identity across from an
  // existing MYTHOS on this machine. The scan is read-only and the import writes
  // only what the operator confirms; secret values are never carried. See
  // routes/import-existing.js and src/core/setup/import-existing.js. ----
  require('./routes/import-existing').mountImportRoutes(app, { config, logger });

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
  //
  // THE BODY IS RAW AUDIO BYTES, NOT A FORM. req.body goes to the provider
  // untouched, and req's own Content-Type picks the upload's extension
  // (extFor() in providers/groq-stt.js). A multipart/form-data POST therefore
  // sends the MIME envelope itself to the STT provider as if it were audio, and
  // fails with a 503 that reads like an outage rather than a bad request. That
  // is not hypothetical: the phone node shipped doing exactly this, and nothing
  // caught it because the HUD uses Gemini Live / browser speech recognition and
  // never calls this route — the node is its only consumer.
  // Pinned by test/voice-node-launch-guards.test.js.
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

  // ONE VOICE PER SESSION. The chain resolves once and sticks, so the boot greeting,
  // every proactive announcement and every batch reply all come from the SAME engine
  // — the operator must never hear the voice change partway through a session. It
  // only moves on a real provider failure, and then stays moved (see providers/tts.js).
  // synthesize() returns { audio, mime, provider }: the engines emit different
  // containers (edge=MP3, gemini/piper=WAV) so the mime travels PER CHUNK.
  // Test-only seam, undefined in production (same shape as createLiveSocket
  // below): lets a test drive synthesis timing, which is the only way to observe
  // a reply that is still IN FLIGHT. With the real chain unavailable, every chunk
  // is emitted in one synchronous burst, so "mid-reply" — the entire premise of
  // the Stage 5 handoff — cannot be expressed at all.
  //
  // Named `ttsChain`, NOT `tts`, deliberately. Several existing test files already
  // pass a `tts:` dep that this file has never read, so those objects are inert
  // fakes missing most of the chain's surface (chainNames, synthesize). Honouring
  // `deps.tts` here activated all of them at once and broke 21 tests that had
  // nothing to do with this feature. Left inert rather than "fixed": making them
  // real would change what those tests exercise, which is their authors' call.
  //
  // SWAPPABLE, as of the HUD voice picker (2026-08-11). The chain object itself
  // parses VOICE_TTS_CHAIN once at construction and can never be re-pointed, so
  // "apply the newly picked voice without a restart" has to mean "build a NEW
  // chain and hand it to whoever asks next". That is all setTtsChain does.
  //
  // The one-voice guarantee survives because each speak path captures
  // currentTts() ONCE at the top of its turn (see sendSpokenReply,
  // proactiveSpeak and the vision path) and uses that same object for every
  // chunk. A swap therefore lands on the NEXT reply — the one in flight finishes
  // in the voice it started in, which is the only reading of "immediate" that
  // does not mean "change voice mid-sentence". Nothing here touches a turn's
  // AbortController, so barge-in is unaffected, and no provider holds per-chain
  // state that would need tearing down (kokoro's model cache is a module-level
  // singleton, the rest are stateless HTTP wrappers).
  // BUG-450: the SHARED circuit registry, so the voice-picker rebuild below
  // (routes/tts-voices.js) inherits what is parked instead of paying for it again.
  let ttsChainRef = deps.ttsChain || createTtsChain({ config, logger, circuits: require('../providers/tts-circuit').sharedCircuits });
  function currentTts() { return ttsChainRef; }
  function setTtsChain(next) {
    if (!next) return;
    ttsChainRef = next;
    logger.info('tts.chain-swapped', { chain: next.chainNames.join(',') });
  }
  logger.info('tts.chain', { chain: ttsChainRef.chainNames.join(',') });

  // BUG-274 T4 — WHICH ENGINE ACTUALLY MADE THE SOUND, per spoken reply.
  //
  // T4's "do first" measurement is: play the same sentence through each engine with
  // the mic live and record which come back as a transcript. MYTHOS has three, and
  // they reach the speakers by three different routes — the TTS chain's MP3 through
  // `new Audio(data:)`, the browser's own speechSynthesis, and Gemini Live's PCM
  // through an AudioContext. Only the third is identifiable in the log today
  // (live.turn-parts), and the first two were INDISTINGUISHABLE: the fallback to
  // speechSynthesis is a CLIENT-side decision taken when audioB64 comes back null,
  // and the server never recorded which way a reply went.
  //
  // So the measurement could not be scored even from a perfect session — the same
  // shape as T4 step 0, where the check that had to run first could not run at all.
  // This line makes the engine attributable per reply instead of inferred from the
  // absence of a tts.chunk-failed warning nearby.
  //
  // `engine` is what the CLIENT will do with the chunks, not what the server tried:
  // a synthesize() that threw still ships the chunk, and the browser still speaks it
  // — through a different engine, which is the entire distinction being measured.
  // 'mixed' is kept as its own value rather than rounded to either side, because a
  // reply that was half MP3 and half speechSynthesis cannot be attributed to one
  // engine and must not be silently counted as if it could.
  // Wrapped because this is instrumentation sitting on the speech path, and both call
  // sites are AFTER the chunks have already gone out. A throw here (a chain without
  // chainNames, a logger that rejects) would reject out of the speak call and cost the
  // operator the end of a reply that had already been delivered — a diagnostic
  // breaking the thing it was added to diagnose. Same rule as the playback callbacks
  // in pcm-player.js: logging must never be able to stop the audio.
  function logSpokenEngine(reqId, chunkCount, synthesizedCount, path) {
    try {
      const engine = synthesizedCount === 0 ? 'browser-speechSynthesis'
        : (synthesizedCount === chunkCount ? 'tts-chain' : 'mixed');
      const chain = ttsChainRef && Array.isArray(ttsChainRef.chainNames)
        ? ttsChainRef.chainNames.join(',') : null;
      logger.info('tts.spoke', {
        reqId,
        path,
        engine,
        chain: engine === 'browser-speechSynthesis' ? null : chain,
        chunks: chunkCount,
        synthesized: synthesizedCount,
      });
    } catch (_) { /* instrumentation only — never break a reply */ }
  }

  // A voice picked in the HUD has to reach BOTH speech paths. The TTS chain is
  // rebuilt by the route below; Gemini Live reads GEMINI_LIVE_VOICE once when a
  // session is constructed, so it gets the override at that moment instead
  // (liveConfigNow, used at createLiveSession). Sessions already open keep the
  // voice they opened with — the same rule as a reply already in flight — so
  // setLiveVoice closes them and lets liveForSpeech() reopen on the next turn.
  let liveVoiceOverride = null;
  function liveConfigNow() {
    return liveVoiceOverride ? { ...config, GEMINI_LIVE_VOICE: liveVoiceOverride } : config;
  }
  function setLiveVoice(voice) {
    // Wave 6 (2026-08-13): record what we're ABOUT to replace, before
    // replacing it, so a later revertLiveVoice() has something to go back
    // to. Recorded even when the outgoing value is null (the un-overridden,
    // GEMINI_LIVE_VOICE-from-config default) — "revert" from a first switch
    // must go back to no-override, not silently do nothing.
    recordLiveVoiceSwitch(liveVoiceOverride);
    liveVoiceOverride = voice || null;
    let closed = 0;
    // `wss` is created further down; this only ever runs from an HTTP request,
    // long after boot.
    try {
      wss.clients.forEach((client) => {
        const session = (typeof client.getLiveSession === 'function') ? client.getLiveSession() : null;
        if (session && typeof session.isOpen === 'function' && session.isOpen()) {
          try { session.close('voice-changed'); closed++; } catch (_) { /* already closing */ }
        }
      });
    } catch (_) { /* no server yet — nothing open to reopen */ }
    // `closedCount`, not `sessionsClosed`: LOG_REDACT_KEYS matches key names by
    // SUBSTRING, so any key containing 'session' is replaced with [REDACTED] in
    // the client-bound copy — this line's own count included. Renaming the field
    // is the cheap half of the fix; the enforcing half is
    // test/log-redaction-collateral.test.js, which fails when any NEW log payload
    // key would be swallowed. See the LOG_REDACT_KEYS note for why the substring
    // semantics are kept rather than narrowed.
    if (closed) logger.info('live.voice-changed', { voice: liveVoiceOverride, closedCount: closed });
    return closed;
  }

  // Wave 6 — "switch back to the previous voice". Reuses setLiveVoice's own
  // close-reopen mechanism (that IS the switch; this only supplies WHAT to
  // switch to). Returns undefined when there is nothing recorded — either no
  // switch has happened yet this run, or a previous revert already consumed
  // the one entry of history this keeps — so the caller can say so honestly
  // instead of silently no-op'ing. A real revert can legitimately return
  // null (reverting TO "no override"), which is why undefined and not null
  // is the no-op sentinel here.
  function revertLiveVoice() {
    const previous = popPreviousLiveVoice();
    if (previous === undefined) return undefined; // nothing recorded to revert to
    setLiveVoice(previous);
    return previous;
  }

  // Mounted HERE, between the chain holder it depends on and the /api 404
  // catch-all below. Either side of that pair is wrong: above, currentTts does
  // not exist yet; below, every request to it answers "No such route".
  mountTtsVoiceRoutes(app, {
    config, logger, getTts: currentTts, setTts: setTtsChain, setLiveVoice, revertLiveVoice, expensiveLimit,
  });

  // Unknown /api routes answer honest JSON (the byte-identical NOVA views probe a
  // few NOVA-era routes — /api/kanban/assemble, /api/pipeline/:id/execute — whose
  // backing now lives in P7 effectors, not this REST surface; see ROADMAP.md P9).
  app.use('/api', (req, res) => {
    res.status(404).json({ error: `No such route in the MYTHOS REST surface: ${req.method} ${req.path}` });
  });

  app.get(/.*/, (req, res, next) => { // NOT '*' — Express 5's path-to-regexp 8 throws on it at registration, and '*splat' would not match '/'. test/express-5-compat.test.js
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(UI_PUBLIC_DIR, 'index.html'), { dotfiles: 'allow' }); // dotfiles MUST be set: send's default 'ignore' tests every segment of the absolute path, so any dot-directory in the install path 404s a file that exists while express.static still serves '/'. No user input reaches this path. BUG-360
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // BUG-133. body-parser throws http-errors-shaped failures for a malformed body
    // (400, entity.parse.failed) and an oversized one (413, entity.too.large).
    // Blanket-500ing those told the client the SERVER broke when the REQUEST was bad,
    // and logged every client mistake at error level as an *unhandled* fault — alert
    // noise, and retry logic retrying something that can never succeed.
    // Key on `expose`, NOT on status alone: it is the flag http-errors sets to mark a
    // message client-safe, so a future throw that merely carries a .status can never
    // leak its raw .message here.
    const status = Number(err.status || err.statusCode) || 500;
    if (status >= 400 && status < 500 && err.expose) {
      logger.warn('bad request', { requestId: req.id, path: req.path, status, error: err.message });
      return res.status(status).json({ error: err.message, requestId: req.id });
    }
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
  // BUG-292 — 2026-08-20. 147 `ws-upgrade-rejected` lines in one session, every
  // one of them reading exactly "bad or missing token" and nothing else. That is
  // a client retrying forever, and 147 identical lines cannot tell you which
  // client, so there was no action available: you cannot hand the right client a
  // token, or stop the wrong one retrying, until you can name it.
  //
  // Q2 — and this is the whole risk of the change. A fix for an auth problem must
  // not become a credential leak in a log file. So: `credential` is PRESENCE and
  // CHANNEL only, never the value; `path` is truncated at '?' so a `?token=`
  // cannot ride in on the URL; and the Authorization header is never copied. The
  // fields that identify a client (peer address, user-agent) are not secrets, and
  // are already visible to anyone who can read this log.
  //
  // Q3 — WHO READS THIS? A human triaging a retry storm, which is why it goes in
  // the existing warn rather than a new event: a second event name would split
  // one storm across two greps.
  function upgradeCallerFingerprint(req) {
    const headers = (req && req.headers) || {};
    const socket = (req && req.socket) || {};
    const rawUrl = typeof (req && req.url) === 'string' ? req.url : '';
    const queryIndex = rawUrl.indexOf('?');
    const query = queryIndex >= 0 ? rawUrl.slice(queryIndex + 1) : '';
    let credential = 'none';
    if (typeof headers.authorization === 'string' && headers.authorization.length) credential = 'header';
    // Deliberately a substring test rather than URLSearchParams: this must not be
    // able to throw on a malformed upgrade URL, because the only thing worse than
    // an unattributable rejection is an unattributable crash inside verifyClient.
    else if (/(^|&)token=/.test(query)) credential = 'query';
    const ua = typeof headers['user-agent'] === 'string' ? headers['user-agent'] : null;
    return {
      remote: socket.remoteAddress
        ? String(socket.remoteAddress) + ':' + String(socket.remotePort == null ? '?' : socket.remotePort)
        : null,
      userAgent: ua ? ua.slice(0, 120) : null,
      path: queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : (rawUrl || null),
      credential,
    };
  }

  function verifyClient(info, callback) {
    // H3(a) — checked before any origin/token logic, so a brute-force run
    // against the token check itself (not just successful connections) is
    // capped regardless of which branch below would otherwise accept or
    // reject it.
    if (wsUpgradeRateLimited(info.req)) {
      logger.warn('ws-upgrade-rejected', Object.assign({ reason: 'rate limit exceeded' }, upgradeCallerFingerprint(info.req)));
      return callback(false, 429, 'Too Many Requests');
    }
    const origin = info.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      logger.warn('ws-upgrade-rejected', Object.assign({ reason: 'foreign origin', origin }, upgradeCallerFingerprint(info.req)));
      return callback(false, 403, 'Forbidden');
    }
    if (!origin && !isLoopback(info.req)) {
      // Voice Nodes: a phone is not a browser — OkHttp (and every other
      // non-browser WS client) sends no Origin header, so this rule rejects it
      // before the token check ever runs, and no ALLOWED_ORIGINS value can
      // admit it. This branch is the only way in, and it is deliberately
      // narrower than the rule it sidesteps:
      //   - opt-in (AETHER_NODE_TRUST, default false), so an install that
      //     doesn't own a phone node keeps V2 §7.2's behaviour byte-for-byte;
      //   - a real MYTHOS_AUTH_TOKEN must be CONFIGURED, checked here rather
      //     than left to tokenOk() below, because tokenOk() returns true when
      //     no token is set (the loopback back-compat path) — and a
      //     non-loopback caller must never inherit that;
      //   - and it must PRESENT that token, via the fall-through to the same
      //     tokenOk(info.req) gate every other client passes. Nothing is
      //     trusted about the client beyond the shared secret.
      // Reject stays the default: any of those three failing lands on the 403.
      const nodeTrusted = config.AETHER_NODE_TRUST === true && !!AUTH_TOKEN;
      if (!nodeTrusted) {
        logger.warn('ws-upgrade-rejected', Object.assign({ reason: 'no origin, non-loopback' }, upgradeCallerFingerprint(info.req)));
        return callback(false, 403, 'Forbidden');
      }
      // ...and the credential really is MYTHOS_AUTH_TOKEN and nothing else.
      // tokenOk() below would also accept a browser session cookie (BUG-444),
      // which proves a browser once signed in — a different claim entirely from
      // "I am an enrolled device on this LAN". Accepting it here would mean a
      // session leaked from the HUD (XSS, or a capture on the
      // deliberately-unencrypted LAN of PROTOCOL.md §11.4) authenticates a
      // remote socket, which is exactly the widening this branch is supposed not
      // to be. So the node path checks the shared secret directly.
      if (!authTokenMatches(extractToken(info.req))) {
        logger.warn('ws-upgrade-rejected', Object.assign({ reason: 'node trust: not the auth token' }, upgradeCallerFingerprint(info.req)));
        return callback(false, 401, 'Unauthorized');
      }
    }
    if (!tokenOk(info.req)) {
      logger.warn('ws-upgrade-rejected', Object.assign({ reason: 'bad or missing token' }, upgradeCallerFingerprint(info.req)));
      return callback(false, 401, 'Unauthorized');
    }
    return callback(true);
  }

  // maxPayload is an explicit bound, not a default. The ws library's default is
  // 100 MiB per frame, while every HTTP body on this server is capped far lower
  // (express.json at 1mb, the one raw audio route at 15mb). The upgrade rate
  // limiter throttles NEW connections; it says nothing about how large a frame
  // an already-authenticated socket may send, so a single client could make the
  // server buffer 100 MiB at a time.
  //
  // 16 MiB is chosen to sit above the largest legitimate inbound frame with room
  // to spare: the biggest one is a vision-query, which carries a base64 webcam
  // JPEG at quality 0.7 and full sensor resolution (ui/public/js/vision/camera.js),
  // and the phone node's audio chunks are orders of magnitude smaller. Raise it
  // via WS_MAX_PAYLOAD_BYTES if a real frame is ever refused — a refused frame
  // closes the socket with code 1009, which is loud, not silent.
  const WS_MAX_PAYLOAD = Number(process.env.WS_MAX_PAYLOAD_BYTES) || 16 * 1024 * 1024;
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', verifyClient, maxPayload: WS_MAX_PAYLOAD });

  // BUG-444: logout closes the sockets its session opened (tagged on connection).
  function closeSocketsForSession(hash) {
    wss.clients.forEach((client) => { if (hash && client._mythosAuthSession === hash) client.close(4401, "signed out"); });
  }

  function broadcastAll(msg) {
    const payload = JSON.stringify(msg);
    wss.clients.forEach((client) => {
      if (client.readyState === 1) client.send(payload);
    });
  }

  // A confirm-request goes to EVERY open surface (see the bus subscription
  // below), but only one of them answers — so the rest sit there showing a
  // prompt for an action that has already been dispatched or declined. With
  // one screen that was invisible; with the phone as a second approval surface
  // it means the operator can approve something twice, or read a decision on
  // the phone that the desktop already made.
  //
  // Only ever announce a confirm that is genuinely GONE from the registry. A
  // failed accept can also mean "wrong connection" (T3/T4 are scoped to the
  // originating connection and a mismatch deliberately does NOT consume the
  // entry) — broadcasting that would tell the surface that legitimately owns
  // the confirm to dismiss a prompt that is still live.
  function announceConfirmResolved(confirmId, outcome) {
    broadcastAll({ type: 'confirm-resolved', payload: { id: confirmId, outcome: outcome } });
  }

  // Same fan-out, but at most ONE socket per voice node.
  //
  // A phone can hold several open sockets at once (a reconnect that raced its
  // own close, and historically a client that leaked one per reconnect). They
  // all feed a single inbound handler on the device, so a broadcast reply is
  // played once per socket — the operator hears the same sentence two or three
  // times. Text frames duplicating that way are invisible; audio is not, which
  // is why only speech uses this and the general broadcast is left alone.
  function broadcastSpeech(msg) {
    const payload = JSON.stringify(msg);
    const spokenTo = new Set();
    wss.clients.forEach((client) => {
      if (client.readyState !== 1) return;
      const nodeId = client._mythosNodeId;
      if (nodeId) {
        // The map is the authority on which socket currently IS this node.
        if (voiceNodes.get(nodeId) !== client) return;
        if (spokenTo.has(nodeId)) return;
        spokenTo.add(nodeId);
      }
      client.send(payload);
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

  // ---- Voice Nodes (Stage 3): which device the reply comes out of ----------
  //
  // nodeId -> ws, claimed by an inbound {type:'identify', role:'node', nodeId}.
  // A node's socket is the delivery address for its speech-chunk stream; the
  // node id is the SAME string everywhere — its entry in AETHER_NODE_IDS, its
  // position in the aggregator's --peers, and what it identifies as here.
  const voiceNodes = new Map();
  // FIX-PLAN 3.4 (2026-08-17): damping state for the duplicate-identify
  // anomaly — nodeId -> { at, suppressed }. BUG-253's largest untracked
  // cluster was SIX reports of one reconnect loop in ~30 minutes, each
  // narrated by the immune explainer as a fresh unexplained fault; one per
  // nodeId per minute with a suppressedCount keeps it countable without
  // re-alarming on every bounce. Same TTL-map shape as the healer's
  // suppressedTools (BUG-013). Entries are bounded by distinct node ids.
  const VOICE_NODE_DUP_ANOMALY_MIN_INTERVAL_MS = 60000;
  const voiceNodeDupAnomalyLast = new Map();
  // Wave 1 (2026-08-13): connectionId -> that connection's liveAdapter (set
  // once liveOpen() creates it, deleted on ws close). leash/confirm.js's
  // per-entry expiry timer fires with no connection context of its own — this
  // is what lets the server route an EXPIRED confirm back to the SPECIFIC
  // Live session that raised it, the same way handleConfirmReply already does
  // for an explicit accept/reject on this same connection's closure.
  const liveAdaptersByConnection = new Map();
  const gateRecordingSink = require('./voice-gate-recording').createGateRecordingSink({ logger }); // BUG-406: writes nothing unless VOICE_GATE_RECORDER=true
  // The Aether aggregator's current election owner, cached from the sensor's
  // perception. Read at speak time rather than passed in, because the sensor
  // starts in a later boot step than the server and the owner changes as the
  // operator walks around.
  let aetherOwner = null;

  // Where a spoken reply's AUDIO should go: the elected node's socket, or null
  // to speak locally exactly as before.
  //
  // Fail-honest by construction — every one of these has to hold, and any of
  // them failing means local TTS rather than silence:
  //   - the operator opted in (AETHER_NODE_AUDIO);
  //   - Aether has actually elected somebody (a null owner means no device is
  //     present, not "pick one");
  //   - that owner has identified itself here and its socket is still OPEN.
  // Note what this does NOT claim: delivering to an open socket is not proof the
  // phone played anything. A {type:'played'} ack is deliberately deferred, so
  // "routed" is the honest word for it, never "spoken".
  function nodeSpeechTarget() {
    if (!config.AETHER_NODE_AUDIO) return null;
    if (!aetherOwner) return null;
    const ws = voiceNodes.get(aetherOwner);
    if (!ws || ws.readyState !== 1) return null;
    return { nodeId: aetherOwner, ws };
  }

  // Send one speech-chunk to wherever it belongs. The three synthesis sites
  // (proactiveSpeak, sendSpokenReply, vision-query) all route through this
  // rather than each re-deciding — they had already drifted apart once, which is
  // how the third site came to be missed in planning.
  //
  // The origin connection deliberately receives NOTHING per chunk. Sending it a
  // text-only copy would look harmless and isn't: playNextChunk() speaks any
  // chunk whose audioB64 is null via speechSynthesis, so the PC would narrate
  // the reply alongside the phone — the same two-voices defect as BUG-060.
  // F2b: replies and proactive announcements share one connection speech lock.
  // Each engine's microphone gate alone cannot prevent overlapping playback.
  //
  // Queue, never discard — the risk of this change is a lost announcement, so a
  // second utterance waits rather than being dropped. But the wait is BOUNDED:
  // chunk synthesis has no global timeout, so an edge-tts request that hangs
  // would otherwise mute every later utterance for the rest of the session.
  // Past the ceiling we speak anyway, which is the same fail-open doctrine the
  // half-duplex mic gate uses (a deaf assistant, or here a mute one, is the
  // worse failure).
  const SPEECH_LOCK_CEILING_MS = 20000;
  const speechChains = new WeakMap();
  const BROADCAST_SPEECH_KEY = Object.freeze({});   // WeakMap needs an object key
  function serializeSpeech(target, fn) {
    const key = (target && typeof target === 'object') ? target : BROADCAST_SPEECH_KEY;
    const prev = speechChains.get(key) || Promise.resolve();
    let timer = null;
    const bounded = Promise.race([
      prev,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          logger.warn('speech.lock-ceiling', { ceilingMs: SPEECH_LOCK_CEILING_MS });
          resolve();
        }, SPEECH_LOCK_CEILING_MS);
      }),
    ]).then(() => { if (timer) clearTimeout(timer); });
    const next = bounded.then(fn);
    // The stored tail swallows rejections so ONE failed utterance cannot wedge
    // the queue for the connection; the caller still sees the real rejection.
    speechChains.set(key, next.then(() => {}, () => {}));
    return next;
  }

  // F2d — see the call site in sendSpokenReply. Latched, not per-turn: the
  // condition is a property of the machine's TTS install, not of this reply.
  let ttsChainDownReported = false;
  function noteTtsChainDown(ttsUp, chain) {
    if (ttsUp) { ttsChainDownReported = false; return; }   // recovered — re-arm
    if (ttsChainDownReported) return;
    ttsChainDownReported = true;
    const chainNames = (chain && chain.chainNames) || [];
    logger.warn('tts.chain-down', {
      chain: chainNames.join(' -> '),
      note: 'no configured TTS provider can speak; replies will use the browser voice, '
        + 'which is a DIFFERENT voice from the entity\'s',
    });
    try {
      bus.emit('health.anomaly', {
        kind: 'tts-chain-down',
        target: 'tts',
        reason: 'No TTS provider can speak (' + (chainNames.join(', ') || 'empty chain')
          + '). MYTHOS is falling back to the browser voice, which sounds different. '
          + 'Start the edge-tts server or configure another provider.',
      });
    } catch (_) { /* health reporting must never break a reply */ }
  }

  function sendSpeechChunk(localSend, target, msg, originWs) {
    // Stage 5: a deliberate, FSM-sequenced handoff may have moved this reply to
    // another device since the target was resolved. `target` is a live object so
    // the redirect applies to the chunks that have not been sent yet — which is
    // the whole trick: the sentence continues on the new device instead of
    // restarting there.
    const current = target && target.ws;
    if (current) {
      try {
        current.send(JSON.stringify(msg));
        return;
      } catch (_) {
        // The node died mid-reply. Remaining chunks fall back to the origin
        // below rather than vanishing.
      }
    }
    // Both fallback paths below are silent by design (localSend's send() is a
    // no-op on a closed socket) — that's fine when the origin is legitimately
    // gone, but it means "answered and nobody heard it" leaves no trace. Log it
    // once here, the one place every synthesis site funnels through, instead of
    // at each send() call site.
    if (originWs && originWs.readyState !== 1) {
      logger.warn('speech.undeliverable', { reqId: msg.reqId, nodeId: target ? target.nodeId : null });
    }
    localSend(msg);
  }

  // Everything MYTHOS is currently speaking, keyed by reqId, so a handoff can
  // redirect a reply that is already in flight. Entries are removed by the
  // synthesis sites' own finally blocks — a leak here would pin closed sockets.
  const activeSpeech = new Map();

  // A handoff reached CONFIRM: §6.3 says attribution flips to the NEW owner at
  // that phase, so this is the moment to move any reply still being streamed.
  // Earlier (PREPARE/TRANSFER) the old device is still the speaker; later
  // (RELEASE) the audio is already resuming and moving it would stutter.
  function moveActiveSpeechToCurrentOwner() {
    if (activeSpeech.size === 0) return;
    const next = nodeSpeechTarget();
    activeSpeech.forEach((entry, reqId) => {
      const previous = entry.ws;
      const nextWs = next ? next.ws : null;
      if (previous === nextWs) return;
      // Tell the losing device to drop what it still has queued, or it would
      // keep talking over the device that now owns the sentence.
      if (previous && previous.readyState === 1) {
        try { previous.send(JSON.stringify({ type: 'cancel', reqId })); } catch (_) { /* gone */ }
      }
      entry.ws = nextWs;
      entry.nodeId = next ? next.nodeId : null;
      logger.info('voice-node.speech-moved', { reqId, to: entry.nodeId });
    });
  }

  // ---- Stage 4: one wake phrase lights exactly one device -----------------
  //
  // Every node runs its own detector locally, so a phrase spoken in a hallway is
  // heard by several at once. Whichever heard it says so; MYTHOS asks Aether to
  // rank them; the winner listens and the rest visibly stand down. Nothing is
  // decided here or on the phone — the only component holding every scanner's
  // RSSI is the aggregator.
  //
  // The debounce is the whole reason this is not just a passthrough: four devices
  // reporting the same phrase within a few hundred ms must produce ONE
  // arbitration, not four. Four would each emit a one-shot wakeOutcome, and the
  // later ones would arrive after the winner had already started listening —
  // suppressing the device that was mid-utterance.
  let lastWakeRequestAt = 0;
  const WAKE_DEBOUNCE_MS = 1000;

  function requestWakeArbitration(fromNodeId) {
    const now = Date.now();
    if (now - lastWakeRequestAt < WAKE_DEBOUNCE_MS) return 'debounced';
    lastWakeRequestAt = now;
    const asked = typeof deps.aetherRequestWake === 'function' ? deps.aetherRequestWake() : false;
    if (!asked) {
      // Aether is down or not enabled. Failing closed here would make the whole
      // mesh deaf, so the device that heard the phrase answers — the pre-Stage-4
      // behaviour, and the honest degradation.
      logger.info('voice-node.wake-unarbitrated', { nodeId: fromNodeId || null });
      const frame = JSON.stringify({
        type: 'wake-outcome',
        arbitrated: false,
        results: fromNodeId ? [{ id: fromNodeId, outcome: 'ACCEPTED' }] : [],
      });
      voiceNodes.forEach((ws, nodeId) => {
        if (ws.readyState !== 1) return;
        // Only the reporter is told to listen; the others are told nothing, which
        // leaves them idle rather than suppressed.
        if (nodeId === fromNodeId) { try { ws.send(frame); } catch (_) { /* gone */ } }
      });
      return 'unarbitrated';
    }
    return 'requested';
  }

  // HUD parity. The desktop is a scanner in the mesh too (the operator's own
  // bridge.py), so it should win or lose the same arbitration a phone does —
  // otherwise saying the wake phrase in the kitchen opens a turn on the PC as well
  // and two devices answer.
  //
  // The HUD cannot judge its own verdict alone: the aggregator reports scanner ids,
  // and only the operator knows which id their local bridge.py uses. So the server
  // holds the pending request and tells that one connection whether it may proceed.
  //
  // FAIL-OPEN by construction. A verdict that never arrives (Aether down, no
  // AETHER_LOCAL_SCANNER_ID configured, the local scanner absent from `results`)
  // leaves the HUD to behave exactly as it does today. Only an explicit SUPPRESSED
  // stands it down — being deaf is a worse failure than answering twice.
  let pendingLocalWake = null;

  function resolveLocalWake(results) {
    const target = pendingLocalWake;
    if (!target) return;
    pendingLocalWake = null;
    if (target.readyState !== 1) return;
    const localId = String(config.AETHER_LOCAL_SCANNER_ID || '').trim();
    let accepted = true;
    let reason = 'not-arbitrated';
    if (localId) {
      const entry = (results || []).find((r) => r && r.id === localId);
      if (entry) {
        accepted = entry.outcome === 'ACCEPTED';
        reason = accepted ? 'accepted' : 'suppressed-by-aether';
      } else {
        // Absent from results means this scanner is not present — it cannot be the
        // owner, but it also was not asked to stand down, and the operator IS at
        // this machine if the HUD heard them. Fail open.
        reason = 'local-scanner-not-in-results';
      }
    }
    try { target.send(JSON.stringify({ type: 'wake-verdict', accepted, reason })); } catch (_) { /* gone */ }
  }

  // The verdict, straight from the aggregator. Relayed to every node — the losers
  // need it as much as the winner, because a device that heard the phrase and is
  // told nothing has no way to distinguish "you lost" from "nobody heard you",
  // and would either answer too or sit there looking broken.
  bus.subscribe('aether.wake-outcome', (e) => {
    const p = e.payload || {};
    const frame = JSON.stringify({
      type: 'wake-outcome', arbitrated: true, owner: p.owner || null, results: p.results || [],
    });
    voiceNodes.forEach((ws) => {
      if (ws.readyState === 1) { try { ws.send(frame); } catch (_) { /* gone */ } }
    });
    resolveLocalWake(p.results || []);
  });

  // Relay the conversation FSM to every identified node. Nodes need every phase,
  // not just CONFIRM: TRANSFER is when a phone pauses and records its playhead,
  // and RELEASE is when it resumes from that offset (§6.3).
  bus.subscribe('aether.conversation', (e) => {
    const p = e.payload || {};
    const frame = JSON.stringify({
      type: 'conversation', phase: p.phase, from: p.from, speakingScanner: p.speakingScanner,
    });
    voiceNodes.forEach((ws) => {
      if (ws.readyState === 1) { try { ws.send(frame); } catch (_) { /* gone */ } }
    });
    if (p.phase === 'CONFIRM') moveActiveSpeechToCurrentOwner();
  });
  // F2b: every entry point into this function is serialized per connection.
  // The real work is proactiveSpeakNow(); this wrapper only owns the lock.
  async function proactiveSpeak(text, targetWs, opts) {
    if (!text || !wss) return;
    return serializeSpeech(targetWs || lastActiveWs, () => proactiveSpeakNow(text, targetWs, opts));
  }

  async function proactiveSpeakNow(text, targetWs, opts) {
    if (opts?.isCurrent && !opts.isCurrent()) return;
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
    // 2026-08-06: try to OPEN one first (VOICE_UNIFIED_LIVE_VOICE). Without
    // this, entity-initiated speech — the boot greeting above all, which fires
    // 2.5s after the first connection, long before any wake word — had no Live
    // session to use and came out of edge-tts in a different voice than the
    // conversation that followed. Returns null when unified voice is off, S2S
    // is off, there is no key, or the open fails; every one of those falls
    // through to the unchanged edge-tts path below.
    // BUG-170: skipLive is for the one caller whose whole reason for existing
    // is that Live just failed to make a sound (a turn with reply text and
    // zero audio parts). Handing that text back to the same session would
    // reproduce the silence; this is the only way down to the TTS chain.
    const skipLive = !!(opts && opts.skipLive);
    let liveSession = (!skipLive && targetWs && typeof targetWs.getLiveSession === 'function') ? targetWs.getLiveSession() : null;
    // readyState guard: targetWs defaults to lastActiveWs, which may be a tab
    // that has since closed — opening a metered Gemini session to speak into a
    // dead connection is pure waste.
    if (!skipLive && !(liveSession && liveSession.isOpen()) && targetWs && targetWs.readyState === 1
        && typeof targetWs.liveForSpeech === 'function') {
      try { liveSession = await targetWs.liveForSpeech(); } catch (_) { /* stays on the TTS path */ }
      // BUG-149: falling through to the TTS chain here is exactly what the
      // operator hears as "it greeted me in a different voice" — the chain's
      // edge-tts default is en-GB-SoniaNeural, a British voice, against Live's
      // Aoede. It was SILENT: unified voice was on, the fall-through happened
      // anyway, and nothing said so. Observed 2026-08-07, caused by BUG-148's
      // duplicate gmail announcement opening/consuming Live moments earlier and
      // this greeting arriving second. Logged as a warning because with
      // VOICE_UNIFIED_LIVE_VOICE on, a fall-through is a defect, not a mode.
      // BUG-433: this fall-through has two causes and they are not one event. No
      // listener is the designed mode (the greeting speaks in the TTS voice);
      // anything else with unified voice ON is the defect BUG-149 named.
      const noListener = typeof targetWs.hasLiveListener === 'function' && !targetWs.hasLiveListener();
      if (!(liveSession && liveSession.isOpen()) && config.VOICE_UNIFIED_LIVE_VOICE && noListener) {
        logger.info('proactive.live-skipped-no-listener', { note: 'no client is listening on the Live channel; speaking via the TTS chain' });
      } else if (!(liveSession && liveSession.isOpen()) && config.VOICE_UNIFIED_LIVE_VOICE) {
        logger.warn('proactive.live-unavailable-voice-will-differ', {
          note: 'unified live voice is ON but no Live session — speaking via the TTS chain instead',
          chain: String(config.VOICE_TTS_CHAIN || process.env.VOICE_TTS_CHAIN || ''),
        });
      }
    }
    if (liveSession && liveSession.isOpen()) {
      // BUG-117: same self-describing prefix the tool-outcome pushes use — a
      // proactive alert is even easier to misread as the operator speaking.
      // BUG-273 D3: every injection names itself now. This is the entity speaking
      // unprompted (an announcement, an anomaly, the boot greeting), which is exactly
      // the class the operator described as "rambling on by yourself" — and the class
      // that was indistinguishable in the log from a tool outcome or from the operator
      // typing, because all thirteen sites called one unlabelled function.
      liveSession.sendText(`${SYSTEM_NOTICE_PREFIX} ${text}`, { site: 'proactive-speak' });
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
      : broadcastSpeech;
    const reqId = 'proactive-' + Date.now() + '-' + (++proactiveSeq);
    const speak = sanitizeSpoken(text);
    // Phase 2 (AETHER-WIRING): when enabled, the announcement goes to the
    // Aether aggregator (nearest-device TTS) instead of the local chain. The
    // client still gets its 'proactive-speech' + caption-only 'done' pair
    // (chunked:true, zero chunks — voice-loop.js deliverReply finishes the
    // turn silently) so the HUD shows what was said without the local machine
    // speaking it. Aggregator down -> speakViaAether() false -> local TTS.
    //
    // Stage 3 precedence: if a voice node is elected AND connected, MYTHOS's own
    // voice goes to that phone instead. Both flags routing at once would speak
    // twice — once from the aggregator's TTS on whatever machine it runs on, once
    // from the phone — so the node wins, being the endpoint we synthesize for and
    // can name in the audit.
    if (!nodeSpeechTarget() && speakViaAether(speak)) {
      sendOut({ type: 'proactive-speech', reqId, text, speak });
      sendOut({ type: 'done', reqId, say: text, speak, chunked: true, proactive: true });
      return;
    }
    sendOut({ type: 'proactive-speech', reqId, text, speak });
    // Captured ONCE for this announcement. A voice picked mid-announcement lands
    // on the next one rather than halfway through this one.
    const activeChain = currentTts();
    let ttsUp = false;
    try {
      ttsUp = await activeChain.isAvailable();
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
    ctrl._targetWs = targetWs;
    inflightSpeech.set(reqId, ctrl);
    try {
      // Always split — same fix and same reason as sendSpokenReply() below (see
      // its comment). With TTS down this used to send zero text chunks, so the
      // client spoke the whole thing as one SpeechSynthesisUtterance and Chrome
      // clipped the tail. The boot greeting rides this path, which is why the
      // operator heard the greeting cut short too.
      const textChunks = splitSentences(speak);
      // Resolved ONCE per reply, not per chunk: a reply whose chunks split
      // across two devices mid-sentence because the operator moved is worse
      // than one that finishes where it started. Stage 5's conversation handoff
      // is the deliberate, FSM-sequenced way for a sentence to move.
      const speechTarget = nodeSpeechTarget();
      // Stage 5: registered as a MUTABLE entry so a CONFIRM-phase handoff can
      // repoint it mid-reply. A reply that started LOCALLY is not registered and
      // stays local — pushing audio onto a device that was not already speaking
      // it is a different feature, and would startle the operator mid-sentence.
      if (speechTarget) activeSpeech.set(reqId, speechTarget);
      // Alert tone counts as chunk 0 of the SAME reqId's sequence (not a
      // separate turn) so it plays through the existing chunk-queue ordering
      // instead of racing a second, unregistered reqId on the client.
      const totalChunks = (alertB64 ? 1 : 0) + textChunks.length;
      let idx = 0;
      if (alertB64 && !ctrl.signal.aborted) {
        sendSpeechChunk(sendOut, speechTarget, { type: 'speech-chunk', reqId, index: idx, total: totalChunks, audioB64: alertB64, mime: 'audio/wav', text: '' }, targetWs);
        idx++;
      }
      let proactiveSynthesized = 0;
      for (let i = 0; i < textChunks.length; i++) {
        if (ctrl.signal.aborted) break;
        let audioB64 = null;
        let chunkMime;
        if (ttsUp) {
          try {
            const out = await activeChain.synthesize({ text: textChunks[i], signal: ctrl.signal });
            audioB64 = out.audio.toString('base64');
            chunkMime = out.mime;
          } catch (err) {
            logger.warn('tts.proactive-chunk-failed', { error: err.message, index: i });
          }
        }
        if (audioB64) proactiveSynthesized++;
        if (ctrl.signal.aborted) break;
        sendSpeechChunk(sendOut, speechTarget, { type: 'speech-chunk', reqId, index: idx, total: totalChunks, audioB64, mime: chunkMime, text: textChunks[i] }, targetWs);
        idx++;
      }
      if (textChunks.length) logSpokenEngine(reqId, textChunks.length, proactiveSynthesized, 'proactive');
      // chunked forced true on abort, or when the alert tone alone was sent
      // (even with edge-tts down): routes the client's 'done' handling through
      // the session-checked chunk-queue path, never the non-chunked
      // speechSynthesis fallback (which would otherwise speak the just-
      // barged-in-on reply after the fact, or skip the alert chunk's queue).
      // chunked stays true when the audio went to a node: the origin's queue is
      // empty, and voice-loop.js's chunked branch finishes the turn silently
      // instead of narrating the reply a second time through speechSynthesis.
      const chunked = (ctrl.signal.aborted || speechTarget) ? true : (totalChunks > 0);
      sendOut({ type: 'done', reqId, say: text, speak, chunked, proactive: true, ...(speechTarget ? { routedToNode: speechTarget.nodeId } : {}) });
    } finally {
      inflightSpeech.delete(reqId);
      activeSpeech.delete(reqId);
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
      connectionId: ctx.connectionId || null,
      requestId: ctx.requestId || null,
      tier: ctx.tier || 0,
      // REMEDIATION P2-12: this hardcoded 'voice' unconditionally, even for
      // handleConfirmReply's confirm-accept path below (a T3+ action a human
      // approved via a HUD click, not something voice itself decided) —
      // callers now pass the real channel; 'voice' stays the default so the
      // primary (and originally only) caller is unaffected.
      channel: ctx.channel || 'voice',
      traceId: ctx.traceId || null,
      // G4: which surface (click/gesture/unknown) produced this dispatch, and
      // which confirm.accept() scope resolved it (connection/system) — see
      // handleConfirmReply and dispatch-action.js's audit write.
      surface: ctx.surface,
      acceptedScope: ctx.acceptedScope,
      origin: ctx.origin, // BUG-446: a cortex-raised confirm is re-checked at execution
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
    if (!(e && e.payload && e.payload.text)) return;
    // 2026-08-10: an UNPLAYBOOKED internal diagnostic must not interrupt a live
    // conversation. That session heard, mid-exchange and five times over, "One of
    // my internal checks has no automatic fix: live-turn-no-user-transcript" —
    // every one of them a false alarm (fixed at source in
    // src/core/voice/live-session.js), and none of them anything the operator
    // could act on while talking.
    //
    // Deliberately NOT solved by softening the words. AD-5 (BUG-123) requires the
    // real condition to be NAMED rather than narrated into invented prose, and
    // test/bug-123-anomaly-honest-phrasing.test.js pins exactly that — so the slug
    // is the honest part, not the defect. What was wrong was the timing.
    //
    // Scope is narrow on purpose: only payloads the explainer marks
    // internalDiagnostic, and only while a Live session is actually open. Genuine
    // critical health speech is untouched, and the anomaly still reaches the HUD,
    // the log and the audit either way — this drops one spoken interruption, not
    // the record of it.
    if (e.payload.internalDiagnostic) {
      const ws = lastActiveWs;
      const live = (ws && typeof ws.getLiveSession === 'function') ? ws.getLiveSession() : null;
      if (live && live.isOpen()) {
        logger.info('immune-explain.not-spoken-during-live', {
          kind: e.payload.kind || null,
          reason: 'a Live conversation is in progress — the anomaly is in the log, the audit and the HUD',
        });
        return;
      }
    }
    proactiveSpeak(e.payload.text).catch((err) => logger.warn('proactive.speak-failed', { error: err.message }));
  });

  // ---- Boot greeting (JARVIS-style) ----
  // Fired once per boot, on the FIRST dashboard connection: a persona-voiced
  // spoken greeting with a one-line situational brief, delivered through the
  // same proactiveSpeak() path as every other entity-initiated speech. The
  // "upgraded since last boot" check compares the current git ref against
  // Identity/last-boot.json (written at construction, so the diff survives
  // even if the brain is offline when the client connects).
  // BOOT_GREETING=false disables greetings; NODE_TEST_CONTEXT also avoids delayed test fetches.
  // BUG-148: the gmail-batch subscriber needs to know whether the greeting has
  // actually been DELIVERED, so this is set after proactiveSpeak, never at
  // arming time. It starts true wherever no greeting will be spoken at all.
  //
  // BUG-433 (2026-09-18) deleted its companion `bootGreetingFired`. That flag
  // meant "a timer is running", which was the only record of the single shot
  // while arming happened on connection; the scheduler owns that state now, and
  // a second variable saying the same thing is what let the 09-16 greeting be
  // marked spent before anything had been spoken.
  // The old two-line form ORed in `BOOT_GREETING==='false' && !hasSettingsWarnings`
  // on top of a plain `BOOT_GREETING==='false'`, so the warnings term could never
  // change the result. Same value, arithmetic no longer hiding that.
  let bootGreetingDelivered = !!process.env.NODE_TEST_CONTEXT || process.env.BOOT_GREETING === 'false';
  const serverBootAt = Date.now();
  // How long after boot the greeting is still considered "about to happen". Only
  // used to bound the gmail suppression below, so a sensor batch arriving hours
  // later is never silently swallowed.
  const BOOT_GREETING_WINDOW_MS = 60000;
  // How long after the first dashboard connection the greeting waits (see the
  // arming site). A variable rather than a constant purely so a test can shorten
  // it — the real 2.5s outlives a test file, and BUG-178's race is unobservable
  // from outside without arming the actual timer.
  let bootGreetingDelayMs = 2500;
  // BUG-433 (2026-09-18). The greeting used to arm on the FIRST connection and
  // mark the single shot fired at that moment. On 2026-09-16 that connection
  // was a PIN-locked HUD, which drops proactive speech before registering a
  // handler — so the audio was synthesized, sent, discarded, and logged as
  // delivered. "Something connected" is not "something can play this", and only
  // the client knows the second one. It says so in a `hud-ready` message; this
  // scheduler waits for one that can. States and rationale: ./boot-greeting.js.
  // Keyed by connection id, NOT one mutable "the greetable socket": the scheduler already
  // owns which connection the shot belongs to, and a second variable tracking
  // the same fact can disagree with it. A first draft here did — a second tab
  // announcing itself while tab one was scheduled was refused by the scheduler
  // and still overwrote the socket, so the greeting would have gone to a tab the
  // scheduler had never chosen. The socket is now DERIVED from the target id.
  const greetableSockets = new Map();
  const greetingScheduler = require('./boot-greeting').createGreetingScheduler({
    get delayMs() { return bootGreetingDelayMs; },
    log: (event, data) => logger.info(event, data),
    // Re-asked when the timer fires: the operator can relock, or the tab can
    // close, inside the delay — which is precisely where 09-16's greeting died.
    stillEligible: (id) => { const s = greetableSockets.get(id); return !!s && s.readyState === 1 && !s._mythosNodeId; },
    deliver: (id) => deliverBootGreeting(greetableSockets.get(id)),
  });
  const LAST_BOOT_PATH = 'Identity/last-boot.json';
  const bootUpgrade = { upgraded: false, changes: [] };
  // Genuine "since this entity was last alive" instant for the self-healing
  // briefing fact (TASK B4 code review) — read from the SAME prev record
  // bootUpgrade already diffs gitRef against, before it gets overwritten
  // below with this boot's own bootDate. null on a first run (no
  // Identity/last-boot.json yet) or if the version-check try below fails;
  // briefing.js's buildBriefingFacts() falls back to a fixed window itself
  // when this stays null.
  let previousBootAt = null;
  try {
    const v = version.getVersion();
    const prev = memory.fs.readJSON(LAST_BOOT_PATH, null);
    if (prev && prev.bootDate) {
      const parsed = Date.parse(prev.bootDate);
      if (!Number.isNaN(parsed)) previousBootAt = parsed;
    }
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

  // What the last update did, if anything — electron/main.js forwards
  // unfinishedUpdate()'s result as MYTHOS_UPDATE_RESULT (JSON) just before
  // forking this process. getUpdateReport() throws on a present-but-corrupt/
  // malformed value rather than returning the same null it returns for
  // "absent" — that distinction matters here: a caught parse failure is
  // logged and otherwise ignored (no fact, no episodic entry), but it must
  // never be silently treated as "no update happened".
  let updateReport = null;
  try {
    updateReport = getUpdateReport();
  } catch (err) {
    logger.warn('boot-greeting.update-report-invalid', { error: err.message });
  }
  if (updateReport) {
    // One episodic entry, not one per fact — recallable later so "what
    // changed recently" and self-knowledge answers stay truthful even after
    // the boot greeting itself has scrolled out of the dedup window.
    try {
      memory.episodic.write({
        kind: 'system',
        summary: updateReport.completed
          ? 'Update completed: v' + updateReport.from + ' -> v' + updateReport.version
          : 'Update did not complete: still on v' + updateReport.from + ' (target v' + updateReport.version + ')',
        detail: updateReport,
        salience: 0.5,
      });
    } catch (_) { /* memory must never block boot */ }
  }

  // TWO-BRAIN KEY SEPARATION — REMOVED AS A CHECK, KEPT AS A NOTE (W6,
  // 2026-08-22). This compared config.MISTRAL_API_KEY against
  // HERMES_PROVIDER_KEY and warned when they matched, because Hermes held its
  // OWN provider key and sharing one Mistral workspace key meant a 20-60-call
  // build ate the same rate limit as voice, vision and memory consolidation —
  // voice turns then fell back to the weakest model in the chain mid-conversation.
  //
  // Under dsh there is no separate key to compare. The engine authenticates with
  // whatever credential the BUILD LANE names, which is MISTRAL_API_KEY, so the
  // two are the same key BY CONSTRUCTION and this check would fire on every
  // boot — a warning that always fires is noise, and one that can never fire is
  // worse. The rate-limit arithmetic has NOT changed and is documented in
  // .env.example: if you hold a second Mistral workspace key, express that by
  // putting it first in the build lane, not by setting an env var nothing reads.

  // BUG-112: one greeting-shaped announcement per session, shared across every
  // source (boot greeting here, the daily planner's morning brief below) via
  // conversationAnnouncer's own isRecent/markAnnounced dedup map — reusing its
  // existing 5-minute window instead of inventing a second dedup mechanism.
  const GREETING_DEDUP_KEY = 'greeting:session';

  async function deliverBootGreeting(targetWs) {
    if (targetWs && (targetWs.readyState !== 1 || targetWs._mythosNodeId)) return false; // BUG-433: hand the shot back
    if (process.env.BOOT_GREETING === 'false') {
      await proactiveSpeak(conversationAnnouncer?.appendSettingsWarnings('', deps.settingsDiagnostics), targetWs);
      return;
    }
    const hour = new Date().getHours();
    const salutation = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    // TASK B2: fact assembly lives in conversation/briefing.js (testable behaviorally,
    // not just source-shape) and each source is individually time-boxed there.
    // `dispatch` reaches read-only T0 tools (get_weather, reminder_list) via
    // the same dispatchAction() wrapper every other caller uses — AD-1's
    // "one execution surface" rule forbids briefing.js from calling
    // effectors.invoke directly.
    const facts = await buildBriefingFacts({
      goalsEffector,
      probes,
      isProviderDown,
      bootUpgrade,
      updateReport,
      // Also backs the self-healing fact (TASK B4) via memory.audit.query —
      // no separate dep needed, briefing.js reads it off this same object.
      memory,
      // The self-healing fact's real window — see the comment where this is
      // computed above.
      previousBootAt,
      kanbanEffector,
      spend,
      snapshotSystemMetrics,
      dispatch: (tool, args) => dispatchAction({ tool, args: args || {} }, { tier: 0, channel: 'boot-briefing' }),
    });
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
              greetingRelationshipClause(previousBootAt) + // BUG-447: a first meeting is not the hundredth
              (config.LIVE_VOICE_HONESTY_ENABLED === false ? '' : GREETING_FACT_DISCIPLINE) + 'Facts you may use:\n- ' +
              facts.join('\n- ') + '\n' +
              'If a "Last time we spoke" fact is present, open by picking up that thread in half a sentence, ' +
              'the way someone resumes a conversation rather than starting one.\n' +
              'Reply with ONLY the spoken greeting: one to three short sentences, plain natural speech, no markdown, no quotes.',
          }],
          source: 'boot-greeting',
          // Opt out of BRAIN_TERSE_LANES: this lane is 'simple' (which the terse
          // style covers by default) but the result is SPOKEN, and caveman-terse
          // fragments read aloud sound like a fault, not brevity.
          terse: false,
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
    // Recheck after generation; a replacement dashboard may already be waiting.
    if (targetWs && (targetWs.readyState !== 1 || targetWs._mythosNodeId)) {
      targetWs = [...wss.clients].find((ws) => ws.readyState === 1 && !ws._mythosNodeId);
      if (!targetWs) return false; // BUG-433: nothing was spoken, so the scheduler re-arms
    }
    try {
      if (conversationAnnouncer && typeof conversationAnnouncer.markAnnounced === 'function') {
        conversationAnnouncer.markAnnounced(GREETING_DEDUP_KEY);
      }
    } catch (_) {}
    await proactiveSpeak(conversationAnnouncer ? conversationAnnouncer.appendSettingsWarnings(text, deps.settingsDiagnostics) : text, targetWs);
    // BUG-148: set AFTER the greeting has actually been spoken, so the gmail-batch
    // subscriber's suppression window closes at the right moment. Set in a finally-
    // style position rather than early, because a batch arriving while the greeting
    // is still being synthesized should still yield to it.
    bootGreetingDelivered = true;
  }

  // Calendar reminders — proactive speech when a reminder fires due.
  bus.subscribe('reminder.due', (e) => {
    if (e && e.payload && e.payload.text) {
      // F2 (2026-08-12, G5 diagnosis): 'Reminder: <text>' reads exactly like an
      // instruction to CREATE a reminder, not a report that one already fired.
      // On the Live path this notice necessarily arrives as user-role
      // realtimeInput (BUG-117 — no system channel exists), so a model reading
      // "Reminder: walk the dog" as the operator's own words called
      // reminder_add on it — the reminder re-created itself, 9 seconds later.
      // This wording is self-describing as a completed event instead.
      proactiveSpeak('This reminder has just fired and is now complete: ' + e.payload.text, undefined, { alertSound: Boolean(e.payload.alertSound) }).catch((err) => logger.warn('proactive.speak-failed', { error: err.message }));
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
    proactiveSpeak(e.payload.text).catch((err) => logger.warn('proactive.speak-failed', { error: err.message }));
    try {
      if (conversationAnnouncer && typeof conversationAnnouncer.markAnnounced === 'function') {
        conversationAnnouncer.markAnnounced(GREETING_DEDUP_KEY);
      }
    } catch (_) {}
  });
  bus.subscribe('plan.checkin', (e) => {
    if (e && e.payload && e.payload.text) proactiveSpeak(e.payload.text).catch((err) => logger.warn('proactive.speak-failed', { error: err.message }));
  });
  bus.subscribe('plan.evening-review', (e) => {
    if (e && e.payload && e.payload.text) proactiveSpeak(e.payload.text).catch((err) => logger.warn('proactive.speak-failed', { error: err.message }));
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
    proactiveSpeak(String(e.payload.text)).catch((err) => logger.warn('proactive.speak-failed', { error: err.message }));
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
    // BUG-112 residual (found 2026-08-05): this was the one greeting-shaped
    // source still calling proactiveSpeak() with no dedup at all. The boot
    // greeting already reads unread mail into its own opening line, so the
    // sensor's batch landing seconds later produced a second "you have N new
    // emails" — the exact duplicate-greeting shape BUG-112 closed everywhere
    // else. Same key, same order (check, speak, mark) as the morning brief
    // above; deliberately NOT applied to reminder.due / plan.checkin /
    // cortex.thought, which are a different class and must stay audible.
    try {
      if (conversationAnnouncer && typeof conversationAnnouncer.isRecent === 'function' &&
          conversationAnnouncer.isRecent(GREETING_DEDUP_KEY)) {
        return;
      }
    } catch (_) {}
    // BUG-148: the dedup above only works in ONE direction, and at boot it loses
    // the race. deliverBootGreeting() calls markAnnounced() but never isRecent(),
    // so it always speaks; meanwhile the gmail sensor's default 'boot-once' mode
    // polls IMMEDIATELY at start() while the greeting waits 2.5s for a client to
    // attach. The sensor therefore spoke first, marked the key, and the greeting
    // — which reads the inbox into its own opening line — spoke anyway. Result
    // observed 2026-08-07: "You have 10 new emails, including ..." at 22:08:07
    // followed by "...a bit more chaos in the inbox since we last spoke" at
    // 22:08:09. Two mail announcements, seconds apart, on every boot.
    //
    // The greeting is the canonical one (it is in-character and the operator asked
    // for it), so this raw batch yields to it rather than the reverse. Bounded by
    // BOOT_GREETING_WINDOW_MS so this can only ever suppress the boot-window
    // batch: mail arriving later still speaks normally. The sensor has already
    // added these ids to its own seenIds, which is what we want — they are
    // covered by the greeting, so they should not be re-announced later either.
    if (!bootGreetingDelivered && (Date.now() - serverBootAt) < BOOT_GREETING_WINDOW_MS) {
      logger.info('gmail.batch-deferred-to-greeting', { count: count });
      return;
    }
    proactiveSpeak(text).catch((err) => logger.warn('proactive.speak-failed', { error: err.message }));
    try {
      if (conversationAnnouncer && typeof conversationAnnouncer.markAnnounced === 'function') {
        conversationAnnouncer.markAnnounced(GREETING_DEDUP_KEY);
      }
    } catch (_) {}
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
    // BUG-306: still best-effort, no longer silent.
    //
    // This was `catch (_) {}`. A vault that had stopped accepting writes lost
    // every conversation and said nothing — the next launch simply began with no
    // history, which reads as a fresh session rather than as a failure. Best-
    // effort and invisible are separate decisions and only the first one was
    // ever made here.
    //
    // The catch stays, deliberately: the operator is mid-sentence and a disk
    // problem must not end the turn. Note this also fires for a test fake whose
    // fs exposes only vaultPath, which is a true statement about that fake —
    // history is not being persisted — and those fakes inject a silent logger.
    try {
      memory.fs.writeJSON(SESSION_PATH, { turns: history, savedAt: historyAt });
    } catch (err) {
      logger.warn('session-history-write-failed', {
        path: SESSION_PATH,
        turns: history.length,
        error: (err && err.message) || String(err),
      });
    }
  }

  wss.on('connection', (ws, req) => {
    const connectionId = crypto.randomUUID();
    const authVerdict = credentialCheck(req);
    ws._mythosAuthSession = authVerdict.via === 'session' ? authSessions.hashOf(authVerdict.sessionId) : null;
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

    // A turn's reply is addressed to the socket that ASKED, but a voice node's
    // identity outlives its sockets: a phone reconnects mid-turn (documented as
    // the normal case in NodeLink.kt — sleep, Wi-Fi roam, a server restart), and
    // since the duplicate-identify branch below now closes the superseded
    // socket, the reply for a turn already in flight had nowhere to land. It
    // vanished into the readyState check, and because `done` is the only frame
    // that returns the phone to IDLE, the phone waited forever. Live-verified
    // 2026-08-09: "thinking, thinking, thinking".
    //
    // So re-home to whatever socket currently holds this node id rather than
    // giving up on the captured one. A HUD connection has no node identity and
    // is unaffected — it keeps the old behaviour exactly.
    function send(msg) {
      if (ws.readyState === ws.OPEN) { ws.send(JSON.stringify(msg)); return; }
      const nodeId = ws._mythosNodeId;
      if (nodeId) {
        const current = voiceNodes.get(nodeId);
        if (current && current !== ws && current.readyState === 1) {
          try {
            current.send(JSON.stringify(msg));
            logger.info('speech.rehomed', { nodeId, type: msg && msg.type, reqId: msg && msg.reqId });
            return;
          } catch (_) { /* the replacement died too — fall through to the warn */ }
        }
      }
      // Silence here is what made the last two rounds of this bug invisible.
      // Only the terminal frame is worth a line: a dropped chunk is already
      // covered by sendSpeechChunk's speech.undeliverable.
      if (msg && msg.type === 'done') {
        logger.warn('speech.undeliverable', { reqId: msg.reqId, nodeId: nodeId || null, frame: 'done' });
      }
    }

    // ---- S2S Live voice (V2 §10, merged-order step 4, Phase 5) ----
    // Live session and adapter are lazy per connection, preserving the wake/cost
    // gate and compatibility with server fixtures that never exercise voice.
    let liveSession = null;
    let liveAdapter = null;
    // BUG-433: the HUD registers its onBroadcast('live-audio-out') handler inside
    // s2s-bridge start() (:1031) and only then sends live-open (:1039), so the
    // message is a faithful proxy for "this client can play Live audio" — and
    // ws.js drops an unhandled broadcast type in silence (:166-169), which is why
    // the 0.1.12 boot greeting reached Gemini and was never heard by anyone.
    let clientLiveRequested = false;
    let liveOutputGeneration = 0, operatorReqId = null, operatorLivePending = false;
    const desktop = config.DESKTOP_OPERATOR_ENABLED && deps.desktopRuntime ? require('./desktop-connection').createDesktopConnection({
      runtime: deps.desktopRuntime, connectionId, leash, dispatch: dispatchAction, send, historyAppend, logger,
      reply: sendSpokenReply, speak: async (text, opts) => {
        await proactiveSpeak(text, ws, { ...opts, skipLive: true });
      },
      cancelSpeech: opts => {
        for (const ctrl of inflightSpeech.values()) if (ctrl._targetWs === ws) ctrl.abort();
        if (!(opts?.preserveCompletedLive && liveSession?.isOpen() && !operatorLivePending)) { liveOutputGeneration++; if (liveSession) { liveSession.close('desktop-control'); send({ type: 'live-interrupted', operatorReqId }); } liveSession = null; }
        operatorReqId = null; operatorLivePending = false;
      },
    }) : null;
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
      // BUG-146: a client that asked to open a session is entitled to be told the
      // answer, even when the answer is "it was already open". This used to be a
      // bare `return`, and the HUD paints the orb/caption ONLY from live-state
      // (ui/public/js/voice/s2s-bridge.js's onLiveStateMsg) — so with a session
      // already open at boot (which VOICE_UNIFIED_LIVE_VOICE now makes the normal
      // case, since the greeting opens one ~2.5s in, long before any click), every
      // orb click produced literally zero visible feedback. Reported as "the gold
      // button does nothing at all". The reason field distinguishes this from a
      // fresh open for anyone reading the log.
      if (liveSession && liveSession.isOpen()) {
        send({ type: 'live-state', state: 'open', reason: 'already-open' });
        return;
      }
      if (!liveAdapter) {
        // AD-1/AD-2/AD-4: identical gate -> dispatch path as this connection's
        // own executeAction()/handleConfirmReply() — leash.check() -> dispatchAction().
        liveAdapter = createLiveToolAdapter({
          leash, dispatchAction: (decision, ctx) => dispatchAction(decision, { ...ctx, connectionId }), bus, logger, connectionId,
          memory, historyAppend, reflection,
          summarizeActionsForResult,
          getLiveSession: () => liveSession, speakWhenClosed: async text => {
            await proactiveSpeak(text, ws, { skipLive: true });
          },
          sanitizeErrorForClient,
          goals, // BUG-113: commitment-ledger logging in onLiveTurnComplete
          // Fix-plan 2.3: the schema key the .env.example doc points at —
          // without this the documented dial silently did nothing.
          toolAckDeadlineMs: config.TOOL_ACK_DEADLINE_MS, config,
        });
        liveAdaptersByConnection.set(connectionId, liveAdapter);
      }
      if (!liveSession) {
        // Hoisted into a named builder so it can be re-run. It used to be called
        // exactly once, and its result handed to createLiveSession as a frozen
        // array — which meant a session that rotated at the 10-minute ceiling
        // came back declaring the capabilities the machine had before the
        // rotation, contradicting this function's own comment below. Passed as a
        // FUNCTION now, the same way buildLiveSystemInstruction is (BUG-079), so
        // live-session.js rebuilds it on every open()/reconnect.
        const liveDeclarations = require('../src/core/voice/live-declarations').createLiveDeclarations({
          config, effectors, logger, desktop, desktopRuntime: deps.desktopRuntime,
          browserAgentAdapter, cuaDriverAdapter, pcChild, androidChildAdapter,
          conversationToolAllowed: require('./desktop-connection').conversationToolAllowed });
        const outputGeneration = liveOutputGeneration;
        liveSession = createLiveSession({
          // liveConfigNow() carries a voice picked in the HUD since boot.
          // live-session.js reads GEMINI_LIVE_VOICE ONCE, at construction
          // (:82), so a session built from the frozen boot config would keep
          // speaking in the old voice while every other surface had switched —
          // the picker would look broken precisely for the operator who is
          // using Live, which is now the default whenever a Google key exists.
          config: liveConfigNow(), bus, logger, spend, breakers: geminiLiveBreakers,
          createSocket: createLiveSocket, // test-only seam; undefined in production
          // BUG-436: an answer still held when the session FINALLY closes goes into the history and, if it has a spoken form, out over TTS — see createUndeliveredHandler.
          onNoticeUndelivered: require('../src/core/voice/notice-queue').createUndeliveredHandler({ historyAppend, speak: (text) => proactiveSpeak(text, ws, { skipLive: true }).catch((err) => logger.warn('proactive.speak-failed', { error: err.message })), logger }),
          // BUG-079: pass the FUNCTION, not its one-time result — live-session.js's
          // buildSetup() calls it fresh on every open()/reconnect so the local
          // time (and anything else composed here) never goes stale across a
          // long-running or rotated session.
          systemInstruction: () => buildLiveSystemInstruction(liveDeclarations.instructionBlock()),
          // BUG-079's reasoning applied to the catalog, not just the prompt: a
          // function, so a rotation re-reads which adapters are actually up.
          functionDeclarations: liveDeclarations.forSession,
          onToolCall: (calls, handlers) => desktop ? require('./desktop-connection').conversationTools(calls, handlers, liveAdapter) : liveAdapter.handleLiveToolCalls(calls, handlers),
          onAudioOut: (b64) => {
            if (outputGeneration !== liveOutputGeneration) return;
            send({ type: 'live-audio-out', data: b64, ...(desktop ? { operatorReqId } : {}) });
            if (liveTurnUserSpeechAt !== null && !liveTurnAudioRecorded) {
              voiceLatencyTracker.record(Date.now() - liveTurnUserSpeechAt);
              liveTurnAudioRecorded = true;
            }
          },
          onTranscript: (t) => {
            if (outputGeneration !== liveOutputGeneration) return;
            send({ type: 'live-transcript', role: t.role, text: t.text, ...(desktop ? { operatorReqId } : {}) });
            if (t.role === 'user' && liveTurnUserSpeechAt === null) liveTurnUserSpeechAt = Date.now();
          },
          onState: (s) => { if (outputGeneration === liveOutputGeneration) send({ type: 'live-state', state: s.state, reason: s.reason }); },
          onTurnComplete: (turn) => {
            if (outputGeneration !== liveOutputGeneration) return;
            operatorLivePending = false;
            liveAdapter.onLiveTurnComplete(turn);
            liveTurnUserSpeechAt = null;
            liveTurnAudioRecorded = false;
            // The HUD infers the end of a Live turn from its own audio queue
            // draining. A voice node cannot: its `done` ack arrives before the
            // first audio frame (say:'', routedToLive:true), so without an
            // explicit end-of-turn it has no moment at which to reopen the mic
            // or stop its reply-timeout clock. Ignored by clients that don't
            // know the frame.
            send({ type: 'live-turn-complete', ...(desktop ? { operatorReqId } : {}) });
          },
          onEchoCheck: ({ ratio, matched }) => { if (config.VOICE_ECHO_VERDICT_TO_CLIENT !== false && outputGeneration === liveOutputGeneration) send({ type: 'live-echo-check', ratio, matched }); },
          // Direct per-connection callbacks — a bare bus.subscribe here
          // would fire for every OTHER connection's interruption too.
          onInterrupted: () => { if (outputGeneration === liveOutputGeneration) send({ type: 'live-interrupted', ...(desktop ? { operatorReqId } : {}) }); },
          // BUG-170: Live produced a reply the operator could read and no
          // audio at all — which is indistinguishable, from the room, from
          // being ignored. Speak it through the TTS chain instead. skipLive
          // is not optional here: routing it back into the session that just
          // failed to speak would be the same silence again.
          onSilentTurn: ({ turnId, text, interrupts }) => {
            if (desktop) return; // Native operator audio owns this turn.
            if (outputGeneration !== liveOutputGeneration) return;
            const reason = config.LIVE_VOICE_HONESTY_ENABLED !== false && require('../src/core/voice/silent-turn').silentTurnWithheld({ text, interrupts });
            if (reason) { logger.info('live.turn-silent.withheld', { turnId, reason }); return; }
            logger.warn('live.turn-silent.speaking-via-tts', { turnId, chars: text.length });
            proactiveSpeak(text, ws, { skipLive: true })
              .catch((err) => logger.warn('live.turn-silent.tts-failed', { turnId, error: err.message }));
          },
          // Wave 2 (2026-08-13, resume-on-activity watchdog): direct
          // per-connection callback, same reason as onInterrupted above — tell
          // THIS connection's bridge to check its own captureSuspended and
          // clear early if set. The bridge (not us) knows whether it's
          // actually suspended right now.
          onSuspendedTurnAnomaly: () => send({ type: 'live-watchdog-clear' }),
        });
      }
      const ok = await liveSession.open();
      // Honest-inert: never claim S2S is up when it isn't.
      if (!ok) send({ type: 'live-state', state: 'closed', reason: 'open-failed' });
    }

    // ---- One voice on every surface (operator report, 2026-08-06) ----
    // "When mythos boots there is one voice, when I speak another, when I type
    // another." All three were real and all three came from the same root: the
    // Live session is opened LAZILY by liveOpen() above (the wake-word/cost
    // gate), so entity-initiated speech and typed-only turns had no Live session
    // to speak through and fell to edge-tts — or, while the edge-tts sidecar was
    // still starting, to the browser's own speechSynthesis. Three engines, three
    // voices, one session.
    //
    // This returns an OPEN Live session for this connection, opening one on
    // demand if that is allowed, or null. Callers that already had an "is Live
    // open?" branch (proactiveSpeak, the typed-utterance handler) now call this
    // first, so the branch they already had is simply taken more often — the
    // edge-tts path below them is untouched and is still what runs when this
    // returns null.
    //
    // Deliberately NOT the same thing as removing the lazy gate: mic capture is
    // still wake-word gated, and VOICE_UNIFIED_LIVE_VOICE=false restores the
    // previous behaviour exactly. Cost is real and acknowledged — a session may
    // now open without the operator having spoken — but live-session.js's
    // MAX_IDLE_ROTATIONS_WITHOUT_SPEECH ceiling still stops an unattended
    // session rotating forever.
    // THREE clients can render live-audio-out, announcing it three different ways,
    // so one predicate would be wrong for two of them: the HUD bridge sends
    // live-open; a voice node declares live-audio at identify time and never sends
    // live-open; and in operator mode operator-playback.js subscribes on its own,
    // keyed on operatorReqId, while batch STT owns the mic and the bridge never
    // starts. Naming the renderer at the call site is deliberate — one name with
    // two predicates is how this repo has broken audit semantics before. An
    // omitted renderer gets the broadcast rule, the refusing direction.
    function canRender(renderer) { return renderer === 'operator' ? !!desktop : (clientLiveRequested || ws._nodeLiveAudio === true); }
    ws.hasLiveListener = () => canRender();
    async function liveForSpeech(renderer) {
      // Opening a metered Gemini session for a client that cannot play its audio
      // spends money to produce silence (BUG-433).
      if (!canRender(renderer)) return null;
      if (!config.VOICE_UNIFIED_LIVE_VOICE) return null;
      if (!config.VOICE_S2S_ENABLED) return null;
      // No key -> open() would fail anyway; skip the attempt and the log noise.
      // process.env, not config: GOOGLE_API_KEY is not a schema key, and
      // live-session.js's open() reads it from the environment too (:207).
      if (!process.env.GOOGLE_API_KEY) return null;
      if (liveSession && liveSession.isOpen()) return liveSession;
      try {
        await liveOpen();
      } catch (err) {
        // Never let a failed open break the speech itself — the caller falls
        // through to the TTS chain exactly as before.
        logger.warn('live-for-speech.open-failed', { error: err.message });
        return null;
      }
      return (liveSession && liveSession.isOpen()) ? liveSession : null;
    }
    // proactiveSpeak() lives outside this closure — expose it the same way
    // ws.getLiveSession is (BUG-060), as a getter re-read on every call.
    ws.liveForSpeech = liveForSpeech;

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
    // F2b: same per-connection lock as proactiveSpeak — a reminder firing
    // mid-reply now queues behind it instead of playing over it.
    async function sendSpokenReply(reqId, say, meta, micStoppedAt) {
      return serializeSpeech(ws, () => sendSpokenReplyNow(reqId, say, meta, micStoppedAt));
    }

    async function sendSpokenReplyNow(reqId, say, meta, micStoppedAt) {
      if (meta?.isCurrent && !meta.isCurrent()) return;
      const speak = sanitizeSpoken(say);
      // Phase 2 (AETHER-WIRING): route the reply to the nearest device instead
      // of the local TTS chain. The client still gets its caption-only 'done'
      // (chunked:true, zero chunks — voice-loop.js finishes the turn silently)
      // so the HUD shows the reply without the local machine speaking it.
      // BUG-060 guard (mirrors proactiveSpeak): with a Gemini Live session open
      // on this connection, Live's PCM playback is already the entity's voice —
      // never ALSO route the batch reply to the Aether device (two voices).
      const liveSession = (typeof ws.getLiveSession === 'function') ? ws.getLiveSession() : null;
      // Same three-way precedence as proactiveSpeak: an open Live session wins
      // over everything (its PCM playback IS the entity's voice — BUG-060), then
      // an elected voice node, then the aggregator's own TTS.
      if (!(liveSession && liveSession.isOpen()) && !nodeSpeechTarget() && speakViaAether(speak)) {
        try { send({ type: 'done', reqId, say, speak, chunked: true, ...meta }); } catch (_) { /* client gone */ }
        return;
      }
      // F2 (2026-08-15) — THE THIRD SPEECH PATH. proactiveSpeak() and
      // handleVisionQuery() have both had this guard since BUG-060; this one
      // never got it, and BUGS.md has recorded it since 2026-07-31 as "Known
      // remaining gap, NOT fixed in this pass" (BUG-083). The check two lines
      // above LOOKS like the guard but only gates the Aether short-circuit —
      // with an open Live session and no Aether device, control fell straight
      // through into the synthesis loop below.
      //
      // What the operator heard on 2026-08-14: at 21:45:59 all three TTS
      // providers failed within 4ms (gemini-tts 429, edge-tts not running,
      // kokoro-tts unresolvable — see F2c). ttsUp is then false, every chunk
      // ships audioB64:null, and voice-loop.js:528-601 speaks them through
      // window.speechSynthesis — the OS voice — while Gemini Live's PCM
      // playback was the entity's voice for the same connection. Two engines,
      // one connection, guaranteed to differ in timbre.
      //
      // Conversation uses the Live system-notice route. Node replies retain their
      // originating device. Verified desktop wording bypasses model paraphrasing;
      // its task owner closes prior Live output and waits for actual TTS drain.
      if (!ws._mythosNodeId && liveSession && liveSession.isOpen() && !meta?.verifiedDesktop) {
        liveSession.sendText(`${SYSTEM_NOTICE_PREFIX} ${speak}`, { site: 'reply-routed-to-live' });
        logger.info('reply.routed-to-live', { reqId, chars: speak.length });
        try { send({ type: 'done', reqId, say, speak, chunked: true, ...meta }); } catch (_) { /* client gone */ }
        return;
      }
      // Captured ONCE for this reply — see currentTts()/setTtsChain(). Every
      // chunk below comes from this object even if the operator picks a new
      // voice mid-reply; the new one starts at the next reply.
      const activeChain = currentTts();
      const ttsUp = await activeChain.isAvailable();
      // F2d (2026-08-15): degrading to window.speechSynthesis is a CHANGE OF
      // VOICE IDENTITY, not a graceful fallback — the operator hears a different
      // entity and has no way to know why. On 2026-08-14 all three providers
      // failed within 4ms (gemini-tts quota, edge-tts not running, kokoro-tts
      // unresolvable) and nothing said so anywhere the operator could see.
      //
      // Reported through health.anomaly rather than a caption because that is
      // this system's existing honest-failure channel (it reaches the HUD and
      // the announcer), and because a caption would be overwritten by the reply
      // text a moment later. Once per session — the condition does not change
      // per turn, and a per-turn anomaly would be its own kind of noise.
      // Deliberately does NOT suppress the browser-voice fallback: a mute
      // assistant is the worse failure. The point is that it stops being silent
      // about it (rules/core.md §11.2).
      noteTtsChainDown(ttsUp, activeChain);
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
      // See proactiveSpeak: resolved once per reply, never per chunk — but
      // registered so Stage 5's handoff can move it deliberately.
      const speechTarget = nodeSpeechTarget();
      if (speechTarget) activeSpeech.set(reqId, speechTarget);
      // Item B: register an abort controller so a 'stop' for this reqId
      // (barge-in) can cancel remaining chunk synthesis below — otherwise
      // edge-tts keeps synthesizing chunks nobody will hear after the client
      // has already stopped playback locally.
      const ctrl = new AbortController();
      ctrl._targetWs = ws;
      inflightSpeech.set(reqId, ctrl);
      // Task 12: record the real mic-stop -> first-audio-frame delta exactly
      // once, on the first chunk that actually ships real audio (AD-5 — a
      // turn with no client-supplied micStoppedAt, or that never produces
      // real audio, contributes no sample rather than an estimate).
      let latencyRecorded = false;
      try {
        if (chunks.length) {
          let replySynthesized = 0;
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
                const out = await activeChain.synthesize({ text: chunks[i], signal: ctrl.signal });
                audioB64 = out.audio.toString('base64');
                chunkMime = out.mime;
              } catch (err) {
                logger.warn('tts.chunk-failed', { error: err.message, index: i });
              }
            }
            if (audioB64) replySynthesized++;
            if (ctrl.signal.aborted) break;
            if (audioB64 && typeof micStoppedAt === 'number' && !latencyRecorded) {
              voiceLatencyTracker.record(Date.now() - micStoppedAt);
              latencyRecorded = true;
            }
            sendSpeechChunk(send, speechTarget, { type: 'speech-chunk', reqId, index: i, total: chunks.length, audioB64, mime: chunkMime, text: chunks[i] }, ws);
          }
          logSpokenEngine(reqId, chunks.length, replySynthesized, 'reply');
        }
        // chunked forced true on abort (even with zero chunks sent): routes the
        // client's 'done' handling through the session-checked chunk-queue path,
        // never the non-chunked speechSynthesis fallback (which would otherwise
        // speak the just-barged-in-on reply after the fact).
        send({ type: 'done', reqId, say, speak, chunked: (ctrl.signal.aborted || speechTarget) ? true : chunks.length > 0, ...meta, ...(speechTarget ? { routedToNode: speechTarget.nodeId } : {}) });
      } finally {
        inflightSpeech.delete(reqId);
        activeSpeech.delete(reqId);
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

        // BUG-060, third site (vault/Incidents/2026-07-31.jsonl): proactiveSpeak()
        // and sendSpokenReply() are already guarded against emitting edge-tts
        // speech-chunk audio while a Gemini Live session is open on this
        // connection — Live's own PCM playback IS the entity's voice, and
        // stacking edge-tts on top of it is the "two voices" bug. This path had
        // no such check. Resolved the same way sendSpokenReply() does.
        // NOTE: this closes a real hole in THIS source file. It does not
        // establish that the installed/packaged build the operator was running
        // even contains the BUG-060 fix — packaging drift is this whole repair
        // plan's premise, and a stale packaged server/index.js would explain the
        // original incident with no new mechanism at all.
        const liveSession = (typeof ws.getLiveSession === 'function') ? ws.getLiveSession() : null;
        const liveOpen = !!(liveSession && liveSession.isOpen());

        // Captured ONCE for this vision answer, same rule as the other two speak
        // paths — every streamed sentence below comes from this chain object.
        // ttsUp forced false when Live is open: onToken below becomes undefined,
        // so the streamer/enqueueChunk machinery is never invoked and no
        // speech-chunk is ever synthesized or sent for this turn.
        const activeChain = currentTts();
        const ttsUp = liveOpen ? false : await activeChain.isAvailable();
        const streamer = createSentenceStreamer();
        // The third synthesis site. It streams sentences as the vision model
        // produces them, so it needs the same routing decision as the other two
        // — missing it would answer a vision question on the laptop while every
        // other reply came out of the phone.
        const speechTarget = nodeSpeechTarget();
        if (speechTarget) activeSpeech.set(msg.reqId, speechTarget);
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
              const out = await activeChain.synthesize({ text: spoken, signal: AbortSignal.timeout(30000) }); // GAP-ANALYSIS M2-sibling: hung sidecar here stalled every later chunk and the vision turn (undici ~300s); 30s = ACTION_TIMEOUT_MS
              audioB64 = out.audio.toString('base64');
              chunkMime = out.mime;
            } catch (err) {
              logger.warn('tts.chunk-failed', { error: err.message, index: i });
            }
            sendSpeechChunk(send, speechTarget, { type: 'speech-chunk', reqId: msg.reqId, index: i, total: null, audioB64, mime: chunkMime, text: spoken }, ws);
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

        if (liveOpen) {
          // Mirror proactiveSpeak's Live-open branch exactly: never emit
          // speech-chunk edge-tts audio on top of Live's own PCM playback.
          // The final `done` still carries the caption so the HUD shows the
          // answer, marked chunked so the client finishes the turn silently
          // instead of speaking the reply again locally.
          liveSession.sendText(`${SYSTEM_NOTICE_PREFIX} ${say}`, { site: 'ask-answer-to-live' });
          send({ type: 'done', reqId: msg.reqId, say, speak: sanitizeSpoken(say), chunked: true });
          activeSpeech.delete(msg.reqId);
          return;
        }
        if (ttsUp) {
          const tail = streamer.flush();
          if (tail) enqueueChunk(tail);
          await sendChain;
        }
        // Same reason as the other two sites: with the audio on a node, the
        // origin must take the chunked branch (silent finish) rather than
        // speaking the answer again locally.
        send({ type: 'done', reqId: msg.reqId, say, speak: sanitizeSpoken(say), chunked: speechTarget ? true : (ttsUp && chunkIndex > 0), ...(speechTarget ? { routedToNode: speechTarget.nodeId } : {}) });
        activeSpeech.delete(msg.reqId);
      } catch (err) {
        logger.warn('vision-query-error', { error: err.message, reqId: msg.reqId });
        send({ type: 'done', reqId: msg.reqId, say: `Error: ${sanitizeErrorForClient(err)}`, error: true });
      }
    }

    function handleCommand(msg) { // off unless MYTHOS_TEST_HATCH=1; loopback + leash + dispatchAction. See server/test-hatch.js.
      require('./test-hatch').handleCommand(msg, { send, leash, dispatchAction, connectionId, socket: ws, env: process.env, logger });
    }

    // Close the loop for whoever is still showing this prompt. `resolution` is
    // the outcome when the reply genuinely consumed the confirm, or null when
    // it did not — in which case we look at the registry to tell the two very
    // different failures apart:
    //   entry gone   -> already answered elsewhere, or swept after its TTL.
    //                   Safe to announce to everyone; nothing is pending.
    //   entry still  -> this connection is not the one that raised it (T3/T4
    //   pending         are connection-scoped). Only the replier is told, so
    //                   the surface that DOES own the confirm keeps its prompt.
    function reportConfirmOutcome(confirmId, resolution) {
      if (resolution) { announceConfirmResolved(confirmId, resolution); return; }
      let stillPending = null;
      try {
        if (typeof leash.confirm.peek === 'function') stillPending = leash.confirm.peek(confirmId);
      } catch (_) {}
      if (stillPending && !stillPending.expired) {
        send({ type: 'confirm-resolved', payload: { id: confirmId, outcome: 'not-permitted' } });
        return;
      }
      announceConfirmResolved(confirmId, 'expired');
    }

    async function handleConfirmReply(msg) {
      const { confirmId, accept } = msg;
      // G4: which surface produced this reply. Old clients (pre-dating this
      // field) send nothing here — recorded as 'unknown', never defaulted to
      // 'click', which would invent an attribution nobody can vouch for.
      const surface = (typeof msg.surface === 'string' && msg.surface) ? msg.surface : 'unknown';
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
        const didReject = leash.confirm.reject(confirmId, connectionId) || leash.confirm.reject(confirmId, 'system');
        reportConfirmOutcome(confirmId, didReject ? 'rejected' : null);
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
      // G4: which of the two accept() scopes actually resolved this confirm —
      // material to attribution, and previously indistinguishable in the audit.
      let acceptedScope = action ? 'connection' : null;
      if (!action) {
        const tier = typeof leash.confirm.peekTier === 'function' ? leash.confirm.peekTier(confirmId) : null;
        if (tier === null || tier <= 2) {
          action = leash.confirm.accept(confirmId, 'system');
          if (action) acceptedScope = 'system';
        }
      }
      if (!action) {
        // Was a silent no-op (matching NOVA). Silence is survivable on a modal
        // the operator is staring at; it is not on a phone, where "I tapped
        // Approve and nothing happened" is indistinguishable from a dropped
        // frame. The reply still does nothing — it just says so.
        reportConfirmOutcome(confirmId, null);
        return;
      }
      announceConfirmResolved(confirmId, 'accepted');
      // Cortex stores {decision, goalId, tier} envelopes (cortex/index.js act());
      // a bare {tool, args} decision (the spec's own test 2 fixture) passes through
      // unchanged — one normalization, no shadow dispatch paths.
      const decision = action.decision || { tool: action.tool, args: action.args };
      try {
        // REMEDIATION P2-12: this is a confirm-accept (a human clicked "yes"
        // on a T3+ popup), not the voice agent deciding on its own — label it
        // as such instead of the wrapper's default, and correlate it back to
        // the specific confirm popup that was approved.
        const outcome = await dispatchAction(decision, { goalId: action.goalId, tier: action.tier, channel: 'confirm-accept', origin: action.origin, traceId: confirmId, surface: surface, acceptedScope: acceptedScope });
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
      if (desktop?.handle(msg)) return;
      // Targeted proactive speech (Phase 3c): the most-recently-active
      // connection is whichever tab last sent ANY message, not just an
      // utterance — keeps a silently-idle-but-focused tab as the target
      // over a tab that's just replaying subscriptions on load.
      //
      // Voice-node telemetry is excluded: a phone pushes 'node-reading' several
      // times a second whenever it can see the beacon, which would pin
      // lastActiveWs to a socket that has no HUD and no speech-chunk player,
      // permanently starving reminders/nudges of the tab the operator is
      // actually looking at. Proximity is not activity.
      if (!NODE_TELEMETRY_TYPES.has(msg.type)) lastActiveWs = ws;
      // Quiet-gate reference for proactive follow-ups: an unprompted remark must
      // never land while the operator is mid-conversation.
      if (msg.type === 'utterance' || msg.type === 'vision-query') lastTurnAt = Date.now();
      // Completed task utterances were intercepted above. Conversation stays in
      // the native Live session; operator playback retains ownership until drain.
      if (msg.type === 'utterance') {
        if (desktop) {
          require('./desktop-connection').routeConversation(msg, { router: desktop, getLive: () => liveForSpeech('operator'), send, sanitize: sanitizeErrorForClient, onStart: id => { operatorReqId = id; operatorLivePending = true; } });
          return;
        }
        // Proof that the mic-hot window that ducked the speakers was a person.
        // See duckAudio/unduckAudio: two windows in a row WITHOUT this and
        // ducking backs off, because the trigger was playback, not speech.
        noteUtteranceHeard();
        // A voice node that cannot RENDER Live's audio must not be routed into
        // it. Live's reply leaves as 'live-audio-out' frames on this socket, and
        // a client with no case for them discards them silently while the ack
        // carries say:'' — so not even a caption survives. Live-verified
        // 2026-08-09: the brain answered (live.turn-parts audioParts=57) and the
        // room stayed silent.
        //
        // The batch fallback is honest but it is NOT equivalent: it answers from
        // the 'voice' lane's text chain, whose last resort the lane table itself
        // calls "fast but flat", while the desktop is talking to a native-audio
        // model. The operator heard that difference immediately. So the gate is
        // the client's declared capability, not "is it a node" — a phone that
        // says it can play PCM gets the same brain the desktop does, and an older
        // build that says nothing still gets a reply it can actually hear.
        if (ws._mythosNodeId && !ws._nodeLiveAudio) {
          queueTurn(function() { return handleUtterance(msg); });
        } else if (liveSession && liveSession.isOpen()) {
          // BUG-273 D3: operator:true. This is the HUD text box — the operator's own
          // words, arriving on the same wire frame as a pipeline injection because the
          // Live protocol has no system role after setup. Marking it system-initiated
          // (which is what an unlabelled call does) silently exempts the turn from the
          // half-blind-transcript check, i.e. from the one monitor that notices when
          // the operator was not heard.
          liveSession.sendText(String(msg.text || ''), { site: 'operator-typed', operator: true });
          send({ type: 'done', reqId: msg.reqId, say: '', routedToLive: true });
        } else {
          const typedText = String(msg.text || '');
          liveForSpeech().then((live) => {
            if (live && live.isOpen()) {
              live.sendText(typedText, { site: 'operator-typed', operator: true });
              send({ type: 'done', reqId: msg.reqId, say: '', routedToLive: true });
            } else {
              queueTurn(function() { return handleUtterance(msg); });
            }
          }).catch(() => {
            // liveForSpeech() swallows its own failures, but an unexpected
            // rejection here would strand the HUD's reqId forever — the turn
            // must always end up somewhere.
            queueTurn(function() { return handleUtterance(msg); });
          });
        }
      }
      else if (msg.type === 'vision-query') handleVisionQuery(msg);
      else if (msg.type === 'command') handleCommand(msg);
      else if (msg.type === 'confirm-reply') handleConfirmReply(msg);
      else if (msg.type === 'checkpoint-reply') handleCheckpointReply(msg);
      else if (msg.type === 'subscribe') handleSubscribe(msg);
      else if (msg.type === 'camera-frame') {
        const p = pendingFrames.get(msg.frameReqId);
        if (p) { clearTimeout(p.timer); pendingFrames.delete(msg.frameReqId); p.resolve(String(msg.image || '') || null); }
      }
      else if (msg.type === 'camera-power-ack') {
        // The HUD reports the state the camera loop actually reached, plus a
        // reason when it did not come on (permission denied, model load failed,
        // no camera). Passed through verbatim so camera_on can say WHY rather
        // than a bare failure — see requestCameraPower's contract above.
        const p = pendingCameraPower.get(msg.reqId);
        if (p) {
          clearTimeout(p.timer);
          pendingCameraPower.delete(msg.reqId);
          p.resolve({ on: !!msg.on, state: String(msg.state || ''), reason: String(msg.reason || '') });
        }
      }
      else if (msg.type === 'duck-audio') {
        duckAudio().catch(function() {}); // best-effort — never let a duck failure break voice
      }
      else if (msg.type === 'unduck-audio') {
        unduckAudio().catch(function() {});
      }
      // Wave 0 (2026-08-13): s2s-bridge.js's capture-suspend transition log —
      // fire-and-forget, no reply expected. Gives Wave 2's lost-transcript
      // diagnosis a server-side record of every suspend/clear instead of only
      // inferring it after the fact from a blind turn.
      else if (msg.type === 'voice-gate-recording') { gateRecordingSink.handle(msg).catch(() => {}); } // BUG-406: the mic-gate recorder's windows; the sink itself is off unless VOICE_GATE_RECORDER=true
      else if (msg.type === 'voice-capture-suspend') {
        // BUG-271: the own-voice-release transition also carries the ring/gate
        // diagnostics the client has computed since 36561bd (and framesZeroed
        // since the BUG-271 noise gate) — log them under their exact client
        // names instead of discarding them. Only the transitions that send a
        // field get it: a media-start line must not grow fabricated zeros.
        // No wire change; numeric/boolean fields only, never transcript text.
        const fields = { suspended: Boolean(msg.suspended), holdMs: msg.holdMs, reason: msg.reason, at: msg.at };
        // BUG-272: bargeVetoed/bargeVetoTier/bleedFloor were added to the client's
        // transition message by slice 3 and were NOT added here, so they were
        // computed, sent over the wire, and thrown away — the exact defect BUG-271
        // fixed for the fields above it, reintroduced by the commit that added new
        // ones. Found on the first live run: the log line arrived with everything
        // EXCEPT the three numbers needed to judge whether the new barge-in policy
        // is calibrated. An allowlist is the right shape here (a transcript must
        // never reach a log line by accident), but it means every new client field
        // has to be added in two places, and forgetting the second is silent.
        // BUG-273, and this is the THIRD time this exact bug has been fixed here.
        // A1 added bleedPeak/learnedFloor and A2 added flushedFrames/flushedZeroed/
        // flushedRaw to the client's transition message, and neither added them below —
        // so they were computed, sent, and dropped, exactly as the paragraph above
        // describes happening to BUG-272's three fields. flushedRaw is the ONE datum
        // A2's remaining acoustic fix waits on: two live sessions were run to collect
        // it, both produced nothing, and the verifier reported "log predates the
        // instrumentation" because a discarded field and an old log look identical to
        // it. A P0 sat blocked on "we need another session" over a missing line here.
        //
        // The list stays a list — a transcript must never reach a log line by accident.
        // What was missing was a CHECK on it, which now exists and runs every commit:
        // test/bug-273-suspend-fields-reach-the-log.test.js reads the fields the client
        // actually sends and fails if any would be dropped. Third occurrence is where
        // patching instances stops and the assertion gets written.
        for (const k of ['ownVoiceGate', 'prerollFrames', 'prerollCap', 'heldMs', 'framesDropped', 'framesZeroed', 'peakRms',
          'bargeVetoed', 'bargeVetoTier', 'bleedFloor',
          // BUG-274: the policy's own veto reason and the level it refused. bargeVetoTier
          // alone names the blocked BACKSTOP tier, which is the same string whichever of
          // the four policy causes fired — and those causes want opposite fixes. The
          // 2026-08-19 session's answer turned out to be 'already-confirmed', a veto
          // revoking a release granted one frame earlier, which no amount of tuning the
          // window or the floor would ever have reached.
          'bargeVetoPolicyReason', 'bargeVetoLevel',
          'bleedPeak', 'learnedFloor',
          'flushedFrames', 'flushedZeroed', 'flushedRaw',
          // BUG-274 W1 Q5: what Chromium actually GRANTED on the Live capture stream,
          // as opposed to what mic-device.js requested. The own-voice gate exists to
          // compensate for MYTHOS hearing itself, and the premise of removing it is
          // that AEC3 is already on — a premise nothing had ever read back. If this
          // logs false, the gate is patching a dropped constraint and the whole class
          // of fix is aimed at the wrong layer. null means not measured, which stays
          // distinguishable from measured-as-false.
          'micEchoCancellation', 'micNoiseSuppression',
          // BUG-274 step 5: how much of a model turn the barge-in suppression dropped
          // after the operator interrupted, and for how long. A local flush only empties
          // the queue — the server keeps streaming the rest of the turn — so the client
          // now drops arriving chunks until the turn ends. That mechanism eats speech by
          // design, and these two numbers are the only evidence of how much. Would have
          // been the FOURTH field dropped at this seam; caught before the live session
          // this time by bug-273-suspend-fields-reach-the-log.test.js, which now scans
          // every logSuspendTransition() call site instead of two named ones.
          'suppressedChunks', 'suppressedMs',
          // BUG-274 step 5: pcm-player.js's jitter cushion, as it stood when the
          // suppression lifted. cushionMs is how far ahead of the clock the player
          // is scheduling audio, underruns is how many times the timeline ran dry
          // anyway. Present only on a session that actually stuttered, so their
          // ABSENCE means a clean link rather than a dropped field — the one
          // reading this pair does not support, and the reason the client sends
          // them as undefined rather than as zeros.
          //
          // These are the numbers that separate "the reply was chopped because the
          // operator interrupted" from "because the audio arrived too late to play
          // continuously". Both sound identical from the room, and step 4 was built
          // on a grep that could not tell them apart.
          'cushionMs', 'underruns',
          // BUG-274 step 5b: how many times a model turn ran past the player's
          // attribution ceiling while still claiming to be open — i.e. how many
          // 'live-turn-complete' frames never reached the HUD. The cushion's
          // underrun accounting depends on that boundary, so this is the field that
          // says whether the accounting can be trusted at all. Non-zero means read
          // the server's turn frames, not the cushion; it is a different fault from
          // a slow link and is deliberately not folded into `underruns`.
          'missedTurnEnds']) {
          if (msg[k] !== undefined) fields[k] = msg[k];
        }
        logger.info('voice.capture-suspend', fields);
      }
      else if (msg.type === 'open-web-ack') {
        // Missing/malformed mounted never confirms; explicit unknown preserves noopener's absent handle.
        const w = pendingWidgetRender.get(msg.reqId);
        if (w) {
          clearTimeout(w.timer);
          pendingWidgetRender.delete(msg.reqId);
          w.resolve({
            mounted: msg.mounted === true,
            unverified: msg.mounted === false && msg.unverified === true && typeof msg.reason === 'string' && !!msg.reason.trim(),
            surface: typeof msg.surface === 'string' ? msg.surface.slice(0, 60) : null,
            reason: typeof msg.reason === 'string' ? msg.reason.slice(0, 200) : null,
          });
        }
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
        desktop?.stop().catch(error => logger.warn('desktop.stop-failed', { error: error.message }));
        const ctrl = inflightSpeech.get(msg.reqId);
        if (ctrl) ctrl.abort();
      }
      // ---- Wake-word telemetry (BUG-150) ----
      // The wake word runs entirely in the browser and reported entirely to a
      // transient HUD caption, so NOTHING about it was ever visible server-side:
      // not whether it armed, not whether audio reached it, not what it scored.
      // "Hey jarvis has never worked" was therefore undiagnosable from any log,
      // for a week. This is the read-only pipe that fixes that. It changes no
      // behaviour and drives nothing — it exists to be greppable.
      else if (msg.type === 'wakeword-status') {
        const state = String(msg.state || 'unknown').slice(0, 40);
        const fields = { state: state, detail: String(msg.detail || '').slice(0, 300) };
        // Copy only the known numeric/boolean diagnostics, so a client cannot
        // inflate the log with arbitrary keys.
        for (const k of ['peakScore', 'score', 'scores', 'frames', 'framesTotal', 'threshold', 'framesToFirstAudio']) {
          if (typeof msg[k] === 'number' && Number.isFinite(msg[k])) fields[k] = msg[k];
        }
        for (const k of ['ctxState', 'ctxStateAtStart', 'reason']) {
          if (typeof msg[k] === 'string') fields[k] = msg[k].slice(0, 40);
        }
        if (typeof msg.streamLive === 'boolean') fields.streamLive = msg.streamLive;
        // 'silent' means armed-but-deaf and 'detected-suppressed' means heard-but-
        // ignored; both are the interesting failures, so they warn rather than
        // disappear into info-level noise.
        if (state === 'silent' || state === 'error' || state === 'degraded') logger.warn('wakeword.' + state, fields);
        else logger.info('wakeword.' + state, fields);
      }
      // ---- S2S Live voice (V2 §10, Phase 5) ----
      // Voice Nodes (Stage 1): a phone's BLE observation of the tracked beacon.
      // The phone has already verified the §11.2 authenticated payload locally,
      // so a reading arriving here is one this node vouches for; the proxy turns
      // it into Aether §4.1/§4.2 wire shape for the aggregator. Unknown nodeIds
      // are logged and dropped by the proxy — never auto-registered, or a rogue
      // client could invent a room and win the election.
      else if (msg.type === 'node-reading') {
        if (scannerProxy) scannerProxy.updateReading(String(msg.nodeId || ''), { rssi: msg.rssi, name: msg.name });
      }
      else if (msg.type === 'node-lost') {
        if (scannerProxy) scannerProxy.markLost(String(msg.nodeId || ''));
      }
      // Stage 4: this node heard the wake phrase. It is a REPORT, not a claim —
      // the node does not get to decide it should answer.
      else if (msg.type === 'node-wake') {
        const reportingNodeId = String(msg.nodeId || '').trim() || null;
        // A wake reported by a connection that has NOT identified as a node is the
        // HUD competing (see resolveLocalWake). It gets an answer on this socket
        // rather than through the node relay, which it is not part of.
        if (!ws._mythosNodeId) pendingLocalWake = ws;
        const outcome = requestWakeArbitration(reportingNodeId);
        if (outcome !== 'requested' && pendingLocalWake === ws) {
          // Nothing will arrive to resolve it — answer now rather than leaving the
          // HUD waiting out its timeout on every wake.
          resolveLocalWake([]);
        }
      }
      // BUG-433: the client tells us whether it can actually PLAY proactive
      // speech — socket up, voice config loaded,
      // playback wired. A playback hint, never an authentication claim: the
      // server decides what this socket IS (`isNode` below), the message does
      // not get to say. An old HUD never sends this and is therefore never
      // greeted; that is the documented compatibility limit.
      else if (msg.type === 'hud-ready') {
        const greetable = msg.greetable === true;
        if (greetable) greetableSockets.set(connectionId, ws);
        else { greetableSockets.delete(connectionId); greetingScheduler.withdraw(connectionId, msg.why || 'not-greetable'); }
        greetingScheduler.offer({ id: connectionId, greetable, why: msg.why || null, isNode: !!ws._mythosNodeId });
      }
      // A node claims its identity, so speech can be routed back to it. Last
      // writer wins (a reconnecting phone must be able to replace its own stale
      // socket), but a duplicate claim is reported as an anomaly because the
      // usual cause is two devices misconfigured with one id — which would make
      // the election attribute one room's readings to both.
      else if (msg.type === 'identify' && msg.role === 'node') {
        const nodeId = String(msg.nodeId || '').trim();
        if (!nodeId) {
          send({ type: 'identified', ok: false, error: 'nodeId is required' });
        } else {
          const previous = voiceNodes.get(nodeId);
          if (previous && previous !== ws && previous.readyState === 1) {
            // FIX-PLAN 3.4: rate-limit to one anomaly per nodeId per minute.
            // Every suppressed bounce still increments the count, and the next
            // EMITTED anomaly carries it as suppressedCount — so the storm
            // stays countable in the vault exactly as before (rules/core.md
            // §11.2), it just stops re-invoking the explainer per bounce.
            const dupNow = Date.now();
            const dupLast = voiceNodeDupAnomalyLast.get(nodeId);
            if (dupLast && dupNow - dupLast.at < VOICE_NODE_DUP_ANOMALY_MIN_INTERVAL_MS) {
              dupLast.suppressed += 1;
            } else {
              const suppressedSinceLast = dupLast ? dupLast.suppressed : 0;
              voiceNodeDupAnomalyLast.set(nodeId, { at: dupNow, suppressed: 0 });
              bus.emit('health.anomaly', {
                kind: 'voice-node-duplicate-identify',
                summary: `Two open sockets claimed voice node "${nodeId}" — the newer one wins.`,
                detail: { nodeId, suppressedCount: suppressedSinceLast },
                // 2026-08-10: `summary` is not a field the spoken path reads.
                // immune/explainer.js narrates an unplaybooked anomaly from
                // `target` + `reason` (AD-5 deterministic wording), so this fired
                // repeatedly on 2026-08-09 and was announced as an unexplained
                // fault — while the cause was written right here. Naming the
                // benign case matters too: one phone reconnecting after a network
                // drop produces this exactly like two misconfigured devices do,
                // and the server genuinely cannot tell them apart.
                target: nodeId,
                reason: 'two open sockets claimed this voice node and the newer one won — ' +
                  'usually the same device reconnecting, but two devices sharing one node id look identical here',
              });
            }
            // "Newer one wins" only ever applied to voiceNodes; the superseded
            // socket stayed open and kept receiving, because a reply goes to the
            // socket that ASKED, not to the map. A phone that opened three
            // sockets therefore had three live conversations with one server.
            // Close it here so a stale socket cannot outlive its replacement,
            // whatever client build is on the other end.
            try { previous.close(1000, 'superseded'); } catch (_) { /* already gone */ }
          }
          voiceNodes.set(nodeId, ws);
          ws._mythosNodeId = nodeId;
          // Absent or unparseable caps mean "assume nothing" — an older phone
          // build predates this field entirely and must keep the batch path.
          ws._nodeLiveAudio = Array.isArray(msg.caps) && msg.caps.includes('live-audio');
          logger.info('voice-node.identified', { nodeId, liveAudio: ws._nodeLiveAudio });
          send({ type: 'identified', ok: true, nodeId });
        }
      }
      else if (msg.type === 'live-open') { clientLiveRequested = true; queueTurn(function () { return liveOpen(); }); }
      else if (msg.type === 'live-audio') { if (config.DESKTOP_OPERATOR_ENABLED) send({ type: 'live-state', state: 'closed', reason: 'operator-mode-requires-completed-transcription' }); else if (liveSession) liveSession.sendAudio(msg.data); }
      // Slice 3 screen share. Same guard shape as live-audio: a frame arriving
      // before live-open (or after a close) is a silent no-op, never a throw —
      // the HUD's capture loop and the session lifecycle are independent timers
      // and will always race at the edges.
      // SECURITY (2026-08-05 review, finding C2): refuse before touching the
      // session. LIVE_SCREEN_SHARE_ENABLED used to be enforced ONLY in renderer
      // JS, and this socket is unauthenticated for loopback callers on stock
      // config, so any local process could stream frames to Gemini on the
      // operator's key with screen share off. live-session.js's sendVideoFrame
      // checks too — that is the choke point; this is the cheap, explicit refusal.
      else if (msg.type === 'live-video') {
        if (liveSession && config.LIVE_SCREEN_SHARE_ENABLED === true) liveSession.sendVideoFrame(msg.data);
      }
      else if (msg.type === 'live-close') { clientLiveRequested = false; if (liveSession) liveSession.close('client-request'); }
      else if (msg.type === 'live-text') {
        if (liveSession) liveSession.sendText(String(msg.text || ''), { site: 'operator-typed', operator: true });
      }
    });

    // Tear down any open Live session when the socket itself closes — a
    // dangling Gemini socket would otherwise keep billing for open-mic time
    // with no client left to hear the reply.
    ws.on('close', () => {
      // BUG-433: a socket that goes away hands the greeting back, so the next
      // eligible HUD still gets one. The old code had already spent the single
      // shot at arming time and could not.
      greetableSockets.delete(connectionId);
      greetingScheduler.withdraw(connectionId, 'socket-closed');
      clientLiveRequested = false;
      desktop?.close().catch(error => logger.warn('desktop.disconnect-failed', { error: error.message }));
      if (liveSession) liveSession.close('ws-closed');
      liveAdaptersByConnection.delete(connectionId);
      // Drop this node's registration — but ONLY if the map still points at THIS
      // socket. A phone that reconnected before its old socket's close event
      // landed has already overwritten the entry, and unconditionally deleting
      // here would evict the live replacement and route the next reply to the
      // laptop instead.
      const nodeId = ws._mythosNodeId;
      if (nodeId && voiceNodes.get(nodeId) === ws) {
        voiceNodes.delete(nodeId);
        logger.info('voice-node.disconnected', { nodeId });
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
  // Voice Nodes: track who Aether currently says is nearest. Subscribed
  // separately from the HUD relay below because that relay drops anything under
  // MYTHOS_IDLE_SALIENCE, and speech routing must follow the election whether or
  // not the perception was interesting enough to paint. The sensor's fail-honest
  // offline emit carries owner:null, which correctly returns routing to local.
  bus.subscribe('perception.aether', (e) => {
    const detail = (e.payload && e.payload.detail) || {};
    aetherOwner = detail.owner || null;
  });

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

  // 'action.denied' | 'action.blocked' | 'action.completed' — the three real
  // action-outcome events, exact strings from cortex/index.js. `unverified` is
  // relayed alongside `ok` (Wave 0 evidence contract): the HUD must be able to
  // draw "attempted, unconfirmed" as its own state. Dropping it here is what
  // made the Agent Actions panel tick three ui_type calls that had typed
  // nothing into a visibly empty Notepad.
  //
  // Relaying only {tool, ok, ...} collapsed denied/blocked into "failed" in
  // the HUD, because they carry no `ok` at all. The state travels explicitly
  // now, and test/actions-widget-glyph.test.js pins this exact vocabulary
  // against ui/public/js/widgets/kinds/actions.js's glyphFor() so the two
  // sides cannot silently drift apart on a fourth outcome state.
  //
  // 'action.*' is a PREFIX glob (matchGlob in src/core/bus/index.js is
  // startsWith), so it also catches 'action.speak-requested' — a fourth
  // event, emitted by main.js's announcer shim and explainer.js, that has its
  // own dedicated subscriber elsewhere in this file and carries no
  // `tool`/`ok` at all. This relay is for outcome events only; anything else
  // is ignored outright rather than painted as a nameless failed row and a
  // false missing-tool warning.
  bus.subscribe('action.*', (e) => {
    const state = String(e.type || '').split('.')[1] || 'completed';
    if (state !== 'completed' && state !== 'denied' && state !== 'blocked') return;
    // `undefined` deliberately coerces to `null` here (not left as-is): the
    // payload is JSON.stringified over the wire, which drops `undefined`
    // keys entirely but keeps `null` ones — this keeps the `tool` key always
    // present on the client so `p.tool || '(unnamed action)'` sees a stable
    // shape instead of the key vanishing when `tool` is absent.
    const tool = e.payload.tool || null;
    if (!tool) logger.warn('action-relay.missing-tool', { state, reason: e.payload.reason, goalId: e.payload.goalId });
    const payload = {
      tool, state, ok: e.payload.ok, goalId: e.payload.goalId,
      reason: e.payload.reason, unverified: e.payload.unverified,
      // BUG-273 D2: the BUS event's own time, not the client's arrival time. The
      // Agent Actions feed had no way to tell two calls of the SAME tool apart, and
      // on 2026-08-18 that cost trust: an open_web widget rendered at 11:44:01 and a
      // different open_web failed at 11:44:06, so the operator read the failure row as
      // the widget's and filed *"main HUD shows incorrect error message"*. Relayed
      // rather than stamped client-side because replayBuffers replays up to 200 old
      // rows on subscribe — Date.now() at receipt would stamp all of session history
      // with the moment the panel opened, which is a worse lie than no clock at all.
      ts: e.ts,
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
    // Stage 5 (BUG-075): "open YouTube on the Electron app" (operator,
    // verbatim) needs a real second BrowserWindow, which only electron/main.js
    // (a SEPARATE OS process — the fork() parent) can create. The WS broadcast
    // below only ever reaches this process's own WS clients (the dashboard's
    // browser JS), never the Electron main process. process.send() is the
    // fork() IPC channel already set up for lifecycle when running under
    // Electron (stdio slot 3, 'ipc') — reused here, not a new channel. Absent
    // under a plain `node mythos/src/main.js` boot (no send()), which is fine:
    // there is no Electron window to open in that mode anyway.
    //
    // BUG-166: ONE surface per open_web call. This used to broadcast AND
    // relay unconditionally, so under Electron a single
    // open_web(type:"youtube") produced two players of the same video — the
    // dashboard panel plus an always-on-top media window showing YouTube's
    // Error 153 (operator incident 2026-08-07 04:04, "conflicting windows"
    // with a non-interactive panel underneath). Under Electron the media
    // window is the designed surface for youtube/web (BUG-075's ask), so the
    // panel broadcast is suppressed for exactly those two types; every other
    // widgetType (search/weather/flights/image/dynamic/newtab/news) still
    // broadcasts as before, and a plain node boot (no process.send) is
    // byte-identical to the old behaviour. A HUD open in a separate browser
    // tab while the Electron shell runs will not see a youtube panel — the
    // media window is the one surface, deliberately.
    const electronHandles = typeof process.send === 'function'
      && e.payload && (e.payload.widgetType === 'youtube' || e.payload.widgetType === 'web');
    if (!electronHandles) broadcastAll({ type: 'open-web', payload: e.payload });
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
  let pendingOpenExternal = null;     // { resolve, timer } — BUG-272 T2
  let pendingOpenPath = null;
  if (typeof process.on === 'function') {
    process.on('message', (msg) => {
      if (msg && msg.channel === 'mythos:close-media-window-ack' && pendingCloseMediaWindow) {
        clearTimeout(pendingCloseMediaWindow.timer);
        const pending = pendingCloseMediaWindow;
        pendingCloseMediaWindow = null;
        pending.resolve(Boolean(msg.closed));
        return;
      }
      // BUG-272 T2 — the ack for mythos:open-external. Same single-pending-slot
      // shape as close-media-window above: one browser hand-off at a time, so a
      // reqId-keyed Map would be more machinery than the problem needs.
      if (msg && msg.channel === 'mythos:open-external-ack' && pendingOpenExternal) {
        clearTimeout(pendingOpenExternal.timer);
        const pending = pendingOpenExternal;
        pendingOpenExternal = null;
        pending.resolve({ opened: Boolean(msg.opened), reason: msg.reason || null });
        return;
      }
      // The ack for mythos:open-path (open_file, 2026-08-21). Its own pending
      // slot, deliberately NOT shared with open-external: a file open and a
      // browser hand-off are different requests, and one superseding the other
      // would resolve the wrong promise.
      if (msg && msg.channel === 'mythos:open-path-ack' && pendingOpenPath) {
        clearTimeout(pendingOpenPath.timer);
        const pending = pendingOpenPath;
        pendingOpenPath = null;
        pending.resolve({ opened: Boolean(msg.opened), reason: msg.reason || null });
        return;
      }
      // Slice 2 (Electron shell): Ctrl+Alt+X pressed in the Electron main
      // process → OCR the screen via the pc-child adapter's screen_read_text
      // effector, then broadcast the text back to the HUD. channel:'hotkey'
      // so the audit trail attributes it to the keypress, not the cortex.
      // Fire-and-forget: a globalShortcut callback can't await, and a failure
      // must surface as an honest ocr-result, never crash the server.
      if (msg && msg.channel === 'mythos:ocr-grab') {
        // BUG-268 D4 (2026-09-16): also up the fork IPC channel, for the main-process toast + clipboard (electron/ocr-result.js — the HUD is unfocused when the hotkey fires). `npm start` has no parent: guard.
        const sendOcrResultToShell = (payload) => { if (typeof process.send !== 'function') return;
          try { process.send({ channel: 'mythos:ocr-result', payload }); }
          catch (err) { try { logger.warn('ocr.hotkey.shell-send-failed', { error: err && err.message }); } catch { /* never break the handler to log */ } } };
        (async () => {
          // BUG-268 boundary 2 (Electron callback owns boundary 1): entry without
          // outcome means dispatch hung; ok:true with empty text implicates capture/OCR.
          const startedAt = Date.now();
          try { logger.info('ocr.hotkey.received', {}); } catch { /* never break the handler to log */ }
          try {
            const r = await dispatchAction({ tool: 'screen_read_text', args: {} }, { tier: 0, channel: 'hotkey' });
            const ok = Boolean(r && r.ok);
            // fail(reason) carries a string; preserve it identically in telemetry and HUD.
            const error = ok ? undefined : (reasonText(r && r.result) || reasonText(r && r.error) || 'OCR failed');
            try {
              logger.info('ocr.hotkey.dispatched', {
                ok: ok,
                textLength: ok ? String((r.result && r.result.text) || '').length : 0,
                unverified: Boolean(r && r.unverified),
                ms: Date.now() - startedAt,
                error: error,
              });
            } catch { /* never break the handler to log */ }
            const payload = { ok: ok, text: ok ? String((r.result && r.result.text) || '') : '', error: error };
            sendOcrResultToShell(payload);
            broadcastAll({ type: 'ocr-result', payload });
          } catch (err) {
            const payload = { ok: false, text: '', error: String((err && err.message) || err || 'OCR failed') };
            sendOcrResultToShell(payload);
            try {
              broadcastAll({ type: 'ocr-result', payload });
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

  // BUG-272 T2 — hand a URL to the operator's real browser via the Electron main
  // process. Mirrors requestCloseMediaWindow exactly, with one difference that
  // matters: it resolves an OBJECT, not a boolean, because "it did not open" and
  // "it did not open BECAUSE the scheme was refused" are different things the
  // operator needs to hear, and a bare false is how the original failure stayed
  // invisible for seven attempts.
  //
  // Not under Electron (plain `npm start`, or the batch launcher without the
  // shell) resolves opened:false with a reason that says so, rather than hanging
  // or pretending. The scheme allowlist lives in the main process, next to the
  // shell.openExternal call it protects — validating here as well would be a
  // second copy to drift.
  // open_file's side of the shell hop (2026-08-21 audit). Mirrors
  // requestOpenExternal below, including the honest answer when MYTHOS is not
  // running under Electron at all — a batch/dev boot has no shell to ask.
  function requestOpenPath(filePath) {
    return new Promise((resolve) => {
      if (typeof process.send !== 'function') {
        resolve({ opened: false, reason: 'not running under the Electron shell, so there is nothing to open this with' });
        return;
      }
      if (pendingOpenPath) {
        clearTimeout(pendingOpenPath.timer);
        pendingOpenPath.resolve({ opened: false, reason: 'superseded by a newer request' });
      }
      const timer = setTimeout(() => {
        pendingOpenPath = null;
        resolve({ opened: false, reason: 'the Electron shell did not acknowledge the request' });
      }, 3000);
      pendingOpenPath = { resolve, timer };
      try { process.send({ channel: 'mythos:open-path', path: String(filePath || '') }); }
      catch (err) {
        pendingOpenPath = null;
        clearTimeout(timer);
        resolve({ opened: false, reason: err.message });
      }
    });
  }

  function requestOpenExternal(url) {
    return new Promise((resolve) => {
      if (typeof process.send !== 'function') {
        resolve({ opened: false, reason: 'not running under the Electron shell, so there is no browser to hand this to' });
        return;
      }
      if (pendingOpenExternal) {
        clearTimeout(pendingOpenExternal.timer);
        pendingOpenExternal.resolve({ opened: false, reason: 'superseded by a newer request' });
      }
      const timer = setTimeout(() => {
        pendingOpenExternal = null;
        resolve({ opened: false, reason: 'the Electron shell did not acknowledge the request' });
      }, 3000);
      pendingOpenExternal = { resolve, timer };
      try { process.send({ channel: 'mythos:open-external', url: String(url || '') }); }
      catch (err) {
        pendingOpenExternal = null;
        clearTimeout(timer);
        resolve({ opened: false, reason: err.message });
      }
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

  // B2 (2026-08-14): what survives from an anomaly payload to the permanent
  // record now lives in src/core/immune/anomaly-detail.js — a named allowlist
  // plus its bounds, extracted so the round trip is testable without booting
  // this server. See that file's header for the measured defect.
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
        // B2 (2026-08-14): `reason` joins that chain. It is the field
        // anomaly-payloads-need-reason establishes as load-bearing for the
        // spoken explanation, and a payload carrying only a reason stored as
        // "anomaly: live-turn-no-user-transcript — " — a trailing dash and
        // nothing else.
        summary: 'anomaly: ' + (e.payload.kind || 'unknown') + ' — ' + anomalySummaryDetail(e.payload),
        detail: anomalyDetail(e.payload, e.id),
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
      // Wave 0 (2026-08-13): a playbook suppressed by its own cooldown is
      // intentional throttling, not a fix that failed — labeling it
      // 'unhandled' alongside real no-match/error outcomes made a healthy
      // suppression look like a problem the healer gave up on.
      const label = actuallyHealed ? 'healed' : (p.outcome === 'cooldown' ? 'cooldown' : (p.outcome === 'acknowledged' ? 'acknowledged' : 'unhandled'));
      memory.episodic.write({
        kind: 'anomaly', channel: 'immune',
        summary: label + ': ' + (p.kind || 'unknown') + ' — ' + (p.target || ''),
        // B2: eventId is the anomaly record's join key (see anomalyDetail). This
        // record is the healer's VERDICT on that anomaly, not a second anomaly —
        // the pair is kept, but is now countable rather than doubling every tally.
        detail: { kind: p.kind, target: p.target, playbookId: p.playbookId, outcome: p.outcome, eventId: p.sourceEventId || null },
        outcome: label, salience: label === 'cooldown' ? 0.3 : (actuallyHealed ? 0.6 : 0.5),
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

  // P5 audit.decision: preserve persisted identity for snapshot/live overlap (BUG-019).
  bus.subscribe('audit.decision', (e) => {
    broadcastAll({ type: 'audit', payload: { tool: e.payload.tool, tier: e.payload.tier, decision: e.payload.decision, id: e.payload.id, ts: e.payload.ts } });
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

  // Wave 1 (2026-08-13): leash/confirm.js's per-entry expiry timer fires this
  // for a T3+ confirm nobody answered in time — the gmail_send incident
  // (1 confirm created, 0 completed, no trace of why). announceConfirmResolved
  // dismisses the prompt on every surface still showing it; the connectionId
  // routes an EXPIRED verdict to the SPECIFIC Live session that raised it, if
  // any (a modal-only confirm has no liveAdapter registered and this is a
  // silent no-op, same as resolveLiveConfirm already is for any confirm that
  // never touched the Live path).
  bus.subscribe('confirm-expired', (e) => {
    announceConfirmResolved(e.payload.confirmId, 'expired');
    const adapter = liveAdaptersByConnection.get(e.payload.connectionId);
    if (adapter) { adapter.resolveLiveConfirm(e.payload.confirmId, null, false, { expired: true }).catch(() => {}); }
  });

  bus.subscribe('confirm-request', (e) => {
    // ttlMs rides along so a surface that has to run its OWN expiry clock (the
    // phone — nothing tells a client when a confirm lapses; the registry sweeps
    // it passively) can show a truthful one instead of hardcoding a copy of
    // LEASH_CONFIRM_TTL_MS that silently disagrees the moment it is configured.
    let ttlMs = null;
    try {
      if (leash.confirm && typeof leash.confirm.stats === 'function') ttlMs = leash.confirm.stats().ttlMs;
    } catch (_) { /* a leash without stats() just means the client keeps its default */ }
    broadcastAll({ type: 'confirm-request', payload: { id: e.payload.confirmId, tool: e.payload.tool, summary: e.payload.summary, tier: e.payload.tier, ttlMs: ttlMs } });
  });

  // brain-spend — exact string with hyphen (D-28 fixed).
  bus.subscribe('brain-spend', (e) => {
    pushReplay('brain-spend', e.payload);
    broadcastAll({ type: 'brain-spend', payload: e.payload });
  });

  // log — NOT a bus event; a logger hook (see logger.js onLog(fn) diff).
  if (typeof logger.onLog === 'function') {
    logger.onLog((line) => {
      // A2: scrub the client-bound copy BEFORE both the replay buffer and the
      // live broadcast. redactLogEntry returns a new object — the original
      // entry is left untouched (stdout already got it unredacted, and any
      // other listener must see the same object logger.js emitted).
      const safe = redactLogEntry(line);
      pushReplay('log', safe);
      broadcastAll({ type: 'log', payload: safe });
    });
  }

  function stop() {
    stopBrowserOfflineNotice();
    // BUG-372: no kokoro worker thread may outlive the server. Called on the PROVIDER MODULE, not through a chain object — routes/tts-voices.js builds replacement chains over the same singleton providers, so a chain-scoped shutdown would terminate a worker another chain still holds. The obvious home is stopRunningLoops() in src/main.js beside edgeTtsChild.stop(), but that file is AT its ratchet ceiling (1373), so this must stay one line.
    try { const k = require('../providers/kokoro-tts').shutdown(); if (k && k.catch) k.catch(() => {}); } catch (_) { /* optional provider; never block shutdown on it */ }
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
    app, httpServer, wss, stop, dispatchAction, ready, requestCameraFrame, requestCameraPower, requestClosePanel,
    requestWidgetRender,
    requestCloseMediaWindow, requestOpenExternal, requestOpenPath, setGmailPollCountGetter,
    // Test-only introspection (Task 12) — never used by production callers.
    _internal: {
      voiceLatencyTracker, sanitizeErrorForClient, deliverBootGreeting, conversationAnnouncer, GREETING_DEDUP_KEY,
      // BUG-148 test seam. Under `node --test`, NODE_TEST_CONTEXT suppresses the
      // boot greeting entirely, so bootGreetingDelivered is legitimately true at
      // construction and the "a greeting is still pending" state — the whole
      // condition under test — is unreachable from the outside. This lets a test
      // put the server into that state explicitly rather than by faking env.
      setBootGreetingDelivered: (v) => { bootGreetingDelivered = Boolean(v); },
      isBootGreetingDelivered: () => bootGreetingDelivered,
      // BUG-178 test seams, same reasoning as setBootGreetingDelivered above:
      // NODE_TEST_CONTEXT pre-fires the gate, so the connection race that bug is
      // about cannot be reached from outside without re-arming it, and the real
      // 2.5s delay outlives a test file.
      rearmBootGreeting: () => { bootGreetingDelivered = false; }, // BUG-433: the scheduler owns the shot now
      setBootGreetingDelayMs: (ms) => { bootGreetingDelayMs = Number(ms) || 0; },
      // Voice Nodes: proactive speech targets lastActiveWs, and a phone pushing
      // proximity telemetry several times a second must never become that
      // target. There is no other observable for it from outside.
      getLastActiveWs: () => lastActiveWs,
      // BUG-306. historyAppend is a closure and the only production route to it
      // is a full websocket voice turn — model call, dispatch, TTS. The thing
      // under test is one line of error handling inside it, so the turn is not
      // the subject and standing one up would test everything except the fix.
      historyAppend: (role, content) => historyAppend(role, content),
      historyGet: () => historyGet(),
    },
  };
}

module.exports = { createServer };
