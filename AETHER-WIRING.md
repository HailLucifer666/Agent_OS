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

> **⚠ STALE — re-verify before Phase 2 relies on this (checked 2026-08-04).**
> The "RSSI only, no `distance_m`" claim was true when written but the Aether-BLE
> repo has moved on. Its local `main` is at **Phase 10** (`a206f20` layout
> persistence + 5-surface spatial dashboard, on top of `488035c` "Phase 9 fusion
> engine + real chirp: matched-filter ToF, 2-D Kalman, room adjacency"), and
> `aether-bridge/aggregator.py` now imports `rssi_to_distance_m` from `layout`
> and threads `distance_m` / `tof_us` through its geometry and fusion paths. In
> other words **the "ranging tier" that §"Real data only" below says to wait for
> appears to be wired.** What is NOT yet established is whether `distance_m`
> reaches the *broadcast payload MYTHOS consumes*, or stays internal to fusion —
> that is the one thing to check before treating ranging as available here, and
> it was deliberately not concluded from a grep.
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
| 2 | Voice output routing — Agent_OS speaks through the nearest device | ⬚ Next | — |
| 3 | Voice input routing — nearest device's mic reaches Agent_OS | ⬚ | — |
| 4 | Conversation handoff — mid-sentence migration between devices | ⬚ | — |
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
default false). QA-reviewed. 2525/2525 tests pass.

**Verify live:**
```
# in mythos/.env:  AETHER_ENABLED=true
"<path-to-Aether-BLE-repo>\AetherMesh.bat"   # simulated walk, owner flips ~15s
```

---

## Phase 2 — Voice Output Routing (NEXT)

**Goal:** Agent_OS speaks through whichever device the user is nearest to.

**Key insight that simplifies this phase:** the aggregator ALREADY accepts inbound
`say`/`ask` messages on the same socket the sensor pulls from
(`aggregator.py:910-924`). So Phase 2 does NOT need a new push channel — the
sensor's existing WS connection is bidirectional. Agent_OS sends `say` down it;
the aggregator plays TTS on the owner device via its existing 4-phase FSM.

**Plan:**
1. Extend `aether.js` (or a sibling `aether-output.js`) to expose a `speak(text)`
   that sends `{type:'say', text}` over the open WS to the aggregator.
2. Hook the speech path: where the cortex/server currently calls
   `proactiveSpeak()` → local Edge-TTS → browser chunk, add a branch: when
   `AETHER_ENABLED && AETHER_AUDIO_ROUTE`, send `say` to the aggregator instead
   of (or alongside) the local speaker.
3. Add `AETHER_AUDIO_ROUTE` (bool, default false) to the config schema.
4. Test: ask Agent_OS a question → walk to PC → answer plays on PC; walk to
   phone → next answer plays on phone.

**Open question for Phase 2:** does the aggregator's `say` path produce audio
that reaches the *owner device's* speaker, or just the aggregator's own TTS?
Needs a live check against `aggregator.py`'s `_handle_say` + `piper_tts.py`. If
it only plays locally, Phase 2 also needs the aggregator to forward audio to the
owner scanner — a small Python-side addition (the one place this plan would touch
Aether code).

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

## Phase 3 — Voice Input Routing

**Goal:** the nearest device's mic captures voice and streams it to Agent_OS.

**Plan:**
1. The aggregator already has a `wake` inbound message and a wake-listener
   (`wake_listener.py`). On wake, Agent_OS opens a listening session.
2. Mic capture: either the aggregator forwards PCM chunks to Agent_OS (new
   inbound message type), or Agent_OS pulls from a per-device mic stream.
3. Feed chunks into the existing STT pipeline (`providers/groq-stt.js` or
   `local-whisper-stt.js`) → transcript → cortex OBSERVE phase.

**Deferred detail:** wake-word integration, chunk encoding (PCM16 base64), and
the `is_final` semantics all need design once Phase 2's audio path is proven.

---

## Phase 4 — Conversation Handoff

**Goal:** mid-conversation migration between devices — the "Google problem."

**What's already on the wire:** the aggregator's `conversation` broadcast carries
the full 4-phase FSM (`IDLE | PREPARE | TRANSFER | CONFIRM | RELEASE`) plus
`lastHandoff.{from,to}`. The sensor can listen to it now (free); Phase 4 acts on it.

**Plan:**
1. On `TRANSFER` phase: Agent_OS pauses voice output (don't cut mid-sentence),
   stores conversation state (last utterance, position in stream, pending response).
2. On `RELEASE` (new device confirmed): resume output on the new device, continuing
   from the stored position if mid-sentence.
3. New `cortex/aether-handler.js` (or extend the sensor) to handle the FSM events.

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
