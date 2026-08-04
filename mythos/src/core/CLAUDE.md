# mythos/src/core/ — repo rules for AI sessions

Scope: the runtime core — `bus/`, `leash/`, and the shared dispatch sequence
(`effectors/dispatch-action.js`). Root `CLAUDE.md` still applies here — this
file adds the invariants specific to this layer.

## Bus (`bus/index.js`)

- Dot-taxonomy: an event's channel is its first dot segment (e.g.
  `audit.decision` → channel `audit`). Subscribers match via `matchGlob`:
  exact type, `'*'` for everything, or a `'prefix.*'` wildcard.
- **Causal depth guard**: events carry a `depth`; publish refuses anything
  at or past `maxDepth` (default 32) and emits `health.anomaly` instead —
  this is what stops a handler-triggers-event-triggers-handler loop from
  spinning forever.
- **Storm guard**: a sliding window (default 1000ms / 400 events) coalesces
  non-critical event floods into a single `perception.coalesced` event.
  `health`, `lifecycle`, and `audit` channels are exempt — they must never be
  dropped even under storm conditions.
- `safeEmit` (used for the bus's own internal `health.anomaly`/etc. emits)
  bypasses the middleware chain and swallows handler errors — it exists so
  the bus can report on itself without risking a recursive failure.
- Handler exceptions are caught per-handler and reported as
  `health.anomaly` with `kind: 'handler-error'` — one bad subscriber cannot
  take down publish() for every other subscriber.

## Leash (`leash/index.js`)

- **Mandatory, not optional**: `createLeash` throws at construction if any
  of `bus`, `config`, `identity` (with `checkBoundary`/
  `getMaxAutonomousTier`), `auditWriter.write`, `goals.get`, or
  `effectors.get` is missing. It is the single checkpoint between Cortex's
  `decide()` and Effectors' `invoke()` — cortex/index.js's `act()` calls
  `leash.check()` unconditionally; there is no call-time path that skips it.
- **Unknown tool → T3 fail-safe**, resolved *before* the `DRY_RUN` and
  `maxTier` comparisons (both do `tier >= N`, and `undefined >= N` is always
  false in JS — resolving late let an unmapped/hallucinated tool name slip
  through to auto-allow whenever `AUTONOMOUS_MAX_TIER >= 3`).
- **Effective ceiling is most-restrictive-wins**: `maxTier =
  min(config.AUTONOMOUS_MAX_TIER, identity.getMaxAutonomousTier())`, and both
  are read live on every call, never cached — `boundaries.md` can only
  tighten the config ceiling, never loosen it.
- **Fail-closed on unwritable audit**: for tier ≥ 3, if the audit line
  itself couldn't be written, the action is denied regardless of what the
  rest of the logic decided (`failClosedIfUnwritable`). T0–T2 stay fail-open
  (reads/local writes don't need this).
- **T3 grants are per-tool, per-connection, never tier-wide**: a goal's
  `grants['3']` is a list of tool names, not a boolean — a legacy bare
  `true` grant is deliberately not honoured (it re-prompts and reports
  `goal-grant-legacy-unscoped` instead of silently trusting an
  un-auditable old grant). Session grants for repetitive local UI tools
  (`ui_click`, `ui_type`, `click_at`, `send_key`, `focus_window`) are keyed
  by `connectionId + ':' + tool`, not by tool alone — do not widen
  `SESSION_GRANTABLE` to outward-facing or destructive T3 tools
  (`gmail_send`, `delete_goal`, build/pipeline execution, etc.) without a
  safety review.
- Credential-pattern scanning runs before any T3/T4 effector, and the
  scanner's own output is always redacted in the audit reason — never the
  full secret.

## Dispatch (`effectors/dispatch-action.js`)

- **Single shared sequence** used by both the cortex autonomous loop and the
  server's voice/confirm-accept paths, specifically to prevent the two
  surfaces from drifting apart: breaker check → `effectors.invoke()` →
  episodic write → budget debit → skill/plan bookkeeping → `action.completed`
  event → audit write.
- **Evidence contract**: a world-changing effector can return `ok: true`
  without having proven the world actually changed, in which case it sets
  `unverified: true` plus a spoken-usable `reason`. This must never be
  flattened into plain `ok`/`fail` — that flattening is exactly how a UI-type
  action once got audited as delivered when the target app never received
  the text. Carry `unverified`/`reason` alongside `ok`, don't fold them into
  it.
- `reasonText()` exists because some effectors' failure shape is an object
  (`{error: m, ...extra}`), not a string — audit lines used to record the
  useless literal `"[object Object]"` before this normalization.
- Skill/plan bookkeeping (`skills.recordUse`, `goals.markPlanStepDone`) and
  episodic/audit writes are all best-effort and wrapped so a failure there
  can never mask or override the actual dispatch result.
