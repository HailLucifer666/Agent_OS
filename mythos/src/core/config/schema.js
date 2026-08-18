'use strict';

const path = require('path');

// MYTHOS Phase 0 config schema
// Keys: type, default, min?, max?, enum?, bool?, required?
// validate() in index.js reads this to coerce + validate raw env

// B3-remainder (security audit, 2026-08-08): MYTHOS_VAULT_ROOT used to default
// to the LITERAL string './vault', resolved by main.js's path.resolve() against
// process.cwd() at boot — so the vault MYTHOS opens depended on whatever
// directory launched the process, not on where the repo/install lives. A fork
// with an unexpected cwd silently opened an empty <cwd>/vault instead of the
// real vault holding thousands of episodic entries and reported healthy (the
// "factory-reset MYTHOS" incident — see
// mythos/Plans/MYTHOS-IRIS-Synthesis-Plan.md). electron/vault-migration.js
// already fixed the packaged/Electron path by resolving under
// app.getPath('userData') and always deferring to an explicit env value; this
// fixes the same failure mode for the bare-node path by computing the default
// as an ABSOLUTE path anchored to this file's own location (mythos/), which is
// stable regardless of process.cwd(). An explicit MYTHOS_VAULT_ROOT (operator
// .env, Dockerfile, render.yaml's /data/vault, or Electron's resolved
// userData path) is read verbatim by validate() below and always wins — this
// default is only ever reached when the key is completely unset.
const DEFAULT_VAULT_ROOT = path.join(__dirname, '..', '..', '..', 'vault');

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
  // Track B1 — real server-side enforcement of the §7.3 PIN lock screen.
  // Until this, the PIN screen was a client-side visual/pointer deterrent
  // ONLY: tokenOk() (server/index.js) passes every request when
  // MYTHOS_AUTH_TOKEN is unset, so `curl 127.0.0.1/api/...` bypassed the
  // lock screen entirely on the default loopback install. ON by default
  // (operator decision, 2026-08-17: "whenever we start the app, it should
  // ask for the PIN") — and safe to be on because pinSessionRequired()
  // (server/index.js) requires BOTH this flag AND a PIN actually configured
  // via POST /api/pin/set: with no PIN set there is nothing to enforce, so a
  // fresh install stays open rather than locking the operator out of their
  // own server. Set false to opt out — a loopback-without-token install then
  // exercises none of the enforcement paths, exactly as before Track B1.
  // See .env.example for the full story and its caveats.
  PIN_SESSION_ENFORCE:      { type: 'bool', default: true },
  // How long a PIN-unlocked session stays valid with no further activity
  // (sliding — src/core/security/pin-session.js extends it on every
  // authenticated request), ms.
  PIN_SESSION_TTL_MS:       { type: 'number', default: 1800000, min: 60000, max: 86400000 },
  // How long the mythos_token cookie issued by POST /api/auth/session lives —
  // i.e. how long a browser tab stays authenticated after the operator types
  // MYTHOS_AUTH_TOKEN once (server/routes/auth.js). Not sliding: the cookie
  // carries the bearer token itself, so this is an expiry, not a session.
  // Longer than the PIN session on purpose — the PIN gates physical presence
  // and should lapse quickly; this one only saves re-typing a token the
  // operator already has in .env.
  AUTH_SESSION_COOKIE_TTL_MS: { type: 'number', default: 2592000000, min: 3600000, max: 31536000000 },
  MYTHOS_VAULT_ROOT:        { type: 'string', default: DEFAULT_VAULT_ROOT },
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
  //
  // 2026-08-06: retuned from en-GB-SoniaNeural to en-US-AvaNeural. With
  // VOICE_UNIFIED_LIVE_VOICE (below) the entity now speaks through Gemini Live
  // (Aoede) on every surface it can, so this edge id is no longer the everyday
  // voice — it is what the operator hears when Live genuinely cannot open (no
  // key, S2S off, API down). It therefore has one job: sound like the SAME
  // person as Aoede rather than like a second character. Aoede is a warm,
  // US-leaning female; a British voice is the audible mismatch. Paired with
  // voice-loop.js's PREFERRED_VOICES order — test/voice-identity-consistent.test.js
  // pins the two together.
  VOICE_TTS_VOICE:          { type: 'string', default: 'en-US-AvaNeural' },

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

  // Kokoro-82M TTS (providers/kokoro-tts.js) — in-process onnxruntime, no
  // child service. Weights fetch from Hugging Face on first use into a
  // gitignored cache dir, never committed (see .env.example, THIRD_PARTY_NOTICES.md).
  KOKORO_VOICE:             { type: 'string', default: 'af_heart' },
  KOKORO_MODEL_DIR:         { type: 'string', default: '' },

  // ORDERED STT chain (providers/stt.js), same convention as VOICE_TTS_CHAIN.
  // Default 'groq': unchanged behaviour for anyone who sets nothing — the
  // /api/voice/transcribe route used to call providers/groq-stt.js directly.
  //   groq   Groq Whisper API. Needs GROQ_API_KEY + network.
  //   local  On-device Whisper (providers/local-whisper-stt.js). No network
  //          after the model is cached; WAV audio only.
  VOICE_STT_CHAIN:          { type: 'string', default: '' },

  // Voice VAD tuning (BUG-020 — client-side voice-loop.js speech-detection
  // thresholds; defaults match the previously-hardcoded constants). Exposed
  // to the HUD via GET /api/config/vad so mic sensitivity can be tuned
  // without a rebuild.
  // VAD_SILENCE_MS default is 1800. The 2026-08-17 experiment of 900
  // (faster endpointing) was live-falsified the same day: natural
  // mid-sentence pauses of 0.9–1.8s split one utterance into two clips,
  // MYTHOS answered mid-thought, and the assistantSpeaking half-duplex gate
  // then swallowed the operator's continuation — read live as "it interrupts
  // and breaks in between things". 1800 restored; still env-tunable for
  // anyone who wants faster endpointing: VAD_SILENCE_MS=900 in mythos/.env.
  VAD_SPEECH_RMS:           { type: 'number', default: 0.035, min: 0, max: 1 },
  VAD_MIN_PEAK_RMS:         { type: 'number', default: 0.06,  min: 0, max: 1 },
  VAD_HOLD_TICKS:           { type: 'number', default: 3,     min: 1, max: 20 },
  VAD_SILENCE_MS:           { type: 'number', default: 1800,  min: 100, max: 10000 },
  // Which speech-detector drives voice-loop.js. 'rms' (default) is the
  // hand-tuned volume-threshold detector above. 'silero' runs a trained
  // speech/non-speech ONNX model (ui/public/js/voice/silero-vad.js) client-side
  // instead — fetched by scripts/setup-silero.js, gitignored, opt-in. When
  // 'silero' is active, VAD_SPEECH_RMS/VAD_MIN_PEAK_RMS above are read as
  // speech-probability thresholds (0..1), not RMS amplitude.
  VAD_ENGINE:               { type: 'string', default: 'rms', enum: ['rms', 'silero'] },

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

  // Aether-BLE proximity-focus sensor (src/core/sensors/aether.js). Pulls the
  // Aether aggregator's `election` broadcast (nearest device = owner) over WS
  // and emits perception.aether on owner-change / meaningful RSSI drift. OFF
  // by default — opt-in (no effect when Aether isn't running). AETHER_WS_URL
  // points at the aggregator (default :8766), NOT the raw scanner bridge :8765.
  AETHER_ENABLED:            { type: 'bool',   default: false },
  AETHER_WS_URL:             { type: 'string', default: 'ws://127.0.0.1:8766' },
  // Phase 2 — route voice output to the nearest Aether device (aggregator
  // `say`) instead of the local TTS chain. Requires AETHER_ENABLED + a live
  // aggregator; falls back to local TTS when the socket is down.
  AETHER_AUDIO_ROUTE:        { type: 'bool',   default: false },
  // Voice Nodes (phones as Aether scanners + audio endpoints).
  //
  // The Aether protocol (PROTOCOL.md §2) has the aggregator dial OUT to every
  // scanner as a WS client — a scanner MUST serve its own WS server. A phone
  // on Wi-Fi cannot reliably be dialled (roaming IP, doze, no stable port), so
  // MYTHOS runs one loopback WS server per phone and republishes whatever that
  // phone pushes up its own outbound socket in §4.1 `reading` / §4.2 `lost`
  // shape. The aggregator dials the proxy; the phone dials MYTHOS. Nothing
  // Python-side changes.
  //
  // AETHER_NODE_IDS is a comma-separated list; ORDER IS LOAD-BEARING — the
  // first id gets AETHER_PROXY_PORT_BASE, the second base+1, and so on, which
  // is the order those ports must appear in the aggregator's --peers. The proxy
  // refuses to start on a malformed/duplicate list rather than silently
  // mis-assigning a port.
  AETHER_PROXY_ENABLED:      { type: 'bool',   default: false },
  AETHER_PROXY_PORT_BASE:    { type: 'number', default: 4480, min: 1024, max: 65000 },
  AETHER_NODE_IDS:           { type: 'string', default: '' },
  // Admits non-browser voice-node clients (OkHttp sends no Origin header) to
  // the WS upgrade. This deliberately relaxes the V2 §7.2 "no Origin +
  // non-loopback => 403" rule, so it is OFF by default and — unlike the
  // loopback back-compat path — a valid MYTHOS_AUTH_TOKEN is MANDATORY on
  // every request it admits, never optional. No token, no node access.
  AETHER_NODE_TRUST:         { type: 'bool',   default: false },
  // Speak through the elected voice node instead of the local speakers: MYTHOS
  // synthesizes as usual and the speech-chunk stream is delivered to the phone
  // Aether currently names as owner, while the HUD still captions the reply.
  // Distinct from AETHER_AUDIO_ROUTE, which hands the TEXT to the aggregator and
  // lets IT synthesize on whatever machine it runs on. This one keeps MYTHOS's
  // own voice and just changes which speaker it comes out of, so it takes
  // precedence when both are set. Falls back to local TTS whenever no node is
  // connected, and a live Gemini Live session always wins over both.
  AETHER_NODE_AUDIO:         { type: 'bool',   default: false },
  // The id THIS machine's own scanner uses in the mesh — i.e. `bridge.py
  // --scanner <id>`, conventionally 'PC'. MYTHOS cannot infer it: the scanner is a
  // separate process the operator starts, and the aggregator only ever reports ids.
  //
  // Set it and the HUD competes in wake arbitration like any phone, standing down
  // when Aether names another device. Leave it unset and the desktop wake word
  // behaves exactly as it does today — which is why the default is empty rather
  // than a guess at 'PC': a wrong id here would make the HUD look suppressed
  // forever, or compete as a device that is not in the election at all.
  AETHER_LOCAL_SCANNER_ID:   { type: 'string', default: '' },

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
  // B1 (2026-08-14): per-(provider,model) circuit breakers in brain/chain.js, on
  // top of CHAIN_COOLDOWN_MS. The cooldown is a flat 60s single-failure skip and
  // lapses between calls that are minutes apart — which is the measured pattern
  // that let NVIDIA NIM sit at the head of the vision lane costing 8s of dead
  // time per look, all day (screen_look median 10,254ms against a 12,000ms
  // budget). The breaker adds escalating backoff so a sustained outage is skipped
  // for minutes, with HALF_OPEN's single probe restoring a recovered provider
  // automatically. Default ON; this key exists as a kill switch because chain.js
  // serves EVERY brain lane, so a defect here would degrade the whole brain.
  CHAIN_BREAKERS_ENABLED:   { type: 'boolean', default: true },
  MODEL_REGISTRY_TTL_MS:    { type: 'number', default: 300000, min: 10000 },

  // Caveman/terse output style (src/core/brain/style-terse.js), comma-separated
  // lane names. Cuts OUTPUT tokens on prose by dropping articles, filler and
  // pleasantries while leaving code, commands and error text byte-identical.
  //
  // 'voice' is deliberately NOT a default and should not be added: it is spoken
  // aloud, and clipped fragments sound like a malfunction rather than brevity.
  // 'build' is also excluded — that lane emits artifact CONTENT (source files),
  // where a brevity instruction is actively destructive.
  // 'simple' is the trivial/formatting lane and is where the savings are.
  // Individual callers on a spoken path opt out per call with
  // think({ terse: false }) — the boot greeting (server/index.js) and
  // immune/explainer.js both do exactly that, which is why they were left on
  // 'simple' when the reasoning/memory lanes were split out.
  //
  // 'memory' WAS ADDED 2026-08-14 WITH THAT SPLIT, DELIBERATELY, and this is the
  // only place the decision is visible. Memory consolidation and document
  // answering moved off 'simple' onto their own lane; without naming 'memory'
  // here they would have silently lost terse compression — longer summaries,
  // more tokens, no error, nothing in a diff to notice. Compact summaries are
  // the point of consolidation, so terse follows it.
  //
  // 'reasoning' is deliberately EXCLUDED for the mirror-image reason. mull(),
  // reflection, the reviewer/reality-check seats and think_deeply were moved to
  // that lane precisely so they could think properly; compressing their output
  // is working against the change that created the lane. A reasoning answer that
  // has to drop articles to fit is the wrong trade.
  //
  // Empty string disables the layer entirely.
  BRAIN_TERSE_LANES:        { type: 'string', default: 'simple,memory' },

  // Autonomy
  AUTONOMOUS_MAX_TIER:      { type: 'number', default: 2, min: 0, max: 4 },
  // B4 (2026-08-14) — RAISED FROM 20000 AGAINST A MEASUREMENT, not a guess.
  //
  // Three goals were created at 17:32:12 and two auto-paused five seconds later,
  // before either had done anything. From vault/Goals/*.json:
  //   "Set up the backend API endpoints"  spent {tokens:31272, actions:2}  budget {tokens:20000, actions:25}
  //   "Develop the frontend components"   spent {tokens:31200, actions:2}  budget {tokens:20000, actions:25}
  // ~15,600 tokens per action against a 20,000 total. The operator asked for
  // structured project tracking and got two of three tasks paused on arrival.
  //
  // WHAT IS COUNTED IS NOT WHAT THE GOAL SPENT. brain/index.js debits
  // `spend.estimate(result.content) + spend.estimate(inputText)`, and inputText is
  // the ENTIRE prompt — system instruction, tool catalogue, recalled memory,
  // history. That fixed per-call overhead is identical whether the goal is one
  // line or fifty, so this budget was denominated in a unit dominated by the cost
  // of thinking once rather than by anything the goal did.
  //
  // 250,000 = 16 planner-sized calls at the measured ~15.6k, which is well past
  // any ordinary multi-step goal while still bounding a true runaway. The number
  // is deliberately NOT "large enough to never trip": GOAL_ACTION_BUDGET is the
  // real runaway ceiling (see below) and this stays a genuine backstop.
  //
  // NOT fixed here, and noted because a budget decision resting on an estimate
  // deserves the caveat: spend.estimate() is a chars/4-ish approximation while the
  // providers return real usage. Whether the ledger should switch to reported
  // usage is its own change.
  GOAL_TOKEN_BUDGET:        { type: 'number', default: 250000, min: 0 },
  // The primary ceiling, and the dimension that actually bounds a loop. On
  // 2026-08-14 it never came close: 2 actions of 25. Left exactly as it was —
  // raising the token budget only works because this one is still doing the real
  // work of stopping a goal that will not terminate.
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
  // Learning-loop keys (Lessons store). LESSON_RECALL_LIMIT caps how many prior
  // failures the goal planner injects into its brain prompt. GOAL_FAIL_PAUSE_THRESHOLD
  // is how many identical (tool+argsHash+goalTitle) failures land before the goal
  // auto-pauses with reason:'repeated-failure' instead of re-planning forever —
  // the symmetric counterpart to the existing budget-exhausted pause.
  LESSON_RECALL_LIMIT:       { type: 'number', default: 5, min: 1, max: 20 },
  GOAL_FAIL_PAUSE_THRESHOLD: { type: 'number', default: 3, min: 2, max: 20 },
  LESSON_RETENTION_DAYS:     { type: 'number', default: 90, min: 1, max: 3650 },

  // Leash (Phase 5)
  // 30s was a desktop-modal assumption: the operator is already looking at the
  // screen, so the window only has to cover "read it and click". Approvals now
  // also reach the phone (2026-08-09), where the window has to cover hearing the
  // request, picking the device up, unlocking it, reading and deciding — and a
  // confirm that lapses mid-decision is worse than a slower one, because the
  // registry sweeps it passively and the late tap is a silent no-op.
  // Widening it does keep an un-answered T3/T4 action approvable for longer;
  // it does NOT widen who may approve (accept() is still connection-scoped and
  // single-use) or what may be approved without a human.
  LEASH_CONFIRM_TTL_MS:     { type: 'number', default: 120000, min: 1000 },

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
  // Notes directory (memory/notes.js). Empty = <vault>/Notes, which is what a
  // fresh clone uses. Set it to an existing Obsidian vault folder and MYTHOS's
  // notes land there as ordinary .md files — no Obsidian plugin or CLI needed.
  MYTHOS_NOTES_DIR:          { type: 'string', default: '' },
  // Build refine loop (2026-08-14, the "snake game test"). ON by default: a
  // build that has never been rendered is the problem this closes. The refiner
  // is CONSTRUCTED INSIDE this flag check in main.js — an opt-out flag protects
  // nothing that runs before it is read (Slice-5 lesson).
  BUILD_REFINE_ENABLED:        { type: 'bool',   default: true },
  BUILD_REFINE_MAX_ITERATIONS: { type: 'number', default: 2, min: 1, max: 4 },
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
  // BUG-111: how often the sensor polls gmail_unread in the background.
  // 'boot-once' (default) runs a single pass at startup then stops its own
  // timer entirely; 'poll' is the pre-2026-08-05 always-on recurring
  // behavior; 'off' disables the sensor. gmail_unread itself (the effector)
  // is unaffected by this — explicit requests still work in every mode.
  GMAIL_TRIAGE_MODE:           { type: 'string', default: 'boot-once', enum: ['boot-once', 'poll', 'off'] },

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
  // Bound on ONE vision look (screen_look / camera_look), deliberately far below
  // CHAIN_ATTEMPT_TIMEOUT_MS: that is 30s PER ATTEMPT across a seven-model lane,
  // so a starved free-tier provider can hold a "quick look" past a minute — two
  // real screen_look calls on 2026-08-10 took 16s and 63s while the operator was
  // mid-sentence, which is how the model ended up narrating a guess. A look that
  // outlives this fails honestly instead of arriving after the conversation has
  // moved on. Raise it only if a slow provider is genuinely preferred to a
  // truthful "I could not see it in time".
  VISION_CALL_TIMEOUT_MS:      { type: 'number', default: 12000, min: 1000 },
  // Bound on ONE PROVIDER ATTEMPT inside that look, and the 2026-08-14 fix for
  // two screen_look calls that failed with the lane fully alive. The pair above
  // was not merely different from CHAIN_ATTEMPT_TIMEOUT_MS, it was incompatible
  // with it: a 12s total budget against a 30s per-attempt step means the first
  // slow model consumes the entire budget and the remaining four are never tried,
  // so the lane's failover existed but could never run. 4s per attempt lets the
  // 12s budget actually walk 2-3 models; vision-call.js clamps it below
  // VISION_CALL_TIMEOUT_MS, because a per-attempt bound at or above the total
  // bound reintroduces the bug rather than configuring it.
  // BUG-273 C3 — was 4000, and 4000 could not tell a slow provider from a dead
  // one. PREF_VISION's own recorded latencies include 3090ms, and the screen_look
  // that SUCCEEDED on 2026-08-18 took 2672ms; three minutes later nine models
  // across five providers all aborted within 15ms of the 4000ms ceiling. A budget
  // only ~30% above the known-good case turns one slow minute into a lane-wide
  // outage. 7000ms clears the slowest recorded good latency by ~2.3x while still
  // leaving room for THREE attempts inside the raised total budget. screen_look has
  // been a SLOW_TOOL since BUG-272 T4 (it acks 'started' and reports its real
  // outcome later), so a longer budget no longer stalls a voice turn the way it
  // would have when these two numbers were first chosen.
  VISION_ATTEMPT_TIMEOUT_MS:   { type: 'number', default: 7000, min: 500 },

  // think_deeply (effectors/deep-think.js) — same two-bound shape as vision
  // above, and for the same reason: a total budget shorter than chain.js's
  // per-attempt step means the lane's failover can never run. Longer than
  // vision's 12s deliberately — a look answers "what is on screen right now",
  // this one is the explicit "go away and think about it properly" verb. Past
  // 20s the operator has moved on and an honest "that took too long" beats a
  // late answer. deep-think.js clamps the per-attempt bound below the total.
  DEEP_THINK_TIMEOUT_MS:       { type: 'number', default: 20000, min: 1000 },
  DEEP_THINK_ATTEMPT_TIMEOUT_MS: { type: 'number', default: 7000, min: 500 },

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

  // MCP client (adapters/mcp-client + effectors/from-mcp.js). Lets MYTHOS talk
  // to Model Context Protocol servers over stdio — Desktop Commander,
  // browser-use, or anything else the operator points it at.
  //
  // MCP_SERVERS is a JSON array; empty → fail-closed, no server is contacted
  // and every mcp_* tool reports disabled. Each entry:
  //   {"name":"desktop_commander",         // [A-Za-z0-9_-], becomes part of the tool name
  //    "command":"npx","args":["-y","@wonderwhy-er/desktop-commander@latest"],
  //    "env":{"OPENAI_API_KEY":"${OPENAI_API_KEY}"},   // ${VAR} expands from the real env
  //    "autostart":false}                              // connect at boot, or lazily on first use
  // Ambient env is scrubbed of secrets before the server is spawned; the "env"
  // block is the ONLY way a key reaches it, per server, by name.
  //
  // MCP_TOOL_ALLOWLIST is an optional second gate: a ;/,/newline-separated list
  // of fully-qualified tool names (mcp__<server>__<tool>). Empty means every
  // tool the configured servers advertise is callable — which is why every call
  // is tier 3 regardless. An MCP server is NOT sandboxed by MYTHOS.
  MCP_SERVERS:                 { type: 'string', default: '' },
  MCP_TOOL_ALLOWLIST:          { type: 'string', default: '' },
  MCP_TIMEOUT_MS:              { type: 'number', default: 30000, min: 1000 },

  // Strix security scanning (effectors/from-strix.js, `security_scan` tool).
  // Optional: absent Strix/Docker → the tool reports OFFLINE with an install
  // hint, never blocks boot. STRIX_LLM + LLM_API_KEY are the operator's OWN LLM
  // credentials — Strix bills against them, not MYTHOS's brain keys. The tool
  // still refuses without a per-call `authorized_by`; these keys only decide
  // whether an authorized run can execute.
  STRIX_LLM:                   { type: 'string', default: '' },
  LLM_API_KEY:                 { type: 'string', default: '' },
  LLM_API_BASE:                { type: 'string', default: '' },
  STRIX_TIMEOUT_MS:            { type: 'number', default: 1800000, min: 10000 },

  // Native speech-to-speech (Gemini Live, V2 §6-§10, merged-order step 4).
  // Opt-in and OFF by default (F5, go-live proof plan 2026-08-08): the Live
  // API is metered per open session and bills for the time the socket is
  // open, and .env.example has ALWAYS documented it as "Opt-in and OFF by
  // default" — the schema default of true contradicted the docs, so a fresh
  // deploy with a GOOGLE_API_KEY opened billed Live sessions with no explicit
  // opt-in. Set true to make Gemini Live (real-time duplex audio via
  // s2s-bridge.js) the primary voice path; voice-agent.js's batch STT path
  // remains the untouched fallback when it is off, no key is present, or a
  // live session fails. Flipping back to false is a total, zero-code rollback
  // (V2 §16). See .env.example for the full story on each key, including the
  // voice choice.
  VOICE_S2S_ENABLED:           { type: 'bool',   default: false },

  // BUG-251: inject Semantic/user-facts.md into the Live session instruction so
  // the spoken path knows what the vault knows. Default ON — the amnesia it
  // fixes was operator-visible. Setting it false restores the pre-fix frame
  // exactly, with no code change (see server/index.js's OPERATOR FACTS block).
  LIVE_MEMORY_INJECT:          { type: 'bool',   default: true },

  // ---- record-window volume ducking, and its anti-feedback bounds ----
  //
  // ADDED TO THE SCHEMA 2026-08-11 (installer parity). All five were
  // `Number(process.env.X) || default` inside server/index.js, which put them
  // OUTSIDE the config schema — and therefore outside userData/config.json, the
  // only place a packaged install can put a setting. So the exact bounds that stop
  // the volume feedback loop could not be tuned on the build that reported the
  // loop. Defaults are transcribed from those expressions unchanged, so .env and
  // every existing deployment behave identically. See server/index.js's duckAudio
  // comment for what each one does and the incident that produced them.
  //
  // An operator on VOICE_S2S_ENABLED (the dev configuration, and the derived
  // default when a Google key is present) never reaches this code at all — Live
  // duplex has no record-window ducking.
  DUCK_VOLUME_LEVEL:           { type: 'number', default: 15, min: 0, max: 100 },
  DUCK_MIN_HOLD_MS:            { type: 'number', default: 800, min: 0 },
  DUCK_COOLDOWN_MS:            { type: 'number', default: 1200, min: 0 },
  // Consecutive mic-hot windows that ended with no utterance dispatched before
  // ducking backs off entirely. A window that heard nobody was not a person.
  DUCK_FALSE_MAX:              { type: 'number', default: 2, min: 1 },
  DUCK_SUPPRESS_MS:            { type: 'number', default: 30000, min: 0 },
  // Restores the volume even if the client never sends unduck (dropped
  // connection, crash). In the schema for the same reason as the four above.
  UNDUCK_SAFETY_MS:            { type: 'number', default: 15000, min: 1000 },
  // MEASURED 2026-08-14 on the operator's real key, with actual BidiGenerateContent
  // connects (catalog listings lie here, so reachability means a real setupComplete):
  //
  //   REACHABLE  gemini-3.1-flash-live-preview           setup 468ms, first audio  951ms
  //   REACHABLE  gemini-2.5-flash-native-audio-latest    setup 556ms, first audio 2126ms
  //   REACHABLE  gemini-2.5-flash-native-audio-preview-12-2025   (same timings)
  //   setup ok, never completes a text turn: gemini-3.5-live-translate-preview
  //   NOT FOUND (close 1008): gemini-3.1-pro-live-preview, gemini-live-2.5-flash-preview
  //
  // **There is no Pro-tier Live model.** ListModels advertises 6 models supporting
  // bidiGenerateContent and every one is flash or a flash native-audio variant, so
  // "move voice to a stronger model" is not a lever that exists — unlike the TEXT
  // lanes, where Pro is merely 429-blocked on a free key (see lanes.default.js) and
  // billing would plausibly unlock it. Do not swap this default hoping for more
  // intelligence: on a 4-question set the two families scored identically (4/4
  // each, including refusing to invent a fact and getting a two-step age puzzle
  // right), and native-audio is 2.2x slower to first audio. The set was too easy
  // to discriminate them, which is itself the finding — reach for prompt and
  // tool-visibility work (BUG-222) before reaching for the model name.
  GEMINI_LIVE_MODEL:           { type: 'string', default: 'models/gemini-3.1-flash-live-preview' },
  // Aoede | Kore | Leda | Zephyr | Puck | Charon — Aoede kept as default (see
  // .env.example): auditioning by ear across all six needs a human with
  // speakers, which cannot happen in this environment.
  GEMINI_LIVE_VOICE:           { type: 'string', default: 'Aoede' },
  // Wave 6 (2026-08-13): unset (empty string) means auto-detect, Gemini's own
  // default and this project's — pinning a language is opt-in, not a new
  // default nobody asked for. An operator whose session drifts into Korean
  // or Spanish STT mid-conversation can pin e.g. 'en-US' to stop it. BCP-47
  // tag, passed through verbatim — no validation here, since Gemini Live's
  // supported set is theirs to define and can change without a schema edit
  // on this side. KNOWN CAVEAT, not fixed by this: per the Gemini Live docs,
  // Hindi/Bengali (and some other languages) are speech-INPUT-only for this
  // API — pinning one of those changes what the model expects to HEAR, not
  // what it can SPEAK back in.
  GEMINI_LIVE_LANGUAGE:        { type: 'string', default: '' },
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
  // BUG-128's net (live-tool-adapter.js): any tool call not resolved by this
  // deadline gets a status:'started' ack so the Live turn never ends holding an
  // unanswered call id. Config-driven since 2026-08-17 (fix-plan 2.3) because
  // the 1500 default produced 4 late acks on web_search/web_fetch in one
  // measured session — network calls that routinely exceed 1.5s. The number is
  // the OPERATOR's call, evidence-first: count `live.tool-ack-deadline` log
  // lines per session and raise it until the storms stop (each line names the
  // tool and the deadline it blew). Default UNCHANGED at 1500; min 250 stops a
  // typo from acking before the dispatch round-trip even starts.
  TOOL_ACK_DEADLINE_MS:        { type: 'number', default: 1500, min: 250 },

  // One voice on every surface (operator report, 2026-08-06: "when mythos boots
  // there is one voice, when I speak another, when I type another").
  //
  // The Live session is created lazily on liveOpen() — the wake-word/cost gate,
  // deliberately "never at boot, never at connection time" (server/index.js).
  // That gate is also why the boot greeting and typed-only chat had no Live
  // session to speak through and fell to edge-tts (and, when the edge-tts
  // sidecar was still starting, to the browser's own speechSynthesis) — three
  // engines, three voices, in one session.
  //
  // With this true, entity-initiated speech (boot greeting, proactive alerts)
  // and typed HUD turns OPEN a Live session on demand and speak through it, so
  // they use the exact GEMINI_LIVE_VOICE the operator hears when speaking.
  // Honest tradeoff: that is a real Gemini Live session opened without the
  // operator having said anything, which costs BYO quota. The existing
  // MAX_IDLE_ROTATIONS_WITHOUT_SPEECH ceiling in live-session.js still applies,
  // so an unattended session stops rotating rather than burning quota forever.
  // false = the pre-2026-08-06 behaviour exactly, no code path changed.
  VOICE_UNIFIED_LIVE_VOICE:    { type: 'bool',   default: true },

  // Operator-present trust (leash/index.js, 2026-08-06). Comma-separated tool
  // names ADDED to the built-in trusted list — local, reversible T3 tools that
  // auto-allow WITHOUT a confirm, but ONLY when a real operator connection is
  // driving (voice-agent.js / live-tool-adapter.js). The autonomous loop, the
  // engagement executor and the reminder sensor pass no connectionId and are
  // therefore unaffected by anything set here; this is not a ceiling raise and
  // AUTONOMOUS_MAX_TIER is untouched.
  //
  // An entry is IGNORED and reported at boot (health.anomaly
  // 'leash-trusted-tool-ignored', named) when it is on the never-trustable set
  // (anything that sends, runs/installs, deletes, or executes arbitrary code —
  // gmail_send, run_command, delete_file, browser_evaluate, kill_session, …),
  // is not tier 3, or is not a known tool name. That set cannot be overridden
  // from env, by design.
  //
  // TRUSTED_TOOLS_DISABLED=true is the single switch back to confirm-everything
  // (which degrades to the BUG-012/BUG-119 session grant: confirm once per tool
  // per connection, not confirm every time). leash.check() reads it on every
  // call rather than caching it at construction — same discipline as
  // AUTONOMOUS_MAX_TIER — but the config object itself is built once at boot and
  // frozen, so editing .env still needs a restart to take effect.
  TRUSTED_TOOLS:               { type: 'string', default: '' },
  TRUSTED_TOOLS_DISABLED:      { type: 'bool',   default: false },

  // Live screen share (Electron Slice 3, spine §13's desktopCapturer). Streams
  // desktop JPEG frames into the open Live session as realtimeInput.video, so
  // "what am I looking at?" is answered from the actual screen instead of the
  // polling screen-sensor's periodic vision call.
  //
  // OFF by default and deliberately so — this sends pictures of the operator's
  // desktop to Google continuously, which is a materially different privacy
  // posture from sending audio, and nobody should get it by upgrading. The HUD
  // learns the flag from /api/config/s2s (the same path that made s2s-bridge.js
  // reachable at all).
  //
  // FPS is the cost dial, not a quality dial: every frame is a billed image
  // input. 0.5 (one frame per two seconds) is enough for "watch my screen"
  // because the model keeps prior frames in context; 1-2 is noticeably more
  // responsive and proportionally more expensive. Capped at 4 — past that the
  // token spend climbs far faster than the usefulness.
  LIVE_SCREEN_SHARE_ENABLED:   { type: 'bool',   default: false },
  LIVE_SCREEN_FPS:             { type: 'number', default: 0.5, min: 0.1, max: 4 },
  LIVE_SCREEN_JPEG_QUALITY:    { type: 'number', default: 0.6, min: 0.1, max: 1 },
  // Per-frame size ceiling, enforced in live-session.js's sendVideoFrame. The
  // 2026-08-05 security review found nothing bounded a frame below ws's 100MB
  // default, so a direct WS caller could push arbitrarily large billed images at
  // the operator's own Gemini key. A 1280px-edge JPEG at quality 0.6 is a few
  // hundred KB, so 2MB is generous for the legitimate path and still a real cap.
  LIVE_SCREEN_MAX_FRAME_KB:    { type: 'number', default: 2048, min: 64, max: 16384 },
};

module.exports = { SCHEMA };
