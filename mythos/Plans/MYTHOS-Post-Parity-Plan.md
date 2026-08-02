# Post-Parity Plan — Social Reach, the Business Agent Layer, Multi-Surface Control

> **This document covers work that starts AFTER merged-order step 7 of the parity
> build.** The parity build is the active work and it is tracked in
> **`mythos/Plans/MYTHOS-IRIS-Synthesis-Plan.md`** (the roadmap/delta) plus
> **`mythos/Plans/MYTHOS-IRIS-Synthesis-Plan-V2-spine.md`** (the source-level spine).
> As of 2026-07-31 that build sits at **step 6.5 (the licensing gate) with step 7
> (Electron shell + installer) remaining**. Nothing in this file is startable
> until those close, with the two explicit exceptions named in the sequence table
> below. **For anything at or before step 7 — including anything this file appears
> to contradict — the parity roadmap is the authority and wins outright.**

## Why a third document exists, when the repo forbids one

The repo's rule against a second plan document exists because planning once lived
in untracked files and the V2 spine was declared lost as a result. That rule is
about **not splitting one build across two competing specs**. This file does not
compete with the parity build: every item in it is scope the parity plan
*deliberately* does not cover. The parity plan's own terminal state is "IRIS
Pro-Plus feature parity, shipped in an Electron installer" — it says nothing about
social platforms, nothing about a multi-agent business layer, nothing about phone
or IoT control surfaces, and nothing about multi-device wake-word arbitration.
Writing those into the parity roadmap would bury a live, mid-flight, RESUME-HERE-
driven build under scope it has no dependency on. So this is a separate backlog
with the same discipline, not a fork of the same build. **Two hard rules:**
(1) where this file and the parity roadmap overlap in any way, the parity roadmap
wins; (2) nothing here gets ticked while the parity roadmap's RESUME HERE still
names step 6.5 or 7 as the next action, except the two items flagged
`PARALLEL-SAFE` below.

This file **inherits the V2 spine's Anti-Drift Contract AD-1…AD-10 verbatim and
does not restate it.** Read V2 §1 before building anything here. Every task below
is written on the assumption that AD-1 (one dispatch surface), AD-4 (no fabricated
success), AD-5 (no synthesized metric — unmeasured means `null`), AD-7
(portability, no machine-specific paths), AD-9 (optional dependencies degrade,
never crash boot) and AD-10 (generated doc counts) apply without exception. Where a
task needs an AD invariant extended to a new class of thing, it says so explicitly
rather than quietly bending it.

---

## RESUME HERE

*Rewrite this block every session that touches this file. It is the first and
sometimes only thing the next machine reads.*

| | |
|---|---|
| **Status** | **Nothing started.** This document was authored 2026-07-31 as a plan only; zero source files were changed by the session that wrote it. No phase below is in progress, and no phase is startable yet — see Blocked on. |
| **Next action** | None in this file. Go to `mythos/Plans/MYTHOS-IRIS-Synthesis-Plan.md`'s RESUME HERE and do step 6.5. The only work here that may begin before then is **P0-parallel** (filing the Instagram/Facebook app-review and TikTok audit paperwork — calendar time, zero engineering, zero code) and **P8** (multi-device wake-word arbitration — independent of everything else here and of the parity build, but gated on the operator's own repo, see below). |
| **Blocked on** | (1) Parity steps 6.5 and 7 (except the two `PARALLEL-SAFE` items). (2) **Four operator decisions** — see "Open decisions" below; three of them (product name, AGPL-internal-use, autonomous posting) gate real design choices, not just wording. (3) **P8 is blocked on the operator supplying their own wake-word-collision repo**, which they said exists. Do not commit to the design sketched in §P8 before reading it. (4) Several research findings this plan rests on are flagged UNVERIFIED or LIKELY-WRONG in "Research corrections" below — verify before building a step on one. |
| **Relationship to the parity build** | Strictly downstream. Parity roadmap wins on any overlap. This file never edits `mythos/Plans/MYTHOS-IRIS-Synthesis-Plan.md` or the V2 spine except to add its own one-line pointer. |
| **Last updated** | 2026-07-31 |

**Sequence (the only order — justified in the next section):**
P0 ☐ · P0-parallel ☐ `PARALLEL-SAFE` · P1 ☐ · P2 ☐ · P3 ☐ · P4 ☐ · P5 ☐ · P6 ☐ · P7 ☐ · P8 ☐ `PARALLEL-SAFE` · P9 ☐ · P10 ☐ · P11 ☐

### How to keep this file honest

1. Tick `- [x]` on a step only when it is **live-verified** against the real
   platform or the real hardware, not merely unit-green. For a social effector,
   "live-verified" means a real post/comment/DM landed on a real account and was
   observed there, or the honest-degrade path ran against a real credential-less
   config. A green suite is not evidence; this repo has shipped 6-of-11 broken
   behind vacuous tests.
2. **A publish tool verified only against a mock is not verified.** Say so in the
   Live-verified column, in those words. The failure mode this whole repo exists
   to beat is a plausible claim with nothing behind it, and social posting is the
   one place where a fabricated success is visible to strangers.
3. Add a row to **Progress log** with the commit SHA that carried the work.
4. Rewrite **RESUME HERE** — Status, Next action, Blocked on.
5. Commit the tick with the code, then `git push`. **A tick that isn't pushed does
   not exist** as far as the next machine is concerned.
6. Steps get ticked and logged rather than deleted — a task that needs revisiting
   has to still be readable.
7. When a step's outcome contradicts a research finding quoted in this file,
   **correct the finding in "Research corrections" in the same commit.** Stale
   third-party facts are how this kind of document rots.

### Progress log

| Date | Work | Commit | Live-verified |
|---|---|---|---|
| 2026-07-31 | Authored this file. Read the parity roadmap (RESUME HERE, merged order, step-6.5 section, Progress log), the V2 spine's §0–§2 including AD-1…AD-10, root `CLAUDE.md`, and the real seams: `src/main.js` registration/boot-step/capability-manifest wiring, `src/core/leash/tiers.js`, `src/core/leash/confirm.js`, `src/core/effectors/{from-calendar,from-gmail,from-android,from-computer,from-mission,orchestrator,adapter}.js`, `adapters/android-child/index.js`, `adapters/google/index.js`, `src/core/agents/personas.js`, `src/core/engagements/index.js`, `src/core/voice/{live-tools,latency-tracker}.js`, `ui/public/js/voice/wakeword.js`, `server/index.js`'s WS message switch, `src/core/config/schema.js`, `.env.example`, `test/effectors-hub.test.js`. No source file changed. | (this commit) | n/a (docs) — and deliberately so: this is a plan, there is nothing to live-verify yet |
| 2026-08-02 | **Capability-pack integration** (appendix CAP below, independent of P0–P11). Twelve operator-named upstream packs made reachable on a fresh clone: 13 skills vendored + loader block-scalar/plugin-root/optional-entry fixes; an MCP stdio client (`adapters/mcp-client/`) + `from-mcp.js`; OKF (`memory/okf.js` + `from-okf.js`); Strix (`from-strix.js`). | `c626b4e`, `2ec3278`, (this commit) | Unit-green (2352 pass). MCP client tested against a real stub server over real pipes. NOT yet live: a real Desktop Commander / browser-use / Strix run against the installed tool — that is the outstanding live-verify, see CAP. |

---

## Sequence, and why this order

The ordering rule is **de-risk before invest**, with calendar-time items started
first because waiting is not work.

| # | Work | Why it sits here |
|---|---|---|
| **P0** | Social spine: `adapters/social/`, `from-social.js` with **read-only tools only**, tier rows, config keys, no-credential-OFFLINE contract | Nothing leaves the machine. Establishes the seam every later phase plugs into. If the spine is wrong, it is wrong before any post is public. |
| **P0-parallel** | File the Instagram/Facebook app review and the TikTok Content Posting API audit. `PARALLEL-SAFE` | Reported 4–6 weeks and multi-week respectively. That is **calendar time, not engineering time** — the only wrong move is starting it late. Requires no code and no parity-build dependency, so it may be filed today. |
| **P1** | **Telegram** publish + read | Free, no fees, no approval, no ban risk on a bot you own, and the API is the simplest of the set. First real proof that the whole chain (voice → leash → confirm → adapter → real outward action) works end-to-end. Cheapest possible place to discover the chain is broken. |
| **P2** | **YouTube** Data API v3 upload + read, `privacyStatus: 'private'` by default | Free quota, official API, your own channel, and an upload can be made non-public by default so a mistake is not a public mistake. Second-cheapest real proof, and the highest-value single platform for the operator's stated content ambition. |
| **P3** | **Reddit** submit + read | Free, official, and it has a genuine sandbox (your own test subreddit) that costs nothing and embarrasses no one. |
| **P4** | Read-only analytics/insights across whatever is connected | T0, no new outward risk, and it is the phase that makes the earlier ones feel worth it. Deliberately after P1–P3 because analytics of nothing is nothing. |
| **P5** | Own scheduler, built on the existing reminder machinery | Only meaningful once ≥1 platform can actually publish. **This is also the phase that removes the entire AGPL/Sustainable-Use question** — see the licensing section. |
| **P6** | Content-render sidecar (optional, MIT, project-local) | A video generator with nowhere to publish is a toy. Strictly after P1–P3, and strictly optional (AD-9 class). |
| **P7** | Phone as a control surface | Mostly already shipped by parity step 2 (`MYTHOS_BIND` + `MYTHOS_AUTH_TOKEN` + WS `?token=`). Small delta, high felt value, no platform dependency. Sits here because it makes P1–P5 usable from the operator's hand, which is what they actually asked for. |
| **P8** | **Multi-device wake-word arbitration.** `PARALLEL-SAFE` | Independent of every other phase and of the parity build. Ordered here only because it is gated on the operator's own repo; if that repo arrives sooner, do it sooner. |
| **P9** | **Instagram** + **TikTok**, once P0-parallel's approvals land | Not engineering-gated — calendar-gated. Doing the code before the approval means an untestable feature sitting in the tree. |
| **P10** | The multi-agent business layer (sales / support / marketing / "the company") | **After the tool layer exists.** A team of agents with no working tools is theatre: it produces convincing plans and zero outcomes, which is precisely the fabricated-capability failure mode AD-4 exists to prevent. This phase is genuinely blocked, not merely deprioritized. |
| **P11** | **X/Twitter**, **LinkedIn company pages**, **WhatsApp Business** | Each is a cost or an approval decision rather than a technical one (X has no free tier for new developers; LinkedIn pages need partner gating; WhatsApp bills per message). Last, and only against real numbers the earlier phases produce. |

**Explicitly not in this plan.** IoT and wearables: the operator named them as
"later" and there is nothing concrete to design against. The honest position is
that P7's work (a token-authenticated WS surface over the LAN) is the same
substrate any such device would use, so P7 is the prerequisite and nothing further
should be planned until there is a specific device.

---

## Open decisions — the operator's, not a session's

Do not guess these. Each one changes code.

| # | Decision | Options | Recommendation |
|---|---|---|---|
| **OD-1** | **The product name is not decided.** MYTHOS is the working name in this repo, not a chosen product name. | (a) Keep MYTHOS. (b) Pick something new and rename. | **Decide before P0**, because `MYTHOS_NAME` already exists in `config/schema.js` as a first-class configurable and every social account handle, OAuth app name, redirect URI and app-review submission created in P0-parallel/P1–P3 will carry the name. Renaming after Meta's app review has approved an app named MYTHOS means re-review. This is the single cheapest decision to make early and the most expensive to defer. Nothing in this file assumes the name is final. |
| **OD-2** | **May an AGPL-3.0 component be used internally, on the operator's own machine, in a product that will be sold?** (Postiz, Automatisch, Windmill core, MoneyPrinterV2 all land here.) | (a) Never — permissive-only, no exceptions. (b) Internal operator use only, never bundled, never network-exposed to third parties. (c) Ask a lawyer first. | **(a) for anything shipped, and P5 is designed so the question never has to be asked** — MYTHOS builds its own scheduler on machinery it already owns rather than embedding one. If the operator wants a self-hosted scheduler's UI for their own workflow, that is a personal-tooling decision outside this codebase. Note the AGPL network-use clause is exactly the trap: a scheduler reached over HTTP by users of a sold product is the case AGPL was written for. **This is a lawyer's call, not a session's — see the licensing section.** |
| **OD-3** | **Is autonomous posting ever permitted without human approval?** | (a) Never — every outward publish is T3+, always. (b) Permitted for pre-approved content only, bound to a content hash. (c) Permitted freely inside a per-account daily budget. | **(b), and never (c).** (b) is implementable, testable, and gives the operator real leverage without a reputational-damage machine; the mechanism is specified in the tiering section. (c) is the option that ends with a bot arguing with a customer at 3am under the operator's brand. Note (a) is the safe default the code should ship with regardless of the answer: `SOCIAL_AUTOPOST_ENABLED` defaults false, so if the operator never decides, nothing autonomous ever happens. |
| **OD-4** | **Which accounts are in scope, and are any of them a real business's live accounts?** | (a) Fresh accounts created for MYTHOS, throwaway-safe. (b) The operator's real personal accounts. (c) A real business's accounts with real customers. | **(a) for P1–P6.** Every phase's first live verification posts to a real audience of zero. Only promote to (b)/(c) after a platform has passed its own live-verification gate at least once. This is the difference between a bug and an incident. |

Two more that are decisions but not blockers, recorded so they are not re-litigated
per-session: whether the business-agent layer's personas live in tracked
`vault/Personas/*.md` (they currently do not — that directory is the runtime
persona registry read by `src/core/agents/personas.js`), and whether analytics
history is retained in the vault at all (a privacy decision, not a technical one).

---

## Existing seams this plan reuses — read before writing anything

The single most important property of this plan is that it adds **no parallel
machinery**. Every item below already exists and was read in the session that
wrote this file.

| Need | Existing seam | Path |
|---|---|---|
| Register a new tool group | `registerFrom*(hub, ctx)` returning nothing, tools built by `buildTools(ctx)`, each wrapped by `effectorFromTool()` | `src/core/effectors/from-calendar.js:215`, `src/core/effectors/adapter.js:10` |
| Boot wiring for a tool group | one `require` at the top of `main.js`, one `registerFrom*` call in the effectors boot step | `src/main.js:51`, `src/main.js:324` (`registerFromAndroid` is the closest template) |
| An external service adapter with a `getStatus()` and an honest OFFLINE state | `adapters/android-child/index.js` (ENOENT→OFFLINE, module-singleton state, side-effect-free `require`, explicit `start`/`shutdown`, per-target queues) | `adapters/android-child/index.js:1-45` |
| An HTTP-API adapter with an OAuth refresh token and a `ready` flag | `createGoogleAdapter()` + the generalized `apiRequest(base, path, method, body)` added for §7.6 | `adapters/google/index.js` |
| Lazy-construct-on-first-use, never cache the not-ready sentinel, clean config error | `ensureAdapter()` | `src/core/effectors/from-gmail.js:21-27` (and the comment there explaining *why* caching the sentinel breaks) |
| Adapter status in the boot capability manifest and `/api/status` | `adapterOnline[...]` + `adapterStatuses()` in the `capabilities-manifest` boot step | `src/main.js:520-524`, `src/main.js:642-670` |
| Tiering a new tool | one row per tool in `TIER_TABLE`, with an inline comment naming the phase and the reason | `src/core/leash/tiers.js` |
| Human confirmation for an irreversible action | `leash.check()` → confirm registry (single-use, connection-scoped, TTL from `LEASH_CONFIRM_TTL_MS`) | `src/core/leash/confirm.js` |
| A single audit line per decision (AD-2) | `leash.check()` already writes it on every branch — callers must not write a second | `src/core/leash/audit-writer.js` |
| Single execution surface (AD-1) | `dispatchAction()`; `effectors.invoke(` must appear only in `dispatch-action.js` | `src/core/effectors/dispatch-action.js` |
| A due-time scan that fires local actions | `addReminder()` / `fireDueReminders()` / the `reminder.due` bus event, with `alertSound` threaded through | `src/core/effectors/from-calendar.js`, `server/index.js`'s `reminder.due` handler |
| Vault-backed JSON store | `fs.readJSON(FILE, default)` / `fs.writeJSON` / `fs.ensureDir` | `src/core/effectors/from-calendar.js:19-32` |
| Path sandboxing for anything touching the local filesystem | `resolveSandboxed()` / `isInsideAllowedRoots()` / `allowedRoots()` | `src/core/effectors/from-computer.js:36-51` |
| Multi-agent delegation over existing primitives | `createOrchestrator()` — a fixed 3-stage plan→build→synthesize pipeline, deliberately **not** a graph framework | `src/core/effectors/orchestrator.js:1-18` |
| Role-specialized agents | `loadPersona(role)` reading `vault/Personas/<role>.md`, cached, returns `null` on miss | `src/core/agents/personas.js` |
| A human-gated multi-stage business workflow with an approve transition | `createEngagement()`'s state machine + `onExecute` firing only on approve→EXECUTING | `src/core/engagements/index.js` |
| Provider spend/quota accounting | `brain/spend.js`'s `recordCall`, `quota.js`'s per-provider day buckets | `src/core/brain/spend.js`, `src/core/quota.js` |
| Honest latency measurement (never estimated) | `latency-tracker.js` — empty tracker reports `{p50:null,p95:null,sampleCount:0}` | `src/core/voice/latency-tracker.js` |
| Which tools the voice model can even see | `DEFAULT_ALLOWLIST` + `LIVE_TOOL_ALLOWLIST`; withheld tools are *reported*, never silently dropped | `src/core/voice/live-tools.js:16,89` |
| Wake-word detection hook | `createWakeWord({threshold, onWake, onStatus})`, `onWake(score)`, `REFRACTORY_MS` gate | `ui/public/js/voice/wakeword.js:26,152` |
| Typed WS frames both ways | the `msg.type ===` chain, `send()`, per-connection closure state | `server/index.js:1425-1460` |
| Client-side broadcast subscription | `onBroadcast`/`offBroadcast` exports (used by `s2s-bridge.js` to self-wire) | `ui/public/js/ws.js` |
| Device identity, existing notion | `vault/Identity/android-devices.json` — **ADB targets MYTHOS controls** | referenced in `.env.example:419` |
| Server auth over the LAN | boot guard + `tokenOk()` (`timingSafeEqual`) + `/api/*` and `/vault/builds` gate + WS `?token=` | `server/index.js`, `.env.example:5-23` |

**One naming trap, stated up front.** `vault/Identity/android-devices.json` holds
phones **MYTHOS controls via adb**. P8 needs a registry of **surfaces that control
MYTHOS** (HUD clients that hear the wake word). These are different things that
happen to both be "devices". Do **not** merge them into one file, and do not name
the new one similarly enough to invite it — use `vault/Identity/surfaces.json`.

---

## Tiering — a first-class design question for this plan

The existing tier table has a shape worth understanding before extending it, and
it was read, not assumed: **T0** read-only, **T1** local writes (auto-allow,
audited), **T2** local action touching real OS/system state (auto-allow at the
default `AUTONOMOUS_MAX_TIER=2`; only differs from T1 when an operator tightens
that setting), **T3** confirm-and-execute, **T4** always confirm, never cached.
There is an enforced invariant that `danger:true` implies tier ≥ 3
(`test/effectors-hub.test.js`, "gate: danger -> tier >= 3"), and unmapped tools
fail safe to T3 via `tierOf()`.

Social tools break the existing table's assumptions in one specific way: **T1 and
T2 both auto-allow under the default configuration.** Everything in the current
table below T3 is either a read or a write the operator can undo by hand on their
own machine. A published post cannot be undone — a deletion is a *different*
public act, not an undo, and screenshots survive it. So the tier boundary that
matters here is not local-vs-system, it is **inward-vs-outward**.

### The proposed tiers

| Tier | Tools | Reasoning |
|---|---|---|
| **T0** | `social_accounts_list`, `social_analytics`, `social_read_comments`, `social_read_mentions`, `social_queue_list`, `social_drafts_list` | Reads of the operator's own data. No outward effect, nothing published, nothing spent. Same class as `gmail_unread`… except note `gmail_unread` is **T1**, not T0, because it is a privacy read of a mailbox. Comments and mentions on a public post are already public; DM reads are not — see the T1 row. |
| **T1** | `social_draft_create`, `social_draft_delete`, `social_render_media`, `social_read_dms`, `social_pause_all` | Vault-local writes plus one privacy read. `social_read_dms` sits here, not T0, following `gmail_read`'s precedent — private correspondence. `social_render_media` writes a file into the vault via `resolveSandboxed()` and touches no network beyond the render sidecar. **`social_pause_all` is deliberately the cheapest tool in the set:** stopping must never require a confirmation the operator might not be present to give. The asymmetry is intentional — going is gated, stopping is free. |
| **T2** | **(empty — no new T2 tools)** | Stated explicitly so nobody adds one by reflex. Every candidate that *looks* T2 is really T3: connecting an account is an OAuth grant, and scheduling is publishing with a delay fuse. |
| **T3** | `social_publish`, `social_schedule`, `social_unschedule`, `social_comment_reply`, `social_dm_send`, `social_delete_post`, `social_account_connect` | Every outward action to a real audience. Confirm-and-execute. The confirm summary must show the **exact rendered payload**, the **target account handle**, the **platform**, and the audience size **if measured, else `null`** (AD-5 — never an estimate, and "unknown followers" is an acceptable thing for a modal to say). `social_schedule` is here and not lower precisely *because* of the delay: the human who approves is not present when it fires, so approval must happen at schedule time on the final bytes. `social_delete_post` is T3 rather than T1 because deletion is itself an outward act with its own consequences (broken links, a visible gap, an archive that already captured it). `social_account_connect` is T3 because an OAuth grant hands a third party standing access. |
| **T4** | `social_ads_spend`, `social_boost_post`, `social_bulk_dm`, `social_account_disconnect_all` | Never cached, human approves every single invocation. Money leaving the account, and any send whose recipient count exceeds `SOCIAL_BULK_DM_THRESHOLD`. `danger: true` on all four, which the existing gate already requires at this tier. |

Two consequences to handle mechanically, not by intention:

- **The Live voice model must not see the T3/T4 tools by default.**
  `live-tools.js`'s `DEFAULT_ALLOWLIST` is a curated subset because declaration
  accuracy degrades with tool count. Adding a dozen social tools to it would both
  hurt every other tool's accuracy and put "publish" one mis-transcription away.
  Add only the T0/T1 tools to the default allowlist; T3/T4 reach Live only if the
  operator opts them in via `LIVE_TOOL_ALLOWLIST`. Withheld tools are already
  reported rather than silently dropped, so this stays honest.
- **`tierOf()`'s unmapped→T3 fail-safe is not good enough here.** T3 means "a
  human confirms", which is right for a forgotten local tool and *wrong* for a
  forgotten money tool. Add a targeted assertion (P0 step) that every registered
  tool whose name starts `social_` has an explicit `TIER_TABLE` row — so a new
  social tool that someone forgets to tier fails the suite instead of quietly
  landing at T3.

### The ugly case: an autonomous marketing agent

Stated plainly, because the operator asked for a marketing team and this is what
that means if it is built carelessly: **an agent that can publish without a human
is a reputational-damage machine.** It does not need to be malicious or even
wrong. It needs only to be confidently off-tone once, at scale, in public, under
the operator's real name, while nobody is watching. Tiers alone do not stop this,
because an operator who gets tired of confirming will raise
`AUTONOMOUS_MAX_TIER`, and then every T3 tool is autonomous.

Five gates, of which the third is the load-bearing one:

1. **`SOCIAL_AUTOPOST_ENABLED`, default `false`**, read from config at boot. No
   effector may write it. Verify, do not assume, that this holds: the project root
   is **always** an allowed root in `allowedRoots()`
   (`from-computer.js:44-49`), and `mythos/.env` sits inside it, so a
   T3-approved `write_file` can rewrite the config file today. That is a real hole
   in the reasoning and it is in the risk register, not hand-waved.
2. **Tier floor override.** When `SOCIAL_AUTOPOST_ENABLED` is false, every
   `social_*` T3/T4 tool must be treated as confirm-required **regardless** of
   `AUTONOMOUS_MAX_TIER`. This is a deliberate, documented, tested exception to
   the tier ladder — the one place in this plan where an AD-adjacent invariant is
   extended rather than reused, and it needs a `mythos/docs/DRIFT-LOG.md` entry
   per V2 §1's drift-log rule, with an expiry.
3. **Approval binds to bytes, not to intent.** The only autonomous mode this plan
   endorses (OD-3 option b) is: a human approves a **specific rendered artifact**,
   the approval record stores a SHA-256 of the exact payload
   (`src/core/social/approval.js`), and `social_publish` will publish autonomously
   **only** when the payload it holds hashes to an unexpired approval. Any
   edit — one word, one different image, a re-render — changes the hash and drops
   the call back to T3. This is the concrete answer to "the agent wrote something
   different from what I approved", and it is trivially testable: mutate a byte,
   assert the tool refuses.
4. **A server-side per-account daily publish budget**, in the shape `quota.js`
   already uses for providers. Even a fully-approved autonomous run cannot emit
   400 posts, because the budget is not something the agent can raise.
5. **Default to non-public where the platform allows it.** YouTube uploads
   `privacyStatus: 'private'`, TikTok stays `SELF_ONLY` until its audit passes
   anyway, Reddit posts to a test subreddit until `SOCIAL_LIVE_ACCOUNTS` names a
   real one. The first live verification of every platform posts to an audience of
   zero (OD-4).

---

## P0 — the social spine (no outward action)

**Files:** create `mythos/adapters/social/index.js`, `mythos/adapters/social/http.js`;
create `mythos/src/core/effectors/from-social.js`; modify `mythos/src/main.js`,
`mythos/src/core/leash/tiers.js`, `mythos/src/core/config/schema.js`,
`mythos/.env.example`; tests `mythos/test/social-adapter.test.js`,
`mythos/test/from-social.test.js`, `mythos/test/social-tiers.test.js`.

- [ ] **Step 1 — write the failing tests first, run them, paste the red.**
  `test/from-social.test.js` asserts `registerFromSocial` exists and that
  `social_accounts_list` is registered. Expect `Cannot find module
  '../src/core/effectors/from-social.js'` — that is the correct red for a
  not-yet-created module, and it is the same red the parity build's Task 8/10
  recorded. Run only your own files:
  `cd mythos && node --test test/from-social.test.js`.
- [ ] **Step 2 — `adapters/social/index.js`.** One module, one `getStatus()` per
  platform, following `android-child`'s discipline (module-singleton state,
  side-effect-free `require`, explicit `startSocial()`/`shutdownSocial()`) and
  `adapters/google`'s shape for the HTTP part (`apiRequest(base, path, method,
  body)`, a `ready` flag per platform). **The AD-9 analogue for an API platform is
  "no credential → OFFLINE with a hint", exactly as "no binary → OFFLINE with an
  install hint".** Boot must succeed with zero social credentials configured, every
  platform reporting `OFFLINE`, and every tool degrading with a clean, actionable
  message naming the exact env keys to set — the `from-gmail.js:21-27` pattern
  verbatim, including *not* caching the not-ready sentinel.
- [ ] **Step 3 — `from-social.js` with T0/T1 tools only.** `social_accounts_list`
  (which platforms are configured and reachable — real status, never a guess),
  `social_drafts_list`, `social_draft_create`, `social_draft_delete`,
  `social_pause_all`. Vault store at `Social/drafts.json` via
  `fs.readJSON`/`writeJSON`, same as `Calendar/reminders.json`. No network yet.
- [ ] **Step 4 — tier rows** in `src/core/leash/tiers.js` for every tool
  registered in step 3, each with an inline comment naming this plan's phase and
  the reason, matching the file's existing comment style. `social_pause_all` T1.
- [ ] **Step 5 — the forgotten-tier guard.** `test/social-tiers.test.js`: every
  registered tool whose name matches `/^social_/` has an explicit `TIER_TABLE`
  entry; no `social_*` tool with `danger:true` is below T3; the T2 row stays
  empty. Prove it red by temporarily deleting one row.
- [ ] **Step 6 — boot wiring** in `src/main.js`: the `require`, the
  `registerFromSocial(hub, {...})` call in the effectors boot step, `startSocial`/
  `shutdownSocial` in the lifecycle steps, and the adapter in **both**
  `adapterOnline` (`main.js:520-524`) and `adapterStatuses()`
  (`main.js:650-653`) so `vault/Identity/capabilities.md` and `/api/status` report
  it honestly. Missing either of those two is the classic half-wiring in this repo.
- [ ] **Step 7 — config + docs.** `SOCIAL_AUTOPOST_ENABLED` (default false),
  `SOCIAL_LIVE_ACCOUNTS` (default empty), `SOCIAL_BULK_DM_THRESHOLD`,
  `SOCIAL_DAILY_PUBLISH_BUDGET`, and per-platform key names in
  `src/core/config/schema.js` **and** `mythos/.env.example` with the reasoning
  written out, matching how `.env.example` documents `MYTHOS_AUTH_TOKEN`. Every
  provider key belongs in `.env.example` — no key, no hardcoded default, feature
  degrades honestly (root `CLAUDE.md`).
- [ ] **Step 8 — effector counts.** `from-social.js` is a **new** `registerFrom*`
  and is **not** among the eight the `test/effectors-hub.test.js` "gate: 86
  registered count" test boots (computer, pc, browser, dashboard, project, gmail,
  docs, runner), so that number is unaffected — verify that claim by running the
  file rather than trusting this sentence, and extend that test's changelog
  comment to record the decision either way. The boot-time total and README's
  counts **do** change: run `node scripts/sync-test-count.js --write` and commit
  the result (AD-10).
- [ ] **Step 9 — live-verify the honest-degrade path for real.** Boot the real app
  (`node src/main.js`) with **no** social credentials in `.env`: expect
  `social.offline` with the exact hint in the log, the platform listed as OFFLINE
  in `vault/Identity/capabilities.md`, boot completing, and every other effector
  registering — the same AD-9 proof shape the parity build's step 6 produced for
  `adb`. Paste the real log lines.

## P0-parallel — start the long-lead approvals (`PARALLEL-SAFE`, no code)

- [ ] **Step 1 — settle OD-1 (the name) first.** An app-review submission carries
  the product name. Renaming after approval means re-review.
- [ ] **Step 2 — Meta:** create the app, convert the target Instagram account to
  Business or Creator (the API supports no other kind), request the content-
  publishing and insights permissions, submit for review. Reported 4–6 weeks.
- [ ] **Step 3 — TikTok:** register for the Content Posting API, build against the
  sandbox, and submit for the production audit. Until it passes, an unaudited
  client can only post `SELF_ONLY` — which is fine, because that is what P9's
  first live verification wants anyway.
- [ ] **Step 4 — record the submission dates and the reference numbers** in this
  file's Progress log, so a later session can tell "waiting" from "forgotten".
- [ ] **Step 5 — no code.** If this phase produces a diff, something has gone
  wrong.

## P1 — Telegram (first real outward action)

**Files:** create `mythos/adapters/social/telegram.js`; modify
`mythos/src/core/effectors/from-social.js`, `mythos/src/core/leash/tiers.js`,
`mythos/.env.example`; test `mythos/test/social-telegram.test.js`.

- [ ] **Step 1 — red first.** Test asserts `social_publish` with
  `platform:'telegram'` is registered and, with no `TELEGRAM_BOT_TOKEN`, returns a
  clean failure naming that key. Run it, confirm the red, paste it.
- [ ] **Step 2 — adapter.** Bot API over plain `fetch` (no new dependency —
  `process.loadEnvFile()` replaced `dotenv` precisely because this repo keeps its
  dependency count low and generated). `sendMessage`, `sendPhoto`, `sendVideo`,
  `getUpdates`.
- [ ] **Step 3 — the honest constraint, in the tool's own error text.** A Telegram
  bot **cannot** message a user who has not first started a conversation with it.
  Say that in the failure message rather than reporting a send that went nowhere
  (AD-4). This is the first place the plan's "no fabricated success" rule meets a
  real platform rule.
- [ ] **Step 4 — `social_publish` T3, `social_dm_send` T3**, rows added with
  reasons.
- [ ] **Step 5 — the confirm path, tested end-to-end.** Drive a real
  `createLeash()` (the pattern `test/anti-drift-audit-single-write.test.js`
  already uses): assert `status:'awaiting_human_confirmation'`, **zero** dispatch
  calls, and **exactly one** tier-3 audit line. Then accept and assert exactly one
  publish. This is the gate that must never regress.
- [ ] **Step 6 — live-verify for real.** Post to a real channel the operator owns
  with an audience of zero (OD-4), by voice if the mic is available, and **observe
  the message in Telegram**. Then reject a confirm and prove nothing was posted.
  Paste the real result. A mock-only pass here is not a tick.

## P2 — YouTube (Data API v3)

**Files:** create `mythos/adapters/social/youtube.js`; modify `from-social.js`,
`tiers.js`, `.env.example`; test `mythos/test/social-youtube.test.js`.

- [ ] **Step 1 — red first**, as P1.
- [ ] **Step 2 — reuse the Google OAuth path that already exists.** `adapters/
  google/index.js` already holds refresh-token plumbing and a generalized
  `apiRequest`, and `scripts/google-auth.js` already mints tokens. This is a new
  **scope** (`youtube.upload`, `youtube.readonly`), not a new auth system — the
  same conclusion the parity build reached for Calendar in step 5 §7.6, and it was
  reached there by *reading* `SCOPES` rather than assuming. Read it again; do not
  trust this sentence.
- [ ] **Step 3 — verify the quota numbers against the live docs before designing
  around them.** This plan's research claims an upload now costs roughly 100 units
  against a 10,000/day default, with uploads billed to a separate daily bucket. If
  that is stale and an upload still costs 1,600 units, the design does not change —
  it just means ~6 uploads/day instead of many. **Do not let a volume feature
  depend on the cheaper number until it is confirmed** (see Research corrections).
- [ ] **Step 4 — `privacyStatus: 'private'` is the hard default** and the only
  value used until the operator explicitly passes otherwise. A public upload is
  T3-confirmed with the visibility shown in the modal.
- [ ] **Step 5 — resumable upload for anything non-trivial**, streamed from the
  vault path via `resolveSandboxed()`. Never read a whole video into memory.
- [ ] **Step 6 — live-verify:** upload one real short clip as `private` to a real
  channel, observe it in YouTube Studio, then delete it. Record the real unit cost
  observed against the quota, measured — not the documented figure (AD-5).

## P3 — Reddit

**Files:** create `mythos/adapters/social/reddit.js`; modify `from-social.js`,
`tiers.js`, `.env.example`; test `mythos/test/social-reddit.test.js`.

- [ ] **Step 1 — red first.**
- [ ] **Step 2 — OAuth script-app flow**, correct `User-Agent` (Reddit rejects a
  generic one), free-tier rate limit respected with a real backoff — and the rate
  limit read from the live docs, since this plan's figure is flagged unverified.
- [ ] **Step 3 — `social_publish` for a self/link post; `social_read_comments`
  T0.**
- [ ] **Step 4 — live-verify** against a private test subreddit the operator
  creates for this purpose. Observe the post. Then verify a rate-limit response
  produces an honest degraded result rather than a retry storm.

## P4 — read-only analytics

**Files:** modify `from-social.js`, `tiers.js`; create
`mythos/src/core/social/metrics.js`; test `mythos/test/social-analytics.test.js`.

- [ ] **Step 1 — red first**, then implement `social_analytics` (T0) fanning out
  across whichever platforms are ONLINE.
- [ ] **Step 2 — AD-5 is the whole design here.** A platform that is OFFLINE
  contributes `null`, not zero and not an extrapolation. A metric the API does not
  return is **absent** from the result object, not defaulted. A partial fan-out
  reports `degraded:true` and names which platforms failed — the same shape
  `document_search` uses when embeddings are down. This is the phase where the
  IRIS anti-pattern (`temperature = 40 + cpu*0.4 + Math.random()*2`) would sneak
  back in, so the test file should include a grep-style assertion that
  `metrics.js` contains no `Math.random()` at all.
- [ ] **Step 3 — a HUD tile only after the data is real.** Do not build a
  dashboard for numbers that do not exist yet.
- [ ] **Step 4 — live-verify** against a real account with real (probably tiny)
  numbers, and confirm the OFFLINE-platform case genuinely returns `null`.

## P5 — the scheduler MYTHOS already almost has

**This is the phase that deletes the AGPL problem instead of solving it.** Postiz
(AGPL-3.0, network-use clause), Automatisch (AGPL-3.0), Windmill (AGPL core with
an explicit no-resale clause) and n8n (Sustainable Use License, source-available,
not OSI open source, cannot be resold as a managed service) are all licence risks
for a product that will be sold, and each is a whole extra service to run.
Meanwhile `from-calendar.js` already implements a persisted due-time store, a
periodic due-scan (`fireDueReminders()`), a bus event, and a server handler that
acts on it — that is a scheduler. A scheduled post is a reminder with a payload.

**Files:** create `mythos/src/core/social/queue.js`,
`mythos/src/core/social/approval.js`; modify `from-social.js`, `tiers.js`,
`mythos/server/index.js`; tests `mythos/test/social-queue.test.js`,
`mythos/test/social-approval.test.js`.

- [ ] **Step 1 — red first** for both new modules.
- [ ] **Step 2 — `queue.js`**: `Social/queue.json` in the vault, records carrying
  `{id, platform, account, payload, payloadHash, dueAt, status, approvalId,
  firedAt, result}`. Model the due-scan on `fireDueReminders()` rather than
  inventing a second timer loop, and reuse the crash policy `build-runner`/
  `orchestrator` already use: an in-flight item found at boot is marked failed
  **honestly**, never silently retried into a duplicate post.
- [ ] **Step 3 — `approval.js`**: SHA-256 over the canonical serialization of the
  payload, an expiry, and a single-use consumption record. Mirror
  `leash/confirm.js`'s discipline (single-use, sweep-on-create, TTL from config)
  rather than writing a new registry idiom.
- [ ] **Step 4 — `social_schedule` / `social_unschedule` at T3.** Approval is
  captured **at schedule time on the final bytes**, because the human is not
  present when it fires.
- [ ] **Step 5 — the hash gate, proved by mutation.** Test: approve a payload,
  mutate one byte, assert the queued publish **refuses** and drops to
  confirm-required. Then assert an expired approval also refuses. This is OD-3
  option (b)'s entire mechanism; if this test is weak, the feature is a
  reputational-damage machine with extra steps.
- [ ] **Step 6 — server wiring** in `server/index.js` following the `reminder.due`
  handler's shape exactly, including how it reaches the operator's HUD.
- [ ] **Step 7 — the survives-restart question, answered explicitly.** V2 §7.12
  wanted real Windows Scheduled Tasks for alarms so they survive a MYTHOS restart,
  and the parity build's Task 5 shipped in-process timers instead and **documented
  the gap rather than hiding it.** The same gap applies here and is worse: a post
  scheduled for 09:00 does not fire if MYTHOS is not running at 09:00. Decide and
  record: (a) accept it, and make `social_queue_list` show "will not fire unless
  MYTHOS is running" honestly; or (b) reuse `scripts/setup-autostart.js`'s
  `schtasks` machinery so MYTHOS is running. **Do not ship (a) silently.**
- [ ] **Step 8 — live-verify:** schedule a real post two minutes out, watch it
  fire, observe it on the platform, then schedule one and kill MYTHOS before it
  fires and confirm the boot-time recovery reports failure honestly rather than
  double-posting.

## P6 — content rendering (optional sidecar)

**Files:** create `mythos/scripts/setup-content-engine.js`,
`mythos/adapters/content-engine/index.js`; modify `from-social.js`, `tiers.js`,
`.gitignore`, `.env.example`; test `mythos/test/content-engine.test.js`.

MoneyPrinterTurbo (MIT) is a genuinely useful video generator. **Its auto-publish
path routes through Upload-Post, a paid third-party SaaS — do not use that path at
all.** Use it as a *render* engine only and publish through P1–P3's own effectors.
Original MoneyPrinter is MIT but YouTube-Shorts-only with no publish automation;
MoneyPrinterV2 is AGPL-3.0 and is therefore out under OD-2.

- [ ] **Step 1 — red first**, including a test that boot succeeds with the engine
  absent.
- [ ] **Step 2 — install project-local, exactly like Hermes.** Clone into a
  gitignored `<repo>/Content Engine/` from git and run that clone's own installer.
  **Never `curl | bash` or `iex (irm …)`** (root `CLAUDE.md`). Model the script on
  `mythos/scripts/setup-hermes.js`.
- [ ] **Step 3 — AD-9, and Hermes is *not* the precedent to copy here.** Hermes is
  the one deliberate exception where absence makes builds *fail*. A content engine
  is not load-bearing: spawn ENOENT → adapter OFFLINE → `social_render_media`
  degrades with an install hint → boot unaffected → everything else still works.
- [ ] **Step 4 — `social_render_media` T1**, output written through
  `resolveSandboxed()` into the vault.
- [ ] **Step 5 — licence and asset audit, folded into 6.5's surface** (see the
  licensing section). MIT code frequently ships with **model or asset files under
  separate terms** — the parity build already flagged exactly this for MediaPipe.
  Check the engine's bundled voices, music beds, and stock-footage sources
  individually; a royalty-free-for-personal-use music bed in a sold product is the
  same class of problem as the openWakeWord weights.
- [ ] **Step 6 — live-verify:** render one real clip locally with the engine
  installed, then uninstall it and confirm the degrade path.

## P7 — the phone as a control surface

Most of this already shipped. Parity step 2 delivered a non-loopback bind guard,
`MYTHOS_AUTH_TOKEN` with `timingSafeEqual`, an `/api/*` + `/vault/builds` gate, and
WS `?token=` — and it was live-verified with real `curl` and real WS connects
against a process bound to `0.0.0.0`. So "drive the desktop server from my phone"
is a **small delta**, not a project. Resist rebuilding it.

**Files:** create `mythos/ui/public/manifest.webmanifest`,
`mythos/ui/public/js/pwa.js`; modify `mythos/ui/public/index.html`,
`mythos/ui/public/css/*` (responsive only); test
`mythos/test/pwa-manifest.test.js`.

- [ ] **Step 1 — write down what is actually missing** before writing code: a web
  app manifest, an installable-to-home-screen path, a touch-sized layout at phone
  breakpoints, and a way to enter the token once on the phone. The HUD's
  responsive breakpoints were already consolidated in the 2026-07-27 UI overhaul —
  read that work before adding new ones.
- [ ] **Step 2 — manifest + icons**, all paths relative, no absolute URLs (AD-7).
- [ ] **Step 3 — the token entry path on a phone.** `.env.example` already warns
  that `?token=` leaks into access logs and that any `mythos_token` cookie must be
  `Secure` + `SameSite`, and `HttpOnly` unless page JS needs it. Honour that. Over
  a LAN without TLS a `Secure` cookie will not be set at all — so **decide and
  record** whether phone access requires HTTPS (self-signed or a reverse proxy) or
  whether the operator accepts a plaintext LAN token. Do not silently pick.
- [ ] **Step 4 — mic on mobile is a real constraint, not a detail.** Browsers
  require a secure context for `getUserMedia`; `http://<lan-ip>:4478` is not one.
  Either the phone surface is text/tap-only, or step 3 resolves to HTTPS. State
  which, in the tool's own status output, so the model never claims a phone mic it
  does not have.
- [ ] **Step 5 — live-verify from a real phone** on the real LAN: authenticate,
  see live status, drive one T0 tool and one T3 tool through the confirm modal on a
  touch screen. A confirm modal that cannot be read or tapped on a phone is a
  security control that does not exist.
- [ ] **Step 6 — do not weaken the boot guard for convenience.** If a step here
  wants to relax the non-loopback-requires-token rule, the step is wrong.

## P8 — multi-device wake-word arbitration (`PARALLEL-SAFE`)

**This is the operator's own live problem and it deserves real design, not a
placeholder.** With two or three devices in one room, one wake word wakes all of
them — the failure mode Google Assistant and Siri both have. **The operator
believes they may have solved it and will supply a repo. Read that repo before
committing to any design.** What follows is a baseline to compare it against, and
an honest statement of what this repo's shape makes easy.

### The problem, stated precisely

N surfaces hear one acoustic event. Exactly one must answer. The losers must not
speak and must not open a billed session. The decision must land inside the
perceptual budget for "instant" — call it ~200 ms of headroom before the
acknowledgement, which the existing `latency-tracker.js` can measure honestly
rather than us asserting it. And when the network is down, each device must still
reach a safe decision alone.

### The observation that makes this tractable here

It is tempting to reach for a distributed-consensus protocol. **Do not.** In this
architecture every HUD client already connects to one authoritative MYTHOS server
over `/ws`. There is already a single sequencer with a total order over incoming
frames. So the common case is not consensus at all — it is a **single-writer
election at a component that already exists**, which is both drastically simpler
and drastically faster than any quorum protocol. Raft here would be engineering
theatre. The genuinely hard parts are (a) what gets measured, (b) the tiebreak,
(c) hysteresis, and (d) the partitioned case.

A second, stronger consequence: **a MYTHOS surface that cannot reach the server
cannot answer usefully anyway** — no brain, no tools, no TTS pipeline. Unlike an
Alexa or a HomePod, each of which has its own independent cloud path, a losing
MYTHOS client has nothing to fabricate an answer with. That shrinks the
partitioned case from "the hard part" to "a small, well-defined fallback".

### What each device measures on wake

`wakeword.js`'s `onWake(score)` already fires with the classifier score after a
`REFRACTORY_MS` gate. Today it opens a session directly. The change is that
`onWake` **claims candidacy and waits**; it never opens anything itself.

The claim carries only measured values (AD-5 — anything unmeasured is `null` and is
then ignored as an input, never defaulted):

- `score` — the ONNX classifier output, 0..1. **Secondary, not primary**: it
  saturates near 1.0 for any clear utterance and is a poor discriminator between
  two devices that both heard it clearly. Say this out loud, because "just take the
  highest confidence" is the obvious wrong answer.
- `rmsDb` over the wake window and `noiseFloorDb` from a rolling estimate, giving
  **`snrDb` — the primary signal.** The nearest microphone hears the wake word with
  the best signal-to-noise margin. This is a physical proximity proxy and it is
  what actually correlates with "the device the human is talking to". The pre-roll
  audio needed to compute it already exists (`preroll-worklet.js`).
- `detectedAtLocalMs` (monotonic) plus `clockOffsetMs` and
  **`clockUncertaintyMs`**, estimated from WS ping/pong RTT. **If the uncertainty
  exceeds the tolerance window, the timestamp must be discarded as a tiebreak
  input rather than trusted.** Applying AD-5's discipline to a clock is the
  difference between a tiebreak and a coin flip that looks like a measurement.
- `surfaceId`, stable across reloads, persisted client-side.

### The election

New module `mythos/src/core/voice/wake-arbiter.js` — pure, with an injectable
clock, following the DI-seam precedent this repo has now used four times
(`createSocket` in `live-session.js`, `contextFactory` in `pcm-player.js`, `embed`
in `from-documents.js`, `createLiveSocket` on `createServer`). Pure and injectable
means the whole thing is testable without hardware, which matters because the
hardware verification needs a second machine.

1. **Window.** The first claim mints a server-side `wakeId` and opens a window of
   `WAKE_ARBITRATION_WINDOW_MS`, default ~120 ms. The budget reasoning, which must
   be **measured and then corrected**, not trusted: the openWakeWord front end
   runs on 1280-sample frames at 16 kHz, i.e. 80 ms hops, so two devices hearing
   the same utterance detect within roughly one frame of each other plus scheduling
   jitter; LAN RTT is typically single-digit to low-tens of milliseconds but spikes.
   120 ms covers that and still leaves headroom inside the ~200 ms perceptual
   budget. **Record the real observed inter-device spread with
   `latency-tracker.js` and tune from data.**
2. **Grouping — the correctness trap.** Claims are the same utterance only if they
   arrive inside the window **and** are consistent (same wake word, timestamps
   within tolerance where trustworthy). A naive "everything in 120 ms is one
   event" swallows a genuine second wake word spoken immediately after the first.
   Test this case explicitly.
3. **Ranking.** Operator pin (an explicit per-surface priority) → highest `snrDb`
   margin → highest `score` → **deterministic tiebreak: lowest `surfaceId`
   lexicographically.** Not random: a random tiebreak makes the outcome
   irreproducible in tests and makes the answering device flap between two
   equidistant surfaces on successive wakes, which is exactly the behaviour that
   makes multi-device assistants feel broken.
4. **Hysteresis / stickiness.** If a surface won within `WAKE_STICKY_MS` (~8 s) and
   is within `WAKE_STICKY_MARGIN_DB` (~3 dB) of the current best, it wins again.
   Without this, a two-device room hands the conversation back and forth
   mid-sentence. This, not the election itself, is what makes it *feel* solved.
5. **Result frames.** `{type:'wake-grant', wakeId}` to the winner;
   `{type:'wake-deny', wakeId, reason, winnerSurfaceId}` to every loser. New
   branches in `server/index.js`'s `msg.type ===` chain alongside
   `live-open`/`live-audio`. **`live-open` and utterance capture become gated on a
   grant** — a loser must never have opened a session, which is a cost argument as
   well as a UX one, since a Live session bills for open-mic time.
6. **Cross-device echo is a new failure mode.** `voice-loop.js`'s echo guard is
   per-device: device A speaking is not device A's problem, it is device B's. When
   a grant is issued the server broadcasts a speaking state; losers apply
   `WAKE_SUPPRESS_MS` and duck their own capture so the winner's TTS does not
   re-trigger them. Two devices politely waking each other in a loop is a real
   thing that happens.

### Failing safe alone, when the server is unreachable

Two options, with honestly different failure modes:

- **Fail-open** (answer alone): the user is never ignored, but every device answers
  at once — the original bug.
- **Fail-closed** (stay silent): exactly-one is preserved, but nobody answers and
  the assistant looks dead.

**Recommendation: fail-open on exactly one designated primary, fail-closed
everywhere else.** `WAKE_PRIMARY_SURFACE_ID` is persisted and operator-set,
defaulting to the surface running on the same host as the server. This preserves
exactly-one determinism with **no network and no negotiation**. The honest cost:
if the primary is in another room, the operator is ignored. That must surface in
the HUD as an explicit `DEGRADED` state naming the reason — never silently, per
this repo's honest-inert principle. And per the observation above, a non-primary
surface that cannot reach the server could not have answered usefully anyway, so
fail-closed costs very little here.

### Files and tests

**Create** `mythos/src/core/voice/wake-arbiter.js`,
`mythos/ui/public/js/voice/wake-claim.js`. **Modify**
`mythos/ui/public/js/voice/wakeword.js` (`onWake` → claim, never a direct open),
`mythos/ui/public/js/voice/voice-loop.js` (gate capture on grant; cross-device
suppression), `mythos/server/index.js` (two new WS branches + the speaking
broadcast), `mythos/src/core/config/schema.js` + `mythos/.env.example` (the five
`WAKE_*` keys), and a new `vault/Identity/surfaces.json` registry — **distinct from
`android-devices.json`**, see the naming trap above. **Tests**
`mythos/test/wake-arbiter.test.js` (pure election: single claim, N simultaneous
claims, the second-utterance grouping trap, deterministic tiebreak, stickiness,
untrustworthy-clock discard, window expiry with zero claims),
`mythos/test/wake-arbiter-wiring.test.js` (real server + real WS: losers get deny
and open no session — assert **zero** Live session constructions, which the
`createLiveSocket` DI seam makes observable).

- [ ] **Step 1 — read the operator's repo. Do not skip this and do not build
  first.** They may have solved it differently or better; a plan that ignores the
  operator's own work to build its own guess is the wrong plan even if the guess is
  good. Record what it does and how it differs from the above, in this file.
- [ ] **Step 2 — red-first `wake-arbiter.test.js`**, all seven cases.
- [ ] **Step 3 — implement the arbiter**, pure, injectable clock.
- [ ] **Step 4 — the client claim path**, with `onWake` no longer opening anything.
- [ ] **Step 5 — server wiring + the zero-session-for-losers test.**
- [ ] **Step 6 — measure, then tune.** Instrument the claim-to-grant interval with
  `latency-tracker.js`. Report real p50/p95; an unmeasured window is `null`, never
  an estimate (AD-5). **The default 120 ms above is a starting hypothesis, not a
  result.**
- [ ] **Step 7 — live-verify with two real devices in one real room.** This needs a
  second physical machine with a real microphone. **It is not producible in a
  single-machine session** — if you cannot do it, leave this step unticked and say
  why, exactly as the parity build left its physical-phone and mic/speaker steps
  unticked rather than fabricating them.
- [ ] **Step 8 — live-verify the partitioned case:** kill the server, say the wake
  word, confirm exactly one device (the primary) responds and the others stay
  silent and show `DEGRADED` with the reason.

## P9 — Instagram and TikTok (approval-gated)

**Files:** create `mythos/adapters/social/instagram.js`,
`mythos/adapters/social/tiktok.js`; modify `from-social.js`, `tiers.js`,
`.env.example`; tests `mythos/test/social-instagram.test.js`,
`mythos/test/social-tiktok.test.js`.

- [ ] **Step 1 — do not start until P0-parallel's approvals have actually landed.**
  Code for an unapproved API is untestable code.
- [ ] **Step 2 — Instagram Graph API only. `instagrapi` and any other
  private-API emulation is banned outright** — high ban risk, against platform ToS,
  and a feature whose account can vanish overnight has no place in a product that
  will be sold. If an unofficial path is ever mentioned in this codebase it must be
  clearly marked and must never be the default.
- [ ] **Step 3 — the two-step container-then-publish flow** (`/media` then
  `/media_publish`), Business/Creator accounts only. **Verify the publishing-
  specific limit separately from the general rate limit** — see Research
  corrections; the low daily *publish* cap and the hourly *call* cap are different
  numbers and conflating them will design in a bug.
- [ ] **Step 4 — TikTok stays `SELF_ONLY`** until the production audit passes.
  `social_accounts_list` must report that state honestly so the model never claims
  a public post it cannot make.
- [ ] **Step 5 — live-verify** each with one real post to a real account with an
  audience of zero, observed on the platform. Delete afterwards.

## P10 — the business-agent layer (sales, support, marketing, "the company")

**Blocked until the tool layer works.** The operator asked to run their own sales,
customer-service and marketing teams. The honest reading of that intent is: *a set
of role-specialized agents that use the tools MYTHOS has, under human gates, with
real outcomes recorded honestly.* The dishonest version — agents that produce
convincing plans and no outcomes — is the exact failure AD-4 exists to prevent, and
it is what you get if this phase runs before P1–P5.

**Reuse, do not rebuild.** Three relevant pieces already exist and were read:
`src/core/effectors/orchestrator.js` is a mission orchestrator that delegates a
multi-part goal to a background agent team over existing primitives and
**deliberately is not a graph framework**; `src/core/agents/personas.js` loads
role-specialized agents from `vault/Personas/<role>.md`; and
`src/core/engagements/` is a full state machine whose executor fires only on an
**approve → EXECUTING** transition. That last one is close to exactly what a
"customer engagement" needs.

**Files:** create `vault/Personas/{sales,support,marketing}.md` (or their tracked
equivalent per OD's open note), `mythos/src/core/agents/teams.js`; modify
`src/core/effectors/from-mission.js` or add
`mythos/src/core/effectors/from-teams.js`, `tiers.js`; test
`mythos/test/agent-teams.test.js`.

- [ ] **Step 1 — decide against building a framework.** CrewAI (MIT), AG2
  (Apache-2.0), agency-swarm (MIT) and LangGraph's MIT **core** (its
  `langgraph-api`/deploy tooling is Elastic License 2.0 — embed the core only, if
  anything) are all Python, so the interop shape would be an HTTP sidecar, exactly
  how this repo already treats Hermes-Agent and edge-tts. **Recommendation: do not
  add one.** The existing orchestrator + personas + engagements already cover
  plan → delegate → execute → report, and a second orchestration model would be a
  parallel execution surface — an AD-1 problem, not just extra code. Revisit only
  if a concrete capability is genuinely missing, and name it before adding a
  runtime.
- [ ] **Step 2 — write the personas as real briefs**, in the same shape
  `personas.js` already expects. A persona that does not name which tools its role
  may use is decoration.
- [ ] **Step 3 — every outward action still goes through the same tiers.** A
  marketing agent gets no privileged path: `social_publish` is T3 for an agent
  exactly as for a human, and `SOCIAL_AUTOPOST_ENABLED`'s floor override applies.
  **An agent must never be able to raise its own ceiling** — test that explicitly
  by having a fake agent attempt it.
- [ ] **Step 4 — the support agent case is different and worse in one way.** A
  reply to a real customer is irreversible *and* time-sensitive, so the operator
  will be tempted to make it autonomous. Two mitigations: draft-only by default
  (`social_draft_create` T1, human sends), and if autonomy is ever enabled it is
  OD-3 option (b)'s hash-bound approval on a **fixed response library**, never on
  free-generated text.
- [ ] **Step 5 — outcomes are recorded honestly or not at all.** A mission that
  produced no measurable result reports none (AD-5). "Engagement up" with no
  measurement is the IRIS anti-pattern wearing a business hat.
- [ ] **Step 6 — live-verify** one real end-to-end run per role with a real
  outcome the operator can point at: a real drafted-and-approved post that went
  out, a real support draft, a real lead record written. One each, real, before
  claiming any of it.

## P11 — X/Twitter, LinkedIn pages, WhatsApp Business

- [ ] **Step 1 — X is a cost decision, not a technical one.** Research says no free
  tier for new developers as of Feb 2026, roughly $0.005/read and $0.015/post.
  Verify current pricing, then decide with real numbers from P4's analytics whether
  X is worth it at all. It may simply not be.
- [ ] **Step 2 — LinkedIn:** personal posting via `w_member_social` is free and
  achievable; **company pages need partner-gated Marketing Developer Platform
  approval**. Ship the personal path if it is wanted; treat pages as another
  P0-parallel-class calendar item, filed early if wanted at all.
- [ ] **Step 3 — WhatsApp:** the Business Cloud API bills per message, with replies
  inside the customer-service window free. **`whatsapp-web.js` and Baileys are
  banned for the same reason `instagrapi` is** — ToS-violating, high ban risk,
  unacceptable in a sold product. Note the parity build already resolved
  `phone_whatsapp_send` as an honest deep-link-open reporting `{opened:true,
  sent:false}`; that honest behaviour must not regress into a claimed send when a
  real API path lands beside it.
- [ ] **Step 4 — live-verify each** against a real account, or do not ship it.

---

## Licensing — folded into the parity build's step 6.5, not a competing gate

**Do not open a second licensing gate.** The parity roadmap's step 6.5 already
exists, is already live (the operator confirmed commercial intent on 2026-07-30),
already lists three operator decisions, and already names a wider audit surface
(Hermes-Agent, cua-driver, MediaPipe model assets, provider ToS for resale). This
plan adds items **to that surface** and changes nothing about the gate itself.

Additions for 6.5's audit list, from this plan's scope:

1. **AGPL-3.0 components (Postiz, Automatisch, Windmill core, MoneyPrinterV2).**
   The network-use clause is the specific hazard for a sold product reached over
   HTTP. **P5 is designed so none of these is needed** — that is the cheapest
   possible resolution and it should be preferred over any analysis. OD-2 is the
   decision.
2. **n8n's Sustainable Use License** — source-available, not OSI open source, with
   an explicit restriction on reselling it as a managed service. Same resolution:
   not needed.
3. **Mixpost** — the community "Lite" edition is permissively licensed but Pro and
   Enterprise are a paid perpetual licence, and it is a Laravel/PHP application,
   i.e. another whole runtime this repo does not have. Same objection the research
   correctly raised against Huginn's Ruby, and it applies here too.
4. **Any content-render engine's bundled assets** (P6 step 5) — MIT code with
   non-commercial voices, music beds or stock footage is the same class of problem
   as the openWakeWord weights, and it is easy to miss because the repo licence
   looks clean.
5. **Every platform's developer terms, specifically for a resold product.** Free
   API access for a product the operator charges for is a term to read, not to
   assume. The BYO-API-key architecture is a genuine licensing asset — the end
   user brings their own keys and accepts those providers' terms directly — and
   the social layer should preserve it deliberately: **MYTHOS should hold no
   platform credentials on the user's behalf.**

**Two hard limits on what any session may write here.** First, the AGPL
network-use question and the Sustainable-Use bundling question **need an actual
lawyer**; an hour of IP-lawyer time is cheap next to fixing this after launch.
Second — and this is the repo's own standing rule — **do not write a legal
conclusion into this or any tracked file.** A session may report what a licence
file says and what the code does. That is the whole permitted output. If a future
session finds a confident legal conclusion in this file, it was added in error and
should be removed.

---

## Research corrections — what to verify, and what looks wrong

The findings this plan was handed were gathered live and are mostly usable as-is.
These are the ones a session must not build on without checking. Correct entries
here in the same commit as the step that disproves them.

| Claim | Status | What to do |
|---|---|---|
| **"Shoutrrr, by the Coolify team, Apache-2.0, a social scheduler"** | **LIKELY WRONG — highest-confidence flag in this list.** `containrrr/shoutrrr` is a **Go notification-routing library** (Slack/Discord/Telegram/email — it is what Watchtower uses to send alerts), not a social-media scheduler, and it is not a Coolify project. The Apache-2.0 licence matches that library exactly, which is what makes the conflation plausible. | Treat as unusable until someone produces the actual repository URL and it turns out to be a scheduler. **Nothing in this plan depends on it** — P5 builds its own scheduler, which is why this being wrong costs nothing. |
| **YouTube: "a Dec-2025 change dropped an upload to ~100 units, uploads billed to their own daily bucket since June 2026"** | **UNVERIFIED** — post-dates this session's reliable knowledge and was not independently re-checked. Historically an upload cost 1,600 units of a 10,000/day default, i.e. ~6 uploads/day. | P2 step 3 verifies against the live quota docs and **measures the real cost observed**. The plan is deliberately written so P2 works either way; only a *volume* feature would depend on the cheaper number, and none is planned. |
| **Instagram: "200 calls/user/hour"** | **INCOMPLETE, and the gap matters.** That is the general Graph API call-rate shape. Content Publishing has a **separate, much lower per-account daily publish cap** (historically in the tens of posts per 24 h). | P9 step 3 must read both limits and design against the publishing cap, not the call cap. Conflating them designs in a bug that only appears in production. |
| **Reddit: "free tier 100 req/min and 10k/month"** | **PARTIALLY UNVERIFIED.** 100 queries/minute per OAuth client is consistent with the documented free tier; the 10k/month figure was not confirmed. | P3 step 2 reads the current rate-limit docs. Implement real backoff on the returned rate-limit headers rather than a hardcoded budget, and the exact number stops mattering. |
| **X/Twitter: "no free tier for new developers as of Feb 2026, ~$0.005/read, ~$0.015/post"** | **UNVERIFIED** (post-cutoff). Directionally consistent with the trend. | P11 step 1 re-checks pricing before any spend decision. X is last precisely so this never blocks anything. |
| **"AG2 is the actively-governed fork now that Microsoft put original AutoGen into maintenance mode"** | **Partially unverified.** AG2 (Apache-2.0) is real and is an AutoGen fork; the maintenance-mode claim was not confirmed. | Low risk — P10's recommendation is to add **no** Python agent framework, so this only matters if that recommendation is overturned. |
| **"Activepieces core is MIT (cleanest of the group)"** | **NEEDS A NARROWER CHECK.** Repos described as "MIT core" very often carry an `ee/`or `enterprise/` subtree under a separate commercial licence. | If Activepieces is ever actually considered, check the licence **per directory**, not per repository. Not currently needed. |
| **"Mixpost community Lite is MIT"** | Plausible, but the research omitted that Mixpost is a **Laravel/PHP** application. | Apply the same "whole extra runtime" objection the research correctly applied to Huginn's Ruby. This is an internal inconsistency in the brief, not a factual error. |
| **"Postiz self-host has a known open Instagram OAuth bug"** | Unverified here, and moot. | Moot: AGPL rules Postiz out for a sold product under OD-2's recommendation. |
| **instagrapi / whatsapp-web.js / Baileys are high ban risk and ToS-violating** | **Accepted as correct and treated as binding.** | Banned outright for anything shipped (P9 step 2, P11 step 3). Non-negotiable in a product that will be sold. |
| **MoneyPrinterTurbo's auto-publish routes through the paid Upload-Post SaaS** | Plausible and consistent with the operator's stated objection to paid middlemen. | P6 uses it as a **render engine only**. Even if the claim is stale, publishing through MYTHOS's own effectors is the right architecture regardless — it keeps AD-1's single execution surface intact. |

---

## Verification gates

Per-phase, in order. **Nothing advances on a green unit suite alone.** Run only
your own test files while working (`cd mythos && node --test test/<your-file>.test.js`);
a bare full-suite run concurrent with another one exhausts Windows fork limits and
produces fake failures.

1. **P0:** boot the real app with zero social credentials → boot succeeds, the
   social adapter reports `OFFLINE` with a real hint, `vault/Identity/
   capabilities.md` says so honestly, every other effector still registers, and
   every social tool returns a clean config error naming the exact env keys.
2. **P1–P3:** for each platform, one real outward action observed on the real
   platform, **plus** one rejected confirm that provably published nothing, **plus**
   exactly one tier-3 audit line per decision in `vault/Audit/<today>.jsonl`.
3. **P4:** an OFFLINE platform contributes `null`, not zero. Grep `metrics.js` for
   `Math.random()` → no hits.
4. **P5:** a real scheduled post fires and is observed. Mutate one byte of an
   approved payload → the publish refuses. Kill MYTHOS before a scheduled item
   fires → boot recovery reports failure honestly and does **not** double-post.
5. **P6:** render one clip with the engine installed; uninstall it and confirm boot
   is unaffected and the tool degrades with an install hint.
6. **P7:** authenticate from a real phone on the real LAN, drive a T3 tool through
   the confirm modal on a touch screen, and confirm the boot guard still refuses a
   non-loopback bind with no token.
7. **P8:** two real devices, one real room, one wake word → exactly one answers,
   the loser opens **zero** sessions. Then kill the server → exactly one (the
   primary) answers, the others show `DEGRADED` with the reason. Report real
   measured p50/p95 claim-to-grant, or report `null`.
8. **P9:** one real post per platform, observed, then deleted.
9. **P10:** one real outcome per role that the operator can point at.
10. **Ship gate:** parity step 6.5 closed **and** `/precheck` (Release Readiness
    Lead) → PASS or PASS WITH NOTES. Note that `/council` cannot convene on this
    machine (`~/.claude/agents/` holds 39 agents and zero `council-*.md`) — report
    that, never synthesize a verdict. Use the real installed reviewers
    (`code-reviewer`, `security-reviewer`, `silent-failure-hunter`, `debugger`),
    and dispatch `security-reviewer` on **every** phase that touches credentials or
    an outward publish path — that is P0, P1, P5, P7, P9 and P11 at minimum.

---

## Risk register

1. **An autonomous agent posting something damaging (highest).** Not a
   hypothetical: it needs only to be confidently off-tone once, in public, under
   the operator's real name, while nobody is watching. **Mitigation:** the five
   gates in the tiering section, of which hash-bound approval (gate 3) is
   load-bearing; `SOCIAL_AUTOPOST_ENABLED` false by default; a server-side daily
   publish budget the agent cannot raise; `social_pause_all` at T1 so stopping is
   always cheap; and OD-3 answered explicitly rather than drifted into.
2. **`write_file` can rewrite `mythos/.env` and therefore the safety config.**
   Verified in code, not speculated: `allowedRoots()` **always** includes the
   project root (`from-computer.js:44-49`) and `mythos/.env` is inside it, so a
   T3-approved `write_file` can flip `SOCIAL_AUTOPOST_ENABLED`. Config is read at
   boot, so it needs a restart to take effect — and `scripts/setup-autostart.js`
   plus the installer tooling make restarts available. **Mitigation:** treat this
   as a real finding to fix, not a footnote — either deny `.env` explicitly in
   `resolveSandboxed()`, or read the social safety flags from a location no effector
   can write. Fix before P1, because P1 is the first phase where it has teeth.
   Dispatch `security-reviewer` on the fix.
3. **Platform account bans.** Even official APIs suspend accounts for automation
   patterns that look inhuman. **Mitigation:** official APIs only; no private-API
   emulation ever (`instagrapi`, `whatsapp-web.js`, Baileys are banned); rate
   limits respected with real backoff off the response headers; per-account daily
   budgets; and the operator's real business accounts are the **last** thing
   connected, not the first (OD-4).
4. **Approval fatigue defeating the tier system.** An operator who confirms fifty
   posts a day will raise `AUTONOMOUS_MAX_TIER` and silently make every T3 tool
   autonomous. **Mitigation:** the tier-floor override (gate 2) so social T3/T4
   ignore that setting while `SOCIAL_AUTOPOST_ENABLED` is false, with a
   `docs/DRIFT-LOG.md` entry and an expiry per V2 §1; plus batch approval of a
   whole queue in one modal so the friction is proportionate to the risk rather
   than to the count.
5. **Licensing on a product that will be sold.** AGPL network-use and
   Sustainable-Use bundling are real obligations, not paperwork. **Mitigation:**
   fold into parity step 6.5; P5 avoids the question entirely by building on
   machinery this repo already owns; OD-2 decided explicitly; and **a lawyer, not a
   session, writes any conclusion.**
6. **Wake-word arbitration adding perceptible latency.** A 120 ms window is 120 ms
   the operator waits, every single time, on every device — including when only one
   device is present. **Mitigation:** skip the window entirely when exactly one
   surface is registered (the common case); measure claim-to-grant with
   `latency-tracker.js` and tune from real data rather than from this document's
   hypothesis; and treat the number here as a starting point, never as a result.
7. **P8's design being overtaken by the operator's own repo.** They said they may
   have already solved this. **Mitigation:** P8 step 1 is "read their repo" and it
   is not skippable. Building first and reconciling later wastes the work and
   insults the contribution.
8. **A third plan document drifting from the parity build.** This file could rot
   into exactly the split-spec problem the repo's one-plan rule exists to prevent.
   **Mitigation:** the parity roadmap wins on any overlap, stated at the top and
   again in RESUME HERE; nothing here is ticked while the parity roadmap's RESUME
   HERE still names step 6.5 or 7 (except the two `PARALLEL-SAFE` items); and this
   file's own Progress log is maintained to the same standard, including the rule
   that corrections to third-party findings land in the same commit as the step
   that disproved them.
9. **The product name changing after accounts and app reviews exist.** Renaming
   after Meta approves an app named MYTHOS means re-review, and every handle,
   OAuth app name and redirect URI carries the name. **Mitigation:** OD-1 decided
   before P0-parallel files anything. This is the cheapest decision in the
   document and the most expensive to defer.
10. **Fabricated success in a place strangers can see.** Every other honesty
    failure in this repo has been visible only to the operator. A claimed-but-absent
    post is visible to an audience. **Mitigation:** AD-4 applied without exception;
    "verified against a mock" written in those words in the Live-verified column;
    and the parity build's `{opened:true, sent:false}` precedent for
    `phone_whatsapp_send` treated as the standard, not the exception.

---

## Appendix CAP — Capability-pack integration (landed 2026-08-02)

This appendix records work that is **orthogonal to P0–P11** and does not touch
the sequence above. The operator asked to give MYTHOS twelve named upstream
capability packs. It lives here rather than in a fourth plan document (root
`CLAUDE.md` forbids one), but it is deliberately NOT a P-phase — it neither
blocks nor is blocked by the social/business/multi-device sequence, and ticking
it never affected any `Pn ☐`.

**What the twelve became.** Five were already vendored (caveman, ponytail,
taste-frontend, karpathy-guidelines, ui-ux-pro-max). The rest:

| Pack | How it was integrated |
|---|---|
| superpowers | 7 core skills vendored (`using-superpowers`, `brainstorming`, `writing-plans`, `executing-plans`, `systematic-debugging`, `test-driven-development`, `verification-before-completion`), each with a hand-written `SKILL-CORE.md` essence. MIT, LICENSE copied. |
| Agent-Reach | skill + references vendored; the CLI was already wired in `agent-actions.js`. |
| DesktopCommanderMCP | reached through the new MCP client as an `MCP_SERVERS` entry; boundary skill says which jobs stay on MYTHOS's own tools. |
| browser-use | MCP server entry; the built-in playwright adapter stays the deterministic default. |
| Strix | `from-strix.js` — `security_scan`, T3, hard `authorized_by` gate, degrades to an install hint. |
| OKF | `memory/okf.js` + `from-okf.js` — `okf_export`/`okf_list`/`okf_import` over `vault/Knowledge/`. |
| awesome-llm-apps | reference skill only (`llm-app-patterns`); no runtime dependency. |

**The load-bearing new piece** is the MCP **client** (`adapters/mcp-client/`,
`from-mcp.js`) — MYTHOS could expose itself as an MCP server (`mcp/server.js`)
but could not consume one. Tools are namespaced `mcp__<server>__<tool>` (a
collision would silently re-tier a real tool, since `TIER_TABLE` keeps the last
duplicate); every call is T3 because an MCP server is not sandboxed by MYTHOS;
results are `unverified` because the server's report is not independent evidence.

**Outstanding live-verify (the honest gap).** Everything above is unit-green,
and the MCP client is tested against a real stub server over real pipes — but no
step here has been run against a *real installed* Desktop Commander, browser-use
or Strix. Per this file's own honesty rules, that is the remaining work before
any of the three runtime integrations may be called "verified": boot the real
app, configure one `MCP_SERVERS` entry, confirm `mcp_list_tools` returns the
server's real tool list and one `mcp_call_tool` round-trips; for Strix, one
authorized run against a target the operator owns.

**Licensing note (records what upstream states, not a legal conclusion — the
step-6.5/6.6 gate still owns that call):** only superpowers and Agent-Reach text
is redistributed, both MIT. The four non-skill packs redistribute no upstream
source — MYTHOS ships its own adapter code and its own authored skill docs, and
fetches the tools at runtime. See `THIRD_PARTY_NOTICES.md`.

### CAP-2 — Build routing by deliverable kind (landed 2026-08-02)

The follow-on the operator asked for after CAP: vendoring thirteen skills made
them *resolvable*, but the build router still knew only two deliverable kinds
(`ui`, `code`), so only four of the ~19 skills could ever shape a build. This
step re-routes builds by a finer classification.

**The distinction the change is built on.** A skill reaches a build by exactly
one of two levers, and they are not interchangeable:

* **Essence skills** — guidance the build model *follows*, injected as text by
  `packBlockFor()`. `taste-frontend`, `ui-ux-pro-max`, `ponytail`,
  `karpathy-guidelines`, and the superpowers methodology skills.
* **Tool-driver skills** — guidance on how to *run* an external tool
  (`agent-reach`, `strix-security`, `browser-use`, `desktop-commander`,
  `okf-knowledge`). Their value in a build is running the tool and injecting the
  **result**, the way `ui-ux-pro-max/scripts/search.py` already works. Pasting
  such a doc into a one-shot artifact prompt does nothing — the model cannot
  execute a paragraph.

**What landed.** `classifyDeliverable()` now returns `ui` → `research` →
`security` → `app` → `code`, first match wins (visual briefs win outright; a
"secure login screen" is a UI build that mentions auth). `PACKS` gained `app`
(adds `systematic-debugging` + `verification-before-completion`), `research`,
and `security` (adds `strix-security`). `ROUTES` gained a `research` entry that
runs the `agent-reach` CLI and injects its findings. `packBlockFor()` gained a
composed-block budget cap (`MAX_PACK_CHARS` 8000) that drops lowest-priority
essences **and names what it dropped** rather than shrinking silently.
`hermes-runner.js` now classifies non-website Forge builds from the brief
instead of collapsing them to `code`, and runs the tool route for whatever kind
it resolved.

**`test-driven-development` is deliberately not in the `app` pack** — a
red→green loop has no meaning in one-shot artifact generation, so injecting it
would be discipline the model can only pantomime.

**Strix stays a post-build offer, not a generation-time route.** It scans a
target that already exists, so it cannot run while the artifact is being
generated. Its essence primes the model; the scan itself remains the
`security_scan` effector the brain invokes afterwards under its `authorized_by`
gate. A note in `build-pack.js` records this so no later session wires it as a
generation-time tool and wonders why it does nothing.

**One deviation from the written plan, and why.** The plan said no change to
`agent-actions.js`. Its two call sites pass *every* card through
`resolveSkillTool()` as the design-system slot (their `designSystem` flag is a
dependency-present check, not a UI check), and relied on it returning `null` for
non-UI briefs. With a `research` route that is no longer true: a research-shaped
card would have fetched `agent-reach` there **and** again in
`socialResearchForBuild()` — paying twice and injecting twice. Both sites now
call a named `resolveDesignSystemTool()`, which keeps that path byte-identical
to its previous behaviour.

**Verified.** `test/skills-build-pack.test.js` extended (12 pass): the finer
kinds and their precedence, each new pack's contents, the three new essences
loading, the budget cap truncating *with* a notice, and the research route
degrading to `null` when `agent-reach` is absent. Full suite `2428 tests /
2427 pass / 0 fail / 1 skip`; `sync-test-count.js --write` committed.
**Live spot-check** (real `hermes-runner.runBuild`, stubbed only at the Hermes
CLI boundary so no credits were spent): the app-shaped build's prompt carries
`ponytail` + `karpathy-guidelines` + `systematic-debugging` +
`verification-before-completion` (6,604 chars), the website build still carries
`taste-frontend` and a real `search.py` design system (6,922 chars), and the
security build carries `strix-security` (4,743 chars). The research block is
absent on this machine because `agent-reach` is not installed — the intended
degradation, and therefore **the one thing here that is not live-verified**: the
`RESEARCH FINDINGS` injection has never run against a real `agent-reach`.
