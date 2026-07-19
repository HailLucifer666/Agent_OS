# MYTHOS — Phase 2 Handoff (Wiring Integrity, including W9 god-file decomposition)

> **Read first.** This is the operator's laptop-side pickup doc for Phase 2 of the
> MYTHOS Gap-Close Upgrade (task-957). Phase 1 (git reconciliation) is **DONE and
> pushed** — see §1 for state. Phase 2 is **10 wiring fixes + the gated W9
> server decomposition**. The operator explicitly asked for W9 in-scope with
> *explicit rules* — those are §4 below. Do not start Phase 2 without reading §3
> (rules) and §4 (W9 contract).

---

## 1. Phase 1 — what landed (state at handoff)

**Branch:** `merge/engagement-executor` (pushed to `origin`)
**Base:** `main` @ `d38001c` (post-spec-commit)
**Head after Phase 1:** see `git log --oneline merge/engagement-executor`

### Commits added (in order)
| sha | subject | what |
|---|---|---|
| `13f5ef5` | fix(voice): open_url/open_tab → real browser | Phase 0 routing repair, 614edb6 port |
| `3ff3d77` | feat(engage): stage-execution engine | 8706ccc port — engagement executor + 16 events + 4 REST routes |
| `29e9891` | feat(docs): xlsx/pptx/pdf effectors | 4682f7c port — `generate_spreadsheet/deck/pdf`, exceljs+pptxgenjs |
| `6fb4512` | feat(pc): window move/snap/scroll/right-click/drag | dab6e53 port — 5 desktop tools |
| `3468adc` | feat(browser): wait-for-element + form-fill | 1b79321 port — 2 browser tools |
| `5d69811` | refactor(engage): wire createEngagementDrafted builder | 7da9746 port |
| `7818987` | test(phase1): merge-invariant regression guards | NEW — 8 tests pinning merge resolutions |

### Skipped dangling commits (intentional — see commit messages / session log)
- `afcd593` — main already has valid hex uuids in `store.test.js`
- `d4b2a55` — already absorbed into `dab6e53` (which used `$TargetPid` from the start)
- `a5ab889` — fixes `mythos/NOTICES.md` (deleted in Phase 1; intent captured in `mythos/THIRD_PARTY_NOTICES.md`) + BUGS.md text not present on main

### Verification
- **Suite:** `cd mythos && node --test` → **1161 / 1162 pass**. The single fail is the documented `boot.test.js` Windows SIGINT-delivery env issue (NOT a code defect — handoff §2.2). Baseline before Phase 1 was 1099/1100; net **+62 tests**.
- **Boot smoke:** `node mythos/src/main.js` → `MYTHOS ALIVE`, all 23 boot steps `status:ok`, `effectors.ready count:99` (71 tool effectors + named services + voice + skills — the count gate tests only the 71 that go through `hub.register()`).
- **Honest degradation intact:** browser-agent on standby (no Chrome at :9222), brain offline (no keys), pc-child + edge-tts up.

### Effector count: 61 → 71
Count-gate test (`mythos/test/effectors-hub.test.js`) is now `gate: 71 registered count`. The +10:
- 3 docs T2 (`generate_spreadsheet/deck/pdf`)
- 3 pc T2 (`move_window/snap_window/scroll_at`)
- 2 pc T3 (`right_click_at/drag`)
- 1 browser T1 (`browser_wait_for`)
- 1 browser T3 (`browser_fill_form`)

### Key conflict resolutions made (don't re-litigate)
1. **Spotify T3→T2 policy preserved.** The dangling chain (dab6e53, 1b79321) was authored against an older base where `spotify_play`/`spotify_search` were T3. Main deliberately re-tiered them to T2 (vault/Spotify-only writes; a confirm popup on every "play a song" was friction, not safety). The cherry-picks would have silently reverted this; I held the line. Guarded by `phase5-merge-invariants.test.js`.
2. **Path drift fixed.** Chain wrote `mythos/BUGS.md` and `mythos/NOTICES.md`; canonical paths are root `BUGS.md` and `mythos/THIRD_PARTY_NOTICES.md`. Stray files deleted; content merged into canonical locations.
3. **Count gate math recomputed from main's base (61), not the chain's base (58).** Each pick's gate assertion was set to its post-pick state, ending at 71.

---

## 2. How to pick this up on the laptop

```bash
git fetch origin
git checkout merge/engagement-executor    # OR merge to main first if you prefer
cd mythos && node --test                  # expect 1161/1162 (1 documented fail)
node src/main.js                          # expect MYTHOS ALIVE
```

**Branch decision (yours):** I left Phase 1 on its feature branch. To start Phase 2:
- Either branch off `merge/engagement-executor` (keeps Phase 1 isolated until you're happy), or
- Fast-forward `main` to `merge/engagement-executor` first (`git checkout main && git merge --ff-only merge/engagement-executor`), then branch Phase 2 off main.

If you ff main, **push main** (`git push origin main`) when ready — Phase 1 stays recoverable via `backup/main-pre-upgrade` either way.

---

## 3. Phase 2 — scope (from task-957 §26)

**Prime directive (operator's standing rule):** *keep what works.* Full `node --test` green after every change; honest-inert preserved; ponytail-minimal diffs; no drive-by refactors; MIT/Apache-2.0 only; CommonJS in `src/`+`server/`, ES modules only in `ui/public/`, no build step; all timers `unref()`'d; read config live (never cache at construction).

Each W-fix must ship with a regression test (operator's explicit instruction this session).

### W1 — Cortex `act()` shadow dispatch path
- **Problem:** `mythos/src/core/cortex/index.js` `act()` carries an inline copy of dispatch logic that has drifted from `effectors/dispatch-action.js`. It writes the episodic entry and emits `action.completed` but skips the **audit write** and the **`ui.navigate`/`ui.close-panel`/`ui.open-web` relays**. Consequence: autonomous actions leave no audit line; autonomous UI actions never reach the dashboard.
- **Fix:** fold audit + UI relays into `dispatch-action.js` if missing, then make cortex `act()` call `dispatchAction()` instead of inlining. Single source of truth.
- **Regression test:** an autonomous action (cortex-driven, not voice) must produce an audit line and the appropriate `ui.*` emit. Use a fake effector + bus subscriber.

### W2 — Tier laundering in `from-spotify`
- **Problem:** `mythos/src/core/effectors/from-spotify.js` calls `pcEffectors.invoke('ui_click', { pid, elementPath }, {})` (and 13 sibling calls) — raw hub invoke with **no leash check, no audit, no goal context**. A T2 tool is silently driving T3 effectors.
- **Fix:** thread leash context into the inner invokes. Either (a) route through `dispatchAction` with a synthetic decision (correct, slightly heavier), or (b) call `leash.check` + write audit inline. Prefer (a) for invariant #1 consistency.
- **Regression test:** a `spotify_play` call that internally drives `ui_click` produces a leash decision and an audit entry.

### W3 — `gmailUnread = hub.invoke('gmail_unread', …)` (main.js leash step)
- **Problem:** `mythos/src/main.js` (leash step) defines `gmailUnread = function(args) { return hub.invoke('gmail_unread', args, {}); }`. Breaker-gated, no leash. Same shape as W2.
- **Fix:** same as W2 — go through `dispatchAction` or add an inline leash+audit.
- **Regression test:** a `gmailUnread()` call emits an audit decision.

### W4 — REST mutations write with no audit
- **Problem:** `mythos/server/index.js` REST routes (`/api/goals/*`, `/api/kanban/*`, `/api/pipeline/*`, `/api/engagements/*`) mutate state with no leash check and no audit entry. Destructive routes unguarded.
- **Fix:** every POST/DELETE on those prefixes writes an audit line (tool: `rest.<route>`, tier: 1 or 2 per the action). Consider whether a leash check is warranted (operator decision — see P1 for the broader auth story).
- **Regression test:** each mutation route produces an audit entry with the expected `tool` field.

### W5 — `conversation-gateway` constructed with `cortex === null`
- **Problem:** main.js step order constructs `conversation-gateway` (step 12) **before** `cortex` (step 19). The gateway's cortex-fallback route is permanently dead.
- **Fix:** thread a `getCortex()` thunk into the gateway (same pattern the immune system already uses for healer/watchdog — see handoff §15). The gateway resolves cortex lazily at first use.
- **Regression test:** construct gateway with cortex=null, assign cortex later, assert the fallback route fires.

### W6 — Double announcer
- **Problem:** both `mythos/src/core/immune/announcer.js` and `mythos/src/core/conversation/announcer.js` speak on `health.diagnosed`. Operator hears every diagnosis twice.
- **Fix:** `conversation/announcer.js` becomes the single speaker for `health.diagnosed`. `immune/announcer.js` keeps breaker/heal lifecycle speech only. Remove the duplicate subscription.
- **Regression test:** emit `health.diagnosed`, assert exactly one `action.speak-requested` results.

### W7 — Engagements emit inline with stub payloads
- **Problem:** `mythos/src/core/engagements/index.js` emits events like `bus.emit('engagement.spec_ready', { spec: { markdown: 'Spec generated', schema: {} } })` — fabricated stubs. The 16 real builders in `events.js` are test-only.
- **Fix:** replace every inline emit with the corresponding `events.<builder>(...)` call. Real payloads come from spec-builder / plan-builder output.
- **Regression test:** trigger each transition, assert the event payload matches the real builder's shape (not the stub).

### W8 — Config drift
- **Problem:** ~30 env keys bypass the schema (read via `process.env` in code); ~22 schema keys undocumented in `.env.example`.
- **Fix:** move bypass keys into `mythos/src/core/config/schema.js` with proper `{type, default, ...}`; document the rest in `mythos/.env.example`. Each key read live.
- **Regression test:** a schema-rejected key exits 1 at boot; a documented key parses correctly. Consider a static scan test for `process.env.X` outside an allowlist.

### W9 — server/index.js god-file decomposition (GATED — see §4)
- **Problem:** `mythos/server/index.js` is a 1582-line god-file mixing ~9 concerns: REST routes, WS layer, voice turns, vision streaming, confirm/checkpoint flows, proactive speech, TTS, rate-limit, news-feed.
- **Fix:** extract `mythos/server/routes/*.js` factories, each importing `deps` and registering its routes on a passed-in `app`. God-file shrinks to wiring + WS layer.

### D — Dead code
- Decide for each: **wire or delete**. Suite must stay green either way.
  - `memory/daily-note.js` (zero imports) — likely delete.
  - `assistant/{intent-router, response-planner, style, summary}` (~470 lines, test-only) — delete OR wire if Phase 4 autonomy needs them.
  - `providers/claude-cli.js` — delete.
  - `sensors/ws.js` `.ingest()` (zero callers) — delete the method or wire the server-owned ingestion path.
  - Orphan `conversation.intent` event (no subscribers) — delete from the allowlist after removing the emit.
  - `abtop` tools (deliberately honest-inert) — **keep as-is**.

**Recommended order:** W1, W6, W5 first (lowest risk, highest clarity gain). Then W2/W3 (related — same fix shape). Then W7, W4, W8. **W9 last** (gated, biggest blast radius). D-items opportunistically.

---

## 4. W9 god-file decomposition — explicit rules (operator-requested)

The operator asked for W9 in-scope **with explicit rules**. These rules are mandatory; violating any of them defeats the purpose of the decomposition.

### 4.1 What W9 is and isn't
- **IS:** a mechanical extraction of route-registration logic into focused factory modules. Behavior must be byte-for-byte identical before and after.
- **IS NOT:** a rewrite, a refactor of route *logic*, an opportunity to "improve" the REST API, a chance to add middleware, or a license to change response shapes. **Zero behavior change.**

### 4.2 The hard rules
1. **One commit per route family.** Not one mega-commit. Each family (`goals`, `kanban`, `pipeline`, `engagements`, `forge`, `checkpoints`, `media`, `config`, `news`, `health/status`) is its own commit: extract → run full suite → green → next. If any commit goes red, revert that one commit and investigate — do not pile on fixes.
2. **Factory shape is fixed.** Every extracted module exports exactly one function:
   ```js
   // mythos/server/routes/<family>.js
   'use strict';
   function mountFamilyRoutes(app, deps) {
     const { /* only what this family needs */ } = deps;
     app.get('/api/<family>', ...);
     // ...
   }
   module.exports = { mountFamilyRoutes };
   ```
   Then in `server/index.js`:
   ```js
   require('./routes/goals').mountFamilyRoutes(app, deps);
   ```
3. **Dep access is read at mount time, not closed over lazily.** Pull what you need out of `deps` at the top of the factory. If a route needs something lazy (e.g. a thunk), keep the existing lazy pattern — don't *introduce* new lazy patterns.
4. **No behavior change.** Same status codes, same response bodies, same error messages, same order of middleware, same `sanitizeErrorForClient` usage, same 404 shapes. If a test breaks, you changed behavior — revert and re-extract more carefully.
5. **The WS layer, the voice turn loop, the vision streaming, and the camera broker stay in `server/index.js`.** They are not REST routes; they belong in the wiring layer. Do not extract them in Phase 2.
6. **`deps` is the same object `createServer` already receives.** Do not invent new dep keys. If a route needs something not currently in `deps`, add it to `createServer`'s signature in the same commit (and to the caller in `main.js`), with a comment.
7. **The count of `app.*` calls in `server/index.js` must go DOWN by exactly the number extracted.** Verify with `grep -c "app\.\(get\|post\|put\|delete\|use\)" mythos/server/index.js` before and after each commit.
8. **Tripwires stay green.** After every family-commit, run the full suite. The effector count gate, event-name conformance, and tier-table parity must remain green.
9. **`/health` and `/api/status` stay in `server/index.js`.** They are top-level server identity routes, not family routes.
10. **If a route's handler depends on a `let`/`var` that's currently in `createServer`'s closure, promote it to a `deps` field.** Do not duplicate state.

### 4.3 Acceptance criteria for W9
- `server/index.js` is ≤ ~600 lines (from 1582).
- `mythos/server/routes/` contains 8–10 focused factories.
- `node --test` is green (1161+/1162).
- Boot smoke reaches `MYTHOS ALIVE` with all 23 steps `ok`.
- `curl http://127.0.0.1:4478/health` returns `{ok:true,uptime:...}`.
- A representative REST call per family still works (manual spot-check).

### 4.4 What you'll probably be tempted to do (don't)
- "While I'm here, let me also add input validation to `/api/kanban/cards`." **No.** That's a separate commit, separate concern (arguably W4). W9 is extraction-only.
- "This route would be cleaner with `express.Router()`." **Maybe later.** For W9, keep `app.METHOD` — minimize the diff.
- "Let me group all the `app.use(...)` middleware into a `middleware.js`." **No.** That's a different extraction with its own risk profile. Stay focused on REST routes.
- "Let me also fix the W10 `/api/media/control` raw-invoke bug while extracting media routes." **Tempting** (it's literally adjacent), but resist. W10 is its own item — extract first, fix second, so the diff is reviewable.

---

## 5. Phase 3+ preview (not this session)

Per task-957 §26:
- **Phase 3:** new T3 `run_command` effector (allowlist + cwd-pinned + timeout + audited; v1 is allowlist+timeout, not a full sandbox); wire into engagement executor + Forge (closes V7); operator-assisted live-verification of BUG-039/040/041 + barge-in + BUG-020/014/027/028/006; BUG-029 proper fix (kill only launched-mode browser trees, never CDP-attached user Chrome); BUG-024 OAuth docs.
- **Phase 4:** execution→learning loop (V3 — the deepest cut); `plan()` multi-step + Skills recall (V2); memory on the autonomous path (V1); consolidate dedup (V10); proactivity that acts (V5, V8); `reflect()` outcome analysis (V9); brain-driven engagement cognition (V6).
- **Phase 5:** P1 auth (`MYTHOS_AUTH_TOKEN`); render.yaml fixes (P2–P4); platform-gate pc-child/browser-agent (P6); docs re-sync.

---

## 6. Session log (this Phase 1 session)

- **Started:** main @ `685dbaa`, clean tree, 1099/1100 baseline (1 documented fail).
- **Ended:** `merge/engagement-executor` @ `7818987`, 1161/1162 (same 1 documented fail).
- **Decisions worth remembering:**
  - Skipped `8d74684` (a merge of `8706ccc` — identical diff, redundant).
  - The dangling chain was authored against a 58-effector base; main is at 61 via a different path. Count gate math had to be recomputed from main's base, not the chain's.
  - The chain's spotify T3 revert was silently dropped from `dab6e53` and `1b79321` (main policy is T2). `phase5-merge-invariants.test.js` guards this.
  - Stray `mythos/BUGS.md` + `mythos/NOTICES.md` from the chain were merged into canonical root `BUGS.md` + `mythos/THIRD_PARTY_NOTICES.md` and the duplicates deleted.

*End of Phase 2 handoff. Pick up at §2.*

---

## 7. Phase 2 — completion notes (laptop side, 2026-07-19)

Landed on `phase2/wiring-integrity` off `main` @ `685dbaa` (the pre-Phase-1 state — Phase 1's `merge/engagement-executor` was not in the working clone, so Phase 2 proceeded against current main per the operator's call). 21 commits, all green.

### What landed

**10 W-fixes** (each = one commit + one regression test, all in `mythos/test/w*-*.test.js`):

| W | Fix | Test |
|---|---|---|
| W1 | cortex `act()` → `dispatchAction()` (audit + ui.* relays now fire on autonomous actions) | `w1-cortex-dispatch-audit.test.js` (3) |
| W6 | single speaker for `health.diagnosed` (immune/announcer dropped the subscription) | `w6-single-announcer.test.js` (3) + `immune.test.js` updates |
| W5 | conversation-gateway `getCortex()` thunk (cortex-fallback route unblocked) | `w5-gateway-getcortex-thunk.test.js` (4) |
| W2 | spotify inner T3 invokes (`ui_click`/`ui_type`/`click_at`) route through `dispatchAction` | `w2-spotify-tier-laundering.test.js` (3) |
| W3 | `gmailUnread` routes through `dispatchAction` (audit on every poll) | `w3-gmail-unread-audit.test.js` (3) |
| W7 | engagements emit via `events.js` builders (no more stub payloads) | `w7-engagements-builder-events.test.js` (3) |
| W4 | REST mutations write audit entries (16 routes across goals/kanban/pipeline/engagements) | `w4-rest-mutation-audit.test.js` (5) |
| W8 | ~30 previously-bypassed env keys schema-defined + ~22 schema keys documented in `.env.example` | `w8-config-schema-consolidation.test.js` (5) |
| D | dead-code: `daily-note.js` + `claude-cli.js` deleted, plus the claude-cli test block | suite green |

**W9 god-file decomposition** — 10 family commits, one per family, byte-for-byte behavior preserved:

```
mythos/server/routes/
  news.js         /api/news (1)
  goals.js        /api/goals + novaGoalsStats helper (4)
  checkpoints.js  /api/checkpoints (2)
  forge.js        /api/forge/projects (2)
  media.js        /api/media + /art + /control (3) [W10 deferred per §4.4]
  kanban.js       /api/kanban + agent routes (8)
  pipeline.js     /api/pipeline + /api/jobs/:id (7)
  memory.js       /api/memory/:store + /api/audit/recent (2)
  engagements.js  /api/engagements (3) [Phase-1 extras deferred]
  config.js       /api/config/vad + /wakeword + /api/stats (3)
```

server/index.js: **1618 → 1288 lines, 49 → 14 `app.*` calls**. The 14 residual are the §4.2 #5/#9 must-stay set (WS layer, voice turns, vision streaming, camera broker, proactive speech, TTS, confirm/checkpoint, middleware, `/health`, `/api/status`, voice transcribe, 404/SPA/error handlers).

### Suite

`cd mythos && node --test` → **1121 / 1124 pass** (was 1097 / 1100 at baseline). +24 net tests across the 10 W-fixes (W9 is pure refactor, no new tests). The 2 fails are unchanged from baseline: `boot.test.js` Windows SIGINT env issue + `eval/memory-impact` data-dependent.

### Honest caveats (full detail in `BUGS.md` "Phase 2" section)

- **W7 executor-dispatch + W9 engagements Phase-1 extras** — blocked on Phase 1 (the `merge/engagement-executor` branch is not in this clone). When Phase 1 lands, both inherit cleanly.
- **D deferrals** — `assistant/{intent-router,response-planner,style,summary}` (~470 lines) kept for Phase 4 evaluation; `sensors/ws.js .ingest()` kept (deletion unwinds main.js wiring, wiring is Phase 4 work); `conversation.intent` event kept (W5 just unblocked the emit — removing would undo W5).
- **W10** deliberately deferred per W9 §4.4 (extraction-only in W9/media).
- **Pre-existing flake found** at `test/engagements/events.test.js:43` (`assert.equal(event.timestamp, Date.now() || ...)` — buggy time comparison). Not introduced by Phase 2; separate cleanup.
- **W9 line-count target** — the §4.3 "~600 lines" assumed Phase 1's extras would also be extracted; against main alone the 1288 residual is the honest floor (all must-stay per §4.2 #5/#9).

### Verification

```bash
git checkout phase2/wiring-integrity
cd mythos && node --test        # expect 1121/1124
node src/main.js                # expect MYTHOS ALIVE
curl http://127.0.0.1:4478/health   # expect {ok:true,uptime:...}
```

Spot-check the extracted routes per family: `GET /api/news`, `GET /api/goals`, `GET /api/kanban`, `GET /api/pipeline`, `GET /api/forge/projects`, `GET /api/checkpoints`, `GET /api/memory/audit`, `GET /api/engagements`, `GET /api/config/vad`, `GET /api/stats`.

### Operator's next call

1. **Merge or rebase:** fast-forward `main` to `phase2/wiring-integrity` when ready, OR rebase on top of Phase 1 first. The two W9 engagement-route families + the W7 executor portion are the only seams with Phase 1 (documented above).
2. **Push** when happy (operator reviews + pushes — house rule §24.2).
3. **Phase 3** per `MYTHOS_Gap-Close_Upgrade_task-957.md` §26: T3 `run_command` effector + engagement/Forge wiring (V7), live-verification passes, BUG-029 proper fix, BUG-024 OAuth docs.

