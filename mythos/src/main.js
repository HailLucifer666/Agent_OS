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
const { createTimerSensor } = require('./core/sensors/timer');
const { createProbes } = require('./core/immune/probes');
const { createDiagnostician } = require('./core/immune/diagnostician');
const { createHealer } = require('./core/immune/healer');
const { createWatchdog } = require('./core/immune/watchdog');
const { createAnnouncer } = require('./core/immune/announcer');
const { createMonitor, recoverFromCrash } = require('./core/immune/monitor');
const { createMetricSensor } = require('./core/sensors/metric');
const { createEffectorHub } = require('./core/effectors/hub');
const { createBuildRunner } = require('./core/effectors/build-runner');
const { createPipelineEffector } = require('./core/effectors/pipeline');
const { createKanbanEffector } = require('./core/effectors/kanban');
const { createAgentActions } = require('./core/effectors/agent-actions');
const { createGoalsMdBridge } = require('./core/effectors/goals');
const { createVoiceEffector } = require('./core/effectors/voice');
const { createEdgeTtsChild } = require('./core/effectors/edge-tts-child');
const { registerFromComputer } = require('./core/effectors/from-computer');
const { registerFromPc } = require('./core/effectors/from-pc');
const { registerFromBrowser } = require('./core/effectors/from-browser');
const { registerFromDashboard } = require('./core/effectors/from-dashboard');
const { registerFromProject } = require('./core/effectors/from-project');
const abtop = require('./core/effectors/collectors/abtop');
const { createFileSensor } = require('./core/sensors/file');
const { createWsSensor } = require('./core/sensors/ws');
const { createJobSensor } = require('./core/sensors/job');
const { createServer } = require('../server');
const fs = require('fs');

async function main() {
  // Step 0: .env (DEGRADED — missing .env is not fatal, config falls back to schema defaults)
  require('dotenv').config();

  // Step 1: Config
  const configResult = loadConfig();
  if (!configResult.ok) {
    console.error('Config errors:', configResult.errors.join(', '));
    process.exit(1);
  }
  const config = configResult.config;

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
  let goals = null;
  let effectors = null;
  let leash = null;
  let cortex = null;
  let timerSensor = null;
  let immune = null; // { probes, diagnostician, healer, watchdog, announcer, monitor }
  let metricSensor = null;
  let buildRunner = null;
  let fileSensor = null;
  let wsSensor = null;
  let jobSensor = null;
  let edgeTtsChild = null;

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

    { name: 'recovery', fail: 'degraded', fn: function() {
      // [Phase 6 — NEW: supersedes the old inline checkpoint.load() logic] Full §10
      // Recovery algorithm — pauses goals active-at-crash and emits the audited
      // 'lifecycle.recovered' event (see immune/monitor.js's recoverFromCrash()).
      return recoverFromCrash({ bus: bus, config: config, memory: memory, goals: goals }).then(function(result) {
        logger.info('recovery.checked', result);
      });
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

      var pipelineEffector = createPipelineEffector({ fs: memory.fs });
      var kanbanEffector = createKanbanEffector({ fs: memory.fs });
      buildRunner = createBuildRunner({ config: config, brain: brain, bus: bus, vault: memory.fs });
      var agentActionsEffector = createAgentActions({
        fs: memory.fs, pipeline: pipelineEffector, kanban: kanbanEffector, buildRunner: buildRunner
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
      registerFromPc(hub);
      registerFromBrowser(hub);
      registerFromDashboard(hub, {
        goalsEffector: goalsBridge, pipeline: pipelineEffector, kanban: kanbanEffector,
        agentActions: agentActionsEffector, buildRunner: buildRunner,
        probes: immune.probes, abtop: abtop, config: config
      });
      registerFromProject(hub, { pipeline: pipelineEffector, agentActions: agentActionsEffector });
      hub.register(createVoiceEffector({ config: config }));

      effectors = hub;
      logger.info('effectors.ready', { count: effectors.count() });

      leash = createLeash({ bus, config, identity, auditWriter: memory.audit, goals, effectors });
      logger.info('leash.ready', {});
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

      var serverHandle = createServer({
        bus: bus, config: config, logger: logger, memory: memory,
        goalsEffector: goalsEffector,
        kanbanEffector: kanbanEffector,
        pipelineEffector: pipelineEffector,
        effectors: effectors, leash: leash, goals: goals, probes: immune.probes,
        brain: brain,
      });
      lifecycle.registerStopServer(serverHandle.stop); // shutdown step 0 (Ambiguity #5)
      logger.info('server.ready', { port: config.MYTHOS_PORT, bind: config.MYTHOS_BIND });
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

      // [Phase 6 — NEW] metric sensor polls immune/probes.js every 4s and feeds
      // the cognitive OODA loop's perception queue.
      metricSensor = createMetricSensor({ bus, config, probes: immune.probes });
      metricSensor.start();
      logger.info('sensors.metric.started', {});

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

    { name: 'edge-tts', fail: 'degraded', fn: function() {
      // Local Microsoft Neural TTS service (free, no key) — voice replies get
      // synthesized server-side (server/index.js handleUtterance) and shipped
      // to the browser as base64 mp3. Degraded: missing python/module just
      // means the client falls back to browser speechSynthesis.
      edgeTtsChild = createEdgeTtsChild({ logger: logger });
      edgeTtsChild.start();
    }}
  ]);

  // Stop running loops before the lifecycle's own shutdown/exit runs (full graceful
  // shutdown sequencing — drain/flush/audit — is D-07, a non-blocking Known Deviation)
  function stopRunningLoops() {
    if (edgeTtsChild) edgeTtsChild.stop();
    if (timerSensor) timerSensor.stop();
    if (metricSensor) metricSensor.stop();
    if (fileSensor) fileSensor.stop();
    if (wsSensor) wsSensor.stop();
    if (jobSensor) jobSensor.stop();
    if (cortex) cortex.stop();
    if (immune) {
      immune.watchdog.stop();
      immune.diagnostician.stop();
      immune.healer.stop();
      immune.announcer.stop();
      immune.monitor.stop();
    }
  }
  process.on('SIGINT', stopRunningLoops);
  process.on('SIGTERM', stopRunningLoops);

  // Register signal handlers
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
