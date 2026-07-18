# MYTHOS — Complete System Handoff
### Architecture · Infrastructure · Wiring · Logic · Flow · Anti-Drift · Verified Code Snippets

> **For the AI model inheriting this codebase.** Every snippet in this document was copied from the actual source on `main` (verified line-by-line on 2026-07-18), not from the project docs. Where older docs (HANDOFF-FOR-KIMI.md, ROADMAP.md, MYTHOS-ARCHITECTURE.md) disagree with this document, **this document wins** — those docs drifted (see §2 and §25).

---

## 0. How to use this document

1. Read §1 (vision) and §2 (current state) first — they tell you *what exists* vs. *what was claimed*.
2. §5–§21 are the system itself: boot, bus, brain, memory, leash, effectors, cortex, goals, voice, sensors, immune, server, adapters, engagements, UI, vault, JARVIS-wave modules. Each section names the real files and shows the real code.
3. §23 is the rulebook — the invariants and conventions you must not violate (anti-drift).
4. §24 is the verified gap/drift register. §25 is the agreed upgrade plan. §26 is your first-hour checklist.

**Prime directive from the operator:** *"It should not break my code, what works. It should keep what works and make it much much much better."* Everything you do must keep `node --test` green and preserve honest-inert degradation.

---

## 1. The vision — what MYTHOS is supposed to be

MYTHOS is an **always-on autonomous entity**, not a request/response agent. The design intent:

- **It never waits for commands.** A 1-second cognitive tick (OODA: observe → orient → decide → act → reflect) runs continuously. Perceptions arrive from sensors; goals are arbitrated; actions are planned and dispatched under a tiered autonomy "leash"; outcomes are recorded; memory consolidates in the background.
- **It has a body and senses.** Voice in/out (wake-word, VAD, barge-in), screen/camera vision, desktop control (UIA, keystrokes, windows), browser control (Playwright CDP), Spotify/media, Gmail/Calendar, file system, web search/fetch.
- **It remembers.** Five persistent stores (Episodic, Semantic, Skills, Identity, Audit) + Working memory + Checkpoints, all plain files under a vault directory. Hybrid keyword+vector recall.
- **It is safe by construction.** A tiered leash (T0 read-only … T4 always-confirm) gates every action; identity `boundaries.md` can only tighten, never loosen; unknown tools fail-closed to T3; the audit trail is fail-closed for T≥3.
- **It heals itself.** An immune system (probes, diagnostician, healer playbooks, watchdog, circuit breakers, announcer, crash monitor) detects stalls/failures and remediates.
- **It is honest.** If a capability is unavailable, the system says OFFLINE/DEGRADED — it never fabricates success ("honest-inert" design).
- **It costs ~$0.** All LLM access goes through free-tier providers with chain-walk failover; idle ticks make zero brain calls.
- **It builds things.** Pipeline/Forge turn ideas into multi-file projects under `vault/builds/`, with kanban, missions (parallel builder agents), checkpoints, and evidence-validated shipping.

The JARVIS wave (on `main`, beyond the original spec) added: personality + boot greeting, skill packs, a learning loop (reflection), a hermes sidecar, wake-word, ambient screen awareness, a daily planner, orb 2.0 HUD, risk-tiered auto-approval, credential scanning, evidence validation, and the Forge multi-file build pipeline.

---

## 2. Current state snapshot (verified)

### 2.1 Git topography — three divergent work lines

The previous handoff (HANDOFF-FOR-KIMI.md) claims its flagship work is "on main, unpushed." **That is false.** Verified via `git cat-file` / `git branch --contains` / content greps:

| Line | Contents | State |
|---|---|---|
| `main` @ `685dbaa` | Phases P0–P20 + the JARVIS wave (~25 commits newer than the handoff): personality, skill-packs, reflection, hermes, wake-word, screen-sensor, daily planner, orb 2.0, risk-classifier, evidence-validator, credential-scanner, Forge, assistant/gateway, immune/explainer | Clean tree. **This is what runs.** |
| Local branch `phase1/engagement-execution-engine` | `614edb6` (voice browser-tab alias fix), `8706ccc` (engagement stage-execution engine: `executor.js`, 16 event builders, REST wiring) | 2 commits, **not merged to main** |
| Dangling commits (no branch) | `4682f7c` (doc generation: exceljs/pptxgenjs), `dab6e53` (desktop tools), `1b79321` (browser tools), `8d74684`, `afcd593`, `d4b2a55`, `7da9746`, `a5ab889` (gap fixes) | Recoverable while not GC'd |
| `origin/jarvis-p21-p24` | `2cc50f3` only | **Superseded** — its P21–P24 content already landed on `main` via the JARVIS wave |

Consequences: `mythos/src/core/engagements/executor.js`, `effectors/from-docs.js`, `generate_spreadsheet/deck/pdf`, `Handle-MoveWindow`, `browser_wait_for`, `browser_fill_form` **do not exist on main**. The handoff's "68 effectors" vs. the enforced count gate of **61** is doc drift.

### 2.2 Tests

- Runner: `cd mythos && node --test` (node ≥18). ~104 test files, ~1000 cases.
- Deliberate tripwires (do not "fix" by deleting): `effectors-hub.test.js` count gate (asserts exactly **61** registered effectors), `event-name-conformance.test.js` (event-name allowlist), identity/boundaries contract tests, tier-table parity checks.
- Known environment-blocked: `boot.test.js` SIGINT/port checks on some Node/Windows builds — root cause is an OS-level `fs.watch()` handle swallowing console signals (documented in `main.js`'s sensors step comment). Not a code defect; do not "fix" file.js.

### 2.3 Runtime facts

- Port **4478** (`MYTHOS_PORT`), bind `127.0.0.1` default. Dashboard: `http://127.0.0.1:4478`.
- Start: `node mythos/src/main.js` (or `Start Agent OS.bat` at repo root).
- Runtime deps (6): `@mediapipe/tasks-vision` (Apache-2.0), `dotenv`, `express`, `onnxruntime-web`, `playwright-core`, `ws`. No exceljs/pptxgenjs on main.
- `render.yaml` exists and would bind `0.0.0.0` with **no auth** and a wrong healthCheckPath (`/api/health`; the real route is `/health`) — see §24 P-gaps. Do not deploy as-is.

### 2.4 Known bugs (BUGS.md registry, pruned to truth)

- 🔧 **CODED, not live-verified** (need operator hardware pass): BUG-039 wake-word, BUG-040 ambient awareness, BUG-041 daily planner; also BUG-020 mic gating, BUG-014, BUG-027/028, BUG-006, barge-in.
- ✅ Fixed: BUG-038 (pc-child OEM-codepage JSON corruption), BUG-036→BUG-004 (media widget live-verified), BUG-026 (Spotify plays via cua-driver), BUG-012 (session T3 grants), BUG-017 (voice catalog drift).
- ⚠️ BUG-029 (orphan browser processes): pidfile-mitigated, proper fix pending. BUG-024 (Gmail/Calendar): needs operator OAuth (`scripts/google-auth.js`).

---

## 3. Repository layout (what matters)

```
f:\Agent-OS\Agent_OS-main\Agent_OS-main\
├── mythos\                      ← THE APP (everything below is inside mythos\ unless noted)
│   ├── src\
│   │   ├── main.js              ← boot: ~24 lifecycle steps, the wiring diagram made code (719 lines)
│   │   └── core\
│   │       ├── bus\             event bus (index.js, event.js)
│   │       ├── config\          schema.js (validated env) + index.js (loadConfig)
│   │       ├── logger.js
│   │       ├── lifecycle\       boot steps, shutdown sequence, SIGINT/SIGTERM
│   │       ├── brain\           index.js (think), chain.js (failover walk), registry.js, spend.js
│   │       ├── memory\          fs-store, episodic, semantic, skills, identity, audit-writer,
│   │       │                    checkpoints, working, vector-index, daily-note (DEAD), index.js (facade)
│   │       ├── identity\        index.js (self.md/boundaries.md), persona, reflection.js (P4),
│   │       │                    capabilities.js (boot manifest), version.js
│   │       ├── goals\           index.js (CRUD + arbiter + planner + budgets)
│   │       ├── leash\           index.js (check/confirm), tiers.js (CANONICAL tier table),
│   │       │                    confirm.js, checkpoints.js (P22 approval gates)
│   │       ├── cortex\          index.js (tick loop), ooda.js (pure stage functions)
│   │       ├── effectors\       hub.js, adapter.js, dispatch-action.js, breakers(immune),
│   │       │                    from-*.js (17 tool families), forge\, pipeline, kanban,
│   │       │                    agent-actions, build-runner, orchestrator, risk-classifier,
│   │       │                    evidence-validator, credential-scanner, web-search, web-fetch, voice
│   │       ├── engagements\     index.js (state machine), store.js, interview.js,
│   │       │                    spec-builder.js, plan-builder.js, events.js (16 builders, test-only)
│   │       ├── assistant\       gateway.js (LIVE), intent-router/response-planner/style/summary (DEAD)
│   │       ├── conversation\    announcer.js (proactive speech), history
│   │       ├── sensors\         timer, file, ws, job, metric, gmail-sensor, reminder-sensor, screen-sensor
│   │       ├── immune\          probes, diagnostician, healer, watchdog, announcer, monitor,
│   │       │                    breakers, explainer (P6)
│   │       ├── planner\daily.js daily planner (P3 JARVIS)
│   │       ├── design\verify.js build verifier (brain-driven)
│   │       ├── skills\loader.js skill-pack catalog (allowlist)
│   │       └── voice\           voice-agent.js (catalog, aliases, conversation)
│   ├── server\
│   │   ├── index.js             1582-line god-file: ~30 REST routes + WS layer + voice turns +
│   │   │                        vision streaming + confirm/checkpoint flows + proactive speech + TTS
│   │   ├── news-feed.js
│   │   └── rate-limit.js
│   ├── providers\               groq, mistral, cerebras, nim, nim2, openrouter, zcode, ollama,
│   │                            openai-compat (shared SSE client), embeddings, edge-tts, groq-stt,
│   │                            claude-cli (DEAD)
│   ├── adapters\                pc-child\ (PowerShell daemon), browser-agent\ (playwright CDP),
│   │                            cua-driver\, hermes-agent\, google\
│   ├── mcp\server.js            opt-in stdio JSON-RPC server exposing the tool catalog
│   ├── ui\public\               zero-build vanilla JS JARVIS HUD (orb 2.0, widgets, voice, vision)
│   ├── skills\                  vendored skill packs: caveman, karpathy-guidelines, ponytail,
│   │                            taste-frontend, ui-ux-pro-max (11 more expected at ~/.zcode/skills)
│   ├── scripts\                 google-auth.js, graphify*.js, live-logs.js, setup-wakeword.js, …
│   ├── services\edge-tts-server.py   local Microsoft Neural TTS (free, no key)
│   ├── test\                    ~104 files, node:test
│   ├── vault\                   THE ENTITY'S PERSISTENT MEMORY (see §20) — never commit secrets here
│   ├── package.json             CommonJS; engines node>=18
│   ├── .env / .env.example
│   └── THIRD_PARTY_NOTICES.md
├── app\                         ← NOVA, the predecessor dashboard (port 4477). Zero runtime imports
│                                  from mythos. Left in place; archiving is an operator decision.
├── BUGS.md, ROADMAP.md, MYTHOS-ARCHITECTURE.md, MYTHOS-PHASE-BUILD-SPEC.md   ← docs (PARTIALLY STALE)
└── render.yaml                  ← deploy manifest (UNSAFE as-is: no auth, wrong health path)
```

---

## 4. Runtime topology / infrastructure

Single Node.js process. CommonJS in `src/` + `server/`; ES modules only in `ui/public/`. No build step anywhere.

```
                        ┌──────────────────────── MYTHOS process ────────────────────────┐
                        │                                                                │
  microphone/camera ──► │  UI (browser, :4478)  ◄──WS v2──►  server/index.js (Express)   │
  screen (pc-child)  ──►│       ▲                          │  ├─ REST /api/*             │
  gmail/calendar     ──►│       │ proactive speech/TTS     │  ├─ voice turns             │
  files/jobs/metrics ──►│  sensors ──emit──► BUS ◄─────────┤  └─ confirm/checkpoint flow │
                        │                    │             │                             │
                        │        perception.*│subscription │  CORTEX tick (1s, unref'd)  │
                        │                    ▼             │   observe→orient→decide→    │
                        │              memory.working ────►│   act→reflect               │
                        │                                │        │                      │
                        │   goals.arbitrate/plan ◄───────┤────────┘                      │
                        │        │ brain.think           │                               │
                        │        ▼                       │  LEASH.check (tier gate)      │
                        │   BRAIN ──chain.walk──► 8 free providers (SSE)                  │
                        │        │                       │        │ allow                 │
                        │   MEMORY (vault files)         │        ▼                      │
                        │   episodic/semantic/skills/    │  EFFECTOR HUB (61 tools,      │
                        │   identity/audit/checkpoints   │  breaker-gated invoke)        │
                        │        ▲                       │        │                      │
                        │        └──────episodic/audit───┤◄───────┘                      │
                        │                                │  adapters: pc-child (pwsh),   │
                        │   IMMUNE: watchdog/healer/     │  browser-agent (playwright),  │
                        │   breakers/announcer/monitor   │  cua-driver, hermes, google   │
                        └────────────────────────────────┴───────────────────────────────┘
```

Child processes: `pc-child` (persistent PowerShell daemon, JSON-RPC over stdio), `cua-driver` (optional sidecar), `edge-tts` (python http service), launched browser (playwright, on-demand only). All loops/timers are `unref`'d; shutdown is coordinated (see §5.3).

---

## 5. Boot sequence — the wiring, step by step

Source of truth: [mythos/src/main.js](file:///f:/Agent-OS/Agent_OS-main/Agent_OS-main/mythos/src/main.js) (719 lines). Boot is a `lifecycle.setSteps([...])` array; each step declares `fail: 'fast'` (abort boot) or `fail: 'degraded'` (log + continue). After all steps: `logger.info('MYTHOS ALIVE')` and a never-resolving promise holds the event loop open.

### 5.1 The step list (verified order)

| # | Step | Fail | What it wires |
|---|------|------|----------------|
| 0–3 | config, logger, bus, vault-dirs | fast | dotenv → `loadConfig()` (schema-validated, exit 1 on errors); boot banner; bus with history/storm guards; `mkdir -p` vault dirs |
| 4 | memory | fast | `brain = createBrain({config, bus})` (instance #1, no identity yet); `memory = createMemory(...)`; `memory.init()` (all stores + vector indexes) |
| 5 | immune | **fast** | probes, diagnostician, healer (**getCortex/getGoals thunks** closing over `let` bindings), watchdog, announcer (speaks via `action.speak-requested` emit), monitor; starts diagnostician/healer/announcer/monitor |
| 6 | brain-probe | degraded | `Promise.race([brain.probe(), 5s unref'd timeout])` — never blocks boot on provider availability. ⚠️ probes brain instance #1 (see §24 W-drift: brain is reconstructed in step 8) |
| 7 | identity | degraded | `createIdentity({fs: memory.fs, identityStore: memory.identity})`; then **reconstructs brain**: `brain = createBrain({config, bus, identity})` — every later step sees persona injection; memory keeps instance #1 (deliberate, documented) |
| 8 | goals | degraded | `createGoalSystem({fs, config, bus, memory, brain})`; loads `vault/Goals/*.json` |
| 9 | leash | **fast** | The big one — builds the entire effector surface (see 5.2), then `createLeash({bus, config, identity, auditWriter: memory.audit, goals, effectors, scanner: credentialScanner})` |
| 10–13 | engagement-store, engagement-manager, conversation-gateway, engagement-immune-hooks | degraded | Engagement layer. ⚠️ **gateway is constructed with `cortex` still `null`** (cortex is step 18) → its cortex-fallback route is permanently dead (§24 W5) |
| 14 | recovery | degraded | `recoverFromCrash(...)` — pauses goals active-at-crash, folds in buildRunner's recovered jobs, emits audited `lifecycle.recovered` (placed after leash so buildRunner exists — D-57 fix) |
| 15 | server | **fast** | Verifies `goals-effector`/`kanban-effector`/`pipeline-effector` named services exist (throws otherwise — "never silently serves 404s"); creates `reflection` (P4 learning loop); `createServer({...big deps})`; registers stop-server as shutdown step 0; wires `camera_look` frame provider |
| 16 | browser-automation | degraded | CDP-connect attempt only (**no auto-launch** — launching steals the Windows mic, breaking voice); `pcChild.startPcChild()`; `cuaDriver.startCuaDriver()` (ENOENT-tolerant) |
| 17 | capabilities-manifest | degraded | Writes `vault/Identity/capabilities.md` from the live hub catalog + adapter states (again at +10s); `skillsLoader.refresh()` reports missing skill packs honestly |
| 18 | immune-explainer | degraded | Plain-language anomaly explanations via proactive speech |
| 19 | cortex | **fast** | `createCortex({bus, memory, goals, brain, leash, effectors, config})` — **throws if leash or effectors missing (D-39 fail-closed)**; `cortex.start()`; `watchdog.start()` |
| 20 | sensors | **fast** | **The perception bridge**: `bus.subscribe('perception.*', e => memory.working.pushPerception(e.payload))` — without this, cortex perceives nothing (fail-fast by design); starts timer, reminder (if calendar), gmail (only if `GOOGLE_REFRESH_TOKEN && GMAIL_TRIAGE_ENABLED`), metric, screen (only if `SCREEN_AWARENESS_ENABLED`), file, job, ws sensors |
| 21 | planner | degraded | Daily planner always constructed (tool works even when scheduler off); `start()` gated by `PLANNER_ENABLED !== false` |
| 22 | edge-tts | degraded | Local neural TTS child; client falls back to browser speechSynthesis |

### 5.2 The `leash` step — every effector registration (verified)

```js
var hub = createEffectorHub({ bus: bus, config: config });

var riskClassifier = createRiskClassifier();
var evidenceValidator = createEvidenceValidator();
var pipelineEffector = createPipelineEffector({ fs: memory.fs, classifier: riskClassifier });
var kanbanEffector = createKanbanEffector({ fs: memory.fs });
var verifier = require('./core/design/verify').createVerifier({ brain: brain });
buildRunner = createBuildRunner({ config, brain, bus, vault: memory.fs, verifier });
agentActionsEffector = createAgentActions({ fs, pipeline, kanban, buildRunner,
  designSystem: true, brain, webSearch, webFetch, browserAgent, evidenceValidator, bus });

var goalsBridge = createGoalsMdBridge({ fs: memory.fs, goalSystem: goals, bus: bus });
goalsBridge.sync();                                  // reconcile Goals.md -> GoalSystem at boot
hub.registerNamed('goals-effector', goalsBridge);    // named services: no breaker, not in count
hub.registerNamed('kanban-effector', kanbanEffector);
hub.registerNamed('pipeline-effector', pipelineEffector);

registerFromComputer(hub);
pcToolsWiring = registerFromPc(hub, { brain: brain, fs: memory.fs });
registerFromSpotify(hub, { effectors: hub });
registerFromBrowser(hub, { config: config });
dashboardWiring = registerFromDashboard(hub, { goalsEffector, pipeline, kanban,
  agentActions, buildRunner, probes: immune.probes, abtop, config, fs: memory.fs, bus });
// ask_agent dispatch wired through brain.think({lane:'simple'}) — was never wired before (bug fix)
registerFromProject(hub, { pipeline, agentActions });
var orchestrator = createOrchestrator({ buildRunner, kanban, agentActions, brain, bus, fs });
orchestrator.init();
registerFromMission(hub, { orchestrator });
registerFromSystem(hub, { config });
registerFromGmail(hub, { logger });
gmailUnread = function(args) { return hub.invoke('gmail_unread', args || {}, {}); };
                                     // ⚠️ hub-level invoke: breaker-gated but NO leash check (§24 W3)
registerFromSkills(hub);
registerFromMemory(hub, { semantic: memory.semantic, fs: memory.fs, identity, memory });
registerFromPersona(hub, { identity });
registerFromHermes(hub);
calendarWiring = registerFromCalendar(hub, { fs: memory.fs, bus });
registerFromWidgets(hub, { bus });

checkpoints = createCheckpointRegistry({ config, bus, auditWriter: memory.audit, goals, fs });
checkpoints.init();
checkpointSweepTimer = setInterval(() => checkpoints.sweep(), config.CHECKPOINT_SWEEP_MS); // unref'd
forge = createForge({ config, brain, bus, vault: memory.fs, checkpoints });
forge.init();
registerFromForge(hub, { forge });

hub.register(createVoiceEffector({ config: config }));

effectors = hub;                                     // count gate: exactly 61 tool effectors
leash = createLeash({ bus, config, identity, auditWriter: memory.audit, goals, effectors,
                      scanner: require('./core/effectors/credential-scanner').createCredentialScanner() });
```

Also note: `abtop.start()` is deliberately **not** called (its shell-wrapped child breaks Windows SIGINT delivery — documented in a long comment; the `monitor_snapshot`/`kill_session` tools stay honest-inert until a dashboard owns them).

### 5.3 Shutdown (D-07 coordinated sequence)

Registered via `lifecycle.registerShutdownStep`, driven by SIGINT/SIGTERM handlers, `SHUTDOWN_MS` (10s) hard-exit(1) backstop:

```
server-close (step 0) → stop-loops (all sensors/cortex/immune/children) →
reflection-final-pass (P4 learning) → episodic-flush → checkpoint-write →
audit-flush (writes {tool:'lifecycle', decision:'shutdown'}) → exit 0
```

---

## 6. The event bus

[mythos/src/core/bus/index.js](file:///f:/Agent-OS/Agent_OS-main/Agent_OS-main/mythos/src/core/bus/index.js) (128 lines). Synchronous pub/sub with dot-channels (`health.anomaly` → channel `health`), glob subs (`'perception.*'`, `'*'`), 500-event ring history, middleware chain, and three guards:

```js
// Causal depth guard — event-triggered events can only nest 32 deep
if (e.depth >= maxDepth) { safeEmit('health.anomaly', { kind: 'causal-loop', ... }); return; }

// Storm guard — >400 events/sec: non-critical channels (anything but health/lifecycle/audit)
// are coalesced into 'perception.coalesced' and dropped
if (stormTimestamps.length >= stormMaxPerWindow) { ... }

// Subscriber exceptions never kill the bus:
try { handler(e); } catch (err) { safeEmit('health.anomaly', { kind: 'handler-error', ... }); }
```

**Rules that keep it sane (enforced by tests + convention):**
- Event names are `channel.event-name` (first dot segment = channel). `event-name-conformance.test.js` enforces an allowlist — adding a new event name means updating the allowlist *in the same change*.
- Events should be emitted via builder functions where they exist (engagements has 16 builders in `events.js` — currently only used by tests, see §24 W7).
- `bus.emit` never awaits; persistence belongs to memory stores, not the bus.

---

## 7. The Brain

### 7.1 `brain.think` — the one thinking interface

[mythos/src/core/brain/index.js](file:///f:/Agent-OS/Agent_OS-main/Agent_OS-main/mythos/src/core/brain/index.js) (141 lines). Lanes: `voice | build | simple | text | vision | embed`.

```js
async think({ lane, messages, schemaHint, budget, signal, source, onToken, persona }) {
  if (lane === 'embed') return { content: null, offline: true, lane };   // clean offline placeholder
  // Budget exhaustion — defense-in-depth
  if (budget && (budget.tokens <= 0 || budget.actions <= 0))
    return { content: null, offline: true, lane, budgetExhausted: true };

  let msgs = messages;
  if (schemaHint) msgs = [{ role: 'system', content:
    'You must respond with valid JSON matching this schema: ' + schemaHint }, ...messages];
  if (['voice', 'build', 'simple'].indexOf(lane) !== -1) {
    var personaLine = persona
      ? persona + ' ' + versionLine + ' Be concise and actionable.'        // per-call agent seat
      : (identity ? identity.persona() : 'You are MYTHOS.') + ' ' + versionLine + ' Be concise and actionable.';
    msgs = [{ role: 'system', content: personaLine }, ...msgs];
  }

  try {
    const result = await chain.complete({ messages: msgs, brain: lane, signal,
      onAttempt: ({provider, model}) => bus && bus.emit('brain-spend', { provider, model, lane, source }),
      onToken });
    const parsed = tryParseWithRepair(result.content);   // direct parse → fence-strip → brace-match
    const spentTokens = spend.estimate(result.content) + spend.estimate(inputText);
    spend.recordCall({ provider: result.provider, model: result.model, ... });
    return { content: result.content, parsed: parsed || null, provider, model, spentTokens, offline: false, lane };
  } catch (err) {
    if (err.chainExhausted) return { content: null, offline: true, lane };  // HONEST offline, never fake
    if (err.name === 'AbortError') return { content: null, aborted: true, lane };
    throw err;
  }
}
```

**Contract every caller relies on:** `offline:true` means no provider answered — callers must degrade honestly (template fallback, "I'm offline", skip). `parsed` is best-effort JSON repair (fences, first-brace matching). Persona injection happens for voice/build/simple lanes only; a per-call `persona` string creates specialized agent seats (frontend-builder, reviewer) without changing global identity.

### 7.2 The chain walk — free-tier failover

[mythos/src/core/brain/chain.js](file:///f:/Agent-OS/Agent_OS-main/Agent_OS-main/mythos/src/core/brain/chain.js) (163 lines). 8 provider lanes: `zcode, nim, nim2, groq, mistral, cerebras, openrouter, ollama`. `registry.chainFor(lane)` returns the ranked preference list (5-min TTL refresh); a `nim` entry fans out to both NIM keys (key rotation).

```js
for (const { lane, model } of attempts) {
  if (signal && signal.aborted) { /* throw AbortError */ }
  if (isCooling(lane, model)) continue;                              // per lane:model cooldown (60s)
  if (LANES[lane].isAvailable && !LANES[lane].isAvailable()) continue; // unconfigured key → skip
  onAttempt && onAttempt({ provider: lane, model });
  try {
    const attemptCtrl = new AbortController();
    const attemptTimer = setTimeout(() => attemptCtrl.abort(), attemptTimeoutMs); // 30s per attempt
    try {
      content = await LANES[lane].chat(messages, { model, signal: attemptCtrl.signal, onToken });
      return { content, provider: lane, model };
    } finally {
      clearTimeout(attemptTimer);                          // cleanup on BOTH paths (leak fix)
      signal && signal.removeEventListener('abort', onCallerAbort);
    }
  } catch (err) {
    errors.push(`${lane}:${model}: ${err.message}`);
    // Error discrimination — cooldown ONLY for recoverable faults:
    var isRateLimit = /:\s*429\b/.test(msg), isServerError = /:\s*5\d\d\b/.test(msg),
        isNetwork = /fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(msg);
    if (isRateLimit || isServerError || isNetwork) markCooldown(lane, model, cooldownMs);
    // 401/403 (won't recover in 60s), 400 (request's fault), caller-abort → NO cooldown
  }
}
const err = new Error('All AI providers are currently unavailable. Please try again later.');
err.chainExhausted = true;   // generic message — never leaks lane/model to clients (A4)
throw err;
```

Providers live in [mythos/providers/](file:///f:/Agent-OS/Agent_OS-main/Agent_OS-main/mythos/providers) — all OpenAI-compatible SSE via `openai-compat.js`, plus ollama (native shape; vision messages translated via `toOllamaVisionMessages`), `embeddings.js` (memory vectors), `groq-stt.js` (Whisper STT), `edge-tts.js` (local neural TTS client). `claude-cli.js` is **dead** (no production callers).

### 7.3 Cost model

Spend is estimated (`spend.estimate`) and recorded per call with `source` attribution; `brain-spend` bus events feed the dashboard. The **idle-skip principle** (cortex §11) means a quiet entity makes zero brain calls; mull/consolidate are staggered so an idle tick makes at most one.

---

## 8. Memory system

Facade: [mythos/src/core/memory/index.js](file:///f:/Agent-OS/Agent_OS-main/Agent_OS-main/mythos/src/core/memory/index.js) (255 lines). All plain files under `MYTHOS_VAULT_ROOT` via `fs-store` (path-traversal-guarded).

| Store | Files | Purpose |
|---|---|---|
| Working | in-mem + checkpoint | Perception queue (`pushPerception`/`drainPerceptions`), tick counter, spend ledger, `activeGoalId` |
| Episodic | `Episodic/YYYY-MM-DD.jsonl` | Every perception >0.5 salience, every action outcome, conversations, thoughts. 30-day retention, **archived, never hard-deleted (D-18)** |
| Semantic | `Semantic/<topic>.md` | Durable facts. `user-facts.md` is appended by conversation distillation; `consolidated-<ts>` blobs by general distillation |
| Skills | `Skills/*.md` | Procedures with `steps[]` + `successRate`. ⚠️ `recordUse()`/`write` have **zero production callers** (§24 V3) |
| Identity | `Identity/self.md`, `persona.json`, `capabilities.md` | Who the entity is. Human-editable only (except persona dials + generated capabilities manifest) |
| Audit | `Audit/YYYY-MM-DD.jsonl` | Every leash decision + action outcome. **Fail-closed for T≥3** |
| Checkpoints | `Checkpoints/` | Working-memory snapshot every 50 ticks + at shutdown (crash recovery) |

### 8.1 Hybrid recall (keyword + vector, RRF-fused)

Writes fire-and-forget an embedding into per-store vector indexes (`vault/Index/`); embeddings down → pure keyword, same shape. **Only 2 production callers** (the server's recall-before-respond and the `recall_memory` tool) — the OODA loop never uses it (§24 V1).

```js
async recallHybrid(query, opts) {
  const limit = (opts && opts.limit) || 10;
  const keyword = (episodic.recall(query, opts) || []).concat(semantic.recall(query, opts) || []);
  const vector = [];
  const q = await embeddings.embed(query);
  if (q) {
    for (const storeName of ['episodic', 'semantic']) {
      const hits = vecIndexes[storeName].search(q, limit);
      for (const h of hits) {
        if (h.score < VECTOR_MIN_SCORE) continue;          // 0.5 floor
        /* resolve ref → record, skip pruned refs */ vector.push({...});
      }
    }
  }
  return rrfMerge([keyword, vector]).slice(0, limit);      // reciprocal-rank fusion
}
```

### 8.2 Consolidation (runs every `CONSOLIDATE_EVERY`=300 ticks, staggered against mull)

```js
async consolidate(opts) {
  await working.flushToEpisodic();                        // 1. crash-recovery snapshot
  const episodicResult = episodic.consolidate();          // 2. per-store archive (never delete)
  semantic.consolidate(); identity.consolidate(); skills.consolidate(); audit.consolidate();
  if (episodicResult.archived > 0) bus.emit('memory.decay', { pruned: episodicResult.archived });

  // 3. Episodic → semantic distillation (best-effort, skips when brain offline)
  const tail = episodic.tail(20).filter(Boolean);
  const highSalience = tail.filter(e => (e.salience || 0) > 0.5);
  if (highSalience.length > 0) {
    const result = await brain.think({ lane: 'simple', messages: [{ role: 'user',
      content: 'Distill these recent high-salience memories into durable facts:\n' + summaryText }],
      source: 'memory:consolidate' });
    if (result && !result.offline && result.content)
      semantic.write('consolidated-' + Date.now(), [result.content],
                     { confidence: 0.6, sources: highSalience.map(e => e.id) });
  }
  // 3b. Conversation → user-facts (needs ≥3 convo entries/day; appends to user-facts.md, conf 0.7)
}
```

⚠️ No dedup/merge of `consolidated-*` topics, no contradiction handling (§24 V10). `daily-note.js` is fully **dead** (zero imports).

---

## 9. The Leash — tiered autonomy gate

[mythos/src/core/leash/index.js](file:///f:/Agent-OS/Agent_OS-main/Agent_OS-main/mythos/src/core/leash/index.js) (217 lines) + [tiers.js](file:///f:/Agent-OS/Agent_OS-main/Agent_OS-main/mythos/src/core/leash/tiers.js) (canonical table). Constructor **throws** if bus/config/identity(+`checkBoundary`+`getMaxAutonomousTier`)/auditWriter/goals/effectors are missing — never no-ops at call time.

### 9.1 `check()` — the exact decision order (verified)

```js
function check(action, goalCtx) {
  var tier = TIER_TABLE[action.tool];                       // 1. static tier
  var effector = effectors.get(action.tool);                // 2. args-aware override
  if (effector && effector.dangerWhen && effector.dangerWhen(args))
    tier = Math.max(tier === undefined ? 3 : tier, 3);      //    can only RAISE, never lower
  if (tier === undefined) tier = 3;                         // 3. UNKNOWN TOOL → T3 FAIL-SAFE
                                                            //    (resolved BEFORE the >= comparisons — D-audit fix)
  if (tier >= 3 && scanner) {                               // 4. credential scan (P23)
    var credScan = scanner.scan(args);
    if (credScan.found) return deny('credential-detected: …redacted…');
  }
  if (config.MYTHOS_DRY_RUN && tier >= 1)                   // 5. dry-run → logged no-op (read LIVE)
    return deny('dry-run');
  var boundaryHit = identity.checkBoundary(toolName, args); // 6. boundaries.md — absolute DENY
  if (boundaryHit) return deny(boundaryHit);
  var maxTier = Math.min(config.AUTONOMOUS_MAX_TIER,        // 7. auto-allow within ceiling
                         identity.getMaxAutonomousTier());  //    boundaries can only tighten; both read LIVE
  if (tier <= maxTier) return allow('within-autonomous-max');
  if (tier === 3) {                                         // 8. T3: grants then confirm
    if (goal && goal.grants && goal.grants['3']) return allow('goal-granted');   // dies with goal
    if (SESSION_GRANTABLE[toolName] && goalCtx.connectionId) {                    // BUG-012 session grant,
      /* 'connectionId:tool' → expiresAt, 15min TTL — scoped to the accepting     //  per-connection, only
         WS connection; autonomous calls (no connectionId) never match */ }      //  ui_click/ui_type/
    return confirm('tier-3-requires-confirm');                                   //  click_at/send_key/focus_window
  }
  return confirm('tier-4-always-confirm');                  // 9. T4: ALWAYS confirm, never cached
}
```

Every decision writes the audit entry **and** emits `audit.decision` (live-tail for the dashboard). **Fail-closed:** if the audit line can't be written and tier ≥ 3 → deny (`audit-unwritable-fail-closed`); T0–T2 continue fail-open.

### 9.2 The canonical tier table (verbatim from tiers.js — 3-source parity with MYTHOS-ARCHITECTURE.md §9 is an invariant)

```js
const TIER_TABLE = {
  // T0 — READ ONLY (auto-allow, never audit)
  navigate:0, close_panel:0, read_status:0, job_status:0, list_goals:0, pipeline_status:0,
  kanban_status:0, monitor_snapshot:0, mission_status:0, get_time:0, get_weather:0,
  list_folder:0, read_file:0, list_windows:0, ui_elements:0, browser_get_title:0,
  web_search:0, web_fetch:0, camera_look:0, remember:0, log_incident:0, reminder_add:0,
  reminder_list:0, use_skill:0, open_web:0, recall_memory:0, persona_status:0,
  self_capabilities:0, media_status:0, project_status:0,

  // T1 — LOCAL WRITES (auto-allow, audit logged)
  create_goal:1, toggle_goal:1, capture_idea:1, kanban_add_card:1, kanban_move_card:1,
  write_note:1, screen_look:1, capture_screenshot:1, browser_screenshot:1, browser_get_text:1,
  browser_scroll:1, browser_go_back:1, focus_window:1, pipeline_advance:1 /*approve only;
  dangerWhen handles reject*/, gmail_unread:1, gmail_read:1, gmail_draft:1, reminder_cancel:1,
  spawn_widget:1, set_persona_level:1, manage_widget:1, ambient_awareness:1, daily_plan:1,

  // T2 — LOCAL ACTIONS (auto-allow within AUTONOMOUS_MAX_TIER=2, audit)
  open_folder:2, launch_app:2, open_artifact:2, media_key:2, ask_agent:2, browser_navigate:2,
  browser_tabs:2, browser_launch_debug:2, spotify_play_pause:2, spotify_next:2,
  spotify_previous:2, spotify_volume:2, spotify_status:2, send_key:2, spotify_play:2,
  spotify_search:2, build_project:2, revise_project:2, pipeline_execute:2, kanban_assemble:2,
  kanban_build_card:2, start_project:2, run_mission:2,

  // T3 — CONFIRM-ONCE-PER-GOAL (grant recorded, dies with goal)
  delete_goal:3, compose_email:3, close_window:3, gmail_send:3, ui_click:3, ui_type:3,
  click_at:3, browser_click:3, browser_type:3, hermes_task:3,

  // T4 — ALWAYS CONFIRM (never cached)
  kill_session:4, browser_evaluate:4
};
function tierOf(name) { var t = TIER_TABLE[name]; return t === undefined ? 3 : t; } // unmapped→3
```

Re-tiering note (deliberate, documented in-file): spotify_*, build_project, pipeline_execute etc. were moved T3→T2 because they only write inside the sandboxed `vault/builds/` or drive local Spotify — "a confirm popup on every 'play a song' was friction, not safety." The T3/T4 security-invariant tools (gmail_send, delete_goal, ui_click/ui_type/click_at, browser_click/type/evaluate, kill_session, hermes_task, compose_email, close_window) are deliberately untouched.

---

## 10. Effectors — the action surface

### 10.1 The hub

[mythos/src/core/effectors/hub.js](file:///f:/Agent-OS/Agent_OS-main/Agent_OS-main/mythos/src/core/effectors/hub.js) (128 lines):

```js
function createEffectorHub({ bus, config }) {
  var effectors = new Map();        // tool name -> effector (the 61 gate-counted ones)
  var namedServices = new Map();    // 'goals-effector'|'kanban-effector'|'pipeline-effector'
  var breakers = createBreakerRegistry();  // per-effector circuit breaker (immune/breakers)

  function register(effector) {     // enforces {id, invoke()}, auto-creates a breaker
    effectors.set(effector.id, effector);
    breakers.set(effector.id, createBreaker({ name: effector.id, bus, config }));
  }
  function get(name) {              // tools first, then named services (leash & server both use this)
    return effectors.has(name) ? effectors.get(name) : namedServices.get(name);
  }
  async function invoke(name, params, ctx) {
    var effector = effectors.get(name);
    if (!effector) return { ok: false, result: 'unknown-effector' };
    if (!breakers.allow(name)) return { ok: false, result: 'circuit-open' };
    var result;
    try { result = await effector.invoke(params, ctx); }
    catch (err) {                                                  // hub never trusts the
      bus && bus.emit('health.anomaly', { kind: 'effector-throw', target: name, ... }); // no-throw
      result = { ok: false, result: err.message };                 // contract
    }
    result && result.ok ? breakers.recordSuccess(name) : breakers.recordFailure(name);
    return result;
  }
  // catalog() → real registrations (BUG-017: voice catalog is derived, not hand-maintained)
  // count() === effectors.size === 61 — the tripwire gate
}
```

### 10.2 Tool → effector adapter

[mythos/src/core/effectors/adapter.js](file:///f:/Agent-OS/Agent_OS-main/Agent_OS-main/mythos/src/core/effectors/adapter.js) (52 lines, full file — every tool family wraps NOVA-style tools through this):

```js
function effectorFromTool(tool) {
  return {
    id: tool.name,
    tier: tierOf(tool.name),                 // same fail-safe as leash.check (unmapped→3)
    dangerWhen: tool.dangerWhen,             // read by leash.check() at gate time
    describe: function() { return tool.description; },
    describeMeta: function() { return { name: tool.name, description: tool.description,
                                        params: tool.params }; },          // BUG-017 real catalog
    validate: function(params) {             // presence-only: required = key whose description
      var required = Object.keys(tool.params || {}).filter(function(k) {   // lacks "(optional)"
        return String(tool.params[k]).indexOf('(optional)') === -1; });
      /* ...missing/empty → { ok:false, reason:'missing required param: '+key } ... */
      return { ok: true };                   // deliberately shallow — tool fns validate internally
    },
    async invoke(params, ctx) {
      try {
        var result = await tool.fn(params, ctx);
        if (result && typeof result === 'object' && 'ok' in result) return result;
        return { ok: true, result: result }; // normalize bare values
      } catch (err) { return { ok: false, result: err.message }; }
    }
  };
}
```

Tool result convention everywhere: `{ ok: boolean, result: string|object }` (NOVA `ok()`/`fail()` helpers). Invariant: `danger: true` in a tool definition ⇔ tier ≥ 3 in the table.

### 10.3 `dispatchAction` — the canonical dispatch sequence (INVARIANT #1)

[mythos/src/core/effectors/dispatch-action.js](file:///f:/Agent-OS/Agent_OS-main/Agent_OS-main/mythos/src/core/effectors/dispatch-action.js) (78 lines, full file). Used by the server's voice + confirm-accept paths:

```js
async function dispatchAction(decision, ctx) {
  const { effectors, bus, goals, memory, config } = ctx;
  const goalId = ctx.goalId || null;
  const tier = ctx.tier || 0;
  const signal = ctx.signal || AbortSignal.timeout((config && config.ACTION_TIMEOUT_MS) || 30000);

  // 1. Breaker check
  if (effectors.breakers && typeof effectors.breakers.allow === 'function') {
    if (!effectors.breakers.allow(decision.tool)) {
      bus.emit('action.blocked', Object.assign({}, decision, { reason: 'circuit-open' }));
      return { ok: false, result: 'circuit-open' };
    }
  }
  // 2. Dispatch
  const result = await effectors.invoke(decision.tool, decision.args,
                                        { signal, bus, goalId });
  // 3. Record outcome in episodic memory
  await memory.episodic.write({ kind: 'action', channel: ctx.channel || 'cortex',
    summary: decision.tool + '(' + JSON.stringify(decision.args || {}).slice(0, 80) + ')',
    detail: result, outcome: result && result.ok ? 'ok' : 'fail', tier, tokensSpent: 0 });
  // 4. Budget debit
  if (goalId && goals && goals.debitBudget) goals.debitBudget(goalId, { tokens: 0, actions: 1 });
  // 5. Completion event
  bus.emit('action.completed', { tool: decision.tool, ok: result && result.ok, goalId });
  // B4: audit-log the outcome
  memory.audit.write({ tool: decision.tool, tier, decision: 'completed',
                       outcome: result && result.ok ? 'ok' : 'fail', goalId });
  // 6. UI relays — autonomous UI actions reach the dashboard
  if (decision.tool === 'navigate' && result.ok && result.result.route)
    bus.emit('ui.navigate', { route: result.result.route });
  if (decision.tool === 'close_panel' && result.ok)
    bus.emit('ui.close-panel', { all: result.result.all });
  if (decision.tool === 'open_web' && result.ok && result.result)
    bus.emit('ui.open-web', result.result);
  return result;
}
```

### 10.4 Tool families (17 `from-*.js` + forge + voice = 61 tools)

| Family | Tools (highlights) |
|---|---|
| from-computer | get_time, get_weather, read_file, list_folder, open_folder, write_note, capture_screenshot, launch_app |
| from-pc | screen_look, camera_look, list_windows, focus_window, close_window, ui_elements, ui_click, ui_type, click_at, send_key, ambient_awareness |
| from-spotify | spotify_play, spotify_search, spotify_play_pause/next/previous/volume/status |
| from-browser | browser_navigate, browser_get_text, browser_get_title, browser_screenshot, browser_scroll, browser_go_back, browser_tabs, browser_click, browser_type, browser_evaluate, browser_launch_debug |
| from-dashboard | navigate, close_panel, open_web, capture_idea, kanban_*, pipeline_*, monitor_snapshot, kill_session, read_status, ask_agent, manage_widget |
| from-project / from-mission | start_project, run_mission, mission_status |
| from-system | log_incident, open_artifact, job_status |
| from-gmail / from-calendar | gmail_unread/read/draft/send, compose_email, reminder_add/list/cancel |
| from-memory | remember, recall_memory |
| from-persona / from-skills | persona_status, set_persona_level, use_skill, self_capabilities |
| from-hermes | hermes_task (T3 sidecar delegation) |
| from-widgets | spawn_widget |
| from-forge | build_project, revise_project, project_status |
| voice effector | speak |

---

## 11. The Cortex — the 1-second OODA loop

[mythos/src/core/cortex/index.js](file:///f:/Agent-OS/Agent_OS-main/Agent_OS-main/mythos/src/core/cortex/index.js) (353 lines) + [ooda.js](file:///f:/Agent-OS/Agent_OS-main/Agent_OS-main/mythos/src/core/cortex/ooda.js) (59 lines). Construction is fail-closed: throws without `leash.check` and `effectors.invoke`. Timer is `setInterval(config.MYTHOS_TICK_MS || 1000)`, **unref'd**, with reentrancy guard + generation token.

### 11.1 The tick (verified flow)

```js
async function tickOnce() {
  if (!running || tickOnce._inFlight) return;      // reentrancy guard
  tickOnce._inFlight = true;
  try {
    working.tick++; working.resetTickState(); lastTickAt.value = Date.now();

    // -- OBSERVE --
    var perceptions = working.drainPerceptions();           // fed by the bus bridge (§5.1 step 20)
    if (perceptions.length > MAX_DRAIN_PER_TICK) {          // 50/tick cap
      perceptions.length = MAX_DRAIN_PER_TICK;
      bus.emit('perception.coalesced', { original: perceptions.length });
    }
    bus.emit('tick', { tick: working.tick, perceptions: perceptions.length });

    // -- ORIENT --  (pure arithmetic — NO memory consultation, §24 V1)
    var activeGoal = goals.getActive ? goals.getActive() : null;
    var ranked = ooda.orient(perceptions, activeGoal);
    for (/* rankedSalience > 0.5 */) await memory.episodic.write({ kind: 'perception', ... });

    // -- IDLE CHECK (cost lever #1: zero brain calls on idle ticks) --
    var hasActive = goals.hasActive && goals.hasActive();
    if (perceptions.length === 0 && !hasActive) {
      working.activeGoalId = null;
      var mullFired = false;
      if (shouldMull(working.tick, config)) { await mull(...); mullFired = true; } // tick%300
      if (ooda.shouldReflect(working.tick, config)) reflect(working, memory, bus); // tick%60
      if (!mullFired && ooda.shouldConsolidate(working.tick, config))              // tick%300,
        await memory.consolidate({});                       // staggered: never same tick as mull
      return;
    }

    // -- DECIDE --
    var decision = await decide(ranked, goals, working, brain, memory, config);  // MUST await
    if (!decision) return;                                 // (D-38: un-awaited decide() dispatched
    if (decision._spentTokens) working.addSpend(decision._spentTokens);          //  undefined tool)

    // -- ACT --
    await act(decision, { bus, memory, goals, brain, leash, effectors, config, working, ACTION_TIMEOUT_MS });

    // -- REFLECT / CONSOLIDATE (cadences) --
    if (tickOnce._consecutiveErrors >= 10)   // error escalation path:
      bus.emit('health.diagnosed', { kind: 'cortex-stall', ... });  // → healer restarts cortex
  } finally { tickOnce._inFlight = false; }
}
```

### 11.2 orient — pure arithmetic (verified, ooda.js)

```js
function orient(perceptions, activeGoal) {
  return perceptions.map(function(p) {
    var goalBoost = activeGoal ? goalRelevance(p, activeGoal) * 0.3 : 0;  // keyword-overlap only
    var ranked = Math.min((p.salience || 0) + goalBoost, 1.0);
    return { perception: p, rankedSalience: ranked };
  }).sort((a, b) => b.rankedSalience - a.rankedSalience);
}
```

### 11.3 decide → goals.arbitrate → goals.plan (see §12)

### 11.4 act — ⚠️ THE SHADOW DISPATCH PATH (drift, verified)

Cortex's `act()` does **not** call `dispatchAction` — it carries an inline copy that has **drifted**: no audit write, no `ui.*` relay emits. This is why autonomous actions leave no audit line and autonomous `navigate`/`open_web` never reach the dashboard (§24 W1):

```js
async function act(decision, ctx) {
  // RC#2: pre-flight existence check — a hallucinated tool must fail BEFORE the confirm gate
  if (!effectors.effectors.has(decision.tool)) {
    bus.emit('action.completed', { tool: decision.tool, ok: false,
                                   goalId: working.activeGoalId, reason: 'unknown-effector' });
    return;
  }
  // 1. Leash check — mandatory, fail-closed
  var leashResult = leash.check(decision, { goalId: working.activeGoalId });
  if (!leashResult.allow && leashResult.requireConfirm) {
    var confirmId = leash.confirm.create(summary,
      { decision, goalId: working.activeGoalId, tier: leashResult.tier }, 'system');
    bus.emit('confirm-request', Object.assign({}, decision, { confirmId, summary, tier }));
    return;                                                  // 'system'-scoped: any client may accept
  }
  if (!leashResult.allow) { bus.emit('action.denied', ...); return; }
  // 2. Breaker → 3. invoke → 4. episodic → 5. budget debit → action.completed
  var result = await effectors.invoke(decision.tool, decision.args,
    { signal: AbortSignal.timeout(ACTION_TIMEOUT_MS), bus, goalId: working.activeGoalId });
  await memory.episodic.write({ kind: 'action', channel: 'cortex', ... });
  goals.debitBudget(working.activeGoalId, { tokens: working.spendThisTick, actions: 1 });
  bus.emit('action.completed', { tool: decision.tool, ok: result && result.ok, ... });
  // ✗ MISSING vs dispatchAction: memory.audit.write(...) and the ui.navigate/close-panel/open-web emits
}
```

### 11.5 reflect & mull

- `reflect()` is currently a heartbeat: `bus.emit('reflect', { tick, activeGoalId })` — no outcome analysis (§24 V9).
- `mull()` (every `MYTHOS_MULL_EVERY_TICKS`=300 ticks ≈ 5 min): gathers last-day conversations+events, one `simple`-lane call asking "anything worth mentioning?", stores non-low thoughts as episodic `kind:'thought'` (salience 0.4) + emits `cortex.thought`. Thoughts surface in the next conversation via the server's recall-before-respond. **It cannot act** — no goal proposals (§24 V8). Stagger logic keeps idle ticks to ≤1 brain call.

---

## 12. Goals — arbiter + planner

[mythos/src/core/goals/index.js](file:///f:/Agent-OS/Agent_OS-main/Agent_OS-main/mythos/src/core/goals/index.js) (414 lines). Goals are JSON files in `vault/Goals/<id>.json` (normalized on load — B1). Drives: `user-service 1.0 / maintenance 0.55 / curiosity 0.25`.

### 12.1 The arbiter (verified formula)

```js
var score = driveWeight * 0.3 + priority * 0.3 + urgency * 0.15 +
            budgetHeadroom * 0.1 + salienceBoost * 0.1 + sticky;  // sticky=0.15 anti-thrash
// urgency: deadline <1h → 1.0, <24h → 0.5
// budgetHeadroom: min(tokenHeadroom, actionHeadroom), fraction remaining
// salienceBoost: max rankedSalience of perceptions with keyword relevance >0.3
// D-51: MAX_ACTIVE_GOALS(5) cap applied AFTER sorting by score
```

### 12.2 The planner (verified — and its limits)

```js
async function plan(goal, ctx) {
  // 1. Existing plan steps — return first pending step
  if (goal.plan && goal.plan.length > 0)
    for (...) if (goal.plan[i].status === 'pending')
      return { tool: goal.plan[i].tool, args: goal.plan[i].args, rationale: 'plan-step' };
  // ⚠️ goal.plan is NEVER POPULATED in production — nothing writes steps into it (§24 V2)

  // 2. Procedural recall from Skills store
  var skills = await ctx.memory.skills.recall({ query: goal.title, limit: 1 });
  if (skills.length > 0 && skills[0].score > 0.6 && skill.steps.length > 0)
    return { tool: skill.steps[0].tool, args: skill.steps[0].args,
             rationale: 'procedural-skill', offline: true };
  // ⚠️ executes only steps[0] — multi-step procedures never advance (§24 V2)
  // ⚠️ Skills store is EMPTY in production — recordUse/write have no callers (§24 V3)

  // 3. Budget check BEFORE the brain call (both dimensions; exhausted → paused 'budget-exhausted')

  // 4. One-shot brain call with the REAL tool list (RC#1 anti-hallucination fix)
  var names = Array.from(ctx.effectors.effectors.keys()).filter(n =>
    AUTONOMOUS_EXCLUDED.indexOf(n) === -1 && !healer.isToolSuppressed(n));   // BUG-013
  var result = await ctx.brain.think({ lane: goal.drive === 'user-service' ? 'build' : 'simple',
    messages: [/* toolList + skillsHint + 'Plan next action for goal: …' +
                 'GROUNDING: use web_search/web_fetch FIRST for anything stale…' +
                 'Respond as JSON: {"tool":…, "args":…}' */],
    schemaHint: '{ tool: string, args: object }', source: 'goal:' + goal.id,
    budget: { tokens: remaining, actions: remaining } });
  // RC#1 validation: tool not in registry (or AUTONOMOUS_EXCLUDED) → emit
  // 'planner-hallucinated-tool' anomaly and return null (cortex goes idle) — never dispatch
  return { tool, args, rationale: 'brain-planned', done: false, _spentTokens };
}
```

`AUTONOMOUS_EXCLUDED` (the cortex must never call these — human intake/gates only): `capture_idea, create_goal, kanban_add_card, delete_goal, delete_artifact, navigate, open_artifact, pipeline_advance, kill_session, gmail_send`. **Consequence: the entity cannot mint its own goals — autonomy is human-bootstrapped** (§24 V5).

`debitBudget()` auto-pauses at exhaustion and emits `health.anomaly {kind:'budget-exhausted'}` (healer's `budget-pause` playbook consumes it). `grantTier(id, 3)` records the T3 grant the leash consults.

---

## 13. The voice path

Files: [mythos/src/core/voice/voice-agent.js](file:///f:/Agent-OS/Agent_OS-main/Agent_OS-main/mythos/src/core/voice/voice-agent.js), [mythos/server/index.js](file:///f:/Agent-OS/Agent_OS-main/Agent_OS-main/mythos/server/index.js), `ui/public/js/voice/*`, [mythos/providers/groq-stt.js](file:///f:/Agent-OS/Agent_OS-main/Agent_OS-main/mythos/providers/groq-stt.js), [mythos/services/edge-tts-server.py](file:///f:/Agent-OS/Agent_OS-main/Agent_OS-main/mythos/services/edge-tts-server.py).

Pipeline:

```
browser mic ──VAD (client, VAD_* schema keys)──► WS audio ──► Groq Whisper STT
  ──► handleUtterance (server) ──► conversationGateway.classify()   ← the ONLY gateway
  │                                                                method production uses
  ├─► engagement intent → engagement manager (interview/approve flow)
  └─► conversation intent → voice-agent turn:
        catalog = buildCatalogFromHub(effectors.catalog())   (BUG-017: derived, never hand-copied)
        + spoken-name aliases (e.g. "play some music" → spotify_play)
        → brain.think({ lane:'voice', history }) → optional tool call
        → leash.check → (T3/T4: confirm-request over WS → accept → dispatchAction)
                     → (T0–T2: dispatchAction directly)
        → reply text ──► edge-tts synth (server-side) ──► base64 mp3 ──► browser playback
                       (fallback: browser speechSynthesis when edge-tts is down)
```

- **Barge-in**: new user speech cancels in-flight TTS playback + the current turn (`barge-in-tts-cancel.test.js`).
- **Conversation history** is written to episodic as `kind:'conversation'` — this is what feeds consolidate's user-facts distillation (§8.2). Conversations are **not** routed through the OODA perception queue (voice bypasses the loop — §24 V4).
- **Wake-word** (`WAKEWORD_ENABLED`, default false): `ui/public/js/voice/wakeword.js` runs an ONNX openWakeWord model via `onnxruntime-web`. Models are CC BY-NC-SA, fetched by `scripts/setup-wakeword.js`, **never committed** (.gitignore + THIRD_PARTY_NOTICES). 🔧 BUG-039: coded, not live-verified.
- `VOICE_MAX_SAY_CHARS` (800) chunks long replies; confirm popups use humanized `key: value` args, never raw JSON dumps.

---

## 14. Sensors — the perception producers

All sensors emit `perception.*` (or proactive-speech events) onto the bus; the single bridge subscription in the `sensors` boot step pushes them into working memory. `MYTHOS_IDLE_SALIENCE` (0.3) is the floor.

| Sensor | File | Emits | Notes |
|---|---|---|---|
| timer | sensors/timer.js | tick perceptions at `MYTHOS_TICK_MS` | the heartbeat perception |
| metric | sensors/metric.js | `perception.metric` every 4s | polls immune probes into the OODA queue |
| file | sensors/file.js | `perception.file` | `fs.watch` on `MYTHOS_WATCH_DIRS`, debounced 500ms. ⚠️ the fs.watch handle blocks Windows signal delivery on some Node builds — documented env issue, do NOT "fix" by removing the watch |
| job | sensors/job.js | `perception.job` | build-runner job state changes |
| ws | sensors/ws.js | (external WS ingestion) | `start()` is a no-op until a server owns connections; **`.ingest()` has zero callers — dead path** |
| reminder | sensors/reminder-sensor.js | `reminder.due` every 30s | feeds proactive speech |
| gmail | sensors/gmail-sensor.js | `gmail.unread-batch` | only started when `GOOGLE_REFRESH_TOKEN && GMAIL_TRIAGE_ENABLED`; polls via hub `gmail_unread` every `GMAIL_TRIAGE_POLL_MS` (5min) |
| screen | sensors/screen-sensor.js | screen-description perceptions | **opt-in** (`SCREEN_AWARENESS_ENABLED`, default false). Hash-gated: sha1 of the frame; unchanged screen → zero vision calls. Never persists screenshot bytes — descriptions only. 🔧 BUG-040 coded, unverified |

---

## 15. The immune system

Files in [mythos/src/core/immune/](file:///f:/Agent-OS/Agent_OS-main/Agent_OS-main/mythos/src/core/immune). Constructed in boot step 5 (fail-fast), **before** cortex/goals exist — healer and watchdog receive `getCortex()`/`getGoals()` thunks (the pattern the conversation-gateway fix in §25 Phase 2 copies).

| Component | Role |
|---|---|
| probes | health snapshot (queue depths, breaker states, adapter status) |
| watchdog | polls `cortex.lastTickAt` every `WATCHDOG_MS` (2s); silence > `STALL_MS` (5s) → `health.anomaly {kind:'cortex-stall'}` |
| diagnostician | anomaly → `health.diagnosed` (pattern match) |
| healer | playbooks: cortex restart (via `getCortex()`), `budget-pause`, tool suppression (`isToolSuppressed(name)` — consulted by the goal planner, BUG-013) |
| breakers | per-effector: `BREAKER_FAIL_THRESHOLD` (3) fails within `BREAKER_WINDOW_MS` (30s) → open for `BREAKER_RESET_MS` (15s); hub consults `breakers.allow(name)` before every invoke |
| announcer | speaks breaker/heal lifecycle via `action.speak-requested` → dispatched `speak` effector (never a silent no-op) |
| monitor | crash recovery: `recoverFromCrash()` pauses goals active-at-crash, folds in buildRunner's recovered-failed jobs, emits audited `lifecycle.recovered` |
| explainer (P6) | brain-powered plain-language explanation + safe-menu remedy for anomalies no playbook matches; pure bus subscriber |

⚠️ **Double-speak drift (W6):** both `immune/announcer.js` and `conversation/announcer.js` speak on `health.diagnosed` — the operator hears every diagnosis twice. Fix: conversation/announcer becomes the single speaker for diagnoses; immune/announcer keeps breaker/heal lifecycle only.

---

## 16. The server

[mythos/server/index.js](file:///f:/Agent-OS/Agent_OS-main/Agent_OS-main/mythos/server/index.js) — **1582 lines, ~9 concerns in one file** (the "god-file"). Express 4 + `ws` 8. `createServer(deps)` receives: bus, config, logger, memory, goalsEffector, kanbanEffector, pipelineEffector, effectors, leash, goals, probes, brain, buildRunner, agentActions, checkpoints, forge, reflection, engagementStore, engagementManager, conversationGateway.

- **REST**: `/health` (the only health route — render.yaml's `/api/health` healthCheckPath is wrong), `/api/goals/*`, `/api/kanban/*`, `/api/pipeline/*`, `/api/engagements/*`, `/api/memory/*`, `/api/media` + `/api/media/control`, `/api/forge/*`, `/api/checkpoints/*`, `/api/config/vad`, `/api/builds/*`, `/api/mission/*`, …
- **WS v2**: bus relay to dashboard (tick, `action.*`, `audit.decision`, `confirm-request`, `mission.update`→`mission`, health broadcasts), voice turns, vision/camera streaming, confirm + checkpoint replies, proactive speech push. `verifyClient` does an origin check against `ALLOWED_ORIGINS` (env list — the Render hostname is not in it).
- **Confirm contract**: cortex registers confirms with connectionId sentinel `'system'` (any connected client may accept); voice-originated confirms are scoped to the requesting WS connection. Resolution is always `leash.confirm.accept(confirmId, connectionId)` — never an ad-hoc map.
- **Camera broker**: `serverHandle.requestCameraFrame` is injected into the dashboard wiring as the `camera_look` frame provider (the tool asks a connected browser for a frame).
- ⚠️ **No authentication on any route** (§24 P1). `/api/media/control` calls `effectors.invoke` raw — no leash, no audit (W10). REST mutations (goals/kanban/pipeline/engagements) write with no leash/audit trail (W4).
- Also present: `server/rate-limit.js`, `server/news-feed.js`.

---

## 17. Adapters (the body)

| Adapter | Path | What it is |
|---|---|---|
| pc-child | `adapters/pc-child/` | Persistent PowerShell daemon, JSON-RPC over stdio. Drives UIA tree walks (`ui_elements`), window ops, keystrokes, screenshots, SMTC media, `ps-automation.ps1`. BUG-038 fix: forces UTF-8 — OEM codepages corrupted its JSON output. Spawns unconditionally at boot (breaks Linux containers — P6) |
| browser-agent | `adapters/browser-agent/` | `playwright-core`. CDP-connect to the operator's Chrome (`BROWSER_CDP_URL`, :9222) first; launches Chrome/Edge **on demand only** (auto-launch steals the Windows mic). `browser_evaluate` is T4. BUG-029: orphan browser processes — pidfile mitigation in place, proper tree-kill fix pending |
| cua-driver | `adapters/cua-driver/` | Optional native sidecar for element-addressed desktop clicks. Spawn-ENOENT is caught internally → status stays OFFLINE → spotify falls back to the UIA/keystroke path (honest-inert). BUG-026 verified: Spotify plays through it |
| hermes-agent | `adapters/hermes-agent/` | Task sidecar; `hermes_task` is T3 because it runs real commands |
| google | `adapters/google/` | Gmail + Calendar over OAuth refresh token. Setup: `scripts/google-auth.js`. Without creds everything degrades honestly (BUG-024 needs the operator's OAuth pass) |

---

## 18. The engagement layer (and what's missing on main)

Files: [mythos/src/core/engagements/](file:///f:/Agent-OS/Agent_OS-main/Agent_OS-main/mythos/src/core/engagements). 12-state machine: `DRAFT → INTERVIEWING → SPEC_READY → PLAN_READY → AWAITING_APPROVAL → EXECUTING → VERIFYING → COMPLETED` (+ `BLOCKED`, `FAILED`, `CANCELLED`, `PAUSED`). Config: `ENGAGEMENT_TTL_MS` (7d), `ENGAGEMENT_MAX_REPAIRS` (3), `ENGAGEMENT_INTERVIEW_MAX_Q` (5), `ENGAGEMENT_MAX_STAGES` (10).

**Main's reality (verified):**
- `interview.js`: 5 hardcoded questions. `spec-builder.js` / `plan-builder.js`: string templates (3 canned stages).
- `events.js`: 16 spec-conformant event builders — **used only by tests**.
- `index.js` emits inline events with **fabricated stub payloads** (verified):

```js
case 'SPEC_READY':
  bus.emit('engagement.spec_ready', { engagementId,
    spec: { markdown: 'Spec generated', schema: {} }, timestamp: Date.now() });  // ← stub
  break;
case 'PLAN_READY':
  bus.emit('engagement.plan_ready', { engagementId,
    plan: { stages: [] }, timestamp: Date.now() });                              // ← empty stages
  break;
case 'AWAITING_APPROVAL':
  bus.emit('engagement.approval_requested', { engagementId,
    plan: { stages: [] }, timestamp: Date.now() });
  break;
```

- **There is no `executor.js` on main.** Nothing dispatches action stages; nothing emits `stageComplete`/`stageFailed` in production. The pipeline is interview→spec→plan *theater* until the stranded engine lands.
- The stranded engine lives on branch `phase1/engagement-execution-engine` (`8706ccc`): `executor.js`, 16 event builders wired, REST wiring. Its invariants (keep when porting): action stages route through `dispatchAction` **only**; dispatch ctx sets `effectors: null` (executor must not bypass); hard-throw if dispatchAction missing; command stages honestly SKIPPED until a sandboxed runner exists (§25 Phase 3).

---

## 19. The UI — JARVIS HUD

`mythos/ui/public/` — **zero-build vanilla JS** (ES modules), no framework, no runtime CDN (hard constraint). Orb 2.0 home, dashboard views (goals, kanban, pipeline, audit live-tail via `audit.decision`, health, engagements, builds, missions), floating widgets (`spawn_widget` renders a validated data-only spec — never raw HTML/JS; `manage_widget` state lives in browser localStorage), camera/mic capture, hand-gesture confirm (MediaPipe `@mediapipe/tasks-vision`), voice loop with client VAD, optional wake-word. All server push arrives over the single WS.

---

## 20. The vault — the entity's persistent self

`MYTHOS_VAULT_ROOT` (default `./vault`, i.e. `mythos/vault/`):

```
vault/
├── Episodic/YYYY-MM-DD.jsonl     every perception >0.5, action outcomes, conversations, thoughts
├── Semantic/<topic>.md           durable facts (user-facts.md, consolidated-<ts>.md)
├── Skills/*.md                   procedures + successRate   (EMPTY in production — see V3)
├── Identity/self.md              WHO THE ENTITY IS — human-editable only
│   ├── boundaries.md             absolute DENY rules — can only tighten autonomy
│   ├── persona.json              personality dials (set_persona_level writes here)
│   └── capabilities.md           boot-generated tool/adapter manifest (P5)
├── Audit/YYYY-MM-DD.jsonl        every leash decision + dispatchAction outcome
├── Checkpoints/                  working-memory snapshots (every 50 ticks + shutdown)
├── Goals/<id>.json               goal records
├── Engagements/                  engagement records
├── builds/projects/              Forge output — the ONLY tree builds may write (sandbox)
├── Plans/  Incidents/  Goals.md  bridges & logs
└── Index/                        vector indexes (episodic + semantic)
```

**No persistent volume is configured for Render** — every redeploy wipes all of this (P3).

---

## 21. The JARVIS wave — module inventory (on main, beyond the old docs)

| Module | File | Status |
|---|---|---|
| Boot greeting / personality | identity/persona + `BOOT_GREETING` (env-bypass key) | live |
| Skill packs | skills/loader.js + `skills.allowlist` (16 allowed; 5 vendored in `mythos/skills/`: caveman, karpathy-guidelines, ponytail, taste-frontend, ui-ux-pro-max; rest resolve from `~/.zcode/skills/`). `refresh()` reports missing packs honestly at boot | live; `use_skill` T0 |
| Learning loop | identity/reflection.js — extracts operator preferences/style from conversation episodics every ~15 turns (`REFLECTION_EVERY_TURNS`, env-bypass) + final pass at shutdown | live |
| Version context | identity/version.js — `MYTHOS vX.Y` line in persona prompts; `version.refresh()` after code updates | live |
| Capabilities manifest | identity/capabilities.js — answers "what can you do" from the live hub catalog | live (`self_capabilities` T0) |
| hermes sidecar | adapters/hermes-agent + from-hermes | live, T3 |
| Wake-word | ui wakeword.js + onnxruntime-web | opt-in, 🔧 BUG-039 unverified |
| Ambient screen awareness | sensors/screen-sensor.js + `ambient_awareness` tool | opt-in, 🔧 BUG-040 unverified |
| Daily planner | planner/daily.js + `daily_plan` tool — morning brief (9h), stall check-ins (3h), evening review (21h); `PLANNER_ENABLED` default true | 🔧 BUG-041 unverified |
| Orb 2.0 HUD | ui/public | live |
| Risk-tiered auto-approval | effectors/risk-classifier.js (feeds pipeline classifier) | live |
| Credential scanner | effectors/credential-scanner.js — redacted secret-pattern scan of T3/T4 args before execution | live (leash step 4) |
| Evidence validator | effectors/evidence-validator.js — external ship gate for agent-actions | live |
| Forge (P22) | effectors/forge/ + leash/checkpoints.js — multi-file agentic builds into `vault/builds/`, approval gates with TTL+sweep | live (`build_project`/`revise_project` T2, `project_status` T0) |
| Build verifier | design/verify.js — brain-driven verification in build-runner | live |
| Assistant gateway | assistant/gateway.js — intent classify → engagement vs cortex | **only `classify()` is used** (server L1087) |
| assistant/{intent-router, response-planner, style, summary} | assistant/ | **DEAD** (~470 lines, required only by tests) |
| Immune explainer (P6) | immune/explainer.js | live |
| Conversation announcer | conversation/announcer.js — proactive speech (mull thoughts, reminders, gmail) | live (but see W6 double-speak) |
| web_search / web_fetch | effectors/web-search.js, web-fetch.js | live, T0 (research gate for builds) |
| MCP server (Item 10) | mcp/server.js — hand-rolled JSON-RPC 2.0 stdio exposing the tool catalog | opt-in (`MCP_SERVER_ENABLED` false) |
| memory/daily-note.js | memory/ | **DEAD** (zero imports) |
| providers/claude-cli.js | providers/ | **DEAD** |

---

## 22. The config system

[mythos/src/core/config/schema.js](file:///f:/Agent-OS/Agent_OS-main/Agent_OS-main/mythos/src/core/config/schema.js) — every key has `{type, default, min?, max?, enum?, bool?}`; `loadConfig()` coerces + validates and **exits 1** on errors. Highlights (all verified): `MYTHOS_PORT 4478`, `MYTHOS_BIND 127.0.0.1`, `MYTHOS_TICK_MS 1000`, `AUTONOMOUS_MAX_TIER 2`, `GOAL_TOKEN_BUDGET 20000`, `GOAL_ACTION_BUDGET 25`, `MAX_ACTIVE_GOALS 5`, `REFLECT_EVERY 60`, `CONSOLIDATE_EVERY 300`, `EPISODIC_RETENTION_DAYS 30`, `CHAIN_COOLDOWN_MS 60000`, `ACTION_TIMEOUT_MS 30000`, `STALL_MS 5000`, `WATCHDOG_MS 2000`, `BREAKER_* 3/30000/15000`, `CHECKPOINT_EVERY_TICKS 50`, `SHUTDOWN_MS 10000`, `BUS_HISTORY_SIZE 500`, `BUS_STORM_MAX 400`, `MYTHOS_MULL_EVERY_TICKS 300`, `VOICE_MAX_SAY_CHARS 800`, `LEASH_CONFIRM_TTL_MS 30000`, `MYTHOS_BUILD_CONCURRENCY 3`, `BROWSER_CDP_URL http://127.0.0.1:9222`, `ENGAGEMENT_*`, `FORGE_MAX_FILES 12 / FORGE_FILE_RETRY 2 / FORGE_CONCURRENCY 2`, `CHECKPOINT_TTL_MS 1800000 / CHECKPOINT_SWEEP_MS 60000`, VAD_* (0.035/0.06/3/1800), `WAKEWORD_*` (off), `SCREEN_AWARENESS_*` (off), `PLANNER_*` (on), `GMAIL_TRIAGE_*` (on, 5min), `MCP_SERVER_ENABLED` (off), provider API keys, Google OAuth keys.

**Drift (W8):** ~30 env keys bypass the schema entirely (read via `process.env` in code): `CHAIN_ATTEMPT_TIMEOUT_MS`, `VOICE_OLLAMA_KEEP_ALIVE` (verified in chain.js), `HERMES_*`, `EDGE_TTS_*`, provider URL/MODEL passthroughs, `BOOT_GREETING`, `REFLECTION_EVERY_TURNS`, `IMMUNE_EXPLAIN`, `ALLOWED_ORIGINS`, … And ~22 schema keys are undocumented in `.env.example` (MCP_SERVER_ENABLED, FORGE_*, GMAIL_TRIAGE_*, VAD_*, CHECKPOINT_*, …). Consolidation = move bypass keys into schema, document the rest.

---

## 23. Tests

- Run: `cd mythos && node --test` (all), `node --test test/<file>` (one).
- Framework: `node:test` + `test/helpers.js` (in-memory fakes for fs/config/brain that mirror schema guarantees).
- **Tripwires that must stay green and must only be updated as the LAST step of a feature change**: effector count gate (61), event-name allowlist, tier-table parity, identity-boundaries contracts.
- Chaos suite (`chaos-*.test.js`): disk-full, memory-corrupt, provider-killed, restart-mid-action, concurrent-tick — the honest-inert guarantees live here.
- Conventions: no network in unit tests; brain is always faked; timers unref'd; tests must not depend on wall-clock cadence.

---

## 24. The anti-drift rulebook — invariants & standing constraints

### 24.1 The ten invariants (violating any of these IS the drift we're cleaning up)

1. **dispatchAction is the only action path.** Breaker → invoke → episodic → budget debit → `action.completed` → audit → UI relays. ⚠️ *Currently violated by cortex `act()` (W1) and `/api/media/control` (W10).*
2. **Tier-table 3-source parity**: `leash/tiers.js` ⇔ `MYTHOS-ARCHITECTURE.md` §9 ⇔ handoff docs. Change all three together or don't change.
3. **`danger: true` ⇔ tier ≥ 3.** The adapter and the table must agree.
4. **Events via builders + allowlist conformance.** New event names update `event-name-conformance.test.js` in the same change. (Engagements currently emits inline with stub payloads — W7.)
5. **Path-traversal guards** in fs-store and every file-touching tool. Builds write only inside `vault/builds/`.
6. **Identity files are human-editable only.** The entity never rewrites `self.md`/`boundaries.md` (persona dials + generated capabilities manifest are the sanctioned exceptions).
7. **Fail-closed everywhere**: unknown tool → T3; audit unwritable → deny T≥3; `createCortex`/`createLeash` throw on missing deps; `dangerWhen` can only raise tier.
8. **Honest-inert**: unavailable = OFFLINE/DEGRADED, reported. Never fabricate success, never silently skip.
9. **No secrets** in code, logs, or LLM-bound payloads (credential scanner enforces at the leash).
10. **Human gates for destructive/outward actions**: T3 confirm-once-per-goal, T4 always-confirm, `AUTONOMOUS_EXCLUDED` for intake/gates.

### 24.2 Standing constraints (operator's house rules)

- All real files on the **F: drive**. **No git push** — the operator reviews and pushes.
- **Ponytail-minimal diffs**: change only what the task requires; no drive-by refactors. (Sanctioned exceptions in §25: the executor port and the gated server decomposition.)
- Dependencies: **MIT/Apache-2.0 only**, recorded in `THIRD_PARTY_NOTICES.md`. No runtime CDN in the UI.
- CommonJS in `src/`+`server/`; ES modules only in `ui/public/`; **no build step**.
- Read config **live** (`config.X` at call time, never cached at construction) — D-46 class bug.
- All timers/intervals **`unref()`'d**; the process must never be held open by a loop.
- Every child process spawn must tolerate ENOENT and report OFFLINE (honest-inert).
- New brain calls must respect the idle-skip principle (zero cost when idle).

---

## 25. The verified gap & drift register

### W — Wiring gaps (architecture)

| ID | Finding | Evidence |
|---|---|---|
| W1 | Cortex `act()` is a shadow dispatch path: no audit write, no `ui.navigate/close-panel/open-web` relays. Autonomous actions leave no audit line; autonomous UI actions never reach the dashboard | cortex/index.js act() vs effectors/dispatch-action.js (both quoted above) |
| W2 | **Tier laundering**: T2 `spotify_play` internally invokes T3 tools (`ui_click`, `ui_type`, `click_at`) via raw `pcEffectors.invoke(name, args, {})` — no leash, no audit, no goal context | from-spotify.js: `pcEffectors.invoke('ui_click', { pid, elementPath }, {})` etc. (14 call sites) |
| W3 | `gmailUnread = hub.invoke('gmail_unread', …)` — breaker-gated but no leash check | main.js leash step |
| W4 | REST mutations (goals/kanban/pipeline/engagements) write with no audit entries; destructive routes unguarded | server/index.js |
| W5 | Boot-order bug: `conversation-gateway` constructed with `cortex === null` (cortex is step 19, gateway is step 12) → its cortex-fallback route is permanently dead | main.js step order |
| W6 | Double announcer: `health.diagnosed` triggers two spoken alerts (immune/announcer + conversation/announcer) | immune/announcer.js, conversation/announcer.js |
| W7 | Engagements emit inline with fabricated stub payloads (`markdown:'Spec generated'`, `plan:{stages:[]}`); the 16 conformant builders in events.js are test-only | engagements/index.js (quoted §18) |
| W8 | Config drift: ~30 env keys bypass schema; ~22 schema keys undocumented in .env.example | §22 |
| W9 | server/index.js is a 1582-line god-file (~9 concerns) | §16 |
| W10 | `/api/media/control` invokes effectors raw — no leash, no audit | server/index.js |

### V — Vision gaps (autonomy vs. the JARVIS intent)

| ID | Finding |
|---|---|
| V1 | `orient()` is pure arithmetic — zero memory consultation on the autonomous path; `recallHybrid` has only 2 production callers (utterance path + `recall_memory` tool), never the OODA loop |
| V2 | `plan()` is one-shot (single `{tool,args}` per tick); `goal.plan` steps are never populated in production; Skills procedures execute only `steps[0]` |
| V3 | **No execution→learning loop**: `skills.recordUse()` and `skills.write` have zero production callers → the Skills store stays empty → procedural recall never fires → the entity cannot improve at tasks it has done before. This is the deepest cut |
| V4 | Voice bypasses the OODA loop entirely (server-driven turns; conversations aren't perceptions) |
| V5 | Autonomy is human-bootstrapped: `AUTONOMOUS_EXCLUDED` blocks `create_goal`, and no perception→goal-proposal path exists → "doesn't wait for commands" is structurally false today |
| V6 | Engagement pipeline has no executor on main (interview→spec→plan templates, zero production dispatch) |
| V7 | Build verification is parse/brain-review only — no sandboxed command runner, so "verify" can't run tests (engagement VERIFYING + Forge validation both blocked on this) |
| V8 | `mull()` can think but cannot act — thoughts never become goal proposals |
| V9 | `reflect()` is a heartbeat emit, not outcome analysis |
| V10 | `consolidate()` writes `consolidated-<ts>` blobs with no dedup/merge and no contradiction handling |

### P — Production/security gaps

| ID | Finding |
|---|---|
| P1 | **CRITICAL**: no authentication on any REST route or WS; `render.yaml` binds `0.0.0.0` → the entire control plane (including T3 confirms, builds, Gmail) would be public. Fix before any deploy: `MYTHOS_AUTH_TOKEN` bearer on `/api/*` + WS token; boot warns when non-loopback without a token |
| P2 | render.yaml `healthCheckPath: /api/health` — real route is `/health` → deploys flap |
| P3 | No persistent vault volume on Render → every redeploy wipes memory/goals/audit |
| P4 | `ALLOWED_ORIGINS` doesn't include the Render hostname → WS origin check rejects the deployed UI |
| P5 | Effector count drift: docs claim 68, enforced gate is 61 |
| P6 | pc-child (PowerShell) spawns unconditionally → Linux containers can't boot clean; gate on `os.platform()==='win32'` |

### D — Dead code (decide: wire or delete; suite must stay green)

daily-note.js (zero imports) · assistant/{intent-router, response-planner, style, summary} (~470 lines, test-only) · providers/claude-cli.js · ws-sensor `.ingest()` · orphan `conversation.intent` event (no subscribers) · abtop tools (deliberately honest-inert — keep as-is until a dashboard owns them).

---

## 26. The agreed upgrade plan (phases)

**Prime directive:** keep what works. Full `node --test` green after every change; work lands on feature branches; `main` only fast-forwards on green; honest-inert preserved; no push.

- **Phase 0 — Safety net**: baseline suite run; `backup/main-pre-upgrade` branch; verify dangling commits recoverable (`git cat-file`).
- **Phase 1 — Git reconciliation** (branch `merge/engagement-executor`): cherry-pick `614edb6` (voice alias fix — check main's BUG-037 handling first), `8706ccc` (executor port honoring the invariants in §18), `4682f7c` (docs-gen + exceljs/pptxgenjs, both MIT → package.json + NOTICES + tier parity), `dab6e53` (desktop — main's BUG-031/038 fixes win conflicts), `1b79321` (browser), then gap-fix commits `afcd593/d4b2a55/7da9746/a5ab889` (keep main's BUG-039..041 numbering). Update the count gate + event allowlist last. Leave `origin/jarvis-p21-p24` (superseded).
- **Phase 2 — Wiring integrity** (lowest-risk first, each with a regression test): fold audit+UI relays into dispatch-action.js then point cortex `act()` at it (W1, W10); close tier-laundering by threading leash context/audit into from-spotify inner invokes + gmailUnread (W2, W3); audit REST mutations (W4); gateway `getCortex()` thunk (W5); single-speaker announcer (W6); engagements emit via events.js builders with real payloads (W7); config consolidation (W8); dead-code decisions (D); **gated**: extract `server/routes/*.js` factories from the god-file (W9).
- **Phase 3 — Verification & gap closure**: new T3 `run_command` effector (allowlist, cwd pinned to project/vault, timeout, audited — v1 is allowlist+timeout, not a full sandbox) wired into the engagement executor + Forge (V7); operator-assisted live verification of BUG-039/040/041, barge-in, BUG-020/014/027/028/006; BUG-029 proper fix (kill only launched-mode browser trees, never CDP-attached user Chrome); BUG-036/SMTC re-verify; BUG-024 OAuth docs.
- **Phase 4 — Autonomy advancement** (biggest leverage first, all respecting idle-skip): execution→learning loop — `skills.recordUse()` in the dispatchAction completion path; goal-completion/consolidate-time procedure distillation into Skills (one bounded brain call); `plan()` consults procedures with real successRate, executes multi-step procedures, persists brain plans into `goal.plan` (V2, V3); memory on the autonomous path — orient→recallHybrid for high-salience perceptions with per-tick cache; hybrid skill recall; consolidate dedup/contradiction (V1, V10); proactivity that acts — `mull()` → `propose_goal` suggestions for one-tap acceptance (human-confirmed autonomy, respecting AUTONOMOUS_EXCLUDED), calendar-event perception, opt-in active-window sensor (V5, V8); `reflect()` analyzes last-N outcomes → recurring failures to diagnostician, successes to Skills (V9); brain-driven interview/spec/plan with template fallback (V6 cognition).
- **Phase 5 — Production & docs**: `MYTHOS_AUTH_TOKEN` (P1); render.yaml health path + ALLOWED_ORIGINS + persistent vault disk (P2–P4); platform-gate pc-child/browser-agent (P6); docs re-sync (rewrite the handoff against main, ROADMAP append, BUGS prune, §9 parity, P5); NOVA `app/` stays in place by default (archiving is an explicit operator decision).

---

## 27. Quickstart — your first hour

1. `cd f:\Agent-OS\Agent_OS-main\Agent_OS-main` → `git log --oneline -5` (expect `685dbaa` on main), `git status` (expect clean).
2. `cd mythos && node --test` — establish the green baseline before touching anything.
3. Read in this order: `src/main.js` (wiring), `src/core/effectors/dispatch-action.js` (the action invariant), `src/core/leash/tiers.js` + `leash/index.js` (the gate), `src/core/cortex/index.js` (the loop), `src/core/goals/index.js` (arbitration/planning), `src/core/brain/chain.js` (failover).
4. Boot it: `node src/main.js` → expect `MYTHOS ALIVE`; open `http://127.0.0.1:4478`. Verify honest degradation: with no API keys configured, brain calls return `offline:true` and the UI says so.
5. Before any change: re-read §24 (rulebook). After any change: full suite. Update tripwires (effector count, event allowlist) only as the final step.
6. If you need the engagement executor, docs-gen, or the desktop/browser expansions: they are NOT on main — recover from `phase1/engagement-execution-engine` / the dangling commits listed in §2.1, per §26 Phase 1.

*End of handoff. This document supersedes HANDOFF-FOR-KIMI.md and HANDOFF-INTELLIGENCE-UPGRADE.md where they conflict.*
