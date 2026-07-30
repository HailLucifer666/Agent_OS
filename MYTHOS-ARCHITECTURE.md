# MYTHOS — Autonomous Entity Architecture

> STATUS: v1 — ground truth verified against GitHub `HailLucifer666/Agent_OS` @ `a0433b5` (2026-07-08).
> BASELINE COMMIT: `a0433b5 feat: nova jarvis assistant (phases A-E) + bug fixes`

---

## ⚠️ MANDATORY SYNC FILES — UPDATE ON EVERY PUSH

The following files **MUST** be updated and committed alongside every phase gate push.
No phase is considered complete until both files reflect the current state.

| File | Action | Location |
|---|---|---|
| `mythos/ROADMAP.md` | Mark phase ✅ Done, update test count, append commit SHA to log | `mythos/ROADMAP.md` |
| `graphify-out/graph.html` | Regenerate with new MYTHOS nodes/edges for completed phase | `graphify-out/graphify-out/graph.html` |

**Procedure for every phase completion:**
1. Run `npm test` — must be green
2. Update `mythos/ROADMAP.md`: flip phase status to ✅ Done, update test count in Progress table, add commit to Commit Log
3. Regenerate `graphify-out/graph.html`: add new module nodes + dependency edges for the phase (use `mythos/.graph-data.json` as source, merge into existing NOVA data with community ID offset +50)
4. `git add -f graphify-out/graph.html mythos/ROADMAP.md`
5. Commit and push together

**Skipping this step blocks the phase gate.**

---

## §1 Vision & Entity Principles

NOVA is a request→respond agent dashboard: the user asks, the system answers. MYTHOS evolves NOVA 100× into a **continuous autonomous entity** — an always-on cognitive loop that perceives, reasons, acts, and self-heals without a human in the loop for every decision.

### Entity vs Agent

| Property | NOVA (Agent) | MYTHOS (Entity) |
|----------|-------------|-----------------|
| Trigger | User request | OODA cognitive loop (1s tick) |
| Cognition | On-demand chain walk | Continuous cortex tick |
| Memory | Vault files + in-session intake | Layered persistent memory + WorkingMemory |
| Safety | Danger flag → confirm dialog | Tiered autonomy + audit trail + immune system |
| Failure mode | Return error, user retries | Self-diagnose, self-heal, degrade gracefully |
| Idle state | No work, no cost | Idle tick skips Brain entirely (cost lever #1) |

### Core Principles

1. **Honest-Inert**: Never fake success. If a provider is down, say so. If a job crashes, mark it failed. If memory is corrupt, fallback + checkpoint restore.
2. **Audit Everything**: Every tier ≥3 action writes an audit line before executing. Audit unwritable = action denied (fail-closed).
3. **Cost Discipline**: Idle ticks call zero LLM APIs. Breakers stop hammering dead providers. Budget caps halt runaway goals.
4. **Human Sovereignty**: Identity boundaries are human-editable, entity has no write path. Tier-4 actions always require confirmation. `MYTHOS_DRY_RUN=1` makes all T≥1 actions logged no-ops.
5. **Testable by Isolation**: Every module takes `bus` + `config` via injection. Fake bus in unit tests. `VAULT_ROOT` read live per call for test isolation.
6. **Zero New Dependencies**: Same 4 npm deps as NOVA — `dotenv`, `express`, `ws`, `playwright-core`. Vanilla JS CommonJS. `node:test` + `node:assert/strict`.

### Naming

`MYTHOS_NAME` is configurable (env var, default `"MYTHOS"`). The working title is provisional. All code references `config.MYTHOS_NAME` — never hardcoded.

---

## §2 Baseline & Ground Truth

### GitHub State

- **Repo**: `HailLucifer666/Agent_OS`
- **Commit**: `a0433b5` (pushed 2026-07-08 20:24 UTC)
- **Message**: `feat: nova jarvis assistant (phases A-E) + bug fixes`
- **Deps** (exact 4): `dotenv@^16.4.5`, `express@^4.19.2`, `playwright-core@^1.61.1`, `ws@^8.17.0`
- **Tests**: 27 files, `node --test` runner, `test-helpers.tempVaultDir()` + `VAULT_ROOT`-before-require isolation

### Subsystem Map (post-Jarvis)

```
app/
├── server.js              (1533 lines — WS, REST, CORS, shutdown)
├── lib/
│   ├── models/
│   │   ├── registry.js    (218 lines — brain-lane routing, alive-only probing)
│   │   └── chain.js       (110 lines — ranked fallback walk, cooldown, key rotation)
│   ├── providers/         (~20 modules — openai-compat factory + per-provider)
│   │   └── openai-compat.js (136 lines — factory: {chat, isAvailable, getStatus, getModel})
│   ├── reasoning.js       (55 lines — orchestrator engine picker, absorbed by MYTHOS Brain)
│   ├── probes.js           (status aggregation, 4s heartbeat)
│   ├── quota.js            (per-provider daily estimates, isEstimate:true)
│   ├── rate-limit.js       (fixed-window limiter, global 240/min, expensive 8/min)
│   ├── activity-log.js     (ring buffer 200, vault aggregates, ~4 chars/tok estimate)
│   ├── orchestrator.js     (136 lines — enqueue→pump, CONCURRENCY=1, jobs.json)
│   ├── pipeline.js         (4 stages: capture→human-gate→execute→shipped)
│   ├── kanban.js           (lanes: backlog→building→review→done)
│   ├── goals.js            (Goals.md checkbox list, positional IDs)
│   ├── vault.js            (83 lines — vaultRoot(), readText/writeText/readJSON/writeJSON)
│   ├── logger.js           (73 lines — structured JSON lines, LOG_LEVEL threshold)
│   ├── confirm.js          (65 lines — crypto UUID, 30s TTL, connection-scoped)
│   ├── agent-actions.js    (shared enqueue for pipeline/kanban actions)
│   └── voice/
│       ├── voice-agent.js  (318 lines — JSON tool-calling loop, MAX_ITERATIONS 4)
│       ├── tools-dashboard.js (21 tools)
│       ├── tools-computer.js  (4 tools, VOICE_ALLOWED_DIRS sandbox)
│       ├── tools-pc.js       (10 tools, pc-child delegate)
│       ├── tools-browser.js  (10 tools, playwright-core CDP)
│       ├── tools-project.js  (1 tool — start_project auto-pipeline)
│       ├── intake.js        (connection-scoped multi-turn, 10min TTL, 12 turns)
│       └── checkpoint-announcer.js (job-stage TTS broadcasts)
├── services/               (s2s, pc-child, browser-agent — WRAP untouched)
├── public/                 (vanilla SPA: hash router, 23 routes, tokens.css)
│   ├── js/
│   │   ├── router.js       (hash→dynamic import, render(mountEl)→cleanup)
│   │   ├── ws.js           (reqId request-response + onBroadcast, auto-reconnect)
│   │   └── shell.js        (sidebar + header + status pill)
│   └── css/
│       └── tokens.css      (240 lines — Jarvis theme, --gold #4fd8ff, --bg #05080f)
└── vault/                  (Episodic/Semantic/Skills/Goals/Pipeline/Kanban/builds)
```

### 45 Tools (Total)

| Catalog | Count | Tools |
|---------|-------|-------|
| tools-dashboard | 21 | navigate, open_artifact, read_status, job_status, create_goal, list_goals, toggle_goal, delete_goal, capture_idea, pipeline_status, pipeline_advance, pipeline_execute, kanban_status, kanban_add_card, kanban_move_card, kanban_assemble, kanban_build_card, ask_agent, monitor_snapshot, kill_session |
| tools-computer | 4 | open_folder, list_folder, read_file, compose_email |
| tools-pc | 10 | launch_app, list_windows, focus_window, close_window, media_key, screen_look, ui_elements, ui_click, ui_type, write_note |
| tools-browser | 10 | browser_navigate, browser_click, browser_type, browser_screenshot, browser_get_title, browser_get_text, browser_scroll, browser_tabs, browser_go_back, browser_evaluate |
| tools-project | 1 | start_project |

### Provider Interface (Canonical)

```js
// app/lib/providers/openai-compat.js:136
{ name, chat(messages, opts), isAvailable(), getStatus(), getModel() }
```

### Brain Lanes (Locked 2026-07-08, all HTTP-200 verified)

```
VOICE  → Groq llama-3.3-70b → Mistral large-2512 → Ollama qwen3:8b
BUILD  → Mistral large-2512 → NIM GLM-5.2 → Ollama ornith:9b
SIMPLE → Ollama qwen3:8b
VISION → Ollama qwen3.5 → Ollama qwen2.5vl:7b
```

### Frontend Conventions

- Hash router → dynamic `import('/js/views/{route}.js')`, each view exports `async render(mountEl) → cleanup`
- WS client: `nextReqId` Map + `onBroadcast(type, fn)` fallthrough, auto-reconnect 500ms→8s
- Design tokens: `--bg #05080f`, `--gold #4fd8ff`, `--status-ok #43e5a0`, `--status-degraded #eab308`
- 23 CSS files, orb-overlay persistent assistant

---

## §3 System Overview

### Six Layers

```
┌─────────────────────────────────────────────────────┐
│                   SERVER & UI v2                     │  Express + WS on :4478
├─────────────────────────────────────────────────────┤
│                   IDENTITY                           │  self.md / boundaries.md
├─────────────────────────────────────────────────────┤
│  SENSORS  ←→  BUS  ←→  EFFECTORS                    │  5 sensors, 45 effectors
├─────────────────────────────────────────────────────┤
│               CORTEX (OODA Loop)                     │  1s tick, generation guard
├─────────────────────────────────────────────────────┤
│  GOALS  │  BRAIN  │  LEASH  │  IMMUNE               │  Cognition subsystems
├─────────────────────────────────────────────────────┤
│               MEMORY (5 stores)                       │  Episodic, Semantic, Skills,
│                                                      │  Identity, Audit
├─────────────────────────────────────────────────────┤
│  CONFIG  │  BUS  │  LIFECYCLE  │  LOGGER            │  Foundation
└─────────────────────────────────────────────────────┘
```

### Wiring Rule

Modules never call across layer boundaries directly — **publish/subscribe on bus**. Exceptions:
- Everyone gets `bus` + `config` injected at construction.
- Cortex holds direct refs to `memory`, `goals`, `brain`, `leash`, `effectors` (it IS the orchestrating layer).
- Every leaf module testable with a fake bus.

### Full OODA Cycle (ASCII)

```
                  ┌─────────────┐
          timer   │             │  perception
       ─────────►│   OBSERVE   │◄───── file, ws, job, metric sensors
                  │             │
                  └──────┬──────┘
                         │
                  ┌──────▼──────┐
                  │   ORIENT    │  rank salience vs goals + drives
                  │             │  high-salience → episodic record
                  └──────┬──────┘
                         │
                  ┌──────▼──────┐
                  │   DECIDE    │  arbiter: weighted score + hysteresis
                  │             │  planner: procedural recall first,
                  │             │  else Brain call
                  └──────┬──────┘
                         │
                  ┌──────▼──────┐
                  │    ACT      │  leash.check → breaker.allow
                  │             │  dispatch w/ AbortSignal + timeout
                  │             │  confirm path pauses action
                  └──────┬──────┘
                         │
                  ┌──────▼──────┐
                  │  REFLECT    │  every REFLECT_EVERY ticks
                  │             │  consolidate every CONSOLIDATE_EVERY
                  └─────────────┘

    traceId ──────────────────────────────────────────────────►
    (root of causal chain, propagated through all events)
```

---

## §4 Event Bus

### Event Envelope

```js
// src/core/bus/event.js
class Event {
  constructor(type, payload, { cause, source } = {}) {
    this.id = `evt-${Date.now()}-${base36()}`;   // base36 ~7 chars
    this.type = type;                              // dot-namespaced
    this.channel = type[0];                        // perception|decision|action|health|memory|lifecycle|audit|identity
    this.payload = payload;
    this.ts = Date.now();
    this.source = source || 'unknown';
    this.causeId = cause?.id || null;
    this.traceId = cause?.traceId || this.id;      // root of causal chain
    this.depth = (cause?.depth || 0) + 1;
    this.seq = 0;                                  // assigned by bus
  }
}

function Event(type, payload, opts) {
  const e = Object.create(null);
  e.id = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  e.type = type;
  e.channel = type.split('.')[0];  // first segment
  e.payload = payload;
  e.ts = Date.now();
  e.source = opts?.source || 'unknown';
  e.causeId = opts?.cause?.id || null;
  e.traceId = opts?.cause?.traceId || e.id;
  e.depth = (opts?.cause?.depth || 0) + 1;
  e.seq = 0;
  return e;
}
```

### Bus API

```js
// src/core/bus/index.js
function createBus({ historySize = 500, maxDepth = 32, storm = { windowMs: 1000, maxPerWindow: 400 } } = {}) {
  const subs = new Map();         // pattern → Set<handler>
  const history = [];             // ring buffer, historySize cap
  const mw = [];                  // sync middleware chain
  let seq = 0;
  let stormWindow = [];          // timestamps for storm detection

  return {
    publish(event) {
      // 1. Run middleware (null drops event)
      let e = event;
      for (const m of mw) { e = m(e); if (!e) return; }

      // 2. Causal depth guard
      if (e.depth > maxDepth) {
        return safeEmit(Event('health.anomaly', { kind: 'causal-loop', event: e.id, depth: e.depth }));
      }

      // 3. Storm guard (token bucket)
      const now = Date.now();
      stormWindow = stormWindow.filter(t => now - t < storm.windowMs);
      if (stormWindow.length >= storm.maxPerWindow) {
        if (['health', 'lifecycle', 'audit'].includes(e.channel)) {
          // ALWAYS pass critical channels
        } else {
          // Shed non-critical, coalesce
          return safeEmit(Event('perception.coalesced', { count: 1, original: e.type }));
        }
      }
      stormWindow.push(now);

      // 4. Assign sequence, push history
      e.seq = ++seq;
      history.push(e);
      if (history.length > historySize) history.shift();

      // 5. Dispatch to matching subscribers (try/catch each)
      for (const [pattern, handlers] of subs) {
        if (matchGlob(pattern, e.type)) {
          for (const h of handlers) {
            try { h(e); } catch (err) {
              safeEmit(Event('health.anomaly', { kind: 'handler-error', pattern, error: err.message }));
            }
          }
        }
      }
    },

    emit(type, payload, opts) {
      this.publish(Event(type, payload, opts));
    },

    subscribe(pattern) {
      const handler = typeof pattern === 'function'
        ? { glob: '*', fn: pattern }
        : { glob: pattern, fn: arguments[1] };
      if (!subs.has(handler.glob)) subs.set(handler.glob, new Set());
      subs.get(handler.glob).add(handler.fn);
      return () => subs.get(handler.glob)?.delete(handler.fn);
    },

    use(middleware) { mw.push(middleware); },
    history(filter) { return filter ? history.filter(filter) : [...history]; },
    stats() { return { subs: subs.size, historySize: history.length, seq }; }
  };
}
```

### Built-in Middleware

```js
// Audit tap — logs every action decision
function auditTap(e) {
  if (e.channel === 'audit' || e.channel === 'action') {
    auditWriter.append(e);  // write to vault/Audit/
  }
  return e;
}

// History tap — enriches with subscriber count
function historyTap(e) {
  e._subCount = /* count matching subs */;
  return e;
}

// Redact secrets — strips API keys from payloads before history storage
function redactSecrets(e) {
  const REDACT = ['apiKey', 'api_key', 'token', 'authorization'];
  if (e.payload) {
    for (const k of REDACT) { if (e.payload[k]) e.payload[k] = '[REDACTED]'; }
  }
  return e;
}
```

---

## §5 Memory

### MemoryStore Interface (all 5 stores)

```js
// src/core/memory/store.js
// All stores implement this interface:
{
  init()                    → Promise<void>           // create dirs, load indexes
  write(record)             → Promise<{ ref }>        // returns stable reference
  recall(query, opts)       → Promise<RecallHit[]>    // ranked by score
  get(ref)                  → Promise<Record|null>
  consolidate(opts)         → Promise<{ moved, distilled, archived }>
  stats()                   → { count, bytes, lastWrite }
}

// RecallHit shape
{ ref, score: 0..1, record, snippet: '≤200 chars', store: 'episodic' }
```

### Episodic Store (Primary — append-only JSONL)

```js
// src/core/memory/episodic.js
// vault/Episodic/YYYY-MM-DD.jsonl — one line per episode, daily rotation

const EPISODE_SCHEMA = {
  id:          'string',     // stable UUID
  ts:          'number',     // creation timestamp
  tick:        'number',     // cortex tick number
  traceId:     'string',     // causal chain root
  causeId:     'string',     // immediate parent event
  goalId:      'string|null',
  drive:       'string',     // curiosity | maintenance | user-service
  kind:        'string',     // perception | decision | action | reflection | anomaly
  channel:     'string',     // timer | file | ws | job | metric | voice
  summary:     'string',     // greppable one-liner (FS index friendly)
  detail:      'any',        // full context data
  salience:    'number',     // 0..1
  outcome:     'string',     // ok | fail | partial
  tier:        'number',     // leash tier of any associated action
  tokensSpent: 'number',     // LLM tokens consumed (0 for non-LLM)
  tags:        ['string']
};

// Append = only write → no two-writer corruption
// recall bounded to date window (default 7d)
// Per-line try/parse — corrupt line skipped with anomaly event
// tail(n) for crash recovery → rebuild WorkingMemory
```

### Semantic Store (Markdown + HTML sidecar)

```js
// vault/Semantic/<topic>.md
// Human-readable bullets with parseable sidecar:

// ## Topic Title
// <!-- {id: 'sem-abc123', ts: 1700000000, confidence: 0.8, sources: ['ep-001']} -->
// - Fact one
// - Fact two (learned from user correction)

// recall: filename match + term overlap in content
// consolidate: Brain 'simple' distills episodic clusters → new semantic entries
```

### Skills Store (Procedural memory)

```js
// vault/Skills/<skill>.md
// <!-- {id: 'sk-build-react', ts: 1700000000, uses: 42, successRate: 0.85} -->
// ## When
// User requests a React component build
// ## Steps
// - tool: create_goal, args: { title: 'Build React component for X' }
// - tool: execute_pipeline_card, args: { cardId: '{cardId}' }
// ## Success Criteria
// Component renders in browser without errors

// Planner checks Skills BEFORE Brain (cheap path — no LLM call on skill hit)
```

### WorkingMemory (RAM — never authoritative)

```js
// src/core/memory/working.js
function createWorkingMemory() {
  return {
    tick: 0,
    lastModel: null,           // per-tick, reset each tick (prevents stale model refs)
    perceptionQueue: [],       // drained by Observe stage
    activeGoalId: null,
    context: new Map(),        // arbitrary key-value for cross-tick state
    spendThisTick: 0,

    drainPerceptions() {
      const drained = this.perceptionQueue;
      this.perceptionQueue = [];
      return drained;
    },

    resetTickState() {
      this.lastModel = null;
      this.spendThisTick = 0;
    },

    snapshot() {
      return {
        tick: this.tick,
        activeGoalId: this.activeGoalId,
        contextKeys: [...this.context.keys()],
        lastTickAt: Date.now()
      };
    }
  };
}
// Rebuilt from episodic tail on boot if checkpoint missing
```

### Recall Portability (Injected Scorer)

```js
// v1: lexical scorer (term overlap + recency decay)
function lexicalScore(query, record) {
  const terms = query.toLowerCase().split(/\s+/);
  const text = `${record.summary} ${JSON.stringify(record.detail)}`.toLowerCase();
  const hits = terms.filter(t => text.includes(t)).length;
  const overlap = hits / Math.max(terms.length, 1);
  const age = (Date.now() - record.ts) / (7 * 24 * 3600000); // days
  const recency = Math.exp(-age * 0.3);  // exponential decay
  return Math.min(overlap * 0.7 + recency * 0.3, 1.0);
}

// Later: vectorScore(embed via Brain lane 'embed')
// Swap scorer + add rec.vec = entire vector upgrade; recall body unchanged
function createEpisodicStore({ scorer = lexicalScore }) {
  // scorer is INJECTED — never hardcoded
}
```

### Consolidate

```js
// Runs on Cortex cadence (every CONSOLIDATE_EVERY ticks)
// 1. Flush WorkingMemory → episodic append
// 2. Episodic → semantic distill via Brain 'simple' (one call, skipped if offline)
// 3. Decay: day files > EPISODIC_RETENTION_DAYS → digest to .md + gzip to Checkpoints/archive
// 4. Low-confidence semantic facts → _archive.md
```

### Write Safety

```js
// Per-path in-process async mutex for MD/JSON read-modify-write
// Write pattern: write-temp + atomic-rename
// Disk-full → emit anomaly + return { ref: null, degraded: true }, never crash
```

---

## §6 Cortex

### The Orchestrating Layer

```js
// src/core/cortex/index.js
function createCortex({ bus, memory, goals, brain, leash, effectors, config }) {
  let timer = null;
  let running = false;
  let generation = 0;       // restart token — stale interval callbacks die quietly
  const lastTickAt = { value: 0 };  // object ref for watchdog access

  const MAX_DRAIN_PER_TICK = 50;
  const MAX_DRAIN = config.MAX_DRAIN_PER_TICK || MAX_DRAIN_PER_TICK;

  async function tickOnce() {
    if (!running) return;
    const tickStart = Date.now();

    // REENTRANCY GUARD
    if (tickOnce._inFlight) return;
    tickOnce._inFlight = true;

    try {
      const working = memory.working;
      working.tick++;
      working.resetTickState();
      lastTickAt.value = tickStart;

      // ── OBSERVE ──
      const perceptions = working.drainPerceptions();
      if (perceptions.length > MAX_DRAIN) {
        // Coalesce excess
        perceptions.length = MAX_DRAIN;
        bus.emit('perception.coalesced', { original: perceptions.length });
      }
      bus.emit('tick', { tick: working.tick, perceptions: perceptions.length });

      // ── ORIENT ──
      const ranked = orient(perceptions, goals, working);
      for (const p of ranked) {
        if (p.salience > 0.5) {
          await memory.episodic.write({ ...p, kind: 'perception', tick: working.tick });
        }
      }

      // ── IDLE CHECK (cost lever #1) ──
      if (perceptions.length === 0 && !goals.hasActive()) {
        working.activeGoalId = null;
        // ZERO Brain calls on idle ticks
        if (working.tick % config.REFLECT_EVERY === 0) reflect();
        return;
      }

      // ── DECIDE ──
      const decision = decide(ranked, goals, working, config);
      if (!decision) return;  // nothing to do

      // ── ACT ──
      await act(decision, { bus, memory, goals, brain, leash, effectors, config, working });

      // ── REFLECT ──
      if (working.tick % config.REFLECT_EVERY === 0) {
        await reflect();
      }
      if (working.tick % config.CONSOLIDATE_EVERY === 0) {
        await memory.consolidate({});
      }

    } catch (err) {
      bus.emit('health.anomaly', { kind: 'tick-error', error: err.message, tick: memory.working.tick });
    } finally {
      tickOnce._inFlight = false;
    }
  }

  function start() {
    generation++;
    const myGen = generation;
    running = true;
    const tickMs = config.MYTHOS_TICK_MS || 1000;
    timer = setInterval(() => {
      if (generation !== myGen) return;  // stale callback dies quietly
      tickOnce();
    }, tickMs);
    if (timer.unref) timer.unref();  // don't keep process alive
    bus.emit('lifecycle.started', { generation: myGen });
  }

  function stop() {
    running = false;
    generation++;
    if (timer) { clearInterval(timer); timer = null; }
    bus.emit('lifecycle.stopped', {});
  }

  return { start, stop, tickOnce, get lastTickAt() { return lastTickAt; }, get generation() { return generation; } };
}
```

### Orient Stage

```js
function orient(perceptions, goals, working) {
  // Rank each perception by salience + goal relevance
  const activeGoal = goals.getActive();
  return perceptions.map(p => {
    let goalBoost = 0;
    if (activeGoal) {
      goalBoost = goalRelevance(p, activeGoal) * 0.3;
    }
    return { ...p, rankedSalience: Math.min(p.salience + goalBoost, 1.0) };
  }).sort((a, b) => b.rankedSalience - a.rankedSalience);
}
```

### Decide Stage

```js
function decide(ranked, goals, working, config) {
  // Arbiter: weighted score + STICKY hysteresis bonus for current goal
  const best = goals.arbitrate(ranked, working);
  if (!best) return null;

  working.activeGoalId = best.id;

  // Planner: procedural recall first (no Brain call on skill hit)
  const plan = goals.plan(best, { memory, brain: brain /* only if needed */ });
  if (!plan) return null;

  return plan;  // { tool, args, rationale, done, offline? }
}
```

### Act Stage

```js
async function act(decision, ctx) {
  const { bus, leash, effectors, brain, memory, goals, config, working } = ctx;

  // 1. Leash check
  const leashResult = leash.check(decision, { goalId: working.activeGoalId });
  if (!leashResult.allow && leashResult.requireConfirm) {
    bus.emit('confirm-request', { ...decision, ...leashResult });
    return;  // action paused until confirm-reply
  }
  if (!leashResult.allow) {
    bus.emit('action.denied', { ...decision, reason: leashResult.reason });
    return;
  }

  // 2. Breaker check
  const breakerOk = effectors.breakers.allow(decision.tool);
  if (!breakerOk) {
    bus.emit('action.blocked', { ...decision, reason: 'circuit-open' });
    return;
  }

  // 3. Dispatch
  const signal = AbortSignal.timeout(config.ACTION_TIMEOUT_MS || 30000);
  const result = await effectors.invoke(decision.tool, decision.args, { signal, bus, goalId: working.activeGoalId });

  // 4. Record outcome
  await memory.episodic.write({
    kind: 'action',
    channel: 'cortex',
    summary: `${decision.tool}(${JSON.stringify(decision.args).slice(0, 80)})`,
    detail: result,
    outcome: result?.ok ? 'ok' : 'fail',
    tier: leashResult.tier,
    tokensSpent: working.spendThisTick
  });

  // 5. Debit goal budget
  if (working.activeGoalId) {
    goals.debitBudget(working.activeGoalId, { tokens: working.spendThisTick, actions: 1 });
  }

  bus.emit('action.completed', { tool: decision.tool, ok: result?.ok, goalId: working.activeGoalId });
}
```

### Overrun Protection

```
- SKIP/coalesce beats (never queue — no invisible backlog)
- Reentrancy flag (tickOnce._inFlight)
- Generation token (stale interval callback dies quietly after watchdog restart)
- tick NEVER throws upward (per-stage try/catch + outer catch → health.anomaly)
- Timer unref'd (don't keep process alive)
```

---

## §7 Goal System

### Goal Record Schema

```js
// vault/Goals/<id>.json — one file per goal (stable IDs)
{
  id:              'goal-abc123',     // stable UUID, never reindexed
  drive:           'user-service',   // curiosity | maintenance | user-service
  title:           'Build React dashboard component',
  status:          'active',         // proposed | active | paused | done | failed
  priority:        0.8,             // 0..1
  budget: {
    tokens:        20000,            // max LLM tokens
    actions:       25,               // max effector invocations
    deadline:      null              // ISO timestamp or null
  },
  spent: {
    tokens:        0,
    actions:       0
  },
  parentId:       null,
  childIds:       [],
  plan: [{ tool: 'create_goal', args: {...}, status: 'done' }],
  grants: { '3': true },            // T3 confirm-once grants per goal
  reason:         'User requested via voice',
  createdAt:       1700000000000,
  updatedAt:       1700000000000,
  lastActionAt:    null
}
```

### Drive Weights

```js
const DRIVE_WEIGHTS = {
  'user-service':  1.0,   // human-initiated, highest priority
  'maintenance':   0.55,  // self-maintenance tasks
  'curiosity':     0.25   // self-generated exploration (rate-limited)
};
```

### Arbiter (Goal Selection)

```js
// Weighted score with STICKY hysteresis bonus for current goal (anti-thrash)
function arbitrate(ranked, working) {
  const candidates = goals.getActiveGoals();
  if (candidates.length === 0) return null;

  // Enforce MAX_ACTIVE_GOALS
  const cap = config.MAX_ACTIVE_GOALS || 5;

  const scored = candidates.map(g => {
    const driveWeight = DRIVE_WEIGHTS[g.drive] || 0;
    const priority = g.priority;

    // Deadline urgency (closer = higher)
    let urgency = 0;
    if (g.budget.deadline) {
      const remaining = (new Date(g.budget.deadline) - Date.now()) / 3600000;
      urgency = remaining < 1 ? 1.0 : remaining < 24 ? 0.5 : 0;
    }

    // Budget pressure (lower remaining = lower score)
    const tokenPressure = 1 - (g.spent.tokens / g.budget.tokens);
    const actionPressure = 1 - (g.spent.actions / g.budget.actions);
    const budgetPressure = Math.min(tokenPressure, actionPressure);

    // Salience boost from perceptions
    const salienceBoost = ranked
      .filter(p => goalRelevance(p, g) > 0.3)
      .reduce((max, p) => Math.max(max, p.rankedSalience), 0);

    // STICKY: bonus for current goal (anti-thrash)
    const sticky = g.id === working.activeGoalId ? 0.15 : 0;

    return {
      goal: g,
      score: driveWeight * 0.3 + priority * 0.3 + urgency * 0.15 +
             budgetPressure * 0.1 + salienceBoost * 0.1 + sticky
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.goal || null;
}
```

### Planner

```js
// Procedural recall first (no Brain call on skill hit), else Brain
async function plan(goal, ctx) {
  // 1. Check if current plan has a pending step
  const pending = goal.plan.find(s => s.status === 'pending');
  if (pending) return { tool: pending.tool, args: pending.args, rationale: 'plan-step' };

  // 2. Procedural recall — check Skills store first
  const skills = await ctx.memory.skills.recall({ query: goal.title });
  if (skills.length > 0 && skills[0].score > 0.6) {
    const skill = skills[0].record;
    const step = skill.steps[0];
    return { tool: step.tool, args: step.args, rationale: 'procedural-skill', offline: true };
  }

  // 3. Budget check BEFORE Brain call
  if (goal.spent.tokens >= goal.budget.tokens) {
    goal.status = 'paused';
    goal.reason = 'budget-exhausted';
    return null;  // exhausted → pause goal, never silent overspend
  }

  // 4. Brain 'build' (novel) or 'simple' (routine) with schemaHint
  const lane = goal.drive === 'user-service' ? 'build' : 'simple';
  const result = await ctx.brain.think({
    lane,
    messages: [{ role: 'user', content: `Plan next action for goal: ${goal.title}` }],
    schemaHint: '{ tool: string, args: object }',
    budget: goal.budget.tokens - goal.spent.tokens,
    source: `goal:${goal.id}`
  });

  if (!result || result.offline) return null;

  const parsed = result.parsed || tryParse(result.content);
  if (!parsed?.tool) return null;

  return { tool: parsed.tool, args: parsed.args, rationale: 'brain-planned', done: false };
}
```

### NOVA Goals.md Compatibility

NOVA's `Goals.md` (positional IDs, checkbox list) stays as the **user-facing surface**. The GoalSystem maps Goals.md entries to `user-service` drive goals internally. The `goals` effector reads/writes `Goals.md`; the GoalSystem layer uses stable-id JSON files for cognition.

---

## §8 Brain

### Unified Think Interface

```js
// src/core/brain/index.js
function createBrain({ config, bus }) {
  const registry = require('./registry');       // CA from NOVA app/lib/models/registry.js
  const chain = require('./chain');             // CA from NOVA app/lib/models/chain.js
  const spend = require('./spend');             // CA from NOVA activity-log.js
  const quota = require('../quota');            // CV from NOVA app/lib/quota.js
  const lanes = require('./lanes.default');     // from BRAIN-MAP.md

  return {
    async think({ lane, messages, schemaHint, budget, signal, source }) {
      // 1. Embed lane is placeholder — chainFor('embed')→[] → clean offline
      if (lane === 'embed') {
        return { content: null, offline: true, lane };
      }

      // 2. Add schemaHint + persona injection
      let msgs = messages;
      if (schemaHint) {
        msgs = [
          { role: 'system', content: `You must respond with valid JSON matching this schema: ${schemaHint}` },
          ...messages
        ];
      }
      if (['voice', 'build', 'simple'].includes(lane)) {
        const persona = config.MYTHOS_NAME || 'MYTHOS';
        msgs = [
          { role: 'system', content: `You are ${persona}. Be concise and actionable.` },
          ...msgs
        ];
      }

      // 3. chain.complete — reused cooldown/failover/key-rotation ONLY here
      //    reasoning.js DELETED — callers use think({ lane: 'build' })
      try {
        const result = await chain.complete({
          messages: msgs,
          kind: lane === 'embed' ? 'simple' : lane,
          signal,
          onAttempt: ({ provider, model }) => {
            bus.emit('brain-spend', { provider, model, lane, source });
          }
        });

        // 4. Parse: fence-strip → parse → ONE repair retry → degrade to raw content
        const parsed = tryParseWithRepair(result.content);

        // 5. Record spend (≈4 chars/tok, verbatim from NOVA activityLog.recordCall)
        const spentTokens = spend.estimate(result.content) + spend.estimate(msgs.map(m => m.content).join(''));
        spend.recordCall({ provider: result.provider, model: result.model, source, ok: true,
                          inputTokens: spentTokens * 0.6, outputTokens: spentTokens * 0.4 });

        return {
          content: result.content,
          parsed: parsed || null,
          provider: result.provider,
          model: result.model,
          spentTokens,
          offline: false,
          lane
        };
      } catch (err) {
        if (err.chainExhausted) {
          return { content: null, offline: true, lane };  // NEVER throw to Cortex
        }
        if (err.name === 'AbortError') {
          return { content: null, aborted: true, lane };  // legit control flow
        }
        throw err;  // unexpected — let Cortex catch as anomaly
      }
    },

    async probe() {
      await registry.refresh(true);  // force re-probe all providers
    }
  };
}
```

### Absorb Map (What Gets Removed/Rewritten)

| NOVA Module | MYTHOS Destination | Strategy |
|-------------|-------------------|----------|
| `registry.js` | `brain/registry.js` | CA: add 6th lane `embed`, CHAIN_* env overrides |
| `chain.js` | `brain/chain.js` | CA: LANES add zcode/groq/mistral; onAttempt emits brain-spend |
| `reasoning.js` | DELETED | RW: folds into `brain.think({ lane: 'build' })` — duplication eliminated |
| `BRAIN-MAP.md` | `brain/lanes.default.js` | CV: lane rankings as JS config |
| `activity-log.js` | `brain/spend.js` | CA: re-point require → brain/spend |

### Brain Lanes (Extended)

```
voice   → Groq llama-3.3-70b → Mistral large-2512 → Ollama qwen3:8b
build   → Mistral large-2512 → NIM GLM-5.2 → Ollama ornith:9b
simple  → Ollama qwen3:8b
text    → (same as voice, no persona injection)
vision  → Ollama qwen3.5 → Ollama qwen2.5vl:7b
embed   → (placeholder — empty chain, returns { offline: true })
```

---

## §9 Leash

### Canonical Tier Table (Conservative Merge)

```js
// src/core/leash/tiers.js — kept in byte-for-byte sync with the real file;
// see git history for the tier-table timeline (this snippet had drifted
// significantly out of sync before the confirmation-policy pass — the
// invariant is "matches tiers.js exactly", not "hand-maintained subset").
const TIER_TABLE = {
  // T0 — READ ONLY (auto-allow, never audit)
  'navigate':              0,
  'close_panel':           0,
  'read_status':           0,
  'job_status':            0,
  'list_goals':            0,
  'pipeline_status':       0,
  'kanban_status':         0,
  'mission_status':        0,
  'get_time':              0,
  'get_weather':           0,
  'list_folder':           0,
  'read_file':             0,
  'list_windows':          0,
  'ui_elements':           0,
  'browser_get_title':     0,
  'web_search':            0,  // read-only research — fetches public search results
  'web_fetch':             0,  // read-only fetch — retrieves public web page content
  'camera_look':           0,  // read-only — captures and describes camera frame
  'remember':              0,
  'log_incident':          0,
  'reminder_add':          0,  // read-only — creates a local reminder record
  'reminder_list':         0,  // read-only — lists pending reminders
  'use_skill':             0,  // read-only — loads a skill's guidance text from disk
  'open_web':              0,  // read-only — opens a dashboard view (no destructive action)
  'recall_memory':         0,  // read-only — searches existing memory (recallHybrid), writes nothing
  'persona_status':        0,  // read-only — reports current personality dial settings
  'self_capabilities':     0,  // read-only — reports the boot-generated capabilities manifest

  // T1 — LOCAL WRITES (auto-allow, audit logged)
  'create_goal':           1,
  'toggle_goal':           1,
  'capture_idea':          1,
  'kanban_add_card':       1,
  'kanban_move_card':      1,
  'write_note':            1,
  'screen_look':           1,
  'capture_screenshot':    1,
  'browser_screenshot':    1,
  'browser_get_text':      1,
  'browser_scroll':        1,
  'browser_go_back':       1,
  'browser_wait_for':      1,  // Phase 4 — read-only wait for an element
  'focus_window':          1,
  'pipeline_advance':      1,  // approve only — dangerWhen handles reject
  'gmail_unread':          1,
  'gmail_read':            1,
  'gmail_draft':           1,
  'reminder_cancel':       1,  // local write — cancels a pending reminder
  'spawn_widget':          1,  // local write — spawns a floating dashboard widget from a
                               // validated data-only spec (Item 11 generative UI)
  'set_persona_level':     1,  // local write — adjusts a personality dial in Identity/persona.json
  'manage_widget':         1,  // local write — hides/shows dashboard widgets (state in browser localStorage)
  'ambient_awareness':     1,  // local toggle — turns the ambient screen-awareness sensor on/off/status
  'daily_plan':            1,  // local write — reads/re-fires/quiets the daily planner's day file

  // T2 — LOCAL ACTIONS (auto-allow within AUTONOMOUS_MAX_TIER, audit)
  'open_folder':           2,
  'launch_app':            2,
  'open_artifact':         2,  // BUG-008 — opens a file/URL via the OS (cmd start/open/xdg-open),
                               // read-only w.r.t. destructive risk; same category as open_folder/
                               // launch_app above, not the T3 confirm tier. Was previously unmapped
                               // and fell back to tierOf()'s T3 fail-safe.
  'media_key':             2,
  'ask_agent':             2,
  'browser_navigate':      2,
  'browser_tabs':          2,
  'browser_launch_debug':  2,  // Phase 6 — on-demand debug-browser launch, local action, no destructive risk
  'spotify_play_pause':    2,
  'spotify_next':          2,
  'spotify_previous':      2,
  'spotify_volume':        2,
  'spotify_status':        2,
  'send_key':              2,
  'media_status':          0,
  // Re-tiered T3 -> T2 (confirmation-policy pass): these write only to the
  // sandboxed vault/builds/ tree or drive Spotify locally — no destructive or
  // outward-facing risk, so a confirm popup on every "play a song"/"build me
  // a landing page" was pure friction, not safety. See BUGS.md for the audit
  // that identified them; the T3/T4 security-invariant tools below (compose_email,
  // gmail_send, delete_goal, close_window, hermes_task, ui_click, ui_type,
  // click_at, browser_click, browser_type, kill_session, browser_evaluate) are
  // deliberately untouched.
  'spotify_play':          2,
  'spotify_search':        2,
  'build_project':         2,  // P22 Forge — multi-file build, sandboxed to vault/builds/
  'revise_project':        2,  // P22 Forge — targeted regen, sandboxed to vault/builds/
  'pipeline_execute':      2,
  'kanban_assemble':       2,
  'kanban_build_card':     2,
  'start_project':         2,
  'run_mission':           2,
  // Phase 2 docs-gen — sandboxed vault writes under builds/docs/.
  'generate_spreadsheet':  2,  // .xlsx via exceljs
  'generate_deck':         2,  // .pptx via pptxgenjs
  'generate_pdf':          2,  // .pdf via headless Chrome print-to-pdf; honest HTML fallback
  // Phase 3 desktop control — non-destructive window ops; right_click/drag are T3 below.
  'move_window':           2,  // window move/resize
  'snap_window':           2,  // window snap/min/max/restore
  'scroll_at':             2,  // wheel scroll at a point

  // T3 — CONFIRM-ONCE-PER-GOAL (grant recorded, dies with goal)
  'delete_goal':           3,
  'project_status':        0,  // P22 Forge — read-only build status (tier 0; flat table, position cosmetic)
  'compose_email':         3,
  'close_window':          3,
  'gmail_send':            3,
  'ui_click':              3,  // ELEVATED — autonomous typing unpredictable
  'ui_type':               3,  // ELEVATED — same reasoning
  'click_at':              3,  // ELEVATED — autonomous clicking unpredictable
  'right_click_at':        3,  // Phase 3 — autonomous right-click, context menus unpredictable
  'drag':                  3,  // Phase 3 — autonomous drag, drop targets unpredictable
  'browser_click':         3,
  'browser_type':          3,
  'browser_fill_form':     3,  // Phase 4 — autonomous multi-field typing
  'hermes_task':           3,  // P7 — delegates to the hermes-agent sidecar, which runs real commands

  // T4 — ALWAYS CONFIRM (never cached, human must approve every time)
  'kill_session':          4,
  'browser_evaluate':      4
};
```

### check() Function

```js
// src/core/leash/index.js
function createLeash({ bus, config, identity, auditWriter }) {
  const maxTier = config.AUTONOMOUS_MAX_TIER || 2;  // default: only T0-T1 autonomous

  return {
    check(action, goalCtx) {
      const toolName = action.tool;
      const args = action.args || {};
      let tier = TIER_TABLE[toolName];  // static tier

      // Args-aware override (e.g., pipeline_advance with reject)
      const effector = effectors.get(toolName);
      if (effector?.dangerWhen && effector.dangerWhen(args)) {
        tier = Math.max(tier, 3);  // upgrade to T3 at minimum
      }

      // DRY RUN → T≥1 becomes logged no-op
      if (config.MYTHOS_DRY_RUN && tier >= 1) {
        auditWriter.write({ ...action, tier, decision: 'dry-run' });
        return { allow: false, requireConfirm: false, tier, reason: 'dry-run' };
      }

      // 1. Boundaries DENY (absolute blocks from boundaries.md)
      const boundaryHit = identity.checkBoundary(toolName, args);
      if (boundaryHit) {
        auditWriter.write({ ...action, tier, decision: 'deny', boundaryHit });
        return { allow: false, requireConfirm: false, tier, reason: boundaryHit };
      }

      // 2. Unknown tool → T3 fail-safe
      if (tier === undefined) tier = 3;

      // 3. Below maxTier → auto-allow
      if (tier <= maxTier) {
        auditWriter.write({ ...action, tier, decision: 'allow' });
        return { allow: true, requireConfirm: false, tier, reason: 'within-autonomous-max' };
      }

      // 4. T3 → check per-goal grant
      if (tier === 3) {
        const goal = goals.get(goalCtx.goalId);
        if (goal?.grants?.['3']) {
          auditWriter.write({ ...action, tier, decision: 'allow', granted: true });
          return { allow: true, requireConfirm: false, tier, reason: 'goal-granted' };
        }
        // Request confirmation — grant recorded per-goal, dies with goal
        auditWriter.write({ ...action, tier, decision: 'confirm' });
        return { allow: false, requireConfirm: true, tier, reason: 'tier-3-requires-confirm' };
      }

      // 5. T4 → always confirm, never cached
      auditWriter.write({ ...action, tier, decision: 'confirm' });
      return { allow: false, requireConfirm: true, tier, reason: 'tier-4-always-confirm' };
    }
  };
}
```

### Audit Trail (Append-Only JSONL)

```js
// vault/Audit/YYYY-MM-DD.jsonl
// Schema:
{
  id:            'aud-abc123',
  ts:            1700000000000,
  goalId:        'goal-xyz789' | null,
  traceId:       'evt-1700000000-abc123',
  tool:          'kill_session',
  args:          { sessionId: '...' },  // redacted in history
  tier:          4,
  decision:      'confirm',           // allow | deny | confirm | dry-run
  granted:       false,
  actor:         'cortex',            // cortex | human
  reason:        'tier-4-always-confirm',
  outcome:       'accepted',          // accepted | rejected | (null if not confirm)
  boundaryHit:   null
}

// FAIL-CLOSED: T≥3 if audit unwritable → deny action
// T0-2 continue without audit (fail-open for reads)
```

---

## §10 Immune System

### Six Components

```
Monitor → Breakers → Watchdog → Diagnostician → Healer → Recovery
```

### Circuit Breaker FSM

```js
// src/core/immune/breakers.js
// Per effector + per provider
// CLOSED → (≥3 fails in 30s) → OPEN → (15s, ×2 backoff cap 5min) → HALF_OPEN → success → CLOSED

const BREAKER_STATES = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half-open' };

function createBreaker({ name, failThreshold = 3, windowMs = 30000, resetMs = 15000, maxResetMs = 300000 }) {
  let state = BREAKER_STATES.CLOSED;
  let failCount = 0;
  let lastFailAt = 0;
  let resetAt = 0;
  let halfOpenAttempts = 0;

  return {
    get state() { return state; },
    get stats() { return { name, state, failCount, resetAt }; },

    allow() {
      const now = Date.now();
      if (state === BREAKER_STATES.CLOSED) return true;

      if (state === BREAKER_STATES.OPEN) {
        if (now >= resetAt) {
          state = BREAKER_STATES.HALF_OPEN;
          halfOpenAttempts = 0;
          return true;  // allow one probe
        }
        return false;   // OPEN → effector returns { ok: false, 'circuit-open' } WITHOUT calling tool
      }

      if (state === BREAKER_STATES.HALF_OPEN) {
        halfOpenAttempts++;
        return halfOpenAttempts <= 1;  // only one probe in half-open
      }
      return false;
    },

    recordSuccess() {
      if (state === BREAKER_STATES.HALF_OPEN) {
        state = BREAKER_STATES.CLOSED;  // recovered
      }
      failCount = 0;
    },

    recordFailure() {
      const now = Date.now();
      // Reset window
      if (now - lastFailAt > windowMs) {
        failCount = 0;
      }
      lastFailAt = now;
      failCount++;

      if (state === BREAKER_STATES.HALF_OPEN) {
        // Probe failed → back to OPEN with backoff
        const nextReset = Math.min(resetAt * 2, now + maxResetMs);
        resetAt = nextReset;
        state = BREAKER_STATES.OPEN;
        return;
      }

      if (failCount >= failThreshold) {
        state = BREAKER_STATES.OPEN;
        resetAt = now + resetMs;
        bus.emit('health.anomaly', { kind: 'effector-flapping', target: name, failCount, state });
      }
    }
  };
}
```

### Watchdog

```js
// src/core/immune/watchdog.js
// Independent 2s unref'd timer reads cortex.lastTickAt
// Stall > 5× TICK_MS → restart cortex

function createWatchdog({ cortex, bus, config }) {
  const STALL_MS = config.STALL_MS || 5000;
  const CHECK_MS = config.WATCHDOG_MS || 2000;
  let timer = null;
  let restarting = false;

  function start() {
    timer = setInterval(() => {
      if (restarting) return;
      const elapsed = Date.now() - cortex.lastTickAt.value;
      if (elapsed > STALL_MS) {
        handleStall(elapsed);
      }
    }, CHECK_MS);
    if (timer.unref) timer.unref();
  }

  async function handleStall(elapsed) {
    restarting = true;
    bus.emit('health.anomaly', { kind: 'cortex-stall', elapsed, lastTickAt: cortex.lastTickAt.value });

    // (1) Abort in-flight dispatch cooperatively
    // (2) Bump generation → stopTimerOnly (WorkingMemory UNTOUCHED)
    cortex.stop();
    // (3) Active goal → paused 'cortex-restart'
    // (4) cortex.start()
    cortex.start();
    restarting = false;
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start, stop };
}
```

### Diagnostician

```js
// Typed diagnoses:
// provider-down | effector-flapping | tick-overrun | cortex-stall |
// memory-growth | budget-exhausted | quota-low | causal-loop | event-storm

function diagnose(anomaly) {
  return {
    kind: anomaly.kind,
    target: anomaly.target,
    evidence: anomaly,
    severity: severityOf(anomaly.kind),
    suggestedAction: playbookLookup(anomaly.kind)
  };
}
```

### Healer (Playbook DSL)

```js
// Playbooks as DATA — no code eval, per-playbook cooldown kills heal storms

const SEED_PLAYBOOKS = [
  {
    id: 'rotate-nim-key',
    when: { kind: 'provider-down', target: { eq: 'nim' } },
    then: [{ do: 'probe-provider', args: { provider: 'nim', rotateKey: true } }],
    cooldownMs: 60000
  },
  {
    id: 'stall-restart',
    when: { kind: 'cortex-stall' },
    then: [{ do: 'restart-cortex' }],
    cooldownMs: 30000
  },
  {
    id: 'quota-guard',
    when: { kind: 'quota-low', target: { eq: 'groq' } },
    then: [{ do: 'degrade-lane', args: { lane: 'voice', removeProvider: 'groq' } }],
    cooldownMs: 300000
  },
  {
    id: 'mem-consolidate',
    when: { kind: 'memory-growth', target: { bytes: { gt: 50000000 } } },
    then: [{ do: 'consolidate-memory' }],
    cooldownMs: 600000
  },
  {
    id: 'budget-pause',
    when: { kind: 'budget-exhausted' },
    then: [{ do: 'pause-goal', args: { reason: 'budget-exhausted' } }],
    cooldownMs: 0  // no cooldown — immediate
  }
];

// DSL evaluation: equality + lt/gt + $var references
// All heals audited via audit trail
```

### Recovery (Post-Crash)

```js
// 1. Read episodic tail → rebuild WorkingMemory.context
// 2. Mark active-at-crash goals → paused 'crash-recovery'
// 3. Merge checkpoint hint (if available)
// 4. Emit lifecycle.recovered
// 5. Entity RESUMES via re-arbitration — never re-runs interrupted action
```

---

## §11 Identity

### Self & Boundaries

```js
// vault/Identity/self.md — entity-writable
// Contains: purpose, values, persona, learned preferences
// Each learned pref has sidecar: { ts, source, confidence }

// vault/Identity/boundaries.md — HUMAN-EDITABLE ONLY
// Entity has NO write path (contract-tested)
```

### Boundaries Schema

```markdown
# MYTHOS Boundaries

## Deny Rules (absolute blocks)
deny: kill_session
deny: browser_evaluate

## Max Autonomous Tier
max_autonomous_tier: 2

## Allowed Directories
allowed_dirs:
  - F:/Projects
  - F:/Documents
```

### Identity Module

```js
// src/core/identity/index.js
function createIdentity({ bus, config, vault }) {
  let self = null;       // cached self.md content
  let boundaries = null;  // cached boundaries.md content

  return {
    async init() {
      self = await vault.readText('Identity/self.md', {
        purpose: 'An autonomous entity that assists its operator.',
        values: 'Helpfulness, honesty, efficiency.',
        persona: config.MYTHOS_NAME || 'MYTHOS'
      });
      boundaries = await vault.readText('Identity/boundaries.md', {
        deny: [],
        max_autonomous_tier: 1  // fail-safe default
      });

      // Validate boundaries — malformed → fail-safe
      if (typeof boundaries.max_autonomous_tier !== 'number') {
        boundaries.max_autonomous_tier = 1;
        bus.emit('health.anomaly', { kind: 'identity-boundaries-malformed', severity: 'critical' });
      }
    },

    checkBoundary(tool, args) {
      const denyList = Array.isArray(boundaries.deny) ? boundaries.deny : [];
      if (denyList.includes(tool)) return `denied by boundaries.md`;
      return null;
    },

    persona() {
      return `You are ${self.persona || config.MYTHOS_NAME || 'MYTHOS'}. ${self.values || ''}`;
    },

    async learn({ signal, text, sourceEpId }) {
      // On human rejection of confirms / edits / feedback
      // Consolidate prunes contradicted prefs, raises durable confidence
    }
  };
}
```

---

## §12 Sensors & Effectors

### Sensors (5 Types)

```js
// All sensors implement: start(emit) → stop()

// 1. Timer Sensor — setInterval unref, base beat + named cron schedules
//    hint: 0.1 (low salience — expected heartbeat)
function createTimerSensor({ config }) {
  let timer = null;
  return {
    start(emit) {
      const tickMs = config.MYTHOS_TICK_MS || 1000;
      timer = setInterval(() => {
        emit(Event('perception.tick', { kind: 'timer', ts: Date.now() }, { source: 'sensor-timer' }));
      }, tickMs);
      if (timer.unref) timer.unref();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } }
  };
}

// 2. File Sensor — fs.watch vault + MYTHOS_WATCH_DIRS
//    debounced, ignores Checkpoints/Audit self-writes
//    hint: 0.4-0.6
function createFileSensor({ config, vault }) {
  // fs.watch per directory, debounce 500ms, filter self-write dirs
}

// 3. WS Sensor — utterance/command inbound from WebSocket clients
//    hint: 0.8 (high salience — human-initiated)
function createWsSensor({ bus, config }) {
  // Subscribes to ws message events, emits perception events
}

// 4. Job Sensor — build-runner onJobUpdate
//    hint: 0.5 (normal), 0.7 (failed)
function createJobSensor({ buildRunner }) {
  // Attaches to build-runner.onJobUpdate, emits perception events
}

// 5. Metric Sensor — probes + spend poll every 4s
//    hint: 0.2 (normal), 0.9 (breaker trip)
function createMetricSensor({ probes, spend }) {
  let timer = null;
  return {
    start(emit) {
      timer = setInterval(() => {
        const status = probes.getStatus();
        const quotas = spend.getAllQuotas();
        const lowQuota = quotas.some(q => q.remainingPercent < 10);
        emit(Event('perception.metric', {
          kind: 'metric',
          status,
          quotas,
          hint: lowQuota ? 0.9 : 0.2
        }));
      }, 4000);
      if (timer.unref) timer.unref();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } }
  };
}
```

### Perception Envelope

```js
{
  id:             'evt-1700000000-abc123',
  type:           'perception.tick',      // perception.{timer,file,ws,job,metric,voice}
  channel:        'perception',
  payload: {
    id:             'perc-xyz',
    at:             1700000000000,
    channel:        'timer',
    kind:           'timer',
    payload:        { ts: 1700000000000 },
    salienceHint:   0.1              // 0..1, from sensor
  },
  ts:             1700000000000,
  source:         'sensor-timer',
  causeId:        null,
  traceId:        'evt-1700000000-abc123',
  depth:          0
}
```

### Effector Interface

```js
// Canonical effector shape:
{
  id:             'kill_session',
  tier:           4,
  describe()     → 'Terminate a running agent session',
  validate(params) → { ok: true } | { ok: false, reason: '...' },
  async invoke(params, ctx) → { ok: true, result: any, uiActions?, needsResult? }
}
```

### Tool → Effector Adapter

```js
// src/core/effectors/adapter.js
function effectorFromTool(tool, { tierOf }) {
  return {
    id: tool.name,
    tier: tierOf(tool.name),
    describe: () => tool.description,
    validate: (params) => {
      // Validate params against tool.params schema
      return { ok: true };
    },
    async invoke(params, ctx) {
      // dangerWhen honored by Leash at gate time — not here
      try {
        return await tool.fn(params, ctx);
      } catch (err) {
        return { ok: false, result: err.message };
      }
    }
  };
}
```

### Build Artifact Effector (WRAP of NOVA Orchestrator)

```js
// src/core/effectors/build-runner.js
// WRAPS orchestrator.js — NOT absorbed into GoalSystem
// Rationale: cognition (1s cadence) must not block on multi-minute builds
// onJobUpdate becomes job sensor → closes the loop

function createBuildRunner({ config, brain, bus, vault }) {
  // enqueue→pump, CONCURRENCY, jobs.json last-100
  // restart marks running jobs failed (honest)
  // Uses brain.think({ lane: 'build' }) instead of reasoning.chat()
  // Emits job-update events → job sensor picks up → cortex aware
}
```

### Effector Hub

```js
// src/core/effectors/index.js
function createEffectorHub({ bus, config }) {
  const effectors = new Map();     // name → effector
  const breakers = new Map();       // name → breaker

  function register(effector) {
    effectors.set(effector.id, effector);
    breakers.set(effector.id, createBreaker({ name: effector.id }));
  }

  async function invoke(name, params, ctx) {
    const effector = effectors.get(name);
    if (!effector) return { ok: false, result: 'unknown-effector' };

    const breaker = breakers.get(name);
    if (!breaker.allow()) {
      return { ok: false, result: 'circuit-open' };
    }

    const result = await effector.invoke(params, ctx);
    if (result.ok) breaker.recordSuccess();
    else breaker.recordFailure();

    return result;
  }

  return { register, invoke, get effectors() { return effectors; }, get breakers() { return breakers; }, count: () => effectors.size };
}
```

---

## §13 Config & Boot

### Config Schema & Validator

```js
// src/core/config/schema.js
const SCHEMA = {
  // MYTHOS-specific keys
  MYTHOS_NAME:              { type: 'string', default: 'MYTHOS' },
  MYTHOS_PORT:              { type: 'number', default: 4478, min: 1024, max: 65535 },
  MYTHOS_BIND:              { type: 'string', default: '127.0.0.1' },
  MYTHOS_VAULT_ROOT:        { type: 'string', required: true },
  MYTHOS_TICK_MS:           { type: 'number', default: 1000, min: 100, max: 60000 },
  MYTHOS_IDLE_SALIENCE:     { type: 'number', default: 0.3, min: 0, max: 1 },
  MYTHOS_DRY_RUN:           { type: 'bool',  default: false },

  // NOVA passthrough (subset — ~50 total in .env.example)
  LOG_LEVEL:                 { type: 'string', default: 'info', enum: ['debug', 'info', 'warn', 'error'] },
  PORT:                     { type: 'number', default: 4477 },   // NOVA port (unchanged)
  BIND:                     { type: 'string', default: '127.0.0.1' },
  OLLAMA_URL:               { type: 'string', default: 'http://localhost:11434' },
  GROQ_API_KEY:             { type: 'string' },
  MISTRAL_API_KEY:          { type: 'string' },
  NIM_API_KEY:              { type: 'string' },
  ZCODE_API_KEY:            { type: 'string' },
  // ... (full list in .env.example)

  // Brain
  REFLECT_EVERY:            { type: 'number', default: 60, min: 1 },
  CONSOLIDATE_EVERY:        { type: 'number', default: 300, min: 1 },
  EPISODIC_RETENTION_DAYS:  { type: 'number', default: 30, min: 1 },
  CHAIN_COOLDOWN_MS:        { type: 'number', default: 60000 },
  MODEL_REGISTRY_TTL_MS:    { type: 'number', default: 300000 },

  // Autonomy
  AUTONOMOUS_MAX_TIER:      { type: 'number', default: 2, min: 0, max: 4 },
  GOAL_TOKEN_BUDGET:        { type: 'number', default: 20000, min: 0 },
  GOAL_ACTION_BUDGET:       { type: 'number', default: 25, min: 0 },
  MAX_ACTIVE_GOALS:         { type: 'number', default: 5, min: 1, max: 20 },
  CURIOSITY_MIN_INTERVAL_MS:{ type: 'number', default: 600000 },

  // Immune
  STALL_MS:                 { type: 'number', default: 5000 },
  WATCHDOG_MS:              { type: 'number', default: 2000 },
  BREAKER_FAIL_THRESHOLD:   { type: 'number', default: 3 },
  BREAKER_WINDOW_MS:        { type: 'number', default: 30000 },
  BREAKER_RESET_MS:         { type: 'number', default: 15000 },

  // Bus
  BUS_HISTORY_SIZE:         { type: 'number', default: 500 },
  BUS_STORM_MAX:            { type: 'number', default: 400 },
};

// src/core/config/index.js
function validate(rawEnv, schema) {
  const errors = [];
  const config = {};

  for (const [key, def] of Object.entries(schema)) {
    let val = rawEnv[key];

    if (val === undefined || val === '') {
      if (def.required) {
        errors.push(`Missing required config: ${key}`);
        continue;
      }
      val = def.default;
    }

    // Type coercion
    if (def.type === 'number') {
      val = Number(val);
      if (isNaN(val)) { errors.push(`Invalid number: ${key}=${rawEnv[key]}`); continue; }
      if (def.min !== undefined && val < def.min) errors.push(`${key}=${val} below min ${def.min}`);
      if (def.max !== undefined && val > def.max) errors.push(`${key}=${val} above max ${def.max}`);
    }
    if (def.type === 'bool') {
      val = val === 'true' || val === '1' || val === true;
    }
    if (def.enum && !def.enum.includes(val)) {
      errors.push(`${key}=${val} not in [${def.enum.join(',')}]`);
    }

    config[key] = Object.freeze(val);
  }

  return Object.freeze({ ok: errors.length === 0, config, errors });
}
```

### Boot Sequence (14 Steps)

```js
// src/main.js
const bootOrder = [
  // FAIL-FAST steps (error = exit)
  { name: 'config',     fn: () => loadConfig(),       fail: 'fast' },
  { name: 'logger',     fn: () => initLogger(),       fail: 'fast' },
  { name: 'bus',        fn: () => createBus(config),   fail: 'fast' },
  { name: 'vault-dirs', fn: () => ensureVaultDirs(),  fail: 'fast' },
  { name: 'episodic',   fn: () => initEpisodic(),     fail: 'fast' },
  { name: 'audit',      fn: () => initAudit(),        fail: 'fast' },  // fail-closed for T≥3
  { name: 'immune',     fn: () => initImmune(),       fail: 'fast' },
  { name: 'cortex',     fn: () => createCortex({...}), fail: 'fast' },

  // DEGRADED steps (warning = continue)
  { name: '.env',       fn: () => loadDotenv(),       fail: 'degraded' },
  { name: 'stores',     fn: () => initStores(),       fail: 'degraded' },
  { name: 'identity',   fn: () => initIdentity(),     fail: 'degraded' },
  { name: 'brain-probe',fn: () => brain.probe(),     fail: 'degraded' },  // fire-and-forget w/ timeout
  { name: 'goals',      fn: () => initGoals(),        fail: 'degraded' },
  { name: 'recovery',   fn: () => recoverFromCheckpoint(), fail: 'degraded' },

  // Final
  { name: 'sensors',    fn: () => startSensors(),    fail: 'fast' },
  { name: 'effectors',  fn: () => registerEffectors(), fail: 'fast' },
  { name: 'server',     fn: () => startServer(),     fail: 'fast' },
  { name: 'cortex-tick',fn: () => cortex.start(),    fail: 'fast' },
];
// After all steps: emit lifecycle.alive → log "ALIVE" → process keeps running
```

### Shutdown Sequence

```
1. Sensors stop
2. Cortex drain (abort dispatch after grace)
3. Working → episodic flush
4. Checkpoint atomic write { tick, activeGoalId, salientContextKeys, lastTickAt, ts }
5. Audit flush
6. Exit 0
7. SHUTDOWN_MS hard-exit timer (safety net)
```

### Crash Invariants

1. **Episodic append = source of truth** — torn last line skipped on read.
2. **No fake resume** — running jobs marked failed on restart, goals paused.
3. **WorkingMemory derived** — safe to lose, rebuilt from episodic tail.
4. **Single-writer** — pidfile in Checkpoints refuses 2nd process.
5. **Audit append-only** — fail-closed for T≥3 if unwritable.

---

## §14 Server & UI v2

### Server (MYTHOS_PORT 4478)

```js
// mythos/server.js — RW from NOVA server.js
// Reuses: 127.0.0.1 bind, CORS allowlist, verifyWsClient, broadcastAll, graceful-shutdown

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws', verifyClient });

// WS v2 message types:
// IN (reqId):  utterance, command, confirm-reply{confirmId,accept}, subscribe{types[]}, stop
// OUT (broadcast): entity-state, tick, goal-update, perception, action, health, audit,
//                 confirm-request, brain-spend, log
```

### WS v2 Protocol

```js
// Client → Server
{ type: 'utterance', reqId: 'r1', text: 'Build me a dashboard' }
{ type: 'command', reqId: 'r2', command: 'status' }
{ type: 'confirm-reply', confirmId: 'cf-abc', accept: true }
{ type: 'subscribe', types: ['tick', 'action', 'health'] }
{ type: 'stop', reqId: 'r1' }

// Server → Client (broadcast, no reqId)
{ type: 'entity-state', payload: { name: 'MYTHOS', status: 'alive', tick: 1234 } }
{ type: 'tick', payload: { tick: 1234, perceptions: 2, activeGoal: 'goal-abc' } }
{ type: 'goal-update', payload: { id: 'goal-abc', status: 'active', title: '...' } }
{ type: 'perception', payload: { channel: 'ws', kind: 'utterance', salience: 0.8, text: '...' } }
{ type: 'action', payload: { tool: 'create_goal', ok: true, goalId: 'goal-abc' } }
{ type: 'health', payload: { breakers: {...}, providers: {...} } }
{ type: 'audit', payload: { tool: 'kill_session', tier: 4, decision: 'confirm' } }
{ type: 'confirm-request', payload: { id: 'cf-abc', tool: 'kill_session', summary: '...', tier: 4 } }
{ type: 'brain-spend', payload: { provider: 'groq', model: 'llama-3.3-70b', lane: 'voice', tokens: 450 } }
```

### Client WS Helper

```js
// public/js/ws.js — CA from NOVA ws.js
// Keeps: nextReqId/handlers-Map/onBroadcast/backoff/sendQueue
// New: subscribe(types, onEvent) for live streaming

function subscribe(types, onEvent) {
  send({ type: 'subscribe', types });
  types.forEach(t => onBroadcast(t, onEvent));
}
```

### UI Views (async render → cleanup)

| View | Source | Description |
|------|--------|-------------|
| Mind | NEW | Live tick/goals/salience — the entity's current cognition |
| Memory | NEW | Browse 5 stores (episodic, semantic, skills, identity, audit) |
| Health | NEW | Breakers state, provider status, spend rates, anomaly log |
| Audit | NEW | Scrollable leash trail — every decision with tier/outcome |
| Goals | CA | NOVA goals view adapted for GoalSystem |
| Kanban | CA | Unchanged |
| Pipeline | CA | Unchanged |
| Confirm | NEW | Modal (orb styling) + spoken summary; tier-4 always, tier-3 once/session |

---

## §15 Migration Map & Directory Layout

### Full Migration Table

| NOVA Module | MYTHOS Path | Strategy | Notes |
|-------------|-------------|----------|-------|
| `providers/*.js` (all ~20) | `providers/` | CV/CA | All verbatim except openai-compat CA (re-point activity-log) |
| `free-models.js` | `providers/free-models.js` | CA | Adapt paths |
| `registry.js` | `src/core/brain/registry.js` | CA | +embed lane, CHAIN_* env overrides |
| `chain.js` | `src/core/brain/chain.js` | CA | +zcode/groq/mistral lanes, onAttempt emits brain-spend |
| `reasoning.js` | DELETED | RW | Folded into brain.think({ lane: 'build' }) |
| `BRAIN-MAP.md` | `src/core/brain/lanes.default.js` | CV | Lane rankings as JS config |
| `activity-log.js` | `src/core/brain/spend.js` | CA | Renamed, re-pointed |
| `quota.js` | `src/core/quota.js` | CV | Verbatim |
| `rate-limit.js` | `server/rate-limit.js` | CV | Verbatim |
| `tools-dashboard.js` | `src/core/effectors/from-dashboard.js` | CA | Fn bodies verbatim, requires re-pointed |
| `tools-computer.js` | `src/core/effectors/from-computer.js` | CA | Same |
| `tools-pc.js` | `src/core/effectors/from-pc.js` | CA | Same |
| `tools-browser.js` | `src/core/effectors/from-browser.js` | CA | Same |
| `tools-project.js` | `src/core/effectors/from-project.js` | CA | Same |
| `agent-actions.js` | `src/core/effectors/agent-actions.js` | CA | reasoning.chat→brain.complete |
| `orchestrator.js` | `src/core/effectors/build-runner.js` | WRAP | Enqueue→pump as effector, NOT absorbed into GoalSystem |
| `confirm.js` | `src/core/leash/confirm.js` | CA | Session+tier-scoped, T3 confirmed-once |
| `voice-agent.js` | `src/core/brain/interpret.js` | CA | interpret(utterance)→{say, intents[]} |
| `tts.js` | `src/core/effectors/voice.js` | CA | TTS as effector |
| `checkpoint-announcer.js` | `src/core/immune/announcer.js` | RW | Bus-subscribed, speaks via voice effector |
| `intake.js` | WS sensor buffer | RW | Connection-scoped memory via WS sensor |
| `logger.js` | `src/core/logger.js` | CA | Structured JSON lines |
| `probes.js` | `src/core/immune/probes.js` | CA | Status aggregation |
| `routes.js` | UI + navigate effector | CA | Adapted |
| `vault.js` | `src/core/memory/fs-store.js` | CA | +append/entries/prune for episodic |
| `pipeline.js` | `src/core/effectors/pipeline.js` | CA | + semantic store integration |
| `kanban.js` | `src/core/effectors/kanban.js` | CA | Same |
| `goals.js` | `src/core/effectors/goals.js` | CA | Goals.md → user-service drive mapping |
| `server.js` | `server/index.js` | RW | WS v2, broadcast patterns, graceful shutdown |
| `s2s/pc-child/browser-agent` | `adapters/` | WRAP | Untouched, just re-pathed |

### LEAVE in NOVA until Phase 9

- `builds.js`, `radar/`, `video-render/`, `free-claude/` — not migrated, archived later.

### Directory Layout

```
mythos/
├── package.json                 (separate from NOVA — isolation)
├── .env.example
├── src/
│   ├── main.js                  (boot sequence, 14 steps)
│   └── core/
│       ├── config/
│       │   ├── schema.js        (MYTHOS_* + NOVA passthrough keys)
│       │   └── index.js         (validate() + frozen config)
│       ├── bus/
│       │   ├── event.js         (Event constructor)
│       │   └── index.js         (createBus())
│       ├── logger.js            (structured JSON, CA from NOVA)
│       ├── lifecycle/
│       │   └── index.js         (boot runner, shutdown, SIGINT handler)
│       ├── memory/
│       │   ├── store.js         (MemoryStore interface)
│       │   ├── fs-store.js      (FsStore base from vault.js)
│       │   ├── episodic.js      (JSONL append, daily rotation)
│       │   ├── semantic.js      (Markdown + sidecar)
│       │   ├── skills.js        (Procedural memory)
│       │   ├── working.js       (RAM WorkingMemory)
│       │   └── audit-writer.js  (Append-only audit JSONL)
│       ├── cortex/
│       │   ├── index.js         (createCortex — OODA loop)
│       │   └── ooda.js          (observe/orient/decide/act/reflect)
│       ├── goals/
│       │   └── index.js         (GoalSystem — arbiter, planner)
│       ├── brain/
│       │   ├── index.js         (createBrain — think())
│       │   ├── registry.js     (CA from NOVA)
│       │   ├── chain.js         (CA from NOVA)
│       │   ├── spend.js         (CA from activity-log)
│       │   └── lanes.default.js (from BRAIN-MAP.md)
│       ├── sensors/
│       │   ├── timer.js
│       │   ├── file.js
│       │   ├── ws.js
│       │   ├── job.js
│       │   └── metric.js
│       ├── effectors/
│       │   ├── adapter.js       (effectorFromTool)
│       │   ├── hub.js           (createEffectorHub)
│       │   ├── build-runner.js  (WRAP orchestrator)
│       │   ├── from-dashboard.js
│       │   ├── from-computer.js
│       │   ├── from-pc.js
│       │   ├── from-browser.js
│       │   ├── from-project.js
│       │   ├── agent-actions.js
│       │   ├── voice.js          (TTS effector)
│       │   ├── pipeline.js
│       │   ├── kanban.js
│       │   └── goals.js
│       ├── leash/
│       │   ├── index.js         (createLeash — check())
│       │   ├── tiers.js         (canonical tier table)
│       │   └── confirm.js       (CA from NOVA confirm.js)
│       ├── immune/
│       │   ├── monitor.js
│       │   ├── breakers.js
│       │   ├── watchdog.js
│       │   ├── diagnostician.js
│       │   ├── healer.js
│       │   ├── announcer.js
│       │   └── probes.js
│       ├── identity/
│       │   └── index.js
│       └── quota.js             (CV from NOVA)
├── providers/                   (CV/CA from NOVA app/lib/providers/)
├── adapters/                    (WRAP — s2s, pc-child, browser-agent)
├── server/
│   ├── index.js                 (Express + WS v2)
│   └── rate-limit.js            (CV from NOVA)
├── ui/
│   ├── public/
│   │   ├── js/
│   │   │   ├── ws.js            (CA from NOVA + subscribe)
│   │   │   ├── router.js        (hash router)
│   │   │   └── shell.js         (sidebar + header)
│   │   ├── css/
│   │   │   └── tokens.css       (CV from NOVA)
│   │   └── views/
│   │       ├── mind.js          (NEW — tick/goals/salience)
│   │       ├── memory.js        (NEW — 5-store browser)
│   │       ├── health.js        (NEW — breakers/providers)
│   │       └── audit.js         (NEW — leash trail)
│   └── views/
│       ├── goals.js             (CA from NOVA)
│       ├── kanban.js            (CA)
│       ├── pipeline.js          (CA)
│       └── confirm.js           (NEW — modal)
├── vault/                       (runtime data)
│   ├── Episodic/                (.gitkeep)
│   ├── Semantic/                (.gitkeep)
│   ├── Skills/                  (.gitkeep)
│   ├── Identity/                (.gitkeep)
│   ├── Goals/                   (.gitkeep)
│   ├── Audit/                   (.gitkeep)
│   └── Checkpoints/             (.gitkeep)
└── test/
    ├── helpers.js               (tempVaultDir, fakeBus, etc.)
    ├── config.test.js
    ├── bus.test.js
    ├── lifecycle.test.js
    └── boot.test.js
```

---

## §16 Build Phases, Gates & Chaos Drills

### Phase Gate Policy

> Every phase must pass: (1) `npm test` green, (2) manual smoke check, before proceeding to next.

### Phase 0 — Foundation

**Scope**: package.json, main.js, config, bus, lifecycle, logger, vault dirs, 4 test files.

```
Deliverables:
- package.json (separate from NOVA — same 4 deps, isolation for tests/lockfile)
- src/main.js (boot sequence skeleton)
- src/core/config/{schema,index}.js
- src/core/bus/{event,index}.js
- src/core/lifecycle/index.js
- src/core/logger.js
- test/{config,bus,lifecycle,boot}.test.js
- .env.example
- vault/{Episodic,Semantic,Skills,Identity,Audit,Checkpoints}/.gitkeep

Gate: npm install && npm test green && node src/main.js → ALIVE → Ctrl-C exit 0
```

### Phase 1 — Memory

**Scope**: fs-store, episodic, semantic, skills, identity store, audit, checkpoints, working memory.

```
Deliverables:
- src/core/memory/{store,fs-store,episodic,semantic,skills,working,audit-writer}.js
- Consolidate logic
- Decay/archive logic

Gate: round-trip write→recall, prune-by-age decay, audit append-only,
      checkpoint save/restore, consolidate merges
```

### Phase 2 — Brain

**Scope**: registry, chain, spend, quota, lanes.default, providers copy.

```
Deliverables:
- src/core/brain/{index,registry,chain,spend,lanes.default}.js
- providers/ (CV/CA from NOVA)
- src/core/quota.js

Gate: chainFor alive-only, cooldown skip, chainExhausted, brain-spend event, env override
```

### Phase 3 — Cortex

**Scope**: cortex OODA loop, timer sensor.

```
Deliverables:
- src/core/cortex/{index,ooda}.js
- src/core/sensors/timer.js

Gate: idle tick → 0 Brain calls (spy), high-salience → engages, tick cadence (fake timers)
```

### Phase 4 — Goals

**Scope**: GoalSystem — arbiter, planner, CRUD.

```
Deliverables:
- src/core/goals/index.js

Gate: id reindex semantics, active goal→intent, stats, budget enforcement
```

### Phase 5 — Leash

**Scope**: leash check, tiers, confirm, audit writer.

```
Deliverables:
- src/core/leash/{index,tiers,confirm,audit-writer}.js

Gate: tier0 auto, tier4 always, tier3 once, dry-run no-op,
      audit line per decision, wrong-connection cannot accept
```

### Phase 6 — Immune

**Scope**: monitor, breakers, watchdog, diagnostician, healer, announcer, probes, metric sensor.

```
Deliverables:
- src/core/immune/{monitor,breakers,watchdog,diagnostician,healer,announcer,probes}.js
- src/core/sensors/metric.js

Gate: breaker open→half-open, watchdog stall detect, healer playbook re-probe,
      checkpoint every N ticks
```

### Phase 7 — Sensors & Effectors

**Scope**: adapter + from-*.js (45 tools), build-runner, voice, file/ws/job sensors, WRAP adapters.

```
Deliverables:
- src/core/effectors/{adapter,hub,build-runner,from-dashboard,from-computer,from-pc,
                      from-browser,from-project,agent-actions,voice,pipeline,kanban,goals}.js
- src/core/sensors/{file,ws,job}.js
- adapters/ (s2s, pc-child, browser-agent)

Gate: danger→tier≥3, invoke normalization, 45 registered count,
      build-runner queued→done + restart-failed, job sensor perception
```

### Phase 8 — Identity

**Scope**: identity module, vault/Identity/{self,boundaries}.md.

```
Deliverables:
- src/core/identity/index.js
- vault/Identity/self.md (seed)
- vault/Identity/boundaries.md (seed)

Gate: loaded at boot, edit changes tier ceiling, MYTHOS_NAME override,
      entity has no write path to boundaries (contract test)
```

### Phase 9 — UI v2 & Cutover

**Scope**: server, WS v2, all views, NOVA→MYTHOS cutover.

```
Cutover plan:
1. Tag NOVA as nova-final
2. Side-by-side soak (MYTHOS :4478 vs NOVA :4477)
3. One-shot vault import (Goals.md, Kanban.json, Pipeline/)
4. Move app/ → archive/nova/
5. Update launch scripts to point mythos/
6. Rollback: archive/nova/ stays runnable

Gate: all views render, WS v2 messages flow, confirm modal works,
      Mind/Memory/Health/Audit views show live data
```

### Phase 10 — Chaos Drills

**Scope**: Failure injection tests proving honest-inert posture.

| Drill | Injection | Expected Behavior |
|-------|-----------|-------------------|
| Provider-killed | Kill Ollama/Groq process mid-call | Breaker opens, chain falls back, Brain returns `{offline:true}` |
| Cortex-stalled | Block event loop for >5×TICK_MS | Watchdog detects, restarts cortex, goals paused 'cortex-restart' |
| Disk-full | Write until ENOSPC | Anomaly emitted, writes return `{degraded:true}`, no crash |
| Memory-corrupt | Truncate JSONL mid-line | Corrupt line skipped, episodic continues, checkpoint-restore works |
| Concurrent-tick | Two tickOnce calls overlap | Reentrancy guard blocks second, first completes normally |
| Restart-mid-action | SIGKILL during effector dispatch | On next boot: running jobs→failed, goals→paused 'crash-recovery', audit consistent |

### Risk Register

| ID | Risk | Mitigation | Phase |
|----|------|------------|-------|
| R1 | Idle-loop Brain cost | Idle-skip (P3) + spend events/cap (P2) | P2, P3 |
| R2 | Memory growth | Decay + archive (P1), consolidate cadence | P1 |
| R3 | Autonomy safety | Audit + spend cap + MYTHOS_DRY_RUN + tier gates | P5 |
| R4 | Identity drift | Human-editable boundaries as tier ceiling | P8 |
| R5 | SPOF | Checkpoint every N ticks + restore (P6/P1) + drill (P10) | P1, P6, P10 |
| R6 | Port conflict | MYTHOS_PORT 4478 (NOVA stays 4477) + separate vault root | P0 |
| R7 | Stale copy | Git clone verified @ a0433b5, future `git pull` | Step 0 |

### Reuse Ledger

| NOVA Asset | Lines | Reuse | Phase |
|------------|-------|-------|-------|
| Provider modules (~20) | ~800 | CV/CA | P2 |
| registry.js | 218 | CA | P2 |
| chain.js | 110 | CA | P2 |
| activity-log.js | 154 | CA→spend.js | P2 |
| quota.js | 165 | CV | P2 |
| rate-limit.js | 54 | CV | P9 |
| logger.js | 73 | CA | P0 |
| vault.js | 83 | CA→fs-store.js | P1 |
| confirm.js | 65 | CA | P5 |
| voice-agent.js | 318 | CA→interpret.js | P7 |
| orchestrator.js | 136 | WRAP→build-runner | P7 |
| tools-* (5 files) | ~1081 | CA→from-*.js | P7 |
| agent-actions.js | 145 | CA | P7 |
| pipeline/kanban/goals | ~238 | CA | P7 |
| probes.js | 140 | CA | P6 |
| BRAIN-MAP.md | 66 | CV→lanes.default.js | P2 |
| server.js (patterns) | 1533 | RW | P9 |
| ws.js (client) | 181 | CA | P9 |
| tokens.css | 240 | CV | P9 |
| reasoning.js | 55 | DELETED | P2 |

**Total NOVA lines reused**: ~4,700 of ~5,600 (84%) — the other 16% is either DELETED (reasoning.js duplication) or REWRITTEN (server.js, voice-agent.js).
