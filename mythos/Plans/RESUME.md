# RESUME — read this first, every session

*Under 100 lines, by rule. The 5,278-line roadmap and its RESUME blocks are the
archive; this file is the position. Rewrite it in place, never append.*

## Position (2026-09-11)

**One workflow, until it is boring.** The build is collapsed to Stage 1 by the
2026-09-07 operator decision; Stages 2-7 stay paused until the golden path holds
10 consecutive PASS lines across two cold boots for a week. Phase A landed via
PR #74 (`451ba73`); the Windows Operator implementation continues on
`codex/windows-operator` and is not on `main`.

**A four-contract repair landed on `verify/live-2026-09-10` on 2026-09-11**
(`ae89f17`, `54942ec`, `ac985d6`, `71206c8` and `66f9e39`). All five are local
code + tests only. **No attended run of any kind was performed, and the
golden-path streak is still 0.**

| commit | what | what is still owed |
|---|---|---|
| `ae89f17` | regenerated the capability-map island, stale at 7634 vs 7726 | nothing |
| `54942ec` | BUG-436 stall rows carry `sampleWindowMs` + `mainCpuMs`; 4 docs corrected | the stall REPAIR — one attended `LOOP_LAG_TRACE=true` session names the caller |
| `ac985d6` | BUG-438 open_web refuses rather than opening a different episode | one attended spoken "play S2 EP6" |
| `71206c8` | BUG-432 a held notice survives a rotation; phantom flag fixed | an attended Live rotation; the flag stays OFF |
| `66f9e39` | BUG-372 Kokoro moved to a worker; the cache bug that made `KOKORO_MODEL_DIR` inert | a PACKAGED boot with kokoro in the chain |

The measurements behind each are in `BUGS.md`, not here.

**Known environment hazard on this machine:** `ollama` holds ~5 GB resident. With
it running, the full suite at default concurrency fails ONE wandering test per run
(`boot`, then `verify-lib-attach`) — the documented exhaustion signature, not a
regression. At `--test-concurrency=3` the suite is **7794/7794, 0 failures,
0 skipped**. The pre-commit hook uses default concurrency, so a commit may need a
retry when memory is tight.

## The golden path

Spoken, in the operator's already-signed-in browser: **open YouTube, play the
third video, pause, resume, next.** Instrument: `cd mythos && node
scripts/golden-path.js`, once a day with MYTHOS up. It appends ONE line to
`.cache/windows-operator/golden-path.log` (gitignored):

```
<iso-time> PASS|FAIL|UNVERIFIED|PREREQ-MISSING steps=<n>/4 ackP95ms=<n> <notes>
```

**The consecutive-PASS streak it prints is the one number that matters.
Today: 0.** PREREQ-MISSING counts neither for nor against it.

## Stages

- [ ] **Stage 1 — ACTIVE.** Bar: 10 consecutive attended spoken successes
  across two cold boots; p95 ack 2 s, local stop 250 ms, spoken cancel 1.5 s.
  Measure; never weaken after a failure.
- [ ] **Stages 2-7 — PAUSED** by the 2026-09-07 decision, not cancelled. They
  stay paused until the Stage 1 streak holds. Scope is in the roadmap.

## Gates

Pre-commit runs the full suite and blocks on `fail > 0`, nothing else. The four
documentation gates are `cd mythos && npm run docs:check` — run before a push.
History of that split is in the roadmap.

## Still open

- Live/hardware gates (mic/playback 027/406, Ctrl+Alt+X 268, grounded speech 275).
- Licensing and release decisions (step 6.5, 274 T3). No release authorized.
- Open tickets: **268, 274, 275, 406, 421, 422, 432, 433, 434, 436 (stall half), 437, 438**. BUG-435 and the goAway half of BUG-436 ARE on this branch (goaway-gate.js at `3f4082d4`); the earlier note that they were "unmerged" was true only of `main`.
  BUG-421 still lacks reveal margin; BUG-422 needs a diagnosed child failure;
  BUG-432 notice collisions need measured scheduling work. BUG-428 is coded,
  with its acoustic proof still owed under BUG-406.
- Phase B of the subtraction plan: one tool-definition object in
  `effectors/hub.js` carrying `tier` and `schema`, so leash, live-tools and the
  capability map read one source. Separate session, after review.

## NEXT ACTION

Review the single integration PR (verify/live-2026-09-10 -> main), then arrange
the next attended Stage 1 pass. **Nothing in the 2026-09-11 batch has been run
in front of a human.** In priority order, each is one attended session:

1. `node scripts/golden-path.js` with MYTHOS up — the streak is 0 and every
   change on the voice/browser path owes a line before and after.
2. Say "play INDIA'S GOT LATENT S2 EP6" and check it opens EP6 (BUG-438).
3. Boot with `LOOP_LAG_TRACE=true` for 30 minutes; grep `loop.stalled` and read
   `mainCpuMs` against `sampleWindowMs`. That names BUG-436's caller — the
   stall itself is still unfixed and this is the input to fixing it.
4. Build the installer and boot it once with kokoro in `VOICE_TTS_CHAIN`
   (BUG-372). A green suite cannot tell you the app starts.

Before any of it: verify the installed native host and extension match the
BUG-416 code — the September 9 check found the installed host still stripped
`instanceId`, and rebuilding it is operator work.

## Where the detail lives

- Archive and history: `MYTHOS-IRIS-Synthesis-Plan.md` (roadmap),
  `MYTHOS-IRIS-Synthesis-Plan-V2-spine.md` (source-level spine),
  `MYTHOS-Post-Parity-Plan.md` (post-step-7 scope).
- Defect evidence: `BUGS.md`. Raw run artifacts: `.cache/windows-operator/`.
