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
  (`ui_click`, `ui_type`, `click_at`, `send_key`, `focus_window`, and — since
  2026-08-06, on the operator's explicit approval — `browser_click`,
  `browser_type`, `browser_fill_form`) are keyed by `connectionId + ':' +
  tool`, not by tool alone — do not widen `SESSION_GRANTABLE` to
  outward-facing or destructive T3 tools (`gmail_send`, `delete_goal`,
  build/pipeline execution, etc.) without a safety review. The browser
  widening (BUG-119) was that review's outcome, not a bypass of it: an
  approval loop that re-prompts for every click trains the operator to accept
  without reading, which costs more safety than the grant does.
  `browser_evaluate` is deliberately excluded and is T4 — always confirm,
  never cached; the `accept()` wrapper only records a grant when
  `TIER_TABLE[tool] === 3`, so T4 is structurally ineligible.
- **Operator-present trust: `connectionId` is load-bearing for containment**
  (2026-08-06, operator decision). A curated list of local, reversible T3
  tools (`browser_click`/`browser_type`/`browser_fill_form`/
  `browser_select_option`/`browser_press_key`/`browser_upload_file`,
  `ui_click`/`ui_type`/`click_at`/`see_and_click`/`cua_click`,
  `close_window`) auto-allows with **no confirm at all** — but only when a
  real operator connection is driving. The audit reason is its own string,
  `operator-present-trusted`, so the path is visible in the Audit view rather
  than blending into `within-autonomous-max` or `session-granted`.

  The containment is the call-site table — `check()` receives a
  `connectionId` from exactly two places, both human-driven, and from nowhere
  else:

  | Call site | Context passed | Human present? |
  |---|---|---|
  | `voice/voice-agent.js:495` | `{ connectionId }` | yes |
  | `voice/live-tool-adapter.js:271` | `{ connectionId, goalId: null }` | yes |
  | `cortex/index.js:278` | `{ goalId }` | no — autonomous loop |
  | `engagements/executor.js:272`, `:422` | `{ goalId: record.goalId }` | no — LLM-authored stages |
  | `sensors/reminder-sensor.js:37` | `{ goalId }` | no — fires unattended |

  So **do not start passing `connectionId` from an unattended path** — that,
  not the list, is what would break this. `'system'` is excluded explicitly
  (`voice-agent.js` passes `connectionId || 'system'` into `confirm.create`,
  so the sentinel is real here).

  `NEVER_TRUSTABLE` is un-overridable: sending (`gmail_send`,
  `whatsapp_send`, `phone_*`), running/installing (`run_command`,
  `install_from_github`, `hermes_task`, `mcp_call_tool`, `security_scan`,
  the build/pipeline tools), deleting (`delete_file`, `delete_goal`,
  `delete_artifact`), `reminder_approve_action`, and `browser_evaluate`/
  `kill_session`. `TRUSTED_TOOLS` (env) can add T3 tools but cannot add
  anything on that set, anything not T3, or an unknown name — each rejection
  is emitted by name as `health.anomaly` `leash-trusted-tool-ignored` at
  construction. `TRUSTED_TOOLS_DISABLED=true` reverts to the pre-trust
  behaviour; `check()` reads it per call rather than caching it at
  construction, but the config object is frozen at boot, so an `.env` edit
  still needs a restart.

  **This is deliberately not a tier change and not a ceiling raise.**
  Re-tiering these to T2 would hand the same clicking/typing/window-closing
  to the autonomous loop, and BUGS.md records raising `AUTONOMOUS_MAX_TIER`
  globally as evaluated and rejected as a safety regression. Trust is checked
  after the goal grant and before the session grant, and *after* the
  credential scan, the `boundaries.md` deny and the `DRY_RUN` gate — all of
  which still run first and still win. `failClosedIfUnwritable` still applies:
  an unwritable audit at T3 denies, trusted or not.

  Consequence worth knowing: every tool in `SESSION_GRANTABLE` is now also
  trusted, so with trust ON the session-grant branch is unreachable. It is
  not dead code — it is what the kill switch degrades to (confirm once per
  tool per connection rather than every time), which is why
  `test/leash.test.js`'s BUG-012 block and `leash-grant-scope.test.js`'s
  BUG-119 block now run with `TRUSTED_TOOLS_DISABLED: true`.
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
