# RESUME — read this first, every session

*Under 100 lines, by rule. The 5,278-line roadmap and its RESUME blocks are the
archive; this file is the position. Rewrite it in place, never append.*

## Position (2026-09-07)

**One workflow, until it is boring.** The Windows Operator build is collapsed to
Stage 1 by operator decision on 2026-09-07. Stages 2-7 are PAUSED, not cancelled,
and stay paused until the golden path below reads 10 consecutive PASS lines
across at least two cold boots, sustained for a week.

Phase A landed via PR #74 (`451ba73`). The Windows Operator implementation
itself continues on `codex/windows-operator` and is not on `main` yet.

## The golden path

Spoken, in the operator's already-signed-in browser: **open YouTube, play the
third video, pause, resume, next.**

The instrument is `mythos/scripts/golden-path.js`. It attaches to the running
MYTHOS, sends the four turns over the HUD's own WebSocket path, judges each on
tool evidence plus the media oracle, and appends ONE line to
`.cache/windows-operator/golden-path.log` (gitignored):

```
<iso-time> PASS|FAIL|UNVERIFIED|PREREQ-MISSING steps=<n>/4 ackP95ms=<n> <notes>
```

**The consecutive-PASS streak it prints is the one number that matters.** Today: 0.

Run it once a day, with MYTHOS running:

```
cd mythos && node scripts/golden-path.js
```

PREREQ-MISSING (no provider, no browser, server down) is separate from FAIL and
does not count toward or against the streak.

## Stages

- [ ] **Stage 1 — ACTIVE.** Spoken YouTube third-video selection, pause, resume,
  next, in the existing signed-in browser session. Bar: 10 consecutive attended
  spoken successes across two cold boots; p95 acknowledgement 2 s, local stop
  250 ms, spoken cancellation 1.5 s. Measure; do not weaken after failures.
- [ ] Stage 2 — PAUSED. Windows discovery, target identity, input takeover, modals.
- [ ] Stage 3 — PAUSED. Browser navigation, Gmail drafts; Amazon stops at order review.
- [ ] Stage 4 — PAUSED. Transactional DOCX/XLSX/PDF and OneNote edits.
- [ ] Stage 5 — PAUSED. Advanced PDF replacement and OCR with BYO Acrobat.
- [ ] Stage 6 — PAUSED. Spoken DSH builds against functional acceptance.
- [ ] Stage 7 — PAUSED. Packaged-bytes repeat: cold boot, reconnect, cancel, restart.

## Gates that changed on 2026-09-07 (Phase A of the subtraction plan)

- The pre-commit hook runs the full suite and blocks on `fail > 0`. Nothing else.
- The four documentation gates (`sync-test-count`, `lint-bug-registry`,
  `build-index`, `build-capability-map`) moved to `npm run docs:check` in
  `mythos/`. Run it before a push; CI still runs `sync-test-count --check`.
- This file exists. `CLAUDE.md`'s plan-file ceiling names it explicitly.

## Still open, not in this branch

- Live/hardware gates from the 261-ticket campaign (mic/playback 027/406,
  Ctrl+Alt+X 268, grounded speech 275) — see the roadmap's 2026-09-07 block.
- Licensing and release decisions (step 6.5, 274 T3). No release authorized.
- Phase B of the subtraction plan: one tool-definition object in
  `effectors/hub.js` carrying `tier` and `schema`, so leash, live-tools and the
  capability map read one source. Separate session, after review.

## NEXT ACTION

Phase A merged (PR #74, `451ba73`). The first real golden-path run happened on
2026-09-07 and named two prerequisites, both now reported as PREREQ-MISSING by
the runner instead of UNVERIFIED:

1. **No debuggable browser.** Brave was running without
   `--remote-debugging-port=9222`, so the server withheld all 20 `browser_*`
   tools before the brain saw them. `scripts/setup-chrome-debug.ps1` launches
   Chrome or Edge with a SEPARATE profile, which is not the signed-in Brave
   session Stage 1 names. On `main` there is no path to the operator's own
   Brave session; that path is the extension work on `codex/windows-operator`.
2. **Typed turns vanish into Live.** With `VOICE_S2S_ENABLED=true` the server
   injects a typed utterance into the Gemini Live session (`live.text-injected`)
   and answers the legacy channel with an empty `done`. The runner cannot
   observe a spoken reply from that channel.

In order: (a) decide whether the golden path is judged through the extension
path (merge `codex/windows-operator` Stage 1 first) or through CDP against Brave
relaunched with the debug flag; (b) give the runner a way to observe the Live
path, or run with `VOICE_S2S_ENABLED=false` and say so; (c) read the first real
line. Streak is still 0.

## Where the detail lives

- Archive and history: `MYTHOS-IRIS-Synthesis-Plan.md` (roadmap),
  `MYTHOS-IRIS-Synthesis-Plan-V2-spine.md` (source-level spine),
  `MYTHOS-Post-Parity-Plan.md` (post-step-7 scope).
- Defect evidence: `BUGS.md`. Raw run artifacts: `.cache/windows-operator/`.
