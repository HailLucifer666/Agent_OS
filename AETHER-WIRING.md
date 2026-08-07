# Aether-BLE × Agent_OS — Wiring Plan

> Two existing repos wired into one system: **Agent_OS** (the brain — Node.js,
> Express + WS on `:4478`, OODA cortex, 5-layer memory) and **Aether-BLE** (the
> nervous system — Python, `bleak` BLE scanner + WS aggregator on `:8766`,
> proximity arbitration via hysteresis + leader election + a 4-phase handoff FSM).
>
> One sentence: **Aether decides WHERE the conversation happens. Agent_OS decides
> WHAT the conversation is.**

This doc is the single source of truth for the wiring. It supersedes the
original `WIRING_SPEC.md` (which existed only as pasted text and had four errors
verified against source — see §0). Phase status tracks what has actually shipped.

---

## 0. Spec corrections (verified against source, 2026-08-04)

The original spec was directionally right but wrong on specifics. Corrections:

1. **Bus API is `bus.emit('perception.*', payload)`, NOT `bus.publish()`.** Sensors
   call `emit`; `publish` takes a pre-built event object. See `src/core/bus/index.js`.
2. **There is no `voice/spoken.js`.** The TTS sanitizer is `voice/spoken-text.js`;
   the speech pipeline is `bus.emit('action.speak-requested')` → server's
   `proactiveSpeak()` → `providers/edge-tts.synthesize()`. Phase 2 concern.
3. **The aggregator port is `8766`, NOT `8765`.** `:8765` is one scanner *feeder*
   (`bridge.py`); `:8766` is the election hub (`aggregator.py`) that already has
   WS-client consumers (the Next.js dashboard). Agent_OS is just another client.
4. **No new WS server is needed.** The existing `perception.*` relay in
   `server/index.js` forwards any perception with `salience ≥ MYTHOS_IDLE_SALIENCE`
   to all HUD clients automatically. A correctly-shaped sensor is HUD-visible for free.

The spec's invented `aether.focus` message (`device_id`, `distance_m`, `user_id`)
**does not exist**. The real signal is the aggregator's `election` broadcast:

```json
{ "type":"election", "owner":"PC", "tick":4831, "ts":"14:32:41",
  "scanners":[{"id":"PC","rssi":-58.2,"smoothedRssi":-59.1,"lastSeenMs":340,"present":true}],
  "lastHandoff":{"from":"SIM-A","to":"PC","atTick":4821,"ts":"14:32:15"},
  "wakeOutcome":null }
```

`owner` IS the nearest device. There is **no `distance_m`** (RSSI only) and
`user_id` is effectively single-user ("AetherUser1"). Locked schema lives in
`aether-bridge/messages.py` in the Aether-BLE repo.

> **✅ RESOLVED 2026-08-05 (read from source, not concluded from a grep).** The
> question "does `distance_m` reach the broadcast payload MYTHOS consumes" has a
> precise answer: **NO — the locked `election` payload never carries it.**
> `messages.py:build_election_message` takes only `owner/tick/scanners/
> last_handoff/wake_outcome`, and `aggregator.py:_current_scanner_entries`
> emits `id/rssi/smoothedRssi/lastSeenMs/present` per scanner — RSSI only.
> `distance_m` stays internal to fusion/geometry.
>
> **BUT real distance IS on the same socket, as separate broadcasts:**
> `ranging` (per-scanner `distanceM`/`tofUs` from chirp measurements,
> suppressed entirely while tier 2 is idle) and `position` (fused 2-D
> `x/y/uncertaintyRadiusM` per user, omitted until a fusion track exists).
> Both ride the exact WS the sensor already consumes, additive schemas, no
> Python changes needed. **Phase 1.5 (shipped 2026-08-05, `08f9a28`) consumes
> them:** the sensor ingests `ranging`/`position` (never emitting on their
> own), and the next election perception carries the owner's real `distanceM`
> + fused `position` in `detail`, plus `distanceM` in the summary/HUD chip.
> Caches clear on socket drop (real data only — never show a distance you
> didn't just hear). The "carry rssi until a ranging tier is wired" gate is
> therefore satisfied: the tier is wired and the sensor now carries it.
>
> Also note `aether-bridge/bridge.py` has **uncommitted local changes** in that
> repo, so its on-disk behaviour may not match its own last commit. Reconcile
> that before building against it.
>
> Phase numbering is a genuine trap here: this document's "Phase 1-5" are
> MYTHOS-side *wiring* phases, entirely separate from the Aether-BLE repo's own
> Phase 8/9/10 development commits. They are not the same axis and neither
> implies the other's progress.

---

## Architecture

```
USER (phone/beacon in pocket)
│  BLE RSSI broadcast
▼
AETHER-BLE  (Python, aggregator on :8766)
  Scanner → Aggregator → Election (owner) → FSM
                                    │
                         election JSON every 400ms
                                    │  (WS, pull model)
                                    ▼
AGENT_OS  (Node.js, :4478)
  aether sensor → bus.emit('perception.aether')
       │                         │
       │    perception.* bridge   │   existing perception.* relay
       │      → cortex queue      │     → WS broadcast to HUD
       ▼                         ▼
  CORTEX (OODA)              JARVIS HUD ("NEAREST DEVICE" chip)
```

**Rule:** Agent_OS never knows which physical device it's talking to. It only
knows "the user is nearest to X" and (Phase 2+) "speak now, routed via Aether."
Aether handles all device routing.

---

## Phase Status

| Phase | Goal | Status | Commit |
|-------|------|--------|--------|
| **1** | Focus awareness — Agent_OS perceives the nearest device; HUD shows it live | ✅ **DONE** | `711722d` |
| **1.5** | Ranging enrichment — real ToF distance rides the perception once the ranging tier is wired | ✅ **DONE** | `08f9a28` |
| 2 | Voice output routing — Agent_OS speaks through the nearest device | 🔧 **CODED — needs live verify** | `08f9a28` |
| 3 | Voice input routing — nearest device's mic reaches Agent_OS | 📐 **DESIGNED — blocked on Aether-side audio transport** | — |
| 4 | Conversation handoff — mid-sentence migration between devices | 🔧 **CODED — sensor side complete (listen+awareness+speak-gating); end-to-end still needs Phase 2 live + Phase 3** | `5c206e4` |
| 5 | Multi-device mesh — multiple rooms, multiple users | ⬚ | — |

---

## Phase 1 — Focus Awareness ✅ DONE (`711722d`)

**Shipped:** `src/core/sensors/aether.js` connects OUT to the aggregator, parses
`election`, and emits `perception.aether` on the bus. The existing relay forwards
it to the HUD; a new `widgets/kinds/aether.js` chip paints "Nearest: PC · -59 dBm".

**Dedup gate (the core design):** the aggregator fires every 400ms but the cortex
perception queue drains 1×/sec (cap 50). The sensor emits ONLY on (a) owner
transition (null→X, X→Y, X→null), (b) first acquisition, or (c) owner-stable RSSI
drift ≥3 dBm throttled to 1 Hz. Without this, one sensor would flood the cortex
queue. Reconnect w/ exp backoff; fail-honest-inert; opt-in (`AETHER_ENABLED`,
default false). QA-reviewed.

**Phase 1.5 — Ranging enrichment ✅ DONE (`08f9a28`):** the sensor now also
consumes the same-socket `ranging` (real ToF `distanceM`) and `position` (fused
2-D) broadcasts — see the resolved ⚠ note in §0. Enrichment-only: never emits on
its own, only enriches the next election perception (owner's `distanceM` in
summary + `detail`, fused `position` in `detail`); caches clear on socket drop.
No fabricated data: `distanceM` is shown exactly as broadcast.

**Verify live:**
```
# in mythos/.env:  AETHER_ENABLED=true
"<path-to-Aether-BLE-repo>\AetherMesh.bat"   # simulated walk, owner flips ~15s
```

---

## Phase 2 — Voice Output Routing 🔧 CODED — needs live verify (`08f9a28`)

**Goal:** Agent_OS speaks through whichever device the user is nearest to.

> **Precedence, decided by the operator 2026-08-07: LIVE WINS ALWAYS.** Unified
> Gemini Live voice and Aether audio routing are **mutually exclusive by
> design** — never both in one turn, and the tie always goes to Live. Aether
> routing is best-effort: it may be attempted only on a path where no Live
> session is open. That is already how `server/index.js` is ordered
> (`proactiveSpeak()` takes its Live branch first and returns; `sendSpokenReply()`
> and the typed-utterance handler check `getLiveSession()` before
> `speakViaAether()`), and `test/aether-live-precedence.test.js` now pins both
> directions so an edit cannot quietly reverse it.
>
> **The honest consequence: with `VOICE_UNIFIED_LIVE_VOICE` on — which is the
> schema default — the Aether audio route will effectively never fire.** That
> flag makes `proactiveSpeak()` actively *open* a Live session before it reaches
> the Aether branch, so on the default config the branch is live code that is
> almost never taken rather than a path the operator can exercise. **Phase 2 can
> therefore only be walked with `VOICE_UNIFIED_LIVE_VOICE=false`** (plus
> `AETHER_ENABLED=true`, `AETHER_AUDIO_ROUTE=true`). Suppressing the Live open to
> let Aether through was considered and rejected: Live is the entity's voice.
>
> Phase 2 stays **CODED — needs live verify**. Nothing here is a live-walk
> result, and the Android node still cannot play audio at all (see the 2026-08-04
> note below, re-verified 2026-08-07: zero `AudioTrack`/`MediaPlayer`/`ExoPlayer`
> hits anywhere under `aether-android/`), so even with the flag off "the nearest
> device speaks" means the open dashboard tab speaks.

**Key insight that simplifies this phase:** the aggregator ALREADY accepts inbound
`say`/`ask` messages on the same socket the sensor pulls from
(`aggregator.py:910-924`). So Phase 2 does NOT need a new push channel — the
sensor's existing WS connection is bidirectional. Agent_OS sends `say` down it;
the aggregator plays TTS on the owner device via its existing 4-phase FSM.

**Shipped (Agent_OS side — all code is here; only the live walk test is pending):**
1. `sensors/aether.js` exposes `speak(text)` → sends `{type:'say', text}` over
   the open WS; returns `false` (no throw) when the socket is down so callers
   fail open to local TTS. Covered by a real-socket test.
2. `server/index.js` hooks BOTH speech paths through one `speakViaAether()`
   branch gated on `AETHER_ENABLED && AETHER_AUDIO_ROUTE`:
   - `proactiveSpeak()` (announcer / immune / boot greeting / reminders): the
     text goes to the aggregator; the client still gets `proactive-speech` +
     a caption-only `done` (`chunked:true`, zero chunks) so the HUD shows what
     was said without the local machine speaking it.
   - `sendSpokenReply()` (interactive utterance replies — the "ask a question"
     path): same treatment, caption-only `done`. Both branches guard against an
     open Gemini Live session on the connection (BUG-060 class: Live's PCM
     playback is already the entity's voice — never ALSO route to Aether).
   - Both fall back to the local Edge-TTS chain automatically when the
     aggregator socket is down (fail-open). Both branches are covered by tests:
     proactive via `action.speak-requested` over a real WS; interactive via a
     real `utterance` turn through a stub-brain voice agent (the
     `tts-down-sentence-chunks` harness).
3. `AETHER_AUDIO_ROUTE` (bool, default false) added to the config schema +
   `.env.example`; `main.js` passes the sensor's `speak` sink into the server.
4. **Still pending — the live walk test:** ask Agent_OS a question → walk to PC
   → answer plays on PC; walk to phone → next answer plays on phone. Needs the
   real Aether system (start AetherMesh + MYTHOS with `AETHER_ENABLED=true`,
   `AETHER_AUDIO_ROUTE=true`). Do NOT tick this phase DONE until that passes.

**Open question — RESOLVED by reading the source (2026-08-05):** `aggregator.py`
`_handle_say` does NOT play audio on the aggregator host: it generates the TTS
utterance (Piper, or a synthetic no-audio fallback), assigns it to the CURRENT
OWNER scanner, and broadcasts it in the `conversation` stream — i.e. `say` IS
the owner-routing mechanism, and "which device plays it" is decided by Aether's
client-side FSM, not by this repo. The remaining unknown is purely Aether-side:
whether each scanner's client actually plays the owner-assigned utterance
(likely, given the narration/conversation FSM, but that is Aether's code to
verify live). No Python-side change is expected from this phase.

> **ANSWERED 2026-08-04, and the answer changes Phase 2's shape.** The
> aggregator's `_handle_say` synthesises with Piper and embeds `audio_base64` in
> the conversation broadcast assigned to `owner` — so audio *is* published, not
> merely played locally. But **only `aether-dashboard` consumes it.** A search of
> the Aether-BLE repo for `AudioTrack`/`MediaPlayer` matches **no Kotlin or Java
> file at all** — `audio_base64` appears only in Python
> (`aggregator.py`, `conversation.py`, and their tests). So today "speak on the
> nearest device" actually means **"the open dashboard tab plays it"**, and
> `aether-android` cannot play audio at all.
>
> Therefore the prerequisite is **playback on the Android node**, not a transport
> change — which is why the operator's decision was to fix node playback FIRST
> and defer the transport choice. That deferred choice is between reusing `say`
> (Piper's voice, zero Python changes) and adding a `sayAudio` inbound type
> (MYTHOS's voice, touches `aggregator.py` + `messages.py`). Note `say` would
> make Piper a **fourth** TTS engine alongside edge-tts, Gemini Live and browser
> `speechSynthesis` — and this repo already has a documented rule that a voice or
> chunking change must be applied to all engines at once.
>
> **Constraint that holds either way: MYTHOS must send `say`/`sayAudio`, never
> `ask`.** `ask` routes to Aether's local Ollama and bypasses MYTHOS's brain
> entirely. Inbound accepts only `wake | say | ask | placeDevice |
> setCalibration | setTuning` — no message type carries audio *into* the
> aggregator.
>
> **Scope note:** building that playback means writing to the Aether-BLE repo,
> which is OUTSIDE this project directory. Per the project-isolation rule that is
> not something to do without the operator explicitly authorising work in that
> repo.

---

## Phase 3 — Voice Input Routing 📐 DESIGNED — blocked on Aether-side audio transport

**Goal:** the nearest device's mic captures voice and streams it to Agent_OS.

**Verified reality (read from source, 2026-08-05) — the wire does NOT exist yet:**

1. `aggregator.py` says it outright: *"Real audio capture is NOT implemented
   here"* — its inbound types are only `wake` / `say` / `ask` / `placeDevice` /
   `setCalibration` / `setTuning`. Nothing streams mic audio to it.
2. The ONLY mic-capture code in the Aether repo is `wake_listener.py` — a
   per-scanner local process: sounddevice captures 16kHz mono int16 frames →
   openWakeWord scores them → on threshold crossing it sends `{type:'wake'}`
   (debounced 1.5s). Its audio callback feeds ONLY the wake scorer; it does
   not capture or stream the utterance after wake.
3. `chirp_audio.py` is pure DSP for ToF ranging (18-21 kHz chirps) — not voice.
4. `wyoming_satellite.py` (Phase 8) is the Home Assistant satellite seam
   (wake + TTS for HA's Assist pipeline) — it does not stream device mic audio
   to Agent_OS either.
5. Wake acceptance ALREADY reaches Agent_OS for free: `election.wakeOutcome`
   (one-shot — `_pending_wake_outcome` is cleared after the next broadcast) is
   a camelCase `{requestedAtTick, ts, owner, results:[{id, outcome:
   'ACCEPTED'|'SUPPRESSED'}]}` riding inside the `election` broadcast the
   Phase 1 sensor already consumes. The ACCEPTED scanner is the one whose wake
   won (owner match).

**Therefore Phase 3 requires exactly ONE Aether-side addition (the plan's
single Python touch), in the OTHER repo:** extend `wake_listener.py` (or a
sibling `voice_stream.py`) so that after its own wake is ACCEPTED it records a
fixed window of the SAME 16kHz mono int16 frames it already captures (e.g. up
to 8s, silence-truncated) and streams them to the aggregator as a new inbound
message type:

```json
{ "type": "audio_chunk", "scannerId": "PC", "data": "<base64 PCM16 LE 16kHz mono>", "final": false }
{ "type": "audio_chunk", "scannerId": "PC", "data": "<...>", "final": true }
```

**Deferred details — RESOLVED by the source:**

- **Wake-word integration:** already solved on the Aether side —
  `wake_listener.py` IS the wake-word listener (openWakeWord, `hey_jarvis`).
  Agent_OS needs no wake-word of its own; it reacts to an ACCEPTED entry in
  `election.wakeOutcome.results` (the scanner whose `outcome` is 'ACCEPTED').
- **Chunk encoding:** 16kHz mono PCM16 LE base64 — exactly what
  `wake_listener.py` already produces; the 44-byte WAV header is trivially
  reconstructed Agent_OS-side.
- **`is_final`:** `final:true` on the last chunk ends the clip; Agent_OS
  accumulates until `final` (a dropped socket mid-clip discards the partial
  buffer — never transcribes a truncated clip).

**Relay vs pull (per the "pull model preferred" constraint):** the aggregator
should UNICAST audio chunks only to subscribing clients. Agent_OS sends
`{type:'subscribe', topic:'audio', scannerId:'PC'}`; the aggregator streams that
scanner's chunks to that one client. Never broadcast raw mic audio to every
dashboard client.

**Agent_OS side (Phase 3 code — only after the Aether side exists):**

1. `sensors/aether.js`: on `election.wakeOutcome` with an ACCEPTED result →
   open a listening session (reset accumulator, send `subscribe audio`). On
   `audio_chunk` messages on the existing socket: accumulate `data`; on
   `final` → wrap the PCM16 in a WAV header and call
   `providers/stt.js`'s chain (`sttChain.transcribe(wav, 'audio/wav', config)`
   — groq first, local-whisper fallback; both accept WAV).
2. Transcript → `bus.emit('perception.voice', {kind:'voice', channel:'voice',
   summary, salience:0.8, text})` — the existing human-initiated utterance
   event the cortex already consumes (mirrors the ws-sensor's utterance
   handling, `src/core/sensors/ws.js`).
3. Honest failure: blank or low-confidence transcript (the groq provider's
   existing `isLowConfidence` filter) → log and emit nothing; aggregator
   socket down → no session, no fabricated transcript.

**Why this phase is DESIGN, not code:** the wire does not exist, and per repo
rules Agent_OS code must not be written against a protocol the aggregator does
not implement (real data only). The Aether-side addition needs an operator
decision: extend `wake_listener.py` vs a new module, and confirm the
subscribe/unicast mechanism. The full mic→STT→cortex loop also wants Phase 2's
device-audio story live-proven first (the two designs are independent, but the
end-to-end test needs both).

---

## Phase 4 — Conversation Handoff 🔧 CODED (sensor side) — e2e needs Phase 2 live + Phase 3

**Goal:** mid-conversation migration between devices — the "Google problem."

**Verified wire facts (read from source, 2026-08-05) — the FSM is ALREADY live:**

1. The `conversation` broadcast rides the **exact socket** the Phase 1 sensor
   already consumes (`aggregator.py` broadcasts it immediately after each
   election tick — it is NOT a new channel).
2. Locked schema (`messages.py:build_conversation_message`):
   `{type:'conversation', transcript:[{id,scanner,role,text,ts}],
   utterance:{text,audioBase64,durationMs,offsetMs,isSynthetic}|null,
   speakingScanner, phase, phaseFrom, phaseTo,
   conversationEvent:{phase,fromScanner,toScanner,atTick}|null}`.
3. FSM (`conversation.py`, pure logic — deterministic, tick-driven):
   `IDLE -> PREPARE -> TRANSFER -> CONFIRM -> RELEASE -> IDLE`, ~200 ms per
   non-IDLE phase (`PHASE_DURATIONS_MS`) = an ~800 ms migration window.
   A handoff only begins when an utterance is active AND `speaking_scanner`
   is the scanner losing ownership; a handoff with no active utterance is a
   no-op. `conversationEvent` is one-shot (cleared after one broadcast,
   mirroring `wakeOutcome`).
4. **The load-bearing constraint for Agent_OS:** `start_utterance` — what a
   fresh inbound `say` calls — REPLACES the in-flight utterance and forces
   `phase` back to IDLE. The source says it outright: *"starting a new
   utterance cancels any in-flight handoff, which is the right call because
   a fresh say mid-handoff would otherwise race the FSM."* So a reply sent
   during the ~800 ms window KILLS the device-to-device sentence move.
5. Playback pause/seek/resume across the migration is **dashboard-side**
   (TRANSFER → pause + record offset, CONFIRM → seek, RELEASE → resume) —
   not Agent_OS's job to reimplement. Agent_OS owns only awareness + not
   racing the FSM.

**Therefore Phase 4 is Agent_OS-side ONLY (no Python changes):**

1. **Listen ✅ CODED (2026-08-05):** the sensor parses `conversation`
   broadcasts on the existing socket and caches the current `phase` +
   `speakingScanner` + the one-shot `conversationEvent` (cleared after being
   carried once, matching its one-shot semantics). Enrichment-only, same
   discipline as ranging — never emits on its own; cache clears on socket
   drop/stop.
2. **Awareness ✅ CODED:** the next election perception carries `phase` and,
   when a one-shot event arrived, `handoffPhase:{phase,from,to}` in `detail`
   — so the cortex can know "a handoff is mid-flight (moving to phone…)"
   instead of seeing stale silence. Covered by 4 tests incl. a real-WS
   round-trip with drop-clear (27/27 sensor tests).
3. **Speak-gating ✅ CODED (2026-08-08):** while `phase != IDLE`, `speak()`
   defers the outgoing `say` into a 1-entry queue (newest wins — the
   aggregator's own "new utterance replaces in-flight" semantics, so we
   never fight it) and drains it when an IDLE broadcast arrives; a 1.2 s
   safety timer (FSM window is ~800 ms) fails open and delivers the text
   anyway if IDLE never returns. This is what actually keeps the "sentence
   moves devices" experience intact: without it, a reply landing
   mid-migration cancels the handoff (the aggregator's `start_utterance`
   replaces the in-flight utterance and forces IDLE).
   Contract note: `speak()` returns `true` while queued, so the server's
   caption-only path (`speakViaAether`) treats it as sent — the desired
   device-routed, caption-only behavior during a handoff. The socket-down
   case still returns `false` and falls through to local TTS unchanged. A
   socket drop or `stop()` clears the queue and the timer — never a stale
   say after reconnect. Covered by 6 new tests (34 sensor tests). The only
   remaining Phase 4 work is the end-to-end migration test, still gated on
   Phase 2 live-proven (device audio actually playing) + Phase 3 (a user
   utterance arriving mid-migration).

**Gated on (per the phase gate — one phase at a time):** the end-to-end
migration test wants Phase 2 live-proven (device audio actually playing) and
Phase 3 built (a user utterance arriving mid-migration). The sensor-side
listen + awareness slice landed early (same pattern as Phase 1.5) as
`5c206e4`, and speak-gating landed 2026-08-08; only the end-to-end test
remains, sequenced after 2+3.

---

## Phase 5 — Multi-Device Mesh

**Goal:** multiple rooms, multiple users — each talks to their own Agent_OS
context with no crosstalk.

**Plan:** multiple aggregator scanners (one per room, already supported by the
mesh), per-user beacon → per-user Agent_OS context threading, separate memory
threads per user. Largest scope; deliberately last.

---

## Constraints (carry forward to every phase)

- **No rewrite of either repo.** Add new files, modify existing minimally.
- **No new npm/pip deps** unless absolutely necessary. (`ws` and `websockets`
  already present; Edge-TTS sidecar already runs.)
- **Pull model preferred.** Agent_OS is a client of the aggregator whenever
  possible — avoids auth-token plumbing and keeps Aether crashes from affecting
  Agent_OS (graceful degradation both directions).
- **Field is `salience`**, never `salienceHint` (recurring repo bug).
- **Real data only.** No fabricated `distance_m`; carry `rssi` until a ranging
  tier (the aggregator's tier-2 chirp ToF) is wired.
- **Phase gate:** each phase must pass the full `node --test` suite (0 failures)
  + `sync-test-count.js --check` before commit. One phase at a time — no skipping.

---

## Repo locations

- **Agent_OS:** this repo (`main`/`feat/aether-focus-sensor`)
- **Aether-BLE:** sibling repo, `HailLucifer666/Aether-BLE`, `main` (wherever you cloned it locally)
