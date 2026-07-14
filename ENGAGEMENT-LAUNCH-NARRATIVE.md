# MYTHOS Engagement Layer -- Launch

## For whom

The Engagement Layer is for anyone who wants MYTHOS to do more than answer questions -- to take an idea, interview you about it, generate a spec, build an execution plan, ask for approval, run the plan, verify the results, repair failures, and deliver a completion report. It turns MYTHOS from a conversational entity into a task-execution entity with a structured lifecycle.

## What shipped

**15 new backend modules** across two subsystems:

**Engagements** (`mythos/src/core/engagements/` -- 10 modules):
- A **state machine** with 12 states and 22 validated transitions. Every transition has preconditions -- you cannot approve a plan that has no stages, you cannot complete an interview with unanswered questions. Invalid transitions emit typed health anomalies instead of silently corrupting state.
- An **interview system** that presents up to 5 questions in 5 variants (text, choice, confirm, multi-select, numeric) with per-type validation.
- A **spec builder** that converts interview answers into structured markdown documents and generates build/research/hybrid recommendations with confidence scores.
- A **plan builder** that produces staged execution plans with verification gates per stage (command, file, HTTP, browser, research).
- A **persistent JSON store** with per-record promise mutexes for safe concurrent writes.
- A **progress tracking** module that computes percentage-complete, streams progress events on the bus, and tracks the repair budget.
- **18 event factory functions** covering the full lifecycle with exact event name strings.
- A **recommendation engine** that analyzes spec text for research vs build indicators.

**Assistant** (`mythos/src/core/assistant/` -- 5 modules):
- A **conversation gateway** that classifies incoming messages as action, question, or chat with confidence scores and routes to the appropriate handler.
- An **intent router** with 9 action patterns for engagement commands.
- A **response planner** that builds structured response plans for chat and question intents.
- A **style module** with 4 voice tones for formatting responses, interview questions, spec previews, and completion reports.
- A **summary engine** that extracts titles, computes progress, and summarizes plans and specs.

**8 new UI component modules** (`mythos/ui/public/js/views/` + `.../components/engagement/`):
- A **3-column dashboard** (list + detail + live progress) with Active/Recent/Completed filters and 10-second auto-polling for active engagements.
- A **5-tab detail panel** (Spec, Plan, Execution, Verifications, Report) with lazy rendering.
- Components for interview cards (5 variants), spec previews with recommendation tiles, plan timelines with approval gates, progress streaming with live progress bars, verification check cards (5 types, 6 states), approval gate modals with risk indicators, and completion reports with artifact links.
- An **80+ variable CSS design system** scoped to the engagement layer.

**166 new tests** across 14 test files (121 engagement + 45 assistant), all passing.

## The core capability in one sentence

You say "build a CLI tool for parsing CSV files" and MYTHOS conducts a structured interview, generates a spec, proposes a build plan with 3 stages and verification gates, awaits your approval, executes the plan, verifies each stage, and delivers a completion report with a repair budget of 3 retries if anything fails.

## What this unlocks tomorrow

The Engagement Layer provides the lifecycle framework that higher-level features depend on:

- **Workspace management** -- each engagement could get a dedicated workspace directory
- **Artifact tracking** -- engagement-produced files can be cataloged and linked from completion reports
- **Verification subsystem** -- dedicated verifiers for command, file, HTTP, browser, and research checks
- **Research workflows** -- engagements with research stages can use web search, source evaluation, and claim verification
- **Multistage workflows** -- the stage executor can run build and research stages in sequence with repair loops
- **Human-in-the-loop approval** -- the AWAITING_APPROVAL and AWAITING_STAGE_APPROVAL states are already wired; the approval UI component is built

## What is NOT shipping

The Engagement Layer modules are **tested in isolation** and **ready for integration**, but not yet wired into the main boot sequence or exposed via REST API. Specifically:
- No `/api/engagements` REST routes exist yet in `server/index.js`
- The engagement manager is not created or wired into `mythos/src/main.js`
- Workspace, Artifacts, Verification, Research, and Workflows subsystems listed in the architecture plan are not yet built

Config schema keys (`ENGAGEMENT_TTL_MS`, `ENGAGEMENT_MAX_REPAIRS`, `ENGAGEMENT_INTERVIEW_MAX_Q`, `ENGAGEMENT_MAX_STAGES`) are registered in `config/schema.js` and documented in `.env.example`.

These integration steps are the next priority.

## Test summary

```
engagements/events:          19 tests
engagements/state-machine:   22 tests
engagements/schema:          21 tests
engagements/interview:       13 tests
engagements/store:           12 tests
engagements/index:           12 tests
engagements/recommendations: 11 tests
engagements/plan-builder:     6 tests
engagements/spec-builder:     5 tests
                             ---
                             121 tests (9 files)

assistant/style:             14 tests
assistant/intent-router:     13 tests
assistant/summary:            8 tests
assistant/gateway:            5 tests
assistant/response-planner:   5 tests
                             ---
                              45 tests (5 files)
                             ===
                             166 total tests (14 files)
```
