# RESUME — read this first, every session

*Under 100 lines, by rule. The roadmap is the archive; this file is the position.
Rewrite in place, never append.*

## Position (2026-09-16, after the attended run)

**One workflow, until it is boring.** Stage 1 only; Stages 2-7 paused until the
golden path holds 10 consecutive PASS lines across two cold boots for a week.
**Streak: 0** (today's line: `PREREQ-MISSING` — no debuggable browser on 9222
before the session started).

**The 16-bug plan has now run both halves.** Headless half: five fix commits and
three cleanup commits on `verify/live-2026-09-10` (PR #96 -> `main`), suite
green at each. Attended half (Track A): one 35-minute spoken session, 64 turns,
66 tool calls, 8 honest failures, run from source with the HUD PIN-locked at boot.
**Result: 3 closed, 2 new filed, the rest evidenced and still open.** Register
went open 14 · coded 10 -> **open 13 · coded 10** (verified 82 -> 85).

| ticket | attended result (evidence is quoted in BUGS.md) |
|---|---|
| 435, 438, 440 | **LIVE-VERIFIED, closed.** One Brave window with `browser_navigate` url; open_web refused EP6 honestly then EP6 opened (window title); 5x screen_look all 1 attempt, 2.3-4.3 s |
| 433 | NOT heard. Sharper cause: greeting fires 2.5 s after the FIRST HUD connection, which was PIN-locked; the HUD drops proactive speech behind the lock and it never replays. Still open |
| 437 | Quit 1 of 3 (X): zero survivors, BUT the shell exits 0.47 s after sending `mythos:shutdown` — nothing awaits the graceful stop, so the 7 s wait never runs, the child log pipe dies at step 1, and the checkpoint was not rewritten. Sub-defect in the 09-16 fix |
| 268 | Two presses: dispatched 303 / 539 ms, `copied:true toastShown:true`; first toast reached the shell 10 s late. Operator "seen it" not collected |
| 275 | H1 sample: round 1 names+order matched the snippet; round 2 promoted "DeepSeek V4.1 … edging out others" — present in no result |
| 432 | Two rotations, held notice delivered after each, no loss row; 10 interrupts / 64 turns (all beside operator speech). One notice per rotation, plan wanted two. Flag back to default OFF |
| 434 | Not exercised: the model chose `app_reply`, which failed as `[object Object]` (-> BUG-443) |
| 421 | Not testable here: `desktop_task_start` withheld (DESKTOP_OPERATOR_ENABLED off) |
| 436 | 3 loop stalls, none with `lastSync`; 2 turn-stalls; 1 cortex self-restart. Suspects narrowed, not named |
| 439, 441 | Not exercised (no cua_click, no unverified click). A say-before-act sample recorded under 441 |
| **442 new** | HUD demanded the ACCESS TOKEN mid-conversation: PIN cookie has a hard 30-min Max-Age while the server session slides; net-guard shows the token prompt for a lapsed PIN |
| **443 new** | `app_reply` stringifies an object failure to `[object Object]` (from-app-reply.js:141) |

Session tooling worth keeping: a merged timeline (server log + Audit + Episodic
actions) is the only readable view of a live run; `log_incident` rows the operator
asked for are in `vault/Incidents/2026-09-16.jsonl` (stutter/cut-offs; Tier-3
disclaimer too long; the token popup).

## The golden path

Spoken, in the operator's already-signed-in browser: **open YouTube, play the
third video, pause, resume, next.** Instrument: `cd mythos && node
scripts/golden-path.js`, once a day with MYTHOS up; it appends one
`PASS|FAIL|UNVERIFIED|PREREQ-MISSING` line to
`.cache/windows-operator/golden-path.log` (gitignored). **Today: PREREQ-MISSING.**
Note from the run: the debug browser MYTHOS launches is a fresh profile, so the
"signed-in" premise is only met when the operator's own browser carries the port.

## Stages

- [ ] **Stage 1 — ACTIVE.** Bar: 10 consecutive attended spoken successes across
  two cold boots; p95 ack 2 s, local stop 250 ms, spoken cancel 1.5 s.
- [ ] **Stages 2-7 — PAUSED** by the 2026-09-07 decision until the streak holds.

## Gates

Pre-commit runs the full suite and blocks on `fail > 0`, nothing else. The five
documentation gates are `cd mythos && npm run docs:check` — run before a push,
with the suite's TAP piped in or a long-form TEMP. Regenerate `index.html` BEFORE
the counting run; read each gate's exit directly, never through `| tail`.

## Still open

- Open: **274, 275, 406, 421, 422, 432, 433, 434, 436, 437, 439, 442, 443**;
  coded and owing one human confirmation: **268, 441**.
- 274 T3 and 406 are decisions (D1, D2) nobody has made. 436/422 stay
  diagnosis-gated. 421 needs desktop operator mode on this machine (decision D6:
  enable it for one retry, or leave 421 parked).
- Track E: E1/E2/E5/E6/E9 shipped (`6c9f0f1e`, `dcecbab9`, `7d81c64c`); E3/E4/E8
  measured and left; E7 (34 unused exports) not done.
- Licensing and release decisions (step 6.5, 274 T3). No release authorized.

## NEXT ACTION

Four small fixes, each its own commit with a failing-first test and a recorded
mutation, in this order:

1. **437 sub-defect** — `before-quit` must `preventDefault()`, await
   `stopChildGracefully()` (or its 7 s deadline), then `app.exit()`; test that a
   child ignoring the request is still tree-killed before the shell exits. Then
   quit three ways attended with Task Manager open.
2. **442** — re-issue the PIN cookie on each valid check (or drop its Max-Age);
   HUD shows the PIN screen, not the token prompt, when the 401 hint names the PIN
   session. Fix the pin-session header comment in the same commit.
3. **443** — route the failure through `util/reason-text.js`; test that
   `[object Object]` never appears.
4. **433** — arm the greeting on the first UNLOCKED connection.

Then a short attended redo: 434 (operator's caret in the DM box first, so the
model reaches `ui_type`), 268 (toast seen + paste), 437 (three quits). After:
quote the lines into BUGS.md, `docs:check`, commit, push, dispatch `ci.yml` once.

## Where the detail lives

Archive: `MYTHOS-IRIS-Synthesis-Plan.md` (roadmap), `-V2-spine.md` (source-level),
`MYTHOS-Post-Parity-Plan.md` (post-step-7). Defect evidence: `BUGS.md`. Raw run
artifacts: `.cache/windows-operator/`; today's run: `%APPDATA%\MYTHOS\mythos-server.log`
from `--- boot: MYTHOS 0.1.12-dev pid=15388`, `vault/Audit/2026-09-16.jsonl`.
