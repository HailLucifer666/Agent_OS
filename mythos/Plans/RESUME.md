# RESUME — read this first, every session

*Under 100 lines, by rule. The roadmap is the archive; this file is the position.
Rewrite in place, never append.*

## Position (2026-09-16)

**One workflow, until it is boring.** The build is collapsed to Stage 1 by the
2026-09-07 operator decision; Stages 2-7 stay paused until the golden path holds
10 consecutive PASS lines across two cold boots for a week. **The golden-path
streak is still 0.**

**The 16-bug fix plan (2026-09-16) has shipped its headless half on
`verify/live-2026-09-10` (PR #96 -> `main`): five hook-gated fix commits plus
three cleanup commits, suite green at every commit, 0 skipped.** Every fix
carries its failing-first test and a mutation run recorded in the test file.
None of it has been heard or seen by a human:

| commit | ticket | what changed | what is still owed |
|---|---|---|---|
| `fd345b0a` | BUG-441 | `clicking` claim category; legacy path REPLACES the false sentence (D3); OUTCOME_CLAIMED_TOOLS completed to every click tool. Filed cause corrected: the caveat was never dropped, the table had a hole | attended "play the sixth video" (Track A step 4) |
| `e309b055` | BUG-439 | stale `element_index` -> refresh once, fail with the fresh label + structured remedy; NO auto-retry | attended cua click (step 4/5); latency of the 14 s refresh |
| `a2720b74` | BUG-437 | shell sends `mythos:shutdown`, waits 7 s, tree-kills; lifecycle answers the IPC like SIGTERM; dsh tasks tree-killed in stop-loops | the live symptom is UNREPRODUCED — quit 3 ways with Task Manager + main.log open (step 12) |
| `a84ca1df` | BUG-268 | native toast + clipboard from the main process (D4); the HUD write could never work unfocused | one Ctrl+Alt+X press (step 9) |
| `a86d57ae` | BUG-435/440 | prose ratchet widened to `src/core/voice`; D5 verified by grep; 440 register corrected (coded in `96fb0e5a`, bench reaches the lane) | steps 3 and 11 |

Harness lessons from the pass, so the next session does not repay them:
regenerate `index.html` BEFORE the suite run that feeds `sync-test-count --write`
(the register tests read it); `docs:check` re-runs the suite unless fed TAP on
stdin, and a shell without the long-form TEMP gives `fail=1 skipped=1`; a
`| tail` after a gate swallows its exit code; four file-size ratchets and the
BUG-425 prose ratchet fired during the pass and each moved code rather than a
number.

## The golden path

Spoken, in the operator's already-signed-in browser: **open YouTube, play the
third video, pause, resume, next.** Instrument: `cd mythos && node
scripts/golden-path.js`, once a day with MYTHOS up; it appends one
`PASS|FAIL|UNVERIFIED|PREREQ-MISSING` line to
`.cache/windows-operator/golden-path.log` (gitignored). **Today: 0.**

## Stages

- [ ] **Stage 1 — ACTIVE.** Bar: 10 consecutive attended spoken successes across
  two cold boots; p95 ack 2 s, local stop 250 ms, spoken cancel 1.5 s.
- [ ] **Stages 2-7 — PAUSED** by the 2026-09-07 decision until the streak holds.

## Gates

Pre-commit runs the full suite and blocks on `fail > 0`, nothing else. The four
documentation gates are `cd mythos && npm run docs:check` — run before a push,
with the suite's TAP piped in or a long-form TEMP.

## Still open

- Open tickets: **268, 274, 275, 406, 421, 422, 432, 433, 434, 435, 436 (stall
  half), 437 (live symptom), 438, 439, 440, 441** — twelve of them owe only the
  attended session below; 436/422 are diagnosis-gated (trace first, no third
  confident cause); 274 T3 and 406 are decisions (D1, D2) nobody has made.
- Track E cleanup of the 2026-09-16 plan shipped as commits on this branch
  (the plan said "own PRs"; stacking PRs on the unmerged #96 was rejected as a
  deeper stack): `6c9f0f1e` E2 two orphan HUD modules deleted; `dcecbab9`
  E5/E6/E9 — 20 flags documented, `AGENT_REACH_BIN` deleted, and
  `scripts/lint-env-flags.js` in `docs:check` (product reads must be
  documented, documented names must be read — both directions at zero);
  `7d81c64c` E1 — one `escapeHtml`/`escapeAttr` home in `url.js`, 17 copies
  gone, the four attribute-position calls moved to `escapeAttr` (no `"`-bearing
  id was reproduced; consolidation, not a security fix). Measured and NOT
  changed: E3 four tree-kill bodies differ on purpose; E4 the two `reasonText`s
  differ in behaviour; E8 `sleep()` in tests stays. NOT done: E7 (34 unused
  exports, mostly `scripts/`) — needs a test-reachability pass first.
- Licensing and release decisions (step 6.5, 274 T3). No release authorized.

## NEXT ACTION

**One attended evidence session — Track A of the 2026-09-16 plan, twelve steps,
in `~/.claude/plans/` (copy it into the repo if it is load-bearing).** It
gathers evidence; it promises no closures. Prerequisites first, recorded in the
session log: installed `app.asar` hash and main.log version line; effective
flags from the boot log (`LOOP_LAG_TRACE=true`, `VOICE_ECHO_VERDICT_TO_CLIENT=true`,
`VOICE_SERIALIZE_NOTICES=true` — restore all three after); process baseline;
a controlled Slack DM. Then, in order: cold boot + greeting HEARD (433);
`golden-path.js` line read as-is; "Open YouTube in Brave" ONE window (435);
"play the sixth video" (421/441/439); S2 EP6 (438); Slack `ui_type` (434);
"top 5 on LiveBench" names AND ranks (275-H1); two notices across a Live
rotation (432); Ctrl+Alt+X toast + clipboard (268); 30 min for `loop.stalled`
rows (436, narrows suspects only); 3x `screen_look` (440); quit via X, tray,
in-app — restart between — process diff after each (437).

After: quote each log line into BUGS.md, rewrite this file, `docs:check`,
commit, push, then dispatch `ci.yml` once on the final SHA (2,000-min cap).

## Where the detail lives

Archive: `MYTHOS-IRIS-Synthesis-Plan.md` (roadmap), `-V2-spine.md` (source-level),
`MYTHOS-Post-Parity-Plan.md` (post-step-7). Defect evidence: `BUGS.md`. Raw run
artifacts: `.cache/windows-operator/`.
