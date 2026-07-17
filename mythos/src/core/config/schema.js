'use strict';

// MYTHOS Phase 0 config schema
// Keys: type, default, min?, max?, enum?, bool?, required?
// validate() in index.js reads this to coerce + validate raw env

const SCHEMA = {
  // MYTHOS entity
  MYTHOS_NAME:              { type: 'string', default: 'MYTHOS' },
  // Optional version override; defaults to package.json version at boot.
  MYTHOS_VERSION:           { type: 'string', default: '' },
  MYTHOS_PORT:              { type: 'number', default: 4478, min: 1024, max: 65535 },
  MYTHOS_BIND:              { type: 'string', default: '127.0.0.1' },
  MYTHOS_VAULT_ROOT:        { type: 'string', default: './vault' },
  MYTHOS_TICK_MS:           { type: 'number', default: 1000, min: 100, max: 60000 },
  MYTHOS_IDLE_SALIENCE:     { type: 'number', default: 0.3, min: 0, max: 1 },
  MYTHOS_DRY_RUN:           { type: 'bool',  default: false },

  // Logging
  LOG_LEVEL:                 { type: 'string', default: 'info', enum: ['debug', 'info', 'warn', 'error'] },

  // NOVA passthrough (brain providers)
  OLLAMA_URL:               { type: 'string', default: 'http://localhost:11434' },
  GROQ_API_KEY:             { type: 'string', default: '' },
  MISTRAL_API_KEY:          { type: 'string', default: '' },
  NIM_API_KEY:              { type: 'string', default: '' },
  NIM_API_KEY_2:            { type: 'string', default: '' },
  ZCODE_API_KEY:            { type: 'string', default: '' },
  OPENROUTER_API_KEY:       { type: 'string', default: '' },
  CEREBRAS_API_KEY:         { type: 'string', default: '' },

  // Voice reply TTS (edge-tts Microsoft Neural voice id)
  VOICE_TTS_VOICE:          { type: 'string', default: 'en-GB-RyanNeural' },

  // Voice VAD tuning (BUG-020 — client-side voice-loop.js speech-detection
  // thresholds; defaults match the previously-hardcoded constants exactly,
  // zero behavior change until overridden). Exposed to the HUD via
  // GET /api/config/vad so mic sensitivity can be tuned without a rebuild.
  VAD_SPEECH_RMS:           { type: 'number', default: 0.035, min: 0, max: 1 },
  VAD_MIN_PEAK_RMS:         { type: 'number', default: 0.06,  min: 0, max: 1 },
  VAD_HOLD_TICKS:           { type: 'number', default: 3,     min: 1, max: 20 },
  VAD_SILENCE_MS:           { type: 'number', default: 1800,  min: 100, max: 10000 },

  // Wake-word (hands-free "hey jarvis" — ui/public/js/voice/wakeword.js).
  // Opt-in: models are CC BY-NC-SA and fetched by scripts/setup-wakeword.js,
  // never committed (see .gitignore, THIRD_PARTY_NOTICES.md). Off by default
  // even when the models happen to be present.
  WAKEWORD_ENABLED:         { type: 'bool',   default: false },
  WAKEWORD_THRESHOLD:       { type: 'number', default: 0.5, min: 0.1, max: 0.95 },

  // Ambient screen awareness (hash-gated vision sensor — src/core/sensors/
  // screen-sensor.js). Opt-in and off by default: periodically screen_look's
  // the desktop, skips the vision call entirely when the screen is unchanged
  // (sha1 hash gate), and feeds a one-sentence description into the perception
  // loop. Never persists raw screenshot bytes — descriptions only.
  SCREEN_AWARENESS_ENABLED:  { type: 'bool',   default: false },
  SCREEN_AWARENESS_POLL_MS:  { type: 'number', default: 30000, min: 10000, max: 600000 },
  SCREEN_AWARENESS_SALIENCE: { type: 'number', default: 0.3, min: 0, max: 1 },

  // Daily planning + accountability (hands-free morning brief / stall
  // check-ins / evening review — src/core/planner/daily.js). On by default
  // (unlike wake-word/screen-awareness, this touches no camera/mic/screen
  // capture — it only reads the existing Goals system).
  PLANNER_ENABLED:           { type: 'bool',   default: true },
  PLANNER_MORNING_HOUR:      { type: 'number', default: 9,  min: 0, max: 23 },
  PLANNER_EVENING_HOUR:      { type: 'number', default: 21, min: 0, max: 23 },
  PLANNER_CHECKIN_EVERY_MS:  { type: 'number', default: 10800000, min: 1800000 },

  // get_weather tool default location ("lat,lon") when no location is spoken —
  // same Kolkata fallback the dashboard weather widget already uses.
  WEATHER_LOCATION:         { type: 'string', default: '22.57,88.36' },

  // Brain
  REFLECT_EVERY:            { type: 'number', default: 60, min: 1 },
  CONSOLIDATE_EVERY:        { type: 'number', default: 300, min: 1 },
  EPISODIC_RETENTION_DAYS:  { type: 'number', default: 30, min: 1 },
  CHAIN_COOLDOWN_MS:        { type: 'number', default: 60000, min: 1000 },
  MODEL_REGISTRY_TTL_MS:    { type: 'number', default: 300000, min: 10000 },

  // Autonomy
  AUTONOMOUS_MAX_TIER:      { type: 'number', default: 2, min: 0, max: 4 },
  GOAL_TOKEN_BUDGET:        { type: 'number', default: 20000, min: 0 },
  GOAL_ACTION_BUDGET:       { type: 'number', default: 25, min: 0 },
  MAX_ACTIVE_GOALS:         { type: 'number', default: 5, min: 1, max: 20 },
  CURIOSITY_MIN_INTERVAL_MS: { type: 'number', default: 600000, min: 0 },

  // Leash (Phase 5)
  LEASH_CONFIRM_TTL_MS:     { type: 'number', default: 30000, min: 1000 },

  // Cortex / server action dispatch (Phase 9 — closes the Gap-4 hardcoded
  // fallback in cortex/index.js:21; both cortex act() and server dispatchAction()
  // read this schema key, never a re-defaulted literal)
  ACTION_TIMEOUT_MS:        { type: 'number', default: 30000, min: 1000 },

  // Immune
  STALL_MS:                 { type: 'number', default: 5000, min: 1000 },
  WATCHDOG_MS:              { type: 'number', default: 2000, min: 500 },
  BREAKER_FAIL_THRESHOLD:   { type: 'number', default: 3, min: 1 },
  BREAKER_WINDOW_MS:        { type: 'number', default: 30000, min: 1000 },
  BREAKER_RESET_MS:         { type: 'number', default: 15000, min: 1000 },
  CHECKPOINT_EVERY_TICKS:   { type: 'number', default: 50, min: 1 },

  // Lifecycle (D-07 — graceful shutdown hard-exit backstop)
  SHUTDOWN_MS:              { type: 'number', default: 10000, min: 1000 },

  // Bus
  BUS_HISTORY_SIZE:          { type: 'number', default: 500, min: 10 },
  BUS_STORM_MAX:            { type: 'number', default: 400, min: 10 },

  // Effectors & Sensors (Phase 7)
  // Default 3: mission fan-out runs builder agents in parallel; free-tier
  // rate limits tolerate 3 concurrent brain calls across the provider chain.
  MYTHOS_BUILD_CONCURRENCY:  { type: 'number', default: 3, min: 1, max: 8 },
  MYTHOS_JOBS_MAX_PERSISTED: { type: 'number', default: 100, min: 10 },
  MYTHOS_WATCH_DIRS:         { type: 'string', default: '' },
  MYTHOS_FILE_DEBOUNCE_MS:   { type: 'number', default: 500, min: 50 },

  // Conversation brain (idle reasoning) — how often the entity "mulls" during
  // quiet moments (forms thoughts about the operator's situation, loose ends,
  // follow-ups). 0 = disabled (reverts to zero-cost idle). At 1s ticks, 300 = ~5min.
  MYTHOS_MULL_EVERY_TICKS:   { type: 'number', default: 300, min: 0, max: 3600 },
  // Voice agent max spoken reply length (chars). 800 = allows full reasoning
  // paragraphs; lower for terser responses.
  VOICE_MAX_SAY_CHARS:       { type: 'number', default: 800, min: 100, max: 4000 },

  // Browser automation (Phase 9 — playwright-core, drives installed Chrome/Edge)
  BROWSER_CDP_URL:            { type: 'string',  default: 'http://127.0.0.1:9222' },
  BROWSER_AUTOMATION:         { type: 'bool', default: true },

  // Google OAuth (Phase 13 — Gmail adapter)
  GOOGLE_CLIENT_ID:            { type: 'string', default: '' },
  GOOGLE_CLIENT_SECRET:        { type: 'string', default: '' },
  GOOGLE_REFRESH_TOKEN:       { type: 'string', default: '' },

  // Gmail triage sensor (Item 7 — unread-mail polling, mirrors reminder-sensor)
  GMAIL_TRIAGE_POLL_MS:        { type: 'number', default: 300000, min: 60000 },
  GMAIL_TRIAGE_ENABLED:        { type: 'bool',   default: true },

  // Engagement Layer (Phase 17/18 — structured task lifecycle)
  ENGAGEMENT_TTL_MS:           { type: 'number', default: 604800000, min: 3600000 },
  ENGAGEMENT_MAX_REPAIRS:      { type: 'number', default: 3, min: 0, max: 10 },
  ENGAGEMENT_INTERVIEW_MAX_Q:  { type: 'number', default: 5, min: 1, max: 20 },
  ENGAGEMENT_MAX_STAGES:       { type: 'number', default: 10, min: 1, max: 50 },

  // Forge (P22 — multi-file agentic build pipeline)
  FORGE_MAX_FILES:             { type: 'number', default: 12,      min: 1,     max: 40 },
  FORGE_FILE_RETRY:            { type: 'number', default: 2,       min: 0,     max: 5 },
  FORGE_CONCURRENCY:           { type: 'number', default: 2,       min: 1,     max: 6 },
  // Checkpoints (P22 — workflow approval gates, distinct from LEASH_CONFIRM_TTL_MS)
  CHECKPOINT_TTL_MS:           { type: 'number', default: 1800000, min: 60000 },
  CHECKPOINT_SWEEP_MS:         { type: 'number', default: 60000,   min: 5000 },

  // YouTube mode (BUG-006 escape hatch): 'embed' attempts iframe embed, 'newtab' opens in new browser tab
  YOUTUBE_MODE:                { type: 'string', default: 'embed', enum: ['embed', 'newtab'] },

  // MCP server (Item 10 — hand-rolled JSON-RPC 2.0 stdio server, mcp/server.js).
  // Opt-in by design: exposing the hub's ~58-tool catalog over a new stdio
  // surface is a trust-boundary expansion the operator must explicitly enable.
  MCP_SERVER_ENABLED:          { type: 'bool', default: false },
};

module.exports = { SCHEMA };
