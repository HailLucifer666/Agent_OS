# RESUME — read this first, every session

*Under 100 lines, by rule. The roadmap is the archive; this file is the position.
Rewrite in place, never append.*

## Position (2026-09-25, night)

**One workflow, until it is boring.** Stage 1 only. Stages 2 to 7 stay paused until the
golden path holds 10 consecutive PASS lines across two cold boots for a week.
**Streak: 0.**

**Standing rule (operator, 2026-09-25, every project): `main` is always the last
known-good build.** Every change is made on its own branch and tested there. Tested
means the full suite green AND the app run and used. Only then is it merged, and each
good `main` is tagged `good-YYYY-MM-DD`. Merges are the operator's click; the
session's permission check refuses `gh pr merge`.

**Three PRs wait for the OPERATOR. Merge them in this order, with merge commits, never squash:**
1. **#118** — the rev-5 batch, 16 fixes, one commit each (unchanged since 09-24).
2. **#121** — `fix/rev4-28-bugs`, built on #118's tip: 16 more fixes (BUG-467, 458, 459, 462, 448+460, 461+464, 455, 456, 457, 436, 447 (two), 463) and the 2026-09-25 attended record. Until #118 merges, its diff also shows #118's 18 commits.
3. **#122** — `fix/prose-ratchet-lexer`, the prose ratchet's lexer, branched from #121's fifth commit.

Also open, independent: #119 (BUG-454), #120 (BUG-465), #101 (BUG-453), #104
(verify-lib). Whichever merges second conflicts only in the README.md and ROADMAP.md
counts; fix that with `node scripts/sync-test-count.js --write`. After the three merges, tag
`good-2026-09-25` with the operator's go-ahead.

**Attended 2026-09-25 (build fee97e18, 37 turns): the build works, and the week's fixes held live.** The mic reopened early in 0 of 41 holds (20 of 50 on 09-24); 11 chimes at 0.6 s; 7 held replies clean; the memory lock and "ask first" held, and a spoken "no" was honoured; the Gmail line was one plain sentence; resume returned the right answer; the goAway rotation and the quit were clean. **Found**, each in BUGS.md with times: talking over MYTHOS does not stop it (BUG-469, new); two retractions of true actions (448); "yes, refresh the page" not taken as a yes (461); the read-back skipped (464); a double delivery and six screen_look cut-ins (457); English transcribed as Spanish twice (447); a 2.7 s low-CPU stall on a Lessons read (436); paused goals counted active (BUG-470); video clicks miss (BUG-471); unrelated skills and think_deeply overuse (BUG-472).

## The golden path

Spoken, in the operator's already-signed-in browser: **open YouTube, play the
third video, pause, resume, next.** Instrument: `cd mythos && node
scripts/golden-path.js`, once a day with MYTHOS up. It needs a debuggable browser
on 9222 before boot, or the model launches a fresh-profile one itself.

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

- **Merge #118, then #121, then #122**, then approve the `good-2026-09-25` tag.
- **Four answers from the 09-25 session:** (1) Did the operator say "Okay" at 02:11:40? (448) (2) Did any of the video clicks play? (471) (3) Should the identity reflection writer (profile and style) be off by default, like the note-taker? (463) (4) Should clear short commands skip "ask first"? (461)
- **Remove the stale fact** "currently working on … bugs 439, 441, 442". Say "forget the note about bugs 439"; sessions do not edit the vault.
- **BUG-451's three vault records** stating a false cause: remove, quarantine or keep?
- **Should autonomy run while nobody is at the HUD?** The PIN was the only "unattended" signal.
- **Operator actions:** Re-authorise Gmail (`invalid_grant`). Confirm the Mistral console is on the free tier. Google was confirmed 2026-09-24.

## NEXT ACTION

After the merges, one branch per fix, each tested with the suite and an app run: (1) BUG-469, talking over MYTHOS. (2) BUG-448, false retractions (`browser_tabs`, delivered clicks). (3) BUG-461, "yes" followed by the same request. (4) BUG-457, the double delivery, and moving screen_look onto the hold. (5) BUG-447, pinning the transcription language. Test with Bengali and Hindi first. (6) BUG-436, the Lessons stall. (7) BUG-470, 471 and 472.

Not yet exercised live: web_search, recall_memory (436's CPU fix) and crash containment.

## Where the detail lives

Archive: `MYTHOS-IRIS-Synthesis-Plan.md` (roadmap), `-V2-spine.md` (source-level),
`MYTHOS-Post-Parity-Plan.md` (post-step-7). Defect evidence: `BUGS.md`. Attended runs:
`.cache/windows-operator/attended-2026-09-23/`, `-24/` and `-25/` (gitignored, this
machine only). The 09-25 mic-gate recorder windows are in the rev4-28 worktree's
`.cache/voice-gate-recorder/`. Working plan (rev 4, 28 bugs):
`~/.claude/plans/d-agen-os-agent-os-main-agent-os-main-i-deep-cloud.md`.
