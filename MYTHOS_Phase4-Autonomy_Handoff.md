# MYTHOS Phase 4 — Autonomy Advancement (task-957 §26)

**Branch:** `phase4/autonomy-advancement` (13 commits, `6505f93` → `6abd921`)
**Base:** `main` @ `4f8d88f` (post-Phase-3)
**Suite:** 1290/1295 pass (4 baseline fails unchanged — boot SIGINT flake + 3 eval/memory-impact data-dependent)
**New tests:** +88 (1202 → 1290)

## What landed

Phase 4 closes the autonomous OODA loop. The cortex now *learns from outcomes*,
*acts on memory at decision time*, *reflects on action history*, *proposes
goals during idle moments*, and *brain-drives engagement cognition*. The
spec's "doesn't wait for commands" design intent becomes structurally true.

### Latent bugs surfaced + fixed (Area A foundation)

Three bugs had silently disabled the execution→learning loop since the goal
system shipped. The closing integration test
(`phase4a-loop-integration.test.js`) would have caught all three in one run
if it had existed:

| Bug | Where | Symptom |
|---|---|---|
| **B-1** | `goals/index.js:215` | `skills.recall({query,limit})` passed an object where a string was expected → TypeError → swallowed by try/catch → procedural-skill branch silently dead since day one |
| **B-2** | `goals/index.js:216` | `skill.successRate` tracked by recordUse() but no planner ever read it → failing procedures replayed forever |
| **B-3** | `goals/index.js:57` | `goal.plan: []` initialized + read but never written → plan-step reader was dead code |

## Vision gap close-out

| Gap | Spec text | Commit | Status |
|---|---|---|---|
| **V1** | orient→recallHybrid + per-tick cache | `055d408` | ✅ Cortex consults memory on the autonomous path; 1 embeddings call per non-idle tick, zero when idle |
| **V2** | skills.recordUse() in dispatchAction completion path | `f475307` | ✅ Loop closed: planner picks skill → dispatch records outcome → successRate updates via EMA → next plan call respects new rate |
| **V3** | plan() consults successRate, executes multi-step procedures, persists to goal.plan + goal-completion distill | `03c4eb7` + `b2e70c8` | ✅ Multi-step procedures advance correctly; successful goals distill into Skills via one bounded brain call |
| **V5** | mull() → propose_goal suggestions for one-tap acceptance | `a27b980` + `2c5f969` | ✅ Cortex suggests goals during quiet moments; operator accepts/rejects via dashboard; no goal ever activates without human confirmation |
| **V6** | brain-driven interview/spec/plan with template fallback | `6abd921` | ✅ All three builders have brain seams with honest-inert fallback |
| **V8** | mull→propose_goal + calendar-event perception + opt-in active-window sensor | `2c5f969` + `19a8925` + `cf3406c` | ✅ Cortex ACTS during idle; upcoming events enter OODA; opt-in window-title sensor |
| **V9** | reflect() analyzes last-N outcomes → diagnostician (failures) + Skills (successes) | `bc64aa0` | ✅ Action-outcome reflection on its own cadence; failures route to existing health.anomaly channel |
| **V10** | consolidate dedup/contradiction | `c7a2379` | ✅ One bounded brain call merges accumulated consolidated-* topics |

## Autonomy discipline (per spec §24.2 + §25)

The spec was followed verbatim — always-on passive learning (zero cost when
idle), human-gated state-creating actions, opt-in only for heavy sensors.

| Path | Default | Rationale |
|---|---|---|
| skills.recordUse (V2) | ON | Read-only stats, zero cost |
| plan() successRate gate (V3) | ON | Reads an existing field |
| goal-completion distill (V3) | ON | Gated by consolidate cadence (idle-skip) |
| orient→recallHybrid (V1) | ON | Gated by salience > 0.5, not env flag |
| consolidate dedup (V10) | ON | Existing cadence |
| mull→propose_goal (V5/V8) | ON | Human-confirmed — proposals need one-tap acceptance, never auto-activate |
| calendar upcoming (V8) | ON | No privacy surface (local reminders.json only) |
| active-window sensor (V8) | **OFF** | Opt-in via WINDOW_AWARENESS_ENABLED — same privacy surface as screen-sensor |
| reflect→diagnostician/Skills (V9) | ON | Gated by REFLECT_ACTION_EVERY_TURNS (default 30) |
| brain-driven engagements (V6) | ON | Brain-optional — canned template when offline |

## New config keys

| Key | Default | Purpose |
|---|---|---|
| `SKILL_MIN_SUCCESS_RATE` | 0.5 | V3 — procedural-skill replay floor |
| `ORIENT_RECALL_MIN_SALIENCE` | 0.5 | V1 — cortex autonomous-recall gate |
| `ORIENT_RECALL_LIMIT` | 5 | V1 — cache size |
| `CONSOLIDATE_MERGE_MIN` | 3 | V10 — merge-pass idle-skip threshold |
| `REFLECTION_ACTION_EVERY_TURNS` | 30 | V9 — action-reflection cadence |
| `REFLECTION_ACTION_MIN` | 5 | V9 — minimum sample size |
| `CALENDAR_UPCOMING_ENABLED` | true | V8 — calendar perception on/off |
| `CALENDAR_UPCOMING_POLL_MS` | 60000 | V8 — poll cadence |
| `CALENDAR_UPCOMING_LEAD_MS` | 900000 | V8 — perception lead time (15min) |
| `CALENDAR_UPCOMING_SALIENCE` | 0.6 | V8 — event salience |
| `WINDOW_AWARENESS_ENABLED` | false | V8 — opt-in window-title sensor |
| `WINDOW_AWARENESS_POLL_MS` | 30000 | V8 — poll cadence |
| `WINDOW_AWARENESS_SALIENCE` | 0.3 | V8 — perception salience |

## New effectors / routes / events

**Effector:** `propose_goal` (T1 — creates status:'proposed' only; NOT in AUTONOMOUS_EXCLUDED)
**REST routes:** `GET /api/goals/proposals`, `POST /api/goals/:id/accept`, `POST /api/goals/:id/reject`
**Dashboard view:** `PROPOSALS` panel (mirrors goals.js shape)
**PowerShell command:** `active_window` (3 new DllImports: GetForegroundWindow, GetWindowText, GetWindowThreadProcessId)
**New events:** `cortex.recall`, `cortex.proposed`, `goal.completed`, `memory.merged`, `perception.calendar`, `perception.window`

**Effector count gate:** 72 → 73

## What I did NOT do

- No `git push` (house rule §24.2)
- No live OAuth / live sensor verification (operator-hardware work per task-957 §26)
- No autonomous goal completion trigger (the `goals.complete()` API exists but no cortex path calls it autonomously yet — that's a Phase 4.5 decision about when the cortex is allowed to declare success)
- No changes to the engagement transition handler — it stays synchronous (the brain-driven methods are surfaces for cortex/gateway/future orchestrator; transitions still use canned paths to preserve the existing test harness)

## Files touched

```
mythos/src/core/cortex/index.js                 (V1 orient→recall, V8 mull→propose_goal)
mythos/src/core/cortex/ooda.js                  (unchanged — orient() still pure arithmetic, recall is in cortex/index.js)
mythos/src/core/memory/working.js               (V1 recall cache)
mythos/src/core/memory/index.js                 (V10 mergeConsolidatedTopics)
mythos/src/core/goals/index.js                  (V2/V3 skills.recall fix + successRate gate + goal.plan + complete() + distillIntoSkill)
mythos/src/core/effectors/dispatch-action.js    (V2 recordUse + markPlanStepDone)
mythos/src/core/effectors/goals.js              (V5 proposeGoal/listProposals/acceptProposal/rejectProposal)
mythos/src/core/effectors/from-dashboard.js     (V5 propose_goal effector)
mythos/src/core/effectors/routes.js             (V5 proposals route + synonyms)
mythos/src/core/identity/reflection.js          (V9 reflectOnActions)
mythos/src/core/leash/tiers.js                  (V5 propose_goal T1)
mythos/src/core/config/schema.js                (13 new keys)
mythos/src/core/engagements/index.js            (V6 thread brain into builders)
mythos/src/core/engagements/interview.js        (V6 generateQuestionsBrain)
mythos/src/core/engagements/spec-builder.js     (V6 buildBrain)
mythos/src/core/sensors/calendar-upcoming-sensor.js  (V8 NEW)
mythos/src/core/sensors/window-sensor.js        (V8 NEW)
mythos/src/main.js                              (wire new sensors + bus into reflection)
mythos/server/routes/goals.js                   (V5 proposal REST routes)
mythos/ui/public/js/views/proposals.js          (V5 NEW dashboard view)
mythos/ui/public/js/overlay/panel-registry.js   (V5 proposals panel)
mythos/adapters/pc-child/ps-automation.ps1      (V8 active_window command + 3 DllImports)
mythos/test/*.test.js                           (8 new test files, +88 cases)
```

## Verification commands

```bash
# Full Phase 4 test suite (88 new tests)
cd mythos
node --test test/phase4a-skills-recall-fix.test.js \
          test/phase4a-goal-plan-persistence.test.js \
          test/phase4a-dispatch-record-use.test.js \
          test/phase4a-goal-completion-distill.test.js \
          test/phase4a-loop-integration.test.js \
          test/phase4b-orient-recall.test.js \
          test/phase4b-consolidate-merge.test.js \
          test/phase4c-reflect-on-actions.test.js \
          test/phase4d-propose-goal.test.js \
          test/phase4d-mull-propose-goal.test.js \
          test/phase4d-calendar-upcoming-sensor.test.js \
          test/phase4d-window-sensor.test.js \
          test/phase4e-brain-driven-cognition.test.js

# Count gate verification
node --test test/effectors-hub.test.js

# Boot smoke (manual)
node src/main.js
# look for: "MYTHOS ALIVE", "effectors.ready count: 100"
```

## Phase 5 preview (per task-957 §26)

Production & docs: `MYTHOS_AUTH_TOKEN` (P1); `render.yaml` health path +
ALLOWED_ORIGINS + persistent vault disk (P2–P4); platform-gate pc-child /
browser-agent (P6); docs re-sync (handoff rewrite, ROADMAP append, BUGS
prune, §9 parity, P5).
