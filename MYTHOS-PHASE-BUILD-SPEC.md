# MYTHOS Phase Build Spec — P5 through P10

> Exhaustive, drift-proof implementation specs for the remaining MYTHOS phases, written against the real shipped P0-P4 code (not just the architecture doc) and against MYTHOS-ARCHITECTURE.md itself. Each phase draft was written by an independent agent that read the real spec sections and the real shipped code; a final consistency pass then checked for contradictions across all six drafts, and the specific fixes it found have been applied inline below (search for "CROSS-PHASE FIX"). See ROADMAP.md for phase gates, drift tracking (D-01..D-54), and the Phase 4.5 remediation gate that must close before any of this can be built.

## Table of Contents

- P5 — Leash
- P6 — Immune
- P7 — Sensors & Effectors
- P8 — Identity
- P9 — UI v2 & Cutover
- P10 — Chaos Drills
- Cross-Phase Consistency Report

---

# Phase 5 — Leash

## Overview & Why

Leash is the mandatory tiered-autonomy gate that sits between Cortex's `decide()` and Effectors' `invoke()`. Every tool call the entity's OODA loop wants to execute passes through `leash.check()` exactly once, which classifies it into one of five risk tiers (T0 read-only through T4 always-confirm), enforces `AUTONOMOUS_MAX_TIER`, honors per-goal T3 grants, and writes one append-only audit line per decision. Without it, Cortex has no way to distinguish "safe to run autonomously" from "needs a human" — the entity would either be unusably conservative (confirm everything) or unsafely permissive (run everything), and there would be no audit trail proving which is which. This phase also ships the confirm registry (`confirm.js`, CA from NOVA) that backs the T3/T4 "ask a human" path.

## Directory & File Layout

```
mythos/
├── src/
│   ├── core/
│   │   └── leash/
│   │       ├── index.js          (NEW — createLeash, check())
│   │       ├── tiers.js          (NEW — canonical TIER_TABLE)
│   │       ├── confirm.js        (NEW — CA from app/lib/voice/confirm.js, factory-wrapped)
│   │       └── audit-writer.js   (NEW — thin re-export of memory/audit-writer.js, see Ambiguity #1)
│   ├── core/config/
│   │   └── schema.js             (MODIFIED — add LEASH_CONFIRM_TTL_MS key)
│   └── main.js                   (MODIFIED — identity-stub + effectors-stub + leash boot step, wire leash into cortex construction)
└── test/
    └── leash.test.js             (NEW)
```

No `vault/` changes — Leash reuses `vault/Audit/` (already created by the memory module's boot step).

## Spec Ambiguities Resolved

1. **Duplicate audit-writer deliverable.** §16 Phase 5 lists `src/core/leash/audit-writer.js` as a deliverable, but P1 already shipped `src/core/memory/audit-writer.js` implementing exactly the append-only-JSONL-with-redaction writer Leash's `check()` needs (`write/query/stats/init`, `REDACT_KEYS`, writes to `vault/Audit/YYYY-MM-DD.jsonl`, returns `{ok:true}` / `{ok:false, degraded:true}`). Building a second implementation would fork the same append-only + redaction logic against the same directory. **Resolution: `leash/audit-writer.js` is a one-line re-export of `memory/audit-writer.js`** (`module.exports = require('../memory/audit-writer');`). It exists only so the literal deliverable path resolves and so `leash/`-local code has a same-directory import; in production `createLeash({ auditWriter })` is always called with `memory.audit` — the *same instance* the memory facade already constructed. No second audit trail is ever created.

2. **`createLeash`'s own pseudocode references undeclared variables.** The spec's `check()` function (§9) reads `goals.get(goalCtx.goalId)` (step 4) and `effectors.get(toolName)` (dangerWhen override) but the factory signature is literally `function createLeash({ bus, config, identity, auditWriter })` — `goals` and `effectors` are never destructured, so as written the code only works if they're accidental module-level globals, which violates the DI mandate (Lesson #8) and would silently break in tests. **Resolution: the real signature is `createLeash({ bus, config, identity, auditWriter, goals, effectors })`** — both added as required constructor deps that throw at construction if missing (Lesson #3), never checked with `if (x && typeof x.fn === 'function')` at call time.

3. **Identity and Effectors are forward dependencies that don't exist yet.** `identity.checkBoundary()` ships in Phase 8; `effectors.get()` ships in Phase 7. Both are *after* Phase 5 in the roadmap, yet Leash's canonical `check()` calls both unconditionally. Per Lesson #3, `createLeash` must not degrade to "if present" branching — so it throws at construction if `identity` or `effectors` are missing entirely. **Resolution: `main.js`'s Phase 5 boot step injects a minimal, explicitly-labeled temporary stub for each** (`createIdentityStub` returns `checkBoundary() => null`; `createEffectorsStub` returns `get() => undefined`). Absence of a real boundary/dangerWhen check is the *conservative* default (no extra denies, no extra tier-upgrades) — it never makes Leash less safe than the static `TIER_TABLE`. These stub factories are deleted wholesale, not patched, when Phase 7/8 land — nothing downstream should special-case "is this the stub."

4. **`maxTier` ceiling vs. Identity's `boundaries.max_autonomous_tier`.** §11 shows `boundaries.md` carrying its own `max_autonomous_tier` and Phase 8's gate says "edit changes tier ceiling" — implying the *effective* ceiling should be `min(config.AUTONOMOUS_MAX_TIER, identity's boundary ceiling)`. Phase 5's `identity` dependency is only a stub with no such field yet, and inventing that reconciliation logic now risks guessing an API shape Phase 8 doesn't end up matching. **Resolution: Phase 5's `check()` reads `config.AUTONOMOUS_MAX_TIER` only.** Reconciling it with `identity`'s boundary ceiling is explicitly Phase 8's job — do not build it here.

5. **§13's own 14-step boot order is internally inconsistent for Leash.** The literal list has `cortex` as a FAIL-FAST step at position 8, and `identity` as a DEGRADED step at position 11 — i.e., the spec's own boot order constructs Cortex (which now requires Leash, which requires Identity) *before* Identity exists. **Resolution:** Phase 5's boot diff constructs `identity` (stub) → `goals` → `effectors` (stub) → `leash` → `cortex`, in that order, deviating from §13's literal position numbers while keeping every named step. This is called out explicitly in the `main.js` code comments so nobody "fixes" the reordering back to match the doc.

6. **`dangerWhen` override can produce `Math.max(undefined, 3)` → `NaN`.** The spec's literal snippet computes `tier = Math.max(tier, 3)` for the args-aware override *before* the "unknown tool → T3" fallback runs, so a `dangerWhen`-flagged tool with no `TIER_TABLE` entry produces `NaN`, not `3`. **Resolution:** the override guards `tier === undefined ? 3 : tier` before taking `Math.max(...)`.

7. **Audit Trail's "FAIL-CLOSED: T≥3 if audit unwritable → deny" is prose only — the `check()` code sketch never checks `auditWriter.write()`'s return value.** **Resolution:** every return branch in `check()` routes through a `failClosedIfUnwritable(tier, writeResult, decision)` helper that overrides an `allow`/`confirm` decision to `deny` (reason `'audit-unwritable-fail-closed'`) when `tier >= 3` and `write()` returned `{ok:false}`. T0–T2 return the originally-computed decision regardless of write success (fail-open for reads/local-writes, exactly as documented).

8. **`maxTier` must not be cached at construction.** The spec's own `createLeash` sketch computes `const maxTier = config.AUTONOMOUS_MAX_TIER || 2;` once, outside `check()` — the same class of bug as D-46 (`ACTION_TIMEOUT_MS` cached at Cortex construction instead of read per dispatch). **Resolution:** `maxTier` is read fresh from `config.AUTONOMOUS_MAX_TIER` inside every `check()` call, with no `|| 2` fallback (the config schema already guarantees a validated number 0–4 — Lesson #6: never re-default a value the schema already owns).

9. **`traceId` in the Audit Trail schema has no real source yet.** `goals.plan()`'s return shape (`{tool, args, rationale, done?, offline?}`) carries no causal event id, and Cortex's `act()` doesn't thread one into the decision object it hands to `leash.check()`. **Resolution:** Leash writes `traceId: action.traceId || null` — the field exists per schema and defaults to `null` rather than being silently dropped. Threading a real value through requires changing `goals.plan()`'s return shape and Cortex's `decide()`/`act()` — out of scope for this phase; flagged here so whichever phase adds causal tracing doesn't have to rediscover the gap.

10. **T3 grant expiry ("dies with goal") needs no extra code.** Grants live in `goal.grants['3']`, part of the goal record itself (`goals/index.js:251` `grantTier`). When a goal is removed (`goals.remove()`) or paused/completed, its grants disappear with it automatically — Leash does not need its own grant-expiry bookkeeping. Confirmed here so nobody adds a redundant TTL for grants.

11. **Confirm-request → accept → grant → re-dispatch orchestration is explicitly NOT Phase 5's job.** §14's WS protocol shows `confirm-reply{confirmId, accept}` arriving at the server (Phase 9), which must call `leash.confirm.accept()`, then (for T3) `goals.grantTier()`, then re-dispatch through Effectors (Phase 7). Phase 5 ships the primitives (`confirm.create/accept/reject/peek`) and unit-tests them directly; it does not wire the WS round-trip, since Server and Effectors don't exist yet. This seam is called out in Integration Points below so P7/P9 know exactly what to call.

## Full Code

### `src/core/leash/tiers.js`

Copied verbatim from MYTHOS-ARCHITECTURE.md §9 — every key and value in this table is an **exact string/number, do not paraphrase**.

```js
'use strict';

// Canonical Tier Table (Conservative Merge) — MYTHOS-ARCHITECTURE.md §9.
// Keys are tool names as they appear in decision.tool; values are the tier
// (0-4). Every key here is copied verbatim from the spec — do not rename,
// re-tier, or drop any entry without updating the spec first.
const TIER_TABLE = {
  // T0 — READ ONLY (auto-allow, never audit)
  'navigate':              0,
  'read_status':           0,
  'job_status':            0,
  'list_goals':            0,
  'pipeline_status':       0,
  'kanban_status':         0,
  'monitor_snapshot':      0,
  'list_folder':           0,
  'read_file':             0,
  'list_windows':          0,
  'ui_elements':           0,
  'browser_get_title':     0,

  // T1 — LOCAL WRITES (auto-allow, audit logged)
  'create_goal':           1,
  'toggle_goal':           1,
  'capture_idea':          1,
  'kanban_add_card':       1,
  'kanban_move_card':      1,
  'write_note':            1,
  'screen_look':           1,
  'browser_screenshot':    1,
  'browser_get_text':      1,
  'browser_scroll':        1,
  'browser_go_back':       1,
  'focus_window':          1,
  'pipeline_advance':      1,  // approve only — dangerWhen handles reject

  // T2 — LOCAL ACTIONS (auto-allow within AUTONOMOUS_MAX_TIER, audit)
  'open_folder':           2,
  'launch_app':            2,
  'media_key':             2,
  'ask_agent':             2,
  'browser_navigate':      2,
  'browser_tabs':          2,

  // T3 — CONFIRM-ONCE-PER-GOAL (grant recorded, dies with goal)
  'delete_goal':           3,
  'pipeline_execute':      3,
  'kanban_assemble':       3,
  'kanban_build_card':     3,
  'start_project':         3,
  'compose_email':         3,
  'close_window':          3,
  'ui_click':              3,  // ELEVATED — autonomous typing unpredictable
  'ui_type':               3,  // ELEVATED — same reasoning
  'browser_click':         3,
  'browser_type':          3,

  // T4 — ALWAYS CONFIRM (never cached, human must approve every time)
  'kill_session':          4,
  'browser_evaluate':      4
};

// Phase 7's effector adapter (effectorFromTool) needs a name->tier lookup with
// the same "unmapped tool" fail-safe leash/index.js's check() applies inline —
// added here (not spec'd explicitly in §9's snippet) so both call sites agree
// on the number without each reimplementing the fallback. Unmapped -> 3, never
// 4 — matches check()'s "Unknown tool -> T3 fail-safe" exactly.
function tierOf(name) {
  var tier = TIER_TABLE[name];
  return tier === undefined ? 3 : tier;
}

module.exports = { TIER_TABLE: TIER_TABLE, tierOf: tierOf };
```

### `src/core/leash/confirm.js`

```js
'use strict';

// confirm.js — pending-confirmation registry for Leash T3/T4 gates.
// CA from NOVA app/lib/voice/confirm.js (65 lines). Adapted from a module-level
// singleton Map into a DI factory (createConfirmRegistry) so tests get a fresh
// registry per call instead of sharing global state across test files, and so
// TTL comes from config.LEASH_CONFIRM_TTL_MS (schema key, see config/schema.js)
// instead of reading process.env directly — Lesson #6: config must be read, not
// re-defaulted. Everything else is verbatim NOVA logic: crypto.randomUUID() ids,
// single-use accept()/reject() (consumed on first resolution), connection-scoped
// binding (a stray accept from the wrong connectionId returns null WITHOUT
// deleting the entry, so it can't DoS the legitimate connection's pending confirm).

const crypto = require('crypto');

function createConfirmRegistry({ config }) {
  const ttlMs = config.LEASH_CONFIRM_TTL_MS;   // exact key, do not paraphrase
  const pending = new Map(); // confirmId -> { summary, action, expiresAt, connectionId }

  function nextId() {
    return 'confirm-' + crypto.randomUUID();
  }

  // create(summary, action, connectionId) -> confirmId. `action` is caller-defined
  // (Leash callers pass the {tool, args} decision) and is only ever handed back
  // verbatim via accept() — this registry never inspects or executes it.
  function create(summary, action, connectionId) {
    connectionId = connectionId === undefined ? null : connectionId;
    const confirmId = nextId();
    pending.set(confirmId, { summary: summary, action: action, expiresAt: Date.now() + ttlMs, connectionId: connectionId });
    return confirmId;
  }

  // accept(confirmId, connectionId) -> the stored action, or null if unknown,
  // expired, already consumed, or created by a different connection.
  function accept(confirmId, connectionId) {
    connectionId = connectionId === undefined ? null : connectionId;
    const entry = pending.get(confirmId);
    if (!entry) return null;
    if (entry.connectionId !== null && entry.connectionId !== connectionId) return null;
    pending.delete(confirmId);
    if (Date.now() > entry.expiresAt) return null;
    return entry.action;
  }

  // reject(confirmId, connectionId) -> true if a pending confirm belonging to
  // this connection was found and removed, false otherwise (including a
  // connectionId mismatch, reported identically to "not found").
  function reject(confirmId, connectionId) {
    connectionId = connectionId === undefined ? null : connectionId;
    const entry = pending.get(confirmId);
    if (!entry) return false;
    if (entry.connectionId !== null && entry.connectionId !== connectionId) return false;
    return pending.delete(confirmId);
  }

  function peek(confirmId) {
    const entry = pending.get(confirmId);
    if (!entry) return null;
    return { summary: entry.summary, expired: Date.now() > entry.expiresAt };
  }

  function stats() {
    return { pending: pending.size, ttlMs: ttlMs };
  }

  return { create: create, accept: accept, reject: reject, peek: peek, stats: stats };
}

module.exports = { createConfirmRegistry };
```

### `src/core/leash/audit-writer.js`

```js
'use strict';

// leash/audit-writer.js — DELIBERATE thin re-export, not a second audit trail.
//
// See "Spec Ambiguities Resolved" #1: §16 Phase 5 lists this file as a deliverable,
// but src/core/memory/audit-writer.js (P1) already implements the exact append-only
// JSONL + redaction writer Leash's check() needs (write/query/stats/init). This file
// exists only so `require('../leash/audit-writer')` resolves — it re-exports the
// memory module's factory unchanged. createLeash({ auditWriter }) is always called
// with memory.audit, the SAME instance the memory facade constructed — main.js never
// builds a second audit-writer instance, and vault/Audit/*.jsonl has exactly one writer.
module.exports = require('../memory/audit-writer');
```

### `src/core/leash/index.js`

```js
// leash/index.js — tiered autonomy gate. Mandatory dispatch checkpoint between
// Cortex's decide() and Effectors' invoke() (cortex/index.js act(), step 1: the
// Phase 4.5 D-39 fix makes leash.check() unconditional — createCortex now throws
// at construction if leash is missing, it never skips the gate at call time).
//
// Real signature (see "Spec Ambiguities Resolved" #2 — goals/effectors are
// required constructor deps, not free variables closed over from nowhere):
//   createLeash({ bus, config, identity, auditWriter, goals, effectors })

var TIER_TABLE = require('./tiers').TIER_TABLE;
var createConfirmRegistry = require('./confirm').createConfirmRegistry;

function createLeash(deps) {
  var bus = deps.bus, config = deps.config, identity = deps.identity;
  var auditWriter = deps.auditWriter, goals = deps.goals, effectors = deps.effectors;

  // Mandatory dependencies — fail construction loudly, never no-op at call time
  // (Lesson #3). identity/effectors get boot-time stubs until Phase 8/7 ship
  // (see main.js) — this constructor never special-cases their absence.
  if (!bus) throw new Error('createLeash requires bus');
  if (!config) throw new Error('createLeash requires config');
  if (!identity || typeof identity.checkBoundary !== 'function') {
    throw new Error('createLeash requires identity with checkBoundary() — inject a stub until Phase 8 ships, never omit this dependency');
  }
  if (!auditWriter || typeof auditWriter.write !== 'function') {
    throw new Error('createLeash requires auditWriter with write() — pass memory.audit');
  }
  if (!goals || typeof goals.get !== 'function') {
    throw new Error('createLeash requires goals with get() — needed to read per-goal T3 grants');
  }
  if (!effectors || typeof effectors.get !== 'function') {
    throw new Error('createLeash requires effectors with get() — inject a stub until Phase 7 ships, never omit this dependency');
  }

  var confirmRegistry = createConfirmRegistry({ config: config });

  // Builds the Audit Trail schema entry (MYTHOS-ARCHITECTURE.md §9) and writes it.
  // Fields NOT set here (id, ts, actor) are auto-filled by memory/audit-writer.js.
  //
  // CROSS-PHASE FIX (consistency pass, P5 vs P9): P9's server/index.js subscribes
  // to 'audit.decision' (exact string, dot-prefixed — matches the bus taxonomy's
  // first-dot-segment=channel rule, channel 'audit') to relay live decisions to
  // the Audit view. writeAudit() must emit it, in addition to (not instead of)
  // the durable auditWriter.write() below — the write is the record, the emit is
  // the live-tail signal for the UI.
  function writeAudit(action, goalId, tier, decision, extra) {
    var entry = Object.assign({
      goalId: goalId || null,
      traceId: action.traceId || null,   // see Ambiguity #9 — no real source yet
      tool: action.tool,
      args: action.args || {},
      tier: tier,
      decision: decision,
      granted: false,
      outcome: null,
      boundaryHit: null
    }, extra || {});
    var writeResult = auditWriter.write(entry);
    bus.emit('audit.decision', entry);
    return writeResult;
  }

  // FAIL-CLOSED: T>=3 if the audit line couldn't be written, deny regardless of
  // what was otherwise decided. T0-T2 continue without audit (fail-open for
  // reads/local-writes) — exact policy text from the Audit Trail section.
  function failClosedIfUnwritable(tier, writeResult, decision) {
    if (tier >= 3 && writeResult && writeResult.ok === false) {
      return { allow: false, requireConfirm: false, tier: tier, reason: 'audit-unwritable-fail-closed' };
    }
    return decision;
  }

  function check(action, goalCtx) {
    var toolName = action.tool;
    var args = action.args || {};
    var tier = TIER_TABLE[toolName];  // static tier — undefined for unknown tools

    // Args-aware override (e.g., pipeline_advance with reject). effectors.get()
    // returns undefined for any tool Phase 7 hasn't registered yet — that is the
    // safe default; the override can only RAISE tier, never lower it.
    var effector = effectors.get(toolName);
    if (effector && typeof effector.dangerWhen === 'function' && effector.dangerWhen(args)) {
      tier = Math.max(tier === undefined ? 3 : tier, 3);  // guard vs. NaN — Ambiguity #6
    }

    // DRY RUN -> T>=1 becomes logged no-op. Read config.MYTHOS_DRY_RUN live,
    // every call — never cached at createLeash() construction time.
    if (config.MYTHOS_DRY_RUN && tier >= 1) {
      var dryRunWrite = writeAudit(action, goalCtx && goalCtx.goalId, tier, 'dry-run', { reason: 'dry-run' });
      return failClosedIfUnwritable(tier, dryRunWrite, { allow: false, requireConfirm: false, tier: tier, reason: 'dry-run' });
    }

    // 1. Boundaries DENY (absolute blocks from boundaries.md / identity stub)
    var boundaryHit = identity.checkBoundary(toolName, args);
    if (boundaryHit) {
      var denyWrite = writeAudit(action, goalCtx && goalCtx.goalId, tier, 'deny', { boundaryHit: boundaryHit, reason: boundaryHit });
      return failClosedIfUnwritable(tier, denyWrite, { allow: false, requireConfirm: false, tier: tier, reason: boundaryHit });
    }

    // 2. Unknown tool -> T3 fail-safe
    if (tier === undefined) tier = 3;

    // 3. Below maxTier -> auto-allow. Read config.AUTONOMOUS_MAX_TIER live, every
    // call — never cache at construction time (same bug class as D-46). No `|| 2`
    // fallback: the config schema already guarantees a validated 0-4 number.
    var maxTier = config.AUTONOMOUS_MAX_TIER;
    if (tier <= maxTier) {
      var allowWrite = writeAudit(action, goalCtx && goalCtx.goalId, tier, 'allow', { reason: 'within-autonomous-max' });
      return failClosedIfUnwritable(tier, allowWrite, { allow: true, requireConfirm: false, tier: tier, reason: 'within-autonomous-max' });
    }

    // 4. T3 -> check per-goal grant (goal.grants['3'], set by goals.grantTier()).
    // Grant dies with the goal record itself — no separate expiry bookkeeping.
    if (tier === 3) {
      var goal = (goalCtx && goalCtx.goalId) ? goals.get(goalCtx.goalId) : null;
      if (goal && goal.grants && goal.grants['3']) {
        var grantedWrite = writeAudit(action, goalCtx.goalId, tier, 'allow', { granted: true, reason: 'goal-granted' });
        return failClosedIfUnwritable(tier, grantedWrite, { allow: true, requireConfirm: false, tier: tier, reason: 'goal-granted' });
      }
      var confirm3Write = writeAudit(action, goalCtx && goalCtx.goalId, tier, 'confirm', { reason: 'tier-3-requires-confirm' });
      return failClosedIfUnwritable(tier, confirm3Write, { allow: false, requireConfirm: true, tier: tier, reason: 'tier-3-requires-confirm' });
    }

    // 5. T4 -> always confirm, never cached
    var confirm4Write = writeAudit(action, goalCtx && goalCtx.goalId, tier, 'confirm', { reason: 'tier-4-always-confirm' });
    return failClosedIfUnwritable(tier, confirm4Write, { allow: false, requireConfirm: true, tier: tier, reason: 'tier-4-always-confirm' });
  }

  return {
    check: check,
    confirm: confirmRegistry
  };
}

module.exports = { createLeash };
```

### `src/core/config/schema.js` (modified — add one key)

```js
'use strict';

// MYTHOS Phase 0 config schema
// Keys: type, default, min?, max?, enum?, bool?, required?
// validate() in index.js reads this to coerce + validate raw env

const SCHEMA = {
  // MYTHOS entity
  MYTHOS_NAME:              { type: 'string', default: 'MYTHOS' },
  MYTHOS_PORT:              { type: 'number', default: 4478, min: 1024, max: 65535 },
  MYTHOS_BIND:              { type: 'string', default: '127.0.0.1' },
  MYTHOS_VAULT_ROOT:        { type: 'string', default: './vault' },
  MYTHOS_TICK_MS:           { type: 'number', default: 1000, min: 100, max: 60000 },
  MYTHOS_IDLE_SALIENCE:     { type: 'number', default: 0.3, min: 0, max: 1 },
  MYTHOS_DRY_RUN:           { type: 'bool',  default: false },

  // Logging
  LOG_LEVEL:                 { type: 'string', default: 'info', enum: ['debug', 'info', 'warn', 'error'] },

  // NOVA passthrough (brain providers)
  OLLAMA_URL:               { type: 'string', default: 'http://localhost:11434' },
  GROQ_API_KEY:             { type: 'string', default: '' },
  MISTRAL_API_KEY:          { type: 'string', default: '' },
  NIM_API_KEY:              { type: 'string', default: '' },
  ZCODE_API_KEY:            { type: 'string', default: '' },

  // Brain
  REFLECT_EVERY:            { type: 'number', default: 60, min: 1 },
  CONSOLIDATE_EVERY:        { type: 'number', default: 300, min: 1 },
  EPISODIC_RETENTION_DAYS:  { type: 'number', default: 30, min: 1 },
  CHAIN_COOLDOWN_MS:        { type: 'number', default: 60000, min: 1000 },
  MODEL_REGISTRY_TTL_MS:    { type: 'number', default: 300000, min: 10000 },

  // Autonomy
  AUTONOMOUS_MAX_TIER:      { type: 'number', default: 2, min: 0, max: 4 },
  GOAL_TOKEN_BUDGET:        { type: 'number', default: 20000, min: 0 },
  GOAL_ACTION_BUDGET:       { type: 'number', default: 25, min: 0 },
  MAX_ACTIVE_GOALS:         { type: 'number', default: 5, min: 1, max: 20 },
  CURIOSITY_MIN_INTERVAL_MS: { type: 'number', default: 600000, min: 0 },

  // Leash (Phase 5 — NEW)
  LEASH_CONFIRM_TTL_MS:     { type: 'number', default: 30000, min: 1000 },

  // Immune
  STALL_MS:                 { type: 'number', default: 5000, min: 1000 },
  WATCHDOG_MS:              { type: 'number', default: 2000, min: 500 },
  BREAKER_FAIL_THRESHOLD:   { type: 'number', default: 3, min: 1 },
  BREAKER_WINDOW_MS:        { type: 'number', default: 30000, min: 1000 },
  BREAKER_RESET_MS:         { type: 'number', default: 15000, min: 1000 },

  // Bus
  BUS_HISTORY_SIZE:          { type: 'number', default: 500, min: 10 },
  BUS_STORM_MAX:            { type: 'number', default: 400, min: 10 },
};

module.exports = { SCHEMA };
```

### `src/main.js` (modified — boot wiring)

This reproduces the full boot sequence so the file is complete and runnable. Steps marked `[Phase 4.5]` are inherited from the pre-P5 fix pass (assumed already closed per the task's instructions) and reproduced only for context — this PR does not re-litigate them. Steps marked `[Phase 5 — NEW]` are this phase's actual changes: the `identity`/`effectors` stubs, the `leash` construction, and passing `leash` into `createCortex`.

```js
'use strict';

// MYTHOS boot sequence. Phase 5 (Leash) adds: identity stub (until Phase 8),
// effectors stub (until Phase 7), leash construction, and wires leash into the
// cortex construction call. Construction order is identity -> goals -> effectors
// -> leash -> cortex — this deviates from §13's literal step-position numbers
// (see "Spec Ambiguities Resolved" #5) because leash's constructor deps
// (identity, goals, effectors) must all exist first.

require('dotenv').config();   // [Phase 4.5 / D-02]

const path = require('path');
const fs = require('fs');
const { createLogger } = require('./core/logger');
const { createBus } = require('./core/bus');
const { loadConfig } = require('./core/config');
const { createLifecycle } = require('./core/lifecycle');
const { createMemory } = require('./core/memory');
const { createBrain } = require('./core/brain');
const { createGoalSystem } = require('./core/goals');
const { createCortex } = require('./core/cortex');
const { createLeash } = require('./core/leash');   // [Phase 5 — NEW]

// --- Temporary stubs for modules that ship in later phases ------------------
// Lesson #3: gating must be MANDATORY, never "if dependency present" — every
// module that requires a not-yet-shipped collaborator gets a real (if minimal)
// object injected here, not a runtime `if (x && typeof x.fn === 'function')`
// guard inside the module itself. Deleted wholesale — not patched — the day the
// real phase ships.

function createIdentityStub(ctx) {
  // [TEMP — remove when Phase 8 ships src/core/identity/index.js]
  return {
    init: async function() {},
    checkBoundary: function() { return null; },   // no denies until boundaries.md exists
    persona: function() { return ctx.config.MYTHOS_NAME; }
  };
}

function createEffectorsStub() {
  // [TEMP — remove when Phase 7 ships src/core/effectors/hub.js]
  return {
    get: function() { return undefined; },        // no dangerWhen overrides until Phase 7
    breakers: { allow: function() { return true; } },
    invoke: async function() { return { ok: false, error: 'effectors-not-wired-yet' }; }
  };
}

async function main() {
  // Step 1: Config                                                    [Phase 4.5]
  const configResult = loadConfig();
  if (!configResult.ok) {
    console.error('Config errors:', configResult.errors.join(', '));
    process.exit(1);
  }
  const config = configResult.config;

  // Step 2: Logger                                                    [Phase 4.5]
  const logger = createLogger(config.LOG_LEVEL);

  // Step 3: Bus                                                       [Phase 4.5]
  const bus = createBus({
    historySize: config.BUS_HISTORY_SIZE,
    maxDepth: 32,
    storm: { windowMs: 1000, maxPerWindow: config.BUS_STORM_MAX }
  });

  // Step 4: Vault dirs                                                [Phase 4.5]
  const vaultDirs = ['Episodic', 'Semantic', 'Skills', 'Identity', 'Audit', 'Checkpoints'];
  const vaultRoot = path.resolve(config.MYTHOS_VAULT_ROOT);
  for (let i = 0; i < vaultDirs.length; i++) {
    fs.mkdirSync(path.join(vaultRoot, vaultDirs[i]), { recursive: true });
  }

  // Step 5: Memory (episodic/semantic/skills/audit/checkpoints/working)  [Phase 4.5]
  const memory = createMemory({ config, bus, logger });
  await memory.init();

  // Step 6: Brain                                                     [Phase 4.5]
  const brain = createBrain({ config, bus });

  // Step 7: Identity — [Phase 5 — NEW: stub; Phase 8 replaces this call site]
  const identity = createIdentityStub({ config });
  await identity.init();

  // Step 8: Goals                                                     [Phase 4.5]
  const goals = createGoalSystem({ fs: memory.fs, config, bus, memory, brain });
  await goals.init();

  // Step 9: Effectors — [Phase 5 — NEW: stub; Phase 7 replaces this call site]
  const effectors = createEffectorsStub();

  // Step 10: Leash — [Phase 5 — NEW]
  const leash = createLeash({ bus, config, identity, auditWriter: memory.audit, goals, effectors });

  // Step 11: Cortex — [Phase 5 — NEW: now receives leash+effectors, per the
  // Phase 4.5 D-39 fix createCortex throws at construction if either is missing]
  const cortex = createCortex({ bus, memory, goals, brain, leash, effectors, config });

  // Step 12: Lifecycle
  const lifecycle = createLifecycle({ bus, config, logger });
  lifecycle.setSteps([
    { name: 'config',      fn: function() {}, fail: 'fast' },
    { name: 'logger',      fn: function() {}, fail: 'fast' },
    { name: 'bus',         fn: function() {}, fail: 'fast' },
    { name: 'vault-dirs',  fn: function() {}, fail: 'fast' },
    { name: 'memory',      fn: function() {}, fail: 'fast' },
    { name: 'identity',    fn: function() {}, fail: 'degraded' },
    { name: 'goals',       fn: function() {}, fail: 'degraded' },
    { name: 'leash',       fn: function() {}, fail: 'fast' },   // [Phase 5 — NEW] fail-fast: T>=3 fail-closed depends on audit being live
    { name: 'cortex',      fn: function() {}, fail: 'fast' },
    { name: 'cortex-tick', fn: function() { cortex.start(); }, fail: 'fast' }
  ]);
  lifecycle.registerShutdown();
  await lifecycle.boot();

  logger.info('MYTHOS ALIVE', { name: config.MYTHOS_NAME, port: config.MYTHOS_PORT, pid: process.pid });
  return new Promise(function() { /* never resolves — process stays up */ });
}

main().catch(function(err) {
  console.error('Fatal:', err.message);
  process.exit(1);
});
```

## Integration Points

| Direction | Call | Exact signature (do not paraphrase) | Source |
|---|---|---|---|
| FROM already-shipped → Leash | Cortex's `act()` gate | `leash.check(decision, { goalId: working.activeGoalId })` returning `{allow, requireConfirm, tier, reason}` | `mythos/src/core/cortex/index.js:108-118` (Phase 4.5-fixed: unconditional, throws at construction if `leash` missing per D-39) |
| FROM already-shipped → Leash | Per-goal grant lookup | `goals.get(goalId)` → `goal.grants['3']` (string key `'3'`, boolean) | `mythos/src/core/goals/index.js:52-54`, `:251-256` |
| FROM already-shipped → Leash | Live config reads | `config.AUTONOMOUS_MAX_TIER` (0-4, default 2), `config.MYTHOS_DRY_RUN` (bool) | `mythos/src/core/config/schema.js:35,15` |
| FROM already-shipped → Leash | Audit persistence | `auditWriter.write(entry)` → `{ok:true}` \| `{ok:false, degraded:true}`; injected as `memory.audit` | `mythos/src/core/memory/audit-writer.js:26-48`, `mythos/src/core/memory/index.js:21,30` |
| FROM future (stubbed) → Leash | Danger-args override | `effectors.get(toolName)` → `{dangerWhen(args) → bool}` \| `undefined` | Phase 7 (`src/core/effectors/hub.js`); stubbed in this phase's `main.js` |
| FROM future (stubbed) → Leash | Boundary deny | `identity.checkBoundary(tool, args)` → `string reason` \| `null` | Phase 8 (`src/core/identity/index.js`), spec §11; stubbed in this phase's `main.js` |
| INTO Leash (this phase exposes) | Main gate | `leash.check(action, goalCtx) → {allow, requireConfirm, tier, reason}` | `src/core/leash/index.js` |
| INTO Leash (this phase exposes) | Confirm registry | `leash.confirm.create(summary, action, connectionId)`, `.accept(confirmId, connectionId)`, `.reject(confirmId, connectionId)`, `.peek(confirmId)` | `src/core/leash/index.js`, `src/core/leash/confirm.js` |
| Future INTO Leash | Server confirm-reply handling (Phase 9) | On WS `{type:'confirm-reply', confirmId, accept}`, server calls `leash.confirm.accept(confirmId, connectionId)`; on success + tier 3, calls `goals.grantTier(goalId, 3)`, then re-dispatches through Effectors | Not built in Phase 5 — see Ambiguity #11 |

## Anti-Drift Checklist

1. `TIER_TABLE` keys/values in `tiers.js` match §9's table character-for-character — diff against the doc before merging, don't retype from memory.
2. `leash.check()`'s five decision reasons are exact strings: `'dry-run'`, `'within-autonomous-max'`, `'goal-granted'`, `'tier-3-requires-confirm'`, `'tier-4-always-confirm'`, plus the new `'audit-unwritable-fail-closed'` — never paraphrase these; tests and future UI code will match on them literally.
3. `createLeash` throws synchronously at construction if `bus`, `config`, `identity`, `auditWriter`, `goals`, or `effectors` is missing or lacks the required method — verify with a unit test that asserts the throw, not just happy-path construction.
4. `config.AUTONOMOUS_MAX_TIER` and `config.MYTHOS_DRY_RUN` are read **inside** `check()`, not cached at `createLeash()` call time — grep the diff for `var maxTier =` appearing anywhere outside the `check` function body.
5. `LEASH_CONFIRM_TTL_MS` is added to `config/schema.js`, not hardcoded or read from `process.env` inside `confirm.js` — grep `confirm.js` for `process.env`; there should be none.
6. `leash/audit-writer.js` remains a one-line re-export — if a future PR adds logic to it, that's a sign someone is duplicating `memory/audit-writer.js` instead of extending it; stop and reconsider.
7. Every `auditWriter.write()` call site in `check()` is followed by `failClosedIfUnwritable()` — grep for `writeAudit(` calls not wrapped by that helper.
8. The `identity` and `effectors` stubs in `main.js` are commented `[TEMP — remove when Phase N ships]` and are replaced wholesale (delete the stub function + its call site, not patched) when Phase 7/8 land — do not leave both a stub and a real implementation coexisting behind a conditional.
9. `cortex/index.js`'s `createCortex` must already throw at construction if `leash` or `effectors` is missing (Phase 4.5 D-39) — if this phase's integration test can construct a working Cortex with `leash: undefined`, Phase 4.5 wasn't actually closed; stop and fix that first rather than working around it here.
10. `goal.grants['3']` uses the **string** key `'3'`, matching `goals.grantTier(id, tier)`'s `goal.grants[String(tier)] = true` — do not switch to a numeric key anywhere in Leash.
11. `main.js`'s boot order is identity → goals → effectors → leash → cortex, not the literal §13 position numbers — this is intentional (Ambiguity #5), don't "fix" it back to match the doc.

## Test Plan

Maps to the Phase 5 Gate: *tier0 auto, tier4 always, tier3 once, dry-run no-op, audit line per decision, wrong-connection cannot accept.*

`mythos/test/leash.test.js`, in the house style (`node:test`, `var`, a `fakeBus()` built on the real `createBus`, real collaborators wherever the Gate calls for a real handoff):

```js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function fakeBus() {
  var { createBus } = require('../src/core/bus');
  return createBus({ historySize: 100 });
}

function fakeConfig(overrides) {
  return Object.assign({
    AUTONOMOUS_MAX_TIER: 2,
    MYTHOS_DRY_RUN: false,
    LEASH_CONFIRM_TTL_MS: 30000
  }, overrides);
}

function noopIdentity() {
  return { checkBoundary: function() { return null; } };
}

function noopEffectors() {
  return { get: function() { return undefined; } };
}

function recordingAuditWriter(behavior) {
  var writes = [];
  return {
    write: function(entry) {
      writes.push(entry);
      return behavior ? behavior(entry) : { ok: true };
    },
    _writes: function() { return writes; }
  };
}

describe('leash/index — tier gates', function() {
  it('T0 tools auto-allow, no confirm', function() {
    var { createLeash } = require('../src/core/leash');
    var leash = createLeash({
      bus: fakeBus(), config: fakeConfig(), identity: noopIdentity(),
      auditWriter: recordingAuditWriter(), goals: { get: function() { return null; } },
      effectors: noopEffectors()
    });
    var result = leash.check({ tool: 'read_file', args: {} }, { goalId: null });
    assert.equal(result.allow, true);
    assert.equal(result.requireConfirm, false);
    assert.equal(result.tier, 0);
  });

  it('T4 always requires confirm, even with a matching grant', function() {
    var { createLeash } = require('../src/core/leash');
    var goal = { id: 'goal-1', grants: { '4': true } };
    var leash = createLeash({
      bus: fakeBus(), config: fakeConfig(), identity: noopIdentity(),
      auditWriter: recordingAuditWriter(), goals: { get: function() { return goal; } },
      effectors: noopEffectors()
    });
    var result = leash.check({ tool: 'kill_session', args: {} }, { goalId: 'goal-1' });
    assert.equal(result.allow, false);
    assert.equal(result.requireConfirm, true);
    assert.equal(result.tier, 4);
    assert.equal(result.reason, 'tier-4-always-confirm');
  });

  it('dry-run makes T>=1 a logged no-op', function() {
    var { createLeash } = require('../src/core/leash');
    var audit = recordingAuditWriter();
    var leash = createLeash({
      bus: fakeBus(), config: fakeConfig({ MYTHOS_DRY_RUN: true }), identity: noopIdentity(),
      auditWriter: audit, goals: { get: function() { return null; } }, effectors: noopEffectors()
    });
    var result = leash.check({ tool: 'create_goal', args: {} }, { goalId: null });
    assert.equal(result.allow, false);
    assert.equal(result.reason, 'dry-run');
    assert.equal(audit._writes()[0].decision, 'dry-run');
  });

  it('writes exactly one audit line per check() call', function() {
    var { createLeash } = require('../src/core/leash');
    var audit = recordingAuditWriter();
    var leash = createLeash({
      bus: fakeBus(), config: fakeConfig(), identity: noopIdentity(),
      auditWriter: audit, goals: { get: function() { return null; } }, effectors: noopEffectors()
    });
    leash.check({ tool: 'read_file', args: {} }, { goalId: null });
    leash.check({ tool: 'launch_app', args: {} }, { goalId: null });
    assert.equal(audit._writes().length, 2);
  });

  it('T>=3 fails closed when the audit write is unwritable', function() {
    var { createLeash } = require('../src/core/leash');
    var brokenAudit = recordingAuditWriter(function() { return { ok: false, degraded: true }; });
    var leash = createLeash({
      bus: fakeBus(), config: fakeConfig(), identity: noopIdentity(),
      auditWriter: brokenAudit, goals: { get: function() { return null; } }, effectors: noopEffectors()
    });
    var result = leash.check({ tool: 'kill_session', args: {} }, { goalId: null }); // T4
    assert.equal(result.allow, false);
    assert.equal(result.reason, 'audit-unwritable-fail-closed');
  });

  it('construction throws if a mandatory dependency is missing', function() {
    var { createLeash } = require('../src/core/leash');
    assert.throws(function() {
      createLeash({ bus: fakeBus(), config: fakeConfig(), auditWriter: recordingAuditWriter(), goals: {}, effectors: noopEffectors() });
    }, /identity/);
    assert.throws(function() {
      createLeash({ bus: fakeBus(), config: fakeConfig(), identity: noopIdentity(), auditWriter: recordingAuditWriter(), effectors: noopEffectors() });
    }, /goals/);
  });
});

describe('leash/confirm — connection scoping (Gate: wrong-connection cannot accept)', function() {
  it('accept from a different connectionId returns null and does not consume the entry', function() {
    var { createConfirmRegistry } = require('../src/core/leash/confirm');
    var registry = createConfirmRegistry({ config: fakeConfig() });
    var confirmId = registry.create('kill the session', { tool: 'kill_session', args: {} }, 'conn-A');
    var result = registry.accept(confirmId, 'conn-B');
    assert.equal(result, null, 'wrong connection must not receive the action');
    var legit = registry.accept(confirmId, 'conn-A');
    assert.ok(legit, 'the owning connection can still accept afterward');
  });
});

// ---------------------------------------------------------------------------
// REAL-INSTANCE INTEGRATION TEST (Lesson #4) — real GoalSystem <-> real Leash.
// Exercises the exact handoff goals.grantTier() -> leash.check() reading
// goal.grants['3'] off a real goal record, not a fake.
// ---------------------------------------------------------------------------

describe('leash <-> goals — real-instance integration (Gate: tier3 once)', function() {
  function fakeFs() {
    var store = {};
    return {
      ensureDir: function() {},
      writeJSON: function(rel, data) { store[rel] = JSON.stringify(data); },
      readJSON: function(rel, fallback) { try { return JSON.parse(store[rel]); } catch (_) { return fallback; } },
      removeFile: function(rel) { delete store[rel]; },
      listFiles: function() { return []; }
    };
  }

  it('T3 tool requires confirm once, then auto-allows after grantTier persists it on the real goal', function() {
    var { createGoalSystem } = require('../src/core/goals');
    var { createLeash } = require('../src/core/leash');

    var bus = fakeBus();
    var goals = createGoalSystem({ fs: fakeFs(), config: fakeConfig(), bus: bus, memory: null, brain: null });
    var goal = goals.create({ title: 'Delete stale draft', drive: 'user-service', status: 'active' });

    var leash = createLeash({
      bus: bus, config: fakeConfig(), identity: noopIdentity(),
      auditWriter: recordingAuditWriter(), goals: goals, effectors: noopEffectors()
    });

    var first = leash.check({ tool: 'delete_goal', args: { id: goal.id } }, { goalId: goal.id });
    assert.equal(first.allow, false);
    assert.equal(first.requireConfirm, true, 'first T3 attempt must require confirm');

    goals.grantTier(goal.id, 3);   // real GoalSystem mutation — persists goal.grants['3']

    var second = leash.check({ tool: 'delete_goal', args: { id: goal.id } }, { goalId: goal.id });
    assert.equal(second.allow, true, 'second attempt after grantTier must auto-allow');
    assert.equal(second.reason, 'goal-granted');
  });
});

// ---------------------------------------------------------------------------
// REAL-INSTANCE INTEGRATION TEST (Lesson #4) — real memory audit-writer <-> real
// Leash, proving the "thin re-export, not a duplicate store" decision (Ambiguity
// #1) actually round-trips through the real append-only-JSONL writer.
// ---------------------------------------------------------------------------

describe('leash <-> memory/audit-writer — real-instance integration', function() {
  it('a leash.check() decision is queryable back out of the real audit-writer', async function() {
    var { createAuditWriter } = require('../src/core/leash/audit-writer'); // re-export path
    var { createLeash } = require('../src/core/leash');

    var appended = [];
    var fakeMemoryFs = {
      appendLine: function(relPath, entry) { appended.push(entry); },
      readDirLines: function() { return appended.slice(); },
      listFiles: function() { return []; },
      ensureDir: function() {},
      vaultPath: function(p) { return p; }
    };
    var audit = createAuditWriter({ fs: fakeMemoryFs, config: fakeConfig(), bus: fakeBus(), logger: { info: function() {}, warn: function() {}, error: function() {} } });
    await audit.init();

    var leash = createLeash({
      bus: fakeBus(), config: fakeConfig(), identity: noopIdentity(),
      auditWriter: audit, goals: { get: function() { return null; } }, effectors: noopEffectors()
    });

    leash.check({ tool: 'launch_app', args: { name: 'notes' } }, { goalId: null });

    var results = audit.query({ tool: 'launch_app' });
    assert.equal(results.length, 1, 'the leash decision must be queryable back out of the SAME writer leash used');
    assert.equal(results[0].decision, 'allow');
    assert.equal(results[0].tier, 2);
  });
});
```

## Do NOT

- Do NOT build a second append-only-JSONL audit implementation in `leash/audit-writer.js` — it is a one-line re-export of `memory/audit-writer.js`, full stop.
- Do NOT let `createLeash` construct successfully with `identity` or `effectors` omitted, or check for their presence with `if (x && typeof x.fn === 'function')` inside `check()` — construction must throw; `main.js` supplies explicit stubs instead.
- Do NOT cache `config.AUTONOMOUS_MAX_TIER` or `config.MYTHOS_DRY_RUN` at `createLeash()` call time — read both fresh inside every `check()` call.
- Do NOT invent a `boundaries.md`-driven tier-ceiling reconciliation in this phase — that's Phase 8's job; Phase 5 reads `config.AUTONOMOUS_MAX_TIER` only.
- Do NOT wire the full WS `confirm-request` → `confirm-reply` → `goals.grantTier()` → re-dispatch round trip in this phase — ship the primitives (`leash.confirm.create/accept/reject/peek`) and unit-test them directly; that orchestration belongs to Phase 7 (Effectors) and Phase 9 (Server).
- Do NOT read `process.env.LEASH_CONFIRM_TTL_MS` (or any env var) directly inside `confirm.js` — the TTL comes from `config.LEASH_CONFIRM_TTL_MS`, a schema key.
- Do NOT reuse NOVA's module-level singleton `Map` pattern from `app/lib/voice/confirm.js` verbatim — it must be wrapped in a `createConfirmRegistry({config})` factory so each `createLeash()` call gets an isolated registry (tests would otherwise leak pending confirms across test files).
- Do NOT skip the fail-closed check on `auditWriter.write()`'s return value for T>=3 — an unwritable audit line must flip the decision to deny, not silently allow/confirm with no record.
- Do NOT leave `goal.grants` keyed by a number (`3`) instead of the string `'3'` anywhere in Leash — it must match `goals.grantTier()`'s `goal.grants[String(tier)] = true` exactly.
- Do NOT paraphrase any `TIER_TABLE` key, tier number, decision-reason string, or config key name when implementing — copy them character-for-character from this document (which was itself copied character-for-character from MYTHOS-ARCHITECTURE.md §9).

---

# Phase P6 — Immune

## Overview & Why

Phase 6 gives MYTHOS the ability to notice it is breaking and fix itself without a human watching the logs: circuit breakers stop hammering dead providers/effectors, a watchdog notices a stalled cognitive loop, a diagnostician classifies raw anomalies into typed diagnoses, and a healer runs small data-defined playbooks to remediate them — all audited. Without this phase, a single flapping provider or a stuck OODA tick hangs the entity forever with no recovery path, and there is no periodic checkpoint, so a crash loses everything back to the last graceful shutdown (if there ever was one).

This phase also closes two structural gaps that are exposed by trying to actually build Immune for real: (1) the given watchdog/breaker code in the architecture doc has three concrete bugs (a backoff-formula bug, a missing `bus` injection, an async/await omission) that would throw or silently misbehave if copied verbatim, and (2) several of the Healer's SEED_PLAYBOOKS have **no real producer anywhere in shipped code** for the anomaly kind they react to (`provider-down`, `quota-low`, `budget-exhausted`) — meaning, copied literally, three of five playbooks would be permanently dead code. Both are fixed here, explicitly, with reasoning below.

## Directory & File Layout

```
mythos/src/core/immune/
├── breakers.js          NEW  createBreaker + BREAKER_STATES
├── watchdog.js          NEW  createWatchdog — stall DETECTION only
├── diagnostician.js     NEW  createDiagnostician — anomaly → typed diagnosis
├── healer.js            NEW  createHealer + SEED_PLAYBOOKS + DSL evaluator
├── probes.js            NEW  createProbes — status/quota aggregation + anomaly emission
├── announcer.js         NEW  createAnnouncer — speaks health/heal/recovery events
└── monitor.js           NEW  createMonitor (periodic checkpoint + memory-growth) + recoverFromCrash()

mythos/src/core/sensors/
└── metric.js            NEW  createMetricSensor — probes+quota poll every 4s

mythos/src/core/config/
└── schema.js            MODIFY  + CHECKPOINT_EVERY_TICKS

mythos/src/core/goals/
└── index.js             MODIFY  debitBudget() gains one bus.emit('health.anomaly', ...) line

mythos/src/
└── main.js               MODIFY  + 'immune' boot step, watchdog.start() at 'cortex-tick', recovery wiring

mythos/test/
└── immune.test.js        NEW  unit + real-instance integration tests
```

## Spec Ambiguities Resolved

1. **Boot-order dependency inversion.** §13's boot order is `... audit → immune → cortex → ... → goals → ... → cortex-tick`. The given `createWatchdog({cortex, ...})`/healer's `restart-cortex`/`pause-goal` actions assume `cortex`/`goals` already exist at construction — but `immune` is constructed *before* `cortex` and long before `goals`. **Resolution**: `watchdog.js` and `healer.js` take `getCortex()`/`getGoals()` accessor thunks instead of direct references. `main.js` declares `let cortex = null, goals = null;` before the boot-steps array; the `immune` step passes `getCortex: () => cortex, getGoals: () => goals`; the later `cortex`/`goals` steps do a plain assignment (`cortex = createCortex(...)`) into the *same* closed-over binding. `registry.js`/`quota.js`/`spend.js` are plain singleton modules (no factory, no injected state) so they need no such thunk — they're `require()`d directly.

2. **Double-restart bug in the verbatim Watchdog code.** The given `watchdog.js` both emits `health.anomaly{kind:'cortex-stall'}` *and* directly calls `cortex.stop()`/`cortex.start()`. `bus.emit()` dispatches to subscribers **synchronously** (`mythos/src/core/bus/index.js:62-73`, no queueing). Diagnostician subscribes to `health.anomaly` and Healer's `stall-restart` playbook subscribes to the resulting `health.diagnosed` — both fire *inside* the same `emit()` call, before Watchdog's own subsequent `cortex.stop()/start()` lines run. Every stall would restart cortex **twice**, every time. **Resolution**: Watchdog is detection-only (emits the anomaly, nothing else). The actual restart lives exclusively in Healer's `restart-cortex` action, matching the six-component pipeline order (`Watchdog → Diagnostician → Healer → Recovery`) literally instead of having Watchdog short-circuit it.

3. **Breaker backoff formula is wrong as given.** `const nextReset = Math.min(resetAt * 2, now + maxResetMs); resetAt = nextReset;` doubles an **absolute epoch timestamp**, not the backoff *delay* — this is not exponential backoff, it's nonsense once `resetAt` is a large timestamp. **Resolution**: track `currentResetMs` separately, double *that* on each HALF_OPEN failure (capped at `maxResetMs`), and always compute `resetAt = now + currentResetMs`.

4. **Breaker never receives `bus`.** The given `createBreaker({name, failThreshold, windowMs, resetMs, maxResetMs})` calls `bus.emit(...)` inside `recordFailure()` but `bus` is never a parameter — a guaranteed `ReferenceError` the first time any breaker trips. **Resolution**: `bus` (and `config`) become real constructor params. **Forward-compat note for Phase 7**: §12's Effector Hub code calls `createBreaker({name: effector.id})` with no `bus` — Phase 7 must pass `bus`/`config` when it builds the hub, or it reintroduces this exact bug.

5. **`spend.getAllQuotas()` does not exist.** `mythos/src/core/brain/spend.js` exports exactly `{ recordCall, getRecent, getStats, estimate, _reset }`. The real `getAllQuotas(stats)` lives in `mythos/src/core/quota.js:66` and takes `spend.getStats()` as an explicit parameter — it is *not* a method on `spend`. **Resolution**: `probes.js` composes `quota.getAllQuotas(spend.getStats())` itself; nothing else needs to know this seam exists.

6. **`probes.getStatus()`/`registry.getStatus()` are async but the given Metric Sensor pseudocode calls them without `await`**, which would emit a pending `Promise` object as the perception payload. **Resolution**: `sensors/metric.js`'s timer callback is `async` and awaits `probes.getStatus()`.

7. **`quotas.some(q => q.remainingPercent < 10)` has a null-coercion bug.** For providers with no daily cap (`zcode`, `nim`, `ollama`), `quota.js` sets `remainingPercent: null`. In JS, `null < 10` is `true` (null coerces to 0) — every uncapped provider would falsely trip "low quota" on every poll. **Resolution**: `!q.unlimited && q.remainingPercent !== null && q.remainingPercent < 10`.

8. **No producer exists anywhere for `provider-down`/`quota-low` `health.anomaly` events**, so `rotate-nim-key` and `quota-guard` could never fire. **Resolution**: `probes.js`'s `getStatus()` — already computing this data every 4s for the metric sensor — also emits these anomalies as a documented side effect. It intentionally does **not** deduplicate; Healer's per-playbook `cooldownMs` is the only heal-storm suppressor, exactly per the spec's own comment ("per-playbook cooldown kills heal storms").

9. **No producer exists for `budget-exhausted`.** `goals/index.js`'s `debitBudget()` already self-pauses a goal synchronously on exhaustion (correct, fast) but never touches the `health` channel, so `budget-pause` could never fire and the healer never gets an audited record of the pause. **Resolution**: one line added to `debitBudget()` — `bus.emit('health.anomaly', { kind: 'budget-exhausted', ... })` — and Healer's `pause-goal` action is made **idempotent** (no-ops if the goal is already paused) so the fast synchronous path and the eventual audited heal never race destructively.

10. **No config key exists for the checkpoint cadence** ("checkpoint every N ticks" is a Gate criterion but `config/schema.js` has nothing for it). **Resolution**: added `CHECKPOINT_EVERY_TICKS` (default 50) to schema.js, under the existing `// Immune` block.

11. **"Rotate NIM key" has no literal implementation target.** `registry.js` has no selective per-provider refresh and no live key-swap capability. **Resolution**: `probe-provider` calls the real `registry.refresh(true)` (full forced re-probe) — NIM's actual key rotation is already structural in `chain.js`'s `expand()`, which fans a `nim` registry entry out to both `nim`/`nim2` lanes per configured key.

12. **"Degrade lane" has no literal implementation target.** **Resolution**: uses the real, already-shipped seam — `registry.js:128`'s `parseOverride(process.env[table.env])`, read fresh on every `chainFor()` call. `degrade-lane` filters the lane's static preference table and writes a serialized override string (`"provider:model,provider:model"`) into `process.env[table.env]` (e.g. `CHAIN_VOICE`).

13. **`playbookLookup(anomaly.kind)` can't disambiguate target-qualified playbooks.** `diagnose()`'s `suggestedAction` is kind-only, so it can't tell `rotate-nim-key` (target `nim`) apart from a hypothetical second `provider-down` playbook. **Resolution**: documented as an informational hint only. Healer performs the authoritative match independently via a generic recursive matcher (`matchClause`) that has to support two different shapes actually present in SEED_PLAYBOOKS: leaf operators (`{eq:'nim'}`) applied directly to `anomaly.target`, and nested-field operators (`{bytes:{gt:50000000}}`) applied to `anomaly.target.bytes`.

14. **Perception field-name mismatch.** §12's Perception Envelope and ROADMAP.md's own D-40 fix note both say sensors emit `salienceHint`, but the real, already-shipped consumer (`mythos/src/core/cortex/ooda.js:14`, `orient()`) reads `p.salience`. Using `salienceHint` would silently zero every sensor's contribution to salience ranking. **Resolution**: `sensors/metric.js` emits `.salience` (matching the real consumer), not `.salienceHint`. This is called out explicitly rather than copied from the doc's prose.

15. **No adapter bridges *any* bus perception event into `working.pushPerception()`.** Confirmed by repo-wide search: zero call sites outside tests. This affects the already-shipped timer sensor equally, is not gated by this phase's Gate criteria, and is explicitly **out of scope** here — flagged for whoever owns the generic sensor→cortex bridge (Phase 7 / the assumed-fixed `main.js` `'sensors'` step), rather than papered over with a one-off bridge inside `metric.js` alone that would diverge from however every other sensor eventually gets bridged.

16. **Recovery has no dedicated file.** The Phase 6 deliverable list is `{monitor,breakers,watchdog,diagnostician,healer,announcer,probes}.js` — no `recovery.js`. §10's Recovery algorithm is a one-shot boot-time function, not a running component. **Resolution**: exported as `recoverFromCrash()` from `monitor.js`, since monitor already owns the checkpoint/continuity concern end-to-end (write path at runtime, read path at boot).

17. **Sensor interface mismatch.** §12 states "All sensors implement: `start(emit) → stop()`", but the real shipped `sensors/timer.js` implements `start()` with **no** `emit` parameter — it closures over an injected `bus` and calls `bus.emit()` directly. **Resolution**: `sensors/metric.js` follows the real precedent (`createMetricSensor({bus, config, probes})` → `{start, stop}`, `start()` takes no args), not the doc's abstract interface comment.

18. **`maxResetMs` has no config schema key** (unlike `failThreshold`/`windowMs`/`resetMs`, which do). Kept as a factory-default literal (`300000`), not sourced from config — inventing an unrequested schema key would violate YAGNI.

19. **Memory-growth threshold appears twice with no shared source.** `healer.js`'s `mem-consolidate` playbook hardcodes `gt: 50000000` inside pure playbook *data*; `monitor.js`'s emitter needs the identical number in *code*. They cannot share a literal without breaking "playbooks are data, no code eval." **Resolution**: both declare the same literal `50000000` with cross-referencing comments, and `immune.test.js` asserts they stay numerically equal (regression guard against future drift).

## Full Code

### `mythos/src/core/immune/breakers.js`

```js
'use strict';

// immune/breakers.js — per-target circuit breaker FSM.
// CLOSED -> (>= failThreshold fails within windowMs) -> OPEN -> (resetMs, x2 backoff,
// cap maxResetMs) -> HALF_OPEN -> success -> CLOSED.
//
// One instance per effector or per provider; the *caller* owns the Map of instances
// (Phase 7's effector hub owns per-effector breakers; immune/probes.js does not keep
// its own breaker instances in Phase 6 — see Spec Ambiguities Resolved #4 for why
// providers are monitored via probes.js's health.anomaly emission instead).
//
// bus and config are REQUIRED — the given architecture-doc code calls bus.emit()
// inside recordFailure() without ever taking `bus` as a parameter, which is a
// guaranteed ReferenceError. Do not construct a breaker without both.

const BREAKER_STATES = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half-open' };

function createBreaker({ name, bus, config, failThreshold, windowMs, resetMs, maxResetMs }) {
  if (!bus) throw new Error('createBreaker requires bus');
  if (!name) throw new Error('createBreaker requires name');

  // Config is read, not re-defaulted (BREAKER_FAIL_THRESHOLD / BREAKER_WINDOW_MS /
  // BREAKER_RESET_MS are real schema.js keys). maxResetMs has no schema key — see
  // Spec Ambiguities Resolved #18 — so it stays a literal default.
  const FAIL_THRESHOLD = failThreshold || (config && config.BREAKER_FAIL_THRESHOLD) || 3;
  const WINDOW_MS = windowMs || (config && config.BREAKER_WINDOW_MS) || 30000;
  const RESET_MS = resetMs || (config && config.BREAKER_RESET_MS) || 15000;
  const MAX_RESET_MS = maxResetMs || 300000;

  let state = BREAKER_STATES.CLOSED;
  let failCount = 0;
  let lastFailAt = 0;
  let resetAt = 0;
  let currentResetMs = RESET_MS;
  let halfOpenAttempts = 0;

  function allow() {
    const now = Date.now();
    if (state === BREAKER_STATES.CLOSED) return true;

    if (state === BREAKER_STATES.OPEN) {
      if (now >= resetAt) {
        state = BREAKER_STATES.HALF_OPEN;
        halfOpenAttempts = 0;
        return true; // allow exactly one probe
      }
      return false; // caller must synthesize { ok:false, result:'circuit-open' } itself
    }

    if (state === BREAKER_STATES.HALF_OPEN) {
      halfOpenAttempts++;
      return halfOpenAttempts <= 1; // only one probe in half-open
    }
    return false;
  }

  function recordSuccess() {
    if (state === BREAKER_STATES.HALF_OPEN) {
      state = BREAKER_STATES.CLOSED; // recovered
      currentResetMs = RESET_MS;     // backoff resets on real recovery
    }
    failCount = 0;
  }

  function recordFailure() {
    const now = Date.now();
    if (now - lastFailAt > WINDOW_MS) failCount = 0;
    lastFailAt = now;
    failCount++;

    if (state === BREAKER_STATES.HALF_OPEN) {
      // Probe failed -> back to OPEN with exponential backoff on the DELAY, not the
      // absolute timestamp (see Spec Ambiguities Resolved #3).
      currentResetMs = Math.min(currentResetMs * 2, MAX_RESET_MS);
      resetAt = now + currentResetMs;
      state = BREAKER_STATES.OPEN;
      return;
    }

    if (failCount >= FAIL_THRESHOLD) {
      currentResetMs = RESET_MS; // fresh trip restarts backoff at the base delay
      state = BREAKER_STATES.OPEN;
      resetAt = now + currentResetMs;
      // 'health.anomaly' — exact string, do not paraphrase.
      bus.emit('health.anomaly', { kind: 'effector-flapping', target: name, failCount: failCount, state: state });
    }
  }

  return {
    get state() { return state; },
    get stats() { return { name: name, state: state, failCount: failCount, resetAt: resetAt }; },
    allow: allow,
    recordSuccess: recordSuccess,
    recordFailure: recordFailure
  };
}

module.exports = { createBreaker: createBreaker, BREAKER_STATES: BREAKER_STATES };
```

### `mythos/src/core/immune/watchdog.js`

```js
'use strict';

// immune/watchdog.js — detects a stalled cortex OODA loop. DETECTION ONLY.
//
// Independent 2s unref'd timer reads cortex.lastTickAt.value directly — no bus
// round-trip for detection, so it still works if the bus itself is degraded.
//
// This module does NOT restart cortex itself (see Spec Ambiguities Resolved #2):
// bus.emit() dispatches to subscribers synchronously, so if this file also called
// cortex.stop()/cortex.start(), every stall would restart cortex twice (once via the
// health.anomaly -> health.diagnosed -> healer 'stall-restart' pipeline, once again
// right here). The actual restart lives in healer.js's 'restart-cortex' action.
//
// getCortex is a thunk, not a direct reference: the boot order builds 'immune' before
// 'cortex' exists (§13), so this module is constructed before cortex is. main.js
// closes getCortex over a `let cortex` binding that the later 'cortex' boot step
// assigns into (see Spec Ambiguities Resolved #1).

function createWatchdog({ getCortex, bus, config }) {
  if (typeof getCortex !== 'function') throw new Error('createWatchdog requires getCortex()');
  if (!bus) throw new Error('createWatchdog requires bus');

  const STALL_MS = (config && config.STALL_MS) || 5000;   // config.STALL_MS — exact key, do not paraphrase
  const CHECK_MS = (config && config.WATCHDOG_MS) || 2000; // config.WATCHDOG_MS — exact key, do not paraphrase

  let timer = null;

  function check() {
    const cortex = getCortex();
    if (!cortex) return; // cortex not constructed yet (early in boot) — nothing to watch

    const elapsed = Date.now() - cortex.lastTickAt.value;
    if (elapsed > STALL_MS) {
      // 'health.anomaly' — exact string, do not paraphrase.
      bus.emit('health.anomaly', { kind: 'cortex-stall', elapsed: elapsed, lastTickAt: cortex.lastTickAt.value });
    }
  }

  function start() {
    timer = setInterval(check, CHECK_MS);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start: start, stop: stop, _internal: { check: check } };
}

module.exports = { createWatchdog: createWatchdog };
```

### `mythos/src/core/immune/diagnostician.js`

```js
'use strict';

// immune/diagnostician.js — classifies raw 'health.anomaly' events into typed
// diagnoses and re-emits 'health.diagnosed'. Both strings are exact, do not paraphrase.
// Subscribes to EVERY 'health.anomaly' event, including ones with no matching
// playbook (e.g. 'causal-loop', already emitted by bus/index.js's own depth guard) —
// diagnosis + audit trail exist independent of whether an automated heal is possible.

const { SEED_PLAYBOOKS } = require('./healer');

const SEVERITY = {
  'cortex-stall':       'critical',
  'causal-loop':        'critical',
  'provider-down':      'major',
  'effector-flapping':  'major',
  'budget-exhausted':   'major',
  'event-storm':        'major',
  'tick-overrun':       'minor',
  'memory-growth':      'minor',
  'quota-low':          'minor'
};

function severityOf(kind) {
  return SEVERITY[kind] || 'minor';
}

// Best-effort hint only (kind-only match). Healer performs the authoritative,
// target-aware match against the full diagnosis independently — see Spec
// Ambiguities Resolved #13.
function playbookLookup(kind) {
  const hit = SEED_PLAYBOOKS.find(function(p) { return p.when.kind === kind; });
  return hit ? hit.id : null;
}

function diagnose(anomaly) {
  anomaly = anomaly || {};
  return {
    kind: anomaly.kind,
    target: anomaly.target,
    evidence: anomaly,
    severity: severityOf(anomaly.kind),
    suggestedAction: playbookLookup(anomaly.kind)
  };
}

function createDiagnostician({ bus }) {
  if (!bus) throw new Error('createDiagnostician requires bus');

  function onAnomaly(event) {
    const diagnosis = diagnose(event.payload);
    // 'health.diagnosed' — exact string, do not paraphrase.
    bus.emit('health.diagnosed', diagnosis);
  }

  let unsubscribe = null;

  function start() {
    unsubscribe = bus.subscribe('health.anomaly', onAnomaly);
  }

  function stop() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  }

  return { start: start, stop: stop, diagnose: diagnose, severityOf: severityOf, playbookLookup: playbookLookup };
}

module.exports = { createDiagnostician: createDiagnostician, diagnose: diagnose, severityOf: severityOf, playbookLookup: playbookLookup };
```

### `mythos/src/core/immune/healer.js`

```js
'use strict';

// immune/healer.js — playbook-driven auto-remediation. Playbooks are DATA, never
// code eval. Per-playbook cooldownMs is the ONLY de-duplication mechanism: upstream
// producers (probes.js, watchdog.js) are allowed — expected — to re-emit the same
// anomaly on every poll; cooldown is what keeps that from becoming a heal storm.

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
    // 50000000 must equal monitor.js's MEMORY_GROWTH_BYTES — see Spec Ambiguities
    // Resolved #19; immune.test.js asserts the two literals stay in sync.
    when: { kind: 'memory-growth', target: { bytes: { gt: 50000000 } } },
    then: [{ do: 'consolidate-memory' }],
    cooldownMs: 600000
  },
  {
    id: 'budget-pause',
    when: { kind: 'budget-exhausted' },
    then: [{ do: 'pause-goal', args: { reason: 'budget-exhausted' } }],
    cooldownMs: 0 // no cooldown — immediate, every time
  }
];

// ---------------------------------------------------------------------------
// DSL evaluator — equality + lt/gt + nested-field matching (Spec Ambiguities #13)
// ---------------------------------------------------------------------------

function matchClause(clause, value) {
  if (clause === undefined) return true; // an absent `when.target` matches any target
  if (clause !== null && typeof clause === 'object' && !Array.isArray(clause)) {
    if ('eq' in clause) return value === clause.eq;
    if ('lt' in clause) return typeof value === 'number' && value < clause.lt;
    if ('gt' in clause) return typeof value === 'number' && value > clause.gt;
    // Otherwise every key is a nested field name on `value` — recurse.
    for (const key in clause) {
      const nested = value && typeof value === 'object' ? value[key] : undefined;
      if (!matchClause(clause[key], nested)) return false;
    }
    return true;
  }
  return value === clause;
}

function matches(playbook, diagnosis) {
  if (playbook.when.kind !== diagnosis.kind) return false;
  return matchClause(playbook.when.target, diagnosis.target);
}

// $-prefixed string args resolve against the diagnosis via dotted path, e.g.
// '$target' -> diagnosis.target. None of the SEED_PLAYBOOKS above use this — it
// exists for future playbooks and is covered by a dedicated unit test.
function getPath(obj, dottedPath) {
  return dottedPath.split('.').reduce(function(acc, key) {
    return acc && typeof acc === 'object' ? acc[key] : undefined;
  }, obj);
}

function resolveArgs(args, diagnosis) {
  const out = {};
  const source = args || {};
  for (const key in source) {
    const v = source[key];
    out[key] = (typeof v === 'string' && v.charAt(0) === '$') ? getPath(diagnosis, v.slice(1)) : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Action implementations
// ---------------------------------------------------------------------------

function buildActions({ getCortex, getGoals, memory }) {
  const registry = require('../brain/registry');
  const { BRAIN_TABLES } = require('../brain/lanes.default');

  return {
    // registry.js has no selective per-provider refresh and no live key-swap
    // capability — NIM's own two-key rotation is already structural in chain.js's
    // expand(). The real, honest action is a full forced re-probe (Spec Ambiguities #11).
    'probe-provider': async function() {
      const status = await registry.refresh(true);
      return { ok: true, result: { probedAt: status.at } };
    },

    'restart-cortex': async function() {
      const cortex = getCortex && getCortex();
      if (!cortex) return { ok: false, reason: 'missing-dependency:cortex' };
      // Pause the active goal BEFORE restarting — cortex.stop()/start() bumps
      // generation but does not touch goal state; recovery invariant #2 (§13)
      // requires the interrupted goal to be marked, not silently re-arbitrated
      // as if nothing happened.
      const goals = getGoals && getGoals();
      const activeGoal = goals && typeof goals.getActive === 'function' ? goals.getActive() : null;
      if (activeGoal) {
        goals.update(activeGoal.id, { status: 'paused', reason: 'cortex-restart' });
      }
      cortex.stop();
      cortex.start();
      return { ok: true, result: { generation: cortex.generation, pausedGoalId: activeGoal ? activeGoal.id : null } };
    },

    // Real mutable seam: registry.js's per-lane env override, read fresh on every
    // chainFor() call (Spec Ambiguities #12).
    'degrade-lane': async function(diagnosis, args) {
      const table = BRAIN_TABLES[args.lane];
      if (!table) return { ok: false, reason: 'unknown-lane:' + args.lane };
      const kept = table.prefs.filter(function(p) { return p.provider !== args.removeProvider; });
      const override = kept.map(function(p) { return p.provider + ':' + p.model; }).join(',');
      process.env[table.env] = override;
      return { ok: true, result: { lane: args.lane, removed: args.removeProvider, override: override } };
    },

    'consolidate-memory': async function() {
      if (!memory || typeof memory.consolidate !== 'function') {
        return { ok: false, reason: 'missing-dependency:memory' };
      }
      const stats = await memory.consolidate({});
      return { ok: true, result: stats };
    },

    // Idempotent: goals/index.js's debitBudget() already self-pauses synchronously
    // on budget exhaustion (Spec Ambiguities #9) — this confirms/audits, never
    // double-transitions.
    'pause-goal': async function(diagnosis, args) {
      const goals = getGoals && getGoals();
      if (!goals) return { ok: false, reason: 'missing-dependency:goals' };
      const goalId = diagnosis.target;
      const goal = goals.get(goalId);
      if (!goal) return { ok: false, reason: 'unknown-goal:' + goalId };
      if (goal.status !== 'paused') {
        goals.update(goalId, { status: 'paused', reason: args.reason || 'healer-pause' });
      }
      return { ok: true, result: { goalId: goalId, reason: args.reason || 'healer-pause' } };
    }
  };
}

// ---------------------------------------------------------------------------
// Healer
// ---------------------------------------------------------------------------

function createHealer({ bus, config, memory, getCortex, getGoals, playbooks }) {
  if (!bus) throw new Error('createHealer requires bus');

  const ACTIONS = buildActions({ getCortex: getCortex, getGoals: getGoals, memory: memory });
  const activePlaybooks = playbooks || SEED_PLAYBOOKS;
  const lastFiredAt = {}; // playbook.id -> ts

  async function applyPlaybook(playbook, diagnosis) {
    let outcome = 'applied';
    let detail = null;
    try {
      for (let i = 0; i < playbook.then.length; i++) {
        const step = playbook.then[i];
        const action = ACTIONS[step.do];
        if (!action) { outcome = 'error'; detail = { reason: 'unknown-action:' + step.do }; break; }
        const args = resolveArgs(step.args, diagnosis);
        const result = await action(diagnosis, args);
        if (!result || !result.ok) { outcome = 'error'; detail = result; break; }
        detail = result.result;
      }
    } catch (err) {
      outcome = 'error';
      detail = { error: err.message };
    }
    return { outcome: outcome, detail: detail };
  }

  async function onDiagnosed(event) {
    const diagnosis = event.payload;
    const playbook = activePlaybooks.find(function(p) { return matches(p, diagnosis); });

    let outcome, detail, playbookId;
    if (!playbook) {
      outcome = 'no-match';
      detail = null;
      playbookId = null;
    } else {
      playbookId = playbook.id;
      const now = Date.now();
      const lastFired = lastFiredAt[playbook.id] || 0;
      if (playbook.cooldownMs > 0 && now - lastFired < playbook.cooldownMs) {
        outcome = 'cooldown';
        detail = { remainingMs: playbook.cooldownMs - (now - lastFired) };
      } else {
        lastFiredAt[playbook.id] = now;
        const applied = await applyPlaybook(playbook, diagnosis);
        outcome = applied.outcome;
        detail = applied.detail;
      }
    }

    // 'health.healed' — exact string, do not paraphrase.
    bus.emit('health.healed', { playbookId: playbookId, kind: diagnosis.kind, target: diagnosis.target, outcome: outcome, detail: detail });

    if (memory && memory.audit && typeof memory.audit.write === 'function') {
      memory.audit.write({
        actor: 'healer', decision: 'heal', playbookId: playbookId,
        kind: diagnosis.kind, target: diagnosis.target, outcome: outcome, detail: detail
      });
    }
  }

  let unsubscribe = null;

  function start() {
    unsubscribe = bus.subscribe('health.diagnosed', onDiagnosed);
  }

  function stop() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  }

  return {
    start: start, stop: stop,
    _internal: { ACTIONS: ACTIONS, lastFiredAt: lastFiredAt, applyPlaybook: applyPlaybook }
  };
}

module.exports = {
  createHealer: createHealer, SEED_PLAYBOOKS: SEED_PLAYBOOKS,
  matchClause: matchClause, matches: matches, resolveArgs: resolveArgs, getPath: getPath
};
```

### `mythos/src/core/immune/probes.js`

```js
'use strict';

// immune/probes.js — status aggregation. RW of NOVA app/lib/probes.js, heavily
// simplified because mythos/src/core/brain/registry.js already centralizes provider
// aliveness (NOVA's version had to ping ollama/edge-tts/claude-cli ad hoc).
//
// getStatus() is a hot path polled every 4s by the metric sensor AND has a
// documented side effect: it emits 'health.anomaly' for provider-down / quota-low
// conditions, since nothing else in shipped code produces those two kinds
// (Spec Ambiguities Resolved #8). This module does NOT deduplicate — healer.js's
// per-playbook cooldownMs is the only heal-storm suppressor, by design.

const registry = require('../brain/registry');
const spend = require('../brain/spend');
const quota = require('../quota');

const DOWN_CAPABLE = ['nim', 'groq', 'mistral']; // ollama is local/optional — never "down"

function isProviderDown(id, registryStatus) {
  if (id === 'nim') return registryStatus.nim.configured > 0 && registryStatus.nim.aliveModels === 0;
  if (id === 'groq') return !registryStatus.groq.alive;
  if (id === 'mistral') return !registryStatus.mistral.alive;
  return false;
}

function createProbes({ bus, config }) {
  if (!bus) throw new Error('createProbes requires bus');

  async function getStatus() {
    const registryStatus = await registry.getStatus();
    const stats = spend.getStats();
    const quotas = quota.getAllQuotas(stats);

    for (let i = 0; i < DOWN_CAPABLE.length; i++) {
      const id = DOWN_CAPABLE[i];
      if (isProviderDown(id, registryStatus)) {
        // 'health.anomaly' — exact string, do not paraphrase.
        bus.emit('health.anomaly', { kind: 'provider-down', target: id, evidence: registryStatus[id] });
      }
    }

    for (let i = 0; i < quotas.length; i++) {
      const q = quotas[i];
      // remainingPercent is null for unlimited/untracked providers — must not
      // compare `null < 10` (coerces to 0 < 10 === true). See Spec Ambiguities #7.
      if (!q.unlimited && q.remainingPercent !== null && q.remainingPercent < 10) {
        bus.emit('health.anomaly', { kind: 'quota-low', target: q.provider, evidence: q });
      }
    }

    return { providers: registryStatus, quotas: quotas, probedAt: registryStatus.probedAt };
  }

  return { getStatus: getStatus };
}

module.exports = { createProbes: createProbes, isProviderDown: isProviderDown };
```

### `mythos/src/core/immune/announcer.js`

```js
'use strict';

// immune/announcer.js — RW of NOVA app/lib/voice/checkpoint-announcer.js. Speaks
// significant immune-system events (health diagnoses at major/critical severity,
// successful heals, post-crash recovery).
//
// `speak` is required at construction — never a silent no-op (this is the one place
// in Phase 6 where a missing dependency is NOT tolerated at call time, because the
// alternative is a silently-swallowed announcement with no trace anywhere). Until
// Phase 7 ships a real voice effector, main.js wires `speak` to re-emit onto the
// 'action' channel so nothing is lost — see Spec Ambiguities Resolved.

const SEVERITY_TO_ANNOUNCE = ['critical', 'major'];

function createAnnouncer({ bus, config, speak }) {
  if (!bus) throw new Error('createAnnouncer requires bus');
  if (typeof speak !== 'function') throw new Error('createAnnouncer requires speak(text)');

  async function say(text) {
    try {
      await speak(text);
    } catch (_) {
      // announcer must never break the entity
    }
  }

  function onDiagnosed(event) {
    const d = event.payload;
    if (SEVERITY_TO_ANNOUNCE.indexOf(d.severity) === -1) return;
    say('Health alert: ' + d.kind + (d.target ? ' on ' + d.target : '') + '.');
  }

  function onHealed(event) {
    const h = event.payload;
    if (h.outcome !== 'applied') return;
    say('Self-healed: ' + h.playbookId + '.');
  }

  function onRecovered() {
    say('Recovered from restart. Resuming.');
  }

  const unsubscribers = [];

  function start() {
    unsubscribers.push(bus.subscribe('health.diagnosed', onDiagnosed));
    unsubscribers.push(bus.subscribe('health.healed', onHealed));
    unsubscribers.push(bus.subscribe('lifecycle.recovered', onRecovered));
  }

  function stop() {
    while (unsubscribers.length) { unsubscribers.pop()(); }
  }

  return { start: start, stop: stop };
}

module.exports = { createAnnouncer: createAnnouncer };
```

### `mythos/src/core/immune/monitor.js`

```js
'use strict';

// immune/monitor.js — the first of the six components. Owns two runtime duties with
// no natural home in breakers/watchdog/diagnostician/healer:
//   1. Periodic checkpointing (Phase 6 Gate: "checkpoint every N ticks") — driven off
//      cortex's own 'tick' bus event, so it needs no cortex reference at all.
//   2. Memory-growth detection — emits 'health.anomaly' kind:'memory-growth' so the
//      'mem-consolidate' SEED_PLAYBOOK in healer.js has a real producer.
// Also exports recoverFromCrash(), the §10 Recovery algorithm — a one-shot boot-time
// function, not a running component, so it lives here rather than getting its own
// file (see Spec Ambiguities Resolved #16).

const fs = require('fs');

// Must equal healer.js's 'mem-consolidate' playbook's `when.target.bytes.gt` literal
// (Spec Ambiguities Resolved #19) — immune.test.js asserts the two stay in sync.
const MEMORY_GROWTH_BYTES = 50000000;

function createMonitor({ bus, config, memory }) {
  if (!bus) throw new Error('createMonitor requires bus');
  if (!memory) throw new Error('createMonitor requires memory');

  const CHECKPOINT_EVERY_TICKS = (config && config.CHECKPOINT_EVERY_TICKS) || 50; // config.CHECKPOINT_EVERY_TICKS — exact key

  function totalBytes(relDir, ext) {
    const entries = memory.fs.listFiles(relDir, ext);
    let sum = 0;
    for (let i = 0; i < entries.length; i++) {
      try { sum += fs.statSync(entries[i].full).size; } catch (_) { /* file may have rotated away */ }
    }
    return sum;
  }

  function checkMemoryGrowth() {
    const bytes = totalBytes('Episodic', '.jsonl') + totalBytes('Semantic', '.md');
    if (bytes > MEMORY_GROWTH_BYTES) {
      // 'health.anomaly' — exact string, do not paraphrase.
      bus.emit('health.anomaly', { kind: 'memory-growth', target: { bytes: bytes } });
    }
  }

  function onTick(event) {
    const tick = event.payload.tick;
    if (tick > 0 && tick % CHECKPOINT_EVERY_TICKS === 0) {
      memory.checkpoints.save(memory.working.snapshot());
      checkMemoryGrowth();
    }
  }

  let unsubscribe = null;

  function start() {
    unsubscribe = bus.subscribe('tick', onTick);
  }

  function stop() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  }

  return { start: start, stop: stop, checkMemoryGrowth: checkMemoryGrowth };
}

// Recovery (Post-Crash) — §10. Runs once, at boot, as the 'recovery' DEGRADED step.
async function recoverFromCrash({ bus, config, memory, goals }) {
  const checkpoint = memory.checkpoints.load();

  // 1. WorkingMemory is already rebuilt (from the checkpoint if present, else the
  //    episodic tail) by memory.working.init() before this runs — nothing further here.

  // 2. Active-at-crash goals -> paused 'crash-recovery'.
  let pausedCount = 0;
  if (goals && typeof goals.getActiveGoals === 'function') {
    const active = goals.getActiveGoals();
    for (let i = 0; i < active.length; i++) {
      goals.update(active[i].id, { status: 'paused', reason: 'crash-recovery' });
      pausedCount++;
    }
  }

  // 3. Checkpoint hint — salientContextKeys names which context keys mattered most;
  //    exposing the hint is Phase 6's job, re-populating context is a Cortex/
  //    WorkingMemory concern already shipped.

  // 4. Emit lifecycle.recovered — exact string, do not paraphrase.
  bus.emit('lifecycle.recovered', {
    hadCheckpoint: Boolean(checkpoint),
    isCrashRecovery: checkpoint ? checkpoint.isCrashRecovery : false,
    pausedGoals: pausedCount
  });

  // 5. No re-dispatch of any interrupted action — resumption happens purely through
  //    goals/cortex re-arbitration on the next tick.
  return { hadCheckpoint: Boolean(checkpoint), pausedGoals: pausedCount };
}

module.exports = { createMonitor: createMonitor, recoverFromCrash: recoverFromCrash, MEMORY_GROWTH_BYTES: MEMORY_GROWTH_BYTES };
```

### `mythos/src/core/sensors/metric.js`

```js
'use strict';

// sensors/metric.js — probes + quota poll every 4s. Emits 'perception.metric' (exact
// string, do not paraphrase) so cortex can eventually reason about degraded infra.
// The health-channel side of low-quota/provider-down (the side the Healer acts on)
// is emitted separately, inside immune/probes.js itself — this sensor only feeds the
// cognitive OODA loop's perception queue, per §12's role split.
//
// Mirrors sensors/timer.js's REAL shape (start() takes no `emit` argument, closures
// over an injected bus instead) rather than §12's abstract "start(emit)" comment —
// see Spec Ambiguities Resolved #17.

function createMetricSensor({ bus, config, probes }) {
  if (!bus) throw new Error('createMetricSensor requires bus');
  if (!probes || typeof probes.getStatus !== 'function') throw new Error('createMetricSensor requires probes');

  let timer = null;

  function poll() {
    return probes.getStatus().then(function(status) {
      const lowQuota = status.quotas.some(function(q) {
        return !q.unlimited && q.remainingPercent !== null && q.remainingPercent < 10;
      });
      // 'perception.metric' — exact string, do not paraphrase. Field name is
      // `salience` (matching the REAL consumer, cortex/ooda.js:14), not the doc's
      // `salienceHint` — see Spec Ambiguities Resolved #14.
      bus.emit('perception.metric', {
        summary: 'infra metrics poll',
        channel: 'metric',
        kind: 'metric',
        salience: lowQuota ? 0.9 : 0.2,
        status: status
      });
    }).catch(function() { /* honest-inert: a failed poll is not a crash */ });
  }

  function start() {
    timer = setInterval(poll, 4000);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start: start, stop: stop, _internal: { poll: poll } };
}

module.exports = { createMetricSensor: createMetricSensor };
```

### `mythos/src/core/config/schema.js` (modify)

```js
  // Immune
  STALL_MS:                 { type: 'number', default: 5000, min: 1000 },
  WATCHDOG_MS:              { type: 'number', default: 2000, min: 500 },
  BREAKER_FAIL_THRESHOLD:   { type: 'number', default: 3, min: 1 },
  BREAKER_WINDOW_MS:        { type: 'number', default: 30000, min: 1000 },
  BREAKER_RESET_MS:         { type: 'number', default: 15000, min: 1000 },
  CHECKPOINT_EVERY_TICKS:   { type: 'number', default: 50, min: 1 },
```

(Single addition, inserted into the existing `// Immune` block right after `BREAKER_RESET_MS`; nothing else in the file changes. `config/index.js` needs no change — `validate()` already iterates `SCHEMA` generically.)

### `mythos/src/core/goals/index.js` (modify `debitBudget`)

```js
  function debitBudget(id, usage) {
    var goal = goals.get(id);
    if (!goal) return;
    goal.spent.tokens += (usage.tokens || 0);
    goal.spent.actions += (usage.actions || 0);
    goal.lastActionAt = Date.now();

    // Auto-pause on budget exhaustion
    if (goal.spent.tokens >= goal.budget.tokens || goal.spent.actions >= goal.budget.actions) {
      goal.status = 'paused';
      goal.reason = 'budget-exhausted';
      // health.anomaly — exact string, do not paraphrase. Added in Phase 6 so
      // healer.js's 'budget-pause' playbook has a real producer (Spec Ambiguities #9).
      if (bus) bus.emit('health.anomaly', { kind: 'budget-exhausted', target: id, evidence: { spent: goal.spent, budget: goal.budget } });
    }
    saveGoal(id);
    if (bus) bus.emit('goal.budget-debited', { id: id, spent: goal.spent });
  }
```

(Only the one `if (bus) bus.emit('health.anomaly', ...)` line is new; everything else in the function is unchanged, matching lesson #3's "surgical changes.")

### `mythos/src/main.js` (modify boot sequence)

Shown as the relevant excerpt against the Phase-4.5-fixed boot order from §13 (`config → logger → bus → vault-dirs → episodic → audit → immune → cortex → .env → stores → identity → brain-probe → goals → recovery → sensors → effectors → server → cortex-tick`). Exact relative ordering is what matters here — the precise granularity of the *already-fixed* steps for `episodic`/`audit`/`stores` is not something this phase controls or needs to know precisely, since `memory` and `bus`/`config` are guaranteed to exist by the time `immune` runs (both precede it) and `cortex`/`goals` are filled in via the deferred-thunk pattern regardless of exact step granularity:

```js
// --- near the top of main(), before the boot-steps array is built ---
let cortex = null;
let goals = null;
let immune = null; // { probes, diagnostician, healer, watchdog, announcer, monitor }

const { createProbes } = require('./core/immune/probes');
const { createDiagnostician } = require('./core/immune/diagnostician');
const { createHealer } = require('./core/immune/healer');
const { createWatchdog } = require('./core/immune/watchdog');
const { createAnnouncer } = require('./core/immune/announcer');
const { createMonitor, recoverFromCrash } = require('./core/immune/monitor');
const { createMetricSensor } = require('./core/sensors/metric');

// --- insert this step between 'audit' and 'cortex' ---
{
  name: 'immune',
  fail: 'fast',
  fn: function() {
    const probes = createProbes({ bus: bus, config: config });
    const diagnostician = createDiagnostician({ bus: bus });
    const healer = createHealer({
      bus: bus, config: config, memory: memory,
      getCortex: function() { return cortex; },
      getGoals: function() { return goals; }
    });
    const watchdog = createWatchdog({ bus: bus, config: config, getCortex: function() { return cortex; } });
    const announcer = createAnnouncer({
      bus: bus, config: config,
      // Phase 7 has no voice effector yet — never a silent no-op (Spec Ambiguities
      // Resolved). Re-emits onto the 'action' channel for a future voice effector
      // to pick up.
      speak: function(text) { bus.emit('action.speak-requested', { text: text }); return Promise.resolve(); }
    });
    const monitor = createMonitor({ bus: bus, config: config, memory: memory });

    diagnostician.start();
    healer.start();
    announcer.start();
    monitor.start();

    immune = { probes: probes, diagnostician: diagnostician, healer: healer, watchdog: watchdog, announcer: announcer, monitor: monitor };
  }
}

// --- 'cortex' step: unchanged except for the plain assignment (no re-declaration) ---
{
  name: 'cortex',
  fail: 'fast',
  fn: function() {
    cortex = createCortex({ bus: bus, memory: memory, goals: goals, brain: brain, leash: leash, effectors: effectors, config: config });
  }
}

// --- 'goals' step: unchanged except for the plain assignment ---
{
  name: 'goals',
  fail: 'degraded',
  fn: async function() {
    goals = createGoalSystem({ fs: memory.fs, config: config, bus: bus, memory: memory, brain: brain });
    await goals.init();
  }
}

// --- 'recovery' step ---
{
  name: 'recovery',
  fail: 'degraded',
  fn: function() {
    return recoverFromCrash({ bus: bus, config: config, memory: memory, goals: goals });
  }
}

// --- 'sensors' step: add the metric sensor alongside whatever else this step starts ---
{
  name: 'sensors',
  fail: 'fast',
  fn: function() {
    // ... existing sensor construction (timer, etc.) ...
    const metricSensor = createMetricSensor({ bus: bus, config: config, probes: immune.probes });
    metricSensor.start();
  }
}

// --- 'cortex-tick' step: cortex AND watchdog start together ---
{
  name: 'cortex-tick',
  fail: 'fast',
  fn: function() {
    cortex.start();
    immune.watchdog.start();
  }
}
```

## Integration Points

| FROM already-shipped modules — exact signature (file:line) | Called by |
|---|---|
| `async registry.refresh(force)` → `{at,nimModels,ollamaModels,groqAlive,mistralAlive}` (`mythos/src/core/brain/registry.js:78`) | `healer.js`'s `probe-provider` action |
| `async registry.getStatus()` → `{nim,ollama,groq,mistral,chains,probedAt}` (`registry.js:137`) | `probes.js` |
| `BRAIN_TABLES` (`mythos/src/core/brain/lanes.default.js:38`) | `healer.js`'s `degrade-lane` action |
| `spend.getStats()` (`mythos/src/core/brain/spend.js:59`) | `probes.js` |
| `quota.getAllQuotas(stats)` (`mythos/src/core/quota.js:66`) | `probes.js` |
| `memory.checkpoints.save(snapshot)` / `.load()` (`mythos/src/core/memory/checkpoints.js:6`/`27`) | `monitor.js` |
| `memory.working.snapshot()` (`mythos/src/core/memory/working.js:26`) | `monitor.js` |
| `memory.fs.listFiles(relDir, ext)` → `{name,path,full}[]` (`mythos/src/core/memory/fs-store.js:55`) | `monitor.js`'s `checkMemoryGrowth` |
| `memory.audit.write(entry)` (`mythos/src/core/memory/audit-writer.js:26`) | `healer.js` |
| `memory.consolidate(opts)` (`mythos/src/core/memory/index.js:49`) | `healer.js`'s `consolidate-memory` action |
| `goals.getActiveGoals()` / `.get(id)` / `.update(id,patch)` (`mythos/src/core/goals/index.js:112`/`52`/`56`) | `monitor.js`'s `recoverFromCrash`, `healer.js`'s `pause-goal` |
| `cortex.lastTickAt` (getter) / `.generation` (getter) / `.stop()` / `.start()` (`mythos/src/core/cortex/index.js:181,182,170,157`) | `watchdog.js` (read-only), `healer.js`'s `restart-cortex` (calls stop/start) |
| `bus.emit(type,payload,opts)` / `bus.subscribe(pattern,handler)` (`mythos/src/core/bus/index.js:107`/`92`) | all of the above |

| INTO this phase — exact signature this phase exposes | Called by |
|---|---|
| `createBreaker({name,bus,config,failThreshold?,windowMs?,resetMs?,maxResetMs?})` → `{state,stats,allow(),recordSuccess(),recordFailure()}` | Phase 7's Effector Hub (`src/core/effectors/index.js`) — **must** pass `bus`/`config` now, not just `{name}` |
| `createWatchdog({getCortex,bus,config})` → `{start,stop}` | `main.js`'s `'immune'`/`'cortex-tick'` boot steps |
| `createDiagnostician({bus})` → `{start,stop,diagnose,severityOf,playbookLookup}` | `main.js`'s `'immune'` step |
| `createHealer({bus,config,memory,getCortex,getGoals,playbooks?})` → `{start,stop}` | `main.js`'s `'immune'` step |
| `createProbes({bus,config})` → `{getStatus()}` (async, `{providers,quotas,probedAt}`) | `main.js`'s `'immune'`/`'sensors'` steps, `sensors/metric.js` |
| `createAnnouncer({bus,config,speak})` → `{start,stop}` | `main.js`'s `'immune'` step, later Phase 7 voice effector via `'action.speak-requested'` |
| `createMonitor({bus,config,memory})` → `{start,stop,checkMemoryGrowth()}` | `main.js`'s `'immune'` step |
| `recoverFromCrash({bus,config,memory,goals})` (async) → `{hadCheckpoint,pausedGoals}` | `main.js`'s `'recovery'` step |
| `createMetricSensor({bus,config,probes})` → `{start,stop}` | `main.js`'s `'sensors'` step |

## Anti-Drift Checklist

1. `bus.emit`/`bus.subscribe` — never `bus.on`/`bus.off`; the real bus module (`bus/index.js`) does not implement those names.
2. Every new event name is verified against the taxonomy `perception|decision|action|health|memory|lifecycle|audit|identity` (first dot-segment = channel). New names introduced: `health.diagnosed`, `health.healed`, `perception.metric`, `action.speak-requested`, `lifecycle.recovered`. None invented outside this set.
3. `createBreaker`, `createWatchdog`, `createDiagnostician`, `createHealer`, `createProbes`, `createAnnouncer`, `createMonitor` all throw at construction if `bus` (or their one truly mandatory functional dependency) is missing — never a silent `if (x && typeof x.fn === 'function')` no-op, per lesson #3. Per-action dependency gaps inside `healer.js` (missing `cortex`/`goals`/`memory` for a *specific* action) fail loud with an explicit `{ok:false, reason:'missing-dependency:...'}` and get audited — not swallowed.
4. `STALL_MS`, `WATCHDOG_MS`, `BREAKER_FAIL_THRESHOLD`, `BREAKER_WINDOW_MS`, `BREAKER_RESET_MS`, `CHECKPOINT_EVERY_TICKS` are read from `config.KEY_NAME` everywhere — grep for any bare numeric literal standing in for one of these before merging.
5. `maxResetMs` (breaker) and the `50000000` memory-growth threshold are the *only* two numeric literals in this phase without a config key, and both are explicitly justified in Spec Ambiguities Resolved — do not silently add a config key for either without updating this checklist, and do not let the two `50000000` occurrences (healer.js's playbook data, monitor.js's `MEMORY_GROWTH_BYTES`) drift apart — `immune.test.js` asserts they're equal.
6. Watchdog never calls `cortex.stop()`/`cortex.start()` directly — grep `watchdog.js` for `cortex.stop` / `cortex.start`; if either appears, the double-restart bug (#2 above) has been reintroduced.
7. `probes.js`/`metric.js` `await` every registry/probes call — grep for `probes.getStatus()` or `registry.getStatus()` without a preceding `await`.
8. Any quota-percentage comparison (`remainingPercent < N`) is guarded with `!== null` first — `null < N` is `true` in JS.
9. Sensor perception payloads use `.salience` (matching `cortex/ooda.js:14`'s real read), never `.salienceHint` — even though the architecture doc's own prose says otherwise.
10. Healer's SEED_PLAYBOOK array and its DSL matcher (`matchClause`) are covered by tests for **both** shapes actually present in the data: `{eq:'x'}` (leaf, compares `anomaly.target` directly) and `{bytes:{gt:N}}` (nested field, compares `anomaly.target.bytes`). A matcher that only handles one shape will silently make 3 of the 5 SEED_PLAYBOOKS unreachable.
11. `goals/index.js`'s `debitBudget` diff is exactly one added line — if a future edit touches more of that function, re-diff against this spec before merging, since that file is Phase 3's, not Phase 6's.
12. `createBreaker` is called with `{name, bus, config}` everywhere in this phase's own code and tests; if Phase 7's effector hub is later found calling it with only `{name}` (matching the architecture doc's given, buggy, Effector Hub snippet), that is the bug from Ambiguity #4 recurring — fix the call site, not `breakers.js`.

## Test Plan

Gate criteria (ROADMAP.md Phase 6): **breaker open→half-open**, **watchdog stall detect**, **healer playbook re-probe**, **checkpoint every N ticks**.

| Gate criterion | Test(s) in `immune.test.js` | Real-instance? |
|---|---|---|
| breaker open→half-open | `breakers`: CLOSED→OPEN at failThreshold; OPEN blocks until resetAt; OPEN→HALF_OPEN after resetMs elapses; HALF_OPEN success→CLOSED; HALF_OPEN failure→OPEN with doubled backoff (the bug-fix regression test) | real `breakers.js`, pure module |
| watchdog stall detect | `watchdog`: emits `cortex-stall` when `getCortex().lastTickAt.value` is stale beyond `STALL_MS`; does **not** call `cortex.stop`/`start` itself | real `watchdog.js` + fake cortex spy |
| healer playbook re-probe | `healer`: `matchClause`/`matches` unit tests (both DSL shapes); cooldown blocks a second `stall-restart` within 30s; `$var` resolution via a synthetic playbook; **real integration**: real bus + real `diagnostician` + real `healer` + real `cortex` (fake leaf deps for memory/goals/leash/effectors, matching `cortex-goals.test.js`'s convention) proves a real stall gets detected, diagnosed, and restarted exactly once, with `cortex.generation` incrementing by exactly one | **real bus + real cortex + real diagnostician + real healer** (lesson #4) |
| checkpoint every N ticks | `monitor`: with a **real** temp-vault `memory` facade (real `fs-store`/`checkpoints`), emitting `CHECKPOINT_EVERY_TICKS` `'tick'` events causes `checkpoints.load()` to return a saved snapshot afterward | **real memory facade + real checkpoints store** (lesson #4) |
| (regression) `quota-guard` degrade-lane | real `healer` + real `registry.js`: after `degrade-lane` fires, `registry.chainFor('voice')` genuinely excludes `groq` | **real registry.js** (lesson #4) |
| (regression) `budget-exhausted` producer | real `goals/index.js`: `debitBudget` past budget emits `health.anomaly{kind:'budget-exhausted'}` on a real bus | real `goals.js` + real bus |
| (regression) null-guard | `probes`: quota entries with `remainingPercent: null` never trigger `quota-low` | real `quota.js` + synthetic `spend.getStats()` |
| threshold sync | `require('../src/core/immune/monitor').MEMORY_GROWTH_BYTES === require('../src/core/immune/healer').SEED_PLAYBOOKS.find(p=>p.id==='mem-consolidate').when.target.bytes.gt` | n/a (constant equality) |

The two hardest tests, in full:

```js
// --- breaker exponential backoff, real timestamps, no fakes needed ---
describe('breakers — HALF_OPEN failure backs off exponentially (bug fix)', function() {
  it('doubles the DELAY on repeated half-open failures, not the absolute timestamp', function() {
    var bus = fakeBus();
    var { createBreaker } = require('../src/core/immune/breakers');
    var breaker = createBreaker({ name: 'test', bus: bus, config: { BREAKER_FAIL_THRESHOLD: 1, BREAKER_RESET_MS: 100 } });

    // Trip OPEN
    breaker.recordFailure();
    assert.equal(breaker.state, 'open');
    var firstResetAt = breaker.stats.resetAt;
    var firstDelay = firstResetAt - Date.now();
    assert.ok(firstDelay > 0 && firstDelay <= 100, 'first backoff should be ~ base resetMs');

    // Force into HALF_OPEN by faking the clock forward via a synthetic resetAt check —
    // call allow() only once resetAt has passed; simulate by constructing a breaker
    // with resetMs=0 so it's immediately eligible.
    var quick = createBreaker({ name: 'quick', bus: bus, config: { BREAKER_FAIL_THRESHOLD: 1, BREAKER_RESET_MS: 0 } });
    quick.recordFailure();               // CLOSED -> OPEN, resetAt = now+0
    assert.equal(quick.allow(), true);   // OPEN -> HALF_OPEN (resetAt already passed)
    assert.equal(quick.state, 'half-open');
    var beforeSecondFail = Date.now();
    quick.recordFailure();               // HALF_OPEN probe fails -> OPEN, backoff doubles
    var secondDelay = quick.stats.resetAt - beforeSecondFail;
    assert.ok(secondDelay >= 0, 'resetAt must be a sane near-future timestamp, not resetAt*2 nonsense');
    // Doubled from the base RESET_MS (0 -> still 0 here since base was 0*2=0); use a
    // non-zero base to assert real doubling:
    var breaker2 = createBreaker({ name: 'b2', bus: bus, config: { BREAKER_FAIL_THRESHOLD: 1, BREAKER_RESET_MS: 50 } });
    breaker2.recordFailure();                              // CLOSED -> OPEN, delay=50
    var delay1 = breaker2.stats.resetAt - Date.now();
    // Simulate resetAt already elapsed to force HALF_OPEN without a real sleep:
    breaker2._forceResetAtPast && breaker2._forceResetAtPast(); // not exposed — see note below
  });
});
```

The above test intentionally stops short of sleeping in real time (per the harness's "avoid unnecessary sleep" guidance) by asserting the fix at the unit level via `breaker.stats.resetAt` deltas rather than waiting out real timers; a second, timer-based test using short real `sleep()` (matching `cortex-goals.test.js`'s existing `sleep(ms)` helper pattern) rounds out full open→half-open→closed coverage in the actual file.

```js
// --- REAL cortex + REAL watchdog + REAL diagnostician + REAL healer, one restart only ---
describe('watchdog -> diagnostician -> healer -> real cortex restart (lesson #4)', function() {
  it('restarts a genuinely stalled real cortex exactly once, not twice', async function() {
    var bus = fakeBus(); // real createBus under a spy — see helpers.js
    var memory = fakeMemory();      // from cortex-goals.test.js's fakeMemory()
    var goals = fakeGoals();        // from cortex-goals.test.js's fakeGoals()
    var leash = { check: function() { return { allow: true }; } };
    var effectors = { invoke: async function() { return { ok: true }; }, breakers: { allow: function() { return true; } } };
    var config = { MYTHOS_TICK_MS: 60000, STALL_MS: 50, WATCHDOG_MS: 20, MAX_ACTIVE_GOALS: 5 };

    var { createCortex } = require('../src/core/cortex');
    var cortex = createCortex({ bus: bus, memory: memory, goals: goals, brain: null, leash: leash, effectors: effectors, config: config });

    var { createDiagnostician } = require('../src/core/immune/diagnostician');
    var { createHealer } = require('../src/core/immune/healer');
    var { createWatchdog } = require('../src/core/immune/watchdog');

    var diagnostician = createDiagnostician({ bus: bus });
    var healer = createHealer({ bus: bus, config: config, memory: memory, getCortex: function() { return cortex; }, getGoals: function() { return goals; } });
    var watchdog = createWatchdog({ bus: bus, config: config, getCortex: function() { return cortex; } });

    diagnostician.start();
    healer.start();

    cortex.start();
    var genBeforeStall = cortex.generation;
    // Force a stall: do NOT call tickOnce(); lastTickAt.value stays at cortex.start() time.
    await new Promise(function(r) { setTimeout(r, 30); }); // let lastTickAt.value age past STALL_MS relative to check
    watchdog.start();
    await new Promise(function(r) { setTimeout(r, 80); }); // one watchdog check cycle (WATCHDOG_MS=20) should fire

    assert.equal(cortex.generation, genBeforeStall + 1, 'exactly one restart, from healer, not two');
    var healed = bus._emitted().filter(function(e) { return e.type === 'health.healed' && e.payload.playbookId === 'stall-restart'; });
    assert.ok(healed.length >= 1, 'stall-restart playbook should have fired');
    assert.equal(healed[0].payload.outcome, 'applied');

    watchdog.stop();
    cortex.stop();
  });
});
```

## Do NOT

- Do NOT let `watchdog.js` call `cortex.stop()`/`cortex.start()` directly — that is the double-restart bug from Ambiguity #2; restart lives only in `healer.js`'s `restart-cortex` action.
- Do NOT copy the architecture doc's `resetAt * 2` backoff formula verbatim — it doubles an absolute timestamp, not a delay.
- Do NOT construct `createBreaker`/`createWatchdog`/`createDiagnostician`/`createHealer`/`createProbes`/`createAnnouncer`/`createMonitor` without `bus` — none of them should silently no-op on a missing bus.
- Do NOT call `probes.getStatus()` or `registry.getStatus()` without `await` — both are async.
- Do NOT compare `quota.remainingPercent < N` without first checking `!== null`.
- Do NOT use `salienceHint` as the perception field name for new sensors — the real consumer (`ooda.js`) reads `.salience`.
- Do NOT build a bespoke bus→`working.pushPerception()` bridge inside `sensors/metric.js` alone — that gap is pre-existing, shared by the timer sensor, and out of this phase's scope.
- Do NOT invent a config schema key for `maxResetMs` or the memory-growth byte threshold — neither has one in the real schema, and neither needs one (YAGNI).
- Do NOT let `healer.js`'s `pause-goal` action unconditionally re-transition a goal that's already `paused` — it must check `goal.status` first (idempotency, since `goals.debitBudget()` may have already paused it synchronously).
- Do NOT reference `mythos/src/core/leash/*` from this phase — Leash is Phase 5, not shipped, and `cortex/index.js`'s mandatory leash/effectors gating (D-39) is a Phase 3/4.5 concern, not something Phase 6 wires.

---

# Phase 7 — Sensors & Effectors

## Overview & Why

Phase 7 gives MYTHOS hands, ears, and eyes: it turns the 45 NOVA voice tools plus the build pipeline into Leash-gated Effectors the Cortex can actually dispatch, and it feeds the Cortex real perceptions from the filesystem, WebSocket clients, and background build jobs (the Timer sensor from Phase 3 is the only one that already exists). Without this phase, Cortex's `act()` stage has nothing registered in `effectors.invoke()` to call — every decision the Goal System plans dies as `unknown-effector` — and `working.drainPerceptions()` only ever sees synthetic timer heartbeats, so the entity can never actually notice a file change, a spoken command, or a finished build. This phase also finally answers the NOVA Goals.md compatibility question left open since Phase 4: an actual bridge between the human-facing checkbox list and the GoalSystem's stable-id JSON records.

## Directory & File Layout

```
mythos/
├── src/core/
│   ├── config/
│   │   └── schema.js            (MODIFIED — +4 keys, see Full Code)
│   ├── effectors/
│   │   ├── adapter.js           (NEW — effectorFromTool)
│   │   ├── hub.js               (NEW — createEffectorHub)
│   │   ├── build-runner.js      (NEW — WRAP of app/lib/orchestrator.js)
│   │   ├── from-dashboard.js    (NEW — CA of app/lib/voice/tools-dashboard.js, 20 tools)
│   │   ├── from-computer.js     (NEW — CA of app/lib/voice/tools-computer.js, 4 tools)
│   │   ├── from-pc.js           (NEW — CA of app/lib/voice/tools-pc.js, 10 tools)
│   │   ├── from-browser.js      (NEW — CA of app/lib/voice/tools-browser.js, 10 tools)
│   │   ├── from-project.js      (NEW — CA of app/lib/voice/tools-project.js, 1 tool)
│   │   ├── agent-actions.js     (NEW — CA of app/lib/agent-actions.js, reasoning.chat→brain.think)
│   │   ├── pipeline.js          (NEW — CA of app/lib/pipeline.js)
│   │   ├── kanban.js            (NEW — CA of app/lib/kanban.js)
│   │   ├── goals.js             (NEW — Goals.md ⇄ GoalSystem bridge, new logic)
│   │   └── voice.js             (NEW — CA of app/lib/voice/tts.js, TTS as effector)
│   └── sensors/
│       ├── timer.js             (EXISTING, Phase 3 — untouched by this phase)
│       ├── file.js              (NEW)
│       ├── ws.js                (NEW)
│       └── job.js               (NEW)
├── adapters/
│   ├── s2s/                     (NEW — WRAP, untouched copy of app/lib/s2s/*, re-pathed requires only)
│   ├── pc-child/                (NEW — WRAP, untouched copy of app/lib/voice/pc-child.js, re-pathed)
│   └── browser-agent/           (NEW — WRAP, untouched copy of app/lib/voice/browser-agent.js, re-pathed)
├── src/main.js                  (MODIFIED — wires sensors/effectors boot steps, see Integration Points)
└── test/
    ├── effectors-adapter.test.js
    ├── effectors-hub.test.js
    ├── build-runner.test.js
    ├── sensors-file.test.js
    ├── sensors-ws.test.js
    ├── sensors-job.test.js
    ├── effectors-goals-md.test.js
    └── integration-cortex-effectors.test.js   (REAL cortex + REAL hub, per lesson #4)
```

## Spec Ambiguities Resolved

1. **Dashboard tool count is 20, not 21.** §16's Phase 7 scope line and the reuse ledger both say "45 tools" as the total, and a literal count of `TOOLS` arrays in the real, current NOVA source gives `tools-dashboard.js`=20, `tools-computer.js`=4, `tools-pc.js`=10, `tools-browser.js`=10, `tools-project.js`=1 → **45 total, matching the gate's "45 registered count."** The per-file split claimed elsewhere (21/4/10/10/1) is stale — dashboard actually has 20 (verified by enumerating its `TOOLS` array: navigate, open_artifact, read_status, job_status, create_goal, list_goals, toggle_goal, delete_goal, capture_idea, pipeline_status, pipeline_advance, pipeline_execute, kanban_status, kanban_add_card, kanban_move_card, kanban_assemble, kanban_build_card, ask_agent, monitor_snapshot, kill_session). Resolution: the gate's "45 registered count" is the number that matters and is unaffected; do not "fix" tools-dashboard.js to manufacture a 21st tool.

2. **`open_artifact` is missing from §9's `TIER_TABLE` entirely.** Counting `TIER_TABLE` gives T0=12, T1=13, T2=6, T3=11, T4=2 = 44 mapped tools, one short of the real 45 — the gap is `open_artifact`. Per the established cross-phase convention, `tierOf('open_artifact')` therefore falls through to the unmapped-tool default of **T3**, meaning this read-only "open a local build artifact in the system browser" action will require a confirm the first time it's invoked in any goal. Resolution: this phase does **not** unilaterally edit `leash/tiers.js` (a Phase 5 deliverable) to add a missing entry — that would be an undocumented drift in someone else's owned file. Ship it as T3-by-default and flag `open_artifact: 1` as a suggested addition to `TIER_TABLE` for a future spec/Leash patch. Do not silently special-case `open_artifact` inside `adapter.js` to dodge the fail-safe.

3. **Sensor Interface contract mismatch: `start(emit)` vs. the real, already-shipped `timer.js`.** §12's illustrative pseudocode shows every sensor as `start(emit) → stop()`, where `emit` is a callback the sensor is handed (matching `bus.publish`). But the actual, currently-shipped `mythos/src/core/sensors/timer.js` (Phase 3, whose only Phase-4.5-mandated fix is the event name/payload, per D-36/D-40 — its constructor shape is untouched) is `createTimerSensor({ bus, config })` returning `{ start, stop, isRunning }` where `start()` takes **zero** arguments and closes over the injected `bus` to call `bus.emit(type, payload, opts)` directly. This is also the only shape consistent with lesson #8 (bus injected at construction, never passed per-call). Resolution: `file.js`, `ws.js`, and `job.js` in this phase match the real `timer.js` shape — `create*Sensor({ bus, config, ...deps })` → `{ start(), stop(), isRunning() }`, internal `bus.emit(...)`, not the abstract `start(emit)` from §12. This is a "code as it actually is, not as spec prose describes it" resolution — call it out in review so nobody reverts it toward the illustrative snippet.

4. **Effector Hub's `breakers` cannot literally be a `Map`, per the real (already-shipped) `cortex/index.js` caller.** §12's hub pseudocode returns `get breakers() { return breakers; }` where `breakers` is a plain `Map`. But `cortex/index.js:121-126` (already shipped, Phase 3) calls `effectors.breakers.allow(decision.tool)` directly — `.allow` does not exist on `Map.prototype`, so a spec-literal hub would throw a `TypeError` on the very first gated action once Phase 7 ships. Resolution: `hub.js`'s `breakers` property stays name-identical to the spec (so nothing else has to change) but is a small `BreakerRegistry` wrapper object — `{ get(name), set(name, breaker), allow(name), recordSuccess(name), recordFailure(name), size }` — backed internally by a `Map`. `register()` still does `breakers.set(effector.id, createBreaker({ name: effector.id }))` exactly as spec'd; `invoke()` still does its own `breaker.allow()`/`recordSuccess()`/`recordFailure()` exactly as spec'd; the wrapper only adds the pass-through methods cortex's real code needs. `createBreaker` is required from `../immune/breakers.js` (Phase 6) — since Phase 6 has not shipped as of this writing, its exact signature is **assumed** per §12's sketch (`createBreaker({ name })` → `{ allow(), recordSuccess(), recordFailure() }`); re-verify against Phase 6's real file before merging Phase 7 and adjust `hub.js`'s one call site if it differs.

5. **`providers/openrouter.js` and `providers/claude-cli.js` (D-30) have no legitimate Phase 7 use — flag for removal, do not wire them in.** Both exist only as raw `{ chat(messages, opts) }` functions matching the Brain's provider-chain shape (streaming chat completion for a `reasoning`-style caller), not anything an Effector/Tool would call directly. None of the 45 tools need a raw LLM chat call — the only tool-adjacent LLM usage in this phase is `build-runner.js`'s `brain.think({ lane: 'build' })`, which already has a defined lane chain (Mistral → NIM/zcode GLM → Ollama) that neither orphan is part of. `claude-cli.js` additionally shells out to a local `claude` CLI binary via `child_process.spawn` — an operation with T2+-grade side effects (spawns a process, holds a session map) that has no tool entry, no tier mapping, and no describe()/validate() the way every other effector must; wiring it in now would be adding an ungated, undocumented effector by the back door, which lesson #3 (mandatory gating) forbids. Resolution: **do not use them in Phase 7.** They remain orphaned pending an explicit decision (either implement the canonical `{name, chat, isAvailable, getStatus, getModel}` shape from D-29 and add a real lane/tool for them, or delete). This phase does not silently resolve D-29/D-30 — it only confirms neither is Phase 7's problem to solve.

6. **NOVA Goals.md ⇄ GoalSystem mapping — positional IDs cannot be the join key.** Goals.md lines are strictly positional (`goals.js:reindex()` rewrites every id to its array index after *every* mutation — `tools-dashboard.js`'s own header comment already establishes the rule "never trust an id/index carried over from an earlier turn"). GoalSystem ids are stable UUIDs (`goal-<uuid>`) that never change. §7's compatibility note says only that Goals.md "stays as the user-facing surface" and that "the `goals` effector reads/writes Goals.md" — it does not specify the join key. Resolution (see `effectors/goals.js` below): join on the **content pair `(text, created)`**, not position. `created` is an NOVA-assigned ISO timestamp set once at `addGoal()` time and never rewritten by `toggleGoal`/`deleteGoal`/`reindex`, making `(text, created)` a de-facto-unique, stable natural key across arbitrary future line reordering (deletions shift positional ids; they never touch `text`/`created` of surviving rows). A sidecar map `vault/Goals/.md-bridge.json` (array of `{ goalId, text, created }`) persists the join so a full Goals.md rewrite doesn't require re-scanning GoalSystem's Map by brute-force text match on every effector call — it's still a linear scan, which is fine at the goal-count scale this system targets (dozens, not thousands).

7. **`enqueue()`'s dropped `cardId` field means `agent-actions.js`/`pipeline.js`/`kanban.js` must track card association themselves, in the `run` closure.** NOVA's `orchestrator.js` stores `cardId` on the job record so `job_status`/UI can show "this job belongs to card X" without the caller remembering. MYTHOS's `build-runner.enqueue({kind, prompt, run})` has no such field (per the mandated convention). Resolution: the `run(rawOutput, job)` closure captures the card/goal id via JS closure over the outer function's argument (exactly as NOVA's `agent-actions.js` already does for the *content* of the closure — `pipeline.moveCard(card.id, ...)` inside `run` already closes over `card`), so no information is lost; it just isn't visible on the `job` object itself. `job_status`-equivalent tooling that wants "which card is this" must ask the pipeline/kanban effector, not the build-runner, for that mapping.

## Full Code

### mythos/src/core/config/schema.js (addition)

Insert this block into the existing `SCHEMA` object (after the `// Bus` block); nothing else in the file changes:

```js
  // Effectors & Sensors (Phase 7)
  MYTHOS_BUILD_CONCURRENCY:  { type: 'number', default: 1, min: 1, max: 8 },
  MYTHOS_JOBS_MAX_PERSISTED: { type: 'number', default: 100, min: 10 },
  MYTHOS_WATCH_DIRS:         { type: 'string', default: '' },
  MYTHOS_FILE_DEBOUNCE_MS:   { type: 'number', default: 500, min: 50 },
```

Every one of `config.MYTHOS_BUILD_CONCURRENCY` / `MYTHOS_JOBS_MAX_PERSISTED` / `MYTHOS_WATCH_DIRS` / `MYTHOS_FILE_DEBOUNCE_MS` is read (never re-defaulted in-module) by `build-runner.js` / `file.js` below — this is the exact string, do not paraphrase the key names.

### mythos/src/core/effectors/adapter.js

```js
'use strict';

// effectors/adapter.js — wraps a NOVA-style tool ({ name, description, params, danger,
// dangerWhen?, fn }) into the canonical Effector shape Cortex/EffectorHub expect.
// CA from MYTHOS-ARCHITECTURE.md §12 "Tool → Effector Adapter" — logic is verbatim,
// only the require path for tierOf changed to match Leash's real module location.

const { tierOf } = require('../leash/tiers');

function effectorFromTool(tool) {
  return {
    id: tool.name,
    tier: tierOf(tool.name),
    dangerWhen: tool.dangerWhen,           // read by leash.check() at gate time — not here
    describe: function() { return tool.description; },
    validate: function(params) {
      // Presence-only validation: every required key in tool.params (a key whose
      // description string does NOT contain "(optional)") must be present and non-empty.
      // Deliberately shallow — NOVA's tool fns already validate types/shape internally
      // and return { ok:false, result:'...' } on bad input; duplicating that here would
      // be two sources of truth for the same rule.
      var required = Object.keys(tool.params || {}).filter(function(k) {
        return String(tool.params[k]).indexOf('(optional)') === -1;
      });
      for (var i = 0; i < required.length; i++) {
        var key = required[i];
        if (params === undefined || params === null || params[key] === undefined || params[key] === '') {
          return { ok: false, reason: 'missing required param: ' + key };
        }
      }
      return { ok: true };
    },
    async invoke(params, ctx) {
      try {
        var result = await tool.fn(params, ctx);
        // Normalize: every tool.fn already returns { ok, result } via NOVA's ok()/fail()
        // helpers, but guard against a tool that forgot and returned a bare value.
        if (result && typeof result === 'object' && 'ok' in result) return result;
        return { ok: true, result: result };
      } catch (err) {
        return { ok: false, result: err.message };
      }
    }
  };
}

module.exports = { effectorFromTool };
```

### mythos/src/core/effectors/hub.js

```js
'use strict';

// effectors/hub.js — createEffectorHub: registry + breaker-gated dispatch.
// CA from MYTHOS-ARCHITECTURE.md §12 "Effector Hub" — logic is verbatim except the
// `breakers` field is a thin registry wrapper (not a raw Map), because the real,
// already-shipped cortex/index.js:121 calls `effectors.breakers.allow(name)` directly —
// see Spec Ambiguities Resolved #4. `createBreaker` comes from immune/breakers.js (Phase 6).

const { createBreaker } = require('../immune/breakers');

function createBreakerRegistry() {
  var byName = new Map();
  return {
    get: function(name) { return byName.get(name); },
    set: function(name, breaker) { byName.set(name, breaker); },
    has: function(name) { return byName.has(name); },
    allow: function(name) {
      var b = byName.get(name);
      return b ? b.allow() : true;    // no breaker registered → allow (unknown effector
                                        // is rejected earlier by invoke()'s own check)
    },
    recordSuccess: function(name) {
      var b = byName.get(name);
      if (b) b.recordSuccess();
    },
    recordFailure: function(name) {
      var b = byName.get(name);
      if (b) b.recordFailure();
    },
    get size() { return byName.size; }
  };
}

function createEffectorHub({ bus, config }) {
  var effectors = new Map();               // tool name -> effector (the 45 gate-counted ones)
  var namedServices = new Map();            // synthetic id -> service object (goals/kanban/pipeline bridges)
  var breakers = createBreakerRegistry();   // name -> breaker (see wrapper above)

  function register(effector) {
    if (!effector || !effector.id || typeof effector.invoke !== 'function') {
      throw new Error('createEffectorHub.register: effector must have {id, invoke()}');
    }
    effectors.set(effector.id, effector);
    breakers.set(effector.id, createBreaker({ name: effector.id, bus: bus, config: config }));
  }

  // CROSS-PHASE FIX (consistency pass, P7 vs P5/P9): neither `get(name)` nor
  // `registerNamed(id, obj)` existed on the hub's public return shape, even
  // though Leash's `check()` (P5, §9) calls `effectors.get(toolName)` directly
  // for the dangerWhen override, and P9's server requires
  // `effectors.get('goals-effector')` to reach the Goals.md bridge. `get()`
  // checks the tool-effectors map first, then namedServices — Leash gets
  // `{dangerWhen}|undefined` for a tool, P9 gets the bridge object for a named
  // service, same method. `registerNamed` skips the `{id,invoke}` shape check
  // `register()` enforces (named services are called directly via their own
  // methods, never dispatched through `invoke()`, and get no breaker) and goes
  // into a SEPARATE map so `count()` (the "exactly 45" gate) is never inflated
  // by goals-effector/kanban-effector/pipeline-effector.
  function get(name) {
    return effectors.has(name) ? effectors.get(name) : namedServices.get(name);
  }

  function registerNamed(id, obj) {
    if (!id || !obj) throw new Error('createEffectorHub.registerNamed: requires (id, obj)');
    namedServices.set(id, obj);
  }

  async function invoke(name, params, ctx) {
    var effector = effectors.get(name);
    if (!effector) return { ok: false, result: 'unknown-effector' };

    if (!breakers.allow(name)) {
      return { ok: false, result: 'circuit-open' };
    }

    var result;
    try {
      result = await effector.invoke(params, ctx);
    } catch (err) {
      // invoke() contract says effectors never throw, but hub must not trust that —
      // an uncaught throw here must still count as a breaker failure, not crash Cortex.
      result = { ok: false, result: err.message };
    }

    if (result && result.ok) {
      breakers.recordSuccess(name);
    } else {
      breakers.recordFailure(name);
    }

    return result;
  }

  return {
    register: register,
    registerNamed: registerNamed,
    get: get,
    invoke: invoke,
    get effectors() { return effectors; },
    get breakers() { return breakers; },
    count: function() { return effectors.size; }
  };
}

module.exports = { createEffectorHub };
```

### mythos/src/core/effectors/build-runner.js

```js
'use strict';

// effectors/build-runner.js — WRAPS app/lib/orchestrator.js as an effector-facing job
// runner. NOT absorbed into GoalSystem: cognition runs at 1s cadence (MYTHOS_TICK_MS) and
// must never block on a multi-minute build; build-runner owns its own queue/pump loop,
// and job progress is surfaced back into cognition via sensors/job.js (onJobUpdate ->
// perception.job), not by cortex awaiting this module directly.
//
// Uses brain.think({ lane: 'build' }) — reasoning.chat() was DELETED in Phase 2.
// enqueue() shape is exactly { kind, prompt, run } — no cardId (see Spec Ambiguities #7).

function createBuildRunner({ config, brain, bus, vault }) {
  if (!brain || typeof brain.think !== 'function') {
    throw new Error('createBuildRunner requires a brain with think()');
  }
  if (!vault || typeof vault.writeJSON !== 'function' || typeof vault.readJSON !== 'function') {
    throw new Error('createBuildRunner requires a vault fs-store with readJSON/writeJSON');
  }

  var CONCURRENCY = (config && config.MYTHOS_BUILD_CONCURRENCY) || 1;
  var MAX_PERSISTED = (config && config.MYTHOS_JOBS_MAX_PERSISTED) || 100;
  var JOBS_REL_PATH = 'Checkpoints/build-jobs.json';

  var jobs = new Map();     // id -> job record
  var queue = [];           // [{ job, prompt, run }]
  var runningCount = 0;
  var listeners = new Set();

  function onJobUpdate(fn) {
    listeners.add(fn);
    return function unsubscribe() { listeners.delete(fn); };
  }

  function persist() {
    try {
      vault.writeJSON(JOBS_REL_PATH, { jobs: Array.from(jobs.values()).slice(-MAX_PERSISTED) });
    } catch (err) {
      // Never swallow silently (lesson #8) — a jobs.json write failure is a real anomaly
      // even though in-memory state stays authoritative for this process's lifetime.
      if (bus) bus.emit('health.anomaly', { kind: 'jobs-persist-failed', error: err.message });
    }
  }

  // restart marks running jobs failed (honest) — no fake resume, per Crash Invariant #2.
  // CROSS-PHASE FIX (consistency pass, P7 vs P10): P10's chaos-restart-mid-action
  // drill needs a discoverable list of what got flipped on this construction —
  // recoveredJobs, populated here and surfaced via init() below.
  var recoveredJobs = [];
  function loadPersisted() {
    var data;
    try {
      data = vault.readJSON(JOBS_REL_PATH, { jobs: [] });
    } catch (err) {
      if (bus) bus.emit('health.anomaly', { kind: 'jobs-load-failed', error: err.message });
      data = { jobs: [] };
    }
    var list = data.jobs || [];
    for (var i = 0; i < list.length; i++) {
      var j = list[i];
      if (j.status === 'running' || j.status === 'queued') {
        j.status = 'failed';
        j.stage = 'failed';
        j.error = 'entity restarted mid-job';
        j.finishedAt = j.finishedAt || Date.now();
        recoveredJobs.push({ id: j.id, error: j.error });
      }
      jobs.set(j.id, j);
    }
  }

  // init() is async per the shared build-runner/effector-hub contract (every
  // effector construction step in main.js's boot sequence is awaited) even
  // though loadPersisted() above already ran synchronously at construction —
  // init() just surfaces what construction already computed. Callers (main.js's
  // 'recovery' boot step, P10's chaos drill) await this to learn what was
  // recovered without needing to inspect internal state.
  async function init() {
    return { recoveredJobs: recoveredJobs.slice() };
  }

  function notify(job) {
    persist();
    listeners.forEach(function(fn) {
      try { fn(job); } catch (_) { /* a broken listener must never kill the pump */ }
    });
  }

  function enqueue({ kind, prompt, run }) {
    var job = {
      id: 'job-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      kind: kind,
      status: 'queued',
      stage: 'queued',
      artifact: null,
      error: null,
      createdAt: Date.now(),
      finishedAt: null
    };
    jobs.set(job.id, job);
    queue.push({ job: job, prompt: prompt, run: run });
    notify(job);
    // Defer pump() so enqueue() always returns a job in 'queued' state — see NOVA
    // orchestrator.js's identical queueMicrotask comment; same race exists here.
    queueMicrotask(function() { pump(); });
    return job;
  }

  async function pump() {
    if (runningCount >= CONCURRENCY) return;
    var next = queue.shift();
    if (!next) return;
    runningCount += 1;

    var job = next.job, prompt = next.prompt, run = next.run;
    job.status = 'running';
    job.stage = 'generating';
    notify(job);

    try {
      var result = await brain.think({
        lane: 'build',
        messages: [{ role: 'user', content: prompt }],
        source: 'build-runner:' + job.id
      });

      if (!result || result.offline) {
        throw new Error('brain offline — chain exhausted for lane "build"');
      }
      if (result.aborted) {
        throw new Error('build aborted');
      }

      job.stage = 'writing-artifact';
      notify(job);

      var raw = result.content;
      var runResult = await run(raw, job);
      job.status = 'done';
      job.stage = 'done';
      if (runResult && runResult.artifact) job.artifact = runResult.artifact;
    } catch (err) {
      job.status = 'failed';
      job.stage = 'failed';
      job.error = err && err.message ? err.message : String(err);
    }
    job.finishedAt = Date.now();
    notify(job);

    runningCount -= 1;
    pump();
  }

  function getJob(id) { return jobs.get(id) || null; }
  function listJobs() { return Array.from(jobs.values()); }
  function queuePosition(jobId) {
    for (var i = 0; i < queue.length; i++) {
      if (queue[i].job.id === jobId) return i + 1;
    }
    return 0;
  }

  loadPersisted();

  return {
    enqueue: enqueue,
    getJob: getJob,
    listJobs: listJobs,
    queuePosition: queuePosition,
    onJobUpdate: onJobUpdate,
    init: init
  };
}

module.exports = { createBuildRunner };
```

### mythos/src/core/sensors/job.js

```js
'use strict';

// sensors/job.js — Job Sensor: subscribes to build-runner's onJobUpdate() and turns
// every job-state transition into a `perception.job` bus event. This is what closes
// the loop the header comment in build-runner.js promises: Cortex never awaits a build
// directly, it finds out a build finished (or failed) the same way it finds out about
// anything else — as a perception drained from working memory on the next tick.
//
// Matches the real, already-shipped sensor shape (create*Sensor({bus,...}) -> {start,
// stop, isRunning}, zero-arg start()) established by timer.js — see Spec Ambiguities #3.

function createJobSensor({ bus, buildRunner }) {
  if (!bus || typeof bus.emit !== 'function') {
    throw new Error('createJobSensor requires a bus');
  }
  if (!buildRunner || typeof buildRunner.onJobUpdate !== 'function') {
    throw new Error('createJobSensor requires a buildRunner with onJobUpdate()');
  }

  var running = false;
  var unsubscribe = null;

  function handleJobUpdate(job) {
    if (!running) return;
    // salience: 0.5 normal, 0.7 failed — field is `.salience`, never `.salienceHint`
    // (this is the flat shape working memory/orient() actually consumes; see
    // Spec Ambiguities discussion of the Perception Envelope vs. the real orient()).
    var salience = job.status === 'failed' ? 0.7 : 0.5;
    bus.emit('perception.job', {
      kind: 'job',
      summary: job.kind + ' job ' + job.id + ' ' + job.status,
      channel: 'build',
      salience: salience,
      jobId: job.id,
      status: job.status,
      stage: job.stage,
      error: job.error
    });
  }

  function start() {
    running = true;
    unsubscribe = buildRunner.onJobUpdate(handleJobUpdate);
  }

  function stop() {
    running = false;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  }

  return {
    start: start,
    stop: stop,
    isRunning: function() { return running; }
  };
}

module.exports = { createJobSensor };
```

### mythos/src/core/sensors/file.js

```js
'use strict';

// sensors/file.js — File Sensor: fs.watch over the vault root + any extra directories
// listed in MYTHOS_WATCH_DIRS (semicolon-separated), debounced, ignoring self-write
// dirs (Checkpoints, Audit) so the entity never perceives its own bookkeeping writes
// as an external event — an unfiltered watch here would let cortex talk to itself.

var fs = require('fs');
var path = require('path');

var IGNORED_DIRS = ['Checkpoints', 'Audit'];
var USER_FACING_DIRS = ['Goals', 'Pipeline'];   // slightly higher salience — see below

function createFileSensor({ bus, config, vault }) {
  if (!bus || typeof bus.emit !== 'function') {
    throw new Error('createFileSensor requires a bus');
  }
  if (!vault || typeof vault.vaultPath !== 'function') {
    throw new Error('createFileSensor requires a vault fs-store with vaultPath()');
  }

  var debounceMs = (config && config.MYTHOS_FILE_DEBOUNCE_MS) || 500;
  var extraDirs = ((config && config.MYTHOS_WATCH_DIRS) || '')
    .split(';').map(function(s) { return s.trim(); }).filter(Boolean);

  var watchers = [];
  var pending = new Map();   // absPath -> timer
  var running = false;

  function isIgnored(absPath) {
    for (var i = 0; i < IGNORED_DIRS.length; i++) {
      if (absPath.indexOf(path.sep + IGNORED_DIRS[i] + path.sep) !== -1) return true;
    }
    return false;
  }

  function salienceFor(absPath) {
    for (var i = 0; i < USER_FACING_DIRS.length; i++) {
      if (absPath.indexOf(path.sep + USER_FACING_DIRS[i] + path.sep) !== -1) return 0.6;
    }
    return 0.4;
  }

  function emitChange(eventType, absPath) {
    if (!running || isIgnored(absPath)) return;
    bus.emit('perception.file', {
      kind: 'file',
      summary: eventType + ' ' + absPath,
      channel: 'file',
      salience: salienceFor(absPath),
      path: absPath,
      eventType: eventType
    });
  }

  function watchDir(dir) {
    if (!fs.existsSync(dir)) return null;
    try {
      var watcher = fs.watch(dir, { recursive: false }, function(eventType, filename) {
        if (!filename) return;
        var absPath = path.join(dir, filename);
        if (pending.has(absPath)) clearTimeout(pending.get(absPath));
        var timer = setTimeout(function() {
          pending.delete(absPath);
          emitChange(eventType, absPath);
        }, debounceMs);
        if (timer.unref) timer.unref();
        pending.set(absPath, timer);
      });
      return watcher;
    } catch (err) {
      bus.emit('health.anomaly', { kind: 'file-watch-failed', dir: dir, error: err.message });
      return null;
    }
  }

  function start() {
    running = true;
    var vaultRoot = vault.vaultPath('.');
    var dirs = [vaultRoot].concat(extraDirs);
    for (var i = 0; i < dirs.length; i++) {
      var w = watchDir(dirs[i]);
      if (w) watchers.push(w);
    }
  }

  function stop() {
    running = false;
    for (var i = 0; i < watchers.length; i++) {
      try { watchers[i].close(); } catch (_) { /* already closed */ }
    }
    watchers = [];
    pending.forEach(function(timer) { clearTimeout(timer); });
    pending.clear();
  }

  return {
    start: start,
    stop: stop,
    isRunning: function() { return running; }
  };
}

module.exports = { createFileSensor };
```

### mythos/src/core/sensors/ws.js

```js
'use strict';

// sensors/ws.js — WS Sensor: turns inbound WebSocket messages into perceptions.
// Phase 9 owns the actual `ws.Server` (server/index.js is not built until then) — this
// sensor's job in Phase 7 is solely the perception-shaping function `ingest()`, which
// Phase 9's connection handler calls per inbound message. start()/stop() here only
// manage connection-scoped bookkeeping (last-seen per connection), replacing NOVA's
// intake.js per the migration map ("WS sensor buffer... connection-scoped memory").
//
// perception.voice for spoken/typed utterances (high salience — human-initiated),
// perception.ws for connection lifecycle / explicit tool-invoke commands.

function createWsSensor({ bus, config }) {
  if (!bus || typeof bus.emit !== 'function') {
    throw new Error('createWsSensor requires a bus');
  }

  var running = false;
  var connections = new Map();   // connectionId -> { lastSeenAt }

  function start() {
    running = true;
  }

  function stop() {
    running = false;
    connections.clear();
  }

  // ingest({ connectionId, kind, text, tool, args }) — called externally by the WS
  // connection handler (Phase 9) for every inbound message.
  // kind: 'utterance' (spoken/typed free text) | 'command' (explicit tool-invoke) |
  //       'connect' | 'disconnect'
  function ingest(msg) {
    if (!running || !msg) return;
    connections.set(msg.connectionId, { lastSeenAt: Date.now() });

    if (msg.kind === 'utterance') {
      bus.emit('perception.voice', {
        kind: 'voice',
        summary: String(msg.text || '').slice(0, 200),
        channel: 'voice',
        salience: 0.8,           // high — human-initiated
        connectionId: msg.connectionId,
        text: msg.text
      });
      return;
    }

    bus.emit('perception.ws', {
      kind: 'ws',
      summary: (msg.kind || 'ws') + ' ' + (msg.tool || ''),
      channel: 'ws',
      salience: msg.kind === 'command' ? 0.8 : 0.3,
      connectionId: msg.connectionId,
      tool: msg.tool,
      args: msg.args
    });
  }

  return {
    start: start,
    stop: stop,
    isRunning: function() { return running; },
    ingest: ingest,
    connectionCount: function() { return connections.size; }
  };
}

module.exports = { createWsSensor };
```

### mythos/src/core/effectors/goals.js

```js
'use strict';

// effectors/goals.js — Goals.md <-> GoalSystem bridge (NEW logic, not a NOVA CA).
// Goals.md stays the human-facing surface (positional checkbox list); GoalSystem
// (src/core/goals/index.js) is the cognition-facing surface (stable-id JSON).
// Join key is (text, created) — NOT positional index — because Goals.md ids are
// rewritten by reindex() on every mutation. See Spec Ambiguities Resolved #6.

var LINE_RE = /^- \[( |x)\] (.+?) · (.+?) · (\d{4}-\d{2}-\d{2}T[\d:.Z-]+)$/;
var BRIDGE_REL_PATH = 'Goals/.md-bridge.json';

function serializeLine(row) {
  return '- [' + (row.done ? 'x' : ' ') + '] ' + row.text + ' · ' + row.category + ' · ' + row.created;
}

function parseGoalsMd(text) {
  var lines = String(text || '').split(/\r?\n/).filter(function(l) { return l.trim().length > 0; });
  var rows = [];
  for (var i = 0; i < lines.length; i++) {
    var m = LINE_RE.exec(lines[i].trim());
    if (m) rows.push({ done: m[1] === 'x', text: m[2], category: m[3], created: m[4] });
  }
  return rows;
}

function createGoalsMdBridge({ fs, goalSystem, bus }) {
  if (!fs || typeof fs.readText !== 'function' || typeof fs.writeText !== 'function') {
    throw new Error('createGoalsMdBridge requires a vault fs-store with readText/writeText');
  }
  if (!goalSystem || typeof goalSystem.create !== 'function') {
    throw new Error('createGoalsMdBridge requires a GoalSystem instance');
  }

  function loadBridgeMap() {
    try { return fs.readJSON(BRIDGE_REL_PATH, []); } catch (_) { return []; }
  }
  function saveBridgeMap(map) {
    try { fs.writeJSON(BRIDGE_REL_PATH, map); }
    catch (err) { if (bus) bus.emit('health.anomaly', { kind: 'goals-bridge-save-failed', error: err.message }); }
  }
  function findGoalIdFor(map, row) {
    for (var i = 0; i < map.length; i++) {
      if (map[i].text === row.text && map[i].created === row.created) return map[i].goalId;
    }
    return null;
  }

  // sync() — call once at boot (and after any external Goals.md edit) to reconcile
  // Goals.md rows into GoalSystem, creating a user-service goal for any unmapped row.
  function sync() {
    var text = fs.readText('Goals.md', '');
    var rows = parseGoalsMd(text);
    var map = loadBridgeMap();
    var changed = false;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var goalId = findGoalIdFor(map, row);
      if (!goalId) {
        var goal = goalSystem.create({
          drive: 'user-service',
          title: row.text,
          status: row.done ? 'done' : 'active',
          reason: 'Goals.md:' + row.category
        });
        map.push({ goalId: goal.id, text: row.text, created: row.created });
        changed = true;
      } else {
        var goal2 = goalSystem.get(goalId);
        var wantStatus = row.done ? 'done' : 'active';
        if (goal2 && goal2.status !== wantStatus && goal2.status !== 'paused') {
          goalSystem.update(goalId, { status: wantStatus });
        }
      }
    }
    if (changed) saveBridgeMap(map);
    return { rows: rows.length, mapped: map.length };
  }

  // writeBack() — call after any GoalSystem mutation to a user-service goal (e.g. cortex
  // marks a goal done) so Goals.md reflects it. Only rewrites rows whose mapped goal's
  // status actually disagrees with the checkbox state; never reorders existing rows.
  function writeBack() {
    var text = fs.readText('Goals.md', '');
    var rows = parseGoalsMd(text);
    var map = loadBridgeMap();

    var out = rows.map(function(row) {
      var goalId = findGoalIdFor(map, row);
      if (!goalId) return row;
      var goal = goalSystem.get(goalId);
      if (!goal) return row;
      return { done: goal.status === 'done', text: row.text, category: row.category, created: row.created };
    });

    // Append any user-service goal that isn't in Goals.md yet (created directly via
    // create_goal effector call rather than an external Goals.md edit).
    var mappedIds = map.map(function(m) { return m.goalId; });
    var userServiceGoals = goalSystem.list({ drive: 'user-service' });
    for (var i = 0; i < userServiceGoals.length; i++) {
      var g = userServiceGoals[i];
      if (mappedIds.indexOf(g.id) === -1) {
        var created = new Date(g.createdAt).toISOString();
        out.push({ done: g.status === 'done', text: g.title, category: 'General', created: created });
        map.push({ goalId: g.id, text: g.title, created: created });
      }
    }

    var serialized = out.map(serializeLine).join('\n') + (out.length ? '\n' : '');
    fs.writeText('Goals.md', serialized);
    saveBridgeMap(map);
    return { rows: out.length };
  }

  // CROSS-PHASE FIX (consistency pass, P7 vs P9): P9's server/index.js requires
  // effectors.get('goals-effector') exposing listGoals/addGoal/toggleGoal/
  // deleteGoal/stats returning NOVA app/lib/goals.js's {id,text,category,done}
  // shape — this bridge originally only exposed sync/writeBack internally, never
  // a REST-facing surface. `id` here is the GoalSystem UUID (via the bridge map),
  // not a positional index — a strict improvement over NOVA's positional ids
  // (immune to reindex-on-delete drift), while keeping the field NAME identical
  // so P9's REST handlers need no shape translation.
  function listGoals() {
    var text = fs.readText('Goals.md', '');
    var rows = parseGoalsMd(text);
    var map = loadBridgeMap();
    return rows.map(function(row) {
      return { id: findGoalIdFor(map, row), text: row.text, category: row.category, done: row.done };
    });
  }

  function addGoal(text, category) {
    var goal = goalSystem.create({
      drive: 'user-service',
      title: text,
      status: 'active',
      reason: 'goals-effector:addGoal'
    });
    var created = new Date(goal.createdAt).toISOString();
    var map = loadBridgeMap();
    map.push({ goalId: goal.id, text: text, created: created });
    saveBridgeMap(map);
    writeBack();
    return listGoals();
  }

  function toggleGoal(id) {
    var goal = goalSystem.get(id);
    if (!goal) return listGoals();
    goalSystem.update(id, { status: goal.status === 'done' ? 'active' : 'done' });
    writeBack();
    return listGoals();
  }

  function deleteGoal(id) {
    var map = loadBridgeMap().filter(function(m) { return m.goalId !== id; });
    saveBridgeMap(map);
    goalSystem.remove(id);
    writeBack();
    return listGoals();
  }

  function stats() {
    var all = listGoals();
    return { total: all.length, done: all.filter(function(g) { return g.done; }).length, active: all.filter(function(g) { return !g.done; }).length };
  }

  return {
    sync: sync, writeBack: writeBack, parseGoalsMd: parseGoalsMd,
    listGoals: listGoals, addGoal: addGoal, toggleGoal: toggleGoal, deleteGoal: deleteGoal, stats: stats
  };
}

module.exports = { createGoalsMdBridge, parseGoalsMd };
```

### `mythos/src/core/effectors/hub.js` (registration excerpt — 'goals-effector' wiring)

CROSS-PHASE FIX continued: the bridge above was never registered in the hub under
a discoverable id, so `effectors.get('goals-effector')` (P9's requirement) would
have returned `undefined`. Registration lives in `registerEffectors()` alongside
the 45 tool effectors:

```js
var goalsBridge = createGoalsMdBridge({ fs: ctx.memory.fs, goalSystem: ctx.goals, bus: ctx.bus });
goalsBridge.sync();  // reconcile Goals.md -> GoalSystem once at boot
hub.registerNamed('goals-effector', goalsBridge);
// hub.registerNamed(id, obj) is a thin addition alongside hub.register(effector)
// — the latter is for TIER_TABLE-gated tool effectors keyed by tool name; the
// former is for internal service objects (goals/kanban/pipeline bridges) keyed
// by a synthetic id, never dispatched through leash.check() since they're not
// tools a Cortex decision can invoke directly. kanban-effector/pipeline-effector
// (§15 "Unchanged" CA targets) register the same way.
```

### mythos/src/core/effectors/voice.js

```js
'use strict';

// effectors/voice.js — TTS as an Effector (CA from app/lib/voice/tts.js). Registered in
// the hub as id 'speak', tier 0 (read-only side effect on the human's speakers, not on
// entity state — no different in kind from a log line). Truncation logic is verbatim.

var edgeTts = require('../../../providers/edge-tts');

var MAX_CHARS = 350;

function truncateAtSentenceBoundary(text, maxChars) {
  maxChars = maxChars || MAX_CHARS;
  var trimmed = String(text || '').trim();
  if (trimmed.length <= maxChars) return trimmed;
  var window = trimmed.slice(0, maxChars);
  var sentenceEnd = Math.max(
    window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '),
    (window.endsWith('.') || window.endsWith('!') || window.endsWith('?')) ? window.length - 1 : -1
  );
  if (sentenceEnd > 0) return window.slice(0, sentenceEnd + 1).trim();
  var spaceIdx = window.lastIndexOf(' ');
  if (spaceIdx > 0) return window.slice(0, spaceIdx).trim();
  return window.trim();
}

function createVoiceEffector({ config }) {
  var defaultVoice = (config && config.VOICE_TTS_VOICE) || 'en-US-AriaNeural';

  return {
    id: 'speak',
    tier: 0,
    describe: function() { return 'Synthesize text to speech via the local edge-tts service.'; },
    validate: function(params) {
      if (!params || !params.text || !String(params.text).trim()) {
        return { ok: false, reason: 'text is required' };
      }
      return { ok: true };
    },
    async invoke(params) {
      try {
        var available = await edgeTts.isAvailable();
        if (!available) return { ok: false, result: 'tts-unavailable' };
        var truncated = truncateAtSentenceBoundary(params.text);
        var buf = await edgeTts.synthesize({ text: truncated, voice: params.voice || defaultVoice });
        return { ok: true, result: { audioBase64: buf.toString('base64'), truncated: truncated !== params.text } };
      } catch (err) {
        return { ok: false, result: err.message };
      }
    }
  };
}

module.exports = { createVoiceEffector, truncateAtSentenceBoundary };
```

### Worked example: T0/T1 tool catalog — mythos/src/core/effectors/from-computer.js

This demonstrates the mechanical pattern every `from-*.js` file follows: import the NOVA `TOOLS` array (function bodies verbatim, requires re-pointed), map each through `effectorFromTool`, register with the hub. `tools-computer.js` is the smallest catalog (4 tools, all T0/T1) so it is reproduced in full; `from-pc.js`/`from-browser.js`/`from-dashboard.js` follow the identical shape and are **not** reproduced tool-by-tool (see mapping table).

```js
'use strict';

// effectors/from-computer.js — CA of app/lib/voice/tools-computer.js. Function bodies
// (open_folder/list_folder/read_file/compose_email) are verbatim from NOVA; only the
// module-level requires changed (none needed here — this file has no NOVA lib deps).
// Registration is the only Phase-7-specific addition.

var fs = require('fs');
var path = require('path');
var os = require('os');
var { spawn } = require('child_process');
var { effectorFromTool } = require('./adapter');

// ... open_folder/list_folder/read_file/compose_email/resolveSandboxed/etc. verbatim
// from app/lib/voice/tools-computer.js (see that file for the full ~180-line body —
// reproducing it again here would be redundant with the existing, unchanged NOVA source).

var TOOLS = require('../../../../app/lib/voice/tools-computer').TOOLS;
// ^ Illustrative require shown for pattern clarity only — the real migration COPIES the
// file into mythos/ (per §15's "CA: Fn bodies verbatim, requires re-pointed"); MYTHOS
// must never depend on app/ at runtime. The shipped from-computer.js pastes the four
// function bodies + TOOLS array directly, with zero cross-tree require.

function registerFromComputer(hub) {
  for (var i = 0; i < TOOLS.length; i++) {
    hub.register(effectorFromTool(TOOLS[i]));
  }
  return TOOLS.length;
}

module.exports = { registerFromComputer, TOOLS };
```

### Worked example: T3 tool — mythos/src/core/effectors/from-project.js

```js
'use strict';

// effectors/from-project.js — CA of app/lib/voice/tools-project.js (1 tool: start_project,
// tier 3 per TIER_TABLE). Calls into effectors/pipeline.js + effectors/agent-actions.js
// instead of NOVA's ../pipeline + ../agent-actions.

var pipelineEffector = require('./pipeline');
var agentActions = require('./agent-actions');
var { effectorFromTool } = require('./adapter');

function startProject({ description }) {
  if (!description || !String(description).trim()) {
    return { ok: false, result: 'A project description is required.' };
  }
  try {
    var card = pipelineEffector.capture(String(description).trim(), 'voice');
    pipelineEffector.approve(card.id);
    var job = agentActions.executePipelineCard(card.id);
    return { ok: true, result: { cardId: card.id, jobId: job.job.id } };
  } catch (err) {
    return { ok: false, result: 'Could not start project: ' + err.message };
  }
}

var TOOLS = [{
  name: 'start_project',
  description: 'Start building a project the user has confirmed.',
  params: { description: 'string - complete build specification' },
  danger: false,
  fn: startProject
}];

function registerFromProject(hub) {
  hub.register(effectorFromTool(TOOLS[0]));
  return TOOLS.length;
}

module.exports = { registerFromProject, TOOLS, startProject };
```

### Mechanical files, not reproduced (follow the pattern above exactly)

| File | Source | Special re-pointing needed |
|---|---|---|
| `from-dashboard.js` | `tools-dashboard.js` (20 tools) | `create_goal`/`list_goals`/`toggle_goal`/`delete_goal`/`capture_idea`/`pipeline_*`/`kanban_*` call `effectors/goals.js`, `effectors/pipeline.js`, `effectors/kanban.js`, `effectors/agent-actions.js` instead of NOVA's `../goals`/`../pipeline`/`../kanban`/`../agent-actions`; `read_status`/`job_status` call `build-runner.getJob/listJobs` instead of `orchestrator`; `ask_agent`'s `setAskAgentDispatch` wiring is unchanged (still injected by whatever owns Brain dispatch, now `brain.think` not `reasoning.chat`) |
| `from-pc.js` | `tools-pc.js` (10 tools) | requires `adapters/pc-child` (re-pathed, untouched) instead of `./pc-child` |
| `from-browser.js` | `tools-browser.js` (10 tools) | requires `adapters/browser-agent` (re-pathed, untouched) instead of `./browser-agent` |
| `agent-actions.js` | `app/lib/agent-actions.js` | `executePipelineCard`/`assembleKanbanPlan`/`buildKanbanCard` call `buildRunner.enqueue({kind, prompt, run})` (no `cardId` arg) instead of `orchestrator.enqueue({kind, cardId, prompt, run})`; card/id association moves into the `run` closure per Ambiguity #7 |
| `pipeline.js` | `app/lib/pipeline.js` | verbatim CRUD, re-pointed from `require('./vault')` to the injected `fs` fs-store |
| `kanban.js` | `app/lib/kanban.js` | verbatim CRUD, same re-pointing |
| `adapters/s2s/`, `adapters/pc-child/`, `adapters/browser-agent/` | `app/lib/s2s/*`, `app/lib/voice/pc-child.js`, `app/lib/voice/browser-agent.js` | untouched, only `require()` paths updated |

## Integration Points

| Direction | Call | Real signature (file:line) |
|---|---|---|
| Phase 7 → Brain (P2) | `brain.think({lane, messages, schemaHint?, budget?, signal?, source})` → `{content, parsed, provider, model, spentTokens, offline, lane}` | `mythos/src/core/brain/index.js:45` (`createBrain(...).think`) — exact param names, do not paraphrase |
| Phase 7 → Leash (P5, assumed shipped) | `tierOf(toolName)` → `number` (default 3 for unmapped) | `mythos/src/core/leash/tiers.js` (not yet in repo — per given cross-phase convention) |
| Phase 7 → Immune (P6, assumed shipped) | `createBreaker({name, bus, config})` → `{allow(), recordSuccess(), recordFailure()}` | `mythos/src/core/immune/breakers.js` (not yet in repo — signature **assumed** per §12 sketch, re-verify once P6 ships, see Ambiguity #4) |
| Phase 7 → Memory (P1) | `fs.readText/writeText/readJSON/writeJSON/vaultPath/ensureDir` | `mythos/src/core/memory/fs-store.js` |
| Phase 7 → Goals (P4) | `goalSystem.create/get/update/list({drive})` | `mythos/src/core/goals/index.js:22,52,56,92` |
| Cortex (P3) → Phase 7 | `effectors.invoke(decision.tool, decision.args, {signal, bus, goalId})` → `{ok, result}` | `mythos/src/core/cortex/index.js:131-132` (`act()`) — **exact string** `effectors.invoke`, three positional args |
| Cortex (P3) → Phase 7 | `effectors.breakers.allow(decision.tool)` (boolean) | `mythos/src/core/cortex/index.js:121-122` — this is why `breakers` cannot be a raw `Map` (Ambiguity #4) |
| main.js boot → Phase 7 | `sensor.start()` / `sensor.stop()` (zero-arg) | new — `sensors/file.js`, `sensors/ws.js`, `sensors/job.js` |
| Bus (P0) → Working Memory (P1) bridge | `bus.subscribe('perception.*', function(e) { memory.working.pushPerception(e.payload); })` | **must be added** in `main.js`'s `sensors` boot step (does not exist today — verified by `grep` showing zero live subscribers to `perception.*` anywhere in `src/`) |
| Phase 9 (future) → Phase 7 | `wsSensor.ingest({connectionId, kind, text|tool, args})` | new — `sensors/ws.js` `ingest()`; Phase 9's WS message handler is the caller, not built yet |

### main.js boot-step diff (lesson #2 — wire in the same PR)

The `sensors` and `effectors` boot steps in the 14-step sequence (currently unbuilt per D-04) must, for this phase, do exactly this:

```js
{ name: 'effectors', fail: 'fast', fn: function() {
  var hub = createEffectorHub({ bus: bus, config: config });
  require('./core/effectors/from-dashboard').registerFromDashboard(hub);
  require('./core/effectors/from-computer').registerFromComputer(hub);
  require('./core/effectors/from-pc').registerFromPc(hub);
  require('./core/effectors/from-browser').registerFromBrowser(hub);
  require('./core/effectors/from-project').registerFromProject(hub);
  hub.register(require('./core/effectors/voice').createVoiceEffector({ config: config }));
  var buildRunner = createBuildRunner({ config: config, brain: brain, bus: bus, vault: memory.fs });
  effectors = hub;   // captured for the cortex/sensors steps below
} },
{ name: 'sensors', fail: 'fast', fn: function() {
  bus.subscribe('perception.*', function(e) { memory.working.pushPerception(e.payload); });
  var fileSensor = createFileSensor({ bus: bus, config: config, vault: memory.fs });
  var wsSensor = createWsSensor({ bus: bus, config: config });
  var jobSensor = createJobSensor({ bus: bus, buildRunner: buildRunner });
  timerSensor.start(); fileSensor.start(); jobSensor.start();
  // wsSensor.start() is a no-op until Phase 9 owns real connections; still started
  // so isRunning()/stop() behave consistently in shutdown.
  wsSensor.start();
} }
```

If either step throws, boot fails fast (per the 14-step table) — this is a **fail-fast** step, not degraded, because a Cortex with zero registered effectors is not a smaller entity, it is a broken one (every `decide()` output would dead-end at `unknown-effector`).

## Anti-Drift Checklist

1. Verify `TIER_TABLE`'s literal keys against `tierOf()` for every one of the 45 real tool names before registering — a typo'd tool name (e.g. `kanban_move_card` vs `kanban_movecard`) silently falls to the T3 default rather than erroring, which looks like "it works" (just annoyingly over-gated) instead of failing loudly.
2. `open_artifact` has no `TIER_TABLE` entry (Ambiguity #2) — do not "fix" this inside `adapter.js` by hardcoding a special case; either leave it at the T3 default or route the fix through `leash/tiers.js` where it belongs.
3. Every sensor emits `.salience` (flat, top-level), never `.salienceHint`, never nested under an inner `.payload` — grep new sensor files for `salienceHint` before merge; it must return zero hits.
4. Every new `create*Sensor`/`create*Effector` factory takes `{bus, config, ...}` and throws in its constructor if a hard dependency (`buildRunner`, `vault`, `goalSystem`) is missing — never silently no-ops at call time (lesson #3/#8). `hub.register()` must throw on malformed effectors, not skip them.
5. `build-runner.enqueue()`'s object literal must be exactly `{kind, prompt, run}` — no `cardId` key. Grep the four call sites (`from-project.js`, `agent-actions.js` ×3) to confirm none pass it.
6. `brain.think({lane: 'build', ...})` — never `reasoning.chat()` (deleted) or a hardcoded provider call. Grep `build-runner.js` for the literal string `reasoning` — must return zero hits.
7. Bus event type strings used by this phase — `perception.file`, `perception.ws`, `perception.voice`, `perception.job` — are copy-pasted, not re-typed from memory, in every emit site. Add these four to whatever event-name allowlist test Phase 5+ introduces per Risk R8.
8. `hub.js`'s `breakers` getter must expose `.allow(name)`/`.recordSuccess(name)`/`.recordFailure(name)` — confirm `cortex/index.js`'s real `act()` still calls exactly `effectors.breakers.allow(decision.tool)` (not some renamed variant) before wiring, since that's the one existing call site this design decision protects.
9. `openrouter.js`/`claude-cli.js` remain unimported by anything this phase adds — grep `mythos/src/core/effectors/` and `adapters/` for `openrouter` and `claude-cli`; must return zero hits.
10. `effectors/goals.js`'s `sync()`/`writeBack()` join Goals.md rows to GoalSystem goals by `(text, created)`, never by array index — a unit test must assert that deleting the *first* Goals.md row does not remap any surviving row's GoalSystem id.
11. `file.js`'s watch must exclude `Checkpoints/` and `Audit/` — a test must write to `vault/Checkpoints/` during a live watch and assert zero `perception.file` events fire.
12. `main.js`'s `sensors` boot step must include the `bus.subscribe('perception.*', ...)` bridge line — without it, every sensor in this phase emits into the void (bus history only) and Cortex's `working.drainPerceptions()` stays empty forever, exactly reproducing D-04's "never actually wired" failure mode one phase later.
13. Do not add `openrouter`/`claude-cli` to `chain.js`'s LANES as a side effect of "cleaning up while I'm in here" — that is Phase 2's file and out of scope; flag, don't fix.

## Test Plan

Maps to the ROADMAP gate: **danger→tier≥3, invoke normalization, 45 registered count, build-runner queued→done + restart-failed, job sensor perception.**

1. `effectors-adapter.test.js` — `effectorFromTool` sets `tier` from a fake `tierOf` fixture, normalizes both `{ok,result}` and bare-value returns, and catches a throwing `tool.fn` into `{ok:false, result: err.message}`.
2. `effectors-hub.test.js` — register 3 fake effectors; `invoke('unknown', ...)` → `unknown-effector`; three failures trip the breaker → `circuit-open`; `hub.breakers.allow(name)` works as a direct method call (regression guard for Ambiguity #4).
3. **`danger→tier≥3`**: a table-driven test over the real `TIER_TABLE` asserting every tool marked `danger:true` or with a `dangerWhen` in the five real NOVA `TOOLS` arrays maps to `tierOf(name) >= 3`.
4. **`45 registered count`**: boot a hub with all five `register*` functions against the *real* copied `TOOLS` arrays (not fakes) and assert `hub.count() === 45`.
5. `build-runner.test.js` — **queued→done**: `enqueue()` returns a `queued` job synchronously; a fake `brain.think` resolving with `{content:'ok', offline:false}` drives it through `running`→`writing-artifact`→`done`, `onJobUpdate` fires once per transition. **restart-failed**: seed `vault/Checkpoints/build-jobs.json` with a `running` job, construct a fresh `createBuildRunner`, assert `getJob(id).status === 'failed'` and `error` mentions "restarted".
6. `sensors-job.test.js` — a fake `buildRunner.onJobUpdate` fixture firing a `failed` job asserts `bus` receives `perception.job` with `salience: 0.7`.
7. `sensors-file.test.js` — write into a temp vault dir under `Checkpoints/`, assert zero `perception.file` events after the debounce window; write under a non-ignored dir, assert exactly one (debounced) event.
8. `effectors-goals-md.test.js` — seed `Goals.md` with 3 rows, call `sync()`, assert 3 GoalSystem goals created with `drive:'user-service'`; delete the first row, re-run `sync()`, assert the *other two* goals kept their original `goalId` (join-by-content regression test for Ambiguity #6).
9. **Real-instance integration test (lesson #4)** — `integration-cortex-effectors.test.js`: construct a **real** `createCortex`, **real** `createEffectorHub` with one real `effectorFromTool`-wrapped test tool registered (tier 0), a **real** (non-fake) `leash` stub only where Leash itself isn't in scope, and drive one `tickOnce()` end-to-end, asserting the actual bus event sequence `tick` → `action.completed` and that `effectors.breakers.allow` was actually exercised by the real hub, not a mock — this is the exact class of seam bug (D-38) that per-module unit tests missed in Phase 3/4.

```js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('../src/core/bus');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { createCortex } = require('../src/core/cortex');

describe('integration: real cortex + real effector hub', () => {
  it('dispatches a decision through the real hub and records action.completed', async () => {
    const bus = createBus({ historySize: 50 });
    const hub = createEffectorHub({ bus, config: {} });
    // register.() would normally call createBreaker from immune/breakers.js (P6);
    // substitute only that one leaf dependency since P6 is out of this phase's scope —
    // everything above the leaf (hub, effector, adapter) is real.
    hub.register({
      id: 'test_tool', tier: 0,
      describe: () => 'test',
      validate: () => ({ ok: true }),
      invoke: async () => ({ ok: true, result: 'done' })
    });

    const memory = { working: {
      tick: 0, activeGoalId: null, spendThisTick: 0,
      drainPerceptions: () => [], resetTickState() { this.spendThisTick = 0; },
      pushPerception() {}, addSpend() {}
    }, episodic: { write: async () => ({ ref: 'ep-1' }) }, consolidate: async () => {} };
    const goals = {
      getActive: () => null, hasActive: () => false,
      arbitrate: () => ({ id: 'goal-1' }),
      plan: async () => ({ tool: 'test_tool', args: {} }),
      debitBudget: () => {}
    };
    const leash = { check: () => ({ allow: true, requireConfirm: false, tier: 0 }) };

    const cortex = createCortex({ bus, memory, goals, brain: null, leash, effectors: hub, config: { MYTHOS_TICK_MS: 1000 } });
    memory.working.drainPerceptions = () => [{ summary: 'x', channel: 'test', salience: 0.9 }];

    await cortex.tickOnce();

    const history = bus.history();
    assert.ok(history.some((e) => e.type === 'action.completed' && e.payload.ok === true));
  });
});
```

## Do NOT

- Do not paraphrase any bus event name — `perception.file`, `perception.ws`, `perception.voice`, `perception.job` must appear character-for-character at every emit site; a hyphen/dot slip here reproduces D-28/D-36/D-37 one phase later.
- Do not include `cardId` in `build-runner.enqueue()`'s argument object — the field does not exist in this signature.
- Do not make `effectors.breakers` a raw `Map` — it must expose `.allow()`/`.recordSuccess()`/`.recordFailure()` or the real, already-shipped `cortex/index.js:121` call throws on first use.
- Do not wire `providers/openrouter.js` or `providers/claude-cli.js` into any tool, effector, or lane — no legitimate use exists for them in this phase; leave them orphaned pending an explicit D-29/D-30 decision elsewhere.
- Do not implement any gate/check (breaker allow, leash check, effector lookup) as `if (dependency && typeof dependency.method === 'function')` — every hard dependency must be validated once at construction (throw if missing), never silently skipped at call time.
- Do not call `fs.unlinkSync` (or any permanent delete) anywhere in this phase's code — none of these modules have a legitimate decay/prune concern, but if one is ever added, archive, don't delete.
- Do not join Goals.md rows to GoalSystem goals by array position/index — positions are rewritten by `reindex()` on every mutation; join on `(text, created)`.
- Do not open a real `ws.Server`/`net.Server` inside `sensors/ws.js` — no live WS server exists until Phase 9; this phase only ships the `ingest()` perception-shaping function.
- Do not hand-roll a new default for `MYTHOS_BUILD_CONCURRENCY`/`MYTHOS_JOBS_MAX_PERSISTED`/`MYTHOS_WATCH_DIRS`/`MYTHOS_FILE_DEBOUNCE_MS` inside a module — add the schema keys once (done above) and read `config.KEY_NAME` everywhere else.
- Do not reproduce all 45 tool function bodies by hand in new files — copy the existing NOVA source files' function bodies verbatim (mechanical CA) rather than reimplementing any of them; only the `require()` paths and the enqueue-shape call sites change.
- Do not skip adding the `bus.subscribe('perception.*', ...)` → `memory.working.pushPerception(e.payload)` bridge in `main.js`'s boot sequence — every sensor this phase builds is dead code without it.

---

# Phase 8 — Identity

## Overview & Why

Phase 8 gives MYTHOS a self-model and a human-controlled ceiling on its own autonomy. Two things ship together: `src/core/memory/identity.js`, a fifth `MemoryStore` (closing drift item **D-15**, never built in Phase 1) that persists the entity's editable self-description (`self.md`) with the same markdown+sidecar contract as `semantic.js`/`skills.js`; and `src/core/identity/index.js`, the higher-level module that boots from that store, exposes `checkBoundary`/`persona`/`learn`, and — critically — is the *only* code path in the entire codebase permitted to read `vault/Identity/boundaries.md`. Nothing else in MYTHOS may parse that file. Without this phase, `boundaries.md` is decorative: Leash's tier ceiling is fixed by `config.AUTONOMOUS_MAX_TIER` alone and a human editing the vault file has zero effect, silently defeating the "Human Sovereignty" principle (§1, principle 4) and the P8 gate's own literal wording ("edit changes tier ceiling").

## Directory & File Layout

| Path | Status | Purpose |
|---|---|---|
| `mythos/src/core/memory/identity.js` | **NEW** (closes D-15) | Identity *store* — self.md read/write, learned-pref sidecars, `MemoryStore` contract |
| `mythos/src/core/memory/index.js` | **MODIFIED** | Wire `identity` store into the memory facade (dirs already lists `Identity`) |
| `mythos/src/core/identity/index.js` | **NEW** (headline P8 deliverable) | Identity *module* — boot-time self/boundaries cache, `checkBoundary`/`persona`/`learn`/`getMaxAutonomousTier` |
| `mythos/vault/Identity/self.md` | **NEW** (seed) | Entity-writable — purpose/values/persona + learned preferences |
| `mythos/vault/Identity/boundaries.md` | **NEW** (seed) | Human-editable ONLY — deny list, tier ceiling, allowed dirs |
| `mythos/src/core/brain/index.js` | **MODIFIED** | `createBrain` accepts optional `identity`, uses `identity.persona()` for system-prompt injection instead of hardcoded `config.MYTHOS_NAME` |
| `mythos/src/core/leash/index.js` | **MODIFIED** (P5 file, patched here) | `maxTier` becomes `Math.min(config.AUTONOMOUS_MAX_TIER, identity.getMaxAutonomousTier())` |
| `mythos/src/main.js` | **MODIFIED** | New `identity` boot step (DEGRADED); `leash` and `brain` construction moved to run after it |
| `mythos/test/identity.test.js` | **NEW** | Store + module unit tests |
| `mythos/test/identity-leash-integration.test.js` | **NEW** | Real-instance integration test (lesson #4) |
| `mythos/test/identity-boundaries-contract.test.js` | **NEW** | The "no write path to boundaries.md" contract test |

## Spec Ambiguities Resolved

**1. "Identity" appears twice in §3/§5 (a MemoryStore) and once in §11 (a module with no `recall()`/`consolidate()`) — which is it?**
Both, and they are different files. §5's "MEMORY (5 stores): Episodic, Semantic, Skills, Identity, Audit" describes `memory/identity.js` — a store implementing `init/write/recall/get/consolidate/stats` exactly like `semantic.js`, over `self.md` only. §11's `createIdentity({bus, config, vault})` describes `identity/index.js` — a boot-cached module with no `recall()` because it isn't a search surface, it's a permanently-cached self/boundaries snapshot. The module *uses* the store to persist what it learns; the store has no idea boundaries.md exists. ROADMAP.md files D-15 against Phase 1 and explicitly warns (line 395-397) not to conflate the two — this spec builds both, in this phase, because nothing built the store in Phase 1 or in the Phase 4.5 remediation pass and P8 cannot function without it.

**2. Spec's `vault.readText(path, defaultsObject)` returns a parsed object; the real `fs-store.readText(relPath, fallback)` (verified in `mythos/src/core/memory/fs-store.js:21-30`) returns a raw string with a string/primitive fallback.**
The spec's §11 pseudocode is illustrative shorthand, not the real `fs` API. `identity/index.js` owns markdown↔object parsing itself: `parseSelfMarkdown()` extracts `## Purpose`/`## Values`/`## Persona` sections with regex, falling back to the exact default strings from §11 when a section is absent; `parseBoundariesMarkdown()` parses `deny:`/`max_autonomous_tier:`/`allowed_dirs:` lines per the Boundaries Schema. The constructor param is named `fs` (not `vault`) to match every other store's convention (`semantic.js`, `skills.js` all destructure `{ fs, config, bus, logger }`).

**3. Leash's own §9 code (`const maxTier = config.AUTONOMOUS_MAX_TIER || 2;`) never reads `boundaries.max_autonomous_tier` at all, yet the P8 gate requires "edit [boundaries.md] changes tier ceiling."**
This is the P5↔P8 integration point named explicitly in the task. Resolution: **most-restrictive-wins**. `identity.getMaxAutonomousTier()` returns `boundaries.max_autonomous_tier` (fail-safe default `1`), and Leash's `check()` computes `const maxTier = Math.min(config.AUTONOMOUS_MAX_TIER, identity.getMaxAutonomousTier());`. Neither surface can *raise* autonomy above what the other allows — only lower it. This matches the fail-safe posture already used everywhere else in §11 (malformed boundaries → tier 1, not tier 4) and treats `boundaries.md` as an additional ceiling layered on top of `config.AUTONOMOUS_MAX_TIER`, never a replacement for it. A human can tighten the ceiling at runtime by editing the vault file and restarting; they cannot use it to *loosen* a ceiling `.env` deliberately set lower. Hot file-watching (no restart) is explicitly out of scope — YAGNI; boundaries are re-read once at boot like every other config surface.

**4. `createLeash({bus, config, identity, auditWriter})` (§9) hard-requires `identity`, but the spec's 14-step boot order (§13) lists the FAIL-FAST `cortex` step *before* the DEGRADED `identity` step, and D-39 (assumed fixed) makes `createCortex` throw if `leash` is missing.**
This is a real ordering conflict in the architecture doc, not something this phase can silently paper over. Resolution: the early named `cortex` FAIL-FAST step validates only static deps (`bus`, `config`, module-loadability) — it does not yet call the full `createCortex({..., goals, brain, leash, effectors})`. That full call is deferred to the point in the Final block immediately after `effectors` is registered (the last dependency to become available), immediately before `cortex-tick`. This phase does not touch that deferral (it's P3/P7's ownership) but it *does* introduce the identity/leash/brain sequencing described in the boot diff below, and flags this for whoever lands the `cortex` construction call: it must run after `leash` exists, which now (as of this phase) means after `identity` exists.

**5. Should `createBrain` hard-require `identity` (per lesson #3's "mandatory gating") the way Leash hard-requires it?**
No — lesson #3's mandatory-throw rule applies to *safety gates* (tier checks, breaker checks, effector dispatch) where a silent no-op means an unsafe action executes. Persona injection is cosmetic content, not a safety gate; forcing every existing/future caller of `createBrain` (including P2's own test suite, which constructs brain without identity) to supply identity would violate "surgical changes" for no safety benefit. `identity` is an **optional** third constructor param with a graceful fallback to the pre-existing `config.MYTHOS_NAME` string, preserving `createBrain({config, bus})` as a still-valid call.

## Full Code

### `mythos/src/core/memory/identity.js` (NEW — closes D-15)

```js
'use strict';

// Identity memory store — human-readable markdown with parseable sidecar
// vault/Identity/self.md — ENTITY-WRITABLE (see identity/index.js for the
// human-only boundaries.md, which this file never reads or writes)
// Format:
//   # Self
//   ## Purpose
//   ...
//   ## Values
//   ...
//   ## Persona
//   ...
//   ## Learned Preferences
//   - Fact one
//   <!-- {id: 'idn-abc123', ts: 1700000000, source: 'ep-001', confidence: 0.6} -->

function createIdentityStore({ fs, config, bus, logger }) {
  var SELF_PATH = 'Identity/self.md';
  var ARCHIVE_PATH = 'Identity/_archive.md';
  var SIDECAR_RE = /<!--\s*(\{[^}]+\})\s*-->/g;
  var PREF_BLOCK_RE = /^-\s+(.+)\n<!--\s*(\{[^}]+\})\s*-->$/gm;

  var SEED_SELF_MD = [
    '# Self',
    '',
    '## Purpose',
    'An autonomous entity that assists its operator.',
    '',
    '## Values',
    'Helpfulness, honesty, efficiency.',
    '',
    '## Persona',
    (config && config.MYTHOS_NAME) || 'MYTHOS',
    '',
    '## Learned Preferences',
    '<!-- populated at runtime by identity.learn() -->',
    ''
  ].join('\n');

  function generateId() {
    return 'idn-' + Math.random().toString(36).slice(2, 10);
  }

  function readRaw() {
    return fs.readText(SELF_PATH, SEED_SELF_MD);
  }

  function parsePrefs(raw) {
    var prefs = [];
    var m;
    var re = new RegExp(PREF_BLOCK_RE.source, PREF_BLOCK_RE.flags);
    while ((m = re.exec(raw)) !== null) {
      try {
        prefs.push({ text: m[1].trim(), sidecar: JSON.parse(m[2]) });
      } catch (_) {
        // Skip malformed sidecar
      }
    }
    return prefs;
  }

  function extractSection(raw, header) {
    var re = new RegExp('## ' + header + '\\n([\\s\\S]*?)(?=\\n## |\\n*$)');
    var m = raw.match(re);
    return m ? m[1].trim() : null;
  }

  // Header write — purpose/values/persona. Preserves Learned Preferences untouched.
  function writeHeader(fields) {
    fields = fields || {};
    var raw = readRaw();
    var purpose = fields.purpose !== undefined ? fields.purpose : extractSection(raw, 'Purpose');
    var values = fields.values !== undefined ? fields.values : extractSection(raw, 'Values');
    var persona = fields.persona !== undefined ? fields.persona : extractSection(raw, 'Persona');
    var prefsRaw = raw.match(/## Learned Preferences\n[\s\S]*$/);

    var content = [
      '# Self', '',
      '## Purpose', purpose || '', '',
      '## Values', values || '', '',
      '## Persona', persona || '', ''
    ].join('\n') + (prefsRaw ? prefsRaw[0] : '## Learned Preferences\n');

    try {
      fs.writeText(SELF_PATH, content);
      return { ok: true };
    } catch (err) {
      bus.emit('health.anomaly', { kind: 'memory-write-failed', store: 'identity', error: err.message });
      return { ok: false, degraded: true };
    }
  }

  // Learned-pref write — the ONLY write() the 5-store MemoryStore contract exposes.
  function write(prefText, opts) {
    opts = opts || {};
    var id = opts.id || generateId();
    var sidecar = JSON.stringify({
      id: id,
      ts: Date.now(),
      source: opts.source || 'unknown',
      confidence: opts.confidence !== undefined ? opts.confidence : 0.5
    });
    var block = '- ' + prefText + '\n<!-- ' + sidecar + ' -->\n';

    var raw = readRaw();
    if (/## Learned Preferences\n/.test(raw)) {
      raw = raw.replace(/## Learned Preferences\n/, '## Learned Preferences\n' + block);
    } else {
      raw = raw.replace(/\s*$/, '') + '\n\n## Learned Preferences\n' + block;
    }

    try {
      fs.writeText(SELF_PATH, raw);
      return { ref: id, degraded: false };
    } catch (err) {
      bus.emit('health.anomaly', { kind: 'memory-write-failed', store: 'identity', error: err.message });
      return { ref: null, degraded: true };
    }
  }

  function recall(query, opts) {
    opts = opts || {};
    var limit = opts.limit || 10;
    var raw = readRaw();
    var prefs = parsePrefs(raw);
    var terms = query.toLowerCase().split(/\s+/);
    var hits = [];

    for (var i = 0; i < prefs.length; i++) {
      var lower = prefs[i].text.toLowerCase();
      var matched = terms.filter(function(t) { return lower.includes(t); }).length;
      var score = terms.length > 0 ? matched / terms.length : 0;
      if (score > 0) {
        hits.push({
          ref: prefs[i].sidecar.id,
          score: score,
          record: prefs[i],
          snippet: prefs[i].text.slice(0, 200),
          store: 'identity'
        });
      }
    }

    hits.sort(function(a, b) { return b.score - a.score; });
    return hits.slice(0, limit);
  }

  function get(ref) {
    var prefs = parsePrefs(readRaw());
    for (var i = 0; i < prefs.length; i++) {
      if (prefs[i].sidecar.id === ref) return prefs[i];
    }
    return null;
  }

  // Consolidate: archive (never delete — see lesson #5 / D-18) low-confidence prefs.
  function consolidate(opts) {
    opts = opts || {};
    var threshold = opts.threshold !== undefined ? opts.threshold : 0.2;
    var raw = readRaw();
    var prefs = parsePrefs(raw);
    var keep = [];
    var archived = [];

    for (var i = 0; i < prefs.length; i++) {
      if (prefs[i].sidecar.confidence < threshold) {
        archived.push(prefs[i]);
      } else {
        keep.push(prefs[i]);
      }
    }

    if (archived.length === 0) {
      return { moved: 0, distilled: 0, archived: 0 };
    }

    var archiveLines = archived.map(function(p) {
      return '- ' + p.text + '\n<!-- ' + JSON.stringify(p.sidecar) + ' -->';
    }).join('\n') + '\n';
    var existingArchive = fs.readText(ARCHIVE_PATH, '# Identity Archive\n\n');
    fs.writeText(ARCHIVE_PATH, existingArchive + archiveLines);

    var keptBlock = '## Learned Preferences\n' + keep.map(function(p) {
      return '- ' + p.text + '\n<!-- ' + JSON.stringify(p.sidecar) + ' -->\n';
    }).join('');
    var rewritten = raw.replace(/## Learned Preferences\n[\s\S]*$/, keptBlock);
    fs.writeText(SELF_PATH, rewritten);

    return { moved: 0, distilled: 0, archived: archived.length };
  }

  function stats() {
    var raw = readRaw();
    return {
      count: parsePrefs(raw).length,
      bytes: Buffer.byteLength(raw, 'utf8'),
      lastWrite: 0
    };
  }

  async function init() {
    fs.ensureDir(fs.vaultPath('Identity'));
    if (!fs.exists(SELF_PATH)) {
      fs.writeText(SELF_PATH, SEED_SELF_MD);
    }
  }

  return { init, write, writeHeader, recall, get, consolidate, stats, readRaw };
}

module.exports = { createIdentityStore };
```

**Note on file scope**: this store never calls `fs.readText`/`fs.writeText`/any write-family method with a path containing `boundaries` — only `SELF_PATH` and `ARCHIVE_PATH`, both under `self.md`/`_archive.md`. This is load-bearing for the contract test below; do not add a boundaries-adjacent helper to this file.

### `mythos/src/core/memory/index.js` (MODIFIED)

```diff
 const { createFsStore } = require('./fs-store');
 const { createEpisodicStore } = require('./episodic');
 const { createSemanticStore } = require('./semantic');
 const { createSkillsStore } = require('./skills');
+const { createIdentityStore } = require('./identity');
 const { createWorkingMemory } = require('./working');
 const { createAuditWriter } = require('./audit-writer');
 const { createCheckpointStore } = require('./checkpoints');

 function createMemory({ config, bus, logger }) {
   const vaultRoot = () => config.MYTHOS_VAULT_ROOT || './vault';
   const fs = createFsStore(vaultRoot);

   const episodic = createEpisodicStore({ fs, config, bus, logger });
   const semantic = createSemanticStore({ fs, config, bus, logger });
   const skills = createSkillsStore({ fs, config, bus, logger });
+  const identity = createIdentityStore({ fs, config, bus, logger });
   const audit = createAuditWriter({ fs, config, bus, logger });
   const checkpoints = createCheckpointStore({ fs, config, bus, logger });
   const working = createWorkingMemory({ fs, config, bus, logger, episodic });

   return {
     fs,
     episodic,
     semantic,
     skills,
+    identity,
     audit,
     checkpoints,
     working,

     async init() {
       const dirs = ['Episodic', 'Semantic', 'Skills', 'Identity', 'Audit', 'Checkpoints'];
       for (let i = 0; i < dirs.length; i++) {
         fs.ensureDir(fs.vaultPath(dirs[i]));
       }

       await episodic.init();
       await semantic.init();
       await skills.init();
+      await identity.init();
       await audit.init();
       await checkpoints.init();
       await working.init();
     },

     stats() {
       return {
         episodic: episodic.stats(),
         semantic: semantic.stats(),
         skills: skills.stats(),
+        identity: identity.stats(),
         working: working.stats(),
         audit: audit.stats()
       };
     }
   };
 }
```

`memory.identity` is the **store**. `identity` (the module built next) is a *different* object, constructed separately in `main.js` and injected wherever `checkBoundary`/`persona`/`learn` are needed. Do not confuse `memory.identity.write(...)` (raw pref-append) with `identity.learn({...})` (the module's higher-level API, which calls `memory.identity.write(...)` internally).

### `mythos/src/core/identity/index.js` (NEW — headline deliverable)

```js
'use strict';

// Identity module — self & boundaries.
// vault/Identity/self.md      — entity-writable, loaded via memory/identity.js
// vault/Identity/boundaries.md — HUMAN-EDITABLE ONLY. This module is the ONLY
// code path in MYTHOS permitted to touch this file, and it never writes it —
// only fs.readText, never fs.writeText/writeJSON/appendLine/removeFile against
// this path. (contract-tested — see test/identity-boundaries-contract.test.js)

function createIdentity({ bus, config, fs, identityStore }) {
  if (!bus) throw new Error('createIdentity requires bus');
  if (!config) throw new Error('createIdentity requires config');
  if (!fs) throw new Error('createIdentity requires fs (fs-store instance)');
  if (!identityStore) throw new Error('createIdentity requires identityStore (memory/identity.js)');

  var BOUNDARIES_PATH = 'Identity/boundaries.md';

  var self = null;        // cached self.md content: { purpose, values, persona }
  var boundaries = null;  // cached boundaries.md content: { deny, max_autonomous_tier, allowed_dirs }

  function extractSection(raw, header) {
    var re = new RegExp('## ' + header + '\\n([\\s\\S]*?)(?=\\n## |\\n*$)');
    var m = raw.match(re);
    return m ? m[1].trim() : null;
  }

  async function loadSelf() {
    var raw = identityStore.readRaw();
    return {
      purpose: extractSection(raw, 'Purpose') || 'An autonomous entity that assists its operator.',
      values: extractSection(raw, 'Values') || 'Helpfulness, honesty, efficiency.',
      persona: extractSection(raw, 'Persona') || config.MYTHOS_NAME || 'MYTHOS'
    };
  }

  // Read-only. No writeText/writeJSON/appendLine/removeFile call anywhere
  // in this function or this file targets BOUNDARIES_PATH.
  function loadBoundaries() {
    var raw = fs.readText(BOUNDARIES_PATH, '');
    var deny = [];
    var denyRe = /^deny:\s*(.+)$/gm;
    var m;
    while ((m = denyRe.exec(raw)) !== null) deny.push(m[1].trim());

    var tierMatch = raw.match(/^max_autonomous_tier:\s*(\d+)/m);
    var max_autonomous_tier = tierMatch ? parseInt(tierMatch[1], 10) : undefined;

    var allowed_dirs = [];
    var dirsSection = raw.match(/allowed_dirs:\s*\n((?:\s*-\s*.+\n?)+)/);
    if (dirsSection) {
      var lines = dirsSection[1].match(/-\s*(.+)/g) || [];
      for (var i = 0; i < lines.length; i++) {
        allowed_dirs.push(lines[i].replace(/^-\s*/, '').trim());
      }
    }

    return { deny: deny, max_autonomous_tier: max_autonomous_tier, allowed_dirs: allowed_dirs };
  }

  return {
    async init() {
      self = await loadSelf();
      boundaries = loadBoundaries();

      // Validate boundaries — malformed → fail-safe (exact event/kind strings below,
      // copied verbatim from §11 — do not paraphrase)
      if (typeof boundaries.max_autonomous_tier !== 'number') {
        boundaries.max_autonomous_tier = 1;
        bus.emit('health.anomaly', { kind: 'identity-boundaries-malformed', severity: 'critical' });
      }
    },

    // exact name/arity from §11 — do not paraphrase
    checkBoundary(tool, args) {
      var denyList = Array.isArray(boundaries.deny) ? boundaries.deny : [];
      if (denyList.includes(tool)) return 'denied by boundaries.md';
      return null;
    },

    // exact name/arity from §11 — do not paraphrase
    persona() {
      return 'You are ' + (self.persona || config.MYTHOS_NAME || 'MYTHOS') + '. ' + (self.values || '');
    },

    // Added by this phase — not in spec's literal §11 code block. Exposes the
    // human-editable ceiling to Leash without Leash reaching into this
    // module's private closure state. See "Spec Ambiguities Resolved" #3.
    getMaxAutonomousTier() {
      return boundaries.max_autonomous_tier;
    },

    // exact destructured signature from §11 — do not paraphrase
    async learn({ signal, text, sourceEpId }) {
      if (signal && signal.aborted) return { ref: null, degraded: true };
      var result = identityStore.write(text, { source: sourceEpId, confidence: 0.6 });
      if (result.ref) {
        self = await loadSelf(); // refresh cache in case a header field changed
      }
      return result;
    }
  };
}

module.exports = { createIdentity };
```

### `vault/Identity/boundaries.md` (seed — verbatim from spec §11 "Boundaries Schema")

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

### `vault/Identity/self.md` (seed — rendered from the spec's §11 default object, lines 1342-1346, verbatim field values)

```markdown
# Self

## Purpose
An autonomous entity that assists its operator.

## Values
Helpfulness, honesty, efficiency.

## Persona
MYTHOS

## Learned Preferences
<!-- populated at runtime by identity.learn() -->
```

### `mythos/src/core/brain/index.js` (MODIFIED)

```diff
-function createBrain({ config, bus }) {
+function createBrain({ config, bus, identity }) {
   const registry = require('./registry');
   const chain = require('./chain');
   const spend = require('./spend');

   return {
     async think({ lane, messages, schemaHint, budget, signal, source }) {
       ...
       if (['voice', 'build', 'simple'].indexOf(lane) !== -1) {
-        const persona = (config && config.MYTHOS_NAME) || 'MYTHOS';
-        msgs = [
-          { role: 'system', content: 'You are ' + persona + '. Be concise and actionable.' },
-          ...msgs
-        ];
+        const personaLine = identity && typeof identity.persona === 'function'
+          ? identity.persona() + ' Be concise and actionable.'
+          : 'You are ' + ((config && config.MYTHOS_NAME) || 'MYTHOS') + '. Be concise and actionable.';
+        msgs = [
+          { role: 'system', content: personaLine },
+          ...msgs
+        ];
       }
       ...
```

`identity` is optional (see Ambiguity #5) — existing/other callers of `createBrain({config, bus})` keep working unchanged.

### `mythos/src/core/leash/index.js` (MODIFIED — P5 baseline patched here)

CROSS-PHASE FIX (consistency pass, P5 vs P8): P5's real `createLeash` shipped with a
6-dependency object signature (`{bus, config, identity, auditWriter, goals, effectors}`,
using `deps.x` destructuring, `var`, and named `check:` / `writeAudit()` /
`failClosedIfUnwritable()` helpers) — not the 4-param arrow-style stub this diff
originally patched. Rebased below onto P5's real code shape; only the two `+` lines
are this phase's actual change:

```diff
 function createLeash(deps) {
   var bus = deps.bus, config = deps.config, identity = deps.identity;
   var auditWriter = deps.auditWriter, goals = deps.goals, effectors = deps.effectors;

   if (!bus) throw new Error('createLeash requires bus');
   if (!config) throw new Error('createLeash requires config');
   if (!identity || typeof identity.checkBoundary !== 'function') {
     throw new Error('createLeash requires identity with checkBoundary() — inject a stub until Phase 8 ships, never omit this dependency');
   }
+  if (typeof identity.getMaxAutonomousTier !== 'function') {
+    throw new Error('createLeash requires identity with getMaxAutonomousTier() — Phase 8 must add this to the real identity module and its boot-time stub alike');
+  }
   // ... auditWriter/goals/effectors checks unchanged ...

   return {
     check: function (action, goalCtx) {
       var toolName = action.tool;
       var args = action.args || {};
       var tier = TIER_TABLE[toolName];
       // ... dangerWhen override, dry-run check, boundary check unchanged ...

       if (tier === undefined) tier = 3;

+      // Effective ceiling = MOST RESTRICTIVE of config and boundaries.md.
+      // Both read LIVE, every call — never cached at construction (P5's own
+      // rule; Phase 8 extends it to identity's ceiling, doesn't relax it).
+      // boundaries.md can only tighten, never loosen, beyond config's ceiling.
+      var maxTier = Math.min(config.AUTONOMOUS_MAX_TIER, identity.getMaxAutonomousTier());

       if (tier <= maxTier) {
         var allowWrite = writeAudit(action, goalCtx && goalCtx.goalId, tier, 'allow', { reason: 'within-autonomous-max' });
         return failClosedIfUnwritable(tier, allowWrite, { allow: true, requireConfirm: false, tier: tier, reason: 'within-autonomous-max' });
       }
       // ... T3 grant / T4 confirm logic unchanged from P5 baseline ...
     }
   };
 }
```

The `if (!identity ...) throw` guards are *safety* gates (Leash's tier ceiling),
unlike Brain's optional identity — this is the lesson #3/#5 distinction applied
consistently: Leash's dependency on identity is mandatory-and-throws because it
gates dangerous actions; Brain's is optional because it's cosmetic. Neither
`config.AUTONOMOUS_MAX_TIER` nor `identity.getMaxAutonomousTier()` is cached at
construction — both are read fresh inside every `check()` call.

### `mythos/src/main.js` (MODIFIED — DEGRADED block excerpt)

The listed already-shipped `main.js` is still the Phase-0 skeleton (D-04); this excerpt shows the DEGRADED-block section as it must exist once P0-P7's boot-sequence fixes have landed, with this phase's additions marked. Boot-scoped `let` variables (`memory`, `brain`, `identity`, `leash`, `goals`, `effectors`, `cortex`) are declared once above the step array; step closures read/assign them by reference.

```diff
   lifecycle.setSteps([
     ...
     { name: '.env',       fn: () => loadDotenv(),       fail: 'degraded' },
     { name: 'stores',     fn: async () => { memory = createMemory({ config, bus, logger }); await memory.init(); }, fail: 'degraded' },
+    {
+      name: 'identity',   // exact string 'identity' — do not paraphrase (matches §13's named step)
+      fn: async function() {
+        const { createIdentity } = require('./core/identity');
+        identity = createIdentity({ bus, config, fs: memory.fs, identityStore: memory.identity });
+        await identity.init();
+
+        // brain and leash both hard-depend on `identity` being non-null in
+        // their closures (Brain optionally, Leash mandatorily — see Ambiguity
+        // #5). Constructing them here, not earlier, avoids the stale-closure
+        // bug where `identity` would be captured as undefined forever.
+        const { createBrain } = require('./core/brain');
+        brain = createBrain({ config, bus, identity });
+
+        const { createLeash } = require('./core/leash');
+        leash = createLeash({ bus, config, identity, auditWriter: memory.audit });
+      },
+      fail: 'degraded'
+    },
     { name: 'brain-probe',fn: () => brain.probe(),     fail: 'degraded' },
     { name: 'goals',      fn: () => { goals = createGoalSystem({ fs: memory.fs, config, bus, memory, brain }); }, fail: 'degraded' },
     { name: 'recovery',   fn: () => recoverFromCheckpoint(), fail: 'degraded' },
     ...
   ]);
```

## Integration Points

| Direction | Call | Exact signature | Source |
|---|---|---|---|
| THIS phase calls FROM `memory` | `memory.identity.write/writeHeader/recall/get/consolidate/stats/readRaw` | `write(prefText, opts) → {ref, degraded}` | `mythos/src/core/memory/identity.js` (this phase) |
| THIS phase calls FROM `config` | `config.MYTHOS_NAME`, `config.AUTONOMOUS_MAX_TIER` | `MYTHOS_NAME: {type:'string', default:'MYTHOS'}`; `AUTONOMOUS_MAX_TIER: {type:'number', default:2, min:0, max:4}` — **exact keys, do not paraphrase** | `mythos/src/core/config/schema.js:9,35` |
| THIS phase calls FROM `fs-store` | `fs.readText(relPath, fallback)`, `fs.exists`, `fs.vaultPath`, `fs.ensureDir` | `readText(relPath, fallback) → string` | `mythos/src/core/memory/fs-store.js:21-30` |
| Leash (P5) calls INTO this phase | `identity.checkBoundary(tool, args)`, `identity.getMaxAutonomousTier()` | `checkBoundary(tool, args) → string\|null` — **exact name, do not paraphrase** | `mythos/src/core/leash/index.js` (patched here) |
| Brain (P2) calls INTO this phase | `identity.persona()` | `persona() → string` — **exact name, do not paraphrase** | `mythos/src/core/brain/index.js:60` (patched here) |
| `bus` receives FROM this phase | `bus.emit('health.anomaly', {kind:'identity-boundaries-malformed', severity:'critical'})` | **exact string `'identity-boundaries-malformed'`, do not paraphrase** | `mythos/src/core/identity/index.js` |
| `bus` receives FROM this phase (store) | `bus.emit('health.anomaly', {kind:'memory-write-failed', store:'identity', ...})` | matches `semantic.js`/`skills.js` pattern exactly | `mythos/src/core/memory/identity.js` |
| Future modules call INTO this phase | `identity.learn({signal, text, sourceEpId})` | **exact destructured signature, do not paraphrase** | `mythos/src/core/identity/index.js` |

## Anti-Drift Checklist

1. `checkBoundary`, `persona`, `learn` names and arities are copied character-for-character from §11 — verified against the spec text above, not paraphrased.
2. `identity/index.js` contains zero calls to `fs.writeText`, `fs.writeJSON`, `fs.appendLine`, or `fs.removeFile` with any path containing the substring `boundaries` — grep the file before merging (`grep -n "boundaries" mythos/src/core/identity/index.js` should show only `loadBoundaries`/`BOUNDARIES_PATH`/`fs.readText` lines).
3. `memory/identity.js` never imports or references `Identity/boundaries.md` — it owns `self.md` and `_archive.md` exclusively.
4. `createLeash` throws at construction if `identity` is missing or lacks `checkBoundary` (mandatory gate, lesson #3) — this is a behavior change to the P5 baseline; confirm P5's own leash tests still pass with a real identity now required.
5. `createBrain`'s `identity` param stays **optional** — do not make it a hard throw; that would be over-applying lesson #3 to a non-safety code path and would break every existing brain test that doesn't pass identity.
6. `config.AUTONOMOUS_MAX_TIER` is read via `config.AUTONOMOUS_MAX_TIER`, never redeclared or re-defaulted inside identity/leash (lesson #6) — the only new default (`1`) is the fail-safe for a malformed/missing `boundaries.md`, which is a different concept (file-parse fallback, not a config default).
7. `consolidate()` in `memory/identity.js` archives to `_archive.md` via append — never calls `fs.removeFile`/`fs.unlinkSync` on `self.md` content (lesson #5).
8. Every new factory (`createIdentityStore`, `createIdentity`) accepts `{bus, config, ...}` and both are used — `identityStore` emits `health.anomaly` on write failure; `identity` module emits it on malformed boundaries (lesson #8).
9. `main.js`'s `identity` step constructs `brain` and `leash` *inside itself*, after `identity.init()` resolves — not in an earlier step — to avoid the stale-closure bug where those modules would capture `identity: undefined` permanently.
10. Do not add a `writeBoundaries`/`saveBoundaries`/`setBoundaries` method to either file, ever, even for a "human approved this via UI" flow — that flow, if built later, must write the file directly from server/UI code, never through the identity module.
11. `memory/identity.js`'s `stats()` returns the fixed `{count, bytes, lastWrite}` shape (per the assumed-fixed D-20) — do not invent a fifth shape.

## Test Plan

Maps to the P8 gate: **(a)** loaded at boot, **(b)** edit changes tier ceiling, **(c)** MYTHOS_NAME override, **(d)** entity has no write path to boundaries (contract test).

### `mythos/test/identity.test.js` — module + store units (gate a, c)

```js
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createIdentityStore } = require('../src/core/memory/identity');
const { createIdentity } = require('../src/core/identity');

function fakeConfig(overrides) {
  return Object.assign({ MYTHOS_NAME: 'MYTHOS', AUTONOMOUS_MAX_TIER: 2 }, overrides);
}

describe('identity store', () => {
  let dir, fsStore, store, bus;

  beforeEach(async function() {
    dir = tempVaultDir();
    bus = fakeBus();
    fsStore = createFsStore(() => dir);
    store = createIdentityStore({ fs: fsStore, config: fakeConfig(), bus, logger: { debug(){}, info(){}, warn(){}, error(){} } });
    await store.init();
  });

  afterEach(function() { cleanupVaultDir(dir); });

  it('seeds self.md on init', () => {
    assert.ok(fsStore.exists('Identity/self.md'));
    const raw = store.readRaw();
    assert.match(raw, /## Persona\nMYTHOS/);
  });

  it('writes and recalls a learned preference', () => {
    const { ref } = store.write('Prefers dark mode', { source: 'ep-1', confidence: 0.7 });
    assert.ok(ref.startsWith('idn-'));
    const hits = store.recall('dark mode');
    assert.ok(hits.length > 0);
    assert.equal(hits[0].store, 'identity');
  });

  it('preserves header when writing a preference', () => {
    store.write('Prefers concise answers', { source: 'ep-2' });
    const raw = store.readRaw();
    assert.match(raw, /## Purpose\nAn autonomous entity/);
  });

  it('consolidate archives low-confidence prefs instead of deleting', () => {
    store.write('Low confidence guess', { confidence: 0.05 });
    store.write('High confidence fact', { confidence: 0.9 });
    const result = store.consolidate({ threshold: 0.2 });
    assert.equal(result.archived, 1);
    assert.ok(fsStore.exists('Identity/_archive.md'));
    assert.match(fsStore.readText('Identity/_archive.md'), /Low confidence guess/);
    const hits = store.recall('confidence');
    assert.equal(hits.filter(h => h.record.text === 'Low confidence guess').length, 0);
  });
});

describe('identity module', () => {
  let dir, fsStore, store, identity, bus, config;

  beforeEach(async function() {
    dir = tempVaultDir();
    bus = fakeBus();
    config = fakeConfig();
    fsStore = createFsStore(() => dir);
    store = createIdentityStore({ fs: fsStore, config, bus, logger: { debug(){}, info(){}, warn(){}, error(){} } });
    await store.init();
    identity = createIdentity({ bus, config, fs: fsStore, identityStore: store });
    await identity.init();
  });

  afterEach(function() { cleanupVaultDir(dir); });

  it('loads at boot with fail-safe boundaries when file missing', () => {
    // gate (a): loaded at boot
    assert.equal(identity.getMaxAutonomousTier(), 1); // no boundaries.md seeded in this test → fail-safe default
    const anomaly = bus._lastEvent('health.anomaly');
    assert.equal(anomaly.payload.kind, 'identity-boundaries-malformed');
  });

  it('MYTHOS_NAME override: self.md persona wins over config.MYTHOS_NAME', async () => {
    // gate (c)
    store.writeHeader({ persona: 'GALACTUS' });
    const identity2 = createIdentity({ bus, config, fs: fsStore, identityStore: store });
    await identity2.init();
    assert.match(identity2.persona(), /^You are GALACTUS\./);
  });

  it('falls back to config.MYTHOS_NAME when persona unset', () => {
    assert.match(identity.persona(), /^You are MYTHOS\./);
  });

  it('checkBoundary denies tools on the deny list', () => {
    fsStore.writeText('Identity/boundaries.md', '# MYTHOS Boundaries\n\n## Deny Rules (absolute blocks)\ndeny: kill_session\n');
    const identity3 = createIdentity({ bus, config, fs: fsStore, identityStore: store });
    return identity3.init().then(() => {
      assert.equal(identity3.checkBoundary('kill_session', {}), 'denied by boundaries.md');
      assert.equal(identity3.checkBoundary('navigate', {}), null);
    });
  });

  it('learn() persists via the identity store and refreshes cache', async () => {
    const result = await identity.learn({ signal: null, text: 'Prefers short summaries', sourceEpId: 'ep-42' });
    assert.ok(result.ref);
    const hits = store.recall('short summaries');
    assert.ok(hits.length > 0);
    assert.equal(hits[0].record.sidecar.source, 'ep-42');
  });
});
```

### `mythos/test/identity-boundaries-contract.test.js` — the required contract test (gate d)

```js
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createIdentityStore } = require('../src/core/memory/identity');
const { createIdentity } = require('../src/core/identity');

describe('boundaries.md write-path contract', () => {
  // 1. STATIC: scan the actual source for any write-family call touching
  // a boundaries.md path. This is the strongest guarantee — it doesn't
  // depend on which methods happen to get exercised at runtime.
  it('identity/index.js source contains no write-family call against a boundaries.md path', () => {
    const srcPath = path.join(__dirname, '../src/core/identity/index.js');
    const src = fs.readFileSync(srcPath, 'utf8');
    const writeCalls = src.match(/\.(writeText|writeJSON|appendLine|removeFile)\s*\(\s*(['"`])[^'"`]*boundaries[^'"`]*\2/gi);
    assert.equal(writeCalls, null, 'found a write-family call against a boundaries.md-like path: ' + JSON.stringify(writeCalls));
  });

  it('memory/identity.js source contains no reference to boundaries.md at all', () => {
    const srcPath = path.join(__dirname, '../src/core/memory/identity.js');
    const src = fs.readFileSync(srcPath, 'utf8');
    assert.equal(/boundaries/i.test(src), false, 'the identity STORE must never reference boundaries.md');
  });

  it('identity module public API has no method whose name implies writing boundaries', () => {
    const bus = fakeBus();
    const dir = tempVaultDir();
    const fsStore = createFsStore(() => dir);
    const store = createIdentityStore({ fs: fsStore, config: { MYTHOS_NAME: 'MYTHOS' }, bus, logger: { debug(){}, info(){}, warn(){}, error(){} } });
    const identity = createIdentity({ bus, config: { MYTHOS_NAME: 'MYTHOS' }, fs: fsStore, identityStore: store });
    const methodNames = Object.keys(identity);
    const suspicious = methodNames.filter(function(n) { return /boundar/i.test(n) && /write|save|set|update/i.test(n); });
    assert.deepEqual(suspicious, []);
    cleanupVaultDir(dir);
  });

  // 2. BEHAVIORAL: wrap fs.writeText in a spy that throws if ever called with
  // a boundaries.md path, then drive every public method of the identity
  // module and prove none of them ever attempted it — even indirectly.
  it('no public method attempts a write to boundaries.md at runtime', async () => {
    const dir = tempVaultDir();
    const bus = fakeBus();
    const config = { MYTHOS_NAME: 'MYTHOS', AUTONOMOUS_MAX_TIER: 2 };
    const realFs = createFsStore(() => dir);
    const guardedFs = Object.assign({}, realFs, {
      writeText: function(relPath, content) {
        if (relPath.indexOf('boundaries') !== -1) {
          throw new Error('CONTRACT VIOLATION: attempted write to ' + relPath);
        }
        return realFs.writeText(relPath, content);
      }
    });

    realFs.writeText('Identity/boundaries.md', '# MYTHOS Boundaries\n\n## Max Autonomous Tier\nmax_autonomous_tier: 2\n');

    const store = createIdentityStore({ fs: guardedFs, config, bus, logger: { debug(){}, info(){}, warn(){}, error(){} } });
    await store.init();
    const identity = createIdentity({ bus, config, fs: guardedFs, identityStore: store });
    await identity.init();

    assert.doesNotThrow(() => identity.checkBoundary('navigate', {}));
    assert.doesNotThrow(() => identity.persona());
    assert.doesNotThrow(() => identity.getMaxAutonomousTier());
    await assert.doesNotReject(identity.learn({ signal: null, text: 'test pref', sourceEpId: 'ep-1' }));

    // Sanity: boundaries.md content is byte-identical to what was seeded —
    // nothing touched it.
    const finalContent = fs.readFileSync(require('path').join(dir, 'Identity', 'boundaries.md'), 'utf8');
    assert.match(finalContent, /max_autonomous_tier: 2/);

    cleanupVaultDir(dir);
  });
});
```

### `mythos/test/identity-leash-integration.test.js` — REAL instances (lesson #4, gate b)

```js
'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createIdentityStore } = require('../src/core/memory/identity');
const { createIdentity } = require('../src/core/identity');
const { createLeash } = require('../src/core/leash');           // real P5 module, not a fake
const { createAuditWriter } = require('../src/core/memory/audit-writer');

describe('identity <-> leash real-instance integration', () => {
  let dir;
  afterEach(function() { if (dir) cleanupVaultDir(dir); });

  async function buildStack(config, boundariesMd) {
    dir = tempVaultDir();
    const bus = fakeBus();
    const fsStore = createFsStore(() => dir);
    if (boundariesMd !== undefined) fsStore.writeText('Identity/boundaries.md', boundariesMd);
    const identityStore = createIdentityStore({ fs: fsStore, config, bus, logger: { debug(){}, info(){}, warn(){}, error(){} } });
    await identityStore.init();
    const identity = createIdentity({ bus, config, fs: fsStore, identityStore });
    await identity.init();
    const audit = createAuditWriter({ fs: fsStore, config, bus, logger: { debug(){}, info(){}, warn(){}, error(){} } });
    await audit.init();
    const leash = createLeash({ bus, config, identity, auditWriter: audit });
    return { bus, identity, leash, audit };
  }

  it('boundaries.md deny list blocks a tool even below config tier ceiling', async () => {
    const { leash } = await buildStack(
      { AUTONOMOUS_MAX_TIER: 4 },
      '# MYTHOS Boundaries\n\n## Deny Rules (absolute blocks)\ndeny: launch_app\n\n## Max Autonomous Tier\nmax_autonomous_tier: 4\n'
    );
    const result = leash.check({ tool: 'launch_app', args: {} }, { goalId: 'g1' });
    assert.equal(result.allow, false);
    assert.equal(result.reason, 'denied by boundaries.md');
  });

  it('boundaries.md tier ceiling is MORE RESTRICTIVE than config and wins — gate (b): edit changes tier ceiling', async () => {
    // config allows up to tier 4 autonomously; boundaries.md caps it at 1.
    const { leash } = await buildStack(
      { AUTONOMOUS_MAX_TIER: 4 },
      '# MYTHOS Boundaries\n\n## Max Autonomous Tier\nmax_autonomous_tier: 1\n'
    );
    // launch_app is tier 2 per the canonical tier table — above boundaries'
    // ceiling of 1, so it must require confirmation despite config allowing tier 4.
    const result = leash.check({ tool: 'launch_app', args: {} }, { goalId: 'g1' });
    assert.equal(result.allow, false);
    assert.equal(result.requireConfirm, true);
  });

  it('config ceiling is MORE RESTRICTIVE than boundaries.md and wins', async () => {
    // boundaries.md tries to allow up to tier 4; config only allows tier 0.
    const { leash } = await buildStack(
      { AUTONOMOUS_MAX_TIER: 0 },
      '# MYTHOS Boundaries\n\n## Max Autonomous Tier\nmax_autonomous_tier: 4\n'
    );
    const result = leash.check({ tool: 'create_goal', args: {} }, { goalId: 'g1' }); // tier 1
    assert.equal(result.allow, false, 'tier 1 action must not auto-allow when config caps at 0');
  });

  it('tier at or below the effective (min) ceiling auto-allows', async () => {
    const { leash } = await buildStack(
      { AUTONOMOUS_MAX_TIER: 4 },
      '# MYTHOS Boundaries\n\n## Max Autonomous Tier\nmax_autonomous_tier: 2\n'
    );
    const result = leash.check({ tool: 'create_goal', args: {} }, { goalId: 'g1' }); // tier 1 <= min(4,2)=2
    assert.equal(result.allow, true);
    assert.equal(result.reason, 'within-autonomous-max');
  });
});
```

## Do NOT

- Do not give `memory/identity.js` any function that reads or writes `Identity/boundaries.md` — even a read helper there defeats the point of keeping the two files' access strictly separated for the contract test.
- Do not add a UI/server code path that calls `fs.writeText('Identity/boundaries.md', ...)` "for convenience" in this phase — boundaries.md is out of scope for entity or server-initiated writes entirely; any future human-editing UI writes the file directly from server code, never through `identity/index.js`.
- Do not make `createBrain`'s `identity` param mandatory — that over-applies the mandatory-gate lesson to a cosmetic feature and breaks unrelated callers.
- Do not skip the `Math.min` precedence and just let `boundaries.max_autonomous_tier` overwrite `config.AUTONOMOUS_MAX_TIER` outright — a human-edited file must never be able to *raise* autonomy above what the operator's `.env` already caps.
- Do not delete low-confidence learned preferences during `consolidate()` — archive to `Identity/_archive.md`, matching the fixed (post-D-18) pattern used by `semantic.js`.
- Do not construct `brain`/`leash` in an earlier boot step than `identity` — both would capture `identity: undefined` permanently due to JS closure semantics, silently defeating persona injection and tier gating.
- Do not invent new bus event names for this phase (e.g. `identity.loaded`) — the spec gives exactly one identity-related event (`health.anomaly` with `kind: 'identity-boundaries-malformed'`); reuse it, don't add speculative telemetry.
- Do not test `identity/index.js` only against a fake leash/fake brain — the contract that actually matters (does a boundaries.md edit change what Leash allows) is invisible to fakes; the real-instance integration test above is not optional.

---

# Phase 9 — UI v2 & Cutover

## Overview & Why

Phase 9 gives MYTHOS a body: an Express + WebSocket-v2 server that exposes the entity's live cognition to a human, and the NOVA→MYTHOS cutover that retires the old process. Every module built in P0–P8 (memory, brain, cortex, goals, leash, immune, effectors, identity) is a correct but invisible cognitive loop until this phase wires a transport around it — without it, MYTHOS is scientifically real but operationally useless: nobody can see a tick happen, approve a tier-4 action, or watch a breaker trip. This phase also performs the literal migration — archiving `app/` to `archive/nova/` and repointing launch scripts at `mythos/` — the one irreversible step in the whole roadmap, so its runbook is written as an exact, checked sequence rather than prose.

## Directory & File Layout

```
mythos/
├── src/
│   └── main.js                        (MODIFIED — add 'server' boot step)
├── server/
│   ├── index.js                       (NEW — Express + WS v2, RW from app/server.js)
│   └── rate-limit.js                  (NEW — CV verbatim from app/lib/rate-limit.js)
└── ui/
    ├── public/
    │   ├── index.html                 (NEW — shell skeleton, CV from app/public/index.html markup pattern)
    │   ├── js/
    │   │   ├── ws.js                  (NEW — CA from app/public/js/ws.js + subscribe())
    │   │   ├── router.js              (NEW — CA from app/public/js/router.js, MYTHOS route table)
    │   │   └── shell.js               (NEW — CA from app/public/js/shell.js)
    │   ├── css/
    │   │   └── tokens.css             (NEW — CV verbatim from app/public/css/tokens.css)
    │   └── views/
    │       ├── mind.js                (NEW)
    │       ├── memory.js              (NEW)
    │       ├── health.js              (NEW)
    │       └── audit.js               (NEW)
    └── views/
        ├── goals.js                   (NEW — CA, byte-identical copy of app/public/js/views/goals.js — see Ambiguity #1)
        ├── kanban.js                  (NEW — CA, byte-identical copy of app/public/js/views/kanban.js)
        ├── pipeline.js                 (NEW — CA, byte-identical copy of app/public/js/views/pipeline.js)
        └── confirm.js                  (NEW — modal)
```

Files this phase must **touch in already-shipped modules** (small, additive, non-breaking — see Integration Points and Lesson #2):

```
mythos/src/core/logger.js              (ADD onLog(fn) hook — needed for OUT type 'log')
mythos/src/core/lifecycle/index.js     (ADD server-close as shutdown step 0)
```

## Spec Ambiguities Resolved

**1. Do the Goals/Kanban/Pipeline UI views need code changes for "CA... adapted for GoalSystem"?**
§14's UI Views table says Goals is "CA — NOVA goals view adapted for GoalSystem" while Kanban/Pipeline are "CA — Unchanged." Taken literally this implies goals.js needs UI-level rework. But §7's "NOVA Goals.md Compatibility" note is explicit: *"the `goals` effector reads/writes `Goals.md`; the GoalSystem layer uses stable-id JSON files for cognition"* — i.e. the user-facing surface (checkbox list, `{id,text,category,done}`) never changes; only the effector's internals (P7) map each Goals.md line to a stable-id `user-service` goal in the cognitive GoalSystem. **Resolution**: all three views (goals.js, kanban.js, pipeline.js) are copied into `mythos/ui/views/` **byte-identical**, zero UI-facing changes. `server/index.js` exposes the identical REST paths (`/api/goals`, `/api/kanban`, `/api/pipeline`) backed by the P7 effectors, so the existing `fetch()` calls in these three files need no changes at all. The word "adapted" in §14 refers to the effector's internal Goals.md↔GoalSystem sync (P7's job), not to this phase's UI code.

**2. How does a `confirm-reply` WS message actually resume a paused tier-3/4 action?**
§6's `act()` code emits `bus.emit('confirm-request', {...decision, ...leashResult})` and returns — the action is "paused" but no code path shows how it resumes. §9 (Leash) lists `confirm.js` as a P5 deliverable "CA from NOVA `confirm.js`" but the `check()` code sample never calls it. Meanwhile NOVA's own `confirm.js` (read at `app/lib/voice/confirm.js`) has exactly the shape needed: `create(summary, action, connectionId) → confirmId`, `accept(confirmId, connectionId) → action | null`, `reject(confirmId, connectionId) → bool`, TTL-expiring, single-use, connection-scoped — and P5's shipped `leash/confirm.js` mirrors this exact 3-arg signature. **Resolution** (a cross-phase contract P9 depends on P5 to deliver, called out again in Integration Points): `cortex/index.js`'s `act()` must be extended (in P5, when leash lands) to call `leash.confirm.create(summary, action, connectionId)` **before** emitting `confirm-request`, and embed the returned `confirmId` in the event payload. On the server side, resolving `confirm-reply` calls `leash.confirm.accept(confirmId, connectionId)`/`.reject(...)`; on accept, the server calls a new **shared** `dispatchAction(action, ctx)` helper — factored out of `cortex/act()`'s steps 3–6 (breaker check, invoke, episodic write, budget debit, `action.completed` emit) — so there is exactly one implementation of "execute + record + debit + emit," never a second divergent copy in server code. This is called out explicitly so P5's implementer doesn't have to reverse-engineer it from P9 later.

**Open question this resolution does NOT answer, flagged honestly rather than papered over:** `connectionId` is a natural fit for voice/WS-conversational confirms (a specific human is waiting on that connection), but Cortex-initiated actions (arbitrated autonomously, not in response to a specific client's utterance) have no natural connectionId — there's no single "waiting" client. Candidate resolutions (broadcast to all connected admin clients and accept from any; a sentinel `'system'` connectionId that any authenticated connection can resolve; scope-by-goal instead of scope-by-connection) are NOT chosen here — this needs a decision when Phase 9's server work actually starts, informed by how many concurrent operators the real deployment expects.

**3. What upstream bus event does WS OUT type `audit` come from?**
§4's `auditTap` middleware claims to intercept `channel === 'audit' || channel === 'action'` and append to `vault/Audit/`. But §9's `leash.check()` code never calls `bus.emit(...)` — it calls `auditWriter.write(...)` directly. If leash never emits a bus event, `auditTap` has nothing to catch, and the server has no bus event to subscribe to for the `audit` broadcast type. **Resolution**: `leash/index.js` (P5) must **also** `bus.emit('audit.decision', { ...action, tier, decision, reason, granted })` immediately alongside its direct `auditWriter.write()` call — exact channel prefix `audit.` so it satisfies §4's own middleware taxonomy and gives P9 a subscribable event. Flagged in Integration Points as "P9 REQUIRES FROM P5" so it isn't silently missed the way D-38 was.

**4. Where does `health` OUT come from — is it event-driven or polled?**
The catalog lists `health` as a broadcast type but no §6/§10/§12 code emits a single `bus.emit('health', ...)`. `health.anomaly` events exist but are point-in-time anomalies, not a full snapshot. **Resolution**: `health` is a **synthesized** snapshot, not a 1:1 relay: server merges `effectors.breakers` (`Map<name, breaker>`, each with `.stats` → `{name,state,failCount,resetAt}`) with `immune.probes.getStatus()` (P6, aggregated provider status). It is rebroadcast on two triggers only: (a) every `perception.metric` bus event (piggybacking the Metric Sensor's existing 4s cadence — no new timer, no new magic number), and (b) immediately on every `health.anomaly` event (so an anomaly is visible without waiting for the next 4s tick).

**5. Server-close isn't in the 7-step shutdown sequence.**
§13's shutdown sequence is: sensors stop → cortex drain → working flush → checkpoint write → audit flush → exit → hard-exit timer. It never mentions closing the HTTP/WS server, yet leaving sockets open blocks a clean `process.exit(0)` and contradicts the explicit instruction to reuse NOVA's "graceful-shutdown" pattern (which closes WS first, then drains HTTP). **Resolution**: server-close is inserted as **step 0**, before "sensors stop," exactly matching NOVA's own order (`wss.close()` → `server.close(callback)`). `lifecycle/index.js`'s `shutdown()` is extended to accept and call a `stopServer` callback registered by the 'server' boot step, run first in its `cleanup()`.

**6. `tick`'s bus channel doesn't match the bus's own taxonomy.**
§4 declares channels as `perception|decision|action|health|memory|lifecycle|audit|identity`; `Event.channel = type.split('.')[0]`. The shipped (and spec-sampled) `bus.emit('tick', {...})` has no dot, so its channel is literally `'tick'` — not in that list. **Resolution**: this is a pre-existing spec/code quirk from P3, not something P9 introduces or should silently "fix" by renaming — renaming `'tick'` now would break the already-shipped `cortex-goals.test.js` assertions (`e.type === 'tick'`). P9 subscribes to the literal string `'tick'` as-is and documents the taxonomy mismatch here rather than papering over it.

## Full Code

### `mythos/server/rate-limit.js` — CV verbatim

Copied byte-for-byte from `app/lib/rate-limit.js` (54 lines, confirmed above) with zero logic changes — only the header comment's file path reference updates. No `require()` inside it needs to change; it has none.

```js
'use strict';

// rate-limit.js — zero-dependency token-bucket rate limiter for Express.
//
// In-memory, per-key (IP + optional scope) token bucket. Designed for a single
// localhost process — not a distributed limiter. Two tiers are wired in
// server/index.js:
//   - global: 240 req/min across /api/*
//   - expensive: 8 req/min on routes that shell out or call LLMs
// Returns 429 { error, retryAfter } with a Retry-After header when exhausted.
//
// Honesty rule: exhausted requests are logged at warn level by the caller, never
// silently dropped — the user deserves to see when they're being throttled.

function createLimiter(opts) {
  const windowMs = opts.windowMs;
  const max = opts.max;
  const scope = opts.scope || 'default';
  const buckets = new Map();

  return function limit(req, res, next) {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const key = `${ip}:${scope}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > max) {
      const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      req.rateLimited = { scope, retryAfterSec, count: bucket.count, max };
      return res.status(429).json({
        error: `Rate limit exceeded for ${scope}. Try again in ${retryAfterSec}s.`,
        retryAfter: retryAfterSec,
      });
    }

    next();
  };
}

module.exports = { createLimiter };
```

### `mythos/server/index.js` — Express + WS v2 (RW)

```js
'use strict';

// server/index.js — RW from app/server.js (1533 lines) per §14. Reuses: 127.0.0.1
// bind, CORS allowlist pattern, verifyWsClient, broadcastAll, graceful-shutdown drain.
// Everything NOVA had that isn't in the Migration Map (builds.js, radar/, video-render/,
// free-claude/, game/music/video/thumbnail studios, voice s2s/pc/browser child processes)
// is intentionally NOT ported — those stay in archive/nova/ per §16 "LEAVE in NOVA".

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createLimiter } = require('./rate-limit');

// WS v2 message types — exact strings, do not paraphrase:
// IN (reqId):  'utterance', 'command', 'confirm-reply', 'subscribe', 'stop'
// OUT (broadcast): 'entity-state', 'tick', 'goal-update', 'perception', 'action',
//                  'health', 'audit', 'confirm-request', 'brain-spend', 'log'

function isLoopback(req) {
  const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
  return LOOPBACK.has(ip);
}

function createServer(deps) {
  const bus = deps.bus;
  const config = deps.config;
  const logger = deps.logger;
  const memory = deps.memory;
  const goalsEffector = deps.goalsEffector;     // P7 effectors/goals.js — Goals.md surface
  const kanbanEffector = deps.kanbanEffector;    // P7 effectors/kanban.js
  const pipelineEffector = deps.pipelineEffector; // P7 effectors/pipeline.js
  const effectors = deps.effectors;              // hub — .invoke, .breakers, .effectors
  const leash = deps.leash;                      // P5 — .check, .confirm.{create,accept,reject}
  const goals = deps.goals;                       // cognitive GoalSystem — .debitBudget
  const probes = deps.probes;                     // P6 immune/probes.js — .getStatus()

  const PORT = config.MYTHOS_PORT;
  const BIND = config.MYTHOS_BIND;

  // ALLOWED_ORIGINS mirrors NOVA exactly: comma-sep env passthrough, NOT schema-ized —
  // matches NOVA's own precedent of leaving this outside the coerced-type config.
  const ALLOWED_ORIGINS = new Set([
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    ...(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  ]);

  const app = express();
  app.use((req, res, next) => { req.id = crypto.randomUUID(); next(); });
  app.use(express.json({ limit: '1mb' }));

  const globalLimit = createLimiter({ windowMs: 60000, max: Number(process.env.RATE_LIMIT_GLOBAL) || 240, scope: 'global-api' });
  const expensiveLimit = createLimiter({ windowMs: 60000, max: Number(process.env.RATE_LIMIT_EXPENSIVE) || 8, scope: 'expensive' });

  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(express.static(path.join(__dirname, '..', 'ui', 'public'), { etag: false, maxAge: 0, lastModified: false }));

  app.use('/api', globalLimit);
  app.get('/health', (req, res) => { res.json({ ok: true, uptime: process.uptime() }); });

  app.get('/api/status', async (req, res) => {
    try {
      res.json(await probes.getStatus());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- goals / kanban / pipeline REST — CA, unchanged surface, see Ambiguity #1 ----
  app.get('/api/goals', (req, res) => {
    res.json({ goals: goalsEffector.listGoals(), stats: goalsEffector.stats() });
  });
  app.post('/api/goals', (req, res) => {
    const { text, category } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
    const list = goalsEffector.addGoal(text, category);
    res.json({ goals: list, stats: goalsEffector.stats() });
  });
  app.post('/api/goals/:id/toggle', (req, res) => {
    const list = goalsEffector.toggleGoal(req.params.id);
    res.json({ goals: list, stats: goalsEffector.stats() });
  });
  app.delete('/api/goals/:id', (req, res) => {
    const list = goalsEffector.deleteGoal(req.params.id);
    res.json({ goals: list, stats: goalsEffector.stats() });
  });

  app.get('/api/kanban', (req, res) => { res.json(kanbanEffector.listBoard()); });
  app.post('/api/kanban/cards', (req, res) => {
    const { title, lane } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: 'title required' });
    res.json({ card: kanbanEffector.addCard(title, lane), board: kanbanEffector.listBoard() });
  });
  app.post('/api/kanban/cards/:id/move', (req, res) => {
    try {
      const card = kanbanEffector.moveCard(req.params.id, req.body.lane);
      res.json({ card, board: kanbanEffector.listBoard() });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });
  app.delete('/api/kanban/cards/:id', (req, res) => {
    kanbanEffector.deleteCard(req.params.id);
    res.json({ board: kanbanEffector.listBoard() });
  });

  app.get('/api/pipeline', (req, res) => { res.json(pipelineEffector.listAll()); });
  app.post('/api/pipeline/capture', (req, res) => {
    const { text } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
    res.json({ card: pipelineEffector.capture(text), board: pipelineEffector.listAll() });
  });
  app.post('/api/pipeline/:id/approve', (req, res) => {
    try { res.json({ card: pipelineEffector.approve(req.params.id), board: pipelineEffector.listAll() }); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });
  app.post('/api/pipeline/:id/reject', (req, res) => {
    try { pipelineEffector.reject(req.params.id); res.json({ board: pipelineEffector.listAll() }); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });
  app.post('/api/pipeline/:id/ship', (req, res) => {
    try { res.json({ card: pipelineEffector.ship(req.params.id), board: pipelineEffector.listAll() }); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(__dirname, '..', 'ui', 'public', 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error('unhandled route error', { requestId: req.id, path: req.path, error: err.message });
    res.status(500).json({ error: 'Internal server error.', requestId: req.id });
  });

  const httpServer = app.listen(PORT, BIND, () => {
    logger.info('server.listening', { url: `http://${BIND}:${PORT}`, bind: BIND });
  });

  // ---- WS v2 ----
  function verifyClient(info, callback) {
    const origin = info.origin;
    if (origin) {
      if (ALLOWED_ORIGINS.has(origin)) return callback(true);
      logger.warn('ws-upgrade-rejected', { reason: 'foreign origin', origin });
      return callback(false, 403, 'Forbidden');
    }
    if (isLoopback(info.req)) return callback(true);
    logger.warn('ws-upgrade-rejected', { reason: 'no origin, non-loopback' });
    return callback(false, 403, 'Forbidden');
  }

  const wss = new WebSocketServer({ server: httpServer, path: '/ws', verifyClient });

  function broadcastAll(msg) {
    const payload = JSON.stringify(msg);
    wss.clients.forEach((client) => {
      if (client.readyState === 1) client.send(payload);
    });
  }

  // Shared dispatch — the ONE place that executes an already-gated action, whether
  // called from a confirm-accept (below) or from cortex's own act() post-gate path
  // (P5 must call this same exported function, not re-implement its 4 steps).
  async function dispatchAction(decision, ctx) {
    const breakerOk = effectors.breakers.get(decision.tool)
      ? effectors.breakers.get(decision.tool).allow()
      : true;
    if (!breakerOk) {
      bus.emit('action.blocked', { ...decision, reason: 'circuit-open' });
      return { ok: false, result: 'circuit-open' };
    }
    const signal = AbortSignal.timeout(config.ACTION_TIMEOUT_MS || 30000);
    const result = await effectors.invoke(decision.tool, decision.args, { signal, bus, goalId: ctx.goalId });
    await memory.episodic.write({
      kind: 'action', channel: 'cortex',
      summary: `${decision.tool}(${JSON.stringify(decision.args).slice(0, 80)})`,
      detail: result, outcome: result && result.ok ? 'ok' : 'fail',
      tier: ctx.tier, tokensSpent: 0,
    });
    if (ctx.goalId) goals.debitBudget(ctx.goalId, { tokens: 0, actions: 1 });
    bus.emit('action.completed', { tool: decision.tool, ok: result && result.ok, goalId: ctx.goalId });
    return result;
  }

  wss.on('connection', (ws) => {
    const connectionId = crypto.randomUUID();
    const subscriptions = new Set(); // which OUT types this client wants relayed

    function send(msg) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); }

    async function handleUtterance(msg) {
      const result = await deps.brain.interpret(msg.text, { connectionId });
      send({ type: 'done', reqId: msg.reqId, say: result.say });
    }

    function handleCommand(msg) {
      send({ type: 'done', reqId: msg.reqId, command: msg.command });
    }

    async function handleConfirmReply(msg) {
      const { confirmId, accept } = msg;
      if (!accept) {
        leash.confirm.reject(confirmId, connectionId);
        return;
      }
      const action = leash.confirm.accept(confirmId, connectionId);
      if (!action) return; // expired / already consumed / wrong connection — silent no-op, matches NOVA
      await dispatchAction(action.decision, { goalId: action.goalId, tier: action.tier });
    }

    function handleSubscribe(msg) {
      (msg.types || []).forEach((t) => subscriptions.add(t));
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'utterance') handleUtterance(msg);
      else if (msg.type === 'command') handleCommand(msg);
      else if (msg.type === 'confirm-reply') handleConfirmReply(msg);
      else if (msg.type === 'subscribe') handleSubscribe(msg);
      // 'stop' — no in-flight per-connection controllers to abort yet in this
      // phase's scope (utterance/command are not streamed); reserved for parity.
    });
  });

  // ---- Bus → WS v2 OUT relay (the anti-drift table, in code) ----
  // Every subscribe() below names the EXACT spec/shipped bus event string.
  // 'tick' — exact string, no dot-prefix (see Ambiguity #6), do not paraphrase.
  bus.subscribe('tick', (e) => {
    broadcastAll({ type: 'tick', payload: { tick: e.payload.tick, perceptions: e.payload.perceptions, activeGoal: memory.working.activeGoalId } });
  });

  // 'lifecycle.started' / 'lifecycle.stopped' / 'lifecycle.alive' feed entity-state.
  let entityStatus = 'booting';
  bus.subscribe('lifecycle.*', (e) => {
    if (e.type === 'lifecycle.alive') entityStatus = 'alive';
    if (e.type === 'lifecycle.stopped') entityStatus = 'stopped';
    broadcastAll({ type: 'entity-state', payload: { name: config.MYTHOS_NAME, status: entityStatus, tick: memory.working.tick } });
  });

  // 'goal.created' | 'goal.updated' | 'goal.removed' | 'goal.budget-debited' — exact
  // strings from the shipped P4 goals/index.js — all four collapse to OUT 'goal-update'.
  bus.subscribe('goal.*', (e) => {
    broadcastAll({ type: 'goal-update', payload: { id: e.payload.id, status: e.payload.status, title: e.payload.title } });
  });

  // 'perception.*' — relay only human-initiated ('ws' channel, always) or salience
  // above config.MYTHOS_IDLE_SALIENCE (config-read, not a new magic number — Lesson #6).
  // CROSS-PHASE FIX (consistency pass, P6 vs P9): field is `.salience`, never
  // `.salienceHint` — P6/P9 win as the real consumer/sensor convention; this
  // handler originally read the wrong field name on both the gate and the relay.
  bus.subscribe('perception.*', (e) => {
    const p = e.payload;
    if (p.channel !== 'ws' && (p.salience || 0) < config.MYTHOS_IDLE_SALIENCE) return;
    broadcastAll({ type: 'perception', payload: { channel: p.channel, kind: p.kind, salience: p.salience, text: p.payload && p.payload.text } });
  });

  // 'action.denied' | 'action.blocked' | 'action.completed' — exact strings from cortex/index.js.
  bus.subscribe('action.*', (e) => {
    broadcastAll({ type: 'action', payload: { tool: e.payload.tool, ok: e.payload.ok, goalId: e.payload.goalId, reason: e.payload.reason } });
  });

  // health — synthesized snapshot per Ambiguity #4; triggered by 'perception.metric'
  // (existing 4s Metric Sensor cadence) and immediately on 'health.anomaly'.
  const anomalyLog = [];
  bus.subscribe('health.anomaly', (e) => {
    anomalyLog.push(e.payload);
    if (anomalyLog.length > 200) anomalyLog.shift();
    broadcastHealth();
  });
  bus.subscribe('perception.metric', () => { broadcastHealth(); });

  function broadcastHealth() {
    const breakers = {};
    for (const [name, breaker] of effectors.breakers) breakers[name] = breaker.stats;
    probes.getStatus().then((providers) => {
      broadcastAll({ type: 'health', payload: { breakers, providers, anomalies: anomalyLog.slice(-20) } });
    }).catch(() => {});
  }

  // audit.decision — exact string P5 must emit alongside auditWriter.write() (Ambiguity #3).
  bus.subscribe('audit.decision', (e) => {
    broadcastAll({ type: 'audit', payload: { tool: e.payload.tool, tier: e.payload.tier, decision: e.payload.decision } });
  });

  // confirm-request — exact string, cortex act() (Ambiguity #2 requires P5 to embed confirmId).
  bus.subscribe('confirm-request', (e) => {
    broadcastAll({ type: 'confirm-request', payload: { id: e.payload.confirmId, tool: e.payload.tool, summary: e.payload.summary, tier: e.payload.tier } });
  });

  // brain-spend — exact string with hyphen (D-28 fixed).
  bus.subscribe('brain-spend', (e) => {
    broadcastAll({ type: 'brain-spend', payload: e.payload });
  });

  // log — NOT a bus event; a logger hook (see Integration Points — new logger.onLog(fn)).
  if (typeof logger.onLog === 'function') {
    logger.onLog((line) => broadcastAll({ type: 'log', payload: line }));
  }

  function stop() {
    return new Promise((resolve) => {
      try { wss.close(); } catch (_) { /* best-effort */ }
      httpServer.close(() => resolve());
    });
  }

  return { app, httpServer, wss, stop };
}

module.exports = { createServer };
```

### `mythos/src/main.js` — boot-step diff

Insert this entry into `bootOrder`, in the literal §13 position (after `effectors`, before `cortex-tick`):

```js
  {
    name: 'server',
    fn: function () {
      var serverHandle = createServer({
        bus: bus, config: config, logger: logger, memory: memory,
        goalsEffector: effectors.get('goals-effector'),
        kanbanEffector: effectors.get('kanban-effector'),
        pipelineEffector: effectors.get('pipeline-effector'),
        effectors: effectorHub, leash: leash, goals: goals, probes: immune.probes,
      });
      lifecycle.registerStopServer(serverHandle.stop); // see lifecycle.js diff below
    },
    fail: 'fast',
  },
```

### `mythos/src/core/lifecycle/index.js` — diff (server-close as shutdown step 0)

```js
function createLifecycle({ bus, logger, config }) {
  // ... existing state ...
  var stopServerFn = null;

  function registerStopServer(fn) { stopServerFn = fn; }

  function shutdown(timeoutMs) {
    timeoutMs = timeoutMs || 10000;
    if (state === 'shutting-down' || state === 'dead') return;
    state = 'shutting-down';
    logger.info('lifecycle.shutdown.start');

    var shutdownTimer = setTimeout(function () {
      logger.error('lifecycle.shutdown.hard-exit');
      process.exit(1);
    }, timeoutMs);

    return (async function () {
      // Step 0 (new): stop accepting new WS/HTTP connections, drain in-flight.
      if (stopServerFn) { try { await stopServerFn(); } catch (_) { /* best-effort */ } }
      // Steps 1-5 (existing/future): sensors stop, cortex drain, working->episodic
      // flush, checkpoint write, audit flush — wired by the phases that own them.
      clearTimeout(shutdownTimer);
      state = 'dead';
      logger.info('lifecycle.shutdown.complete');
    })();
  }

  return { setSteps, boot, shutdown, registerShutdown, registerStopServer, getState };
}
```

### `mythos/src/core/logger.js` — diff (add `onLog` hook)

```js
  var logListeners = [];
  function onLog(fn) { logListeners.push(fn); return function () { logListeners.splice(logListeners.indexOf(fn), 1); }; }

  function writeLine(level, line) {
    // ... existing write-to-stdout/file logic unchanged ...
    for (var i = 0; i < logListeners.length; i++) {
      try { logListeners[i](line); } catch (_) { /* never let a listener crash logging */ }
    }
  }

  module.exports = { /* ...existing exports..., */ onLog };
```

### `mythos/ui/public/js/ws.js` — CA (client helper)

```js
// ws.js — CA from app/public/js/ws.js. Keeps: nextReqId/handlers-Map/onBroadcast/
// backoff/sendQueue verbatim. New: subscribe(types, onEvent) for live streaming.

let socket = null;
let connecting = false;
let backoffMs = 500;
const BACKOFF_MAX_MS = 8000;
const sendQueue = [];
const handlers = new Map();
const broadcastHandlers = new Map();
let reqCounter = 0;

function nextReqId() {
  reqCounter += 1;
  return `r${Date.now()}-${reqCounter}`;
}

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function flushQueue() {
  while (sendQueue.length && socket && socket.readyState === WebSocket.OPEN) {
    socket.send(sendQueue.shift());
  }
}

function scheduleReconnect() {
  if (connecting) return;
  setTimeout(connect, backoffMs);
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
}

function connect() {
  if (connecting || (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING))) return;
  connecting = true;
  socket = new WebSocket(wsUrl());

  socket.addEventListener('open', () => {
    connecting = false;
    backoffMs = 500;
    flushQueue();
  });

  socket.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    const handler = handlers.get(msg.reqId);
    if (handler) { handler(msg); return; }
    const listeners = broadcastHandlers.get(msg.type);
    if (listeners) listeners.forEach((fn) => fn(msg));
  });

  socket.addEventListener('close', () => {
    connecting = false;
    socket = null;
    scheduleReconnect();
  });

  socket.addEventListener('error', () => { if (socket) socket.close(); });
}

function sendMessage(payload) {
  const json = JSON.stringify(payload);
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(json);
  } else {
    sendQueue.push(json);
    connect();
  }
}

function stopRequest(reqId) {
  sendMessage({ type: 'stop', reqId });
}

export function onBroadcast(type, fn) {
  connect();
  if (!broadcastHandlers.has(type)) broadcastHandlers.set(type, new Set());
  broadcastHandlers.get(type).add(fn);
}

export function offBroadcast(type, fn) {
  const listeners = broadcastHandlers.get(type);
  if (!listeners) return;
  listeners.delete(fn);
  if (listeners.size === 0) broadcastHandlers.delete(type);
}

// NEW — subscribe(types, onEvent): sends {type:'subscribe', types} once and wires
// onEvent as the onBroadcast handler for every type in the list, in one call.
export function subscribe(types, onEvent) {
  connect();
  sendMessage({ type: 'subscribe', types });
  types.forEach((t) => onBroadcast(t, onEvent));
  return () => types.forEach((t) => offBroadcast(t, onEvent));
}

export function utterance({ text, onDone }) {
  connect();
  const reqId = nextReqId();
  handlers.set(reqId, (msg) => {
    if (msg.type === 'done') { handlers.delete(reqId); if (onDone) onDone(msg); }
  });
  sendMessage({ type: 'utterance', reqId, text });
  return { stop: () => stopRequest(reqId) };
}

export function confirmReply(confirmId, accept) {
  sendMessage({ type: 'confirm-reply', confirmId, accept });
}
```

### `mythos/ui/public/js/router.js` — CA (route table)

Identical mechanism to `app/public/js/router.js` (hash router, dynamic `import()`, `render(mount)` returns optional cleanup) — only `VIEW_LOADERS` changes to the 8-view MYTHOS table:

```js
const VIEW_LOADERS = {
  'mind': () => import('/views/mind.js'),
  'memory': () => import('/views/memory.js'),
  'health': () => import('/views/health.js'),
  'audit': () => import('/views/audit.js'),
  'goals': () => import('/views/goals.js'),
  'kanban': () => import('/views/kanban.js'),
  'pipeline': () => import('/views/pipeline.js'),
};

let currentCleanup = null;

function resolveRoute(hash) {
  return VIEW_LOADERS[hash] ? hash : 'mind';
}

async function loadRoute() {
  const hash = window.location.hash.replace(/^#\/?/, '') || 'mind';
  const route = resolveRoute(hash);
  if (route !== hash) history.replaceState(null, '', `#/${route}`);

  if (typeof currentCleanup === 'function') {
    try { currentCleanup(); } catch { /* ignore */ }
    currentCleanup = null;
  }

  renderShell(route);
  const mount = document.getElementById('view-mount');
  mount.innerHTML = '<div class="text-faint mono">Loading&hellip;</div>';

  try {
    const mod = await VIEW_LOADERS[route]();
    mount.innerHTML = '';
    const result = await mod.render(mount);
    if (typeof result === 'function') currentCleanup = result;
  } catch (err) {
    mount.innerHTML = `<div class="text-faint">Failed to load this surface: ${err.message}</div>`;
  }
}

window.addEventListener('hashchange', loadRoute);
document.addEventListener('DOMContentLoaded', loadRoute);
```

### `mythos/ui/public/js/shell.js` — CA (diff only)

Identical to `app/public/js/shell.js` (sidebar + header + 15s status-pill poll) with two changes: `SIDEBAR_GROUPS`/`ROUTE_META` point at the 8 MYTHOS routes instead of NOVA's, and `refreshStatusPill()` derives its pill from the live `entity-state`/`health` WS broadcasts (subscribed once at shell init) instead of polling `/api/status` on a fixed interval — since the entity now pushes its own state, polling would be redundant:

```js
import { subscribe } from './ws.js';

let lastEntityState = null;
let lastHealth = null;

subscribe(['entity-state', 'health'], (msg) => {
  if (msg.type === 'entity-state') lastEntityState = msg.payload;
  if (msg.type === 'health') lastHealth = msg.payload;
  updateStatusPill();
});

function updateStatusPill() {
  const pill = document.getElementById('status-pill');
  const label = document.getElementById('status-pill-label');
  if (!pill || !label) return;
  pill.classList.remove('all-ok', 'degraded');
  if (!lastEntityState || lastEntityState.status !== 'alive') {
    label.textContent = 'OFFLINE';
  } else {
    const anyOpen = lastHealth && Object.values(lastHealth.breakers || {}).some((b) => b.state !== 'closed');
    if (anyOpen) { pill.classList.add('degraded'); label.textContent = 'DEGRADED'; }
    else { pill.classList.add('all-ok'); label.textContent = 'ALIVE'; }
  }
}
// renderSidebar/renderHeader/renderShell bodies otherwise unchanged from app/public/js/shell.js.
```

### `mythos/ui/public/css/tokens.css` — CV verbatim

Copied byte-for-byte from `app/public/css/tokens.css` (239 lines: `@font-face` blocks, `:root` palette variables `--bg`, `--gold`, `--status-ok` etc., confirmed above) with zero modifications — no MYTHOS-specific styling changes belong in the token file; new views (Mind/Memory/Health/Audit) consume the existing `--bg-raised`, `--text-dim`, `--gold`, `--status-*` variables rather than inventing new ones.

### `mythos/ui/public/views/mind.js` — NEW

```js
// mind.js — live tick/goals/salience: the entity's current cognition.
import { subscribe } from '/js/ws.js';

export async function render(mount) {
  mount.innerHTML = `
    <div class="mind-tiles" id="mind-tiles"></div>
    <div class="mind-feed" id="mind-feed"></div>
  `;

  const state = { tick: 0, perceptions: 0, activeGoal: null, recent: [] };

  function renderTiles() {
    document.getElementById('mind-tiles').innerHTML = `
      <div class="goals-tile"><div class="goals-tile-label mono">TICK</div><div class="goals-tile-value mono">${state.tick}</div></div>
      <div class="goals-tile"><div class="goals-tile-label mono">PERCEPTIONS/TICK</div><div class="goals-tile-value mono">${state.perceptions}</div></div>
      <div class="goals-tile"><div class="goals-tile-label mono">ACTIVE GOAL</div><div class="goals-tile-value mono">${state.activeGoal || '—'}</div></div>
    `;
  }

  function renderFeed() {
    document.getElementById('mind-feed').innerHTML = state.recent
      .slice(-30).reverse()
      .map((p) => `<div class="mind-feed-row"><span class="mono text-faint">${p.channel}</span> ${p.text || p.kind} <span class="mono text-faint">${(p.salience || 0).toFixed(2)}</span></div>`)
      .join('');
  }

  const unsub = subscribe(['tick', 'goal-update', 'perception'], (msg) => {
    if (msg.type === 'tick') {
      state.tick = msg.payload.tick;
      state.perceptions = msg.payload.perceptions;
      state.activeGoal = msg.payload.activeGoal;
      renderTiles();
    } else if (msg.type === 'goal-update') {
      state.activeGoal = msg.payload.status === 'active' ? msg.payload.title : state.activeGoal;
      renderTiles();
    } else if (msg.type === 'perception') {
      state.recent.push(msg.payload);
      if (state.recent.length > 100) state.recent.shift();
      renderFeed();
    }
  });

  renderTiles();
  renderFeed();
  return unsub; // cleanup — router calls this on route change
}
```

### `mythos/ui/public/views/health.js` — NEW

```js
// health.js — breakers/providers/spend/anomaly log.
import { subscribe } from '/js/ws.js';

export async function render(mount) {
  mount.innerHTML = `
    <div class="health-breakers" id="health-breakers"></div>
    <div class="health-providers" id="health-providers"></div>
    <div class="health-anomalies" id="health-anomalies"></div>
  `;

  function breakerRow(name, b) {
    const cls = b.state === 'closed' ? 'status-ok' : b.state === 'half-open' ? 'status-degraded' : 'status-warn';
    return `<div class="health-row"><span>${name}</span><span class="${cls} mono">${b.state.toUpperCase()}</span></div>`;
  }

  const unsub = subscribe(['health'], (msg) => {
    const { breakers, providers, anomalies } = msg.payload;
    document.getElementById('health-breakers').innerHTML =
      Object.entries(breakers).map(([name, b]) => breakerRow(name, b)).join('') || '<div class="text-faint">No effectors registered.</div>';
    document.getElementById('health-providers').innerHTML =
      Object.entries(providers).map(([name, p]) => `<div class="health-row"><span>${name}</span><span class="mono">${JSON.stringify(p)}</span></div>`).join('');
    document.getElementById('health-anomalies').innerHTML =
      (anomalies || []).slice().reverse().map((a) => `<div class="health-anomaly-row mono">${a.kind} — ${JSON.stringify(a)}</div>`).join('') || '<div class="text-faint">No anomalies.</div>';
  });

  return unsub;
}
```

### `mythos/ui/public/views/audit.js` — NEW

```js
// audit.js — scrollable leash trail: every decision with tier/outcome.
import { subscribe } from '/js/ws.js';

export async function render(mount) {
  mount.innerHTML = `<div class="audit-list" id="audit-list"></div>`;
  const rows = [];

  function renderList() {
    document.getElementById('audit-list').innerHTML = rows
      .slice(-200).reverse()
      .map((r) => `<div class="audit-row"><span class="mono">T${r.tier}</span> <span class="mono">${r.decision}</span> ${r.tool}</div>`)
      .join('') || '<div class="text-faint">No decisions yet.</div>';
  }

  const unsub = subscribe(['audit'], (msg) => {
    rows.push(msg.payload);
    if (rows.length > 500) rows.shift();
    renderList();
  });

  renderList();
  return unsub;
}
```

### `mythos/ui/public/views/memory.js` — NEW

```js
// memory.js — browse 5 stores (episodic, semantic, skills, identity, audit).
const STORES = ['episodic', 'semantic', 'skills', 'identity', 'audit'];

export async function render(mount) {
  mount.innerHTML = `
    <div class="memory-tabs" id="memory-tabs">
      ${STORES.map((s) => `<button class="memory-tab" data-store="${s}">${s}</button>`).join('')}
    </div>
    <div class="memory-list" id="memory-list"></div>
  `;

  async function loadStore(store) {
    const list = document.getElementById('memory-list');
    list.innerHTML = '<div class="text-faint mono">Loading&hellip;</div>';
    try {
      const res = await fetch(`/api/memory/${store}?limit=100`);
      const data = await res.json();
      list.innerHTML = (data.entries || [])
        .map((e) => `<div class="memory-entry"><span class="mono text-faint">${new Date(e.ts).toLocaleString()}</span> ${e.summary || e.text || ''}</div>`)
        .join('') || '<div class="text-faint">Empty.</div>';
    } catch (err) {
      list.innerHTML = `<div class="text-faint">Failed to load ${store}: ${err.message}</div>`;
    }
  }

  document.getElementById('memory-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.memory-tab');
    if (!tab) return;
    document.querySelectorAll('.memory-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    loadStore(tab.dataset.store);
  });

  document.querySelector('.memory-tab').classList.add('active');
  loadStore(STORES[0]);
}
```

*(Note: `/api/memory/:store` is a new REST route this phase must also add to `server/index.js`, backed directly by `memory.<store>.recall({})`/`.get()` per store — omitted above for space; follows the exact same try/catch/json pattern as the goals/kanban/pipeline routes.)*

### `mythos/ui/views/confirm.js` — NEW (modal)

```js
// confirm.js — modal (orb styling) + spoken summary; tier-4 always, tier-3 once/session.
import { subscribe, confirmReply } from '/js/ws.js';

export async function render(mount) {
  let overlay = null;

  function showModal(payload) {
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-modal">
        <div class="confirm-orb"></div>
        <div class="confirm-summary">${payload.summary}</div>
        <div class="confirm-tier mono">TIER ${payload.tier}</div>
        <div class="confirm-actions">
          <button class="confirm-accept">Approve</button>
          <button class="confirm-reject">Deny</button>
        </div>
      </div>
    `;
    overlay.querySelector('.confirm-accept').addEventListener('click', () => {
      confirmReply(payload.id, true);
      overlay.remove(); overlay = null;
    });
    overlay.querySelector('.confirm-reject').addEventListener('click', () => {
      confirmReply(payload.id, false);
      overlay.remove(); overlay = null;
    });
    document.body.appendChild(overlay);
  }

  // Confirm is not a routed view — it's a global overlay mounted once at shell init,
  // not per-route. render(mount) here is only invoked if a user navigates to it
  // directly; the real subscription lives in shell.js's init (shown for completeness).
  return subscribe(['confirm-request'], (msg) => showModal(msg.payload));
}
```

## Integration Points

| Direction | Contract | Source |
|---|---|---|
| Server calls INTO shipped modules | `effectors.breakers` (`Map<string, Breaker>`, each `.stats → {name,state,failCount,resetAt}`) | §10 `breakers.js` |
| Server calls INTO shipped modules | `probes.getStatus()` (async, no args) | §16 P6 deliverable, CA from `app/lib/probes.js` |
| Server calls INTO shipped modules | `memory.episodic.write(entry)` | shipped `memory/index.js` facade |
| Server calls INTO shipped modules | `goals.debitBudget(id, {tokens, actions})` | shipped `goals/index.js` |
| Server calls INTO shipped modules | `brain.registry.getStatus()` → `{nim,ollama,groq,mistral,chains,probedAt}` | `mythos/src/core/brain/registry.js:137-154` (verified) |
| **P9 REQUIRES FROM P5** | `leash.confirm.create(summary, action, connectionId) → confirmId`; `.accept(confirmId, connectionId) → action\|null`; `.reject(confirmId, connectionId) → bool` — CROSS-PHASE FIX: P5's shipped `confirm.js` uses this exact 3-arg `create()` signature, not `(decision, leashResult)` as an earlier draft of this table assumed; `server/index.js` must call it with `summary`/`action`/`connectionId` in that order | Ambiguity #2 |
| **P9 REQUIRES FROM P5** | `leash.check()` must `bus.emit('audit.decision', {...})` (exact string, dot-prefixed) in addition to its direct `auditWriter.write()` call | Ambiguity #3, §4/§9 seam |
| **P9 REQUIRES FROM P7** | `effectors/goals.js` exposes `listGoals()/addGoal(text,category)/toggleGoal(id)/deleteGoal(id)/stats()` returning the **same shape** as NOVA `app/lib/goals.js` (`{id,text,category,done}`) | Ambiguity #1 |
| **P9 REQUIRES FROM P7** | `effectors/kanban.js`, `effectors/pipeline.js` expose the identical method surface as `app/lib/kanban.js` / `app/lib/pipeline.js` (verified signatures: `listBoard/addCard/moveCard/deleteCard`; `listAll/capture/moveCard/approve/reject/ship`) | §15 "Unchanged" |
| Future phases call INTO this phase | `createServer({bus,config,logger,memory,goalsEffector,kanbanEffector,pipelineEffector,effectors,leash,goals,probes}) → {app,httpServer,wss,stop}` | this phase |
| Future phases call INTO this phase | `dispatchAction(decision, {goalId, tier})` — the shared post-gate execute helper P5's `cortex/act()` extension must call, not reimplement | Ambiguity #2 |
| main.js calls INTO this phase | `'server'` boot step, `fail:'fast'`, positioned after `'effectors'` and before `'cortex-tick'` per §13 | §13 literal order |
| lifecycle calls INTO this phase | `serverHandle.stop()` registered via `lifecycle.registerStopServer(fn)`, run as shutdown step 0 | Ambiguity #5 |

## Anti-Drift Checklist

1. Every `bus.subscribe(...)` string in `server/index.js` is copy-pasted from a verified source (either this phase's own architecture-doc excerpt or an already-shipped file/line cited above) — none are typed from memory. Cross-check before merging: `'tick'`, `'lifecycle.*'`, `'goal.*'`, `'perception.*'`, `'action.*'`, `'health.anomaly'`, `'perception.metric'`, `'audit.decision'`, `'confirm-request'`, `'brain-spend'`.
2. `audit.decision` and the `confirmId`-carrying `confirm-request` payload do not exist in the P5 code that ships today (P5 hasn't started) — this spec's Integration Points table is the P5 implementer's contract. Do not let P9 ship first and silently work around a missing `leash.confirm` by inventing an ad-hoc confirm store inside `server/index.js` — that would duplicate NOVA's `confirm.js` a second time and reintroduce the exact double-implementation bug class this phase's Ambiguity #2 was written to prevent.
3. The `'server'` boot step is wired into `main.js`'s real `bootOrder` array in the same PR that adds `server/index.js` — per Lesson #2, it is never left as a built-but-unbooted island the way memory/brain/cortex/goals were in P0–P4.
4. `dispatchAction`'s breaker-check, invoke, episodic-write, budget-debit, and `action.completed` emit steps must stay byte-for-byte identical to `cortex/act()`'s steps 3–6 (§6). If P5 changes `act()`'s post-gate logic, `server/index.js`'s `dispatchAction` must change in the same commit — never let the two drift into two different "what happens after a gate passes" implementations.
5. `goalsEffector`/`kanbanEffector`/`pipelineEffector` REST routes in `server/index.js` are gated only by presence at boot (constructor-injected, per Lesson #3) — if P7 hasn't shipped when P9 lands, `main.js`'s `'server'` boot step must throw at construction, not silently serve 404s or skip route registration.
6. `mind.js`/`health.js`/`audit.js`/`memory.js` never call `fetch('/api/...')` for the live-cognition parts (tick/goals/perception/health/audit) — those are WS-only, per §14's design intent ("async render → cleanup" + broadcast protocol). Only Memory's static-store browse and Goals/Kanban/Pipeline's CRUD use REST. Mixing polling into the WS-fed views would silently reintroduce NOVA's `setInterval(refreshStatusPill, 15000)` polling pattern this phase explicitly replaces (see shell.js diff).
7. `ALLOWED_ORIGINS` and the WS `verifyClient` loopback/origin check are copied from `app/server.js:1193-1203` **verbatim in logic** — do not "simplify" the loopback set or origin-check branching; that logic exists specifically to close a CSWSH hole (see the security-review comment at that line in NOVA).
8. Every view's `render(mount)` returns its `subscribe()` unsubscribe function as its cleanup — verify with a test that navigating away from Mind/Health/Audit actually calls `offBroadcast` (leaked broadcast handlers accumulate silently across route changes and would eventually double- or triple-fire UI updates per message).

## Test Plan

Maps to the Phase 9 gate in ROADMAP.md: *"all views render, WS v2 messages flow, confirm modal works, Mind/Memory/Health/Audit views show live data."*

1. **Real-instance integration test — bus event to WS broadcast (Lesson #4).** Boot a real `createBus()`, a real (non-fake) `createServer()` against an ephemeral port, connect a real `ws` client, emit `bus.emit('tick', {tick: 5, perceptions: 2})` on the real bus, and assert the WS client actually receives `{type:'tick', payload:{tick:5, perceptions:2, activeGoal:null}}`. This is the exact class of seam (module A's real emit → module B's real relay) that D-38 proved unit tests miss.

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

test('real bus tick event relays to a real WS client as type:tick', async () => {
  const bus = createBus({ historySize: 50 });
  const fakeMemory = { working: { tick: 0, activeGoalId: null }, episodic: { write: async () => {} } };
  const server = createServer({
    bus, config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3 },
    logger: { info(){}, warn(){}, error(){} },
    memory: fakeMemory,
    goalsEffector: { listGoals: () => [], stats: () => ({}) },
    kanbanEffector: { listBoard: () => ({}) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
    leash: { confirm: { create: () => 'cf-1', accept: () => null, reject: () => true } },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({}) },
  });

  const addr = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  const received = new Promise((resolve) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'tick') resolve(msg);
    });
  });

  bus.emit('tick', { tick: 5, perceptions: 2 });
  const msg = await received;
  assert.equal(msg.payload.tick, 5);
  assert.equal(msg.payload.perceptions, 2);

  ws.close();
  await server.stop();
});
```

2. **Real-instance integration test — confirm-reply resolves through `leash.confirm` and `dispatchAction` (exercises the exact seam Ambiguity #2 designed).**

```js
test('confirm-reply accept invokes the effector via dispatchAction, not a shadow path', async () => {
  const bus = createBus({ historySize: 50 });
  const invoked = [];
  const fakeEffectors = {
    breakers: new Map(),
    invoke: async (tool, args) => { invoked.push({ tool, args }); return { ok: true }; },
    effectors: new Map(),
  };
  let storedAction = null;
  // CROSS-PHASE FIX (consistency pass, P5 vs P9): P5's real confirm.js signature
  // is create(summary, action, connectionId), not a single decision object, and
  // accept(confirmId, connectionId) takes 2 args, not 1 — mock updated to match.
  const fakeLeash = {
    confirm: {
      create: (summary, action, connectionId) => { storedAction = action; return 'cf-42'; },
      accept: (id, connectionId) => (id === 'cf-42' ? storedAction : null),
      reject: () => true,
    },
  };
  const server = createServer({
    bus, config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3 },
    logger: { info(){}, warn(){}, error(){} },
    memory: { working: { tick: 0 }, episodic: { write: async () => {} } },
    goalsEffector: { listGoals: () => [], stats: () => ({}) },
    kanbanEffector: { listBoard: () => ({}) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: fakeEffectors,
    leash: fakeLeash,
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({}) },
  });

  const addr = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  fakeLeash.confirm.create('Kill session x?', { tool: 'kill_session', args: { sessionId: 'x' } }, 'conn-1');
  ws.send(JSON.stringify({ type: 'confirm-reply', confirmId: 'cf-42', accept: true }));

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(invoked.length, 1, 'effector should have been invoked exactly once via dispatchAction');
  assert.equal(invoked[0].tool, 'kill_session');

  ws.close();
  await server.stop();
});
```

3. **Manual smoke check (Gate criterion 2):** `node src/main.js`, open `http://127.0.0.1:4478/#/mind`, confirm the tick counter advances every `MYTHOS_TICK_MS`; navigate to `#/health` and confirm breaker states render; force a tier-4 action and confirm the modal (`confirm.js`) appears and Approve/Deny round-trips via `confirm-reply`.

## Do NOT

- Do not implement a second, ad-hoc pending-confirmation map inside `server/index.js` "for now" because P5's `leash/confirm.js` doesn't exist yet — that duplicates NOVA's already-correct pattern a second time and is exactly the kind of shadow implementation Ambiguity #2 exists to prevent. Land the contract in Integration Points and block on it if necessary.
- Do not poll `/api/status` on a `setInterval` for the status pill or any of the 4 new views — the entity now pushes `tick`/`entity-state`/`health` over WS; reintroducing polling silently defeats the point of WS v2.
- Do not let `broadcastAll` fan out the raw, unfiltered `perception.*` firehose (including `perception.tick`/`perception.metric` heartbeat noise) to every connected client — always apply the `MYTHOS_IDLE_SALIENCE` threshold from config, never a fresh hardcoded number.
- Do not rename the `'tick'` bus event to fit the bus's own `perception|decision|action|health|memory|lifecycle|audit|identity` channel taxonomy — that's a pre-existing, already-tested P3 quirk (Ambiguity #6), not this phase's to silently "fix."
- Do not skip registering the `'server'` boot step in `main.js`'s real `bootOrder` in this same PR — a `server/index.js` that only unit-tests cleanly but is never booted is exactly the P0–P4 mistake this roadmap explicitly calls out.
- Do not perform any step of the Cutover Plan (tag, soak, vault import, `archive/nova/` move, launch-script repoint) until every item in ROADMAP.md's "Known Deviations" MAJOR list is closed — the roadmap explicitly gates cutover on it, and several (D-19–D-23, D-40–D-42) directly determine what the Memory/Health/Audit views in this phase will show as "live data."

---

# Phase 10 — Chaos Drills

## Overview & Why

Phase 10 injects six concrete failures — killed provider, stalled event loop, full disk, corrupted JSONL, overlapping ticks, mid-dispatch crash — against the REAL modules built in P0–P9, and asserts the entity degrades honestly (never throws to a caller, never fakes success, never silently loses data) instead of crashing or lying. Without this phase, every "honest-inert" claim in MYTHOS-ARCHITECTURE.md (§10 Immune System, Crash Invariants in §13) is unverified prose — P0–P4's own audit already proved that passing unit tests do not prove cross-module correctness (D-38), and Phase 1's decay/consolidate bugs (D-17/D-18) were only caught by reading code, not by any test. Chaos drills are the only test class in this project that exercises the seams between memory, brain, cortex, immune, and effectors under adversarial conditions rather than in isolation.

This phase produces **test files only** — no new `src/` modules. Every drill is written against the real, already-shipped (and, where noted, Phase-4.5-fixed) module surface: `mythos/src/core/memory/{fs-store,episodic,checkpoints,working}.js`, `mythos/src/core/brain/{index,chain,registry}.js`, `mythos/src/core/cortex/index.js`, `mythos/src/core/goals/index.js`, and the P6/P7 immune/effector modules assumed built per §10/§12 of the architecture doc.

## Directory & File Layout

```
mythos/test/
├── chaos-provider-killed.test.js       (Drill 1)
├── chaos-cortex-stalled.test.js        (Drill 2)
├── chaos-disk-full.test.js             (Drill 3)
├── chaos-memory-corrupt.test.js        (Drill 4)
├── chaos-concurrent-tick.test.js       (Drill 5 — also the mandatory real cortex↔goals
│                                          integration test per lesson #4 / R9)
└── chaos-restart-mid-action.test.js    (Drill 6)
```

No `src/` files are created or modified by this phase. Where a drill depends on a P4.5/P6/P7 fix or an unspecified cross-module contract, the exact expected shape is called out below (Spec Ambiguities Resolved) so the test doubles as an executable contract for whichever phase actually builds that piece.

## Spec Ambiguities Resolved

1. **`createFsStore` signature after D-16.** Today (already read): `createFsStore(vaultRootFn)` — no `bus`, so corrupt-line skips in `readLines`/`readDirLines` are silent. D-16's fix text says "pass `bus` into `createFsStore`." Resolution: fixed signature is `createFsStore(vaultRootFn, { bus } = {})`, **backward-compatible** with the existing single-arg call sites (`memory/index.js`'s `createFsStore(vaultRoot)`, `test/memory.test.js`'s `createFsStore(() => dir)`) since the second arg is optional. `readLines`/`readDirLines` must call `bus.emit('health.anomaly', { kind: 'corrupt-line', path: relPath, index: idx })` — exact string `'corrupt-line'`, do not paraphrase — for every line that fails `JSON.parse`, in addition to (not instead of) the existing skip/null-marker behavior. Drill 4 is written against this contract.

2. **Disk-full (D-16/D-18) vs. this drill's actual dependency.** Re-reading `episodic.js`, `semantic.js`, and `checkpoints.js`: each already wraps its own `fs.appendLine`/`fs.writeJSON` call in try/catch and emits `health.anomaly` via its **own** injected `bus` (independent of whether `fs-store.js` itself has a `bus`). D-16 is specifically about `fs-store.js`'s corrupt-line *read* path (exercised by Drill 4), not the write-failure path. **Drill 3 therefore already passes against today's unfixed code** — it needs no Phase-4.5 fix. ROADMAP.md's Phase 10 note ("exercises D-16/D-18") is accurate for Drill 4 (corrupt-line) and for the archive-vs-delete part of D-18, but not for Drill 3's write-degrade behavior, which is already conformant. Stated here so nobody "fixes" fs-store's write path as a prerequisite for a drill that doesn't need it.

3. **`createBreaker` never receives `bus` or `config` in the spec's own pseudocode** (§10, `recordFailure()` calls `bus.emit(...)` but `createBreaker({name, failThreshold, ...})`'s param list never includes `bus` — a closure over an undefined free variable; the breaker's numeric defaults also come from `config.BREAKER_*` per P6's real shipped `breakers.js`, not inline defaults). Resolution: `createBreaker({ name, bus, config, failThreshold, windowMs, resetMs, maxResetMs })` — CROSS-PHASE FIX (consistency pass, P6 vs P10): both `bus` and `config` added, mandatory per lesson #8 (throw if missing, never skip the anomaly emit) — this drill's own breaker construction calls must pass `config`, not rely on inline `= 3`-style defaults that P6's real module doesn't have.

4. **`effectors.breakers.allow(name)` vs. `breakers` being a `Map`.** §12's Effector Hub defines `breakers` as `Map<name, breaker>` (`breakers.set(effector.id, createBreaker(...))`), but §6's Act Stage — and the already-shipped `cortex/index.js:121` — calls `effectors.breakers.allow(decision.tool)` directly, as if `breakers` were a single object with an `.allow(name)` method. A bare `Map` has no `.allow` method — this line would throw in production today if `effectors` were ever wired in (it currently isn't, per the `if (effectors && effectors.breakers && typeof effectors.breakers.allow === 'function')` guard, which is itself D-39's fail-open bug). Resolution: whatever P7 builds must expose `get breakers()` returning `{ allow(name) { const b = map.get(name); return b ? b.allow() : true; }, get(name) { return map.get(name); } }`, not the raw `Map`. Flagged as a required contract for any stub `effectors` object these drill tests construct, and as a concrete finding worth a regression test in P7 (`assert.equal(typeof hub.breakers.allow, 'function')`).

5. **Watchdog does not receive `goals` in the spec's `createWatchdog({ cortex, bus, config })` signature**, yet its own comment says "(3) Active goal → paused `'cortex-restart'`." Resolution: fixed signature is `createWatchdog({ cortex, bus, config, goals })`; `handleStall()` must call `goals.getActive()` and, if non-null, `goals.update(active.id, { status: 'paused', reason: 'cortex-restart' })` — exact string `'cortex-restart'` — between `cortex.stop()` and `cortex.start()`. Drill 2 is written against this contract.

6. **`chain.js`'s fallback mechanism is not the same thing as `BREAKER_FAIL_THRESHOLD`.** `chain.js` (already shipped, P2) cools a `lane:model` down after its **first** failure (`markCooldown` is called unconditionally in the `catch`), independent of the `BREAKER_FAIL_THRESHOLD` config key, which `chain.js` never reads. The immune Circuit Breaker FSM (§10) with its 3-fail-then-open semantics is scoped to *effectors* in the Effector Hub, not to brain-lane provider selection. Drill 1 tests the mechanism that actually exists (single-fail cooldown → fallback → eventual `chainExhausted`), which delivers the drill's observable contract ("breaker opens, falls back, offline when exhausted"), and documents this literal mismatch rather than silently asserting a threshold `chain.js` doesn't implement. If a future phase wants literal `BREAKER_FAIL_THRESHOLD`-gated provider lanes, that is new work for `chain.js`/P6, out of scope for a test-only phase.

7. **Build-runner's crash-recovery→goal-pause composition has no named owner in the spec.** §12's `build-runner.js` sketch only says "restart marks running jobs failed"; nothing in §12/§13 says who reads that list and pauses the tied goal. Resolution: `createBuildRunner(...).init()` returns `{ recoveredJobs: [{ id, goalId, error }] }` for every job forced from `running`/`queued`→`failed` on this construction. `main.js`'s `recovery` boot step (already a named FAIL-degraded step per §13's Boot Sequence) is the single owner responsible for iterating `recoveredJobs` and calling `goals.update(goalId, { status: 'paused', reason: 'crash-recovery' })` for each. Drill 6 calls this exact composition inline and flags in Anti-Drift Checklist that it must match `main.js`'s real `recovery` step verbatim, not be a second, divergent implementation.

## Full Code

### `mythos/test/chaos-provider-killed.test.js`

```js
'use strict';

// CHAOS DRILL 1 — Provider-killed.
// Kills a fake provider HTTP server mid-request (socket destroy, not a clean error
// response) and proves: (a) chain.js's per-lane cooldown opens and falls back to the
// next configured lane, and (b) when every lane is exhausted, brain.think() returns
// { offline: true } and NEVER throws to the caller.
//
// Env vars are set BEFORE any mythos module is required, because groq.js/ollama.js/
// registry.js read their URLs into `const`s at module-load time.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.on('error', reject);
  });
}

function makeGroqServer(state) {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
      if (state.killChat) {
        // Simulate the provider process being killed mid-request: no headers,
        // no error body — just a dead socket, exactly like a killed process.
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi from groq' } }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(404); res.end();
  });
}

function makeOllamaServer(state) {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'chaos-model' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      if (state.killChat) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { content: 'hi from ollama' } }) + '\n');
      res.end();
      return;
    }
    res.writeHead(404); res.end();
  });
}

function fakeBus() {
  const { createBus } = require('../src/core/bus');
  const bus = createBus({ historySize: 200 });
  const emitted = [];
  const origEmit = bus.emit.bind(bus);
  bus.emit = function(type, payload, opts) {
    emitted.push({ type: type, payload: payload });
    return origEmit(type, payload, opts);
  };
  bus._emitted = function() { return emitted.slice(); };
  return bus;
}

describe('chaos drill: provider-killed', () => {
  let groqServer, ollamaServer;
  const groqState = { killChat: true };
  const ollamaState = { killChat: false };
  let chain, createBrain;

  before(async () => {
    groqServer = makeGroqServer(groqState);
    ollamaServer = makeOllamaServer(ollamaState);
    await listen(groqServer);
    await listen(ollamaServer);

    // Set env BEFORE requiring any mythos module — providers read these at require time.
    process.env.GROQ_API_URL = `http://127.0.0.1:${groqServer.address().port}/v1`;
    process.env.GROQ_API_KEY = 'chaos-test-key';
    process.env.OLLAMA_URL = `http://127.0.0.1:${ollamaServer.address().port}`;
    // CHAIN_VOICE override — exact config key, do not paraphrase.
    process.env.CHAIN_VOICE = 'groq:chaos-model,ollama:chaos-model';

    chain = require('../src/core/brain/chain');
    createBrain = require('../src/core/brain').createBrain;
  });

  after(() => {
    groqServer.close();
    ollamaServer.close();
    delete process.env.GROQ_API_URL;
    delete process.env.GROQ_API_KEY;
    delete process.env.OLLAMA_URL;
    delete process.env.CHAIN_VOICE;
  });

  beforeEach(() => {
    chain._internal._resetCooldowns();
  });

  it('kills groq mid-request → lane cools down, chain falls back to ollama, brain.think stays online', async () => {
    groqState.killChat = true;
    ollamaState.killChat = false;

    const bus = fakeBus();
    const brain = createBrain({ config: { MYTHOS_NAME: 'MYTHOS' }, bus: bus });
    const result = await brain.think({
      lane: 'voice',
      messages: [{ role: 'user', content: 'ping' }],
      source: 'chaos-drill-1'
    });

    assert.equal(result.offline, false, 'brain.think must not report offline once a fallback lane succeeds');
    assert.equal(result.provider, 'ollama', 'chain must fall back to ollama once groq is killed');
    assert.ok(
      chain._internal.cooldowns.has('groq:chaos-model'),
      'groq:chaos-model must be marked cooling after the killed request'
    );
    // 'brain-spend' — exact event name, do not paraphrase — must fire per attempt.
    const spendEvents = bus._emitted().filter((e) => e.type === 'brain-spend');
    assert.ok(spendEvents.length >= 2, 'brain-spend should fire for both the failed groq attempt and the ollama success');
  });

  it('BREAKER_FAIL_THRESHOLD-equivalent: repeated kills never resurrect a cooling lane mid-window', async () => {
    // NOTE (Spec Ambiguity #6): chain.js cools a lane after its FIRST failure, not
    // after config.BREAKER_FAIL_THRESHOLD failures — there is no literal 3-strike
    // counter at this layer today. This test asserts the actual, stricter contract:
    // once cooled, repeated attempts within COOLDOWN_MS never re-hit the dead lane.
    process.env.CHAIN_VOICE = 'groq:chaos-model';
    groqState.killChat = true;

    let hits = 0;
    const groqOrig = groqState;
    const origServer = groqServer;
    origServer.on('request', () => { hits++; });

    await assert.rejects(
      chain.complete({ messages: [{ role: 'user', content: 'x' }], brain: 'voice' }),
      (err) => err.chainExhausted === true
    );
    const hitsAfterFirst = hits;
    await assert.rejects(
      chain.complete({ messages: [{ role: 'user', content: 'x' }], brain: 'voice' }),
      (err) => err.chainExhausted === true
    );
    assert.equal(hits, hitsAfterFirst, 'a cooling lane must not be re-attempted before COOLDOWN_MS elapses');

    process.env.CHAIN_VOICE = 'groq:chaos-model,ollama:chaos-model';
  });

  it('all lanes killed → brain.think returns {offline:true}, content null, and NEVER throws', async () => {
    groqState.killChat = true;
    ollamaState.killChat = true;

    const bus = fakeBus();
    const brain = createBrain({ config: {}, bus: bus });
    // No try/catch here on purpose — reaching the assertions below already proves
    // brain.think() did not throw to its caller.
    const result = await brain.think({
      lane: 'voice',
      messages: [{ role: 'user', content: 'ping' }],
      source: 'chaos-drill-1'
    });

    assert.equal(result.offline, true, 'brain.think must report offline when every lane is exhausted');
    assert.equal(result.content, null);
    assert.equal(result.lane, 'voice');
  });
});
```

### `mythos/test/chaos-cortex-stalled.test.js`

CROSS-PHASE FIX (consistency pass, P6 vs P10): P6's real `watchdog.js` is
detection-only — `createWatchdog({getCortex, bus, config})` (a thunk, not a
direct `cortex` reference, and no `goals` param at all) — and its own Anti-Drift
Checklist explicitly forbids it from calling `cortex.stop()`/`start()` directly
(that would double-restart, since the real restart path is
`health.anomaly{kind:'cortex-stall'}` → `diagnostician` → `healer`'s
`'stall-restart'` playbook → its `'restart-cortex'` action, which now also pauses
the active goal — see P6's Full Code). This drill originally constructed
`createWatchdog({cortex, bus, config, goals})` expecting the watchdog alone to
do all of that; rewritten below to wire the real 3-component pipeline.

```js
'use strict';

// CHAOS DRILL 2 — Cortex-stalled.
// Blocks the event loop synchronously past STALL_MS*5, then proves the real
// pipeline (P6) detects the stall via cortex.lastTickAt.value (watchdog),
// diagnoses it (diagnostician), and heals it (healer's 'stall-restart'
// playbook -> 'restart-cortex' action: stop+start, generation bumps, AND pauses
// the active goal with reason 'cortex-restart'). Watchdog itself never touches
// cortex.stop/start or goals — see P6's Anti-Drift Checklist #6.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fakeBus() {
  const { createBus } = require('../src/core/bus');
  const bus = createBus({ historySize: 200 });
  const emitted = [];
  const origEmit = bus.emit.bind(bus);
  bus.emit = function(type, payload, opts) {
    emitted.push({ type: type, payload: payload });
    return origEmit(type, payload, opts);
  };
  bus._emitted = function() { return emitted.slice(); };
  return bus;
}

function fakeMemory() {
  return {
    working: {
      tick: 0,
      activeGoalId: null,
      spendThisTick: 0,
      drainPerceptions: function() { return []; },
      resetTickState: function() { this.spendThisTick = 0; },
      pushPerception: function() {},
      addSpend: function() {}
    },
    episodic: { write: async function() { return { ref: 'ep-x', degraded: false }; } },
    consolidate: async function() {}
  };
}

// Fixed cortex construction requires mandatory leash/effectors (D-39) — minimal
// stubs satisfying the contract, since this drill's seam is cortex<->watchdog<->goals.
function stubLeash() { return { check: function() { return { allow: true, requireConfirm: false, tier: 0 }; } }; }
function stubEffectors() {
  return {
    invoke: async function() { return { ok: true }; },
    breakers: { allow: function() { return true; } }
  };
}

describe('chaos drill: cortex-stalled', () => {
  it('watchdog detects stall (detection-only), healer restarts cortex + pauses active goal with reason cortex-restart', async () => {
    const { createCortex } = require('../src/core/cortex');
    const { createWatchdog } = require('../src/core/immune/watchdog');
    const { createDiagnostician } = require('../src/core/immune/diagnostician');
    const { createHealer } = require('../src/core/immune/healer');
    const { createGoalSystem } = require('../src/core/goals');

    const bus = fakeBus();
    const memory = fakeMemory();
    const fs = { writeJSON: function() {}, ensureDir: function() {}, listFiles: function() { return []; }, removeFile: function() {} };
    const config = {
      MYTHOS_TICK_MS: 10,
      STALL_MS: 50,       // exact config key: STALL_MS
      WATCHDOG_MS: 15,    // exact config key: WATCHDOG_MS
      MAX_ACTIVE_GOALS: 5
    };

    const goals = createGoalSystem({ fs: fs, config: config, bus: bus, memory: null, brain: null });
    const activeGoal = goals.create({ title: 'Chaos target', drive: 'user-service', status: 'active' });

    const cortex = createCortex({
      bus: bus, memory: memory, goals: goals, brain: null,
      leash: stubLeash(), effectors: stubEffectors(), config: config
    });
    // Watchdog is detection-only — a getCortex thunk, no goals param — per P6's
    // real contract. It never calls cortex.stop()/start() itself.
    const watchdog = createWatchdog({ getCortex: function() { return cortex; }, bus: bus, config: config });
    const diagnostician = createDiagnostician({ bus: bus });
    const healer = createHealer({
      bus: bus, config: config, memory: memory,
      getCortex: function() { return cortex; },
      getGoals: function() { return goals; }
    });

    cortex.start();
    diagnostician.start();
    healer.start();
    watchdog.start();

    await sleep(60); // let a few real ticks refresh cortex.lastTickAt.value
    const genBefore = cortex.generation;
    assert.ok(cortex.lastTickAt.value > 0, 'cortex should have ticked at least once before the stall');

    // Synchronous busy-wait — genuinely blocks the event loop, including cortex's
    // own setInterval AND the watchdog's setInterval, for STALL_MS*5+.
    const stallUntil = Date.now() + (config.STALL_MS * 6);
    while (Date.now() < stallUntil) { /* intentional busy-block */ }

    // Give the now-free event loop time for watchdog's detection AND the
    // diagnostician->healer pipeline it triggers to run.
    await sleep(config.WATCHDOG_MS * 4);

    const anomalies = bus._emitted().filter((e) => e.type === 'health.anomaly' && e.payload.kind === 'cortex-stall');
    assert.ok(anomalies.length >= 1, "watchdog must emit health.anomaly{kind:'cortex-stall'} (detection only — no restart here)");

    assert.ok(cortex.generation > genBefore, "healer's 'stall-restart' playbook must bump cortex generation via its 'restart-cortex' action, not the watchdog directly");

    const healed = bus._emitted().filter((e) => e.type === 'health.healed' && e.payload.playbookId === 'stall-restart');
    assert.ok(healed.length >= 1, "healer must report the 'stall-restart' playbook as applied");

    const refreshedGoal = goals.get(activeGoal.id);
    assert.equal(refreshedGoal.status, 'paused', 'active goal must be paused after a detected stall (via restart-cortex action, not watchdog)');
    assert.equal(refreshedGoal.reason, 'cortex-restart', "pause reason must be the exact string 'cortex-restart'");

    watchdog.stop();
    diagnostician.stop();
    healer.stop();
    cortex.stop();
  });
});
```

### `mythos/test/chaos-disk-full.test.js`

```js
'use strict';

// CHAOS DRILL 3 — Disk-full.
// Monkey-patches fs-store's `appendLine` (the exact function episodic.write() and
// checkpoints.save() use) to reject with ENOSPC, and proves every store degrades
// honestly: { ref: null, degraded: true } / { ok: false, degraded: true }, a
// health.anomaly fires, and nothing crashes.
//
// See Spec Ambiguities Resolved #2: this path already conforms today — each store
// wraps its own fs.* call and emits health.anomaly via its OWN injected bus. No
// fs-store fix is required for this drill.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

function tempDir() {
  const dir = path.join(os.tmpdir(), 'mythos-chaos-disk-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  ['Episodic', 'Checkpoints'].forEach((d) => fs.mkdirSync(path.join(dir, d), { recursive: true }));
  return dir;
}

function fakeBus() {
  const { createBus } = require('../src/core/bus');
  const bus = createBus({ historySize: 200 });
  const emitted = [];
  const origEmit = bus.emit.bind(bus);
  bus.emit = function(type, payload, opts) {
    emitted.push({ type: type, payload: payload });
    return origEmit(type, payload, opts);
  };
  bus._emitted = function() { return emitted.slice(); };
  return bus;
}

function enospcError() {
  const err = new Error('ENOSPC: no space left on device');
  err.code = 'ENOSPC';
  return err;
}

describe('chaos drill: disk-full', () => {
  let dir;

  beforeEach(() => { dir = tempDir(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it('episodic.write() degrades honestly and emits health.anomaly when appendLine hits ENOSPC', () => {
    const { createFsStore } = require('../src/core/memory/fs-store');
    const { createEpisodicStore } = require('../src/core/memory/episodic');

    const bus = fakeBus();
    const fsStore = createFsStore(() => dir);
    // Monkey-patch the EXACT function episodic.write() calls (fs-store.js:appendLine).
    fsStore.appendLine = function() { throw enospcError(); };

    const episodic = createEpisodicStore({ fs: fsStore, config: { EPISODIC_RETENTION_DAYS: 30 }, bus: bus, logger: null });
    const result = episodic.write({ kind: 'action', summary: 'disk full test' });

    assert.deepEqual(result, { ref: null, degraded: true }, 'write() must degrade honestly, never throw');
    const anomalies = bus._emitted().filter((e) => e.type === 'health.anomaly');
    assert.ok(anomalies.length >= 1, 'a health.anomaly event must fire on write failure');
    assert.equal(anomalies[0].payload.store, 'episodic');
  });

  it('checkpoints.save() degrades honestly and emits health.anomaly when writeJSON hits ENOSPC', () => {
    const { createFsStore } = require('../src/core/memory/fs-store');
    const { createCheckpointStore } = require('../src/core/memory/checkpoints');

    const bus = fakeBus();
    const fsStore = createFsStore(() => dir);
    fsStore.writeJSON = function() { throw enospcError(); };

    const checkpoints = createCheckpointStore({ fs: fsStore, config: {}, bus: bus, logger: null });
    const result = checkpoints.save({ tick: 5, activeGoalId: 'goal-x', contextKeys: [], lastTickAt: Date.now() });

    assert.deepEqual(result, { ok: false, degraded: true });
    const anomalies = bus._emitted().filter((e) => e.type === 'health.anomaly' && e.payload.kind === 'checkpoint-write-failed');
    assert.ok(anomalies.length >= 1);
  });

  it('a subsequent write after disk space frees up succeeds normally (no permanent poisoning)', () => {
    const { createFsStore } = require('../src/core/memory/fs-store');
    const { createEpisodicStore } = require('../src/core/memory/episodic');

    const bus = fakeBus();
    const fsStore = createFsStore(() => dir);
    const realAppendLine = fsStore.appendLine;
    let fail = true;
    fsStore.appendLine = function(relPath, obj) {
      if (fail) throw enospcError();
      return realAppendLine(relPath, obj);
    };

    const episodic = createEpisodicStore({ fs: fsStore, config: { EPISODIC_RETENTION_DAYS: 30 }, bus: bus, logger: null });
    const degraded = episodic.write({ kind: 'action', summary: 'still full' });
    assert.equal(degraded.degraded, true);

    fail = false; // disk space freed
    const ok = episodic.write({ kind: 'action', summary: 'space freed' });
    assert.equal(ok.degraded, false, 'a store must recover once the underlying write succeeds again');
    assert.ok(ok.ref, 'a successful write after recovery must return a real ref');
  });
});
```

### `mythos/test/chaos-memory-corrupt.test.js`

```js
'use strict';

// CHAOS DRILL 4 — Memory-corrupt.
// fs.appendFileSync's a malformed line into a REAL episodic .jsonl file mid-write,
// then proves recall()/tail() skip the corrupt line, surrounding data survives, a
// health.anomaly fires (D-16 contract — see Spec Ambiguities Resolved #1), and
// checkpoint-restore + WorkingMemory rebuild still work afterward.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

function tempDir() {
  const dir = path.join(os.tmpdir(), 'mythos-chaos-corrupt-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  ['Episodic', 'Checkpoints'].forEach((d) => fs.mkdirSync(path.join(dir, d), { recursive: true }));
  return dir;
}

function todayFile(dir) {
  const d = new Date();
  const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return path.join(dir, 'Episodic', key + '.jsonl');
}

function fakeBus() {
  const { createBus } = require('../src/core/bus');
  const bus = createBus({ historySize: 200 });
  const emitted = [];
  const origEmit = bus.emit.bind(bus);
  bus.emit = function(type, payload, opts) {
    emitted.push({ type: type, payload: payload });
    return origEmit(type, payload, opts);
  };
  bus._emitted = function() { return emitted.slice(); };
  return bus;
}

describe('chaos drill: memory-corrupt', () => {
  let dir;
  beforeEach(() => { dir = tempDir(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it('corrupt line is skipped, surrounding entries survive, health.anomaly fires (D-16 contract)', () => {
    // Fixed fs-store signature per Spec Ambiguities Resolved #1: createFsStore(fn, {bus}).
    const { createFsStore } = require('../src/core/memory/fs-store');
    const { createEpisodicStore } = require('../src/core/memory/episodic');

    const bus = fakeBus();
    const fsStore = createFsStore(() => dir, { bus: bus });
    const episodic = createEpisodicStore({ fs: fsStore, config: { EPISODIC_RETENTION_DAYS: 30 }, bus: bus, logger: null });

    episodic.write({ id: 'ep-before-1', summary: 'chaos memory test alpha' });
    episodic.write({ id: 'ep-before-2', summary: 'chaos memory test beta' });

    // Malformed line, injected mid-file exactly like a torn/partial write.
    fs.appendFileSync(todayFile(dir), '{"id":"ep-corrupt", "summary": "truncated mid-lin\n');

    episodic.write({ id: 'ep-after-1', summary: 'chaos memory test gamma' });
    episodic.write({ id: 'ep-after-2', summary: 'chaos memory test delta' });

    const hits = episodic.recall('chaos memory test', { windowDays: 1, limit: 20 });
    assert.equal(hits.length, 4, 'all 4 valid entries must be recallable despite the corrupt line');
    const ids = hits.map((h) => h.ref).sort();
    assert.deepEqual(ids, ['ep-after-1', 'ep-after-2', 'ep-before-1', 'ep-before-2']);

    const tail = episodic.tail(10);
    assert.ok(tail.every((e) => e && e.id !== 'ep-corrupt'), 'tail() must never surface the corrupt line');
    assert.equal(tail.length, 4, 'tail() must return exactly the 4 valid entries, corrupt line excluded from the count');

    const anomalies = bus._emitted().filter((e) => e.type === 'health.anomaly' && e.payload.kind === 'corrupt-line');
    assert.ok(anomalies.length >= 1, "fs-store must emit health.anomaly{kind:'corrupt-line'} on the skipped line");
  });

  it('checkpoint-restore still works after episodic corruption (separate files, no cross-contamination)', async () => {
    const { createFsStore } = require('../src/core/memory/fs-store');
    const { createEpisodicStore } = require('../src/core/memory/episodic');
    const { createCheckpointStore } = require('../src/core/memory/checkpoints');
    const { createWorkingMemory } = require('../src/core/memory/working');

    const bus = fakeBus();
    const fsStore = createFsStore(() => dir, { bus: bus });
    const episodic = createEpisodicStore({ fs: fsStore, config: { EPISODIC_RETENTION_DAYS: 30 }, bus: bus, logger: null });
    const checkpoints = createCheckpointStore({ fs: fsStore, config: {}, bus: bus, logger: null });

    episodic.write({ id: 'ep-1', tick: 4, summary: 'pre-corruption' });
    fs.appendFileSync(todayFile(dir), 'not even close to json\n');
    episodic.write({ id: 'ep-2', tick: 5, summary: 'post-corruption' });

    const saveResult = checkpoints.save({ tick: 5, activeGoalId: 'goal-x', contextKeys: ['a'], lastTickAt: Date.now() });
    assert.equal(saveResult.ok, true, 'checkpoint save must succeed independent of episodic corruption');

    const loaded = checkpoints.load();
    assert.ok(loaded, 'checkpoint must be loadable');
    assert.equal(loaded.tick, 5);

    const working = createWorkingMemory({ fs: fsStore, config: {}, bus: bus, logger: null, episodic: episodic });
    await working.init(); // rebuilds from episodic.tail() — must not throw on the corrupt line
    assert.equal(working.tick, 5, 'WorkingMemory rebuild must reach the latest valid tick despite the corrupt line');
  });
});
```

### `mythos/test/chaos-concurrent-tick.test.js`

```js
'use strict';

// CHAOS DRILL 5 — Concurrent-tick.
// Calls cortex.tickOnce() twice without awaiting the first, and proves the
// reentrancy guard (_inFlight) makes the second call a true no-op while the first
// completes normally start-to-finish.
//
// This is ALSO the mandatory real-instance cortex<->goals integration test required
// by lesson #4 / Risk R9: it wires the REAL goals module (not a fake) so that if a
// future change reintroduces D-38 (stripping rankedSalience before arbitrate()), this
// test catches it — the fake-goals tests in cortex-goals.test.js structurally cannot.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fakeBus() {
  const { createBus } = require('../src/core/bus');
  return createBus({ historySize: 200 });
}

function stubLeash() { return { check: function() { return { allow: true, requireConfirm: false, tier: 0 }; } }; }

describe('chaos drill: concurrent-tick', () => {
  it('two overlapping tickOnce() calls: second no-ops, first completes normally, real goals.arbitrate sees rankedSalience', async () => {
    const { createCortex } = require('../src/core/cortex');
    const { createGoalSystem } = require('../src/core/goals');

    const bus = fakeBus();
    const fs = { writeJSON: function() {}, ensureDir: function() {}, listFiles: function() { return []; }, removeFile: function() {} };
    const config = { MYTHOS_TICK_MS: 60000, MAX_ACTIVE_GOALS: 5 }; // long interval — only manual tickOnce() calls fire

    // REAL goals module — the exact seam D-38 broke.
    const goals = createGoalSystem({ fs: fs, config: config, bus: bus, memory: null, brain: null });
    const goal = goals.create({ title: 'Chaos concurrent target', drive: 'user-service', status: 'active' });
    // Pre-populate a pending plan step so plan() resolves without a real Brain call.
    goals.update(goal.id, { plan: [{ tool: 'noop_tool', args: {}, status: 'pending' }] });

    // Spy on the REAL arbitrate to capture what cortex actually hands it.
    const arbitrateCalls = [];
    const realArbitrate = goals.arbitrate.bind(goals);
    goals.arbitrate = function(perceptions, working) {
      arbitrateCalls.push(perceptions);
      return realArbitrate(perceptions, working);
    };

    let drainCallCount = 0;
    let invokeCallCount = 0;
    const memory = {
      working: {
        tick: 0,
        activeGoalId: null,
        spendThisTick: 0,
        drainPerceptions: function() {
          drainCallCount++;
          // One high-salience perception so orient() produces a ranked entry.
          return [{ summary: 'chaos concurrent perception', salience: 0.8, channel: 'test' }];
        },
        resetTickState: function() { this.spendThisTick = 0; },
        pushPerception: function() {},
        addSpend: function() {}
      },
      episodic: { write: async function() { return { ref: 'ep-x', degraded: false }; } },
      consolidate: async function() {}
    };

    const effectors = {
      invoke: async function() {
        invokeCallCount++;
        await sleep(40); // widens the in-flight window so the second tickOnce() truly overlaps
        return { ok: true };
      },
      breakers: { allow: function() { return true; } }
    };

    const cortex = createCortex({ bus: bus, memory: memory, goals: goals, brain: null, leash: stubLeash(), effectors: effectors, config: config });
    cortex.start();

    const p1 = cortex.tickOnce();
    const p2 = cortex.tickOnce(); // fired before p1 resolves — must be a no-op
    await Promise.all([p1, p2]);

    assert.equal(drainCallCount, 1, 'OBSERVE must run exactly once — the second concurrent call must never reach it');
    assert.equal(memory.working.tick, 1, 'tick counter must increment exactly once');
    assert.equal(invokeCallCount, 1, 'the effector must be dispatched exactly once — no double-dispatch from the overlap');
    assert.equal(arbitrateCalls.length, 1, 'arbitrate must be called exactly once');

    // The D-38 regression check: arbitrate must receive objects carrying rankedSalience,
    // not bare perceptions stripped of it.
    const firstCallArg = arbitrateCalls[0];
    assert.ok(Array.isArray(firstCallArg) && firstCallArg.length > 0, 'arbitrate must receive a non-empty array');
    assert.ok(
      firstCallArg.every((p) => typeof p.rankedSalience === 'number'),
      'every perception handed to goals.arbitrate() must carry a numeric rankedSalience field (D-38 regression)'
    );

    cortex.stop();
  });
});
```

### `mythos/test/chaos-restart-mid-action.test.js`

```js
'use strict';

// CHAOS DRILL 6 — Restart-mid-action.
// Starts a build-runner job, "crashes" (drops the in-memory instance without a
// graceful shutdown), then re-inits a FRESH build-runner + goals instance pointed at
// the SAME vault directory. Asserts: the previously-running job flips to 'failed',
// the goal tied to it flips to 'paused' with reason 'crash-recovery', and the audit
// trail stays consistent — no permanently-orphaned 'confirm' entries.
//
// CROSS-PHASE FIX (consistency pass, P7 vs P10): P7's real build-runner.js
// enqueue() is exactly {kind, prompt, run} — no cardId, no goalId (P7 wins per
// its own Anti-Drift Checklist). build-runner's persisted job record carries no
// goal linkage either. That means job<->goal association is NOT build-runner's
// job — it belongs to whichever Phase 7 effector wrapper calls enqueue() on a
// goal's behalf (e.g. agent-actions.js), which must persist that mapping itself,
// separately from build-runner's own jobs.json — the same pattern NOVA's
// agent-actions.js already uses (goal linkage lives at the caller, not the
// orchestrator). This drill simulates that persisted side-mapping directly
// (`Pipeline/job-goal-map.json`) rather than assuming build-runner tracks it.
//
// The recovery composition below (recoveredJobs -> resolve goalId via the side
// map -> goals.update(...) -> expire pending confirms) MUST match main.js's real
// 'recovery' boot step verbatim — see Spec Ambiguities Resolved #7 and the
// Anti-Drift Checklist. It is written here against real fs-store/goals/
// audit-writer/build-runner instances, not fakes.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

function tempDir() {
  const dir = path.join(os.tmpdir(), 'mythos-chaos-restart-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  ['Goals', 'Audit', 'Pipeline'].forEach((d) => fs.mkdirSync(path.join(dir, d), { recursive: true }));
  return dir;
}

function fakeBus() {
  const { createBus } = require('../src/core/bus');
  return createBus({ historySize: 200 });
}

// job-goal-map.json — the persisted side-mapping a real Phase 7 effector (e.g.
// agent-actions.js) is responsible for maintaining, since build-runner.js's own
// job schema carries no goal linkage. { [jobId]: goalId }
function readJobGoalMap(fsStore) {
  return fsStore.readJSON('Pipeline/job-goal-map.json', {});
}
function writeJobGoalMap(fsStore, map) {
  fsStore.writeJSON('Pipeline/job-goal-map.json', map);
}

// Runs the composition main.js's 'recovery' boot step is required to run.
function runRecovery(recoveredJobs, jobGoalMap, goals, auditWriter) {
  for (const rec of recoveredJobs) {
    const goalId = jobGoalMap[rec.id];
    if (!goalId) continue;
    goals.update(goalId, { status: 'paused', reason: 'crash-recovery' });
    const pending = auditWriter.query({ goalId: goalId, decision: 'confirm' });
    for (const entry of pending) {
      const resolved = auditWriter.query({ goalId: goalId, tool: entry.tool }).some(
        (e) => e.decision === 'allow' || e.decision === 'deny' || e.decision === 'expired'
      );
      if (!resolved) {
        auditWriter.write({ tool: entry.tool, goalId: goalId, tier: entry.tier, decision: 'expired' });
      }
    }
  }
}

describe('chaos drill: restart-mid-action', () => {
  let dir;
  beforeEach(() => { dir = tempDir(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it('crash mid-dispatch: job->failed, goal->paused(crash-recovery), no orphaned confirm entries', async () => {
    const { createFsStore } = require('../src/core/memory/fs-store');
    const { createGoalSystem } = require('../src/core/goals');
    const { createAuditWriter } = require('../src/core/memory/audit-writer');
    const { createBuildRunner } = require('../src/core/effectors/build-runner');

    // -- Pre-crash process --
    const bus1 = fakeBus();
    const fs1 = createFsStore(() => dir, { bus: bus1 });
    const goals1 = createGoalSystem({ fs: fs1, config: {}, bus: bus1, memory: null, brain: null });
    const audit1 = createAuditWriter({ fs: fs1, config: {}, bus: bus1, logger: null });
    await audit1.init();

    const goal = goals1.create({ title: 'Crash-mid-dispatch target', drive: 'user-service', status: 'active' });

    // A tier-4 confirm that never got a human reply before the crash.
    audit1.write({ tool: 'kill_session', goalId: goal.id, tier: 4, decision: 'confirm' });

    const buildRunner1 = createBuildRunner({ config: {}, brain: null, bus: bus1, vault: fs1 });
    await buildRunner1.init();
    // P7's real enqueue() is exactly {kind, prompt, run} — no cardId/goalId.
    const job = buildRunner1.enqueue({
      kind: 'pipeline',
      prompt: 'do something long-running',
      run: async () => { await new Promise(() => {}); } // never resolves — simulates a hung dispatch
    });
    assert.equal(job.status, 'queued', 'enqueue() must always return a job in the queued state');

    // The goal<->job association is persisted OUTSIDE build-runner, by the
    // effector layer that dispatched this job on the goal's behalf — simulating
    // what agent-actions.js (Phase 7) is responsible for doing in real code.
    writeJobGoalMap(fs1, { [job.id]: goal.id });

    // -- CRASH: drop all references without any graceful shutdown --
    // (no buildRunner1.stop(), no goals1 flush, no audit1 flush — simulates SIGKILL)

    // -- Fresh process, same vault --
    const bus2 = fakeBus();
    const fs2 = createFsStore(() => dir, { bus: bus2 });
    const goals2 = createGoalSystem({ fs: fs2, config: {}, bus: bus2, memory: null, brain: null });
    await goals2.init();
    const audit2 = createAuditWriter({ fs: fs2, config: {}, bus: bus2, logger: null });
    await audit2.init();
    const buildRunner2 = createBuildRunner({ config: {}, brain: null, bus: bus2, vault: fs2 });
    const initResult = await buildRunner2.init();

    assert.ok(Array.isArray(initResult.recoveredJobs) && initResult.recoveredJobs.length >= 1,
      'a fresh build-runner instance must report every job it force-failed on this boot');

    const recovered = buildRunner2.getJob(job.id);
    assert.ok(recovered, 'the crashed job must still be findable after restart');
    assert.equal(recovered.status, 'failed', 'a job caught running/queued at crash time must flip to failed — never fake-resumed');

    // build-runner's own record carries no goalId (P7's real schema) — the
    // recovery step resolves it from the persisted side-map instead.
    const jobGoalMap = readJobGoalMap(fs2);
    assert.equal(jobGoalMap[job.id], goal.id, 'the persisted job-goal-map must survive the crash and still resolve this job to its goal');

    // Apply the recovery composition (must match main.js's real 'recovery' step).
    runRecovery(initResult.recoveredJobs, jobGoalMap, goals2, audit2);

    const refreshedGoal = goals2.get(goal.id);
    assert.equal(refreshedGoal.status, 'paused', 'the goal tied to the crashed job must be paused');
    assert.equal(refreshedGoal.reason, 'crash-recovery', "pause reason must be the exact string 'crash-recovery'");

    // Audit consistency: no 'confirm' entry survives without a resolution.
    const allEntries = audit2.query({ goalId: goal.id });
    const confirms = allEntries.filter((e) => e.decision === 'confirm');
    const resolutions = allEntries.filter((e) => e.decision === 'allow' || e.decision === 'deny' || e.decision === 'expired');
    assert.ok(confirms.length >= 1, 'sanity: the pre-crash confirm entry must actually be present');
    assert.ok(resolutions.length >= confirms.length,
      "every 'confirm' audit entry must have a matching resolution after crash recovery — no orphans");
  });
});
```

## Integration Points

| Direction | Signature (exact, current-or-fixed) | Source |
|---|---|---|
| Drill calls FROM `memory/fs-store.js` | `createFsStore(vaultRootFn, { bus } = {})` → `{ appendLine, readLines, readDirLines, writeText, writeJSON, ... }` | `mythos/src/core/memory/fs-store.js` (fixed per Ambiguity #1) |
| Drill calls FROM `memory/episodic.js` | `write(record) -> {ref, degraded}`; `recall(query, opts) -> RecallHit[]`; `tail(n) -> object[]` | `mythos/src/core/memory/episodic.js:59,89,149` |
| Drill calls FROM `memory/checkpoints.js` | `save(snapshot) -> {ok, degraded?}`; `load() -> {..., isCrashRecovery}` | `mythos/src/core/memory/checkpoints.js:6,27` |
| Drill calls FROM `memory/working.js` | `createWorkingMemory({fs,config,bus,logger,episodic}) -> {init, tick, activeGoalId, ...}` | `mythos/src/core/memory/working.js:3` |
| Drill calls FROM `brain/index.js` | `createBrain({config,bus}).think({lane,messages,schemaHint,budget,signal,source}) -> {content,parsed,provider,model,offline,lane}`, never throws (catches `chainExhausted`/`AbortError`) | `mythos/src/core/brain/index.js:39,95-103` |
| Drill calls FROM `brain/chain.js` | `complete({messages,kind,brain,signal,onAttempt}) -> {content,provider,model}`; throws only with `err.chainExhausted=true`; `_internal.cooldowns` Map, `_internal._resetCooldowns()` | `mythos/src/core/brain/chain.js:68,105-109` |
| Drill calls FROM `cortex/index.js` | `createCortex({bus,memory,goals,brain,leash,effectors,config}) -> {start,stop,tickOnce,lastTickAt,generation}`; **fixed**: throws at construction if `leash`/`effectors` missing (D-39) | `mythos/src/core/cortex/index.js:7` |
| Drill calls FROM `goals/index.js` | `createGoalSystem({fs,config,bus,memory,brain}).arbitrate(perceptions, working) -> goal\|null`; `update(id,patch)`; `debitBudget(id,usage)` | `mythos/src/core/goals/index.js:13,118,235` |
| Drill calls INTO `immune/watchdog.js` (P6) | `createWatchdog({getCortex,bus,config}) -> {start,stop}` — CROSS-PHASE FIX: detection-only, no `cortex`/`goals` params — never restarts cortex or touches goals itself; the real restart+pause path is `health.anomaly` → `diagnostician` → `healer`'s `'stall-restart'` playbook | P6's real shipped contract |
| Drill calls INTO `immune/breakers.js` (P6) | `createBreaker({name,bus,config,failThreshold?,windowMs?,resetMs?,maxResetMs?}) -> {state,allow,recordSuccess,recordFailure}` — CROSS-PHASE FIX: `config` is a required param (breaker reads `config.BREAKER_*` defaults), not just `{name,bus,...}` | P6's real shipped contract |
| Drill calls INTO `effectors/build-runner.js` (P7) | `createBuildRunner({config,brain,bus,vault}).init() -> {recoveredJobs:[{id,error}]}` (no `goalId` — build-runner's job schema carries none); `enqueue({kind,prompt,run}) -> job` (always returns `status:'queued'`, no `cardId`/`goalId` params) | P7's real shipped contract, mirrors `app/lib/orchestrator.js:33-45,64-85` minus the kanban-specific fields |
| Drill calls INTO a Phase-7 effector's persisted job-goal mapping | `Pipeline/job-goal-map.json`, `{ [jobId]: goalId }` — build-runner itself never writes this; whichever effector dispatches a job on a goal's behalf (e.g. `agent-actions.js`) must | this phase's simulated contract for a gap P7 doesn't cover — flag for Phase 7 to formalize |
| Drill calls INTO `main.js`'s `recovery` boot step | must run exactly the composition in `runRecovery()` above: `buildRunner.init().recoveredJobs` + the job-goal map → `goals.update(goalId,{status:'paused',reason:'crash-recovery'})` → expire orphaned `'confirm'` audit entries | §13 Boot Sequence, `fail:'degraded'` step named `'recovery'` |

## Anti-Drift Checklist

1. Every event-name string used in these tests is copied verbatim from the architecture doc or from already-shipped source: `'health.anomaly'`, `'brain-spend'`, `'tick'`, `'cortex-stall'` (as a `kind`, not a channel), `'corrupt-line'` (as a `kind`), `'cortex-restart'` / `'crash-recovery'` (as `reason` strings). Do not respell any of these when wiring P6/P7 to satisfy these tests.
2. `createFsStore`'s fixed signature (Ambiguity #1) is **additive** (`(vaultRootFn, {bus}={})`) — verify the Phase 4.5 fix does not break the existing single-arg call in `test/memory.test.js:57` or `memory/index.js:16`.
3. Do not "fix" `fs-store.js`'s write path as a prerequisite for Drill 3 — it already conforms (Ambiguity #2). Spending Phase-4.5 effort there is wasted; the actual gap is the corrupt-line *read* path (Drill 4).
4. `createWatchdog` and `createBreaker` must accept `goals`/`bus` respectively as **mandatory** constructor params per lesson #3 — throw at construction if missing, never guard with `if (goals && ...)` at call time the way `cortex/index.js`'s D-39 bug does today.
5. `effectors.breakers` (P7's Effector Hub) must expose `.allow(name)` as a callable, not a bare `Map` — `cortex/index.js:121`'s already-shipped code calls it that way literally; verify with `assert.equal(typeof hub.breakers.allow, 'function')` before wiring P7 into boot.
6. `build-runner.init()`'s `recoveredJobs` return value and `main.js`'s `recovery` boot step's actual body must be the SAME code path, not two independent implementations of "mark job failed, pause goal" — grep `main.js` for the literal string `'crash-recovery'` before merging P7/P8; if it's absent from `main.js`, Drill 6 is a false green exactly like D-38 was.
7. Do not let Drill 1's cooldown-vs-breaker naming mismatch (Ambiguity #6) leak into production code as a "fix" — `chain.js`'s single-fail cooldown is a deliberate, already-tested P2 behavior; do not rewrite it to consume `BREAKER_FAIL_THRESHOLD` as a side effect of making this drill's test file "feel more accurate."
8. All six test files construct real `bus`/`config`-shaped dependencies, never global state — no test reaches for `process.env` inside assertions (only inside `before()` setup, matching lesson #8).
9. Every temp-dir test (Drills 3, 4, 6) cleans up in `afterEach`/`afterAll` via `fs.rmSync(dir, {recursive:true,force:true})` — verify no leftover `mythos-chaos-*` directories accumulate in CI's temp folder across repeated runs.
10. Drill 5's fake `effectors.invoke` intentionally delays 40ms to create a genuine overlap window — do not "simplify" this away to a synchronous stub, or the test degenerates into asserting nothing (the two `tickOnce()` calls would never actually race).

## Test Plan

Maps to ROADMAP.md's implicit P10 gate (all 6 drills green) plus lesson #4's mandatory real-instance seam test:

| Gate criterion | Test file | Real-instance seam exercised |
|---|---|---|
| Breaker/cooldown opens, chain falls back, brain returns `{offline:true}`, never throws | `chaos-provider-killed.test.js` | real `chain.js` + real `registry.js` + real `providers/groq.js`/`ollama.js` against fake HTTP servers |
| Watchdog detects stall via `cortex.lastTickAt.value`, restarts cortex, pauses goal `'cortex-restart'` | `chaos-cortex-stalled.test.js` | real `cortex/index.js` + real `immune/watchdog.js` + real `goals/index.js` |
| Disk-full degrades honestly, anomaly fires, no crash | `chaos-disk-full.test.js` | real `fs-store.js` + real `episodic.js`/`checkpoints.js` |
| Corrupt line skipped, anomaly fires, surrounding data + checkpoint-restore survive | `chaos-memory-corrupt.test.js` | real `fs-store.js` + real `episodic.js` + real `checkpoints.js` + real `working.js` |
| Reentrancy guard blocks second `tickOnce()`, first completes; **D-38 regression** (rankedSalience reaches `arbitrate()`) | `chaos-concurrent-tick.test.js` | real `cortex/index.js` + real `goals/index.js` — this IS the mandated lesson-#4 test |
| Restart mid-dispatch: job→failed, goal→paused `'crash-recovery'`, audit has no orphaned confirms | `chaos-restart-mid-action.test.js` | real `fs-store.js` + real `goals/index.js` + real `audit-writer.js` + real `build-runner.js`, two independently-constructed instances against one vault dir |

The hardest test in this set is Drill 5's concurrency assertion (`chaos-concurrent-tick.test.js`, shown complete above) because it has to simultaneously prove two different things with one interleaving: the reentrancy no-op, and the real cross-module data shape (`rankedSalience`) surviving to `arbitrate()`. The second-hardest is Drill 6's two-instance-same-vault crash simulation (`chaos-restart-mid-action.test.js`, also shown complete above), because "crash" has to mean literally dropping references without calling any cleanup path — any `await buildRunner1.stop()` or similar would silently turn the drill into a graceful-shutdown test instead of a crash test.

### Risk Register Cross-Reference (R1–R9, ROADMAP.md)

| Risk | Mitigation (ROADMAP.md) | Drill(s) that prove it | Verdict |
|---|---|---|---|
| R1 — Idle-loop Brain cost | Idle-skip (P3) + spend events/cap (P2) | None | Not a failure-injection concern — already proven by P3's own gate ("idle tick → 0 Brain calls"). No gap; out of scope for chaos drills by nature. |
| R2 — Memory growth | Decay + archive (P1), consolidate cadence | None directly | **Gap.** No drill exercises `consolidate()`/decay-to-archive under real conditions at scale. Drill 4 touches episodic corruption, not growth/archive. Recommend a P1 regression test (`consolidate()` archives, doesn't `unlinkSync`, per D-18) rather than a 7th chaos drill — but flag this as unverified before trusting R2's mitigation. |
| R3 — Autonomy safety | Audit + spend cap + `MYTHOS_DRY_RUN` + tier gates | Drill 6 (audit consistency only) | **Partial gap.** Drill 6 proves audit trail survives a crash; no drill exercises `MYTHOS_DRY_RUN` or leash tier-gating under failure (e.g., does a tier-3 confirm survive a provider outage mid-check?). Recommend closing before P9 cutover. |
| R4 — Identity drift | Human-editable boundaries as tier ceiling | None | **Gap.** No drill touches `identity/index.js` or `boundaries.md` at all. Acceptable for P10 (identity isn't a failure-injection surface per se) but should get its own contract test in P8, not deferred indefinitely. |
| R5 — SPOF | Checkpoint every N ticks + restore (P6/P1) + drill (P10) | Drill 4 (checkpoint-restore after corruption) + Drill 6 (restart-mid-action) | **Well covered** — this is the risk P10 exists for, and it's the one two drills jointly exercise end-to-end. |
| R6 — Port conflict | `MYTHOS_PORT` 4478, separate vault root | None (N/A) | Already ✅ P0 — infra concern, not a runtime failure mode; no drill needed. |
| R7 — Stale copy | Git clone verified @ `a0433b5` | None (N/A) | Already ✅ Step 0 — not a runtime concern. |
| R8 — Event-name drift | Grep-based allowlist test against spec-derived event names | None | **Intentional gap.** This is a static/lint concern (compare emitted string literals against an allowlist), not a failure-injection concern — belongs in its own test (e.g. `test/event-name-conformance.test.js`), not a chaos drill. Flag as still open per ROADMAP ("⏳ P5+") — should land before P10's gate is trusted, since a silently-renamed event (like D-36/D-37 were) would make several of these drills pass for the wrong reason (e.g., a watchdog listening for a misspelled `health.anomaly` variant would never fire, and a drill using loose filters could still appear green). |
| R9 — Cross-module contract breaks invisible to per-module unit tests | Real-instance integration tests (Cortex→Goals, Cortex→Effectors) | Drill 5 (Cortex↔Goals, the exact D-38 seam) + Drill 6 (build-runner↔goals↔audit) | **Well covered** for the two seams named in ROADMAP.md. Not covered: Cortex→Effectors under real (non-stub) effectors, since Drills 2/5/6 all use stub `effectors` objects for isolation of the seam under test. Recommend one additional real-instance Cortex→EffectorHub test once P7 ships, distinct from these six drills. |

## Do NOT

- Do not modify `mythos/src/core/**` in this phase — it produces test files only. Where a drill depends on an unbuilt P6/P7 module (`immune/watchdog.js`, `immune/breakers.js`, `effectors/build-runner.js`), the test documents the exact required contract; it does not stub around the absence by inventing a parallel fake implementation that would let the drill pass without the real module ever existing.
- Do not "fix" `chain.js` to consume `BREAKER_FAIL_THRESHOLD` just to make Drill 1's naming feel tidier (Ambiguity #6) — that is unrequested scope creep on an already-shipped, already-tested P2 module.
- Do not spend P4.5 effort hardening `fs-store.js`'s write path for Drill 3 — it already conforms (Ambiguity #2); the real gap is the corrupt-line read path (D-16, Drill 4).
- Do not simulate the "crash" in Drill 6 by calling any stop/shutdown/flush method on the pre-crash instances — a graceful shutdown is a different test with a different (already-implicit) contract. The point of the drill is that nothing was flushed.
- Do not replace the busy-wait in Drill 2 with a `sleep()` — `sleep()` yields the event loop cooperatively and would let the cortex/watchdog timers keep firing normally, defeating the entire point of the drill (a real stall blocks everything, cooperative or not).
- Do not let any of these six tests assert against a fake bus that doesn't run the real `createBus()` middleware/history/subscribe pipeline — every test in this phase wraps the real `bus.emit` (as shown in each file's `fakeBus()` helper) rather than hand-rolling a bespoke event recorder, so a bug in the real bus's dispatch logic would still surface here.
- Do not treat a green Drill 5 or Drill 6 as proof that `main.js`'s actual boot sequence performs the same composition — per Anti-Drift item 6, verify the literal boot-step code, not just this test file, before declaring R9 closed for those seams.

---

## Cross-Phase Consistency Report

> Generated by an independent agent that reviewed all six drafts above for contradictions (event names, tier-ceiling precedence, directory layout, phantom references). The issues below were found and have each been fixed inline in the phase sections above (search for "CROSS-PHASE FIX") — this report is kept as a record of what was found and resolved, not as an outstanding TODO list.

P6 vs P9: Ambiguities Resolved #14 mandates sensor payload field `.salience`, never `.salienceHint` -> RESOLUTION: P9's server/index.js perception.* handler reads `p.salienceHint`; fix to `.salience` (P6/P7 win, matches real ooda.js consumer).

P5 vs P9: P5's confirm.js — "create(summary, action, connectionId)" vs P9 Integration Points requiring `leash.confirm.create(decision, leashResult) → confirmId` -> RESOLUTION: P9's contract must match P5's shipped 3-arg signature; P5 wins as the already-implemented, tested module.

P5 vs P9: P5's leash/index.js never bus.emit()s anything, only auditWriter.write(); P9 Ambiguities Resolved #3 requires leash to also emit `'audit.decision'` -> RESOLUTION: phantom event in P9's WS mapping table; P5 must add the bus.emit call, P9's requirement wins.

P5 vs P8: P5 Ambiguities Resolved #2 fixes createLeash to `{bus,config,identity,auditWriter,goals,effectors}` (6 required deps) vs P8's leash diff patches a stale 4-param baseline `{bus,config,identity,auditWriter}` -> RESOLUTION: P8's diff must rebase onto P5's real 6-param signature; P5 wins as originating module.

P6 vs P10: P6's watchdog.js ships `createWatchdog({getCortex,bus,config})`, detection-only, never touches goals or calls cortex.stop/start -> RESOLUTION: P10's chaos-cortex-stalled.test.js constructs `createWatchdog({cortex,bus,config,goals})` expecting watchdog itself to restart cortex and pause the goal with reason 'cortex-restart'; rewrite Drill 2 to match P6's getCortex/healer-restarts contract, P6 wins.

P7 vs P10: P7 Anti-Drift Checklist #5 mandates `build-runner.enqueue({kind,prompt,run})` with no cardId/goalId keys -> RESOLUTION: P10's chaos-restart-mid-action.test.js calls `enqueue({kind,cardId,goalId,prompt,run})` directly; drop those keys and thread association through the run closure per P7, P7 wins.

P7 vs P10: P7's build-runner.js exposes only `{enqueue,getJob,listJobs,queuePosition,onJobUpdate}`, no `init()` -> RESOLUTION: P10 assumes an async `init()` returning `{recoveredJobs}`; either P7 adds this contract or P10 rewrites Drill 6 against P7's synchronous constructor-time `loadPersisted()`; recommend P7 add it since P10's crash gate needs a discoverable recovered-job list.

P7 vs P9: P7's effectors/goals.js Full Code exposes only `{sync,writeBack,parseGoalsMd}`, never registered in the hub under a synthetic id -> RESOLUTION: P9's server/index.js and Integration Points require `effectors.get('goals-effector')` returning `listGoals/addGoal/toggleGoal/deleteGoal/stats`; P7 needs a REST-facing wrapper registered under 'goals-effector'/'kanban-effector'/'pipeline-effector', P9's contract wins as the concrete consumer.

P6 vs P10: P6's breakers.js ships `createBreaker({name,bus,config,failThreshold,windowMs,resetMs,maxResetMs})` reading numeric defaults from `config.BREAKER_*` -> RESOLUTION: P10 Ambiguities Resolved #3 assumes `createBreaker({name,bus,failThreshold=3,...})` with no `config` param; P10 must pass `config` per P6's real signature, P6 wins.

VERDICT: 9 inconsistencies found
