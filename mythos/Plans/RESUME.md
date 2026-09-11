# RESUME — read this first, every session

*Under 100 lines, by rule. The roadmap is the archive; this file is the position.
Rewrite in place, never append.*

## Position (2026-09-11)

**One workflow, until it is boring.** The build is collapsed to Stage 1 by the
2026-09-07 operator decision; Stages 2-7 stay paused until the golden path holds
10 consecutive PASS lines across two cold boots for a week. Phase A landed via
PR #74 (`451ba73`); the Windows Operator implementation continues on
`codex/windows-operator` and is not on `main`.

**A four-contract repair landed on `verify/live-2026-09-10` on 2026-09-11**
(`ae89f17`, `54942ec`, `ac985d6`, `71206c8`, `66f9e39`, `f41fa57`, `8d7a33e`),
pushed, opened as the single integration **PR #96 -> `main`**. **CI has NOT run
on it**: one dispatch was cancelled to protect the 2,000-minute allowance (`e2e`
passed in 2m42s first; `test` is outstanding). Run it once, on the final SHA,
after the attended pass. **The golden-path streak is still 0.**

| commit | what | what is still owed |
|---|---|---|
| `54942ec` | BUG-436 stall rows carry `sampleWindowMs` + `mainCpuMs`; 4 docs corrected | the stall REPAIR — one attended `LOOP_LAG_TRACE=true` session names the caller |
| `ac985d6` | BUG-438 open_web refuses rather than opening a different episode | one attended spoken "play S2 EP6" |
| `71206c8` | BUG-432 a held notice survives a rotation; phantom flag fixed | an attended Live rotation; the flag stays OFF |
| `66f9e39` | BUG-372 Kokoro moved to a worker; the cache bug that made `KOKORO_MODEL_DIR` inert | the Electron GUI boot, and a heard run |
| `8d7a33e` | packaged resolution PROVEN (`scripts/verify-packaged-kokoro.js`); client now refuses a NaN deadline | nothing beyond the row above |

**Environment hazard CLEARED 2026-09-11:** `ollama` (~5 GB) made the suite fail
one wandering test per run — the exhaustion signature, not a regression. It was
uninstalled; the suite is **7795/7795, 0 fail, 0 skipped at DEFAULT concurrency**.
A shell exporting the 8.3 short `TEMP` still gives `fail=1 skipped=1`
(deploy-config "real boot", `ECONNRESET`) — set `TEMP`/`TMP` long before
believing any red.

## The golden path

Spoken, in the operator's already-signed-in browser: **open YouTube, play the
third video, pause, resume, next.** Instrument: `cd mythos && node
scripts/golden-path.js`, once a day with MYTHOS up; it appends one
`PASS|FAIL|UNVERIFIED|PREREQ-MISSING` line to
`.cache/windows-operator/golden-path.log` (gitignored). **The consecutive-PASS
streak it prints is the one number that matters. Today: 0.**

## Stages

- [ ] **Stage 1 — ACTIVE.** Bar: 10 consecutive attended spoken successes across
  two cold boots; p95 ack 2 s, local stop 250 ms, spoken cancel 1.5 s. Measure;
  never weaken after a failure.
- [ ] **Stages 2-7 — PAUSED** by the 2026-09-07 decision, not cancelled, until
  the Stage 1 streak holds. Scope is in the roadmap.

## Gates

Pre-commit runs the full suite and blocks on `fail > 0`, nothing else. The four
documentation gates are `cd mythos && npm run docs:check` — run before a push.

## Still open

- Live/hardware gates (mic/playback 027/406, Ctrl+Alt+X 268, grounded speech 275).
  Licensing and release decisions (step 6.5, 274 T3). No release authorized.
- Open tickets: **268, 274, 275, 406, 421, 422, 432, 433, 434, 436 (stall half),
  437, 438**. BUG-435 and the goAway half of BUG-436 ARE on this branch
  (`goaway-gate.js` at `3f4082d4`); "unmerged" was true only of `main`. BUG-421
  lacks reveal margin; BUG-422 needs a diagnosed child failure; BUG-428 is coded
  with its acoustic proof owed under BUG-406.
- **Browser: unlock, do not adopt (2026-09-11).** `browser-use/browsercode`
  rejected; we own its primitive as `browser_evaluate`, unallowlisted.
  `ADOPTION-MATRIX.md` §12.
- Phase B of the subtraction plan: one tool-definition object in
  `effectors/hub.js` carrying `tier` and `schema`, so leash, live-tools and the
  map read one source.

## NEXT ACTION

Review PR #96, then arrange the next attended Stage 1 pass. **Nothing in the
2026-09-11 batch has been heard by a human.** Each is one attended session:

1. `node scripts/golden-path.js` with MYTHOS up — the streak is 0 and every
   change on the voice/browser path owes a line before and after.
2. Say "play INDIA'S GOT LATENT S2 EP6" and check it opens EP6 (BUG-438).
3. Boot with `LOOP_LAG_TRACE=true` for 30 minutes; grep `loop.stalled` and read
   `mainCpuMs` against `sampleWindowMs`. That names BUG-436's caller — the
   stall itself is still unfixed and this is the input to fixing it.
4. Boot the packaged app once with kokoro in `VOICE_TTS_CHAIN` (BUG-372) and
   HEAR it. Resolution under `app.asar.unpacked` is already proven by
   `scripts/verify-packaged-kokoro.js` (28 voices, 211,244 bytes, 0 network
   calls, worker cache == `modelCacheDir()`); what is left is the GUI starting
   and the audio being right.

Before any of it: verify the installed native host and extension match the
BUG-416 code — the Sept 9 check found the host still stripped `instanceId`.

## Where the detail lives

Archive: `MYTHOS-IRIS-Synthesis-Plan.md` (roadmap), `-V2-spine.md` (source-level),
`MYTHOS-Post-Parity-Plan.md` (post-step-7). Defect evidence: `BUGS.md`. Raw run
artifacts: `.cache/windows-operator/`.
