# RESUME — read this first, every session

*Under 100 lines, by rule. The roadmap is the archive; this file is the position.
Rewrite in place, never append.*

## Position (2026-10-05)

**One workflow, until it is boring.** Stage 1 only. Stages 2 to 7 stay paused until the
golden path holds 10 consecutive PASS lines across two cold boots for a week.
**Streak: 0.**

**Standing rule (operator, 2026-09-25, every project): `main` is always the last
known-good build.** Every change is made on its own branch and tested there. Tested
means the full suite green AND the app run and used. Only then is it merged, and each
good `main` is tagged `good-YYYY-MM-DD`. Merges are the operator's click; the
session's permission check refuses `gh pr merge`.

**Bundle A (operator, 2026-10-05: "one tested bundle"; repairs land before the security
bundle #143; Codex reviews).** Branch `fix/stage1-bundle-2026-10`, worktree
`.claude/worktrees/stage1-bundle`, from `main` `f456217d`. It merges, with merge commits
in C1 row 10/19 order, #124 S1, #125 S2, #126 B1, #127 B2a, #128 B1b, #131 (with #129,
#130) and B2c `36b0a32e` (no PR of its own), then #123's documents; every head verified an
ancestor. Two hand resolutions: `s2s-bridge.js` (#126 × #128, both kept on the stop door)
and BUGS.md's 460/461 table rows. Baseline `f456217d` 8370/8370/0/0 on a quiet host (two
earlier runs under host load failed one timing test each: BUG-379's netstat lookup and
BUG-354's 30 ms fake handshake, each now its own task); bundle 8509/8509/0/0, five docs
gates exit 0. The working plan for finishing is plan-mode file
`~/.claude/plans/i-have-20-or-elegant-lagoon.md` (rev 3, Codex-reviewed twice). The
`good-2026-09-25` tag is `ae88f424` and is never moved.

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

Bundle A: desktop app started from the candidate (typed turn, clean quit), then its
Codex packet, push and PR on the operator's go-ahead. Then Bundle B on A's tip, one
branch each: golden-path verdict (an observed FAIL must outrank PREREQ-MISSING;
`golden-path.js:126` ranks it below), spoken-run evidence capture, 466, 470, B4
(468/471/A3), B2d (457), B3, B5, B6 prep. Sitting 1 targeted for 2026-10-08. Not yet
exercised live: web_search, recall_memory, crash containment, and every bundle-A change.

## Where the detail lives

Archive: `MYTHOS-IRIS-Synthesis-Plan.md` (roadmap, and the campaign section at its end),
`-V2-spine.md` (source-level), `MYTHOS-Post-Parity-Plan.md` (post-step-7). Defect
evidence: `BUGS.md`. Attended runs: `.cache/windows-operator/attended-2026-09-23/`, `-24/`
and `-25/` (gitignored, this machine only). The 09-25 mic-gate recorder windows are in
the rev4-28 worktree's `.cache/voice-gate-recorder/`.
