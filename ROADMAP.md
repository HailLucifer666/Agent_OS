# MYTHOS — Build Roadmap

> Autonomous entity runtime evolving from NOVA (Agent OS) 100× into a **continuous
> autonomous entity** — an always-on cognitive loop that perceives, reasons, acts,
> and self-heals. Greenfield `mythos/` scaffold: OODA cognitive loop, layered
> persistent memory, tiered autonomy, immune system.
>
> Ground truth: MYTHOS-ARCHITECTURE.md (v1, verified against GitHub
> `HailLucifer666/Agent_OS`). NOVA baseline commit `a0433b5`.

## Phase Gate Policy

> Every phase must pass: (1) `npm test` green, (2) manual smoke check, (3) **zero open
> CRITICAL drift items against MYTHOS-ARCHITECTURE.md** — before proceeding to next.

Zero new npm dependencies — same 4 as NOVA (`dotenv`, `express`, `playwright-core`,
`ws`). Vanilla JS CommonJS. `node:test` + `node:assert/strict`. Separate
`mythos/package.json` for isolation. `MYTHOS_PORT` 4478 (NOVA stays 4477).

---

## ⚠️ MANDATORY SYNC FILES — UPDATE ON EVERY PUSH

The following files **MUST** be updated and committed alongside every phase gate push.
No phase is considered complete until both files reflect the current state.

| File | Action | Location |
|---|---|---|
| `ROADMAP.md` | Mark phase ✅ Done, update test count, append commit SHA to log | `ROADMAP.md` |
| `graphify-out/graph.html` | Regenerate with new MYTHOS nodes/edges for completed phase | `graphify-out/graphify-out/graph.html` |

**Procedure for every phase completion:**
1. Run `npm test` — must be green
2. Update `ROADMAP.md`: flip phase status to ✅ Done, update test count in Progress table, add commit to Commit Log
3. Regenerate `graphify-out/graph.html`: add new module nodes + dependency edges for the phase (use `mythos/.graph-data.json` as source, merge into existing NOVA data with community ID offset +50)
4. `git add -f graphify-out/graph.html ROADMAP.md`
5. Commit and push together

**Skipping this step blocks the phase gate.**

---

## ⚠️ Spec-Conformance Audit — 2026-07-09

> **Update 2026-07-10**: all 13 CRITICAL items below (headline findings 1-5, D-01
> through D-39) are now fixed — see
> [Phase 4.5](#phase-45--spec-conformance-remediation-✅-done--was-blocks-p5),
> which is ✅ Done. This section is kept as the historical audit record; findings
> below describe the pre-remediation state. MAJOR/MINOR items remain open, tracked
> in Known Deviations.

Every shipped module (P0–P4) was read file-by-file and diffed against
MYTHOS-ARCHITECTURE.md, verified against an SSH clone of `HailLucifer666/Agent_OS`
@ `a78f38b`. Result: **all 5 phases pass their own gate (161/161 tests green)**, but
the *code does not match the spec exactly* in 46 places. Passing tests only proves
each module is internally consistent with itself — it does not prove the module
matches the architecture, and in one case it hid a bug at the seam between two
modules that each individually pass their own suite.

**Rule going forward**: P5 (Leash) may not start until every item in
[Phase 4.5 — Remediation](#phase-45--spec-conformance-remediation-blocks-p5-️) below
is fixed and covered by a regression test. MAJOR/MINOR items are tracked in
[Known Deviations](#known-deviations-non-blocking-track-before-p9-cutover) and must
be resolved before the P9 NOVA→MYTHOS cutover.

### Headline findings

1. **MYTHOS cannot actually boot as a live entity yet.** `mythos/src/main.js` only
   registers 5 stub boot steps (`config`, `logger`, `bus`, `vault-dirs`, `idle-beat`).
   The `memory`, `brain`, `cortex`, and `goals` modules exist in `src/core/` and are
   unit-tested in isolation, but **none of them are wired into `main.js`'s boot
   sequence**. There is no live OODA tick running today — every phase so far has
   been built and tested as an island.
2. **Cross-module contract break, invisible to unit tests**: `cortex/index.js:88`
   strips `orient()`'s ranked output down to bare perceptions
   (`.map(r => r.perception)`) before calling `goals.arbitrate()` — discarding
   `rankedSalience`. But `goals/index.js`'s arbiter reads `p.rankedSalience`
   directly off each item, expecting it to be there. Net effect: the arbiter's
   salience-boost term (10% of the goal-selection score, per spec's formula) is
   **silently always zero** in the assembled system, even though `cortex-goals.test.js`
   passes — because the test suite drives each half of the seam separately.
3. **Bus event names drift from spec in 3 places that future phases depend on**:
   `brain.spend` (spec: `brain-spend`), `sensor.timer` (spec: `perception.tick` — and
   `sensor.*` isn't even a valid channel under the bus's own taxonomy), and
   `lifecycle.cortex-started`/`-stopped` (spec: `lifecycle.started`/`stopped`).
   Any P6/P9 module built by reading the spec literally will silently miss these
   events.
4. **Memory consolidation is not implemented as designed.** The facade's
   `consolidate()` bypasses each store's correct `consolidate()` method, never calls
   Brain to distill episodic→semantic, and both episodic decay and semantic
   low-confidence pruning **permanently delete data** instead of archiving it —
   contradicting the spec's explicit no-silent-data-loss intent and directly
   threatening the P10 "Memory-corrupt" and "Restart-mid-action" chaos drills.
5. **`package.json` declares zero dependencies.** Spec requires exactly 4
   (`dotenv`, `express`, `ws`, `playwright-core`); none are declared, and `dotenv`
   is never `require()`'d anywhere — `.env.example` is currently decorative.

---

## Progress

| Phase | Status | Tests | Commit | Drift (Critical / Major / Minor) |
|-------|--------|-------|--------|-----------------------------------|
| P0 Foundation | ✅ Done, ⚠️ major/minor drift | 26 | `0566acc` | 0 / 4 / 6 |
| P1 Memory | ✅ Done, ⚠️ major/minor drift | 70 | `0566acc` | 0 / 6 / 4 |
| P2 Brain | ✅ Done, ⚠️ major/minor drift | 113 | `3bf42de` | 0 / 3 / 4 |
| P3 Cortex | ✅ Done, ⚠️ major/minor drift | 161 | `f1f6d3a` | 0 / 4 / 4 |
| P4 Goals | ✅ Done, ⚠️ minor drift | 161 | `f1f6d3a` | 0 / 3 / 5 |
| Phase 4.5 Remediation | ✅ Done — 13/13 criticals closed | 174 | `3c75c26` | 0 / 0 / 0 |
| P5 Leash | ✅ Done | 184 | `a837afd` | 0 / 0 / 1 |
| P6 Immune | ✅ Done | 234 | `1c0735b` | 0 / 0 / 0 |
| P7 Sensors & Effectors | ✅ Done, ⚠️ one environment-blocked pre-existing test | 272 (270 pass / 1 skip / 1 fail) | `532106d` | 0 / 0 / 1 |
| P8 Identity | ✅ Done | 293 (291 pass / 1 skip / 1 fail) | `6898d92` | 0 / 0 / 0 |
| P9 UI v2 (server + JARVIS HUD; cutover deferred) | ✅ Done | 316 (314 pass / 1 skip / 1 fail) | `b776b73` | 0 / 0 / 0 |
| P10 Chaos Drills | ⬚ Pending | — | — | — |

**Current**: 316 tests (293 pre-existing + 23 new in P9), 314 passing / 1 skipped / 1
failing. 64 src files (+`core/identity/index.js`) + `server/{index,rate-limit}.js` +
30 `ui/public/` assets (JARVIS HUD: neural-map/overlay/widgets/voice/confirm modules,
6 panel views, 10 css files), `effectors/{adapter,hub,build-runner,goals,voice,routes,
from-computer,from-pc,from-browser,from-dashboard,from-project,pipeline,kanban,
agent-actions,collectors/abtop}.js`, `sensors/{file,ws,job}.js`), `adapters/{pc-child,
browser-agent}/index.js`, 10 provider files (+`edge-tts.js`), 23 test files
(+`server.test.js`, `p9-diffs.test.js`, `hud-model.test.js`). 0 CRITICAL / 20 MAJOR / 24 MINOR drift items
open across P0–P4 (P5 fixed one self-introduced bug pre-merge — see Phase 5 section —
and surfaced one new MINOR item, D-55, in P1's `memory/audit-writer.js`, since fixed
opportunistically — see Known Deviations). P6 fixed three bugs in the architecture
doc's own given code before they ever shipped (breaker backoff formula, missing `bus`
injection, watchdog double-restart) — see Phase 6 section — and introduced no new
drift. P7 found and fixed a real, pre-existing production bug in P3's
`cortex/index.js` (a missing `await` on `decide()` meant every real action dispatch
since Phase 3 silently resolved `unknown-effector` — caught by the mandated
real-instance integration test) and a real bug in the spec's own given
`effectors/goals.js` `addGoal()` (pre-populated the bridge map before `writeBack()`,
defeating `writeBack()`'s own "append unmapped goal" logic) — see Phase 7 section. P7
introduced one new MINOR item: `test/boot.test.js` fails in this specific Node
v26.1.0/Windows sandbox because an active `fs.watch()` handle (used by the new,
spec-mandated `sensors/file.js`) blocks OS signal delivery to the process — verified
as an environment/libuv defect with a zero-application-code minimal reproduction, not
a defect in MYTHOS code; see Phase 7 section for the full investigation. P8 shipped
`src/core/identity/index.js` (new) and rewrote the Phase-4.5 placeholder
`src/core/memory/identity.js` (D-15) into the real header-sectioned self.md store;
patched `brain/index.js` (optional persona injection) and `leash/index.js` (mandatory
`getMaxAutonomousTier()` check, tier ceiling now
`Math.min(config.AUTONOMOUS_MAX_TIER, identity.getMaxAutonomousTier())` —
most-restrictive-wins); wired the real module into `main.js`'s `identity` boot step,
deleting `createIdentityStub()` wholesale. One resolved spec-vs-reality drift item:
`memory/identity.js`'s `stats()` returns the bare `{count}` shape (matching
`semantic.js`/`skills.js`'s real D-20 convention), not the spec's illustrative
`{count,bytes,lastWrite}` — 0 CRITICAL / 0 MAJOR / 0 MINOR drift introduced by P8. The
1 fail/1 skip carried into P8's total are the same pre-existing, environment-blocked
P7 items (`test/boot.test.js`'s SIGINT check and `test/sensors-file.test.js`'s
isolated positive path) — neither is a P8 regression. P8 is done; P9 (UI v2 &
Cutover) is now unblocked.

---

## Phase 0 — Foundation ✅ ⚠️ drift

**Scope**: package.json, main.js, config, bus, lifecycle, logger, vault dirs, 4 test files.

| Deliverable | Status |
|---|---|
| package.json (separate from NOVA — same 4 deps, isolation for tests/lockfile) | ✅ file exists, ⚠️ deps missing (see D-01) |
| src/main.js (boot sequence skeleton) | ✅ file exists, ⚠️ not a real boot sequence (see D-04) |
| src/core/config/{schema,index}.js | ✅ |
| src/core/bus/{event,index}.js | ✅ |
| src/core/lifecycle/index.js | ✅ |
| src/core/logger.js | ✅ |
| test/{config,bus,lifecycle,boot}.test.js | ✅ |
| .env.example | ✅ file exists, ⚠️ never loaded (see D-02) |
| vault/{Episodic,Semantic,Skills,Identity,Audit,Checkpoints}/.gitkeep | ✅ |

**Gate**: ✅ `npm install && npm test` green && `node src/main.js` → ALIVE → Ctrl-C exit 0
(gate passes as written, but ALIVE does not mean the entity is actually running its
cognitive loop — see D-04)

**Drift found** (full detail in Phase 4.5 / Known Deviations):

| ID | Severity | File:Line | Spec says | Code does |
|----|----------|-----------|-----------|-----------|
| D-01 | CRITICAL | `mythos/package.json` | exactly 4 deps: dotenv, express, ws, playwright-core | no `dependencies` key at all |
| D-02 | CRITICAL | `mythos/src/main.js` | `.env` loaded at boot | `require('dotenv').config()` never called; config reads raw `process.env` only |
| D-03 | CRITICAL | `mythos/src/core/lifecycle/index.js:50` | naming always via `config.MYTHOS_NAME`, never hardcoded | `logger.info('lifecycle.alive', { name: 'MYTHOS' })` — literal string, and `createLifecycle` doesn't even receive `config` |
| D-04 | CRITICAL | `mythos/src/main.js:46-61` | 14-18 named FAIL-FAST/DEGRADED boot steps incl. episodic, audit, immune, cortex, stores, identity, brain-probe, goals, recovery, sensors, effectors, server, cortex-tick | only 5 empty-body steps registered (`config`,`logger`,`bus`,`vault-dirs`,`idle-beat`); memory/brain/cortex/goals modules exist but are never booted |
| D-05 | MAJOR | `mythos/src/core/config/schema.js:12` | `MYTHOS_VAULT_ROOT` REQUIRED | has a default (`./vault`), never errors when missing |
| D-06 | MAJOR | `mythos/src/core/bus/index.js` | built-in middleware `auditTap`/`historyTap`/`redactSecrets` wired into every bus | none of the three exist or are registered anywhere |
| D-07 | MAJOR | `mythos/src/core/lifecycle/index.js:54-84` | 7-step shutdown (sensors stop → cortex drain → episodic flush → checkpoint write → audit flush → exit 0 → SHUTDOWN_MS hard-exit) | only the hard-exit timer exists; comment admits "nothing to stop yet — this is the scaffold" |
| D-08 | MAJOR | `mythos/src/core/bus/event.js:18` | `depth = cause.depth+1` or `1` for root | root events get `depth: 0` |
| D-09 | MINOR | `mythos/src/core/bus/index.js:56` | `seq` starts at 0 for first dispatched event | `seq` initialized 0, first event gets `seq: 1` |
| D-10 | MINOR | `mythos/src/core/bus/index.js:38` | depth guard drops when `depth > maxDepth` | drops at `depth >= maxDepth` (one step stricter) |
| D-11 | MINOR | `mythos/src/core/config/schema.js` | NOVA passthrough incl. `PORT` (4477), `BIND` | neither key exists in schema |
| D-12 | MINOR | `mythos/src/core/bus/index.js:49` | `perception.coalesced` should reflect real overflow count | always emits `{count: 1}` per dropped event |
| D-13 | MINOR | `mythos/src/core/config/index.js` | no `SHUTDOWN_MS` config key exists to back D-07's step 7 | n/a — key missing entirely |
| D-14 | MINOR | `mythos/src/core/bus/index.js:115` | `history(filter)` generic filter | only supports a predicate function, no object/channel filter |

---

## Phase 1 — Memory ✅ ⚠️ drift

**Scope**: fs-store, episodic, semantic, skills, identity store, audit, checkpoints, working memory.

| Deliverable | Status |
|---|---|
| src/core/memory/{store,fs-store,episodic,semantic,skills,working,audit-writer}.js | ✅ |
| **identity store** | ⬚ **missing entirely** — explicit P1 deliverable per §16, no `identity.js` exists (see D-15) |
| Consolidate logic | ⚠️ present but wrong — bypasses per-store consolidate(), never calls Brain (see D-17) |
| Decay/archive logic | ⚠️ present but **deletes instead of archives** (see D-18) |

**Gate**: ✅ round-trip write→recall, prune-by-age decay, audit append-only,
checkpoint save/restore, consolidate merges — passes as written, but the gate
criteria describe behavior the code does not actually implement (decay deletes
rather than archives; consolidate doesn't distill via Brain). Tests assert what the
code does, not what the spec requires — this gate needs new tests before it can be
trusted (see Phase 4.5).

**Drift found**:

| ID | Severity | File:Line | Spec says | Code does |
|----|----------|-----------|-----------|-----------|
| D-15 | CRITICAL | `mythos/src/core/memory/` | Identity store is a P1 deliverable (§16 Phase 1 scope) | no `identity.js` file exists; `memory/index.js:36` only creates the directory |
| D-16 | CRITICAL | `mythos/src/core/memory/fs-store.js:82-126` | corrupt line skipped **with anomaly event** | skipped silently — `createFsStore` never receives a `bus`, structurally cannot emit `health.anomaly` |
| D-17 | CRITICAL | `mythos/src/core/memory/index.js:49-67` | consolidate(): (1) flush working→episodic (2) episodic→semantic via Brain 'simple' (3) decay old episodic (4) archive low-confidence semantic | (1) calls a documented no-op (`working.flushToEpisodic()`) (2) never invoked — no Brain reference anywhere in the memory module (3) calls `episodic.prune()` directly, bypassing the correct `episodic.consolidate()` (4) never invoked |
| D-18 | CRITICAL | `mythos/src/core/memory/fs-store.js:133-149`, `semantic.js:121-136` | old episodic → digest+gzip archive; low-confidence semantic → `_archive.md` | both `fs.unlinkSync` the file — **permanent deletion**, no archive step of any kind |
| D-19 | MAJOR | `mythos/src/core/memory/skills.js:171`, `audit-writer.js:87` | all 5 stores implement `init/write/recall/get/consolidate/stats` | `skills.js` has no `consolidate()`; `audit-writer.js` has no `recall()`, `get()`, or `consolidate()` |
| D-20 | MAJOR | `mythos/src/core/memory/*.js` | `stats() → { count, bytes, lastWrite }` | every store returns a different shape, none include `bytes`; audit-writer uses `lastWriteTs` not `lastWrite` |
| D-21 | MAJOR | `mythos/src/core/memory/fs-store.js` | per-path in-process async mutex for MD/JSON read-modify-write | no mutex anywhere — `skills.js:144-160 recordUse()` does unlocked read→mutate→write |
| D-22 | MAJOR | `mythos/src/core/memory/semantic.js:76-79`, `skills.js:72-75` | recall scorer must be injectable (`{scorer=lexicalScore}`), v1 = overlap*0.7 + recency*0.3 | only episodic supports injection; semantic/skills hardcode `matched/terms.length` with no recency term at all |
| D-23 | MAJOR | `mythos/src/core/memory/working.js`, `checkpoints.js` | WorkingMemory rebuilt from episodic tail **only if checkpoint missing** | `working.init()` unconditionally rebuilds from episodic tail; `checkpoints.load()` is never called by the memory module at all |
| D-24 | MINOR | `mythos/src/core/memory/semantic.js:66-97` | recall = filename match + term overlap | only does term overlap; filename is never compared |
| D-25 | MINOR | `mythos/src/core/memory/episodic.js` | `EPISODE_SCHEMA` (15 named fields) defined/enforced | no schema constant exists; only `id`/`ts` are auto-filled, rest are caller's responsibility |
| D-26 | MINOR | `mythos/src/core/memory/audit-writer.js:43-47` | write failure → `{ ref: null, degraded: true }` (same shape as other stores) | returns `{ ok: false, degraded: true }` — no `ref` field, inconsistent shape |
| D-27 | MINOR | `mythos/src/core/memory/episodic.js:131-139` | `get(ref)` should find any past record | bounded to current-month files only — refs from a prior month become unfindable |

---

## Phase 2 — Brain ✅ ⚠️ drift

**Scope**: registry, chain, spend, quota, lanes.default, providers copy.

| Deliverable | Status |
|---|---|
| src/core/brain/{index,registry,chain,spend,lanes.default}.js | ✅ |
| providers/ (CV/CA from NOVA) | ⚠️ 2 of 9 providers (`openrouter.js`, `claude-cli.js`) are orphaned — never wired into chain.js/registry.js (see D-30) |
| src/core/quota.js | ✅ |
| `reasoning.js` deleted | ✅ confirmed — no trace anywhere in `mythos/` except an explanatory comment |

**Gate**: ✅ chainFor alive-only, cooldown skip, chainExhausted, brain-spend event,
env override — **the "brain-spend event" clause of this gate is not actually met**;
see D-28.

**Drift found**:

| ID | Severity | File:Line | Spec says | Code does |
|----|----------|-----------|-----------|-----------|
| D-28 | CRITICAL | `mythos/src/core/brain/index.js:74` | `bus.emit('brain-spend', {...})` | emits `'brain.spend'` (dot, not hyphen) — silent event-name contract break for any future spec-literal subscriber |
| D-29 | MAJOR | `mythos/providers/ollama.js`, `openrouter.js`, `claude-cli.js` | canonical provider interface: `{name, chat, isAvailable, getStatus, getModel}` | ollama exports only `{chat, listModels}`; openrouter/claude-cli export only `{chat}` — none implement the canonical shape |
| D-30 | MAJOR | `mythos/providers/openrouter.js`, `claude-cli.js` | — | built but **never imported** by `chain.js`/`registry.js`/`lanes.default.js` — dead code |
| D-31 | MAJOR | `mythos/src/core/brain/registry.js:112-121` | providers alive-probed like groq/mistral/nim | `zcode`'s liveness check is presence-of-API-key only, not an actual reachability probe — inconsistent with the other 3 |
| D-32 | MINOR | `mythos/src/core/brain/index.js:82-88` | spend estimate = ~4 chars/tok, split input/output | sums separate input+output estimates into one number then re-splits by an arbitrary 60/40 ratio — not faithful to actual input/output split |
| D-33 | MINOR | `mythos/providers/mistral.js:12`, `zcode.js:11`, `nim.js:11`/`nim2.js:11` | provider default models should agree with `lanes.default.js` | fallback defaults disagree with the lane table (`mistral-small-latest` vs `mistral-large-2512`; `glm-4.6` vs `glm-5.2`; NIM defaults vs lane-table model names) — currently dead since chain.js always passes an explicit model, but a landmine for future refactors |
| D-34 | MINOR | `mythos/src/core/brain/chain.js:14` | Absorb Map: "add zcode/groq/mistral" to LANES | code also adds an undocumented `nim2` lane not called out by the absorb map |
| D-35 | MINOR | (spec text itself) | Brain Lanes table labels build-lane hop 2 "NIM GLM-5.2" | code correctly routes GLM through `zcode`, not `nim` — this is a **spec typo**, not a code bug; flag for a future spec correction, do not "fix" the code to match |

---

## Phase 3 — Cortex ✅ ⚠️ drift

**Scope**: cortex OODA loop, timer sensor.

| Deliverable | Status |
|---|---|
| src/core/cortex/{index,ooda}.js | ✅ |
| src/core/sensors/timer.js | ✅ |

**Gate**: ✅ idle tick → 0 Brain calls (spy), high-salience → engages, tick cadence
(fake timers) — passes, but "high-salience → engages" is measured wrong at the
goal-arbitration layer; see D-38.

**Drift found**:

| ID | Severity | File:Line | Spec says | Code does |
|----|----------|-----------|-----------|-----------|
| D-36 | CRITICAL | `mythos/src/core/sensors/timer.js:17` | emits `'perception.tick'` | emits `'sensor.timer'` — not even a valid channel under the bus's own taxonomy (`perception\|decision\|action\|health\|memory\|lifecycle\|audit\|identity`) |
| D-37 | CRITICAL | `mythos/src/core/cortex/index.js:167,174` | lifecycle events `'lifecycle.started'` / `'lifecycle.stopped'` | emits `'lifecycle.cortex-started'` / `'lifecycle.cortex-stopped'` |
| D-38 | CRITICAL | `mythos/src/core/cortex/index.js:88` | `goals.arbitrate(ranked, working)` — arbiter receives the salience-ranked structure | strips ranked output to bare perceptions (`.map(r => r.perception)`) before calling arbitrate — **cross-module bug**: `goals/index.js`'s arbiter reads `p.rankedSalience` directly off each item expecting it to exist; it never does, so the arbiter's salience-boost term (10% of the goal-selection score) is silently always zero. Neither module's own test suite catches this — it only shows up at the seam. |
| D-39 | CRITICAL | `mythos/src/core/cortex/index.js:108,121,131` | leash check / breaker check / effector dispatch are mandatory, fail-closed gates | all three are conditionally skipped if the dependency is falsy (`if (leash && typeof leash.check === 'function')`) — if leash isn't wired at construction, every action bypasses tier gating silently. Fail-open, not fail-closed — direct violation of §1 principles #2 and #4. |
| D-40 | MAJOR | `mythos/src/core/sensors/timer.js:17` | payload `{kind:'timer', ts}` with `salienceHint: 0.1`, meta `{source:'sensor-timer'}` | payload is `{ts, generation}` — no `kind`, no salience hint, no `source`; `orient()` will score these at salience 0, not spec's 0.1 baseline |
| D-41 | MAJOR | `mythos/src/core/cortex/index.js:136-142` | episodic action record includes `tier: leashResult.tier` | `tier` field is dropped entirely from the write |
| D-42 | MAJOR | `mythos/src/core/cortex/index.js:32-34` | `perception.coalesced.original` should be the true pre-truncation count | array is truncated *before* `.length` is read for the payload — `original` always equals `MAX_DRAIN_PER_TICK`, never the real overflow count |
| D-43 | MINOR | `mythos/src/core/cortex/ooda.js:7` | `orient(perceptions, goals, working)` | actual signature is `orient(perceptions, activeGoal)` — caller resolves the active goal itself first; functionally OK, contract text doesn't match |
| D-44 | MINOR | `mythos/src/core/cortex/index.js:84` | `decide(ranked, goals, working, config)` | actual signature adds undocumented `brain`, `memory` params; `config` param is accepted but never read (dead) |
| D-45 | MINOR | `mythos/src/core/cortex/index.js:78` | `health.anomaly` payload carries the error | code passes `err.message` (string) only — stack trace and error type are discarded |
| D-46 | MINOR | `mythos/src/core/cortex/index.js:14,68,105,129` | `AbortSignal.timeout(config.ACTION_TIMEOUT_MS\|\|30000)` read live per dispatch | value is cached once at `createCortex()` construction time, not re-read from config per action |

---

## Phase 4 — Goals ✅ ⚠️ drift

**Scope**: GoalSystem — arbiter, planner, CRUD.

| Deliverable | Status |
|---|---|
| src/core/goals/index.js | ✅ |

**Gate**: ✅ id reindex semantics, active goal→intent, stats, budget enforcement —
passes; goal persistence correctly uses `vault/Goals/<id>.json` (not `Goals.md`),
correctly deferring the Goals.md-facing effector to Phase 7 per spec's compatibility
note.

**Drift found** (no CRITICAL items — this module is the closest to spec; its one
critical-class issue, D-38, is charged to Phase 3 above since the bug is in what
`cortex/index.js` hands to `arbitrate()`, not in `arbitrate()` itself):

| ID | Severity | File:Line | Spec says | Code does |
|----|----------|-----------|-----------|-----------|
| D-47 | MAJOR | `mythos/src/core/goals/index.js:218-223` | Brain call includes `budget: goal.budget.tokens - goal.spent.tokens` | `budget` field is omitted entirely from the `ctx.brain.think(...)` call — Brain never learns the remaining token budget for the goal |
| D-48 | MAJOR | `mythos/src/core/goals/index.js:224-226` | `parsed = result.parsed \|\| tryParse(result.content)` fallback | only checks `result.parsed`; no fallback parse of `result.content` if Brain returns raw unparsed text |
| D-49 | MAJOR | `mythos/src/core/goals/index.js:32-34` | budget defaults sourced from config (`GOAL_TOKEN_BUDGET`, `GOAL_ACTION_BUDGET` exist in schema) | hardcodes `tokens: 50000, actions: 50` — never reads the two config keys that exist specifically for this |
| D-50 | MINOR | `mythos/src/core/goals/index.js:29` | schema example shows `status: 'active'` | actual default on create is `status: 'proposed'` — likely just the spec excerpt using an illustrative value, but worth reconciling in the spec doc |
| D-51 | MINOR | `mythos/src/core/goals/index.js:122-125` | "Enforce MAX_ACTIVE_GOALS" (mechanism unspecified) | caps candidates by slicing the first N in insertion order *before* scoring — a high-priority goal created 6th can be permanently excluded from arbitration while a low-priority 1st-created goal is always considered |
| D-52 | MINOR | `mythos/src/core/goals/index.js:166-178` vs `cortex/ooda.js` | `goalRelevance(p,g)` reads as one shared concept | implemented twice, independently, in both `goals/index.js` and `cortex/ooda.js` — not verified whether the two copies are logically identical |
| D-53 | MINOR | `mythos/src/core/goals/index.js:317-326` | — | extra undocumented exports (`_internal`, top-level `DRIVE_WEIGHTS`) beyond the spec's described contract — harmless test-support surface |
| D-54 | MINOR | `mythos/src/core/goals/index.js` | goals excluded by the `MAX_ACTIVE_GOALS` cap — behavior unspecified by spec | excluded goals stay `status:'active'` forever, invisible to the arbiter but still counted "active" by `getActiveGoals()`/stats callers elsewhere — a gap, not a contradiction |

---

## Phase 4.5 — Spec-Conformance Remediation ✅ Done — was BLOCKS P5

**Closed 2026-07-10 — all 13 CRITICAL items fixed, each covered by a new regression
test, 174/174 tests green.** P5 (Leash) is now unblocked. These were the items that
either violated a core §1 principle, broke an event-name contract future phases
would rely on, or meant the system didn't actually do what its passing tests implied.

| # | ID | Fix required | Status |
|---|----|--------------|--------|
| 1 | D-01 | Add `dependencies` to `mythos/package.json`: `dotenv`, `express`, `ws`, `playwright-core` (exact 4, pinned to same versions as NOVA `app/package.json`) | ✅ |
| 2 | D-02 | Call `require('dotenv').config()` at the top of `src/main.js` before config validation runs | ✅ |
| 3 | D-03 | Pass `config` into `createLifecycle({bus, config})`; replace hardcoded `name: 'MYTHOS'` with `name: config.MYTHOS_NAME` | ✅ |
| 4 | D-04 | Rebuild `src/main.js`'s boot sequence as the spec's 14-18 named FAIL-FAST/DEGRADED steps; wire `memory`, `brain`, `cortex`, `goals` (already built) into real boot steps so the entity actually runs its OODA loop end-to-end, not just in unit tests | ✅ |
| 5 | D-15 | Build `src/core/memory/identity.js` implementing the same `MemoryStore` interface as the other stores; wire into `memory/index.js` facade | ✅ |
| 6 | D-16 | Pass `bus` into `createFsStore`; emit `health.anomaly{kind:'corrupt-line',...}` on every skipped corrupt line instead of swallowing silently | ✅ |
| 7 | D-17 | Rewrite `memory/index.js consolidate()` to: call `working.flushToEpisodic()` correctly (or implement the flush it currently no-ops), call each store's own `consolidate()` (not `episodic.prune()` directly), and wire a real Brain 'simple' call for episodic→semantic distillation (skip cleanly if Brain offline) | ✅ |
| 8 | D-18 | Replace `fs.unlinkSync` in episodic decay and semantic low-confidence pruning with: digest-to-.md + gzip archive (episodic) and move-to-`_archive.md` (semantic) — no permanent deletion | ✅ |
| 9 | D-28 | Rename the brain-spend bus event from `'brain.spend'` to `'brain-spend'` (update the one emit site and any listening tests) | ✅ |
| 10 | D-36 | Rename timer sensor event from `'sensor.timer'` to `'perception.tick'`; add `kind:'timer'` to payload and `salienceHint: 0.1` | ✅ |
| 11 | D-37 | Rename cortex lifecycle events from `'lifecycle.cortex-started'`/`'-stopped'` to `'lifecycle.started'`/`'lifecycle.stopped'` | ✅ |
| 12 | D-38 | Fix `cortex/index.js:88` to pass the full ranked structure (not bare `.map(r => r.perception)`) into `goals.arbitrate()`; add a regression test asserting `arbitrate()` receives objects carrying `rankedSalience` | ✅ |
| 13 | D-39 | Make leash check / breaker check / effector dispatch mandatory in `act()` — if `leash`/`effectors` are not supplied to `createCortex`, fail construction loudly (throw) rather than silently skipping the gate at dispatch time | ✅ |

**Implementation note (superseded by Phase 5)**: this session originally wired
temporary fail-closed `createNullLeash()`/`createNullEffectors()` placeholders
(deny-all / no-op) in `main.js` to satisfy D-39's mandatory-construction requirement.
Phase 5 replaced `createNullLeash()` wholesale with the real `createLeash()` module —
`main.js` no longer contains a null leash anywhere. `createNullEffectors()` stays
(now commented `[TEMP — remove when Phase 7 ships]`) and a new `createIdentityStub()`
was added alongside it (`[TEMP — remove when Phase 8 ships]`) since Leash also
requires an `identity` dependency that doesn't ship until Phase 8.

---

## Known Deviations (non-blocking, track before P9 cutover)

All MAJOR and MINOR items from the audit above that are not already listed in
Phase 4.5. Does not block P5–P8, but must be resolved (or explicitly re-accepted
into the spec) before the P9 NOVA→MYTHOS cutover, since several of these affect
data integrity and observability that the P10 chaos drills will exercise.

**MAJOR** (20 total, tracked by ID above): D-05, D-06, D-07, D-08, D-19, D-20,
D-21, D-22, D-23, D-29, D-30, D-31, D-40, D-41, D-42, D-47, D-48, D-49 — plus D-06/D-07
overlap noted in P0/P1 tables above (bus middleware + shutdown sequence both belong
to the P0 bus/lifecycle modules but are load-bearing for P1's audit-writer and P6's
watchdog respectively — fix opportunistically when touching those files, don't
defer both to P9).

**MINOR** (23 open, tracked by ID above): D-09 through D-14, D-24 through D-27,
D-32 through D-35, D-43 through D-46, D-50 through D-54. D-55 resolved (see below).

| ID | Severity | File:Line | Finding |
|----|----------|-----------|---------|
| D-55 | MINOR — ✅ RESOLVED | `mythos/src/core/memory/audit-writer.js:11-24` | `redact()` only inspected top-level keys of `args` — nested objects/arrays (e.g. a `{headers:{authorization:...}}` shape, or free text typed into a form via `ui_type`/`browser_type`) were copied verbatim into the append-only, permanent `vault/Audit/*.jsonl` trail. `REDACT_KEYS` was also narrow (no `cookie`, `credential`, `session`). Found by Phase 5's security audit while reviewing what Leash writes through this module; flagged rather than fixed in that session since `audit-writer.js` is P1-shipped code outside Phase 5's touch scope. Fixed opportunistically: `redact()` now recurses through nested objects and arrays at any depth, and `REDACT_KEYS` includes `cookie`, `credential`, `session`. Regression tests added in `mythos/test/memory.test.js` (nested-object and array-of-objects cases); full suite (234 tests) green. |

Full detail for every ID is in the per-phase "Drift found" tables above — this
section exists only as a consolidated non-blocking backlog view.

---

## Phase 5 — Leash ✅ Done (2026-07-10)

**Scope**: leash check, tiers, confirm, audit writer.

**Full build spec**: [MYTHOS-PHASE-BUILD-SPEC.md § Phase 5 — Leash](MYTHOS-PHASE-BUILD-SPEC.md#phase-5--leash) —
exact code skeletons, resolved spec ambiguities, integration points against the
real shipped P0–P4 code, and an anti-drift checklist. Built to the corrected,
mandatory-gating, config-not-hardcoded conventions Phase 4.5 established.

| Deliverable | Status |
|---|---|
| src/core/leash/tiers.js (TIER_TABLE, verbatim from §9) | ✅ |
| src/core/leash/confirm.js (createConfirmRegistry — CA from NOVA) | ✅ |
| src/core/leash/audit-writer.js (deliberate 1-line re-export of memory/audit-writer.js) | ✅ |
| src/core/leash/index.js (createLeash — check(), fail-closed on unwritable audit) | ✅ |
| src/core/config/schema.js — `LEASH_CONFIRM_TTL_MS` key added | ✅ |
| src/main.js — `createNullLeash()` replaced with real `createLeash()`; `createIdentityStub()` added; boot order identity → goals → effectors → leash → cortex | ✅ |
| test/leash.test.js (9 tests: tier gates, dry-run, fail-closed audit, construction-throws, connection-scoped confirm, 2 real-instance integration tests) | ✅ |

**Gate**: tier0 auto ✅, tier4 always ✅, tier3 once ✅, dry-run no-op ✅,
audit line per decision ✅, wrong-connection cannot accept ✅ — all verified by
`test/leash.test.js`, 184/184 tests green including the full existing suite.

**Security review finding, fixed pre-merge**: an independent security audit of
`check()` found that the spec's own code (transcribed verbatim) checked
`config.MYTHOS_DRY_RUN && tier >= 1` *before* resolving `tier === undefined ? 3
: tier` (the "unknown tool" fail-safe). `undefined >= 1` is always `false` in
JS, so an unmapped/hallucinated tool name skipped the DRY_RUN no-op entirely
and fell through to a real auto-allow whenever `AUTONOMOUS_MAX_TIER >= 3` — a
fail-open gap for exactly the case (a tool the planner invented) DRY_RUN is
meant to catch. **Fixed**: the "unknown tool -> T3" resolution now runs before
any `tier >= N` comparison in `check()` (`src/core/leash/index.js`), with a
regression test (`test/leash.test.js`, "security-audit regression: dry-run
still no-ops an unmapped tool name..."). This is a deliberate, documented
deviation from `MYTHOS-PHASE-BUILD-SPEC.md`'s literal statement ordering —
the spec's own snippet had this bug, do not "fix" the code back to match it.

**Anti-drift checklist**: all 11 items verified (TIER_TABLE character-for-character
match, exact decision-reason strings, construction-throws for each missing dep,
`maxTier`/`MYTHOS_DRY_RUN` read live inside `check()` not cached, `LEASH_CONFIRM_TTL_MS`
sourced from config not `process.env`, `leash/audit-writer.js` remains a 1-line
re-export, every `writeAudit()` call wrapped by `failClosedIfUnwritable()`, identity/
effectors stubs in `main.js` marked `[TEMP — remove when Phase N ships]`, Phase 4.5's
D-39 fail-closed gate confirmed already in place in `cortex/index.js`, `goal.grants`
uses string key `'3'`, boot order is identity → goals → effectors → leash → cortex).

**Note**: real `main.js` has more boot steps than the spec's simplified reproduction
(`brain-probe`, `recovery`, `sensors` — all pre-existing from Phase 4.5). The `identity`
and `leash` steps were inserted into the *real* step list, not used to replace it
wholesale — `identity` step after `brain-probe`/before `goals`, `leash` step (which
also constructs the `effectors` stub immediately before using it) after `recovery`/
before `cortex`. This satisfies the spec's dependency ordering intent (Ambiguity #5)
without discarding Phase 4.5's existing boot steps.

---

## Phase 6 — Immune ✅ Done (2026-07-10)

**Scope**: monitor, breakers, watchdog, diagnostician, healer, announcer, probes, metric sensor.

**Full build spec**: [MYTHOS-PHASE-BUILD-SPEC.md § Phase 6 — Immune](MYTHOS-PHASE-BUILD-SPEC.md#phase-6--immune) —
includes the breaker-backoff formula fix (the spec's own `resetAt * 2` doubles an
absolute timestamp, not a delay) and the watchdog/healer split (watchdog is
detection-only; the healer's `'stall-restart'` playbook does the actual restart —
do not let watchdog call `cortex.stop()`/`start()` directly, that double-restarts).

| Deliverable | Status |
|---|---|
| src/core/immune/breakers.js (createBreaker — CLOSED→OPEN→HALF_OPEN→CLOSED FSM, delay-based backoff) | ✅ |
| src/core/immune/watchdog.js (createWatchdog — stall DETECTION only, never restarts cortex itself) | ✅ |
| src/core/immune/diagnostician.js (createDiagnostician — anomaly → typed diagnosis, severity map) | ✅ |
| src/core/immune/healer.js (createHealer + 5 SEED_PLAYBOOKS + matchClause DSL evaluator) | ✅ |
| src/core/immune/probes.js (createProbes — registry/quota status aggregation + provider-down/quota-low anomaly emission) | ✅ |
| src/core/immune/announcer.js (createAnnouncer — speaks health/heal/recovery events, mandatory `speak()`) | ✅ |
| src/core/immune/monitor.js (createMonitor — checkpoint-every-N-ticks + memory-growth detection + recoverFromCrash()) | ✅ |
| src/core/sensors/metric.js (createMetricSensor — probes+quota poll every 4s, emits `perception.metric` with `.salience`) | ✅ |
| src/core/config/schema.js — `CHECKPOINT_EVERY_TICKS` key added | ✅ |
| src/core/goals/index.js — `debitBudget()` gains one `bus.emit('health.anomaly', {kind:'budget-exhausted',...})` line | ✅ |
| src/main.js — new `'immune'` boot step (getCortex()/getGoals() thunks); `'recovery'` step replaced wholesale with `recoverFromCrash()`; `'cortex'` step starts the watchdog; `'sensors'` step starts the metric sensor; shutdown stops all immune components | ✅ |
| test/immune.test.js (48 tests: breaker FSM incl. backoff-doubling regression, watchdog detection-only regression, diagnostician severity/lookup, healer DSL both shapes + cooldown + idempotent pause-goal, real-registry degrade-lane regression, real-goals budget-exhausted producer regression, real-quota null-guard regression, announcer, monitor checkpoint cadence on a real memory facade + memory-growth + threshold-sync + recoverFromCrash, metric sensor, and a real-instance bus+cortex+diagnostician+healer+watchdog stall→restart-exactly-once integration test) | ✅ |

**Gate**: breaker open→half-open ✅, watchdog stall detect ✅, healer playbook
re-probe ✅, checkpoint every N ticks ✅ — all verified by `test/immune.test.js`,
234/234 tests green including the full existing suite (real `boot.test.js`
end-to-end spawn confirms the new `'immune'` boot step and the rewired
`'recovery'`/`'cortex'`/`'sensors'` steps still boot to ALIVE and exit 0 on SIGINT).

**Three bugs fixed in the architecture doc's own given code before they ever shipped**
(see MYTHOS-PHASE-BUILD-SPEC.md § Phase 6, Spec Ambiguities Resolved #2–#4 for full
reasoning): (1) the given Watchdog both emitted `health.anomaly{kind:'cortex-stall'}`
*and* called `cortex.stop()/start()` directly — since `bus.emit()` dispatches
synchronously, the Diagnostician→Healer pipeline's own restart would have already
run inside that same `emit()` call, so every stall would have restarted cortex
twice; Watchdog is detection-only here, the Healer's `'stall-restart'` playbook is
the only restart path. (2) The given breaker backoff (`resetAt = min(resetAt*2,
now+maxResetMs)`) doubles an absolute epoch timestamp, not the backoff delay — this
file tracks `currentResetMs` separately and doubles that. (3) The given
`createBreaker({name, failThreshold, windowMs, resetMs, maxResetMs})` never took
`bus` as a parameter despite calling `bus.emit()` inside `recordFailure()` — a
guaranteed `ReferenceError` on the first trip; `bus` (and `config`) are now real,
required constructor params.

**No-producer gaps closed**: three of the five SEED_PLAYBOOKS (`rotate-nim-key`,
`quota-guard`, `budget-pause`) would have been permanently dead code — nothing in
shipped code produced `provider-down`/`quota-low`/`budget-exhausted` anomalies.
`probes.js`'s `getStatus()` (already polled every 4s for the metric sensor) now
also emits those two as a documented side effect; `goals/index.js`'s
`debitBudget()` gained the one-line `budget-exhausted` emit alongside its
pre-existing synchronous self-pause (made race-safe by an idempotent `pause-goal`
action that checks `goal.status` first).

**Anti-drift checklist**: all 12 items verified (`bus.emit`/`bus.subscribe` only,
no invented event names outside `health.diagnosed`/`health.healed`/
`perception.metric`/`action.speak-requested`/`lifecycle.recovered`, every factory
throws at construction on its one mandatory dependency, `STALL_MS`/`WATCHDOG_MS`/
`BREAKER_*`/`CHECKPOINT_EVERY_TICKS` read from config not hardcoded, the two
`50000000` memory-growth literals verified equal by a dedicated sync test, watchdog
confirmed to never call `cortex.stop`/`start`, every `registry`/`probes` status call
`await`ed, quota null-guard confirmed via regression test, `.salience` not
`.salienceHint`, `debitBudget` diff is exactly the one added line, `createBreaker`
called with `{name,bus,config}` everywhere in this phase's own code).

**Note**: `main.js`'s pre-existing `'recovery'` boot step (inline
`memory.checkpoints.load()` + conditional `lifecycle.recovered` emit, from Phase
4.5) is superseded wholesale by `recoverFromCrash()` per this session's "delete
wholesale, don't patch" convention — it now also pauses active-at-crash goals
(§10 invariant #2), which the old inline version never did. The `'immune'` boot
step is inserted right after `'memory'` (bus/config/memory all it needs) and
before `'brain-probe'`, well ahead of `'cortex'`/`'goals'` — safe because
`healer`/`watchdog` close over `getCortex()`/`getGoals()` thunks, never direct
references (Ambiguity #1).

---

## Phase 7 — Sensors & Effectors ✅ Done (2026-07-10)

**Scope**: adapter + from-*.js (45 tools), build-runner, voice, file/ws/job sensors, WRAP adapters.

**Full build spec**: [MYTHOS-PHASE-BUILD-SPEC.md § Phase 7 — Sensors & Effectors](MYTHOS-PHASE-BUILD-SPEC.md#phase-7--sensors--effectors) —
the adapter pattern given once precisely (not all 45 tool bodies), the effector
hub's `get()`/`registerNamed()` additions needed for Leash's `dangerWhen` lookup
and the goals/kanban/pipeline "named service" bridges, and `build-runner.js`'s
`init() → {recoveredJobs}` contract that Phase 10's crash drill depends on.

| Deliverable | Status |
|---|---|
| src/core/effectors/{adapter,hub,build-runner,goals,voice,routes}.js | ✅ |
| src/core/effectors/{from-computer,from-pc,from-browser,from-dashboard,from-project}.js (45 tools) | ✅ |
| src/core/effectors/{pipeline,kanban,agent-actions}.js (DI-factory CA, re-pointed off the injected fs-store) | ✅ |
| src/core/effectors/collectors/abtop.js (untouched CA — see ambiguity below) | ✅ |
| src/core/sensors/{file,ws,job}.js | ✅ |
| adapters/{pc-child,browser-agent}/index.js (untouched CA, re-pathed requires; `adapters/s2s/` skipped — see ambiguity below) | ✅ |
| providers/edge-tts.js (untouched CA, zero re-pointing needed) | ✅ |
| src/core/config/schema.js — 4 keys added (`MYTHOS_BUILD_CONCURRENCY`, `MYTHOS_JOBS_MAX_PERSISTED`, `MYTHOS_WATCH_DIRS`, `MYTHOS_FILE_DEBOUNCE_MS`) | ✅ |
| src/main.js — `createNullEffectors()` deleted wholesale; `'leash'` step now builds the real hub + all 46 registered effectors (45 tools + voice) + goals-effector bridge; `'sensors'` step adds the `perception.*` → `working.pushPerception()` bridge + file/ws/job sensors | ✅ |
| test/{effectors-adapter,effectors-hub,build-runner,sensors-file,sensors-job,effectors-goals-md,integration-cortex-effectors}.test.js + danger→tier≥3 and 45-registered-count gate tests (in effectors-hub.test.js) | ✅ |

**Gate**: danger→tier≥3 ✅, invoke normalization ✅, 45 registered count ✅,
build-runner queued→done + restart-failed ✅, job sensor perception ✅ — all verified
by the new test files, 270/272 tests green (1 pre-existing test environment-blocked,
1 new test environment-blocked — both documented below, neither a MYTHOS code defect).

**Two real bugs found and fixed, beyond this phase's own code**:
1. **`cortex/index.js` (Phase 3, already shipped) was missing an `await`** on its
   `decide()` call — `decide()` is `async` (it awaits `goals.plan()` internally), so
   the unawaited call returned a pending Promise object, which is truthy, so the
   `if (!decision) return;` guard never tripped, but `decision.tool`/`decision.args`
   were `undefined` by the time `act()` read them — meaning **every real action
   dispatch since Phase 3 shipped silently resolved to `unknown-effector`**. This is
   exactly the class of seam bug (D-38) the spec's mandated real-instance integration
   test (lesson #4) exists to catch, and it did: `test/integration-cortex-effectors.test.js`
   failed until the one-token `await` fix landed. Fixed at `src/core/cortex/index.js:71`.
2. **The spec's own given `effectors/goals.js` `addGoal()`** pre-populated the
   Goals.md↔GoalSystem bridge map with the new goal's `{goalId,text,created}` *before*
   calling `writeBack()` — but `writeBack()`'s own "append any user-service goal not
   yet in Goals.md" loop decides what to append by checking whether the goal's id is
   already present in the map, so the pre-population made that check always false,
   meaning a goal created via `addGoal()` could never actually be written into
   `Goals.md`. Fixed by letting `writeBack()`'s existing append logic do the map
   push instead of `addGoal()` doing it twice.

**Spec/reality gaps resolved beyond the 13 documented ambiguities** (same
"documented, not silently papered over" convention as Ambiguities #3/#4/#6):
- `adapters/s2s/` (CA of `app/lib/s2s/*`) was **not built** — none of the 45 tools'
  function bodies import `s2s-child`/`s2s-completions` (confirmed by reading
  `tools-dashboard.js`/`tools-pc.js`/`tools-browser.js` in full); `ask_agent`'s
  dispatch wiring is injected separately and unrelated to s2s. Building an unused
  adapter directory nobody calls would be inventing scope, not migrating it.
- `tools-dashboard.js`'s `monitor_snapshot`/`kill_session` tools depend on
  `app/lib/collectors/abtop.js` (a NOVA-dashboard-only multi-agent-CLI-session
  monitor) and `read_status` depends on NOVA's `app/lib/probes.js` (dashboard
  provider-tile status) — neither is in the spec's Full Code or mapping table.
  `abtop.js` was CA'd verbatim (self-contained, honest-inert if the `abtop` CLI
  isn't installed) into `effectors/collectors/abtop.js`; `read_status` was
  re-pointed to MYTHOS's own `immune/probes.js` (the real status-aggregation
  equivalent) instead. `abtop.start()` is deliberately **not** called from
  `main.js` — see the next item.
- `effectors/pipeline.js`/`kanban.js`/`agent-actions.js` and `from-project.js`/
  `from-dashboard.js` deviate from the spec's worked-example requires
  (`require('./pipeline')` as a bare NOVA-style singleton) — since every other P7
  module follows a strict `create*({...deps})` DI-factory convention (and NOVA's
  singleton-over-`require('./vault')` pattern has no equivalent to inject a
  per-instance `fs`), these three are DI factories, and `from-project.js`/
  `from-dashboard.js` receive the already-constructed instances via a `ctx` object
  built once in `main.js`'s `'leash'` step, rather than requiring singletons.
- `app/lib/voice/routes.js`'s `ALL_ROUTES` reads `app/public/js/sidebar-config.js`
  — a NOVA dashboard frontend file that doesn't exist in headless MYTHOS through
  P7. CA'd verbatim; its own pre-existing fallback list (already designed for a
  missing/unparsable config file) degrades `navigate()` gracefully rather than
  inventing a MYTHOS-side sidebar config nobody specified.
- **`abtop.start()` was tried in `main.js`'s `'leash'` step and reverted**: it
  spawns a shell-wrapped child process (`spawn('abtop', ..., {shell:true})`),
  which measurably changes how Windows delivers console signals to the whole
  process group and broke `test/boot.test.js`'s graceful-SIGINT-shutdown check.
  In NOVA, `abtop.start()` was called by `server.js` — i.e. whatever owns the
  dashboard surface, a role Phase 9 takes on in MYTHOS, not this headless boot
  sequence. Until Phase 9 calls it, `monitor_snapshot`/`kill_session` stay
  honest-inert (`enabled:false`), which is correct — no dashboard process exists
  yet to monitor CLI sessions for.

**One pre-existing test now fails in this specific sandbox for a verified environment
reason, not a MYTHOS defect**: `test/boot.test.js`'s graceful-SIGINT-shutdown check
fails whenever the new (spec-mandated) `sensors/file.js` is wired in, on this
Node v26.1.0/Windows box. Root-caused with a zero-application-code minimal
reproduction: an `fs.watch()` handle on *any* directory, by itself, blocks
`child.kill('SIGINT'|'SIGTERM')` from ever reaching this process's registered
signal handlers on this Node/Windows combination — confirmed independent of path
form, watch target, `ref()`/`unref()`, and signal type. A related but distinct
native crash (`Assertion failed: !_wcsnicmp(filename, dir, dirlen), file
src\win\fs-event.c`) fires when a file is written directly at the root of a
non-recursively-`fs.watch()`'d directory on this box; `test/sensors-file.test.js`'s
positive-path assertion is isolated into a child process (`test-fixtures/
file-sensor-child.js`) so that native crash can't abort the whole suite, and
gracefully skips (via `t.skip()`) if it fires. Neither issue is reproducible in
`sensors/file.js`'s own logic — both were reproduced with plain `fs.watch()` +
`fs.writeFileSync()` and zero MYTHOS code. Do not "fix" this by removing
`fs.watch()` or weakening the sensor's design; it is expected to work normally
on a standard Node LTS / non-sandboxed Windows or Linux host.

**Anti-drift checklist**: all 13 items verified. Item 2 (`open_artifact` left at
the T3 default, `leash/tiers.js` untouched) and item 9 (`openrouter`/`claude-cli`
never imported by anything in `effectors/`/`adapters/`) hold as specified. Item 1
(`danger:true` → `tierOf>=3` for all 45 real tool names) holds with one documented,
pre-existing exception: `pipeline_advance` carries a `dangerWhen` (not `danger:true`)
and sits at T1 in `leash/tiers.js`'s own comment ("approve only — dangerWhen handles
reject") — a deliberate P5-owned design where `dangerWhen` elevates the gate at
`leash.check()` time independent of base tier; `tiers.js` was not edited to force
this one case to T3.

---

## Phase 8 — Identity ✅ Done (2026-07-10)

**Scope**: identity module, identity memory store (D-15), vault/Identity/{self,boundaries}.md,
brain/leash patches, main.js boot-step rewiring.

**Full build spec**: [MYTHOS-PHASE-BUILD-SPEC.md § Phase 8 — Identity](MYTHOS-PHASE-BUILD-SPEC.md#phase-8--identity) —
resolves the module-vs-store split (this phase's `identity/index.js` is the
boundary-enforcement layer; the P1-deliverable `memory/identity.js`, D-15, is
the underlying markdown+sidecar store) and the exact tier-ceiling precedence with
Leash (`Math.min(config.AUTONOMOUS_MAX_TIER, identity.getMaxAutonomousTier())`,
both read live, never cached — most-restrictive wins).

| Deliverable | Status |
|---|---|
| src/core/identity/index.js (checkBoundary/persona/learn/getMaxAutonomousTier) | ✅ |
| src/core/memory/identity.js — rewritten wholesale from the Phase-4.5 placeholder into the real header-sectioned self.md store (closes D-15) | ✅ |
| src/core/memory/index.js — already wired `identity` store (no change needed, verified) | ✅ |
| vault/Identity/self.md (seed) | ✅ |
| vault/Identity/boundaries.md (seed) | ✅ |
| src/core/brain/index.js — optional `identity` param, `identity.persona()` used for system-prompt injection when present | ✅ |
| src/core/leash/index.js — mandatory `getMaxAutonomousTier()` constructor check; `maxTier = Math.min(config.AUTONOMOUS_MAX_TIER, identity.getMaxAutonomousTier())` | ✅ |
| src/main.js — `createIdentityStub()` deleted wholesale; `'identity'` boot step constructs the real module and re-wires `brain` with identity | ✅ |
| test/identity.test.js, test/identity-boundaries-contract.test.js, test/identity-leash-integration.test.js (21 new tests) | ✅ |
| test/leash.test.js — `noopIdentity()` updated with `getMaxAutonomousTier()`; all pre-existing P5 leash tests still pass | ✅ |
| test/brain.test.js — persona-injection-with/without-identity regression added | ✅ |
| test/memory.test.js — pre-P8 placeholder-API `identity` tests updated to the real store's `write(text, opts)` signature | ✅ |

**Gate**: loaded at boot ✅, edit changes tier ceiling ✅ (real-instance
`identity-leash-integration.test.js`, 4 scenarios), MYTHOS_NAME override ✅ (self.md
persona wins over config), entity has no write path to boundaries ✅ (contract test:
static source grep + no-suspicious-method-name + behavioral guarded-fs-spy, all 3
pass) — 293/293 tests exercised, 291 pass / 1 skip / 1 fail (the 1 fail/1 skip are
the same pre-existing, environment-blocked P7 items, not a P8 regression).

**Verified deltas from the spec's illustrative pseudocode** (documented, not silently
papered over — same convention as Ambiguities #2–#6):
1. `memory/identity.js` already existed as a Phase-4.5 placeholder (flat, no header
   sections, `stats()` returning bare `{count}`, `consolidate()` a no-op) — replaced
   wholesale per its own header comment ("Full persona/boundaries/preference-learning
   logic ships in Phase 8"). Its 8 pre-existing placeholder-shaped tests in
   `test/memory.test.js` used the old `write({text, source, confidence})` object-arg
   API; updated to the real store's `write(text, opts)` two-arg signature so the full
   suite passes.
2. **`stats()` shape** (Anti-Drift item 11): the spec's own Full Code literally
   returns `{count, bytes, lastWrite}`, but the real house convention (verified
   against `semantic.js:152-154`/`skills.js:162-165`) is bare `{count}` — matched the
   real convention, not the spec's illustrative text, and added a unit test asserting
   the exact key set.
3. `brain/index.js` and `leash/index.js`'s real code matched the spec's documented
   "before" diffs verbatim (P5's real 6-dependency `createLeash(deps)` signature,
   not the spec's illustrative 4-param stub) — both patches applied cleanly as spec'd.
4. `test/leash.test.js`'s `noopIdentity()` helper needed `getMaxAutonomousTier()`
   added (returns `4`, the highest `AUTONOMOUS_MAX_TIER` any existing P5 leash test
   exercises) once Leash's constructor started mandating it — confirmed all
   pre-existing P5 leash tests still pass with `Math.min(config.AUTONOMOUS_MAX_TIER, 4)`
   never changing an observed outcome.
5. The spec's own `identity-leash-integration.test.js` Full Code called
   `createLeash({bus, config, identity, auditWriter})`, omitting the real leash's
   mandatory `goals`/`effectors` deps — fixed `buildStack()` to pass trivial fakes
   (`{get: () => null}` / `{get: () => undefined}`), matching `test/leash.test.js`'s
   own `noopEffectors()` pattern. All 4 integration scenarios (deny-list block,
   boundaries-more-restrictive, config-more-restrictive, at-ceiling-auto-allow) verified
   against the real `tiers.js` table (`create_goal`=1, `launch_app`=2).
6. `main.js`'s real boot sequence constructs `brain` early (inside the `'memory'`
   step, `createBrain({config, bus})`, no identity) because `memory` itself takes
   `brain` as a constructor dependency for its `consolidate()` distillation path —
   pre-existing architecture, not restructured. Since `identity` needs `memory.fs`/
   `memory.identity` to exist first, and Brain's `identity` param is optional/cosmetic
   (Ambiguity #5, not a safety gate), the surgical fix was to cheaply reconstruct
   `brain` a second time inside the `'identity'` boot step
   (`brain = createBrain({config, bus, identity})`, reassigning the closure `let`) once
   `identity.init()` resolves — a stateless factory call, nothing held open on the
   discarded instance. `memory`'s own internal `brain` reference (captured by value
   at `createMemory()` construction) is unaffected and keeps working exactly as
   before; every step *after* `'identity'` (`goals`, `leash`, `cortex`) sees the
   identity-wired `brain`. The pre-existing `'leash'` boot step already called
   `createLeash({bus, config, identity, auditWriter: memory.audit, goals, effectors})`
   with the real 6-param shape by reference — no change needed there.

**Anti-Drift Checklist**: all 11 items verified — `checkBoundary`/`persona`/`learn`
copied character-for-character; `grep -n "boundaries" src/core/identity/index.js`
shows only `loadBoundaries`/`BOUNDARIES_PATH`/`fs.readText` lines; `memory/identity.js`
has zero references to "boundaries" anywhere, including comments (caught and fixed —
see below); `createLeash` throws at construction if identity lacks `checkBoundary` or
`getMaxAutonomousTier`; `createBrain`'s `identity` stays optional; `config.AUTONOMOUS_MAX_TIER`
read via the exact key, fail-safe default is `1` only; `consolidate()` archives via
append, never deletes; both factories accept `{bus, config, ...}` and emit
`health.anomaly` on their respective failure paths; `main.js` constructs
identity-dependent modules after `identity.init()` resolves; no
`writeBoundaries`/`saveBoundaries`/`setBoundaries` method exists anywhere.

**One self-caught bug, fixed before merge**: the spec's own Full Code for
`memory/identity.js` includes a header comment mentioning "the human-only
boundaries.md" — literal prose the spec itself gives — which would have failed this
same phase's own contract test (`test/identity-boundaries-contract.test.js`'s "no
reference to boundaries.md at all" check, which is intentionally comment-blind — it
regexes the whole file, not just code). Caught by running the new contract test
against the spec's literal wording before merge; reworded the comment to describe the
same boundary without the trigger string.

**Note**: this is the Identity *module* (self/boundaries logic + tier-ceiling
enforcement), distinct from the Identity *memory store* (D-15) — both shipped
together in this phase since the module cannot function without the store.

---

## Phase 9 — UI v2 (Server + JARVIS HUD) ✅ Done (2026-07-10) — Cutover DEFERRED

**Scope shipped**: Express + WS v2 server (spec-verbatim backend), JARVIS-style
full-screen radial neural HUD (user-directed UI design, replaces the spec's
sidebar shell — see deviation #1), shipped-module diffs (logger/lifecycle/cortex/
schema/hub), 23 new tests. **Cutover NOT performed** — user-confirmed deferral:
the spec gates cutover on all 20 MAJOR Known Deviations being closed and they
remain open; cutover becomes its own post-P10 step. MYTHOS (:4478) runs
side-by-side with NOVA (:4477).

**Full build spec**: [MYTHOS-PHASE-BUILD-SPEC.md § Phase 9 — UI v2 & Cutover](MYTHOS-PHASE-BUILD-SPEC.md#phase-9--ui-v2--cutover) —
backend followed verbatim (relay table, dispatchAction, verifyClient, rate
limits); only the UI layer diverges, deliberately.

| Deliverable | Status |
|---|---|
| server/rate-limit.js — CV byte-identical from app/lib/rate-limit.js (only the header path reference updated, CRLF preserved) | ✅ |
| server/index.js — spec Full Code: 127.0.0.1 bind, CORS allowlist, global/expensive limiters, static ui/public/, REST (goals CRUD / kanban / pipeline / status), SPA fallback, WS v2 verifyClient (CSWSH), broadcastAll, shared dispatchAction, full bus→WS relay table (exact strings) | ✅ |
| server/index.js — spec-mandated `/api/memory/:store` (episodic tail / semantic-skills-identity recall('') / audit query, normalized `{ts,summary,kind}`) + new `/api/stats` (HUD density snapshot) | ✅ |
| src/core/logger.js — `onLog(fn)` hook (threshold-gated, listener-crash-proof, returns unsubscribe) | ✅ |
| src/core/lifecycle/index.js — `registerStopServer(fn)` as shutdown step 0 (wss.close → httpServer.close, best-effort) | ✅ |
| src/core/cortex/index.js — act() requireConfirm branch calls `leash.confirm.create(summary, {decision,goalId,tier}, 'system')` and embeds `confirmId` in the confirm-request payload (spec Ambiguity #2 contract closed) | ✅ |
| src/core/config/schema.js — `ACTION_TIMEOUT_MS` (default 30000); cortex reads the schema key, fallback deleted; 3 test fakes updated to mirror it | ✅ |
| src/core/effectors/hub.js — `registerNamed('kanban-effector'/'pipeline-effector')` in main.js (brief claimed all three registered; only goals-effector was) + breaker-registry `[Symbol.iterator]` so the spec's `for..of effectors.breakers` works on the real wrapper | ✅ |
| src/main.js — `'server'` boot step, fail-fast, after 'leash' before 'cortex' (§13 order); constructor-throws if any named effector missing (anti-drift #5) | ✅ |
| ui/public/ — JARVIS HUD: index.html shell (no nav markup), ws.js (spec verbatim), app.js boot, stats-bus, neural-map/{graph-model,graph-layout (pure), hud-canvas, core-orb}, overlay/{overlay-manager, panel-registry}, widgets/{widget-host, widget-registry, 7 kinds}, voice/{voice-loop, mic-indicator}, confirm/confirm-modal | ✅ |
| ui/public/js/views/{goals,kanban,pipeline,speech-to-text}.js — CA byte-identical from app/public/js/views/ | ✅ |
| ui/public/js/views/{memory,audit,health}.js — spec Full Code, panel-mounted | ✅ |
| ui/public/css — tokens.css + goals/kanban/pipeline/memory.css CV byte-identical; hud/overlay/widgets/voice/confirm.css new (token vars only); fonts/ copied (tokens.css @font-face targets) | ✅ |
| test/server.test.js (7), test/p9-diffs.test.js (6), test/hud-model.test.js (10) | ✅ |
| ROADMAP.md + graphify-out/graph.html (communities 70 Server / 71 UI, +50 convention) synced in the same commit | ✅ |

**Gate** (reinterpreted for the HUD): server boots in §13 position and entity
stays ALIVE ✅; WS v2 messages flow (live smoke: 9 ticks/9s, health on 4s cadence,
salience-gated perceptions, actions) ✅; panels render with live data (goals CRUD
round-trip browser→REST→GoalSystem→Goals.md verified in a real browser) ✅;
confirm modal works (tier-4 modal rendered in a real browser against the real
transport + real confirm registry; Approve click → confirm-reply →
`leash.confirm.accept(id,'system')` → dispatchAction → effector invoked exactly
once + budget debited + action.completed) ✅. 316 tests, 314 pass / 1 skip /
1 fail (the same pre-existing environment-blocked boot.test.js fs.watch/SIGINT
item from P7/P8 — its `gotAlive` path now also proves the server boot step
reaches ALIVE). One nuance the 'server' boot step adds: if another process
already holds :4478 (e.g. a second MYTHOS or a dev preview), boot.test.js now
fails with exit 1 instead — that is the fail-fast step refusing to boot an
unobservable entity, working as designed, not a new flake.

**Documented deviations** (same convention as P5–P8 — deliberate, not drift):
1. **UI design (user-directed)**: the spec's sidebar shell + hash router
   (`router.js`/`shell.js`/`mind.js`) is replaced by a full-screen JARVIS radial
   neural HUD matching the user's two reference mockups — voice-first, clickable
   radial nodes opening translucent overlay panels, floating draggable live-data
   widgets (clock/weather/actions/spend/wip/tick-rate/breakers), a core circle
   with entity wordmark + live status + tick-pulsed EKG waveform, ring-icon
   satellites with real-data values, seeded starfield, organic branching
   tendrils with ambient electron particles. The Mind view's duties (tick/
   perception/goal live feed) are absorbed by the core orb + canvas + widgets.
   Neural-map density grows from real vault data via `/api/stats` (empty vault =
   exactly core + 6 modules + 6 tendrils; clusters/breaker nodes appear with
   data, weight ∝ sqrt(count)) — trending toward the second (dense) mockup as
   the entity lives. Anti-drift #6 holds (live views are WS-only; only CRUD +
   memory browse use REST); anti-drift #8 holds (every panel/widget mount
   returns a cleanup, overlay close runs it).
2. **`connectionId` open question resolved**: cortex-initiated confirms use the
   sentinel `'system'`; the server resolves confirm-reply by trying the caller's
   own connection scope first, then `'system'` — any connected client may
   approve a cortex-initiated confirm. A wrong-scope probe never deletes the
   entry (P5 registry semantics), so the two-step probe cannot DoS a pending
   confirm.
3. **`brain.interpret` never shipped** — the spec's `handleUtterance` calls it,
   but the P2 brain's real surface is `think()`; the server adapts utterances to
   `brain.think({lane:'voice'})` with an honest-offline reply, never a silent
   empty response.
4. **NOVA goals stats shape translated at the REST seam**: the byte-identical
   goals view renders `{total,active,completed,progress}` (NOVA app/lib/goals.js)
   but the P7 bridge ships `{total,done,active}` — `novaGoalsStats()` translates
   in server/index.js so the copied view needs zero changes (Ambiguity #1's own
   promise), and the bridge's shape (already consumed by from-dashboard tools)
   stays untouched.
5. **Feedback-storm fix (found in live smoke, spec's own Full Code has the
   landmine)**: `probes.getStatus()` emits `health.anomaly` on every call
   (documented no-dedupe) and the spec's `broadcastHealth()` called
   `getStatus()` on every `health.anomaly` — one down provider recursed
   anomaly→probe→anomaly, saturating the event loop and starving HTTP. Fixed:
   only the 4s `perception.metric` trigger runs a fresh probe; `health.anomaly`
   rebroadcasts immediately with cached provider status. Both spec triggers
   preserved.
6. **`ready` promise added to the server handle** — `app.listen` binds
   asynchronously on Windows so the spec test fixture's synchronous
   `httpServer.address()` read races null; tests `await server.ready`.
7. **Initial `entity-state` snapshot on WS connect** — `lifecycle.*` is
   broadcast-only, so a client connecting after boot would sit on "booting"
   forever; the server now sends the current snapshot to each new connection.
8. **Unknown `/api/*` routes answer honest JSON 404** — the byte-identical NOVA
   kanban/pipeline views probe NOVA-era routes (`/api/kanban/assemble`,
   `/api/pipeline/:id/execute`, `/api/jobs/:id`, …) whose backing now lives in
   P7 effectors, not this REST surface; those buttons fail with a clean message
   instead of an HTML-404 JSON-parse error.
9. **Weather widget calls open-meteo.com** (no API key) — the HUD's only
   external network dependency; geolocation falls back to a fixed city and any
   failure degrades to an explicit "weather offline", never a fake reading.
10. **jarvis-core.js not reused after all** — initially copied per the brief,
    then replaced by a bespoke `core-orb.js` renderer when the user supplied the
    exact reference image (wordmark/status/waveform core, not the abstract
    plasma orb); the mechanics (dpr scaling, ResizeObserver, pulse envelope,
    reduced-motion, visibility pause) are CA from it, and the orphaned copy was
    removed.
11. **`abtop.start()` still not called** — the P7 comment defers it to "whatever
    owns the dashboard surface" (P9), but starting it spawns a shell-wrapped
    child that breaks Windows SIGINT delivery (verified in P7); it stays
    honest-inert until cutover, when NOVA's dashboard stops being the owner.
12. **Audit browse formatting** — immune heal records carry no tier/tool;
    `/api/memory/audit` renders placeholders instead of "Tundefined undefined".
13. **`spec test 2` fixture inconsistency resolved** — the spec's own test stores
    a bare `{tool,args}` decision but its server code reads `action.decision`;
    `handleConfirmReply` normalizes both the bare form (spec fixture) and the
    cortex `{decision,goalId,tier}` envelope through the single dispatchAction
    path — no shadow dispatch.

**Manual smoke (performed live)**: `node src/main.js` → boot log shows
`server` step ok at index 11 (after leash, before cortex) → MYTHOS ALIVE →
`server.listening 127.0.0.1:4478`. REST: /health, /api/stats, /api/goals,
/api/kanban, /api/pipeline, /api/memory/{episodic,audit}, /api/nope→JSON 404,
/ → HUD shell — all verified. WS (real client): 9 ticks in 9s with advancing
counter, bounded health cadence, salience gate observed. Browser (preview):
HUD renders (core wordmark/status/waveform, 6 ring-icon satellites with live
values, starfield, tendrils), SYSTEM STATUS OPTIMAL, canvas click on the goals
node opens the GOALS panel, add-goal round-trips to Goals.md on disk, widgets
show real data (tick rate 0.99 Hz measured off WS ticks, 46 breakers closed,
weather honest-fallback). Tier-4 confirm: modal rendered against a real
bus+server+registry harness serving the real UI; Approve click invoked the
effector exactly once (log-verified). **Not live-verifiable in this
environment (code-reviewed instead, stated honestly)**: wake-word voice loop
(no real microphone available — the loop is a CA of NOVA's proven hands-free
restart pattern with the same caps and honest-disabled paths) and drag-persist
across sessions (drag/pointerup/localStorage write path reviewed; positions
restore from `mythos.widgets.v1` on mount).

**Cutover plan (unchanged, DEFERRED to its own post-P10 step):**
1. Tag NOVA as `nova-final`
2. Side-by-side soak (MYTHOS :4478 vs NOVA :4477)
3. One-shot vault import (Goals.md, Kanban.json, Pipeline/)
4. Move `app/` → `archive/nova/`
5. Update launch scripts to point `mythos/`
6. Rollback: `archive/nova/` stays runnable

**Cutover gate (unchanged)**: all 20 MAJOR + 23 MINOR items in Known Deviations
must be closed first — several (D-19–D-23, D-40–D-42) directly affect what the
Memory/Health/Audit panels show as "live data."

---

## Phase 10 — Chaos Drills ⬚

**Scope**: Failure injection tests proving honest-inert posture.

**Full build spec**: [MYTHOS-PHASE-BUILD-SPEC.md § Phase 10 — Chaos Drills](MYTHOS-PHASE-BUILD-SPEC.md#phase-10--chaos-drills) —
complete, runnable `node:test` files for all 6 drills against real (not faked)
P1/P3/P4/P6/P7 instances, plus a Risk Register (R1–R9) cross-reference showing
which drill proves which risk's mitigation actually works.

| Drill | Injection | Expected Behavior | Status |
|-------|-----------|-------------------|--------|
| Provider-killed | Kill Ollama/Groq process mid-call | Breaker opens, chain falls back, Brain returns `{offline:true}` | ⬚ |
| Cortex-stalled | Block event loop for >5×TICK_MS | Watchdog detects, restarts cortex, goals paused 'cortex-restart' | ⬚ |
| Disk-full | Write until ENOSPC | Anomaly emitted, writes return `{degraded:true}`, no crash | ⬚ |
| Memory-corrupt | Truncate JSONL mid-line | Corrupt line skipped, episodic continues, checkpoint-restore works | ⬚ |
| Concurrent-tick | Two tickOnce calls overlap | Reentrancy guard blocks second, first completes normally | ⬚ |
| Restart-mid-action | SIGKILL during effector dispatch | On next boot: running jobs→failed, goals→paused 'crash-recovery', audit consistent | ⬚ |

**Note**: the "Memory-corrupt" and "Restart-mid-action" drills will fail against
today's code even after P5–P9 ship, unless D-16/D-17/D-18/D-23 (fs-store bus wiring,
real consolidate, archive-not-delete, checkpoint-gated rebuild) are fixed — these
are Phase 4.5 items precisely because P10 depends on them.

---

## Risk Register

| ID | Risk | Mitigation | Phase |
|----|------|------------|-------|
| R1 | Idle-loop Brain cost | Idle-skip (P3) + spend events/cap (P2) | ✅ P2, P3 |
| R2 | Memory growth | Decay + archive (P1), consolidate cadence | ⚠️ P1 — decay/consolidate exist but are broken (D-17, D-18) |
| R3 | Autonomy safety | Audit + spend cap + MYTHOS_DRY_RUN + tier gates | ✅ P5 |
| R4 | Identity drift | Human-editable boundaries as tier ceiling | ✅ P8 |
| R5 | SPOF | Checkpoint every N ticks + restore (P6/P1) + drill (P10) | ⚠️ P1, P6, P10 — checkpoint restore is not wired into WorkingMemory init (D-23) |
| R6 | Port conflict | MYTHOS_PORT 4478 (NOVA stays 4477) + separate vault root | ✅ P0 |
| R7 | Stale copy | Git clone verified @ `a0433b5`, future `git pull` | ✅ Step 0 |
| R8 | Event-name drift silently breaks future-phase wiring | Every bus event name must be copy-pasted verbatim from the spec, not paraphrased — add a lint/test that greps emitted event-name string literals against a spec-derived allowlist | ⏳ P5+ (introduce with Phase 4.5 fixes D-28/D-36/D-37) |
| R9 | Cross-module contract breaks invisible to per-module unit tests | Add integration tests that exercise real module-to-module handoffs (Cortex→Goals, Cortex→Effectors) with real (non-fake) instances wired together, not just fake-bus unit tests per module | ⏳ P5+ (first instance found: D-38) |

---

## NOVA Reuse Ledger

| NOVA Asset | Lines | Reuse | Phase | Status |
|------------|-------|-------|-------|--------|
| Provider modules (~20) | ~800 | CV/CA | P2 | ✅ (2 of 9 shipped orphaned — D-30) |
| registry.js | 218 | CA | P2 | ✅ |
| chain.js | 110 | CA | P2 | ✅ |
| activity-log.js | 154 | CA→spend.js | P2 | ✅ |
| quota.js | 165 | CV | P2 | ✅ |
| rate-limit.js | 54 | CV | P9 | ✅ |
| logger.js | 73 | CA | P0 | ✅ |
| vault.js | 83 | CA→fs-store.js | P1 | ⚠️ CA'd, but never wired to `bus` (D-16) |
| confirm.js | 65 | CA | P5 | ✅ |
| voice-agent.js | 318 | CA→interpret.js | P7 | ⬚ |
| orchestrator.js | 136 | WRAP→build-runner | P7 | ⬚ |
| tools-* (5 files) | ~1081 | CA→from-*.js | P7 | ⬚ |
| agent-actions.js | 145 | CA | P7 | ⬚ |
| pipeline/kanban/goals | ~238 | CA | P7 | ⬚ |
| probes.js | 140 | CA | P6 | ⬚ |
| BRAIN-MAP.md | 66 | CV→lanes.default.js | P2 | ✅ |
| server.js (patterns) | 1533 | RW | P9 | ✅ |
| ws.js (client) | 181 | CA | P9 | ✅ |
| tokens.css | 240 | CV | P9 | ✅ (+ goals/kanban/pipeline/memory.css, 3 views + speech-to-text.js CA byte-identical, fonts) |
| reasoning.js | 55 | DELETED | P2 | ✅ confirmed deleted, no trace |

**Total NOVA lines reused**: ~4,700 of ~5,600 (84%) — the other 16% is either DELETED (reasoning.js duplication) or REWRITTEN (server.js, voice-agent.js).

---

## Commit Log

| Commit | Phase | Description |
|--------|-------|-------------|
| `0566acc` | P0+P1 | Architecture spec + runtime scaffold + 6 memory stores (70 tests) |
| `3bf42de` | P2 | Brain: 9 providers, chain, think(), spend, quota (113 tests) |
| `f1f6d3a` | P3+P4 | Cortex OODA loop + Goals system (161 tests) |
| `3c75c26` | Phase 4.5 | Spec-conformance remediation, 13/13 criticals closed (174 tests) |
| `a837afd` | P5 | Leash: tiers/confirm/audit-writer/index + main.js wiring (184 tests) |
| `1c0735b` | P6 | Immune: breakers/watchdog/diagnostician/healer/probes/announcer/monitor + metric sensor + main.js wiring (234 tests) |
| `532106d` | P7 | Sensors & Effectors: effector hub/adapter/build-runner/goals-bridge/voice/45 NOVA tool catalogs (CA) + file/ws/job sensors + main.js wiring (272 tests, 270 passing, 1 pre-existing env-blocked) |
| `6898d92` | P8 | Identity: self.md store (D-15) + boundary/persona/learn module + leash/brain wiring (293 tests, 291 passing, 1 pre-existing env-blocked) |
| `b776b73` | P9 | UI v2: Express + WS v2 server (spec-verbatim) + JARVIS radial neural HUD (user-directed design) + logger/lifecycle/cortex/schema/hub diffs; cutover deferred pending MAJOR deviations (316 tests, 314 passing, 1 pre-existing env-blocked) |
