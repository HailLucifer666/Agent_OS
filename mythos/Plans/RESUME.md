# RESUME — read this first, every session

*Under 100 lines, by rule. The 5,278-line roadmap and its RESUME blocks are the
archive; this file is the position. Rewrite it in place, never append.*

## Position (2026-09-10)

**One workflow, until it is boring.** The Windows Operator build is collapsed to
Stage 1 by operator decision on 2026-09-07. Stages 2-7 are PAUSED, not cancelled,
and stay paused until the golden path below reads 10 consecutive PASS lines
across at least two cold boots, sustained for a week.

Phase A landed via PR #74 (`451ba73`). The Windows Operator implementation
itself continues on `codex/windows-operator` and is not on `main` yet.

The September 10 ticket campaign is stacked for review in four pull requests:
[register #83](https://github.com/HailLucifer666/Agent_OS/pull/83),
[brain #84](https://github.com/HailLucifer666/Agent_OS/pull/84),
[voice #85](https://github.com/HailLucifer666/Agent_OS/pull/85), and
[echo #82](https://github.com/HailLucifer666/Agent_OS/pull/82).
These local fixes and replay checks provide no new attended voice or acoustic
proof. No pull request was merged, and the golden-path streak remains **0**.

## The golden path

Spoken, in the operator's already-signed-in browser: **open YouTube, play the
third video, pause, resume, next.**

The instrument is `mythos/scripts/golden-path.js` — run it once a day with
MYTHOS up (`cd mythos && node scripts/golden-path.js`). It attaches to the
running server, sends the four turns over the HUD's own WebSocket path, judges
each on tool evidence plus the media oracle, and appends ONE line to
`.cache/windows-operator/golden-path.log` (gitignored):

```
<iso-time> PASS|FAIL|UNVERIFIED|PREREQ-MISSING steps=<n>/4 ackP95ms=<n> <notes>
```

**The consecutive-PASS streak it prints is the one number that matters. Today:
0.** PREREQ-MISSING (no provider, no browser, server down) is separate from
FAIL and counts neither for nor against it.
## Stages

- [ ] **Stage 1 — ACTIVE.** Spoken YouTube third-video selection, pause, resume,
  next, in the existing signed-in browser session. Bar: 10 consecutive attended
  spoken successes across two cold boots; p95 acknowledgement 2 s, local stop
  250 ms, spoken cancellation 1.5 s. Measure; do not weaken after failures.
- [ ] **Stages 2-7 — PAUSED** by the 2026-09-07 decision, not cancelled: windows
  discovery and input takeover; browser navigation and Gmail drafts (Amazon
  stops at order review); transactional DOCX/XLSX/PDF and OneNote; advanced PDF
  and OCR with BYO Acrobat; spoken DSH builds; packaged-bytes repeat. They stay
  paused until the Stage 1 streak above holds.

## Gates that changed on 2026-09-07 (Phase A of the subtraction plan)

- The pre-commit hook runs the full suite and blocks on `fail > 0`. Nothing else.
- The four documentation gates (`sync-test-count`, `lint-bug-registry`,
  `build-index`, `build-capability-map`) moved to `npm run docs:check` in
  `mythos/`. Run it before a push; CI still runs `sync-test-count --check`.
- This file exists. `CLAUDE.md`'s plan-file ceiling names it explicitly.

## Still open

- Live/hardware gates from the 261-ticket campaign (mic/playback 027/406,
  Ctrl+Alt+X 268, grounded speech 275) — see the roadmap's 2026-09-07 block.
- Licensing and release decisions (step 6.5, 274 T3). No release authorized.
- The seven open tickets are **268, 274, 275, 406, 421, 422, and 432**.
  BUG-421 still lacks reveal margin; BUG-422 needs a diagnosed child failure;
  BUG-432 notice collisions need measured scheduling work. BUG-428 is coded,
  with its acoustic proof still owed under BUG-406.
- Phase B of the subtraction plan: one tool-definition object in
  `effectors/hub.js` carrying `tier` and `schema`, so leash, live-tools and the
  capability map read one source. Separate session, after review.

## NEXT ACTION

Review the four pull requests, then arrange the next attended Stage 1 pass.
The September 9 component checks for BUG-414..419 remain historical evidence;
they did not establish one successful golden-path run.

Before that pass, verify the installed native host and extension match the
BUG-416 code. The September 9 check found the installed host still stripped
`instanceId`; rebuilding the native host and reloading the extension remain
operator work. Decide how the runner observes Live injections, then judge the
spoken golden path through the existing signed-in browser. No operator session,
native-host rebuild, extension reload, or golden-path run occurred in this campaign.

**BUG-420 has a local code fix:** retired-model defaults and scoped 403/404
health handling are covered by replay and deterministic tests. New provider
calls remain untested. **BUG-421 stays open:** ordinals 1-20 still exceed the
measured reveal budget. BUG-418 still lacks a real Anthropic/OpenAI provider call.
## Where the detail lives

- Archive and history: `MYTHOS-IRIS-Synthesis-Plan.md` (roadmap),
  `MYTHOS-IRIS-Synthesis-Plan-V2-spine.md` (source-level spine),
  `MYTHOS-Post-Parity-Plan.md` (post-step-7 scope).
- Defect evidence: `BUGS.md`. Raw run artifacts: `.cache/windows-operator/`.
