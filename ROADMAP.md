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
| P0 Foundation | ✅ Done, ⚠️ drift | 26 | `0566acc` | 4 / 4 / 6 |
| P1 Memory | ✅ Done, ⚠️ drift | 70 | `0566acc` | 4 / 6 / 4 |
| P2 Brain | ✅ Done, ⚠️ drift | 113 | `3bf42de` | 1 / 3 / 4 |
| P3 Cortex | ✅ Done, ⚠️ drift | 161 | `f1f6d3a` | 4 / 4 / 4 |
| P4 Goals | ✅ Done, ⚠️ drift | 161 | `f1f6d3a` | 0 / 3 / 5 |
| P5 Leash | ⬚ Pending — **blocked until Phase 4.5 closes** | — | — | — |
| P6 Immune | ⬚ Pending | — | — | — |
| P7 Sensors & Effectors | ⬚ Pending | — | — | — |
| P8 Identity | ⬚ Pending | — | — | — |
| P9 UI v2 & Cutover | ⬚ Pending | — | — | — |
| P10 Chaos Drills | ⬚ Pending | — | — | — |

**Current**: 161 tests, 25 src files, 9 provider files, 7 test files. 13 CRITICAL /
20 MAJOR / 23 MINOR drift items open across P0–P4 (see Phase 4.5 + Known Deviations).

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

## Phase 4.5 — Spec-Conformance Remediation (BLOCKS P5) ⚠️

**No work on Phase 5 (Leash) may start until every item below is fixed and covered
by a new regression test.** These are the 13 CRITICAL items — the ones that either
violate a core §1 principle, break an event-name contract future phases will rely
on, or mean the system doesn't actually do what its passing tests imply.

| # | ID | Fix required | Status |
|---|----|--------------|--------|
| 1 | D-01 | Add `dependencies` to `mythos/package.json`: `dotenv`, `express`, `ws`, `playwright-core` (exact 4, pinned to same versions as NOVA `app/package.json`) | ⬚ |
| 2 | D-02 | Call `require('dotenv').config()` at the top of `src/main.js` before config validation runs | ⬚ |
| 3 | D-03 | Pass `config` into `createLifecycle({bus, config})`; replace hardcoded `name: 'MYTHOS'` with `name: config.MYTHOS_NAME` | ⬚ |
| 4 | D-04 | Rebuild `src/main.js`'s boot sequence as the spec's 14-18 named FAIL-FAST/DEGRADED steps; wire `memory`, `brain`, `cortex`, `goals` (already built) into real boot steps so the entity actually runs its OODA loop end-to-end, not just in unit tests | ⬚ |
| 5 | D-15 | Build `src/core/memory/identity.js` implementing the same `MemoryStore` interface as the other stores; wire into `memory/index.js` facade | ⬚ |
| 6 | D-16 | Pass `bus` into `createFsStore`; emit `health.anomaly{kind:'corrupt-line',...}` on every skipped corrupt line instead of swallowing silently | ⬚ |
| 7 | D-17 | Rewrite `memory/index.js consolidate()` to: call `working.flushToEpisodic()` correctly (or implement the flush it currently no-ops), call each store's own `consolidate()` (not `episodic.prune()` directly), and wire a real Brain 'simple' call for episodic→semantic distillation (skip cleanly if Brain offline) | ⬚ |
| 8 | D-18 | Replace `fs.unlinkSync` in episodic decay and semantic low-confidence pruning with: digest-to-.md + gzip archive (episodic) and move-to-`_archive.md` (semantic) — no permanent deletion | ⬚ |
| 9 | D-28 | Rename the brain-spend bus event from `'brain.spend'` to `'brain-spend'` (update the one emit site and any listening tests) | ⬚ |
| 10 | D-36 | Rename timer sensor event from `'sensor.timer'` to `'perception.tick'`; add `kind:'timer'` to payload and `salienceHint: 0.1` | ⬚ |
| 11 | D-37 | Rename cortex lifecycle events from `'lifecycle.cortex-started'`/`'-stopped'` to `'lifecycle.started'`/`'lifecycle.stopped'` | ⬚ |
| 12 | D-38 | Fix `cortex/index.js:88` to pass the full ranked structure (not bare `.map(r => r.perception)`) into `goals.arbitrate()`; add a regression test asserting `arbitrate()` receives objects carrying `rankedSalience` | ⬚ |
| 13 | D-39 | Make leash check / breaker check / effector dispatch mandatory in `act()` — if `leash`/`effectors` are not supplied to `createCortex`, fail construction loudly (throw) rather than silently skipping the gate at dispatch time | ⬚ |

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

**MINOR** (23 total, tracked by ID above): D-09 through D-14, D-24 through D-27,
D-32 through D-35, D-43 through D-46, D-50 through D-54.

Full detail for every ID is in the per-phase "Drift found" tables above — this
section exists only as a consolidated non-blocking backlog view.

---

## Phase 5 — Leash ⬚ (blocked — see Phase 4.5)

**Scope**: leash check, tiers, confirm, audit writer.

**Full build spec**: [MYTHOS-PHASE-BUILD-SPEC.md § Phase 5 — Leash](MYTHOS-PHASE-BUILD-SPEC.md#phase-5--leash) —
exact code skeletons, resolved spec ambiguities, integration points against the
real shipped P0–P4 code, and an anti-drift checklist. Written to the corrected,
mandatory-gating, config-not-hardcoded conventions this Phase 4.5 remediation
establishes — do not rebuild Leash from MYTHOS-ARCHITECTURE.md §9 alone.

| Deliverable | Status |
|---|---|
| src/core/leash/{index,tiers,confirm,audit-writer}.js | ⬚ |

**Gate**: tier0 auto, tier4 always, tier3 once, dry-run no-op,
audit line per decision, wrong-connection cannot accept

---

## Phase 6 — Immune ⬚

**Scope**: monitor, breakers, watchdog, diagnostician, healer, announcer, probes, metric sensor.

**Full build spec**: [MYTHOS-PHASE-BUILD-SPEC.md § Phase 6 — Immune](MYTHOS-PHASE-BUILD-SPEC.md#phase-6--immune) —
includes the breaker-backoff formula fix (the spec's own `resetAt * 2` doubles an
absolute timestamp, not a delay) and the watchdog/healer split (watchdog is
detection-only; the healer's `'stall-restart'` playbook does the actual restart —
do not let watchdog call `cortex.stop()`/`start()` directly, that double-restarts).

| Deliverable | Status |
|---|---|
| src/core/immune/{monitor,breakers,watchdog,diagnostician,healer,announcer,probes}.js | ⬚ |
| src/core/sensors/metric.js | ⬚ |

**Gate**: breaker open→half-open, watchdog stall detect, healer playbook re-probe,
checkpoint every N ticks

**Note**: Watchdog depends on `cortex`'s lifecycle events matching spec exactly
(D-37 must be fixed first) and on the memory checkpoint/restore path actually
working (D-17/D-18/D-23 must be fixed first) — do not start P6 until Phase 4.5 is
closed.

---

## Phase 7 — Sensors & Effectors ⬚

**Scope**: adapter + from-*.js (45 tools), build-runner, voice, file/ws/job sensors, WRAP adapters.

**Full build spec**: [MYTHOS-PHASE-BUILD-SPEC.md § Phase 7 — Sensors & Effectors](MYTHOS-PHASE-BUILD-SPEC.md#phase-7--sensors--effectors) —
the adapter pattern given once precisely (not all 45 tool bodies), the effector
hub's `get()`/`registerNamed()` additions needed for Leash's `dangerWhen` lookup
and the goals/kanban/pipeline "named service" bridges, and `build-runner.js`'s
`init() → {recoveredJobs}` contract that Phase 10's crash drill depends on.

| Deliverable | Status |
|---|---|
| src/core/effectors/{adapter,hub,build-runner,from-dashboard,from-computer,from-pc,from-browser,from-project,agent-actions,voice,pipeline,kanban,goals}.js | ⬚ |
| src/core/sensors/{file,ws,job}.js | ⬚ |
| adapters/ (s2s, pc-child, browser-agent) | ⬚ |

**Gate**: danger→tier≥3, invoke normalization, 45 registered count,
build-runner queued→done + restart-failed, job sensor perception

**Note**: `providers/openrouter.js` and `providers/claude-cli.js` (D-30) are already
built but orphaned from Phase 2 — check whether Phase 7's effector work has a use
for them before writing new provider code from scratch.

---

## Phase 8 — Identity ⬚

**Scope**: identity module, vault/Identity/{self,boundaries}.md.

**Full build spec**: [MYTHOS-PHASE-BUILD-SPEC.md § Phase 8 — Identity](MYTHOS-PHASE-BUILD-SPEC.md#phase-8--identity) —
resolves the module-vs-store split (this phase's `identity/index.js` is the
boundary-enforcement layer; the P1-deliverable `memory/identity.js`, D-15, is
the underlying markdown+sidecar store) and the exact tier-ceiling precedence with
Leash (`Math.min(config.AUTONOMOUS_MAX_TIER, identity.getMaxAutonomousTier())`,
both read live, never cached — most-restrictive wins).

| Deliverable | Status |
|---|---|
| src/core/identity/index.js | ⬚ |
| vault/Identity/self.md (seed) | ⬚ |
| vault/Identity/boundaries.md (seed) | ⬚ |

**Gate**: loaded at boot, edit changes tier ceiling, MYTHOS_NAME override,
entity has no write path to boundaries (contract test)

**Note**: this is the Identity *module* (self/boundaries logic + tier-ceiling
enforcement), distinct from the Identity *memory store* that was supposed to ship
in P1 and is missing (D-15) — do not conflate the two when scoping this phase.

---

## Phase 9 — UI v2 & Cutover ⬚

**Scope**: server, WS v2, all views, NOVA→MYTHOS cutover.

**Full build spec**: [MYTHOS-PHASE-BUILD-SPEC.md § Phase 9 — UI v2 & Cutover](MYTHOS-PHASE-BUILD-SPEC.md#phase-9--ui-v2--cutover) —
the exact WS v2 message-to-bus-event mapping table (every OUT type traced to its
real upstream event, no phantom names) and an expanded, command-level cutover
runbook.

**Cutover plan:**
1. Tag NOVA as `nova-final`
2. Side-by-side soak (MYTHOS :4478 vs NOVA :4477)
3. One-shot vault import (Goals.md, Kanban.json, Pipeline/)
4. Move `app/` → `archive/nova/`
5. Update launch scripts to point `mythos/`
6. Rollback: `archive/nova/` stays runnable

**Gate**: all views render, WS v2 messages flow, confirm modal works,
Mind/Memory/Health/Audit views show live data

**Note**: all 20 MAJOR + 23 MINOR items in Known Deviations must be closed before
this cutover — several (D-19–D-23, D-40–D-42) directly affect what the Memory/Health/
Audit views will show as "live data."

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
| R3 | Autonomy safety | Audit + spend cap + MYTHOS_DRY_RUN + tier gates | ⏳ P5 |
| R4 | Identity drift | Human-editable boundaries as tier ceiling | ⏳ P8 |
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
| rate-limit.js | 54 | CV | P9 | ⬚ |
| logger.js | 73 | CA | P0 | ✅ |
| vault.js | 83 | CA→fs-store.js | P1 | ⚠️ CA'd, but never wired to `bus` (D-16) |
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
| reasoning.js | 55 | DELETED | P2 | ✅ confirmed deleted, no trace |

**Total NOVA lines reused**: ~4,700 of ~5,600 (84%) — the other 16% is either DELETED (reasoning.js duplication) or REWRITTEN (server.js, voice-agent.js).

---

## Commit Log

| Commit | Phase | Description |
|--------|-------|-------------|
| `0566acc` | P0+P1 | Architecture spec + runtime scaffold + 6 memory stores (70 tests) |
| `3bf42de` | P2 | Brain: 9 providers, chain, think(), spend, quota (113 tests) |
| `f1f6d3a` | P3+P4 | Cortex OODA loop + Goals system (161 tests) |
