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

<!-- SYNC:TEST-COUNT:START -->
**Current test-suite state** (auto-synced by `mythos/scripts/sync-test-count.js`, last run 2026-08-07): **3077 tests, 3076 passing, 0 failing, 1 skipped.**
<!-- SYNC:TEST-COUNT:END -->
## Build content comes from Hermes-Agent, not the brain (2026-07-29 onward)

This file described builds for a long time without ever naming the engine that
performs them, which is how a regression hid in plain sight. Recording it here:

- `src/core/effectors/build-engine.js` is the **single build-content engine**
  (commit `37953ca`). It shells out to the Hermes-Agent CLI. The brain's `build`
  lane is now largely vestigial — it serves only `build-engine.js`'s guarded
  fallback for a transient Hermes outage (tagged `engine:'brain-fallback'` plus a
  `health.anomaly`, never silent) and any stray `brain.think({lane:'build'})`
  caller.
- The swap exists because the brain-backed generators invented titles and topics
  (see `build-engine.js`'s header and BUG-051). **A build with no engine FAILS
  with an install hint rather than shipping a plausible-but-wrong artifact.**
- `37953ca` wired `build-runner.js` and the engagement executor but missed
  `agent-actions.js`, so the research-grounded regeneration and the
  review-rejection retry kept overwriting Hermes output with `brain.think` for
  every `risk='feature'` build — i.e. almost all of them. Fixed 2026-07-31; see
  BUG-051 and `test/build-single-engine-regeneration.test.js`. When adding any new
  content-generation path, route it through `buildEngine.generate()`.
- Forge (`build_project` → `hermes-runner.js`) is Hermes-exclusive with no
  fallback at all, and has **no research gate** — the web-research step lives only
  in the pipeline/kanban path.

## Keeping this file current

Update `ROADMAP.md` (phase status, test count, commit log) as phases land —
it's the single source of truth; `mythos/ROADMAP.md` is a stale pointer here,
not a second copy to maintain.

**Dropped 2026-07-24:** the previous policy mandating `graphify-out/graph.html`
regeneration on every push. It was demonstrably not being followed in practice
(the file's last edit predates dozens of intervening phase-equivalent commits,
discovered live during the 2026-07-24 wiring audit) and blocked nothing real.
`graphify-out/` still exists as a manually-regenerated visualization aid —
regenerate it on demand (`/graphify .`) when a diagram is actually wanted, not
as a merge gate.

---

## ⚠️ Spec-Conformance Audit — 2026-07-09

> **Update 2026-07-10**: all 13 CRITICAL items below (headline findings 1-5, D-01
> through D-39) are now fixed — see
> [Phase 4.5](#phase-45--spec-conformance-remediation-✅-done--was-blocks-p5),
> which is ✅ Done. This section is kept as the historical audit record; findings
> below describe the pre-remediation state. MAJOR/MINOR items remain open, tracked
> in Known Deviations.
>
> **Update 2026-07-27**: D-01 has since regressed and is tracked open again —
> `mythos/package.json` now declares 7 dependencies (later phases added
> `@mediapipe/tasks-vision`, `exceljs`, `onnxruntime-web`, `pptxgenjs` without
> revisiting the exact-4 constraint), `dotenv` is still never declared, and the
> Phase 4.5 row below has been reopened. See Known Deviations.

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
| P10 Chaos Drills | ✅ Done | 327 (325 pass / 1 skip / 1 fail) | `27d8842` | 1 / 1 / 0 (P10's own test files introduce 0 drift; found + documented, not fixed: D-56 CRITICAL pre-existing since P2, D-57 MAJOR pre-existing) |
| P17 Gap-Closing (R2/R3/R4/R8/R9 + D-23/D-57) | ✅ Done | 386 (384 pass / 1 skip / 1 fail) | `TBD` | 0 / 0 / 0 (7 new test files, 0 new drift; 2 real source fixes: D-23 working.js checkpoint consult, D-57 main.js boot-order + recoverFromCrash/buildRunner wiring) |
| P18 Gap-Closing (D-57 job↔goal mapping) | ✅ Done | 390 (388 pass / 1 skip / 1 fail) | `TBD` | 0 / 0 / 0 (1 new test file, 0 new drift; real source fix: build-runner/agent-actions/orchestrator/from-project/from-dashboard/from-mission thread goalId end to end, monitor.js's recoverFromCrash() surfaces recoveredJobGoalMap) |
| P19 Gap-Closing (auto-resume crash-recovered goals) | ✅ Done | 393 (391 pass / 1 skip / 1 fail) | `TBD` | 0 / 0 / 0 (1 new test file, 0 new drift; real source fix: monitor.js's recoverFromCrash() reactivates a paused-at-crash goal when it owned a recovered job, without re-issuing that job) |
| P20 Token-level LLM streaming to first speech-chunk (partial scope) | ✅ Done | 402 (400 pass / 1 skip / 1 fail) | `TBD` | 0 / 0 / 0 (2 new test files, 0 new drift; real source change: onToken threaded chain.js→brain/index.js, handleVisionQuery streams sentence-level TTS as tokens arrive; handleUtterance/voice-agent stays full-buffer by deliberate, documented scope boundary — JSON tool-calling contract + needs_result/corrective loop makes early truncation unsafe) |

**Current**: 327 tests (316 pre-existing + 11 new in P10), 325 passing / 1 skipped / 1
failing. 64 src files (+`core/identity/index.js`) + `server/{index,rate-limit}.js` +
30 `ui/public/` assets (JARVIS HUD: neural-map/overlay/widgets/voice/confirm modules,
6 panel views, 10 css files), `effectors/{adapter,hub,build-runner,goals,voice,routes,
from-computer,from-pc,from-browser,from-dashboard,from-project,pipeline,kanban,
agent-actions,collectors/abtop}.js`, `sensors/{file,ws,job}.js`), `adapters/{pc-child,
browser-agent}/index.js`, 10 provider files (+`edge-tts.js`), 29 test files
(+`server.test.js`, `p9-diffs.test.js`, `hud-model.test.js`, +6 P10 `chaos-*.test.js`
files). 0 CRITICAL / 20 MAJOR / 24 MINOR drift items
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
Cutover) is now unblocked. P10 (test-files-only, no `src/core/**` changes, per its own
scope) found two real, previously-uncaught gaps while building the six drills
against real shipped code instead of the spec's illustrative pseudocode, rather than
inventing scope: **D-56** (CRITICAL, new) — `brain/index.js`'s call into
`chain.complete()` passes the caller's lane as `kind` (`kind: lane === 'embed' ?
'simple' : lane`), never as `brain`; `chain.js`'s own `complete({messages,kind,brain,
...})` only reads `kind` to special-case `'vision'`, and `brain` is the field that
actually selects the `'voice'/'build'/'simple'` preference table + its
`CHAIN_VOICE`/`CHAIN_BUILD`/`CHAIN_SIMPLE` env override. Net effect: every
`brain.think({lane:'voice'|'build'|'simple',...})` call has silently fallen through
to the `'text'` lane's table since Phase 2 — `test/brain.test.js` never caught this
because its own assertions accept either offline outcome. **D-57** (MAJOR, new) —
`main.js`'s `'recovery'` boot step calls `recoverFromCrash({bus,config,memory,goals})`
(the P6 checkpoint-based recovery) only; it never calls `buildRunner.init()` or
performs the `recoveredJobs` → job-goal-map → `goals.update(goalId,{status:'paused',
reason:'crash-recovery'})` composition Drill 6 proves at the module level — worse,
`buildRunner` isn't even constructed until the later `'leash'` step, which runs
*after* `'recovery'`, so today's boot order makes that composition structurally
impossible as written. Neither is fixed in this phase (both are `src/core/**`/
`main.js` changes, out of scope for a test-files-only phase) — both are logged in
Known Deviations below and recommended for a small, dedicated follow-up phase. See
the Phase 10 section for full detail on both findings and how the six drills were
adapted to prove real current behavior around them.

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
| D-04 | CRITICAL | ~~`mythos/src/main.js:46-61`~~ `mythos/src/main.js:166-773` (line numbers drifted as the file grew) | 14-18 named FAIL-FAST/DEGRADED boot steps incl. episodic, audit, immune, cortex, stores, identity, brain-probe, goals, recovery, sensors, effectors, server, cortex-tick | ~~only 5 empty-body steps registered (`config`,`logger`,`bus`,`vault-dirs`,`idle-beat`); memory/brain/cortex/goals modules exist but are never booted~~ — ✅ **RESOLVED** (Phase 4.5, 2026-07-10, remediation #4; reconfirmed 2026-07-27): `lifecycle.setSteps([...])` now registers 24 named steps, each with a real body — `memory` (constructs+inits brain/memory), `immune` (fail:'fast'), `brain-probe`, `identity`, `goals` (fail:'degraded', `goals.init()`), `leash` (builds the real effector hub + effectors + leash), `engagement-store`/`engagement-manager`/`conversation-gateway`/`engagement-immune-hooks`, `recovery` (`recoverFromCrash()`), `server` (fail:'fast', `createServer()`, throws if P7 effectors missing), `browser-automation`, `capabilities-manifest`, `immune-explainer`, `cortex` (`createCortex()`+`cortex.start()`), `sensors` (subscribes `perception.*` into working memory and starts timer/metric/file/job/ws/screen/window sensors), `planner`, `edge-tts`. `stopRunningLoops()` (main.js:777-800) tears all of these back down on shutdown, confirming they are live subsystems, not stubs. Step count (24) exceeds the spec's 14-18 because later phases (engagement layer, browser-automation, planner, edge-tts) added steps beyond the original spec — a superset, not a shortfall. Matches the ✅ already recorded in the Phase 4.5 remediation table below. |
| D-05 | MAJOR | `mythos/src/core/config/schema.js:12` | `MYTHOS_VAULT_ROOT` REQUIRED | has a default (`./vault`), never errors when missing |
| D-06 | MAJOR | `mythos/src/core/bus/index.js` | built-in middleware `auditTap`/`historyTap`/`redactSecrets` wired into every bus | none of the three exist or are registered anywhere |
| D-07 | MAJOR | `mythos/src/core/lifecycle/index.js:54-84` | 7-step shutdown (sensors stop → cortex drain → episodic flush → checkpoint write → audit flush → exit 0 → SHUTDOWN_MS hard-exit) | only the hard-exit timer exists; comment admits "nothing to stop yet — this is the scaffold" — ✅ **RESOLVED** (Phase 1, 2026-07-16): `registerShutdownStep()` added to lifecycle/index.js; main.js registers `stop-loops → episodic-flush → checkpoint-write → audit-flush` in order after server-close, duplicate `process.on('SIGINT'/'SIGTERM', stopRunningLoops)` removed (lifecycle.registerShutdown() is now the sole signal path); `SHUTDOWN_MS` schema key backs the hard-exit backstop (closes D-13 too). Tests: `test/lifecycle.test.js` (16/16), `test/config.test.js`, `test/p9-diffs.test.js` (6/6, unmodified) all pass; live boot smoke confirmed "MYTHOS ALIVE". |
| D-08 | MAJOR | `mythos/src/core/bus/event.js:18` | `depth = cause.depth+1` or `1` for root | root events get `depth: 0` |
| D-09 | MINOR | `mythos/src/core/bus/index.js:56` | `seq` starts at 0 for first dispatched event | `seq` initialized 0, first event gets `seq: 1` |
| D-10 | MINOR | `mythos/src/core/bus/index.js:38` | depth guard drops when `depth > maxDepth` | drops at `depth >= maxDepth` (one step stricter) |
| D-11 | MINOR | `mythos/src/core/config/schema.js` | NOVA passthrough incl. `PORT` (4477), `BIND` | neither key exists in schema |
| D-12 | MINOR | `mythos/src/core/bus/index.js:49` | `perception.coalesced` should reflect real overflow count | always emits `{count: 1}` per dropped event |
| D-13 | MINOR | `mythos/src/core/config/schema.js:145` | no `SHUTDOWN_MS` config key exists to back D-07's step 7 | ✅ **RESOLVED** (Phase 1, 2026-07-16, closed alongside D-07; reconfirmed 2026-07-27): `SHUTDOWN_MS` added to `SCHEMA` in `config/schema.js` (`{ type: 'number', default: 10000, min: 1000 }`), consumed via `config.SHUTDOWN_MS` in `lifecycle/index.js:69` as the shutdown hard-exit backstop. Tests: `test/config.test.js` (asserts `SHUTDOWN_MS === 10000` from defaults) and `test/lifecycle.test.js` ("shutdown uses config.SHUTDOWN_MS as the hard-exit backstop") both pass. |
| D-14 | MINOR | `mythos/src/core/bus/index.js:115` | `history(filter)` generic filter | only supports a predicate function, no object/channel filter |

---

## Phase 1 — Memory ✅ ⚠️ drift

**Scope**: fs-store, episodic, semantic, skills, identity store, audit, checkpoints, working memory.

| Deliverable | Status |
|---|---|
| src/core/memory/{store,fs-store,episodic,semantic,skills,working,audit-writer}.js | ✅ |
| **identity store** | ✅ built Phase 4.5, rewritten Phase 8 into the real header-sectioned self.md store (see D-15, resolved) |
| Consolidate logic | ✅ rewritten Phase 4.5 — calls per-store consolidate(), wires a real Brain 'simple' call (see D-17, resolved) |
| Decay/archive logic | ✅ archives before deleting (see D-18, resolved Phase 4.5) |

**Gate**: ✅ round-trip write→recall, prune-by-age decay, audit append-only,
checkpoint save/restore, consolidate merges — passes as written, but the gate
criteria describe behavior the code does not actually implement (decay deletes
rather than archives; consolidate doesn't distill via Brain). Tests assert what the
code does, not what the spec requires — this gate needs new tests before it can be
trusted (see Phase 4.5).

**Drift found**:

| ID | Severity | File:Line | Spec says | Code does |
|----|----------|-----------|-----------|-----------|
| D-15 | ~~CRITICAL~~ RESOLVED | `mythos/src/core/memory/identity.js` | Identity store is a P1 deliverable (§16 Phase 1 scope) | ✅ Resolved in Phase 4.5 remediation #5 (built `identity.js` implementing the MemoryStore interface, wired into `memory/index.js`) and rewritten wholesale in Phase 8 into the real header-sectioned self.md store; reconfirmed 2026-07-27 still present and wired — `memory/index.js` requires, constructs, inits, consolidates, and reports stats for it. |
| D-16 | CRITICAL | `mythos/src/core/memory/fs-store.js:82-126` | corrupt line skipped **with anomaly event** | ✅ **RESOLVED** (Phase 4.5, remediation #6; reconfirmed 2026-07-27): `createFsStore(vaultRootFn, bus)` now takes `bus` as its second parameter, sourced from `main.js`'s boot-time `createBus(...)` → `createMemory({ config, bus, ... })`. `readLines`, `readDirLines`, and `readDirLinesReverse` each guard their JSON.parse catch with `if (bus) bus.emit('health.anomaly', { kind: 'corrupt-line', path, line })` before skipping the line. Verified live by `test/chaos-memory-corrupt.test.js`. |
| D-17 | CRITICAL | `mythos/src/core/memory/index.js` (`consolidate()`, now ~lines 246-346; original 49-67 line ref is stale) | consolidate(): (1) flush working→episodic (2) episodic→semantic via Brain 'simple' (3) decay old episodic (4) archive low-confidence semantic | ✅ **RESOLVED** (Phase 4.5 remediation #7; reconfirmed 2026-07-27): (1) `await working.flushToEpisodic()` performs a real episodic write (`kind:'working-snapshot'`), not a no-op; (2) `brain.think({lane:'simple', source:'memory:consolidate'})` is called (guarded to skip cleanly if Brain is offline), output written via `semantic.write('consolidated-'+Date.now(), ...)`; (3) `episodic.consolidate()` is called (which internally calls `prune()`) — not `episodic.prune()` directly; (4) `semantic.consolidate()` runs `pruneLowConfidence()` to archive low-confidence topics into `Semantic/_archive.md` rather than deleting them. |
| D-18 | CRITICAL | `mythos/src/core/memory/fs-store.js:172-179` (archiveFile), `semantic.js:144-162` (pruneLowConfidence) | old episodic → digest+gzip archive; low-confidence semantic → `_archive.md` | ✅ **RESOLVED** (Phase 4.5, remediation #8; reconfirmed 2026-07-27): `fs-store.js`'s `archiveFile()` writes a markdown digest, gzips it to `_archive/<name>.md.gz`, then removes the source; `semantic.js`'s `pruneLowConfidence()` appends a timestamped copy to `Semantic/_archive.md` then removes the source. Neither path deletes without archiving first. Test: `test/memory-growth-regression.test.js` (multi-cycle growth at scale). |
| D-19 | MAJOR | `mythos/src/core/memory/skills.js:175`, `audit-writer.js:97` | all 5 stores implement `init/write/recall/get/consolidate/stats` | 🔧 **PARTIALLY RESOLVED** (Phase 1, 2026-07-16; reconfirmed 2026-07-27): `skills.js` now implements all six methods (`write`, `recall`, `get`, `stats`, `consolidate` — added, honest no-op since skills are curated/not time-decayed — `init`) and is fully spec-compliant. `audit-writer.js` gained `consolidate()` (honest no-op — audit is append-only, retention out of scope) but still has **no `recall()` or `get()`**: its return statement exposes `{ write, query, stats, consolidate, init, redact }` — `query()` in their place, a deliberate scope-guard left untouched by this fix. The spec's literal "all 5 stores implement recall/get" therefore remains unmet for the audit store — correctly still counted in the open MAJOR backlog below (not fully resolved, despite the inline ✅ this row previously carried). Test: `test/memory.test.js` (62/62). |
| D-20 | MAJOR | `mythos/src/core/memory/*.js` | `stats() → { count, bytes, lastWrite }` | every store returns a different shape, none include `bytes`; audit-writer uses `lastWriteTs` not `lastWrite` |
| D-21 | MAJOR | `mythos/src/core/memory/fs-store.js` | per-path in-process async mutex for MD/JSON read-modify-write | no mutex anywhere — `skills.js:144-160 recordUse()` does unlocked read→mutate→write — ✅ **RESOLVED** (Phase 1, 2026-07-16): `withLock(relPath, fn)` added to fs-store.js (promise-chain per-path serialization, a rejection never wedges the queue); `skills.js recordUse()` is now `async`, wraps its mutate+write in `withLock`, re-reads fresh data inside the lock. Honest note: `recordUse()` had zero production callers at time of fix — this is forward-looking hardening, not a live-race fix. Not extended to semantic/identity stores (out of scope). Test: `test/memory.test.js` (62/62, incl. new withLock serialization + rejection-doesn't-wedge-queue tests). |
| D-22 | MAJOR | `mythos/src/core/memory/semantic.js:76-79`, `skills.js:72-75` | recall scorer must be injectable (`{scorer=lexicalScore}`), v1 = overlap*0.7 + recency*0.3 | only episodic supports injection; semantic/skills hardcode `matched/terms.length` with no recency term at all |
| D-23 | MAJOR | `mythos/src/core/memory/working.js`, `checkpoints.js` | WorkingMemory rebuilt from episodic tail **only if checkpoint missing** | ~~`working.init()` unconditionally rebuilds from episodic tail; `checkpoints.load()` is never called by the memory module at all~~ — ✅ **RESOLVED in P17** (reconfirmed 2026-07-27): `createWorkingMemory()` now takes an optional `checkpoints` dependency; `init()` restores `{tick, activeGoalId}` directly from a checkpoint when one exists, falling back to the episodic-tail scan only when it doesn't. See the Known Deviations D-23 entry below for full detail. |
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
| D-28 | CRITICAL | `mythos/src/core/brain/index.js:143` (line drifted from :74) | `bus.emit('brain-spend', {...})` | ~~emits `'brain.spend'` (dot, not hyphen)~~ — ✅ **RESOLVED** (Phase 4.5 remediation #9; reconfirmed 2026-07-27): emit site now uses the exact hyphenated literal `'brain-spend'` matching spec. Regression coverage: `test/event-name-conformance.test.js` bans the `'brain.spend'` literal repo-wide; `test/chaos-provider-killed.test.js` asserts `brain-spend` fires per chain attempt; `server/index.js:1306` subscribes/rebroadcasts `'brain-spend'` verbatim. |
| D-29 | MAJOR | `mythos/providers/ollama.js`, `openrouter.js` (`claude-cli.js` since removed) | canonical provider interface: `{name, chat, isAvailable, getStatus, getModel}` | ollama exports only `{chat, listModels}`; openrouter/claude-cli export only `{chat}` — none implement the canonical shape — ✅ **RESOLVED** (Phase 1, 2026-07-16; reconfirmed 2026-07-27): `ollama.js` exports `{name, chat, listModels, isAvailable, getModel, getStatus}` and `openrouter.js` exports `{name, chat, isAvailable, getModel, getStatus}`, both matching the canonical shape. `claude-cli.js` was subsequently deleted entirely as dead code in Phase 2 — Wiring Integrity, so it can no longer violate the interface. Test: `test/brain.test.js` (62/62). |
| D-30 | MAJOR | `mythos/providers/openrouter.js` (`claude-cli.js` deleted) | wired into dispatch | ✅ **RESOLVED** (reconfirmed 2026-07-27): `openrouter` is now required and present in `chain.js`'s `LANES` table, listed as a fallback in `lanes.default.js`'s `DEFAULT_LANE`/`CODE_LANE`/`VOICE_LANE` tables, and alive-probed in `registry.js` (`case 'openrouter': return !!process.env.OPENROUTER_API_KEY;`). `claude-cli.js` was deleted outright (commit `bae537a`, "chore(D): delete dead code — daily-note.js + claude-cli.js", 2026-07-19) along with its `test/brain.test.js` describe block; the module no longer exists. Test: `test/brain.test.js` (`_internal.LANES.openrouter` present). |
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
| D-36 | CRITICAL | `mythos/src/core/sensors/timer.js:17` | emits `'perception.tick'` | ~~emits `'sensor.timer'`~~ — ✅ **RESOLVED** (Phase 4.5 remediation #10; reconfirmed 2026-07-27): code emits `bus.emit('perception.tick', { ts, generation, kind: 'timer', salienceHint: 0.1 })`, matching spec. Regression-guarded by `test/event-name-conformance.test.js` (banned-channel list includes the old `'sensor.timer'` name) and exercised by `test/cortex-goals.test.js`. |
| D-37 | CRITICAL | `mythos/src/core/cortex/index.js:431,443` (line drifted from :167,174) | lifecycle events `'lifecycle.started'` / `'lifecycle.stopped'` | ~~emits `'lifecycle.cortex-started'` / `'lifecycle.cortex-stopped'`~~ — ✅ **RESOLVED** (Phase 4.5 remediation #11; reconfirmed 2026-07-27): code emits spec-correct `'lifecycle.started'` (in `start()`) and `'lifecycle.stopped'` (in `stop()`), both carrying `{ component: 'cortex' }` in the payload rather than baking the component into the event name. Regression-guarded by `test/event-name-conformance.test.js`. |
| D-38 | CRITICAL | `mythos/src/core/cortex/index.js:212-216` (line drifted from :88) | `goals.arbitrate(ranked, working)` — arbiter receives the salience-ranked structure | ~~strips ranked output to bare perceptions (`.map(r => r.perception)`) before calling arbitrate~~ — ✅ **RESOLVED** (Phase 4.5 remediation #12; reconfirmed 2026-07-27): current code passes `ranked.map(r => Object.assign({}, r.perception, { rankedSalience: r.rankedSalience }))` into `goals.arbitrate()` — perception fields plus `rankedSalience` are both present. Regression test `test/cortex-goals.test.js` ("D-38 regression: arbitrate() must receive objects carrying rankedSalience...") passes. |
| D-39 | CRITICAL | `mythos/src/core/cortex/index.js:16-22` (line drifted from :108,121,131) | leash check / breaker check / effector dispatch are mandatory, fail-closed gates | ~~all three are conditionally skipped if the dependency is falsy~~ — ✅ **RESOLVED** (Phase 4.5 remediation #13; reconfirmed 2026-07-27): `createCortex({leash, effectors, ...})` now throws at construction if `leash` lacks a `check()` method or `effectors` lacks an `invoke()` method, eliminating the old `if (leash && typeof leash.check === 'function')` fail-open pattern. `act()` now calls `leash.check(...)` and dispatches unconditionally, relying on that constructor guarantee; the breaker check is enforced unconditionally inside `effectors.invoke()` (`effectors/hub.js:91`). |
| D-40 | MAJOR | `mythos/src/core/sensors/timer.js:17` | payload `{kind:'timer', ts}` with `salienceHint: 0.1`, meta `{source:'sensor-timer'}` | payload is `{ts, generation}` — no `kind`, no salience hint, no `source`; `orient()` will score these at salience 0, not spec's 0.1 baseline |
| D-41 | RESOLVED | `mythos/src/core/effectors/dispatch-action.js:36-49` (moved from `cortex/index.js:136-142` during the F1 dispatch-consolidation refactor) | episodic action record includes `tier: leashResult.tier` | ✅ Fixed (reconfirmed 2026-07-27) — `cortex/index.js`'s `act()` passes `tier: leashResult.tier \|\| 0` into the shared `dispatchAction()`, which writes it into the episodic record as `tier: tier`. No longer dropped. |
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
| D-47 | MAJOR | `mythos/src/core/goals/index.js:438-453` (line drifted from :218-223) | Brain call includes `budget: goal.budget.tokens - goal.spent.tokens` | `budget` field is omitted entirely from the `ctx.brain.think(...)` call — Brain never learns the remaining token budget for the goal — ✅ **RESOLVED** (Phase 1, 2026-07-16; reconfirmed 2026-07-27): `plan()` now forwards `budget: {tokens: remaining, actions: remaining}` to `brain.think()`; `brain/index.js think()` adds a defense-in-depth check returning `{content:null, offline:true, budgetExhausted:true}` when either dimension is exhausted (additive — unreachable for all pre-existing callers). Test: `test/cortex-goals.test.js` + `test/brain.test.js` (118/118 combined, run as separate files). |
| D-48 | MAJOR | `mythos/src/core/goals/index.js:199-200,454` (line drifted from :224-226) | `parsed = result.parsed \|\| tryParse(result.content)` fallback | ✅ **RESOLVED-BY-DESIGN** (predates Phase 4 audit; brain module added 2026-07-09 commit 3bf42de; reconfirmed 2026-07-27): `goals/index.js` only checks `result.parsed` locally, but `brain.think()` (`mythos/src/core/brain/index.js:149,160-161`) already computes `parsed: tryParseWithRepair(result.content) \|\| null` on every call before returning — a strict superset of a plain tryParse (direct parse, backslash-repair retry, fence-strip, brace/bracket extraction). Every Brain caller, including goals/index.js, therefore already receives the fallback-parsed value; there is no path where parseable raw text is dropped. No code change needed. |
| D-49 | MAJOR | `mythos/src/core/goals/index.js:52-56` (line drifted from :32-34) | budget defaults sourced from config (`GOAL_TOKEN_BUDGET`, `GOAL_ACTION_BUDGET` exist in schema) | hardcodes `tokens: 50000, actions: 50` — never reads the two config keys that exist specifically for this — ✅ **RESOLVED** (Phase 1, 2026-07-16; reconfirmed 2026-07-27): `create()` and `init()`'s legacy normalization both now read `config.GOAL_TOKEN_BUDGET`/`GOAL_ACTION_BUDGET` (defaults 20000/25), explicit `opts.budget` still wins. Test: `test/cortex-goals.test.js` (56/56). |
| D-50 | MINOR | `mythos/src/core/goals/index.js:29` | schema example shows `status: 'active'` | actual default on create is `status: 'proposed'` — likely just the spec excerpt using an illustrative value, but worth reconciling in the spec doc |
| D-51 | MINOR | `mythos/src/core/goals/index.js:241-286` (line drifted from :122-125) | "Enforce MAX_ACTIVE_GOALS" (mechanism unspecified) | caps candidates by slicing the first N in insertion order *before* scoring — a high-priority goal created 6th can be permanently excluded from arbitration while a low-priority 1st-created goal is always considered — ✅ **RESOLVED** (Phase 1, 2026-07-16; reconfirmed 2026-07-27): cap moved to AFTER `scored.sort()` — all candidates are now scored before the top-N cap is applied. Test: `test/cortex-goals.test.js` ("D-51 regression: arbitrate scores ALL candidates before capping", 56/56). |
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
| 1 | D-01 | Add `dependencies` to `mythos/package.json`: `dotenv`, `express`, `ws`, `playwright-core` (exact 4, pinned to same versions as NOVA `app/package.json`) | ⚠️ Reopened (2026-07-27) — current `mythos/package.json` has 7 deps (`@mediapipe/tasks-vision`, `exceljs`, `express`, `onnxruntime-web`, `playwright-core`, `pptxgenjs`, `ws`); `dotenv` is still never declared/required, and 4 deps outside the spec's exact-4 list were added in later phases without revisiting this constraint. Needs either a spec update (constraint was never meant to survive feature growth) or a dependency cleanup — flagging as MAJOR in Known Deviations pending a decision, not re-closed as CRITICAL-fixed. |
| 2 | D-02 | Call `require('dotenv').config()` at the top of `src/main.js` before config validation runs | ✅ (superseded 2026-07-27, commit 91ae8b2: `dotenv` dependency removed repo-wide; `.env` now loaded via Node 20.6+ built-in `try { process.loadEnvFile(); } catch (_) {}` at `src/main.js:80`, still ahead of `loadConfig()` at line 86, preserving "missing .env is not fatal" semantics) |
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

**MAJOR** (10 total, tracked by ID above, re-verified 2026-07-27): D-01 (reopened —
see Phase 4.5 row above), D-05, D-06, D-08, D-19 (partially resolved — audit-writer
still missing `recall()`/`get()`, see row above), D-20, D-22, D-31, D-40, D-42.
Resolved and removed from this count since the last listing: D-07, D-21, D-23,
D-29, D-30, D-41, D-47, D-48, D-49 (each confirmed fixed in code — see their rows
above). The former D-06/D-07 overlap note is superseded now that D-07 is resolved —
only D-06 (bus middleware `auditTap`/`historyTap`/`redactSecrets` still unwired,
`mythos/src/core/bus/index.js`) remains open and load-bearing for P1's audit-writer
and P6's watchdog — fix opportunistically when touching that file.

**MINOR** (21 open, tracked by ID above, re-verified 2026-07-27): D-09 through D-12,
D-14, D-24 through D-27, D-32 through D-35, D-43 through D-46, D-50, D-52 through
D-54. D-13 resolved (closed alongside D-07 — see row above) and D-51 resolved
(Phase 1, 2026-07-16 — see row above). D-55 resolved (see below). D-56 (CRITICAL,
P10-attributed, tracked separately below) also resolved.

**New, P10-attributed, tracked separately from the P0–P4 audit-era counts above**
(same convention as D-55, found during P5): **D-56** (CRITICAL, found by P10;
✅ RESOLVED — see below) and **D-57** (MAJOR, found by P10; ✅ **fully RESOLVED —
structural half in P17, job↔goal mapping in P18, goal-level auto-resume in P19**
— see below). D-23 (MAJOR, found pre-P10, tracked under R5) is also ✅ **RESOLVED
in P17** — see below.

| ID | Severity | File:Line | Finding |
|----|----------|-----------|---------|
| D-55 | MINOR — ✅ RESOLVED | `mythos/src/core/memory/audit-writer.js:11-24` | `redact()` only inspected top-level keys of `args` — nested objects/arrays (e.g. a `{headers:{authorization:...}}` shape, or free text typed into a form via `ui_type`/`browser_type`) were copied verbatim into the append-only, permanent `vault/Audit/*.jsonl` trail. `REDACT_KEYS` was also narrow (no `cookie`, `credential`, `session`). Found by Phase 5's security audit while reviewing what Leash writes through this module; flagged rather than fixed in that session since `audit-writer.js` is P1-shipped code outside Phase 5's touch scope. Fixed opportunistically: `redact()` now recurses through nested objects and arrays at any depth, and `REDACT_KEYS` includes `cookie`, `credential`, `session`. Regression tests added in `mythos/test/memory.test.js` (nested-object and array-of-objects cases); full suite (234 tests) green. |
| D-56 | CRITICAL — ✅ RESOLVED | `mythos/src/core/brain/index.js:73` | `chain.complete({messages, kind: lane === 'embed' ? 'simple' : lane, ...})` passed the caller's lane as `kind`, never as `brain`. `chain.js`'s own `complete({messages,kind,brain,...})` (`chain.js:70`) only reads `kind` to special-case `'vision'`; `brain` is the field that selects the `'voice'/'build'/'simple'` preference table + its `CHAIN_VOICE`/`CHAIN_BUILD`/`CHAIN_SIMPLE` env override. Since `brain` was never passed, every `brain.think({lane:'voice'\|'build'\|'simple',...})` call silently fell through to the `'text'` lane's table instead of the requested lane, since Phase 2. Found while building P10's Drill 1 (`test/chaos-provider-killed.test.js`) — `test/brain.test.js` never caught it because its own assertions accepted either offline outcome. Fixed: `brain/index.js:73` now reads `brain: lane === 'embed' ? 'simple' : lane` (renamed the key, same value expression; `kind` dropped since chain.js only needs it for the 'vision' special-case, which this facade never hits directly). Regression test added in `mythos/test/brain.test.js` (D-56 describe block): stubs `zcode.chat` and asserts `brain.think({lane:'build'})` resolves via the `CHAIN_BUILD` override, not `CHAIN_TEXT`. `test/chaos-provider-killed.test.js`'s Drill 1 header comment and env setup updated to drop the now-unneeded `CHAIN_TEXT` workaround, since `brain.think({lane:'voice'})` genuinely consults `CHAIN_VOICE` now. Full suite green: 328 tests, 326 passing / 1 skipped / 1 failing (both pre-existing, unrelated — `test/boot.test.js` SIGINT and `test/sensors-file.test.js` isolated-child-process, same as before this fix). |
| D-57 | MAJOR — ✅ RESOLVED (structural half P17, job↔goal mapping P18, goal auto-resume P19) | `mythos/src/main.js` (`'leash'` step, `'recovery'` step), `mythos/src/core/immune/monitor.js`, `mythos/src/core/effectors/{build-runner,agent-actions,orchestrator,from-project,from-mission,from-dashboard}.js` | The spec's own Drill 6 and Integration Points table assume `main.js`'s `'recovery'` boot step composes `buildRunner.init().recoveredJobs` → job-goal-map → `goals.update(goalId,{status:'paused',reason:'crash-recovery'})`. Found by P10: it did not — `'recovery'` ran before `'leash'` (which constructs `buildRunner`), so the composition was structurally impossible in the real boot order, and `recoverFromCrash()` had no `buildRunner` parameter at all. **P17 fix**: `'recovery'` now runs after `'leash'` in `main.js`'s step list; `recoverFromCrash({bus,config,memory,goals,buildRunner})` awaits `buildRunner.init()` and folds `recoveredJobs.length` into both its return value and the `lifecycle.recovered` event. **P18 fix**: the remaining, explicitly-flagged half — there was genuinely no persisted job↔goal mapping in shipped code (`agent-actions.js`'s `buildRunner.enqueue()` calls carried no `goalId`). Fixed: `build-runner.js`'s `enqueue({kind,prompt,run,goalId})` now carries `goalId` (honestly `null` when the job is goal-less) onto the job record and into `recoveredJobs`; `agent-actions.js`'s `executePipelineCard/assembleKanbanPlan/buildKanbanCard` take an optional `goalId` and thread it to `enqueue()`; every real call site (`from-project.js`'s `start_project`, `from-dashboard.js`'s `pipeline_execute`/`kanban_assemble`/`kanban_build_card`, `from-mission.js`'s `run_mission` → `orchestrator.js`'s `runMission()`) now passes `ctx.goalId` — the same `working.activeGoalId` cortex's `act()` (and `server/index.js`'s voice-dispatch path) already threads into every `effectors.invoke()` call, just not further than that before this phase. `recoverFromCrash()` now builds `recoveredJobGoalMap` (`[{jobId,goalId}]`) from the real, non-invented goalId and surfaces it in both its return value and the `lifecycle.recovered` event — the actual reattachment mechanism the boot-order fix alone couldn't provide. **P19 fix (this phase)**: the last, explicitly-flagged half — automatic resumption. `goals/index.js`'s `getActiveGoals()`/`arbitrate()` only ever consider `status==='active'` goals, and nothing in shipped code ever un-paused a `'crash-recovery'`-paused goal, so it stayed invisible to arbitration forever. `recoverFromCrash()` now reactivates (`status:'active'`, `reason:'crash-recovery-resumed'`) exactly the goals present in `recoveredJobGoalMap` with a non-null `goalId` — a goal with no recovered job stays paused, unchanged. This is not a replay of the crashed job (Crash Invariant #2 — "no fake resume" — is respected: the job itself stays honestly `'failed'`, and `recoverFromCrash()` issues no `enqueue()`/`effectors.invoke()` call of its own); `goals/index.js`'s `plan()` was already stateless per call (`goal.plan` is never populated with persisted step-state anywhere in shipped code), so reactivating the goal is equivalent to letting its own cognition continue, and the pre-existing in-flight guards in `agent-actions.js` (`existing.status==='queued'\|\|'running'` → throw) still gate whatever concrete action the reactivated goal's planner decides on next, proven by a real-instance test that calls `recoverFromCrash()` while a job is still genuinely running and asserts recovery enqueues nothing and a genuine duplicate build attempt is still refused. Regression: `test/p18-goal-job-mapping.test.js`, `test/p19-goal-auto-resume.test.js`. |
| D-23 | MAJOR — ✅ RESOLVED in P17 | `mythos/src/core/memory/working.js`, `mythos/src/core/memory/index.js` | Spec: WorkingMemory should rebuild from the episodic tail only if a checkpoint is missing. Found pre-P10, tracked under R5: `working.init()` unconditionally called `rebuildFromEpisodic()`, never consulting `checkpoints.load()` at all — even though `immune/monitor.js`'s own `recoverFromCrash()` comment already (incorrectly) claimed this behavior existed. **Fixed**: `createWorkingMemory()` now takes an optional `checkpoints` dependency; `init()` restores `{tick, activeGoalId}` directly from a checkpoint when one exists, falling back to the episodic-tail scan only when it doesn't. `memory/index.js` wires `checkpoints` through. Backward compatible — the two pre-existing call sites that construct `createWorkingMemory()` without `checkpoints` (`test/chaos-memory-corrupt.test.js`, `test/memory.test.js`) keep their prior unconditional-fallback behavior unchanged. Regression: `test/d23-working-memory-checkpoint-regression.test.js`. |

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

## Phase 10 — Chaos Drills ✅ Done (2026-07-10)

**Scope**: six failure-injection tests proving honest-inert posture — test files
only, no `src/core/**` changes, per the spec's own scope mandate.

**Full build spec**: [MYTHOS-PHASE-BUILD-SPEC.md § Phase 10 — Chaos Drills](MYTHOS-PHASE-BUILD-SPEC.md#phase-10--chaos-drills) —
complete, runnable `node:test` files for all 6 drills against real (not faked)
P1/P2/P3/P4/P6/P7 instances, an Ambiguities-Resolved section, an Integration Points
table, a 10-item Anti-Drift Checklist, and a Risk Register (R1–R9) cross-reference
showing which drill proves which risk's mitigation actually works.

| Drill | File | Injection | Expected Behavior | Status |
|-------|------|-----------|-------------------|--------|
| Provider-killed | `test/chaos-provider-killed.test.js` (3 tests) | Kill Groq/Ollama fake HTTP server mid-request (socket destroy) | `chain.js`'s per-lane cooldown falls back, `brain.think()` returns `{offline:true}` when exhausted, never throws | ✅ |
| Cortex-stalled | `test/chaos-cortex-stalled.test.js` (1 test) | Synchronous busy-wait blocks the event loop past `STALL_MS*5` | Watchdog detects via `cortex.lastTickAt` (detection-only), diagnostician→healer's `'stall-restart'` playbook restarts cortex and pauses the active goal with reason `'cortex-restart'` | ✅ |
| Disk-full | `test/chaos-disk-full.test.js` (3 tests) | Monkey-patch `fs-store`'s `appendLine`/`writeJSON` to throw ENOSPC | `episodic.write()`/`checkpoints.save()` degrade to `{degraded:true}`, `health.anomaly` fires, recovers once the underlying write succeeds again | ✅ |
| Memory-corrupt | `test/chaos-memory-corrupt.test.js` (2 tests) | Append a malformed line into a real episodic `.jsonl` file mid-write | Corrupt line skipped, `health.anomaly{kind:'corrupt-line'}` fires (D-16), surrounding entries + checkpoint-restore + WorkingMemory rebuild survive | ✅ |
| Concurrent-tick | `test/chaos-concurrent-tick.test.js` (1 test) | Two `cortex.tickOnce()` calls overlap (40ms fake-effector delay widens the window) | Reentrancy guard (`_inFlight`) makes the second call a true no-op; real `goals.arbitrate()` receives `rankedSalience` on every perception — the direct D-38 regression test | ✅ |
| Restart-mid-action | `test/chaos-restart-mid-action.test.js` (1 test) | Drop all references to a pre-crash build-runner/goals/audit instance mid-dispatch (no graceful shutdown) — construct fresh instances against the same vault | In-flight job → `failed`, its goal → `paused` with reason `'crash-recovery'`, no orphaned `'confirm'` audit entries survive | ✅ |

**Post-merge fix — Cortex-stalled flakiness (found in independent verification, not by the P10 build agent).** The drill's original config (`MYTHOS_TICK_MS:10`, `WATCHDOG_MS:15`) failed ~2/3 of isolated runs. Root cause: the busy-wait freezes the *entire* event loop, so cortex's own tick timer and watchdog's poll timer both become simultaneously overdue the instant it unblocks — Node fires whichever has the chronologically earlier next-deadline, and with cortex's period *shorter* than watchdog's, cortex usually won, refreshing `lastTickAt` before watchdog ever checked, so the anomaly silently never fired. A second issue surfaced while fixing the first: `cortex.lastTickAt.value` initializes to `0` (epoch), so starting watchdog before cortex's first real tick causes an immediate spurious "stall" at boot, burning the healer's 30s cooldown before the drill's intentional stall ever happens. Fixed by (a) not starting diagnostician/healer/watchdog until cortex's first real tick lands, and (b) widening the tick-vs-watchdog period ratio (`MYTHOS_TICK_MS:300`, `WATCHDOG_MS:5`, `STALL_MS:600`) so the residual race's collision probability drops from ~1-in-8 to ~1-in-60 — verified clean across 20 consecutive isolated runs plus a full-suite pass. This does not eliminate the race in principle (no fixed config can, for a whole-event-loop-freeze simulation), but reduces it to a negligible residual, consistent with how `boot.test.js`'s known Windows sandbox issue is already tolerated elsewhere in this suite.

**Gate**: all 6 drills green, 327/327 tests exercised, 325 pass / 1 skip / 1 fail —
the 1 fail is the same pre-existing, environment-blocked `test/boot.test.js`
SIGINT/`fs.watch()` Windows-sandbox item tracked since P7 (not a P10 regression); the
1 skip is `test/sensors-file.test.js`'s isolated-child-process positive path, also
pre-existing since P7. No leftover `mythos-chaos-*` temp directories after a full run
(Anti-Drift Checklist item 9 verified).

**Three spec-vs-reality fixes made while building the drills** (the spec's own Full
Code was written against an assumed module surface; each was verified against
today's actual shipped source before writing the test, not guessed):
1. **`createFsStore`'s real signature is `createFsStore(vaultRootFn, bus)`** — `bus`
   is a direct positional argument (`fs-store.js:11`), not the `{bus}={}` options
   object the spec's Ambiguity #1 write-up describes. Confirmed against the real call
   sites (`memory/index.js:17`, `test/memory.test.js:58`, both pass `bus` directly).
   Drills 4 and 6 construct `createFsStore(() => dir, bus)`, not `{bus: bus}` —
   passing the spec's literal shape would have silently defeated corrupt-line
   detection (`bus.emit` called on a plain object with no `.emit` method).
2. **`createBuildRunner` throws at construction if `brain.think` isn't a function**
   (`build-runner.js:13-15`, also directly asserted by
   `test/build-runner.test.js:36-39`). The spec's own pasted Drill 6 code passes
   `brain: null` for both the pre- and post-crash instances, which would throw
   before the drill's body ever runs. Fixed with the same stub shape
   `test/build-runner.test.js` already uses. For the pre-crash instance the stub must
   resolve non-offline — an offline brain fails the job immediately (`status:
   'failed'`, never `'running'`) and the drill would never reach the "crash
   mid-dispatch" state it's meant to simulate.
3. **`cortex/index.js`'s `ACTION_TIMEOUT_MS` has no inline fallback** (schema-only,
   `cortex/index.js:21-24`, Phase 9's Gap-4 closure). Drill 5's spec-given config
   omits it; since Drill 5 genuinely reaches `act()` (pre-populated pending plan
   step), `AbortSignal.timeout(undefined)` throws — verified directly — which
   `tickOnce()`'s own try/catch would have silently swallowed into a `'tick-error'`
   anomaly, failing the test on a false premise (effector never dispatched) instead
   of testing the reentrancy guard. Added `ACTION_TIMEOUT_MS: 30000` to Drills 2 and
   5's configs, matching every other real test that constructs cortex
   (`cortex-goals.test.js`, `immune.test.js`).

**One real, previously-uncaught production bug found (D-56, CRITICAL, not fixed —
`src/core/brain/index.js` is out of scope for this test-files-only phase)**: while
making Drill 1 pass, `brain.think({lane:'voice',...})` returned `{offline:true}`
even with both fake providers healthy and correctly configured via `CHAIN_VOICE`.
Root cause: `brain/index.js:73` calls
`chain.complete({messages, kind: lane === 'embed' ? 'simple' : lane, ...})` —
passing the caller's lane as `kind`. But `chain.js`'s own `complete({messages,kind,
brain,...})` only reads `kind` to special-case `'vision'`
(`chain.js:70`: `effectiveKind = brain || (kind === 'vision' ? 'vision' : 'text')`);
`brain` is the parameter that actually selects the `'voice'/'build'/'simple'`
preference table and its `CHAIN_VOICE`/`CHAIN_BUILD`/`CHAIN_SIMPLE` env override.
Since `brain/index.js` never sets `brain`, **every `brain.think({lane:'voice'|
'build'|'simple',...})` call has silently resolved through the `'text'` lane's
table instead of the requested lane since Phase 2** — `test/brain.test.js` never
caught this because its own assertions accept either offline outcome
(`result.offline === true || result.offline === false`) rather than asserting which
provider/lane was actually used. Confirmed by direct reproduction against real code
(a standalone script showed `chain.complete({brain:'voice',...})` correctly resolves
groq→ollama fallback, while `brain.think({lane:'voice',...})` does not). Drill 1's
tests 1 and 3 are written to prove real current behavior — both `CHAIN_VOICE` and
`CHAIN_TEXT` env overrides are set (with an inline comment explaining why), since
`CHAIN_TEXT` is the override that actually governs `brain.think()` today. Recommend
a 1-line fix in a future phase: `brain/index.js:73`'s `kind: lane === 'embed' ?
'simple' : lane` → `brain: lane === 'embed' ? 'simple' : lane`, plus a regression
test asserting which lane/override `brain.think()` actually consults (not just
`result.offline === true || false`).

*(Since resolved — see Known Deviations' D-56 entry above for the fix, regression
test, and full-suite verification.)*

**One real, previously-documented gap confirmed still open (D-57, MAJOR, not fixed —
`main.js` is out of scope for this test-files-only phase)**: the spec's own Drill 6
(and its Integration Points table's "Drill calls INTO `main.js`'s `recovery` boot
step" row) assumes `main.js`'s `'recovery'` boot step performs the composition
`buildRunner.init().recoveredJobs` → job-goal-map → `goals.update(goalId,
{status:'paused',reason:'crash-recovery'})`. Reading `main.js`'s real boot steps
(lines ~186-193 `'recovery'`, ~195-253 `'leash'`) shows this composition does not
exist: the `'recovery'` step calls only `recoverFromCrash({bus,config,memory,goals})`
(P6's checkpoint-based recovery, which pauses active-at-crash goals but has no
concept of build-runner jobs at all) — and `buildRunner` isn't even constructed
until the later `'leash'` step, which runs *after* `'recovery'`, making the
spec-assumed composition structurally impossible in today's boot order as written.
The literal string `'crash-recovery'` does not appear anywhere in `main.js`. Per
the spec's own Anti-Drift item 6 and "Do NOT" list ("do not treat a green Drill 5
or Drill 6 as proof that main.js's actual boot sequence performs the same
composition"), Drill 6 is written against freshly-constructed real modules directly
(`createFsStore`/`createGoalSystem`/`createAuditWriter`/`createBuildRunner`), proving
the modules compose correctly in isolation — but this does **not** prove `main.js`'s
real boot sequence wires it. Not fixed here (a `main.js` change is genuine scope
creep on a phase whose own framing and "Do NOT" list is test-files-only); recommend
a small dedicated follow-up phase that either moves the `'recovery'` step after
`'leash'` or has `'leash'`'s `buildRunner` construction feed its `recoveredJobs`
back into a second recovery pass, plus a real-boot-level regression test (grep
`main.js` for the literal string `'crash-recovery'`, or a boot-level integration
test) before R9/R5 can be considered closed at the boot level, not just the module
level.

**Anti-Drift Checklist**: all 10 items verified — every event-name/kind/reason
string (`'health.anomaly'`, `'brain-spend'`, `'tick'`, `'cortex-stall'`,
`'corrupt-line'`, `'cortex-restart'`, `'crash-recovery'`) copied verbatim from
already-shipped source, never respelled; all six tests wrap the real `createBus()`
(no hand-rolled event recorder); Drill 3's write path left untouched (Ambiguity #2 —
already conformant); `createWatchdog`/`createBreaker` construction-throw checks
untouched (already shipped correctly per P6); `chain.js`'s single-fail cooldown
left as-is, not rewired to consume `BREAKER_FAIL_THRESHOLD`; all `bus`/`config`
objects are real-shaped, never global `process.env` reads inside assertions; every
temp-dir test (Drills 3, 4, 6) cleans up via `fs.rmSync(dir,{recursive:true,
force:true})` in `afterEach` — verified zero leftover `mythos-chaos-*` directories;
Drill 5's 40ms effector delay and Drill 2's synchronous busy-wait both kept
load-bearing, neither simplified to something cooperative/synchronous.

**Risk Register cross-reference** (transcribed from the spec's own Risk Register
Cross-Reference table, verified against what was actually built — see the updated
Risk Register section below for the authoritative per-risk rows):
- **R1** — not a failure-injection concern by nature (already proven by P3's own
  idle-tick gate); no gap.
- **R2** (Memory growth) — **gap**. No drill exercises `consolidate()`/decay-to-
  archive under real growth at scale; Drill 4 touches episodic corruption, not
  growth. Recommend a dedicated P1-scope regression test rather than a 7th chaos
  drill. (Note: D-17/D-18, the underlying consolidate/archive-not-delete bugs this
  row used to cite, were closed back at Phase 4.5 — this gap is now specifically
  "no drill proves it holds at scale," not "the code is broken.")
- **R3** (Autonomy safety) — **partial gap**. Drill 6 proves the audit trail
  survives a crash; no drill exercises `MYTHOS_DRY_RUN` or leash tier-gating under a
  simultaneous provider outage. Recommend closing before any future cutover.
- **R4** (Identity drift) — **gap, acceptable for P10**. No drill touches
  `identity/index.js`/`boundaries.md` — identity isn't a failure-injection surface
  per se, but it should get its own contract test in a future phase, not indefinitely
  deferred.
- **R5** (SPOF) — **well covered** for the failure modes the drills exercise (Drill 4
  checkpoint-restore after corruption + Drill 6 restart-mid-action) — this is the
  risk P10 exists for. D-23 (WorkingMemory's `rebuildFromEpisodic()` never actually
  calls `checkpoints.load()`/consults `isCrashRecovery` — it unconditionally rebuilds
  from the episodic tail regardless of whether a checkpoint exists) remains open and
  untouched by P10; Drill 4's WorkingMemory-rebuild assertion exercises the
  episodic-tail path specifically, not D-23's still-missing checkpoint-gated branch.
- **R6, R7** — N/A, infra/already-✅ concerns, no drill needed.
- **R8** (Event-name drift) — **intentional gap**, a static/lint concern (grep
  emitted string literals against a spec-derived allowlist), not a failure-injection
  concern — belongs in its own `test/event-name-conformance.test.js`, still open
  per the pre-existing `⏳ P5+` marker.
- **R9** (Cross-module contract breaks invisible to unit tests) — **well covered**
  for the two seams P10 targets: Drill 5 (Cortex↔Goals, the exact D-38 seam,
  `rankedSalience` reaching `arbitrate()`) and Drill 6 (build-runner↔goals↔audit, at
  the module level — see D-57 above for the real-boot-level gap this does **not**
  close). Not covered: Cortex→Effectors under real (non-stub) effectors, since
  Drills 2/5/6 all use stub `effectors` objects to isolate the seam under test —
  recommend one additional real-instance Cortex→EffectorHub-under-failure test in a
  future phase, distinct from these six drills (the existing
  `test/integration-cortex-effectors.test.js` from P7 covers the happy path already).

---

## Phase 11 — Voice Agent v2 + Semantic Memory + Mission Orchestrator ✅ Done (2026-07-10)

**Scope**: user-requested fixes to voice (barge-in, TTS text sanitization, conversation
memory, real tool-calling) plus two new capabilities the user explicitly asked about —
semantic memory recall and a way for the brain to delegate multi-part goals to a
background agent team.

**Framework decision (explicit design commitment, not just an implementation
detail)**: no LangChain, no LangGraph, no external vector DB. LangChain.js would wrap
the same free-tier APIs `chain.js` already fails over across; LangGraph models graphs
of stateful nodes, but the mission "graph" here is a fixed 3-stage pipeline (plan →
parallel build → synthesize) — a ~150-line module over the existing build-runner, not
a framework's worth of state machine; a vector DB is overkill for the memory volume
this entity will ever hold — cosine similarity over an in-memory Float32 index loaded
from a JSON sidecar is milliseconds at this scale. Zero new npm dependencies. Revisit
only if memory outgrows ~50K vectors (sqlite-vec) or missions become genuinely dynamic
graphs.

**Voice Agent v2** (`src/core/voice/voice-agent.js`, new): CA of NOVA
`app/lib/voice/voice-agent.js` — persona (DANGER TOOLS RULE + PROJECT INTAKE RULE) +
a 21-tool catalog → `{say, actions, needs_result}` JSON via `brain.think(lane:'voice')`
→ `leash.check()` per action → the same `dispatchAction` execution surface confirm-
accepts already use → `needs_result` re-prompt loop (max 4) → one corrective pass on
failed single-iteration turns. Per-connection conversation history (12 turns, 10-min
TTL, CA of NOVA's `intake.js`) replaces the previous single-turn-only prompt.
`sanitizeSpoken()` (`src/core/voice/spoken-text.js`, new) strips markdown and expands
abbreviations before TTS — the caption still shows the original text. Client-side
barge-in: the recognizer stays live during playback; a non-echo transcript stops
playback and becomes the next command (echo-guarded via word-overlap against the
currently-spoken reply).

**Semantic memory** (`providers/embeddings.js` + `src/core/memory/vector-index.js`,
new): `embed(text)` chain — Ollama `nomic-embed-text` (local, free) → Mistral
`mistral-embed` (free tier) → `null`. Per-store cosine index (`vault/Index/<store>.vec.json`),
partitioned by embedding provider. `memory.recallHybrid(query)` fuses the existing
keyword scorer with vector search via reciprocal-rank fusion — same result shape every
existing caller already expects, embeddings-down degrades to exactly today's keyword
behavior. `PREF_EMBED` now documents the real chain (previously an empty placeholder);
`brain.think({lane:'embed'})` still hard-short-circuits to `{offline:true}` — the real
embedding path never goes through `chain.js`/`registry.js`.

**Mission orchestrator** (`src/core/effectors/orchestrator.js`, new): fixed 3-stage
pipeline over existing P7 primitives — `assembleKanbanPlan` (Planner agent → kanban
cards) → `buildKanbanCard` per card in parallel (build-runner's existing queue,
`MYTHOS_BUILD_CONCURRENCY` 1→3) → one `brain.think('simple')` synthesis call over the
artifacts. Emits `mission.update` on every transition (relayed as WS `mission`),
persists to `Checkpoints/missions.json` with the same crash-recovery honesty as
build-runner. New `run_mission`/`mission_status` tools (tiers 3/0), intake-gated in the
voice agent identically to `start_project`.

**Verified live** (not simulated): full 3-turn voice intake → "run the mission now" →
6-task plan → 6 parallel builder agents → mission `done` with 6/6 real artifacts under
`vault/builds/kanban/` (color palette, landing page, logo guide, brand kit, +2 more),
synthesis summary spoken back. Semantic recall: wrote an episode about "the PawShop
landing page... for a pet shop", queried "what website did we make for animals?"
(zero shared keywords) → hybrid recall returned it via the vector path, ranked first;
direct cosine sanity check: related paraphrase 0.74 vs unrelated text 0.33.

**One real bug found and fixed by the full-suite run itself**: `createVoiceAgent()`
fail-fasts on a missing `brain`/`leash.check` (always present in production —
`main.js` constructs both fully before `createServer`), but it was being constructed
unconditionally immediately after `app.listen()` opens the socket. `test/server.test.js`'s
intentionally-partial mocks (testing unrelated server surface — WS relay, confirm
flow, HTTP routes) threw mid-construction with the listening socket already open and
never reachable for `server.stop()`, hanging the entire `node --test` process
indefinitely afterward with zero CPU growth (confirmed via repeated `Get-Process`
sampling over a 19-minute stall before diagnosis) rather than failing fast. Fixed by
wrapping the construction in try/catch — `voiceAgent` degrades to `null`,
`handleUtterance` falls back to the existing "Brain is offline" honest message — no
test-fixture changes needed, consistent with the file's own established never-throw
philosophy.

**Gate**: 341 tests, 339 pass, 1 skip, 1 fail — the fail is the same pre-existing
`test/boot.test.js` Windows `fs.watch()`/SIGINT environment issue tracked since P7
(confirmed via isolated run: completes in ~1.2s, fails only its own exit-code
assertion, does not hang) — not a regression from this phase.

---

## Phase 12 — Voice Input: Server-Side Transcription ✅ Done (2026-07-10)

Voice input never worked reliably on this dev machine, across every fix attempted in
P11 and after: dropping the wake-word gate, fixing reply-discarding, fixing
mid-sentence cutoff, bounding the on-device install with a timeout. Root cause,
confirmed live against the real running instance (not assumed): Chrome's built-in
`SpeechRecognition` depends on Google's hosted speech backend
(`speech.googleapis.com`), unreachable from this network — cloud recognition fails
in <0.5s with a `network`-class error; the on-device `processLocally` fallback
stalls indefinitely trying to download its language-pack component for the same
underlying network reason (`available()` reports `'downloading'` persistently across
reloads, `install()` never resolves or rejects even after a 20s race). No
client-side retry/timeout logic can fix a blocked network path to a specific host.

**Fix**: stop depending on Google's speech engine entirely.
- `providers/groq-stt.js` (new): `transcribe(buffer, mimeType)` — multipart POST to
  Groq's Whisper endpoint (`whisper-large-v3-turbo`), same host (`api.groq.com`)
  already proven reachable all session for chat completions. Native `fetch`/
  `FormData`/`Blob` (Node 26) — zero new deps.
- `server/index.js`: `POST /api/voice/transcribe`, `express.raw()` scoped to this
  one route (global `express.json()` only matches `application/json`, doesn't
  interfere). Honest 503/502 on missing key / Groq failure — never hangs.
- `ui/public/js/voice/voice-loop.js`: replaced the browser recognizer with
  `getUserMedia` + a simple RMS-based VAD (`AnalyserNode`, ~100ms tick,
  `SILENCE_MS`-gated utterance boundaries) driving per-utterance `MediaRecorder`
  segments POSTed to the new route. Everything downstream — wake-word strip,
  nav commands, echo-guard/barge-in, `handleCommand` → voice-agent → brain — is
  unchanged; only the input engine was swapped. Public API (`{start, stop, toggle,
  isActive, cleanup}`) unchanged, no caller-side changes needed.
- Found by live testing (not a test file): an in-flight transcription request that
  resolved *after* the mic was toggled off still dispatched a command — the
  synchronous `recognizer.abort()` in the old design had no equivalent async race;
  `transcribeAndDispatch()` now re-checks `active`/`disposed` after every `await`
  before acting on a late-arriving transcript.

**Verified live** against the real running instance: a synthesized test phrase
round-tripped through `edge-tts` → `/api/voice/transcribe` → Groq came back
correctly transcribed; arming the mic drove real `getUserMedia` → VAD → Whisper →
brain → TTS turns end-to-end with no wake word; toggling the mic off mid-turn (after
the race fix) stayed idle with no further replies. TTS (Fable's original
`en-GB-RyanNeural` work) is a separate one-way channel untouched by this change and
confirmed still working via the same round-trip test.

Windows Defender's Network Inspection System remains an untested hypothesis for the
underlying network block (both Google's speech endpoint and Chrome's on-device
component download are affected) — informational only, doesn't gate voice working
today since this phase routes around it entirely.

**Gate**: 341 tests, 339 pass, 1 skip, 1 fail (same pre-existing `boot.test.js` port
conflict — expected, a live instance was running on 4478 during the run).

---

## Phase 13 — get_time / get_weather tools ✅ Done (2026-07-10)

Basic situational questions ("what time is it", "what's the weather") had no tool
to answer them at all. Added `src/core/effectors/from-system.js` following the
exact `from-mission.js` registration pattern: `get_time` (native `Date`/`Intl`, no
dependency, optional IANA `timezone` param, degrades to system default on an
invalid zone instead of throwing) and `get_weather` (Open-Meteo, no API key — the
same free provider the dashboard's weather widget already uses, WMO code table
copied verbatim; optional `location` param geocoded through Open-Meteo's free
geocoding endpoint, else a new `WEATHER_LOCATION` config default matching the
widget's existing Kolkata fallback). Both are tier 0 (read-only, auto-allow) in
`tiers.js` and added to the voice-agent `CATALOG`.

Found by live testing (not a unit test): the voice-agent asked a clarifying
question instead of just calling either tool, even though every argument is
optional — nothing in the persona rules distinguished harmless informational
lookups from the PROJECT INTAKE RULE's deliberate clarify-first dance for
build/create requests. Added an explicit INFORMATIONAL TOOLS RULE so read-only,
danger:false lookups are called in the same turn instead of asking permission
first; reverified live and both tools now answer directly with real data.

**Gate**: 348 tests, 346 pass, 1 skip, 1 fail (same pre-existing `boot.test.js`
port conflict).

---

## Phase 14 — Voice reliability: noise hallucinations + conversation memory ✅ Done (2026-07-10)

Two user-reported voice bugs, both root-caused live against the real running
instance rather than assumed.

### Background noise producing fabricated words

Ambient noise was getting picked up mid-conversation and turned into words
("hi", "how are you", "thank you"), with MYTHOS replying to them. Two
independent causes:

1. The VAD (`ui/public/js/voice/voice-loop.js`) armed a recording the instant a
   single 100ms tick crossed `SPEECH_RMS` — a door, a click, an AC hum spike
   was enough. Fixed with `SPEECH_HOLD_TICKS` (require 2 consecutive
   above-threshold ticks) and `MIN_PEAK_RMS` (track the loudest moment of the
   clip; if it never got meaningfully louder than ambient noise, drop it
   without ever calling the transcription API). `autoGainControl: true` added
   to the `getUserMedia` constraints alongside the existing echo/noise
   suppression.
2. Whisper hallucinates stock phrases from silence/noise — a well-documented
   failure mode (its training data is full of YouTube-style sign-offs).
   Verified LIVE against the real Groq API, not assumed: a 3-second pure
   digital-silence WAV posted to `/api/voice/transcribe` came back as
   `"Thank you."` with `no_speech_prob: 0` and `avg_logprob: -0.29` — both
   comfortably inside what looked like "confident real speech" range, proving
   Whisper's own documented confidence signals are unreliable here in
   practice. `providers/groq-stt.js` now also blocklists an exact-match
   (post-punctuation-stripped) set of known Whisper silence-hallucination
   phrases (`thank you`, `hi`, `bye`, `subscribe`, etc.) and drops
   punctuation-only transcripts (a bare `"."` came back from the same live
   test) — a real sentence merely *containing* one of these phrases as a
   clause is untouched. `test/groq-stt.test.js` (9 cases) covers both the
   confidence-score path and the exact live-reproduced regression.

### Conversation memory forgetting an in-progress build

User: "build me a landing page for a pet shop" → clarify → restate → "go
ahead" → `start_project` fires, replies "in pipeline." Minutes later: "is it
done? tell me when it's ready" → MYTHOS asks "what kind of website do you want
me to build?" as if starting fresh. Root cause: `server/index.js`'s
per-connection history was wiped to `[]` the instant `start_project` succeeded
(`clearIntake`, added in P11 on the theory that the intake conversation
shouldn't bleed into post-build turns) — which also erased the only record
that a build had ever started. Fixed by removing the wipe entirely (and the
now-dead `clearIntake` flag from `voice-agent.js`) — the existing rolling
12-turn/10-minute-idle window already CA's from NOVA's intake.js and is
exactly the mechanism that should carry "I started building X" forward to a
later "is it done."

Verified live end-to-end via a real multi-turn WS session (not mocked): full
intake → `start_project` → job broadcasts (queued → generating →
writing-artifact → done, real artifact `paws-pamper-friendly-dog-grooming.html`
written under `vault/builds/pipeline/`) → "is it done yet?" correctly answered
"still being generated" mid-build (no re-ask) → later "is it done now?"
correctly answered "It's ready, I'll open it" and attempted `open_artifact`
(itself correctly gated through the leash's confirm flow). This also
positively confirms the `build` lane's provider chain (Mistral first, per
`lanes.default.js`'s `PREF_BUILD`) is wired and actually producing real
generated content, not silently failing over or stalling.

**Gate**: 357 tests, 355 pass, 1 skip, 1 fail (same pre-existing `boot.test.js`
port conflict).

Commits: `abbf96f` (noise/hallucination fix), `1bfb97c` (conversation memory fix).

---

## Phase 15 — Mic-off leak, unreadable confirm popups, artifact tab bug ✅ Done (2026-07-10)

Three more voice/dashboard bugs reported after live use, all root-caused by
reading the actual source directly (two Explore agents did the initial legwork;
every finding was independently reverified against the real files before any
fix, including one grep-rendering artifact that looked like a real syntax bug
and turned out not to be — checked, not assumed).

1. **Mic stayed live after toggling off.** `ui/public/js/voice/voice-loop.js`'s
   `stop()` cleared the VAD timer and the `MediaRecorder`, but never released
   the `getUserMedia` `MediaStream` — `stream`/`audioCtx`/`analyser` were left
   alive forever once acquired, so the browser's own mic-in-use indicator kept
   showing "listening" regardless of what MYTHOS's UI said. `mic-indicator.js`
   already released its own separate level-meter stream correctly
   (`stopLevelMeter()`) — `stop()` was just missing the equivalent line for
   its own stream. Fixed with the same `getTracks().forEach(t => t.stop())`
   pattern.
2. **Confirm popups showed raw JSON.** `voice-agent.js`'s `executeAction()`
   built the summary as `` `Voice: ${tool} (${JSON.stringify(args)})` `` —
   braces and quotes rendered verbatim via `confirm-modal.js`'s `.textContent`.
   `cortex/index.js` built its own (non-voice) confirm summaries the same
   broken way, through the same modal — same bug, same fix. Both now use a
   small `humanizeArgs()` (`key: value, key2: value2`, no braces/quotes).
3. **"See the landing page" opened a new tab of the dashboard, not the
   artifact.** `open_artifact` (`from-dashboard.js`) correctly resolves the
   artifact to `http://localhost:4478/vault/builds/...` and spawns the OS's
   default browser at that URL — verified by reading the function directly,
   that part was never broken. The bug was server-side: `server/index.js`
   only ever served `express.static(ui/public)`; there was no static route for
   `vault/builds` at all, so the request fell through to the SPA catch-all
   (`res.sendFile(index.html)`) — the dashboard. Fixed with
   `app.use('/vault/builds', express.static(memory.fs.vaultPath('builds')))`,
   scoped to exactly the `builds` subdirectory (not the whole vault root,
   which also holds Episodic/Semantic/Identity/Audit/Checkpoints — none of
   which should ever be served as plain static files).

Found by the full-suite run itself: adding the `/vault/builds` static route
required `memory.fs.vaultPath` at server construction time, which
`test/server.test.js`'s intentionally-partial `memory` fixtures didn't
provide — 7 tests failed with `Cannot read properties of undefined (reading
'vaultPath')`. Fixed by adding a `fakeFs()` stub to the fixture (a real
production `memory` always has `.fs` — this was a fixture completeness gap,
not a production bug). A `cortex` confirm-flow test also asserted the exact
old JSON-shaped summary string (`/^kill_session\(/`) — updated to match the
new intentional human-readable format.

Verified live against the real running instance for all three, not just
unit tests: (1) toggled the mic on/off through the real UI click handler with
a synthetic (Web-Audio-generated, no permission prompt needed) `MediaStream`
injected in place of the hardware mic — confirmed the actual
`MediaStreamTrack.readyState` transitions `live → ended` on toggle-off, not
just a UI class change; (2) a real WS utterance through `open_artifact`'s
confirm path came back with `summary: "Voice: open_artifact (path:
/vault/builds/pipeline/paws-pamper-friendly-dog-grooming.html, title: Paws
and Pamper Friendly Dog Grooming)"` — no braces, no quotes; (3) `curl`ing the
real artifact URL now returns the actual generated HTML (`200 text/html`,
correct `<title>`), not the dashboard.

**Gate**: 357 tests, 355 pass, 1 skip, 1 fail (same pre-existing
`boot.test.js` port conflict).

---

## Phase 16 — Live Camera + Hand-Gesture Control, Vision Q&A, Streamed Speech Replies ✅ Done (2026-07-11)

Handoff-grade spec, built in dependency order: B0 (vision-lane probe, blocking)
→ C (chunked TTS) → A (camera + gestures) → B (vision Q&A) → this entry.

**B0 — vision-lane sanity check.** `PREF_VISION`'s first entry
(`mistral-large-2512`) had never actually been exercised by any caller
(`grep -r "lane:.*vision"` under `src/`/`server/` was empty before this
phase). Live-probed it with a real image through `brain.think({lane:
'vision', ...})` before writing any feature code, per the spec's blocking
requirement — **it answered correctly** (detailed, accurate description of a
real screenshot, 461 tokens spent, `provider: mistral, model:
mistral-large-2512`). No fix needed to `lanes.default.js`; a prior session
(P2 wiring commit `ac4d7f5`) had already verified this same lane live and
left a comment to that effect, which this probe re-confirmed still holds.

**Part C — sentence-chunked streamed TTS.** Replies now stream N
`speech-chunk` WS messages (one per sentence, synthesized serially by
edge-tts) followed by a metadata-only `done`, instead of one blob
synthesized after the full reply completes. `splitSentences()`
(`src/core/effectors/voice.js`, 6 new unit tests) groups short fragments
with their successor so no chunk is a 2-word synthesis-overhead-dominated
blob. `server/index.js`'s `synthesizeReply` → `sendSpokenReply`, shared by
`handleUtterance` and the new `handleVisionQuery`. `ws.js` gains
`makeReplyHandler()` so `speech-chunk` messages route to `onChunk` without
deleting the `reqId` handler (only `done` does). `voice-loop.js` gains a
chunk playback queue (`beginTurn`/`enqueueChunk`/`playNextChunk`/
`maybeFinishTurn`) — the session token is reserved at dispatch time, before
any chunk can arrive, so barge-in still works mid-queue (talking over chunk
1 of 3 stops playback and drops the rest). Verified E2E against a real
running instance (separate port, user's live 4478 instance never touched):
a 2-sentence reply produced 2 `speech-chunk` messages with real audio before
`done`, first-chunk-to-done gap 1336ms (second sentence still synthesizing
while the first played).

**Deferred at the time**: sentence-splitting here operates on the *full*
completion string returned by `brain.think()` — the LLM call itself was not
streamed, so no chunk (not even chunk 0) could start synthesizing until the
entire reply had finished generating. Token-level LLM streaming (detecting
sentence boundaries as tokens arrive so TTS on sentence 1 can start while the
model is still generating sentence 2+) was explicitly out of scope for this
phase. **Update — P20 (2026-07-11)**: closed for the one call site where it's
actually safe to do (`handleVisionQuery`); the tool-calling voice-agent path
(`handleUtterance`) stays full-buffer by design — see
[Phase 20](#phase-20--token-level-llm-streaming-to-first-speech-chunk-✅-done-partial-scope-2026-07-11)
for why.

**Part A — camera + hand-gesture recognition.** `@mediapipe/tasks-vision`
`GestureRecognizer` (Google's official WASM successor to the
`kinivi/hand-gesture-recognition-mediapipe` project the user pointed at —
that one is Python/OpenCV/TensorFlow-only, no JS port, would fight the
browser for the webcam) — fully client-side, no Python, no GPU, no server
round-trip for detection. The 8MB pretrained model
(`gesture_recognizer.task`) is committed to `ui/public/models/` (not shipped
in the npm package) so the app stays fully self-hosted, no CDN at runtime.
`server/index.js` mounts `/vendor/mediapipe` → `node_modules/@mediapipe/
tasks-vision` (confirmed actual layout after install: `vision_bundle.mjs` +
`wasm/`, exactly as expected, no import-path adjustment needed). New
`ui/public/js/vision/camera.js` mirrors `voice-loop.js`'s factory shape and
honest-degrade philosophy — camera OFF by default, same privacy posture as
the mic, releases the actual hardware stream on `stop()` (same lesson as
P15's mic-leak fix). Gesture → action bindings live in `app.js`: **Thumb_Up**
clicks `.confirm-accept`, **Closed_Fist** clicks `.confirm-reject`,
**Open_Palm** stops the voice loop, **Victory** captures a frame and asks
"describe what you see" — all four reuse the *live* confirm-modal buttons or
voice-loop API, zero new approval surface, zero leash bypass. New
`#camera-indicator` HUD ring (`cam-idle|watching|disabled|error|unsupported`)
clones the mic ring's look with a distinct accent color so the two never
read as the same state.

**Part B — vision Q&A ("what do you see").** `ws.js`'s `visionQuery()` and
`server/index.js`'s `handleVisionQuery` share the exact same chunked-reply
path as voice utterances (read-only, no tool dispatch, no leash tier —
same class as a plain chat reply). `voice-loop.js` intercepts a
`VISION_TRIGGER` regex ("what do you see", "describe this", "look at me",
etc.) before falling through to the brain, same pattern as `NAV_COMMANDS`.
**Deviation from the handoff spec, noted here per house convention**: the
spec's `app.js` snippet aliased `deliverExternalReply: deliverReply` as a
one-line passthrough with no session handling, but that would have left
`speech-chunk` messages for a vision reply with nowhere to enqueue (chunks
arrive *before* `done`, and the spec's own C4 section says the session must
be reserved "at dispatch time" for exactly this reason — it just didn't
carry that requirement through to the vision wiring). Fixed by exposing
`beginTurn()`/`onExternalChunk()` alongside `deliverExternalReply()` so
`app.js`'s `describeScene()` reserves a session before calling `visionQuery()`
and routes its `onChunk`/`onDone` through the same queue voice utterances
use — without this, vision replies would have played zero audio.

Verified live end-to-end against a real running instance (separate port):
a raw WS `vision-query` against a real screenshot produced 3 real
`speech-chunk`s + a correct scene description; the same request driven
through the actual browser's `ws.js` module (not a Node script) against a
tiny synthetic JPEG produced 2 chunks + a correct "plain white background"
description, confirming the full client wiring (not just the server side).
Camera/gesture testing is honestly limited by this environment: no real
webcam hardware is available in the sandbox used to build this phase, so
`getUserMedia` is denied by the browser chrome itself — verified that this
denial is handled honestly (state → `disabled`, caption shown, no hang, no
silent failure) rather than verifying real gesture accuracy on physical
hardware. **Gesture accuracy/reliability on the user's actual camera and
lighting is unverified and should be treated as unknown until tried live.**

**Gate**: 363 tests, 361 pass, 1 skip, 1 fail (same pre-existing
`boot.test.js` port conflict — this run, the specific cause was the user's
own live instance holding port 4478, which was deliberately left running
and untouched throughout this phase; all verification used separate ports).

---

## Phase 17 — Gap-Closing: Risk Register R2/R3/R4/R8/R9 + D-23/D-57 ✅ Done (2026-07-11)

The Risk Register (below) and Known Deviations backlog had accumulated five
explicitly-flagged untested gaps (R2, R3, R4, R8, R9) and two open bugs (D-23, D-57)
across P1/P6/P8/P10. This phase closed all seven, reading each module's actual
current source first rather than trusting the ROADMAP prose (two items — R4's
"no drill touches identity/boundaries.md" and D-56 — turned out to already have
partial coverage from P8, confirmed via `git log --follow`; the rest were verified
genuinely open before any test or fix was written).

**Five new regression/contract tests** (test-files-only, no source changes):
- `test/memory-growth-regression.test.js` (R2) — episodic (90+ simulated days,
  two consolidate cycles, backdated file mtimes) and semantic (60 topics, mixed
  confidence, two cycles) growth-at-scale, proving the active window stays bounded,
  archives are real/gzip-decompressible, and repeated cycles are idempotent —
  the exact "growth", not single-file, scenario the Risk Register flagged as untested.
- `test/chaos-dry-run-tier-gating-outage.test.js` (R3) — a genuine P10-style chaos
  drill: two real HTTP servers killed mid-request (both Brain providers dead), a
  real Leash+Identity+AuditWriter stack, and a composed real `cortex.tickOnce()`
  proving MYTHOS_DRY_RUN and tier-gating are fully decoupled from Brain health —
  tier-0 still auto-allows, DRY_RUN still logs-and-no-ops T>=1, T3/T4 still demand
  confirm, all while every provider is genuinely unreachable.
- `test/identity-boundaries-failsafe-contract.test.js` (R4) — the one path P8's
  existing `identity-boundaries-contract.test.js`/`identity-leash-integration.test.js`
  didn't cover: a malformed/missing `max_autonomous_tier` must fail safe to 1 *and*
  that fail-safe must cascade through a real Leash tier check (not just identity's
  own isolated getter), while never attempting to write `boundaries.md`.
- `test/integration-cortex-real-effector-failure.test.js` (R9) — drives
  `effectors/from-system.js`'s real, shipped `get_weather` effector (real
  `effectorFromTool` adapter, real network call forced to fail) through a real
  cortex tick, proving the real breaker trips and the failure is recorded honestly —
  every prior cortex/effector test used a minimal stub effector to isolate the seam.
- `test/event-name-conformance.test.js` (R8) — statically greps every
  `bus.emit()`/`*Emit()` string-literal event name under `src/` and `server/`
  against a maintained allowlist; asserts the three historically-fixed drift bugs
  (D-28/D-36/D-37) can never silently reappear.

**Two real source fixes**, each with its own dedicated regression test:
- **D-23** (`src/core/memory/working.js`, `src/core/memory/index.js`) — confirmed
  still open: `working.init()` unconditionally called `rebuildFromEpisodic()`,
  never consulting `checkpoints.load()`, even though `immune/monitor.js`'s own
  `recoverFromCrash()` comment already (incorrectly) claimed this behavior existed.
  Fixed: `createWorkingMemory()` now takes an optional `checkpoints` dependency;
  `init()` restores `{tick, activeGoalId}` directly from a checkpoint when one
  exists, only falling back to the episodic-tail scan when it doesn't.
  `memory/index.js` wires `checkpoints` through. Backward compatible — the two
  existing call sites that don't pass `checkpoints` (`test/chaos-memory-corrupt.test.js`,
  `test/memory.test.js`) keep their prior unconditional-fallback behavior.
  Regression: `test/d23-working-memory-checkpoint-regression.test.js`.
- **D-57** (`src/main.js`, `src/core/immune/monitor.js`) — confirmed still open:
  the `'recovery'` boot step ran before `'leash'` (which constructs `buildRunner`),
  making the recoveredJobs→goal composition Drill 6 proves at the module level
  structurally impossible in the real boot sequence, exactly as documented.
  Fixed the structural half: swapped `'recovery'` to run after `'leash'` (nothing
  in either step depends on the other's *output*, only on construction order), and
  `recoverFromCrash()` now takes an optional `buildRunner`, awaits its `init()`,
  and folds `recoveredJobs.length` into both its return value and the
  `lifecycle.recovered` event payload for real observability. **Not fixed** (and
  said so rather than manufacturing scope): there is no persisted job↔goal mapping
  anywhere in shipped production code — `effectors/agent-actions.js`'s
  `buildRunner.enqueue()` calls carry no `goalId`, and `Pipeline/job-goal-map.json`
  is purely `test/chaos-restart-mid-action.test.js`'s own fixture, invented to prove
  the composition at the module level. Implementing a real job→goal linkage
  mechanism (touching `agent-actions.js`/`effectors/goals.js`) is separate, larger
  feature work, not a gap-closing fix — left as an explicit backlog item, not
  silently left half-done. Regression: `test/d57-recovery-boot-order-regression.test.js`.

**Verification**: full suite run before any change: 363 tests, 361 pass / 1 skip /
1 fail (baseline). After: 386 tests (23 new), 384 pass / 1 skip / 1 fail — the one
failure is the same pre-existing `test/boot.test.js` `EADDRINUSE :4478` (the user's
own live instance was running throughout, exactly as expected per house convention;
no live instance was booted by this phase itself, so there was nothing to kill on
exit). Zero regressions.

---

## Phase 18 — Gap-Closing: D-57 job↔goal mapping (the piece P17 left open) ✅ Done (2026-07-11)

P17 fixed D-57's boot-order bug (leash/buildRunner now constructed before recovery
runs) but explicitly declined to invent the other half: "there is no persisted
job↔goal mapping anywhere in shipped production code — `agent-actions.js`'s
`buildRunner.enqueue()` calls carry no `goalId`." This phase closes exactly that,
and nothing more.

Reading the real call graph first (not the ROADMAP prose) turned up something
P17's note didn't spell out: `working.activeGoalId` — the GoalSystem goal cortex's
arbiter picked this tick — was *already* being threaded into every
`effectors.invoke(tool, args, { signal, bus, goalId: working.activeGoalId })` call,
both from `cortex/index.js:174` and from `server/index.js:320`'s voice-dispatch
path. The `goalId` context existed at the door; it just stopped there — none of the
tool functions (`from-project.js`'s `start_project`, `from-dashboard.js`'s
`pipeline_execute`/`kanban_assemble`/`kanban_build_card`, `from-mission.js`'s
`run_mission`) read their second `ctx` argument (`adapter.js`'s
`effectorFromTool().invoke()` already calls `tool.fn(params, ctx)` — that plumbing
was also already there, just unused by these five functions), and
`agent-actions.js`'s three functions and `orchestrator.js`'s `runMission()` had no
parameter to receive it even if it had been passed. So the actual gap was narrower
than "no mechanism exists anywhere" — the mechanism existed one hop away; it was an
unwired last mile, not a missing architecture.

**Fix, end to end**:
- `effectors/build-runner.js` — `enqueue({kind, prompt, run, goalId})` now carries
  `goalId` onto the job record, defaulting to an honest `null` (never a fabricated
  id) when omitted. `loadPersisted()`'s `recoveredJobs` array now includes each
  recovered job's `goalId` too.
- `effectors/agent-actions.js` — `executePipelineCard(cardId, goalId)`,
  `assembleKanbanPlan(goal, goalId)`, `buildKanbanCard(cardId, goalId)` all take an
  optional `goalId` and forward it to `enqueue()`. Backward compatible: every
  existing caller that omits the new argument keeps working exactly as before.
- `effectors/orchestrator.js` — `runMission(goal, goalId)` stores `m.goalId` (a
  mission delegated by a real GoalSystem goal is distinct from a dashboard/voice
  mission with no goal behind it) and threads it into both the planning
  `assembleKanbanPlan()` call and every per-card `buildKanbanCard()` call the
  mission spawns. `publicView()` now surfaces `goalId` too.
- `effectors/from-project.js`, `from-dashboard.js`, `from-mission.js` — the five
  real tool functions now accept the `ctx` (renamed `runCtx` at each call site to
  avoid shadowing the pre-existing `ctx` closure that holds `{pipeline, kanban,
  agentActions, ...}`) that `adapter.js` was already passing, and read
  `runCtx.goalId` through to the `agent-actions`/`orchestrator` calls above.
- `immune/monitor.js`'s `recoverFromCrash()` — now builds `recoveredJobGoalMap`
  (`[{jobId, goalId}]`) from the real (no longer invented) `goalId` on each
  recovered job, and surfaces it in both its return value and the
  `lifecycle.recovered` event payload, alongside the pre-existing `recoveredJobs`
  count.

**Scoped judgment call, stated honestly rather than overbuilt**: this closes the
*mapping* gap — a crash-recovered job can now be traced back to the goal that
spawned it, in both the recovery return value and the audited
`lifecycle.recovered` event. It does **not** implement automatic job resumption
(re-enqueuing/re-running the same build under the same goal post-crash) — that
needs idempotency and a re-entry-point concept this phase doesn't have a mandate
to invent. The existing, unconditional active-at-crash goal pause (shipped since
P6) already covers the goal side; `recoveredJobGoalMap` makes the job side of that
picture visible for the first time, which is what P17 asked for.

**Tests**: `test/p18-goal-job-mapping.test.js` (4 new, real-instance — real
`fs-store`, real `build-runner`, real `pipeline`/`kanban` effectors, real
`agent-actions`, real `recoverFromCrash()`, no stubs on the module under test):
`enqueue()` carries `goalId` (and an honest `null` when absent); all three
`agent-actions` functions thread a real `goalId` through to the real job record;
a job enqueued for a goal, persisted mid-run, and restarted surfaces a real
`recoveredJobGoalMap` entry through `recoverFromCrash()` in both the return value
and the `lifecycle.recovered` event; a goal-less recovered job maps to `null`, not
a fabricated goal.

**Verification**: full suite before any change: 386 tests, 384 pass / 1 skip /
1 fail (baseline, same pre-existing `test/boot.test.js` `EADDRINUSE :4478` — the
user's own live instance). After: 390 tests (4 new), 388 pass / 1 skip / 1 fail —
same one pre-existing failure, zero regressions. No live instance was booted by
this phase.

---

## Phase 19 — Gap-Closing: crash-recovered goals auto-resume ✅ Done (2026-07-11)

P18 closed the job↔goal *mapping* gap and explicitly declined to invent automatic
job resumption: "It does not implement automatic job resumption... that needs
idempotency and a re-entry-point concept this phase doesn't have a mandate to
invent." This phase is that exact backlog item, taken up honestly rather than
forced into the shape the backlog note implied.

**Reading the real code first changed the shape of the fix.** The backlog note
assumed "resume" meant re-enqueuing/re-running the specific crashed job — which
would require serializing and replaying its `run` closure (a live JS function,
never persisted) and would collide head-on with the architecture doc's own stated
**Crash Invariant #2**: *"No fake resume — running jobs marked failed on restart,
goals paused."* Re-running the literal interrupted job is exactly the "fake
resume" that invariant forbids, and it isn't actually needed: reading
`goals/index.js`'s `plan()` shows `goal.plan` (a hypothetical persisted step
queue) is never populated anywhere in shipped code — every planning call derives
the goal's *next* action fresh from `goal.title` + current state via a live Brain
call. Planning was already stateless per call. The one real gap was
`getActiveGoals()` (line 112-114) filtering strictly on `status === 'active'`: a
goal crash-paused with `reason: 'crash-recovery'` (shipped since P6) is
permanently invisible to arbitration forever after — nothing in shipped code ever
flips it back to `'active'`. That is the actual, narrower bug: not "no resume
mechanism," but "the resume mechanism (re-arbitration) exists and works, but
nothing ever un-pauses the goal to reach it."

**Fix**: `immune/monitor.js`'s `recoverFromCrash()` — after its existing,
unchanged step 2 (pause every active-at-crash goal, `reason: 'crash-recovery'`),
a new step 2b reactivates (`status: 'active'`, `reason: 'crash-recovery-resumed'`)
exactly the goals that appear in `recoveredJobGoalMap` (P18) with a non-null
`goalId` — i.e. a goal whose own in-flight build job was the thing that actually
got interrupted. A goal that was active-at-crash but owned no recovered job (e.g.
idle/thinking, or a goal some other actor already paused for an unrelated reason)
stays paused, unchanged from P6/P17/P18. `resumedGoals` (a count) is added
alongside the pre-existing `pausedGoals`/`recoveredJobs` in both the return value
and the `lifecycle.recovered` event payload.

**Double-execution safety (the hard requirement) — the actual mechanism, not just
an assertion**: `recoverFromCrash()` makes zero `enqueue()`/`effectors.invoke()`
calls itself; reactivating a goal only makes it eligible for arbitration again, it
does not perform any action. Whatever concrete tool call a reactivated goal's
planner decides on next still passes through the pre-existing, untouched in-flight
guards in `agent-actions.js` — `executePipelineCard`/`buildKanbanCard` throw `'a
build is already in progress for this card'` whenever the card's last known job is
still `'queued'`/`'running'`. A crashed job is `'failed'` (build-runner's own
restart logic, unchanged), never `'running'`, so a genuine retry is permitted
through that guard exactly as any other legitimate retry would be; a job that is
still genuinely healthy and in-flight elsewhere is still refused. This is proven
by a real-instance test (`p19-goal-auto-resume.test.js`'s third case) that calls
`recoverFromCrash()` while a job is still actually `'running'` in-process (no
restart occurred) and asserts both that `buildRunner`'s job count is unchanged by
recovery and that a genuine duplicate `buildKanbanCard()` call on the same
in-flight card is still refused.

**Scoped judgment call, stated honestly**: this closes the auto-resume gap at the
*goal* level — a goal that was making real progress before the crash keeps making
progress after the restart, without a human having to manually flip its status
back to `'active'`. It deliberately does not attempt to resume the *specific*
crashed job's exact in-flight state (recreate its `run` closure, replay its
prompt) — Crash Invariant #2 says that job stays honestly `'failed'`, and nothing
in the shipped planning model needs it replayed verbatim: the goal's next planned
action, derived fresh, is what carries the goal forward, same as it always has.
If a future phase wants finer-grained mid-job checkpointing (e.g. resuming a
multi-file build from file 3 of 5 rather than restarting the deliverable from
scratch), that is a materially larger, distinct feature — persisted step-level
progress does not exist anywhere in the current build-runner/agent-actions model
to resume from.

**Tests**: `test/p19-goal-auto-resume.test.js` (3 new, real-instance — real
`fs-store`, real `build-runner`, real `kanban`/`pipeline` effectors, real
`agent-actions`, real `recoverFromCrash()`, no stubs on the module under test): a
goal with a genuinely in-flight job at crash time is reactivated on the next boot
(not left paused forever); a goal that was active-at-crash but owned no recovered
job stays paused (regression guard); auto-resume cannot double-execute (recovery
itself enqueues nothing, and the existing in-flight guard still refuses a genuine
concurrent duplicate).

**Verification**: full suite before any change: 390 tests, 388 pass / 1 skip / 1
fail (baseline, same pre-existing `test/boot.test.js` `EADDRINUSE :4478` — the
user's own live instance, not touched). After: 393 tests (3 new), 391 pass / 1
skip / 1 fail — same one pre-existing failure, zero regressions. No live instance
was booted by this phase.

---

## Phase 20 — Token-Level LLM Streaming to First Speech-Chunk ✅ Done (partial scope) (2026-07-11)

P16 Part C chunked TTS by sentence-splitting the LLM's *full* completion
string after `brain.think()` resolved — real latency win over one giant
blob, but chunk 0 still couldn't start synthesizing until the entire reply
had finished generating. This phase is that deferred item: plumb token-level
streaming from the LLM through to wherever it can legitimately start
producing speech-chunks sooner.

**Finding #1 — the providers already stream, end to end.** Read every
provider in the voice/build/simple/vision hot lanes
(`lanes.default.js`: groq, mistral, cerebras, nim/nim2, zcode, openrouter,
ollama). All eight already call their vendor endpoint with `stream: true`,
already parse SSE (`data:` lines) or NDJSON (ollama) incrementally, and
`providers/openai-compat.js` (the factory behind groq/mistral/cerebras/nim/
nim2/zcode) plus `openrouter.js` and `ollama.js` already accept and fire an
`onToken(delta)` callback per token — this was CA'd from NOVA and has sat
unused since Phase 2. `grep -r "onToken" src/core/brain/` was genuinely
empty before this phase, confirming the P16 non-goal note: the gap was never
"can the providers stream", it was "nothing above the provider layer ever
asked them to."

**Fix — thread `onToken` two hops up.** `chain.js`'s `complete({...,
onToken})` now forwards it verbatim to whichever provider actually answers
(`LANES[lane].chat(messages, {model, signal, source, onToken})` / the
`ollama.chat(...)` call) — a provider that fails mid-stream still falls
through to the next attempt exactly as before, `onToken` just stops firing
for that attempt. `brain/index.js`'s `think({..., onToken})` forwards it
straight into `chain.complete()`. Zero behavior change for every existing
caller that doesn't pass `onToken` — pure additive plumbing.

**Finding #2 — the tool-calling voice-agent path cannot safely consume it,
and this is a real constraint, not a missing feature.** `voice-agent.js`'s
`handleUtterance()` forces the model into ONE JSON object per call
(`{"say","actions","needs_result"}` — `OUTPUT_CONTRACT`) and then may loop:
a `needs_result` iteration re-prompts with tool results and overwrites
`finalSay`, and a single failed-action turn gets a corrective re-prompt that
overwrites it again. There is no point during that loop where "the content
generated so far is provably the final spoken reply" — iteration 1's `say`
is frequently a placeholder ("let me check...") superseded by iteration 2,
or is later contradicted by the corrective pass. Starting TTS on a
provisional `say` risks the user hearing a reply that gets silently replaced
moments later — worse than the status quo, not better. This is not a
provider-capability limit (every provider here streams fine); it's the
calling convention (structured JSON + multi-iteration loop) that makes
early truncation unsafe. **`handleUtterance` stays full-buffer, unchanged,
by deliberate scope boundary** — documented in `server/index.js` at the
`handleVisionQuery` comment block rather than silently left unexplained.

**Fix applied where it's actually safe — `handleVisionQuery`.** This path
(`server/index.js`) calls `brain.think({lane:'vision', ...})` directly with
no schema hint and no tool-calling loop — one plain-prose completion, always
final. `src/core/effectors/voice.js` gains `createSentenceStreamer()` (7 new
unit tests, `test/sentence-streamer.test.js`): the incremental counterpart
to the existing `splitSentences()` — feed raw text deltas as they arrive and
get back only sentences that are *provably* complete (regex requires
terminal punctuation, same `MIN_CHUNK_CHARS` grouping as the batch version,
so streaming never emits a 2-word chunk either); any dangling unpunctuated
tail waits for `flush()` at end-of-stream. `handleVisionQuery` now passes
`onToken` into `brain.think()`, feeds every delta into the streamer, and for
each sentence that completes mid-generation, sanitizes + synthesizes +
sends its own `speech-chunk` immediately — ordering preserved by a small
serialized promise chain so a slow synth for chunk 0 can't let chunk 1 send
first. Zero protocol change: still N `speech-chunk` messages then a
metadata-only `done`, so `ws.js`/`voice-loop.js` (P16) needed no client
changes. `total` is sent as `null` per streamed chunk (unknowable until the
stream ends) — verified safe because `voice-loop.js`'s `maybeFinishTurn()`
already falls back to "chunk queue drained" rather than relying solely on
`index===total-1` (that fallback was already there to cover `done` arriving
before all chunks finish playing).

**Live verification** (separate port 4491, user's live 4478 instance never
touched): a raw WS `vision-query` against a real running instance with a
real Mistral vision completion produced 2 `speech-chunk`s with real
edge-tts audio before `done` — first-chunk latency 1519ms, `done` (full
reply resolved) at 2536ms. Since chunk 0 now starts synthesizing the moment
sentence 1's tokens are provably complete rather than waiting for the whole
reply, first-audio latency drops by roughly the generation time of
sentence 2+ (here, ~1000ms) compared to the pre-P20 chunked-but-not-streamed
behavior, where chunk 0 couldn't begin synthesis until `content` (all of it)
was already in hand.

**Scope boundary, stated honestly**: this phase closes token-level streaming
for exactly one call site — the one where the response shape (plain prose,
one completion, no tool loop) makes it provably safe. The tool-calling voice
path, which carries the large majority of real voice turns, is intentionally
left full-buffer; doing otherwise would mean speculatively speaking content
that a later loop iteration might overwrite, which is a correctness
regression dressed up as a latency win. The provider→chain→brain `onToken`
plumbing itself is now generic and available to any future caller (e.g. a
future non-JSON single-shot lane) without further wiring.

**Tests**: `test/sentence-streamer.test.js` (7 new — nothing emitted until
terminal punctuation, no re-emission across pushes, short-fragment grouping
matches `splitSentences()`, `flush()` returns the dangling tail or `null`,
char-by-char streaming reconstructs the same output as the batch function
on identical input). `test/brain.test.js` gains 2 new regressions
(`chain.complete()` forwards `onToken` to the resolved provider without
hitting the network via a stubbed `zcode.chat`; `brain.think()` forwards
`onToken` through to `chain.complete()`).

**Verification**: full suite before any change: 393 tests, 391 pass / 1 skip
/ 1 fail (baseline, same pre-existing `test/boot.test.js` `EADDRINUSE :4478`
— the user's own live instance, not touched). After: 402 tests (9 new),
400 pass / 1 skip / 1 fail — same one pre-existing failure, zero
regressions. Live-verification instance (port 4491) was booted for the
`handleVisionQuery` E2E check above and killed before this phase finished
(`taskkill /F /PID <pid>`, port confirmed free by `netstat`); its scratch
vault directory was also removed.

---

## Risk Register

| ID | Risk | Mitigation | Phase |
|----|------|------------|-------|
| R1 | Idle-loop Brain cost | Idle-skip (P3) + spend events/cap (P2) | ✅ P2, P3 — not a failure-injection concern by nature, no P10 drill needed |
| R2 | Memory growth | Decay + archive (P1), consolidate cadence | ✅ P1 (D-17/D-18 archive-not-delete fixed at Phase 4.5); ✅ **P17** — `test/memory-growth-regression.test.js` exercises `consolidate()`/decay-to-archive under real multi-cycle growth at scale (90+ simulated episodic days, 60 semantic topics), not just the single-file edge case |
| R3 | Autonomy safety | Audit + spend cap + MYTHOS_DRY_RUN + tier gates | ✅ P5; ✅ **P17** — `test/chaos-dry-run-tier-gating-outage.test.js` is a real P10-style chaos drill proving `MYTHOS_DRY_RUN` and leash tier-gating stay correct (never fail-open, audit trail intact) under a genuine simultaneous Brain-provider outage |
| R4 | Identity drift | Human-editable boundaries as tier ceiling | ✅ P8; ✅ **P17** — `test/identity-boundaries-failsafe-contract.test.js` adds the one path P8's existing contract tests didn't cover: a malformed `boundaries.md` fail-safe (tier→1) proven to cascade through a real Leash check, not just identity's own isolated getter |
| R5 | SPOF | Checkpoint every N ticks + restore (P6/P1) + drill (P10) | ✅ **well covered** by P10 (Drill 4 checkpoint-restore-after-corruption + Drill 6 restart-mid-action). D-23 (WorkingMemory's `rebuildFromEpisodic()` never consulted `checkpoints.load()`/`isCrashRecovery`) — ✅ **fixed in P17**: `working.js`'s `init()` now restores from a checkpoint when one exists, only falling back to the episodic tail otherwise; regression in `test/d23-working-memory-checkpoint-regression.test.js` |
| R6 | Port conflict | MYTHOS_PORT 4478 (NOVA stays 4477) + separate vault root | ✅ P0 |
| R7 | Stale copy | Git clone verified @ `a0433b5`, future `git pull` | ✅ Step 0 |
| R8 | Event-name drift silently breaks future-phase wiring | Every bus event name must be copy-pasted verbatim from the spec, not paraphrased — add a lint/test that greps emitted event-name string literals against a spec-derived allowlist | ✅ **P17** — `test/event-name-conformance.test.js` statically greps every `bus.emit()`/`*Emit()` literal under `src/`+`server/` against a maintained allowlist and asserts the three historical drift bugs (D-28/D-36/D-37) can never silently reappear |
| R9 | Cross-module contract breaks invisible to per-module unit tests | Add integration tests that exercise real module-to-module handoffs (Cortex→Goals, Cortex→Effectors) with real (non-fake) instances wired together, not just fake-bus unit tests per module | ✅ **well covered** for the two seams P10 targets — Drill 5 (Cortex↔Goals, the D-38 seam) + Drill 6 (build-runner↔goals↔audit, module level only — see D-57). ✅ **P17** closes the remaining seam — `test/integration-cortex-real-effector-failure.test.js` drives a real, shipped production effector (`from-system.js`'s `get_weather`, real adapter, real forced network failure) through a real cortex tick, not a stub effector |

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
| `27d8842` | P10 | Chaos Drills: 6 failure-injection test files (provider-killed, cortex-stalled, disk-full, memory-corrupt, concurrent-tick, restart-mid-action) against real P1/P2/P3/P4/P6/P7 modules; found and documented 2 new gaps (D-56 CRITICAL brain/index.js lane-selection bug, D-57 MAJOR main.js recovery/build-runner boot-order gap), neither fixed here (test-files-only phase) (327 tests, 325 passing, 1 pre-existing env-blocked) |
| `e281f32` | P11 | Voice Agent v2 (barge-in, TTS sanitization, conversation memory, real tool-calling — CA of NOVA voice-agent.js) + semantic memory (local embeddings/RAG, no vector DB) + mission orchestrator (brain delegates multi-part goals to a background agent team, no LangGraph) + a real createVoiceAgent()-fail-fast/socket-leak hang found and fixed by the suite run itself (341 tests, 339 passing, 1 pre-existing env-blocked) |
| `3914163` | P12 | Voice input replaced with server-side Groq Whisper transcription (`providers/groq-stt.js` + `/api/voice/transcribe` + `voice-loop.js` MediaRecorder/VAD) after live-confirming Chrome's SpeechRecognition (cloud AND on-device) is blocked at the network level on this machine; found and fixed a stop()-vs-in-flight-transcription race live-testing against the real instance (341 tests, 339 passing, 1 pre-existing env-blocked) |
| `abb223b` | P13 | get_time + get_weather tools (`from-system.js`, Open-Meteo, no API key) + a persona-rule gap found live-testing (voice-agent asked permission before calling harmless read-only lookups) (348 tests, 346 passing, 1 pre-existing env-blocked) |
| `abbf96f` | P14 | Background-noise voice hallucinations fixed: VAD hold-ticks + peak-RMS energy gate (`voice-loop.js`) + Groq Whisper stock-phrase/punctuation-only filter (`groq-stt.js`), live-reproduced against the real Groq API (pure silence -> "Thank you." at no_speech_prob 0) (357 tests, 355 passing, 1 pre-existing env-blocked) |
| `1bfb97c` | P14 | Conversation-memory fix: removed the clearIntake history wipe that erased all record of an in-progress build, breaking "is it done?" follow-ups; live-verified full intake -> build -> completion -> status-check cycle end to end, also confirming the `build` lane's Mistral-first provider chain actually works (357 tests, 355 passing, 1 pre-existing env-blocked) |
| `5d2dced` | P15 | Mic-off stream leak (`voice-loop.js` never released the getUserMedia MediaStream) + unreadable JSON confirm popups (`voice-agent.js` + `cortex/index.js` humanizeArgs) + artifact tabs opening the dashboard (missing `/vault/builds` static route) — all three live-verified against the real running instance, plus a `server.test.js` fixture gap (missing `memory.fs`) found and fixed by the suite run itself (357 tests, 355 passing, 1 pre-existing env-blocked) |
| `a8e439c` | P16 | Chunked streamed TTS: sentence-chunked speech-chunk WS messages before a metadata-only done, so first audio plays while later sentences still synthesize (`splitSentences`, `sendSpokenReply`, `voice-loop.js` chunk queue) — also carries this phase's B0 vision-lane probe result (mistral-large-2512 confirmed live) and the server-side vision-query handler; live-verified 2 chunks + real audio, first-chunk-to-done gap 1336ms (363 tests, 361 passing, 1 pre-existing env-blocked) |
| `dccb1a3` | P16 | Live camera + hand-gesture control (`@mediapipe/tasks-vision` GestureRecognizer, client-side WASM) + vision Q&A client wiring — Thumb_Up/Closed_Fist/Open_Palm/Victory gestures reuse the live confirm-modal buttons and voice-loop API (zero new approval surface); live-verified static asset serving, honest permission-denied degrade, and a real vision reply round-tripping through the browser's own ws.js (363 tests, 361 passing, 1 pre-existing env-blocked) |
| `TBD` | P17 | Gap-closing: closed Risk Register R2/R3/R4/R8/R9 with 5 new regression/chaos-drill/contract tests (`memory-growth-regression`, `chaos-dry-run-tier-gating-outage`, `identity-boundaries-failsafe-contract`, `integration-cortex-real-effector-failure`, `event-name-conformance`) + fixed 2 confirmed-still-open bugs (D-23 WorkingMemory now consults `checkpoints.load()` before falling back to the episodic tail; D-57 `main.js` boot order fixed so `buildRunner` exists before `recovery` runs, `recoverFromCrash()` now surfaces `recoveredJobs`) with their own regression tests; job↔goal linkage (D-57's other half) confirmed to not exist anywhere in production code and left as an explicit, separate backlog item rather than manufactured in scope (386 tests, 384 passing, 1 pre-existing env-blocked) |
| `TBD` | P18 | Gap-closing: D-57's job↔goal mapping, the piece P17 left open — `build-runner.js`'s `enqueue()` now carries an honest `goalId` (null when goal-less) onto every job record, `agent-actions.js`'s three job-creating functions and `orchestrator.js`'s `runMission()` take it as an optional param, and every real call site (`from-project.js`, `from-dashboard.js`, `from-mission.js`) threads the `ctx.goalId` cortex/server already pass into `effectors.invoke()` — a plumbing gap one hop past where the wiring already existed, not a missing architecture; `monitor.js`'s `recoverFromCrash()` now surfaces a real `recoveredJobGoalMap` in both its return value and `lifecycle.recovered`, closing the reattachment gap without inventing automatic job resumption (390 tests, 388 passing, 1 pre-existing env-blocked) |
| `TBD` | P19 | Gap-closing: D-57's last piece, automatic resumption of crash-recovered goals — `monitor.js`'s `recoverFromCrash()` now reactivates (`status:'active'`) exactly the goals present in P18's `recoveredJobGoalMap`, since `goals/index.js`'s arbiter only ever considers `status==='active'` goals and nothing previously un-paused a `'crash-recovery'`-paused one; a goal with no recovered job stays paused, unchanged. Respects Crash Invariant #2 ("no fake resume") — the crashed job itself stays honestly `'failed'`, recovery issues no `enqueue()`/`effectors.invoke()` call of its own, and the pre-existing `agent-actions.js` in-flight guards still gate whatever the reactivated goal's planner decides on next, proven by a real-instance test with a job still genuinely running (393 tests, 391 passing, 1 pre-existing env-blocked) |
| `TBD` | P20 | Token-level LLM streaming to first speech-chunk, the P16-deferred item — every hot-lane provider already spoke SSE/NDJSON streaming with an unused `onToken` hook (CA'd from NOVA, never wired above the provider layer); `onToken` now threads through `chain.complete()` → `brain.think()`. `src/core/effectors/voice.js` gains `createSentenceStreamer()`, the incremental counterpart to `splitSentences()`. Wired into `handleVisionQuery` only (`server/index.js`) — plain single-completion prose with no tool-calling loop, so early truncation is provably safe; `handleUtterance`'s voice-agent path stays full-buffer by deliberate scope boundary (JSON `{say,actions,needs_result}` contract + needs_result/corrective-pass loop means no point in that call is provably final until the whole turn resolves). Live-verified against a real running instance (separate port): first-chunk latency 1519ms vs. full-reply completion at 2536ms (402 tests, 400 passing, 1 pre-existing env-blocked) |
| `uncommitted` | Phase 1 | **Reliability (D-51, D-47/D-49, D-19, D-21, D-29/D-30, D-07)**: goal arbiter scores-then-caps, config-driven goal budgets forwarded to `brain.think()`, honest `consolidate()` on skills/audit stores, per-path async mutex in fs-store (`recordUse` now async), canonical `{name,chat,isAvailable,getStatus,getModel}` shape on ollama/openrouter/claude-cli + `ollama` added to `chain.js` LANES, and the full D-07 graceful-shutdown sequence (`registerShutdownStep`: stop-loops → episodic-flush → checkpoint-write → audit-flush, duplicate `process.on(SIGINT/SIGTERM)` handlers removed, `SHUTDOWN_MS` backstop). **Features (Items 7-12)**: RAG hardening (`handleUtterance` now calls `recallHybrid` instead of plain lexical recall — the vector/hybrid system was previously inert on the hot path); Gmail triage sensor (`gmail-sensor.js` mirrors `reminder-sensor.js`, opt-in via `GMAIL_TRIAGE_ENABLED`, 🔧 coded — needs the user's own Google OAuth); barge-in reconciliation (`decideBargeIn()` pure-function VAD-level second threshold inside the existing BUG-027 gate, gate itself untouched, 🔧 coded — needs a live mic session to confirm no self-transcription regression); generative UI (`spawn_widget` T1 effector + `widgets/kinds/dynamic.js`, server-validated declarative spec, zero eval/innerHTML-unescaped, manual injection trace confirmed inert); hand-rolled MCP server (`mcp/server.js`, JSON-RPC 2.0 stdio, opt-in via `MCP_SERVER_ENABLED`, `goalId` hardcoded null so T3+ tools are structurally unreachable — tier-gate test is the load-bearing one; multi-agent cortex spike doc is a no-go for Phase 2); native `click_at` coordinate-click primitive (`ps-automation.ps1` + `from-pc.js` T3 + `spotify_play()` rewrite using `ui_elements` rect → click, falling back to the old keystroke path — the third BUG-026 attempt, 🔧 coded, needs a live 10/10 Spotify play-through). Full touched-file test batch: 295 tests, 293 passing, 2 failing — both pre-existing and unrelated to this phase's changes: `test/boot.test.js`'s Windows SIGINT signal-delivery gap (present at session start, unrelated to D-07's shutdown-step wiring which is itself fully covered by its own tests) and `test/event-name-conformance.test.js`'s pre-existing `engagement.*`/`ui.open-web`/`conversation.intent` allowlist gaps (all in files untouched by this phase's diffs — confirmed via `git diff`; the one legitimate new event this phase added, `lifecycle.shutdown.step-failed`, was deliberately added to the allowlist). No git commits made — working tree left uncommitted for review. |
| `711722d` | Aether P1 | **Aether-BLE × Agent_OS wiring, Phase 1 (focus awareness)** — new `aether` sensor (`src/core/sensors/aether.js`) connects OUT as a WS client to the Aether aggregator (`ws://127.0.0.1:8766`) and consumes its locked `election` broadcast; nearest device = `election.owner`. Emits `perception.aether` on the bus, which the existing `perception.*` relay forwards to the HUD automatically — **zero Python changes, zero server changes, pull model**. Dedup gate (aggregator fires every 400ms but cortex perception queue drains 1×/sec cap 50): emits ONLY on owner transition / first acquisition / owner-stable RSSI drift ≥3 dBm throttled 1 Hz. New `widgets/kinds/aether.js` (NEAREST DEVICE chip) + 12-case `test/aether-sensor.test.js`. Modified: `schema.js`, `main.js`, `widget-registry.js` + 3 widget allowlists (`from-widgets`/`widget-spec`/`manage-widget`), `event-name-conformance` allowlist, `.env.example` — all spec-drift guards updated. Opt-in (`AETHER_ENABLED`, default false); graceful degradation both directions; no new deps; real RSSI (no fabricated distance). QA-reviewed. **2525/2525 tests pass.** Branch `feat/aether-focus-sensor`. Plan + Phases 2–5 next-up: see `AETHER-WIRING.md`. |
