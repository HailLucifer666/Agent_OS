# MYTHOS Live Verification Runbook

**Purpose:** operator-run verification procedures for the BUGs that ship as "🔧 CODED, live-verified pending" in BUGS.md. Each procedure has exact env vars, exact phrases, exact pass/fail signals.

**When to use:** after a fresh boot of MYTHOS on the operator's actual hardware. The unit-test suite covers logic; this runbook covers the real-hardware paths the tests can't reach (mic, camera, real browser audio, real LLM provider).

## Prerequisites

Before running ANY verification:

1. **MYTHOS boots cleanly.** `node src/main.js` reaches `MYTHOS ALIVE` within ~7s. If not, see BUGS.md D-07 (graceful shutdown) + the Start Agent OS.bat caveats.
2. **Test suite is green** — `node --test` from `mythos/`. Should be 1294+/1295 pass after the Phase 5 flake fixes.
3. **At least one brain provider key set** in `.env` (GROQ_API_KEY, MISTRAL_API_KEY, NIM_API_KEY, OPENROUTER_API_KEY, or CEREBRAS_API_KEY). Without this, utterance-based verifications all fail with "all my thinking providers are offline" — that's an env issue, not a bug.
4. **Dashboard open** at http://127.0.0.1:4478 — most verifications are observable from the captions panel + audit log.

## Group A — Scriptable (run a harness)

These have dedicated `scripts/verify-*.js` files. Run them from `mythos/`:

### A1. BUG-041 daily planner

**What:** morning brief fires on the first 60s tick, writes `vault/Plans/<date>.json` with `morningFiredAt`, and does NOT re-fire after a restart.

**Requirements:** just MYTHOS booting. No brain key needed — falls back to the canned morning message when the brain is offline.

**Run:**
```bash
cd mythos
node scripts/verify-planner.js
```

**Expected output:**
```
🧪  BUG-041 daily-planner verification starting
✅  MYTHOS booted on port 4478
⏳  waiting for planner first tick (75s — planner ticks every 60s)...
✅  vault/Plans/2026-07-21.json written, morningFiredAt=<epoch-ms>
🔄  restarting MYTHOS to verify idempotence...
✅  NO morning-brief re-fire on restart (idempotence holds)
🎉  BUG-041 daily-planner: PASS
```

**Verified live:** 2026-07-21 in the agent's shell. PASS.

**Failure modes:**
- `planner did NOT fire any events` — check `PLANNER_ENABLED=true` in `.env` (default is `true` so usually fine).
- File not written — check `MYTHOS_VAULT_ROOT` is writable. Look for `health.anomaly kind:'planner-day-file-write-failed'` in the boot logs.

**Existing unit coverage:** `test/planner-daily.test.js` (13 cases including this exact restart scenario at lines 94-117).

---

### A2. BUG-014 memory pollution guard

**What:** the `remember` tool rejects STT noise ("uh", "the", "that you like", "hmm") and accepts real facts.

**Requirements:** brain provider key (voice agent needs the brain to decide to call `remember`). Windows or POSIX.

**Run:**
```bash
cd mythos
node scripts/verify-memory-guard.js
```

**Expected output:**
```
🧪  BUG-014 memory-guard verification starting
✅  MYTHOS booted on port 4478
✅  noise "uh" rejected as expected
✅  noise "the" rejected as expected
✅  noise "that you like" rejected as expected
✅  noise "hmm" rejected as expected
✅  signal "i really enjoy playing jazz piano" accepted as expected
🎉  BUG-014 memory-guard: PASS
```

**Verified live:** NOT YET — needs brain provider key (the agent's shell has none configured).

**Failure modes:**
- `noise NOT rejected` — regression in `src/core/effectors/from-memory.js:15-35` (the noise regex or the 10-char floor).
- `signal NOT accepted` — same file. Check the unit test `test/from-memory.test.js:231-288` for the exact boundary cases.

**Existing unit coverage:** `test/from-memory.test.js` `describe('BUG-014: STT noise rejection')` — 23 cases including "spaced out" (10 chars, accepted) vs "call" (rejected) boundary.

---

### A3. BUG-006 YouTube embed mode

**What:** utterance "play X on YouTube" produces the correct `open-web` event with `widgetType` matching `YOUTUBE_MODE`.

**Requirements:** brain provider key. The harness verifies server-side only — actual iframe rendering in the browser is operator-eyes-only (see step 3 below).

**Run:**
```bash
cd mythos

# Default mode (embed)
node scripts/verify-youtube.js

# New-tab mode
YOUTUBE_MODE=newtab node scripts/verify-youtube.js
```

**Expected output:**
```
🧪  BUG-006 YouTube verification starting (YOUTUBE_MODE=embed)
✅  open-web event captured with YouTube URL + videoId
✅  default mode: URL uses youtube-nocookie embed
🎉  BUG-006 YouTube (server-side): PASS
ℹ️  NOTE: actual iframe rendering is operator-eyes-only — see docs/live-verification-runbook.md
```

**Operator eyes-only follow-up (after harness passes):**
1. Open the dashboard, click the compose bar, type "play guitar tutorial on YouTube"
2. Watch the WEB panel — should either:
   - **Default mode:** YouTube-nocookie iframe loads + plays, OR the fallback UI shows thumbnail + title + "Open in new tab" button (after the 8s onReady timeout)
   - **New-tab mode:** a real browser tab opens to `https://youtube.com/watch?v=<id>`

**Failure modes:**
- `no YouTube open-web event captured` — brain didn't decide to call `open_web`. Check the brain was online + the voice-agent prompt saw the YouTube intent.
- Server passes but iframe shows "Video unavailable" — this is the ORIGINAL BUG-006 symptom. Check `web-panel.js:42-47` (the fallback UI wiring) + whether `youtube-nocookie.com` is reachable from your network.

**Existing unit coverage:** `test/bug-006-youtube-mode.test.js` (4 cases: default/embed/newtab/missing-query).

---

### A4. BUG-040 ambient screen awareness sensor

**What:** screen-sensor emits `perception.screen` events with one-sentence descriptions, and the hash-skip optimization prevents re-emitting on unchanged screens.

**Requirements:** Windows host (pc-child needs `powershell.exe` + the `screen_look` handler), at least one foreground app visible, brain provider key for the vision lane.

**Run:**
```bash
cd mythos
SCREEN_AWARENESS_ENABLED=true node scripts/verify-screen-sensor.js

# Faster poll for quicker verification (default is 30s):
SCREEN_AWARENESS_ENABLED=true SCREEN_AWARENESS_POLL_MS=10000 node scripts/verify-screen-sensor.js
```

**Expected output:**
```
🧪  BUG-040 screen-sensor verification starting (pollMs=10000)
✅  MYTHOS booted on port 4478
⏳  capturing perception.screen events for 25s (2 poll cycles)...
✅  1 perception.screen event(s) fired
ℹ️  first description: Active window: Code — main.js
✅  hash-skip held on the unchanged screen (only 1 event over 2 cycles)
🎉  BUG-040 screen-sensor: PASS
```

**Verified live:** NOT YET — needs Windows + pc-child + brain vision provider (the agent's shell has no brain key).

**Failure modes:**
- `NO perception.screen events fired` — check boot logs for `pc-child` errors (often `powershell.exe` ENOENT if PATH is wrong) or vision-brain errors. The diagnostic in the script output lists the likely causes.
- Multiple events on unchanged screen — hash-skip regression in `src/core/sensors/screen-sensor.js:45-47`.

**Existing unit coverage:** `test/sensors-screen.test.js` (11 cases: hash-skip, generation-token stop, offline paths) + `test/ambient-awareness-tool.test.js` (8 cases for the on/off/status tool).

---

## Group B — Live dashboard session (no script)

> **Update 2026-07-27:** BUG-028 has since been fully automated — `node scripts/verify-news-route.js` drives the same utterance over the real compose-bar WS protocol and inspects the server's own action/navigate broadcast telemetry instead of a human watching the screen. It PASSED (twice, adversarially rechecked). The manual procedure below is kept for anyone who wants to eyeball it directly, but is no longer required to close this bug.

### B1. BUG-028 navigate "news" route fabrication

**What:** asking about news should NOT trigger a fabricated `navigate({route:'news'})` call — news is a dashboard widget, not a route.

**Requirements:** brain provider key (the LLM decides whether to call `navigate`).

**Procedure:**
1. Open dashboard, ensure no `news` route exists in `ALL_ROUTES` (`src/core/effectors/routes.js:11` — list is `goals, proposals, kanban, pipeline, memory, health, audit, backend, conversation, engagements`).
2. Click compose bar, type (or speak): "what's the news for today?"
3. Watch the audit panel + MYTHOS's reply.

**Pass signal:** MYTHOS does NOT call `navigate`. It either:
- Explains news is a floating widget already on the dashboard, OR
- Responds with a web_search / open_web result instead, OR
- Calls `navigate({route:'health'})` or similar EXISTING route

**Fail signal:** `navigate({route:'news'})` appears in the audit log, or MYTHOS says something like "I've opened the news panel" when no panel opened.

**Existing unit coverage:** None — this is a prompt-behavior change at `src/core/voice/voice-agent.js:43`. Cannot be unit-tested (no automated way to verify an LLM's future decision from a static prompt).

---

## Group C — Live voice session (mic + speakers required)

These need a real microphone and real speakers (NOT headphones for some — open-air speakers exercise the acoustic echo loop). No Node-side harness exists for these because `voice-loop.js` is a browser-only ES module (`MediaRecorder`, `AudioContext`, `AudioWorklet`, `getUserMedia` — none of which exist under Node).

> **Which transport are you actually testing?** (added 2026-08-14 — read this before
> trusting a Group C pass.) C2 and C3 below describe the **legacy** voice loop:
> `voice-loop.js`, its `assistantSpeaking` flag, and `BARGE_IN_RMS_MULT`. With
> `VOICE_UNIFIED_LIVE_VOICE` on, a real session runs over **Gemini Live (S2S)**
> instead, which does its own VAD and barge-in server-side — the episodic records
> from 2026-08-14 are all `"transport":"s2s"`. Tuning a `voice-loop.js` constant
> cannot fix an S2S session, and a C2/C3 pass on the legacy path does not clear
> the bug on the Live path. Check `transport` on the turn in
> `vault/Episodic/<date>.jsonl` before recording any result here.

### Suggested single sitting (~20 min, one pass)

Ordered so each step's setup serves the next; do them in one session rather than
six visits. Record each outcome against its BUG entry as you go.

1. **C1** wake word — say "hey jarvis" (proves the mic path is live at all).
2. **C5** self-capabilities — two questions, no hardware change.
3. **C6** desktop typing — one sentence, exercises the 2026-08-14 fixes.
4. **C2/C3** echo + barge-in — needs open-air speakers; note the transport warning above.
5. **C4** noise — passive, run it last and just leave the room listening.

### C1. BUG-039 wake-word ("hey jarvis")

**What:** on-device wake-word detection via ONNX. Speaking the phrase near the mic should activate voice without a manual click on the orb.

**Requirements:**
1. Run `node scripts/setup-wakeword.js` once (downloads 3 ONNX models into `ui/public/models/wakeword/`)
2. Set `WAKEWORD_ENABLED=true` in `.env`
3. Real mic + Chrome/Edge with `AudioWorklet` support
4. Click anywhere once on the dashboard (satisfies Chrome's autoplay/`pointerdown` arm gate at `app.js:250-255`)

**Procedure:**
1. Boot MYTHOS, open dashboard, click anywhere once to arm audio
2. Speak clearly: "hey jarvis"
3. Watch the orb — should flash wake + voice loop toggles on with NO manual click on the orb

**Pass signal:** orb flashes, recording starts, MYTHOS says its wake response ("yes?"). No false re-trigger during the subsequent TTS playback.

**Fail signal:**
- Orb doesn't react — ONNX models not loaded (check `GET /api/config/wakeword` returns `{enabled:true, modelsPresent:true}`)
- Re-triggers on its own TTS — wake-word threshold too low, tune `WAKEWORD_THRESHOLD` (default 0.7)

**Partial script coverage:** A `scripts/verify-wakeword-config.js` could be written to assert config + model-file sizes, but the actual activation cannot be scripted — it requires real mic audio through the browser's AudioWorklet.

**Existing unit coverage:** `test/wakeword.test.js` (3 cases — route contract + setup script's pure URL resolver). ONNX tensor shapes byte-verified against openWakeWord source.

---

### C2. BUG-027 TTS echo loop (self-transcription)

**What:** MYTHOS should NOT transcribe its own spoken TTS as user speech. The `assistantSpeaking` flag in `voice-loop.js` gates the VAD loop.

**Requirements:** real mic + real **open-air speakers** (NOT headphones — headphones mask the bug entirely). Real brain provider.

**Procedure:**
1. Boot MYTHOS, open dashboard, arm audio (click once)
2. Ask a question that produces a multi-sentence spoken reply: "tell me about the lewis & clark expedition" or "what's the weather in tokyo"
3. Watch the captions + audit panel for the ~3 seconds AFTER MYTHOS finishes speaking

**Pass signal:** no new user turn is transcribed until you actually speak again. No phantom tool call (`web_search`, `open_web`, `remember`, `log_incident`) fires off MYTHOS's own voice.

**Fail signal:** captions show fragments of MYTHOS's TTS being transcribed, or the audit panel shows a tool call you didn't ask for.

**Tuning:** if echo loops happen intermittently, the BUG-027 gate (`voice-loop.js:113`) may need the `assistantSpeaking` flag widened. Document the transcript in BUGS.md.

**On the Live (S2S) path — BUG-224, added 2026-08-14, CODED not verified.** The
above is the legacy loop. On S2S the echo source is the Live model's OWN spoken
reply, and the new gate in `s2s-bridge.js` stops those mic frames reaching
Gemini's VAD while MYTHOS is audible. This is the fix for *both* "it interrupts
me" and "the last word is half-spoken" — one mechanism caused both (Gemini heard
itself finish a sentence, called it a barge-in, and stopped synthesizing).

Check all four of these in one pass:
1. **Clipping gone** — ask for a multi-sentence answer on open-air speakers. Every
   sentence should finish its final word. Half-spoken endings mean the gate is not
   holding; check the server log for `voice-capture-suspend` frames with
   `reason:"own-voice-hold"`.
2. **No self-interruption** — MYTHOS must not cut itself off mid-reply, and must
   not start a new turn off its own voice.
3. **Barge-in still works** — talk over it firmly mid-reply. It must stop.
   *This is the regression risk*: while the gate is held, the LOCAL backstop is the
   only detector, and its threshold (`0.035 * 2.5` RMS sustained ~600ms) is higher
   than Gemini's server VAD. If a normal-volume interruption no longer lands,
   lower `BACKSTOP_RMS_THRESHOLD` — do not disable the gate.
4. **Nothing is swallowed** — when you do interrupt, the first word must survive.
   Say "stop, actually what's the weather" and confirm it did not hear only
   "actually what's the weather" (that is the 1.2s preroll replay working).

**Kill switch** (no rebuild): `localStorage.MYTHOS_LIVE_HALF_DUPLEX = 'off'` in the
browser console, then reload. Use it to A/B the same question if you are unsure
whether the gate helped.

**Existing unit coverage:** None. The bug entry itself (`BUGS.md:661`) documents why: building a harness would require mocking `MediaRecorder` / `AudioContext` / `getUserMedia` / `AudioWorklet`, which is out of scope.

---

### C3. Barge-in (VAD second threshold)

**What:** while MYTHOS is speaking, the operator can firmly interrupt and the TTS cuts immediately + the interrupt is captured.

**Requirements:** real mic + real speakers (open-air preferred). Real brain provider.

**Procedure:**
1. Boot MYTHOS, open dashboard, arm audio
2. Ask a long question that produces a multi-sentence reply
3. While MYTHOS is mid-speech, speak firmly over it: "stop, actually I wanted to ask about the weather instead"

**Pass signal:**
- TTS playback cuts immediately (mid-word)
- Recording starts capturing your interrupt
- The new utterance goes to the brain and gets a fresh reply

**Fail signal:**
- TTS continues playing despite your interrupt — barge-in threshold too high (tune `BARGE_IN_RMS_MULT` default 2.5 in `voice-loop.js:32-39`)
- A single cough or door-slam triggers barge-in — threshold too low (the sustained-hold requirement is `BARGE_IN_HOLD_TICKS_MULT` default 2, so ~6 ticks @ 100ms = 600ms above 0.0875 RMS required)

**Existing unit coverage:**
- `test/voice-barge-in-decision.test.js` (4 cases — pure `decideBargeIn` decision logic)
- `test/barge-in-tts-cancel.test.js` (2 cases — WS `{type:'stop', reqId}` round-trip aborts TTS synthesis server-side)

The audio path itself is browser-only and not covered.

---

### C4. BUG-020 background-noise voice hallucinations

**What:** in a noisy room, MYTHOS should NOT hallucinate voice input from ambient noise.

**Requirements:** real mic in the operator's actual environment (AC, fans, traffic — whatever they care about).

**Procedure:**
1. Boot MYTHOS in your normal working environment
2. Do NOT speak — leave it listening
3. Watch the captions for 10-15 minutes of normal ambient noise
4. If false positives appear, tune the VAD constants:
   - `VAD_SPEECH_RMS` (default 0.035) — raise to require louder audio
   - `VAD_MIN_PEAK_RMS` (default 0.06) — raise to require clearer peaks
   - `VAD_HOLD_TICKS` (default 3) — raise to require longer sustained audio
   - `VAD_SILENCE_MS` (default 1800) — adjust end-of-speech detection
5. Tune via any of:
   - `localStorage.MYTHOS_VAD_RMS = 0.05` in the browser console (per-session)
   - Env vars in `.env`: `VAD_SPEECH_RMS`, `VAD_MIN_PEAK_RMS`, `VAD_HOLD_TICKS`, `VAD_SILENCE_MS`
   - `GET /api/config/vad` route to read current values

**Pass signal:** zero false-positive transcriptions over 10-15 min of ambient noise. STT produces only "no_speech_prob" rejections.

**Fail signal:** captions show hallucinated phrases ("Thank you.", "Yes.", "Hmm.") without you speaking.

**Existing unit coverage:** `test/config.test.js` confirms defaults. The VAD loop itself (`voice-loop.js:678-735`) is browser-only and untested.

---

### C5. BUG-222 self-capabilities reachable from voice

**What:** "what can you do?" and "what did you fix?" must be answered from the
boot-written capabilities manifest (`vault/Identity/capabilities.md`, regenerated
every boot from the live hub catalog, adapter states and recent git changes), not
improvised. `self_capabilities` was withheld from the Live allowlist until
2026-08-14, and with nothing able to answer, the model substituted the nearest
reachable tool — which is where the repeated web-search suggestions came from.

**Requirements:** real voice session. No special hardware beyond a mic.

**Procedure:**
1. Boot MYTHOS, start a voice session.
2. Ask: "what can you do?"
3. Ask: "what did you fix recently?" / "what changed?"

**Pass signal:** the audit panel (or `vault/Audit/<date>.jsonl`) shows a
`self_capabilities` tool call for at least one of the two questions, and the
spoken answer names real tool families / real recent changes.

**Fail signal:** no `self_capabilities` call in the audit; the answer is generic,
or it offers to web-search for the answer. That means the model can reach the
tool but does not prefer it — a prompt problem, not an allowlist one. Record the
transcript before changing anything.

**Existing coverage:** `test/allowlist-reachability.test.js`,
`test/live-tools.test.js` (reachability only — they cannot prove the model
chooses it).

---

### C6. BUG-221 / BUG-223 desktop typing + honest close

**What:** the 2026-08-14 pair. `ui_type` no longer aborts when a target element
refuses focus (BUG-221), and `close_window` no longer reports `ok:true` for a
window that is still open (BUG-223).

**Requirements:** real voice session, Windows desktop.

**Procedure:**
1. "Open Notepad."
2. "Type: the quick brown fox jumps over the lazy dog."
3. Look at the screen. Then: "close it."

**Pass signal:**
- The text is actually in Notepad — not merely claimed.
- The audit row for `ui_type` shows `readBack: "confirmed"`. If it also carries a
  `preFocus` note, that is the BUG-221 path working as designed: focus was
  refused and the escalation ladder typed anyway.
- Closing an unsaved Notepad triggers Windows' save prompt, so the window
  survives — MYTHOS must say so honestly. An `ok:true`/"closed it" here is a
  BUG-223 regression.

**Fail signal:** any "I typed it" / "I closed it" that the screen contradicts.
That is the fabrication class both fixes exist to end — capture the audit row.

**Existing coverage:** `test/ui-type-focus-is-advisory.test.js`,
`test/pc-child-string-is-failure.test.js`,
`scripts/verify-notepad-typing.js` (all green as of 2026-08-14; none of them
proves the *voice* path chooses the tools correctly).

---

## BUG-by-BUG summary table

| BUG | Group | Required hardware | Existing tests | Verify approach |
|---|---|---|---|---|
| BUG-041 daily planner | A (script) | Just boot | 13 unit | `node scripts/verify-planner.js` |
| BUG-014 memory guard | A (script) | Brain key | 23 unit | `node scripts/verify-memory-guard.js` |
| BUG-006 YouTube | A (script) + eyes | Brain key + browser | 4 unit | `node scripts/verify-youtube.js` + manual iframe check |
| BUG-040 screen-sensor | A (script) | Windows + brain vision key | 11 unit | `SCREEN_AWARENESS_ENABLED=true node scripts/verify-screen-sensor.js` |
| BUG-028 news route | B (session) | Brain key | None (prompt-only) | Manual conversation |
| BUG-039 wake-word | C (voice) | Mic + Chrome + ONNX models | 3 unit (config only) | Manual voice session |
| BUG-027 TTS echo loop | C (voice) | Mic + open-air speakers | None (browser-only) | Manual voice session |
| Barge-in | C (voice) | Mic + speakers | 6 unit (decision + WS abort) | Manual voice session |
| BUG-020 noise tuning | C (voice) | Mic in real environment | Config only | Manual session + VAD constant tuning |
| BUG-222 self-capabilities | C (voice) | Mic | 2 reachability suites | Ask "what can you do / what did you fix", check audit for the call |
| BUG-221 typing / BUG-223 close | C (voice) | Mic + Windows desktop | 3 suites + verify script | "Open Notepad, type X, close it" — screen is the oracle |

## After verification

For each BUG you verify live, update its `BUGS.md` entry:

```
**Status:** ✅ LIVE-VERIFIED (YYYY-MM-DD) — <one-line result>
```

If verification fails, file the failure as a new BUG entry with the transcript/log and re-open the original.
