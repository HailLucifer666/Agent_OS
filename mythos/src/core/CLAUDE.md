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
  `install_from_github`, `dsh_task`, `mcp_call_tool`, `security_scan`,
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
- **Operator-present trust now also needs the operator's words (BUG-461,
  2026-09-24).** A Live call the leash allows as `operator-present-trusted` or
  `session-granted` then passes `voice/authority-gate.js`: it runs only when
  this turn's echo-accepted spoken words, or HUD-typed words, ask for it
  (`voice/operator-authority.js`). Otherwise MYTHOS asks one question, and a
  whole-utterance yes runs exactly the stored call through the confirm
  registry's spoken entries (`markPresented`, `acceptSpoken`). The gate only
  narrows: it never approves what the leash did not allow, and a spoken yes
  never approves a click-only confirm. Measured cause: at 09-24 15:11:24 a
  click ran in a turn that said "I didn't say anything… it's the background
  noise". Do not dispatch a trusted call around `authorityGate.hold()`.
  Since B2c (2026-09-26, operator decision): a spoken command of four words or
  fewer runs only when it starts with its verb and names THIS call's key or
  typed words ("refresh the page" for F5); a click or a window close still
  asks. A yes may go on ("Yes, refresh the web page") only when the rest names
  the same key or words; a contrast, a later, another target or a question
  makes it no yes.
- **`remember` needs a consent token (BUG-464, 2026-09-24).** It writes
  `user-facts` only with a token from `leash/consent.js` for exactly its
  arguments. The token is minted by the authority gate and carried in the
  dispatch context; `dispatch-action.js` and `server/index.js`'s wrapper both
  forward `consent`, and model arguments never can. So the autonomous loop,
  the engagement executor and any new caller cannot write permanent memory
  through the tool. Only `authority-gate.js` mints (test-pinned). The
  background summariser in `memory/index.js` (step 3b) writes `user-facts`
  only when `MEMORY_AUTO_USER_FACTS=true`: off by default since 2026-09-25,
  on the operator's decision (BUG-463). Do not turn it back on by default.

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

## Refusals (any guard that blocks a tool call)

A guard that refuses a call has not finished its job by refusing. Three times
now a refusal here has left the model with no way forward, and each time the
user got LESS than before the guard existed:

- **BUG-099** — a wrong-browser refusal said "call `browser_launch_debug`". That
  tool was not in the Live allowlist, so the spoken path could not call it.
- **BUG-107** — the same refusal's other remedy, `browser_switch`, was withheld
  too. `live-tools.js` records it as "the same 'a hint naming an unreachable
  tool is not a remedy' gap BUG-099 fixed".
- **BUG-435** — 2026-09-10 18:21Z. The named-browser refusal pointed at
  `browser_launch_debug`, which had already run and connected twenty seconds
  earlier. Reachable, but already satisfied. The model retried the refused call
  four times and no page opened at all — worse than the two windows the guard
  was written to prevent.

So, before a refusal ships:

1. **Name the next tool in the MESSAGE, not only in a structured field.** The
   message is the channel the model reads. BUG-435 put its tools in `remedy`
   and an invented `then` field; `then` is read by nothing in this repo and the
   model ignored both. A structured `remedy()` beside the prose is right — the
   prose alone is not, and the structure alone is not either.
2. **The tool you name must be reachable AND not already done.** Reachability is
   automated in `test/refusal-is-actionable.test.js`. "Already done" depends on
   runtime state and cannot be: derive the suggestion from that state, and pin
   it with a test that puts the system in the state where the obvious advice is
   already satisfied.
3. **Ship a test that reaches the GOAL, not one that observes the refusal.**
   Drive the refusal's own remedy through to the thing the operator asked for,
   and assert the arguments arrived — a sequence that reaches `browser_navigate`
   with no url is not a page. Before 2026-09-11 this whole suite contained two
   tests that went past a refusal at all, and neither reached a goal.
4. **Check what the tool DESCRIPTIONS say.** A guard that refuses what a tool's
   own description instructs is fighting the prompt, and the prompt wins:
   BUG-435's root cause was `open_web` still saying "if they NAMED a browser,
   pass browserName". The mismatch was even filed as a follow-up before the
   incident. A follow-up that contradicts the change it follows is not a
   follow-up; it is an unfinished fix.
5. **For anything on the voice or browser path, record a `golden-path.js` line
   before and after.** `mythos/scripts/golden-path.js` drives the real workflow
   and grades on tool evidence plus the media oracle. It exists, and on
   2026-09-10 seven changes shipped to this path without it being run once.
