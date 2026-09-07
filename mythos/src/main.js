'use strict';

// MYTHOS Phase 0 — boots clean, logs ALIVE, handles SIGINT exit 0

const path = require('path');
const { createLogger } = require('./core/logger');
const { installCrashHandlers } = require('./core/crash-handlers');
const { createBus } = require('./core/bus');
const { buildBindFailureAnomaly } = require('./core/aether/bind-failure');
const { loadConfig, SCHEMA } = require('./core/config');
const { createLifecycle } = require('./core/lifecycle');
const { createMemory } = require('./core/memory');
const { createBrain } = require('./core/brain');
const { createIdentity } = require('./core/identity');
const { seedBoundaries } = require('./core/identity/boundaries-seed');
const { createGoalSystem } = require('./core/goals');
const { createCortex } = require('./core/cortex');
const { createLeash } = require('./core/leash');
const { createCheckpointRegistry } = require('./core/leash/checkpoints');
const { createForge } = require('./core/effectors/forge');
const { createForgeRunner } = require('./core/effectors/forge-runner');
const { registerFromForge } = require('./core/effectors/from-forge');
const { createEngagementStore } = require('./core/engagements/store');
const { createEngagementManager } = require('./core/engagements');
const { createConversationGateway } = require('./core/assistant/gateway');
const { createTimerSensor } = require('./core/sensors/timer');
const { createReminderSensor } = require('./core/sensors/reminder-sensor');
const { createCalendarUpcomingSensor } = require('./core/sensors/calendar-upcoming-sensor');
const { createGmailSensor } = require('./core/sensors/gmail-sensor');
const { createScreenSensor } = require('./core/sensors/screen-sensor');
const { createWindowSensor } = require('./core/sensors/window-sensor');
const { createAetherSensor } = require('./core/sensors/aether');
const { createScannerProxy } = require('./core/aether/scanner-proxy');
const { createDailyPlanner } = require('./core/planner/daily');
const { createProbes } = require('./core/immune/probes');
const { createDiagnostician } = require('./core/immune/diagnostician');
const { createHealer } = require('./core/immune/healer');
const { createWatchdog } = require('./core/immune/watchdog');
const { createAnnouncer } = require('./core/immune/announcer');
const { createMonitor, recoverFromCrash } = require('./core/immune/monitor');
const { createMetricSensor } = require('./core/sensors/metric');
const { createEffectorHub } = require('./core/effectors/hub');
const { dispatchAction } = require('./core/effectors/dispatch-action');
const { createBuildRunner } = require('./core/effectors/build-runner');
const { createBuildEngine } = require('./core/effectors/build-engine');
const { createPipelineEffector } = require('./core/effectors/pipeline');
const { createRiskClassifier } = require('./core/effectors/risk-classifier');
const { createEvidenceValidator } = require('./core/effectors/evidence-validator');
const { createKanbanEffector } = require('./core/effectors/kanban');
const { createAgentActions } = require('./core/effectors/agent-actions');
const { createGoalsMdBridge } = require('./core/effectors/goals');
const { createEdgeTtsChild } = require('./core/effectors/edge-tts-child');
const { createPiperChild } = require('./core/effectors/piper-child');
const { createWebSearchChild } = require('./core/effectors/websearch-child');
const { registerFromComputer, allowedRoots, setOpenPathProvider } = require('./core/effectors/from-computer');
const { registerFromPc, KNOWN_DESKTOP_APPS } = require('./core/effectors/from-pc');
const { registerFromCua } = require('./core/effectors/from-cua');
const { registerFromAndroid } = require('./core/effectors/from-android');
const { registerFromBrowser, browser_launch_debug } = require('./core/effectors/from-browser');
const skillsLoader = require('./core/skills/loader');
const { registerFromDashboard } = require('./core/effectors/from-dashboard');
const { registerFromPersona } = require('./core/effectors/from-persona');
const { createReflection } = require('./core/identity/reflection');
const capabilities = require('./core/identity/capabilities');
const { createExplainer } = require('./core/immune/explainer');
const { registerFromDsh } = require('./core/effectors/from-dsh');
const { registerFromRunner } = require('./core/effectors/from-runner');
const { registerFromInstaller } = require('./core/effectors/from-installer');
const { registerFromMcp } = require('./core/effectors/from-mcp');
const { registerFromOkf } = require('./core/effectors/from-okf');
const { registerFromStrix } = require('./core/effectors/from-strix');
const { registerFromProject } = require('./core/effectors/from-project');
const { registerFromMission } = require('./core/effectors/from-mission');
const { registerFromSystem } = require('./core/effectors/from-system');
const { registerFromGmail } = require('./core/effectors/from-gmail');
const { registerFromMemory } = require('./core/effectors/from-memory');
const { registerFromCalendar } = require('./core/effectors/from-calendar');
const { registerFromSkills } = require('./core/effectors/from-skills');
const { registerFromSpotify } = require('./core/effectors/from-spotify');
const { registerFromWhatsapp } = require('./core/effectors/from-whatsapp');
const { registerFromAppReply } = require('./core/effectors/from-app-reply');
const { registerFromWidgets } = require('./core/effectors/from-widgets');
const { registerFromDocs } = require('./core/effectors/from-docs');
const { registerFromImageGen } = require('./core/effectors/from-image-gen');
const { registerFromDocuments } = require('./core/effectors/from-documents');
const { registerFromCodeSearch } = require('./core/effectors/from-code-search');
const { createPinLock } = require('./core/security/pin-lock');
const { createOrchestrator } = require('./core/effectors/orchestrator');
const { createFileSensor } = require('./core/sensors/file');
const { createWsSensor } = require('./core/sensors/ws');
const { createJobSensor } = require('./core/sensors/job');
const { createServer } = require('../server');
const fs = require('fs');
const browserAgent = require('../adapters/browser-agent');
const pcChild = require('../adapters/pc-child');
const cuaDriver = require('../adapters/cua-driver');
const androidChild = require('../adapters/android-child');

async function main() {
  // Step 0: .env (DEGRADED — missing .env is not fatal, config falls back to schema defaults)
  // REMEDIATION P0-1 (item 6): load by absolute path anchored to this file's
  // own location, not process.cwd() — process.loadEnvFile() with no argument
  // resolves relative to the CURRENT WORKING DIRECTORY, which silently misses
  // mythos/.env whenever MYTHOS is launched from anywhere other than the
  // mythos/ directory itself (a service, a shortcut, `node src/main.js` from
  // the repo root, etc.), degrading providers/adapters with no error.
  //
  // INSTALLER PARITY (operator, 2026-08-11): mythos/.env is excluded from
  // package.json build.files, so in the packaged .exe this load finds nothing
  // and ~140 keys fall to their schema defaults — the root cause behind all
  // four incidents logged on the freshly installed build (volume oscillation,
  // Tier-2 approval prompts, dead wake word, the wrong TTS voice). The remedy
  // is a second config source a packaged install CAN write:
  // core/config/settings-store.js. For config.json to be able to outrank .env,
  // loadConfig has to know which keys exist ONLY because of this load — so
  // snapshot the environment before it and diff afterwards. process.env still
  // ends up carrying .env exactly as before, so every direct process.env
  // reader elsewhere in the tree is untouched.
  const envKeysBeforeDotenv = new Set(Object.keys(process.env));
  try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch (_) {}
  const envFileKeys = new Set(Object.keys(process.env).filter((k) => !envKeysBeforeDotenv.has(k)));

  // Render / cloud injects PORT; promote it to MYTHOS_PORT if not explicitly set.
  if (!process.env.MYTHOS_PORT && process.env.PORT) process.env.MYTHOS_PORT = process.env.PORT;

  // Step 1: Config
  const configResult = loadConfig({ envFileKeys });
  if (!configResult.ok) {
    console.error('Config errors:', configResult.errors.join(', '));
    process.exit(1);
  }
  const config = configResult.config;

  // Boot cinematic (TTY-only cosmetic — no-op on pipes and under tests)
  await require('./core/boot-banner').print({ name: config.MYTHOS_NAME, port: config.MYTHOS_PORT });

  // Step 2: Logger
  const logger = createLogger(config.LOG_LEVEL);
  // BUG-308: armed here, immediately after the logger exists and BEFORE any
  // subsystem is built. Node already terminates this process on an escaped
  // promise rejection or an uncaught throw; until now it did so with no line
  // anywhere saying why. Order is the point — a net strung up at the end of boot
  // catches nothing thrown during boot, which is when a young process is most
  // likely to throw. See core/crash-handlers.js for why it exits rather than
  // carrying on.
  installCrashHandlers({ logger });
  logger.info('config.loaded', { name: config.MYTHOS_NAME, port: config.MYTHOS_PORT });
  // Started as early as there is a logger to report through, because the stall
  // being chased (see loop-lag.js) happened right after boot — a probe armed at
  // the END of boot would have missed the only window that matters. Silent on a
  // healthy run; not started under node --test, where an unref'd interval in
  // every boot-spawning test buys nothing.
  if (!process.env.NODE_TEST_CONTEXT) {
    require('./core/loop-lag').startLoopLagProbe({ logger });
  }

  // Step 3: Bus
  const bus = createBus({
    historySize: config.BUS_HISTORY_SIZE,
    maxDepth: 32,
    storm: { windowMs: 1000, maxPerWindow: config.BUS_STORM_MAX }
  });
  logger.info('bus.created', bus.stats());

  // The settings overlay reports itself ONCE, here, now that there is a bus to
  // report on. A key the operator typed into config.json that MYTHOS does not
  // recognise is otherwise the quietest possible failure: the file looks right,
  // the value is never applied, and nothing anywhere says so. Same for a file
  // that failed to parse — settings-store.js deliberately treats that as empty
  // rather than fatal, which is only defensible if it is also loud.
  if (configResult.settingsError) {
    logger.warn('config.settings.unreadable', { file: configResult.settingsFile, error: configResult.settingsError });
    bus.emit('health.anomaly', {
      kind: 'config-settings-unreadable',
      file: configResult.settingsFile,
      detail: configResult.settingsError,
    });
  }
  if (configResult.settingsUnknown.length || configResult.settingsDropped.length) {
    logger.warn('config.settings.ignored', {
      file: configResult.settingsFile,
      unknown: configResult.settingsUnknown,
      dropped: configResult.settingsDropped,
    });
    bus.emit('health.anomaly', {
      kind: 'config-settings-ignored',
      file: configResult.settingsFile,
      unknown: configResult.settingsUnknown,
      dropped: configResult.settingsDropped,
    });
  }
  logger.info('config.settings.loaded', {
    file: configResult.settingsFile,
    // Which layer won, counted. A packaged install reporting "config.json: 0"
    // is the parity failure this whole change exists to make visible.
    origins: Object.values(configResult.origins).reduce((acc, o) => {
      acc[o] = (acc[o] || 0) + 1;
      return acc;
    }, {}),
  });

  // 2026-08-20: a raised default that the machine never gets. BUG-274 T1 was
  // fixed in config/voice-defaults.js, shipped, recorded as done — and stayed
  // inert here for a day because this machine's .env carried the pre-fix chain,
  // and an explicit override beats a derived default silently. The counted
  // origins above could show "3 keys came from .env"; they could never show
  // WHICH key, or that its value was the one a fix had just replaced.
  //
  // Warn, not info: this is a fix that is not in effect. Both values are named
  // because "overridden" alone does not tell the operator whether theirs is the
  // stale one. No committed test can read a gitignored .env, so this log line is
  // the only place the override is observable — see
  // test/derived-default-override-visibility.test.js for the tracked-template
  // half and its stated limit.
  if (configResult.derivedOverridden && configResult.derivedOverridden.length > 0) {
    logger.warn('config.derived.overridden', { keys: configResult.derivedOverridden });
  }

  // Step 4: Ensure vault directories
  const vaultDirs = ['Episodic', 'Semantic', 'Skills', 'Identity', 'Audit', 'Checkpoints'];
  const vaultRoot = path.resolve(config.MYTHOS_VAULT_ROOT);
  for (let i = 0; i < vaultDirs.length; i++) {
    const dir = path.join(vaultRoot, vaultDirs[i]);
    fs.mkdirSync(dir, { recursive: true });
  }
  logger.info('vault.dirs.created', { root: vaultRoot, dirs: vaultDirs });

  // F4 (go-live proof plan): on a container platform without a mounted volume,
  // the vault directory is EPHEMERAL — every redeploy silently wipes
  // episodic/semantic/identity/audit data, and fs-store JSON/JSONL has no
  // other persistence. Render sets RENDER=true; Docker/OCI runtimes drop
  // /.dockerenv. Neither exists on a local desktop boot.
  //
  // The risk is specific to the vault resolving INSIDE the app's own
  // directory (the schema default ./vault -> /app/vault in the image, which
  // sits in the container's ephemeral writable layer). An explicit override
  // to a path outside the app dir — e.g. MYTHOS_VAULT_ROOT=/data/vault on a
  // mounted disk (render.yaml, B4) — is the operator's deliberate persistent
  // choice and must NOT be warned about. This keeps the warning honest for
  // the pre-disk Render config, any Docker run without a volume, and
  // disappears the moment the vault is pointed at real storage.
  //
  // This is a warning, not a gate: persist (volume), externalize (object
  // storage / DB) or accept ephemeral cloud memory as documented behavior is
  // the operator's decision — recorded in the roadmap, never decided by code.
  // Pinned by test/vault-ephemeral-warning.test.js.
  const inContainer = process.env.RENDER === 'true' || fs.existsSync('/.dockerenv');
  const appDir = path.join(__dirname, '..'); // mythos/ (WORKDIR /app in the image)
  const vaultRel = path.relative(appDir, vaultRoot);
  const vaultUnderAppDir = vaultRel !== '' && !vaultRel.startsWith('..') && !path.isAbsolute(vaultRel);
  if (inContainer && vaultUnderAppDir) {
    logger.warn('vault.ephemeral', {
      root: vaultRoot,
      risk: 'container-local disk is wiped on redeploy — mount a persistent volume (e.g. /data) or externalize the vault before relying on stored memory',
    });
  }

  // Step 5: Lifecycle
  const lifecycle = createLifecycle({ bus, logger, config });

  // Modules constructed by the boot steps below, closed over so shutdown can stop them
  let memory = null;
  let brain = null;
  let identity = null;
  let reflection = null;
  let immuneExplainer = null;
  let goals = null;
  let desktopRuntime = null;
  let effectors = null;
  let leash = null;
  let cortex = null;
  let timerSensor = null;
  let immune = null; // { probes, diagnostician, healer, watchdog, announcer, monitor }
  let metricSensor = null;
  let buildRunner = null;
  let buildEngine = null;
  let agentActionsEffector = null;
  let dashboardWiring = null;
  let fileSensor = null;
  let wsSensor = null;
  let jobSensor = null;
  let edgeTtsChild = null;
  let piperChild = null;
  let webSearchChild = null;
  let calendarWiring = null;
  let gmailUnread = null;         // bound fn — goes through the hub, wired to gmail-sensor in the 'sensors' step
  let serverHandle = null;        // BUG-111: hoisted so the later 'sensors' step can wire setGmailPollCountGetter
  let checkpoints = null;          // P22 checkpoint approval registry
  let forge = null;                // P22 Forge multi-file build pipeline
  let checkpointSweepTimer = null;
  let actionReflectTimer = null;   // Layer 4: autonomous reflectOnActions cadence (headless learning)
  let screenSensor = null;         // Phase 2 Jarvis upgrade — ambient screen awareness
  let windowSensor = null;         // V8 (Phase 4) — opt-in active-window perception
  let aetherSensor = null;         // Aether-BLE proximity-focus sensor (pull model)
  let scannerProxy = null;         // Voice Nodes — one loopback Aether scanner per phone
  let pcToolsWiring = null;        // from-pc.js's registerFromPc() return (holds setScreenSensorHandle)
  let mcpWiring = null;            // from-mcp.js's registerFromMcp() return (holds autostart/shutdown)
  let dailyPlanner = null;         // Phase 3 Jarvis upgrade — daily planning + accountability

  // Engagement Layer
  let engagementStore = null;
  let engagementManager = null;
  let conversationGateway = null;

  // Re-write vault/Identity/capabilities.md on demand. Assigned by the
  // 'capabilities-manifest' boot step once effectors/memory are wired; the
  // browser auto-connect/auto-launch callbacks (which settle async, after that
  // step) call it so the manifest reflects ONLINE the moment it happens instead
  // of the stale OFFLINE written at boot. No-op until assigned.
  let refreshCapabilities = function () {};

  // Real boot sequence — wires memory/brain/cortex/goals/sensors (already built)
  // so the entity actually runs its OODA loop end-to-end, not just in unit tests.
  // FAIL-FAST: a broken core module means the entity cannot safely run.
  // DEGRADED: best-effort — the entity should still boot if these are unavailable.
  lifecycle.setSteps([
    { name: 'config',     fn: function() { /* already loaded */ } },
    { name: 'logger',     fn: function() { /* already created */ } },
    { name: 'bus',        fn: function() { /* already created */ } },
    { name: 'vault-dirs', fn: function() { /* already ensured */ } },

    { name: 'memory', fn: async function() {
      brain = createBrain({ config, bus });
      memory = createMemory({ config, bus, logger, brain });
      await memory.init();
      logger.info('memory.ready', memory.stats());
    }},

    { name: 'immune', fail: 'fast', fn: function() {
      // [Phase 6 — NEW] Constructed before 'cortex'/'goals' exist (§13's boot order) —
      // healer/watchdog take getCortex()/getGoals() thunks closing over the `let
      // cortex`/`let goals` bindings above, filled in by their own later boot steps
      // (Phase 6, Ambiguity #1). Detection (watchdog) and remediation (healer) are
      // separate components so a stall is never restarted twice (Ambiguity #2).
      const probes = createProbes({ bus: bus, config: config });
      const diagnostician = createDiagnostician({ bus: bus });
      const healer = createHealer({
        bus: bus, config: config, memory: memory,
        getCortex: function() { return cortex; },
        getGoals: function() { return goals; },
        getEffectors: function() { return effectors; },
        // Wave 7 (2026-08-13): same getter-thunk pattern as getCortex/getGoals
        // above — healer boots before scannerProxy exists (§13 boot order),
        // so this closes over the `let scannerProxy` binding and reads
        // whatever it points to WHEN a retry actually fires, not at
        // construction time.
        getScannerProxy: function() { return scannerProxy; }
      });
      const watchdog = createWatchdog({ bus: bus, config: config, getCortex: function() { return cortex; } });
      const announcer = createAnnouncer({
        bus: bus, config: config,
        // Speech is NOT a hub effector — the old 'speak' effector was dead code and
        // was removed 2026-07-31 (see effectors/voice.js's header). This re-emits onto
        // 'action.speak-requested', which server/index.js subscribes to and feeds to
        // proactiveSpeak() -> providers/edge-tts.synthesize(). Never a silent no-op:
        // announcer.js requires a real speak() at construction.
        speak: function(text) { bus.emit('action.speak-requested', { text: text }); return Promise.resolve(); }
      });
      const monitor = createMonitor({ bus: bus, config: config, memory: memory });

      diagnostician.start();
      healer.start();
      announcer.start();
      monitor.start();

      immune = { probes: probes, diagnostician: diagnostician, healer: healer, watchdog: watchdog, announcer: announcer, monitor: monitor };
      logger.info('immune.ready', {});
    }},

    { name: 'brain-probe', fail: 'degraded', fn: function() {
      // Fire-and-forget with a timeout — boot never blocks on provider availability.
      // The guard timer is unref'd: it must never hold the process open on its own.
      const timeoutMs = 5000;
      Promise.race([
        brain.probe(),
        new Promise(function(resolve) {
          const t = setTimeout(resolve, timeoutMs);
          if (t.unref) t.unref();
        })
      ]).catch(function(err) {
        logger.warn('brain.probe.failed', { error: err.message });
      });
    }},

    { name: 'identity', fail: 'degraded', fn: async function() {
      // [Phase 8 — NEW: replaces the Phase 5 createIdentityStub() call site,
      // deleted wholesale above] identity/index.js needs memory.fs (raw file
      // access for boundaries.md) and memory.identity (the self.md store), so
      // it cannot be constructed before the 'memory' step — but 'memory'
      // itself constructs `brain` early (createBrain({config, bus}), no
      // identity yet) because memory's own consolidate() takes brain as a
      // constructor dependency. That's pre-existing architecture this phase
      // doesn't restructure. Persona injection is optional/cosmetic (Ambiguity
      // #5), so instead of moving brain's construction, we cheaply reconstruct
      // it here — a stateless factory, nothing held open on the old instance —
      // and reassign the closure variable so every step AFTER this one (goals,
      // leash, cortex) sees a brain wired with real persona injection. memory's
      // own internal `brain` reference (captured by value when createMemory()
      // ran) is unaffected and keeps working exactly as before.
      // Installer parity (2026-08-11): seed Identity/boundaries.md BEFORE
      // identity.init() reads it. A fresh install has no boundaries file, and
      // identity.init() used to treat absent as malformed — clamping the
      // autonomy ceiling to tier 1 so every Tier-2 tool asked for approval,
      // which is exactly what the operator's new install did while dev did not.
      // The seed writes the operator's OWN configured ceiling and never touches
      // an existing file; see core/identity/boundaries-seed.js for why the write
      // lives in its own module rather than in identity/ or memory/identity.js.
      const seeded = seedBoundaries({ fs: memory.fs, config, logger });
      if (seeded.status === 'failed') {
        // Not fatal. identity.init()'s absent-file branch still applies the
        // configured ceiling; the vault is just read-only for this file.
        logger.warn('identity.boundaries.seed-failed', { error: seeded.error });
      }
      identity = createIdentity({ bus, config, fs: memory.fs, identityStore: memory.identity });
      await identity.init();
      brain = createBrain({ config, bus, identity });
      // The effective autonomy ceiling and WHERE it came from, at boot, in the
      // log. leash/index.js takes the most restrictive of the two numbers below,
      // and nothing anywhere used to say what they were — so a ceiling silently
      // clamped to 1 looked exactly like MYTHOS being cautious.
      logger.info('identity.ready', {
        maxAutonomousTier: Math.min(config.AUTONOMOUS_MAX_TIER, identity.getMaxAutonomousTier()),
        configCeiling: config.AUTONOMOUS_MAX_TIER,
        boundariesCeiling: identity.getMaxAutonomousTier(),
        boundariesSource: identity.boundariesSource(),
      });
    }},

    { name: 'goals', fail: 'degraded', fn: async function() {
      goals = createGoalSystem({ fs: memory.fs, config, bus, memory, brain });
      await goals.init();
      logger.info('goals.ready', goals.stats());
    }},

    { name: 'leash', fn: function() {
      // [Phase 7 — NEW] Real effector hub + the full tool-effector set + the goals-effector
      // bridge + voice effector, built here (immediately before leash, which requires
      // it) rather than inline in the cortex step — createNullEffectors (Phase 5 stub)
      // is deleted wholesale, not patched, per its own header comment. Boot order stays
      // identity -> goals -> effectors -> leash -> cortex (Phase 5, Ambiguity #5)
      // because leash's constructor deps (identity, goals, effectors) must all exist
      // first. fail-fast: a Cortex with zero registered effectors is not a smaller
      // entity, it's a broken one (every decide() output would dead-end at
      // 'unknown-effector') — see Phase 7's Anti-Drift Checklist and Integration Points.
      var hub = createEffectorHub({ bus: bus, config: config });

      var riskClassifier = createRiskClassifier();
      // BUG-304: the gate needs the vault to confirm an artifact file exists
      // rather than trusting that its path is a non-empty string. memory.fs is
      // the same handle the two lines below already use.
      var evidenceValidator = createEvidenceValidator({ fs: memory.fs });
      var pipelineEffector = createPipelineEffector({ fs: memory.fs, classifier: riskClassifier });
      var kanbanEffector = createKanbanEffector({ fs: memory.fs, bus: bus });
      // Integration 3: build verifier (needs brain)
      var verifier = require('./core/design/verify').createVerifier({ brain: brain });
      // Single build-content engine (DeepSeek Harness). Passed to BOTH the build
      // runner and the engagement executor so the three formerly-independent
      // generators collapse to one. With buildEngine present, build-runner
      // never calls brain.think for content — there is no fallback by design
      // (see build-engine.js). brain is still passed for the verifier/review
      // machinery that legitimately uses it.
      buildEngine = createBuildEngine({ engine: require('../adapters/dsh-agent'), vault: memory.fs, bus: bus });
      // Refine loop (2026-08-14): renders the built artifact in real headless
      // Chrome, screenshots it, and critiques it through the vision lane before
      // it can be called done. CONSTRUCTED INSIDE the flag check on purpose —
      // an opt-out flag protects nothing that runs before it is read, which is
      // exactly how the cursor-overlay slice killed boot for everyone including
      // the operators who had it disabled. Absent refiner = feature off, and
      // build-runner records the skip on the job rather than hiding it.
      var buildRefiner = null;
      if (config.BUILD_REFINE_ENABLED) {
        buildRefiner = require('./core/effectors/build-refine').createBuildRefiner({
          vault: memory.fs, brain: brain, logger: logger,
        });
      }
      buildRunner = createBuildRunner({ config: config, brain: brain, bus: bus, vault: memory.fs, verifier: verifier, buildEngine: buildEngine, refiner: buildRefiner });

      // Integration 2 + 4: agent actions with design system + persona dispatch
      agentActionsEffector = createAgentActions({
        fs: memory.fs, pipeline: pipelineEffector, kanban: kanbanEffector,
        buildRunner: buildRunner,
        designSystem: true,  // Integration 2: enables design-system prompt injection
        brain: brain,  // P22: for visual verification + reviewer/reality-check
        // Content generation goes through the SAME single engine as build-runner.
        // Without this, the research-grounded regeneration and the review-retry
        // below silently fell back to brain.think and overwrote the engine's output
        // with it — see the comment at those call sites in agent-actions.js.
        buildEngine: buildEngine,
        webSearch: require('./core/effectors/web-search').web_search,  // P22: research gate
        webFetch: require('./core/effectors/web-fetch').web_fetch,     // P22: research gate
        browserAgent: browserAgent,  // P22: visual verification (render + screenshot)
        evidenceValidator: evidenceValidator,  // P23: external ship gate
        bus: bus,  // A4: research-skipped anomaly emission
      });

      // goals-effector: Goals.md <-> GoalSystem bridge (Spec Ambiguities #6), registered
      // under a named (non-tool, non-breaker-gated) service id — see hub.js's
      // registerNamed CROSS-PHASE FIX comment.
      var goalsBridge = createGoalsMdBridge({ fs: memory.fs, goalSystem: goals, bus: bus });
      // Reconcile Goals.md -> GoalSystem once at boot. A degraded result means
      // the bridge map was unreadable, so GoalSystem is NOT reconciled with
      // Goals.md for this process. Surfaced rather than dropped: the operator
      // watches the boot log, and a silent skip here looks identical to a
      // healthy boot while every goal mutation is a no-op.
      var goalsSync = goalsBridge.sync();
      if (goalsSync && goalsSync.degraded) {
        logger.warn('goals.bridge.degraded', { reason: 'bridge map unreadable — Goals.md not reconciled; goal mutations will not persist' });
      }
      hub.registerNamed('goals-effector', goalsBridge);
      // [Phase 9 — NEW] kanban/pipeline join goals-effector in the hub's
      // namedServices map (hub.js's own comment names all three as its purpose)
      // so the 'server' boot step below reaches them via effectors.get(name) —
      // named services, not tool effectors: no breaker, not counted in the 45.
      hub.registerNamed('kanban-effector', kanbanEffector);
      hub.registerNamed('pipeline-effector', pipelineEffector);

      // brain/config/logger are for think_deeply (effectors/deep-think.js) — the
      // only route from a conversation to the reasoning lane. Passing brain here
      // is load-bearing: without it think_deeply registers but can only decline.
      // Same wiring gap that left camera_look's brain null for weeks, so
      // test/think-deeply.test.js asserts this call keeps passing it.
      registerFromComputer(hub, { brain: brain, config: config, logger: logger });
      // config + logger are for screen_look's vision call (effectors/vision-call.js):
      // VISION_CALL_TIMEOUT_MS bounds it, and the logger is what emits the
      // `vision.call` provider/model/ms line that did not exist before 2026-08-10.
      pcToolsWiring = registerFromPc(hub, { brain: brain, fs: memory.fs, config: config, logger: logger });
      // CUA driver tools (cua_list_windows / cua_bring_to_front / cua_get_window_state
      // / cua_click) — the Chromium-capable click path that complements pc-child's
      // ui_click (which fails on apps exposing no named UIA leaf: Spotify, YouTube
      // web, Electron overlays). Each tool degrades to a clear {ok:false} when the
      // cua-driver binary is absent, so the brain falls back to pc-child honestly.
      registerFromCua(hub);
      registerFromAndroid(hub);
      registerFromSpotify(hub, { effectors: hub, bus: bus, memory: memory, goals: goals, config: config });
      // WhatsApp desktop. Needs memory.fs to read vault/Contacts/contacts.json,
      // so a contact name ("dad") can resolve to a number.
      registerFromWhatsapp(hub, { memory: memory, logger: logger });
      // WAVE 7 — reply into whatever chat app is already open, composing only.
      // Takes no collaborators: it reaches pc-child directly (like from-pc) and
      // reuses from-pc's ui_type so it inherits the Wave 2 read-back oracle.
      registerFromAppReply(hub);
      // REMEDIATION P1-7: fs (vault fs-store) added so browser_navigate can
      // existence-check a /vault/... path via the same resolver open_artifact
      // uses (vault-url.js), instead of forwarding it into a file:// URL.
      registerFromBrowser(hub, { config, fs: memory.fs, getBridge: () => desktopRuntime?.getBridge(), isDesktopTask: id => goals?.get(id)?.execution?.owner === 'desktop' });
      dashboardWiring = registerFromDashboard(hub, {
        goalsEffector: goalsBridge, pipeline: pipelineEffector, kanban: kanbanEffector,
        agentActions: agentActionsEffector, buildRunner: buildRunner,
        probes: immune.probes, config: config, fs: memory.fs, bus: bus,
        goals: goals, // BUG-113: raw GoalSystem — read_status surfaces open commitments
        logger: logger, // camera_look's `vision.call` instrumentation (vision-call.js)
        identity: identity, // A4: read_status surfaces current persona trait levels
        // Wave 5 (2026-08-13): camera_look's `var brain = (ctx && ctx.brain) || null`
        // was ALWAYS null — this key was simply never passed, unlike from-pc.js's
        // registerFromPc() call above which does pass it for screen_look. Reported
        // as "no vision brain" (sounding like lane exhaustion) but was a wiring
        // gap the whole time; NIM_API_KEY being present never mattered.
        brain: brain,
      });
      // Wire ask_agent dispatch — routes (seat, prompt) through brain.think so the
      // cortex autonomous loop, dashboard REST, AND voice can all delegate to subagents.
      // Previously setAskAgentDispatch was never called, so ask_agent always failed.
      if (dashboardWiring && typeof dashboardWiring.setAskAgentDispatch === 'function') {
        dashboardWiring.setAskAgentDispatch(async function(seat, prompt) {
          // lane 'reasoning' (2026-08-14): a delegated agent seat is asked to
          // think, not to format. It was on 'simple' — the trivial lane.
          var result = await brain.think({
            lane: 'reasoning',
            messages: [{ role: 'user', content: String(prompt || '') }],
            source: 'ask_agent:' + (seat || 'unknown'),
          });
          if (!result || result.offline) return 'Agent offline.';
          return result.content || (result.parsed ? JSON.stringify(result.parsed) : '');
        });
      }
      registerFromProject(hub, { pipeline: pipelineEffector, agentActions: agentActionsEffector });

      // Mission orchestrator: plan -> parallel builder agents -> synthesize.
      // Constructed here (needs buildRunner/kanban/agentActions/brain, all
      // just built); its bus 'mission.update' events are relayed by P9's
      // server as the 'mission' WS broadcast.
      var orchestrator = createOrchestrator({
        buildRunner: buildRunner, kanban: kanbanEffector, agentActions: agentActionsEffector,
        brain: brain, bus: bus, fs: memory.fs
      });
      orchestrator.init();
      registerFromMission(hub, { orchestrator: orchestrator });
      // Task B3 (code review FIX 1): system_status deliberately does NOT take
      // immune.probes here — probes.getStatus() emits health.anomaly/
      // health.healed on provider state transitions, which would let a T0
      // voice-invoked read trigger real healer.js remediation. It reads
      // brain/registry.js + quota.js directly instead (see from-system.js's
      // header); those, spend.getStats(), and the adapter ONLINE/OFFLINE
      // reads are all side-effect-free requires inside from-system.js itself.
      registerFromSystem(hub, { config: config });
      registerFromGmail(hub, { logger: logger });
      // Gmail triage sensor's bound fn — MUST go through the hub (breaker-gated),
      // never call the gmail adapter directly. Constructed here (next to hub) but
      // only started conditionally in the 'sensors' step below.
      // W3 (Phase 2 — Wiring Integrity): route through dispatchAction instead of raw
      // hub.invoke() so each gmail_unread poll writes an audit line + episodic entry
      // (gmail_unread is T1, auto-allow — audit-only, no new confirm gate). Same
      // return shape ({ok, result}) the gmail-sensor consumes, so the sensor is
      // unchanged. task-957 §24 W3.
      gmailUnread = function(args) {
        return dispatchAction(
          { tool: 'gmail_unread', args: args || {} },
          { effectors: hub, bus: bus, memory: memory, goals: goals, config: config,
            goalId: null, tier: 1, channel: 'gmail-sensor' }
        );
      };
      registerFromSkills(hub);
      registerFromMemory(hub, { semantic: memory.semantic, fs: memory.fs, identity: identity, memory: memory, notes: memory.notes });
      registerFromPersona(hub, { identity: identity });
      registerFromDsh(hub);
      // Phase 3 (V7): allow-listed shell runner for engagement/Forge verify-stages.
      // Fail-closed when RUN_COMMAND_ALLOWLIST is empty — honest-inert.
      registerFromRunner(hub, { vault: memory.fs, config: config });
      // install_from_github — clones a GitHub repo into vault/builds/installs and
      // runs its package manager, reporting every stage's real subprocess output.
      // Shares run_command's RUN_COMMAND_ALLOWLIST gate, so it is fail-closed too.
      registerFromInstaller(hub, { vault: memory.fs, config: config });
      // MCP transport — mcp_list_servers / mcp_list_tools / mcp_call_tool.
      // Fail-closed when MCP_SERVERS is empty (nothing spawned, tools report
      // disabled). Servers connect lazily on first use unless an entry sets
      // autostart, so registration here costs nothing on a machine with none
      // configured.
      mcpWiring = registerFromMcp(hub, { config: config, logger: logger });
      // Deliberately not awaited: a server that is slow to start, or not
      // installed at all, must never delay or fail boot. autostart() logs what
      // connected and what did not.
      mcpWiring.autostart().catch(function(err) {
        logger.warn('mcp.autostart-failed', { error: err && err.message });
      });
      // Open Knowledge Format import/export over vault/Knowledge. Pure data —
      // no dependency, no external process, nothing to degrade.
      registerFromOkf(hub, { vault: memory.fs });
      // Strix security scanning — optional (pip install strix-agent + Docker),
      // degrades to an install hint when absent. Refuses without a per-call
      // operator authorization; the config keys are the operator's own LLM.
      registerFromStrix(hub, { config: config, logger: logger });
      calendarWiring = registerFromCalendar(hub, { fs: memory.fs, bus: bus, goals: goals });
      registerFromWidgets(hub, { bus: bus });
      // Phase 2: document generation (xlsx/pptx/pdf), sandboxed to vault/builds/docs.
      registerFromDocs(hub, { vault: memory.fs });
      // §7.10 image generation — separate file from from-docs.js on purpose: that
      // file documents "no new network at runtime" and image-gen needs a real call.
      registerFromImageGen(hub, { vault: memory.fs });
      // §7.5 doc RAG + §7.11 code search — both read/write the SAME
      // memory.documents store + memory.documentsIndex vector partition.
      // brain is passed so document_answer (§7.5 RAG citations) can compose a
      // synthesized answer; it degrades to an extractive one when brain is
      // offline or absent (see from-documents.js's composeAnswer).
      registerFromDocuments(hub, { documents: memory.documents, documentsIndex: memory.documentsIndex, brain: brain });
      registerFromCodeSearch(hub, { documents: memory.documents, documentsIndex: memory.documentsIndex });

      // P22 Forge — multi-file agentic build pipeline + its checkpoint approval
      // registry. checkpoints needs memory.audit + goals (both exist by now).
      // Forge drives the build-engine adapter (via forge-runner.js) instead of
      // brain.think. The engine is INJECTED here rather than required inside the
      // runner (W6), so both build paths resolve the engine from one place.
      checkpoints = createCheckpointRegistry({ config: config, bus: bus, auditWriter: memory.audit, goals: goals, fs: memory.fs });
      checkpoints.init();
      checkpointSweepTimer = setInterval(function() { checkpoints.sweep(); }, config.CHECKPOINT_SWEEP_MS);
      if (checkpointSweepTimer.unref) checkpointSweepTimer.unref();
      const forgeRunner = createForgeRunner({ config: config, vault: memory.fs, engine: require('../adapters/dsh-agent') });
      forge = createForge({ config: config, runner: forgeRunner, bus: bus, vault: memory.fs, checkpoints: checkpoints });
      // A degraded init means the project-state file was unreadable, so Forge
      // loaded no history AND latched persistence off for this whole process —
      // builds still run but nothing is written to disk. That must be visible in
      // the boot log, not inferable only from a health.anomaly.
      var forgeInit = forge.init();
      if (forgeInit && forgeInit.degraded) {
        logger.warn('forge.state.degraded', { reason: 'project state unreadable — history not loaded and persistence suspended until restart' });
      }
      registerFromForge(hub, { forge: forge });

      effectors = hub;
      logger.info('effectors.ready', { count: effectors.count() });

      leash = createLeash({ bus, config, identity, auditWriter: memory.audit, goals, effectors, scanner: require('./core/effectors/credential-scanner').createCredentialScanner() });
      desktopRuntime = require('./core/desktop/runtime').createDesktopRuntime({ goals, effectors, leash, memory, config, bus, logger });
      logger.info('leash.ready', {});
    }},

    { name: 'engagement-store', fail: 'degraded', fn: async function() {
      // Engagement Layer: persistent store for engagement records
      engagementStore = createEngagementStore({ fs: memory.fs, config, bus });
      await engagementStore.init();
      logger.info('engagement-store.ready', {});
    }},

    { name: 'engagement-manager', fail: 'degraded', fn: function() {
      // Engagement Layer: manager orchestrates interview->spec->plan->execute->verify.
      // Phase 1: brain + checkpoints threaded in so the executor can drive
      // build/research stages via brain.think and park stage-level approvals
      // on the checkpoint registry (forge pattern). executor.init() re-arms
      // interrupted/AWAITING_STAGE_APPROVAL engagements from persisted state.
      engagementManager = createEngagementManager({
        bus, config, memory, goals, leash, effectors, engagementStore,
        brain: brain, checkpoints: checkpoints, buildEngine: buildEngine
      });
      try {
        var execInit = engagementManager && engagementManager.executor && engagementManager.executor.init();
        if (execInit) logger.info('engagement-executor.init', execInit);
      } catch (e) {
        logger.warn('engagement-executor.init-failed', { error: e.message });
      }
      logger.info('engagement-manager.ready', {});
    }},

    { name: 'conversation-gateway', fail: 'degraded', fn: function() {
      // Engagement Layer: gateway classifies intent and routes to engagement or cortex.
      // W5: `cortex` is `null` here — cortex is boot step 19, this is step 12. Pass a
      // getCortex thunk (same pattern as healer/watchdog in step 5) so the gateway's
      // cortex-fallback route resolves cortex lazily at first route() call, instead of
      // capturing null forever.
      conversationGateway = createConversationGateway({
        bus, config, engagementManager,
        getCortex: function() { return cortex; }
      });
      logger.info('conversation-gateway.ready', {});
    }},

    { name: 'engagement-immune-hooks', fail: 'degraded', fn: function() {
      // Engagement Layer: wire engagement manager to immune watchdog
      // Watchdog monitors for stuck engagements (engagement-stuck-interviewing, etc.)
      if (immune && immune.watchdog && engagementManager) {
        // Watchdog already monitors cortex; engagement hooks emit health.anomaly
        // which watchdog will pick up via bus subscription
        bus.emit('engagement.immune.hooks.registered', { ok: true });
      }
      logger.info('engagement-immune-hooks.ready', {});
    }},

    { name: 'recovery', fail: 'degraded', fn: function() {
      // [Phase 6 — NEW: supersedes the old inline checkpoint.load() logic] Full §10
      // Recovery algorithm — pauses goals active-at-crash and emits the audited
      // 'lifecycle.recovered' event (see immune/monitor.js's recoverFromCrash()).
      //
      // D-57 fix: this step used to run BEFORE 'leash', so buildRunner didn't exist
      // yet — recoverFromCrash() had no way to learn which build jobs got flipped to
      // 'failed' on this restart, even though buildRunner.init() already computes
      // exactly that list (build-runner.js's own recoveredJobs, populated at
      // construction). Moved after 'leash' (which constructs buildRunner) so recovery
      // can actually pass it through; recoverFromCrash() now awaits
      // buildRunner.init() and folds recoveredJobs.length into both the
      // 'lifecycle.recovered' payload and its own return value for observability.
      return recoverFromCrash({ bus: bus, config: config, memory: memory, goals: goals, buildRunner: buildRunner }).then(function(result) {
        logger.info('recovery.checked', result);
      });
    }},

    { name: 'server', fail: 'fast', fn: function() {
      // [Phase 9 — NEW] Express + WS v2 transport, positioned after 'effectors'/
      // 'leash' and before the cortex tick starts (§13 literal order). fail-fast:
      // an entity nobody can observe or confirm-gate is not a smaller entity.
      // Anti-drift #5: REST routes are gated only by presence at boot — a missing
      // P7 effector throws here at construction, never silently serves 404s.
      var goalsEffector = effectors.get('goals-effector');
      var kanbanEffector = effectors.get('kanban-effector');
      var pipelineEffector = effectors.get('pipeline-effector');
      if (!goalsEffector) throw new Error("server boot: effectors.get('goals-effector') missing — P7 must register the Goals.md bridge before P9 can serve /api/goals");
      if (!kanbanEffector) throw new Error("server boot: effectors.get('kanban-effector') missing — P7 must register it before P9 can serve /api/kanban");
      if (!pipelineEffector) throw new Error("server boot: effectors.get('pipeline-effector') missing — P7 must register it before P9 can serve /api/pipeline");

      // P4 Jarvis upgrade: the learning loop — extracts operator preferences +
      // speaking style from conversation episodics every ~15 turns and at
      // graceful shutdown. Best-effort: constructor deps all exist by now.
      reflection = createReflection({ brain: brain, memory: memory, identity: identity, config: config, logger: logger, bus: bus });

      // Learning loop (Layer 4): reflectOnActions was previously bound to the
      // VOICE turn path (noteTurn, called from server/index.js:1515). A purely
      // autonomous/headless session — no operator turns — never triggered it,
      // so failures during unattended goal pursuit were never distilled into
      // lessons. This timer fires the same pass on a wall-clock cadence so
      // headless runs learn too. Reuses REFLECTION_ACTION_EVERY_TURNS as the
      // cadence in MINUTES (default 30 → every 30min), mirroring the spirit of
      // the turn-based cadence. unref'd so it never keeps the process alive.
      var actionReflectMinutes = Math.max(5, Number((config && config.REFLECTION_ACTION_EVERY_TURNS) || 30));
      actionReflectTimer = setInterval(function () {
        if (!reflection || typeof reflection.reflectOnActions !== 'function') return;
        reflection.reflectOnActions('autonomous').catch(function (err) {
          logger.warn('reflection.autonomous.failed', { error: err && err.message });
        });
      }, actionReflectMinutes * 60 * 1000);
      if (actionReflectTimer.unref) actionReflectTimer.unref();

      // B2 (pre-context brain upgrade): live capability digest, read fresh on
      // every voice turn. Synchronous, in-memory reads only — no new awaits,
      // no new probes, same getStatus() calls the capabilities-manifest step
      // below already uses. providerCount is deliberately omitted: no
      // synchronous provider-registry count exists anywhere in this file
      // (brain/registry.js's getStatus() is async, and probing it here would
      // be exactly the new-async-call this digest must not introduce) —
      // capabilities.summaryDigest() already treats providerCount as optional.
      function getCapabilityDigest(opts) {
        var adapterOnline = {};
        try { adapterOnline['pc-child'] = pcChild.getStatus().state === 'ONLINE'; } catch (_) {}
        try { adapterOnline['cua-driver'] = cuaDriver.getStatus().state === 'ONLINE'; } catch (_) {}
        try { adapterOnline['android-child'] = androidChild.getStatus().state === 'ONLINE'; } catch (_) {}
        try { adapterOnline['browser-agent'] = browserAgent.getStatus().state === 'ONLINE'; } catch (_) {}
        return capabilities.summaryDigest({
          apps: KNOWN_DESKTOP_APPS,
          roots: allowedRoots(),
          adapters: adapterOnline,
          asOf: opts && opts.asOf,
        });
      }

      // §7.3 (step 5) — local PIN lock gate, separate from Task 6's
      // MYTHOS_AUTH_TOKEN (that gates network/remote access; this gates
      // local physical presence).
      var pinLock = createPinLock({ fs: memory.fs });

      // Voice Nodes (Stage 1) — stood up BEFORE createServer because the server
      // destructures deps once, and a phone can connect the moment /ws is open.
      // Deliberately boot-fatal on a bad id list rather than silently off: the
      // ids map to ports by position and must line up with the aggregator's
      // --peers, so "enabled but proxying nothing" would look healthy while
      // every reading vanished — the exact failure class this repo keeps paying
      // for. Same posture as the MYTHOS_BIND/AUTH_TOKEN boot guard.
      if (config.AETHER_PROXY_ENABLED) {
        scannerProxy = createScannerProxy({ config: config, logger: logger });
        scannerProxy.start();
        // Binding is async; whenReady() is what knows the ports are really
        // accepting. A bind failure (base range already in use) is reported
        // here rather than swallowed — the aggregator would otherwise just
        // retry a dead port every 2s forever with nothing explaining why.
        scannerProxy.whenReady().then(
          () => logger.info('aether.proxy.started', { ports: scannerProxy.ports() }),
          async (err) => {
            // scanner-proxy.js already tears down any sibling ports it opened
            // on a partial bind failure; stop() here is the documented way to
            // release this instance's own state, and is idempotent if it
            // already did so. Report via health.anomaly, not just the log
            // line, so this is visible the same way other boot-time failures
            // are — not swallowed.
            logger.error('aether.proxy.bind-failed', { error: err && err.message });
            // BUG-379: the payload is built in aether/bind-failure.js. It names WHICH
            // process holds the port - 65 vault records over 2026-08-08/09 never did -
            // and it fixes `target`, which could never name the port because ports()
            // returns an OBJECT and this tested `.length` on it (so the naming branch
            // was unreachable, and its .join() would have THROWN in this error handler
            // if it ever ran). Extracted rather than inlined because the file-size
            // ratchet refused main.js growing 1373 -> 1406, and it was right: a payload
            // builder with three failure modes belongs somewhere a test can call
            // without booting the application.
            const failedPorts = (function() {
              try { return Object.values(scannerProxy.ports() || {}); } catch (_) { return []; }
            })();
            scannerProxy.stop();
            bus.emit('health.anomaly', await buildBindFailureAnomaly({
              err: err, ports: failedPorts, portBase: config.AETHER_PROXY_PORT_BASE,
            }));
          }
        );
      }

      serverHandle = createServer({
        bus: bus, config: config, logger: logger, memory: memory,
        // Installer parity — which layer set each key, for /api/config/settings
        // and scripts/parity-check.js. See src/core/config/settings-store.js.
        configOrigins: configResult.origins,
        settingsFile: configResult.settingsFile,
        pinLock: pinLock,
        goalsEffector: goalsEffector,
        kanbanEffector: kanbanEffector,
        pipelineEffector: pipelineEffector,
        effectors: effectors, leash: leash, goals: goals, probes: immune.probes,
        brain: brain, buildRunner: buildRunner,
        agentActions: agentActionsEffector,
        checkpoints: checkpoints, forge: forge,
        reflection: reflection,
        engagementStore: engagementStore, engagementManager: engagementManager,
        conversationGateway: conversationGateway, desktopRuntime,
        getCapabilityDigest: getCapabilityDigest,
        identity: identity, // S2S (Phase 5) — buildLiveSystemInstruction()'s persona compose
        // Phase 2 (Aether): nearest-device audio sink — the aether sensor's
        // speak(), read at call time because the sensor starts in a later boot
        // step than the server. Resolves false (route off) when Aether is not
        // enabled or its socket is down, so the server fails open to local TTS.
        aetherSpeak: (text) => (aetherSensor && typeof aetherSensor.speak === 'function' ? aetherSensor.speak(text) : false),
        scannerProxy: scannerProxy, // Voice Nodes — null unless AETHER_PROXY_ENABLED
        // Stage 4 — ask Aether to arbitrate a wake. Read at call time for the
        // same reason as aetherSpeak: the sensor starts in a later boot step
        // than the server. Resolves false when Aether is off or its socket is
        // down, which the server degrades to "the device that heard it answers"
        // rather than going deaf.
        aetherRequestWake: () => (aetherSensor && typeof aetherSensor.requestWake === 'function' ? aetherSensor.requestWake() : false),
      });
      lifecycle.registerStopServer(serverHandle.stop); // shutdown step 0 (Ambiguity #5)
      // Wire camera_look — server-initiated frame capture from dashboard clients.
      if (dashboardWiring && typeof dashboardWiring.setCameraFrameProvider === 'function' && typeof serverHandle.requestCameraFrame === 'function') {
        dashboardWiring.setCameraFrameProvider(serverHandle.requestCameraFrame);
      }
      // camera_on — the confirm-gated opener for the camera camera_look reads
      // from. Same request/ack round-trip; unwired means camera_on says it cannot
      // reach a dashboard, which is the honest answer.
      if (dashboardWiring && typeof dashboardWiring.setCameraPowerProvider === 'function' && typeof serverHandle.requestCameraPower === 'function') {
        dashboardWiring.setCameraPowerProvider(serverHandle.requestCameraPower);
      }
      // REMEDIATION P1-5: wire close_panel — same server-initiated request/ack
      // round-trip pattern as camera_look above, so close_panel can report
      // what actually closed instead of a hardcoded closed:true.
      if (dashboardWiring && typeof dashboardWiring.setClosePanelProvider === 'function' && typeof serverHandle.requestClosePanel === 'function') {
        dashboardWiring.setClosePanelProvider(serverHandle.requestClosePanel);
      }
      // Stage 5 (BUG-075) — same wiring shape, for close_panel's Electron
      // media-window counterpart (electron/main.js's BrowserWindow, opened via
      // 'ui.open-web' relayed over the fork IPC channel).
      if (dashboardWiring && typeof dashboardWiring.setMediaWindowCloser === 'function' && typeof serverHandle.requestCloseMediaWindow === 'function') {
        dashboardWiring.setMediaWindowCloser(serverHandle.requestCloseMediaWindow);
      }
      // BUG-272 T2 — same wiring shape again, for open_web(browser:true). Left
      // unset outside the Electron shell, which is exactly what open_web needs in
      // order to say "there is no browser to hand this to" instead of reporting a
      // success nothing performed.
      if (dashboardWiring && typeof dashboardWiring.setExternalOpener === 'function' && typeof serverHandle.requestOpenExternal === 'function') {
        dashboardWiring.setExternalOpener(serverHandle.requestOpenExternal);
      }
      // 2026-08-21 — the same wiring shape for open_file. Wired HERE rather than
      // beside registerFromComputer() because serverHandle does not exist yet at
      // that point (it is created ~340 lines later); wiring it there would be a
      // call that silently never fires. Left unset outside the Electron shell on
      // purpose, so open_file reports the shell as absent instead of an open that
      // nothing performed.
      if (typeof setOpenPathProvider === 'function' && typeof serverHandle.requestOpenPath === 'function') {
        setOpenPathProvider(serverHandle.requestOpenPath);
      }
      // BUG-273 B3 — the same wiring shape once more, for the DASHBOARD half of
      // open_web. With this set, a widget that never mounts is a FAILURE instead of
      // an unverified success. Without it, open_web keeps saying "the dashboard has
      // not confirmed it rendered this", which is exactly what it always said.
      if (dashboardWiring && typeof dashboardWiring.setWidgetRenderer === 'function' && typeof serverHandle.requestWidgetRender === 'function') {
        dashboardWiring.setWidgetRenderer(serverHandle.requestWidgetRender);
      }
      logger.info('server.ready', { port: config.MYTHOS_PORT, bind: config.MYTHOS_BIND });
    }},

    { name: 'browser-automation', fail: 'degraded', fn: function() {
      desktopRuntime.start().catch(error => logger.warn('desktop.bridge-unavailable', { error: error.message }));
      // [Phase 9 — NEW] Browser automation via playwright-core. Tries CDP to an
      // already-running Chrome first, then launches Chrome/Edge locally as fallback.
      // Also starts the PC child (PowerShell automation daemon).
      if (config.BROWSER_AUTOMATION !== false) {
        // CDP connect only — no auto-launch here. Launching a real browser on
        // boot steals the mic/audio device on Windows, breaking voice input.
        browserAgent.connect(config.BROWSER_CDP_URL).then(function(ok) {
          var status = browserAgent.getStatus();
          if (ok) {
            logger.info('browser-automation.online', { mode: status.mode, pages: status.pageCount });
            refreshCapabilities();
          } else {
            logger.info('browser-automation.standby', { hint: 'CDP not connected — auto-connect poller + on-demand launch will bring it online' });
            // BUG-366, the actual fix: only the SUCCESS paths refreshed, so a
            // CONNECTING -> OFFLINE settle never reached the manifest.
            refreshCapabilities();
          }
        }).catch(function(err) {
          logger.warn('browser-automation.connect-failed', { error: err.message });
          // A thrown connect is also a settled outcome — the adapter has set
          // state OFFLINE and a hint by now, and the manifest must say so.
          refreshCapabilities();
        });

        // Auto-connect poller: attach the moment a debug Chrome appears (operator
        // ran setup-chrome-debug.ps1, started Chrome with --remote-debugging-port,
        // or the deferred launch below fired) and re-attach after an unexpected
        // drop — no manual "Connect". Connect-only, so no mic risk. Refreshes
        // capabilities.md on the OFFLINE->ONLINE transition. 0 disables it.
        browserAgent.startAutoConnect(config.BROWSER_CDP_URL, config.BROWSER_RECONNECT_MS, function() {
          var s = browserAgent.getStatus();
          logger.info('browser-automation.auto-connected', { mode: s.mode, pages: s.pageCount });
          refreshCapabilities();
        });

        // Opt-in fully hands-off launch: boot stays launch-free, but once voice/
        // mic init has claimed the audio device (delay below), launch a debug
        // Chrome so the adapter reaches ONLINE with zero manual steps. The
        // auto-connect poller keeps it attached afterwards; this timer only
        // bootstraps the first launch. Unref'd so it never holds the process up.
        if (config.BROWSER_AUTO_LAUNCH === true) {
          var launchTimer = setTimeout(function() {
            if (browserAgent.getStatus().state === 'ONLINE') return;
            logger.info('browser-automation.auto-launch', { delayMs: config.BROWSER_AUTO_LAUNCH_DELAY_MS });
            Promise.resolve(browser_launch_debug()).then(function(res) {
              if (res && res.ok) {
                var s = browserAgent.getStatus();
                logger.info('browser-automation.auto-launched', { mode: s.mode, pages: s.pageCount });
                refreshCapabilities();
              } else {
                logger.warn('browser-automation.auto-launch-failed', { reason: res && res.result });
              }
            }).catch(function(err) {
              logger.warn('browser-automation.auto-launch-failed', { error: err.message });
            });
          }, config.BROWSER_AUTO_LAUNCH_DELAY_MS);
          if (launchTimer.unref) launchTimer.unref();
        }
      }

      pcChild.startPcChild({ lateCompletionSink: (i) => bus.emit('health.anomaly', Object.assign({ kind: 'action-completed-after-timeout', adapter: 'pc-child', summary: 'action completed after its caller timed out - it may have executed twice if retried' }, i)) }); // BUG-335: see adapters/pc-child stale-response bell
      logger.info('pc-child.starting', {});

      // BUG-026 (4th attempt) part B — optional cua-driver adapter for the Spotify click path.
      // Degraded, not fatal: if the binary isn't installed, spawn ENOENT is caught
      // inside the adapter itself and getStatus() just stays OFFLINE forever, so
      // spotify_play() falls back to the existing UIA/keystroke path unchanged.
      cuaDriver.startCuaDriver();
      logger.info('cua-driver.starting', {});

      // Task 8 (step 6, Android bridge) — optional adb bridge. Degraded, not
      // fatal: startAndroidChild() itself never throws, and an absent adb
      // binary settles to OFFLINE with an install hint (AD-9) — every
      // phone_* tool then fails honestly instead of blocking boot.
      androidChild.startAndroidChild({
        adbBin: config.ANDROID_ADB_BIN, pollMs: config.ANDROID_ADB_POLL_MS, cmdTimeoutMs: config.ANDROID_CMD_TIMEOUT_MS,
      });
      logger.info('android-child.starting', {});

      // BUG-168: dsh-agent is the ONLY build-content engine (there is no
      // brain fallback by design), yet it was the one adapter nobody probed at
      // boot — it has no start*() of its own, so its first probe happened
      // inside the first build. A live session on 2026-08-07 therefore
      // discovered it was OFFLINE by watching six consecutive builds fail with
      // the same message, and the capability manifest ("what can you do")
      // claimed nothing was wrong the whole time. Probe once here, announce
      // the result, and let it into adapterStatuses() below. Never fatal and
      // never awaited: a slow probe must not hold boot.
      require('../adapters/dsh-agent').probe(true).then(function(online) {
        var s = require('../adapters/dsh-agent').getStatus();
        if (online) {
          // `evidence` rather than a bare "online": the probe runs dsh --version
          // and nothing else, so ONLINE from a version banner is not the same
          // claim as ONLINE from a completed build. A log that cannot tell those
          // two apart is how BUG-168's predecessor stayed invisible for six
          // consecutive failed builds.
          logger.info('dsh-agent.online', { version: s.version, evidence: s.evidence });
        } else {
          logger.warn('dsh-agent.offline', {
            hint: s.hint,
            probeDiagnostic: s.probeDiagnostic,
            impact: 'every build will fail — there is no brain fallback by design',
          });
        }
        if (refreshCapabilities) refreshCapabilities();
      }).catch(function(err) {
        logger.warn('dsh-agent.probe-failed', { error: err && err.message });
      });
    }},

    { name: 'capabilities-manifest', fail: 'degraded', fn: function() {
      // P5 Jarvis upgrade: regenerate vault/Identity/capabilities.md from the
      // live hub catalog + adapter states every boot — the entity's grounded
      // answer to "what can you do" / "what's new". Adapters spawn async just
      // above, so write once now (may show STARTING) and refresh once after
      // they settle.
      function writeIt() {
        try {
          capabilities.writeManifest(memory.fs, effectors, capabilities.collectAdapterStatuses());
        } catch (err) {
          logger.warn('capabilities-manifest.write-failed', { error: err.message });
        }
      }
      writeIt();
      // Expose the writer so the browser auto-connect/auto-launch callbacks (which
      // settle async, after this step) can re-write the manifest when the adapter
      // flips ONLINE — otherwise it keeps the stale OFFLINE line written here.
      refreshCapabilities = writeIt;
      // BUG-366: derived from the adapter's handshake timeout, never a second
      // copy of it. The audit blamed two literal 10000s racing; measurably not
      // the cause. Mechanism and evidence in BUGS.md — this file is at its
      // ratchet ceiling, so the explanation lives there.
      var SETTLE_HEADROOM_MS = 2000;
      var settleDelayMs = browserAgent.CONNECT_TIMEOUT_MS + SETTLE_HEADROOM_MS;
      var settleTimer = setTimeout(writeIt, settleDelayMs);
      if (settleTimer.unref) settleTimer.unref();
      logger.info('capabilities-manifest.written', { tools: effectors.count() });

      // Honest-degradation sweep (Phase 6): the skill-pack allowlist silently
      // dropped any pack that failed to resolve — a fresh clone only vendors
      // 5 of 16 allowlisted packs (mythos/skills/), the rest need ~/.zcode/skills/
      // and were missing with zero signal anywhere. Same boot pass as the
      // capabilities manifest, so the warning lands in the same place an
      // operator already looks for "what's actually available." refresh()
      // (not loadCatalog()) forces a real computation regardless of whether
      // an earlier boot step already warmed the module-level cache — the
      // missing-pack tracking only runs on an actual (non-cached) load.
      skillsLoader.refresh({ logger: logger });
    }},

    { name: 'immune-explainer', fail: 'degraded', fn: function() {
      // P6 Jarvis upgrade: plain-language explanation + safe-menu remedy for
      // anomalies no playbook matches, spoken via proactive speech. Pure bus
      // subscriber — no healer coupling.
      immuneExplainer = createExplainer({ bus: bus, brain: brain, memory: memory, config: config, logger: logger });
      immuneExplainer.start();
      logger.info('immune-explainer.ready', {});
    }},

    { name: 'cortex', fn: function() {
      // [Phase 5 — NEW: receives the real leash] [Phase 7 — NEW: receives the real
      // effector hub, replacing the Phase 5 null-effectors stub] Per the Phase 4.5
      // D-39 fix, createCortex throws at construction if either is missing.
      cortex = createCortex({ bus, memory, goals, brain, leash, effectors, config });
      cortex.start();
      // [Phase 6 — NEW] watchdog starts alongside cortex so lastTickAt is always fresh
      // once it begins polling.
      immune.watchdog.start();
      logger.info('cortex.started', { generation: cortex.generation });
    }},

    { name: 'sensors', fn: function() {
      // [Phase 7 — NEW] The bus -> working-memory perception bridge. Without this line
      // every sensor (this phase's and pre-existing) emits into the void (bus history
      // only) and Cortex's working.drainPerceptions() stays empty forever — Anti-Drift
      // Checklist item #12 / Integration Points table. fail-fast (no `fail` override):
      // a Cortex that never perceives anything is a broken entity, not a degraded one.
      bus.subscribe('perception.*', function(e) { memory.working.pushPerception(e.payload); });

      timerSensor = createTimerSensor({ bus, config });
      timerSensor.start();
      logger.info('sensors.timer.started', { intervalMs: config.MYTHOS_TICK_MS });

      // Calendar reminder sensor — polls fireDueReminders() every 30s so due
      // reminders emit 'reminder.due' on the bus for proactive speech.
      if (calendarWiring && calendarWiring.calendar) {
        var reminderSensor = createReminderSensor({
          calendar: calendarWiring.calendar, bus: bus,
          // Track B5 — fire-time dispatch of a reminder's action goes through
          // the SAME leash.check() -> dispatchAction() path as every other
          // action (AD-1/AD-2), never a raw effectors.invoke().
          leash: leash, goals: goals, effectors: effectors, memory: memory, config: config
        });
        reminderSensor.start();
        logger.info('sensors.reminder.started', {});

        // V8 (Phase 4): calendar upcoming-event perception sensor — emits
        // perception.calendar for events coming up within LEAD_MS so the
        // cortex OODA loop can act on them (distinct from reminder.due above
        // which fires for OVERDUE events straight to proactive speech).
        // ON by default (no privacy surface — reads only local reminders.json).
        if (config.CALENDAR_UPCOMING_ENABLED) {
          var calendarUpcomingSensor = createCalendarUpcomingSensor({
            calendar: calendarWiring.calendar, bus: bus, config: config, logger: logger
          });
          calendarUpcomingSensor.start();
          logger.info('sensors.calendar-upcoming.started', { leadMs: config.CALENDAR_UPCOMING_LEAD_MS });
        }
      }

      // Gmail unread triage sensor — polls gmail_unread via the hub so genuinely
      // new unread mail emits 'gmail.unread-batch' for proactive speech. Only
      // constructed when Gmail is actually configured AND triage is enabled AND
      // GMAIL_TRIAGE_MODE isn't 'off' — otherwise it would error-spam every poll
      // cycle hitting an unconfigured Gmail API (or simply never do anything).
      // BUG-111: GMAIL_TRIAGE_MODE ('boot-once' default / 'poll' / 'off') gates
      // the sensor's own recurring cadence — a stored `remember` note can't stop
      // a background timer, so this is a config decision, not a memory note.
      if (config.GOOGLE_REFRESH_TOKEN && config.GMAIL_TRIAGE_ENABLED && config.GMAIL_TRIAGE_MODE !== 'off') {
        var gmailSensor = createGmailSensor({
          gmailUnread: gmailUnread, bus: bus,
          pollMs: config.GMAIL_TRIAGE_POLL_MS, mode: config.GMAIL_TRIAGE_MODE
        });
        gmailSensor.start();
        logger.info('sensors.gmail.started', { mode: config.GMAIL_TRIAGE_MODE });
        // BUG-111: /api/status surfaces the real poll count so quota burn is
        // visible instead of inferred after the fact.
        if (serverHandle && typeof serverHandle.setGmailPollCountGetter === 'function') {
          serverHandle.setGmailPollCountGetter(gmailSensor.getPollCount);
        }
      }

      // [Phase 6 — NEW] metric sensor polls immune/probes.js every 4s and feeds
      // the cognitive OODA loop's perception queue.
      metricSensor = createMetricSensor({ bus, config, probes: immune.probes });
      metricSensor.start();
      logger.info('sensors.metric.started', {});

      // [Phase 2 Jarvis upgrade — NEW] ambient screen awareness: hash-gated
      // screen_look -> vision-description sensor. Opt-in (SCREEN_AWARENESS_ENABLED
      // defaults false) and only constructed when pc-child is present — otherwise
      // every poll would just be a silent no-op forever, which is honest but
      // pointless. The ambient_awareness voice tool (from-pc.js) can only flip a
      // sensor that was actually constructed here; when disabled at boot it
      // reports unavailable rather than throwing.
      if (config.SCREEN_AWARENESS_ENABLED && pcChild) {
        screenSensor = createScreenSensor({ bus: bus, config: config, brain: brain, pcChild: pcChild, logger: logger });
        screenSensor.start();
        if (pcToolsWiring && typeof pcToolsWiring.setScreenSensorHandle === 'function') {
          pcToolsWiring.setScreenSensorHandle(screenSensor);
        }
        logger.info('sensors.screen.started', { pollMs: config.SCREEN_AWARENESS_POLL_MS });
      }

      // V8 (Phase 4): opt-in active-window perception sensor. Mirrors the
      // screen-sensor gate (opt-in, default false — same privacy surface).
      // Reads the foreground window's app/title via pc-child 'active_window'
      // and emits perception.window for the OODA loop. Distinct from screen-
      // sensor: structured {app,title,pid} metadata, NOT vision captions.
      if (config.WINDOW_AWARENESS_ENABLED && pcChild) {
        windowSensor = createWindowSensor({ bus: bus, config: config, pcChild: pcChild, logger: logger });
        windowSensor.start();
        logger.info('sensors.window.started', { pollMs: config.WINDOW_AWARENESS_POLL_MS });
      }

      // Aether-BLE proximity-focus sensor — pulls the aggregator's election
      // broadcast (ws://127.0.0.1:8766) and emits perception.aether on
      // owner-change / RSSI drift. Opt-in; silent retry + zero impact when
      // Aether is absent. The existing perception.* relay forwards it to the
      // HUD "NEAREST DEVICE" widget automatically.
      if (config.AETHER_ENABLED) {
        aetherSensor = createAetherSensor({ bus: bus, config: config, logger: logger });
        aetherSensor.start();
        logger.info('sensors.aether.started', { url: config.AETHER_WS_URL });
      }

      // [Phase 7 — NEW] file/job sensors start immediately; ws sensor's start() is a
      // no-op until Phase 9 owns real connections, but it's still started so
      // isRunning()/stop() behave consistently through shutdown.
      // KNOWN ENVIRONMENT ISSUE (documented, not a code defect): on some Node/Windows
      // builds, an open fs.watch() handle interferes with OS signal delivery to this
      // process (verified with a zero-application-code minimal repro — an fs.watch()
      // handle alone, watching any directory, blocks child.kill('SIGINT'/'SIGTERM')
      // from ever reaching process.on() handlers). This can make test/boot.test.js's
      // graceful-SIGINT-shutdown check fail in that environment even though sensors/
      // file.js's own logic is correct and matches the spec's Full Code verbatim. Do
      // not "fix" this by removing fs.watch() or by weakening file.js's design — see
      // the Phase 7 build report for the full investigation.
      fileSensor = createFileSensor({ bus, config, vault: memory.fs });
      wsSensor = createWsSensor({ bus, config });
      jobSensor = createJobSensor({ bus, buildRunner: buildRunner });
      fileSensor.start();
      jobSensor.start();
      wsSensor.start();
      logger.info('sensors.file.started', {});
      logger.info('sensors.job.started', {});
      logger.info('sensors.ws.started', {});
    }},

    { name: 'planner', fail: 'degraded', fn: function() {
      // [Phase 3 Jarvis upgrade — NEW] daily planning + accountability: morning
      // brief / stall check-ins / evening review, layered on the existing
      // Goals system (goals.arbitrate/list are reused, never reimplemented).
      // Positioned after 'sensors' (needs goals+brain+memory, all ready by
      // now). Degraded, not fatal: a missing planner is a smaller entity, not
      // a broken one. Always constructed (so the daily_plan tool's status/
      // replan/skip_today work even with the automatic scheduler off) — only
      // start() (the scheduler) is gated by PLANNER_ENABLED, mirroring how
      // the 'sensors' step above gates screenSensor.start() on
      // SCREEN_AWARENESS_ENABLED.
      dailyPlanner = createDailyPlanner({ bus: bus, config: config, memory: memory, goals: goals, brain: brain, identity: identity, logger: logger });
      if (config.PLANNER_ENABLED !== false) {
        dailyPlanner.start();
      }
      if (dashboardWiring && typeof dashboardWiring.setPlannerHandle === 'function') {
        dashboardWiring.setPlannerHandle(dailyPlanner);
      }
      logger.info('planner.ready', { enabled: config.PLANNER_ENABLED !== false });
    }},

    { name: 'edge-tts', fail: 'degraded', fn: function() {
      // Local Microsoft Neural TTS service (free, no key) — voice replies get
      // synthesized server-side (server/index.js handleUtterance) and shipped
      // to the browser as base64 mp3. Degraded: missing python/module just
      // means the client falls back to browser speechSynthesis.
      edgeTtsChild = createEdgeTtsChild({ logger: logger });
      edgeTtsChild.start();
    }},

    { name: 'piper', fail: 'degraded', fn: function() {
      // Local Piper TTS — fully offline (no API, no key, proven with sockets
      // blocked), ~350ms/sentence, and the only TTS engine here that is licensed
      // for a product that is sold. Degraded by design: no python, no piper
      // module or an empty mythos/models/piper just means this entry of
      // VOICE_TTS_CHAIN reports unavailable and the chain uses the next one.
      piperChild = createPiperChild({ logger: logger, config: config });
      piperChild.start();
    }},

    { name: 'websearch', fail: 'degraded', fn: function() {
      // Local open-webSearch daemon — the only keyless provider in the web_search
      // chain that still works. Started here rather than left to the operator
      // because BUG-280 shipped the rung, documented the launch in a comment, and
      // search then answered every query from Wikipedia for a day: the daemon was
      // never running on the machine that needed it. Degraded by design — not
      // installed means the rung reports the refused connection and the chain
      // carries on to the keyed providers.
      webSearchChild = createWebSearchChild({ logger: logger, config: config });
      webSearchChild.start();
    }}
  ]);

  // Stop running loops — step 1 of the D-07 coordinated shutdown sequence
  // (registered below via lifecycle.registerShutdownStep, run after server-close).
  function stopRunningLoops() {
    desktopRuntime?.stop().catch(error => logger.warn('desktop.stop-failed', { error: error.message }));
    if (checkpointSweepTimer) clearInterval(checkpointSweepTimer);
    if (actionReflectTimer) clearInterval(actionReflectTimer);
    pcChild.shutdownPcChild();
    cuaDriver.shutdownCuaDriver();
    androidChild.shutdownAndroidChild();
    browserAgent.stopAutoConnect();  // stop the poller before disconnect so it can't re-attach mid-shutdown
    browserAgent.disconnect();
    // MCP servers are real OS child processes MYTHOS spawned. Not closing them
    // leaves an orphan holding a browser or a filesystem session open after
    // MYTHOS is gone — the BUG-029 failure mode. Fire-and-forget: this step is
    // synchronous, and close() is best-effort by contract.
    if (mcpWiring && mcpWiring.shutdown) { try { mcpWiring.shutdown(); } catch (_) { /* best-effort */ } }
    if (edgeTtsChild) edgeTtsChild.stop();
    if (piperChild) piperChild.stop();
    if (webSearchChild) webSearchChild.stop();
    if (timerSensor) timerSensor.stop();
    if (metricSensor) metricSensor.stop();
    if (screenSensor) screenSensor.stop();
    if (aetherSensor) aetherSensor.stop();   // closes WS client + clears reconnect timer
    if (scannerProxy) scannerProxy.stop();   // closes each per-node WS server + its timers
    if (dailyPlanner) dailyPlanner.stop();
    if (fileSensor) fileSensor.stop();
    if (wsSensor) wsSensor.stop();
    if (jobSensor) jobSensor.stop();
    if (immuneExplainer) immuneExplainer.stop();
    if (cortex) cortex.stop();
    if (immune) {
      immune.watchdog.stop();
      immune.diagnostician.stop();
      immune.healer.stop();
      immune.announcer.stop();
      immune.monitor.stop();
    }
  }

  // D-07: full graceful shutdown sequence — server-close (step 0, registered
  // separately via registerStopServer above) -> stop-loops -> episodic-flush
  // -> checkpoint-write -> audit-flush -> exit 0, with SHUTDOWN_MS as the
  // hard-exit(1) backstop if any step hangs. `memory` is closure-captured
  // here (same pattern stopRunningLoops relies on for cortex/immune/etc.) and
  // is populated by the 'memory' boot step before lifecycle.boot() resolves.
  lifecycle.registerShutdownStep('stop-loops', stopRunningLoops);
  lifecycle.registerShutdownStep('reflection-final-pass', function() {
    // P4: one last learning pass over the session's conversations. Bounded by
    // the brain's own timeouts; skips silently when brain is offline.
    if (reflection) return reflection.runNow('shutdown');
  });
  lifecycle.registerShutdownStep('episodic-flush', function() {
    if (memory) return memory.working.flushToEpisodic();
  });
  lifecycle.registerShutdownStep('checkpoint-write', function() {
    if (memory) return memory.checkpoints.save(memory.working.snapshot());
  });
  lifecycle.registerShutdownStep('audit-flush', function() {
    if (memory) return memory.audit.write({ tool: 'lifecycle', tier: 0, decision: 'shutdown', outcome: 'ok' });
  });

  // Register signal handlers — the ONE path that drives shutdown on SIGINT/SIGTERM
  // (stopRunningLoops is no longer hooked to process.on() directly; it runs as the
  // 'stop-loops' step above, coordinated through this same sequence).
  lifecycle.registerShutdown();

  // Boot
  await lifecycle.boot();
  logger.info('MYTHOS ALIVE', { name: config.MYTHOS_NAME, port: config.MYTHOS_PORT, pid: process.pid });

  // Keep process alive — cortex's tick interval and the timer sensor's interval
  // are both unref'd, so we need something to hold the event loop open.
  return new Promise(function() { /* never resolves — process stays up */ });
}

main().catch(function(err) {
  console.error('Fatal:', err.message);
  process.exit(1);
});
