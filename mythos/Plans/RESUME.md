# RESUME — read this first, every session

*Under 100 lines, by rule. The roadmap is the archive; this file is the position.
Rewrite in place, never append.*

## Position (2026-09-23, after the attended run)

**One workflow, until it is boring.** Stage 1 only; Stages 2-7 paused until the
golden path holds 10 consecutive PASS lines across two cold boots for a week.
**Streak: 0.** The golden path cannot pass today: "play the third video" is
structurally impossible (BUG-445, below).

**The attended run happened** (2026-09-23, 13:37-14:14, from source via
`npm start`, combined auth mode, 51 voice turns, flags `LOOP_LAG_TRACE`,
`VOICE_SERIALIZE_NOTICES`, `PIN_SESSION_TTL_MS=120000` — all three removed after).
Register: **open 13 -> 17, verified 85 -> 89.** Four closed, seven filed. The bugs
were already there; the run wrote them down.

| result | tickets |
|---|---|
| **Live-verified, closed** | **433** greeting heard after unlock · **434** typing claim stands · **442** no token prompt after 11 idle min on a 2-min session · **268** Ctrl+Alt+X read, copied, toasted in 489 ms |
| **Partial, still open** | **437** X quit leaves no process and the shell waits, but the server hangs on its reflection (LLM) step, is hard-killed at 6 s, and the checkpoint is never written · **422** a child death CAPTURED: exit 0xE06D7363, native C++ exception, suspect the in-process Kokoro worker killed mid-inference · **436** an 18 s silence with a healthy server (model-side) and a 3 s zero-CPU freeze during a sync PowerShell spawn the profiler likely cannot see · **432** measured: the flag holds tool results too — keep it OFF |
| **Not exercised** | **439** (model used the media tool) · **441** (no `unverified:true` click) · **421** · 437's tray and in-app quits |
| **Filed** | **445** snapshot cut to 4,000 chars, only the 1st video addressable (CRITICAL, golden path) · **446** paused over-budget "commitment" goals from 09-11 acted at boot, launched Brave, while locked (HIGH) · **447** 15 of 51 turns system-initiated, heal lines spoken in log vocabulary (HIGH) · **448** window-control false retraction · **449** tool syntax spoken aloud · **450** TTS chain retries dead engines, audio 51 s behind text · **451** wrong lessons saved to the vault |

Evidence: `.cache/windows-operator/attended-2026-09-23/` — merged `timeline.log`,
`raw-*.log` copies of every source, `crash1-*` and `silence1-*` snapshots,
`refpos.js` (the 4,000-char measurement). Gitignored; this machine only.

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

## Operator decisions owed

- **Should a "commitment" expire?** A "right now" from 12 days ago fired today (446).
- **Should a successful self-heal ever be spoken during a live conversation?**
  Recommendation: no (447).
- **Shutdown:** save data before the reflection call, cap it, or drop it at quit (437).
- **Remove the two wrong records** in `vault/Lessons/` and notes once 445 lands (451).
- Still open from before: background polls count as PIN activity (442); D1
  wake-word licence (274 T3); D2 recordings (406); D6 operator mode (421).
- Operator action, not code: **Gmail needs re-authorising** (`invalid_grant`).

## NEXT ACTION

**BUG-445 first** — it is the golden path, and the mechanism is fully measured:
give the model a compact, reference-first view of a page bounded by element count,
never a character-cut raw tree, and never a screenshot through a text result.
Learn from BUG-397, the same defect on the desktop path. Prove it attended with
"play the third video" and "play the sixth video".

Then, in order of harm: **446** (status and budget as hard gates at execution),
**437**'s shutdown ordering (one-line reorder, big data-safety win), **450**'s
circuit breaker (which also cuts BUG-422's crash exposure), **447**, **448**.
Nothing merges from PR #96 until CI runs once on the final SHA.

## Where the detail lives

Archive: `MYTHOS-IRIS-Synthesis-Plan.md` (roadmap), `-V2-spine.md` (source-level),
`MYTHOS-Post-Parity-Plan.md` (post-step-7). Defect evidence: `BUGS.md`. This run:
`%APPDATA%\MYTHOS\mythos-server.log` from `--- boot: MYTHOS 0.1.12-dev pid=18264`,
`vault/Audit/2026-09-23.jsonl`, `vault/Episodic/2026-09-23.jsonl`.
