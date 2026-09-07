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
const { SCHEMA } = require('../../src/core/config/schema');
const { isSecretShaped } = require('../../src/core/config/settings-store');
const { findModelFile } = require('../../src/core/setup/model-paths');

// Client-facing error text goes through sanitizeRestError: a raw err.message
// here disclosed absolute filesystem paths (ENOENT/EACCES carry them) over HTTP
// while the WS path had been sanitizing the same errors all along. Validation
// messages this route raises itself still pass through unchanged.
const { sanitizeRestError } = require('../sanitize-error');

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
      // VAD_ENGINE=rms|silero (default rms). voice-loop.js applies
      // engine-appropriate threshold DEFAULTS before the four numeric
      // overrides above, so an operator who only sets VAD_ENGINE=silero
      // (without also retuning the thresholds) still gets sane behavior.
      engine: config.VAD_ENGINE === 'silero' ? 'silero' : 'rms',
    });
  });

  // ---- /api/config/wakeword — hands-free "hey jarvis" activation. modelsPresent
  // is a live statSync check (not a cached boot-time flag) so running
  // scripts/setup-wakeword.js and reloading the HUD picks it up without a
  // server restart. Models are CC BY-NC-SA and gitignored — see
  // scripts/setup-wakeword.js and THIRD_PARTY_NOTICES.md.
  //
  // `deps.wakewordModelsDir` is an injectable-path seam, and it exists for a
  // specific, destructive reason. This path used to be hardcoded here, so the
  // only way test/wakeword.test.js could exercise "models absent" was to
  // renameSync the operator's REAL models directory aside and rename it back
  // afterwards. On Windows that rename loses an EPERM race under full-suite
  // load, and when it does the real .onnx files are left stranded in a
  // gitignored `wakeword.test-backup/` while `wakeword/` no longer exists —
  // wake word is silently dead and git shows nothing, because BOTH directories
  // are ignored. It does not self-heal. With this seam the test points at a
  // temp directory instead and cannot touch real models at all.
  // Production passes nothing and now searches every model directory instead of
  // one hardcoded path — see the route below and core/setup/model-paths.js.

  app.get('/api/config/wakeword', (req, res) => {
    const files = ['melspectrogram.onnx', 'embedding_model.onnx', 'hey_jarvis_v0.1.onnx'];
    // deps.wakewordModelsDir is the injected test seam and is honoured verbatim.
    // With no seam, search BOTH the userData-scoped models directory and the
    // install tree — installer parity (2026-08-11): the downloaders now write to
    // userData (the install tree ships no models and every update replaces it), so
    // checking only the install tree would report modelsPresent:false on exactly
    // the machine that just installed the wake word. deriveWakewordDefaults reads
    // the SAME rule via config/index.js's wakewordModelsPresent, so the flag and
    // this route can still never disagree.
    const modelsPresent = deps.wakewordModelsDir
      ? files.every((f) => {
        try { return fs.statSync(path.join(deps.wakewordModelsDir, f)).size > 0; } catch { return false; }
      })
      : files.every((f) => Boolean(findModelFile('wakeword', f)));
    res.json({ enabled: config.WAKEWORD_ENABLED, threshold: config.WAKEWORD_THRESHOLD, modelsPresent });
  });

  // ---- /api/config/s2s — Gemini Live speech-to-speech availability, read once
  // at HUD boot alongside vad/wakeword above. NEW: until this existed, the
  // client had NO way to learn VOICE_S2S_ENABLED, so ui/public/js/voice/
  // s2s-bridge.js — a complete, protocol-correct implementation — had no
  // consumer and the whole S2S feature was unreachable from the UI. app.js
  // routes a voice toggle to the bridge only when this reports enabled:true;
  // otherwise voice-loop.js's batch-STT path runs exactly as before.
  //
  // Only the boolean is exposed, never GEMINI_API_KEY or the model id: the
  // client needs to know WHETHER to open a live session, not how the server
  // talks to Google. A false here is the honest default (schema.js defaults
  // VOICE_S2S_ENABLED to false), and matches what liveOpen() in
  // server/index.js would answer anyway ({state:'closed', reason:'disabled'}).
  // screenShare (Electron Slice 3): same reasoning one level down — the HUD's
  // capture module cannot know whether the operator opted into streaming their
  // desktop, and must default to not doing it. fps/quality ride along because
  // the capture loop lives in the browser; they are cost dials, not secrets.
  app.get('/api/config/s2s', (req, res) => {
    res.json({
      enabled: Boolean(config.VOICE_S2S_ENABLED),
      operatorEnabled: Boolean(config.DESKTOP_OPERATOR_ENABLED),
      screenShare: {
        enabled: Boolean(config.LIVE_SCREEN_SHARE_ENABLED),
        fps: config.LIVE_SCREEN_FPS,
        quality: config.LIVE_SCREEN_JPEG_QUALITY,
      },
    });
  });

  // ---- /api/config/settings — every schema key, its effective value, and WHERE
  // that value came from. ----
  //
  // INSTALLER PARITY (operator, 2026-08-11). The installed .exe and the dev run
  // execute byte-identical code and behaved nothing alike, and it took two
  // months to notice because nothing anywhere could answer "what is
  // VOICE_S2S_ENABLED set to on this machine, and who set it". This route is
  // that answer: the Settings panel renders it and scripts/parity-check.js
  // asserts on it, so a future build's drift is a failed check rather than the
  // operator re-testing every feature by hand.
  //
  // AD-8 HOLDS HERE. Secret-shaped keys report presence ONLY — never the value,
  // not even truncated. test/anti-drift-no-key-to-client.test.js is the guard,
  // and `redacted:true` is what the panel renders instead of an input box.
  // identity is undefined in several test harnesses, and a missing dependency
  // must read as "not known here", never as a fabricated ceiling.
  function autonomySnapshot() {
    const identity = deps.identity;
    const configCeiling = config.AUTONOMOUS_MAX_TIER;
    if (!identity || typeof identity.getMaxAutonomousTier !== 'function') {
      return { effective: null, configCeiling, boundariesCeiling: null, source: 'unknown' };
    }
    const boundariesCeiling = identity.getMaxAutonomousTier();
    return {
      effective: Math.min(configCeiling, boundariesCeiling),
      configCeiling,
      boundariesCeiling,
      source: typeof identity.boundariesSource === 'function' ? identity.boundariesSource() : 'unknown',
    };
  }

  app.get('/api/config/settings', (req, res) => {
    const origins = deps.configOrigins || {};
    const keys = Object.keys(SCHEMA).sort().map((name) => {
      const def = SCHEMA[name];
      const secret = isSecretShaped(name);
      const value = config[name];
      return {
        name,
        type: def.type,
        // The default is not a secret even for a secret-shaped key: the schema
        // ships '' for all of them, and showing it is what makes "unset" legible.
        default: def.default === undefined ? '' : String(def.default),
        enum: def.enum || null,
        required: def.required === true,
        secret,
        redacted: secret,
        // presence, not value
        set: secret ? (value !== undefined && String(value) !== '') : undefined,
        value: secret ? undefined : (typeof value === 'boolean' ? value : String(value === undefined ? '' : value)),
        // 'env' | 'config.json' | '.env' | 'voice-choice' | 'derived' | 'default'
        origin: origins[name] || 'unknown',
      };
    });
    res.json({
      file: deps.settingsFile || null,
      // The effective autonomy ceiling and its provenance — the exact fact whose
      // invisibility let the approval-prompt incident survive a fresh install.
      // leash/index.js gates on Math.min of the two ceilings, so both are
      // reported rather than only the winner. `source` distinguishes a real
      // boundaries.md from the tier-1 malformed fail-safe and from a fresh vault
      // with no file (see core/identity/index.js init and boundaries-seed.js).
      autonomy: autonomySnapshot(),
      // Writing is the Electron main process's job (mythos:set-setting), not
      // this server's — the same split keys.json already uses. A plain browser
      // tab has no bridge, so the panel shows values read-only and says why.
      writable: false,
      keys,
    });
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
      res.status(500).json({ error: sanitizeRestError(err) });
    }
  });
}

module.exports = { mountConfigRoutes };
