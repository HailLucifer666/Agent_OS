'use strict';

// MYTHOS Phase 0 — boots clean, logs ALIVE, handles SIGINT exit 0

const path = require('path');
const { createLogger } = require('./core/logger');
const { createBus } = require('./core/bus');
const { loadConfig, SCHEMA } = require('./core/config');
const { createLifecycle } = require('./core/lifecycle');
const { createMemory } = require('./core/memory');
const { createBrain } = require('./core/brain');
const { createIdentity } = require('./core/identity');
const { createGoalSystem } = require('./core/goals');
const { createCortex } = require('./core/cortex');
const { createLeash } = require('./core/leash');
const { createCheckpointRegistry } = require('./core/leash/checkpoints');
const { createForge } = require('./core/effectors/forge');
const { registerFromForge } = require('./core/effectors/from-forge');
const { createEngagementStore } = require('./core/engagements/store');
const { createEngagementManager } = require('./core/engagements');
const { createConversationGateway } = require('./core/assistant/gateway');
const { createTimerSensor } = require('./core/sensors/timer');
const { createReminderSensor } = require('./core/sensors/reminder-sensor');
const { createGmailSensor } = require('./core/sensors/gmail-sensor');
const { createScreenSensor } = require('./core/sensors/screen-sensor');
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
const { createPipelineEffector } = require('./core/effectors/pipeline');
const { createRiskClassifier } = require('./core/effectors/risk-classifier');
const { createEvidenceValidator } = require('./core/effectors/evidence-validator');
const { createKanbanEffector } = require('./core/effectors/kanban');
const { createAgentActions } = require('./core/effectors/agent-actions');
const { createGoalsMdBridge } = require('./core/effectors/goals');
const { createVoiceEffector } = require('./core/effectors/voice');
const { createEdgeTtsChild } = require('./core/effectors/edge-tts-child');
const { registerFromComputer } = require('./core/effectors/from-computer');
const { registerFromPc } = require('./core/effectors/from-pc');
const { registerFromBrowser } = require('./core/effectors/from-browser');
const skillsLoader = require('./core/skills/loader');
const { registerFromDashboard } = require('./core/effectors/from-dashboard');
const { registerFromPersona } = require('./core/effectors/from-persona');
const { createReflection } = require('./core/identity/reflection');
const capabilities = require('./core/identity/capabilities');
const { createExplainer } = require('./core/immune/explainer');
const { registerFromHermes } = require('./core/effectors/from-hermes');
const { registerFromRunner } = require('./core/effectors/from-runner');
const { registerFromProject } = require('./core/effectors/from-project');
const { registerFromMission } = require('./core/effectors/from-mission');
const { registerFromSystem } = require('./core/effectors/from-system');
const { registerFromGmail } = require('./core/effectors/from-gmail');
const { registerFromMemory } = require('./core/effectors/from-memory');
const { registerFromCalendar } = require('./core/effectors/from-calendar');
const { registerFromSkills } = require('./core/effectors/from-skills');
const { registerFromSpotify } = require('./core/effectors/from-spotify');
const { registerFromWidgets } = require('./core/effectors/from-widgets');
const { registerFromDocs } = require('./core/effectors/from-docs');
const { createOrchestrator } = require('./core/effectors/orchestrator');
const abtop = require('./core/effectors/collectors/abtop');
const { createFileSensor } = require('./core/sensors/file');
const { createWsSensor } = require('./core/sensors/ws');
const { createJobSensor } = require('./core/sensors/job');
const { createServer } = require('../server');
const fs = require('fs');
const browserAgent = require('../adapters/browser-agent');
const pcChild = require('../adapters/pc-child');
const cuaDriver = require('../adapters/cua-driver');

async function main() {
  // Step 0: .env (DEGRADED — missing .env is not fatal, config falls back to schema defaults)
  require('dotenv').config();

  // Render / cloud injects PORT; promote it to MYTHOS_PORT if not explicitly set.
  if (!process.env.MYTHOS_PORT && process.env.PORT) process.env.MYTHOS_PORT = process.env.PORT;

  // Step 1: Config
  const configResult = loadConfig();
  if (!configResult.ok) {
    console.error('Config errors:', configResult.errors.join(', '));
    process.exit(1);
  }
  const config = configResult.config;

  // Boot cinematic (TTY-only cosmetic — no-op on pipes and under tests)
  await require('./core/boot-banner').print({ name: config.MYTHOS_NAME, port: config.MYTHOS_PORT });

  // Step 2: Logger
  const logger = createLogger(config.LOG_LEVEL);
  logger.info('config.loaded', { name: config.MYTHOS_NAME, port: config.MYTHOS_PORT });

  // Step 3: Bus
  const bus = createBus({
    historySize: config.BUS_HISTORY_SIZE,
    maxDepth: 32,
    storm: { windowMs: 1000, maxPerWindow: config.BUS_STORM_MAX }
  });
  logger.info('bus.created', bus.stats());

  // Step 4: Ensure vault directories
  const vaultDirs = ['Episodic', 'Semantic', 'Skills', 'Identity', 'Audit', 'Checkpoints'];
  const vaultRoot = path.resolve(config.MYTHOS_VAULT_ROOT);
  for (let i = 0; i < vaultDirs.length; i++) {
    const dir = path.join(vaultRoot, vaultDirs[i]);
    fs.mkdirSync(dir, { recursive: true });
  }
  logger.info('vault.dirs.created', { root: vaultRoot, dirs: vaultDirs });

  // Step 5: Lifecycle
  const lifecycle = createLifecycle({ bus, logger, config });

  // Modules constructed by the boot steps below, closed over so shutdown can stop them
  let memory = null;
  let brain = null;
  let identity = null;
  let reflection = null;
  let immuneExplainer = null;
  let goals = null;
  let effectors = null;
  let leash = null;
  let cortex = null;
  let timerSensor = null;
  let immune = null; // { probes, diagnostician, healer, watchdog, announcer, monitor }
  let metricSensor = null;
  let buildRunner = null;
  let agentActionsEffector = null;
  let dashboardWiring = null;
  let fileSensor = null;
  let wsSensor = null;
  let jobSensor = null;
  let edgeTtsChild = null;
  let calendarWiring = null;
  let gmailUnread = null;         // bound fn — goes through the hub, wired to gmail-sensor in the 'sensors' step
  let checkpoints = null;          // P22 checkpoint approval registry
  let forge = null;                // P22 Forge multi-file build pipeline
  let checkpointSweepTimer = null;
  let screenSensor = null;         // Phase 2 Jarvis upgrade — ambient screen awareness
  let pcToolsWiring = null;        // from-pc.js's registerFromPc() return (holds setScreenSensorHandle)
  let dailyPlanner = null;         // Phase 3 Jarvis upgrade — daily planning + accountability

  // Engagement Layer
  let engagementStore = null;
  let engagementManager = null;
  let conversationGateway = null;

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
        getGoals: function() { return goals; }
      });
      const watchdog = createWatchdog({ bus: bus, config: config, getCortex: function() { return cortex; } });
      const announcer = createAnnouncer({
        bus: bus, config: config,
        // The 'speak' voice effector (Phase 7) is dispatched through Cortex's normal
        // effectors.invoke() path, not called directly from here — never a silent
        // no-op. Re-emits onto the 'action' channel for any future direct listener.
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
      identity = createIdentity({ bus, config, fs: memory.fs, identityStore: memory.identity });
      await identity.init();
      brain = createBrain({ config, bus, identity });
      logger.info('identity.ready', {});
    }},

    { name: 'goals', fail: 'degraded', fn: async function() {
      goals = createGoalSystem({ fs: memory.fs, config, bus, memory, brain });
      await goals.init();
      logger.info('goals.ready', goals.stats());
    }},

    { name: 'leash', fn: function() {
      // [Phase 7 — NEW] Real effector hub + all 45 tool effectors + the goals-effector
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
      var evidenceValidator = createEvidenceValidator();
      var pipelineEffector = createPipelineEffector({ fs: memory.fs, classifier: riskClassifier });
      var kanbanEffector = createKanbanEffector({ fs: memory.fs });
      // Integration 3: build verifier (needs brain)
      var verifier = require('./core/design/verify').createVerifier({ brain: brain });
      buildRunner = createBuildRunner({ config: config, brain: brain, bus: bus, vault: memory.fs, verifier: verifier });

      // Integration 2 + 4: agent actions with design system + persona dispatch
      agentActionsEffector = createAgentActions({
        fs: memory.fs, pipeline: pipelineEffector, kanban: kanbanEffector,
        buildRunner: buildRunner,
        designSystem: true,  // Integration 2: enables design-system prompt injection
        brain: brain,  // P22: for visual verification + reviewer/reality-check
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
      goalsBridge.sync();  // reconcile Goals.md -> GoalSystem once at boot
      hub.registerNamed('goals-effector', goalsBridge);
      // [Phase 9 — NEW] kanban/pipeline join goals-effector in the hub's
      // namedServices map (hub.js's own comment names all three as its purpose)
      // so the 'server' boot step below reaches them via effectors.get(name) —
      // named services, not tool effectors: no breaker, not counted in the 45.
      hub.registerNamed('kanban-effector', kanbanEffector);
      hub.registerNamed('pipeline-effector', pipelineEffector);

      // NOTE: abtop.start() (the optional NOVA agent-CLI-session poller behind
      // monitor_snapshot/kill_session) is deliberately NOT started here. In NOVA it was
      // started by server.js, i.e. whatever owns the dashboard surface — a role Phase 9
      // takes on in MYTHOS, not main.js's headless boot sequence. Starting it here was
      // tried and reverted: it spawns a shell-wrapped child process (`spawn(..., {shell:
      // true})`) that changes how Windows delivers console signals to the whole process
      // group, breaking graceful SIGINT shutdown (verified via test/boot.test.js — see
      // git history). Until Phase 9 calls abtop.start() itself, the two tools stay
      // honest-inert (abtop.getState() reports enabled:false), which is correct: there
      // is no dashboard process to monitor CLI sessions for yet.
      registerFromComputer(hub);
      pcToolsWiring = registerFromPc(hub, { brain: brain, fs: memory.fs });
      registerFromSpotify(hub, { effectors: hub, bus: bus, memory: memory, goals: goals, config: config });
      registerFromBrowser(hub, { config: config });
      dashboardWiring = registerFromDashboard(hub, {
        goalsEffector: goalsBridge, pipeline: pipelineEffector, kanban: kanbanEffector,
        agentActions: agentActionsEffector, buildRunner: buildRunner,
        probes: immune.probes, abtop: abtop, config: config, fs: memory.fs, bus: bus
      });
      // Wire ask_agent dispatch — routes (seat, prompt) through brain.think so the
      // cortex autonomous loop, dashboard REST, AND voice can all delegate to subagents.
      // Previously setAskAgentDispatch was never called, so ask_agent always failed.
      if (dashboardWiring && typeof dashboardWiring.setAskAgentDispatch === 'function') {
        dashboardWiring.setAskAgentDispatch(async function(seat, prompt) {
          var result = await brain.think({
            lane: 'simple',
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
      registerFromMemory(hub, { semantic: memory.semantic, fs: memory.fs, identity: identity, memory: memory });
      registerFromPersona(hub, { identity: identity });
      registerFromHermes(hub);
      // Phase 3 (V7): allow-listed shell runner for engagement/Forge verify-stages.
      // Fail-closed when RUN_COMMAND_ALLOWLIST is empty — honest-inert.
      registerFromRunner(hub, { vault: memory.fs, config: config });
      calendarWiring = registerFromCalendar(hub, { fs: memory.fs, bus: bus });
      registerFromWidgets(hub, { bus: bus });
      // Phase 2: document generation (xlsx/pptx/pdf), sandboxed to vault/builds/docs.
      registerFromDocs(hub, { vault: memory.fs });

      // P22 Forge — multi-file agentic build pipeline + its checkpoint approval
      // registry. checkpoints needs memory.audit + goals (both exist by now); forge
      // drives brain.think({lane:'build'}) and writes files under vault/builds/projects.
      checkpoints = createCheckpointRegistry({ config: config, bus: bus, auditWriter: memory.audit, goals: goals, fs: memory.fs });
      checkpoints.init();
      checkpointSweepTimer = setInterval(function() { checkpoints.sweep(); }, config.CHECKPOINT_SWEEP_MS);
      if (checkpointSweepTimer.unref) checkpointSweepTimer.unref();
      forge = createForge({ config: config, brain: brain, bus: bus, vault: memory.fs, checkpoints: checkpoints });
      forge.init();
      registerFromForge(hub, { forge: forge });

      hub.register(createVoiceEffector({ config: config }));

      effectors = hub;
      logger.info('effectors.ready', { count: effectors.count() });

      leash = createLeash({ bus, config, identity, auditWriter: memory.audit, goals, effectors, scanner: require('./core/effectors/credential-scanner').createCredentialScanner() });
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
        brain: brain, checkpoints: checkpoints
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
      reflection = createReflection({ brain: brain, memory: memory, identity: identity, config: config, logger: logger });

      var serverHandle = createServer({
        bus: bus, config: config, logger: logger, memory: memory,
        goalsEffector: goalsEffector,
        kanbanEffector: kanbanEffector,
        pipelineEffector: pipelineEffector,
        effectors: effectors, leash: leash, goals: goals, probes: immune.probes,
        brain: brain, buildRunner: buildRunner,
        agentActions: agentActionsEffector,
        checkpoints: checkpoints, forge: forge,
        reflection: reflection,
        engagementStore: engagementStore, engagementManager: engagementManager,
        conversationGateway: conversationGateway,
      });
      lifecycle.registerStopServer(serverHandle.stop); // shutdown step 0 (Ambiguity #5)
      // Wire camera_look — server-initiated frame capture from dashboard clients.
      if (dashboardWiring && typeof dashboardWiring.setCameraFrameProvider === 'function' && typeof serverHandle.requestCameraFrame === 'function') {
        dashboardWiring.setCameraFrameProvider(serverHandle.requestCameraFrame);
      }
      logger.info('server.ready', { port: config.MYTHOS_PORT, bind: config.MYTHOS_BIND });
    }},

    { name: 'browser-automation', fail: 'degraded', fn: function() {
      // [Phase 9 — NEW] Browser automation via playwright-core. Tries CDP to an
      // already-running Chrome first, then launches Chrome/Edge locally as fallback.
      // Also starts the PC child (PowerShell automation daemon).
      if (config.BROWSER_AUTOMATION !== false) {
        // CDP connect only — no auto-launch. Launching a real browser on boot
        // steals the mic/audio device on Windows, breaking voice input. Browser
        // launches on-demand when tools actually need it.
        browserAgent.connect(config.BROWSER_CDP_URL).then(function(ok) {
          var status = browserAgent.getStatus();
          if (ok) {
            logger.info('browser-automation.online', { mode: status.mode, pages: status.pageCount });
          } else {
            logger.info('browser-automation.standby', { hint: 'CDP not connected — browser will launch on demand' });
          }
        }).catch(function(err) {
          logger.warn('browser-automation.connect-failed', { error: err.message });
        });
      }

      // Start PC child (PowerShell automation daemon) for desktop control tools.
      pcChild.startPcChild();
      logger.info('pc-child.starting', {});

      // BUG-026 (4th attempt) part B — optional cua-driver adapter for the Spotify click path.
      // Degraded, not fatal: if the binary isn't installed, spawn ENOENT is caught
      // inside the adapter itself and getStatus() just stays OFFLINE forever, so
      // spotify_play() falls back to the existing UIA/keystroke path unchanged.
      cuaDriver.startCuaDriver();
      logger.info('cua-driver.starting', {});
    }},

    { name: 'capabilities-manifest', fail: 'degraded', fn: function() {
      // P5 Jarvis upgrade: regenerate vault/Identity/capabilities.md from the
      // live hub catalog + adapter states every boot — the entity's grounded
      // answer to "what can you do" / "what's new". Adapters spawn async just
      // above, so write once now (may show STARTING) and refresh once after
      // they settle.
      function adapterStatuses() {
        var out = [];
        try { out.push(Object.assign({ name: 'pc-child' }, pcChild.getStatus())); } catch (_) {}
        try { out.push(Object.assign({ name: 'cua-driver' }, cuaDriver.getStatus())); } catch (_) {}
        try { out.push(Object.assign({ name: 'browser-agent' }, browserAgent.getStatus())); } catch (_) {}
        return out;
      }
      function writeIt() {
        try {
          capabilities.writeManifest(memory.fs, effectors, adapterStatuses());
        } catch (err) {
          logger.warn('capabilities-manifest.write-failed', { error: err.message });
        }
      }
      writeIt();
      var settleTimer = setTimeout(writeIt, 10000);
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
        var reminderSensor = createReminderSensor({ calendar: calendarWiring.calendar, bus: bus });
        reminderSensor.start();
        logger.info('sensors.reminder.started', {});
      }

      // Gmail unread triage sensor — polls gmail_unread via the hub every
      // GMAIL_TRIAGE_POLL_MS so genuinely new unread mail emits 'gmail.unread-batch'
      // for proactive speech. Only started when Gmail is actually configured AND
      // triage is enabled — otherwise it would error-spam every poll cycle hitting
      // an unconfigured Gmail API.
      if (config.GOOGLE_REFRESH_TOKEN && config.GMAIL_TRIAGE_ENABLED) {
        var gmailSensor = createGmailSensor({ gmailUnread: gmailUnread, bus: bus, pollMs: config.GMAIL_TRIAGE_POLL_MS });
        gmailSensor.start();
        logger.info('sensors.gmail.started', {});
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
    }}
  ]);

  // Stop running loops — step 1 of the D-07 coordinated shutdown sequence
  // (registered below via lifecycle.registerShutdownStep, run after server-close).
  function stopRunningLoops() {
    if (checkpointSweepTimer) clearInterval(checkpointSweepTimer);
    pcChild.shutdownPcChild();
    cuaDriver.shutdownCuaDriver();
    browserAgent.disconnect();
    if (edgeTtsChild) edgeTtsChild.stop();
    if (timerSensor) timerSensor.stop();
    if (metricSensor) metricSensor.stop();
    if (screenSensor) screenSensor.stop();
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
