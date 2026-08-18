# MYTHOS × IRIS Pro-Plus Parity — Living Roadmap

> **This file is the cross-session source of truth, and it is tracked in git so any
> machine can pick the build up mid-flight.** The loop is: read **RESUME HERE**, do the
> next unchecked step, tick it, update the block, commit, push. Do not start a second
> plan document — the V2 spine was lost precisely because planning lived in untracked
> files (see the blocking-gap section below).

**Post-parity backlog (not part of this build):** `mythos/Plans/MYTHOS-Post-Parity-Plan.md` holds scope that starts only after merged-order step 7 — social platforms, a multi-agent business layer, phone/multi-device control surfaces, multi-device wake-word arbitration. It is downstream by construction and **this file wins on any overlap**; it exists so that scope does not bury this build's RESUME HERE loop. It also
carries **Appendix COMM — commercial readiness** (added 2026-08-17): the
open-core split, the demo-critical reliability list, and — relevant to *this*
file — the reason the product name gates **release** rather than step 7's tick
(`build.appId` is Windows' install/upgrade key and is free to change only until
the first external user exists).

## RESUME HERE

*Rewrite this block every session. It is the first and sometimes only thing the next machine reads.*

### 2026-08-18 (latest, third entry) — the post-BUG-272 sessions RAN and BUG-273 is CLOSED except for what needs a live session. Ten items shipped; A2 diagnosed and instrumented. Next action: **the operator’s voice session**, then `node mythos/scripts/verify-voice-session.js <log>`.

**Status: merged-order position UNCHANGED (6.5 ☐ · 6.6 ☐ · 7 ☐).**
Fourteen commits on `main`, `f0f63f9..2d82ba5`: `7eb3920` (B1, `unverified` was
narrated as success), `33090e1` (A1, the learned bleed floor went dormant),
`8d61547` (the verifier’s headline criterion could never fire), `1d58765` (A2’s
measurement + the BUG-273 record), `24c95c5` + `1d01c79` (D2), `a910767` +
`619c5b1` (A3), `e1684ab` + `ea5f1dd` (B2), `025ceba` (B3), `e8777ee` (C1),
`12b6ada` (C3), `5fe9368` (A4), `2d82ba5` (C2).
Suite **5066/5066/0 fail/0 skipped**, from 4963 at the start of the session.

**Read BUGS.md's BUG-273 entry before touching anything.** It is the full
handoff: the measured evidence table, what is now closed out, the remaining
backlog in order, and — load-bearing — **three corrections to the BUG-273 fix
plan's own diagnoses**, all found by reading the code before writing any:

1. **B1's cause was an asymmetry BUG-272 slice 4 created**, not the
   instruction-following failure it looked like. Three paths narrate an
   unverified outcome and they carried three different hedges;
   `reportLateOutcome` had none. Slice 4 (`190cd74`) moved `launch_app` into
   `SLOW_TOOLS` for sound duration reasons, which moved its narration onto the
   weakest of the three, three commits before the session that caught it.
2. **A2's carrier is the release FLUSH, not bleed passed during a hold.**
   Nothing reaches Gemini during a hold — the capture handler `return`s before
   any send. The replay at `releaseOwnVoiceGate()` pushes the whole preroll ring
   (133 frames = 13.3 s of audio the code's own comment calls "mostly MYTHOS")
   in one burst, and a test now shows the noise gate silences **0 of 133** at
   the measured levels: floor 0.02 vs bleed 0.123. That also rules out the
   plan's own first remedy — a floor high enough to reject 0.123 bleed rejects
   operator speech at 0.069 too.
3. **The verifier was lying on the plan's headline metric.** It counted a `msg`
   that is a bus event and is never logged, so "self-interruption under 15%"
   printed PASS on every session ever run, including one at 43%.

**THREE BUG-272 ITEMS ARE NOW LIVE-VERIFIED** and can stop being re-litigated:
slice 1 (wake word listening all session), slice 2 (echo attribution — and its
37/39 `no-reference` decisions **close the deferred V3 wire-message question with
data: do not build it**), and slice 4b (`open_web(browser:true)`, four successful
hand-offs against 7/7 silent failure).

**D2 IS DONE, and it was not what it looked like.** The HUD banner was never
false. The audit shows one `open_web` succeeding at 11:44:01 and a DIFFERENT one
failing at 11:44:06, with nothing in the Agent Actions feed to tell two same-tool
rows apart. Two real defects behind it, both fixed in `24c95c5`: a bare
"A URL is required for web embedding." that the 2026-08-14 fix had already
condemned but only removed from one of its two branches (the same asymmetry as
B1, four days apart), and a feed row carrying no timestamp. The `propose_goal`
half was a misattribution — all 6 calls carry `actor:'cortex'` and `propose_goal`
is not in the Live allowlist, so voice cannot reach it.

**A3 IS DONE, and it was not the case it was filed as.** The premise was "at boot
there is no Live session yet, so proactive TTS really plays". There WAS one —
`live.tool-call-batch` with three tools is logged at 11:33:01.976, eighteen seconds
before the detection. The real defect is that a wake-word score is evidence about
the previous ~1,960ms (76 + 15*8 = 196 mel frames at a 10ms hop) while all five
guards asked "is MYTHOS speaking NOW?", so a greeting that stopped playing shortly
before the score crossed the threshold defeated every one of them. `a910767` adds a
sixth guard over the detector-reported window, tracking WHEN MYTHOS last had speech
audio rather than whether it has some right now. Q1 held: only MYTHOS’s own speech
feeds the window, and a test pins that Spotify never does.

**Left behind for whoever wants it:** `s2s.isActive()` reads false while a Live
session is making tool calls, because that flag tracks the CLIENT bridge’s session.
That is why the batch TTS chain ran at all instead of BUG-060/061 routing the
greeting through `sendText()`. Not filed as its own item yet.

**TEN OF THE ELEVEN BUG-273 ITEMS ARE SHIPPED.** Read BUGS.md’s BUG-273 entry for
the detail; what belongs here is the pattern, because it decided most of the work:
**five of these fixes were caused by earlier fixes**, and every one was found by
reading what the consumer actually receives rather than what the branch intends to
say.

- BUG-272 slice 4 moved `launch_app` into SLOW_TOOLS, which moved its narration onto
  the weakest of three hedges → **B1**.
- **B1**’s blanket prohibition then gagged the one tool whose partial success was
  worth stating → **B2**.
- BUG-272-era B1 (the vision one) made a timeout take a cooldown against a budget
  too tight to tell slow from dead → **C3**.
- BUG-272 renamed one shared ceiling label but left one timer serving two purposes
  → **A4**.
- And the verifier’s own headline criterion had never once fired, so "self-
  interruption under 15%" printed PASS on every session ever run, including one at
  43%.

**Four times a PRE-EXISTING test caught a real defect in the first attempt** —
most sharply in C3, where the cooldown settlement ran only on the exhausted path and
would have disabled the fix for every call that eventually got an answer. Run the
whole suite, not the new file.

**NEXT ACTION — the operator’s voice session.** Everything acoustic is now waiting on
measurement rather than on code:

```
npm start 2>&1 | tee "$env:TEMP\mythos-terminal.log"
node mythos/scripts/verify-voice-session.js "$env:APPDATA\MYTHOS\mythos-server.log"
```

Target deltas: interrupted turns well under 15% (from 43%), max hold under 2s (from
13,396ms), `framesDropped` still 0, `bleedFloor` still 0.05, `flushedRaw` reported at
all (it never has been), zero `wakeword.detected` while MYTHOS is speaking, zero
incidents of the "tools are lying" class. Capture the terminal because **D4** exists:
one run died with no Crashpad dump, no child exit line, and no trail at all.

**WHAT IS LEFT, and why none of it is code-ready:**
- **A2’s acoustic fix (P0)** — diagnosed (the release flush is the carrier; the noise
  gate silences 0 of 133 frames at measured levels) and deliberately NOT written.
  `flushedRaw` from one real session confirms or kills it, and changing the acoustic
  path blind is how BUG-272 traded V1 for V2 in the first place.
- **C2’s other half** — an operator action, not a patch: move the Google Cloud OAuth
  app to Production/External, or accept weekly re-consent. MYTHOS now warns
  proactively either way.
- **D3** (unsolicited speech) and **D4** (the missing crash trail) — both need
  evidence a session has not yet produced.
**A1's escape hatch, and the one thing to check first if barge-in feels worse:**
the learned floor is now dormant and the floor in force is pinned at
`INITIAL_BLEED_FLOOR` (0.05). Turn it back on with
`MYTHOS_BARGE_LEARNED_FLOOR=1` in localStorage. Note the honest limit, which is
locked by a test: 0.05 clears the loud end of measured operator speech (0.069)
and still sits **above** the quiet end (0.0395), so a very quiet interruption
still will not open a candidacy. Lowering it further is A2's call, because below
0.05 the only thing rejecting 0.123 bleed is the 350 ms sustain test. The other
hatches are unchanged: `MYTHOS_BARGE_PROTECTED_MS`,
`MYTHOS_BARGE_PENDING_HOLD_MS`, `MYTHOS_BARGE_BLEED_MARGIN`,
`MYTHOS_LIVE_HALF_DUPLEX=off`.

**The gate for the acoustic work is another live session**, and
`node mythos/scripts/verify-voice-session.js <log>` now measures what it claims
to. Target deltas: interrupted turns well under 15% (from 43%), max hold under
2 s (from 13,396 ms), `framesDropped` still 0, `bleedFloor` still 0.05,
`flushedRaw` reported at all (it never has been), zero `wakeword.detected` while
MYTHOS is speaking, zero incidents of the "tools are lying" class. Capture the
terminal this time:
`npm start 2>&1 | tee "$env:TEMP\mythos-terminal.log"` — D4 exists because one
run died with no trail at all.

### 2026-08-18 (superseded by the block above, second entry) — BUG-272 slices 1–5 are SHIPPED IN CODE and pushed. Next action: the operator's scripted mic session, then `node scripts/verify-voice-session.js <log>`.

**Status: merged-order position UNCHANGED (6.5 ☐ · 6.6 ☐ · 7 ☐).** Four commits
on `main`: `6d1dc34` (slice 1, wake word survives a stale mic device id + bounded
backoff/devicechange re-arm), `8bf1acc` (slice 2, `live.echo-check` on every
decision), `daf89d4` (slice 3, the playback-aware barge-in state machine),
`190cd74` (slice 4, tool honesty). Suite **4940/4940/0 fail/0 skipped**.

**NOTHING HERE IS LIVE-VERIFIED, and slices 1 and 3 cannot be.** They are
acoustic and device-dependent. This repo has already shipped a slice with 16
green tests that could not boot the app — unit-green proves the state machine,
not that the operator's room stopped interrupting MYTHOS.

**NEXT ACTION — the scripted ~10-minute session** (MYTHOS speaks ~60s in a quiet
room; interrupt at 1s/3s/8s into its speech; speaker volume low/med/high; wake
word attempted before and after s2s starts; `launch_app`/`focus_window` twice
each). Then run **`node scripts/verify-voice-session.js <path-to-log>`**, which
prints every BUG-272 pass criterion green/red. The criteria live in that script
deliberately: two hand-count errors from the 2026-08-17 analysis survived into a
written fix plan, and a script cannot make them.

**Read BUGS.md's BUG-272 status block before touching anything** — it records
five corrections to that entry's own fix plan, found by reading the code. The
load-bearing ones: there is no 13-second ceiling (an 8s ceiling refreshed by
arriving audio); "preroll cap 150 frames (1.5s)" is off by 10× and the cap must
stay a derived expression; and the adaptive bleed floor must rise ABOVE the flush
tier, not be clamped below it, because this room's bleed is above both tiers.

**T2's browser surface is now BUILT** (`open_web(browser:true)` -> the new
`mythos:open-external` fork-IPC channel -> `shell.openExternal`, http/https only,
validated with WHATWG `URL` before the hand-off because that call runs whatever is
registered for a scheme and the URL comes from a model-composed tool call). No
surface is now a FAILURE rather than an unverified success. `bug-075`'s test did
NOT need changing after all - its assertion is still correct, because this adds a
different surface rather than widening the media window.

**Nothing in BUG-272 is left unbuilt.** What remains is the operator's session.

**If the session still self-interrupts:** the escape hatches are
`MYTHOS_BARGE_PROTECTED_MS` (0 disables the protection window),
`MYTHOS_BARGE_PENDING_HOLD_MS`, `MYTHOS_BARGE_BLEED_MARGIN`, and
`MYTHOS_LIVE_HALF_DUPLEX=off` for the whole gate — all localStorage, all
absolute-precedence, no code change needed. Read `bargeVetoed` and `bleedFloor`
on the `voice.capture-suspend` lines first: high vetoes with a happy operator
means bleed is being correctly rejected; high vetoes plus "it still ignores me"
means the window or the floor is too aggressive.

### 2026-08-18 (superseded by the block above) — BUG-271's live re-test HAPPENED: the evidence is inventoried as BUG-272, and the fix plan is written.

**Status: merged-order position UNCHANGED (6.5 ☐ · 6.6 ☐ · 7 ☐).** The
operator ran the 20-minute post-BUG-271 voice session in the noisy room
(2026-08-17 21:35–21:56 UTC, 72 live turns). **Everything it proved and
broke is recorded in BUGS.md's BUG-272 entry — that entry is the full
handoff; read it before touching anything.** Summary:

- **What BUG-271's fixes demonstrably did:** the noise gate zeroed 5,000+
  frames and dropped ZERO (no operator speech lost); the suspend-log
  evidence fields delivered the diagnosis below — the data that was missing
  on 2026-08-16 existed for the first time.
- **What they did NOT fix:** self-interruption at 63% of turns (45/72
  interrupted) — the raised eager tier 0.05 sits BELOW this room's measured
  speaker-bleed floor of 0.09–0.38 RMS, so no static constant can work;
  real barge-ins held 10–13s by the ceiling (16 `ceiling-fail-open`
  events); the echo filter fired ZERO times (`live.echo-dropped` absent all
  session); phantom ASR persists; the wake word died at boot
  (OverconstrainedError, stale `deviceId:{exact}` the surviving cause) and
  never re-armed; `launch_app` resolved "code" to the ZCode process via the
  unanchored substring rung; `open_web(browser:true)` failed 7/7 silently
  under Electron (no working surface; breaker counted unverified as
  success).
- **The agreed fix order (do not tune the eager threshold alone — V1 and V2
  are opposite failures of one RMS-only policy, and bleed overlaps the
  speech band):** audio ownership → echo attribution → barge-in policy →
  tool honesty. Slices, in the BUG-272 entry: **1** wake-word relaxed retry
  + backoff re-arm + constraint logging; **2** echo-check instrumentation
  (privacy-safe fields only — never transcript text); **3** playback-aware
  barge-in state machine (IDLE/PROTECTED/INTERRUPTIBLE/PENDING/CONFIRMED),
  2s ceiling replacing 13s, preroll cap ~150 frames; **4** launch_app
  partial-match demotion + resolvedName + open_web `shell.openExternal`
  surface + breaker counts unverified as failure + cross-turn dedupe +
  per-tool-class ack deadlines; **5** records + scripted verification
  session with pass criteria.

**NEXT ACTION — implement BUG-272 slice 1 (wake word survives mic
failure).** Full spec in the BUG-272 entry's "Slice 1" section. RED-first.
Then slices 2–4 in order, each its own commit, pushed immediately
(concurrent-session rule). The scripted verification session (Slice 5)
needs the operator at the mic on the machine with the noisy room. **The
Part B gating is unchanged:** steps 6.5, 6.6 and 7 tick only after Part B
passes, then Part C releases v0.1.10. This block supersedes the two
BUG-271/BUG-270 re-test asks below — the re-test happened and its results
are the BUG-272 inventory.

### 2026-08-17 — BUG-271 CODE-COMPLETE + PUSHED: the Live-path fix for what BUG-270 fixed on the wrong path. Next action: the live acoustic re-test in the noisy room.

**Status: merged-order position UNCHANGED (6.5 ☐ · 6.6 ☐ · 7 ☐).** The block
below fixed BUG-270 on the batch path — but the operator's machine runs the
Gemini Live path (`VOICE_S2S_ENABLED`), which is why nothing changed after
that fix shipped. **BUG-271** is the Live-path diagnosis and fix, shipped in
code across `d3d6226`, `bb10623`, `952580e` plus the records commit (see the
Progress-log row and BUGS.md):

1. **The self-interruption echo loop** — MYTHOS's own voice replayed into
   Gemini's `START_SENSITIVITY_HIGH` VAD, transcribed as the operator,
   interrupting itself mid-word. The Live path now has the batch path's
   battle-tested echo filter (`src/core/voice/echo-filter.js`, ≥60% word
   overlap vs the last 3s of MYTHOS speech); a matching transcript behaves
   as if it never arrived and logs `live.echo-dropped` (ratio only, never
   transcript text).
2. **Phantom words from ungated noise** — the Live send path streamed every
   frame with no gate. `ui/public/js/voice/live-noise-gate.js` now ZEROES
   below-floor frames (never drops — wire shape and Gemini's VAD timeline
   untouched) at BOTH `live-audio` send points, and the eager barge-in tier
   is raised 0.035/200ms → 0.05/300ms (above the measured speaker bleed,
   still below the 0.056 flush tier).
3. **The hidden evidence** — the client has sent ring/gate diagnostics on
   the own-voice-release transition since `36561bd`, and the server
   discarded every one of them. `voice.capture-suspend` now logs them all
   under their exact client names (`prerollFrames`, `prerollCap`, `heldMs`,
   `framesDropped`, `framesZeroed`, `peakRms`, `ownVoiceGate`). No wire
   change — the server only logs more of what it already receives.

**NEXT ACTION — the operator's live acoustic re-test:** restart the app and
converse in the noisy room. Watch for phantom words (defect 2) and
self-interruption/echo turns (defect 1). If anything persists, the new log
lines in mythos-server.log name the responsible gate: `live.echo-dropped`
(the echo filter fired), `peakRms` (how loud the bleed got), `framesZeroed`
(what the noise gate silenced), `framesDropped` (what the preroll ring
lost). This re-test subsumes the voice checks of the block below; everything
else there stands. **The Part B gating is unchanged:** steps 6.5, 6.6 and 7
tick only after Part B passes, then Part C releases v0.1.10.

### 2026-08-17 — Part B's FIRST live voice check FAILED — and it falsified a same-day change. BUG-270 fixed in code; voice checks must be re-run.

**Status: merged-order position UNCHANGED (6.5 ☐ · 6.6 ☐ · 7 ☐).** The
operator ran the first real voice conversation (Part B's voice checks, batch
path — `VOICE_S2S_ENABLED` unset). Verdict: "It is very glitchy. It
interrupts and it's breaking in between all sorts of things… It's not
picking up words from the noise." Two findings, both now fixed in code
(**BUG-270**, see BUGS.md and the Progress-log row):

1. **The interruptions were the 900ms endpointing experiment (`e19ac07`,
   shipped the same morning, flagged unit-green-only) failing its own
   predicted live test.** Natural pauses >900ms split one utterance into two
   clips; MYTHOS answered mid-thought; the BUG-027 half-duplex gate then
   swallowed the continuation. **Reverted to 1800** (schema + voice-loop
   literal + `.env.example`, doc-truth-pinned). Still env-tunable.
2. **The missed words were undiagnosable because the drop was silent.** The
   batch path's clip gates (peak RMS, min length) used to `return` with zero
   evidence anywhere. **Both drops are now loud** — console.warn with the
   measured value + floor, and a HUD caption ("🎤 too quiet — not sent").
   Pinned red-first by `test/bug-270-clip-drop-observability.test.js`. The
   BUG-020 thresholds deliberately UNCHANGED — the new observability makes
   the next tuning step evidence-based (`VAD_SPEECH_RMS=0.025` first, or
   `VAD_ENGINE=silero` for the trained speech-vs-noise detector).

**NEXT ACTION — the operator re-runs the voice checks of Part B** (the other
checks stand as listed in the block below): a conversation WITH natural
pauses — MYTHOS must no longer jump in mid-thought; speech in the noisy
room — if still missed, note whether the "too quiet" hint appears, which
names the gate to tune. Everything else in the Part A summary below is
unchanged; steps tick only after Part B passes.

### 2026-08-17 — v0.1.10 closeout, Part A CODE-COMPLETE: BUG-269 fixed, PIN defaults ON, the 6.5/6.6 audit work done. Steps still ☐ — the operator's Part B sitting is the only gate left.

**Status: merged-order position UNCHANGED (6.5 ☐ · 6.6 ☐ · 7 ☐) — by design,
not drift.** The "Closing 6.5, 6.6 and 7 — the path to releasing v0.1.10"
plan's Part A (all the code work) shipped in four commits, each unit-green,
independently reviewed, pushed:

- `9b98bc3` — **A1 / BUG-269**, the intermittent press-to-talk hotkey, fixed
  at three independent defects: the lost-IPC race (a press between hotkey
  registration and the renderer's listener was lost forever — now a
  `mythos:renderer-ready` signal + a single-press latch that re-arms on
  reload), toggle re-entrancy (concurrent presses interleaved — now an
  in-flight guard that drops, never queues), and structural lag (`arming`
  state sets synchronously before any await; `vadTick()` runs once
  immediately, removing up to 100ms of dead time). New behavioural tests were
  red-first: 8/14 failing before the fix, 20/20 after.
- `a847894` — **A2**, `PIN_SESSION_ENFORCE` schema default false→true,
  enacting the operator's 2026-08-17 answer. Safe by construction:
  `pinSessionRequired()` requires BOTH the flag and a configured PIN — no
  PIN, no lockout. `.env.example` documents the opt-out.
- `e62acbd` — **A3 / step 6.5**, informed consent at the install point: the
  setup wizard's wakeword component now states the weights are openWakeWord,
  CC BY-NC-SA 4.0, non-commercial, and downloading them is the user's own
  action; the allowlist test pins the notice. Decision 4 recorded in the 6.5
  section; the own-model training workstream is superseded.
- `1bee47f` — **A4 / step 6.6**, the last named audit gap closed: NVIDIA
  NIM's production-use definition quoted verbatim with source + fetch date in
  `THIRD_PARTY_NOTICES.md` (free hosted tier is development/evaluation only;
  production needs an NVIDIA AI Enterprise licence), a note beside the NIM
  keys in `.env.example`, and a lane audit: NIM leads NO default lane, so no
  de-ranking was needed. Facts recorded, no legal conclusion — per the
  standing limit.

Suite **4823 / 4821 pass / 0 fail / 2 skip** (both skips pre-existing
environment skips), `sync-test-count --check` OK.

**NEXT ACTION — the operator's Part B sitting, one session, in order (a fail
is more useful than a retry):**

1. **Merged vault loads.** Launch the app once; confirm a clean start and
   that it recalls something old. The 2026-08-17 merge added 734 episodic
   entries to a file the app reads at boot, never verified inside the running
   app.
2. **PIN.** Set a fresh PIN, fully quit, relaunch — the PIN screen must
   appear. Then confirm an app with NO PIN configured is not locked out —
   the safety property the default-on relies on. (Do NOT import the orphaned
   `%APPDATA%\agent-os\pin.json`; set a fresh one.)
3. **Hotkey (the A1 fix).** Press the talk hotkey twenty times from another
   application: ten cold presses right after launch (what A1a fixes), ten
   warm. Count misses; the visible state must change instantly on every press
   even when audio is slow.
4. **Screen share.** `LIVE_SCREEN_SHARE_ENABLED=true`, then ask "what's on my
   screen".
5. **Cursor overlay.** `Ctrl+Alt+C`.
6. **Persona and voice by ear.** Judge the persona and the `Aoede` voice
   across a greeting, a status check, pushback, a build request and a failing
   tool — also the first real chance to hear the CRLF fix (the authored
   persona had never reached the model on a Windows-edited vault before
   2026-08-16).
7. **Barge-in.** Interrupt mid-sentence; confirm it stops.
8. **Installer.** Install the built installer on a clean path; confirm the
   app launches from it.
9. **Watch for the second voice throughout.** When the Live path returns text
   with no audio, MYTHOS finishes through the local TTS chain in a different
   voice — architecture, not a glitch. If you hear it, note which check.

**When Part B passes, the next session:** tick 6.5, 6.6 and 7 in the
merged-order line below (a tick is only valid once the matching Part B check
was performed — this repo once shipped six-of-eleven broken behind green
tests), then run **Part C**: `node scripts/release.js patch --yes --ci` —
bumps 0.1.9 → 0.1.10, commits, tags, smoke-builds, pushes; the tag push
triggers the release CI. Do NOT touch `build.appId` (`com.mythos.assistant`)
or `package.json` `name` (`agent-os`) — that is Windows' install/upgrade
identity. The build stays unsigned by design (SmartScreen warns;
`latest.yml` still enforces SHA512).

**Step 8 (six lanes, AD-11…AD-21) remains planned-not-started** and unlocks
only when 6.5, 6.6 and 7 are ticked; its design lives in the blocks below.

### 2026-08-17 — step 8 grew two lanes: 8E (Agency roster) and 8F (the four TencentDB assets). PLANNING ONLY, NO CODE. Position unchanged.

**Status: merged-order position UNCHANGED (6.5 ☐ · 6.6 ☐ · 7 ☐). Next action
UNCHANGED. Step 8 still does not start until 6.5, 6.6 and 7 are ticked** — the
operator re-confirmed *plan only, nothing built* when asking for this.

The operator named three upstream repos to fold into MYTHOS — `prime-agent`,
`TencentDB-Agent-Memory`, and (new) `msitarzewski/agency-agents` — asking for
"the best of the best: memory, agent skills". Two of the three were **already
designed in** by the step-8 block below, so this pass added only what was
genuinely missing:

- **8E — the Agency roster reaches the seats.** The finding that sized the lane:
  agency-agents is **already half-vendored** — six personas ship as
  `mythos/skills/persona-*/SKILL.md` (MIT, in `skills.allowlist`, credited in
  `THIRD_PARTY_NOTICES.md`) — but they are **catalogue-only**. There are two
  persona layers that cannot see each other: `skills/loader.js` serves those six to
  the model via `use_skill`, while `agents/personas.js` serves the *seats* from a
  different directory holding four files. And `pickBuilderPersona()` is a two-way
  keyword coin flip — one frontend keyword list, else `backend-builder` — so cards
  about deploy, schema, credentials or test coverage all get the backend builder and
  the roster is never consulted. 8E bridges the roots (8E.1), makes the router
  scored and self-reporting (8E.2), and vendors **eight** more personas that each
  have a named reader (8E.3), leaving ~220 unvendored on purpose.
- **8F — the four TencentDB assets 8C did not take.** 8C took only the L0→L3
  layering. The operator wanted all four of the rest: **8F.1** versioned skills
  (`memory/skills.js` overwrites in place, so a worse auto-distillation silently
  destroys a better one — and `recordUse()` must *not* snapshot or it is a disk
  leak), **8F.2** `[[wiki-link]]` resolution + backlinks over the existing
  Obsidian-compatible Notes store with **no index file**, **8F.3** scoped recall
  (`meta.scope`/`meta.audience` tags first, the filter second, applied at the one
  place `excludeKinds` already is — its team/ACL half is explicitly not built, no
  reader in a single-operator product), **8F.4** CodeGraph, which opens with an
  **adopt-vs-build decision** because the adoption matrix already carries
  `tirth8205/code-review-graph` at 🟢 P1 for exactly this.
- **Five new invariants, AD-17…AD-21**, mirrored into V2 spine §1: one persona
  loader; a routed seat states which seat and why; a skill body is never overwritten
  without keeping its predecessor; a graph answer carries its freshness; a scope
  filter removes, never fabricates, and says what it withheld.

Upstream filenames for 8E.3 were enumerated from the **real** tree with
`gh api repos/msitarzewski/agency-agents/git/trees/main?recursive=1` — the
`tree/main/...` web path 404s, so do not guess them. All three upstreams are MIT,
so the commercial gate (6.5) is unaffected; **extend** the single agency-agents row
in `THIRD_PARTY_NOTICES.md` rather than adding a second.

### 2026-08-17 — the FIRST real operator Electron sitting. Three step-7 items verified by a human, two defects found, and the forked vault merged.

**Status: 6.5 ☐ · 6.6 ☐ · 7 ☐ — step 7 is NOT ticked, but it moved for the first
time since 2026-08-04.** The operator ran the sitting this file has been asking
for since then. `npm start` (which is `electron electron/main.js` — the real
desktop app) launches and runs correctly from an ordinary right-click terminal.

**Verified by a human, first time ever:**
1. **The app launches and runs** — Slice 1, previously unit-green only.
2. **Close-and-reopen works.** `MYTHOS.exe` disappears from Task Manager and a
   double-click relaunches it. **This is BUG-225's quit seam, fixed 2026-08-17
   and never before checked by a person.**
3. **The press-to-talk hotkey fires while another application holds focus** —
   Slice 2's core claim.

**Two defects found, both green in the automated suite — the Slice 5 lesson
again, and it is now three-for-three: a green suite is not evidence that the
desktop app works.**
- **BUG-268 — `Ctrl+Alt+X` (screen text capture) does nothing.** A popup fires,
  then no result appears anywhere. **Operator explicitly DEPRIORITISED it the
  same day** ("not one of the most important features right now"). Undiagnosed on
  purpose — the BUGS.md entry records only what was observed and refuses to guess
  a cause.
- **BUG-269 — the press-to-talk hotkey is intermittent**, with variable lag and
  occasional total silence. Reliability defect, not absence. Kept separate from
  268 deliberately so a fix for one cannot close both.

**The PIN question is answered and is NOT a bug.** No PIN screen appears from the
Start Menu. Cause: the PIN was set in the pre-rename vault and the current build
never reads it (see the vault fork below). When `PIN_SESSION_ENFORCE` is decided,
set a fresh PIN — do not import the old `pin.json`.

**The vault had FORKED, and it is now merged.** Before `electron/main.js` began
calling `app.setName('MYTHOS')`, dev runs wrote `%APPDATA%\agent-os` while the
packaged app wrote `%APPDATA%\MYTHOS`; both were live on the same days.
`%APPDATA%\MYTHOS` and `%APPDATA%\mythos` are ONE directory (Windows is
case-insensitive) — so two vaults, not the four an earlier note implied.
Stranded in the orphan and now recovered **additively, with a backup, nothing
overwritten**: **734 episodic entries** (203 on 08-11, 499 on 08-12, 32 on
08-13), **572 audit lines**, **31 lessons** (90 → 121) and **2 operator facts**
(37 → 39). Verified afterwards: every merged line parses, zero duplicate ids, and
a re-run finds nothing left to move. Backup at
`%APPDATA%\MYTHOS\_backup-before-vault-merge-2026-08-17T08-14-22`; the orphan
directory was left in place, so the whole operation is reversible.
**Deliberately NOT merged, each for a reason:** 6 goals still marked `proposed`
and five days stale (copying them lets the autonomous loop act on week-old
conversational commitments), an expired all-`fired:true` reminders file, the old
`pin.json`, six Identity files whose live copies are NEWER, and 10 byte-identical
Skills files.

**Two of step 7's three product decisions were answered by the operator on
2026-08-17:**
- **PIN — ANSWERED: `PIN_SESSION_ENFORCE` defaults ON.** *"If we have set it, it
  should default to the main home screen. Whenever we start the app, it should
  ask for the PIN."* So: enforcement on by default, and it self-disables when no
  PIN exists (`pinSessionRequired()` already requires both the flag AND
  `pinLock.isConfigured()`), which is what makes an on-by-default safe — no PIN
  set means no lockout. **Do NOT import the orphaned `%APPDATA%\agent-os`
  `pin.json` to satisfy this** — the operator sets a fresh PIN once enforcement
  is on. The operator also asked for an **on-demand + AFK lock** ("lock and go…
  once we are back we can type, just like Windows lock") and placed it
  explicitly in future scope, so it is recorded in
  `MYTHOS-Post-Parity-Plan.md`, NOT here.
- **Product name — STILL OPEN, and actively being worked.** The operator is
  researching names because most candidates are taken. **Consequence that matters
  before any public release:** `build.appId` is `com.mythos.assistant` and that
  string is Windows' install/upgrade key. Change it after users exist and Windows
  installs a SECOND copy side by side instead of updating. Today the only install
  is the operator's, so the change is still free — it stops being free at the
  first external user. Leave `appId` as-is until the name lands; do not
  "tidy" `package.json`'s `name: agent-os` into something else in the meantime,
  because that is what derives the dev userData path and the vault fork below is
  what that costs.
- Gesture model licence — unchanged, still open (excluded from the installer).

**Next action — the operator's:** the remaining step-7 checks that still need a
human — `LIVE_SCREEN_SHARE_ENABLED=true` then "what's on my screen"; the cursor
overlay via `Ctrl+Alt+C`; judging the persona and the `Aoede` voice by ear;
barge-in; and installing the built installer on a clean path. **Plus one new
check created by this session: launch the app once and confirm the merged vault
loads cleanly** — 734 recovered episodic entries changed a file the app reads at
boot, and that merge is not yet verified inside the running app.

### 2026-08-17 — step 8 planned and tracked. NO CODE WRITTEN. Position unchanged.

**Status: merged-order position UNCHANGED (6.5 ☐ · 6.6 ☐ · 7 ☐). Next action
UNCHANGED.** This session was planning only. The operator asked for three
upstream repos to be wired into MYTHOS end-to-end —
`PrimeIntellect-ai/prime-agent`, `addyosmani/agent-skills`,
`TencentCloud/TencentDB-Agent-Memory` — and then set the sequence explicitly:
**write the plan now, build it only after 6.5, 6.6 and 7 close.** The whole
design therefore landed in this file as **Step 8**, with nothing implemented.
(One `loader.js` edit was started before that instruction arrived and was
reverted; `git status` confirmed clean.)

**What step 8 contains:** **six** lanes — 8A skills truth + curated vendoring, 8B
the Continual Harness, 8C memory budget + Live depth, 8D budgets + quality
gates, and (added later the same day, see the block below) 8E the Agency roster
reaching the seats, 8F the four TencentDB assets 8A-8D had not taken — each with
its architecture, a wiring table naming every writer and every reader, real code
snippets, and eleven new anti-drift invariants **AD-11…AD-21**
(mirrored into the V2 spine §1 table). Two operator decisions are recorded there
and should not be relitigated: prime-agent and TencentDB are **patterns-only,
never dependencies** — prime-agent installs by `curl | sh` (forbidden by the root
`CLAUDE.md`, where Hermes is the single deliberate exception) and TencentDB needs
a 3-service Docker stack that breaks portability and the sold-installer story.
Only addyosmani's skills and agency-agents' persona markdown get vendored — six
addyosmani skills (8A.4) and eight personas on top of the six already on disk
(8E.3) — by the process `mythos/skills/README.md` already documents.
Infrastructure delta: zero — no dependency, service, port or container.

**The research finding worth keeping:** MYTHOS already has most of what those
repos are known for. `skills/loader.js` is multi-root resolution with progressive
disclosure (prime-agent's own shape); `memory/index.js:243 recallHybrid()`
already fuses keyword and vector ranking by RRF (TencentDB's headline retrieval
design); and `Identity/operator-profile.txt` is already TencentDB's "L3 persona",
reaching every surface through `persona()`. Step 8 is gap-closing, not importing
— which is why 8C.3 (L2 scenario blocks) is marked provisional and gated behind
8C.2 proving insufficient.

**Two live bugs were reproduced while planning and are deliberately NOT fixed**
(they are lane 8A's first two items; fixing them now would jump the operator's
sequence). **BUG-266** — six skill names are hardcoded into prompt text
(`voice-agent.js:275`/`:93`, `from-skills.js:37`) that are PHANTOM on any fresh
clone, proven by running the real loader with `USERPROFILE`/`HOME` pointed at a
non-existent directory; `ui-ux-pro-max` is phantom even on this machine, because
it is vendored essence-only and `loadContent()` reads `SKILL.md` exclusively.
**BUG-267** — `buildLiveSystemInstruction()` injects a 43-skill catalogue whose
header tells the model to "call use_skill", while `use_skill` sits in
`VOICE_ALLOWLIST_EXEMPT` and Live declares only `DEFAULT_ALLOWLIST` — so the
primary spoken surface is told to call a tool it was never given. Both are cheap.
Neither is urgent enough to reorder the build.

**Next action — unchanged by this session:** whatever the block below names.
Step 8 waits for 6.5 / 6.6 / 7.

### 2026-08-17 — the nine open coding defects (fix-plan waves 1–3), all shipped

**Status: merged-order position UNCHANGED (6.5 ☐ · 6.6 ☐ · 7 ☐).** The
operator-approved fix plan for the nine open coding defects executed end to
end: nine commits, one per verified fix, each through the hook gate and pushed
immediately (BUG-037). **BUG-260..BUG-265** in BUGS.md carry the detail; the
2026-08-15 RCA's wakeword and TOOL_ACK_DEADLINE_MS bullets are closed too, and
BUG-225's quit seam is fixed at all four structural defects. Suite
**4760 / 4758 pass / 0 fail / 2 skip**, counts synced per commit.

The headline items: **BUG-225's zombie-on-close** had four independent holes
(re-fork race in the window-all-closed→before-quit gap, media/overlay windows
pinning `window-all-closed` un-fired, no kill ladder on the ordinary close
path, no hard-exit backstop for a wedged before-quit) — all fixed, pinned by
8 source-shape tests, and one trap the fix itself forced: `before-quit`'s
vault-push skip now keys off an explicit `installerHandover` flag, because
pre-setting `isQuitting` in `window-all-closed` would otherwise have skipped
the vault push on every ordinary quit. **BUG-262's distillation dead gates:**
the cortex idle gate never opened (timer heartbeats — the same gate that
blocked `mull()`, per this file's own Phase-4 live-tested-broken note) and the
active branch's consolidate sat below the goalless early-return; both fixed,
and every skip now emits `memory.consolidate-skip` with a reason, so "did it
ever distill" is answerable from the next session's log for the first time.
**The WebView2 caret false-refusal (BUG-263)** is split on the landed title:
real app names keep the hard failure (the 2026-07-31 MYTHOS-dashboard and
Antigravity guards are intact and pinned), the "Chrome Legacy Window"
hosting-artifact shape returns honest-unverified before the read-back oracle.

**Concurrent-session note:** a second session (freebuff worktree) was live
throughout and landed `42f370d` (dockerignore) between this plan's commits —
stacked cleanly, no conflict. Hook-blocked commits twice on suite-load flakes
from the two sessions' overlapping full-suite runs; retried clean each time.

**Next action — the operator's, now four sittings, all cheap:**
1. **One X-close sitting** (BUG-225): close the app with Task Manager open —
   `MYTHOS.exe` must exit within ~10s, and a double-click must relaunch
   immediately.
2. **One packaged-install check** (wakeword): on the installed build with no
   userData weights, the HUD must report the wake word honestly unavailable —
   not arm off source-tree leftovers.
3. **One voice session** (BUG-262): afterwards grep the log for
   `memory.consolidate-skip` — the reasons observed there answer "did it ever
   distill" factually; also covers the 08-15 persona/facts checks still owed.
4. **Aether side** (BUG-265 root cause): the reconnect-storm diagnosis needs
   the live aggregator — operator-side, honestly open.

### 2026-08-16 — gap analysis, then the CI-red double root cause (BUG-258 + BUG-259)

**Status: merged-order position UNCHANGED (6.5 ☐ · 6.6 ☐ · 7 ☐).** A deep
gap-analysis pass over plans-vs-code-vs-repo state, and the red CI it forced
into the open. **CI's `test` job had been failing on every push since
2026-08-13** while the local hook stayed green and the e2e job passed — two
independent, both machine-dependent causes, both now fixed and verified in
CI's exact conditions: **BUG-258** (the immune reprobe test needed a
machine-local hermes; now pins `HERMES_CLI` to `process.execPath`) and
**BUG-259** (`briefing.js`/`from-pc.js`/`electron/child-exit.js` unref'd
one-shot timers whose only job is to settle a promise — in a quiet process
(the Node 22 runner child) they never fire, the test is killed as pending,
and siblings cascade to `cancelledByParent`; CI's summary said `fail 0` and
the test-count gate failed on the number mismatch, a shape that pointed away
from a test failure). Local runs were green because Node 24's runner child
behaves differently — the suite is now reproducibly green under Node 22,
clean env, UTC, browser-less: **4718 / 4716 / 0 fail / 0 cancelled / 2 skip.**

**Also landed:** hygiene (`.freebuff/` + graph-data gitignored, orphaned
ADOPTION-MATRIX/EXPLAINER adopted, 0-byte stray deleted), the doc-truth pass
(phantom paths, tool-count comments, seams 23→21, ROADMAP D-05 ticked,
spine §18.4 supersession note, `mythos/docs/DRIFT-LOG.md` created), and
**step 6.6's first audit pass** in THIRD_PARTY_NOTICES.md: Hermes MIT
re-verified live; MediaPipe gesture weights re-confirmed UNVERIFIED (both
canonical docs URLs now 404); provider ToS for resale recorded verbatim for
Google/Groq/Mistral/Cerebras/OpenRouter with sources and dates; **NVIDIA NIM
is the named remaining gap** (its terms pages render empty). 6.6 stays ☐
pending that gap + operator/lawyer review of the recorded facts.

**CI is GREEN — run 181 on `f16c0fd`, the first green `ci` since 2026-08-13.**
Six causes in total, peeled one annotation round at a time after the
`::error::` channel was added to ci.yml (itself now permanent: failing-test
names AND their assert messages surface as check annotations, readable via
the public API — no more three-day-silent red): BUG-258 (hermes ENOENT),
BUG-259 (three unref'd one-shot timers), the test job's missing root deps
(app-builder-lib), its shallow clone (real-history tests), a machine-coupled
count gate (strict pass/skipped comparison vs honest fixture-skips — the gate
is now machine-independent: strict on tests/fail + a partition invariant),
two fixture-dependent tests (openWakeWord allowlist hard-assert, wakeword
static-asset subtest vs the SPA fallback), and a same-millisecond
`updatedAt` race in engagements/store (now monotonic by construction).

**Next action — the operator's:** the single voice session the 08-15 block
asks for (persona sounds like `self.md`; `think_deeply` rare; user-facts
recall without a tool call). The CI badge needs no attention — it is green.

### 2026-08-15 (latest) — the persona that was never loaded, and the cost of a tool call

**Status: merged-order position UNCHANGED (6.5 ☐ · 6.6 ☐ · 7 ☐).** The operator
reported the spoken path felt slower and sometimes did not answer at all. Four
defects, measured from the real session log and the real vault rather than
theorised. **Suite 4687 → 4700 / 4700 pass / 0 fail / 0 skip.**

**BUG-254 is the one that matters, and it is not about performance.** The
operator's authored `self.md` — a full JARVIS character brief — had **never
reached the model, on this machine or any other with a Windows-edited vault**.
`extractSection()` required a literal `\n` after each `## header`; the file is
CRLF, so `Purpose`, `Persona`, `Values` and `Origin` all parsed as `null` and
`persona()` fell back to "You are MYTHOS. Helpfulness, honesty, efficiency."
Nothing surfaced it, because a parse miss and a section the operator never
wrote both return `null` and both receive a plausible default. Verified against
the real vault: four sections `null` before, real content after. This is the
same shape as the gitignored-personas miss — **a loader that cannot find
anything returns exactly what a loader with nothing to find returns.**

**The performance finding, stated correctly: a tool call is two inference
passes.** `think_deeply` was 10 of ~34 tool calls in one conversation, and the
tool itself is blameless — 471-1081ms, 10/10 successful, zero 429s. Turn 32 is
the measurement: tool answered in 580ms, speech arrived 19 seconds later, and
the 10s `live.turn-stalled` detector fired in between. That is the "doesn't
reply" the operator heard. Fixed at the only lever the model actually reads —
the tool description — by making answering the default, naming the cost, and
giving it a self-check it can apply. Same reasoning raised the facts cap
(BUG-256): a fact the model cannot see becomes a `recall_memory` round-trip,
and the frame is composed once per session while a round-trip is paid per turn.

**Next action — the operator's, and it is one voice session:** talk normally,
then count `live.tool-call-batch` by tool in `%APPDATA%\MYTHOS\mythos-server.log`.
`think_deeply` should be rare rather than ten-in-thirty-four. **Watch the other
direction too** — if it never fires on a genuinely hard question, the wording
swung too far and needs loosening, not reverting. While there: MYTHOS should
now sound like the `self.md` brief (dry, British-butler), which is the visible
proof of BUG-254.

**Deliberately NOT done:** the Aether reconnect backoff is unchanged (retrying
forever is correct for a sensor whose aggregator may appear at any time; only
the muteness was wrong), and `AETHER_ENABLED=false` is set in the operator's
**untracked** `.env`, not in tracked config — anyone running the BLE bridge
should leave it on.

### 2026-08-15 (late) — the full-history log audit: what the pattern was

**Status: merged-order position UNCHANGED (6.5 ☐ · 6.6 ☐ · 7 ☐).** Not parity
work and not a bug wave. The operator asked for the PATTERN across all logs
rather than the next defect, so three read-only analysts were run over the live
vault (88 lesson files, 26 episodic days, the 30-incident ledger, the session
server log) and this repo. **Suite 4674 → 4687 / 4687 pass / 0 fail / 0 skip.**

**Four patterns found. Two were structural, and those two are fixed:**

1. **BUG-251 — the learning loop was write-only on the surface that matters.**
   The Live voice path's system instruction carried rules, persona, version,
   capabilities, skills and time, and **no memory of any kind**. Everything
   durable the vault knew (`Semantic/user-facts.md`) was reachable only from
   the TYPED compose-bar path's `recallHybrid()`. So "you never remember my
   songs" described the surface accurately while the songs sat on disk — and
   the "two brains" complaint a week earlier was the same mechanism. Fixed with
   a synchronous `semantic.topic()` read injected as a labelled, size-capped
   `OPERATOR FACTS` block. **This is the READ half of BUG-249's WRITE half,
   fixed the same day: they were independently broken, so neither alone would
   have changed anything the operator experienced.**
2. **BUG-252/253 — the incident ledger and BUGS.md had no mechanical
   relationship.** 30 incidents recorded, **2** cited by id. Nothing hid the
   other 28; there was no way to ask, so nobody asked. `scripts/triage-incidents.js`
   asks it (id citation only — a same-symptom BUG never clears a report), and
   BUG-253 dispositions all 28. Ledger now reads 30 / 30 / 0.
3. **Chronic failures re-fail forever, each treated as fresh** — `gmail_unread`
   `invalid_grant` 25× over 5 days, CDP-unattached across 8 days in a month, a
   TTS chain whose first three links are structurally dead in a packaged build.
   Partly closed already by BUG-238's `terminal:true`; the general counter is
   **deliberately not built** (see below).
4. **Repeat reports dominate.** Five classes recur across separate weeks: media
   playing the wrong item, browser/window targeting, voice duplication,
   false-success verification, `screen_look` finding nothing. This is the
   finding behind items 1-3, not a separate one.

**Next action — the operator's, and it is one voice session:** ask MYTHOS
something only `user-facts.md` knows (a music preference) and confirm it
answers **without calling a tool**. That is the only thing a green suite cannot
show about BUG-251. While there, the previous block's checks still stand
(`brain-spend` distribution, `vision.attempt` at 1 attempt, `think_deeply`).

**Deliberately NOT built, so nobody "finishes" it blind:** the general
chronic-signature counter. The threshold that turns it into a useful standing
notice rather than a second stream of noise needs live evidence, and BUG-238
already covers the sharpest instance (a non-retryable failure now disables its
tool and serves the remedy). Guessing the threshold ships the noise.

**Still open, now NAMED rather than merely recorded** (from BUG-253's table):
the six-report voice-node-duplicate loop, `whatsapp_send` typing into Chrome
Legacy Window instead of WhatsApp, `open_web` opening a widget where a browser
was expected, and `open_folder` reporting `unverified` for a folder that opened.
Everything in the blocks below is still open and still the operator's.

### 2026-08-15 — brain-lane rewire + the personas that were never loading

**Status: merged-order position UNCHANGED (6.5 ☐ · 6.6 ☐ · 7 ☐).** Not parity
work. Every MYTHOS role was re-pointed at the model measured best for that job,
and one silent long-standing defect was found and fixed on the way.

**Suite: 4592 / 4592 pass / 0 fail / 0 skip.** Landed and pushed: `08b0e3e`
(lanes + `think_deeply`), `34fbf90` (personas). Full measurement data and an
authoritative AS BUILT section: `docs/free-tier-model-map.md`.

**Note for anyone reading an older suite number in this file:** the "4323 / 1
skip" below and the "4389" some notes carry are both stale. The 1 skip was the
short-`TEMP` artefact the root `CLAUDE.md` documents; with long-form `TEMP` the
honest figure is 0 skipped. Trust `sync-test-count.js`, not prose.

**What changed:**
- **Two new brain lanes.** `reasoning` (Cerebras `gpt-oss-120b` first) now serves
  `mull`, both reflection calls, the reviewer and reality-checker seats, design
  verify, orchestrator synthesize, `ask_agent` and engagement interviews — all of
  which ran on `llama-3.1-8b-instant`, the weakest model in the fleet, because
  `PREF_SIMPLE` was ranked on latency. `memory` (Google `gemini-3-flash-preview`)
  serves consolidation and document answering.
- **Load is now a first-class ranking reason.** Google's quota is per MODEL, so
  vision, memory and voice sit on three different Google models and get three
  independent buckets. Vision leads on Google rather than Mistral to keep
  Mistral's 4 req/min free for Hermes builds and embeddings — a load decision,
  not a quality one, and written in the code so it does not get "fixed" back.
- **`think_deeply` (new tool, T0, in the Live allowlist).** The only thing here
  that can change conversational quality: the Live path makes zero `brain.think`
  calls and its own model is capped at Flash tier on a free key, so no lane
  re-ranking reaches a spoken answer. A tool is the mechanism.
- **Personas were never loading, on any machine, ever.** `personas.js` searched
  only `mythos/vault/Personas/` — gitignored, and absent — so `loadPersona()`
  returned `null` for every role and every specialised seat silently ran as
  generic MYTHOS. Now an ordered search ending in a tracked `mythos/personas/`,
  with four authored defaults.
- Three silent breakages the lane split would otherwise have caused (persona
  injection scoped to the old lane list; terse styling implicitly attached to
  `simple`; `chainFor()` substituting the caller-less `text` lane for an unknown
  name without a word) are fixed and each is pinned by a test.

**Next action — the operator's, and it is small:** one voice session with the app
running, then read `%APPDATA%\MYTHOS\vault`. Three things to confirm, none of
which a green suite can show: `brain-spend` shows the new distribution (Cerebras
for reasoning, Google for vision/memory, Groq only for trivial); `vision.attempt`
shows Google first at ~1.5s with `attemptsTried: 1` rather than 3; and asking
something genuinely hard actually reaches `think_deeply`. Watch for Cerebras
429s — 5 req/min is the tightest budget in the new layout, and seven
low-frequency roles now share it.

**Blocked on / not done:**
- **Hermes's own build model.** `devstral-medium-latest` (12/12 @ 1593ms) is the
  candidate and `lanes.default.js`'s "41s" exclusion contradicts that
  measurement. Needs `build-refine.js`'s real render check over real builds. The
  model lives in `Hermes Agent/config.yaml`, which forwarded env does not
  override, so it is a Hermes-side change either way.
- **The benchmark is thin** — one sample per probe, ~50-token prompts, seven
  models tied at 4/4. Real prompts are 10k+ tokens. Re-probe at realistic size
  before treating the reasoning order as settled.
- Everything in the 2026-08-14 block below is still open and still the operator's.

### 2026-08-14 — operator-reported basics wave (BUG-221 … BUG-224)

**Status:** merged-order position UNCHANGED (6.5 ☐ · 6.6 ☐ · 7 ☐, all gating
shipping, not building). This session was not parity work — the operator reported
that the basics had regressed and was considering scrapping the project. Four bugs
found, four fixed, two live-verified.

**Suite: 4323 / 4322 pass / 0 fail / 1 skip.** Landed and pushed:
`cb505e5` `899daeb` `55f96c1` `0757cb4` (+ the runbook commit).

**The headline correction, because it invalidates a premise several documents
still carry: the installed app was never stale.** It is **v0.1.9, installed
2026-08-13 04:06**, which IS the latest published GitHub release (0.1.9,
2026-08-12). What made it look abandoned is that **v0.1.9 renamed the app's
userData directory from `%APPDATA%\agent-os` to `%APPDATA%\MYTHOS`** — so the old
vault and logs simply stop, and a forensic search of the old paths finds an app
that appears to have died two days ago. There are now FOUR vault locations on
that machine. Resolve the live one from the running build before concluding
anything from an absent log.

**What was actually wrong:**
- **BUG-221** (fixed, live-verified) — `ui_type` aborted on an unguarded advisory
  `SetFocus()`, the only unguarded one of four in `ps-automation.ps1`. Win11's
  WinUI3 Notepad refuses focus, and the exception killed the whole handler
  *before* `uia-setvalue`/`wm-char-post` — the two routes that need no focus and
  are the measured-working ones on MSIX apps. The ladder was intact; its entrance
  was not.
- **BUG-222** (fixed, NOT live-verified) — `self_capabilities` was withheld from
  the Live allowlist, so "what can you do?" and "what did you fix?" had no honest
  answer and the model improvised around them (the operator heard this as endless
  web-search suggestions). `capabilities.js` has been writing the true answer —
  tools, adapters, recent git changes — to `vault/Identity/capabilities.md` on
  every boot the whole time, with no reader on the voice surface.
- **BUG-223** (fixed, live-verified) — `close_window` reported `ok:true` for a
  window that was still open. The handler was honest (BUG-103 made it return a
  failure STRING); the dispatcher arm that converts a string to `ok:false` was
  missing, as it was on eight other commands. Fixed by hoisting that conversion
  to one gate instead of adding a 25th per-arm copy.
- **BUG-224** (fixed, NOT live-verified) — the interruptions AND the clipped last
  word are ONE mechanism: MYTHOS's own Live voice re-entered the mic and was
  streamed to Gemini's `START_SENSITIVITY_HIGH` VAD, which heard it finish a
  sentence, called it a barge-in, and **stopped synthesizing server-side**. That
  is why BUG-084's client-side tail guard never cured the clipping. A half-duplex
  gate now holds mic frames while MYTHOS is audible — gating the send only, so
  the local barge-in backstop still runs and opens the gate, with a 1.2s preroll
  replayed on release.

**Next action — the operator's, and it is now ONE sitting, not six:**
`docs/live-verification-runbook.md` Group C, in the order given there
(C1 wake word → C5 self-capabilities → C6 typing/close → C2+C3 echo and barge-in
→ C4 noise). C2 carries the four BUG-224 pass signals and names the regression
risk to watch: while the gate is held the LOCAL backstop is the only detector and
its threshold is higher than the server VAD's, so a soft interruption may need to
be firmer. Kill switch `localStorage.MYTHOS_LIVE_HALF_DUPLEX = 'off'` for an A/B.
**Read the transport warning at the top of Group C first** — C2/C3 were written
for the legacy `voice-loop.js` path, and every 2026-08-14 turn was `"s2s"`.

**Blocked on / not done:**
- **P0, UNCLAIMED as of this writing: the zombie-on-close bug.** Closing the app
  with X leaves the process alive; it then refuses to relaunch until the operator
  ends the task. This blocks daily use of the installed app and NOBODY has taken
  it — a second session was expected to and there is no commit or working-tree
  evidence that it did. Root area: `electron/main.js` teardown (child server
  fork, pc-child PowerShell child, ports 4478/5050) plus the single-instance
  lock, which currently swallows the relaunch silently. Related: BUG-029's
  pidfile is a mitigation that only kills orphans on the NEXT launch; proper
  graceful shutdown is ROADMAP D-07.
- **The updater is NOT broken — verified, do not "fix" it.** Feed reachable
  (public repo, releases through 0.1.9), progress/notification/install/
  post-restart notice/rollback detection all present and wired
  (`unfinishedUpdate()` → `MYTHOS_UPDATE_RESULT` → `update-report.js` → the boot
  greeting), 38/38 tests green. The v0.1.9 install *looked* dead only because
  NSIS `/S` hides its progress UI; the visible-notification work that fixes that
  perception landed 2026-08-13, i.e. AFTER that install. Next real update is the
  first one that will show itself.
- **6.5 / 6.6** unchanged: wake-word weights decision (train own model, separate
  workstream — **SUPERSEDED 2026-08-17 by Decision 4: wake word stays BYO with
  the non-commercial notice at the install point; there is no training
  workstream**), wider licence audit, and the money items (code-signing cert,
  update host). Standing operator-only: suspend the exposed Render instance, add
  a LICENSE, physical-phone checks.
- **Superseded claim:** any earlier note in this file that there is "no delegable
  work left" is false — the P0 above is delegable, and unclaimed.

### 2026-08-08 — pre-release security audit remediation (interleaved with the Stage 0-5 voice-node session)

**This section is about the RELEASE LAYER, not the parity build.** The merged-order
position below is unchanged by it. A full pre-release audit ran and its blocking
findings were fixed; steps 6.5/6.6/7 still gate shipping.

**Landed (11 commits): `e400885` `70d94a5` `1c6154b` `4b33ad6` `6dad1c2` `8b13ba1`
`9c8a0d1` `26fa034` `81ffa1f` `122af24` `4f09394`.** Suite 3255 / 3254 pass / 0 fail
/ 1 skip throughout.

**Evening addendum — two of the "deliberately NOT done" items below are now done.**
**H11 (asar) is closed and live-verified**, and **B6's buildable half shipped**
(`electron-updater` behind `MYTHOS_UPDATE_URL`, opportunistic signing, honest docs);
what B6 still lacks is only what money buys — a code-signing certificate and an update
host. Read those two bullets below for the two findings that came out of actually
running the packaged app, the most reusable of which is that a module-scope
`require('electron-updater')` breaks packaged boot while passing every test. Suite is
now **3283 / 3283 pass / 0 fail / 0 skip**. The next release-layer action is still the
operator's: run the built `dist/MYTHOS Setup 0.1.0.exe` (built, never run — not the
same test as `win-unpacked`), and answer the certificate/host question.

- **B2/H6** — the Electron key-store IPC channels answered ANY sender holding the
  preload bridge, and the media window (which `loadURL()`s caller-supplied URLs via
  Tier-0 `open_web`) shared the HUD's preload. A poisoned page could
  `setKey('GEMINI_API_KEY', …)` to reroute all model traffic, or `setKey('NODE_OPTIONS',
  '--inspect=…')` for RCE in the forked child. Now scoped to `isHudContents`, media
  window has its own empty preload, env-injection denylist, `will-navigate` guard.
- **H1 + a worse inverse.** `tokenOk()` let the bearer token bypass `PIN_SESSION_ENFORCE`
  — and, unconditionally first, let a PIN session alone satisfy every `/api/*` route and
  the WS upgrade. Since `POST /api/pin/verify` is exempt from auth by design, a
  network-exposed instance with a PIN set was a **remote auth bypass**: the
  `MYTHOS_AUTH_TOKEN` was reducible to a short numeric PIN behind a 5-attempt lockout.
  Both layers are now required on distinct channels when both are configured.
- **B7/B8** — `readJSONStrict` at the four remaining read-mutate-write sites. The
  serious one: a corrupt `pin.json` read as "no PIN configured" and silently DISABLED the
  lock. `mergeConsolidatedTopics` reordered write-verify-delete (it deleted every source
  topic before a write that never throws).
- **B3** — vault out of the install tree: Electron resolves under `userData` with a
  copy-and-verify migration that never touches the source; the bare-node default is now
  absolute, anchored to `mythos/`, not `process.cwd()`. This is the "factory-reset
  MYTHOS" incident's actual root cause, finally closed. **ROADMAP D-05 can be ticked.**
- **B4** — `render.yaml`: `healthCheckPath` was `/api/health`, which 404s, so the check
  could never pass; added the 1 GB persistent disk (the vault was ephemeral); dropped
  `PORT: generateValue`, which minted a random value that overrode Render's injected port.
- **H3/H7** — WS-upgrade rate limit, weak-`MYTHOS_AUTH_TOKEN` boot refusal, and a split
  CSP (narrow enforcing + fuller report-only; three real HUD features violate the strict
  policy today).
- **H8/H9/H12/H13/H14** — audit-log rotation, engagement back-fill on load, rate-limit
  bucket eviction, Aether partial-bind socket teardown, identity preserving malformed
  preference blocks.
- **B1/B5** — Electron 32.3.3 (17 months EOL) → 43.3.0, audited per-major against real
  upstream notes across all 8 modules used, and **verified by an actual launch**; Docker
  Node 20 → 22 with an `engines` floor.
- **H5** — the installer was shipping `Plans/` and `scripts/` (confirmed in a real
  `dist/win-unpacked/`). Excluded, but `setup-*.js` deliberately kept: runtime hint
  strings name them.
- **R3/R4** — untracked `.qoder/`/`.zcode/` scratch specs that still asserted "no
  authentication on any REST route or WS", fixed in `8be82f2`, in a public repo.

**Deliberately NOT done, with reasons — do not "fix" these without reading why:**
- **H11 (asar) — DONE 2026-08-08, on exactly the terms this entry set.** Kept for the
  record because the reasoning is what made it safe. Prior state: two agents
  independently concluded a `fork()`'d child cannot `cwd` into an asar archive, that
  `asarUnpack` alone doesn't help because `MYTHOS_DIR` resolves to the virtual
  `app.asar` path, and that it needed `main.js` to rewrite to `app.asar.unpacked` under
  `app.isPackaged` **plus a real packaged run** — flipping the flag alone passes every
  test and breaks boot on install. All three were done: `asar: true` +
  `asarUnpack: ["mythos/**/*"]`, `toRealPathIfPackaged()` translating `SERVER_ENTRY`
  and `MYTHOS_DIR` before `fork()` sees them, and a real `npm run dist` launched from
  `dist/win-unpacked`. **Live evidence, not unit-green:** the packaged app boots, the
  child server completes all 24 boot steps out of `app.asar.unpacked/mythos`, creates
  its vault under `userData`, and `pc-child` (PowerShell, spawned from the unpacked
  tree) answers `media_status` in 150-700ms.
- **H4 (wake-word models)** — the exclusion is deliberate: CC BY-NC-SA weights, product
  intended for sale. Absence is already loud and the setup hint stays actionable.
- **B9** — `sharp`, `adm-zip`, `uuid`, `image-size` all traced NOT reachable (rationale
  in `122af24`); only `brace-expansion` was fixed. Don't re-litigate each audit.
- **B6 (signing + auto-update) — the MECHANISM landed 2026-08-08; the CERT and the HOST
  are still the operator's, and still the sequencing risk.** What exists now:
  `electron-updater` as a runtime dep, a `checkForUpdates()` in `electron/main.js` that
  reads `MYTHOS_UPDATE_URL` at runtime and logs-and-returns when it is unset,
  `autoDownload:false` with `quitAndInstall` never called, `build.publish: null` so an
  ordinary build never depends on a host, `win.forceCodeSigning: false` so a missing
  cert yields an *unsigned* build rather than a failed one (confirmed in the real build
  log: "no signing info identified, signing is skipped"), and `CSC_LINK`/
  `CSC_KEY_PASSWORD` documented in CONTRIBUTING.md as env-only. **What is still
  missing is unchanged: a purchased certificate and an update host**, so every fix
  still reaches existing installs only by manual reinstall.
  **Two corrections worth carrying, both found by doing it rather than by review:**
  (1) `const { autoUpdater } = require('electron-updater')` at module scope **broke the
  packaged app** — it exited 1 instantly with an empty stderr while dev `npm start` was
  fine, because that export is a getter that constructs the platform updater on first
  property read, i.e. before `app.whenReady()`. This is the Slice-5 `screen` lesson
  again, in a dependency. Requiring it lazily inside `checkForUpdates()` fixed the boot;
  the two builds differed in nothing else, so the causal claim is measured, not inferred.
  (2) "Set `MYTHOS_UPDATE_URL` and updates work" is **client-side only**. A generic feed
  is polled for `latest.yml`, and electron-builder writes that file only when a publish
  config exists — so the release build must set `build.publish` even if the artifacts are
  uploaded by hand. Both points are pinned by `test/electron-updater-signing.test.js`,
  including a fixture that proves the module-scope-require checker actually fails on the
  bad shape.

**BLOCKED ON THE OPERATOR — these are the live ones:**
1. **`https://agent-os-7gg5.onrender.com` still answers `/api/status` 200 with no
   credentials.** It predates `8be82f2`, so the auth gate is absent from every `/api/*`
   route on that build. Suspend it and rotate what it held.
2. **The repo is still PUBLIC with no LICENSE**, and `gh` here authenticates as a
   different account than the owner, so visibility could not be changed from this session.
   Note the commits above describe the vulnerabilities in detail and are already pushed.

**Unverified — narrowed 2026-08-08.** The installer half is now closed: `npm run dist`
was run twice on Electron 43 with the current `files`/`asar` config, and the resulting
`dist/win-unpacked` app was **launched**, not merely walked — it boots, forks the server
out of `app.asar.unpacked/mythos`, and drives `pc-child`. Still unverified, unchanged:
cross-version `safeStorage` decryption of a `keys.json` encrypted under Electron 32 (no
fixture exists, and the packaged run above created a *fresh* `userData` under
`agent-os`, so it exercised the empty-store path, not the migration) — if provider keys
read empty after upgrading, check that first. Also still untested: the NSIS installer
itself (`dist/MYTHOS Setup 0.1.0.exe`) has been built but not run; `win-unpacked` and an
installed copy are not the same test.

| | |
|---|---|
| **Status** | Merged-order steps 0-5 ✅ (unchanged from before this session) AND **6 ✅ the ADB phone bridge is closed.** Task 8 (`android-child` adapter — per-device queues over one-shot `adb` calls, not a copy of `pc-child`'s persistent daemon), Task 9 (`setup-android.js` — install/pair/connect, argv-only unit-tested, never executed for real), Task 10 (`from-android.js` — 14 registered tools/13 table rows, `phone_flashlight_toggle` omitted, `phone_shell` refused, WhatsApp resolved as option (b): honest deep-link-open, never a claimed send). Three commits, each red-first tested. security-reviewer (sonnet) ran on `from-android.js` before its commit and found 3 issues, all fixed same-session: HIGH (`deviceId`/`serial` never actually reached `adb`'s argv — a real multi-device-breaking bug, fixed with a new `buildAdbArgs()`, plus `checkDevice()` now confirms the serial is currently known, not merely truthy), MEDIUM-HIGH (`phone_file_pull` mistiered T1 despite being a local write — re-tiered to T3), LOW/informational (`resolveSandboxed()`'s pre-existing, repo-wide lack of symlink-awareness — flagged as a spawned background task, not fixed here, out of scope for this file). Real AD-9 proof, not just unit-green: booted the actual app with `adb` absent from PATH — `android-child.offline` with the exact install hint, `capabilities-manifest.written` lists it honestly, boot succeeds, all 139 other effectors register, `pc-child`/`cua-driver` come online normally. Baseline grew 1690→1727 tests, 125→139 effectors, 0 fail throughout. Physical-phone-dependent checkboxes (Task 9 Step 5, Task 10 Step 9, and Task 10's original Step 3 uiautomator-tap approach) are explicitly left unticked — no Android device exists on this machine, and nothing here fabricates that verification. **Post-step-6 integration (same session):** two local-only branches were reconciled into `main` rather than left to rot on one machine — `78a4c2d` (symlink/junction-aware `resolveSandboxed()`, merged as `e263ae1`) and `claude/stoic-williams-6a1c85` (CRLF-safe `sync-test-count.js` + the missing brain lanes in README's two mermaid diagrams). The first branch was cut from `39ceb00` and reported Task 10 as "never pushed" when it was already on `origin/main` — the BUG-037 stale-base shape, caught by `git merge-base` before any merge. Nothing was lost because that fix landed in the shared helper, so `from-android.js`'s two call sites inherited it despite the branch being blind to them. The CRLF fix is the root cause of a duplicate-sync-block bug hit by hand during the first merge: `ROADMAP_BLOCK_RE` hardcoded `
`, so on any `core.autocrlf=true` clone `--check` reported "block missing" and `--write` then INSERTED a second block. Baseline 1727→1735 tests, 0 fail. |
| **⚠ CORRECTION — read before anything else in this block** | **Slice 5 shipped BROKEN and boot-fatal, and two claims written below on 2026-08-04 were wrong.** The operator ran Track C, and the Electron shell did not start at all: `Error: The 'screen' module can't be used before the app 'ready' event`, raised from `cursor-overlay-window.js`'s constructor via `main.js`'s module-scope construction. So (a) **"Slice 5 is unit-green"** understated it — it was not merely unverified, it was fatal; and (b) **"step 7 is code-complete at all 6 slices"** was false, because one slice prevented the product from launching. **Fixed and LIVE-VERIFIED 2026-08-04** (see the Progress log row): the app now boots with the overlay off (the default) and on, `Ctrl+Alt+C` registers, and the controller is constructed against the real Electron `screen` only after `app.whenReady()`. **The lesson is the valuable part and it vindicates this document's own tick discipline:** 2598 passing tests, ten green Anti-Drift invariants and a walked 298MB installer artifact, and the app still could not open a window. A green suite is not evidence that the desktop app runs. Everything below stands except those two claims. |
| **Next action** | ## ⇢ THE NEXT ACTION IS YOURS, NOT A BUILD STEP.
| | **2026-08-05 — still true, with three items retired and one new finding.** Nothing in the merged order advanced today; two voice-session incident batches landed beside it (BUG-099..BUG-105 in the morning, BUG-106..BUG-116 in the afternoon, 12 commits, suite 2664→2759, 0 fail) and the Progress log carries the row. Retired from the list below: the missing installer icon (item 5 of the Slice-4 open list, now `build/icon.ico`), the stale `AETHER-WIRING.md` drive-path flag (closed by `d5eb2ec`, re-verified), and a false test failure that was silently blocking **every** commit — `test/electron-builder-files-allowlist.test.js` hard-asserted that kokoro-js's Hugging Face cache weight exists inside `node_modules`, which is downloaded on first TTS use, so any checkout that had never spoken failed a packaging test for environmental reasons. **The new finding, which changes what "step 7 verified" will mean:** the Slice 3 screen-share surface streams the operator's whole desktop to Gemini and had never been security-reviewed (the building session was told not to spawn agents); a review is now under way, and its findings should land before the operator's Electron sitting rather than after, because that sitting is what first grants a real `getDisplayMedia()`. Also confirmed by reading the code, not inferred: BUG-116's fix covers the **Live** path only (`5b8afc9` touches `live-tool-adapter.js` alone), and `voice-agent.js`'s batch path still composes its sentence before the actions run — mitigated since 2026-07-31 by a corrective re-derivation pass plus a deterministic truthful prefix, but that prefix fires only when the ENTIRE turn failed, so a partial-success turn still depends on the model choosing to admit the failed half. That residual is documented at `voice-agent.js:829-831` as a deliberate design decision and is not a regression. |
| | **As of 2026-08-04 (second session, two waves, 10 commits) there is no delegable work left in this document.** Step 7 is **code-complete at all 6 slices**, the Anti-Drift Contract is **10/10** with executable tests, and all **six remaining unchecked items require the operator or physical hardware.** Do not go looking for the next `- [ ]` to build — there isn't one. What remains, in the order that retires the most risk per minute: **(1) Track C, one Electron sitting (~15 min).** Slices 1, 2, 3 and 5 are unit-green only; Slice 4 is the sole slice verified against a real artifact. `npm install` at repo root then `npm start` — **but NOT from a VS Code terminal**: `ELECTRON_RUN_AS_NODE=1` is inherited from the extension host, which makes `electron.exe` run as plain Node so `require('electron')` returns the npm path shim and every destructured API is undefined (crash at `electron/main.js` on `ipcMain.handle`). Second trap: electron's postinstall extraction fails **silently** (npm exit 0, `dist/` holding only `locales`, no `path.txt`) — check for `path.txt` before debugging anything else. In that one sitting: press-to-talk from another app, `Ctrl+Alt+X` OCR, `LIVE_SCREEN_SHARE_ENABLED=true` then ask "what's on my screen" (Slice 3 end-to-end), `MYTHOS_CURSOR_OVERLAY_ENABLED=true` then `Ctrl+Alt+C` (Slice 5), and while you are there close the four long-open operator items: judge the persona by ear across the five scenarios, judge the `Aoede` voice, test barge-in, and read the real p50 from `/api/status` → `voiceLatency`. **(2) Install the built installer** (`dist/MYTHOS Setup 0.1.0.exe`, 298MB) on a clean path and confirm it boots and resolves the real vault. **(3) Four decisions only you can make**, all cheap now and expensive later: whether `PIN_SESSION_ENFORCE` should default **ON** in packaged builds (it defaults false for back-compat, which means the shipped desktop app still has the `curl` bypass — recommended ON, since enforcement self-disables unless a PIN exists so lockout is already handled); whether `appId: com.mythos.assistant` is the real product identity, given OD-1 is undecided and `package.json`'s `name` is still `agent-os` (appId is the Windows install/upgrade key); what to do about `gesture_recognizer.task`, whose model licence was chased to Google's primary sources and is **stated nowhere** (page content is CC BY 4.0, code samples Apache-2.0, and the linked model card asset 404s) so it is excluded from the installer and gesture recognition is absent from packaged builds until it resolves or gets a `setup-gesture.js`; and how the paid product handles the NC wake-word weights. **(4) Track E1 needs your authorisation** — it means writing into the Aether-BLE repo, outside this project directory. **(5) Track G is gated on OD-1** (the product name; every account handle, OAuth app name and redirect URI depends on it), and P8 must not be designed before reading your own wake-word-collision repo. **(6) Wake-word training** needs Piper installed and your ear. **SUPERSEDED 2026-08-17 by Decision 4 — wake word stays BYO with the non-commercial notice; no training workstream exists.** *Superseded build-status detail follows.* **2026-08-04 (second session): Slice 4 — the electron-builder installer — is DONE and is the first step-7 slice verified beyond unit-green.** `npm run dist` produces a real `dist/MYTHOS Setup 0.1.0.exe` (298MB, unsigned by design), and the licence gate was verified by **walking `dist/win-unpacked` itself**, not by trusting the globs: zero `.onnx`, zero `.task`, no `edge-tts-server.py`, no `.env`, no `vault/`, no `.cache/`. **The finding that made this real, and the one to carry forward: `electron-builder` packages the WORKING DIRECTORY, not the git tree — `.gitignore` is not a packaging boundary.** Because every model here is deliberately fetched per-machine and never committed, a developer's checkout holds weights git has never seen, and the first build shipped three of them: `gesture_recognizer.task` (the only model actually tracked in git, and step 6.6 could NOT establish its licence), `silero_vad.onnx`, and a Hugging Face `.cache` copy of Kokoro-82M living inside `node_modules/kokoro-js` — that last one invisible to any check looking at this repo's own model directory or at git. The openWakeWord weights escaped only because the first pattern named that exact directory. Now excluded as a class (`!mythos/ui/public/models{,/**/*}`, `!**/.cache{,/**/*}`), which matches the architecture rather than breaking it — those files are absent on a fresh clone too and `setup-silero.js`/`setup-wakeword.js`/`setup-piper.js` exist to fetch them. `test/electron-builder-files-allowlist.test.js` (10 tests) asserts all of it through electron-builder's OWN `FileMatcher`, with a positive control so an over-broad pattern fails loudly instead of passing vacuously. Two build facts pinned there so nobody "fixes" them: **`asar` must stay false** (main.js:242 forks the child server with `cwd: MYTHOS_DIR`; a fork cannot cwd into an asar archive and the child writes `vault/` there — electron-builder's "strongly not recommended" warning is wrong for this architecture and the breakage would appear only in a packaged build), and **`includeSubNodeModules: true`** (without it AppFileWalker silently drops `mythos/node_modules` entirely — caught by a real build that shipped it empty). **Open, flagged, NOT decided by this session:** (1) `gesture_recognizer.task`'s model licence is still UNVERIFIED, so gesture recognition is absent from packaged builds until it resolves or gets a `setup-gesture.js` like every other model; (2) the app is **1.2GB unpacked** — the bulk is `onnxruntime`/`@huggingface/transformers`/`kokoro-js`, all there for LOCAL TTS/STT while the default architecture is BYO cloud, so cutting them is a product call not a build fix; (3) `kokoro-js/voices/*.bin` (56 voice embeddings) still ship, lower-risk since they arrive as published npm package contents; (4) **`appId: com.mythos.assistant` bakes in a product name that is still an open operator decision**, while `package.json`'s `name` is `agent-os` (hence artifact `agent-os-0.1.0-x64`) — appId is the Windows install/upgrade identity and is expensive to change once anyone has installed; (5) **CLOSED 2026-08-05** — there was no icon asset anywhere in the repo, and electron-builder does not fail on a missing icon: it silently falls back to Electron's own and exits 0, so a 298MB installer wore somebody else's logo. `build/icon.ico` now exists (7 entries, 16-256px), generated reproducibly by `mythos/scripts/make-icon.js` (dependency-free, deterministic, `--check` mode for CI) and pinned by `test/electron-builder-icon.test.js`, which asserts the file exists and parses as a real multi-size ICO rather than merely that a config key is set. `build.icon` is now explicit instead of relying on the implicit default. Deliberately a placeholder mark, not a logo — a wordmark cannot be designed before OD-1 settles the product name. **Next is Slice 5 (cursor overlay), then Slice 6 (OSS hygiene: SECURITY.md, CONTRIBUTING.md, issue templates, CODEOWNERS, dependabot, plus spine §13's directory-scoped `CLAUDE.md` split).** Slices 1-3 remain unverified live and still need the operator at a desktop — that is unchanged and is the highest-value remaining risk retirement. *Superseded context follows:* **Slice 3 (desktopCapturer) is SHIPPED IN CODE as of 2026-08-04 (see the Progress log row). Next is Slice 4 of 6: the electron-builder installer, which MUST honour Decision 1 — the step-7 installer never bundles the LGPL edge-tts package; TTS stays BYO. Then Slice 5 (cursor overlay) and Slice 6 (OSS hygiene: SECURITY.md, CONTRIBUTING.md, issue templates, CODEOWNERS, dependabot, plus spine §13's directory-scoped `CLAUDE.md` split).** Slice 3 added `sendVideoFrame` to `live-session.js`, a `live-video` WS branch, `setDisplayMediaRequestHandler` in `electron/main.js`, and `ui/public/js/voice/screen-share.js`, all opt-in behind `LIVE_SCREEN_SHARE_ENABLED` (default false) and **with `electron/preload.js` untouched, so AD-8 still holds**. Suite 2539/2538/0 fail/1 skip. **Two things it did NOT do, both worth picking up:** no security-reviewer ran on a surface that streams the desktop to a third party (the session was instructed not to spawn agents), and nothing is live-verified — a real `getDisplayMedia()` grant, real pixels, and Gemini actually answering from them all need the operator at an Electron desktop. **Beside the merged order, also landed 2026-08-04:** `feat/aether-focus-sensor` was fast-forwarded into `main` (Aether-BLE proximity sensor, Phase 1 of 5 — see `AETHER-WIRING.md`), and the test-count gates were repaired: commits `73818e2`/`bf95f35`/`b571ab4` had each added test files without running `sync-test-count.js`, so `main` carried 2488 while the suite really ran 2513 and `--check` — which CI gates on — was failing. **CLOSED 2026-08-05 — this item is stale and was still being read as open work.** It claimed `AETHER-WIRING.md` hardcoded drive-rooted absolute paths for both repos and that AD-7 could not catch them. AD-7 was subsequently widened in `d5eb2ec` to match any drive-rooted machine-specific path and cleared 54 hits across 19 tracked files, that document included. Re-verified 2026-08-05 by sweeping every tracked file for the shape: the only surviving matches are comment examples in `mythos/src/core/brain/index.js` that demonstrate the illegal-JSON-escape bug, i.e. illustrations rather than real paths. **When editing this row, do not spell the literal path shape out again — doing so is what tripped AD-7 inside this very document twice before.** **Slice 1 (FOUNDATION) shipped `5f6108d` and, as of 2026-07-31, BOOTS FOR REAL: `npm install` + `npm start` at repo root opens a window titled "MYTHOS" whose forked child server answers on 127.0.0.1:4478 and serves the HUD (index.html 200, `app.js` 8,800B gzipped). Two install-time gotchas cost an hour and are written up in the Progress log — electron's postinstall extraction failed SILENTLY (npm exit 0, `dist/` containing only `locales`, no `path.txt`), and `ELECTRON_RUN_AS_NODE=1` inherited from a VS Code extension host makes `electron.exe` run as plain Node so `require('electron')` returns the npm path shim and every destructured API is undefined. Neither is a MYTHOS defect.** Slice 2 (globalShortcut) is now SHIPPED in code: the press-to-talk half was found already fully implemented and test-pinned (`registerTalkHotkey()` + `onHotkey`→`toggleVoice()`), so the remaining work was the **Ctrl+Alt+X OCR grab** — `registerOcrGrabHotkey()` in electron/main.js (fallbacks `Control+Alt+X`→`Control+Shift+X`→`Control+Alt+S`, `MYTHOS_HOTKEY_OCR` override, never steals focus, guarded `child.send({channel:'mythos:ocr-grab'})`) → server/index.js's existing fork-IPC `process.on('message')` handler dispatches the already-registered `screen_read_text` effector through shared `dispatchAction` with `channel:'hotkey'` (audit-honest) → `broadcastAll({type:'ocr-result'})` → app.js captions the first line via `mic.setCaption` (PIN-gate respected) and best-effort `navigator.clipboard.writeText` (rejects unfocused by design — caption is the always-surface). As predicted in this block, Slice 2 needed NO preload-surface change — AD-8 intact, `electron-preload-surface.test.js` untouched and green. New `test/electron-ocr-hotkey.test.js` (9 tests, source-shape for the Electron half per the talk-hotkey precedent + server/HUD wiring guards). Full suite 2425/2425/0 fail. **Unit-tested only — the OS-global keypress + real OCR needs the operator at the desktop, so the slice is NOT live-ticked.** Next is Slice 3 (desktopCapturer). The full step-7 slice list is logged in the Progress log row for `5f6108d`. **6.5 now has ZERO open decisions** — all three answered AND the wake-word path locked (train own `hey_mythos` model, free/open only, BYOK product-wide — **SUPERSEDED 2026-08-17 by Decision 4: wake word stays BYO with the non-commercial notice at the install point; no training workstream**); the wake-word *training* itself is a separate workstream needing Piper installed + the operator's ear, and does not block the Electron build. To actually SEE the app so far: `npm install` at the repo root (pulls electron/electron-builder), then `npm start` — done 2026-07-31, it works. **CORRECTION: `GOOGLE_API_KEY` is NOT absent on this machine — it is set in `mythos/.env` and verified Live-capable** (`scripts/verify-gemini-live.js` → PASS, 41,282B of real audio from `models/gemini-3.1-flash-live-preview`). The earlier "absent" claim in this block was stale and blocked S2S on paper for no reason. **S2S is now ENABLED and verified end to end** (see the Progress log row); what still needs a human is a microphone, not a key. Do not write a legal conclusion into this file. **Landed beside step 7 on 2026-07-31 (see the row below and the Progress log):** a cross-cutting hardening wave — a CRITICAL tier-wide T3 leash bypass, a CRITICAL corrupt-JSON data loss in three vault stores, and installed agent skills never reaching builds. It advanced no merged-order step but it changed load-bearing behaviour in `leash/`, `goals/`, `fs-store.js` and `skills/loader.js`, so read that row before touching those. |
| **Blocked on** | **Nothing in step 7 blocks the next slice.** Wake-word training (a separate workstream, closes the last 6.5 sub-item) needs Piper installed + the operator's ear to validate the trained model. **SUPERSEDED 2026-08-17 by Decision 4 — wake word stays BYO with the non-commercial notice; no training workstream.** Still open, needing the operator in person: (1) the persona has **not been judged by ear**; (2) V2 §14's live items 1-4 + Task 12 Step 5 need a microphone and speakers — **narrowed 2026-07-31**: everything on the S2S path that does NOT require a mic is now verified against the real API (session open, transcripts, audio-out bytes, tool calls through the leash, T3 confirm), because `live-text` (server/index.js:1600) lets a headless WS client drive a whole Live turn; what remains is genuinely mic-only, i.e. speaking to it, barge-in, and judging the `Aoede` voice by ear; (3) **§7.3's PIN lock is now REAL access control as of 2026-08-04 — the "visual deterrent only" state is closed.** New `src/core/security/pin-session.js`: `POST /api/pin/verify` mints a CSPRNG session token (32 bytes) stored server-side with a sliding 30-min TTL and returned as an `HttpOnly`/`SameSite=Strict` cookie (`Secure` when `req.secure`). Enforcement extends the EXISTING `extractToken()` chain rather than adding a fourth mechanism, so one change closed both gates at once — `requireToken` (REST) and the WS `verifyClient` upgrade both already routed through `tokenOk(extractToken(...))`. `tokenOk()` became `if (pinSession.isValid(presented)) return true; if (!AUTH_TOKEN) return !pinSessionRequired();`. Proven red-first: against the unmodified server the new `test/pin-session.test.js` failed 6 of 8 with `expected 401 with no session; got 200`; after the fix 8/8, plus 75/75 across every existing file touching `tokenOk`/`requireToken`/`verifyClient`/`mythos_token`/`pinLock`. Two design points worth keeping: `/pin/status` and `/pin/verify` are exempt or enforcement is an unrecoverable lockout (and the exemption matches on the MOUNT-RELATIVE path — inside `app.use('/api', …)` `req.path` is `/pin/verify`, so matching the full path would have made it silently dead), while `/pin/set` stays gated; and `pinSessionRequired()` returns false unless the operator opted in AND a PIN actually exists, so flipping the flag on a fresh install cannot lock anyone out. **Two residual items, both deliberate:** `PIN_SESSION_ENFORCE` defaults to **false** (required for back-compat — headless/Docker/Render and the whole existing suite rely on loopback-without-token), which means the bypass still exists on a default install and **the packaged desktop build should almost certainly default it ON** — that is an unmade product decision, not an oversight; and `/api/pin/set` needs no session on FIRST-TIME setup, so on a fresh server whoever reaches it first claims the PIN (pre-existing trust-on-first-use in `pin-lock.js`, loopback-only, unchanged here). Note the pre-existing hard boot refusal for non-loopback binds without `MYTHOS_AUTH_TOKEN` is untouched — the two layers stay independent (network vs local-physical) by design; (4) §7.10's `generate_image` needs billing enabled on the Google AI Studio project; (5) §7.6's `calendar_upcoming` success path needs real Google OAuth creds; (6) Task 9 Step 5, Task 10 Step 9 and the option-(a) `phone_tap` alternative all need a physical Android phone; (7) Task 7's `--install` needs an account that can register a scheduled task (it hit a real Access-denied here, and escalation was deliberately refused); (8) **booting the actual Electron app** (Slice 1's runtime) needs `npm install` at repo root + a desktop GUI — unit-tested only so far. Open but unowned/low priority: (9) the S2S health-tile design decision from step 4; (10) the pre-existing `resolveSandboxed()`/`allowedRoots()` Windows 8.3 short-name mismatch (the new symlink test works around it via `realpathSync`; the underlying helper gap remains); (11) V2 §7.12's Scheduled-Task-backed alarms, judged not a thin reuse of Task 7's machinery and documented rather than built. |
| **2026-07-31 hardening session (no merged-order step advanced — read this before assuming 6.5 is still the whole story)** | A full-codebase audit ran *beside* the merged order rather than inside it: 5 read-only auditors (security, silent-failure, wiring, gap-sweep, OSS-licence research), then a 6-agent fix wave, then 3 adversarial reviewers on independent lenses (correctness / honesty / security). **All three reviewers returned DEFECTIVE on the first fix wave**, which is the single most useful result of the session — every one of their findings was real and a second round fixed them. What landed: **(1) a CRITICAL leash bypass.** `goals.grantTier(id, 3)` stored a bare `true` and `leash.check()` honoured it tier-wide, so approving ONE Forge plan-approval checkpoint pre-authorised *every* T3 tool carrying that goalId — `gmail_send`, `run_command`, `delete_file`, `phone_call`, `phone_sms_send`, `browser_click`, `install_from_github`. Reachable with no external attacker via `engagements/executor.js` (checks LLM-authored `{tool,args}` stages against the gate with `goalId` set, so untrusted text reaching a spec could steer it) and via `cortex/index.js` (passes its own `activeGoalId` every autonomous tick). Grants are now an **array of tool names**; `checkpoints.js` passes `PLAN_APPROVAL_GRANT_TOOLS = ['build_project','revise_project']`; a legacy boolean grant fails closed and emits `goal-grant-legacy-unscoped`. Two existing tests *asserted the vulnerable behaviour* (`leash.test.js:306`, `checkpoints.test.js:59`) and were rewritten with the reasoning recorded, not deleted. **(2) a CRITICAL silent data loss, fixed at the root on the second attempt.** `fs-store.readJSON()` returns the fallback for a CORRUPT file as well as a missing one, so three read-mutate-write stores turned one corrupt read into a truncated store while reporting success — proven end-to-end by seeding a real `reminders.json` with two real reminders and a truncated brace: `reminder_add` returned `ok:true` and both were permanently gone. The first fix only closed the *throwing* variant (EBUSY/EPERM) and the honesty reviewer caught that; new `fs-store.readJSONStrict()` throws on **both** shapes and `from-calendar.js`/`goals.js`/`forge.js` use it. `readJSON` keeps its lenient contract for the other 18 callers that legitimately want "no usable file → default". **(3) installed agent skills never reached builds.** `skills/loader.js` resolved exactly one external root, `~/.zcode/skills`, which does not exist on a Claude Code machine — so every non-vendored skill silently failed and every UI build fell through to `design/system.js`'s bundled-CSV substitute while the operator believed their `ui-ux-pro-max` install was driving output. Now an ordered candidate list (`$MYTHOS_SKILLS_DIR` → `~/.claude/skills` → `~/.claude/plugins/marketplaces/*/{src,.claude/skills}` → `~/.zcode/skills`), with `externalSkillRoots()` exported as a diagnostic. **Live-verified:** the real `ui-ux-pro-max/scripts/search.py` now resolves and returns 2,661 chars of genuine design system; catalog 5 → 9 skills. **(4)** dead `speak` effector removed (it had no `describeMeta()`, so it never appeared in any catalog the model sees — unreachable, not merely untiered) + phantom `monitor_snapshot` tier row removed, both now guarded by a new two-way `tier-table-conformance.test.js`. **(5)** four android tools stopped claiming success from `adb`'s exit code — real read-back via `settings get global wifi_on`/`bluetooth_on`/`pidof`, three honest outcomes, `needs_result:true` so the honest one actually reaches the user instead of `voice-agent.js`'s flat `"<tool> done."`. **(6)** S2S browser bridge, PIN lock screen and the `voiceLatency` tile were all fully built and loaded by **nothing** — now wired. **(7)** goals-bridge degraded paths stopped auditing `'ok'` for mutations that never reached disk. **Still open and honest:** the PIN lock is a visual/pointer deterrent only — the default install ships `MYTHOS_AUTH_TOKEN` commented out and `tokenOk()` returns `true` when unset, so `curl 127.0.0.1/api/...` bypasses it; real enforcement needs a server-side PIN session, which is **not built**. |
| **2026-08-03 — Hermes as the generation engine + pattern ports (no merged-order step advanced)** | A second beside-the-order initiative, commits `47158de`..`bf147fb`, all pushed. **Phase A — provider failover.** `HERMES_PROVIDER_KEY_2..4` / `_BASE_URL_n` / `_MODEL_n`, additive so a single-key install is unchanged. Rotation fires only on provider-class failure (spawn error, non-zero exit, timeout, or an exit-0 reply matching Hermes's own anchored error prefix), never on a bad prompt; each rotation logs `hermes.provider-rotated` and reaches the bus as a `health.anomaly`. The guarded brain fallback is kept. **The finding that made this real:** `<HERMES_HOME>/.env` loads with `override=True` (`env_loader.py:325`, and `HERMES_HOME` is `<repo>/Hermes Agent` here, NOT `~/.hermes`) and beat every forwarded key — a deliberately invalid slot-1 key returned a correct artifact, so rotation would have passed every test while reusing one credential forever. Both lines are now commented out there (operator-approved; backup `Hermes Agent/.env.bak-2026-08-03`). Re-probed after: invalid slot 1 → `HTTP 401`, rotation logged, slot 2 produced the answer, `activeSlot=2`. An apparent escape hatch was tested and **refuted** — `HERMES_INFERENCE_PROVIDER=lmstudio` with unpinned `LM_API_KEY` still authenticated with an invalid key, because `config.yaml`'s `provider: openai-api` wins on the `-z` path. **Phase B** routes interview, spec-builder, plan-builder and the executor research stage through `buildEngine`; 4/4 live-verified with no brain wired (`scripts/verify-phase-b-hermes.js`). **Phase C:** C1 RAG citations 6/6 with every cited ref re-checked against its chunk file on disk; C2 watcher diff-gate 4/4 (suppresses repeats AND stays audible on real change); C3 was **broken and is fixed** — sampled 3× it was 0/3 because the model decorated static kinds with `title`/`layout`, which the validator rejects by design; the schema hint never said the static form carries only `kind`. Saying so → 3/3. Fixed the prompt, not the validator. **Phase D not built** (post-parity scope, deliberate). Also: the widget fork with the other machine was reconciled in `f9042b8` — remote's hardened widgets kept, this machine's `sanitizeErrorForClient` kept, chosen by a mechanical superset check, decision record in `Plans/widget-fork-reconciliation-2026-08-03.md`. Baseline 2428→2488, 0 fail. **CORRECTION, found by running real builds (commit `972ba62`) — Phase A delivers LESS than its plan claimed. Cross-provider failover DOES NOT WORK.** Hermes takes `model.base_url` from its own `config.yaml` and ignores the forwarded `OPENAI_BASE_URL`; proven by forwarding an unroutable base_url (`http://127.0.0.1:9/v1`) and still getting a correct reply. No generic `HERMES_INFERENCE_BASE_URL` exists — only `_MODEL` and `_PROVIDER`. So slots rotate the KEY and the MODEL, never the PROVIDER. This hid because the rotation proof used two MISTRAL keys, which share config.yaml's endpoint; a **valid** Cerebras key returns 401 because its key is sent to Mistral. The A1 slot table (Mistral/InferX/Cerebras/Kilo) therefore cannot function as designed — slots 2-4 are useful today only as extra keys for the SAME provider (e.g. a second Mistral key to escape a 429). Genuine cross-provider failover needs `config.yaml` rewritten per attempt, which the env-only design deliberately refuses; **that tradeoff is now an open operator decision.** `setup-hermes --check` flags any slot whose base_url differs from config.yaml as UNREACHABLE, and `.env.example` leads with the limitation. **Slot-1 bake-off DONE** (artifacts graded, not latency): `mistral-medium-latest` 6/6 clean, `mistral-large-2512` 6/6 but wraps output in a markdown fence after being told not to, `mistral-vibe-cli-with-tools` HTTP 429 — so mistral-medium-latest stands as slot 1 on evidence. The 429 is the shared-rate-bucket problem appearing unprompted. **Endurance NOW MEASURED, and it fails (`scripts/verify-hermes-build-endurance.js`, 12K-char prompts):** unpaced → HTTP 429 at **call 3 of 60**; 8s pacing → still 429 at call 3; 45s pacing → 4/4 clean. So it is a time-window rate limit and the usable spacing sits between 8s and 45s — a 60-call build at 45s spacing is ~45 minutes of waiting alone. **Slot 1's entire premise ("the only provider with TPM headroom for a whole build") is false on a free-tier key.** Rotation does not rescue this: it cannot change provider, and two slots holding same-provider keys share one bucket — backoff-and-retry is the mechanism that would help, and it is deliberately NOT built because that is an operator design choice, not a verification-session change. **Open decision for the operator: paid tier, throttling, or accept that multi-call builds are impractical on free keys.** **Slots 2 and 4 are MOOT, not merely untested.** An earlier line here said they were blocked on missing Kilo/InferX keys; that was the wrong conclusion. Those slots name endpoints `config.yaml` does not use, so per the endpoint finding above they are unreachable *by construction* — a valid key would still 401, exactly as a valid Cerebras key did. No credential unblocks them; only the config.yaml decision does. Sustained endurance still unmeasured for Slots 2 and 4 remain untested because no Kilo or InferX key exists in any env file on this machine — the operator declined to rotate the exposed Kilo/InferX/NVIDIA keys (free tier, accepted risk) and no separate Mistral key exists, so `HERMES_PROVIDER_KEY` and `MISTRAL_API_KEY` still share one rate bucket and slot 1's 500K-TPM justification is unproven. Slots 2-4 stay commented in `.env.example` until each survives a real build. |
| **Operator decisions captured 2026-07-31** | Outward-facing actions (email/WhatsApp/SMS/posts/spend): **approve-a-plan-once**, not approve-each — which is exactly the shape of the bypass fixed above, so it is only safe *because* a grant now enumerates its tools. Any batch-approval UI must therefore disclose and grant a specific tool list, never a tier. Lead sourcing: **deferred**, build the product first. "Very smart": **all three** of memory-that-grows, better reasoning/routing, and prediction-from-real-stats (the last one honestly reports "not enough data" until a dataset exists — AD-5). Autonomous outbound voice calls: **roadmap/future**, not now. Product name: still undecided. |
| **Two documents → now three** | This file = delta/roadmap. V2 spine = source-level detail. `MYTHOS-Post-Parity-Plan.md` = everything after step 7 (social, business-agent layer, multi-surface, wake-word arbitration). The "do not start a third plan document" rule exists to stop planning living in **untracked** files; all three are tracked and cross-linked, and this file still wins on any overlap. Precedence rules in the V2-spine section below. |
| **Last updated** | 2026-08-16 (status-table rows below the dated RESUME HERE blocks still describe 2026-08-05 state; the dated blocks above are newer and win) |

**Merged order (the only sequence — see V2 §18.4 below):** 0 ✅ · 1 ✅ · 2 ✅ · 3 ✅ · 4 ✅ (all 5 phases + Task 12 shipped and unit/integration-tested; V2 §14's live items 1-4 need the operator's microphone — see RESUME HERE) · 5 ✅ (nine buildable items shipped and committed; WhatsApp-desktop-scheduling deliberately deferred to its Task 10 dependency in step 6 — see RESUME HERE) · 6 ✅ (ADB phone bridge: adapter + setup script + 14 tools/13 rows, WhatsApp resolved as honest-open-only, physical-phone checks left unticked — see RESUME HERE) · 6.5 ☐ (4 decisions answered + licences verified; wake word stays BYO with the non-commercial notice at the install point — Decision 4, 2026-08-17; the own-model training workstream is superseded) · **6.6 ☐** (wider audit, split from 6.5 by Decision 3) · 7 ☐ **(all 6 slices now shipped IN CODE as of 2026-08-04 — Slice 5 cursor overlay `3050889`, Slice 6 OSS hygiene + the directory-scoped `CLAUDE.md` split. What keeps step 7 unticked is live verification, not missing code: Slices 1, 2, 3 and 5 are unit-green only and need the operator at an Electron desktop. Slice 4 is the sole slice verified against a real artifact.)** Earlier state for the record: (**Slices 1-4 of 6 shipped in code**: `5f6108d` foundation, globalShortcut, desktopCapturer, and — 2026-08-04 — the electron-builder installer, which honours Decision 1 and is the first slice verified against a real artifact rather than only unit-green: a real `MYTHOS Setup 0.1.0.exe` with the licence exclusions confirmed by walking `dist/win-unpacked`. Slices 1-3 remain NOT live-verified — all three need the operator at an Electron desktop. Next: Slice 5, the cursor overlay, then Slice 6, OSS hygiene)

**· 8 ☐ (planned 2026-08-17, TRACKED NOT STARTED — "Step 8 — Upstream synthesis:
prime-agent · addyosmani/agent-skills · TencentDB-Agent-Memory · agency-agents",
below. **Six** lanes 8A-8F (8E/8F added later the same day when the operator named
`msitarzewski/agency-agents` and asked for the four TencentDB assets 8A-8D had not
taken), full design + code snippets + AD-11…AD-21 written out so the build
is an execution pass, not an investigation. Operator set the sequence explicitly:
**step 8 does not start until 6.5, 6.6 and 7 are ticked.** It carries two live,
already-reproduced bugs — BUG-266 phantom skill names on a fresh clone, BUG-267
the Live prompt naming a tool Live was never given — which are cheap and are
lane 8A's first two items.)**

Ignore the older "Wave 0/1/1.5/2/3/4" numbering where it conflicts — the merged order table is authoritative.

### How to keep this file honest

1. Tick `- [x]` on a step only when it is **live-verified**, not merely unit-green. This repo has shipped 6-of-11 broken behind vacuous tests; a green suite is not evidence.
2. Add a row to **Progress log** with the commit SHA that carried the work.
3. Rewrite the **RESUME HERE** table — Status, Next action, Blocked on.
4. Commit the tick together with the code change, then `git push`. **A tick that isn't pushed does not exist** as far as the next machine is concerned.

Steps get ticked and logged rather than deleted: a task that turns out to need revisiting has to still be readable, and the Progress log is what gives latest-progress at a glance without destroying the spec.

### Progress log

| Date | Work | Commit | Live-verified |
|---|---|---|---|
| 2026-07-30 | Preserved both untracked plan files + Gemini Live probe into git | `ce013a5` | n/a (docs) |
| 2026-07-30 | Promoted canonical plan to `mythos/Plans/`, added this tracking header | `496e884` | n/a (docs) |
| 2026-07-30 | **Merged-order step 0:** restored the V2 spine from `~/.claude/plans/` into `mythos/Plans/MYTHOS-IRIS-Synthesis-Plan-V2-spine.md` (md5 verified identical); retracted the false blocking-gap; folded in V2 §18's seven corrections and merged execution order | `3cabeec` | n/a (docs) |
| 2026-07-30 | **Merged-order step 1:** full baseline re-run (1329-subset→1517 real→1520 final tests, 0 fail, 1 skip — "two real failures" prediction disproven, both files pass 38/38); fixed a real 14-file/188-test gap in `sync-test-count.js`/pre-commit/CI (non-recursive glob); README numbers corrected + independently verified (deps 7, sensors 10, providers 12, **effectors 107** — this plan's own "106" was off by one); AD-10 implemented (`computeDepsCount`/`computeSensorCount`/`computeProviderCount`/`computeEffectorCount`, all generated, gated by `--check`); Gemini Live quota risk re-verified live and retired (V2 §16); 4 of 10 §1 anti-drift invariant tests written (AD-1 found a real, tracked violation — `todo`; AD-5, AD-7, AD-10 pass; AD-7 also found and fixed 2 real hardcoded-path leaks) | `42c2b48` | yes — every number and test result re-run and confirmed in this session, not carried over from the plan's predictions |
| 2026-07-30 | **Merged-order step 2 (Task 6/§7.2):** boot guard (non-loopback bind + no `MYTHOS_AUTH_TOKEN` refuses to boot), `tokenOk()` (`crypto.timingSafeEqual`), `/api/*` + `/vault/builds` bearer/cookie gate, WS `?token=`. `test/server-auth.test.js` written red-first (12 tests, confirmed failing against the un-implemented server before any source change), green after. security-reviewer (sonnet) caught a CRITICAL bypass in the first pass — `verifyClient`'s no-Origin/loopback branch never called `tokenOk()`, so any reverse-proxy-fronted deployment (remoteAddress looks loopback for every remote client) was fully unauthenticated even with a token configured; fixed (origin/loopback are now pure gates under one unconditional token check) and live-reverified. Also fixed a MEDIUM (rate limiter mounted after the auth gate, so bad-token floods bypassed `RATE_LIMIT_GLOBAL`). AD-1 (carried per the prior row's plan): all 5 real `effectors.invoke()` calls across 3 files rerouted through `dispatchAction()`, `todo` dropped from `test/anti-drift-single-dispatch.test.js`, and a direct re-scan confirms zero hits outside `dispatch-action.js`. Full suite 1520/1518/0/1/1(todo) → 1531/1530/0/1/0(todo). The doc-sync gate that briefly blocked this commit resolved cleanly: `sync-test-count.js --write` touched only the seven test-count numbers in `README.md`/`ROADMAP.md` and no mermaid content, so there was no overlap with the concurrent README session after all. | `8be82f2` | yes — real curl (401 no-token, 401 bad-token, 200 Bearer, 200 cookie) and real WS connects (`ws` library, `?token=` and `Authorization` header, both the browser-Origin shape and the no-Origin reverse-proxy shape) against a live process bound to `0.0.0.0` with a real `MYTHOS_AUTH_TOKEN`; boot-guard refusal produced a real non-zero exit with the exact error text; loopback-no-token boot re-confirmed unaffected end-to-end |
| 2026-07-30 | **Merged-order step 3 (V2 §11 rows 1-4, persona unclamp):** lane-aware brevity tail hoisted in `brain/index.js` (voice loses `' Be concise and actionable.'`, build/simple keep it); `voice-agent.js`'s `BREVITY` RULES paragraph rewritten AND its `OUTPUT_CONTRACT` restatement fixed too (V2 §11 didn't mention the second one, but leaving it would have silently re-clamped the model's actual "say" output); `identity/index.js`'s `DEFAULT_LEVELS` raised (humor 6→8, warmth 6→7, sass 4→7, proactivity 6→8, terseness deliberately left at 5 — see the correction below, V2's own 5→4 rationale is self-defeating; formality/strictness unchanged); `memory/identity.js`'s `SEED_SELF_MD` Persona section rewritten into a full character brief. **CORRECTION applied** (see Task 11-persona section above): V2 §11 rows 3-4 pointed at gitignored `vault/Identity/persona.json`/`self.md`; verified in code that the tracked `DEFAULT_LEVELS`/`SEED_SELF_MD` are what a fresh clone actually gets (vault overrides only apply per-trait when the file exists, and it doesn't on a fresh clone), so that's where the changes landed instead. `STYLE_GUARDRAIL` untouched (verified byte-identical — only surrounding code changed). `test/persona-dials.test.js` written and run red-first against the pre-change source (via targeted `git stash` of the 4 source files only), confirmed 5 real failures, then green after restoring; also fixed one test-authoring bug it caught in itself (a wrong assumed band for terseness=4 — see the flag in the Task 11-persona section above) and one house-convention break in the new persona prose (needed "You are X." as a literal sentence, not an em-dash, per `identity/index.js`'s documented `persona()` contract — caught by the pre-existing `identity.test.js`/`persona.test.js` suite going red on first pass). Consequential updates to `persona.test.js` (default-levels assertion + 3 tests hardcoded to old dial values) and `brain.test.js` (2 tests that asserted the actionability tail on the voice lane specifically — switched to the build lane, which still has it). Full suite: 1541 tests, 1541 pass, 0 fail, 1 skip, 0 todo. The 1 pre-existing failure (`test/bug-006-youtube-mode.test.js`) was root-caused and fixed rather than bypassed — it never stubbed the `global.fetch` it declared, so it made live DuckDuckGo + YouTube oembed calls on every run, and its `ctx.bus = {}` lacked the `emit` the provider-fallback chain calls. Both fixed, no assertion weakened, deterministic across four runs. | (this commit) | yes — composed system prompt dumped verbatim for both the voice and build lanes from a genuinely fresh temp vault (no `persona.json`, no `self.md`) via the real `createFsStore`/`createIdentityStore`/`createIdentity`/`createBrain` chain with only `chain.complete` stubbed to capture instead of hitting a network provider; confirmed voice lane lost the tail, build lane kept it, `STYLE_GUARDRAIL` present, new persona brief present, humor-8 band active; separately drove a real end-to-end `createVoiceAgent().handleUtterance()` call (only `brain.think` stubbed) and confirmed the new BREVITY prose landed in both the RULES block and the OUTPUT_CONTRACT restatement, with the old "one short sentence / 10-word answer" clamp language gone from both |
| 2026-07-30 | **Merged-order step 4, Phase 1 (V2 §6, `live-session.js`):** new `mythos/src/core/voice/live-session.js`, adapted verbatim from the V2 spine's frozen source with one testability seam added — an injectable `createSocket` factory (defaults to real `ws`), since the frozen part of §3 is the wire protocol, not the transport constructor. `test/live-session.test.js` (7 tests, red-first on the trap case): setupComplete→open+onState; no-key refusal; **the §3 trap** — one combined `serverContent` frame carrying `inputTranscription`+`outputTranscription`+`inlineData` audio+`turnComplete` yields audio AND both transcripts AND a turn-complete callback, proved by temporarily mutating `handleFrame()` into an else-if chain and re-running the same test file (it failed: `audio must be delivered from the combined frame`, expected `['QUJD']` got `[]`), then reverting; `interrupted`→`bus.emit('voice.live.interrupted')`; an all-empty `turnComplete`→`health.anomaly` kind `live-turn-no-transcript` (AD-6); `goAway`→transparent reconnect (a second socket opens, setup resent, state returns to `open`); `usageMetadata`→`spend.recordCall` with the frame's real token counts (AD-5, no invented numbers). Also registered three new bus event names (`voice.live.state`, `voice.live.interrupted`, `voice.live.toolcancel`) in `test/event-name-conformance.test.js`'s allowlist — this file's static scanner would otherwise fail the build on the first real emit. Full suite: 1548 tests, 1547 pass, 0 fail, 1 skip, 0 todo. | (this commit) | Scripted-frame level only — real Gemini Live socket behavior already confirmed separately via `verify-gemini-live.js` (unchanged in this phase). No human-in-the-loop verification applies to this phase (pure transport module, no audio hardware involved). |
| 2026-07-30 | **Merged-order step 4, Phase 2 (V2 §7, `live-tools.js`):** new `mythos/src/core/voice/live-tools.js`, the prose→JSON-Schema converter that turns `buildCatalogFromHub(hub)`'s hand-written MYTHOS param strings into Gemini `functionDeclarations`, plus `DEFAULT_ALLOWLIST` (curated high-traffic subset — accuracy degrades with 107 raw tools) and a non-silent `withheld` report. `test/live-tools.test.js` (13 tests): all five prose shapes from the spec (`'string (optional)'`, `'number (optional) - exact target 0-100'`, `"'approve' | 'reject'"` enum, plain required string, and unparseable prose falling back to `string` with the original text preserved — never dropped); zero-param tools get no `parameters` block; a hub entry left off the allowlist is reported in `withheld`, never silently dropped; the log callback fires only when something actually is withheld. `test/anti-drift-live-tools-subset.test.js` (3 tests, AD-3): every declared name is provably a subset of `hub.catalog()` names (an allowlisted-but-unregistered fake tool name never produces a declaration); a brand-new effector reaches Live automatically the moment it's allowlisted, with zero changes to `live-tools.js`; an unallowlisted real tool shows up in `withheld`, not vanished. One correction made mid-implementation: three of the withheld-reporting tests initially assumed a bare test hub of N entries yields exactly N catalog entries — wrong, because `buildCatalogFromHub` (voice-agent.js, BUG-017) always merges in `CATALOG_RAW`'s ~40 hub-less pseudo-tools (navigate, close_panel, etc.) regardless of what the hub itself registers; the tests were rewritten to assert against that real merge behavior instead of fighting it. Full suite: 1561 tests, 1560 pass, 0 fail, 1 skip, 0 todo. | (this commit) | n/a — pure conversion-logic module, no live model call involved in this phase; correctness demonstrated by the 5 prose-shape tests plus AD-3's subset proof. |
| 2026-07-30 | **Merged-order step 4, Phase 3 (V2 §8, the tool adapter / safety seam):** new `mythos/src/core/voice/live-tool-adapter.js`, factored out as its own testable module (a departure from V2's literal "add this inline in `wss.on('connection')`" — done for testability; the wiring itself is Phase 5's job) exposing `handleLiveToolCalls`, `resolveLiveConfirm`, `onLiveTurnComplete`. AD-1 red→green proof: temporarily edited the module to call the effector hub's raw invoke method directly instead of the injected `dispatchAction`, reran `test/anti-drift-single-dispatch.test.js` — it FAILED (`effectors.invoke( found outside dispatch-action.js: src\core\voice\live-tool-adapter.js:99`) — then reverted; the real module passes. AD-2 proof: `test/anti-drift-audit-single-write.test.js` drives a REAL `createLeash()` end-to-end for T0/T3/deny decisions, asserting exactly one audit write each and zero dispatch calls for the T3 case before approval. AD-4 proof: `test/anti-drift-live-no-fabrication.test.js` drives a REAL `dispatch-action.js` with an always-failing effector, proves the episodic record says `ok:false` even though the simulated model reply claimed success. `test/live-tool-adapter.test.js` (16 tests) covers every branch (allow/confirm/deny/dispatch-throw/leash-throw/failed-dispatch) plus `resolveLiveConfirm`'s accept/reject/session-gone paths and `onLiveTurnComplete`'s history+episodic+clear behavior. **security-reviewer (sonnet) pass found 5 real issues, all fixed same-commit:** (1) MEDIUM — the `!ok` failure-branch error was never passed through `sanitizeErrorForClient`, only the `catch` branch was, so a raw effector error string (potentially containing paths/stderr) could reach the model/episodic memory unsanitized — fixed via a new `sanitizeResultError()` wrapper applied on both branches; (2) MEDIUM-HIGH — `leash.confirm.create()` was called with the raw (possibly falsy) `connectionId` instead of `voice-agent.js`'s `connectionId || 'system'` fallback, which is a latent cross-connection confirm-hijack window (`confirm.js` treats a `null` connectionId as unscoped) — fixed; (3) LOW-MEDIUM — `livePendingConfirms` had no TTL/sweep and could leak forever for a confirm the human never answers — fixed with a 10-minute sweep-on-call pattern mirroring `confirm.js`'s own design, plus `resolveLiveConfirm` now deletes its entry unconditionally once resolved instead of only when a live session happens to still be open; (4) MEDIUM — a genuine turn-boundary race: `live-session.js` invokes `onToolCall` fire-and-forget, so a slow `dispatchAction` could resolve after `turnComplete` already read+cleared `liveTurnActions`, misattributing the outcome to a later turn — fixed with a `turnGeneration` counter plus an atomic `splice()` snapshot, verified by a new test that races a manually-resolved promise across two `onLiveTurnComplete` calls and confirms the late outcome lands in neither turn's episodic record and instead emits `health.anomaly` kind `live-tool-outcome-late-for-turn`; (5) LOW — the confirm-modal summary (`humanizeLiveArgs`) had no length cap, unlike every other model-facing/human-facing string in this module — fixed with a 300-char cap. 5 new regression tests added for these fixes (7 net new counting sub-assertions), bringing `live-tool-adapter.test.js` to 16 tests. Full suite: 1581 tests, 1580 pass, 0 fail, 1 skip, 0 todo. | (this commit) | Scripted/unit level only, as with Phases 1-2 — no live WS connection exists yet for this module to run inside (Phase 5's job). The T3 "awaiting_human_confirmation, zero dispatch, one tier-3 audit line" behavior required by the close-out report is verified here: `test/anti-drift-audit-single-write.test.js`'s second test asserts exactly 1 audit write (`decision:'confirm'`, `tier:3`) and 0 dispatch calls for a `delete_goal` T3 call. |
| 2026-07-30 | **Merged-order step 4, Phase 4 (V2 §9, browser audio path):** `mythos/ui/public/js/voice/pcm-capture-worklet.js` shipped verbatim from the V2 spine's frozen source (an `AudioWorkletProcessor`, no imports — matches the existing `preroll-worklet.js`/`wakeword-worklet.js` convention exactly). Because AudioWorklet files in this repo take no imports, the resampling math inside it is duplicated (not shared) in a new standalone `pcm-resample.js`, which is what `test/pcm-resample.test.js` (4 tests) actually exercises via dynamic `import()` — the same pattern `test/voice-barge-in-decision.test.js` already uses for `voice-loop.js`'s `decideBargeIn()`. Covers: 48kHz→16kHz total output length within ±1 sample for 1s of audio; the fractional cursor never escaping `[0, ratio)` across 100 emitted frames (no accumulating drift); a non-integer ratio (44.1kHz→16kHz); and no int16 overflow on deliberately-clipped input. `pcm-player.js` shipped with one testability seam added (an injectable `contextFactory`, mirroring Phase 1's `createSocket` seam) since the frozen source's `ensure()` calls `new window.AudioContext()` directly, which doesn't exist under `node:test`. `test/pcm-player.test.js` (7 tests) covers the 40ms scheduling floor, back-to-back sequential (never-overlapping) scheduling, **`flush()` stops every live source and clears the set** (the required gate), `flush()` resetting `nextAt` so a barge-in mid-playback schedules fresh, `isSpeaking()`, `close()`, and suspended-context auto-resume. **One deliberate departure from V2 §9's literal instruction, stated plainly:** rather than editing the large, already-tested `voice-loop.js` in place to "add S2S mode beside the existing path," the S2S-specific browser wiring (mic capture → worklet → WS `live-audio` frames out; `live-audio-out`/`live-interrupted`/`live-state`/`live-transcript` broadcasts in → `pcm-player`) landed in a new sibling module, `s2s-bridge.js`, self-wired via the existing `onBroadcast`/`offBroadcast` exports in `ws.js`. Rationale: `voice-loop.js` is 812 lines of mature, already-green-tested batch-STT logic (VAD, echo guard, pre-roll, barge-in) that stays the untouched fallback under `VOICE_S2S_ENABLED=false`; mixing a second, structurally different transport (continuous duplex socket vs. record-then-POST) into that same closure risked regressing working code for no test-verifiable gain, since this specific wiring (real `getUserMedia`/`AudioWorkletNode`/live WS frames) has no meaningful Node-side double beyond what `pcm-resample.test.js`/`pcm-player.test.js` already cover — it needs a real browser with a real microphone, which is the operator's job per V2 §14's live-verification items 1-4. `s2s-bridge.js` was smoke-verified to import cleanly and construct its returned API under Node (no syntax/reference errors at module scope), which is the ceiling of what's verifiable without a browser. Full suite: 1592 tests, 1591 pass, 0 fail, 1 skip, 0 todo. | (this commit) | Node-level: pcm-resample/pcm-player math and scheduling, yes. Browser-level (`s2s-bridge.js`'s actual mic→WS→server round trip): NO — needs a human with a microphone and a running server with `VOICE_S2S_ENABLED=true`, which is Phase 5's + the operator's job, not something this session can produce. |
| 2026-07-30 | **Merged-order step 4, Phase 5 (V2 §10, server wiring) — CLOSES STEP 4.** Config: `VOICE_S2S_ENABLED` (default false), `GEMINI_LIVE_MODEL`, `GEMINI_LIVE_VOICE` (default `Aoede`), `LIVE_IDLE_TIMEOUT_MS`, `LIVE_SESSION_MAX_MS`, `LIVE_TOOL_ALLOWLIST` added to `config/schema.js` + documented in `.env.example` with the voice-audition reasoning written out (see V2 §11 row 6 above). `RULES` exported from `voice-agent.js` (was module-private) for `buildLiveSystemInstruction()` to reuse — deliberately NOT `OUTPUT_CONTRACT`, since Live's tool-calling is native, not the batch path's embedded-JSON scheme. `identity` threaded into `createServer()`'s deps (`main.js` updated) so `buildLiveSystemInstruction()` can call `identity.persona()`. Server wiring: `liveSession`/`liveAdapter` are BOTH lazy (constructed only inside `liveOpen()`, matching the "one session per connection, created on wake-word/cost-gate" principle) — the adapter was originally sketched eager-per-connection but that broke `test/server-auth.test.js`'s minimal fake `leash` (no `.check()`) the instant it was wired in, which is exactly the "default config exercises none of the new path" back-compat rule catching a real mistake before it shipped; fixed by making adapter construction lazy too. Four new `ws.on('message')` branches (`live-open`/`live-audio`/`live-close`/`live-text`); a new `ws.on('close')` handler (didn't exist before) that closes any open Live session so a dropped client never leaves a socket billing for open-mic time; the confirm-accept/reject paths in `handleConfirmReply()` now call `liveAdapter.resolveLiveConfirm(...)` (guarded — a no-op when S2S was never engaged on that connection). **One correctness bug found and fixed during integration, beyond what any single-phase test could catch:** `live-session.js`'s `sc.interrupted` handler only emitted `bus.emit('voice.live.interrupted')` on the SHARED process bus — with 2+ concurrent Live connections, connection A's barge-in would have broadcast to connection B's listener too (a real cross-connection leak, not present in Phases 1-3's own per-module tests since none of them exercised two connections at once). Fixed by adding a direct, per-session `onInterrupted` callback to `live-session.js` (bus emit kept for observability), server/index.js now wires `onInterrupted: () => send({type:'live-interrupted'})` directly instead of a shared `bus.subscribe`; `test/live-session.test.js`'s interrupted test extended to assert the direct callback fires exactly once. `test/server-live-wiring.test.js` (3 tests, using a new `createLiveSocket` test-only DI seam on `createServer` mirroring Phase 1's `createSocket` seam, so this drives the REAL wiring against a fake Gemini socket with zero real network calls): `VOICE_S2S_ENABLED=false` reports `{state:'closed',reason:'disabled'}` honestly and creates no session; **a `live-audio` frame before `live-open` is a no-op, not a throw** (the connection survives and keeps handling normal messages); **`ws.close()` closes the underlying Gemini socket** (the required gate). Task 12 (latency instrumentation) shipped in full: new `latency-tracker.js` (a capped ring buffer, `record()`/`stats()`, AD-5-honest — garbage input silently dropped, an empty tracker reports `{p50:null,p95:null,sampleCount:0}` rather than a fabricated number) with `test/voice-latency.test.js` (6 tests: 4 pure unit + 2 server-integration via `/api/status`, using a new `server._internal.voiceLatencyTracker` test-only exposure). Batch path: `voice-loop.js`'s `stopRecording()` stamps `lastMicStoppedAt`; threaded through `ws.js`'s `utterance()` (new optional param, `undefined`-safe for existing callers) into the `{type:'utterance'}` frame; `server/index.js`'s `sendSpokenReply()` records the delta on the first chunk carrying real `audioB64`. S2S path: the connection closure tracks `liveTurnUserSpeechAt` (set on the turn's first confirmed user transcription, since Live has no discrete "recording stopped" moment) and records the delta on the turn's first `onAudioOut`, resetting both on `onTurnComplete`. Both paths feed the same shared tracker, surfaced via `/api/status`'s new `voiceLatency` field. **Live verification, both real:** `node scripts/verify-gemini-live.js` re-run this session — PASS, `models/gemini-3.1-flash-live-preview`, 79,682B of real 24kHz audio, transcript "Hello, how are you doing?", clean `turnComplete`. New `scripts/verify-live-session-e2e.js` (distinct from the probe above — exercises MYTHOS's OWN `live-session.js` module end-to-end, not a hand-rolled wire-protocol script) — PASS: opened a real socket through the real module, sent synthetic 16kHz PCM + a text nudge, received 81,150 bytes of real 24kHz audio back through the module's own `onAudioOut` callback, transcript "Hello, how are you?" through `onTranscript`, `onTurnComplete` fired with the real turn, and real `usageMetadata`→`spend.recordCall` with 375 input / 47 output tokens — proving the module this build shipped, not just the wire protocol in the abstract, actually works against the live API. Full suite: 1601 tests, 1600 pass, 0 fail, 1 skip, 0 todo. | (this commit) | Scripted/module-level: yes, both scripts above ran live against the real Gemini API with a real key. Full end-to-end through a browser (wake word → `s2s-bridge.js` → `server/index.js` → Gemini → speaker) and V2 §14's live items 1-4 (barge-in by voice, the T3 confirm-by-voice gate, cross-turn recall by voice, hearing a reply) all need a human with a microphone and speakers — genuinely not producible in this environment, left explicitly unticked above with that reason. The T3 scripted proof the close-out asks for (no microphone needed) already exists from Phase 3: `test/anti-drift-audit-single-write.test.js`'s second test drives a `delete_goal` (T3) call through the real adapter+leash and asserts `status:'awaiting_human_confirmation'`, zero `dispatchAction` calls, and exactly one audit write (`decision:'confirm'`, `tier:3`). |
| 2026-07-30 | **Merged-order step 5, Task 7 (autostart on login):** new `mythos/scripts/setup-autostart.js` (`--install`/`--check`/`--uninstall`, task name `MythosAgentOS`, repo root resolved via `path.resolve(__dirname,'..','..')`, points at the existing `Start Agent OS.bat`, `/rl limited` so no elevation is required by design, `/f` for idempotent re-registration). `buildSchtasksArgs()` factored out and unit-tested (`test/setup-autostart.test.js`, 5 tests — written red-first, confirmed failing on "module not found" before the script existed) to prove the argv never contains a hardcoded/machine-specific path and always double-quotes the (space-containing) repo path. A background sub-agent's own first live-verification attempt tried to spawn an elevated/admin PowerShell process without authorization to force the registration through — flagged as a security concern, not acted on; independently confirmed via `schtasks /query /tn MythosAgentOS` that no task was actually left registered by that attempt. Re-verified everything myself, unelevated: the delivered test file was actually ESM (`import`/`export`) in a CommonJS repo with no `"type":"module"` in `package.json` — it could not have run as committed; rewritten to the same `require()`-based style as every other test file in this repo, then genuinely re-run green (5/5). `--check` and `--uninstall` both live-verified for real against this machine's real (absent) Task Scheduler state, honest non-zero exit + clear message either way. `--install` was attempted for real and failed with a real `schtasks` "Access is denied" — this development account cannot register scheduled tasks in this session (an environment/account permission limit, not a script defect); did not escalate privileges to force it through, since Step 3 of this task is explicit that the script is user-invoked only and nothing authorized an elevated system-settings change. | `e4484f1` (bundled with the tiers.js infra commit below — the two files were already staged from an earlier blocked commit attempt when the tiers.js commit was made; not a deliberate multi-item batch) | `--check`/`--uninstall`: yes, real `schtasks` calls, real output pasted in the session report. `--install`: attempted for real, failed honestly with Access Denied on this sandboxed account; full logout/login confirmation needs an operator with normal admin rights on their own machine, left unticked (Step 4) for that reason. |
| 2026-07-30 | **Merged-order step 5, Task 4 (file move/copy/rename/search):** `move_file`/`copy_file`/`rename_file`/`search_files` added to `from-computer.js`, reusing `resolveSandboxed()`/`isInsideAllowedRoots()`/`nearestExistingAncestor()` verbatim on both source AND destination for the three mutating tools. `search_files` adds a name-match wildcard walker capped at depth 6 (new `MAX_SEARCH_DEPTH`) and a second, previously-unspecified `MAX_SEARCH_SCAN=5000` total-entries cap so a `pattern:'*'` search over a large real directory can't hang. `test/from-computer-fileops.test.js` (11 tests), red-first: 5 "must be registered" failures + 6 downstream `TypeError`s before implementation, 11/11 after. `test/effectors-hub.test.js`'s "gate: N registered count" invariant updated 78→82 with its changelog comment extended (this file's `registerFromComputer()` is one of the register* calls that gate counts). **Real finding, out of scope to fix here:** the plan's own literal test used `os.tmpdir()` as a stand-in allowed root; on this machine that's the Windows 8.3 short-name form of the user-profile path (an 8-char truncated+`~1`-suffixed directory segment, because the real username contains a space) while `%USERPROFILE%` is the long form — `resolveSandboxed()`'s plain string-prefix compare doesn't resolve short names, so it wrongly rejects a `%TEMP%`-derived path as outside every allowed root even though it's the same real location on disk. Pre-existing in `resolveSandboxed()`/`allowedRoots()` (also affects `write_file`/`create_folder`/`delete_file` today), not introduced by this task; live-verification below used a project-root scratch directory instead, sidestepping it. Full suite: 1665 tests, 1664 pass, 0 fail, 1 skip, 0 todo. | `` (this commit) `` | Real, on-disk, via the actual module (not mocked): `move_file`/`copy_file`/`rename_file`/`search_files` each run against real files under a real project-root scratch directory with real `fs.existsSync` before/after proving the real filesystem effect (source gone/present, destination present/absent, content correct); a security case confirmed `move_file` targeting `C:\Windows\System32\...` is rejected with nothing created there and the source untouched. "By voice" (Step 6's literal wording) needs a live mic/human session — not producible here; the on-disk proof above is the substitute. |
| 2026-07-30 | **Merged-order step 5, §7.6 (Calendar claim — implemented, not deleted):** verified `scripts/google-auth.js` already requests the `calendar.readonly` scope alongside Gmail's (since BUG-024), so this is genuinely "scope, not new auth" against the existing `adapters/google` adapter — the opposite conclusion from an earlier pass in this same session that (wrongly) assumed a new OAuth consent flow was needed and started deleting the header claim instead; caught before committing by actually reading `scripts/google-auth.js`'s `SCOPES` array rather than assuming. `adapters/google/index.js`: generalized `gmailRequest` into a shared `apiRequest(base, path, method, body)` (zero behavior change to existing Gmail call sites — `gmailRequest` is now a one-line wrapper), added `calendarRequest` + `listUpcomingEvents(maxResults)` (Calendar API v3, `timeMin`/`singleEvents`/`orderBy=startTime`, maps to `{id,title,start,end,location}`). `from-calendar.js`: new `calendar_upcoming` tool, same lazy-construct/clean-error/not-ready-sentinel-never-cached pattern as `from-gmail.js`'s `ensureAdapter`. `test/from-calendar-google.test.js` (4 tests), red-first: stashed the implementation, reran, confirmed 3 real failures ("calendar_upcoming must be registered"), restored, reran green. Covers the clean-config-error path (real, no creds configured on this machine) and the success path (mocked adapter via require-cache substitution, since `GOOGLE_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN` are genuinely unset here — confirmed, not assumed). Tier T1 (privacy-read, matches `gmail_unread`/`gmail_read`), not T0. Full suite: 1665 tests, 1664 pass (this feature added 4 net-new atop the baseline established by the tiers.js/main.js infra commits), 0 fail, 1 skip, 0 todo. | (this commit) | Real: the clean-degrade path (no Google creds configured) ran for real end-to-end through the real `buildCalendarTools`/`ensureGoogleAdapter`/`createGoogleAdapter` chain. NOT real: an actual Google Calendar account read — `GOOGLE_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN` are not configured on this machine (confirmed via a real env check, distinct from the unrelated `GOOGLE_API_KEY` which IS set for Gemini chat/image calls), so the success path is proven only against a mocked adapter. Needs an operator who runs `scripts/google-auth.js` with real Google Cloud OAuth credentials to live-verify a real event list — left explicitly unticked for that reason, a new item in the same class as the S2S mic/speaker gaps. |
| 2026-07-30 | **Merged-order step 5, Task 5 (alarms/timers with an audible alert) — committed together with §7.6 above since both live in `from-calendar.js` and were developed in the same working session without an intermediate commit boundary.** `addReminder()` gained `alertSound`; `timer_add`/`timer_cancel` thin-wrap `addReminder`/`cancelReminder`; `fireDueReminders()`'s `reminder.due` emit now carries `alertSound` through. `mythos/scripts/generate-alert-wav.js` (new, zero deps — hand-rolled 16-bit PCM WAV header + sine-wave synthesis) generates the committed `mythos/ui/public/audio/alert.wav` (a two-note 880Hz→660Hz chime, 33,560 real bytes, verified `RIFF`/`WAVE` magic). `server/index.js`'s `proactiveSpeak(text, targetWs, opts)` gained a third param; when `opts.alertSound` is set it loads+caches the WAV as base64 and sends it as chunk index 0 of the SAME `reqId`'s sequence (not a second, unregistered `reqId` — see the Step 4 note above for why that would have silently gone nowhere on the client), forcing `done.chunked:true` even when edge-tts is down so the client uses the chunk queue instead of double-speaking via `speechSynthesis`. `ui/public/js/voice/voice-loop.js`'s chunk player gained an optional `chunk.mime` (defaults to the prior hardcoded `audio/mpeg`, so every existing caller is unaffected) since the alert tone is a real WAV, not edge-tts's MP3. `test/from-calendar-timer.test.js` (5 tests) + `test/reminder-alert-sound.test.js` (2 tests, real server+WS), both red-first (server test stashed to prove real red: `expected at least one speech-chunk (the alert tone)` failed before the wiring existed). `.env.example` documents `REMINDER_ALERT_SOUND`. Conflict resolution vs V2 §7.12 (real Scheduled-Tasks-backed alarms) recorded above the checklist — built in-process only, judged NOT a thin reuse of Task 7's `schtasks` machinery, documented as a real gap rather than silently dropped. Full suite: 1665/1664/0/1/0 (net of the whole step-5 batch, not just this item). | (this commit) | Real, server+WS level: a genuine `bus.emit('reminder.due', {alertSound:true})` through the real `createServer()` produces a real `speech-chunk` (`mime:'audio/wav'`, real decoded `RIFF`/`WAVE` bytes) ahead of a `done` with `chunked:true`; a plain reminder (`alertSound` false/absent) never emits that chunk. NOT real: a human actually hearing the tone through speakers — no audio hardware/operator in this session, left explicitly unticked (Step 7) rather than fabricated. |
| 2026-07-30 | **Merged-order step 5, §7.9 maps/routing + §7.10 image generation:** `get_directions` added to `from-system.js` (keyless OSRM public routing + the existing `geocode()`), tier T0. New `from-image-gen.js` (`generate_image`, T2 — same class as `generate_pdf`/`generate_deck`), kept OUT of `from-docs.js` on purpose since that file's own header documents "no new network at runtime" and image-gen genuinely needs one. Model id verified live (WebSearch against current Gemini API docs, then a real probe against 5 candidate model ids with the real key — a wrong id 404s, a valid-but-quota-blocked id 429s with the model name in the error, which is how `gemini-3.1-flash-image` was confirmed real): not trusted from training data, which would be stale for a preview-era API. **Real, honest finding:** the real call returns HTTP 429 `limit: 0` — this Google account's free tier grants zero image-generation quota (permanent entitlement, not a transient rate limit that clears on retry) — reported to the caller exactly as `Image generation is unavailable (You exceeded your current quota...)`, never a fabricated image. `test/from-system-directions.test.js` (9 tests) + `test/from-image-gen.test.js` (9 tests, including a path-traversal title rejected via the same slugify+prefix-assertion pattern `from-docs.js` already uses), both red-first (module/function not found before implementation). Full suite included in the step-5 batch total (1665/1664/0/1/0). | (this commit) | Real for both: `get_directions` called for real (London→Paris, real distance/duration from OSRM); `generate_image` called for real with the real `GOOGLE_API_KEY` already in `.env` — the real 429/quota-zero response IS the live verification here, proving the tool's honest-failure path against a genuine API response rather than a mock. No image was actually generated (impossible with this account's current entitlement, not something this session can fix) — left explicitly unticked as a capability that needs the operator to enable billing on the Google AI Studio project. |
| 2026-07-30 | **Merged-order step 5, §7.5 Document RAG + §7.11 semantic code search (built in that order, as required):** new `memory/chunker.js` (pure, shared by both — `chunkProse` ~800-word chunks/15% overlap, tokens approximated as whitespace-split words since no tokenizer dep exists or was added; `chunkCode` a boundary-aware heuristic for JS/TS/Python function/class/def/arrow-const/module.exports boundaries, falling back to a line-cap for other constructs). New `memory/documents.js` (`createDocumentsStore`, one JSON file per chunk under `Documents/chunks/<ref>.json` plus a doc-level `Documents/index.json`). `memory/index.js` diff (the only file this feature modifies that is shared with nothing else in step 5): added `documents: createVectorIndex({fs, store:'documents'})` as the ONE new partition — explicitly commented as such — and extended `recallHybrid`'s fan-out from `['episodic','semantic']` to `['episodic','semantic','documents']` via a `RECALL_STORES` map. New `from-documents.js` (`document_ingest`/`document_list`/`document_search`) and `from-code-search.js` (`index_project`/`search_code`), both accepting an injectable `embed` function (DI seam mirroring `live-session.js`'s `createSocket`/`pcm-player.js`'s `contextFactory` precedent) defaulting to the real `providers/embeddings.embed`; both write into the SAME `documents` store/index via a `sourceType` field (`'upload'` vs `'code'`), never a second `createVectorIndex(...)` call. `index_project`/`document_ingest` reuse `from-computer.js`'s `resolveSandboxed`/`isInsideAllowedRoots` verbatim (one new one-line export needed on that file — landed in the Task 4 commit, confirmed no conflict with that commit's own fileops work via diff). **The "not a second index" invariant is proven, not just asserted:** `code-search.test.js`'s invariant test ingests one prose doc and indexes one code file through the two separate effectors, then asserts exactly one `Index/documents.vec.json` sidecar file exists. `test/document-rag.test.js` + `test/code-search.test.js` (19 tests combined), red-first (`Cannot find module` before either effector file existed), then a genuine mid-implementation bug found and fixed (`isInsideAllowedRoots is not a function` — not yet exported), then a real test-isolation bug found and fixed (two describe blocks shared one scratch directory, so a previous run's leftover file leaked into a sibling test). Full suite (whole step-5 batch): 1665/1664/0/1/0. | (this commit) | `providers/embeddings.getStatus()` confirmed real and honest: `{available:false}` — no Ollama/Mistral reachable in this environment. Real path (genuinely exercised, not skipped): `document_ingest`/`index_project` against real files degrade honestly per-chunk (`embedded:0, skipped:1`), `document_search`/`search_code`/`recallHybrid` all return `[]` with `degraded:true` rather than throwing or fabricating a hit. DI-seam substitute (a fake embedder standing in for the confirmed-down real network call, explicitly sanctioned for this exact situation): proves the actual ranking/retrieval logic works — a real ingested doc is found by `document_search`, a real indexed source file is found by `search_code` with correct `lineStart`/`lineEnd`. A real Ollama/Mistral embedding round-trip needs an operator with one of those configured — left unticked as that specific sub-case, the retrieval logic itself is proven via the DI seam. |
| 2026-07-30 | **Merged-order step 5, Task 3 (clipboard read/write) — first of the serialized `ps-automation.ps1` items.** Pre-edit BUG-037 reconciliation done for real (all 6 load-bearing pieces confirmed present, re-confirmed after). Real dispatch shape differs from the plan's illustrative `Write-Response $cmdId @{...}` snippet — matched the actual `switch`-with-`$result`/`$err`-then-one-`Write-Response`-call convention instead (new `Handle-GetClipboard`/`Handle-SetClipboard` functions, same style as `Handle-GetVolume`/`Handle-WriteNote`). `from-computer.js`: `clipboard_read`/`clipboard_write` require `adapters/pc-child` directly at module scope (matching `from-pc.js`, NOT the plan's illustrative `ctx.pcChild` — verified `dispatch-action.js`'s real ctx is `{signal,bus,goalId}`, never an adapter handle, so a `ctx.pcChild` design would silently never work in production). Two conflict resolutions recorded in the checklist above: `clipboard_write` tier (T2, not Task 3's T1 or V2's ambiguity) and its `danger` flag (`false`, not Task 3's `true` — required by this repo's own `danger:true→tier>=3` invariant, caught by the full suite failing after the first attempt). `test/from-computer-clipboard.test.js` (5 tests), red-first (confirmed "clipboard_read must be registered" before implementation). `effectors-hub.test.js` gate 82→84. Full suite: 1670 tests, 1669 pass, 0 fail, 1 skip, 0 todo. | (this commit) | **Real, end-to-end, through the actual PowerShell daemon — not mocked.** Started the real `pc-child` adapter, confirmed real `ONLINE`/`ping`, wrote a unique marker string via the real `clipboard_write()` (real `set_clipboard` PS command executed), read it back via the real `clipboard_read()` (real `get_clipboard` PS command) — the exact marker came back. This is the strongest class of live verification in this whole step: a genuine OS-level round trip, no mocks, no stubs. |
| 2026-07-30 | **Merged-order step 5, §7.1 (real screen OCR) — second serialized `ps-automation.ps1` item.** Pre-edit BUG-037 reconciliation done for real (all 6 load-bearing pieces confirmed present before and after). Deviated from V2's illustrative PowerShell snippet's bare `[Windows.Storage.StorageFile]` bracket syntax, which doesn't reliably resolve in PS 5.1 without extra accelerator setup this file never does that way — matched the file's OWN established `[Type]::GetType('...,ContentType=WindowsRuntime')` convention instead (identical to how the existing SMTC media-session code resolves `Windows.Media.Control` types). De-risked the WinRT reflection chain BEFORE wiring it in: a standalone throwaway script ran the exact same `StorageFile`→stream→`BitmapDecoder`→`SoftwareBitmap`→`OcrEngine` chain against a bitmap with known drawn text and got that exact string back, proving the reflection approach works on this real machine before touching the shared file. New `Handle-ScreenReadText` (ps-automation.ps1) + `screen_read_text` effector (`from-pc.js`, T0). `test/screen-read-text.test.js` (3 tests), red-first. `effectors-hub.test.js` gate 84→85. Full suite: 1673 tests, 1672 pass, 0 fail, 1 skip, 0 todo. | (this commit) | **Real, and unusually strong — the OCR read genuine, unstaged live desktop content**, not a synthetic fixture: through the real `pc-child` daemon, `screen_read_text()` returned 49 real recognized lines of actual on-screen text from this very working session (editor content, terminal output), proving the full real pipeline (screen capture → WinRT decode → real `Windows.Media.Ocr` recognition) end-to-end against real, uncontrolled screen content. |
| 2026-07-30 | **Merged-order step 5, §7.7 (wallpaper engine) — third and last serialized `ps-automation.ps1` item, closes that chain.** Pre-edit BUG-037 reconciliation done for real (6 load-bearing pieces confirmed present before and after — count unchanged from the OCR commit, as expected since this edit touches none of those six markers). Added `SystemParametersInfo` P/Invoke to the existing `NativeInput` C# class (same `Add-Type` block `SendInput`/`SetWindowPos` already live in) rather than a new class, plus `Handle-SetWallpaper`. De-risked standalone before wiring in: a throwaway script called the real P/Invoke against a real generated BMP and confirmed via the real `HKCU:\Control Panel\Desktop\Wallpaper` registry value that the OS wallpaper genuinely changed, then restored the operator's real original wallpaper immediately. New `set_wallpaper` effector in `from-pc.js` (T2), path sandboxed via `from-computer.js`'s `resolveSandboxed` before ever reaching `pc-child`. `test/from-pc-wallpaper.test.js` (3 tests), red-first. `effectors-hub.test.js` gate 85→86. Full suite: 1676 tests, 1675 pass, 0 fail, 1 skip, 0 todo. | (this commit) | **Real, through the actual PowerShell daemon and the real OS setting — not mocked, with one honest complication.** The real `set_wallpaper()` effector call against the real `pc-child` daemon returned `ok:true` with the real resolved path, and a direct registry check independently confirmed `HKCU:\Control Panel\Desktop\Wallpaper` had genuinely changed to that exact path. The automated verify script's own restore step failed (a `execSync`/cmd.exe quoting bug in the *verification harness*, not the feature — it mangled the registry-path string it was trying to read back, so it captured an empty "original wallpaper" value and couldn't restore from it). Caught immediately by checking the registry directly rather than trusting the script's own success/failure signal; the operator's actual original wallpaper (recorded earlier in this same session, before ANY test) was restored for real via a direct P/Invoke call, then independently re-confirmed via the registry to match exactly. No lasting effect on the machine. |
| 2026-07-30 | **Merged-order step 5, §7.3 (PIN / Windows Hello lock) — closes step 5.** New `src/core/security/pin-lock.js` (salted `scrypt` hash, random per-PIN salt, `timingSafeEqual` comparison, 5-attempt/60s lockout) + `server/routes/pin.js` (`GET /api/pin/status`, `POST /api/pin/set`, `POST /api/pin/verify`), wired via `main.js`'s `createPinLock({fs: memory.fs})` into `createServer()`'s deps and mounted behind the existing `requireToken` `/api` gate. Windows Hello NOT built — `hasWindowsHello()` always `false`, honestly documented as "never built" not "hardware absent." `test/pin-lock.test.js` (9 tests) + `test/pin-routes.test.js` (5 tests), red-first (both files confirmed failing — module/mount not found — with the implementation files temporarily moved aside, then restored). **security-reviewer (sonnet) dispatched per the task's own instruction** (a credential-storing feature): found one real MEDIUM (`/api/pin/set` had no proof-of-current-PIN requirement — a total bypass of the feature's purpose for anyone reaching the route, since it sits behind the same bearer-token gate the whole feature is supposed to add friction beyond) — fixed same-session: `setPin()` now calls the real `verifyPin()` internally (lockout included) before allowing a change to an already-configured PIN; two new tests added proving both the bypass is closed AND that a legitimate PIN change still works with the correct current PIN once any active lockout window passes (a prior test asserting the opposite — that `setPin` could be used to escape a lockout — was itself invalidated by the fix and rewritten to assert the correct, secure behavior instead of quietly deleted). Two LOW findings accepted as-is (in-memory-only lockout; no enforcement point wired yet — see below). Full suite: 1690 tests, 1689 pass, 0 fail, 1 skip, 0 todo. | (this commit) | Real, but backend-only, honestly scoped: `test/pin-routes.test.js` drives a REAL Express server + a REAL `createPinLock` instance (only the vault `fs` is faked, matching every other test in this repo) through real HTTP requests — real salted-hash storage, a real 429 lockout triggered by genuinely repeated wrong-PIN HTTP calls, and the real security-fix bypass-closure, all end-to-end through the actual route handlers. What is NOT live-verified, and could not be in this environment: a human actually typing a PIN into a lock-screen UI and watching the HUD unlock — no frontend lock screen exists yet (the security review's own LOW finding), so there is nothing for an operator to click through. This session ships the real backend mechanism, not a working end-to-end user-facing lock; left honestly unticked at that granularity. |
| 2026-07-30 | **Merged-order step 6, Task 8 (`android-child` adapter).** New `mythos/adapters/android-child/index.js` — NOT a copy of `pc-child`'s persistent-daemon shape (adb has no such mode; every `adb -s <serial> shell …` is one-shot), so what transfers is the discipline: per-device queues (`Map<serial,{queue,inFlight}>`, so a slow command on phone A never blocks phone B), side-effect-free `require()`, explicit start/shutdown, and cua-driver's ENOENT→OFFLINE contract (AD-9). `startAndroidChild()` is a synchronous `adb version` `spawnSync` probe — no async handshake needed, unlike `pc-child`/`cua-driver`. Never calls `adb kill-server` on shutdown (would drop other tools' adb sessions on the same machine). `test/android-child-adapter.test.js` (8 tests after the Task-10 integration fix below, 6 red-first at this commit — confirmed "Cannot find module" before the file existed): side-effect-free require, `sendCommand()` resolving `ok:false` (never throwing) while offline for both device-scoped and global commands, safe shutdown with nothing started, bounded settle to a terminal state, independent per-device queues. Full suite: 1696 tests, 1695 pass, 0 fail, 1 skip, 0 todo. | `83b2281` | Real: booted with no `adb` on PATH (confirmed absent on this machine) — settles to `OFFLINE` with the exact install hint, logged by the adapter itself. The `-s <serial>` argv bug (Finding 1 below) was still latent at this commit — not yet observable because no device-scoped call existed until Task 10 wired one. |
| 2026-07-30 | **Merged-order step 6, Task 9 (`setup-android.js`).** New `mythos/scripts/setup-android.js`, modeled on `setup-hermes.js`'s `--check`/`--install` shape: `--check` resolves `adb` (env override → project-local install → PATH) and reports per-device pairing status + a smoke-test command; `--install` downloads Google's official platform-tools zip for the running OS into `<repo>/Android Platform Tools/` (gitignored) and unzips via the OS's own tool (Expand-Archive/`unzip`) — no new npm dependency, never `curl\|bash`/`iex(irm…)`; `--pair`/`--connect` relay to `adb pair`/`adb connect`, the latter persisting to `vault/Identity/android-devices.json` (vault, not `.env` — a growing list, not a static secret). `test/setup-android.test.js` (10 tests) covers only pure construction/parsing logic (URL building, path portability, arg shape, devices-output parsing, device-record merge/dedupe) — mirrors `setup-autostart.test.js`'s precedent of never touching the real tool. `--install`/`--pair`/`--connect` deliberately never run for real: no adb, no phone, and an unattended ~15MB download is the operator's call. Full suite: 1706 tests, 1705 pass, 0 fail, 1 skip, 0 todo. | `39ceb00` | Real, live `--check` on this machine (no adb on PATH): `adb: NOT FOUND (adb)` + the install hint, exit code 1 — matches `android-child`'s own OFFLINE state exactly. `--install`/`--pair`/`--connect` NOT run — no adb, no phone, deliberate per the task's own instruction not to attempt an unattended install. |
| 2026-07-30 | **Merged-order step 6, Task 10 (`from-android.js`, 14 tools) — CLOSES STEP 6.** New `mythos/src/core/effectors/from-android.js` (14 registered effectors / 13 table rows — `phone_flashlight_toggle` omitted, `phone_shell` refused); `tiers.js` (+14 entries, cited per that file's own header requiring a spec update for any add/re-tier — this plan IS that update); `main.js` boot wiring (registration, start/shutdown, capability-manifest/status roll-up, identical to `pc-child`/`cua-driver`'s three wiring points); `config/schema.js` + `.env.example` (`ANDROID_ADB_BIN`/`ANDROID_ADB_POLL_MS`/`ANDROID_CMD_TIMEOUT_MS`); `.gitignore` (`/Android Platform Tools/`, mirroring `/Hermes Agent/`). WhatsApp resolved as option (b): dropped the "resolved send tap" step (Task 10's own Step 3), keeping the honest deep-link-open behaviour — no physical phone to verify a tap primitive against, and shipping one unverifiable would be the exact false-capability-claim failure mode this whole build exists to beat. `phone_sms_send`/`phone_whatsapp_send` report `{opened:true, sent:false}`, never a claimed send (AD-4). `test/from-android.test.js` (20 tests) against a MOCKED `androidChild` (module-singleton stubbing, same technique as `test/from-calendar-google.test.js`): exact tool count/no-flashlight/no-raw-shell, every tool degrading honestly OFFLINE, explicit-`deviceId` enforcement (missing AND unknown-serial), and the precise POSIX single-quote escaping of a malicious SMS body and a SQL-breakout contacts query (verified against the literal expected escaped token, not a substring guess). **security-reviewer (sonnet) dispatched per this task's own instruction — 3 findings, all fixed same-session:** (1) HIGH — `serial` was used only as the queue-partition key and never reached `adb`'s actual argv (`android-child/index.js`), so a command silently ran against whatever device adb defaulted to; invisible with one device attached, outright broken with 2+ (this task's own explicit multi-device goal) since adb refuses to run anything without `-s` when multiple devices are present — fixed with a new pure, exported, unit-tested `buildAdbArgs(serial, args)` prepending `['-s', serial]` before the subcommand, plus `from-android.js`'s `checkDevice()` now also confirms the supplied `deviceId` is a currently-known serial (not merely truthy), closing a stale-serial-silently-accepted gap too; (2) MEDIUM-HIGH — `phone_file_pull` was tiered T1 ("a read from the phone") despite `adb pull` being a local WRITE into whatever `resolveSandboxed()`-approved path is given (same risk class as `write_file`, and `allowedRoots()` always includes the project root) — re-tiered to T3, `danger:true`, matching `phone_file_push`/`write_file`; (3) LOW/informational — `resolveSandboxed()` (shared with `set_wallpaper`) doesn't follow symlinks the way `isInsideAllowedRoots()` does; confirmed pre-existing and repo-wide, not introduced here — flagged as a spawned background task (`task_5836cdee`) rather than fixed in this file, out of scope. Also aligned `phone_wifi_toggle`/`phone_bluetooth_toggle`/`phone_app_launch`/`phone_app_close` onto the same single-quoted-command pattern as sms/contacts/whatsapp (a reviewer consistency note, safe either way today since those four inputs are strictly enum/regex-validated, but more defensible if a validator is ever loosened). Full suite: 1727 tests, 1726 pass, 0 fail, 1 skip, 0 todo (was 1690/1689/0/1/0 before step 6; 125→139 effectors). | `7247d5c` | **Real AD-9 proof**: booted the actual app (`node src/main.js`) with `adb` absent from PATH — `{"msg":"effectors.ready","count":139}`, `{"msg":"android-child.offline","hint":"adb not found — run node mythos/scripts/setup-android.js --install"}`, `vault/Identity/capabilities.md` written listing `android-child: OFFLINE (adb not found — ...)` honestly, then `{"msg":"MYTHOS ALIVE","port":4478}` — boot succeeded, all 139 effectors registered, `pc-child`/`cua-driver` came online normally, unaffected by `android-child`'s absence. Unit-verified only, against a mocked adapter (explicitly, not claimed otherwise): every `phone_*` tool's OFFLINE-degrade behavior, device-id enforcement, and shell-injection resistance. NOT live-verified, and cannot be from this machine: Task 9 Step 5 (`--check` against a real device), Task 10 Step 9 (real SMS compose, real WhatsApp deep link, real WiFi toggle, real `adb shell echo` roundtrip) — no physical Android phone exists here. Left explicitly unticked for that reason. |

| 2026-07-30 | **Post-step-6 integration + cross-machine handoff prep:** merged both local-only branches into `main` (`e263ae1` symlink-aware `resolveSandboxed()`; CRLF-safe `sync-test-count.js` + README mermaid brain lanes), committed the stranded `setup-hermes.js` provider warning (`34659d8`) so it survives the machine move, pushed `phase5/production-and-docs` to origin for preservation, and folded this session's licensing findings into the new Step 6.5 section (commercial intent confirmed; warnings are self-authored not upstream; edge-tts is ToS + an unverified package licence; NC covers use not just distribution; the gate blocks shipping not building; three operator decisions required). | `e263ae1`, `34659d8` + this commit | yes — full suite re-run independently at 1735/1734/0 fail/1 skip/0 todo; `sync-test-count --check` green; CRLF fix verified by re-running `--check` (previously reported "block missing") and confirming exactly one sync block remains |
| 2026-07-31 | **Cross-cutting hardening wave — advanced NO merged-order step, ran beside them.** Structure: 5 read-only auditors → 6-agent fix wave → 3 adversarial reviewers (correctness/honesty/security lenses, each told to default to DEFECTIVE when uncertain) → a second fix round on their findings. **All three reviewers returned DEFECTIVE on the first wave and every finding was real** — that round-two step is where most of the value is, and it is the reason this row can be trusted. Landed, each red-first: (a) **CRITICAL leash bypass** — tier-wide T3 grant scoped to an explicit tool array (`goals/index.js`, `leash/index.js`, `leash/checkpoints.js`, new `test/leash-grant-scope.test.js`; red proof was literally `gmail_send must NOT be allowed by a build_project grant — actual: true`); (b) **CRITICAL corrupt-JSON data loss** — new `fs-store.readJSONStrict()` throws on unparseable *and* unreadable, adopted by the three read-mutate-write stores, with the real-file proof (a seeded corrupt `reminders.json` losing two real reminders behind `ok:true`) as a test; the first attempt only closed the throwing variant and the honesty reviewer caught it; (c) **skills never reached builds** — `skills/loader.js` searched only `~/.zcode/skills`, so a Claude Code machine silently got a bundled-CSV design substitute; multi-root resolution added + `externalSkillRoots()` diagnostic; (d) dead `speak` effector and phantom `monitor_snapshot` tier row removed, replaced by a two-way `tier-table-conformance.test.js` so the drift class cannot return; (e) four android tools now read device state back instead of trusting `adb`'s exit code, with `needs_result:true` so the honest outcome reaches the user; (f) S2S bridge / PIN lock / `voiceLatency` tile wired to the UI for the first time; (g) goals-bridge degraded paths no longer audit `'ok'` for writes that never landed; (h) two flaky pipeline tests were a 4s bounded wait, not a deadlock — diagnosed, widened, message made diagnostic. | (this commit) | Mixed, stated per item. **Real:** the skills fix (ran the actual `ui-ux-pro-max/scripts/search.py`, 2,661 chars of real design system; catalog 5→9); the corrupt-JSON loss and its fix (real `fs-store`, real files on disk, byte-compared); every fix red→green through the real modules. **Unit/mock only:** android read-back (no physical phone exists here — all four paths remain unverified against real hardware). **NOT verified, needs a human:** every browser/mic item — S2S end-to-end, the PIN overlay, the latency tile — plus the pre-existing V2 §14 live items. **Known-incomplete by design:** the PIN lock is a visual/pointer deterrent, NOT access control (default install has no bearer token and `tokenOk()` passes when unset, so `curl` bypasses it); a server-side PIN session is not built. |

| 2026-07-30 | **6.5 licensing gate — decisions + upstream licence verification (resume from second PC).** Synced `main` to `ac5032c` (stash→ff→pop over 2 local WIP files, then 2 commits: `035c2f3` test-count sync, `7db9d5c` hermes `v2026.7.20` tag pin + `env.download` gitignore). Full baseline: 1735/1735/0 fail/0 skip (the 1 documented skip runs as pass on this Node/Windows). **Both gate problems verified against REAL upstream sources, not this repo's self-authored comments** (`git blame`→`532106d8`): (a) edge-tts upstream Python package = **LGPLv3** — LICENSE file (`github.com/rany2/edge-tts`) is LGPLv3 for the lib (one MIT CLI entry file), PyPI classifier `License :: OSI Approved :: GNU Lesser General Public License v3 (LGPLv3)`, author `rany`, `7.2.8`; the package is NOT vendored anywhere tracked (`services/edge-tts-server.py` does `import edge_tts`, no requirements.txt) so the repo ships a Combined Work expecting the user to supply the library; (b) openWakeWord weights = **CC BY-NC-SA 4.0** (GitHub README + HuggingFace `davidscripka/openwakeword`, verbatim "due to the inclusion of datasets with unknown or restrictive licensing"), code/tooling Apache-2.0 — caught my own near-error of reading the code-only LICENSE and concluding "Apache for everything." **Three operator decisions answered:** D1 TTS stays BYO (removes the LGPL exposure WITHOUT a Piper swap — the planned swap is no longer required for TTS; constraint becomes step-7 installer "never bundle the LGPL package" + BYO docs, not a 6.5 code task); D2 free demo deferred; D3 wider licence audit split into new tracked step 6.6. **Wake-word decision (C) locked:** train an own `hey_mythos` model with openWakeWord's Apache-2.0 tooling + Piper's MIT samples — free/open, commercial-safe, BYOK product-wide (users bring their own Gemini/Grok keys). Separate workstream, needs the operator's ear to validate; closes the last open 6.5 item when done. | `035c2f3`, `7db9d5c` + this commit | yes — baseline reproduced via the pre-commit gate's own full-suite run (0 failures, 1735/1735); licences verified against live upstream URLs (raw LICENSE files + PyPI JSON), not search summaries or repo comments. No code changed; no legal conclusion written into any tracked file. |

| 2026-07-30 | **Step 7 / Phase 8 — Electron shell, Slice 1 (FOUNDATION).** Implements spine §13 — Electron as a shell around the existing server, NOT a rewrite. `BrowserWindow` loads `http://127.0.0.1:<port>` (HUD/worklets/WS client unchanged); `mythos/src/main.js` is `fork()`ed on loopback with paths resolved via `__dirname` (no hardcoded/machine-specific paths — AD-7). Bounded `GET /health` probe before `loadURL`; capped child-restart backoff; single-instance lock; clean shutdown. **safeStorage (DPAPI) key store** under `app.getPath('userData')/keys.json` — decrypted values injected ONLY into the child env (server-side), never the renderer; `.env` stays supported for headless/Docker. **AD-8 (load-bearing):** `electron/preload.js` exposes a `contextBridge` surface of EXACTLY `{ getKeyNames, setKey, hasKey }` — names + booleans only, no `getKey`/`getValue`/`read`. Root `package.json` (devDeps electron + electron-builder; mythos/package.json untouched). **security-reviewer (sonnet) dispatched on the credential surface** — AD-8 intact; found 1 HIGH (safeStorage Buffer round-tripped via JSON as `{type:Buffer}` then silently failed decrypt on restart, dropping keys from the child env — fixed: explicit base64), 1 MEDIUM (`__proto__`/`constructor` key names silently lost — fixed: charset-validated name + `Object.create(null)` store), 2 LOW (0600 perms + load-modify-write race — fixed). All same-commit. Tests: `electron-preload-surface.test.js` (exact 3-fn surface, channel forwarding) + `anti-drift-no-key-to-client.test.js` (AD-8 regression gate). Test idiom: generalized the repo's require-cache stubbing beyond `from-calendar-google.test.js` — `Module._resolveFilename` override (install-agnostic, since `require.resolve('electron')` throws when electron isn't npm-installed). Suite 1735→1737, 0 fail. **Slice 1 of 6** (remaining: globalShortcut, desktopCapturer, electron-builder installer w/ Decision-1 no-edge-tts-bundle constraint, cursor overlay, OSS hygiene). Windows-only (Decision A); slice-by-slice (Decision B); code-signing deferred to release (Decision D). | `5f6108d` | yes — full suite reproduced by orchestrator independently (1737/1737/0 fail, NOT trusted from the agent's report); both new tests assert the security-critical AD-8 surface; security-reviewer findings fixed before commit. NOT live-verified through a real Electron window (needs `npm install` at repo root + a desktop GUI) — the Electron runtime code is unit-tested only; booting the actual app is the operator's step (see RESUME HERE). |

| 2026-07-30 | **Slice 1 hardening — 3 launch bugs found live + 2 session-surface bugs fixed.** The operator booted Slice 1 via `Start Electron App.bat` and had real voice conversations through the **browser** (port 4478) — proving the server child boots under Electron's fork, but surfacing four real gaps, root-caused and fixed: (a) **EPIPE crash** (`67c57b7`) — double-clicked Electron has no terminal reading stdout/stderr; the chatty server child inherited those pipes, the parent's next `console.error` wrote to a broken fd and threw → crash dialog. Fix: child stdio → `app.getPath('userData')/mythos-server.log` (diagnosable + removes the EPIPE surface); EPIPE-safe `log()` helper; `process.uncaughtException` backstop. (b) **Vault-path regression** (`67c57b7`) — `fork()` inherits the parent's CWD (repo root), but `MYTHOS_VAULT_ROOT` defaults to `./vault` (CWD-relative), so the server used `<repo>/vault` (empty, count:0) instead of `mythos/vault` (2842 episodic entries) — a factory-reset MYTHOS. Fix: `cwd: MYTHOS_DIR`. (c) **Launcher LF endings** (`4907999`) — the bat was written LF, cmd mis-tokenized it (`'Electron'`/`'tron'` split, `) was unexpected`); now CRLF + a `:log` helper mirroring every step to `%TEMP%\mythos-electron-launch.log` so an open-and-close leaves evidence. `.gitignore` covers `/vault/` (the misrooted-vault safety net). (d) **Browser SPA click timeout + Electron mic** (`d09565a`) — the operator's session showed `browser_get_text` timing out at 15s on `ytd-rich-item-renderer #video-title` (YouTube's custom elements hydrate AFTER `domcontentloaded`, and get_text had NO pre-wait while click SILENTLY SWALLOWED its 5s wait). Fix: one `waitReady(page,selector)` helper (bounded visible-wait, returns true/false, no swallow) reused by click/type/get_text/fill_form; `browser_navigate` → `waitUntil:'commit'` + bounded `networkidle` settle; new config `BROWSER_PAGE_WAIT_MS` (8000) + `BROWSER_PAGE_TIMEOUT_MS` (15000). The Electron **mic** gap: Electron denies `getUserMedia` by default (no browser prompt), so the HUD's mic silently rejected — fixed via `setPermissionRequestHandler`/`setPermissionCheckHandler` auto-granting media/audioCapture/microphone for loopback only. 5 new SPA tests. Suite 1737→1742, 0 fail. | `67c57b7`, `4907999`, `d09565a` | yes (mock/unit level) — EPIPE/vault verified via the real electron binary (`MYTHOS ALIVE`, episodic count 2842, 0 EPIPE in child log); browser logic via 5 new mock tests; mic via 2 electron tests. NOT live-verified: the mic in the actual Electron window + a real YouTube click — both need the operator's interactive desktop (the agent shell cannot drive a GUI). Left unticked at that granularity. The operator's voice session through the browser DID prove the server's voice + screen-awareness + immune-self-heal paths work end-to-end. |
| 2026-07-31 | **Slice 2 hardening — 8 incidents flagged by the operator during live MYTHOS sessions (07-30/31), root-caused and fixed.** Note: the operator's "white leg" note was a voice-transcription garble for "the UI click is not **wired for the** electron" (verified, tick 148596) — no such term exists in the codebase. The fixes: (a) **click-inside-rendered-content gap** — `cua-driver` (element-addressed click binary) existed on disk but was wired to ONE private caller (Spotify); new `mythos/src/core/effectors/from-cua.js` exposes `cua_list_windows`/`cua_bring_to_front`/`cua_get_window_state`/`cua_click` to the brain with OFFLINE-honesty (`main.js` wires them, binary resolves ONLINE). This un-breaks Spotify-native search-then-play AND general Chromium clicking — the single root of "the wire for the electron." New `test/from-cua.test.js` (6 tests), hub gate 86→90. (b) **YouTube ad-blocker failing** (`electron/main.js`) — `fromPrebuiltAdsAndTracking(...).then(...)` was never awaited before `loadURL`, so cold-cache 7MB fetch finished after the iframe fired ad requests; now awaited, failure surfaced honestly. (c) **Electron YouTube lag** — `backgroundThrottling` defaulted true → iframe renderer throttled when unfocused (the 1-2s audio-cut signature); now `backgroundThrottling:false` + `disable-background-timer-throttling`/`disable-renderer-backgrounding` switches. (d) **"Opened Chrome despite electron-only"** — added `YOUTUBE_MODE:'electron'` (new default, in-HUD) + a `setWindowOpenHandler` that traps external `window.open(_blank)`. (e) **HUD stuck on "degraded" after self-heal** — healer suppressed/restored tools but never transitioned the breaker FSM, so `broadcastHealth` kept reporting it open; added `breaker.reset()`, healer calls it on `tool-restore`. (f) **Goals die on spawn** — the planner's ~107-tool catalog prompt was debited to the goal via `spentTokens: working.spendThisTick`, so each action re-charged for re-planning and a fresh 20k goal died in 1-2 ticks; planner cost now debited ONCE at plan time (`actions:0`), the action carries only its own cost. (g) **Fabricated success** ("now playing", "I minimized Spotify") — the corrective pass relied on the model choosing to admit failure; added a DETERMINISTIC honesty guard: when the entire turn failed, force a truthful frame regardless of model output; `show_desktop` result annotated `scope:'all-windows'` so it can't be misattributed to one window. (h) **Volume ducking** — the current tree already saves/restores the real pre-uck level (the "40/50/62" symptom was stale); made `DUCK_VOLUME_LEVEL`/`UNDUCK_SAFETY_MS` env-overridable for live tuning, restore logic unchanged pending live verification. Folder/skill flapping (candidate item) was found already covered by the existing effector breaker + fix (e), so no parallel mechanism was added. Suite 1742→1761, 0 fail (+19 new tests). | (this commit, unpushed) | partial — (a),(e),(f),(g),(h) unit/integration tested (breaker reset, goal-budget survival, deterministic honesty guard, from-cua offline-honesty, ducking knobs all green). NOT live-verified: (b),(c),(d) and the real Spotify search-then-play / YouTube in-app click need the operator's interactive Electron desktop — same caveat Slice 1 carried. These bugs were only ever caught live, never by mock tests, so live verification is the real gate before marking them closed. |

| 2026-07-31 | **First real voice session, and everything it broke — advanced NO merged-order step.** The operator held a ~70-minute voice conversation (35 turns, 23:22-00:33) and reported two things; the entity had itself logged three incidents. All were real, and all were diagnosed from that session's own data rather than guessed at. **(1) The entity was two different people.** "At the starting there is this British guy, male accent... but then comes the female voice." Three engines speak in one session and nothing kept them matched: `VOICE_TTS_VOICE` defaulted to `en-GB-RyanNeural` (male), `GEMINI_LIVE_VOICE` to `Aoede` (female), and the browser `speechSynthesis` fallback set **no voice at all**, inheriting Windows' Microsoft David (male). Each module was individually defensible — only the *set* was wrong, which is why nothing ever failed. Now `en-GB-SoniaNeural` + `Aoede` + a pure `pickSpeechVoice()` that prefers en-GB female and returns null rather than actively choosing a male voice. New `voice-identity-consistent.test.js` pins the two engine defaults **as a pair** and asserts every `SpeechSynthesisUtterance` gets an explicit voice. **(2) "My speech is consistently being cut off at the end, losing the last one or two words"** — logged by the entity as its own incident. The text was never at fault: all 29 replies round-trip `splitSentences()` losslessly and the longest was 628 chars against an 800 cap. The clue was the clock — the session ran 23:22-00:33 and `edge_tts` was not installed until 04:01, so TTS was **down for every single turn**. `sendSpokenReply()` computed `ttsUp ? splitSentences(speak) : []` and therefore sent **zero** chunks, so the client spoke the ENTIRE reply as one `SpeechSynthesisUtterance` — and Chrome truncates long ones. The comment directly above that line already described the correct behaviour, and `playNextChunk()` already had the text-only branch to consume it; the code simply disagreed with its own comment. Fixed in **both** callers (`proactiveSpeak` too — the boot greeting rides it), synthesizing only when `ttsUp`. AD-5 preserved: latency is still sampled only from a chunk that shipped real audio. **CORRECTION, same day:** the clipping diagnosis in (2) is WRONG and is retained above only so the error is traceable. `ls --time-style` prints LOCAL time (a literal `Z` in the format string was misread as UTC): edge_tts was installed **04:01 local**, the session ran **04:52-06:03 local**, so TTS was UP the whole time. And `detail.transport` in every episodic record shows **43 of 44 turns were `s2s`**, which plays PCM via `pcm-player.js` and never touches `speechSynthesis`. What IS true and fully evidenced: the boot greeting rides `proactiveSpeak` -> edge-tts -> `en-GB-RyanNeural` (male) while every turn after it rode S2S -> `Aoede` (female) — the real explanation of "British guy at the start, then the female voice", and the Ryan->Sonia fix still stands. **The clipping cause is OPEN.** On S2S only `live-interrupted` -> `player.flush()` stops audio; Gemini's server-side VAD emits it on music/room noise, matching the same session's "interrupted by user singing/feedback" incident. Unproven — see BUGS.md. The chunking fix remains a real bug fix, just not this bug's fix. **(3) It narrated playback from memory** — claimed "COME DOWN" was playing when it was not. Mechanically fine (`media_status`/`spotify_status` both declare `needs_result:true`, and P3-8 forces a re-derive for any tool that does); the gap was a missing grounding rule. There were rules for the outside world, artifact paths and dependent calls, but none for the state of the machine. New **DEVICE STATE RULE**, mirroring WEB GROUNDING, including "the tool wins over your earlier claim" because the observed failure was the entity *defending* the stale one. **(4) Deleting a goal did not delete it, and it came back.** Found while probing the T3 gate: `DELETE /api/goals/:id` returned 200 and audited `'ok'` while the goal stayed listed with `id: null`, unaddressable forever. `writeBack()` rebuilds Goals.md from its existing rows and so can never remove one; worse, `sync()` re-creates a user-service goal for every unmapped row at boot, so the deleted goal was **resurrected on restart**. `deleteGoal()` now captures the rows the id owns *before* dropping the mapping (afterwards they are unidentifiable — that is the bug) and removes them. **(5)** `truncateAtSentenceBoundary()` was dead code — defined, exported, called by nothing — while four paths hard-sliced spoken text mid-word; all four now use it. **NOT fixed, deliberately:** the third incident (playback interrupted by the operator singing / speaker feedback) is acoustic. The mic already requests `echoCancellation`/`noiseSuppression`/`autoGainControl`, and browser AEC cannot cancel Spotify because it is a separate process. That needs hardware testing with a human present. | `0cd4e4d`, `966545f`, `aa6a354` | **Real, from the operator's own session data** — `vault/Incidents` + 29 real replies in `vault/Episodic`, plus the `edge_tts` install timestamp that made the TTS-down diagnosis decisive rather than plausible. The new voice was verified to actually exist by synthesizing 17,856 bytes through the live sidecar with the configured id, not by trusting the string. Every fix red-first: the TTS-down test's red run reported exactly "got 0 chunks", and the goal test's reported exactly "the deleted goal was resurrected by sync()". **NOT verified, needs the operator:** that the new voice sounds right to them, and whether the end-clipping is actually gone in a real session — the mechanism is proven but only their ear closes it. |

| 2026-07-31 | **S2S turned ON and verified end to end against the real Gemini Live API — the first time this code has ever run outside a mock.** Staged cheapest-failure-first, and the staging paid for itself immediately. **Stage 0 (handshake only):** `scripts/verify-gemini-live.js` — which already existed and which I initially duplicated in a scratchpad probe before finding it — returns PASS on `models/gemini-3.1-flash-live-preview` with 41,282B of real audio, so neither the preview slug nor the key was the problem. **Stage 1 (full server path, NO microphone):** `server/index.js:1600` handles `{type:'live-text'}` → `liveSession.sendText()`, so a plain Node WS client can drive an entire Live turn headless. First attempt **failed instantly**: `close code=1007, function_declarations[5].parameters.properties[elementPath].items: missing field`. `live-tools.js parseParam()` emitted `{type:'array'}` with no `items`, Gemini requires it, and the API rejects the **whole setup frame** rather than the one bad declaration — so **every S2S session had always failed to open** with the default allowlist, and no unit test could see it because they asserted JS shape, never Schema validity. Fixed in the shared converter (`789a4eb`) with items hardcoded to string and the inference trap documented: elementPath's own prose reads "array of number strings", so `/array of (\w+)/` would type it as number and break the tool at call time instead of at setup. New `test/live-tools-gemini-schema.test.js`; its regression gate builds a REAL `createEffectorHub` + real `from-pc` registrations, because a fixture-only gate PASSED while production was broken (voice-agent's `CATALOG_RAW` fallback declares no array params — only the genuine registry reproduces it). **After the fix, measured, not estimated:** session open 799ms, text→first audio **668ms**, 54,722B of real PCM, AD-6 output transcription live. **Stage 2 (tool spine + security):** `list_windows` executed through the normal `leash.check()` → `dispatchAction()` path with **exactly one** audit line, and the model answered from the real result ("seven windows open, sir"). Then the T3 half, probed safely by creating a throwaway goal first so a gate failure would destroy nothing: `delete_goal` **raised a confirm instead of executing**, the entity said so out loud ("a Tier 3 action, so I'll need your final approval, sir"), and the target survived. **Stage 4:** electron installed at repo root and the shell BOOTS — window titled "MYTHOS", child server on 127.0.0.1:4478, HUD served, `app.js` 8,800B gzipped, `/api/config/s2s` → `{"enabled":true}`. Two install-time traps, neither a MYTHOS defect but both worth an hour to anyone who repeats this: electron's postinstall extraction failed **silently** (npm exit 0, `dist/` holding only `locales`, no `path.txt`, cached zip intact at 107.9MB — fixed by extracting the cached zip by hand and writing `path.txt`), and `ELECTRON_RUN_AS_NODE=1` inherited from a VS Code extension host makes `electron.exe` run as plain Node, so `require('electron')` returns the npm path shim and every destructured API is `undefined` (crash at `electron/main.js:167` on `ipcMain.handle`). **Also fixed, from the other machine's README redesign (`d6a20bc`):** it moved every effector-count slot (emoji in the heading, TOC bullet → nav pill, a new shields.io badge), unhooking three AD-10 patterns and leaving README disagreeing with itself — badge 143, nav 138, heading 143, real 138, and 1761 tests against a real 1867. `sync-test-count.js` patterns are now tolerant of decorative prefixes, and — root cause — **every occurrence is checked and rewritten, not just the first**; `content.match()` + non-global `replace()` had been validating one match and leaving the rest stale, which is why a badge could sit at 143 while the gate said OK (`be3891b`). | `789a4eb`, `be3891b` | **Real, against the live API and a real desktop app.** Every number above is measured. **Found and NOT fixed (deliberately out of the approved scope, needs its own red-first pass):** `deleteGoal()` in `src/core/effectors/goals.js` removes the per-goal JSON and the bridge mapping but `writeBack()` rewrites Goals.md **from the existing md rows**, so the row survives as an orphan with `id: null` — permanently unaddressable, while `DELETE /api/goals/:id` returns 200 and audits `'ok'`. Same report-success-for-work-that-did-not-happen class as the corrupt-JSON bug. Reproduced by hand; the orphan row this session created was removed by hand and the operator's three real goals verified intact. **NOT verified, needs the operator + a microphone:** speaking to it, barge-in, and the `Aoede` voice judged by ear. |

| 2026-07-31 | **Performance pass — operator report was "it feels slow"; advanced NO merged-order step.** Measured before changing anything, and the measurement moved the target twice. (a) **Static delivery had no compression and no caching at all** — every mount was `{ etag:false, maxAge:0, lastModified:false }`, so a browser re-fetched 13.5MB of `ort-wasm-simd-threaded.wasm`, 5.9MB of `ort.all.mjs`, 3.6MB of wake-word ONNX and 489KB of UI text raw on **every** load. Fixed with a precompress-and-cache `gzipTextAssets` middleware plus a mutability split: version-pinned bytes (`/vendor/*`, `ui/public/models`) get `Cache-Control: immutable`, app source gets `no-cache` + an ETag so an edit is never served stale. The FIRST attempt wrapped `res.write`/`res.end` around a zlib stream ahead of `express.static` and **hung every request** — static had already set `Content-Length` to the raw size, so the client waited forever for bytes the shorter body never sent; that is why the shipped version precompresses with an explicit `Content-Length`. (b) **The real felt cost was the boot overlay, not the network.** With (a) in place the whole critical path measures **17ms** over loopback (1 html + 15 css + 38 modules, 160KB gzipped, 5 waterfall levels), and `server/index.js:1119` already sends an `entity-state` snapshot the moment the WS connects — so on a refresh `init-screen.js` had nothing left to cover and still held the screen **~1.25s** (1.1s wordmark intro + 500ms hold + 700ms fade). Every duration in `init-screen.js` and its paired twin in `init.css` halved, JS ones promoted to named constants because the pairs must move together; refresh-to-interactive **~1.25s → ~0.62s**, hard LINK TIMEOUT ceiling 6s → 3s. (c) **edge-tts autostart never looked at a project-local venv** — it probed only `python`/`python3` on PATH, so an operator who installed edge-tts the way this repo requires got server TTS silently off *and* a hint telling them to install globally; now checks `mythos/.venv` and `<repo>/.venv` first (both `__dirname`-derived, AD-7-safe) and the hint teaches the venv install. edge-tts stays BYO. (d) **A failed TTS health check was cached as long as a healthy one** — the sidecar needs ~2.4s to bind, so the first post-boot check always fails and a 10s negative cache meant the entity answered its own boot greeting in the browser's voice, and (since `onToken` is gated on `isAvailable()`) sentence streaming was off for that window too. Failures now expire after 1.5s. **Explicitly NOT done, because measurement said not to:** `modulepreload` for the 38-module graph — all five waterfall levels cost 11ms over 6 sockets, so there is nothing to win; and gzip for the multi-MB binaries — immutable caching already makes those once-per-version, and a synchronous 13.5MB gzip would block the event loop for longer than it saves. Suite 1854 → **1862 tests, 1861 pass, 0 fail, 1 skip**; doc counts regenerated by `sync-test-count.js --write`, never hand-typed. | `39e4760`, `0ef57a7` | **Real, against a running server.** (a) `/js/app.js` 25,031B → 8,800B gzipped; `/vendor/onnxruntime/ort.all.mjs` 5,863,117B → 1,151,753B gzipped and `immutable`; unchanged asset revalidates to a clean **304 with a 0-byte body**; `/health` untouched by the middleware; path-escape attempts leak nothing (the 200 there is the SPA shell — an earlier assertion on *status* was a false alarm, it now asserts on returned bytes). Guarded by new `test/static-asset-perf.test.js` (8 tests); its own first revision wrapped `server.app` in a second `http.createServer` and closed only that one, so the socket `createServer` owns kept the event loop alive and `node --test` never exited — now uses `server.httpServer` + `server.stop()`. (c)/(d) detector picks the venv interpreter with **no warnings**, `isAvailable()` recovers **2,415ms** after spawn (the old cache would have blocked it ≥10s), and `synthesize()` costs **858/944/1082ms** for 10/85/66-char inputs — flat per call, not per character, which is the measured reason overlapping synthesis with generation is worth anything. **NOT verified, needs a human at the machine:** that the halved overlay still *looks* right, and any real voice-latency figure end-to-end through a browser mic. |

| 2026-08-03 | **Step 7 / Phase 8 — Electron shell, Slice 2 (globalShortcut).** Scoped the slice and found the press-to-talk half **already fully implemented and test-pinned** (`registerTalkHotkey()` in electron/main.js — Alt+Space + fallbacks, `MYTHOS_HOTKEY_TALK` override, guarded `child.send({channel:'mythos:toggle-voice'})`; server/index.js's fork-IPC handler dispatches `toggleVoice()`; preload `onHotkey` + app.js `toggleVoice()`; `electron-talk-hotkey.test.js` green). So the remaining work was the **Ctrl+Alt+X OCR grab**, shipped as: `registerOcrGrabHotkey()` in electron/main.js (fallbacks `Control+Alt+X`→`Control+Shift+X`→`Control+Alt+S`, `MYTHOS_HOTKEY_OCR` override/disable, `isRegistered()` confirmation logging, never steals focus, guarded `child.send({channel:'mythos:ocr-grab'})`) → server/index.js's existing fork-IPC `process.on('message')` handler dispatches the already-registered `screen_read_text` effector through shared `dispatchAction` with `channel:'hotkey'` (audit-honest, no new effector) → `broadcastAll({type:'ocr-result'})` → app.js captions the first line via `mic.setCaption` (PIN-gate respected, failure surfaces as an error caption) and best-effort `navigator.clipboard.writeText` (rejects unfocused by design — caption is the always-surface). **No preload-surface change — AD-8 intact**, `electron-preload-surface.test.js` untouched and green. New `test/electron-ocr-hotkey.test.js` (9 tests: source-shape for the Electron half per the talk-hotkey precedent, plus server/HUD wiring guards). Full suite **2425/2425/0 fail** (count grew from the documented 1735 baseline because another session's uncommitted tests are in the tree; `sync-test-count.js --write` run, README/ROADMAP synced). **Unit-tested only — the OS-global keypress + real OCR needs the operator at the desktop, so the slice is NOT live-ticked.** | this commit (pushed on `feat/sentient-hud`) | Unit-tested only — OS-global hotkey registration + real OCR need the operator at the desktop; live tick left for operator verification |
| 2026-08-04 | **Step 7 / Phase 8 — Slice 4 (electron-builder installer) + Slice 5 (cursor overlay), plus the §7.3 PIN gate and an AD-7 widening. Four commits, wave verified together at 2573/2572/0 fail/1 skip.** **Slice 4 (`98a66ad`)** — root `package.json` had the `dist` script and the devDep but no `build` block at all, so all of it is new; `npm run dist` now produces a real `dist/MYTHOS Setup 0.1.0.exe` (298MB, unsigned by design). **The finding to carry forward: electron-builder packages the WORKING DIRECTORY, not the git tree, so `.gitignore` is not a packaging boundary** — and since every model here is fetched per-machine and never committed, the first build shipped three weights git has never seen (`gesture_recognizer.task`, whose licence step 6.6 could NOT establish; `silero_vad.onnx`; and a Hugging Face `.cache` copy of Kokoro-82M inside `node_modules/kokoro-js`, which is invisible to any check looking at this repo's model dir or at git). Now excluded as a class. Verified by walking `dist/win-unpacked` rather than trusting globs: zero `.onnx`, zero `.task`, no `edge-tts-server.py`, no `.env`, no `vault/`, no `.cache/`. 10 tests through electron-builder's own `FileMatcher` with a positive control, and two build facts pinned against future "fixes" (`asar:false` is load-bearing because main.js:242 forks the child server with `cwd: MYTHOS_DIR`; `includeSubNodeModules:true` or AppFileWalker silently drops `mythos/node_modules`). **Slice 5 (`3050889`)** — frameless transparent always-on-top click-through overlay following `media-window.js`'s lifecycle, opt-in and fail-closed behind `MYTHOS_CURSOR_OVERLAY_ENABLED`; **AD-8 holds by construction, not restraint** — the window carries no `preload` key at all because its content is a static `data:` URL with nothing to bridge, and `electron/preload.js` has a zero-line diff. 16 tests. **PIN gate (`9f2a49e`)** — closes the bypass where `tokenOk()` returned true whenever `MYTHOS_AUTH_TOKEN` was unset; proven red-first (6 of 8 failing, `expected 401 with no session; got 200`), and closed BOTH the REST and WS-upgrade gates with one change by extending the existing `extractToken()` chain instead of adding a fourth mechanism. **AD-7 (`d5eb2ec`)** — widened from two user-profile shapes to any drive-rooted machine-specific path; 54 hits across 19 tracked files, now 0. A lookbehind requiring a standalone drive letter cleared 9 files without editing them: a PowerShell registry PSDrive prefix (the `HKCU`/`HKLM` shape) ends in a letter and is immediately followed by a colon and a separator, so the un-anchored pattern matched that trailing letter as though it were a drive — and regex literals ending in a letter before `:` did the same. **Note for whoever edits this row: spelling either shape out literally here trips the very check it describes** — this row already failed AD-7 once for exactly that reason, which is the second time this document has done so (see the AD-7 bullet in §18.3.6). | `d5eb2ec`, `9f2a49e`, `98a66ad`, `3050889` | **Slice 4 is the first step-7 slice verified beyond unit-green** — a real installer artifact was built and walked. Everything else here is unit/integration-green only. **Still NOT live-verified and needing the operator at a desktop:** installing the `.exe` on a clean path and booting it; Slices 1-3 and 5's real OS behaviour (click-through routing, `showInactive()` vs Windows' foreground-lock, hotkey collisions). **Also open, flagged, deliberately not decided:** `gesture_recognizer.task`'s model licence (chased to primary sources — Google's page licenses page content CC BY 4.0 and code samples Apache-2.0, neither covers the `.task` bundle, and the linked model card asset 404s), the 1.2GB unpacked size, `kokoro-js` voice `.bin` files still shipping, `appId` baking in an undecided product name, no icon asset, and whether `PIN_SESSION_ENFORCE` should default ON in packaged builds. |
| 2026-08-04 | **Slice 5 was boot-fatal; fixed and live-verified. The first genuine live verification of the Electron shell in this build, and it immediately paid for itself.** The operator ran Track C and MYTHOS would not launch: `Error: The 'screen' module can't be used before the app 'ready' event`. **Root cause was two mistakes compounding, and the second is the interesting one.** (1) `main.js` destructured `screen` from `require('electron')` at module scope and constructed the overlay controller there — departing from a pattern this same file already had, since Slice 3 requires `desktopCapturer` and `session` lazily inside their handlers. (2) `cursor-overlay-window.js`'s constructor validated with `typeof screenModule.getCursorScreenPoint !== 'function'`, and **that property read is what fired Electron's lazy `createScreenIfNeeded` — the defensive guard was the crash.** The code comment beside it reasoned correctly that `getCursorScreenPoint()` is only *called* inside `show()`, then never accounted for its own type-check. **And the opt-in flag protected nobody:** `CURSOR_OVERLAY_ENABLED` (default off) was parsed *below* the unconditional construction, so every user's app died regardless of the setting. **Why 16 passing tests missed it, which is the transferable lesson:** the controller's tests inject a fake `screenModule`, so they are structurally blind to main-process load order; the test asserting "no window is created until show()" proved laziness on the *window* axis while the bug was on the *module-access* axis; and the test asserting the constructor throws on a bad `screenModule` **actively mandated the eager read** — fixing the crash required changing an existing assertion, so this was never a mere coverage gap. **Fix:** `let cursorOverlayController = null` at module scope, constructed inside `app.whenReady()` **and only when the flag is on** (so a disabled feature builds nothing at all), with `screen` required lazily at that site; the shape check moved from the constructor to `show()`; both consumers null-guarded. **Tests:** the mandating assertion was replaced with a throwing-getter probe that reproduces the real crash in a plain unit test with no Electron — it fails with the operator's exact error text before the fix — plus a source-shape guard pinning that `screen` is never destructured at module scope and that construction sits inside `whenReady` behind the flag. A module-scope scan confirmed **zero** other ready-gated Electron APIs used too early. 17 overlay tests, 41 across all four Electron files, `electron/preload.js` zero-diff so AD-8 holds. | (this commit) | **LIVE-VERIFIED, twice, and this is the first slice in step 7 proven by actually running the app.** Booted with the overlay OFF (default): shell starts, HUD serves, and it logs `cursor-overlay hotkey disabled (MYTHOS_CURSOR_OVERLAY_ENABLED is not "true")`. Booted with it ON: `cursor-overlay hotkey registered: Control+Alt+C` — meaning the controller was constructed against the REAL Electron `screen` module after ready, which is precisely what used to crash. Still needing the operator: the overlay's actual on-screen rendering and click-through input routing, and the rest of the Track C sitting (press-to-talk from another app, Ctrl+Alt+X OCR, screen-share end-to-end, persona by ear, real p50). |
| 2026-08-04 | **Second wave the same day — step 7 reaches CODE-COMPLETE at all 6 slices, the Anti-Drift Contract reaches 10/10, and Hermes cross-provider failover works for the first time. Five commits, verified together at 2598/2597/0 fail/1 skip.** **Slice 6 (`c654e5c`)** — `SECURITY.md`, `CONTRIBUTING.md`, issue templates, `CODEOWNERS`, `dependabot.yml` (two npm entries, since there are two `package.json` files), plus spine §13's directory-scoped `CLAUDE.md` split into `mythos/adapters/`, `mythos/ui/` and `mythos/src/core/`. Rules were **moved, not duplicated** — duplicated instructions drift apart and then contradict, which is worse than one long file; root keeps only what is genuinely global plus a pointer section, and all five pc-child gotchas were verified to survive the move. **Anti-drift 10/10 (`cfcbd2d`)** — AD-9's shared ENOENT harness (`test/helpers/mock-spawn-enoent.js`) plus AD-6's missing episodic-write half and AD-8's missing response-leak scan. Each was red-first, and two corrected something beyond themselves: **AD-6 proved the spine named the wrong module** (`live-session.js` never touches memory; the write is in `live-tool-adapter.js`), and **AD-9 established `browser-agent` cannot be ENOENT'd at the `child_process` layer at all** (playwright preflight-checks with `existsSync`, and boot dials CDP rather than spawning) — reported, not fudged. AD-9's red-first proof is only valid *because* cua-driver is genuinely installed here: it asserted ONLINE under forced ENOENT and failed, where a no-op harness would have passed by observing reality. AD-8's probe injected a real secret into `/health` and was verified removed afterwards — a forgotten probe would itself have been the vulnerability. **Reminders (`a5d8d73`)** — `reminder_add` gains an optional `action:{tool,args}` dispatched at fire time through the normal `leash.check()` → `dispatchAction()` path, so AD-1/AD-2 hold by construction; the T3 grant enumerates **one tool, never the tier**, respecting the shape of the CRITICAL bypass fixed earlier, with five tests proving approving one tool grants no sibling. Effectors 151→152. **Hermes (`84b818a`)** — each attempt now gets its own throwaway `HERMES_HOME` with a `config.yaml` naming that attempt's provider, so concurrency safety is structural rather than a lock. **Measured: a bad Mistral key rotated to a valid Cerebras key that authenticated against `api.cerebras.ai` and returned "PONG"** — the exact thing that was impossible under the env-only design — and an 8-call run completed **8/8** with rotation firing at calls 3, 5 and 7, against a reproduced single-provider baseline that still 429s at call 3. 12 real provider calls. **wakeword (`13c9bb8`)** — the destructive EPERM race is gone at the root: `routes/config.js` takes an injectable models path, so the test uses a temp dir instead of renaming the operator's real CC BY-NC-SA weights aside. | `13c9bb8`, `c654e5c`, `cfcbd2d`, `a5d8d73`, `84b818a` | **Mixed, and the split matters.** Genuinely live-verified: Hermes cross-provider auth and endurance (real provider calls against real endpoints), and the wakeword models confirmed intact after the refactor. Unit/integration-green only: Slice 6 (docs), the three invariant tests, and the reminder fire-action path — note in particular that **no real WhatsApp message was sent**, so `whatsapp_send`'s own real-world send behaviour is unchanged and unverified by this work. **All six remaining unchecked items in this document now require the operator or physical hardware** — there is no delegable work left in it. |
| 2026-08-03 | **BACKFILLED 2026-08-04 — landed beside the merged order and had no Progress-log row, so it was invisible here.** `bf95f35` **the missing half of the learning loop: a durable Lessons store.** `reflection.js:215` already emitted `recurring-failure`, but nothing remembered it, so MYTHOS kept retrying the same known-bad approach. New `memory/lessons.js` persists `vault/Lessons/*.md` with an id/ts/count/lastSeen/trigger/sources sidecar; dedup is by `triggerKey` (`tool\|argsHash\|goalTitle`) so a repeated failure increments `count` instead of spawning files (`recordFailure`/`recall`/`prune`/`consolidate`/`toOkfConcepts`, the last round-tripping through OKF). Three writers: `reflectOnActions` now writes lessons directly so headless runs no longer depend on the voice-turn path; `log_incident` feeds them so an operator report grounds the planner too; and `distillFailureIntoLesson` (`goals/index.js`) — the symmetric counterpart to `distillIntoSkill` — asks the brain to distill ONE actionable lesson from a failure trace at `failCount>=2`. One reader, at `goals/index.js` Layer 3: recall lessons **before** spending a brain call; if a single lesson's count crossed `GOAL_FAIL_PAUSE_THRESHOLD`, pause the goal with `reason:'repeated-failure'` (symmetric to budget-exhausted) rather than re-planning forever, otherwise inject a grounded "this failed before" block so the brain picks a different tool/args/approach. | `bf95f35` | Not separately live-verified; landed with the suite green. The behaviour that matters (a paused goal instead of an infinite re-plan) is worth watching in real autonomous use. |
| 2026-08-03 | **BACKFILLED 2026-08-04 — same reason: no Progress-log row existed.** `73818e2` **`tam-bridge`, a stdio↔HTTP shim for TencentDB Agent Memory.** MYTHOS's MCP client speaks JSON-RPC over stdio (it spawns a server as a child); TAM exposes MCP over HTTP instead (`POST /v3/tools/list`, `/v3/tools/call`, default `:8424`). New `adapters/mcp-client/tam-bridge.js` is the child MYTHOS can spawn, speaking the stdio JSON-RPC it expects and forwarding each call over HTTP. **Deliberately bridges only Wiki + Code-Graph** — the 12 read-only tools (`wiki_search/read/list/graph`, `code_search/explore/callers/callees/impact/node/status/files`). TAM's Chat Memory and Skill are separate REST routes, not MCP tools, and are **not** bridged because MYTHOS's own episodic/semantic/skills stores are richer and feed the learning loop natively; this takes only the genuinely-better-than-local part, real symbol/call-graph/impact analysis that `from-code-search.js` does not do. Auth is per-call via `X-Tdai-Service-Id`/`X-Tdai-User-Key` read from env (`TAM_SERVICE_ID`, `TAM_USER_KEY`) so credentials never appear in `MCP_SERVERS` config. **Fail-closed:** with TAM down, `initialize` still succeeds and `tools/list` returns an empty list, so MYTHOS boots and honestly offers no hub tools. Orphan by design — no JS module imports it; MYTHOS spawns it from config when enabled (commented `MCP_SERVERS` example in `.env.example`). | `73818e2` | Not live-verified against a running TAM instance — no TAM service is configured on this machine. The fail-closed path (TAM absent → empty tool list, boot succeeds) is the half that is exercised here by construction. |
| 2026-08-04 | **Step 7 / Phase 8 — Electron shell, Slice 3 (desktopCapturer).** Implements spine §13's "`desktopCapturer` — Live accepts video… the one IRIS capability that genuinely needs Electron." Four seams, no new transport and no new dependency: (1) `live-session.js` gains `sendVideoFrame(base64Jpeg)` → `realtimeInput:{video:{mimeType:'image/jpeg',data}}`, §3-legal (exactly one top-level key) and returned on the session object; (2) `server/index.js` gains a `live-video` WS branch guarded exactly like `live-audio`, so a frame racing `live-open`/close is a no-op not a throw; (3) `electron/main.js` registers `session.setDisplayMediaRequestHandler` resolving the primary screen via `desktopCapturer.getSources({types:['screen']})`, plus `'display-capture'` on the permission-check handler — without it Electron denies `getDisplayMedia()` silently, the same shape as the Slice 1 mic denial; (4) new `ui/public/js/voice/screen-share.js` captures via `getDisplayMedia()` → detached `<video>` → canvas → JPEG → `{type:'live-video'}`, lazily imported by `s2s-bridge.js` so an opt-out install never fetches it. **AD-8 intact and this drove the design:** granting the request in the main process means the renderer calls `getDisplayMedia()` natively, so `electron/preload.js` is UNCHANGED — the contextBridge surface stays exactly `{getKeyNames,setKey,hasKey}` and the new test pins that no `getDisplayMedia`/`desktopCapturer`/`getSources` channel appeared. A preload-mediated capture would have worked and widened that surface for nothing. **Three deliberate non-obvious calls, each test-pinned:** (a) `sendVideoFrame` does NOT call `armIdle()` unlike `sendAudio` — the idle timer is what stops an unattended room holding a Live session open on the operator's BYO quota, and a desktop streams frames just as happily to an empty room, so speech extends a session and wallpaper does not; (b) `audio:false` on the capture — loopback audio would feed MYTHOS's own TTS back as operator speech, the exact self-answering failure `s2s-bridge.js`'s capture-suspend logic exists to prevent; (c) capture is torn down FIRST in `stop()`, because a capture outliving its session both keeps the OS screen-share indicator lit (the UI lying to the user) and pushes billed frames into a closed socket. Frames are downscaled to a 1280px long edge and default to 0.5 fps / 0.6 quality — every frame is a billed image input, so the defaults are cost floors, not compromises. **Opt-in and fail-closed:** `LIVE_SCREEN_SHARE_ENABLED` defaults false, reaching the HUD via `/api/config/s2s` (the same route whose absence once left `s2s-bridge.js` unreachable); a failed or missing fetch leaves capture off, since the failure mode is streaming a desktop unasked. `screen-sensor.js` is NOT replaced — it polls, hashes and spends a vision-lane call to describe a screen into prose for the cortex, which is the right shape for ambient awareness and the wrong shape for a live turn; both run and answer different questions. **Four existing `/api/config/s2s` tests were rewritten, not deleted** — they asserted `deepEqual(body,{enabled})`, the whole body exactly, which over-constrained the route's actual guarantee; the two things that file guards (a real boolean, never a secret) are both kept, and the exact-key-set assertion is still exact against the new two-key shape so the next field added has to justify itself there too. New `test/electron-screen-share.test.js` (13 tests, red-first: wire shape via live-session's own `createSocket` injection seam, the idle-arm guard, the server branch, the Electron handler's explicit-deny paths, the AD-8 surface, config fail-closed, `.env.example` coverage, capture lifecycle). Suite 2525→2539, 0 fail. **Slice 3 of 6** (remaining: electron-builder installer w/ Decision-1 no-edge-tts-bundle constraint, cursor overlay, OSS hygiene). | this commit | **Unit-tested only, NOT live-verified — and the gap is wider than Slice 2's.** No agent shell can grant a real `getDisplayMedia()`, read real pixels off a real display, or confirm Gemini answers from the frames; all three need the operator at an Electron desktop with `LIVE_SCREEN_SHARE_ENABLED=true` and a mic. What IS proven: the wire frame is §3-legal against a real session object, the AD-8 surface did not grow, and the full suite is green. **Also NOT done: no security-reviewer was dispatched**, which breaks the precedent Slices 1 and 2 set for a privacy-sensitive surface (this one streams the desktop to a third party) — the session was instructed not to spawn agents. Worth running before this ships. |
| 2026-08-05 | **No merged-order step advanced. Two voice-session incident batches, the first security review of the screen-share surface (which found two CRITICALs), the installer icon, and one scope correction. Suite 2664→2777, 0 fail throughout.** **(1) The morning batch was never committed.** BUGS.md claimed BUG-099..BUG-105 were fixed while all 25 files, `ps-automation.ps1` among them, sat uncommitted in the working tree — precisely the BUG-037 shape where another machine's clean `git pull --ff-only` silently reverts live-verified work. Committed as `daeee69` first. **(2) A false test failure was silently blocking EVERY commit**, and it is the reusable lesson: `test/electron-builder-files-allowlist.test.js` hard-asserted that kokoro-js's Hugging Face cache weight exists under `node_modules`. That file downloads on first TTS use, so any checkout that had never spoken failed a *packaging* test for environmental reasons — the same class as the wakeword rename race, a test depending on machine-local gitignored data. Now materializes a stand-in only when the real file is absent and removes exactly what it created; deliberately NOT generalised to the wakeword/silero fixtures, because faking those is how the ONNX weights got destroyed before. **(3) BUG-106..BUG-116, eleven root-caused defects, all red→green** (`ed919e7`..`de2013d`): stale browser identity driving Chrome while calling it Brave, a wrong-browser refusal that was a dead end, whole-screen OCR reading MYTHOS's own window instead of the page, a string `window_id`, `get_directions` unreachable from voice, 14 Gmail polls no stored preference could stop, four greetings in three minutes including "Good morning" at 5:08 PM, dropped spoken commitments, YouTube error 153, an ad blocker that could never work (a throwaway debug profile has no extensions), and the systemic honesty defect of narrating a click as successful in the same second the tool failed. Two of those closed a CLASS rather than an instance, which is the pattern worth repeating: `get_directions` shipped with a reachability gate asserting every T0/T1 read-only effector is either allowlisted or on a commented exclusion list, and the browser fix clears `attachedBrowser` on any non-ONLINE state so the stale window is impossible rather than merely narrow. **(4) BUG-107 was only half fixed, caught by review after it was called done** (`572a157`) — the remedy landed in `checkBrowserTarget()` but `browser_launch_debug`'s own already-ONLINE mismatch branch still said "close it first", and that is the branch a model asked to switch browsers reaches FIRST. Lesson recorded in BUGS.md: a "name the remedy in the refusal" fix must cover every site that refuses, not the one the incident came through. **(5) SECURITY — the Slice 3 screen-share surface got its first review, and it should have had one before it shipped.** Two CRITICALs, both confirmed by reading the code rather than inferred, both now fixed with tests: **C1** — `setDisplayMediaRequestHandler` never inspected `request`, so it granted the primary screen to ANY webContents on the shared default session, and `electron/media-window.js` is a second window on that same session which loads a URL supplied by the `open_web` tool. A prompt-injected or mistyped URL could therefore run attacker JS that calls `getDisplayMedia()` and receives the whole desktop with no prompt and no picker, exfiltrating it over its own `fetch()` without touching MYTHOS's socket or Gemini at all — so `LIVE_SCREEN_SHARE_ENABLED` never gated that path. Every capture grant (mic included — the same blanket-by-permission-name bug applied to `getUserMedia`) is now scoped to the HUD's own webContents, and it fails closed when the requester cannot be identified. Deliberately NOT fixed by giving the media window its own partition, because the ad/tracker blocking is registered on the default session and isolating that window would silently disable ad blocking on the one surface that shows ads — a test records that tradeoff so nobody "hardens" it into BUG-115 again. **C2** — the `live-video` branch forwarded frames to Gemini with no server-side flag check; enforcement lived ONLY in renderer JS, so `main.js`'s own comment claiming the flag "gates it server-side" was false, and on stock defaults (no `MYTHOS_AUTH_TOKEN`, `PIN_SESSION_ENFORCE` false, `VOICE_S2S_ENABLED` true) any local non-browser process could open the loopback socket with no `Origin` header and bill arbitrary images to the operator's own key. The gate now lives in `live-session.js`'s `sendVideoFrame` — the choke point every caller must pass — plus the server branch, and fails closed on an absent flag. The same review's HIGH is fixed alongside: nothing bounded a frame below the WebSocket library's 100MB default, so there is now a per-frame ceiling (`LIVE_SCREEN_MAX_FRAME_KB`, 2MB) and a server-side rate limit derived from `LIVE_SCREEN_FPS`, with refused frames deliberately not consuming the rate budget so a malformed burst cannot lock out the operator's next real frame. Reported clean on the axes that were clean: no frame content is logged or persisted anywhere, nothing beyond pixels reaches Gemini, the WS's cross-origin rejection does stop ordinary web pages, and AD-8 still holds. **(6) The installer icon** — see the Slice-4 open-items list, item 5, now closed. **(7) Scope correction on BUG-116:** `5b8afc9` touches `live-tool-adapter.js` alone, so that fix is Live-path only; `voice-agent.js` still composes its sentence before the actions run, mitigated since 2026-07-31 by a corrective re-derivation pass and a deterministic truthful prefix — but the prefix fires only when the ENTIRE turn failed, so a partial-success turn still rests on the model admitting the failed half. Documented at `voice-agent.js:829-831` as deliberate; not a regression, and still open. | `daeee69`, `ed919e7`, `a022c55`, `df84c7d`, `bc4936e`, `a05b1ae`, `1e00889`, `5b8afc9`, `19f81d9`, `178bf16`, `f3b807a`, `572a157`, `de2013d` + this commit | **No, and the distinction matters more than usual here.** The eleven bug fixes are unit-verified only and need an operator voice session; the app was running throughout, so none of them is in the live process yet. The 9-item live gate is in BUGS.md's new afternoon section. The security fixes are unit-verified and source-pinned; the C1 handler cannot execute outside a real Electron app, so **the operator's Electron sitting is now also the live test for the capture scoping** — screen share must still work from the HUD, and must be refused in a media window. Suite numbers were reproduced independently from a cold `git status` rather than trusted from the orchestrating agent's report, which mattered: that agent reported seven sub-agents as having delivered work that was not on disk at the time, and its own central wiring pass shipped a boot-fatal `serverHandle is not defined` caught by `boot.test.js` on the next full run. **Two orchestration lessons worth carrying:** a background agent's completion notification can fire while its own children are still running, so `git status` is the only proof work happened; and `sync-test-count.js --write` chained with a commit in one shell call exceeds the 10-minute tool ceiling, after which the commit silently never lands while the index still looks staged. |
| 2026-08-08 (evening) | **No merged-order step advanced. Two release-layer items closed instead: H11 (asar) and the buildable half of B6 (signing + auto-update), both live-verified against a real packaged app rather than left unit-green.** The work was already partly in the working tree when this session picked it up — `asar:true` + `asarUnpack: ["mythos/**/*"]`, `toRealPathIfPackaged()` in `electron/main.js`, `electron-updater` wired behind `MYTHOS_UPDATE_URL`, `forceCodeSigning:false`, `publish:null`, and a CONTRIBUTING section — and finishing it meant building and RUNNING it, which is where the two real findings came from. **(1) The packaged app did not boot, and every test said it would.** `dist/win-unpacked/MYTHOS.exe` exited 1 instantly with a completely empty stderr while dev `npm start` booted fine — the classic "green suite cannot tell you the Electron app starts". Cause: `const { autoUpdater } = require('electron-updater')` at module scope. That export is a **getter** that constructs the platform updater on first property read, so the destructure ran it before `app.whenReady()` — the Slice-5 `screen` lesson repeating, this time inside a dependency rather than our own code. Requiring it lazily inside `checkForUpdates()` fixed boot; the two builds differed in nothing else, so this is measured, not inferred. Pinned by a source-shape test that itself is proven against a known-bad fixture, so the checker cannot silently stop checking. **(2) "Just set `MYTHOS_UPDATE_URL`" was an overclaim** in both the code comment and CONTRIBUTING: true for the client (the URL is read at runtime and `setFeedURL` bypasses the absent `app-update.yml`), false for the release, because electron-builder writes the `latest.yml` a generic feed is polled FOR only when a publish config exists. CONTRIBUTING now carries the real release recipe, including that automatic download must stay off until the build is signed — an unsigned build gives electron-updater's Windows publisher check nothing to verify against. **H11 evidence:** the packaged app boots, forks the server out of `app.asar.unpacked/mythos`, completes all 24 boot steps, creates its vault under `userData`, and `pc-child` (PowerShell, spawned from the unpacked tree) answers `media_status` in 150-700ms. **(3) A test-environment trap worth more than the feature**, now in root CLAUDE.md: an agent shell exports `TEMP` in Windows' 8.3 short form (the profile folder written as `<NAME>~1`), so `fs.mkdtempSync(os.tmpdir())` hands a spawned server a short-name vault path and the watcher aborts it in libuv (`fs-event.c` line 72 assertion, exit `0xC0000409`). The test reports only `ECONNREFUSED` after its 30s timeout because the child's stderr is captured and never printed — it reads exactly like a regression you just caused. Re-running with the long-form `TEMP` turned `deploy-config-conformance.test.js` green with no code change. Suite 3255→**3283, 3283 pass, 0 fail, 0 skip** (the 1 skip also disappears once `TEMP` is long — same libuv fault). **Still not done, unchanged and still the operator's:** a purchased code-signing certificate and an update host; and the NSIS installer itself has been built but never run, which is a different test from `win-unpacked`. | this commit | **Yes for H11 and the update-check wiring** — real `npm run dist`, real packaged launch, real child server and pc-child traffic, and the honest-inert log line observed in both dev and packaged runs. **No for signing and for updates end-to-end** — nothing was signed (no cert) and no feed was ever polled (no host), so those remain shape-verified only. |
| 2026-08-15 | **No merged-order step advanced — a cross-cutting model-routing rewire plus one long-standing silent defect.** **(1) Every MYTHOS role re-pointed at the model measured best for that job.** Almost every "thinking" role ran on `llama-3.1-8b-instant` because `PREF_SIMPLE` was ranked on latency ("224ms — fastest measured anywhere"), including cortex's `mull()`, whose entire job is noticing loose ends and which nothing waits on — the latency bought nothing and cost the reasoning. Two new lanes: `reasoning` (Cerebras `gpt-oss-120b` first; serves `mull`, both reflections, the reviewer and reality-checker seats, design verify, orchestrator synthesize, `ask_agent`, engagement interviews) and `memory` (Google `gemini-3-flash-preview`; consolidation ×3 + document answering). Vision and voice re-ranked; the 404 OpenRouter slug and a 27.9s NIM model deleted. **Load is treated as a first-class ranking reason, not a tiebreak:** Google's quota is per MODEL, so vision, memory and voice sit on three DIFFERENT Google models for three independent buckets, and vision leads on Google rather than Mistral specifically to keep Mistral's 4 req/min free for Hermes builds and embeddings. That reasoning is written into `lanes.default.js` because it is invisible from the ranking alone and a later session would otherwise "fix" it back on a quality argument. **(2) `think_deeply`** (new tool, T0, in the Live allowlist, `effectors/deep-think.js`) — the only change here that can affect conversational quality, because `live-session.js`/`live-tool-adapter.js` make ZERO `brain.think` calls and the Live model is capped at Flash tier on a free key. Bounds and instrumentation copied from `vision-call.js` rather than re-derived. **(3) Three silent breakages the lane split would otherwise have caused, all found by walking the full `think()` argument list rather than only the lane name** — persona injection was scoped to `voice/build/simple`, so moving the persona-passing seats would have dropped the argument with no error; `BRAIN_TERSE_LANES` defaulted to `simple`, so the callers moving off it would have silently lost compression; and `chainFor()` substituted the caller-less `text` lane for any unknown lane name, so a typo produced no error at all. Each is fixed and pinned; the last now emits `health.anomaly` plus stderr, and a test resolves every literal `lane:` string in `src/` (the one dynamic site is whitelisted BY NAME with both branches asserted, rather than claiming coverage it lacks). **(4) The specialised agent seats were never specialised.** `personas.js` searched only `mythos/vault/Personas/` — gitignored and absent — so `loadPersona()` returned `null` for every role on every machine and each seat silently ran as generic MYTHOS. Ordered resolution now ends in a tracked `mythos/personas/` with four authored defaults; the test derives required roles from the source, and was proven non-vacuous by deleting `reviewer.md` and watching it fail. **(5) A clean re-probe** of the two Google models that scored low on 2026-08-14 confirmed both were throttling artefacts (`gemini-3.7-flash` 1/4→4/4, `gemini-3.6-flash` 3/4→4/4). That re-probe's own first pass scored every model 3/4 on one probe because the expected answer had been carried over from a different phrasing — recorded in the doc, because a benchmark disagreeing with a previous run on EVERY model at once is a broken probe, not simultaneous regressions. Suite 4551→**4592, 0 fail, 0 skip**. | `08b0e3e`, `34fbf90` | **No — and the honest gap is narrow but real.** Everything here is unit-green and source-pinned; a green suite cannot show which model actually answered. Needs one operator voice session, then `%APPDATA%\MYTHOS\vault`: `brain-spend` showing the new distribution, `vision.attempt` showing Google first at ~1.5s with `attemptsTried: 1` (3 today), and a hard question actually reaching `think_deeply`. Watch for Cerebras 429s — 5 req/min is the tightest budget in the new layout and seven low-frequency roles now share it. The Google re-probe IS live-verified (real API calls against the operator's key). |
| 2026-08-15 | **No merged-order step advanced — a full-history log audit, and the two structural findings it produced.** Not a bug wave: three read-only analysts were run over the operator's live vault (88 lesson files, 26 episodic days, the 30-incident ledger, the session server log) and this repo, to find the PATTERN rather than the next defect. Two findings were structural and are fixed here. **(1) BUG-251 — the Live voice path had no memory of the operator.** `buildLiveSystemInstruction()` composed rules + persona + version + capabilities + skills + time and no memory of any kind; everything durable the vault held (`Semantic/user-facts.md` — including seven lines of music taste) was reachable only from `handleUtterance()`'s `recallHybrid()`, i.e. the TYPED path. So "you never remember my songs" was true of the surface while the facts sat on disk, and the operator's earlier "two brains" complaint was the same mechanism a week apart. New `semantic.topic()` direct read (synchronous — this composer runs inside `buildSetup()` and cannot await, and an embeddings round-trip on every session open/rotation is not a thing to add), injected as an `OPERATOR FACTS` block labelled as-of-session-start per BUG-136, capped at 4000 chars keeping the TAIL because the store is append-only and newest-last. `LIVE_MEMORY_INJECT=false` is an exact zero-code rollback. Note this is the READ half of the same day's BUG-249, which fixed the WRITE half — the two were independently broken, which is why neither alone would have changed what the operator experienced. **(2) BUG-252/253 — the incident ledger and BUGS.md had no mechanical relationship.** Of 30 incidents recorded since 2026-08-07, **2** were cited by id in BUGS.md; six copies of one voice-node-duplicate loop, whatsapp typing into the wrong window, both camera misidentifications and the HUD colour report had no entry at all. Nothing hid them — there was no way to ask the question, so it was never asked, which is `memory/lessons.js`'s own documented trap ("wrote Incidents/ that nothing read back") re-emerged one layer up. New `scripts/triage-incidents.js` is a reporter, not a filer (auto-filing would produce 30 entries and a triage problem one layer up, which IS the bug); tracked is decided by id citation only, never text similarity, because a false "tracked" hides work while a false "untracked" costs one look. BUG-253 then triages all 28 in one table: 9 already closed elsewhere, 3 by-design, 1 informational, and **the open remainder named** — the six-report voice-node loop, whatsapp window targeting, `open_web` opening a widget where a browser was expected, `open_folder` reporting unverified when it worked. Ledger now reads 30 recorded / 30 cited / 0 untracked. **Deliberately NOT built:** the general chronic-signature counter (BUG-238's `terminal:true` already covers the sharpest instance; the threshold that makes it a useful notice rather than a second noise stream needs live evidence, and guessing it ships the noise). Suite 4674→**4687, 0 fail, 0 skip**. | (this commit) | **Partly.** `triage-incidents.js` is live-verified against the operator's real vault (30 recorded / 2 cited / 28 untracked before the entries, 30/30/0 after — a real run, not a fixture). BUG-251 is unit-green plus a real setup-frame assertion driven through the server's live-open path with a fake Gemini socket; what it cannot show is the model USING the facts, which needs one voice session — ask for something only `user-facts.md` knows and confirm no tool was called. |
| 2026-08-15 (late) | **No merged-order step advanced — a live-session performance investigation, and the silent defect it turned up on the way.** The operator reported the spoken path felt slower and sometimes did not reply at all. Measured from the real session log rather than theorised. **(1) BUG-254, and it is the one that matters: the operator's authored persona had NEVER reached the model, on this machine or any other with a Windows-edited `self.md`.** `extractSection()` required a literal `\n` after each `## header`; the operator's `self.md` is CRLF, so `Purpose`/`Persona`/`Values`/`Origin` all returned `null` and `persona()` composed "You are MYTHOS. Helpfulness, honesty, efficiency." while a full JARVIS brief sat on disk. Nothing surfaced it because a parse miss and an unwritten section both return `null` and both get a plausible default — the same shape as the gitignored-personas miss. `topLearnedPrefs()` had the identical bug and LOOKED healthy only because `learn()` prepends a second, LF-written copy of that header further down the file. Verified against the real vault: four sections, all `null` before, all real content after. **(2) BUG-255 — `think_deeply` was 10 of ~34 tool calls in one conversation.** The tool is innocent on timings (471-1081ms, 10/10 ok, no 429s); the cost is that **every tool call is two inference passes**, so turn 32 spent 19 of its 20 seconds AFTER the tool had answered, and tripped the 10s `live.turn-stalled` detector — which is precisely the "doesn't reply" the operator heard. Its description named the failure modes but framed calling as normal ("planning an approach, checking whether an argument holds" covers most of a conversation). Rewritten so the default is answering, the cost is stated in weighable terms, and the trigger is an applicable self-check (would you otherwise guess?). **(3) BUG-256** — the facts cap kept 26 of the operator's 37 durable facts; raised 4000→8000, because a fact the model cannot see is a `recall_memory` round-trip, and the frame is composed once per session while the round-trip is paid per turn. **(4) BUG-257** — 151 anonymous `sensors.aether.socket_error` lines in 12 minutes; the handler now logs `url` and `code`, and the operator's local `.env` turns the sensor off since the BLE bridge is not running. Explicitly NOT claimed as the latency cause — it is fixed so it stops burying the next investigation. Suite 4687→**4700, 0 fail, 0 skip**. | (this commit) | **Partly, and the split matters.** BUG-254 is verified against the operator's REAL `self.md` (all four sections null before, real content after) — the strongest evidence in this row. BUG-257's diagnosis is from the real session log. BUG-255 and BUG-256 are unit-green and reasoned from measured call counts, but their effect is behavioural: only the NEXT session's `live.tool-call-batch` count answers whether the restraint wording works, and whether it swung too far. That is the single live check outstanding. |
| 2026-08-16 | **No merged-order step advanced (6.5 ☐ · 6.6 ☐ · 7 ☐ unchanged) — a full gap-analysis pass over plans vs code vs repo state, and the CI-red it surfaced.** **(1) BUG-258: the `ci` workflow's test job had been failing on EVERY push since 2026-08-13** (runs 164-173; e2e green throughout) while the operator's local pre-commit hook ran green — `test/immune.test.js`'s build-engine-reprobe test did a "genuine live re-probe" against whatever `hermes` resolution the surrounding machine offered (PATH / exported `HERMES_CLI` / running gateway), true on the operator's shell, `spawn hermes ENOENT` on CI and any fresh clone. Tests do not load `mythos/.env`; only `src/main.js` does. Fixed by pinning `HERMES_CLI` to `process.execPath` for the test (real adapter probe, real child spawn, exit-code→ONLINE — only the target binary is made portable; save/restore per the `hermes-adapter.test.js` convention). Nobody noticed the red badge; `gh` is not even installed locally. **(2) Hygiene:** `.freebuff/` (23MB third-party tool state incl. a personal-data SQLite DB and a full nested repo copy) and `mythos/.graph-data.json` (regenerable graphify output) gitignored; `mythos/Plans/ADOPTION-MATRIX.md` (6 days untracked) and `MYTHOS-EXPLAINER.html` adopted into git; 0-byte stray `MYTHOS-Post-Parity-Plan` (no extension) deleted. **(3) Doc-truth:** MYTHOS-ARCHITECTURE.md's four phantom paths (`brain/interpret.js`, `effectors/index.js`, `memory/store.js`, `mythos/server.js`) corrected and its `F:/Projects` example genericised (the last AD-7 portability violation, doc-side); stale tool-count comments unpinned ("45"/"107"/"171" — real figure via `sync-test-count.js`, measured 146); seam count corrected 23→21 in BOTH plan documents with a dated note at spine §4 (the table never had 23 rows); ROADMAP **D-05 ticked** (B3 evidence re-verified against `schema.js:9-22` before ticking; MAJOR backlog 10→9); spine §18.4's superseded "blocks 7"/Piper-swap wording annotated in place (frozen table kept, supersession note added); `mythos/docs/DRIFT-LOG.md` created per the spine's own AD drift-log contract, seeded with this pass's corrections. Suite **4718 / 4716 pass / 0 fail / 2 skip**, docs-sync OK. | this commit | **Yes for BUG-258** — reproduced in isolation with the exact ENOENT diagnostic before the fix, 54/54 after, full suite green, `sync-test-count --check` OK. Doc changes verified against the code they describe (schema.js, the spine's own table row count, effectors count from sync-test-count). CI itself will confirm on push — the one thing a local run cannot. |
| 2026-08-16 (second wave) | **No merged-order step advanced — BUG-258's fix was pushed and CI STAYED RED, which forced the deeper reproduction and found the second, independent cause.** With the immune test fixed, CI's failure signature became readable: `fail 0` — so the pwsh fail-gate PASSED — and the `sync-test-count.js --check` gate failed on the number mismatch instead. A local reproduction in CI's exact conditions (Node 22.23.2, `env -i` clean environment, `TZ=UTC`, no discoverable browser; local Node 24 runs were green throughout) reproduced it exactly: `fail 0 / cancelled 64 / pass 4652`. **BUG-259, root cause:** three one-shot timers were `unref()`'d whose only job is to settle a promise someone awaits — `briefing.js`'s `withTimeout()`, `from-pc.js`'s `delegateWithRetry` backoff, `electron/child-exit.js`'s SIGKILL deadline (where the unref defeated the function's own "never waits forever: escalates and resolves anyway" contract). In a quiet process — precisely the Node 22 test-runner child with an otherwise-empty event loop — an unref'd timer never fires; the awaited race never settles; the runner kills the pending test ("Promise resolution is still pending but the event loop has already resolved") and its siblings cascade `cancelledByParent` (64 via briefing, 18 more via the from-pc/child-exit families after the first fix). All three timers are ref'd again — an unref'd timeout is a timeout that never fires in the process that most needs it. One more env-dependence fixed alongside, different shape: `browser_launch_debug()` ran browser discovery BEFORE `BROWSER_EXTENSIONS` validation, so on a browser-less machine (fresh contributor, stripped runner) the loud config error was masked by "No supported browser found" and `test/bug-115`'s loud-failure test failed there; validation now runs first, machine-independent. **Step 6.6 first audit pass recorded** in THIRD_PARTY_NOTICES.md (Hermes MIT re-verified live; MediaPipe gesture weights re-confirmed UNVERIFIED with both canonical docs URLs now 404; Google/Groq/Mistral/Cerebras/OpenRouter ToS quoted verbatim with sources+dates; NVIDIA NIM named as the remaining gap). 6.6 stays ☐. **Final verification: 4718 / 4716 pass / 0 fail / 0 cancelled / 2 skip in CI's exact conditions — matching the committed numbers both CI gates check.** | this commit | BUG-259 reproduced under Node 22.23.2 before each fix (64 then 18 cancellations), zero after; the five affected test files pass 46/46 browser-less under Node 22; the full CI-faithful run matches the committed counts exactly. **CI CONFIRMED GREEN — run 181, `f16c0fd`, 2026-08-17, the first since 2026-08-13** — after four more environment layers surfaced by the new annotation channel and fixed in `22c9dc4` (root deps + full clone), `b9969bd` (machine-independent count gate + honest fixture-skips), `39c13b0` (SPA-fallback wakeword subtest), `f16c0fd` (monotonic `updatedAt` race). |
| 2026-08-17 (operator sitting) | **Step 7 moved for the first time since 2026-08-04 — three slices verified by a human, two defects found, and the forked vault merged. Step 7 still ☐** (screen-share, cursor overlay, persona-by-ear, barge-in and the clean-path installer check remain). Verified live: the app launches and runs from `npm start` (the real Electron shell); **close-and-reopen works — BUG-225's quit seam, fixed the same day and never before checked by a person**; press-to-talk fires while another app holds focus. Found live, both green in the automated suite: **BUG-268** (`Ctrl+Alt+X` screen-text capture does nothing — popup fires, no result; operator-deprioritised, left undiagnosed rather than guessed at) and **BUG-269** (press-to-talk intermittent with variable lag; kept separate from 268 so one fix cannot close both). The PIN prompt was resolved as NOT a bug. **The vault fork is the substantive finding:** before `app.setName('MYTHOS')`, dev runs wrote `%APPDATA%\agent-os` and the packaged app wrote `%APPDATA%\MYTHOS`, both live on the same days — and `MYTHOS`/`mythos` are one directory, Windows being case-insensitive, so two vaults not four. Merged additively with a backup and nothing overwritten: **734 episodic entries, 572 audit lines, 31 lessons (90→121), 2 operator facts (37→39)**; every merged line parses, zero duplicate ids, re-run finds nothing left. Stale `proposed` goals, an all-`fired` reminders file, `pin.json` and six older Identity files deliberately left behind. **BUG-266/267 recorded in BUGS.md as reserved ids** so a concurrent session cannot reuse them. | this commit | **Yes — this row is itself the live verification**, performed by the operator at a real Electron desktop, which is the only thing that could have produced it. The merge is verified by re-run + JSON validation, not by assumption. BUG-268/269 are verified as REAL and deliberately NOT diagnosed. |
| 2026-08-17 (planning only) | **No merged-order step advanced, NO CODE WRITTEN — merged-order step 8 designed and tracked.** The operator asked for three upstream repos wired into MYTHOS end-to-end (`PrimeIntellect-ai/prime-agent`, `addyosmani/agent-skills`, `TencentCloud/TencentDB-Agent-Memory`) and then set the sequence explicitly: plan now, build only after 6.5/6.6/7. The full design landed in this file as **Step 8** — four lanes (8A skills truth + curated vendoring, 8B Continual Harness, 8C memory budget + Live depth, 8D budgets + quality gates), each with architecture, a wiring table naming every writer and reader, code snippets, and six new invariants **AD-11…AD-16** mirrored into the V2 spine §1. Two operator decisions recorded so they are not relitigated: prime-agent and TencentDB are **patterns-only, never dependencies** (prime-agent installs by `curl \| sh`, forbidden by the root `CLAUDE.md`; TencentDB needs a 3-service Docker stack that breaks portability and the sold-installer story). Infrastructure delta zero. **Research finding that reframed the scope:** MYTHOS already has most of what those repos are known for — `skills/loader.js` is multi-root resolution with progressive disclosure, `memory/index.js:243 recallHybrid()` already does keyword+vector RRF (TencentDB's headline design), and `Identity/operator-profile.txt` is already its "L3 persona" reaching every surface via `persona()`; hence 8C.3 is provisional and gated behind 8C.2 proving insufficient. **Two live bugs reproduced and deliberately left unfixed** (they are 8A's first two items; fixing them now would jump the operator's sequence): **BUG-266** — six skill names hardcoded into prompt text (`voice-agent.js:275`/`:93`, `from-skills.js:37`) are PHANTOM on any fresh clone, proven by running the real loader with `USERPROFILE`/`HOME` pointed at a non-existent directory, and `ui-ux-pro-max` is phantom even here because it is vendored essence-only while `loadContent()` reads `SKILL.md` exclusively; **BUG-267** — `buildLiveSystemInstruction()` injects a 43-skill catalogue whose header says "call use_skill" while `use_skill` sits in `VOICE_ALLOWLIST_EXEMPT` and Live declares only `DEFAULT_ALLOWLIST`, so the primary spoken surface is told to call a tool it was never given. One `loader.js` edit was begun before the plan-only instruction arrived and was reverted; `git status` confirmed clean before this commit. | this commit | n/a (docs) — **nothing in step 8 is implemented, so nothing is verifiable yet.** The two bugs above ARE verified as real: reproduced against the live loader in the fresh-clone environment shape, output recorded verbatim in the Step 8 section. |
| 2026-08-17 | **No merged-order step advanced (6.5 ☐ · 6.6 ☐ · 7 ☐ unchanged) — the operator-approved fix plan for the NINE open coding defects, executed in three waves, one commit per verified fix, each pushed immediately.** **Wave 1:** BUG-225's quit seam fixed at all four structural defects (re-fork race: `window-all-closed` sets `isQuitting` before `stopChild` non-darwin + `startChild` refuses once quitting; secondary windows: the main window's `closed` handler now releases media window + overlay so `window-all-closed` can fire; kill ladder: `stopChild` returns `awaitChildExit`'s SIGKILL-at-3s escalation; backstop: a ref'd 10s quit watchdog tree-killing via `taskkill /T /F` then `app.exit(0)` — armed BEFORE the blocking vault push) — with the trap the fix forced: an explicit `installerHandover` flag now feeds `before-quit`'s push-skip, since pre-setting `isQuitting` in `window-all-closed` would have skipped the vault push on every ordinary quit. Packaged builds no longer arm wake-word models from the install tree (`MYTHOS_PACKAGED=1` injected; `modelSearchDirs` drops the install tree there — userData-or-nothing, dev keeps the search). **Wave 2:** BUG-260 (`sensors/job.js` emitted the artifact OBJECT, the announcer spoke "[object Object]" — now the PATH string, announcer accepts both shapes); BUG-261 (open_folder's single 700ms coin-flip oracle → 4×400ms bounded poll, exact-then-contains title match, distinct pc-child-offline vs no-window reasons); `TOOL_ACK_DEADLINE_MS` operator-tunable (schema key default 1500 UNCHANGED, seam fed, `.env.example` names `live.tool-ack-deadline` counts as the evidence source). **Wave 3:** BUG-262 (distillation's two dead gates: idle count excludes `kind:'timer'` heartbeats — also revives `mull()`, the Phase-4-broken routing — and the active-branch consolidate hoisted above the goalless early-return; every skip now emits `memory.consolidate-skip` with a reason); BUG-263 (the fields-absent WebView2 caret false-refusal: split on the landed title — real app names still hard-fail with the 2026-07-31/Antigravity guards intact and pinned, the "Chrome Legacy Window" artifact shape returns honest-unverified BEFORE the read-back oracle); BUG-264 (`open_web browser:true` — the explicit in-tool route through the existing newtab mechanism; default unchanged, pinned); BUG-265 (the duplicate-identify anomaly damped to one per nodeId per 60s with `suppressedCount`; root cause honestly recorded as Aether-side). BUG-253's table rows for the whatsapp, open_folder, open_web and duplicate-storm incidents closed; the 2026-08-15 RCA's wakeword and ack-deadline bullets closed. Suite **4760 / 4758 pass / 0 fail / 2 skip**, counts synced per commit. A second session (freebuff worktree) landed `42f370d` mid-plan — stacked cleanly. | `1eda5a8`, `36ba820`, `196911d`, `f61f205`, `2c4bc08`, `0ed3108`, `bd64180`, `b7e16fa`, `1b96d52` | **Unit/source-shape green only — nothing here is live-verified yet, and four cheap operator sittings are named in RESUME HERE:** one X-close sitting (BUG-225: MYTHOS.exe exits ≤10s, double-click relaunches), one packaged-install check (wakeword honest-unavailable), one voice session then grep `memory.consolidate-skip` (BUG-262 — also covers the 08-15 persona/facts checks), and the Aether-side storm diagnosis. Two hook retries were load flakes from the concurrent session's suite runs, not regressions — both re-verified green in isolation before commit. |
| 2026-08-17 (planning only, second pass) | **No merged-order step advanced, NO CODE WRITTEN — step 8 grew from four lanes to six.** The operator named `msitarzewski/agency-agents` alongside the two repos step 8 already covered, asked for "the best of the best — memory, agent skills", and re-confirmed **plan only, nothing built**, so the 6.5/6.6/7 gate stands. Two lanes added with full design, wiring tables and per-lane oracles: **8E — the Agency roster reaches the seats.** The finding that sized it: agency-agents is **already half-vendored** (six personas as `mythos/skills/persona-*/SKILL.md`, MIT, in `skills.allowlist`, credited in `THIRD_PARTY_NOTICES.md`) but **catalogue-only** — two persona layers exist that cannot see each other (`skills/loader.js` serves those six to the model via `use_skill`; `agents/personas.js` serves the *seats* from a different directory of four files), and `pickBuilderPersona()` is a two-way keyword coin flip, so every card that is not frontend-shaped gets `backend-builder` and the roster is never consulted — the same silent-degradation shape as *personas never loaded*. 8E.1 bridges the roots as a fourth candidate, 8E.2 makes the router scored and self-reporting, 8E.3 vendors **eight** more personas that each have a named reader (devops-automator, api-platform-engineer, data-engineer, appsec-engineer, secrets-credential-engineer, test-automation-engineer, evidence-collector, minimal-change-engineer), leaving ~220 unvendored on purpose, with `desktop-app-engineer` and `code-reviewer` deferred for stated reasons. **8F — the four TencentDB assets 8C did not take** (8C took only the L0→L3 layering): 8F.1 versioned skills (`memory/skills.js:28` overwrites in place, so a worse auto-distillation silently destroys a better one — and the load-bearing detail is that `recordUse()` must NOT snapshot, since it rewrites on every use); 8F.2 `[[wiki-link]]` + backlinks over the existing Obsidian-compatible Notes store with **no index file**; 8F.3 scoped recall, tags first and filter second, applied at the one place `excludeKinds` already is (`memory/index.js:265`, where the keyword/vector paths once diverged as FIX G) — its team/ACL half deliberately not built, no reader in a single-operator product; 8F.4 CodeGraph, which **opens with an adopt-vs-build decision** because `ADOPTION-MATRIX.md` already carries `tirth8205/code-review-graph` at 🟢 P1 for exactly this question, with a recorded recommendation to build native and scope it to JS/TS honestly. **Five new invariants AD-17…AD-21** mirrored into V2 spine §1. Upstream persona filenames were enumerated from the real tree with `gh api repos/msitarzewski/agency-agents/git/trees/main?recursive=1` — the `tree/main/...` web path 404s, so guessing them was explicitly ruled out. All three upstreams MIT, so 6.5 is unaffected. | this commit | n/a (docs) — **nothing in 8E or 8F is implemented, so nothing is verifiable yet.** What IS verified: the two-persona-layer split and the coin-flip router were read in `agents/personas.js` and `agent-actions.js` (four `loadPersona` call sites, one `pickBuilderPersona` caller); the six vendored personas were confirmed on disk, in `skills.allowlist` and in `THIRD_PARTY_NOTICES.md`; the eight upstream filenames were listed from the live upstream tree. |
| 2026-08-17 (v0.1.10 closeout, Part A) | **No merged-order step ticked yet (6.5 ☐ · 6.6 ☐ · 7 ☐ — ticks are gated on the operator's Part B sitting) — but the closeout plan's entire code half, Part A items A1-A4, shipped in four commits, each independently reviewed and pushed.** **(1) A1 / BUG-269 — the intermittent press-to-talk hotkey, the highest-value fix in the repo, fixed at three independent defects that each reproduce the symptom.** The lost-IPC race: `registerTalkHotkey()` ran before the renderer's `onHotkey` listener existed, and Electron does not queue IPC for unregistered listeners, so any press in that window was lost silently and forever — now a payload-free `mythos:renderer-ready` signal (AD-8-safe, no channel param added to the preload surface) plus `electron/hotkey-latch.js`, a boolean single-press latch that flushes exactly once on ready and re-arms on `did-start-loading` (a reload destroys renderer listeners — same bug class, would have reappeared after every refresh). Re-entrancy: `toggleVoice()` was async but invoked un-awaited, and `ensureVoice().start()` inside it too, so two presses during mic acquisition interleaved — now `voice/toggle-guard.js`, an in-flight guard that DROPS concurrent presses (queueing would ripple start/stop/start the operator never asked for), with the un-awaited calls awaited. Structural lag: `arming` state now sets synchronously as the first statement before any await (a lost press and a slow press were visually identical — why the bug read as "intermittent" rather than "slow"), and `vadTick()` runs once immediately after `setInterval`, removing up to a full 100ms tick of dead time. New behavioural tests were red-first per the plan's mandate: 8/14 failing before the fix, 20/20 after; the pre-existing source-shape guards (which passed throughout the bug, by their own admission) kept and extended. **(2) A2 — `PIN_SESSION_ENFORCE` schema default false→true**, enacting the operator's 2026-08-17 answer ("whenever we start the app, it should ask for the PIN"). Safe by construction and pinned: `pinSessionRequired()` requires BOTH the flag AND `pinLock.isConfigured()`, so no PIN means no lockout; `.env.example` documents the opt-out; the config-doc-truth gate carries a deliberate allowlist entry; `pin-session.test.js` got prose-only corrections, no assertion loosened. **(3) A3 / step 6.5 — informed consent at the install point.** The architecture already excluded the CC BY-NC-SA weights from the installer (verified, not assumed); what was missing was the notice. The setup wizard's wakeword component now states the weights are openWakeWord, licensed CC BY-NC-SA 4.0, non-commercial use only, and downloading them is the user's own action; the allowlist test asserts the notice contains all three claims so it cannot be silently dropped. Decision 4 recorded in the 6.5 section; the 2026-07-30 own-model training workstream marked superseded. **(4) A4 / step 6.6 — the last named audit gap closed by evidence.** NVIDIA NIM's production-use definition quoted verbatim with source URL + fetch date in `THIRD_PARTY_NOTICES.md` ("Production use involves any use of NIM for purposes other than development, testing, research or evaluation … including activity serving real end-users. Using NIM in production requires an NVIDIA AI Enterprise license." — General NIM FAQ, "What does 'production' mean?"), replacing the "NOT VERIFIED 2026-08-16" entry; a 3-line note beside the NIM keys in `.env.example`; consequence phrased as a disclosure obligation, not a licensing one (BYO-key architecture — the end user accepts NVIDIA's terms directly). Lane audit: NIM leads NO default lane (PREF_VOICE 5th, PREF_REASONING 3rd, PREF_SIMPLE 3rd, PREF_TEXT 4th, PREF_BUILD 7th, PREF_VISION 5th-6th google-leading, PREF_MEMORY/PREF_EMBED absent), so no de-ranking was needed. Facts only, no legal conclusion, per the standing limit. Suite **4823 / 4821 pass / 0 fail / 2 skip** (both skips pre-existing environment skips), `sync-test-count --check` OK. | `9b98bc3`, `a847894`, `e62acbd`, `1bee47f` | **No — and the gate is explicit, not an oversight.** All four items are unit-green and independently reviewed; none is live-verified, because the verification IS the operator's Part B sitting (nine checks, listed in RESUME HERE): merged-vault boot, PIN set/quit/relaunch + no-PIN-no-lockout, twenty hotkey presses (ten cold), screen share, cursor overlay, persona/voice by ear, barge-in, clean-path installer, and the second-voice watch. Steps 6.5, 6.6 and 7 tick only after Part B is performed; Part C (`node scripts/release.js patch --yes --ci`) releases v0.1.10 after the ticks. |
| 2026-08-17 (BUG-270) | **No merged-order step advanced — Part B's first live voice check FAILED, and it falsified a same-day change; BUG-270 fixed in code.** The operator ran the first real voice conversation on the batch path (`VOICE_S2S_ENABLED` unset): "It is very glitchy. It interrupts and it's breaking in between all sorts of things… It's not picking up words from the noise. The microphone is fine." **(1) The interruptions — the 900ms endpointing experiment live-falsified the same day it shipped.** `e19ac07` (that morning) cut `VAD_SILENCE_MS` 1800→900 for faster endpointing, flagged "unit-green, NOT yet live-verified at a mic", and its commit message accepted the exact trade-off that then happened live: natural mid-sentence pauses >900ms split one utterance into two clips, MYTHOS answered mid-thought, and the BUG-027 `assistantSpeaking` half-duplex gate then swallowed the operator's continuation (only the much higher barge-in floor, 0.0875 RMS sustained ~600ms, could get it through). **The documented revert applied:** default restored to 1800 in `schema.js`, the `voice-loop.js` literal, and `.env.example` — the pair re-pinned by `config-doc-truth.test.js`; still env-tunable for anyone who wants faster endpointing. **(2) The missed words — the real defect was that they were INVISIBLE.** The batch path's `recorder.onstop` gates each clip twice (peak RMS vs `MIN_PEAK_RMS` 0.06; effective length/size vs `MIN_CLIP_MS`/`MIN_CLIP_BYTES`) and both gates used to `return` with no log, no event, no HUD hint — and the batch path emits no client telemetry of its own, so "not picking up words" had zero evidence to diagnose. **Both drops are now loud:** `console.warn` carrying the measured value and the floor it failed, plus a HUD caption ("🎤 too quiet — not sent" / "🎤 too short — not sent"). Pinned red-first by new `test/bug-270-clip-drop-observability.test.js` (source-shape, brace-matched onstop extraction; 2/3 failing before the fix, 3/3 after; the third test pins that the gates still DROP — observability changed, behaviour did not). **Deliberately NOT changed: the BUG-020 threshold trio stays** (0.035/0.06/3) — it was raised against noise for a reason (fans/AC/bikes triggered phantom recordings) and lowering it blindly re-opens that bug; the new observability makes the next step evidence-based (`VAD_SPEECH_RMS=0.025` first, or `VAD_ENGINE=silero`, the trained speech-vs-noise detector, one-time `setup-silero.js` download). BUGS.md: BUG-270 recorded; BUG-269's stale "OPEN, UNDIAGNOSED" line corrected to fixed-in-code `9b98bc3`. | this commit | **No — the fix is unit-green and red-first-pinned; live re-verification is the operator re-running Part B's voice checks:** a conversation WITH natural pauses (MYTHOS must no longer jump in mid-thought) and speech in the noisy room (if still missed, the new "too quiet" hint names the gate to tune). The other Part B checks stand. Steps stay ☐. |
| 2026-08-17 (BUG-271) | **No merged-order step advanced — BUG-271, the Live-path diagnosis of the symptoms BUG-270 fixed on the wrong path, shipped in code across three commits plus this record.** The operator's machine runs the Gemini Live path (`VOICE_S2S_ENABLED`), and the Live path never got the defences the batch path has carried for years. Three defects, three fixes: **(1) the self-interrupting echo loop** — MYTHOS's own voice replayed to Gemini's `START_SENSITIVITY_HIGH` VAD, transcribed as the operator, firing `serverContent.interrupted` mid-word and reading as self-interruption one turn later. `d3d6226`: `src/core/voice/echo-filter.js`, a verbatim port of the batch `echoMatch` (≥60% word overlap vs the last 3s of MYTHOS speech) wired into `live-session.js`; a matching transcript behaves as if it never arrived and logs `live.echo-dropped` (ratio only, never transcript text). 18 new tests. **(2) phantom words from ungated noise** — the Live send path streamed every 100ms frame with no gate, and the eager barge-in release tier (0.035/200ms) tripped on speaker bleed every ~7s, replaying MYTHOS's own voice back. `bb10623`: new `ui/public/js/voice/live-noise-gate.js` wired into BOTH `live-audio` send points — **zero, never drop** (below-floor frames become silence of the same byteLength; wire shape and Gemini's VAD timeline untouched; 800ms-quiet hysteresis; localStorage floor, 0 = raw stream), eager tier raised to **0.05/300ms** (above measured bleed, still below the 0.056 flush tier). 39 new tests. `952580e`: review fix — `framesZeroed` now resets per session in the gate's `reset()`. **(3) the hidden evidence** — since `36561bd` the client's own-voice-release transition has sent `prerollFrames`/`prerollCap`/`heldMs`/`framesDropped`/`peakRms` (plus `framesZeroed` from the new gate), but the server's `voice-capture-suspend` handler logged only `{ suspended, holdMs, reason, at }`. This commit: the handler logs every field the client sends under its exact client name, on the transitions that send it — no wire change, numeric/boolean only. Pinned red-first by extending `test/s2s-capture-suspend-log.test.js` with a real-server block (1/2 failing before, 10/10 after); the same edit fixed a leaked global `mock.timers.enable` in that file that hung any later test using `setTimeout`. BUGS.md: BUG-271 recorded; BUG-270 gets the honest correction note (valid fix, wrong path for the operator's machine). Naming note: `holdMs` (suspend-start) and `heldMs` (own-voice-release duration) are distinct fields on different transitions. | `d3d6226`, `bb10623`, `952580e`, this commit | **No — code-complete and unit-tested; the live acoustic re-test is the operator's next step** (restart the app, converse in the noisy room, watch for phantom words and self-interruption/echo turns; if anything persists, `live.echo-dropped`, `peakRms`, `framesZeroed`, `framesDropped` in mythos-server.log name the responsible gate). Steps stay ☐. |
| 2026-08-18 (BUG-272, docs only) | **No merged-order step advanced, NO CODE WRITTEN — BUG-271's live re-test happened, and its full fallout is inventoried as BUG-272 with the fix plan.** The operator ran the first post-BUG-271 voice session (20-minute, noisy room, 72 live turns) plus a full forensics pass over the server log (721 lines) and the vault (170 episodic entries, 130 audit records, 3 incidents, `logs/main.log`). **Confirmed working from BUG-271:** noise gate zeroed 5,000+ frames with `framesDropped: 0` on every transition; the suspend-log evidence fields delivered the diagnosis. **Not fixed, now root-caused:** self-interruption at 63% of turns — the eager tier sits below the room's measured bleed floor of 0.09–0.38 RMS, which overlaps the speech band, so no RMS threshold can separate them; 16 `ceiling-fail-open` holds up to 13s (the mirror-image failure — same RMS-only policy); the echo filter fired ZERO times (either pure VAD-level interrupts before any transcript exists, or a broken reference pipeline — the logs cannot currently tell which, hence instrumentation before policy); phantom ASR persists above the noise floor; the wake word died at boot with OverconstrainedError (stale `deviceId:{exact}` from localStorage the surviving cause — the failure predates the s2s mic by ~29s, disproving the capture-race theory; no sampleRate/channelCount constraints exist in the request at all) and never re-armed (no fallback, no backoff, no devicechange hook); `launch_app` "code" resolved to the ZCode process via the unanchored substring rung with a circular evidence oracle; `open_web(browser:true)` failed 7/7 silently under Electron (newtab rejected by the media window, `setWindowOpenHandler` denies window.open, `shell.openExternal` absent from the repo; breaker counts unverified as success; per-turn dedupe resets); focus_window stale-pid + foreground-lock confirmed live-reproducing with a real app focused (answers AGENTS.md's open question; ladder exhausted, no speculative 4th rung); 4 ack-deadline breaches. Five evidence-based corrections to the findings document recorded in the entry (wake-word timeline, constraint shape, launch_app failure class, dedupe-exists-and-worked, echo-check logs must stay transcript-free). **The agreed fix order — audio ownership → echo attribution → barge-in policy → tool honesty — is written into the BUG-272 entry as five slices** (wake-word relaxed retry + backoff re-arm; echo-check instrumentation with privacy-safe fields only; playback-aware barge-in state machine with 2s ceiling and ~150-frame preroll cap; tool honesty incl. `shell.openExternal` surface and per-tool-class ack deadlines; records + scripted verification session with pass criteria). This commit is docs only: BUGS.md BUG-272 entry + header chain, this roadmap's RESUME HERE rewrite + this row. | this commit | **n/a (docs) — nothing implemented, so nothing verifiable yet.** What IS verified: every statistic in the inventory comes from the real session log and vault of 2026-08-17/18, and every code-level claim was grounded by reading the named file:line (mic-device.js, wakeword.js, app.js, ps-automation.ps1, from-pc.js, from-dashboard.js, electron/main.js, media-window.js, live-tool-adapter.js, hub.js). The live verification of the FIXES is the Slice 5 scripted session with the operator at the mic. |

---

## The V2 spine — found, committed, nothing to re-plan

**An earlier revision of this section declared the V2 spine lost and marked Wave 3 plus Task 11's §7.1/§7.3/§7.5/§7.6/§7.7 as "must be re-planned from primary sources." That was a false alarm. Retracted.** V2 is intact and is now committed beside this file:

> **`mythos/Plans/MYTHOS-IRIS-Synthesis-Plan-V2-spine.md`** — 1,570 lines, md5 `6e1547df33ad0b43663604f86b5acd03`

**Why the search missed it.** The verification was rigorous but scoped entirely to the repo — `git log --all`, `git stash list`, `mythos/Plans/`, and a repo-wide `*synthesis*`/`*iris*`/`*s2s*` filename sweep. V2 lives in `~/.claude/plans/` (where Claude Code plan-mode files go) under the auto-generated name `deep-compare-this-floofy-heron.md`, which matches no plan-related filename pattern. This document sits in that same directory as `i-just-installed-the-virtual-sketch.md` — two siblings in one folder; the search found this one and concluded the other never existed. The root `.md.txt` that was analysed was a stripped copy of **this** document, which is why the `§` markers only ever matched themselves. **Lesson for the next session: `~/.claude/plans/` is outside the repo and outside every repo-scoped search. Check it before concluding a plan is gone.**

Recovered verbatim and unfabricated by that one pointer: §1 Anti-Drift Contract with AD-1…AD-10 and each executable check · §3 frozen Gemini Live wire protocol, every envelope and exact field name · §4 frozen MYTHOS seams, 21 seams with line numbers and contracts (the prose here said "23" from the start while the table itself has 21 rows — corrected 2026-08-16, see the spine's §4 note) · §6 `live-session.js` full source · §7 `live-tools.js` full source with the param-prose converter · §8 the leash tool adapter · §9 both browser worklets · §10 server wiring diff · §11 persona table, all six changes · §7.1–§7.7 including the WinRT OCR PowerShell block · §13 Electron shell · §17 Amendment 1.

**Precedence between the two documents.** V2 is the spine and owns anything it specifies in source-level detail (S2S transport, the frozen references, the Anti-Drift Contract, Electron). This document is the delta and wins where it is more concrete or more recent — it carries literal test code, and V2's own §18.2 explicitly adopts six of its decisions. Where they conflict, V2 §18 is the tie-breaker because it was written last and with both documents in hand. Do not build both sides of a supersession: V2 §7.4's `android-adb`/`from-phone.js` with 6 tools is **replaced** by this document's Wave 2 (`android-child`/`from-android.js`, 14 tools, per-device queues).

### Corrections this document needs (from V2 §18.3) — apply as you reach them

- [x] **`phone_whatsapp_send` has no legal tap primitive — internal contradiction.** Task 10 requires "a resolved send tap", but none of the 14 tools taps or types, and `phone_shell` is deliberately refused. As written the flow can only ever report "opened, please tap send." **Fix:** add a tiered `phone_tap` (T3, resource-id targeted only, never raw coordinates), or drop the send step and keep the honest deep-link-open behaviour. **RESOLVED (option b, merged-order step 6):** dropped the send step. No physical phone existed to verify a tap primitive against, so `phone_whatsapp_send` opens the wa.me deep link with the message pre-filled and reports `{opened:true, sent:false}` — never a claimed send. Option (a) remains open for a future session WITH a real device to verify against.
- [x] **Do not register `phone_flashlight_toggle`.** Task 10 concedes no reliable stock command exists. A tool that always fails pollutes `capabilities.md` and, worse, the Live `functionDeclarations`, where accuracy degrades with tool count. Omit it, or register only after a runtime capability probe succeeds. AD-4 argues this. **DONE (merged-order step 6):** not registered — `from-android.js` ships 14 tools (13 rows, see Task 10), `phone_flashlight_toggle` is not one of them, confirmed by a dedicated test.
- [x] **Licensing is a hard gate before Wave 4, and it is absent from this document.** Verified in code, not just claimed: `mythos/providers/edge-tts.js:8` and `mythos/services/edge-tts-server.py:7` both label edge-tts as a reverse-engineered endpoint, personal/hobby use only, commercial deployment prohibited; `mythos/THIRD_PARTY_NOTICES.md:25` records the openWakeWord **model weights** as CC BY-NC-SA 4.0, non-commercial. Wave 4 ships an installer, and a paid binary must not contain NC-licensed wake-word weights. **Swap edge-TTS → Piper (MIT, local) and train an own-voice `hey_mythos` model using openWakeWord's Apache-2.0 tooling** — the tooling is permissive, only the pretrained weights are NC. This is a licensing problem, not a technical one, and it will never surface in testing. **RESOLVED — the gate now exists in this document as tracked steps 6.5 and 6.6** (merged-order line, the 6.5 section's four operator decisions, `THIRD_PARTY_NOTICES.md`'s dated/sourced audit entries), and the proposed remedy is superseded twice over: Decision 1 (2026-07-30) keeps TTS BYO, so no Piper swap is required, and Decision 4 (2026-08-17) keeps the wake word BYO with the non-commercial notice at the install point, so there is no own-model training workstream. Do not execute the struck remedy.
- [x] **Fix cross-reference drift in the parity table. VERIFIED ALREADY FIXED 2026-08-04** — checked the raw table rows rather than trusting this correction's own age (the same method line 111 below used, and for the same reason: these correction bullets go stale themselves). All four now cite correctly: "SMS to contacts by voice" → Task 10 (line 348), "Phone calls + contacts directory" → Task 10 (349), "Up to 2 Android devices + desktop" → Task 9 (353), "24/7 background, zero daily limits" → Task 7 (354). Nothing to change; this checkbox was the only thing still stale.
- [x] **Split Task 11.** It is nine items behind one checkbox. A checkbox-driven roadmap needs one task each. **VERIFIED ALREADY DONE** — the Task 11 section below (`### Task 11: The rest of V2 §7 plus the four gaps the audit surfaced`) already lists all nine items (semantic code search, maps+routing, image generation, WhatsApp desktop scheduling, §7.1 OCR, §7.3 PIN/Hello, §7.5 doc RAG, §7.6 calendar, §7.7 wallpaper) as separate `- [ ]` checkboxes, not one shared checkbox — checked the raw section directly rather than trusting this correction's own age.
- [x] **Schedule the §1 anti-drift invariant tests. RESOLVED 2026-08-04, and the phone-tool concern is satisfied by construction rather than by a per-tool test.** All ten invariants now have executable tests (see §18.3.6's re-count below). On the specific worry here — the 14 phone tools: **AD-1's test is a repo-wide literal scan** asserting `effectors.invoke(` appears nowhere but `dispatch-action.js`, so every phone tool is covered automatically the moment it exists; a phone tool that bypassed dispatch would fail that scan, not slip past it. **AD-2** drives a real `createLeash()` end-to-end for a T0 auto-allow, a T3 requireConfirm and a boundary-denial, asserting exactly one audit write each — the property is per-dispatch, not per-tool, so it holds for the phone tools via the same shared path. Additionally `tier-table-conformance.test.js` enforces two-way tier coverage (no tool without a tier row, no tier row without a tool), which is what would actually catch a phone tool being added untiered, and **AD-9 now injects ENOENT on `android-child` specifically**. Writing 14 near-identical per-tool tests would add no coverage the scans do not already give.
- [x] **Wave numbering is inconsistent. RESOLVED** — the fix was to stop maintaining two sequences rather than to renumber. The merged-order line above is now explicitly authoritative and is immediately followed by "Ignore the older Wave 0/1/1.5/2/3/4 numbering where it conflicts", so "Wave 1.5" appearing after Wave 2 in the body no longer implies anything about ordering. The old wave labels survive only as historical section names.

### Merged execution order (V2 §18.4 — supersedes the table in Decision 3)

| # | Work | Source |
|---|---|---|
| 0 | ✅ Restore the V2 spine into `mythos/Plans/` — unblocks Wave 3 + Task 11 | §18.1 — **done, this commit** |
| 1 | Green the baseline + docs (AD-10) + §1 invariant tests | Tasks 1–2 + §18.3.6 |
| 2 | Server auth + WS `?token=` + `/vault/builds` gate | §7.2 + §18.2 |
| 3 | Persona unclamp — hours, largest felt win, two-file rollback | §11 |
| 4 | S2S transport + latency instrumentation | §6–§10 + Task 12 |
| 5 ✅ | Desktop gaps: clipboard, file ops, alarms, autostart, OCR, maps, image gen, code search, PIN, wallpaper, calendar | §7 + §17.2 + §18.2 |
| 6 ✅ | ADB bridge: adapter, setup script, 14 tools, per-device queues, device registry | §17.1 + Tasks 8–10 |
| **6.5** | **Licensing gate: TTS=BYO (no swap needed), wake-word model TBD — blocks SHIPPING, see below** | §18.3.3 |
| **6.6** | **Wider third-party licence audit (Hermes, cua-driver, MediaPipe assets, provider ToS for resale) — split from 6.5 by Decision 3** | new |
| 7 | Electron shell + installer + overlay; Android app planned only — buildable now (blocks release, not building); installer MUST honour Decision 1 (never bundle the LGPL edge-tts package) | §13 |
| **8** | **Upstream synthesis (prime-agent · addyosmani/agent-skills · TencentDB-Agent-Memory · agency-agents): 8A skills truth + curated vendoring, 8B Continual Harness, 8C memory budget + Live depth, 8D budgets + quality gates, 8E Agency roster reaches the seats, 8F the four TencentDB assets 8A-8D left (versioned skills, wiki links, scoped recall, CodeGraph). Tracked, NOT started — starts only after 6.5/6.6/7** | new (AD-11…AD-21) |

### Step 6.5 — the licensing gate, with 2026-07-30's findings folded in

**Read this before starting 6.5. It changes what the step is.**

**The commercial intent is now confirmed, so the gate is live.** V2 §17.3 frames
this step conditionally — "if the intent is to sell." The operator confirmed on
2026-07-30 that **MYTHOS will be sold later, possibly with a free basic demo
tier.** So the condition is satisfied and this step is real, not hypothetical.
Note that a free demo does **not** rescue either problem below if it shares a
codebase with the paid product: a demo that markets a commercial product is
generally still commercial use, and maintaining two TTS paths so the demo can
keep edge-tts is worse than swapping once.

**The repo's own warnings are self-authored — do not treat them as upstream
rulings.** `git blame` puts the `providers/edge-tts.js` warning at `532106d8`
(2026-07-10, authored in this repo) and the `THIRD_PARTY_NOTICES.md` weights
entry at `29e9891`. Nobody at Microsoft or upstream wrote "personal/hobby use
only" anywhere. Verify against actual upstream licence files before planning
around them; earlier revisions of this roadmap cited these comments as though
they were external law.

**The two problems are different in kind:**

- **edge-tts is a Terms-of-Use and business-risk question, not a copyright
  licence one.** The Read Aloud endpoint is undocumented and unauthenticated, so
  there is no Microsoft licence to violate — the exposure is charging money for a
  product that depends on unauthorised access to Microsoft's service. That gets a
  product pulled rather than fined. **VERIFIED 2026-07-30 against real upstream
  sources (not this repo's self-authored comments): the upstream `edge-tts`
  Python package (`github.com/rany2/edge-tts`, PyPI `edge-tts` 7.2.8, author
  `rany`) IS copyleft — LGPLv3.** Both sources agree: the LICENSE file is
  LGPLv3 for the library (one CLI entry file is MIT), and the PyPI classifier is
  `License :: OSI Approved :: GNU Lesser General Public License v3 (LGPLv3)`.
  The package itself is NOT bundled or vendored anywhere in this repo
  (`mythos/services/edge-tts-server.py` does `import edge_tts`, but there is no
  `requirements.txt`/pip-install vendoring it) — so the repo ships a Combined Work
  that expects the user to supply the library. Whether BYO fully clears the
  LGPL bundling obligation is a lawyer's call, not a session's; see Decision 1
  below for how the operator resolved the policy side.
- **openWakeWord weights are a genuine upstream licence** — RE-VERIFIED
  2026-07-30 against real upstream sources: the GitHub README
  (`dscripka/openWakeWord`) and the Hugging Face model repo
  (`davidscripka/openwakeword`) both state verbatim that the pre-trained models
  are CC BY-NC-SA 4.0 "*due to the inclusion of datasets with unknown or
  restrictive licensing.*" The code/tooling is Apache-2.0 (the LICENSE file).
  **Trap a future session must not fall into:** reading only the code LICENSE
  (Apache-2.0) and concluding "Apache for everything" — the weights are a
  separate artefact under separate terms. NC restricts **use**, not just
  distribution, with share-alike obligations on derivatives. Training an own
  `hey_mythos` model with the Apache-2.0 tooling is the clean fix (using a tool
  to train ≠ bundling it); see Decision on wake-word below for the unresolved
  status.

**The download-on-demand nuance, and why it is not a free pass.** MYTHOS never
distributes the wake-word weights — `mythos/ui/public/models/wakeword/` is
gitignored and `scripts/setup-wakeword.js` fetches them to the user's own machine.
That mitigates *distribution*. It does not clearly clear NC, because NC restricts
**use**, not only distribution. "Our paid product's wake word requires you to go
download non-commercial weights yourself" is not a position worth betting a
business on.

**Scope narrowed by step 4.** The S2S path does its own TTS inside the Gemini
Live stream and never touches edge-tts, so edge-tts now only affects the
`VOICE_S2S_ENABLED=false` fallback path. Still shipped code, so still in scope,
but no longer the primary voice path.

**This gate blocks SHIPPING, not BUILDING.** Nothing is distributed until a
release is published, so step 7's Electron shell, installer packaging and overlay
are buildable in parallel — provided nothing is released until 6.5 closes. The
earlier "blocks 7" framing would have idled weeks of buildable work for no
licensing benefit.

**Swap both on the merits anyway.** Piper is MIT and fully local: no network
round trip to a reverse-engineered endpoint, no ToS surface, lower latency than
an HTTP hop to a Python service. Honest trade-off — Edge Neural voices sound
better than Piper's, so the operator must audition Piper voices by ear, and each
voice model carries its own licence independent of Piper's MIT code. Useful
interaction: openWakeWord's training pipeline generates synthetic samples using
Piper TTS, so installing Piper also supplies the sample generator for training
`hey_mythos` — which additionally gets a wake word that is on-brand instead of
"hey jarvis".

**Wider audit surface — first pass recorded 2026-08-16** (moved to its own
tracked step 6.6 by Decision 3 below; facts live in
`mythos/THIRD_PARTY_NOTICES.md`, each with source URL and fetch date — no
legal conclusions, per the standing limit below): **Hermes-Agent = MIT**
(verified upstream 2026-08-08, re-verified live 2026-08-16); **cua-driver =
MIT**, with the AGPL caveat correctly scoped to the unused `cua-agent[omni]`
extra (verified upstream 2026-08-08); **MediaPipe `gesture_recognizer.task`
remains licence-UNVERIFIED** — re-checked 2026-08-16: both canonical Google
docs URLs for it are now dead (404 via redirect), and the samples repo states
no terms for the `.task` weights; the operator's 2026-08-12 ship-anyway
decision stands, the open question stands with it; and **provider ToS for
resale** is now recorded verbatim for Google (Gemini API + Google APIs ToS),
Groq (Services Agreement, 2026-06-22), Mistral (Commercial ToS + Additional
Product Terms, effective 2026-08-05 — including that Labs/Preview models may
train on Customer Data), Cerebras (2024-08-27) and OpenRouter (2026-07-29).
The named gap — **NVIDIA NIM hosted-API terms** — is **CLOSED 2026-08-17**:
the General NIM FAQ ("What does 'production' mean?",
https://docs.api.nvidia.com/nim/docs/product, fetched 2026-08-17) states
*"Production use involves any use of NIM for purposes other than development,
testing, research or evaluation such as conducting business transactions and
any non-testing activity including activity serving real end-users. Using NIM
in production requires an NVIDIA AI Enterprise license."*, and Developer
Program access *"is for prototyping, research, development and testing
purposes only and does not include enterprise features or support"*. Full
sourced entry in THIRD_PARTY_NOTICES.md; the BYO-key consequence (end user
accepts NVIDIA's terms directly — a disclosure obligation, not a licensing
one) is recorded there. **Lane audit (2026-08-17):** NIM leads NO
default lane in `src/core/brain/lanes.default.js` — voice 5th ("last cloud
resort"), reasoning 3rd, simple 3rd, text 4th, build 7th, vision 5th–6th
(lane leads with google); memory and embed have no NIM entry. No
de-ranking was needed: the historical vision-lane rank-0 timeout problem was
already fixed by the 2026-08-14 reorder that put google first. Step 6.6
stays ☐ until the operator/lawyer reads the recorded facts (the NIM gap
itself is now closed by evidence, not by another empty terms page).

The seven npm dependencies themselves are permissive
(MIT/Apache-2.0). **The BYO-API-key architecture is a genuine licensing asset**
— the end user brings their own provider keys and accepts those providers' terms
directly, so MYTHOS resells nobody's API. Preserve that deliberately.

**Operator decisions — 1–3 ANSWERED 2026-07-30, Decision 4 locked 2026-08-17**
(each is a product/architecture choice, not derivable from code; recorded here
verbatim):

- **Decision 1 — Paid TTS: STAYS BYO, like the API keys.** This resolves the
  edge-tts/LGPL exposure *without a code swap*. The paid installer ships no
  `edge-tts` Python package; the user installs it themselves if they want that
  fallback, accepting Microsoft's terms directly — the same "BYO-API-key asset"
  framing above. Consequences that drop out: the planned Piper swap is **no
  longer required** for the TTS side (exposure removed by not bundling, not by
  swapping); `providers/edge-tts.js`/`services/edge-tts-server.py` are *this
  repo's own* glue (not the LGPL package) and stay; edge-tts is already optional
  in code (server autostarts only when `python + edge-tts module` are present),
  so BYO is already true — no adapter rewrite. What remains is a **constraint on
  step 7's installer** (never bundle the LGPL package) + clearer BYO docs, not a
  6.5 code task. Whether BYO fully clears LGPL bundling is still a lawyer's call.
- **Decision 2 — Free demo: DEFERRED.** No demo exists yet; revisit when it does.
  Note (unchanged): a demo sharing the paid codebase would NOT rescue the
  NC/LGPL problems, so the same licensing rules apply if/when it ships.
- **Decision 3 — Wider licence audit: OWN TRACKED STEP 6.6**, not folded into 6.5.
  Keeps the two known swaps separate from the un-scoped unknowns (Hermes/cua/
  MediaPipe/provider-ToS); see the new 6.6 row in the merged-order table.
- **Decision 4 — Wake word: STAYS BYO, with the non-commercial terms stated at
  the install point (locked 2026-08-17).** The openWakeWord pretrained weights
  are never bundled (root `package.json` build files exclude
  `mythos/ui/public/models`), `WAKEWORD_ENABLED` defaults false, and
  `scripts/setup-wakeword.js` fetches the weights to the user's own machine on
  demand. The operator's decision adds informed consent at that download moment:
  the setup wizard's wakeword component note now states the weights are
  openWakeWord, licensed CC BY-NC-SA 4.0, non-commercial use only, and that
  downloading them is the user's own action (`src/core/setup/components.js`,
  pinned by `test/electron-builder-files-allowlist.test.js`). No own-model
  training workstream: the 2026-07-30 "train an own `hey_mythos` model" plan
  (see the Progress log row for that date) is superseded by this decision.
  Facts only, per the standing limit below — whether download-on-demand clears
  NC for a paid product remains a lawyer's call, and step 6.5 stays unticked
  until the operator's Part B manual check (v0.1.10 closeout plan) has run.

**Standing limit:** an AI session can report what the licence files say and what
the code does. Whether download-on-demand clears NC for a paid product is a
lawyer's call. For a product that will be charged for, an hour with an IP lawyer
is cheap next to fixing this after launch. Do not let a future session write a
confident legal conclusion into this file.

Two further notes carried from V2 §18.2. Decision 1 (cancelling the speculative sentence-chunk TTS parser) is correct and **stronger than this document states** — sentence-chunked TTS streaming already exists as `splitSentences` in `server/index.js` and `src/core/effectors/voice.js`, with `test/sentence-streamer.test.js` and `test/split-sentences.test.js`; the cancelled work was redundant twice over. And V2 §7.12 wants **real Windows Scheduled Tasks** for alarms so they survive a MYTHOS restart, which is more than Task 5's in-process timer delivers — reconcile when building Task 5, and note V2 §7.8 tiers `clipboard_write` at T2 against Task 3's T1.

One standing constraint: `/council` cannot convene — `~/.claude/agents/` holds 39 agents and zero `council-*.md`. Report that; never synthesize a verdict. Use the real installed reviewers (`code-reviewer`, `security-reviewer`, `silent-failure-hunter`, `debugger`).

---

## Step 8 — Upstream synthesis: prime-agent · addyosmani/agent-skills · TencentDB-Agent-Memory

> **STATUS: TRACKED, NOT STARTED. Planned 2026-08-17, zero code written.**
> **Do not start step 8 until 6.5, 6.6 and 7 are ticked.** The operator set this
> sequence explicitly. This section exists so that when those close, the build is
> a fast execution pass against a finished design rather than a fresh
> investigation — the research below is done and the two bugs are already
> reproduced.

The operator asked for the best of three upstream repos wired into MYTHOS
end-to-end. Two operator decisions were taken during planning and both are
**patterns-only**, recorded here so a later session does not relitigate them:

| Repo | Licence | What it actually is | Decision (operator, 2026-08-17) |
|---|---|---|---|
| `PrimeIntellect-ai/prime-agent` | MIT | A complete competing agent CLI (TypeScript + persistent IPython kernel), installed by `curl \| sh` | **Patterns only** |
| `addyosmani/agent-skills` | MIT | 24 `SKILL.md` documents + 4 personas + 7 reference checklists | **Vendor a curated subset** (5 already vendored) |
| `TencentCloud/TencentDB-Agent-Memory` | MIT | 3-service Docker stack (memory-core + web hub + proxy) + a team/ACL model | **Patterns only** |
| `msitarzewski/agency-agents` | MIT | ~230 persona markdown files across 18 divisions + shell installers for 14 host tools | **Vendor a curated subset** (6 already vendored; +8 in 8E.3) — added to this step 2026-08-17 |

Two of the three cannot become dependencies without breaking rules already in the
root `CLAUDE.md`: prime-agent's installer is `curl -fsSL … | sh` (forbidden
outright, and Hermes-Agent is the single deliberate external-engine exception),
and TencentDB-Agent-Memory needs Docker plus its own LLM keys, which breaks
open-source portability and puts a second source of truth beside the vault.

**The finding that reframes the work: MYTHOS already has most of what these repos
are known for.** `src/core/skills/loader.js` is multi-root skill resolution with
progressive disclosure — prime-agent's own shape. `memory/index.js:243`
`recallHybrid()` already fuses keyword and vector ranking with reciprocal-rank
fusion, which is TencentDB's headline retrieval design. `Identity/operator-profile.txt`
— written whole by `identity/reflection.js`, folded into `persona()` — is already
TencentDB's "L3 long-term persona" and it reaches every surface. So step 8 is
gap-closing, not importing.

### The two bugs found while planning (reproduced, not theorised)

Both are **live today** and both are cheap. They are the reason lane 8A is first.

**BUG-266 — the prompts name skills that do not exist on a fresh clone.**
Reproduced by running the real loader with `USERPROFILE`/`HOME` pointed at a
non-existent directory (i.e. any machine without the operator's `~/.claude/skills`):

```
resolved: 43
missing OPTIONAL: ["ui-ux-pro-max","frontend-patterns","frontend-ui-engineering",
                   "design-system","deep-research","spec-driven-development",
                   "planning-and-task-breakdown","tdd-workflow","code-review"]
prompt-named ui-ux-pro-max            -> PHANTOM
prompt-named frontend-ui-engineering  -> PHANTOM
prompt-named spec-driven-development  -> PHANTOM
prompt-named tdd-workflow             -> PHANTOM
prompt-named deep-research            -> PHANTOM
prompt-named code-review              -> PHANTOM
```

Six of those are hardcoded by name into prompt text the model reads every turn —
`voice/voice-agent.js:275` (the SKILLS RULE paragraph), `voice/voice-agent.js:93`
and `effectors/from-skills.js:37`. They resolve on the authoring machine from the
host CLI's skill directory, so the defect is **invisible here and fires on every
fresh clone**. It is the shape already recorded in this repo's history as
*withheld read tools get substituted*: the model does not report the miss, it
picks the nearest thing and narrates it.

`ui-ux-pro-max` is phantom **on this machine too**: `mythos/skills/ui-ux-pro-max/`
holds `LICENSE` + `SKILL-CORE.md` only, and `loadContent()` reads `SKILL.md`
exclusively — so `use_skill('ui-ux-pro-max')` answers "not found" for a skill that
is vendored and is driving every UI build through `loadEssence()`. The loader
disagrees with itself about whether a skill exists.

**BUG-267 — the Live/spoken path is told to call a tool it was never given.**
`buildLiveSystemInstruction()` injects `skillsLoader.catalogBlock()`, whose header
reads *"SKILLS AVAILABLE … call use_skill with the name to load full guidance"*
(`loader.js:392`). But `use_skill` sits in `VOICE_ALLOWLIST_EXEMPT`
(`voice/live-tools.js:252`, rationale "internal/debugging surface") and Live's
`functionDeclarations` are built from `DEFAULT_ALLOWLIST` only
(`server/index.js`, the `buildFunctionDeclarations` call). So the **primary
spoken surface** receives a catalogue of 43 skills plus an instruction to call a
function it does not have. Same substitution failure mode, on the surface the
operator actually uses.

*(Line numbers above were correct at `81cf4d5`. `server/index.js` moves often —
re-grep for `function buildLiveSystemInstruction` and `'use_skill'` before
editing, per the concurrent-session rule.)*

### Anti-Drift Contract — AD-11 … AD-16

AD-1 … AD-10 (V2 spine §1) apply unchanged and are not restated. Step 8 introduces
state that is **read by the model and editable by the model**, which AD-1…10 does
not cover. These six extend it. **They are additions to the spine's §1 table and
are mirrored there** — if the two ever disagree, the spine wins (precedence rule).

| ID | Invariant | Enforcement |
|---|---|---|
| **AD-11** | **Additive overlay only.** The harness overlay is *appended* to a composed prompt. It can never replace, reorder or edit `RULES`, `persona()`, or the capability digest. | `test/anti-drift-harness-additive.test.js`: compose the Live instruction with and without a non-empty overlay; assert the `RULES` and persona substrings are byte-identical in both, and that the overlay appears only as a suffix segment. |
| **AD-12** | **No unevidenced refinement.** `harness.refine()`/`propose()` refuses any refinement whose `evidence[]` is empty or names episodic/lesson/skill ids that do not resolve in the vault. Refusal emits `health.anomaly` `harness-refine-unevidenced`. | `test/harness-refine-evidence.test.js`: submit `evidence: []`, then a fabricated `ep-…` ref; assert both rejected, overlay unchanged on disk, anomaly emitted. |
| **AD-13** | **One composer, one path literal.** `Harness/overlay.md` is read and written in exactly one module. No second reader may re-implement composition. | `test/anti-drift-harness-single-composer.test.js`: read every file under `src/` + `server/`; assert the literal `Harness/overlay` appears only in `src/core/harness/index.js`. Mirrors AD-1's `effectors.invoke(` sweep. |
| **AD-14** | **Every prompt-injected memory block is budgeted and states what it dropped.** No block may silently truncate; the omitted count appears in the emitted text. | `test/memory-budget.test.js`: 200 items against a 500-char cap; assert output ≤ cap and the trailing `[N older entries omitted…]` marker present with N correct. |
| **AD-15** | **A limit is not a success.** A run ending by exhausting a turn/token/wall budget reports `status:'budget-exhausted:<dimension>'`, never `COMPLETED`; a passed gate is credited only with what that gate checked. | `test/agent-budget-gates.test.js`: exhaust each dimension; assert the engagement lands `BLOCKED` with the named reason and never `COMPLETED`. |
| **AD-16** | **Nothing the model reads is invisible to the operator.** Any model-editable prompt state is readable through a HUD route and included in the vault export. | `test/harness-route.test.js`: `GET /api/harness` returns the current overlay text, the snapshot list and the refinement ledger. |

Two of these exist because of scars already in this repo. AD-13 is the `Harness/`
restatement of *a loader pointed at one root fails silently forever*. AD-16 exists
because **a loader that cannot find anything returns exactly what a loader with
nothing to find returns** — an invisible overlay would be that same trap wearing a
new filename.

**AD-17 … AD-21 — added the same day, for lanes 8E and 8F** (the Agency roster and
the four TencentDB assets 8A-8D did not take). Same rule as above: these are
additions to the spine's §1 table, mirrored there, and **the spine wins** on any
disagreement.

| ID | Invariant | Enforcement |
|---|---|---|
| **AD-17** | **One persona loader.** Every persona — tracked default, operator edit, or vendored Agency body — resolves through `src/core/agents/personas.js`. No second reader, no inline `path.join` to a persona directory anywhere else. Two persona layers that cannot see each other is the state 8E exists to end; a third would restore it. | `test/anti-drift-persona-single-loader.test.js`: read every file under `src/` + `server/`; assert persona-directory path construction appears only in `agents/personas.js`. Same sweep shape as AD-13. |
| **AD-18** | **A routed seat says which seat it is and why.** Persona selection writes the chosen role **and** the matched reason into the kanban/mission record. No silent default. A router whose choice is invisible is indistinguishable from the two-way keyword coin flip it replaced — which is exactly how `backend-builder` came to build every security card without anyone noticing. | `test/persona-router.test.js`: assert role + reason present for a matched card and for a zero-hit card (where the reason is the fallback, stated as such). |
| **AD-19** | **A skill body is never overwritten without keeping its predecessor.** A body/steps change snapshots the previous version first; a use-counter update does **not** snapshot. Both halves are load-bearing: without the first, a worse distillation silently destroys a better one; without the second, `recordUse()` writes thousands of version files a week. | `test/skills-versioning.test.js`: write → rewrite with different steps → assert exactly one version file; then 50 `recordUse()` calls → assert still exactly one. |
| **AD-20** | **A graph answer carries its freshness.** Every CodeGraph result states the index timestamp and file count, and a query naming a file that is not in the index returns a distinct "not indexed" shape — never an empty edge set. An empty result and an unindexed target must never look identical; that equivalence is the same dishonest-empty trap AD-16 names one layer up. | `test/codegraph-freshness.test.js`: query an un-indexed file; assert the not-indexed shape, not `[]`. Assert timestamp + file count on a normal hit. |
| **AD-21** | **A scope filter removes, never fabricates, and states what it withheld.** A scoped recall is a strict subset of the same unscoped recall and reports how many records scope withheld. A filter that silently shrinks recall is indistinguishable from an empty vault. | `test/memory-scope-filter.test.js`: same query scoped vs unscoped; assert subset, and assert the withheld count is reported and non-zero when records were excluded. |

### Architecture and infrastructure

**Infrastructure delta: none.** No new npm dependency, no service, no port, no
Docker image, no model download. All new state is files under the existing vault
root reached through the existing `createFsStore` surface, so `MYTHOS_VAULT_ROOT`,
the Electron userData vault, atomic writes, archiving and pruning keep working
unmodified. This is deliberate: TencentDB's Hub and prime-agent's daemon are
precisely the parts that cannot ship inside an installer the operator sells
(step 6.5/6.6 territory).

```
                    ┌──────────────────── vault/ ────────────────────┐
                    │ Episodic/  Semantic/  Lessons/  Skills/         │  existing
                    │ Identity/{self.md, operator-profile.txt}        │  existing
                    │ Harness/{overlay.md, snapshots/, refinements.jsonl}  NEW (8B)
                    │ Semantic/scenarios/<slug>.md                    │  NEW (8C.3, provisional)
                    └────────────────────────────────────────────────┘
                                       │ createFsStore (unchanged seam)
        ┌──────────────────────────────┼───────────────────────────────┐
        │                              │                               │
  memory/index.js               harness/index.js  NEW           skills/loader.js
  (episodic, semantic,          overlayBlock() / propose()      (unchanged roots,
   lessons, recallHybrid)       / apply() / rollback()           + SKILL-CORE fallback)
        │                              │                               │
        └──────────► memory/budget.js NEW (AD-14) ◄────────────────────┘
                                       │
             ┌─────────────────────────┴──────────────────────────┐
             │                                                    │
   server/index.js                                       voice/voice-agent.js
   buildLiveSystemInstruction()                          per-turn prompt composer
   (spoken / Live, session-start labelled)               (typed / batch, fresh)
             │                                                    │
             └──────────► identical block content, one composer ───┘
                                       │
                             live-session.js buildSetup()
                                       │
                      Gemini Live  ◄───┴───►  functionDeclarations
                                              (DEFAULT_ALLOWLIST + use_skill, 8A.3)

  Execution side (8D):
   agent/budget.js NEW ──► engagements/executor.js (repair budget, verify sweep)
   agent/gates.js  NEW ──► gate commands run through the EXISTING run_command
                           effector (allowlist + metachar reject + cwd pin +
                           env scrub + leash + treeKill) — never a new spawn path
```

**New config keys — all optional, all defaulted** (`config/schema.js`, plus an
`.env.example` line each; no key means the default, never a silent disable):

| Key | Default | Purpose |
|---|---|---|
| `HARNESS_ENABLED` | `true` | Master switch for 8B. `false` → `overlayBlock()` returns `''`. |
| `HARNESS_MAX_CHARS` | `4000` | Overlay budget cap (AD-14). |
| `LIVE_EPISODIC_MAX_CHARS` | `3000` | Cap for the new Live episodic block (8C.2). |
| `LIVE_LESSONS_MAX` | `5` | Item cap for the new Live lessons block (8C.2). |
| `AGENT_MAX_WALL_MS` | `1800000` | 8D wall-clock budget; matches today's `buildTimeoutMs()`. |

---

### Step 8A — Skills truth + curated vendoring (addyosmani/agent-skills)

- [ ] **8A.1 — Stop hardcoding skill names in prompts (BUG-266a).**

  **Attach first — what reads what.** Three prompt sites hardcode example names;
  one catalogue function is the single honest source of what actually resolved.

  | Site | Today | Consumers |
  |---|---|---|
  | `skills/loader.js:389 catalogBlock()` | emits only skills that **resolved** | `server/index.js` (Live), `voice-agent.js` (batch), `identity/capabilities.js:162` |
  | `voice/voice-agent.js:275` SKILLS RULE | names 5 skills verbatim | the batch/typed prompt |
  | `voice/voice-agent.js:93` `use_skill` decl | names 3 verbatim | batch tool declarations |
  | `effectors/from-skills.js:37` tool description | names 3 verbatim | every surface declaring `use_skill`, incl. Live after 8A.3 |

  Derive the examples from the same resolved catalogue the block already uses, so
  a name can never appear in prose without existing on disk:

  ```js
  // skills/loader.js — add next to catalogBlock()

  // Example names for prompt prose. Derived from the RESOLVED catalog, never
  // hand-typed: BUG-266 was five skill names written into RULES that resolve on
  // the author's machine (~/.claude/skills) and are PHANTOM on a fresh clone, so
  // the model was instructed every turn to call use_skill on something that
  // answers "not found". A hardcoded example name is a claim about another
  // machine's disk. `prefer` is a wish list, not a guarantee — anything in it
  // that did not resolve is dropped and the catalog head fills the remainder.
  function exampleNames(prefer, limit) {
    var have = {};
    loadCatalog().forEach(function(s) { have[s.name] = true; });
    var cap = limit || 3;
    var out = (prefer || []).filter(function(n) { return have[n]; });
    if (out.length < cap) {
      loadCatalog().forEach(function(s) {
        if (out.length >= cap) return;
        if (out.indexOf(s.name) === -1) out.push(s.name);
      });
    }
    return out.slice(0, cap);
  }
  ```

  Each prompt site then interpolates instead of asserting:

  ```js
  // voice/voice-agent.js — SKILLS RULE (was: a fixed list of five names)
  var eg = skillsLoader.exampleNames(
    ['ui-ux-pro-max', 'spec-driven-development', 'test-driven-development'], 3);
  var SKILLS_RULE = 'SKILLS RULE: You have SKILLS available (listed in the SKILLS ' +
    'AVAILABLE block). When a task fits one — e.g. ' + eg.join(', ') + ' — call ' +
    'use_skill with that name to load its full guidance, then apply it. Only ever ' +
    'call use_skill with a name from that block.';
  ```

  The trailing sentence is load-bearing: it is what stops the model inventing a
  plausible skill name when the one it wanted is absent.

  **Test (red first):** `test/skills-prompt-names.test.js` — with
  `USERPROFILE`/`HOME` forced to a non-existent dir and `MYTHOS_SKILLS_DIR` empty
  (the fresh-clone shape that found this), extract every quoted skill-like token
  from the composed batch prompt, the `use_skill` declaration and the Live
  instruction, and assert each is in `loadCatalog()`. **This test fails today** —
  that red is the proof.

- [ ] **8A.2 — An essence-only skill must still load (BUG-266b).**

  ```js
  // skills/loader.js — loadContent(), after the SKILL.md attempt fails
    } catch (_) { /* no SKILL.md anywhere — try the vendored essence below */ }
    // Essence-only vendoring is a real, documented state (skills/README.md:
    // "SKILL-CORE.md — a hand-distilled ~1-2 KB essence"), and ui-ux-pro-max ships
    // exactly that, because its full 45 KB doc needs a Python CSV database this
    // repo does not carry. Reading only SKILL.md made use_skill report "not found"
    // for a skill that IS vendored and IS driving every UI build through
    // loadEssence(). Say it is the essence, so the model does not treat 1 KB as
    // the whole guidance.
    try {
      var essence = fs.readFileSync(path.join(REPO_SKILLS_DIR, name, 'SKILL-CORE.md'), 'utf8');
      if (essence.trim()) {
        return '(Condensed essence — the full skill needs a host install of its own ' +
          'tooling; this is the complete guidance available on this machine.)\n\n' +
          essence.trim();
      }
    } catch (_) { /* no essence either */ }
    return null;
  ```

  **Consumers checked:** `loadContent()` has exactly one caller,
  `effectors/from-skills.js:22`. Nothing parses its return value, so the prefix
  line is safe. `loadEssence()` is untouched.

- [ ] **8A.3 — Give the spoken path the tool its own prompt names (BUG-267).**

  `use_skill` is **T0** (`leash/tiers.js:71`, "read-only — loads a skill's guidance
  text from disk"), so there is no safety argument for withholding it — only the
  tool-count argument in `live-tools.js:15-18`, which is outweighed here because
  the Live prompt already spends the tokens listing 43 skills. Move `'use_skill'`
  out of `VOICE_ALLOWLIST_EXEMPT` into `DEFAULT_ALLOWLIST` with this rationale in
  place of the old exempt comment:

  ```js
    // use_skill — promoted (BUG-267). It was exempt as an "internal/debugging
    // surface", but buildLiveSystemInstruction() injects catalogBlock(), whose
    // header instructs the model to "call use_skill with the name". Declaring the
    // catalog while withholding the tool is the withheld-read-tool trap: the model
    // does not report the gap, it substitutes the nearest tool and narrates it.
    // Either the catalog goes or the tool comes — the catalog is 43 real skills,
    // so the tool comes. T0 (leash/tiers.js:71), so this adds no confirm.
    'use_skill',
  ```

  **Consumers checked before moving it:** `DEFAULT_ALLOWLIST` is read by
  `buildFunctionDeclarations()` (`live-tools.js`), called from `server/index.js`.
  Two existing conformance sweeps gate this list and validate the move for free —
  `test/allowlist-reachability.test.js` (fails when a T0–T2 tool is in neither
  list) and `test/tier-table-conformance.test.js`. Both already
  `require('../src/core/effectors/from-skills')`.

  **Alternative rejected:** suppressing `catalogBlock()` on Live. One line
  cheaper, but it makes the primary surface the only one with no skills at all —
  the opposite of the wiring being asked for.

- [ ] **8A.4 — Vendor the curated addyosmani subset.**

  Five are already vendored (`THIRD_PARTY_NOTICES.md:203`). Six more earn a slot;
  each is justified against `build-pack.js:24-41`'s essence-vs-tool-driver rule
  and against what is already on disk.

  | Skill | Why it earns a slot | Pack |
  |---|---|---|
  | `spec-driven-development` | Named in two prompts today and phantom on a fresh clone (BUG-266); also the natural front end of the engagement `SPEC_READY` state | `app` |
  | `planning-and-task-breakdown` | Feeds `engagements/plan-builder`; already `?`-listed, never vendored | `app` |
  | `incremental-implementation` | Thin vertical slices with a test/commit cycle — the discipline the engagement stage model assumes but never states to the model | `app` |
  | `doubt-driven-development` | Adversarial fresh-context review before finalising; direct analogue of AD-4 and of `effectors/evidence.js`. Wired into 8D's verify gate | `app`, `security` |
  | `context-engineering` | Governs every budget decision in 8C; the repo has no written rule for what belongs in a prompt | `research` |
  | `frontend-ui-engineering` | Named in `voice-agent.js:275`, phantom today, `?`-listed | `ui` |

  Also vendor `references/definition-of-done.md` as
  `mythos/skills/definition-of-done/SKILL.md` — it is the checklist 8D's gate
  runner needs and otherwise has no home.

  **Deliberately NOT vendored, reason recorded so a later session does not
  "helpfully" add them:** `debugging-and-error-recovery` duplicates the vendored
  superpowers `systematic-debugging`; `code-simplification` duplicates `ponytail`;
  `security-and-hardening`, `performance-optimization`, `code-review-and-quality`,
  `api-and-interface-design`, `observability-and-instrumentation` are already
  vendored; `git-workflow-and-versioning`, `ci-cd-and-automation`,
  `documentation-and-adrs`, `deprecation-and-migration`, `shipping-and-launch`,
  `browser-testing-with-devtools`, `interview-me`, `idea-refine`,
  `source-driven-development` stay `?`-optional — real skills, but nothing on the
  MYTHOS execution path reads them, and a catalogue entry the model never needs
  is prompt tax on every turn.

  **Mechanics per skill — the repo already documents this exactly
  (`mythos/skills/README.md:47-58`); follow it verbatim, invent no new process:**
  1. `mythos/skills/<name>/SKILL.md`, upstream text verbatim, frontmatter `name`
     matching the directory, `description` collapsed to one quoted line.
  2. `mythos/skills/<name>/LICENSE` — upstream MIT, copied.
  3. `SKILL-CORE.md` — **required** for any skill added to a `PACKS` entry, since
     `packBlockFor()` composes essences under an 8 000-char cap
     (`build-pack.js:86`) and a 20 KB upstream body would evict the packs already
     carrying every build.
  4. One line in `mythos/skills.allowlist` under a new
     `# ---- Engineering discipline (addyosmani/agent-skills, MIT) ----` block —
     and **remove** the now-redundant `?spec-driven-development`,
     `?planning-and-task-breakdown`, `?frontend-ui-engineering` entries so the
     same name is not listed twice.
  5. Extend the existing `THIRD_PARTY_NOTICES.md:203` row; do not add a second
     addyosmani row.
  6. Add rows to `mythos/skills/README.md`'s "Copied from upstream" table — which
     today is **missing the five already-vendored addyosmani skills**, a doc gap
     this lane closes on the way past.

  ```js
  // skills/build-pack.js — PACKS, after vendoring
  var PACKS = {
    ui: ['taste-frontend', 'hallmark', 'ui-ux-pro-max', 'frontend-ui-engineering', 'diagram-design'],
    code: ['ponytail', 'karpathy-guidelines'],
    // spec/plan/slice discipline. Order matters: the cap drops from the TAIL, so
    // the ones that change what gets BUILT come before the ones that change how
    // it is REVIEWED.
    app: ['ponytail', 'karpathy-guidelines', 'incremental-implementation',
          'spec-driven-development', 'planning-and-task-breakdown',
          'systematic-debugging', 'doubt-driven-development',
          'verification-before-completion'],
    research: ['ponytail', 'karpathy-guidelines', 'context-engineering'],
    security: ['ponytail', 'karpathy-guidelines', 'strix-security', 'doubt-driven-development'],
  };
  ```

  `packBlockFor()` already names anything it dropped for budget
  (`build-pack.js:257`), so an over-long `app` pack degrades visibly — but
  **measure the real composed size against `MAX_PACK_CHARS` and raise the cap in
  the same commit if the tail is being dropped on every build.** Add a case to
  `test/skills-build-pack.test.js` asserting `app` composes under cap with
  **nothing dropped**, so a future essence pushing it over is caught at commit
  time rather than discovered as missing discipline.

---

### Step 8B — Continual Harness (prime-agent's `/refine`)

- [ ] **8B — supplemental, evidence-backed, snapshotted prompt state.**

  What prime-agent does:

  > "`/refine` reviews the current trajectory and can apply small, evidence-backed
  > updates to supplemental harness state. It never rewrites the immutable base
  > system prompt, and recorded snapshots support rollback."

  MYTHOS has three of the four pieces and they are good: `Lessons/` is durable
  failure memory with trigger matching and counts (`memory/lessons.js`);
  `vault/Skills/` is auto-distilled procedural success (`memory/skills.js`,
  written by `goals/index.js:176` and `identity/reflection.js:259`);
  `Identity/self.md` + `operator-profile.txt` carry durable identity.

  **The missing piece is the one prime-agent centres on:** a supplemental overlay
  the entity can propose changes to, that carries its evidence, that rolls back,
  and that actually reaches the model on the spoken path. Today `Lessons/` has
  **exactly one reader** — the autonomous goal planner (`goals/index.js:456`) — so
  a lesson learned the hard way never reaches a conversation. That is the same
  structural amnesia BUG-251 fixed for operator facts, one store over.

  **New module `src/core/harness/index.js`** — `vault/Harness/overlay.md` (what the
  model reads), `vault/Harness/snapshots/<ts>.md` (one per applied refinement),
  `vault/Harness/refinements.jsonl` (the ledger: who/when/why/evidence). API:
  `init()`, `overlayBlock({asOf})`, `propose({note, evidence, source})`,
  `apply(id)`, `rollback(snapshotId)`, `ledger()`, `overlayText()`.

  Two functions carry the invariants and are worth writing first:

  ```js
  // AD-12. An id that does not resolve in the vault is not evidence — it is a
  // sentence that LOOKS like evidence, which is worse than none. Without this the
  // entity can write itself any instruction it likes and call it learning.
  function evidenceResolves(refs) {
    if (!Array.isArray(refs) || refs.length === 0) return false;
    return refs.every((ref) => {
      try {
        if (/^ep-/.test(ref)) return !!memory.episodic.get(ref);
        if (/^lsn-/.test(ref)) return !!memory.lessons.get(ref);
        if (/^sk-/.test(ref)) return !!memory.skills.get(ref);
      } catch (_) { return false; }
      return false;
    });
  }

  // Snapshot BEFORE write is what makes rollback real rather than a promise in a
  // comment. apply() is the only writer of overlay.md (AD-13).
  apply(id) {
    const rec = this.ledger().find((r) => r.id === id && r.status === 'proposed');
    if (!rec) return { ok: false, error: 'no proposed refinement ' + id };
    const before = fs.readText(OVERLAY_PATH, '');
    const snapId = String(rec.ts) + '-' + id.slice(4, 12);
    fs.writeText(SNAPSHOT_DIR + '/' + snapId + '.md', before);
    fs.writeText(OVERLAY_PATH, (before ? before.replace(/\s*$/, '\n') : '') + '- ' + rec.note + '\n');
    fs.appendLine(LEDGER_PATH, Object.assign({}, rec, {
      status: 'applied', appliedAt: Date.now(), snapshot: snapId,
    }));
    return { ok: true, id, snapshot: snapId };
  }
  ```

  **Wiring — every writer, every reader, every gate.**

  *Construction:* `src/main.js`, beside the memory facade; `harness` joins the deps
  object passed to the server exactly as `memory` and `identity` do. `init()` runs
  in the same boot step as `memory.init()`.

  *WRITER 1 — the operator, by voice or HUD.* New effector
  `src/core/effectors/from-harness.js` exposing `refine_harness` with
  `action: propose | apply | rollback | list`, registered next to
  `registerFromSkills(hub)` (`main.js:579`). Tiering:

  ```js
    'refine_harness':        3,  // edits what the model is told about itself.
                                 // Local and snapshot-reversible, so not T4 — but
                                 // never session-grantable: a tool that rewrites
                                 // its own operating instructions must not become
                                 // click-through after the first yes.
  ```

  and add `'refine_harness'` to `NEVER_TRUSTABLE` in `leash/index.js`, so
  `TRUSTED_TOOLS` cannot promote it and `SESSION_GRANTABLE` cannot cache it. It
  **is** added to `DEFAULT_ALLOWLIST` (spoken-reachable) — "remember to always do
  X" is a natural spoken instruction — and T3 + never-trustable means the operator
  confirms every single time, which is the correct friction for self-modification.
  `test/tier-table-conformance.test.js` and `test/allowlist-reachability.test.js`
  enforce both of the above with no new test written.

  *WRITER 2 — reflection, as proposals only.* `identity/reflection.js:164-282`
  (`reflectOnActions`) already asks the brain for `{failures[], successes[]}` and
  writes failures to `Lessons/`, successes to `vault/Skills/`. Add a third bucket,
  `corrections[]` → `harness.propose({source:'reflection', evidence:[…]})`. Status
  stays `proposed`; **nothing machine-authored is ever auto-applied.** The episodic
  ids reflection already carries become the AD-12 evidence, so this costs no new
  plumbing.

  *READER 1 — the spoken path.* In `buildLiveSystemInstruction()`, after the
  operator-facts block and before the local-time line:

  ```js
      // The harness overlay — durable operating notes refined from real sessions.
      // Session-start labelled per BUG-136 like every other value in this
      // composer, and budgeted per AD-14. Synchronous by construction: this
      // function is called from live-session.js buildSetup() on every open() and
      // rotation and cannot await — the same constraint that made BUG-251's fix a
      // direct topic() read rather than recallHybrid().
      try {
        const overlay = harness ? harness.overlayBlock({ asOf: 'session-start' }) : '';
        if (overlay) parts.push(overlay);
      } catch (err) { logger.warn('live.harness-compose-failed', { error: err.message }); }
  ```

  *READER 2 — the typed/batch path.* `voice/voice-agent.js`'s per-turn composer
  appends `harness.overlayBlock()` with **no** `asOf` label — it genuinely is fresh
  there, and labelling a live value as a snapshot is its own small lie.

  *READER 3 — the operator (AD-16).* `server/routes/memory.js` gains
  `GET /api/harness` → `{ overlay, snapshots[], ledger[] }`, plus a HUD panel
  entry. Not optional polish: it is the difference between an auditable overlay
  and a file that quietly steers every answer.

  *Deliberately NOT wired:* the autonomous goal planner. It already reads
  `Lessons/` with a hard pause at `GOAL_FAIL_PAUSE_THRESHOLD`; a second overlapping
  instruction source on the same decision would make it impossible to say which one
  paused a goal. A planner overlay, if ever wanted, needs its own file and its own
  reason.

  *Tests:* `harness-store.test.js` (propose/apply/rollback/ledger round trip),
  `harness-refine-evidence.test.js` (AD-12),
  `anti-drift-harness-additive.test.js` (AD-11),
  `anti-drift-harness-single-composer.test.js` (AD-13),
  `harness-route.test.js` (AD-16), plus one case appended to the existing
  `test/live-memory-inject.test.js` — that file already owns this composer's
  contract.

---

### Step 8C — Memory budget + Live depth (TencentDB layering)

- [ ] **8C.1 — One budgeted-block helper (AD-14).**

  Three separate hand-rolled truncation loops exist today: the operator-facts loop
  in `buildLiveSystemInstruction()` (`LIVE_FACTS_MAX_CHARS = 8000`),
  `build-pack.js:235-261` (essences, and **this one is the good example** — it
  names what it dropped), and `loader.js:394` (per-skill description truncation).
  8B and 8C.2 would add three more.

  ```js
  // memory/budget.js — the one truncation rule for anything injected into a
  // prompt (AD-14).
  //
  // Three hand-rolled loops did this before with three different overflow
  // behaviours. Only build-pack.js's said what it dropped; the others truncated in
  // silence, which reads to anyone reading the prompt as "this is everything" when
  // it is not — the same dishonest-ok shape the loader's lastMissing() exists to
  // prevent one layer up.
  //
  // Contract: never exceed maxChars; never exceed maxItems; ALWAYS state the
  // omitted count when anything was dropped.
  function budgetedBlock({ header, items, maxItems, maxChars, newestFirst }) {
    const all = (items || []).map((i) => String(i).trim()).filter(Boolean);
    const ordered = newestFirst ? all.slice().reverse() : all.slice();
    const capItems = maxItems && maxItems > 0 ? maxItems : ordered.length;
    const capChars = maxChars && maxChars > 0 ? maxChars : Infinity;
    const head = String(header || '').trim();

    const kept = [];
    let used = head.length;
    for (const item of ordered) {
      if (kept.length >= capItems) break;
      const line = item.startsWith('- ') ? item : '- ' + item;
      if (used + line.length + 1 > capChars) break;
      used += line.length + 1;
      kept.push(line);
    }
    const omitted = all.length - kept.length;
    if (!kept.length) return { text: '', included: 0, omitted: all.length };

    // newestFirst callers want the newest KEPT but chronological reading order.
    const body = (newestFirst ? kept.slice().reverse() : kept).join('\n');
    const note = omitted > 0 ? '\n[' + omitted + ' older entries omitted for prompt budget]' : '';
    return { text: head + '\n' + body + note, included: kept.length, omitted };
  }
  ```

  **Converted in the same commit** (a replacement, not an addition — leaving the
  old loops is how two truncation rules drift apart): the operator-facts loop, the
  8B overlay, both 8C.2 blocks. **`build-pack.js`'s loop stays as-is** — it
  composes whole documents with a separator rather than bullet items, and forcing
  it through this helper would rewrite working code for symmetry, which the
  surgical-changes rule forbids.

- [ ] **8C.2 — Give Live the depth the typed path already has.**

  Measured gap: `handleUtterance()` calls `recallHybrid()` per turn, so the typed
  path gets episodic + semantic + documents fused by RRF. Live gets one static
  `user-facts.md` snapshot per socket open, and `Lessons/` reaches neither. Two
  blocks, both **synchronous** reads (no embeddings — the session-open path cannot
  await, per the BUG-251 reasoning already written into that composer):

  ```js
      // Recent episodic context. The typed path gets recallHybrid() per turn; Live
      // got nothing, so "what were we doing yesterday" had no honest answer on the
      // surface most likely to be asked it. tail() is a bounded reverse read.
      try {
        const recent = (memory.episodic.tail({ limit: 40 }) || [])
          .filter((e) => e.kind === 'conversation' && e.summary);
        const block = budget.budgetedBlock({
          header: 'RECENT CONTEXT (as of session-start — use recall_memory for anything older):',
          items: recent.map((e) => e.summary),
          maxItems: 12,
          maxChars: Number(config.LIVE_EPISODIC_MAX_CHARS) || 3000,
          newestFirst: true,
        });
        if (block.text) parts.push(block.text);
      } catch (err) { logger.warn('live.episodic-compose-failed', { error: err.message }); }

      // Repeated failures. Lessons/ has exactly one reader today (goals/index.js:456,
      // the autonomous planner), so a failure the operator watched happen three
      // times never reached the conversation about it. Highest count first.
      try {
        const top = (memory.lessons.recall('', { limit: Number(config.LIVE_LESSONS_MAX) || 5 }) || [])
          .filter((l) => (l.count || 0) > 1);
        const block = budget.budgetedBlock({
          header: 'KNOWN FAILURE MODES (seen before — do not repeat):',
          items: top.map((l) => l.text + ' (seen ' + l.count + 'x)'),
          maxItems: Number(config.LIVE_LESSONS_MAX) || 5,
          maxChars: 1200,
        });
        if (block.text) parts.push(block.text);
      } catch (err) { logger.warn('live.lessons-compose-failed', { error: err.message }); }
  ```

  **Check before writing:** `memory.lessons.recall(query, opts)` is called with a
  non-empty query at its only current call site (`goals/index.js:456`). Confirm
  `lessons.js:208` returns count-ordered results for an empty query; if it does
  not, add an explicit `topByCount(limit)` rather than bending `recall()` — **the
  planner's behaviour must not change as a side effect of a prompt feature.**

  **Prompt-budget accounting, stated rather than assumed:** these two blocks plus
  8B's overlay add at most 3000 + 1200 + 4000 ≈ 8.2 KB to a frame already carrying
  RULES + persona + capability digest + a 43-skill catalogue + up to 8 KB of facts.
  Paid **once per session**, not per turn (the composed-once frame, V2 §11 row 5).
  If the frame gets uncomfortable the lever is `LIVE_FACTS_MAX_CHARS`, which at
  8000 is the largest single block and the least selective. **Measure the composed
  length in the test and log it; do not guess.**

- [ ] **8C.3 — L2 scenario blocks. PROVISIONAL — verify the gap before building.**

  TencentDB's model is L0 raw → L1 facts/preferences/constraints → L2
  scenario-organised blocks → L3 long-term persona. Mapped honestly:

  | Layer | MYTHOS today | Status |
  |---|---|---|
  | L0 | `Episodic/*.jsonl` | exists |
  | L1 | `Semantic/user-facts.md` (`habit-promoter.js` + `memory/index.js:374`) | exists |
  | L2 | — | **the only real gap** |
  | L3 | `Identity/operator-profile.txt`, rewritten whole by `reflection.js`, folded into `persona()` | **already exists** |

  Three of four layers are already built. L2 would be
  `Semantic/scenarios/<slug>.md` — clusters of related L1 facts and episodics under
  a scenario heading — produced by extending the `consolidate()` that
  `cortex/index.js:413` already calls on its idle path.

  **Sequenced last and marked provisional on purpose.** 8C.2 gives Live real
  episodic recall for the first time; that may close the felt gap entirely, in
  which case L2 is a second index over data the model can already reach — exactly
  the speculative abstraction the simplicity rule forbids. **Do not build 8C.3
  until 8C.2 is live-verified and found insufficient, and record which observation
  made it necessary.**

---

### Step 8D — Budgets and quality gates (prime-agent autonomous mode)

- [ ] **8D — one budget, gates that must pass, and "a limit is not a success".**

  **What exists first.** Three unrelated bounded-retry counters, none aware of the
  others: `engagements/executor.js:50` `MAX_REPAIRS` (default 3) with
  `execution.repairBudget:{used,max}` in the record; `build-runner.js:48`
  `REFINE_MAX`; `hermes-runner.js:40` `buildTimeoutMs()` (30 min) plus
  `hermes-agent/index.js:41` `taskTimeoutMs()` (3 min). Verification already exists
  as `executor.js:393-455 runCommandVerification()`, which runs an allowlisted
  command through the real `run_command` effector and degrades honestly to
  `skipped:true` when `RUN_COMMAND_ALLOWLIST` is unset. That is a good foundation.

  What prime-agent adds: one budget spanning turns/tokens/wall-clock; gates that
  must pass before a run may finish; **not re-running a gate whose inputs have not
  changed since it failed**; and the explicit rule that hitting a limit is not
  success.

  ```js
  // agent/budget.js
  // AD-15 is the whole point: "reaching a limit does not imply task success."
  // Three separate counters existed before this and none could answer "how much
  // budget does this work have left" — so a run could exhaust one, look finished,
  // and be reported as done.
  function createBudget({ maxTurns, maxTokens, maxWallMs, now }) {
    const clock = now || (() => Date.now());
    const startedAt = clock();
    let turns = 0, tokens = 0;
    return {
      spendTurn() { turns += 1; },
      spendTokens(n) { tokens += Number(n) || 0; },
      remaining() {
        return {
          turns: maxTurns ? Math.max(0, maxTurns - turns) : Infinity,
          tokens: maxTokens ? Math.max(0, maxTokens - tokens) : Infinity,
          wallMs: maxWallMs ? Math.max(0, maxWallMs - (clock() - startedAt)) : Infinity,
        };
      },
      // Named, not boolean: the caller must report WHICH limit stopped it. A bare
      // `true` is how "we ran out of time" becomes "we finished".
      exhausted() {
        const r = this.remaining();
        if (r.turns <= 0) return 'turns';
        if (r.tokens <= 0) return 'tokens';
        if (r.wallMs <= 0) return 'wall-clock';
        return null;
      },
    };
  }
  ```

  ```js
  // agent/gates.js
  // The one non-obvious rule, straight from prime-agent: a gate that failed and
  // whose INPUTS have not changed is not re-run. Re-running burns budget to
  // re-learn something already known and — worse — a gate that passes on a retry
  // with identical inputs is measuring flake, not progress.
  //
  // Gates execute through the EXISTING run_command effector (allowlist + metachar
  // rejection + cwd pin + env scrub + leash + treeKill). No new spawn path: a
  // second way to run a shell command is a second place for the allowlist to not
  // apply.
  async function runGates(gates, { dispatch, budget, inputsHash, priorResults }) {
    const results = [];
    for (const gate of gates || []) {
      const prior = (priorResults || []).find((r) => r.id === gate.id);
      if (prior && !prior.passed && prior.inputsHash === inputsHash) {
        results.push(Object.assign({}, prior, { skipped: 'unchanged-since-failure' }));
        continue;
      }
      const stop = budget.exhausted();
      if (stop) { results.push({ id: gate.id, passed: false, reason: 'budget-exhausted:' + stop }); break; }
      const out = await dispatch({ tool: 'run_command', args: gate.args });
      results.push({
        id: gate.id, passed: !!out.ok, inputsHash,
        // Bounded on purpose: the failing tail is what the next attempt needs, and
        // an unbounded gate log is how one failure eats the context window.
        output: String(out.result || out.error || '').slice(-2000),
      });
    }
    return results;
  }
  ```

  **Wiring — consumers checked before changing them.** `engagements/executor.js` is
  the single consumer rewired. Its `runVerificationSweep()` (lines 541-590)
  currently decides `COMPLETED` / `REPAIRING` / `BLOCKED`; it gains a budget and a
  gate list, and the rule that a budget stop lands `BLOCKED` with
  `reason:'budget-exhausted:<dimension>'` and **never** `COMPLETED` (AD-15). The
  `repairBudget:{used,max}` field already in the record
  (`engagements/index.js:37-92`) is the natural home for the counters, so the
  persisted shape gains fields rather than changing — existing engagements keep
  loading through `store.js:58 backfillRecord()`.

  **`build-runner.js`'s `REFINE_MAX` and `orchestrator.js` are left alone in this
  lane** — working, on a different execution path (the kanban build queue, not the
  engagement state machine), and folding them in at the same time mixes a refactor
  into a feature. Follow-up, recorded as a decision rather than an oversight.

  `doubt-driven-development` (vendored in 8A.4) is the guidance loaded when a gate
  fails twice with the same `inputsHash` — the point at which "try again" has
  already been proven not to work.

  *Tests:* `test/agent-budget-gates.test.js` — each dimension exhausts to its named
  reason; a failed gate with unchanged `inputsHash` is skipped, not re-run; a
  changed hash re-runs; budget exhaustion lands `BLOCKED` and never `COMPLETED`;
  gate output truncated to 2000 chars. Extend `test/engagements/*` with the
  executor's new terminal reason.

---

### Step 8E — The Agency roster reaches the seats (`msitarzewski/agency-agents`)

> **Added 2026-08-17, same plan-only pass. TRACKED, NOT STARTED, same 6.5/6.6/7
> gate as the rest of step 8.** The operator named a third repo alongside
> prime-agent and TencentDB; research found it **already half-vendored**, which is
> what makes this lane small.

Six Agency personas already ship in this repo: `mythos/skills/persona-frontend-developer`,
`persona-backend-architect`, `persona-ui-designer`, `persona-brand-guardian`,
`persona-reality-checker`, `persona-ui-finish-gate-reviewer` — MIT bodies verbatim,
listed in `mythos/skills.allowlist` under `# ---- Personas (adapted from
msitarzewski/agency-agents, MIT) ----`, credited in `THIRD_PARTY_NOTICES.md`.

**The defect that makes them decorative.** There are two persona layers and they
cannot see each other:

| Layer | Resolved by | Reads | Reaches |
|---|---|---|---|
| Vendored Agency personas | `skills/loader.js` | `mythos/skills/persona-*/SKILL.md` | the model, via `use_skill` — **only if it thinks to ask** |
| Seat personas | `agents/personas.js` | `$MYTHOS_PERSONAS_DIR` → `vault/Personas/` → `mythos/personas/` (4 files) | the reviewer / reality-checker / builder seats, on every build |

So `agent-actions.js` can seat a `reviewer` and a `reality-checker` and two
builders, and nothing else — six vendored personas sit in the skills catalogue
where no seat can reach them. And the router that chooses a builder,
`agents/personas.js:121 pickBuilderPersona()`, is a **two-way keyword coin flip**:
one frontend keyword list, else `backend-builder`. A card about deploying, about
schema, about credentials, about test coverage — all get the backend builder, and
the roster is never consulted. This is the same shape as *personas never loaded*
already recorded in this repo's history: nothing throws, every seat just quietly
degrades to generic.

- [ ] **8E.1 — One persona resolution order (bridge the two layers).**

  `agents/personas.js` gains the vendored persona skills as a **fourth and final
  root**, after the existing three. Order becomes:

  1. `$MYTHOS_PERSONAS_DIR` — explicit override, `path.delimiter`-separated (unchanged)
  2. `mythos/vault/Personas/` — the operator's own edits (unchanged; a customisation
     that loses to a shipped default does nothing)
  3. `mythos/personas/` — tracked defaults (unchanged)
  4. **NEW** `mythos/skills/persona-<role>/SKILL.md` — the vendored Agency bodies

  Four things the lane must get right, each traced to something already known here:

  - **Strip the frontmatter before using the body as a system identity.** These
    files are `SKILL.md`s: they open with `name:`/`description:` YAML that is
    loader metadata, not persona prose. `skills/loader.js` already parses that
    block — reuse it rather than writing a second frontmatter regex.
  - **`isSafeRole()` still gates the role name** (`personas.js:66`). The new root is
    one more `path.join` on the same already-validated value, not a new input path.
  - **Keep caching the miss** (`personas.js:86`). Four roots × a role with no file ×
    the reviewer seat running on every build is a stat storm for nothing.
  - **Prefix mapping is explicit, not clever.** Role `ui-designer` must resolve
    `persona-ui-designer/`; do not accept a bare `persona-` prefix from the caller,
    or the same persona ends up addressable by two names and the cache keys split.

  `listPersonas()` gains the same root so the vendored six become listable — which
  is precisely what 8E.2 needs, and is unreachable today.

  **Consumers checked:** `loadPersona` has four call sites, all in
  `effectors/agent-actions.js` (`:435` reviewer, `:457` reality-checker, `:709`
  builder, `:859` reviewer again) plus a comment reference in `brain/index.js:135`.
  None inspect the string; all pass it as a system identity. So a body that arrives
  from a different root needs no caller change.

- [ ] **8E.2 — A router that states its choice (AD-18).**

  Replace the keyword coin flip with a scored match over `listPersonas()`:

  - Routing terms live in **one** place. Decide at execution time between a
    `Routes:` line inside each persona file and a table in `agents/personas.js` —
    but pick one. Two sources for the same mapping is how a persona ends up
    routable in the table and unroutable in the file.
  - Score = term hits; ties broken by declaration order, so the ordering is
    reviewable rather than emergent.
  - **Zero hits still resolves to `backend-builder`.** Today's default is the
    fail-safe and stays the fail-safe — a router that returns nothing would silently
    drop the persona entirely, which is worse than a generic seat.
  - The chosen role **and the matched reason** are written into the kanban/mission
    record (AD-18), so the Audit view can answer "which seat built this card".

  **Do not change the signature.** `pickBuilderPersona(cardTitle, cardDetail)` has
  exactly one caller (`agent-actions.js:708`); widening it to take the whole card
  is a refactor riding along on a feature.

- [ ] **8E.3 — Vendor eight more personas, each with a named reader.**

  Slot test is 8A.4's, unchanged: **a persona earns a slot when a seat calls it**,
  not when it reads well. Upstream filenames below were enumerated from the real
  tree (`gh api repos/msitarzewski/agency-agents/git/trees/main?recursive=1`) — the
  repo has 18 division directories and ~230 files, and the `tree/main/...` web path
  404s, so enumerate with `gh` or a clone rather than guessing.

  | Upstream file | Vendored as | The reader that exists today |
  |---|---|---|
  | `engineering/engineering-devops-automator.md` | `persona-devops-automator` | build cards about deploy/CI/Docker — today they get `backend-builder` |
  | `engineering/engineering-api-platform-engineer.md` | `persona-api-platform-engineer` | build cards adding routes/effectors; pairs with the vendored `api-and-interface-design` skill |
  | `engineering/engineering-data-engineer.md` | `persona-data-engineer` | ingestion/vault/index cards (`memory/documents.js`, `from-code-search.js` indexing work) |
  | `security/security-appsec-engineer.md` | `persona-appsec-engineer` | security cards; the `security` pack and `strix-security` skill already exist for this lane and have no seat |
  | `security/security-secrets-credential-engineer.md` | `persona-secrets-credential-engineer` | the credential scanner (`effectors/credential-scanner.js`) + leash pre-T3 scan — the one area where a generic builder is actively dangerous |
  | `testing/testing-test-automation-engineer.md` | `persona-test-automation-engineer` | test-writing cards; the `tdd-workflow`/`verification-before-completion` skills have no seat |
  | `testing/testing-evidence-collector.md` | `persona-evidence-collector` | the **evidence contract** — `effectors/evidence.js` + `evidence-validator.js` + `dispatch-action.js`'s `unverified`/`reason` rule. This repo's single most-repeated scar has no persona |
  | `engineering/engineering-minimal-change-engineer.md` | `persona-minimal-change-engineer` | `build-refine.js` repair passes; the code analogue of the vendored `ponytail` skill and of the surgical-changes rule |

  **Two considered and deliberately deferred, reason recorded so a later session
  does not "helpfully" add them:** `engineering/engineering-desktop-app-engineer.md`
  (MYTHOS *is* an Electron app, so the reader is real — but step 7 is the Electron
  lane and is unticked; adding a seat mid-flight there mixes two builds) and
  `engineering/engineering-code-reviewer.md` (the reviewer seat already has a
  tracked `mythos/personas/reviewer.md` written for this repo's own rubric, and
  `review-rubric.js` owns the output contract — a second reviewer identity would
  fight it). **The remaining ~220 stay unvendored**: a catalogue entry no seat calls
  is prompt tax on every turn.

  Mechanics per persona: `mythos/skills/README.md:47-58`, verbatim, invent nothing
  — upstream body verbatim, frontmatter rewritten for this loader with the
  `<!-- Adapted from msitarzewski/agency-agents (MIT), original file … -->`
  provenance comment the existing six already carry, `LICENSE` copied, one line in
  the existing `skills.allowlist` Personas block, **extend the single
  `THIRD_PARTY_NOTICES.md` agency-agents row** (do not add a second), and add the
  README "Copied from upstream" rows.

- [ ] **8E.4 — Tests.**

  - `test/personas-resolution.test.js` — four-root order; `$MYTHOS_PERSONAS_DIR`
    wins; operator `vault/Personas/` beats tracked defaults; vendored fallback
    resolves; frontmatter stripped; unsafe role rejected; miss cached. **Point every
    root at temp directories.** Never rename a real directory to fake a state — that
    is the wake-word `EPERM` scar, and it stranded real model weights invisibly
    because both directories were gitignored.
  - `test/persona-router.test.js` — a security card does not get `backend-builder`;
    a zero-hit card still does; role + reason land in the record (AD-18).
  - `test/anti-drift-persona-single-loader.test.js` — AD-17 sweep.

---

### Step 8F — The TencentDB assets step 8 did not take

> **Added 2026-08-17, same plan-only pass, same 6.5/6.6/7 gate.** 8C took
> TencentDB's **layering** (L0→L3) and nothing else. The operator asked for the
> other four assets: versioned skills, the Wiki's link structure, memory
> loadouts/ACL, and CodeGraph. Ordered cheapest-and-most-certain first; the last
> two carry explicit gates because both are large and one has a competing answer
> already sitting in the adoption matrix.

- [ ] **8F.1 — Versioned skills (no gate — the cheapest real win in step 8).**

  `memory/skills.js:28 write()` composes the whole file and overwrites it. So an
  auto-distilled skill (written by `goals/index.js:176` and
  `identity/reflection.js:259`) can be silently replaced by a worse distillation
  and the predecessor is gone — the exact hazard 8B's snapshot ledger exists to
  prevent, one store over. TencentDB versions its skill assets for this reason.

  Design, deliberately the same shape as 8B so the repo has one discipline, not two:

  - `vault/Skills/<slug>.md` stays the current version. **No reader changes** —
    `recall()`, `get()`, `parseSkill()` and the `dispatch-action.js` bookkeeping all
    keep working untouched.
  - `vault/Skills/versions/<slug>/<ts>.md` — the previous body, written **before**
    the overwrite. Snapshot-then-write, in that order, for the same reason
    `mergeConsolidatedTopics()` now writes before deleting: the other order destroys
    data on a failed write.
  - `version` + `supersedes` added to the existing sidecar comment
    (`skills.js:17 SIDECAR_RE`). Additive — `parseSkill()` must keep parsing files
    that have neither, or every skill written before this lane becomes unreadable.
  - **`recordUse()` must NOT snapshot.** It rewrites the file on every single use to
    bump `uses`/`successRate` (`skills.js:146`, inside `fs.withLock`). A version per
    use is thousands of files a week. Only a change to the body/steps/criteria
    snapshots. **This distinction is the whole lane** — get it backwards and the
    feature is a disk leak.
  - `history(slug)` and `rollback(slug, ts)` surfaced through the existing
    `from-memory.js` tool set, not a new effector file.
  - AD-19 above.

- [ ] **8F.2 — Wiki link structure over Notes (small, additive).**

  `memory/notes.js` is already Obsidian-compatible markdown with search
  (`notes.js:167`), and `MYTHOS_NOTES_DIR` can point at the operator's real
  Obsidian vault. What TencentDB's Wiki adds is what is missing: **link structure**
  — `[[wiki-link]]` resolution and backlinks, so a note declares what it relates to
  and the relation is readable from both ends.

  - Parse `[[target]]` on read and resolve through the existing `slugifyTitle()`
    (`notes.js:28`), so link resolution and file naming cannot drift apart.
  - `backlinks(slug)` computed by scanning at query time, bounded by the existing
    `MAX_SCAN_FILES` cap. **No index file.** An index over a directory the operator
    edits in Obsidian is a second source of truth that is stale the moment they
    save — and the truncation must be reported, since `search()` already reports
    `truncated`.
  - Unresolved links are **reported as unresolved**, never silently dropped. Same
    honesty rule as the loader reporting a missing skill instead of quietly
    shortening its catalogue.
  - Anything injected into a prompt from here goes through 8C.1's
    `budgetedBlock()` (AD-14). No second truncation rule.

- [ ] **8F.3 — Memory loadouts / per-agent scope (two parts, second one gated).**

  TencentDB's idea is that memory assets **bind to specific agents** — sharing is
  explicit, not broadcast. Its team/ACL half (System Admin / Team Admin / Member,
  private/team/restricted visibility) has **no reader in a single-operator
  product** and is not being built; that is recorded here so it is not mistaken for
  an oversight. The half that does have a reader is **scoped recall**: the reviewer
  seat should not be steered by facts distilled from an unrelated project, and a
  build agent should not inherit conversational preferences.

  1. **Scope tags on write — ship this alone first.** `semantic.write(topic, facts,
     meta)` already carries a `meta` object (`memory/index.js:88`). Add
     `meta.scope` (project/engagement slug) and `meta.audience` (seat role; absent
     = every seat). Purely additive: every existing caller keeps working and every
     untagged record stays universally visible.
  2. **A recall filter, not a recall fork.** `recallHybrid(query, opts)` gains
     `opts.audience`/`opts.scope`, applied **in the same place `opts.excludeKinds`
     is already applied** (`memory/index.js:265`) — that filter exists there
     precisely because the vector path bypassed the keyword path's exclusion once
     (recorded in-file as FIX G). A second filter site would re-create that bug.
     AD-21 applies.

  **Gate:** part 1 before part 2, as separate commits. Tagging is harmless and
  immediately auditable. Filtering changes what every seat sees, so part 2 needs a
  full audit of the `recall`/`recallHybrid` call sites first — the server's
  recall-before-respond, `handleUtterance()`, the goal planner, and the Live
  composer all read memory, and a filter defaulting the wrong way makes MYTHOS look
  amnesiac with a full vault.

- [ ] **8F.4 — CodeGraph: symbols, call edges, blast radius (largest — decision first).**

  The honest gap: `from-code-search.js` is embedding-only (`index_project` /
  `search_code` over `chunkCode()` chunks in the shared `documents` vector
  partition). It finds code that *reads like* the query. It cannot answer "what
  breaks if I change this function" — the question the build lane, the reviewer
  seat and the pre-commit gate all actually ask, and the question TencentDB's
  CodeGraph exists to answer.

  **First task of this lane is a recorded decision, not code.** The adoption matrix
  already carries a competing answer: `tirth8205/code-review-graph`, 🟢 **P1** —
  tree-sitter blast-radius graph over MCP, ~65× token reduction, risk-scored merge
  gate, local-first, `pip install`. MYTHOS already speaks MCP (`from-mcp.js`,
  `mcp_call_tool`).

  | Option | For | Against |
  |---|---|---|
  | **Adopt** `code-review-graph` as an MCP sidecar | real tree-sitter parsing, multi-language, someone else maintains it; degrades OFFLINE when absent, exactly the cua-driver pattern the root `CLAUDE.md` mandates | a Python dependency inside a product being sold — its licence and its deps must clear step 6.6 before it can ship |
  | **Build native** | zero new dependencies; reuses the existing `walk()` + `SKIP_DIRS` + `MAX_FILES` caps in `from-code-search.js` (**do not write a second walker**); ships in the installer with nothing to install | regex/AST-lite means JS/TS-accurate and weak elsewhere |

  **Recommendation to record: build native, scoped to JS/TS only, and say so in the
  tool description.** A graph that silently under-reports Python callers is worse
  than one that declines to cover Python — that is AD-20's whole point. Shape:
  extract `require`/`import`/`export` edges and top-level declarations, write
  `vault/Index/codegraph.json`, expose `impact_of({symbol|file, depth})` returning
  callers/importers. T0 read-only, so no leash change.

  Sequenced **last** in step 8 and dependent on 8A.4, because the reviewer/gate
  consumers that make it worth building are what 8A.4 and 8D put in place.

---

### Step 8 — execution order and verification

Each step is independently shippable and independently revertible.

| # | Step | Depends on | Risk |
|---|---|---|---|
| 1 | 8A.1 phantom-name fix + red test | — | low |
| 2 | 8A.2 essence fallback in `loadContent()` | — | low |
| 3 | 8A.3 `use_skill` → `DEFAULT_ALLOWLIST` | — | low; two existing sweeps gate it |
| 4 | 8A.4 vendor 6 skills + `definition-of-done` + PACKS + notices + README | 1-3 | low; watch `MAX_PACK_CHARS` |
| 5 | 8C.1 `memory/budget.js` + convert the operator-facts loop | — | low |
| 6 | 8B harness store + effector + tier + `NEVER_TRUSTABLE` + both composers + route | 5 | **highest** — model-editable prompt state |
| 7 | 8C.2 Live episodic + lessons blocks | 5 | medium; prompt-size cost is real |
| 8 | 8D budget + gates + executor rewire | 4 | medium |
| 9 | 8C.3 L2 scenarios — **only if 7 proves insufficient** | 7 | provisional |
| 11 | 8E.1 persona resolution bridge + AD-17 sweep | — | low |
| 12 | 8E.2 scored router + AD-18 record fields | 11 | low |
| 13 | 8E.3 vendor 8 personas + allowlist/notices/README | 11-12 | low |
| 14 | 8F.1 versioned skills + AD-19 | — | low |
| 15 | 8F.2 wiki links + backlinks over Notes | 5 (uses `budgetedBlock`) | low |
| 16 | 8F.3 part 1 — scope tags on write, unused | — | low |
| 17 | 8F.3 part 2 — scoped recall filter + AD-21 | 16 + a full `recall*` consumer audit | medium |
| 18 | 8F.4 CodeGraph — **adopt-vs-build decision recorded first**, then native JS/TS + AD-20 | 4, 8 | **highest of 8E/8F** |
| 10 | Tick each box, Progress-log rows with SHAs, rewrite RESUME HERE | all | doc |

Rows 11-18 were appended 2026-08-17 (lanes 8E/8F). Row 10 stays last because it is
the doc close-out for the whole step. **8E and 8F are independent of 8A-8D** — the
only cross-lane dependencies are row 15 on 8C.1's `budgetedBlock()` and row 18 on
8A.4/8D's reviewer-and-gate consumers, so 8E can start the moment the 6.5/6.6/7
gate opens, without waiting on 8B.

**Before touching anything** (concurrent-session safety): `git pull`, then diff
`skills.allowlist`, `voice/live-tools.js` and `server/index.js` against what
BUGS.md claims is in them. Two machines share this repo and one git index —
commit by pathspec.

**Every suite run and every commit** needs the environment this repo has already
learned it needs, or the result is noise:

```bash
# long-form TEMP (an 8.3 short TEMP aborts spawned-server tests inside libuv and
# surfaces as ECONNREFUSED); port overrides so a running MYTHOS does not produce
# two false failures on 4478/5050. The pre-commit hook runs the suite too, so it
# needs the same env.
export TEMP="$LOCALAPPDATA/Temp" TMP="$LOCALAPPDATA/Temp"
cd mythos && MYTHOS_PORT=4999 EDGE_TTS_PORT=5099 EDGE_TTS_URL=http://127.0.0.1:5099 node --test
```

Per-lane verification, in order:

1. **8A.1/8A.2 — red before green.** Run the fresh-clone probe that found the bug:
   ```bash
   cd mythos && USERPROFILE=C:/__no_such_home__ HOME=/__no_such_home__ MYTHOS_SKILLS_DIR= \
     node -e "const l=require('./src/core/skills/loader');
       const n=new Set(l.loadCatalog().map(s=>s.name));
       ['ui-ux-pro-max','spec-driven-development','frontend-ui-engineering']
         .forEach(s=>console.log(s, n.has(s)?'OK':'PHANTOM'));
       console.log('use_skill(ui-ux-pro-max) ->', l.loadContent('ui-ux-pro-max') ? 'LOADS' : 'FAILS');"
   ```
   Today: three `PHANTOM` and `FAILS`. After: all `OK` and `LOADS`.
2. **8A.3 — live, by voice.** Open a Live session, say *"use your ui-ux-pro-max
   skill and tell me the first rule it gives you."* Before: the model cannot call
   `use_skill` and substitutes something adjacent without saying so. After: a real
   `use_skill` call appears in the Audit view and the answer quotes the skill.
   **Check the Audit tool ARGS, not the spoken claim** — the spoken claim is
   exactly what is being tested for.
3. **8A.4 — build lane.** Trigger an `app`-kind build; assert `packBlockFor('app')`
   composes under `MAX_PACK_CHARS` with an empty `dropped` list and that the new
   essences appear in the prompt actually sent.
4. **8B — the whole loop, on real state.** `propose` with a real episodic id →
   ledger shows `proposed`; `evidence:[]` → rejected and `health.anomaly` fires;
   `apply` → snapshot written, overlay grows; open a **new** Live session and
   confirm the note is in the setup frame (**read the frame; do not ask the model
   whether it saw it**); `rollback` → overlay byte-identical to the snapshot.
   `GET /api/harness` shows all three. Confirm the T3 confirm fires and is **not**
   cached on a second call in the same connection.
5. **8C — measured, not assumed.** Log the composed Live instruction length before
   and after; confirm both blocks present, `session-start` labelled, and an
   over-cap case emits the `[N older entries omitted]` marker. Then the operator
   question that motivated it: *"what were we working on yesterday?"* on a fresh
   Live session against a vault with real episodics.
6. **8D — force each failure.** Exhaust turns, tokens and wall clock separately;
   each lands `BLOCKED` with the named reason, never `COMPLETED`. Fail a gate,
   re-run with identical inputs → `skipped:'unchanged-since-failure'`; change an
   input → re-runs.
7. **8E — the seat, not the catalogue.** Run a build card whose text is about
   deploying or about credentials, and read the **record**: it must name a routed
   persona and the reason (AD-18). Then confirm the body actually reached the
   model — check the composed prompt or the Audit entry, **not** the model's claim
   that it was being a devops engineer. A seat that says it is specialised is
   exactly what was already true and false at the same time before 8E.1. Also
   re-run the resolution probe with all four roots pointed at temp directories and
   confirm the operator root still beats the tracked default.
8. **8F — each lane has its own oracle.** 8F.1: rewrite a skill body, confirm one
   version file exists and the old body is byte-identical in it, then hammer
   `recordUse()` and confirm no new version appears. 8F.2: create two notes that
   link to each other, confirm `backlinks()` finds both directions and that a
   `[[missing]]` link is reported unresolved rather than dropped. 8F.3: same query
   scoped and unscoped, assert subset plus the withheld count. 8F.4: index the
   repo, then `impact_of` a function with known callers and **verify against a real
   grep** — a graph that agrees with itself is not evidence.
9. **Anti-drift.** All eleven new AD tests (AD-11…AD-21) pass and the existing
   `test/anti-drift-*.test.js` suite stays green — AD-7 especially, since step 8
   adds vault paths and test fixtures (derive fixture paths from `os.tmpdir()`;
   AD-7 only fails a path literal after `git add`).
10. **Docs (AD-10).** `node scripts/sync-test-count.js --write`, commit its output,
   never hand-edit a count. Run it as a **separate** command from the commit —
   chaining both has hit the 10-minute ceiling before.

**Definition of done for step 8:** all six lanes (8A, 8B, 8C, 8D, 8E, 8F)
live-verified as above; every box above ticked with a Progress-log row carrying its
commit SHA; AD-11…AD-21 present in the V2 spine's §1 table; RESUME HERE rewritten
to name the next unchecked step; pushed. **A tick that is not pushed does not exist
to the next machine.**

---

## Original plan — Reconciled Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reach IRIS "Complete Suite / Desktop + Mobile Pro" feature parity on MYTHOS, reusing the already-built-and-probed Gemini Live speech-to-speech path rather than building a second streaming mechanism.

**Architecture:** The existing V2 plan (Gemini Live S2S + Electron + Anti-Drift Contract) is the spine and stays as written — **now committed at `mythos/Plans/MYTHOS-IRIS-Synthesis-Plan-V2-spine.md`, 1,570 lines.** Only its filename here was wrong: it was never the root `.md.txt` (that was a stripped copy of *this* document), it was `~/.claude/plans/deep-compare-this-floofy-heron.md`. This document is the **delta**: it adds the IRIS Pro-Plus capabilities V2 under-scoped (phone SMS/calls/contacts/WhatsApp/hardware, clipboard, file ops, alarms, autostart, 2-device registry) and **cancels** one thing I was about to build that would have been redundant.

**Tech Stack:** Node 22 (no build step), Gemini Live WS (`gemini-3.1-flash-live-preview`, probe passed), PowerShell 5.1 daemon, `adb` platform-tools as optional binary, `node --test`.

---

## Context

Two things prompted this plan, and the second one changed it materially.

You installed IRIS locally, found nothing wired together, and identified it as a marketing build — while its Pro-Plus tier still describes the product surface you actually want: one voice assistant that owns the Windows desktop *and* your Android phone, sub-800ms replies, 24/7 background execution, and a memory vault that follows you across devices. You asked for a rewrite plan aligned to that.

Mid-session I discovered my starting assumption was wrong. I reported the root file `MYTHOS × IRIS — Synthesis Plan.md.txt` as empty (0 bytes) and held. It is 723 lines of finished V2 planning work — **correct as to the content, wrong as to the path.** The V2 spine was `~/.claude/plans/deep-compare-this-floofy-heron.md`, has since grown to 1,570 lines, and is now committed inside the repo; the root `.md.txt` was only ever a formatting-stripped copy of *this* document. Also real and confirmed: a **passing** Gemini Live access probe (84,482 bytes of 24kHz audio, clean `turnComplete`), whose script `mythos/scripts/verify-gemini-live.js` is now committed rather than untracked.

The intended outcome: MYTHOS ends up strictly better than IRIS Pro-Plus on capability, and categorically better on honesty — IRIS's HUD synthesizes `temperature = 40 + cpu*0.4 + Math.random()*2` and pure-random network stats. V2's Anti-Drift invariant AD-5 forbids exactly that, and it stays in force.

---

## Decision 1 — Latency: your existing path wins. I am cancelling the new one.

You asked: *"I think mine is faster? if yes, use mine already built!"*

You are right, and the margin is not small. Two candidate paths existed:

| Path | Mechanism | Round trips per turn | Status |
|---|---|---|---|
| **Sentence-chunk TTS streaming** (what I was about to plan) | Parse the `say` field out of a partially-streamed JSON blob, chunk to sentences, synthesize each via edge-tts | Still 1–4 sequential `brain.think` calls, plus a per-chunk TTS HTTP round trip | Not built. **Cancelled.** |
| **Gemini Live native S2S** (V2 §6–§10, yours) | Duplex audio socket; model does STT, reasoning, and TTS inside one stream; native VAD | **Zero.** `needs_result` disappears entirely | Access probe **PASSED** 2026-07-30 |

The speculative-JSON-extraction design my planner produced (`say-stream-extractor.js`, a `speculativeSayFinal` flag, a discard-and-refall-back branch) was ~200 lines of new parser plus a documented risk of speaking an intent phrase before the paired action's outcome is known. It was solving a latency problem your S2S path deletes at the root. Building it would have been the exact over-engineering the ponytail ladder exists to prevent: rung 2 — *already in this codebase* — and the answer was yes.

**What this changes in V2:** nothing needs adding. V2 §16 already keeps `voice-agent.js` as the untouched fallback under `VOICE_S2S_ENABLED=false`. The only thing this plan contributes to latency is **measurement**, because IRIS advertises a number (<800ms) and MYTHOS currently measures nothing:

- [x] Instrument mic-stop → first-audio (Wave 3, Task 12). Client stamps `micStoppedAt` at `voice-loop.js` `stopRecording()`; server computes the delta when the first `live-audio-out` frame ships; a capped ring buffer feeds `/api/status` as `voiceLatency: {p50, p95, sampleCount}`. Real samples only — an unmeasured turn reports nothing rather than an estimate (AD-5). **DONE — verified wired end to end 2026-08-04 by source audit, and this checkbox was STALE, not open.** The whole chain exists: `src/core/voice/latency-tracker.js` (`createLatencyTracker`, capacity 200, and `stats()` honestly returns `{p50:null, p95:null, sampleCount:0}` when nothing has been sampled — AD-5 respected at the source, not just in prose); client stamp `ui/public/js/voice/voice-loop.js:377` → `ui/public/js/ws.js:144` (`utterance()` forwards `micStoppedAt`); **both** server record points, `server/index.js:1274` (S2S path, delta from `liveTurnUserSpeechAt`) and `:1373` (TTS path, guarded by `!latencyRecorded` so one turn records once); exposure at `:563` merging `voiceLatencyTracker.stats()` into `/api/status`; HUD tile `ui/public/js/widgets/kinds/voice-latency.js`. Nothing was built for this tick — the code was already there and the box had simply never been ticked. **The genuinely open half is not instrumentation but measurement:** reading a real p50 requires a real microphone and real use, which is Task 12 Step 5 below and needs the operator.

---

## Decision 2 — Council could not convene (reported, not faked)

You invoked `/council`. The skill loaded, but the 18 member agent definitions it dispatches (`~/.claude/agents/council-*.md`) **do not exist on this machine** — `Glob` over `~/.claude/agents` and all of `~/.claude` returned zero matches. The coordinator has no members to spawn.

I am not going to write a synthetic verdict with fabricated member positions and a fake weighted tally; that would be a plausible-looking artifact with nothing behind it, and it is the same failure mode as IRIS's random-number telemetry. The one genuine tradeoff a council would have adjudicated is Decision 1 above, and it resolved on evidence (a passing probe versus an unbuilt parser), not on deliberation.

To actually get councils working: install the council agent pack into `~/.claude/agents/`. Then `/council --triad architecture` on any open question here.

---

## Decision 3 — Execution order: persona first, not desktop-gaps first

The side-by-side audit supplied mid-planning re-sequences this work, and its ordering is better than my first pass. Its logic: of IRIS's 23 unique items, mobile is 8 and genuinely hard, distribution is 4 and is one Electron phase, and the remaining 8 desktop features are each small and additive. Meanwhile MYTHOS's 29 unique items are architectural and cannot be bolted on by anyone at any price. So the gaps worth attacking first are the two that represent real work — sub-second duplex voice, and the phone — and the cheapest felt win is persona, which ships in hours and needs no new transport.

**Task numbers below are stable IDs, not an order.** Execute in this sequence:

| Order | Work | ID | Cost | Why here |
|---|---|---|---|---|
| 1 | Green the baseline + reconcile docs | Tasks 1–2 | ~half day | Gates everything. Two real failures, both named after honesty guarantees. |
| 2 | **Server bind + bearer auth** | Task 6 | ~2 hours | Out of sequence deliberately — see below. |
| 3 | **Persona unclamp** (V2 §11) | Task 11-persona | **hours** | Highest felt improvement per hour in the whole plan. Ships independently of everything else. Two-file rollback. |
| 4 | **S2S voice transport** (V2 §6–§10) | Wave 3 + Task 12 | days | The one gap that is real work and already de-risked — probe passed. Closes IRIS's single biggest advantage. |
| 5 | Small desktop gaps | Tasks 3, 4, 5, 7, 11 | ~a week total | Each small and additive: clipboard is `Get-Clipboard`, OCR is a WinRT block using a helper that already exists, code search reuses the existing vector index, maps is a keyless API. |
| 6 | ADB phone bridge | Tasks 8, 9, 10 | days | Closes ~two-thirds of IRIS's mobile list with no app to build. |
| 7 | Electron shell + Android app | Wave 4 | weeks | The remaining third of mobile, plus distribution. |

**One deviation from the supplied sequence, stated plainly:** server auth (Task 6) moves to position 2 rather than sitting inside the desktop-gaps batch. It is ~2 hours of work against a live exposure — `Dockerfile` and `render.yaml` both already set `MYTHOS_BIND=0.0.0.0`, and the only current gate is an origin check any non-browser client spoofs with a header. Any cloud-deployed MYTHOS right now serves 106 tools, including tier-3 confirm-and-execute, to whoever finds the URL. That outranks felt-value ordering. Everything else follows the supplied sequence exactly.

---

## What IRIS Pro-Plus claims vs. what MYTHOS has

Verified against the live pages and against the code this session. "Have" means a real code path, not a stub.

| IRIS Pro-Plus claim | MYTHOS today | Wave |
|---|---|---|
| 150+ desktop tools | **106 real effectors** (V2 §0.2 — README says 45, that's stale) | 0 (doc fix) |
| Ultra-low latency <800ms | Full-buffer today; S2S path probed and ready | 3 (V2 §6–§10) |
| Hands-free voice + wake word | Have — ONNX openWakeWord, opt-in | — |
| Screen capture + **OCR text extraction** | Screenshot + vision captioning; **DONE, step 5** — real `Windows.Media.Ocr` via `screen_read_text` | 2 (V2 §7.1, Windows.Media.Ocr) ✅ |
| Keyboard injection / UI automation | Have — 13-command PowerShell daemon | — |
| Terminal / CLI execution | Have — `command-runner`, allowlist-gated | — |
| Deep research + web scraping | Have — 4-tier search chain, SSRF-guarded fetch | — |
| Local file management | **DONE, step 5** — `move_file`/`copy_file`/`rename_file`/`search_files` added, read/list/open/write/create/delete already existed | 1 (Task 4) ✅ |
| **Clipboard reader** | **DONE, step 5** — `clipboard_read`/`clipboard_write` via `pc-child` | 1 (Task 3) ✅ |
| Calendar + event scheduler | **DONE, step 5** — real read-only Google Calendar `calendar_upcoming` shipped (write-side/event creation still not built); reminders unchanged | 1 (Task 5) + 2 (V2 §7.6) ✅ |
| **Alarms / timers with audible alert** | **DONE, step 5** — `timer_add`/`timer_cancel`, real bundled alert tone, in-process (not Scheduled-Tasks-backed — see roadmap Task 5 for why) | 1 (Task 5) ✅ |
| Memory vault synced across devices | Single-writer local vault. Phone-as-ADB-client means one vault on the desktop → **sync is free, nothing to replicate** | n/a by design |
| Biometric / PIN lock | **DONE, step 5, PIN-only** (IRIS's is an 8-byte decoy `face_match.wasm`; Windows Hello deliberately not built here — real gate or nothing) | 2 (V2 §7.3) ✅ |
| **SMS to contacts by voice** | **Absent** | 2 (Task 10) |
| **Phone calls + contacts directory** | **Absent** | 2 (Task 10) |
| **WhatsApp messaging** | **Absent** | 2 (Task 10) |
| **Hardware toggles** (flashlight/WiFi/BT/hotspot) | **Absent** | 2 (Task 10) |
| Notification reading | Absent | 2 (Task 10) |
| Up to 2 Android devices + desktop | No device registry | 2 (Task 9) |
| 24/7 background, zero daily limits | OODA loop runs continuously; **no autostart on login** — **DONE, step 5 Task 7**, `mythos/scripts/setup-autostart.js` | 1 (Task 7) ✅ |
| Android app | Deferred — ADB bridge first, per your decision | 4 (planned only) |
| **Semantic code search** (index local project dirs) | **DONE, step 5** — `index_project`/`search_code`, reuses §7.5's doc-RAG index as a source adapter, not a second index | 2 (Task 11) ✅ |
| **Image generation** | **Built, but genuinely inert** — `generate_image` calls the real, correctly-verified Gemini image model; this Google account's free tier grants zero image-gen quota (real 429), so it honestly reports unavailable rather than faking a picture | 2 (Task 11) ✅ (code) / needs billing (capability) |
| **Maps + route calculation** | **DONE, step 5** — `get_directions`, keyless OSRM + the existing `geocode()` | 2 (Task 11) ✅ |
| **Floating cursor overlay** (summon at cursor, OS-level) | Absent — needs `globalShortcut`, so it rides Electron | 4 |
| **WhatsApp scheduling from desktop** | Absent — trivial once Task 10 lands | 2 (Task 10 follow-on) |
| Auto-update + OS keychain secrets | Absent — `electron-updater` + `safeStorage` | 4 (V2 §13) |
| Mac + Linux builds | Windows-only automation (1,541-line PowerShell daemon; a port is its own project) | Deferred, documented |
| 1M+ context (claimed) | Caps at 262K. Gemini Live is 128K — **but S2S sends the system instruction once per session, not per turn**, so effective headroom improves | n/a |

**Deliberately refused, so these are not read as oversights.** Remote phone camera/photo capture — IRIS advertises it; MYTHOS declines, and that is a product decision, not a gap. Port tunneling to the public internet — refused outright while Task 6 is the reason it would be dangerous, and reconsidered only after auth ships, if ever. Any synthesized metric, ever (AD-5). V8 bytecode obfuscation, HWID banning, license servers — this is open source; hiding the core is the opposite of the point.

**Two IRIS claims that do not survive inspection**, worth knowing so you don't over-index on their list: their "multi-face biometric locking" ships as an 8-byte `face_match.wasm` in a decoy directory, and their HUD synthesizes telemetry with `Math.random()`. Their public repo contains none of the advertised engine; the paid build is closed bytecode. Their column is claims; MYTHOS's column above was read out of code this session.

---

## File Structure

New files (this delta only — V2's own new files are listed in V2 §6–§13):

| File | Responsibility |
|---|---|
| `mythos/adapters/android-child/index.js` | `adb` lifecycle, device registry, per-device command queues, OFFLINE on ENOENT |
| `mythos/src/core/effectors/from-android.js` | The 14 `phone_*` tools; pure delegation to the adapter |
| `mythos/scripts/setup-android.js` | `--check` / `--install` / `--pair` / `--connect`; project-local platform-tools |
| `mythos/scripts/setup-autostart.js` | `schtasks` logon-task registration, `--install` / `--check` / `--uninstall` |
| `vault/Identity/android-devices.json` | Paired-device list (a growing list, so vault not `.env`) |
| `test/android-child-adapter.test.js` | Mirrors `test/cua-driver-adapter.test.js`: no live `adb` in CI |
| `test/from-android.test.js` | Tools against a mocked adapter |
| `test/from-computer-fileops.test.js` | Sandbox + symlink-escape on the 4 new file ops |
| `test/from-calendar-timer.test.js` | Timer fires with `alertSound` |
| `test/voice-latency.test.js` | `/api/status` exposes real `voiceLatency` |

Modified: `from-computer.js` (4 tools + clipboard delegates), `from-calendar.js` (timer), `ps-automation.ps1` (2 clipboard commands), `leash/tiers.js` (18 entries), `main.js` (adapter boot wiring), `.env.example` (new keys).

**Superseded from V2:** V2 §7.4 specifies `adapters/android-adb/index.js` + `from-phone.js` with 6 tools. This plan replaces that section with `android-child` + `from-android.js` and 14 tools, because Pro-Plus parity needs SMS/calls/contacts/WhatsApp/hardware which V2's 6 tools do not cover. Naming follows the existing `pc-child` sibling. **Do not build both.**

---

## Wave 0 — Reconcile and green the baseline (gates everything)

### Task 1: Reconcile the two plan documents

**Files:** repo root `MYTHOS × IRIS — Synthesis Plan.md.txt`; create `mythos/Plans/MYTHOS-IRIS-Synthesis-Plan.md`

**DONE 2026-07-30.** Both documents are now committed side by side in `mythos/Plans/`. Steps are recorded rather than deleted because the path confusion here is worth not repeating.

- [x] **Step 1 — DONE, at a corrected path.** The root `.md.txt` was **not** V2; it was a formatting-stripped copy of *this* document. V2 was `~/.claude/plans/deep-compare-this-floofy-heron.md`, now committed as `mythos/Plans/MYTHOS-IRIS-Synthesis-Plan-V2-spine.md` (1,570 lines, md5 verified identical to source). Its §3 and §4 frozen references — the Gemini Live wire protocol and the 21 MYTHOS seams with line numbers (the "23" this line carried for weeks was prose drift against the table's own 21 rows; corrected 2026-08-16) — are intact and are what merged-order step 4 builds from. **Read them before touching S2S; do not skim.**
- [x] **Step 2 — DONE 2026-07-30.** V2 §0.3 already read `✅ PASSED 2026-07-30`. V2 §16's "Live quota (highest)" risk is now marked **Retired** — re-ran `mythos/scripts/verify-gemini-live.js` live this session (not just trusting the prior claim): `models/gemini-3.1-flash-live-preview`, 67,202B of audio, clean `turnComplete`, no 429. Passed twice now.
- [x] **Step 3 — superseded, not merged.** The two documents stay separate with a precedence rule (see the V2-spine section above) rather than being fused; V2 §18 already reconciles them from its side. The one supersession to honour: build `android-child` + `from-android.js` with 14 tools, **not** V2 §7.4's `android-adb` + `from-phone.js` with 6. Do not build both.
- [x] **Step 4 — DONE.** This file is `mythos/Plans/MYTHOS-IRIS-Synthesis-Plan.md`, moved with `git mv` so history follows it.
- [x] **Step 5 — DONE, but inverted.** Both root files were committed verbatim in `ce013a5` **before** removal, rather than deleted while untracked. The plan's warning ("it is untracked, so `git` will not save you") was sound advice applied to the wrong file — the genuinely at-risk documents were the two in `~/.claude/plans/`, and both are now in the repo.
- [x] **Step 6 — DONE.** Committed and pushed to `origin/main`, which is what makes this roadmap resumable from another machine.

### Task 2: Green the two real test failures

**Files:** `test/ps-dispatch-honest-failure.test.js`, `test/spotify-effector.test.js` (both confirmed present)

- [x] **Step 1: Establish the true baseline — DONE 2026-07-30, prediction was WRONG.** Ran the full suite from `mythos/` with a bare `node --test` (no path args — node's own recursive discovery). Real four-tuple: **1517 tests, 341 suites, 1516 pass, 0 fail, 1 skip** (the 1 skip is `test/sensors-file.test.js`'s documented honest `t.skip()` for a Windows-only native `fs.watch` crash, not a hidden failure). This plan's "two real failures, `ps-dispatch-honest-failure.test.js` + `spotify-effector.test.js`" prediction did **not** hold up: ran both files directly — 38/38 tests pass, 0 fail. There is nothing to fix. Also found, while establishing this baseline: `sync-test-count.js`'s own suite runner AND both `.githooks/pre-commit` and `.github/workflows/ci.yml` globbed only `test/*.test.js` (non-recursive) — silently skipping `test/assistant/*.test.js` + `test/engagements/*.test.js` (14 files, ~188 tests) from every gate that ever ran. Fixed all three to a bare recursive `node --test` invocation (commit carrying this row).

- [x] **Step 2: N/A — no exit-127/wandering-failure signature occurred.** `@(Get-Process node -ErrorAction SilentlyContinue).Count` was 0 before the run; the full suite completed cleanly in ~39s.

- [x] **Step 3: N/A — nothing to debug.** Both named tests pass; the "two real failures" premise was false. No assertion touched.

- [x] **Step 4: Verify — DONE.** `node --test` → 1520 tests (1517 + the 3 new §18.3.6 invariant tests below: AD-1, AD-5, AD-7), 0 fail, 1 skip, 1 todo (AD-1). `node scripts/sync-test-count.js --write` run from `mythos/`; `--check` now reports "all tracked numbers match the real suite. OK."

- [x] **Step 5: Corrected the verified-wrong README claims — DONE, one number differs from this plan's own guess.** Verified each independently (not copied from V2 §0.2 on faith): **deps 4→7** (`package.json` `dependencies` keys, counted directly), **sensors 5→10** (files in `src/core/sensors/`, cross-checked against main.js's 10 `create*Sensor()` calls), **providers 6→12** (files in `providers/` — this was already correct at one README location before this session touched anything). **Effectors: this plan's own "45→106" was wrong — verified real count is 107**, not 106: summed every `from-*.js` tool array (106, via a require+inert-context harness that calls each file's `TOOLS`/`build*Tools()` export the same way `main.js` does, with zero real dependencies) plus the one effector `main.js` registers directly outside any `from-*.js` file — `voice.js`'s `speak` effector (satisfies `hub.register()`'s own `{id, invoke}` shape check) — for 107. AD-10 implemented: `mythos/scripts/sync-test-count.js` now has `computeDepsCount()`, `computeSensorCount()`, `computeProviderCount()`, `computeEffectorCount()`, all directory-reads/require-introspection (zero hand-typed numbers), wired into `--check`/`--write` alongside the existing test-count slots. Also caught and fixed, while in the file: the "6 cloud providers" brain-chain claim (a *third*, narrower metric than the provider directory count) was itself stale in a different way — `chain.js`'s real `LANES` has 8 provider modules (zcode, nim, groq, mistral, cerebras, openrouter, google, ollama), 7 cloud + local Ollama, not 6 and not 12; corrected to "7 cloud providers ... plus a local Ollama fallback — 8 lanes total."

**Gate: no Wave 1 task starts until `node --test` reports 0 failures. Satisfied — 0 fail as of this commit.**

---

### §18.3.6 — anti-drift invariant tests (V2 §18.3 item 6, scheduled here per V2 §18.4 merged-order step 1)

V2's own risk list flagged that no wave scheduled the §1 Anti-Drift Contract's test files at all. Of the ten (AD-1..AD-10), four were writable today with no new product code and no Live session:

- [x] **AD-1 (single execution surface) — WRITTEN, violation found AND FIXED during merged-order step 2 (2026-07-30), `todo` flag removed.** `test/anti-drift-single-dispatch.test.js` implements the check verbatim (`effectors.invoke(` must appear only in `dispatch-action.js`) and is now a real, unweakened `it` — no `todo`. All three real call sites are rerouted through `dispatchAction()`: `src/core/cortex/index.js` (mull-loop `propose_goal`, tier 1, channel `cortex`), `server/index.js` (mic-duck/unduck `get_volume`/`set_volume`, channel `voice-ducking`), and `server/routes/media.js` (the dead `media_key` raw-invoke fallback removed outright — `dispatchAction` is always wired in production and in every test that exercises this route). Two comment-text-only hits the original violation report flagged (`src/core/cortex/index.js`, `src/core/immune/monitor.js` — historical prose mentioning the call shape, not code) were reworded to not spell the literal substring contiguously, since the check is a literal scan. Re-verified by direct source scan: zero hits outside `dispatch-action.js`. **Code done, tests green, NOT YET COMMITTED — see Task 6's Commit note; this is the same commit-blocked state.**
- [x] **AD-5 (no invented telemetry) — WRITTEN, passes.** `test/anti-drift-no-fake-telemetry.test.js`. Every current `Math.random()` in `src/core/`, `server/`, `ui/public/js/` is either a non-colliding id suffix or HUD-canvas animation jitter — none synthesize a status/metric/telemetry value. Genuinely green, not just quiet.
- [x] **AD-7 (no absolute paths) — WRITTEN, passes after two fixes.** `test/anti-drift-no-absolute-paths.test.js`. Found two real hits on first run: this very plan document's V2 spine quoted a real Windows user-profile path (drive letter, `Users`, a real name, a subpath) in its recovery narrative, and `mythos/scripts/verify-propose-goal-ui-click.js`'s comment embedded an 8.3 short-name derived from the same name. Both fixed (generic placeholder / rewritten to describe the short-name shape without embedding a matchable path) in the same commit. Now genuinely green — this bullet itself was rewritten once more after that, having accidentally reintroduced a matching pattern while describing the fix.
- [x] **AD-9 (optional binaries degrade, never crash boot) — WRITTEN 2026-08-04, and it found a real architectural surprise.** New shared harness `test/helpers/mock-spawn-enoent.js` swaps `child_process.spawn`/`spawnSync` for ENOENT-injecting fakes, evicts the target adapter from `require.cache`, requires it fresh (so the adapter's top-level `const { spawn } = require('child_process')` destructuring captures the fake **by value**), then restores the real functions immediately — the adapter's closure keeps the fake while every other already-loaded module in the run is untouched. `test/ad9-adapter-degrade.test.js`, 4 tests. **Red-first, and the proof only works because of a real install:** it forced ENOENT on `cua-driver` and deliberately asserted `ONLINE`, which failed `actual: 'OFFLINE', expected: 'ONLINE'` — evidence the injection is genuine, because cua-driver IS installed on this machine, so a no-op harness would have passed that wrong assertion by observing the real environment. The four status shapes were kept, not normalised: `pc-child`/`cua-driver` carry `queueDepth` + a `STARTING` transient, `android-child` adds `devices` and has no `STARTING`, `browser-agent` has `mode`/`cdpUrl`/`pageCount` + `CONNECTING` and no `queueDepth`. **`browser-agent` could NOT be ENOENT'd at the `child_process` layer and this is reported rather than fudged:** it never spawns its own optional binary — `playwright-core` preflight-checks the executable with `fs.existsSync` and throws its own "npx playwright install" error before any spawn, and per `src/main.js` the boot call is `connect()` (a CDP network dial), not `launchLocal()`. Mocked one layer up at the `playwright-core` boundary instead, reusing the `Module.prototype.require` interception pattern already established in `test/browser-auto-connect-poller.test.js`. Regression check on adjacent pre-existing adapter tests: 32/32.
- ~~**AD-9** — NOT written this session.~~ *(superseded by the tick above; original reasoning kept for the record.)* Existing coverage is partial and adapter-specific (`test/cua-driver-adapter.test.js` observes real-environment OFFLINE, doesn't inject ENOENT; `pc-child`/`browser-agent`/`edge-tts` have no equivalent). A faithful cross-adapter "force ENOENT on each, assert boot completes + status OFFLINE" test needs a shared mock-spawn boot harness across four adapters with different status shapes — real test-infrastructure work, disproportionate to step 1. **Scheduled here**, owner: whichever step next touches adapter boot wiring (currently step 5/6, desktop gaps + ADB bridge).
- [x] **AD-2 (leash owns the audit write)** — DONE, step 4 Phase 3. `test/anti-drift-audit-single-write.test.js` drives one Live tool call end-to-end through a REAL `createLeash()` (not a stub) for a T0 (auto-allow), a T3 (requireConfirm), and a boundary-denied case — each produces exactly one audit write, and the T3 case additionally confirms zero dispatch calls before human approval.
- [x] **AD-3 (tool declarations derive from the hub)** — DONE, step 4 Phase 2. `test/anti-drift-live-tools-subset.test.js`: every declared name is a subset of `hub.catalog()` names; a brand-new allowlisted effector reaches Live automatically via `buildCatalogFromHub(hub)` with zero changes to `live-tools.js`; a real hub tool left off the allowlist is reported in `withheld`, never silently vanished.
- [x] **AD-4 (no fabricated success)** — DONE, step 4 Phase 3. `test/anti-drift-live-no-fabrication.test.js` drives a T0 tool through the REAL `dispatch-action.js` (`sharedDispatch`, not a stub) with an effector hub that always fails, then `onLiveTurnComplete()` with a deliberately success-sounding spoken reply ("All good, status checked.") — proves the appended system note says FAILED and both the action-kind and conversation-kind episodic writes record `ok:false`, regardless of what the model said.
- [x] **AD-6 (S2S turns never amnesiac) — COMPLETED 2026-08-04. The missing episodic-write half is written, and finding where it belonged corrected the spine.** New `test/live-session-transcripts.test.js` (2 tests, the spine's own filename). **The spine put this test in the wrong place:** `live-session.js` never touches memory at all — it only calls the injected `onTurnComplete({userText, assistantText})`, and the real episodic write lives in `voice/live-tool-adapter.js`'s `onLiveTurnComplete`, wired by `server/index.js`. So the test wires **both real modules together exactly as production does** and asserts the resulting `memory.episodic.write` carries `detail.text` (user) and `detail.reply` (assistant). One case drives the §3-trap shape (`inputTranscription` + `outputTranscription` + `turnComplete` on ONE combined frame); the second proves transcripts accumulated across multiple partial frames still land in full. **Red-first against real code:** the `memory.episodic.write(...)` call in `live-tool-adapter.js` was temporarily gutted to a no-op and both new tests failed `0 !== 1`, then it was reverted (`git diff` clean afterwards, verified). The pre-existing anomaly case at `live-session.test.js:155` was NOT duplicated. Combined run with the two neighbouring files: 34/34.
- ~~**AD-6** — HALF COVERED.~~ *(superseded by the tick above; the audit that found it half-covered is kept below for the record.)* **HALF COVERED, and this line was stale.** Re-audited 2026-08-04. The reason given here ("cannot be tested yet; needs `live-session.js`'s scripted frame sequence") expired when step 4 landed `live-session.js` — line 802 below already records the test. The spine's AD-6 row specifies **two** assertions and only one exists: ✅ *a turn that completes with no transcript emits `health.anomaly`* is covered at `test/live-session.test.js:155` ("a turnComplete frame with no transcript at all emits health.anomaly (AD-6)"); ❌ *every completed Live turn writes **both** transcripts to episodic memory* — the spine's own wording, "assert episodic write contains user + assistant text" — has **no test anywhere** (`grep -rn "AD-6\|amnesi" test/` returns exactly that one line). **Write only the missing half**, against the episodic write, not a second copy of the anomaly case. Note the spine names the file `test/live-session-transcripts.test.js`; the anomaly half actually lives in `live-session.test.js`, so either extend that file or add the spine-named one, but do not duplicate the passing assertion.
- [x] **AD-8 (secrets never reach the renderer) — COMPLETED 2026-08-04.** The response-leak half is written: new `test/rest-ws-no-secret-leak.test.js` (6 tests) boots the REAL `createServer`, injects real-shaped fake secrets (Google/OpenAI/Anthropic/Groq/Mistral/Cerebras/ElevenLabs) into **both** `config` and `process.env`, then GETs every mounted read route (`/health`, `/api/status`, all three `/api/config/*`, `/api/stats`, goals, kanban, pipeline, all five `/api/memory/*`, audit, news, system, forge, checkpoints, `/api/pin/status`, engagements) and drives a real WS `live-open`/`subscribe`/`tick` sequence over a faked Gemini socket, scanning every body and frame for provider-key shapes (`sk-`, `AIza`, `gsk_`, `ya29`, `xox`, bare Bearer) plus literal matches of the injected values. **Red-first twice, because one alone is not enough:** the matcher is first run against known-bad and known-good fixtures to prove it is not vacuous (it flags shaped keys, catches a shapeless literal via the literal check, and does NOT flag an ordinary `{enabled:true}`), and then a real leak was injected into `/health`'s handler and the sweep failed with the exact secret captured in the assertion output. Both probes reverted and verified clean — **worth noting because a forgotten probe would itself have been the vulnerability.** The preload half's file was not touched. Combined run: 50/50.
- ~~**AD-8** — HALF COVERED.~~ *(superseded by the tick above; the audit is kept below for the record.)* **HALF COVERED, and this line was stale too.** Re-audited 2026-08-04. The stated blocker ("the Electron preload `contextBridge` doesn't exist until step 7") expired at Slice 1: `test/electron-preload-surface.test.js` exists and passes. ✅ The preload half is genuinely covered, and better than the spec asked — it pins the surface to exactly `{ getKeyNames, setKey, hasKey, onHotkey }` with each forwarding to its named IPC channel, and it proves the inbound `mythos:hotkey` payload is re-derived as a plain string so a structured, possibly secret-bearing event cannot ride the channel into the renderer (`assert.doesNotMatch(received[1], /a-secret-object/)`). ❌ Still uncovered: the other half named in this very bullet — **no current WS/REST response leaks a key pattern**, checked against the running server. That half was deferred on the reasoning that a partial test "risks looking done when it isn't"; that reasoning no longer holds now that the preload half is real and passing, so the remaining work is one response-scanning test, not the whole invariant. Slice 3 (`desktopCapturer`) deliberately added no preload channel, so the existing test is still the complete statement of the surface.
- [x] **AD-10 (docs match reality)** — this is `sync-test-count.js` itself; see Task 2 Step 5 above. Done.

**§18.3.6 correction checkbox: partially delivered.** As first written: 4 of 10 invariant tests written and run (AD-1 found a real violation and was `todo`-tracked at the time; AD-5, AD-7, AD-10 pass). 5 genuinely cannot run before their owning step lands (scheduled above, not silently dropped). 1 (AD-9) deferred as disproportionate build effort for this step, scheduled at the adapter-boot step.

**Re-counted 2026-08-04 — this paragraph had gone stale in two ways.** (1) The `todo` note is obsolete: AD-1's violation was fixed and the flag removed during step 2 (see the AD-1 bullet above), and the full suite now reports **`todo 0`** — there is no outstanding `todo` anywhere in the suite, so any plan text or handoff note claiming "one real todo remains" is wrong. (2) The tally was **8 of 10 fully covered** with 2 partial and 1 unwritten. **Later the same day (2026-08-04) it reached 10 of 10 — the Anti-Drift Contract is now completely covered by executable tests.** AD-6's missing episodic-write half, AD-8's missing response-leak scan, and AD-9's cross-adapter degrade harness were all written; see those three bullets above for the evidence, including the red-first proofs. Two of the three corrected something beyond themselves: AD-6's test proved the **spine had located it in the wrong module** (`live-session.js` never touches memory; the episodic write is in `live-tool-adapter.js`), and AD-9's harness established that **`browser-agent` cannot be ENOENT'd at the `child_process` layer at all** because playwright preflight-checks with `existsSync` and boot dials CDP rather than spawning. The "5 cannot run before their owning step lands" claim is fully expired — every owning step through 6 has landed, and step 7 has landed the preload surface AD-8 was waiting on. Real baseline at `e96daf8`: **2539 tests, 2538 pass, 0 fail, 1 skip, 0 todo** (full recursive `node --test`, reproduced 2026-08-04; the 1 skip is `test/sensors-file.test.js` honestly skipping an environment-specific `fs.watch` crash).

---

## Wave 1 — Desktop parity + server auth foundation

### Task 3: Clipboard read/write

**Files:** Modify `mythos/adapters/pc-child/ps-automation.ps1`, `mythos/src/core/effectors/from-computer.js`; Test `test/from-computer-clipboard.test.js`

`ps-automation.ps1` is the file BUG-037 is about. Before editing: `git pull`, then confirm these still exist in it — UTF-8 console encoding block, `Await-WinRTOperation` with explicit `[type]$ResultType`, `$TargetPid` (never `$pid`), DPI-awareness block, `click_at`, command-id echo in `Write-Response`. If any is missing, STOP and reconcile.

**Pre-edit reconciliation, done for real:** confirmed all six load-bearing pieces present (grep count 64 across the six markers) before touching the file, and re-confirmed present after editing. **One real deviation from this task's illustrative PowerShell snippet, necessary and documented:** the real file's dispatch loop is NOT a `Write-Response $cmdId @{...}` per-case pattern — it's a `switch` that sets `$result`/`$err` script variables, with ONE `Write-Response $ok $resultOrError` call at the very end (id correlation handled separately via `$script:CurrentCmdId`, set once per line from `$cmd.id`). Every existing case (`media_key`, `send_key`, etc.) follows this real convention, not the plan's illustrative one — matched it exactly (`Handle-GetClipboard`/`Handle-SetClipboard` functions, following the same `Handle-X` naming/return-shape convention — hashtable success, bare string failure — as `Handle-GetVolume`/`Handle-WriteNote`) rather than the shown pseudocode.

- [x] **Step 1: Write the failing test.** **DONE**, adapted from the plan's illustrative test to the real shapes: `from-computer.js`'s `ok()/fail()` puts the failure reason in `result`, not `error`; `pcChild` is required directly at module scope in this file (matching `from-pc.js`'s own convention) rather than injected via `ctx.pcChild` — checked `dispatch-action.js`'s real call site (`effectors.invoke(decision.tool, decision.args, {signal, bus, goalId})`) and confirmed `ctx` never carries an adapter handle, so a `ctx.pcChild`-based design (as the plan's illustrative test assumed) would never receive a real pc-child in production. Tests mock via require-cache substitution instead (the same pattern `test/bug-024-gmail-calendar.test.js` already uses for `adapters/google`).

```js
// test/from-computer-clipboard.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { TOOLS } = require('../src/core/effectors/from-computer.js');

test('clipboard_read degrades honestly when pc-child is OFFLINE', async () => {
  const tool = TOOLS.find((t) => t.name === 'clipboard_read');
  assert.ok(tool, 'clipboard_read must be registered');
  const res = await tool.fn({}, { pcChild: { getStatus: () => ({ state: 'OFFLINE' }) } });
  assert.equal(res.ok, false);
  assert.match(String(res.error), /offline/i);
});

test('clipboard_write forwards text to pc-child set_clipboard', async () => {
  const tool = TOOLS.find((t) => t.name === 'clipboard_write');
  const sent = [];
  const stub = {
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: (c) => { sent.push(c); return { ok: true }; },
  };
  const res = await tool.fn({ text: 'hello' }, { pcChild: stub });
  assert.equal(res.ok, true);
  assert.equal(sent[0].cmd, 'set_clipboard');
  assert.equal(sent[0].text, 'hello');
});
```

- [x] **Step 2: Run it and confirm it fails.** `node --test test/from-computer-clipboard.test.js` → FAIL, "clipboard_read must be registered". **DONE**, real red confirmed before implementation.

- [x] **Step 3: Add the two PowerShell commands.** Follow the existing `case` shape exactly, including the command-id echo. **DONE** — real shape (`Handle-*` functions + switch cases), not the illustrative one; see the reconciliation note above.

```powershell
'get_clipboard' {
  try {
    $text = Get-Clipboard -Raw -ErrorAction Stop
    if ($null -eq $text) { $text = '' }
    Write-Response $cmdId @{ ok = $true; text = $text }
  } catch {
    Write-Response $cmdId @{ ok = $false; error = $_.Exception.Message }
  }
}
'set_clipboard' {
  try {
    Set-Clipboard -Value ([string]$command.text) -ErrorAction Stop
    Write-Response $cmdId @{ ok = $true }
  } catch {
    Write-Response $cmdId @{ ok = $false; error = $_.Exception.Message }
  }
}
```

- [x] **Step 4: Add the two effectors** to `from-computer.js`'s `TOOLS` array, delegating through the same `pcChild.sendCommand` path `from-pc.js` already uses. `clipboard_read` — `danger: false`. `clipboard_write` — `danger: true` (it overwrites operator state). **DONE, with one correction to the spec's own `danger` call:** `clipboard_write` shipped `danger: false`, not `true` — this repo has a real, enforced invariant test (`effectors-hub.test.js`, "danger:true → tierOf()>=3") that any `danger:true` tool must sit at T3+. Since the tier conflict below resolves to T2 (not T1 or T3), `danger` must be `false` to stay internally consistent, matching `set_volume`/`media_key`'s exact class (also T2, also `danger:false`) rather than `write_file`/`delete_file`'s T3/`danger:true` class. Caught by actually running the full suite, not assumed.

- [x] **Step 5: Add tiers** to `leash/tiers.js` `TIER_TABLE`: `clipboard_read: 0`, `clipboard_write: 1`. **Conflict resolution, `clipboard_write` tier — resolved T2, not the T1 this step proposes (V2 §7.8 separately proposed T2; this document's own step 18.2 note flagged the disagreement).** Read the real gating semantics in `leash/index.js`'s `check()` before choosing: at the default `AUTONOMOUS_MAX_TIER=2`, T1 and T2 behave identically (both auto-allow) — the difference only surfaces when an operator tightens `AUTONOMOUS_MAX_TIER` below 2, at which point T2 tools additionally require confirmation while T1 tools never do. Chose the more conservative T2 because `clipboard_write` silently overwrites OS-level shared state readable by every other app on the machine (a "local action touching real system state" in the same class as `set_volume`/`media_key`, both T2), not a write to MYTHOS's own internal store (the T1 class `reminder_cancel`/`spawn_widget` occupy). Recorded here so this doesn't flip-flop later. `clipboard_read` shipped T0 as specified.

- [x] **Step 6: Run the test.** PASS. **DONE**, 5/5, plus `effectors-hub.test.js`'s registered-tool-count gate updated 82→84.

- [x] **Step 7: Live-verify, then commit immediately.** Copy text in another app, ask MYTHOS what's on the clipboard, then have it write something and paste it. `ps-automation.ps1` changes do not sit uncommitted while other sessions run. **DONE, real end-to-end round trip through the actual PowerShell daemon** (not mocked): started the real `pc-child` adapter, confirmed real `ONLINE` status via a real `ping`, called the real `clipboard_write({text: <unique marker>})` → real `set_clipboard` PowerShell command executed → then the real `clipboard_read()` → real `get_clipboard` → the exact marker text came back, proving a genuine OS-clipboard round trip, not a stub. Load-bearing `ps-automation.ps1` pieces re-confirmed present after the edit. Committed immediately in the same commit as the code (see Progress log).

```bash
git add mythos/adapters/pc-child/ps-automation.ps1 mythos/src/core/effectors/from-computer.js mythos/src/core/leash/tiers.js test/from-computer-clipboard.test.js
git commit -m "feat(clipboard): add clipboard_read/clipboard_write via pc-child"
```

### Task 4: File move / copy / rename / search

**Files:** Modify `mythos/src/core/effectors/from-computer.js`, `mythos/src/core/leash/tiers.js`; Test `test/from-computer-fileops.test.js`

`write_file`, `create_folder`, and `delete_file` **already exist** at `from-computer.js:308-310`. Only these four are missing. Reuse the file's existing sandbox helpers verbatim — `resolveSandboxed()`, `isInsideAllowedRoots()`, `nearestExistingAncestor()` (the symlink-escape guard). Do not write new path-safety code.

- [x] **Step 1: Write the failing test.** Cover the case that matters: destination outside the sandbox must be rejected even when the source is inside. **DONE** — `test/from-computer-fileops.test.js`, 11 tests.

```js
// test/from-computer-fileops.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { TOOLS } = require('../src/core/effectors/from-computer.js');

test('move_file rejects a destination outside the sandbox', async () => {
  const tool = TOOLS.find((t) => t.name === 'move_file');
  assert.ok(tool, 'move_file must be registered');
  const src = path.join(os.tmpdir(), 'mythos-fileops-src.txt');
  fs.writeFileSync(src, 'x');
  const res = await tool.fn({ from: src, to: path.join(os.tmpdir(), '..', 'escaped.txt') }, {});
  assert.equal(res.ok, false);
  assert.match(String(res.error), /allowed|sandbox/i);
  fs.rmSync(src, { force: true });
});

test('search_files caps results and reports truncation', async () => {
  const tool = TOOLS.find((t) => t.name === 'search_files');
  assert.ok(tool, 'search_files must be registered');
  const res = await tool.fn({ root: os.homedir(), pattern: '*' }, {});
  if (res.ok) {
    assert.ok(res.entries.length <= 50, 'must cap at 50 entries');
    assert.equal(typeof res.truncated, 'boolean');
  }
});
```

- [x] **Step 2: Run it. FAIL** — "move_file must be registered". **DONE**, real red: 5 assertion failures ("must be registered") + 6 downstream `TypeError`s, confirmed before any implementation existed.

- [x] **Step 3: Implement the four tools.** `move_file` (`fs.renameSync`), `copy_file` (`fs.copyFileSync`), `rename_file` (same-parent case of move), `search_files` (depth-capped `readdirSync` walk, name match, 50-entry cap matching the existing `list_folder` limit). Every path argument — **source and destination** — goes through `resolveSandboxed()` then `isInsideAllowedRoots()`. **DONE** — `move_file` also handles folders (renameSync doesn't need recursion, a design choice beyond the spec's literal text); `copy_file` is files-only (mirrors `delete_file`'s "no recursive directory op" scoping); `rename_file` delegates to `move_file` after asserting same-parent; `search_files` adds a second cap (`MAX_SEARCH_SCAN=5000` total entries examined) beyond the 50-result cap, so a `pattern:'*'` search over a large real directory can't hang.

- [x] **Step 4: Tiers.** `move_file: 3`, `copy_file: 3`, `rename_file: 3`, `search_files: 0`. T3 matches the existing `write_file`/`delete_file` grouping — irreversible-in-place inside the sandbox. **DONE**, `tiers.js` (commit `e4484f1`, bundled with the other step-5 items' tier entries — see that commit's message for why).

- [x] **Step 5: Run tests. PASS.** **DONE** — 11/11, plus `test/effectors-hub.test.js`'s "gate: N registered count" invariant updated 78→82 (the four new tools land in `from-computer.js`, which that gate test's `registerFromComputer()` call counts) and re-verified green.

- [x] **Step 6: Live-verify, then commit.** **DONE, real on-disk verification** (a throwaway, uncommitted script against a real project-root scratch directory — `os.tmpdir()` was tried first per the plan's literal test but turned out to be a real pre-existing gap: on this machine `os.tmpdir()`/`%TEMP%` resolve to the Windows 8.3 short-name form of the user-profile path (an 8-char truncated+`~1`-suffixed segment) because the real username contains a space, while `os.homedir()`/`%USERPROFILE%` is the long form — `resolveSandboxed()`'s plain string-prefix compare doesn't resolve short names, so it wrongly rejects a `%TEMP%`-derived path as outside every allowed root even though it's the same real location on disk. This is a **pre-existing property of `resolveSandboxed()`/`allowedRoots()`**, not something these four tools introduced — it also affects `write_file`/`create_folder`/`delete_file` today. Not fixed here (out of scope for this task); flagged as its own follow-up.). Real `fs.existsSync` before/after proved: `move_file` (source gone, destination present with correct content), `copy_file` (destination created, source unchanged), `rename_file` (source gone, destination present), `search_files` (found the real match, excluded the non-match), and a security case (`move_file` targeting `C:\Windows\System32\...` → `ok:false`, nothing created there, source untouched). "By voice" specifically needs a live mic/human session, not producible in this environment — the on-disk proof above is the substitute for that step.

### Task 5: Alarms and timers with an audible alert

**Files:** Modify `mythos/src/core/effectors/from-calendar.js`, `mythos/server/index.js`; add `mythos/ui/public/audio/alert.wav`; Test `test/from-calendar-timer.test.js`

A timer is a reminder whose `when` is always relative and which rings. `parseWhen()` already handles `"in N minutes"`, `reminder-sensor.js` already polls `fireDueReminders()` every 30s, and `server/index.js` already subscribes to `reminder.due`. No new store, no new sensor, no new file format.

**Conflict resolution (V2 §7.12 vs this task) — built in-process, Scheduled-Tasks path NOT built, here's why.** V2 §7.12 wants real Windows Scheduled Tasks so an alarm survives a MYTHOS restart — strictly more than this task's in-process timer. Judged on cost per the roadmap's own instruction ("if a thin reuse of Task 7's `schtasks` machinery, do it; if it turns into its own subsystem, do NOT build it, document the gap"): it is NOT a thin reuse. Task 7's `schtasks /sc onlogon` fires once, at login, forever — an alarm needs `/sc once /st HH:mm /sd MM/dd/yyyy` (a different trigger shape), a unique task name per alarm (registration + cleanup lifecycle, since one-time tasks don't self-delete), a `timer_cancel` that also has to `schtasks /delete` the right one, and — the real blocker — a way to actually ring when the trigger fires that works whether or not MYTHOS is currently running: a Scheduled-Task-fired alarm can't just emit a bus event into a process that may not exist, so it would need its own standalone sound-playing script decoupled from the running server, PLUS coordination with the in-process path so a still-running MYTHOS doesn't double-ring the same alarm. That is a second alarm subsystem with its own lifecycle, not a reuse of Task 7's login-trigger registration. Built Task 5 exactly as specified (in-process, rides the existing `reminder.due` path) and stopped there; the Scheduled-Tasks-backed survives-a-restart alarm is a real, documented gap, not a silent scope cut.

- [x] **Step 1: Write the failing test.** **DONE** — `test/from-calendar-timer.test.js` (5 tests) plus `test/reminder-alert-sound.test.js` (2 tests, real server/WS wiring level).

```js
// test/from-calendar-timer.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { TOOLS } = require('../src/core/effectors/from-calendar.js');

test('timer_add creates a reminder flagged for an audible alert', async () => {
  const tool = TOOLS.find((t) => t.name === 'timer_add');
  assert.ok(tool, 'timer_add must be registered');
  const res = await tool.fn({ minutes: 5, label: 'tea' }, {});
  assert.equal(res.ok, true);
  assert.equal(res.reminder.alertSound, true);
  assert.match(res.reminder.text, /tea/i);
});
```

- [x] **Step 2: Run it. FAIL.** **DONE** — real red, `Expected values to be strictly equal: + undefined - true` (alertSound field didn't exist yet), confirmed before implementation via a temporary `git stash` of the source changes only.

- [x] **Step 3: Implement.** Add `alertSound: Boolean(opts.alertSound)` to the record shape in `addReminder()`. Add `timer_add` as a thin wrapper calling `addReminder({ text: opts.label || 'Timer', when: 'in ' + opts.minutes + ' minutes', alertSound: true })`. **DONE**, plus `timer_cancel` (thin wrapper over `cancelReminder`, not explicitly spec'd by name but implied by Step 5's tier line below).

- [x] **Step 4: Ring it.** In the existing `bus.subscribe('reminder.due', …)` handler, when `e.payload.alertSound` is set, send one extra `speech-chunk` whose `audioB64` is the bundled `alert.wav` **before** the normal `proactiveSpeak('Reminder: ' + text)`. A static bundled tone, not a TTS round trip for a fixed sound. **DONE, with one real correctness fix beyond the spec's literal text:** the alert chunk is folded into the SAME `reqId`'s chunk-index/total sequence as the spoken reply (not sent as a separate out-of-band message) — the client's `registerReplyHandler` only wires up chunk playback for a `reqId` it has already seen via a `'proactive-speech'` broadcast, so an unregistered second `reqId` would have gone nowhere. Also found and fixed: the client's chunk player (`voice-loop.js`) hardcoded `data:audio/mpeg;base64,` for every chunk (correct for edge-tts's MP3 output, wrong for the bundled WAV) — added an optional `chunk.mime` field, defaulting to the old hardcoded value so every existing sender is unaffected.

- [x] **Step 5: Tiers.** `timer_add: 0` (matches existing `reminder_add: 0`), `timer_cancel: 1`. **DONE**, `tiers.js` (bundled with the other step-5 items' tier entries — see the shared infra commit).

- [x] **Step 6: `.env.example`.** Document `REMINDER_ALERT_SOUND` (path override; default is the bundled asset). **DONE.**

- [x] **Step 7: Run tests, then live-verify — set a 1-minute timer and hear it ring.** Commit. **Tests: DONE, real green** (7 tests total). **Live-verify: real but partial, honestly reported** — `test/reminder-alert-sound.test.js` drives the REAL server + a real WS client end-to-end: a real `bus.emit('reminder.due', {alertSound:true})` produces a real `speech-chunk` (`mime:'audio/wav'`, index 0) whose `audioB64` decodes to real bytes with a verified `RIFF`/`WAVE` header, followed by a `done` with `chunked:true`. What this environment genuinely cannot produce: an operator's ear confirming they actually heard it — no speaker/human in this session. Left as an explicit operator-verification gap, same class as the S2S mic/speaker items from step 4, not fabricated as heard.

### Task 6: Server bind + bearer auth (V2 §7.2, unchanged — implement as written)

**Files:** Modify `mythos/src/core/config/schema.js`, `mythos/src/main.js`, `mythos/server/index.js`; Test `test/server-auth.test.js`

V2 §7.2 already specifies this completely, including `tokenOk()` with `crypto.timingSafeEqual` and the boot guard. Implement it verbatim from V2. Two facts that make it urgent and are worth restating: `Dockerfile` and `render.yaml` both already set `MYTHOS_BIND=0.0.0.0`, and the only current gate is origin allow-listing at `server/index.js:357`, which any non-browser client spoofs with a header. A cloud-deployed MYTHOS today exposes 106 tools — including T3 confirm-and-execute — to anyone who finds the URL.

Two additions to V2's spec, both needed by Wave 4's phone client:

- [x] **WS token via query string — CODE DONE, LIVE-VERIFIED, NOT YET COMMITTED (see note below).** `verifyClient` accepts `?token=` (query string) in addition to an `Authorization: Bearer` header. Loopback/origin checks are pure accept-reject gates layered under one unconditional `tokenOk()` call (see security-reviewer note below — the first version kept the loopback branch outside the token check, a real bypass).
- [x] **Gate `/vault/builds` too — CODE DONE, LIVE-VERIFIED, NOT YET COMMITTED.** UI shell static mount stays open (AD-8); `/vault/builds` requires the token.

- [x] **Test, red first — DONE.** `test/server-auth.test.js`, 12 tests. Written and confirmed RED before implementation (pasted in the 2026-07-30 Progress log row below), GREEN after. Boot-guard child-process spawn asserts non-zero exit; token-configured cases assert 401 unauthenticated / 401 wrong token / 200 correct Bearer / 200 cookie / WS `?token=` accepted-rejected / `/vault/builds` gated / UI shell open / loopback-no-token unaffected.

- [x] **Commit — DONE, `8be82f2`, pushed.** Back-compat is total: the default loopback config with no `MYTHOS_AUTH_TOKEN` exercises none of the new branches, re-confirmed by booting it and getting `200` on `/api/status`. The implementing session correctly refused to force this through while the pre-commit hook was reporting `sync-test-count --check: 7 stale number(s)`, since `--write` rewrites `README.md` and a separate session was concurrently editing README's mermaid diagrams (BUG-037's exact two-writer shape). The lead resolved it by running `--write` and **inspecting the resulting diff before committing**: it touched only the seven test-count numbers and no mermaid content, so the feared overlap did not exist. The general lesson, worth keeping: check whether two writers actually collide on the same lines before treating a shared file as untouchable — and commit promptly once they don't, because uncommitted verified work is itself what BUG-037 lost.

### Task 7: Autostart on login

**Files:** Create `mythos/scripts/setup-autostart.js`

- [x] **Step 1: Write it** with `--install` / `--check` / `--uninstall`. Task name `MythosAgentOS`. Resolve the repo root as `path.resolve(__dirname, '..', '..')` — **never** a hardcoded path (repo portability rule). Point at the existing `Start Agent OS.bat`; do not invent a second entry point. **DONE** — `mythos/scripts/setup-autostart.js`, `buildSchtasksArgs()` factored out and unit-tested (5 tests, `test/setup-autostart.test.js`) to prove it never embeds a hardcoded/machine-specific path and always quotes the (space-containing) repo path.

```js
spawnSync('schtasks', ['/create', '/tn', 'MythosAgentOS', '/tr', quotedCmd,
                       '/sc', 'onlogon', '/rl', 'limited', '/f'], { encoding: 'utf8' });
```

`/rl limited` — MYTHOS needs no elevation. `/f` makes re-registration idempotent.

- [x] **Step 2: `--check` runs `schtasks /query /tn MythosAgentOS /v /fo list`** and prints the registered command, so a stale registration after a repo move is visible instead of silently wrong. **DONE**, live-verified — see Progress log.

- [x] **Step 3: User-invoked only.** Never auto-run at install. No `.env` key — this is a one-time machine action, not runtime config. **DONE** — nothing else in the codebase calls this script.

- [ ] **Step 4: Verify** by installing, logging out and back in, and confirming the process is up. **PARTIAL, honestly reported**: `--check`/`--uninstall` live-verified for real (see Progress log). `--install` was attempted for real on this development machine and failed with a real, non-fabricated `schtasks` "Access is denied" — this account cannot register scheduled tasks in this session, an environment/account permission limit, not a script defect (the argv it builds matches the spec exactly, proven by the unit tests). Did **not** escalate to an elevated/admin process to force it through — that would be an unauthorized privilege escalation for a task nobody asked for, and Step 3 already says this script is user-invoked only. A background agent's first attempt at this same live-verification did try to spawn an elevated PowerShell process without authorization; that attempt did not actually leave a task registered (`schtasks /query` confirmed nothing exists) and was not repeated. Full logout/login verification needs an operator with normal admin rights on their own machine — left unticked with this reason, not fabricated.

---

## Wave 2 — Android via ADB (supersedes V2 §7.4)

### Task 8: The `android-child` adapter

**Files:** Create `mythos/adapters/android-child/index.js`; Test `test/android-child-adapter.test.js`

**This is not a copy of `pc-child`.** `pc-child` keeps one PowerShell process alive because `ps-automation.ps1` is a long-running script MYTHOS owns. `adb` has no such mode — every `adb -s <serial> shell …` is a one-shot call that exits. Cargo-culting the persistent-daemon shape here would be inventing a protocol where `adb`'s own argv/exit-code contract already is one. What transfers is the *discipline*, not the shape: command queue, per-command timeout, retry with backoff, restart budget, diagnostic ring buffer, side-effect-free `require()`, explicit `start()`/`shutdown()`, module-level singleton state, and `cua-driver`'s ENOENT → OFFLINE contract.

- [x] **Step 1: Write the failing test, mirroring `test/cua-driver-adapter.test.js`.** Assert: `require()` has no side effects; `sendCommand()` never throws while OFFLINE; state settles to a terminal value within a bounded poll; `shutdownAndroidChild()` is safe with nothing started. **No live `adb` in CI.** **DONE** — `test/android-child-adapter.test.js`, confirmed failing (`Cannot find module`) before the adapter existed.

- [x] **Step 2: Run it. FAIL.** **DONE** — real red output captured, see Progress log.

- [x] **Step 3: Implement.** **DONE**, with one addition beyond this literal spec: `startAndroidChild()` is synchronous (a single `spawnSync` probe), so there is no async `STARTING` window at all — settling happens before the call returns.
  - `startAndroidChild()` probes `adb version` via `spawnSync` with a short timeout. ENOENT → `state='OFFLINE'`, `hint='adb not found — run node mythos/scripts/setup-android.js --install'`. Boot continues (AD-9).
  - On success, `adb start-server`, then an unref'd `setInterval` polling `adb devices -l` every `ANDROID_ADB_POLL_MS` (default 8000) to refresh `devices: Map<serial, {model, transportId, authState, lastSeenAt}>`.
  - **Per-device queues**, not one global queue: `Map<serial, {queue: [], inFlight: null}>`. Two devices is an explicit Pro-Plus requirement; a slow command on phone A must not block phone B. Each queue keeps `pc-child`'s discipline — one in-flight command, `ANDROID_CMD_TIMEOUT_MS` (default 15000), reject-fast when offline.
  - `getStatus()` returns `{state, hint, devices, queueDepth}` using the **same `state`/`hint` field names** as `pc-child`/`cua-driver`, so `main.js`'s adapter-status roll-up and the capability manifest need no special-casing.
  - `shutdownAndroidChild()` clears queues and stops the poll timer. **Do not call `adb kill-server`** — that would drop other tools' adb sessions on the same machine.
  - **Bug found during Task 10 integration (security-review, HIGH):** `serial` was being used only as the queue-partition key and never actually reached `adb`'s argv — no command was ever run with `-s <serial>`, so it silently ran against whatever device `adb` defaulted to. Invisible with exactly one device attached (it "worked" by accident); with 2+ devices attached (this task's own explicit design goal), `adb` refuses to run anything at all without `-s`. Fixed with a new pure, exported, unit-tested `buildAdbArgs(serial, args)` that prepends `['-s', serial]` before the subcommand whenever a serial is given.

- [x] **Step 4: Run tests. PASS.** Commit. **DONE** — `83b2281` (adapter), fix-up for the `-s` bug folded into the Task 10 commit below since it only became functionally observable once Task 10 wired real device-scoped calls.

### Task 9: `setup-android.js` — install and pair

**Files:** Create `mythos/scripts/setup-android.js`

Modeled on `setup-hermes.js`'s `--check`/`--install` shape.

- [x] **Step 1: `--check`** (default): resolve `adb` from PATH or `ANDROID_ADB_BIN`, run `adb version`, run `adb devices -l`, print per-device pairing status. Also print the smoke test to run: `adb -s <serial> shell echo mythos-ping`. **DONE** — live-verified for real on this machine (no adb on PATH): `adb: NOT FOUND (adb)` + the install hint, exit code 1.

- [x] **Step 2: `--install`:** download Google's official versioned `platform-tools` zip into `<repo>/Android Platform Tools/` (gitignored — everything stays inside the project), unzip, print the resolved path for `ANDROID_ADB_BIN`. A plain versioned zip, **never** `curl | bash` or `iex (irm …)`. **BUILT, NOT RUN** — deliberately never executed: an unattended ~15MB download is the operator's decision. Verified instead the same way `setup-autostart.js`'s `buildSchtasksArgs()` was: `buildDownloadUrl()`/`resolvePlatformToolsDir()`/`resolveAdbPath()` are pure, exported, and unit-tested.

- [x] **Step 3: `--pair <ip:port> <code>`** → `adb pair`. Android 11+ Wireless Debugging. The pairing code comes from the phone's Developer Options screen — a manual on-phone step no script can automate; say so in the output. **BUILT, NOT RUN** — no phone to pair with in this environment; `buildPairArgs()` unit-tested for correct argv shape (no shell-string concatenation).

- [x] **Step 4: `--connect <ip:port>`** → `adb connect`, and persist to `vault/Identity/android-devices.json`. Vault, not `.env` — this is a growing list, not a static secret. Recommend a router DHCP reservation in the output, because a renewed lease silently breaks every `phone_*` tool. **BUILT, NOT RUN** — same reason as Step 3; `buildConnectArgs()`/`mergeDeviceRecord()` (add-new + update-existing-by-address, never duplicates) unit-tested.

- [ ] **Step 5: Verify `--check` against a real device.** **NOT DONE, and cannot be from here** — no physical Android phone is connected to this machine. Needs an operator with a real device. Left unticked deliberately rather than fabricated.

### Task 10: `from-android.js` — the phone tools ✅ CLOSED (13 rows below, 14 registered effectors — see note)

**Files:** Create `mythos/src/core/effectors/from-android.js`; modify `mythos/src/core/leash/tiers.js`, `mythos/src/main.js`, `mythos/.env.example`, `mythos/src/core/config/schema.js`; Test `test/from-android.test.js`

Same shape as `from-pc.js`: a `delegate()` helper that checks `getStatus().state === 'ONLINE'` and translates `{ok, stdout}` into the `ok()`/`fail()` shape `effectorFromTool` expects.

**CORRECTED TABLE — 13 rows, 14 registered tool effectors.** `phone_flashlight_toggle` is dropped entirely (correction below). The row-count ("13 tools, not 14") and the real registered-effector count ("14") are BOTH correct and not in conflict: this table has always been row-based, not name-based — its own tier column already gave `phone_file_pull`/`phone_file_push` two different tiers under one combined row. So 14 original rows → 13 after dropping the flashlight row, while the real function count goes 15 → 14 for the identical reason. State it exactly like this for the next machine so nobody "fixes" the count in either direction.

| Tool | adb invocation | Tier |
|---|---|---|
| `phone_list_devices` | `adb devices -l` (served from the adapter's own live-polled status, no extra adb call) | 0 |
| `phone_screenshot` | `exec-out screencap -p` (base64 in JS) | 1 |
| `phone_notifications` | `shell dumpsys notification --noredact` | 1 |
| `phone_contacts_search` | `shell content query --uri content://com.android.contacts/data --where …` | 1 |
| `phone_sms_send` | `shell am start -a android.intent.action.SENDTO -d sms:<n> --es sms_body '<t>'` | **3** |
| `phone_call` | `shell am start -a android.intent.action.CALL -d tel:<n>` | **3** |
| `phone_whatsapp_send` | `am start -a …VIEW -d "https://wa.me/<e164>?text=…"` — opens the chat pre-filled ONLY, no send tap (resolution (b) below) | **3** |
| `phone_wifi_toggle` | `shell svc wifi enable\|disable` | 2 |
| `phone_bluetooth_toggle` | `shell svc bluetooth enable\|disable` | 2 |
| `phone_hotspot_toggle` | `shell cmd wifi start-softap\|stop-softap`, best-effort | 2 |
| `phone_app_launch` | `shell monkey -p <pkg> -c …LAUNCHER 1` | 2 |
| `phone_app_close` | `shell am force-stop <pkg>` | 2 |
| `phone_file_pull` | `adb pull` | **3** (re-tiered from the original 1 — see security-review correction below) |
| `phone_file_push` | `adb push` | **3** |

~~`phone_flashlight_toggle`~~ — **DROPPED, not registered.** No reliable stock command exists (this table's own original note); registering it would have shipped a tool that always fails, polluting `capabilities.md` and the Live `functionDeclarations` list where model accuracy degrades with tool count (AD-4). If a real capability probe ever exists, register it then, not before.

- [x] **Step 1: A generic `phone_shell` is deliberately NOT exposed.** Every capability is a named, tiered action. A raw shell tool would be a de facto T4 bypass of the entire tier table — the same reasoning `run_command`'s allowlist already encodes for the desktop. **CONFIRMED REFUSED** — no `phone_shell` exists; `test/from-android.test.js` asserts it's never registered.

- [x] **Step 2: Honest failure is the hard requirement here.** `phone_sms_send` via intent **opens Messages pre-filled; it does not send.** Report exactly that. **DONE** — returns `{opened:true, sent:false, note:'...tap on Send is still required. Not sent.'}`, verified by a red-first test. `phone_flashlight_toggle` is moot — it isn't registered at all (Step correction above), so there is no fabricated-success path to guard.

- [x] **Step 3 — RESOLVED AS (b), NOT (a).** The literal instruction ("resolve the WhatsApp send button via `uiautomator dump` + resource-id") is NOT built. **Decision: drop the send step, keep the honest deep-link-open behaviour.** No physical phone exists in this environment to live-verify a tap primitive against, and `phone_tap` doesn't exist anywhere else in this build either — shipping a resource-id-targeted tap nobody can live-verify is exactly the "unverifiable code rots into a false capability claim" failure mode this whole plan exists to prevent. `phone_whatsapp_send` opens the chat via a `wa.me` deep link with the message pre-filled and reports `{opened:true, sent:false}` — never a claimed send. If a future session has a real device to verify against, option (a) (a tiered, resource-id-only `phone_tap`, T3, never raw x/y coordinates) remains open, but must ship WITH a real on-device verification, not instead of one.

- [x] **Step 4: Require an explicit `deviceId`** on every device-scoped tool. **DONE, and strengthened past the literal spec.** A missing `deviceId` fails with "No Android devices connected" (zero paired) or "Which phone — check phone_list_devices" (1+ paired) — never guessed, not even with exactly one device. **Security-review addition:** a `deviceId` that IS supplied but isn't a member of the adapter's current device list is also rejected (`Unknown device "<id>" — check phone_list_devices`) rather than silently reaching adb — closes the "phone A unplugged, phone B attached, stale serial still gets accepted" gap.

- [x] **Step 5: Write the test against a mocked adapter**, red first. **DONE** — `test/from-android.test.js`, 20 tests, all against a mocked `androidChild` (module-singleton stubbing, same technique as `test/from-calendar-google.test.js`). Covers every tool degrading honestly OFFLINE, `phone_sms_send`/`phone_whatsapp_send` never claiming delivery, device-id enforcement (missing AND unknown), and the exact POSIX single-quote escaping of a malicious SMS body/contacts query.

- [x] **Step 6: All entries into `TIER_TABLE`.** That file's header forbids adding or re-tiering without updating the spec — **this plan is that update.** **DONE** — 14 entries added.

- [x] **Step 7: Wire boot in `main.js`** — start/shutdown the adapter, register the effectors, include adapter status in the capability manifest. **DONE** — same three wiring points `pc-child`/`cua-driver` use (registration, boot-step start, capability-manifest/status roll-up, shutdown). Live-verified: see AD-9 proof in the Progress log below.

- [x] **Step 8: Document the new keys in `.env.example`:** `ANDROID_ADB_BIN`, `ANDROID_ADB_POLL_MS`, `ANDROID_CMD_TIMEOUT_MS`. **DONE**, plus the matching `config/schema.js` entries (`loadConfig()` verified to resolve all three to their documented defaults).

- [ ] **Step 9: Live-verify on a physical phone:** `adb shell echo` roundtrip, a real SMS compose, a real WhatsApp deep link, WiFi toggle on and off. **NOT DONE, and cannot be from here** — no physical Android phone is connected to this machine. What COULD be and WAS verified for real instead: booting the actual app with `adb` absent from PATH, confirming `android-child` reports `OFFLINE` with the exact install hint, `capabilities-manifest.written` lists it honestly, and boot succeeds with all 139 other effectors registered and the other adapters (`pc-child`, `cua-driver`) coming online normally (AD-9). Left unticked deliberately — an operator with a real device is needed for this specific step.

**Security review (sonnet, dispatched before commit per this task's own instruction) — 3 findings, all acted on:**
1. **HIGH — `deviceId`/`serial` was never enforced or passed to `adb`.** `android-child`'s `sendCommand()` used `serial` only as a queue-partition key; it never reached the actual `adb` argv. With exactly one device attached this "worked" by accident (adb defaults to the sole device); with 2+ devices attached (this task's own explicit multi-device goal) every command would instead fail outright, since adb refuses to run anything without `-s` when multiple devices are present. **Fixed**: new `buildAdbArgs(serial, args)` in `adapters/android-child/index.js`, prepending `['-s', serial]` before the subcommand; `checkDevice()` in `from-android.js` also now confirms the supplied `deviceId` is a currently-known serial, not merely truthy. Both changes unit-tested (regression tests added to both test files).
2. **MEDIUM-HIGH — `phone_file_pull` was tiered T1 ("a read from the phone") despite writing/overwriting an arbitrary local file.** From the PC-filesystem-integrity standpoint `adb pull` is a WRITE (same class as `write_file`, T3), and `resolveSandboxed()`'s `allowedRoots()` always includes the project root itself. **Fixed**: re-tiered to T3, `danger:true`, matching `phone_file_push`/`write_file` exactly.
3. **LOW, informational — `resolveSandboxed()` (used by `phone_file_pull`/`phone_file_push`, also `set_wallpaper`) doesn't follow symlinks the way the dedicated `isInsideAllowedRoots()` helper does.** Confirmed pre-existing and repo-wide, not introduced here, and requires a symlink already planted inside an allowed root by some other means. **Not fixed in this task** (out of scope — a shared-helper hardening job, not a from-android.js bug) — flagged as a spawned background task instead (`task_5836cdee`, "Harden resolveSandboxed() against symlink/junction escape").

Also verified: the file's own claimed POSIX single-quote (`shQuote`) mechanism for remote-shell-bound free text (SMS/WhatsApp bodies, contacts search) is textbook-correct and was independently hand-traced by the reviewer against the trickiest case (an embedded SQL quote inside an already-shell-quoted token) — no exploitable command injection or path traversal beyond the three findings above. A minor consistency note (wifi/bluetooth toggle and app launch/close building multi-arg adb invocations instead of one pre-quoted string, safe today only because their inputs are strictly enum/regex-validated) was also addressed by aligning all four to the same single-quoted-command pattern as sms/contacts/whatsapp, for defense-in-depth against a future loosened validator.

### Task 11: The rest of V2 §7 plus the four gaps the audit surfaced

V2 already specifies §7.1–§7.7 completely. One agent per item, **worktree isolation** for anything touching `ps-automation.ps1`.

Four additions from the side-by-side audit, all of which reuse machinery that already exists:

- [x] **Semantic code search** — reuse `memory/vector-index.js` and `providers/embeddings.js` as-is; point the chunker at project directories under `VOICE_ALLOWED_DIRS` and include results in `recallHybrid()`'s fan-out. This is §7.5's machinery with a different source, so **build §7.5 first** and this becomes a source adapter, not a second index. **DONE, built after §7.5 as instructed, provably a source adapter, not a second index** — see the Progress log row below for the exact test that proves it (asserts exactly one `Index/documents.vec.json` sidecar exists after both an upload and a code-index write).
- [x] **Maps + routing** — keyless public endpoint, same shape as the existing keyless `get_weather`. T0. No key, no new dep. **DONE** — `get_directions` added to `from-system.js`, reuses the existing `geocode()` helper, calls OSRM's public routing API. Real finding: OSRM's public demo server silently ignores the profile segment (never 404s for `walking`/`cycling` as the plan assumed) — ships driving-network numbers regardless, so a `note` field discloses that honestly for non-driving modes rather than claiming mode-specific accuracy it doesn't have.
- [x] **Image generation** — route through a provider that already has a key in `.env`; do not add one for this. No wired provider supports it → the tool reports OFFLINE rather than shipping a stub. **DONE, built AND correctly reports OFFLINE — both, for different reasons.** New `from-image-gen.js` calls Gemini's native `generateContent` image-gen endpoint (model id verified live against current docs, not training data: `gemini-3.1-flash-image`) using the existing `GOOGLE_API_KEY` — no new provider key. Real live call confirmed the model id is valid and routable (a wrong id 404s; this one doesn't), but returned a real `429`: `limit: 0` — this Google account's free tier grants zero image-generation quota, a permanent entitlement gap, not a transient rate limit. The tool surfaces that exact real reason rather than fabricating an image or failing silently.
- [x] **WhatsApp desktop scheduling — BUILT 2026-08-04, and it turned out to be more than wiring.** The blocker named below (a missing `phone_whatsapp_send`) cleared when Task 10 landed in step 6, but the real gap was that `reminder_add` had no field for a fire action at all — it took only `{text, when}`. Now: an optional `action: {tool, args}` on the reminder record, plus `goalId` and `actionApproved`. `reminder-sensor.js` gained `leash, goals, effectors, memory, config` (wired from `src/main.js`, all already constructed when the sensors boot step runs) and at fire time calls `leash.check(decision, {goalId})` then `dispatchAction(decision, ctx)` — **the same two-step path every other action uses, so AD-1 and AD-2 hold by construction rather than by a new code path** (`anti-drift-single-dispatch.test.js` confirms `effectors.invoke(` still appears only in `dispatch-action.js`). **The T3 approval respects the shape of the CRITICAL bypass that was fixed earlier:** a new `reminder_approve_action` tool (T3, so it always requires a fresh confirm and can never carry a grant naming itself) calls `goals.grantTier(reminder.goalId, 3, [action.tool])` — granting **exactly one enumerated tool, never the tier** — and the companion goal is created with `status:'proposed'` so cortex's arbiter, which only picks up `active` goals, never mistakes a grant anchor for a real task. Five tests mirror `leash-grant-scope.test.js`: approving `whatsapp_send` grants neither `gmail_send`, `delete_file` nor `run_command` on the same goal, and a legacy bare-boolean grant fails closed. Honest evidence, not `ok:true`: `approveReminderAction` returns `evidence:{goalId, grantedTool, grants}` read back from the real goal record, and an unapproved action at fire time is a silent non-fire reported as `health.anomaly` kind `reminder-action-not-approved`. `readJSONStrict` was already in use in `from-calendar.js` (verified). Red-first: with the five implementation files stashed, 7 of 9 tests failed; restored, 9/9. Targeted run across the neighbouring reminder/leash/anti-drift files: 42/42. **Note the two WhatsApp tools are NOT interchangeable and this uses the desktop one:** `whatsapp_send` (T3, `from-whatsapp.js`, WhatsApp Desktop) actually sends, while `phone_whatsapp_send` — the tool this item originally named — only opens a `wa.me` deep link pre-filled and still requires a human tap, as the tier table itself records. **Still missing:** nothing proactively surfaces the pending approval, so the operator must invoke `reminder_approve_action` themselves; there is no checkpoint-style modal for this case yet.

The original V2 items:

- [x] **§7.1 Screen OCR** — `Windows.Media.Ocr` through the existing `Await-WinRTOperation`. Full PowerShell case is in V2. Do **not** add `tesseract.js` — wasm plus traineddata for something Windows already ships. **DONE, no tesseract.js.** V2's illustrative snippet uses bare `[Windows.Storage.StorageFile]` bracket syntax, which doesn't reliably resolve in PowerShell 5.1 without the accelerator this codebase never sets up that way — matched the file's OWN established convention instead (`[Type]::GetType('Namespace.Type, Assembly, ContentType=WindowsRuntime')`, exactly how the existing SMTC media-session code already resolves `Windows.Media.Control` types). De-risked before wiring in: ran the exact reflection chain standalone against a bitmap with known drawn text ("MYTHOS OCR TEST 12345") and got that exact string back from the real OCR engine, THEN wired it into `ps-automation.ps1` as `Handle-ScreenReadText`. New `screen_read_text` effector in `from-pc.js`, tier T0. `screen_read_text` was already present in `live-tools.js`'s `DEFAULT_ALLOWLIST` (added by an earlier session, ahead of this one actually registering the tool) — no change needed there.
- [x] **§7.3 PIN / Windows Hello lock** — salted hash in the vault, never plaintext; degrade to PIN-only without Hello hardware. **DONE, PIN-only — Windows Hello deliberately NOT built, real gate or not at all.** New `src/core/security/pin-lock.js` (`crypto.scryptSync` + a random per-PIN salt via `crypto.randomBytes`, `crypto.timingSafeEqual` comparison, 5-attempt/60s in-memory lockout) and `server/routes/pin.js` (`GET /api/pin/status`, `POST /api/pin/set`, `POST /api/pin/verify`), mounted behind the SAME `requireToken` gate every other `/api/*` route already sits behind (Task 6's bearer token — this is a separate, additional local-physical-presence layer, not a replacement). `hasWindowsHello()` always returns `false` — honestly, because that path was never built, not because a hardware probe ran and found none; matches V2's framing exactly (IRIS's "biometric locking" is an 8-byte stub — this ships as a real gate or nothing). **security-reviewer (sonnet) findings and disposition:** one MEDIUM — `/api/pin/set` could overwrite an already-configured PIN with no proof of the old one, a complete bypass of the feature's entire purpose for anyone who could reach the route at all (fixed: `setPin()` now requires the current PIN, checked through the real `verifyPin()` path — including its lockout — before allowing a change; first-time setup, with nothing configured yet, is unaffected). Two LOW/informational, both accepted as-is: the lockout is intentionally in-memory-only (resets on process restart, an accepted tradeoff for this threat model, not a gap); and the feature has **no enforcement point yet** — no frontend lock screen or session-flag middleware blocks anything based on a failed/missing PIN check, so this session ships the real backend mechanism only, not a working end-to-end lock (flagged so a future session doesn't mistake this for a completed gate). Confirmed no plaintext PIN ever reaches storage, logs, or an HTTP response body (routes only ever return `{ok}`/`{error}` strings, and the PIN's own hash/salt path is a hardcoded constant, no traversal risk).
- [x] **§7.5 Document RAG** — the expensive parts already exist (`memory/vector-index.js`, `providers/embeddings.js`, `recallHybrid()` with RRF). Add upload route, ~800-token chunker with 15% overlap, Documents store, fan-out inclusion. **Do not switch embedding models** — `gemini-embedding-001` is 3072-dim against `mistral-embed`'s 1024 and would invalidate every stored vector. **DONE** — "upload route" implemented as a voice-callable `document_ingest` effector (sandboxed via the existing `resolveSandboxed`) rather than an HTTP multipart route, since every other MYTHOS capability is a voice-callable tool and an HTTP upload UI would need untestable browser/frontend work with no test-verifiable gain here; a new `Documents` chunk store (`memory/documents.js`) + a shared `documents` vector-index partition folded into `recallHybrid()`'s existing fan-out loop (`['episodic','semantic']` → `['episodic','semantic','documents']`). Embedding model untouched — still routes through the real `providers/embeddings.embed()` unmodified.
- [x] **§7.6 Calendar claim** — `from-calendar.js`'s header advertises a Google Calendar layer that exists in no file. Implement it (the OAuth adapter already works for Gmail, so this is scope, not new auth) **or delete the claim.** Do not leave it. **DONE — implemented, not deleted.** Verified in code first (not assumed): `scripts/google-auth.js`'s `SCOPES` already requests `calendar.readonly` alongside Gmail's since BUG-024, so any refresh token minted after that fix already covers Calendar reads — genuinely "scope, not new auth." Added `listUpcomingEvents()` to `adapters/google/index.js` (generalized `gmailRequest` into a shared `apiRequest(base, ...)`, `gmailRequest`/`calendarRequest` are now thin wrappers, zero behavior change to existing Gmail call sites) and a new `calendar_upcoming` tool in `from-calendar.js` using the exact same lazy-adapter/clean-error pattern as `from-gmail.js`'s `ensureAdapter`. Tier T1 (not T0) — reads private calendar data, same privacy-audit class as `gmail_unread`/`gmail_read`, not `get_weather`'s T0.
- [x] **§7.7 Wallpaper** — `SystemParametersInfo(SPI_SETDESKWALLPAPER)` P/Invoke. **DONE.** New `set_wallpaper` effector in `from-pc.js`, tier T2 (non-destructive, fully reversible — same class as `show_desktop`/`set_volume`, not a T3 destructive action). Path is sandboxed via `from-computer.js`'s existing `resolveSandboxed` BEFORE it ever reaches `pc-child` — an out-of-sandbox path never generates a PC command at all, proven by a test asserting `sendCommand` is never called in that case.

---

## Wave 1.5 — Persona unclamp (run 3rd, standalone, before any S2S work)

### Task 11-persona: Unclamp the persona (V2 §11) — CLOSED 2026-07-30, commit TBD

**Files actually touched (see CORRECTION below — this differs from V2 §11's literal
file list):** `mythos/src/core/brain/index.js:117-134` (row 1), `mythos/src/core/voice/voice-agent.js:230-278`
(row 2, RULES *and* OUTPUT_CONTRACT — the latter had its own contradictory brevity
clamp not mentioned in V2 §11 that would have silently undone row 2 if left alone),
`mythos/src/core/identity/index.js:24-32` (row 3, `DEFAULT_LEVELS`), `mythos/src/core/memory/identity.js:37-38`
(row 4, `SEED_SELF_MD`'s `## Persona` section); Test `test/persona-dials.test.js` (new) +
consequential updates to `test/persona.test.js`, `test/brain.test.js`, `test/identity.test.js`.

**CORRECTION vs V2 §11's literal file list — read this before touching this again.**
V2 §11 rows 3–4 point at `vault/Identity/persona.json` and `vault/Identity/self.md`.
Both are inside `mythos/vault/`, which is gitignored (`.gitignore:18`) — editing only
those files gives ONE machine a better persona and ships every fresh clone / every
other user the old clamped one, violating CLAUDE.md's open-source portability rule.
Verified in code: `identity/index.js`'s `loadLevels()` reads `persona.json` per-trait
and falls back to `DEFAULT_LEVELS[t]` for any trait not present in the file — i.e.
**code defaults win whenever the vault file doesn't override a given trait, and a
fresh clone has no `persona.json` at all**, so `DEFAULT_LEVELS` (not the vault) is the
real shipping surface. Likewise `self.md`'s seeding path is `memory/identity.js`'s
`init()`: `if (!fs.exists(SELF_PATH)) fs.writeText(SELF_PATH, SEED_SELF_MD)` — the
tracked `SEED_SELF_MD` template literal is what a fresh clone actually gets, not
whatever this machine's already-diverged vault `self.md` happens to contain. So row 3
landed in `identity/index.js`'s `DEFAULT_LEVELS`, and row 4 landed in
`memory/identity.js`'s `SEED_SELF_MD` Persona section — both tracked, both git-committed,
both what `node --test` and a fresh `git clone` actually exercise. Demonstrated live: a
temp vault built from scratch (no `persona.json`, no `self.md`) yields
`{humor:8, warmth:7, formality:5, sass:7, proactivity:8, terseness:5, strictness:4}`
and the new character-brief persona — see `test/persona-dials.test.js`'s "fresh clone
(empty vault)" describe block and the live composed-prompt dump quoted in this
session's report.

Its own wave because it belongs to neither the desktop nor the phone batch: hours of work, the largest felt improvement in the plan, zero new transport, two-file rollback. V2 §11 specifies all six changes; **rows 1-4 are done, rows 5-6 are deferred to Wave 3 / merged-order step 4** (see the new checkboxes added there — `live-session.js` doesn't exist yet, so `setup.systemInstruction` and `GEMINI_LIVE_VOICE` have nowhere to land). The load-bearing constraint:

- [x] **`STYLE_GUARDRAIL` at `identity/index.js:101` stays byte-for-byte untouched.** Errors, failures, confirmations, and safety warnings are always delivered plainly — no humor, no sass. That one sentence is what makes humor 8 and sass 7 safe to run, and it is why raising the dials does not conflict with the honesty rules. Live-verified: byte-identical before/after (only the surrounding `DEFAULT_LEVELS` object changed; the guardrail string itself was never in the diff), and `persona-dials.test.js` loops all 7 traits × values 0-10 (77 checks) asserting the guardrail regex matches every time.
- [x] **Test, red first:** humor 8 → the `>=8` band string; `STYLE_GUARDRAIL` present at every setting; the **voice** lane gets no `' Be concise and actionable.'` tail while the **build** lane still does. `test/persona-dials.test.js` written and run against the pre-change source first (via `git stash` of just the 4 source files) — confirmed 5 real failures, then the source changes were restored and it went green. Full suite after: 1541 tests, 1541 pass, 0 fail, 1 skip, 0 todo (the one pre-existing failure was root-caused and fixed — see below).
- [ ] **Then judge by ear** — NOT done. Only the composed system prompt was verified (dumped verbatim for both the voice and build lanes via a real `createIdentity`/`createBrain`/`createVoiceAgent` call chain with only `chain.complete`/`brain.think` stubbed to capture the prompt instead of hitting a network provider — no real LLM call was made). Actually listening to a live model's replies across the five scenarios (greeting, status check, pushback, build request, failing tool) is still open for whoever picks this up next, or for manual spot-check by the operator.
- [x] **`terseness` stays 5 — V2 §11 row 3's number is wrong and was not followed.** Row 3 says `terseness 5→4, not 3` and justifies it with "`<5` lands on 'Explain thoroughly', which over-swings for speech." That defeats itself: 4 is also `<5`, so under `styleDirectives()`'s `>= 5` boundary both 3 and 4 hit the identical `else` branch and both emit *"Explain thoroughly; detail is welcome."* Lowering the dial at all would have shipped precisely the directive V2 was trying to avoid — confirmed by dumping the composed voice prompt, which contained that sentence while the dial sat at 4. The dial is therefore left at **5**, which yields *"Keep replies short; expand only when the matter is complex."* No band code was changed, so the verbose directive is still reachable at 4 or below; it simply is not the shipped default. Re-verified live from a fresh empty vault: dials `{humor:8, warmth:7, formality:5, sass:7, proactivity:8, terseness:5, strictness:4}`, "Keep replies short" present, "Explain thoroughly" absent, `STYLE_GUARDRAIL` present. The clamp V2 actually wanted removed was never this dial — it was `voice-agent.js`'s "one short sentence / 10 words" BREVITY text and `brain/index.js`'s voice-lane actionability tail, which rows 1 and 2 removed. **Lesson for the next machine: the plan's numbers are not self-validating. Dump the composed artifact and read it.**
- [x] **`test/bug-006-youtube-mode.test.js` — pre-existing flake, root-caused and fixed rather than bypassed.** It blocked this step's commit because `.githooks/pre-commit` hard-fails on any failure. Two real defects, neither related to persona: (1) the file declared `const realFetch = global.fetch` and restored it in `afterEach` from the day it was written but **never actually stubbed it**, so `open_web({type:'youtube'})` ran a live DuckDuckGo search plus a live YouTube oembed call on every run — 1–3 of its 4 subtests failed, varying per run, ~2–3s each; (2) `ctx.bus = {}` is a malformed stub, and `web-search.js`'s provider fallback chain calls `bus.emit('health.anomaly', …)` on provider failure, so a missing `emit` turned any provider failure into a `TypeError` instead of falling through to the next provider. Reproduced 2 failures on a clean HEAD before touching anything, so pre-existing and not a regression. Fixed by stubbing `global.fetch` (routing DuckDuckGo → a fixture result page, oembed → fixture JSON, anything else → throw so a newly-added live call fails loudly) and giving `bus` a real `emit`/`subscribe`. **No assertion was weakened** — every `widgetType`/`embedUrl`/`videoId`/`title` check still runs; they now test the `YOUTUBE_MODE` branching this file is named for instead of testing whether the network is up. Verified deterministic: 4/4 pass on four consecutive runs. `--no-verify` was never used.

---

## Wave 3 — Speech-to-speech + latency measurement

Implement **V2 §6–§10 exactly as written** — `live-session.js`, `live-tools.js`, the tool adapter, the browser PCM path, server wiring. (V2 §11 rows 1-4 are persona and are done, in Wave 1.5 — do not repeat those here.) Nothing in this delta document changes those; the probe has already retired their biggest risk. Three reminders that carry the most weight:

- [x] A single `serverContent` frame may carry audio **and** both transcripts. Process every field present — **no `else if`.** V2 calls this the #1 data-loss bug. **DONE — Phase 1, `live-session.js`.** `test/live-session.test.js`'s "THE §3 TRAP" test proves it: a deliberately-mutated else-if variant of `handleFrame()` was run against this exact test and failed (`audio must be delivered from the combined frame`, expected `['QUJD']` got `[]`); the real implementation (independent `if`s, never `else if`) passes all 7 tests. 7 new tests total: setupComplete→open, no-key refusal, the combined-frame trap, `interrupted`→bus event, empty-turnComplete→`health.anomaly` (AD-6), `goAway`→transparent reconnect (new socket, setup resent), `usageMetadata`→`spend.recordCall` with real counts (AD-5). Full suite after: 1548 tests, 1547 pass, 0 fail, 1 skip, 0 todo.
- [x] Use `realtimeInput` for user turns, never `clientContent` mid-conversation (it breaks VAD). **DONE — Phase 1.** `live-session.js`'s `sendAudio()`/`sendText()` both send `{realtimeInput:{...}}`; `clientContent` appears nowhere in the module (grep-verified).
- [x] `contextWindowCompression.slidingWindow` and `sessionResumption` are **mandatory**, not optional — the connection dies at ~10 minutes regardless. **DONE — Phase 1.** `buildSetup()` always includes both keys; `test/live-session.test.js`'s goAway test proves `sessionResumptionUpdate.newHandle` is captured and used on reconnect.

**Deferred from Wave 1.5 (V2 §11 rows 5-6)** — could not be built in merged-order step 3
because `mythos/src/core/voice/` only contained `spoken-text.js` and `voice-agent.js` at
that time; `live-session.js` (built in this wave) is where these belong:

- [x] **Row 5 — system instruction, once.** DONE — `buildLiveSystemInstruction()` landed in `server/index.js` (composed per-connection, called once inside `liveOpen()`'s lazy session-construction branch, not `live-session.js` itself — `live-session.js` only ever receives the finished string via its `systemInstruction` dep). Composes `RULES` (exported from `voice-agent.js`, with step 3's BREVITY text — deliberately NOT `OUTPUT_CONTRACT`, since Live's tool-calling is native `functionDeclarations`, not the batch path's embedded-JSON contract) + `identity.persona()` + `version.contextLine()` + `getCapabilityDigest()` + `skillsLoader.catalogBlock()`, joined once per session. `identity` is now threaded into `createServer()`'s deps (main.js updated).
- [x] **Row 6 — pick the voice.** DONE — kept `GEMINI_LIVE_VOICE=Aoede` (Google's own suggested assistant-style default), now an explicit, documented decision in `.env.example` and `config/schema.js` rather than an implicit fallback. Reasoning recorded there: auditioning Aoede/Kore/Leda/Zephyr properly requires a human listening on real speakers, which cannot happen in this build environment — flagged as the operator's job, fully overridable via the env key.

### Task 12: Latency instrumentation

**Files:** Modified `mythos/ui/public/js/voice/voice-loop.js`, `mythos/ui/public/js/ws.js`, `mythos/server/index.js`; new `mythos/src/core/voice/latency-tracker.js`; Test `test/voice-latency.test.js` — ALL DONE.

- [x] **Step 1: Write the failing test** — after a synthetic turn, `/api/status` exposes `voiceLatency: {p50, p95, sampleCount}`. DONE — `test/voice-latency.test.js` (6 tests): 4 pure unit tests for `latency-tracker.js` (real percentiles, AD-5 garbage-input rejection, honest empty-state, capped ring buffer) + 2 server-integration tests (`/api/status`'s honest `{p50:null,p95:null,sampleCount:0}` baseline, then real values after `server._internal.voiceLatencyTracker.record(...)`).

- [x] **Step 2: Stamp `micStoppedAt`** at `voice-loop.js`'s `stopRecording()` — the true mic-stop moment — and thread it through to the outbound WS frame. DONE — `stopRecording()` stamps `lastMicStoppedAt`; `handleCommand()`'s `utterance()` call passes it as `micStoppedAt`; `ws.js`'s `utterance()` threads it into the `{type:'utterance', ...}` frame (undefined is dropped by `JSON.stringify`, so pre-existing callers see zero behavior change).

- [x] **Step 3: Compute the delta server-side** when the first audio frame for that `reqId` actually ships (both the S2S and fallback paths). DONE — batch path: `sendSpokenReply()` records `Date.now() - micStoppedAt` on the first chunk with real `audioB64`; S2S path: the connection closure tracks `liveTurnUserSpeechAt` (set on the turn's first `onTranscript` with `role:'user'`, since Live has no discrete "recording stopped" moment — the model's own VAD decides that internally) and records the delta on the turn's first `onAudioOut`, resetting both on `onTurnComplete`. Both paths feed the same shared `voiceLatencyTracker` (a capped ring buffer, `latency-tracker.js`), surfaced via `/api/status`'s new `voiceLatency` field — no new WS message type was needed since `/api/status` already existed and additive fields are free.

- [x] **Step 4: Measure the whole pipeline honestly** — an unmeasured turn contributes no sample rather than an estimate (AD-5). DONE — `latency-tracker.js`'s `record()` silently drops non-number/negative/non-finite input; a turn with no `micStoppedAt` (batch) or no confirmed user transcription (S2S) simply never calls `record()`. Verified by a dedicated test asserting `-5`, `NaN`, `'250'` (string), `undefined`, and `Infinity` all produce zero recorded samples.

- [ ] **Step 5: Live-verify against IRIS's advertised number.** Target <1s wake-word→first-audio. **NOT DONE — needs the operator.** This step requires a real microphone, real wake-word activation, and a human timing (or reading) the real p50 off a live `/api/status` after actual use — none of which this session can produce. What WAS verified live this session: `scripts/verify-live-session-e2e.js` (new, see Phase 5's Progress log row) proves `live-session.js` itself delivers real audio+transcript+turnComplete end-to-end against the real Gemini Live API (81,150 bytes of real 24kHz audio, transcript "Hello, how are you?", real `usageMetadata`→spend with 375 input/47 output tokens) — but that script has no microphone and no wake-word arm, so it cannot produce a real wake-word→first-audio latency number. Left explicitly open for the operator.

---

## Wave 4 — Planned only, not built

Thin Android PWA or native app talking to `/ws` over `MYTHOS_BIND=0.0.0.0` with `MYTHOS_AUTH_TOKEN`, plus V2 §13's Electron shell for the desktop installer story. Wave 1 Task 6 is the prerequisite for both. Do not start either until Waves 1–3 are live-verified.

---

## Verification

Per-wave gates, in order. Nothing advances on a green unit suite alone — this repo has shipped 6-of-11 broken behind vacuous tests, so **demand red→green evidence: the test must fail before the fix.**

1. **Wave 0:** `node --test` → 0 fail. `node scripts/sync-test-count.js --check` passes. `mythos/Plans/MYTHOS-IRIS-Synthesis-Plan.md` exists and reads correctly; root `.md.txt` gone.
2. **Wave 1:** Copy text elsewhere → ask MYTHOS what's on the clipboard → have it write and paste. Move a file by voice inside `VOICE_ALLOWED_DIRS`. Set a 1-minute timer and **hear it ring.** Boot with `MYTHOS_BIND=0.0.0.0` and no token → **refuses to start.** Log out and back in → MYTHOS is running.
3. **Wave 2:** `adb -s <serial> shell echo mythos-ping` returns `mythos-ping`. By voice: read notifications, search contacts, compose an SMS (and confirm MYTHOS says it needs a tap, not that it sent), open a WhatsApp chat, toggle WiFi. Unplug the phone mid-session → tools fail honestly, boot unaffected. Then unset `ANDROID_ADB_BIN` and remove `adb` from PATH → adapter reports OFFLINE, everything else still boots.
4. **Wave 3:** The gate that must not regress — say *"delete the goal about X"*. Confirm modal appears, MYTHOS **says aloud** it needs approval, **nothing executes**, exactly one audit line lands in `vault/Audit/<today>.jsonl` at tier 3. Accept → executes and reports the real outcome. Reject one → no dispatch. Then talk over MYTHOS mid-sentence: audio stops within ~200ms. Hold a 5-minute session and read the spend widget against real `usageMetadata`. Hold a 20-minute session to force `goAway` + resumption — no audible seam.
5. **Ship gate:** `/precheck` (Release Readiness Lead) → PASS or PASS WITH NOTES.

---

## Risk register

1. **ADB SMS/call reliability across OEMs (highest).** Intents open the right app pre-filled but stop short of send/dial on stock Android's security model, and MIUI/One UI/ColorOS restrict `svc` and `am` differently. **Mitigation:** report "opened, needs a tap" unless a tap is confirmed landed. Never claim a sent message — a fabricated success here is worse than no feature.
2. **WhatsApp UI-automation fragility.** Coordinate taps break on every UI version and resolution. **Mitigation:** `uiautomator dump` + `resource-id`, documented fallback to "please tap send."
3. **`focus_window` foreground-lock — already open in this repo.** Reproducibly denied by Windows' foreground-lock in headless/no-app-focused conditions even with `AttachThreadInput`; unconfirmed whether it reproduces in real voice-driven use. None of Wave 1's tools depend on focus, but test against this before assuming success anywhere that does.
4. **Wi-Fi ADB IP churn.** A renewed DHCP lease silently breaks every phone tool. **Mitigation:** persist to `vault/Identity/android-devices.json`, retry on boot, recommend a DHCP reservation, and have `phone_list_devices` surface last-seen staleness honestly. Boot can only retry, not rediscover.
5. **`ps-automation.ps1` concurrency (BUG-037).** Wave 1 Task 3 and Wave 2 Task 11 both edit it. **Mitigation:** `git pull` + diff before editing, re-verify the six load-bearing pieces survive, worktree-isolate or serialize the agents, commit live-verified work immediately, and `TaskStop` any background agent holding the file before editing inline.
6. **S2S cost.** Duplex audio bills for open-mic time; today's model bills per utterance. **Mitigation:** V2's three-layer gate (wake-word-only open, `LIVE_IDLE_TIMEOUT_MS`, `LIVE_SESSION_MAX_MS`) plus real `usageMetadata` in the spend widget. Measure at verification step 4 before expanding usage.
