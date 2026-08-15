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
const { buildBriefingFacts } = require('../src/core/conversation/briefing');
const { snapshotSystemMetrics } = require('./routes/system');
const spend = require('../src/core/brain/spend');
const { dispatchAction: sharedDispatch } = require('../src/core/effectors/dispatch-action');
// S2S (V2 §6-§10, merged-order step 4, Phase 5 wiring): Gemini Live transport,
// hub->functionDeclarations conversion, and the tool-adapter safety seam.
const { createLiveSession } = require('../src/core/voice/live-session');
const { buildFunctionDeclarations } = require('../src/core/voice/live-tools');
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
const { createPinSessionStore } = require('../src/core/security/pin-session');

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
  function buildLiveSystemInstruction() {
    // BUG-117: the transport has no system role after setup, so every pipeline
    // injection arrives as user-role realtimeInput and the model attributed it
    // to the operator. This clause is the other half of SYSTEM_NOTICE_PREFIX —
    // both live in live-tool-adapter.js so they cannot drift apart.
    const parts = [RULES, LIVE_SYSTEM_NOTICE_INSTRUCTION];
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

  // H3(b) (security audit, 2026-08-08) — MYTHOS_AUTH_TOKEN had no minimum
  // length or entropy requirement, yet it is the ONLY thing standing between
  // the public internet and 166 effectors including tier-3 confirm-and-execute
  // once MYTHOS_BIND is non-loopback (see the guard just above). Reject an
  // obviously weak token at boot with the same fail-loud posture — but ONLY
  // when a token is actually configured. Running with NO token at all on
  // loopback is the documented, intentional back-compat default (every
  // pre-existing test depends on it) and is completely untouched by this;
  // this only tightens what counts as a VALID token once the operator has
  // chosen to set one.
  const MIN_AUTH_TOKEN_LENGTH = 16;
  const WEAK_AUTH_TOKEN_RE = /^(password|changeme|admin|secret|letmein|qwerty|default|token|test|12345678)/i;
  function weakAuthTokenReason(token) {
    if (token.length < MIN_AUTH_TOKEN_LENGTH) return `shorter than the ${MIN_AUTH_TOKEN_LENGTH}-char minimum`;
    if (/^(.)\1*$/.test(token)) return 'a single character repeated';
    if (new Set(token.toLowerCase()).size < 4) return 'too few distinct characters (low entropy)';
    if (WEAK_AUTH_TOKEN_RE.test(token)) return 'matches a common/weak token pattern';
    return null;
  }
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
  // mythos_token cookie) and is accepted here as an alternative credential
  // WHEN ONLY ONE of the two layers is actually active for this deployment.
  //
  // H1 FIX (security audit, 2026-08-08): when BOTH layers are actually active
  // — MYTHOS_AUTH_TOKEN is set AND pinSessionRequired() is true — neither
  // credential alone is accepted any more. Presenting the bearer token used
  // to short-circuit tokenOk() before pinSessionRequired() was ever
  // consulted, so an operator who explicitly turned PIN_SESSION_ENFORCE on
  // got zero benefit from it as long as MYTHOS_AUTH_TOKEN was also set — the
  // exact "one subsuming the other" the old comment here disclaimed while
  // the code below it did precisely that.
  //
  // The fix cannot mean "one presented string satisfies both" — extractToken()
  // resolves to a single credential per request. Instead the two layers are
  // pinned to DISTINCT channels for the combined case:
  //   - the bearer secret must arrive via Authorization header or ?token=
  //     query (extractBearerChannel) — the channels a non-browser/API client
  //     can always set;
  //   - the PIN session must arrive via the mythos_token cookie
  //     (extractCookieToken) — the only channel routes/pin.js ever issues it
  //     on.
  // This is forced by a real naming collision: routes/pin.js's session
  // cookie and the plain back-compat bearer-via-cookie path (see the
  // 'mythos_token cookie' test in server-auth.test.js) share the literal
  // cookie name mythos_token. Splitting the bearer check to header/query-only
  // for the combined case avoids that collision instead of relying on it —
  // a browser can send both a query/header bearer token AND its session
  // cookie on the same request (including a WS upgrade, which sends normal
  // headers/cookies even though it can't be scripted to set arbitrary ones
  // after the fact), so this is satisfiable by a real client, not just in
  // theory.
  //
  // Four combinations, stated explicitly:
  //   token unset,  PIN not required -> open (no credential needed) — unchanged.
  //   token unset,  PIN required     -> valid PIN session (any channel) — unchanged.
  //   token set,    PIN not required -> valid bearer token (any channel) — unchanged.
  //   token set,    PIN required     -> valid bearer (header/query) AND
  //                                      valid PIN session (cookie) — THE FIX.
  // Never "PIN session alone" when a token is configured: that would let
  // anyone who can reach POST /api/pin/verify (deliberately unauthenticated,
  // for lockout-avoidance — see routes/pin.js) obtain full access without
  // ever knowing MYTHOS_AUTH_TOKEN, making the PIN's 5-attempt lockout the
  // entire remaining attack surface on a network-exposed instance. That would
  // be worse than the bug being fixed, not a fix.
  //
  // MYTHOS_AUTH_TOKEN and ONLY MYTHOS_AUTH_TOKEN — no PIN-session alternative,
  // no "unset means open" back-compat. Used by the AETHER_NODE_TRUST branch of
  // verifyClient, where both of those leniencies would be wrong (see there).
  // Everything else keeps using tokenOk(). Untouched by the H1 fix: it never
  // consulted pinSessionRequired() and still doesn't — voice nodes have no PIN
  // concept.
  function authTokenMatches(presented) {
    if (!AUTH_TOKEN) return false;
    const a = Buffer.from(String(presented || ''));
    const b = Buffer.from(AUTH_TOKEN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function tokenOk(req) {
    if (AUTH_TOKEN && pinSessionRequired()) {
      // Both layers active: distinct channels, both required. See the block
      // comment above for why neither may be satisfied from the other's
      // channel or from a single merged credential.
      return authTokenMatches(extractBearerChannel(req)) && pinSession.isValid(extractCookieToken(req));
    }
    const presented = extractToken(req);
    if (pinSession.isValid(presented)) return true;
    if (!AUTH_TOKEN) return !pinSessionRequired();
    const a = Buffer.from(String(presented || ''));
    const b = Buffer.from(AUTH_TOKEN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // extractBearerChannel/extractCookieToken are the two channels extractToken
  // (below) merges in priority order; split out so tokenOk()'s combined-layer
  // branch above can pin each credential to its own channel instead of the
  // single merged value every other branch still uses.
  function extractBearerChannel(req) {
    const auth = req.headers && req.headers.authorization;
    if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
    try {
      const fromQuery = new URL(req.url, 'http://internal').searchParams.get('token');
      if (fromQuery) return fromQuery;
    } catch (_) { /* malformed url */ }
    return null;
  }

  function extractCookieToken(req) {
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

  // Shared by the /api|/vault/builds HTTP gate and the WS verifyClient below.
  // Order: Authorization: Bearer header (any client) -> ?token= query (the
  // §18.2 fix — a browser WebSocket cannot set headers, so this is how a
  // remote HUD tab authenticates the WS upgrade) -> mythos_token cookie (set
  // by the HUD once the operator enters the token, reused on plain HTTP nav).
  function extractToken(req) {
    return extractBearerChannel(req) || extractCookieToken(req);
  }

  function requireToken(req, res, next) {
    if (!tokenOk(req)) {
      const hint = (AUTH_TOKEN && pinSessionRequired())
        ? 'Unauthorized — this deployment requires BOTH the MYTHOS_AUTH_TOKEN bearer token (Authorization: Bearer <token> or ?token=) AND an unlocked PIN session (the mythos_token cookie from POST /api/pin/verify).'
        : 'Unauthorized — set MYTHOS_AUTH_TOKEN via Authorization: Bearer <token> or the mythos_token cookie.';
      return res.status(401).json({ error: hint });
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
  //
  // /auth/session joins them for the same reason, one layer up: it is the
  // login endpoint for the bearer token itself (routes/auth.js). Gating the
  // route that hands out the credential behind that credential would be a
  // closed loop — the browser tab that has nothing yet could never get
  // anything. It presents the secret in its own body and rate-limits itself.
  const PIN_UNLOCK_EXEMPT_PATHS = new Set(['/pin/status', '/pin/verify', '/auth/session']);
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

  // ---- /api/pin — §7.3 local PIN lock (separate from Task 6's token gate
  // both of these routes already sit behind). pinSession (Track B1) lets a
  // successful /api/pin/verify issue the real session tokenOk() above
  // checks, so the PIN screen becomes actual access control instead of a
  // visual deterrent. ----
  require('./routes/pin').mountPinRoutes(app, { pinLock, pinSession });

  // ---- /api/auth/session — exchange MYTHOS_AUTH_TOKEN for the mythos_token
  // cookie extractCookieToken() above already reads. Without this the HUD
  // (a plain browser tab, which cannot set an Authorization header on its own
  // navigation and cannot set headers on a WebSocket upgrade at all) had no
  // way to authenticate on a token-configured deployment. See routes/auth.js. ----
  require('./routes/auth').mountAuthRoutes(app, {
    authToken: AUTH_TOKEN,
    authTokenMatches,
    pinSessionRequired,
    cookieTtlMs: config.AUTH_SESSION_COOKIE_TTL_MS,
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
  let ttsChainRef = deps.ttsChain || createTtsChain({ config, logger });
  function currentTts() { return ttsChainRef; }
  function setTtsChain(next) {
    if (!next) return;
    ttsChainRef = next;
    logger.info('tts.chain-swapped', { chain: next.chainNames.join(',') });
  }
  logger.info('tts.chain', { chain: ttsChainRef.chainNames.join(',') });

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
    if (closed) logger.info('live.voice-changed', { voice: liveVoiceOverride, sessionsClosed: closed });
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

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(__dirname, '..', 'ui', 'public', 'index.html'));
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
  function verifyClient(info, callback) {
    // H3(a) — checked before any origin/token logic, so a brute-force run
    // against the token check itself (not just successful connections) is
    // capped regardless of which branch below would otherwise accept or
    // reject it.
    if (wsUpgradeRateLimited(info.req)) {
      logger.warn('ws-upgrade-rejected', { reason: 'rate limit exceeded' });
      return callback(false, 429, 'Too Many Requests');
    }
    const origin = info.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      logger.warn('ws-upgrade-rejected', { reason: 'foreign origin', origin });
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
        logger.warn('ws-upgrade-rejected', { reason: 'no origin, non-loopback' });
        return callback(false, 403, 'Forbidden');
      }
      // ...and the credential really is MYTHOS_AUTH_TOKEN and nothing else.
      // tokenOk() below would also accept a live PIN-session token, which exists
      // to gate LOCAL PHYSICAL PRESENCE (pin-session.js) — a different claim
      // entirely from "I am an enrolled device on this LAN". Accepting it here
      // would mean a PIN session leaked from the HUD (XSS, or a capture on the
      // deliberately-unencrypted LAN of PROTOCOL.md §11.4) authenticates a
      // remote socket, which is exactly the widening this branch is supposed not
      // to be. So the node path checks the shared secret directly.
      if (!authTokenMatches(extractToken(info.req))) {
        logger.warn('ws-upgrade-rejected', { reason: 'node trust: not the auth token' });
        return callback(false, 401, 'Unauthorized');
      }
    }
    if (!tokenOk(info.req)) {
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
  // Wave 1 (2026-08-13): connectionId -> that connection's liveAdapter (set
  // once liveOpen() creates it, deleted on ws close). leash/confirm.js's
  // per-entry expiry timer fires with no connection context of its own — this
  // is what lets the server route an EXPIRED confirm back to the SPECIFIC
  // Live session that raised it, the same way handleConfirmReply already does
  // for an explicit accept/reject on this same connection's closure.
  const liveAdaptersByConnection = new Map();
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
  // F2b (2026-08-15) — one speaker per connection.
  //
  // F2a stops sendSpokenReply from speaking OVER an open Live session, but a
  // guard on one function is an instance, not the class: proactiveSpeak() fires
  // from reminders, goal/build announcements and health notices on its own
  // schedule, and can still land in the middle of a reply that is already
  // streaming chunks. The two share no lock and no turn serialisation, and each
  // side's mic gate polices only its own engine's capture.
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
      if (!(liveSession && liveSession.isOpen()) && config.VOICE_UNIFIED_LIVE_VOICE) {
        logger.warn('proactive.live-unavailable-voice-will-differ', {
          note: 'unified live voice is ON but no Live session — speaking via the TTS chain instead',
          chain: String(config.VOICE_TTS_CHAIN || process.env.VOICE_TTS_CHAIN || ''),
        });
      }
    }
    if (liveSession && liveSession.isOpen()) {
      // BUG-117: same self-describing prefix the tool-outcome pushes use — a
      // proactive alert is even easier to misread as the operator speaking.
      liveSession.sendText(`${SYSTEM_NOTICE_PREFIX} ${text}`);
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
        if (ctrl.signal.aborted) break;
        sendSpeechChunk(sendOut, speechTarget, { type: 'speech-chunk', reqId, index: idx, total: totalChunks, audioB64, mime: chunkMime, text: textChunks[i] }, targetWs);
        idx++;
      }
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
    proactiveSpeak(e.payload.text);
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
  // BUG-148: bootGreetingFired means "scheduled", not "spoken" — it is set the
  // moment the timer is armed. The gmail-batch subscriber needs to know whether
  // the greeting has actually been DELIVERED, which is a different question and
  // ~2.5s later. See that subscriber for why.
  let bootGreetingDelivered = bootGreetingFired;   // pre-satisfied when there will be no greeting
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
    // TASK B2: fact assembly lives in conversation/briefing.js now (extracted
    // for the same reason electron/child-exit.js was — testable behaviorally,
    // not just source-shape) and each source is individually time-boxed there.
    // Deps below are exactly the closure state the inline code used to read.
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
              'Facts you may use:\n- ' +
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
    // Mark THE canonical "session opened" greeting so any other greeting-shaped
    // source (the daily planner's morning brief) sharing this dedup key is
    // suppressed for conversationAnnouncer's dedup window (BUG-112).
    try {
      if (conversationAnnouncer && typeof conversationAnnouncer.markAnnounced === 'function') {
        conversationAnnouncer.markAnnounced(GREETING_DEDUP_KEY);
      }
    } catch (_) {}
    await proactiveSpeak(text, targetWs);
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
      proactiveSpeak('This reminder has just fired and is now complete: ' + e.payload.text, undefined, { alertSound: Boolean(e.payload.alertSound) });
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
    proactiveSpeak(text);
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
          leash, dispatchAction, bus, logger, connectionId,
          memory, historyAppend, reflection,
          summarizeActionsForResult,
          getLiveSession: () => liveSession,
          sanitizeErrorForClient,
          goals, // BUG-113: commitment-ledger logging in onLiveTurnComplete
        });
        liveAdaptersByConnection.set(connectionId, liveAdapter);
      }
      if (!liveSession) {
        const { declarations, withheld, unavailable } = buildFunctionDeclarations(effectors, {
          allowlist: String(config.LIVE_TOOL_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean),
          // Do not declare a tool whose machinery is absent on this machine.
          // The freshly installed build fired gmail_unread / media_status /
          // spotify_status before the operator had spoken, against credentials
          // and adapters the install does not have. Built HERE, per session, not
          // at boot: an adapter that comes online later must become declarable
          // on the next session without a restart. See core/voice/tool-capability.js.
          capability: buildCapabilitySnapshot({
            config,
            // The adapter modules are singletons holding their own connection
            // state, and pc-child is already require()d at the top of this file
            // for exactly that reason. getStatus() is a pure read; requiring
            // these starts nothing.
            adapters: {
              browser: browserAgentAdapter,
              cua: cuaDriverAdapter,
              pcChild,
              android: androidChildAdapter,
            },
          }),
          log: (m) => logger.info('live-tools', { detail: m }),
        });
        if (withheld.length) logger.info('live-tools.withheld', { count: withheld.length });
        // Logged as its own event, not folded into the line above: "withheld by
        // curation" and "withheld because this machine cannot do it" are
        // different findings and only one of them is a setup problem.
        if (unavailable && unavailable.length) {
          logger.warn('live-tools.unavailable', {
            count: unavailable.length,
            tools: unavailable.map((u) => u.name),
            reasons: [...new Set(unavailable.map((u) => u.reason))],
          });
        }
        liveSession = createLiveSession({
          // liveConfigNow() carries a voice picked in the HUD since boot.
          // live-session.js reads GEMINI_LIVE_VOICE ONCE, at construction
          // (:82), so a session built from the frozen boot config would keep
          // speaking in the old voice while every other surface had switched —
          // the picker would look broken precisely for the operator who is
          // using Live, which is now the default whenever a Google key exists.
          config: liveConfigNow(), bus, logger, spend, breakers: effectors.breakers,
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
            // The HUD infers the end of a Live turn from its own audio queue
            // draining. A voice node cannot: its `done` ack arrives before the
            // first audio frame (say:'', routedToLive:true), so without an
            // explicit end-of-turn it has no moment at which to reopen the mic
            // or stop its reply-timeout clock. Ignored by clients that don't
            // know the frame.
            send({ type: 'live-turn-complete' });
          },
          // Direct per-connection barge-in callback — NOT the shared bus (see
          // live-session.js's onInterrupted comment: a bare bus.subscribe here
          // would fire for every OTHER connection's interruption too).
          onInterrupted: () => send({ type: 'live-interrupted' }),
          // BUG-170: Live produced a reply the operator could read and no
          // audio at all — which is indistinguishable, from the room, from
          // being ignored. Speak it through the TTS chain instead. skipLive
          // is not optional here: routing it back into the session that just
          // failed to speak would be the same silence again.
          onSilentTurn: ({ turnId, text }) => {
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
    async function liveForSpeech() {
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

    // First dashboard connection this boot → spoken greeting + status brief.
    // Small delay so the client finishes wiring its WS handlers and voice
    // machinery before the proactive-speech broadcast lands.
    if (!bootGreetingFired) {
      bootGreetingFired = true;
      const greetTimer = setTimeout(() => {
        // BUG-178: a voice node must not consume the greeting. Nodes share this
        // /ws path and only reveal themselves via {type:'identify',role:'node'}
        // AFTER the upgrade, so "the first connection this boot" is not the same
        // question as "the dashboard" — and the answer is only available here, at
        // fire time, not at the arming site above. A phone reconnecting at boot
        // (the normal case per NodeLink.kt) won that race: the whole greeting
        // went to the phone while the HUD connecting a second later got nothing,
        // silently. Speaking through a phone IS a feature, but an election-gated
        // one (nodeSpeechTarget: AETHER_NODE_AUDIO + an elected aetherOwner);
        // picking a socket bypassed that gate entirely.
        //
        // Re-arming alone is NOT enough, and the first cut of this fix got that
        // wrong — live-probed 2026-08-10. A dashboard that connected during the
        // node's 2.5s window already saw bootGreetingFired === true and so never
        // armed a timer of its own; re-arming at fire time is then too late for
        // it and the greeting is lost by both devices. So look for a dashboard
        // that is already connected and hand it over directly, and only re-arm
        // when there is genuinely nobody to greet yet.
        //
        // Either way this stays one greeting per boot, never one per tab (the
        // BUG-112 shape): the handover keeps the gate closed, and a re-armed gate
        // is closed again by whichever dashboard connects next.
        if (ws._mythosNodeId) {
          const dashboard = [...wss.clients].find((c) => c.readyState === 1 && !c._mythosNodeId);
          if (dashboard) {
            logger.info('boot-greeting.rerouted-from-node', { nodeId: ws._mythosNodeId });
            deliverBootGreeting(dashboard).catch((err) => logger.warn('boot-greeting.failed', { error: err.message }));
            return;
          }
          bootGreetingFired = false;
          logger.info('boot-greeting.deferred-node-connection', { nodeId: ws._mythosNodeId });
          return;
        }
        // Deliver to THIS connection only — with two dashboard tabs open, a
        // broadcast greeting plays twice in overlap ("two voices").
        deliverBootGreeting(ws).catch((err) => logger.warn('boot-greeting.failed', { error: err.message }));
      }, bootGreetingDelayMs);
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
    // F2b: same per-connection lock as proactiveSpeak — a reminder firing
    // mid-reply now queues behind it instead of playing over it.
    async function sendSpokenReply(reqId, say, meta, micStoppedAt) {
      return serializeSpeech(ws, () => sendSpokenReplyNow(reqId, say, meta, micStoppedAt));
    }

    async function sendSpokenReplyNow(reqId, say, meta, micStoppedAt) {
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
      // Route the text through the same [SYSTEM] channel proactiveSpeak uses so
      // Gemini itself says it, and finish the turn caption-only (chunked:true,
      // zero chunks) exactly as the Aether branch above does.
      //
      // The `!ws._mythosNodeId` term is load-bearing and was missing in the first
      // cut of this guard, which broke aether-node-routing.test.js. A phone node
      // may have its own Live session open on its own connection, but a
      // node-origin utterance is deliberately answered by the BATCH pipeline (see
      // the routing decision at the 'utterance' handler, which sends node turns
      // to handleUtterance and only HUD turns to Live). Routing the reply into
      // Live here would answer on the desktop a question that was asked at the
      // phone. Same guard the utterance router uses, and for the same reason.
      if (!ws._mythosNodeId && liveSession && liveSession.isOpen()) {
        liveSession.sendText(`${SYSTEM_NOTICE_PREFIX} ${speak}`);
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
                const out = await activeChain.synthesize({ text: chunks[i], signal: ctrl.signal });
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
            sendSpeechChunk(send, speechTarget, { type: 'speech-chunk', reqId, index: i, total: chunks.length, audioB64, mime: chunkMime, text: chunks[i] }, ws);
          }
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
              const out = await activeChain.synthesize({ text: spoken });
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
          liveSession.sendText(`${SYSTEM_NOTICE_PREFIX} ${say}`);
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

    function handleCommand(msg) {
      send({ type: 'done', reqId: msg.reqId, command: msg.command });
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
        const outcome = await dispatchAction(decision, { goalId: action.goalId, tier: action.tier, channel: 'confirm-accept', traceId: confirmId, surface: surface, acceptedScope: acceptedScope });
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
      // BUG-129: while a Live (S2S) session is open, typed HUD text belongs to
      // the SAME conversation as the spoken one. The batch path would answer it
      // through edge-tts — a different voice, and a separate history from the
      // one Gemini is holding. Feed it in as user content instead so the reply
      // comes back on the Live audio path in the Live voice, with context.
      // The empty `done` releases the HUD's reqId handler (deliverReply treats
      // a no-say done as finishTurn); the typed message's own caption is drawn
      // client-side by compose-bar, so nothing is lost by not answering here.
      // 2026-08-06: typing without ever having spoken left `liveSession` null,
      // so this fell to the batch/edge-tts path and answered in a different
      // voice than the spoken conversation. Open one on demand first
      // (VOICE_UNIFIED_LIVE_VOICE); the batch fallback below is unchanged and
      // still runs whenever a Live session genuinely isn't available.
      if (msg.type === 'utterance') {
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
          liveSession.sendText(String(msg.text || ''));
          send({ type: 'done', reqId: msg.reqId, say: '', routedToLive: true });
        } else {
          const typedText = String(msg.text || '');
          liveForSpeech().then((live) => {
            if (live && live.isOpen()) {
              live.sendText(typedText);
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
      else if (msg.type === 'voice-capture-suspend') {
        logger.info('voice.capture-suspend', {
          suspended: Boolean(msg.suspended), holdMs: msg.holdMs, reason: msg.reason, at: msg.at,
        });
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
            bus.emit('health.anomaly', {
              kind: 'voice-node-duplicate-identify',
              summary: `Two open sockets claimed voice node "${nodeId}" — the newer one wins.`,
              detail: { nodeId },
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
      else if (msg.type === 'live-open') { queueTurn(function () { return liveOpen(); }); }
      else if (msg.type === 'live-audio') { if (liveSession) liveSession.sendAudio(msg.data); }
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
      else if (msg.type === 'live-close') { if (liveSession) liveSession.close('client-request'); }
      else if (msg.type === 'live-text') { if (liveSession) liveSession.sendText(String(msg.text || '')); }
    });

    // Tear down any open Live session when the socket itself closes — a
    // dangling Gemini socket would otherwise keep billing for open-mic time
    // with no client left to hear the reply.
    ws.on('close', () => {
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
      const label = actuallyHealed ? 'healed' : (p.outcome === 'cooldown' ? 'cooldown' : 'unhandled');
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
    app, httpServer, wss, stop, dispatchAction, ready, requestCameraFrame, requestCameraPower, requestClosePanel,
    requestCloseMediaWindow, setGmailPollCountGetter,
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
      rearmBootGreeting: () => { bootGreetingFired = false; bootGreetingDelivered = false; },
      setBootGreetingDelayMs: (ms) => { bootGreetingDelayMs = Number(ms) || 0; },
      // Voice Nodes: proactive speech targets lastActiveWs, and a phone pushing
      // proximity telemetry several times a second must never become that
      // target. There is no other observable for it from outside.
      getLastActiveWs: () => lastActiveWs,
    },
  };
}

module.exports = { createServer };
