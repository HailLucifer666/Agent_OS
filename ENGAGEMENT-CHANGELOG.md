# Engagement Layer -- Phase 17/18 Changelog

> What shipped: an Engagement lifecycle system that takes an initial intent through
> interview, spec, plan, approval, execution, verification, repair, and completion --
> plus an Assistant conversation gateway and live-progress dashboard. 166 new tests,
> 15 new modules, 8 new UI components, 18 engagement event types.

---

## 2026-07-14

### `feat(core/engagements): lifecycle engine with 12-state FSM`

**What you can do now:** create an engagement from a natural-language intent, and the system walks it through an 12-state state machine (DRAFT -> INTERVIEWING -> SPEC_READY -> PLAN_READY -> AWAITING_APPROVAL -> EXECUTING -> VERIFYING -> REPAIRING -> COMPLETED / BLOCKED / FAILED) with 22 validated transitions. Every transition is gated by preconditions -- you cannot `buildPlan` without a spec, cannot `requestApproval` without stages, cannot `approve` without a plan. Invalid transitions emit `health.anomaly` events with exact kind strings (`engagement-transition-invalid`, `engagement-corrupt`).

Modules: `engagements/index.js`, `engagements/state-machine.js`, `engagements/schema.js`.

Files: `src/core/engagements/index.js` (301 lines), `src/core/engagements/state-machine.js` (198 lines), `src/core/engagements/schema.js` (452 lines).

### `feat(core/engagements): interview + spec builder`

**What you can do now:** start an interview for any engagement. The system presents up to 5 configurable questions (deliverable type, tech stack, scope, complexity, requirements) across 5 question variants: text, choice, confirm, multi-select, and numeric. Answers are validated per type (choice answers must be in the option list, confirm answers must be yes/no, numeric must be a number). Once all questions are answered, the spec builder generates a structured markdown document and produces build/research/hybrid recommendations with confidence scores.

Modules: `engagements/interview.js`, `engagements/spec-builder.js`, `engagements/recommendations.js`.

Files: `src/core/engagements/interview.js` (167 lines), `src/core/engagements/spec-builder.js` (137 lines), `src/core/engagements/recommendations.js` (114 lines).

### `feat(core/engagements): plan builder + progress streaming`

**What you can do now:** from a spec, the plan builder generates an execution plan with staged phases (setup, core implementation, verification) and optional research stages. Each stage carries a verification gate type (command, file, HTTP, browser, research). The progress module tracks stage completion, emits real-time progress events on the bus, and computes percentage-complete from completed stages vs total stages. Repair budget tracking limits auto-repair attempts (default: 3).

Modules: `engagements/plan-builder.js`, `engagements/progress.js`.

Files: `src/core/engagements/plan-builder.js` (99 lines), `src/core/engagements/progress.js` (137 lines).

### `feat(core/engagements): persistent store with per-record mutex`

**What you can do now:** engagement records persist to vault/Engagements/ as JSON files. The store provides atomic read/write/update/delete with per-record promise mutexes to prevent concurrent-write corruption. Records are validated against the engagement schema on write. Init creates the Engagements directory on first boot.

Module: `engagements/store.js`.

File: `src/core/engagements/store.js` (177 lines).

### `feat(core/engagements): 18 event types with health anomaly constants`

**What you can do now:** every engagement lifecycle transition emits a typed bus event. 18 event factory functions cover the full lifecycle: `engagement.draft`, `engagement.interviewing`, `engagement.spec_ready`, `engagement.plan_ready`, `engagement.approval_requested`, `engagement.approved`, `engagement.stage_started`, `engagement.stage_completed`, `engagement.stage_failed`, `engagement.repairing`, `engagement.blocked`, `engagement.failed`, `engagement.completed`, `engagement.artifact_created`, `engagement.verification_passed`, `engagement.verification_failed`. Four health anomaly kinds detect stuck states and TTL expiry.

Module: `engagements/events.js`.

File: `src/core/engagements/events.js` (228 lines).

### `feat(core/assistant): conversation gateway + intent router`

**What you can do now:** send a message to the conversation gateway and it classifies the intent as action, question, or chat. Action intents ("create an engagement", "approve", "list projects") route to the engagement manager. Question and chat intents route to cortex for response planning. The intent router provides explicit action pattern matching for 9 engagement-related commands (create, delete, list, approve, reject, start interview, skip interview, revise, abandon).

Modules: `assistant/gateway.js`, `assistant/intent-router.js`.

Files: `src/core/assistant/gateway.js` (152 lines), `src/core/assistant/intent-router.js` (115 lines).

### `feat(core/assistant): response planner + style + summary`

**What you can do now:** the response planner creates structured response plans for chat and question intents. The style module applies 4 voice tones (neutral, confident, inquiring, explanatory) and formats interview questions, spec previews, and completion reports. The summary module extracts titles, computes progress percentages, summarizes specs (first 200 characters), and describes plans by stage type counts.

Modules: `assistant/response-planner.js`, `assistant/style.js`, `assistant/summary.js`.

Files: `src/core/assistant/response-planner.js` (65 lines), `src/core/assistant/style.js` (113 lines), `src/core/assistant/summary.js` (112 lines).

### `feat(ui): engagement dashboard with 3-column layout`

**What you can do now:** open the Engagements view from the JARVIS HUD. The dashboard shows a 3-column layout: engagement list (left), detail panel (center), live progress (right). The list supports three filters: Active (in-progress engagements), Recent (completed within 24h or blocked/failed), and Completed (older completions). Active engagements auto-poll every 10 seconds. The dashboard subscribes to 16 WS event types for real-time updates.

View: `ui/public/js/views/engagements.js` (626 lines).

### `feat(ui): engagement detail panel with 5-tab system`

**What you can do now:** click any engagement in the list to see its detail panel. Five tabs render lazily: Spec (markdown-rendered spec document), Plan (stage timeline with type badges and verification preview), Execution (stage results with pass/fail/repair indicators), Verifications (check results by type with passed/failed counts), and Report (completion report with duration, stage count, checks, artifact links, and verification checklist). The report tab appears only for completed engagements.

View: `ui/public/js/views/engagement-detail.js`, `ui/public/js/views/engagement-list.js`.

### `feat(ui): 8 engagement component modules`

**What you can do now:** the engagement UI is built from 8 stateless rendering components covering the full lifecycle:

- `EngagementListItem.js` -- list item with status dot, stage progress, and relative timestamps
- `InterviewQuestionCard.js` -- 5 question-type variants (confirm, choice, text, multi-select, numeric) with step-dot progress and skip/cancel actions
- `SpecPreviewCard.js` -- markdown renderer with recommendation tiles (build/research/hybrid) and confidence scores
- `PlanTimeline.js` -- stage timeline with current/completed indicators, verification previews, approval gates, and summary
- `ProgressStreamPanel.js` -- live WS-driven progress bar with stage type, check items, completed stages, estimated remaining time, and cancel button
- `VerificationCheckCard.js` -- check cards for 5 types (command, file, HTTP, browser, research) with 6 states (pending, running, passed, failed, repaired, warning) and detail expanders
- `ApprovalGateModal.js` -- approval dialog with plan metrics, risk indicators (file writes, external APIs, browser automation), and feedback-textarea for requesting changes
- `CompletionReportView.js` -- completion report with artifact links, verification checklist, research citations placeholder, and metric grid (duration, stages, checks, repairs)

Components: `ui/public/js/components/engagement/*.js` (8 files).

### `feat(ui): engagement design system (CSS)`

**What you get:** 80+ CSS custom properties scoped to the engagement layer under `--engag-*` tokens. State badge colors for all 12 engagement states. Spacing scale on a 4px grid. Card, modal, and check-card radii. Z-index layering for panels, dropdowns, tooltips, and modals. Animations for check transitions (300ms), progress bars (600ms), and pulse effects (1.4s). Shadow system for cards, raised elements, modals, and glow effects.

File: `ui/public/css/engagements.css` (80+ lines of design tokens).

### `test: 166 tests across 14 test files`

121 tests in `test/engagements/` (9 files): events (19), state-machine (22), schema (21), interview (13), store (12), index (12), recommendations (11), plan-builder (6), spec-builder (5).

45 tests in `test/assistant/` (5 files): style (14), intent-router (13), summary (8), gateway (5), response-planner (5).

---

## Config schema additions

The following config keys were added to `config/schema.js`:

| Key | Type | Default | Min | Max | Used by |
|-----|------|---------|-----|-----|---------|
| `ENGAGEMENT_TTL_MS` | number | 604800000 | 3600000 | -- | `engagements/index.js`, `engagements/schema.js` |
| `ENGAGEMENT_MAX_REPAIRS` | number | 3 | 0 | 10 | `engagements/index.js`, `engagements/plan-builder.js` |
| `ENGAGEMENT_INTERVIEW_MAX_Q` | number | 5 | 1 | 20 | `engagements/interview.js` |
| `ENGAGEMENT_MAX_STAGES` | number | 10 | 1 | 50 | `engagements/plan-builder.js` |
