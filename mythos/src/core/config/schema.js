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
  // V2 §7.2 — bearer token gating /api/*, /vault/builds, and the WS upgrade.
  // '' = loopback-only mode (tokenOk() always passes). The boot guard in
  // server/index.js refuses to start when MYTHOS_BIND is non-loopback and
  // this is unset — see mythos/.env.example for the full story.
  MYTHOS_AUTH_TOKEN:        { type: 'string', default: '' },
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

  // Voice reply TTS (edge-tts Microsoft Neural voice id).
  //
  // FEMALE, deliberately, and it must STAY female: the entity has three separate
  // speech paths and the operator hears all three in one session — this edge-tts
  // voice (boot greeting + batch replies), GEMINI_LIVE_VOICE (the S2S duplex
  // path), and the browser's speechSynthesis fallback when edge-tts is down.
  // Until 2026-07-31 this default was en-GB-RyanNeural (male) while
  // GEMINI_LIVE_VOICE was Aoede (female), so the entity greeted the operator as a
  // British man and then answered as a woman. Change one, change all three, or
  // the split comes straight back.
  VOICE_TTS_VOICE:          { type: 'string', default: 'en-GB-SoniaNeural' },

  // Which engine speaks the NON-Live paths (boot greeting, proactive speech,
  // batch replies). 'edge' = edge-tts (~900ms/sentence, free, unofficial
  // Microsoft endpoint labelled personal/hobby-only). 'gemini' = Gemini TTS
  // (~3.9s/sentence, metered) using the SAME prebuilt voice as the Live path, so
  // the entity sounds like one person everywhere instead of edge-tts for the
  // greeting and Aoede for the conversation. Defaults to 'edge' for latency.
  VOICE_TTS_PROVIDER:       { type: 'string', default: 'edge' },
  // Non-streaming TTS model. gemini-2.5-flash-preview-tts measured ~3.9s/sentence;
  // gemini-3.1-flash-tts-preview measured ~17.6s and is NOT a sane default.
  GEMINI_TTS_MODEL:         { type: 'string', default: 'gemini-2.5-flash-preview-tts' },

  // ORDERED TTS chain, comma-separated, same convention as the brain's CHAIN_*.
  // Resolved ONCE per session and sticky: the boot greeting, proactive speech and
  // every batch reply all come from the same engine, and it only moves on a real
  // failure (never flaps back). The operator must not hear the voice change
  // partway through a session — see providers/tts.js.
  //   gemini  Aoede, matches the Live/S2S voice. ~3.9s/sentence, metered.
  //   edge    edge-tts. ~1011ms, free, unofficial MS endpoint (hobby-only label).
  //   piper   local, OFFLINE, ~350ms, free, MIT + open voices — the shippable one.
  // Falls back to VOICE_TTS_PROVIDER, then 'edge', so existing configs are unchanged.
  VOICE_TTS_CHAIN:          { type: 'string', default: '' },
  PIPER_PORT:               { type: 'number', default: 5051, min: 1024, max: 65535 },
  PIPER_VOICE:              { type: 'string', default: 'en_US-hfc_female-medium' },
  PIPER_MODEL_DIR:          { type: 'string', default: '' },

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

  // V8 (Phase 4) — calendar upcoming-event perception sensor
  // (src/core/sensors/calendar-upcoming-sensor.js). ON by default — no
  // privacy surface (reads only local reminders.json, no mic/camera/screen).
  // Distinct from reminder-sensor which emits reminder.due for OVERDUE events
  // (bypasses OODA, fires straight to proactive speech). This sensor emits
  // perception.calendar for UPCOMING events (within LEAD_MS) so the cortex
  // loop can act on them (mull a goal, surface to operator).
  CALENDAR_UPCOMING_ENABLED:   { type: 'bool',   default: true },
  CALENDAR_UPCOMING_POLL_MS:   { type: 'number', default: 60000, min: 10000, max: 600000 },
  CALENDAR_UPCOMING_LEAD_MS:   { type: 'number', default: 900000, min: 60000, max: 86400000 },
  CALENDAR_UPCOMING_SALIENCE:  { type: 'number', default: 0.6, min: 0, max: 1 },

  // V8 (Phase 4) — opt-in active-window perception sensor
  // (src/core/sensors/window-sensor.js). OFF by default — same privacy surface
  // as screen-sensor (reads foreground window title at intervals). Emits
  // perception.window with structured {app, title} metadata (NOT vision
  // captions like screen-sensor). Mirrors SCREEN_AWARENESS_* triplet.
  WINDOW_AWARENESS_ENABLED:  { type: 'bool',   default: false },
  WINDOW_AWARENESS_POLL_MS:  { type: 'number', default: 30000, min: 5000, max: 600000 },
  WINDOW_AWARENESS_SALIENCE: { type: 'number', default: 0.3, min: 0, max: 1 },

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
  // V3 (Phase 4): procedural-skill gate. Skills with uses>0 below this
  // successRate are not replayed by plan() — they keep failing.
  SKILL_MIN_SUCCESS_RATE:   { type: 'number', default: 0.5, min: 0, max: 1 },
  // V1 (Phase 4): orient→recall gate. Only perceptions above this salience
  // trigger a recallHybrid call on the autonomous path (idle-skip: 0 cost
  // when nothing salient arrives). ORIENT_RECALL_LIMIT caps the cache size.
  ORIENT_RECALL_MIN_SALIENCE: { type: 'number', default: 0.5, min: 0, max: 1 },
  ORIENT_RECALL_LIMIT:      { type: 'number', default: 5, min: 1, max: 20 },
  // V10 (Phase 4): consolidate-* merge threshold. The merge pass only fires
  // when this many consolidated-* topics have accumulated. Idle-skip lever.
  CONSOLIDATE_MERGE_MIN:    { type: 'number', default: 3, min: 2, max: 50 },
  // V9 (Phase 4): action-outcome reflection cadence + minimum sample size.
  // REFLECTION_ACTION_EVERY_TURNS fires the action analysis pass (separate
  // from the conversation-preferences pass). REFLECTION_ACTION_MIN is the
  // floor below which the pass skips (not enough data to learn from).
  REFLECTION_ACTION_EVERY_TURNS: { type: 'number', default: 30, min: 1, max: 500 },
  REFLECTION_ACTION_MIN:     { type: 'number', default: 5, min: 1, max: 100 },

  // Leash (Phase 5)
  LEASH_CONFIRM_TTL_MS:     { type: 'number', default: 30000, min: 1000 },

  // Cortex / server action dispatch (Phase 9 — closes the Gap-4 hardcoded
  // fallback in cortex/index.js:21; both cortex act() and server dispatchAction()
  // read this schema key, never a re-defaulted literal)
  ACTION_TIMEOUT_MS:        { type: 'number', default: 30000, min: 1000 },

  // Immune
  // FIX C: was 5000 — lastTickAt is set once at tick start and not refreshed
  // mid-tick, so any legitimately slow (but progressing) 'build'-lane brain call
  // past 5s tripped the stall watchdog. Raised to match ACTION_TIMEOUT_MS so only
  // a truly hung loop fires it.
  STALL_MS:                 { type: 'number', default: 30000, min: 1000 },
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
  // Per-page default action timeout (click/type/textContent). Higher lets a
  // lazy-hydrating SPA (YouTube's ytd-* custom elements) come up before the
  // click; lower fails faster on a genuinely-absent element. Read by the
  // browser-agent adapter (setDefaultTimeout) and from-browser's waitReady().
  BROWSER_PAGE_TIMEOUT_MS:    { type: 'number', default: 15000, min: 1000, max: 60000 },
  // How long waitReady() (the pre-wait before click/type/get_text) waits for a
  // selector to become visible. Less than BROWSER_PAGE_TIMEOUT_MS so a missing
  // element fails at the pre-wait with a clean message, not the raw Playwright
  // 15s timeout. 8000 covers most SPA hydration without unbounded waiting.
  BROWSER_PAGE_WAIT_MS:       { type: 'number', default: 8000, min: 500, max: 30000 },
  // Auto-connect poller: while OFFLINE, retry the CDP connect on this interval so
  // MYTHOS attaches the moment a debug Chrome appears (and re-attaches after a
  // drop) with no manual "Connect". CDP-connect only — never launches a browser,
  // so zero mic risk. 0 = disabled.
  BROWSER_RECONNECT_MS:       { type: 'number', default: 15000, min: 0 },
  // Opt-in fully hands-off launch. Boot never launches a browser (it steals the
  // mic/audio device on Windows during voice init); when this is true, MYTHOS
  // launches a debug Chrome AFTER boot — once the audio device is already
  // claimed — so the constraint is respected by timing, not by skipping launch.
  BROWSER_AUTO_LAUNCH:        { type: 'bool', default: false },
  // Delay (ms) after the browser-automation boot step before the deferred
  // auto-launch fires. Long enough for voice/mic init to grab the device first.
  BROWSER_AUTO_LAUNCH_DELAY_MS: { type: 'number', default: 20000, min: 0 },

  // Google OAuth (Phase 13 — Gmail adapter)
  GOOGLE_CLIENT_ID:            { type: 'string', default: '' },
  GOOGLE_CLIENT_SECRET:        { type: 'string', default: '' },
  GOOGLE_REFRESH_TOKEN:       { type: 'string', default: '' },

  // Gmail triage sensor (Item 7 — unread-mail polling, mirrors reminder-sensor)
  GMAIL_TRIAGE_POLL_MS:        { type: 'number', default: 300000, min: 60000 },
  GMAIL_TRIAGE_ENABLED:        { type: 'bool',   default: true },

  // Android ADB bridge (Task 8-10, Wave 2) — optional. adapters/android-child
  // degrades to OFFLINE with an install hint when adb isn't resolvable;
  // boot is unaffected either way (AD-9). See mythos/.env.example.
  ANDROID_ADB_BIN:             { type: 'string', default: 'adb' },
  ANDROID_ADB_POLL_MS:         { type: 'number', default: 8000, min: 1000 },
  ANDROID_CMD_TIMEOUT_MS:      { type: 'number', default: 15000, min: 1000 },

  // Engagement Layer (Phase 17/18 — structured task lifecycle)
  ENGAGEMENT_TTL_MS:           { type: 'number', default: 604800000, min: 3600000 },
  ENGAGEMENT_MAX_REPAIRS:      { type: 'number', default: 3, min: 0, max: 10 },
  ENGAGEMENT_INTERVIEW_MAX_Q:  { type: 'number', default: 5, min: 1, max: 20 },
  ENGAGEMENT_MAX_STAGES:       { type: 'number', default: 10, min: 1, max: 50 },

  // Forge (P22 — multi-file agentic build pipeline). FORGE_FILE_RETRY and
  // FORGE_CONCURRENCY (a per-file retry count + concurrency pump) were
  // removed by the Phase 3 Hermes orchestration change: Hermes does one
  // build run for the whole project rather than per-file brain.think calls,
  // so neither knob has anything left to read it.
  FORGE_MAX_FILES:             { type: 'number', default: 12,      min: 1,     max: 40 },
  // Hermes build driver (hermes-runner.js) — Forge now drives the hermes-agent
  // CLI instead of brain.think(). Plan runs are sandboxed/short; builds run a
  // real agent loop and need real headroom (30 min default, per THE DECISION's
  // Mistral-primary arithmetic — see the Hermes orchestration handoff).
  HERMES_PLAN_TIMEOUT_MS:      { type: 'number', default: 300000,   min: 10000,  max: 900000 },
  HERMES_BUILD_TIMEOUT_MS:     { type: 'number', default: 1800000,  min: 60000,  max: 3600000 },
  HERMES_POLL_MS:              { type: 'number', default: 2000,     min: 500,    max: 30000 },
  HERMES_BUILD_TERMINAL_ENV:   { type: 'string', default: 'local' },
  // Checkpoints (P22 — workflow approval gates, distinct from LEASH_CONFIRM_TTL_MS)
  CHECKPOINT_TTL_MS:           { type: 'number', default: 1800000, min: 60000 },
  CHECKPOINT_SWEEP_MS:         { type: 'number', default: 60000,   min: 5000 },

  // YouTube mode: 'electron' (default) plays inside the HUD's web panel, where
  // the Electron session-level blocker (electron/main.js,
  // @ghostery/adblocker-electron) handles ads and the app stays self-contained —
  // this is the operator's expressed intent ("electron only, don't open the
  // browser"). 'embed' is the legacy alias for the same in-HUD behavior.
  // 'newtab' opens videos in the real external browser (where the operator's
  // own ad blocker lives) — opt-in only, since it pops a separate Chrome window.
  YOUTUBE_MODE:                { type: 'string', default: 'electron', enum: ['electron', 'embed', 'newtab'] },

  // MCP server (Item 10 — hand-rolled JSON-RPC 2.0 stdio server, mcp/server.js).
  // Opt-in by design: exposing the hub's ~58-tool catalog over a new stdio
  // surface is a trust-boundary expansion the operator must explicitly enable.
  MCP_SERVER_ENABLED:          { type: 'bool', default: false },

  // ---- W8 (Phase 2 — Wiring Integrity): previously-bypassed env keys now
  // schema-defined + documented. task-957 §24 W8: ~30 keys were read via
  // process.env.X without schema validation; ~22 schema keys were missing
  // from .env.example. Each key here is read live (config.X at call time,
  // never cached at construction) per the D-46 class discipline. Some
  // callers still read process.env.X directly at module-load (chain.js,
  // registry.js) — they see the same value either way; the schema entry
  // makes the key visible + validated when explicitly set. ----

  // Brain chain (per-attempt timeout, distinct from ACTION_TIMEOUT_MS which
  // bounds the whole dispatch; ollama keep-alive for vision lane)
  CHAIN_ATTEMPT_TIMEOUT_MS:    { type: 'number', default: 30000, min: 1000 },
  VOICE_OLLAMA_KEEP_ALIVE:     { type: 'string', default: '10m' },

  // Voice loop tuning
  VOICE_RECALL_TIMEOUT_MS:     { type: 'number', default: 3500, min: 500 },     // RAG recall bound before reply
  VOICE_INTAKE_IDLE_MS:        { type: 'number', default: 2700000, min: 10000 }, // idle history retention (45 min)
  VOICE_HISTORY_MAX_TURNS:     { type: 'number', default: 40, min: 2, max: 200 },      // conversation entries kept
  VOICE_HISTORY_MAX_CHARS:     { type: 'number', default: 12000, min: 1000, max: 60000 }, // total history prompt budget
  VOICE_MAX_TOOL_ITERATIONS:   { type: 'number', default: 4, min: 1, max: 20 },
  // WAVE 8 — how long a SPOKEN send-confirm stays armed before it releases
  // itself. Short by design: an armed send is a loaded action, and the operator
  // saying "yes" to something else a minute later must not fire it.
  VOICE_SPOKEN_CONFIRM_TTL_MS: { type: 'number', default: 60000, min: 1, max: 600000 },
  VOICE_EMAIL_MODE:            { type: 'string', default: 'gmail', enum: ['gmail', 'mailto'] },
  VOICE_ALLOWED_DIRS:          { type: 'string', default: '%USERPROFILE%' },    // semicolon-separated list_folder whitelist

  // Identity / reflection / immune speech
  BOOT_GREETING:               { type: 'string', default: '' },    // '' = on; 'false' = off
  REFLECTION_EVERY_TURNS:      { type: 'number', default: 15, min: 1 },
  FOLLOWUP_QUIET_MS:           { type: 'number', default: 120000, min: 0 },   // silence needed before a proactive follow-up
  FOLLOWUP_MIN_GAP_MS:         { type: 'number', default: 3600000, min: 0 },  // min gap between follow-ups; 0 = off
  IMMUNE_EXPLAIN:              { type: 'string', default: 'true' }, // 'false' disables anomaly speech
  ANNOUNCER_REANNOUNCE_MS:     { type: 'number', default: 600000, min: 10000 },

  // Server rate limiting + WS origin allowlist
  RATE_LIMIT_GLOBAL:           { type: 'number', default: 240, min: 1 },
  RATE_LIMIT_EXPENSIVE:        { type: 'number', default: 8,   min: 1 },
  ALLOWED_ORIGINS:             { type: 'string', default: '' }, // comma-sep WS/CORS allowlist

  // Cortex drain cap per tick (the 50-per-tick perception cap, §11.1)
  MAX_DRAIN_PER_TICK:          { type: 'number', default: 50, min: 1, max: 500 },

  // Pretty TTY logging ('force' = on even when piped, 'false' = off)
  MYTHOS_LOG_PRETTY:           { type: 'string', default: '' },

  // Edge-TTS child service
  EDGE_TTS_URL:                { type: 'string', default: 'http://127.0.0.1:5050' },
  EDGE_TTS_PORT:               { type: 'number', default: 5050, min: 1024, max: 65535 },
  EDGE_TTS_AUTOSTART:          { type: 'string', default: '' },  // 'false' = don't spawn at boot

  // Embeddings / STT model overrides (free-tier default models)
  OLLAMA_EMBED_MODEL:          { type: 'string', default: 'nomic-embed-text' },
  MISTRAL_EMBED_MODEL:         { type: 'string', default: 'mistral-embed' },
  GROQ_STT_MODEL:              { type: 'string', default: 'whisper-large-v3-turbo' },

  // Provider URL overrides (default to the official endpoints)
  NIM_API_URL:                 { type: 'string', default: 'https://integrate.api.nvidia.com/v1' },
  GROQ_API_URL:                { type: 'string', default: 'https://api.groq.com/openai/v1' },
  MISTRAL_API_URL:             { type: 'string', default: 'https://api.mistral.ai/v1' },
  CEREBRAS_API_URL:            { type: 'string', default: 'https://api.cerebras.ai/v1' },

  // Phase 3 (V7) — run_command effector (allow-listed shell commands for build
  // verification). v1 is allowlist + timeout, NOT a full sandbox. Empty
  // allowlist → fail-closed ('run_command disabled — set RUN_COMMAND_ALLOWLIST').
  // Format: 'cmd:flag,flag;cmd2:flag;cmd3' (semicolons between commands, colon
  // precedes a command's allowed flags, commas between flags). Keep minimal;
  // never allow sh/bash/cmd/powershell.
  RUN_COMMAND_ALLOWLIST:       { type: 'string', default: '' },
  RUN_COMMAND_TIMEOUT_MS:      { type: 'number', default: 60000, min: 1000 },

  // install_from_github effector (src/core/effectors/from-installer.js). Reuses
  // RUN_COMMAND_ALLOWLIST above as its gate (needs 'git' plus the target repo's
  // package manager), so it is fail-closed by the same switch. Only the timeout
  // is separate: a real `npm install`/`pip install .` routinely exceeds
  // RUN_COMMAND_TIMEOUT_MS's 60s default, and raising that default would loosen
  // every run_command call too.
  INSTALL_TIMEOUT_MS:          { type: 'number', default: 600000, min: 1000 },

  // Native speech-to-speech (Gemini Live, V2 §6-§10, merged-order step 4).
  // Opt-in, default false — voice-agent.js's batch STT path is the untouched
  // fallback; flipping this back to false is a total, zero-code rollback
  // (V2 §16). See .env.example for the full story on each key, including the
  // GEMINI_LIVE_VOICE choice.
  VOICE_S2S_ENABLED:           { type: 'bool',   default: false },
  GEMINI_LIVE_MODEL:           { type: 'string', default: 'models/gemini-3.1-flash-live-preview' },
  // Aoede | Kore | Leda | Zephyr | Puck | Charon — Aoede kept as default (see
  // .env.example): auditioning by ear across all six needs a human with
  // speakers, which cannot happen in this environment.
  GEMINI_LIVE_VOICE:           { type: 'string', default: 'Aoede' },
  // BUG-059: was 45000. The browser bridge (s2s-bridge.js) suspends mic
  // capture for up to 30s (MAX_SUSPEND_MS) while MYTHOS's own TTS or media
  // playback is out of the speakers — sendAudio() stops being called for
  // that whole window, so 45s left no margin before the idle timer fired
  // mid-turn. Raised to comfortably clear a 30s suspend plus slack; still
  // operator-overridable via env, not removed.
  LIVE_IDLE_TIMEOUT_MS:        { type: 'number', default: 120000, min: 1000 },
  LIVE_SESSION_MAX_MS:         { type: 'number', default: 600000, min: 10000 },
  // Comma-separated tool-name allowlist; empty = live-tools.js's curated
  // DEFAULT_ALLOWLIST (accuracy degrades with 107 raw registered tools).
  LIVE_TOOL_ALLOWLIST:         { type: 'string', default: '' },
};

module.exports = { SCHEMA };
