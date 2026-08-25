# Implementation Plan — MYTHOS deep audit & gap analysis (2026-08-24)

**Goal:** read-only audit at `3f2c1b4` producing `mythos/docs/GAP-ANALYSIS-2026-08-24.md`, then Sprint 1 fixes as separate atomic commits.

## 1. Verified e2e flow map
Eight paths traced in source this session: Boot chain (`electron/main.js` → `src/main.js` sequential boot) · Voice turn loop (`live-session.js` → `onToolCall` → `live-tool-adapter.js` → leash → `dispatch-action.js` → `hub.js` → adapters) · Text/HUD path (routes → gateway → brain lanes → TTS chain) · Tool dispatch spine (~150 tools) · Immune loop (sensors → diagnostician → healer → explainer) · Build path (`build_project` → build-runner → risk → evidence-validator → **DSH harness** adapter, Hermes removed W6 2026-08-22, exit-code oracle pinned) · Memory/identity/persona · Aether nodes + Electron shell.

## 2. Gap analysis workstreams
- **G1 Documented ≠ Wired** — README/ROADMAP/CAPABILITY-MAP/AETHER claims vs code. Suspects: Hermes doc drift; Aether Phases 2–4 partial.
- **G2 Entry ≠ Finish** — all tools/events reachable end-to-end; dead ends, emitter/subscriber mismatches.
- **G3 Intended ≠ Built** — Aug-22 fix-plan items 3/5/10/12/13 unremediated; BUG-274 licensing open; Post-Parity plan.
- **G4 Tested ≠ Exercised** — mutation spot-checks on bug-303…308 guards; fixture-vs-wire on dsh tests.

## 3. Attack pass (Q1–Q8)
Applied to: own fix `3f2c1b4` (recorded; residual: `site:`-in-prose graceful-degradation test), PR #19 guards, leash confirm, SSRF predicate, vault containment.

## 4. Verified findings
- 🟠 H1 dispatcher timeout advisory-only (`dispatch-action.js:53`; `from-image-gen.js:99` no signal)
- 🟡 M1 size ceiling + no guard · M2 edge-tts listVoices no timeout · M3 items 5/10/12 unlocated · M4 load-flaky gate · M5 Hermes doc drift
- 🟢 L1 silent catches standing decision · L2 doc archival check

## 5. Sprint 1 (ordered, each atomic + red-first test)
1. Hub-level timeout enforcement (`hub.js`) — class-killer
2. `from-image-gen.js` forwards `ctx.signal`
3. `providers/edge-tts.js` timeouts
4. File-size guard test naming exceptions

## Leave alone
Live wire protocol, leash spine, wake-word loading, ps-automation.ps1, immune explainer/healer, search rung order.

## Out of scope
Operator-ear/hardware verification; licensing decisions.

