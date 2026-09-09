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

## Still open, not in this branch

- Live/hardware gates from the 261-ticket campaign (mic/playback 027/406,
  Ctrl+Alt+X 268, grounded speech 275) — see the roadmap's 2026-09-07 block.
- Licensing and release decisions (step 6.5, 274 T3). No release authorized.
- Phase B of the subtraction plan: one tool-definition object in
  `effectors/hub.js` carrying `tier` and `schema`, so leash, live-tools and the
  capability map read one source. Separate session, after review.

## NEXT ACTION

**Live verification of BUG-414..419 is DONE (2026-09-09): five passed against
real hardware, the sixth has no key here.** Numbers are in each BUGS.md entry.
It answers question (a) above — judge the golden path through the operator's
REAL Brave, not a debug profile. Opening a page there now verifies itself off
the window title (414), the launcher starts Brave rather than Chrome (415),
identity survives a reconnect through the real compiled host (416), an ordinal
addresses the Nth RESULT on a real page (417), and a refusing provider leaves
every lane on its first real call (419).

**Two things before Stage 1 can be judged, neither of them code:**

1. **Rebuild the native host and reload the extension.** The host registered
   for Brave points at the installed app's `resources/mythos-browser-host.exe`,
   built 2026-09-08 — before the 416 fix — so it still strips `instanceId` and
   would refuse every hello. `node mythos/scripts/build-browser-native-host.js`.
   Expect exactly one `browser.extension.protocol-mismatch` when the old
   extension reconnects, none after the reload.
2. **Decide how the runner sees the Live path** (question (b), unchanged):
   observe `live.text-injected`, or run `VOICE_S2S_ENABLED=false` and log it.

**Streak is still 0.** Five green component verifications are not one green
end-to-end run, and nothing in this pass ran the golden path.

**Filed, not fixed:** BUG-420 (a Cerebras model that always 404s stays in three
lanes — only 401/402/403 are recorded) and BUG-421 (the grammar accepts
ordinals 1-20; the reveal budget reaches about 6, with zero margin measured).
BUG-418's provider wire stays unverifiable here: no Anthropic or OpenAI key.
## Where the detail lives

- Archive and history: `MYTHOS-IRIS-Synthesis-Plan.md` (roadmap),
  `MYTHOS-IRIS-Synthesis-Plan-V2-spine.md` (source-level spine),
  `MYTHOS-Post-Parity-Plan.md` (post-step-7 scope).
- Defect evidence: `BUGS.md`. Raw run artifacts: `.cache/windows-operator/`.
