# RESUME — read this first, every session

*Under 100 lines, by rule. The roadmap is the archive; this file is the position.
Rewrite in place, never append.*

## Position (2026-09-23, night)

**One workflow, until it is boring.** Stage 1 only; Stages 2-7 paused until the
golden path holds 10 consecutive PASS lines across two cold boots for a week.
**Streak: 0.** BUG-445 (the golden path's own blocker) is now CODED, not yet proven.

**Working plan:** rev 5 of the 17-bug plan, approved 2026-09-23, at
`~/.claude/plans/file-d-agen-20os-agent-os-main-agent-os-linked-hoare.md` (plan mode's
own file). Waves: 0 baseline · 1 access, browser targets, autonomy · 2 shutdown, TTS,
native crash · 3 speech · 4 qualification and memory.

**A chain of PRs is waiting for the OPERATOR to merge, in this order.** Each targets
`main` and builds on the one before; the session's permission check refuses
`gh pr merge`, so the agent cannot. CI ran green on each head it had finished on:
#102 PIN removal + BUG-444/452 · #103 BUG-445 · #105 BUG-446 · #106 BUG-437 ·
#107 BUG-450 · #108 BUG-422 · #109 BUG-447 · then the BUG-432 + 436-delivery PR. Eleven superseded PRs
(#95 … #82) are also still open — their content is in main; closing them is the
operator's call.

| state | tickets |
|---|---|
| **Coded, attended session owed** | 444, 452 (startup/access) · 445 (browser targets) · 446 (spoken half) · 437 (three-way quit) · 450 (speech) |
| **Contained, still open** | 422 — Kokoro is a child process; the attended 0xE06D7363 itself not reproduced |
| **Coded behind a flag, comparison owed** | 432 — answers never wait behind notices, nothing forced into a reply; `VOICE_SERIALIZE_NOTICES` stays OFF until an attended A/B |
| **Partly coded, still open** | 447 — heals silent, greeting fixed; resume-after-barge-in and Spanish transcript open · 436 — delivery half coded (a result mid-rotation reaches the resumed session); blocking half open |
| **Open, next** | Wave 3: 448, then the 449/275 detectors; then Wave 4 |

What the session proved headlessly, without the operator: a seeded-vault boot
reproduced BUG-446 on the old build and showed zero steps on the new; a forked-IPC
quit of the real server ran every step clean (BUG-437); the real-model Kokoro
matrix crashed 12 of 12 ways on the old transport and 0 on the new, and the packaged
MYTHOS.exe passed `verify-packaged-kokoro.js` (BUG-422).

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
`verify-lib-attach.test.js` glitches about 1 run in 3 ("Unable to deserialize cloned
data") and takes its ~12 tests out of the count — rerun, never write counts from it;
a follow-up task is filed. In `BUGS.md`'s OPEN WORK register,
FIXED/RESOLVED/CLOSED/SATISFIED anywhere in a bullet closes that ticket. CI is
manual dispatch: once, on a final commit.

## Operator decisions owed

- **Merge the PR chain above, in order.**
- **Close the eleven superseded PRs?**
- **Should autonomy run while nobody is at the HUD?** The PIN lock was the only
  signal for "unattended"; it no longer exists.
- D7/D8/D9 were taken under delegation ("whatever works now") and are reversible:
  the validated voice lane is deferred (so 449, 275 and 447's resume-after-barge-in
  stay open), the wake-word licence stays a lawyer's call (274), the mic hold gets a
  recorder first (406).
- Operator action, not code: **Gmail needs re-authorising** (`invalid_grant`).

## NEXT ACTION

Wave 3, in order: **BUG-448** (category matches whose words overlap are one action,
judged together; a sibling's success never overrules the claimed category's own
failed tool; non-overlapping claims stay independent), then the **449/275
detectors**. Then Wave 4: 436's blocking half, 421/439, 451, the 406 recorder, the
274 options note. BUG-432's flag goes default-on only after the attended A/B in the
speech session.

Tracker note for the next ledger pass: BUG-406 is open but has no OPEN WORK
register bullet, so the register lists 17 names while the index counts 18 open.

## Where the detail lives

Archive: `MYTHOS-IRIS-Synthesis-Plan.md` (roadmap), `-V2-spine.md` (source-level),
`MYTHOS-Post-Parity-Plan.md` (post-step-7). Defect evidence: `BUGS.md`. The
2026-09-23 attended run: `.cache/windows-operator/attended-2026-09-23/` (gitignored,
this machine only), `vault/Audit/2026-09-23.jsonl`, `vault/Episodic/2026-09-23.jsonl`.
Headless probes of this session: `.cache/bug446/seeded-boot.js`,
`.cache/bug437/ipc-quit-probe.js`, `.cache/bug422/matrix.js` (all gitignored).
