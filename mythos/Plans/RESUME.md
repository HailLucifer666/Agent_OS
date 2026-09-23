# RESUME — read this first, every session

*Under 100 lines, by rule. The roadmap is the archive; this file is the position.
Rewrite in place, never append.*

## Position (2026-09-23, evening)

**One workflow, until it is boring.** Stage 1 only; Stages 2-7 paused until the
golden path holds 10 consecutive PASS lines across two cold boots for a week.
**Streak: 0.** "Play the third video" is still structurally impossible (BUG-445).

**Working plan:** rev 5 of the 17-bug plan, approved 2026-09-23. It lives outside
the repo at `~/.claude/plans/file-d-agen-20os-agent-os-main-agent-os-linked-hoare.md`
(plan mode's own file). Waves: 0 baseline · 1 access + browser targets + autonomy ·
2 shutdown, TTS, native crash · 3 speech · 4 qualification and memory.

**Done today.**
- **PR #96 merged** (`ca477ad9`) after CI ran green on its final commit `0cc336f5`.
  The first CI run was red on two tests that only held on this machine (a real
  timer Node 22 does not keep alive; an SDDL alias for a RID-500 account); both
  fixed test-side. Eleven superseded PRs (#95 … #82) stay OPEN: they target
  stacked side branches, so GitHub did not auto-close them. Their commits are all
  in main — the operator decides whether to close them.
- **The PIN is gone** (operator decision: "I open the app, it straight puts me in
  the HUD"). Branch `fix/remove-pin-bug-444`: no lock screen, no PIN routes or
  settings, greeting re-armed on voice-config readiness, desktop signs itself in.
  Same PR codes **BUG-444** (session id, never the token) and **BUG-452** (a
  foreign web page could drive the API of any PIN-less install; now refused).
  Security-reviewer pass: no critical/high; its one medium applied.

| state | tickets |
|---|---|
| **Coded, attended session owed** | 444, 452 (startup/access); **445** (browser targets); **446** (spoken D10 half only — headless boot passed) |
| **Coded, attended shutdown session owed** | **437** (server half headless-verified; three-way quit owed) |
| **Coded, attended speech session owed** | **450** (TTS circuit) |
| **Open, next** | **422** (Kokoro out of process; also owns the 0xC0000409 at exit found by the 437 probe) |

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

Pre-commit runs the full suite and blocks on `fail > 0`, nothing else. The five
documentation gates are `cd mythos && npm run docs:check` — run before a push,
with the suite's TAP piped in or a long-form TEMP. Regenerate `index.html` BEFORE
the counting run; read each gate's exit directly. An agent shell's 8.3 short
`TEMP` makes the suite honestly report `fail=2 skipped=1`. In `BUGS.md`'s OPEN WORK
register, FIXED/RESOLVED/CLOSED/SATISFIED anywhere in a bullet closes that ticket.
CI is manual dispatch: run it once, on a final commit, when no more commits are owed.

## Operator decisions owed

- **Close the eleven superseded PRs?** Their content is merged; GitHub left them open.
- **Should autonomy run while nobody is at the HUD?** The PIN lock was the only
  signal for "unattended"; it no longer exists.
- D7/D8/D9 were taken under delegation ("whatever works now") and are reversible:
  the validated voice lane is deferred, the wake-word licence stays a lawyer's call,
  the mic hold gets a recorder first. So 449, 275, 406, 274 stay open this round.
- Operator action, not code: **Gmail needs re-authorising** (`invalid_grant`).

## NEXT ACTION

**Merge in order — each PR targets `main` and builds on the one before:** #102 (PIN
removal, CI green on `ec2efd93`; the session's permission check blocked the agent from
merging, so the operator merges), then the BUG-445 PR. BUG-445 is CODED: `browser_snapshot`
returns a bounded, paged, main-first list whose accepted refs are exactly the refs it
printed, and the voice adapter bounds results as a structure. Its proof owed is one
`golden-path.js` line and an attended "play the third / sixth video". Then the BUG-446
PR: Goals.md never activates an unaccepted commitment, autonomous work is gated on
status and budget where it executes, commitments are listed only when asked. A headless
seeded-vault boot reproduced the incident on the old build (4 steps ran) and showed 0 on
the new. Then the BUG-437 PR: the saving steps run before reflection, under one deadline. Then the BUG-450 PR: one
circuit per TTS engine, a dead engine paid for once per outage. Next: **422** (Kokoro
out of process; it also owns the exit crash), then Wave 3.

Tracker note for the next ledger pass: BUG-406 is open but has no OPEN WORK
register bullet, so the register lists 17 names while the index counts 18 open.

## Where the detail lives

Archive: `MYTHOS-IRIS-Synthesis-Plan.md` (roadmap), `-V2-spine.md` (source-level),
`MYTHOS-Post-Parity-Plan.md` (post-step-7). Defect evidence: `BUGS.md`. The
2026-09-23 attended run: `.cache/windows-operator/attended-2026-09-23/` (gitignored,
this machine only), `vault/Audit/2026-09-23.jsonl`, `vault/Episodic/2026-09-23.jsonl`.
