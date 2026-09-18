# RESUME — read this first, every session

*Under 100 lines, by rule. The roadmap is the archive; this file is the position.
Rewrite in place, never append.*

## Position (2026-09-18, after the four-fix pass)

**One workflow, until it is boring.** Stage 1 only; Stages 2-7 paused until the
golden path holds 10 consecutive PASS lines across two cold boots for a week.
**Streak: 0** (last line: `PREREQ-MISSING` — no debuggable browser on 9222 before
the session started). Not re-run on 09-18: that pass was headless.

**The four fixes the 09-16 attended run asked for are coded, in order.** Four
commits on `verify/live-2026-09-10`, each with a failing-first test, mutation
probes diffed against a full-path backup, and the full suite green at commit.
**Nothing is pushed** — the branch is 85 commits ahead of `origin/main`.

| commit | ticket | what changed |
|---|---|---|
| `b2d52872` | **437** | `electron/quit-sequence.js` + `process-tree.js` + `vault-push.js`. `before-quit` now `preventDefault()`s and awaits the shutdown it already asked for; `will-quit` deleted; process identity is `(ProcessId, CreationDate)`, so a reaped pid is never tree-killed |
| `8041b595` | **442** | `server/credentials.js`. The PIN session and the bearer token stop sharing the cookie name `mythos_token`; `isValidNoSlide()`/`renew()`; a 12 h absolute ceiling replaces the hard Max-Age that was the only cap; net-guard routes a 401 by which credential is missing |
| `2e707594` | **443** | Every failure site in `from-app-reply`/`from-pc`/`from-cua` goes through `reasonText()`; a derived guard fails on any NEW `String(x.error)` site rather than counting known ones |
| `9bf0926d` | **433** | `server/boot-greeting.js` + `ui/public/js/hud-ready.js`. The greeting waits for a client that says it can PLAY one, instead of arming on the first connection and spending the shot there |

Suite 7859 -> **7949, 0 fail, 0 cancelled, 0 skipped, exit 0** (long-form TEMP,
`MYTHOS_PORT=4999 EDGE_TTS_PORT=5099`). All five documentation gates green.

**Three defects were found inside these fixes, by probes rather than by reading:**
442's `tokenOk()` accepted a PIN session where a bearer was required; 433's server
kept a socket variable beside the scheduler's target id and the two could
disagree; 433's lock screen resolved `unknown -> unlocked` on the ordinary no-PIN
boot in silence, which would have meant no greeting on any machine without a PIN.

## The golden path

Spoken, in the operator's already-signed-in browser: **open YouTube, play the
third video, pause, resume, next.** Instrument: `cd mythos && node
scripts/golden-path.js`, once a day with MYTHOS up; it appends one
`PASS|FAIL|UNVERIFIED|PREREQ-MISSING` line to
`.cache/windows-operator/golden-path.log` (gitignored). The debug browser MYTHOS
launches is a fresh profile, so the "signed-in" premise is only met when the
operator's own browser carries the port.

## Stages

- [ ] **Stage 1 — ACTIVE.** Bar: 10 consecutive attended spoken successes across
  two cold boots; p95 ack 2 s, local stop 250 ms, spoken cancel 1.5 s.
- [ ] **Stages 2-7 — PAUSED** by the 2026-09-07 decision until the streak holds.

## Gates

Pre-commit runs the full suite and blocks on `fail > 0`, nothing else. The five
documentation gates are `cd mythos && npm run docs:check` — run before a push,
with the suite's TAP piped in or a long-form TEMP. Regenerate `index.html` BEFORE
the counting run; read each gate's exit directly, never through `| tail`. An
agent shell exports the 8.3 short `TEMP`, under which the suite honestly reports
`fail=2 skipped=1` that a long-form `TEMP` does not.

## Still open

- Open: **274, 275, 406, 421, 422, 432, 434, 436, 439**; coded and owing one human
  confirmation: **268, 433, 437, 441, 442, 443**.
- 274 T3 and 406 are decisions (D1, D2) nobody has made. 436/422 stay
  diagnosis-gated. 421 needs desktop operator mode (decision D6).
- **New decision, from 442's security review:** a background poll still counts as
  PIN-session activity. The 12 h ceiling bounds a session's life; it does not
  establish a person is there. Making renewal depend on real input is a product
  call and it touches the voice path.
- **New ticket owed:** `/api/auth/session` echoes the raw `MYTHOS_AUTH_TOKEN`
  into a 30-day browser cookie rather than minting a session id. Flagged MEDIUM,
  out of 442's scope, not yet filed.
- Track E: E1/E2/E5/E6/E9 shipped; E3/E4/E8 measured and left; E7 not done.
- Licensing and release decisions (step 6.5, 274 T3). No release authorized.

## NEXT ACTION

**Nothing here is attended-verified. Four fixes sit on evidence that is entirely
offline, and three of them are about what the running app does.**

1. **Push the branch and open the PR** to `main`; dispatch `ci.yml` once for the
   reviewed revision. After 442 lands the operator is asked for the access token
   once more (30-day cookie, `routes/auth.js`) — say so in the PR.
2. **One attended session, cold boot from source, speaker on, Task Manager open.**
   433: was the greeting heard? 437: quit three ways (X, tray, in-app) and check
   `lifecycle.shutdown.complete`, the checkpoint and the process inventory. 442:
   a full conversation with a PIN configured, watching for the token prompt.
   434: the operator's caret in the DM box first, so the model reaches `ui_type`.
   268: toast seen plus paste.
3. Quote the lines into `BUGS.md`, rerun `docs:check`, commit, push.

## Where the detail lives

Archive: `MYTHOS-IRIS-Synthesis-Plan.md` (roadmap), `-V2-spine.md` (source-level),
`MYTHOS-Post-Parity-Plan.md` (post-step-7). Defect evidence: `BUGS.md`. Raw run
artifacts: `.cache/windows-operator/`; the 09-16 run:
`%APPDATA%\MYTHOS\mythos-server.log` from `--- boot: MYTHOS 0.1.12-dev pid=15388`,
`vault/Audit/2026-09-16.jsonl`.
