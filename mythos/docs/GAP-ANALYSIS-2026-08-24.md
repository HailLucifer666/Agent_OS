# Gap analysis & deep audit — 2026-08-24

Scope: read-only audit at `3f2c1b4`. Companion to `AUDIT-2026-08-22-defect-classes.md`
(diagnosis) and `AUDIT-2026-08-22-FIX-PLAN.md` (treatment). Adds what those could not:
a verified end-to-end wiring map, a claim-vs-reality gap pass over everything that
changed since the Aug-22 audit (DSH swap, BUG-292…308, news-rss rung), and an
adversarial Q1–Q8 attack pass on the newest guards.
Suite state at audit time: 5903 tests / 5901 pass / 0 fail / 2 skipped (hook-normalised).

---

## Section 1 — Verified end-to-end flow map

Every hop confirmed by reading the actual require/subscribe/dispatch edges this session.

1. Boot: Start Electron App.bat -> electron/main.js (forks server child, run-as-node
   guard, updater download-only) -> src/main.js sequential boot: logger, bus, lifecycle,
   memory, brain, identity, goals, cortex, leash(+checkpoints), forge/forge-runner,
   engagements, assistant gateway, sensors (timer/reminder/calendar/gmail/screen/window/
   aether/metric), planner, immune (probes/diagnostician/healer/watchdog/announcer/
   monitor), effector hub + registerFrom* modules, build-runner/build-engine,
   pipeline/risk/evidence-validator/kanban/agent-actions/goals-bridge, TTS children
   (edge-tts :5050, piper, websearch-child), reflection/explainer, server :4478.
   Crash recovery via core/crash-handlers.js + recoverFromCrash.
2. Voice turn (main loop): HUD mic -> audio worklet -> WS -> createLiveSession (Gemini
   Live wire protocol, frozen spine §3/AD-1). serverContent frames carry audio +
   transcriptions + toolCall in ONE frame. toolCall -> onToolCall -> live-tool-adapter.js
   (leash verdict -> confirm-or-run -> breaker) -> dispatchAction -> hub.chainFor ->
   adapter -> result -> sendToolResponse. Audio out -> onAudioOut -> HUD; echo-filter +
   barge-in protect the loop; openWakeWord gates capture.
3. Text path: HUD chat -> /api routes -> gateway -> brain lanes (cerebras/nim/mistral/
   gemini fallback) -> reply -> TTS chain -> speak+caption.
4. Dispatch spine: ~150 registered tools across from-browser/from-pc/from-cua/
   from-dashboard/from-computer/from-dsh/from-installer/from-mcp/from-okf/from-strix/
   spotify/whatsapp/phone/goals/kanban/documents/skills. Leash tiers gate danger;
   episodic audit line per invoke.
5. Immune loop: health.anomaly -> diagnostician -> healer (forwards needsOperator/reason
   per BUG-278) -> explainer (applicability-built menu; holds during live turns);
   suppressions feed provider skip logic.
6. Build path: build_project -> build-runner -> risk-classifier -> evidence-validator
   ship gate -> DSH harness (Hermes deleted W6 2026-08-22, NOT aliased — W6-AD-8;
   exit code IS the oracle, pinned build-engine.js:144) -> artifact.
7. Memory/identity/persona: episodic write per turn; session.json rolling 40 turns
   (failure logged, BUG-306); semantic.write quarantines unconfirmed identity claims;
   reflection consolidates; persona dials modulate prompts.
8. Multi-device/shell: Aether sensor + scanner-proxy; voice-output routing Phase 2
   coded-needs-live-verify; handoff Phase 4 partial; phone node phone_* tools; Electron
   media-window origin allowlist, cursor overlay flag-gated, updater download-only.

## Section 2 — Gap tables

### G3 Intended ≠ Built (Aug-22 fix plan re-check at HEAD)
| Item | Status | Evidence |
|---|---|---|
| 1 SSRF rebinding | REMEDIATED | bug-303 test |
| 2 ship gate real file | REMEDIATED | bug-304 |
| 3 sandbox override opts.extra | REMEDIATED | build-engine.js:284-292 fixed args, autoApprove absent |
| 4 session-write silent | REMEDIATED | bug-306 |
| 5 engine timeout blame | NOT located at HEAD | stale refs; ~10 min triage |
| 6 fatal stderr trace | REMEDIATED | bug-305/308 + crash-handlers main.js:7 |
| 7 vault containment | REMEDIATED | bug-307 |
| 8 unhandled rejection | REMEDIATED | crash-handlers main.js:143 |
| 9 spawn-as-node assertion | REMEDIATED | spawn-runs-as-node-guard.test.js |
| 10 untrue reprobe assertion | NOT re-located | as item 5 |
| 12 skill score ambiguity | NOT re-located | pending |
| 13 file split + guard | OPEN | index.js 4491 / main.js 2457 / from-browser 1506 / live-tool-adapter 1382 lines; no guard |
| 14 silent catches | standing decision respected | recount pending |

### G2 Entry ≠ Finish (bus wiring)
90 literal bus events emitted vs 33 subscribed in-process. The delta (63) is NOT a
defect list: the server relays a curated subset to the HUD under wire names
(entity-state, tick, goal-update, perception, action, log, open-web...), confirmed in
server/index.js relay comments. NOT confirmed: per-event classification of all 63.
Settling check: map each name against relay list + test consumers (~1h). No dead-end
tool found: spot-checked names all resolve to hub chains.

### G1 Documented ≠ Wired
- M5 CONFIRMED: 67 hermes references remain in AGENTS.md/BUGS.md post-swap; AGENTS.md
  is binding instruction material and still describes Hermes as the build engine with
  setup-hermes.js — actively misleading.
- Aether phases honestly labelled — no ghost claims.
- CAPABILITY-MAP web_search entry predates the news-rung landing (BUG-294): stale but
  conservative (safe direction).

### G4 Tested ≠ Exercised
Q1–Q8 attack pass on own fix 3f2c1b4 recorded in the test header + web-search.js gate
comment; residual opened: prove a false-positive "site:" inside prose degrades
gracefully rather than erroring. PR #19 guards: tests read, mutation attacks scheduled.


---

## Section 3 — New findings (this pass)

H1 (HIGH) — Dispatcher timeout advisory, not enforced. dispatch-action.js:53 builds
AbortSignal.timeout(ACTION_TIMEOUT_MS||30000) and hands it via ctx; nothing races the
invoke against a timer, so an effector that never forwards the signal hangs the turn
indefinitely. CONFIRMED instance: from-image-gen.js:99 (Gemini generateContent, no
signal). Class: the repo's own "unbounded call on the Live path is permanent silence"
(from-dashboard.js:486). Precondition: provider stall (measured possible).

M2 (MED) — edge-tts listVoices fetch has no timeout (providers/edge-tts.js:97); cached
and fail-soft but a hung sidecar blocks up to undici's ~300s header timeout.

M4 (MED) — load-flaky gate failures wander (boot, cortex/sensors/timer): failed twice
under hook load 2026-08-24, passed standalone and other runs; ports verified free.
Risk: trains the operator to distrust a red gate.

L1/L2 (LOW) — silent-catch standing decision respected; MYTHOS-EXPLAINER archival
banner check deferred (deleted file, replacement shipped same commit).

## Section 4 — Deliberate non-changes (on the record)

**No sweep of the 63 relay-or-orphan bus events.** Cost: speculative subscribers with no
verification behind them. Revisit trigger: any new event added to the relay list.
Durable action: extend event-name-conformance test to assert every emitted name has a
subscriber OR a relay mapping.

**No mutation pass on PR #19 guards this session.** Their tests were read, not attacked;
four historical guards in this repo caught nothing once attacked, so this is scheduled
work, not assumed done.

**No doc-drift fix inside the audit commit** — docs churn stays out of the findings
commit; queued as its own commit.
Recorded here so this is not re-litigated.

## Section 5 — Sprint 1 queue (atomic commits after this report)

1. Hub-level timeout enforcement (red-first: stub hung effector, assert invoke rejects)
2. from-image-gen forwards ctx.signal
3. edge-tts timeouts
4. File-size guard naming the two exceptions
