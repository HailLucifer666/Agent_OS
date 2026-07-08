# MYTHOS — Build Roadmap

> Autonomous entity runtime evolving from NOVA (Agent OS). Greenfield scaffold,
> OODA cognitive loop, layered memory, tiered autonomy, immune system.
>
> **Phase Gate Policy**: Every phase must pass `npm test` green + manual smoke
> before proceeding. Zero new npm deps (dotenv, express, playwright-core, ws only).
> Vanilla JS CommonJS, `node:test`.

---

## ⚠️ MANDATORY — Update This File On Every Phase Push

**This ROADMAP.md and graphify-out/graph.html MUST be updated and pushed with every
phase gate commit. No phase is done until both files are synced.**

**Procedure:**
1. Flip the phase deliverables from ⬚ to ✅
2. Update the Progress table (test count, commit SHA)
3. Append the new commit to the Commit Log table
4. Regenerate `graphify-out/graph.html` with new nodes/edges for the phase
5. `git add -f graphify-out/graph.html mythos/ROADMAP.md && git commit && git push`

---

## Progress

| Phase | Status | Tests | Commit |
|-------|--------|-------|--------|
| P0 Foundation | ✅ Done | 26 | `0566acc` |
| P1 Memory | ✅ Done | 70 | `0566acc` |
| P2 Brain | ✅ Done | 113 | `3bf42de` |
| P3 Cortex | ✅ Done | 161 | `f1f6d3a` |
| P4 Goals | ✅ Done | 161 | `f1f6d3a` |
| P5 Leash | ⬚ Pending | — | — |
| P6 Immune | ⬚ Pending | — | — |
| P7 Sensors & Effectors | ⬚ Pending | — | — |
| P8 Identity | ⬚ Pending | — | — |
| P9 UI v2 & Cutover | ⬚ Pending | — | — |
| P10 Chaos Drills | ⬚ Pending | — | — |

**Current**: 161 tests, 25 src files, 9 provider files, 8 test files.

---

## Phase 0 — Foundation ✅

**Boot skeleton, config, event bus, lifecycle, logger, vault dirs.**

| Deliverable | Status |
|---|---|
| `package.json` (separate from NOVA) | ✅ |
| `src/main.js` (boot sequence) | ✅ |
| `src/core/config/{schema,index}.js` | ✅ |
| `src/core/bus/{event,index}.js` | ✅ |
| `src/core/lifecycle/index.js` | ✅ |
| `src/core/logger.js` | ✅ |
| `test/{config,bus,lifecycle,boot}.test.js` | ✅ |
| `.env.example` (32 MYTHOS_* keys) | ✅ |
| `vault/*/` .gitkeep dirs (6) | ✅ |

**Gate**: ✅ `npm test` green + `node src/main.js` → ALIVE → Ctrl-C exit 0

---

## Phase 1 — Memory ✅

**6 stores: episodic, semantic, skills, working, audit, checkpoints.**

| Deliverable | Status |
|---|---|
| `src/core/memory/fs-store.js` (base filesystem) | ✅ |
| `src/core/memory/episodic.js` (JSONL append-only) | ✅ |
| `src/core/memory/semantic.js` (md + sidecar) | ✅ |
| `src/core/memory/skills.js` (procedural) | ✅ |
| `src/core/memory/working.js` (RAM, tick-aware) | ✅ |
| `src/core/memory/audit-writer.js` (append-only trail) | ✅ |
| `src/core/memory/checkpoints.js` (atomic save/restore) | ✅ |
| `src/core/memory/index.js` (facade wiring all 6) | ✅ |
| `test/memory.test.js` (38 tests) | ✅ |
| Decay/archive logic | ✅ |
| Consolidate logic | ✅ |

**Gate**: ✅ Round-trip write→recall, prune-by-age decay, audit append-only,
checkpoint save/restore, consolidate merges.

---

## Phase 2 — Brain ✅

**Provider chain, unified think(), spend tracking, quota.**

| Deliverable | Status |
|---|---|
| `src/core/brain/lanes.default.js` (6 lanes) | ✅ |
| `src/core/brain/registry.js` (probing + alive filter) | ✅ |
| `src/core/brain/chain.js` (cooldown + key rotation) | ✅ |
| `src/core/brain/spend.js` (ring buffer) | ✅ |
| `src/core/brain/index.js` (think() + tryParseWithRepair) | ✅ |
| `providers/openai-compat.js` (factory) | ✅ |
| `providers/{zcode,nim,nim2,groq,mistral,ollama,openrouter,claude-cli}.js` | ✅ |
| `src/core/quota.js` (decoupled from free-models) | ✅ |
| `test/brain.test.js` (43 tests) | ✅ |
| `reasoning.js` → DELETED (absorbed into think()) | ✅ |

**Gate**: ✅ chainFor alive-only, cooldown skip, chainExhausted degradation,
brain-spend event, CHAIN_* env override.

---

## Phase 3 — Cortex ✅

**OODA cognitive loop, timer sensor.**

| Deliverable | Status |
|---|---|
| `src/core/cortex/ooda.js` (orient, goalRelevance, reflect cadence) | ✅ |
| `src/core/cortex/index.js` (tick loop, reentrancy guard, generation token) | ✅ |
| `src/core/sensors/timer.js` (periodic sensor.timer events) | ✅ |

**Gate**: ✅ Idle tick → 0 Brain calls, high-salience engages, tick cadence.

---

## Phase 4 — Goals ✅

**GoalSystem: CRUD, arbiter, planner, budget enforcement.**

| Deliverable | Status |
|---|---|
| `src/core/goals/index.js` (CRUD + arbitrate + plan + budget) | ✅ |
| Persist as `vault/Goals/<id>.json` | ✅ |
| Weighted arbiter (drive, priority, urgency, budget, salience, sticky) | ✅ |
| 4-step planner (plan→skills→budget guard→brain) | ✅ |
| Auto-pause on budget exhaustion | ✅ |

**Gate**: ✅ ID reindex semantics, active goal→intent, stats, budget enforcement.

---

## Phase 5 — Leash ⬚

**Tiered autonomy governance, confirm flow, audit trail.**

| Deliverable | Status |
|---|---|
| `src/core/leash/index.js` (check dispatch) | ⬚ |
| `src/core/leash/tiers.js` (T0–T4 tier table + rules) | ⬚ |
| `src/core/leash/confirm.js` (CA from NOVA confirm.js) | ⬚ |
| `src/core/leash/audit-writer.js` (per-decision audit line) | ⬚ |
| `MYTHOS_DRY_RUN` makes T≥1 no-op | ⬚ |

**Gate**: T0 auto, T4 always confirm, T3 once-grant, dry-run no-op,
audit line per decision, wrong-connection cannot accept.

---

## Phase 6 — Immune ⬚

**Self-healing: breakers, watchdog, diagnostician, healer, probes, metric sensor.**

| Deliverable | Status |
|---|---|
| `src/core/immune/monitor.js` | ⬚ |
| `src/core/immune/breakers.js` (CLOSED→OPEN→HALF_OPEN FSM) | ⬚ |
| `src/core/immune/watchdog.js` (cortex stall detect + restart) | ⬚ |
| `src/core/immune/diagnostician.js` | ⬚ |
| `src/core/immune/healer.js` (playbook DSL) | ⬚ |
| `src/core/immune/announcer.js` | ⬚ |
| `src/core/immune/probes.js` (CA from NOVA probes.js) | ⬚ |
| `src/core/sensors/metric.js` | ⬚ |

**Gate**: Breaker open→half-open, watchdog stall detect, healer playbook
re-probe, checkpoint every N ticks.

---

## Phase 7 — Sensors & Effectors ⬚

**45+ tools from NOVA, build-runner, voice, file/ws/job sensors.**

| Deliverable | Status |
|---|---|
| `src/core/effectors/adapter.js` (effectorFromTool) | ⬚ |
| `src/core/effectors/hub.js` (registry + dispatch) | ⬚ |
| `src/core/effectors/build-runner.js` (WRAP NOVA orchestrator) | ⬚ |
| `src/core/effectors/from-dashboard.js` (CA: 20 tools) | ⬚ |
| `src/core/effectors/from-computer.js` (CA: 4 tools) | ⬚ |
| `src/core/effectors/from-pc.js` (CA: 10 tools) | ⬚ |
| `src/core/effectors/from-browser.js` (CA: 10 tools) | ⬚ |
| `src/core/effectors/from-project.js` (CA: 1 tool) | ⬚ |
| `src/core/effectors/agent-actions.js` (CA) | ⬚ |
| `src/core/effectors/voice.js` (CA voice-agent) | ⬚ |
| `src/core/effectors/{pipeline,kanban,goals}.js` (CA) | ⬚ |
| `src/core/sensors/{file,ws,job}.js` | ⬚ |
| `adapters/` (s2s, pc-child, browser-agent) | ⬚ |

**Gate**: danger→tier≥3, invoke normalization, 45 registered count,
build-runner queued→done + restart-failed, job sensor perception.

---

## Phase 8 — Identity ⬚

**Self model, boundaries, tier ceiling enforcement.**

| Deliverable | Status |
|---|---|
| `src/core/identity/index.js` | ⬚ |
| `vault/Identity/self.md` (seed) | ⬚ |
| `vault/Identity/boundaries.md` (seed) | ⬚ |

**Gate**: Loaded at boot, edit changes tier ceiling, MYTHOS_NAME override,
entity has no write path to boundaries (contract test).

---

## Phase 9 — UI v2 & Cutover ⬚

**Server, WS v2 protocol, all views, NOVA→MYTHOS migration.**

| Step | Status |
|---|---|
| Tag NOVA as `nova-final` | ⬚ |
| Side-by-side soak (MYTHOS :4478 vs NOVA :4477) | ⬚ |
| Vault import (Goals.md, Kanban.json, Pipeline/) | ⬚ |
| Move `app/` → `archive/nova/` | ⬚ |
| Update launch scripts | ⬚ |
| Server + WS v2 protocol | ⬚ |
| All views (Mind, Memory, Health, Audit, Skills) | ⬚ |
| Rollback: archive/nova/ stays runnable | ⬚ |

**Gate**: All views render, WS v2 messages flow, confirm modal works,
Mind/Memory/Health/Audit views show live data.

---

## Phase 10 — Chaos Drills ⬚

**Failure injection tests proving honest-inert posture.**

| Drill | Injection | Expected | Status |
|---|---|---|---|
| Provider-killed | Kill Ollama/Groq mid-call | Breaker opens, chain falls back, `{offline:true}` | ⬚ |
| Cortex-stalled | Block event loop >5×TICK_MS | Watchdog detects, restarts cortex | ⬚ |
| Disk-full | Write until ENOSPC | Anomaly emitted, `{degraded:true}`, no crash | ⬚ |
| Memory-corrupt | Truncate JSONL mid-line | Corrupt line skipped, checkpoint-restore works | ⬚ |
| Concurrent-tick | Two tickOnce calls overlap | Reentrancy guard blocks second | ⬚ |
| Restart-mid-action | SIGKILL during effector dispatch | Jobs→failed, goals→paused, audit consistent | ⬚ |

---

## Risk Register

| ID | Risk | Mitigation | Phase |
|----|------|------------|-------|
| R1 | Idle-loop Brain cost | Idle-skip (P3) + spend events/cap (P2) | ✅ P2, P3 |
| R2 | Memory growth | Decay + archive (P1), consolidate cadence | ✅ P1 |
| R3 | Autonomy safety | Audit + spend cap + MYTHOS_DRY_RUN + tier gates | ⏳ P5 |
| R4 | Identity drift | Human-editable boundaries as tier ceiling | ⏳ P8 |
| R5 | SPOF | Checkpoint every N ticks + restore | ⏳ P6, P10 |
| R6 | Port conflict | MYTHOS_PORT 4478 (NOVA stays 4477) | ✅ P0 |
| R7 | Stale copy | Git clone verified @ `a0433b5` | ✅ Step 0 |

---

## NOVA Reuse Ledger

| NOVA Asset | Lines | Strategy | Phase | Status |
|------------|-------|----------|-------|--------|
| Provider modules (~20) | ~800 | CV/CA | P2 | ✅ |
| registry.js | 218 | CA | P2 | ✅ |
| chain.js | 110 | CA | P2 | ✅ |
| activity-log.js | 154 | CA→spend.js | P2 | ✅ |
| quota.js | 165 | CV | P2 | ✅ |
| rate-limit.js | 54 | CV | P9 | ⬚ |
| logger.js | 73 | CA | P0 | ✅ |
| vault.js | 83 | CA→fs-store.js | P1 | ✅ |
| confirm.js | 65 | CA | P5 | ⬚ |
| voice-agent.js | 318 | CA→interpret.js | P7 | ⬚ |
| orchestrator.js | 136 | WRAP→build-runner | P7 | ⬚ |
| tools-* (5 files) | ~1081 | CA→from-*.js | P7 | ⬚ |
| agent-actions.js | 145 | CA | P7 | ⬚ |
| pipeline/kanban/goals | ~238 | CA | P7 | ⬚ |
| probes.js | 140 | CA | P6 | ⬚ |
| BRAIN-MAP.md | 66 | CV→lanes.default.js | P2 | ✅ |
| server.js (patterns) | 1533 | RW | P9 | ⬚ |
| ws.js (client) | 181 | CA | P9 | ⬚ |
| tokens.css | 240 | CV | P9 | ⬚ |
| reasoning.js | 55 | DELETED | P2 | ✅ |

**Total NOVA lines reused**: ~4,700 of ~5,600 (84%). 16% DELETED or REWRITTEN.

---

## Commit Log

| Commit | Phase | Description |
|--------|-------|-------------|
| `0566acc` | P0+P1 | Architecture spec + runtime scaffold + 6 memory stores (70 tests) |
| `3bf42de` | P2 | Brain: 9 providers, chain, think(), spend, quota (113 tests) |
| `f1f6d3a` | P3+P4 | Cortex OODA loop + Goals system (161 tests) |
