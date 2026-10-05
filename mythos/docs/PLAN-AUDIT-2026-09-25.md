<!--
Preserved as evidence for the Stage 1 repair campaign (mythos/Plans/MYTHOS-IRIS-Synthesis-Plan.md,
section "STAGE 1 REPAIR CAMPAIGN"). Written 2026-09-25 by an independent Codex audit against
main at f456217d, and copied here unchanged from the gitignored .cache/plan-review/ so it
cannot be lost. It is a record of findings, not a plan; the campaign section is the plan.
Line numbers in it refer to f456217d.
-->

# MYTHOS audit report — 2026-09-25

**Rev 6 misses material authority, memory-integrity, verification, and integration risks. No runtime code was changed.** This report supersedes the draft-plan deliverable for the current request: findings only, with no fixes implemented.

## Scope and confidence

Reviewed the supplied rev 6 and its affected source paths, existing tests, generated inventory, roadmap/spine, and verification scripts. Source baseline was local `origin/main` at `f456217d0d7c177ef090b095790e2a46dd3f9489`. No fetch was performed; this identifies an exact local snapshot rather than guaranteeing the latest remote state. The opened checkout is older, so source locations below refer to that SHA, not necessarily the current files on disk.

Read-only Node probes loaded existing source directly from Git into memory. Authority probes used pure functions; lesson-store probes used an in-memory filesystem and a simulated write failure. No test source was created. No operator vault was changed, no app was restarted, no paid API call was made, and no live security exploitation was attempted. The only artifacts written were Markdown documents under project-local ignored `.cache/plan-review/`.

Confidence labels:

- **Reproduced:** the described result was observed in a bounded in-memory probe of the inspected source.
- **Source-confirmed:** the relevant execution path or existing regression expectation was traced, without a fresh end-to-end run.
- **Unverified risk:** a plausible failure requiring additional runtime evidence; not presented as an established incident.

This is a targeted audit of the plan and affected code, not a complete repository penetration test, dependency vulnerability scan, or fresh full-suite certification. The generated map records 8,370 tests; this review did not rerun them. No independent subagent review was performed.

## A. Highest-priority code findings

### F01 — P1: Explicit prohibition passes the action-authority check

**Reproduced.** `mythos/src/core/voice/operator-authority.js:137` accepts `Please do not click that button` with `{proceed:true, reason:'operator-request'}`. The denial patterns recognize objections such as “I didn't ask,” but not this direct prohibition; the word “Please” satisfies request detection.

`authority-gate.js:139` calls this check for trusted actions, and `:183` allows a proceeding verdict through. This matters when a model proposes a click despite the prohibition and the leash's human-presence premise is the reason it was initially allowed. This is not a claim of unauthenticated remote execution or bypass of every leash restriction.

**Missing protection to verify:** direct prohibitions, contractions, quoted prohibitions, mixed positive/negative clauses, and the complete trusted-action dispatch path. Rev 6's short-command repair does not explicitly cover this opposite failure.

### F02 — P1: A question can authorize an unrelated action

**Reproduced.** `Could you explain why this happens` returns `{proceed:true, reason:'operator-request'}` from the same check. The authority function receives words and timing, not the proposed tool, operation, or target. Its caller at `authority-gate.js:139` does not pass those details.

A request for explanation therefore satisfies the action gate if a model also proposes a trusted click/type/key action. The current contract checks request-like language, not authorization for that action.

**Missing protection to verify:** explanation-only requests, wrong verbs, wrong targets, and stale continuation words against a concrete pending operation. Fixing only four-word commands leaves this route intact.

### F03 — P1: Explicit memory request permits different content

**Reproduced.** With operator text `Remember my favorite color is blue` and proposed saved text `My favorite color is green`, `judgeMemoryWrite()` returns `{proceed:true, reason:'operator-request'}`.

At `operator-authority.js:192`, checks cover request form, negation/hypothetical language, length, and unsupported numbers. They do not bind nonnumeric saved content to the actual request. `authority-gate.js:183` and `:248` mint consent after this verdict. Argument-bound consent authenticates the selected payload, but cannot repair a mistaken decision to authorize that payload.

**Missing protection to verify:** altered names, colors, relationships, negated preferences, added facts, and translated/paraphrased content. Rev 6's read-back work must not ignore the explicit-request path.

### F04 — P1: Wrong-target question can mark a click proposal presented

**Source-confirmed; existing test preserves the limitation.** `authority-gate.js:94` accepts an action question without matching its target when the proposal has no textual payload. `test/bug-461-464-ask-before-acting.test.js:679` creates a click on `ref:'e9'`, supplies “Shall I play the other video instead?”, and asserts that the original proposal becomes presented.

This is particularly important because an ordinary later affirmative can authorize the stored action. Token/argument binding does not prove that the operator heard a description of those arguments.

**Missing protection to verify:** human-readable target identity tied to the same proposal, stale refs, wrong video questions, and reissued calls after presentation. The green test documents a known gap; it does not certify safe target consent.

### F05 — P2: “Exact read-back” currently means partial English word overlap

**Reproduced at helper level; source-confirmed at caller.** `speechCovers()` uses a 0.6 threshold and English alphabetic words of four or more characters (`operator-authority.js:211`). The helper returns true for “I will not remember your favorite color is blue” against proposed “Your favorite color is blue.”

`presentedBy()` adds an action-question check, so this helper result alone is not an end-to-end save reproduction. However, neither word overlap nor the caller's substring fallback establishes exact meaning, polarity, numeric values, or heard audio. Non-Latin read-back also has a different path because of the ASCII tokenization. `authority-gate.js:204` derives presentation from assistant text at turn completion, without a playback-completion signal in that method.

**Missing protection to verify:** conflicting numbers/names, omitted clauses, negation, Bengali/Hindi, and interrupted read-back before affirmative consent.

### F06 — P1: Different failure records for the same goal overwrite each other

**Reproduced.** `mythos/src/core/memory/lessons.js:85` chooses a topic from the goal title or tool name; `:144` uses the sanitized topic as the filename. Deduplication at `:176` instead uses tool, arguments hash, and goal title.

Two different triggers under `Build application` were recorded with different command arguments. Result: one file, the first trigger no longer found, the second present. The second write replaces the first because storage identity is weaker than deduplication identity. Sanitization/truncation can create further filename collisions, though those variants were not separately exercised.

**Impact:** failure history can disappear during normal recording, undermining recall and learning. Rev 6 discusses read latency but misses this data-integrity failure.

**Missing protection to verify:** different tools/arguments under one goal, normalized-name collisions, and both records surviving restart/export.

### F07 — P2: Failed lesson update returns a success-shaped result

**Reproduced.** In the existing-trigger branch of `lessons.js:176`, the return from `write(...)` is ignored. With a simulated write failure, `recordFailure()` returned `count:2`, a reference, and `isNew:false`, while the persisted record remained at count 1.

The lower-level write emitted `memory-write-failed`; the failure is therefore not completely silent. It is nevertheless missing from the caller's returned result. A future cache could make the discrepancy permanent if it updates from this success-shaped return.

**Missing protection to verify:** propagation of degraded writes, unchanged cached state after failure, and accurate counts on the next read.

### F08 — P2: Equivalent argument objects get different dedup hashes

**Reproduced.** `lessons.js` hashes `JSON.stringify(args)`. `{x:1,y:2}` and `{y:2,x:1}` produce different hashes. The existing “hash stability” test repeats the same property order.

**Impact:** reordered JSON arguments can split the identity of the same action. Combined with F06, a miss in deduplication can overwrite an existing topic instead of incrementing it. Whether particular callers currently reorder keys was not established.

**Missing protection to verify:** semantic object equivalence, nested objects, and the intended distinction between ordered arrays and unordered object fields.

### F09 — P1: Result delivery has competing owners

**Source-confirmed; aligns with the reported BUG-457 incident.** When a turn generation changes, `live-tool-adapter.js:506` reaches a `late-for-turn` notice at `:598`. The caller still appends a function response. At `:836`, a rejected response can also invoke `reportLateOutcome()` for held replies.

These are distinct routes for the same result, without a shared final-result disposition in the inspected paths. A turn change can therefore trigger a notice plus attempted tool response; rejection introduces another late-result route. The source confirms the competing ownership, but this audit did not run a new live cancellation/rotation trial.

**Missing protection to verify:** completion at the deadline, turn close, typed release, spoken cancellation, socket replacement, reused call IDs, rejected send, and cleanup. A call-ID boolean alone would not settle all these cases.

### F10 — P1: Playback claims are deliberately invisible to the checker

**Source-confirmed; existing test preserves the gap.** `test/bug-448-460-a-claim-is-judged-by-what-it-claims.test.js:180` asserts no detected claims for “The video is playing now” with no action evidence, and for “It should be starting up now” after a click.

Separately, `claim-check.js:196` documents that tool-name backing can excuse a claim about the wrong target. `window-control` at `:170` also omits `browser_tabs`, matching the reported false-retraction residual.

**Impact:** both false success and false retraction remain possible. Adding metadata coverage does not solve missing claim categories or target/effect verification.

**Missing protection to verify:** actual playback evidence, wrong-target success, list-versus-close operations, and operator-confirmed playback provenance. These are known gaps, not newly introduced regressions proven by this review.

### F11 — P2: Conversation history serializes objects as “[object Object]”

**Source-confirmed, already filed as BUG-466; omitted from rev 6.** `mythos/server/index.js:1122` joins `memory.fs.readLines(...)` results. The current ticket at `BUGS.md:3525` documents parsed objects and the downstream JSONL parser discarding them.

**Impact:** the panel loses the day's historical Episodic rows while its rolling session portion can still appear functional.

**Missing protection to verify:** real writer → HTTP history → transcript model → rendered historical turn, preserving the recently merged local-day behavior. This audit did not perform a new live route call.

### F12 — P2: Goal “active” uses the wrong predicate

**Source-confirmed.** `mythos/src/core/effectors/goals.js:272` counts `!g.done` as active. This cannot distinguish paused work from active work and matches BUG-470.

**Missing protection to verify:** canonical status through both greeting and HUD consumers, mixed states, stale Goals.md rows, and unavailable status. Replacing a bad count with an invented zero would create a different false report.

### F13 — P2: Reflection saves model-derived summaries as durable preferences/profile

**Source-confirmed, matching BUG-463's residual.** `identity/reflection.js:74` consumes conversation summaries/snippets; `:136` persists model-selected preferences; `:147` writes style; `:156` replaces the profile. Turning off the separate automatic user-facts route does not turn off this writer.

**Impact:** inferred or summarized material can remain in durable prompt state. Cue filtering over these summaries would still not establish that the operator personally issued the cue.

**Missing protection to verify:** original speaker/turn provenance, quotations and hypothetical preferences, negative preferences versus refusal to save, shutdown timing, and revocation across both identity and semantic stores.

## B. Duplicate responsibility and future maintenance risks

These are traced design risks, not a claim that all duplicated code should be removed.

1. **Outcome narration exists in several branches.** Immediate results, late-for-turn notices, late outcomes, and cancellation/release paths rebuild overlapping meanings. F09 shows why changes at one site leave siblings inconsistent. Any consolidation must preserve failed, unverified, aborted, and partially confirmed distinctions.
2. **Authority policy is split across layers.** Request interpretation, proposal presentation, affirmative matching, registry signatures, and consent minting each enforce different parts. A strong signature can coexist with weak intent/presentation checks, as F01–F05 show.
3. **Durable personal state has multiple writers.** User facts, reflection preferences, profile/style, and explicit memory saves have different gates. Patching one writer does not guarantee the others obey the same policy.
4. **Claim backing duplicates tool knowledge.** Static category lists and broad name-based backing drift when tools add operations. Blanket metadata declarations can reproduce the same drift in another file.
5. **Goal metrics have competing definitions.** Markdown completion state and runtime goal status answer different questions under the same “active” label.
6. **Old comments contradict later corrections.** The backstop file retains an ordering-clamp justification followed by a later explanation that the clamp was wrong and removed. Runtime behavior must win over old comments. A “cleanup” based only on the earlier rationale could reintroduce the bug.
7. **Lesson caching adds consistency obligations.** The store also prunes, exports, reports stats, and supports imports/sync around the wider vault. “Only update on writes” is insufficient. External-writer behavior was not exhaustively traced and must remain an open question.

## C. Confirmed plan and tooling mismatches

| Finding | What inspection established | Consequence |
|---|---|---|
| Inventory | Generated map has **35 open**, not 34; BUG-466 is extra. | Rev 6 is not a complete closure inventory. |
| Baseline | Local origin/main is 34 commits ahead of the checkout; map records 8,370 tests. | Old SHA/count assumptions cannot anchor execution. |
| Resume drift | RESUME still asks for merges already present in inspected history. | Check ancestry rather than replaying stale instructions. |
| Setup | `setup-worktree --check` does not create links; current manifest has eight. | Rev 6's fresh-worktree recipe is incomplete. |
| Isolation | Setup shares dependency/model directories and copies secrets separately. | Worktree isolation does not imply all filesystem writes are isolated. |
| Paths | Current ticket file is root `BUGS.md`; runbook is root `docs/live-verification-runbook.md`. | Resolve actual paths instead of inconsistent prose shorthand. |
| Grader mutation | `verify-live.js:41` writes `mythos/vault/Verification`. | Conflicts with rev 6's no-vault-write constraint. |
| Promotion parser | `verify-live.js:210` expects `### BUG-ID:` plus immediate Status; current tickets use `## BUG-ID —` and OPEN WORK. | Manifest registration alone cannot perform the promised promotion. |
| Evidence statuses | Parse errors and unexercised scenarios were both mapped to not-exercised. | Broken evidence could be hidden as a missing scenario. |
| Gate replay | Recorder keeps rounded RMS, gate flags, and clocks, not PCM/playback amplitude/effective tuning. | Cannot prove acoustic echo separation or replay the exact complete live decision from that corpus alone. |
| Barge diagnosis | Capture-suspended frames return before observation; own-voice-held frames normally reach it. | “Not fed during own-voice hold” is an incomplete hypothesis. Zero vetoes does not prove policy was never evaluated. |
| Release oracle | Rev 6 demands every hold end naturally while adding successful barge-in. | Correct interruption would fail its proposed oracle. |
| Language claim | Current API schema exposes input transcription language hints. | Output-language documentation cannot establish input pinning impossibility. |
| Typed versus spoken | Golden-path script drives WebSocket turns. | Its PASS does not prove microphone/wake-word/acoustic behavior. |
| Latency | Three 100 ms frames consume about 300 ms before further work. | Existing threshold path conflicts with a 250 ms stop target; ticket repair is not qualification. |
| Branch strategy | Independent flat branches share contracts; post-proof rebasing changes candidates. | Final integration evidence cannot automatically bless intermediate main commits. |
| Closure forecast | Multi-residual tickets, missing prerequisites, and accepted limits remain. | “34 → 3 or 4” and one 45-minute sitting are not evidence-backed promises. |

Google's [Live API reference](https://ai.google.dev/api/live#AudioTranscriptionConfig) currently lists `languageCodes[]` as transcription hints. Its [capabilities guide](https://ai.google.dev/gemini-api/docs/live-api/capabilities) discusses native output-language selection separately. Support and benefit on the configured model/API version remain untested; one accepted or rejected request would not establish multilingual quality.

The project-local worktree avoids the untracked research-draft collision. Deleting that file or switching the user's existing checkout is not required for isolated work.

## D. Untested and insufficiently tested areas

The reviewed tests do exist; this is not an assertion that whole modules have no coverage. The gaps are that some tests assert known limitations, some use simpler shapes than the real boundary, and some requirements need hardware/operator evidence.

| Area | Missing or inadequate evidence |
|---|---|
| Action authority | Direct prohibition and unrelated explanation request through real dispatch; proposed-action semantics are absent from the pure checker. |
| Memory authority | Changed nonnumeric content despite an explicit request; partial/negated/multilingual read-back; actual heard presentation. |
| Click confirmation | Existing known-gap test explicitly allows wrong-target presentation. |
| Claims | Existing known-gap test explicitly expects playback claims to go undetected; wrong-target tool backing remains documented. |
| Lesson identity | Existing stability test does not compare property order; same-goal/different-trigger overwrite and failed-update return need behavioral regressions. |
| Result ownership | No new runtime reproduction here for cancellation plus turn close plus socket rotation; isolated hold tests do not prove integrated single delivery. |
| Acoustic behavior | Need synchronized effective tuning, gate reason, observed callback path, player state, and operator-labeled interruption/echo controls. |
| History | Unit transcript strings do not certify the HTTP producer's actual shape; real boundary test is required. |
| Shutdown/containment | Complete log line does not prove process exit, survivor cleanup, successful restart, or next-turn recovery. |
| Session grading | Rotation, truncation, midnight boundaries, partial JSONL, concurrent processes, duplicate windows, and build identity need fixtures. |
| Prompt preferences | Old fact surviving ordinary-fact churn does not test preference overflow, contradiction, forget, or current Live setup refresh. |
| Release qualification | One typed or attended session cannot establish the required spoken streak across cold boots and a week. |

## E. Remaining questions, not confirmed defects

- The precise cause of the reported 2.7-second Lessons stall remains unmeasured here. Repeated directory/file reads are visible; antivirus causation is not established.
- Whether media capture suspension or player speaking state explains the 09-25 barge-in failure needs replay/correlated runtime data.
- Whether documented input language hints work on the configured Live model is unknown.
- The proposed ten-minute presence window is an invented default unless an operator decision or existing policy supplies it. Presence must not replace action permission.
- A capped preference block cannot keep an unlimited number of explicit preferences always visible. Overflow and conflict semantics need a decision.
- A forced “Noted” message from delayed reflection can conflict with the no-unsolicited-speech work. Current intended behavior is underspecified.
- Refusing `expect` strings because they “sound descriptive” risks rejecting valid visible text. The plan lacks a deterministic contract.
- An external browser is not intrinsically uncontrollable. Actual extension/CDP/task ownership determines that capability.
- BUG-451 has both prevention evidence and existing-data disposition; it should not be classified as solely a decision ticket.
- `/kee` has no exposed matching skill in this session; no extra authority was inferred from it.

## Recommended audit disposition

Treat rev 6 as **not execution-ready**. The immediate blockers are authority semantics, memory integrity, result-delivery ownership, and truthful verification/promotion. Resolve or explicitly retain their limitations before claiming comprehensive closure.

Do not count F01–F13 as thirteen newly discovered tickets: several are already registered residuals or known-gap tests. F06–F08 are additional reproduced lesson-store behaviors absent from the supplied plan; duplicates elsewhere in the entire historical registry were not exhaustively ruled out. No ticket numbers were allocated and no statuses were changed.

The working tree's pre-existing untracked research draft remains untouched. No implementation, commit, merge, push, tag, or production configuration change was made.
