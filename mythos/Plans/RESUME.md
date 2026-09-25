# RESUME — read this first, every session

*Under 100 lines, by rule. The roadmap is the archive; this file is the position.
Rewrite in place, never append.*

## Position (2026-09-25, evening)

**One workflow, until it is boring.** Stage 1 only. Stages 2 to 7 stay paused until the
golden path holds 10 consecutive PASS lines across two cold boots for a week.
**Streak: 0.**

**Standing rule (operator, 2026-09-25, every project): `main` is always the last
known-good build.** Every change is made on its own branch and tested there. Tested
means the full suite green AND the app run and used. Only then is it merged, and each
good `main` is tagged `good-YYYY-MM-DD`. Merges are the operator's click; the
session's permission check refuses `gh pr merge`.

**Nothing waits to be merged.** #118, #121, #122, #104, #101, #119 and #120 are all in
`main`, which is `f456217d`. The `good-2026-09-25` tag is `ae88f424` (after #122, before
the last four) and is never moved; `f456217d` itself is not tagged yet. A new tag waits
for the operator's go-ahead after a smoke run of that exact commit.

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
8370/8370, 0 fail, 0 skipped, runner exit 0, five docs gates exit 0, 35 open.

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

## Operator decisions owed

- **Presence window (before B5's BUG-446 fix):** how recently must the operator have used
  MYTHOS to count as "present"? Background goal work runs only while present (decided);
  the window is not. Ten minutes is a suggestion, not a decision.
- **BUG-451's three vault records** stating a false cause: remove, quarantine or keep?
- **Tag `f456217d`** once its smoke run is done.
- **Operator actions:** say "forget the note about bugs 439" (a stale fact; sessions do not
  edit the vault). Re-authorise Gmail (`invalid_grant`) if a sitting needs it. Confirm the
  Mistral console is on the free tier. The wake-word licence question goes to a lawyer.

Answered 2026-09-25 (campaign C1 has the sources): the 02:11:40 "Okay" was said; no video click
played; the identity writer saves on cue words and says so; the auto note-taker is off; short
commands whose own words name the action run without asking.

## NEXT ACTION

**S1** on `fix/s1-authority-consent`, from `f456217d`: a prohibition, an explanation
request, changed memory content, a wrong-target question and an unheard or partial
read-back must each authorise nothing, proven through the real adapter, registry and
dispatcher. Then S2 (the lesson store overwrites its own records, reports a failed write
as success, and hashes arguments by key order). Not yet exercised live: web_search,
recall_memory (436's CPU fix) and crash containment.

## Where the detail lives

Archive: `MYTHOS-IRIS-Synthesis-Plan.md` (roadmap, and the campaign section at its end),
`-V2-spine.md` (source-level), `MYTHOS-Post-Parity-Plan.md` (post-step-7). Defect
evidence: `BUGS.md`. Attended runs: `.cache/windows-operator/attended-2026-09-23/`, `-24/`
and `-25/` (gitignored, this machine only). The 09-25 mic-gate recorder windows are in
the rev4-28 worktree's `.cache/voice-gate-recorder/`.
