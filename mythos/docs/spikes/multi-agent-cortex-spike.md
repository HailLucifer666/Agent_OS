# Spike: does MYTHOS need a second OODA loop (multi-agent Cortex)?

Written as part of Item 10 (MCP server). No code changes here — this is a
go/no-go recommendation for Phase 2, grounded in reading `cortex/index.js`,
`goals/index.js`, and `immune/healer.js` as they exist today.

## What a second OODA loop would need to justify

Cortex's `tickOnce()` is a single reentrancy-guarded loop (`tickOnce._inFlight`,
`cortex/index.js:38-39`) that observes the bus, arbitrates one active goal at a
time (`goals.arbitrate()`), plans one decision, and acts. "Multi-agent" in the
sense the audit item is asking about would mean running a second, independent
instance of this loop concurrently — not the brain-lane specialization MYTHOS
already has.

Brain-lane specialization already covers the common case: `brain/lanes.default.js`
routes different *kinds* of thinking (simple chat, vision, build, voice) to
different model chains, all still funneled through the one Cortex tick. A
second lane is not a second agent — it's a different prompt/model choice inside
the same single-threaded decide→act sequence. The question worth asking is
narrower: what workload *can't* be expressed as "the existing loop picks a
different goal or a different lane on this tick"?

Two candidate use cases were considered:

1. **Long-running background research alongside an active interactive goal.**
   Today, if the operator is mid-conversation (an active engagement or a
   high-salience goal), `goals.arbitrate()`'s sticky bonus (`goals/index.js:172`,
   `+0.15` for the current goal) keeps Cortex on that goal every tick until it
   finishes or is paused. A genuinely parallel "keep researching in the
   background while I talk to the operator" use case is real, but it does not
   require a second *cognitive* loop — it requires either (a) a goal that
   itself dispatches an async, long-running effector (already possible: any
   effector's `invoke()` can kick off a job and return immediately, the way
   `build-runner.js` and `orchestrator.js` already do for Forge multi-file
   builds and mission fan-out) or (b) raising `MAX_ACTIVE_GOALS` and letting
   the existing single loop interleave across goals tick-by-tick. Both are
   cheaper and already-proven patterns in this codebase.

2. **True parallelism for latency** — e.g. two goals whose planning brain calls
   would otherwise serialize behind one Cortex tick. This is real, but the
   fan-out already exists at the *effector* layer (`orchestrator.js`'s parallel
   builder agents, `MYTHOS_BUILD_CONCURRENCY`), not at the OODA layer. Adding a
   second full OODA loop to solve a latency problem that a bounded worker pool
   already solves is solving it at the wrong layer.

**Conclusion on use cases:** no observed requirement needs two *decision-making*
loops. Everything that looks like "we need a second agent" decomposes into
either goal interleaving (already supported) or effector-level concurrency
(already supported, e.g. Forge/orchestrator). A second Cortex loop would add a
new failure mode (see below) to solve a problem the architecture already
solves elsewhere.

## Concurrency safety: what breaks under two concurrent Cortex loops

Reading `cortex/index.js`, `goals/index.js`, and `immune/healer.js` end to end,
every one of these is a *shared, mutable, single-instance* resource with no
locking, because the codebase's entire concurrency model is "there is exactly
one Cortex tick in flight at a time" (`tickOnce._inFlight`, generation counters
in `start()`/`stop()`):

- **Breakers** (`effectors/hub.js`'s `createBreakerRegistry`, backed by
  `immune/breakers.js`). One breaker instance per effector *name*, owned by the
  hub, shared by whoever calls `hub.invoke()`. If two Cortex loops both invoke
  the same tool concurrently, `allow()`/`recordSuccess()`/`recordFailure()`
  read-modify-write `failCount`/`state` with no atomicity guarantee beyond
  "one synchronous statement." Node's single-threadedness prevents a torn
  write *within* one statement, but two loops' `invoke()` calls interleave
  across `await effector.invoke(...)` — loop A's success and loop B's failure
  for the same tool in the same window can flip `state` in an order neither
  loop individually expects, and the HALF_OPEN "allow exactly one probe"
  invariant (`breakers.js:43-45`) breaks: two concurrent tick loops calling
  `allow()` back-to-back before either records an outcome would both see
  `HALF_OPEN` and both count as "the one probe" (`halfOpenAttempts++` isn't
  guarded against a second caller landing between the check and the recorded
  result of the first).

- **`debitBudget`** (`goals/index.js:306-323`). Straight `goal.spent.tokens +=`
  / `goal.spent.actions +=` on a shared in-memory goal object, then an async
  `saveGoal()` disk write. This is a classic check-then-act hazard once a
  second loop is added: both loops can call `goals.plan()` for the *same*
  goal before either has debited, each independently observing budget
  headroom that only exists once — the goal can overspend past
  `budget.tokens`/`budget.actions` by up to one extra action's worth per
  loop, and the auto-pause-on-exhaustion branch (line 314) can fire twice,
  emitting `health.anomaly kind:'budget-exhausted'` twice for one real
  exhaustion event. `saveGoal()`'s file write is not queued/locked either —
  two concurrent writes to the same `Goals/<id>.json` race on the OS, and
  whichever write lands last silently discards the other's `spent` delta.

- **`immune/healer.js`'s module-level state.** `degradedLanes` and
  `suppressedTools` (`healer.js:99,105`) are plain module-scope objects, not
  per-Cortex-instance state — that's correct for *one* Cortex (a lane
  degradation or tool suppression should be process-wide), but it means a
  second Cortex loop inherits the first loop's suppressions/degradations
  whether or not that's the right policy for its own goal stream. More
  concretely, `restart-cortex` (`healer.js:120-135`) calls
  `getCortex().stop(); getCortex().start()` through a single `getCortex()`
  thunk closed over one `let cortex` binding in `main.js` — there is no
  `getCortex(loopId)`. A stall diagnosed against loop A would restart *the*
  cortex reference the healer holds, which is undefined behavior the moment
  "the cortex" stops being singular. The healer's entire design (one
  `getCortex`/`getGoals` thunk pair) assumes a singleton.

- **Audit writes** (`memory.audit.write()`, called from both `leash/index.js`'s
  `writeAudit()` and `dispatch-action.js`'s step 6). Each call appends one
  complete record, so interleaved writes from two loops don't corrupt
  individual records — but the audit trail's implicit ordering guarantee (an
  operator reading it top-to-bottom to reconstruct "what happened in what
  order") stops meaning "in Cortex tick order" once two independent tick
  loops interleave into it. Not a data-corruption bug, but a genuine
  observability regression: `traceId` is already `null` for every action
  (`leash/index.js:56`, "no real source yet"), so there is currently no way to
  even tell the two loops' entries apart after the fact.

**Summary:** every one of breakers, budgets, and the healer's remediation
actions is built as singleton, unlocked, shared mutable state. None of this
is a latent bug *today* because the invariant "exactly one Cortex tick is ever
in flight" holds by construction (the reentrancy guard is per-instance, and
`main.js` constructs exactly one `cortex`). A second concurrent loop would not
find a graceful degradation path — it would find silent double-counting
(budgets), a broken breaker state machine invariant (HALF_OPEN's "exactly one
probe"), and a healer that can only ever address one of the two loops by
construction.

## Go/No-Go Recommendation

**No-go for Phase 2**, as scoped. The use cases that motivate "multi-agent"
language are already served by goal interleaving (single loop, multiple
active goals, already supported up to `MAX_ACTIVE_GOALS`) and effector-level
worker concurrency (Forge/orchestrator's `MYTHOS_BUILD_CONCURRENCY`-bounded
parallel builders), neither of which needs a second decision loop. Meanwhile,
adding a second Cortex instance would require re-architecting three shared
subsystems (breakers, goal budgets, healer remediation) from singleton
assumptions to either per-loop-scoped state or genuine locking/queueing — a
nontrivial, cross-cutting change — to fix hazards that don't exist yet
specifically because there is only one loop.

If a future, concrete use case emerges that goal-interleaving genuinely cannot
express (not hypothesized here — none was found), the right next step is not
"add a second Cortex" but a narrower spike on that specific use case, because
the fix is likely cheaper at the goal or effector layer than at the OODA-loop
layer.
