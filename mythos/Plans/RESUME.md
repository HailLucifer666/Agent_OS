# RESUME — read this first, every session

*Under 100 lines, by rule. The roadmap is the archive; this file is the position.
Rewrite in place, never append.*

## Position (2026-09-26)

**One workflow, until it is boring.** Stage 1 only. Stages 2 to 7 stay paused until the
golden path holds 10 consecutive PASS lines across two cold boots for a week.
**Streak: 0.**

**Standing rule (operator, 2026-09-25, every project): `main` is always the last
known-good build.** Every change is made on its own branch and tested there. Tested
means the full suite green AND the app run and used. Only then is it merged, and each
good `main` is tagged `good-YYYY-MM-DD`. Merges are the operator's click; the
session's permission check refuses `gh pr merge`.

**Nine campaign PRs wait for Codex review, then the operator's merge**, in this order
(C1 rows 10 and 19): #123 this docs branch, #124 S1 `f819adac`, #125 S2 `eab6c27a`,
#126 B1 `9f459d12`, #127 B2a `6311ebee`, #128 B1b `f8071071`, #129 B2b-1 `a99329cd`,
#130 B2b-2 `c49c8ec9`, #131 B2b-3 `01cd1439`. #129–#131 are stacked, so each merges after
the one before; the rest sit on `main` `f456217d`. All rewrite the generated docs, so before its merge each later one is
updated from `main`, regenerated and re-run. The `good-2026-09-25` tag is `ae88f424`
and is never moved; `f456217d` is not tagged yet (operator's go-ahead after a smoke run).

**Attended 2026-09-25 (build fee97e18, 37 turns): the build works, and the week's fixes held live.** The mic reopened early in 0 of 41 holds (20 of 50 on 09-24); 11 chimes at 0.6 s; 7 held replies clean; the memory lock and "ask first" held, and a spoken "no" was honoured; the Gmail line was one plain sentence; resume returned the right answer; the goAway rotation and the quit were clean. **Found**, each in BUGS.md with times: talking over MYTHOS does not stop it (BUG-469); two retractions of true actions (448); "yes, refresh the page" not taken as a yes (461); the read-back skipped (464); a double delivery and six screen_look cut-ins (457); English transcribed as Spanish twice (447); a 2.7 s low-CPU stall on a Lessons read (436); paused goals counted active (BUG-470); video clicks miss (BUG-471); unrelated skills and think_deeply overuse (BUG-472).

## The repair campaign (the working plan)

**`MYTHOS-IRIS-Synthesis-Plan.md`, section "STAGE 1 REPAIR CAMPAIGN"** holds the whole
plan: every contract, the audit findings F01–F13 mapped to batches, the additions A1–A7,
the operator's decisions with their sources, the review gate, and a progress log. The
audit itself is `mythos/docs/PLAN-AUDIT-2026-09-25.md`. It found that the "ask first"
check approves "Please do not click that button", approves a click after "Could you
explain why this happens", and would save "green" when the operator said "blue" — so
those are fixed before any attended sitting.

Order: B0 → **S1** (F01–F05, authority and consent) → S2 (F06–F08, lesson records) →
B1 (469/406/455) → B2 (448/460/461/457) → B3 (464/463/472) → B4 (468/471) → B5
(436/470/446/466) → B6 (447, a capped language-hint trial) → B7 (one guided sitting and
targeted retries) → B8 (the operator's merges, then the Stage 1 week). One `fix/`
branch per change; Claude builds, Codex reviews each branch before the operator merges.

B0 done 2026-09-25: base `f456217d`, worktree `.claude/worktrees/stage1`, baseline
8370/8370, 0 fail, 0 skipped, runner exit 0, five docs gates exit 0, 35 open. S1, S2, B1,
B2a, B1b and B2b (in three parts) are built on their branches (campaign progress log).
B2 is split into B2a–B2d.

## The golden path

Spoken, in the operator's already-signed-in browser: **open YouTube, play the
third video, pause, resume, next.** Instrument: `cd mythos && node
scripts/golden-path.js`, once a day with MYTHOS up. It needs a debuggable browser
on 9222 before boot, or the model launches a fresh-profile one itself. **Its last line
is 2026-09-16 `PREREQ-MISSING`** — it has not run since. It sends typed turns, so a
PASS proves the browser path, not the microphone.

## Stages

- [ ] **Stage 1 — ACTIVE.** Bar: 10 consecutive attended spoken successes across
  two cold boots; p95 ack 2 s, local stop 250 ms, spoken cancel 1.5 s.
- [ ] **Stages 2-7 — PAUSED** by the 2026-09-07 decision until the streak holds.

## Gates

Pre-commit runs the full suite and blocks on `fail > 0`, nothing else — and it only
greps `# fail`, so also count top-level `not ok` lines yourself. The five
documentation gates are `cd mythos && npm run docs:check`, with the suite's TAP
piped in. Regenerate `index.html` BEFORE the counting run; read each gate's exit
directly. A long-form TEMP is required (8.3 short form fakes `fail=2 skipped=1`).
In `BUGS.md`'s OPEN WORK register, FIXED/RESOLVED/CLOSED/SATISFIED anywhere in a
bullet closes that ticket. CI is manual dispatch: once, on a final commit.

## Operator decisions

All answered (campaign C1 rows 4 and 9–19, with sources). Added 2026-09-26: a delivered
click backs "I clicked", and a delivered open backs "opening it now"; "it's playing" needs
the player's reading or the operator's own words, else "not confirmed". Still the operator's:
**tag `f456217d`** after its smoke run, and each merge click. **Operator actions:** delete
BUG-451's two remaining records by hand (C1 row 12); say "forget the note about bugs
439" (sessions do not edit the vault); re-authorise Gmail (`invalid_grant`) if a sitting
needs it; confirm the Mistral console is on the free tier; the wake-word licence goes to a lawyer.

## NEXT ACTION

**B2c** (BUG-461, C1 rows 8 and 15): short commands whose own words name the action.
First measure, read-only, which Bengali and Hindi words the transcriber actually returned
in the operator's sessions, and bring the operator a proposal before changing how they are
treated; until then they keep asking first. Then B2d (457: one delivery record per result),
then B3. Owed at B5: the typed path still treats a delivered click as unbacked. Not yet
exercised live: web_search, recall_memory, crash containment, and every B1b/B2b change.

## Where the detail lives

Archive: `MYTHOS-IRIS-Synthesis-Plan.md` (roadmap, and the campaign section at its end),
`-V2-spine.md` (source-level), `MYTHOS-Post-Parity-Plan.md` (post-step-7). Defect
evidence: `BUGS.md`. Attended runs: `.cache/windows-operator/attended-2026-09-23/`, `-24/`
and `-25/` (gitignored, this machine only). The 09-25 mic-gate recorder windows are in
the rev4-28 worktree's `.cache/voice-gate-recorder/`.
