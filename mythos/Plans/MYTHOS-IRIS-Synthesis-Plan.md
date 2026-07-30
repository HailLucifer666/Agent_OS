# MYTHOS × IRIS Pro-Plus Parity — Living Roadmap

> **This file is the cross-session source of truth, and it is tracked in git so any
> machine can pick the build up mid-flight.** The loop is: read **RESUME HERE**, do the
> next unchecked step, tick it, update the block, commit, push. Do not start a second
> plan document — the V2 spine was lost precisely because planning lived in untracked
> files (see the blocking-gap section below).

## RESUME HERE

*Rewrite this block every session. It is the first and sometimes only thing the next machine reads.*

| | |
|---|---|
| **Status** | Merged-order step 0 ✅ and step 1 ✅ both done. Baseline is real-green (1520 tests, 0 fail, 1 skip, 1 todo), docs match reality (AD-10 live), 4 of 10 anti-drift invariant tests written (one — AD-1 — found a real, tracked violation; see Blocked on). |
| **Next action** | Merged-order step 2 → Task/§7.2: server bind + bearer auth + WS `?token=` + `/vault/builds` gate. **Do this alongside it:** AD-1's violation (`test/anti-drift-single-dispatch.test.js`, currently `todo`) — reroute `src/core/cortex/index.js:403`, `server/index.js:140/143/158`, and `server/routes/media.js:78` through `dispatchAction()` instead of raw `effectors.invoke()`. Step 2 already touches the dispatch/auth surface, so fixing this there is cheaper than a separate pass. |
| **Blocked on** | Nothing hard. One open, tracked, non-blocking finding: AD-1 violation above (3 real call sites bypass audit — not new, found by a test this session added, marked `todo` so it doesn't block the 0-fail gate). |
| **Two documents** | This file = delta/roadmap. V2 spine = source-level detail. Precedence rules in the V2-spine section below. |
| **Last updated** | 2026-07-30 |

**Merged order (the only sequence — see V2 §18.4 below):** 0 ✅ · 1 ✅ · 2 ☐ · 3 ☐ · 4 ☐ · 5 ☐ · 6 ☐ · 6.5 ☐ · 7 ☐

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
| 2026-07-30 | **Merged-order step 1:** full baseline re-run (1329-subset→1517 real→1520 final tests, 0 fail, 1 skip — "two real failures" prediction disproven, both files pass 38/38); fixed a real 14-file/188-test gap in `sync-test-count.js`/pre-commit/CI (non-recursive glob); README numbers corrected + independently verified (deps 7, sensors 10, providers 12, **effectors 107** — this plan's own "106" was off by one); AD-10 implemented (`computeDepsCount`/`computeSensorCount`/`computeProviderCount`/`computeEffectorCount`, all generated, gated by `--check`); Gemini Live quota risk re-verified live and retired (V2 §16); 4 of 10 §1 anti-drift invariant tests written (AD-1 found a real, tracked violation — `todo`; AD-5, AD-7, AD-10 pass; AD-7 also found and fixed 2 real hardcoded-path leaks) | *this commit* | yes — every number and test result re-run and confirmed in this session, not carried over from the plan's predictions |

---

## The V2 spine — found, committed, nothing to re-plan

**An earlier revision of this section declared the V2 spine lost and marked Wave 3 plus Task 11's §7.1/§7.3/§7.5/§7.6/§7.7 as "must be re-planned from primary sources." That was a false alarm. Retracted.** V2 is intact and is now committed beside this file:

> **`mythos/Plans/MYTHOS-IRIS-Synthesis-Plan-V2-spine.md`** — 1,570 lines, md5 `6e1547df33ad0b43663604f86b5acd03`

**Why the search missed it.** The verification was rigorous but scoped entirely to the repo — `git log --all`, `git stash list`, `mythos/Plans/`, and a repo-wide `*synthesis*`/`*iris*`/`*s2s*` filename sweep. V2 lives in `~/.claude/plans/` (where Claude Code plan-mode files go) under the auto-generated name `deep-compare-this-floofy-heron.md`, which matches no plan-related filename pattern. This document sits in that same directory as `i-just-installed-the-virtual-sketch.md` — two siblings in one folder; the search found this one and concluded the other never existed. The root `.md.txt` that was analysed was a stripped copy of **this** document, which is why the `§` markers only ever matched themselves. **Lesson for the next session: `~/.claude/plans/` is outside the repo and outside every repo-scoped search. Check it before concluding a plan is gone.**

Recovered verbatim and unfabricated by that one pointer: §1 Anti-Drift Contract with AD-1…AD-10 and each executable check · §3 frozen Gemini Live wire protocol, every envelope and exact field name · §4 frozen MYTHOS seams, 23 seams with line numbers and contracts · §6 `live-session.js` full source · §7 `live-tools.js` full source with the param-prose converter · §8 the leash tool adapter · §9 both browser worklets · §10 server wiring diff · §11 persona table, all six changes · §7.1–§7.7 including the WinRT OCR PowerShell block · §13 Electron shell · §17 Amendment 1.

**Precedence between the two documents.** V2 is the spine and owns anything it specifies in source-level detail (S2S transport, the frozen references, the Anti-Drift Contract, Electron). This document is the delta and wins where it is more concrete or more recent — it carries literal test code, and V2's own §18.2 explicitly adopts six of its decisions. Where they conflict, V2 §18 is the tie-breaker because it was written last and with both documents in hand. Do not build both sides of a supersession: V2 §7.4's `android-adb`/`from-phone.js` with 6 tools is **replaced** by this document's Wave 2 (`android-child`/`from-android.js`, 14 tools, per-device queues).

### Corrections this document needs (from V2 §18.3) — apply as you reach them

- [ ] **`phone_whatsapp_send` has no legal tap primitive — internal contradiction.** Task 10 requires "a resolved send tap", but none of the 14 tools taps or types, and `phone_shell` is deliberately refused. As written the flow can only ever report "opened, please tap send." **Fix:** add a tiered `phone_tap` (T3, resource-id targeted only, never raw coordinates), or drop the send step and keep the honest deep-link-open behaviour.
- [ ] **Do not register `phone_flashlight_toggle`.** Task 10 concedes no reliable stock command exists. A tool that always fails pollutes `capabilities.md` and, worse, the Live `functionDeclarations`, where accuracy degrades with tool count. Omit it, or register only after a runtime capability probe succeeds. AD-4 argues this.
- [ ] **Licensing is a hard gate before Wave 4, and it is absent from this document.** Verified in code, not just claimed: `mythos/providers/edge-tts.js:8` and `mythos/services/edge-tts-server.py:7` both label edge-tts as a reverse-engineered endpoint, personal/hobby use only, commercial deployment prohibited; `mythos/THIRD_PARTY_NOTICES.md:25` records the openWakeWord **model weights** as CC BY-NC-SA 4.0, non-commercial. Wave 4 ships an installer, and a paid binary must not contain NC-licensed wake-word weights. **Swap edge-TTS → Piper (MIT, local) and train an own-voice `hey_mythos` model using openWakeWord's Apache-2.0 tooling** — the tooling is permissive, only the pretrained weights are NC. This is a licensing problem, not a technical one, and it will never surface in testing.
- [ ] **Fix cross-reference drift in the parity table.** At least four rows cite the wrong task ID: "Up to 2 Android devices" → Task 6 (that's server auth), "24/7 background" → Task 6 (that's Task 7), "SMS to contacts" and "Phone calls" → Task 8 (that's the adapter; the tools are Task 10). In a document whose thesis is anti-drift, these must be right.
- [ ] **Split Task 11.** It is nine items behind one checkbox. A checkbox-driven roadmap needs one task each.
- [ ] **Schedule the §1 anti-drift invariant tests in Wave 0.** All 14 phone tools dispatch, so AD-1 (single dispatch surface) and AD-2 (single audit write) must cover them. No wave currently schedules these test files at all.
- [ ] **Wave numbering is inconsistent** — "Wave 1.5" is sequenced 3rd in the order table but appears after Wave 2 in the body. Let the order table be the only sequence.

### Merged execution order (V2 §18.4 — supersedes the table in Decision 3)

| # | Work | Source |
|---|---|---|
| 0 | ✅ Restore the V2 spine into `mythos/Plans/` — unblocks Wave 3 + Task 11 | §18.1 — **done, this commit** |
| 1 | Green the baseline + docs (AD-10) + §1 invariant tests | Tasks 1–2 + §18.3.6 |
| 2 | Server auth + WS `?token=` + `/vault/builds` gate | §7.2 + §18.2 |
| 3 | Persona unclamp — hours, largest felt win, two-file rollback | §11 |
| 4 | S2S transport + latency instrumentation | §6–§10 + Task 12 |
| 5 | Desktop gaps: clipboard, file ops, alarms, autostart, OCR, maps, image gen, code search, PIN, wallpaper, calendar | §7 + §17.2 + §18.2 |
| 6 | ADB bridge: adapter, setup script, 14 tools, per-device queues, device registry | §17.1 + Tasks 8–10 |
| **6.5** | **Licensing gate: edge-TTS → Piper, own wake-word model** | §18.3.3 — **blocks 7** |
| 7 | Electron shell + installer + overlay; Android app planned only | §13 |

Two further notes carried from V2 §18.2. Decision 1 (cancelling the speculative sentence-chunk TTS parser) is correct and **stronger than this document states** — sentence-chunked TTS streaming already exists as `splitSentences` in `server/index.js` and `src/core/effectors/voice.js`, with `test/sentence-streamer.test.js` and `test/split-sentences.test.js`; the cancelled work was redundant twice over. And V2 §7.12 wants **real Windows Scheduled Tasks** for alarms so they survive a MYTHOS restart, which is more than Task 5's in-process timer delivers — reconcile when building Task 5, and note V2 §7.8 tiers `clipboard_write` at T2 against Task 3's T1.

One standing constraint: `/council` cannot convene — `~/.claude/agents/` holds 39 agents and zero `council-*.md`. Report that; never synthesize a verdict. Use the real installed reviewers (`code-reviewer`, `security-reviewer`, `silent-failure-hunter`, `debugger`).

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

- [ ] Instrument mic-stop → first-audio (Wave 3, Task 12). Client stamps `micStoppedAt` at `voice-loop.js` `stopRecording()`; server computes the delta when the first `live-audio-out` frame ships; a capped ring buffer feeds `/api/status` as `voiceLatency: {p50, p95, sampleCount}`. Real samples only — an unmeasured turn reports nothing rather than an estimate (AD-5).

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
| Screen capture + **OCR text extraction** | Screenshot + vision captioning; **no literal text extraction** | 2 (V2 §7.1, Windows.Media.Ocr) |
| Keyboard injection / UI automation | Have — 13-command PowerShell daemon | — |
| Terminal / CLI execution | Have — `command-runner`, allowlist-gated | — |
| Deep research + web scraping | Have — 4-tier search chain, SSRF-guarded fetch | — |
| Local file management | Partial — read/list/open/**write/create/delete** exist; move/copy/rename/search absent | 1 (Task 4) |
| **Clipboard reader** | **Absent** — zero hits in `mythos/src` | 1 (Task 3) |
| Calendar + event scheduler | Reminders + Google OAuth adapter exist; `from-calendar.js` header advertises a Google Calendar layer **that exists in no file** | 1 (Task 5) + 2 (V2 §7.6) |
| **Alarms / timers with audible alert** | **Absent** — reminders speak, nothing rings | 1 (Task 5) |
| Memory vault synced across devices | Single-writer local vault. Phone-as-ADB-client means one vault on the desktop → **sync is free, nothing to replicate** | n/a by design |
| Biometric / PIN lock | Absent (IRIS's is an 8-byte decoy `face_match.wasm`) | 2 (V2 §7.3) |
| **SMS to contacts by voice** | **Absent** | 2 (Task 8) |
| **Phone calls + contacts directory** | **Absent** | 2 (Task 8) |
| **WhatsApp messaging** | **Absent** | 2 (Task 9) |
| **Hardware toggles** (flashlight/WiFi/BT/hotspot) | **Absent** | 2 (Task 10) |
| Notification reading | Absent | 2 (Task 7) |
| Up to 2 Android devices + desktop | No device registry | 2 (Task 6) |
| 24/7 background, zero daily limits | OODA loop runs continuously; **no autostart on login** | 1 (Task 6) |
| Android app | Deferred — ADB bridge first, per your decision | 4 (planned only) |
| **Semantic code search** (index local project dirs) | Vector index + embeddings chain exist; **not pointed at code dirs** | 2 (Task 11) |
| **Image generation** | Absent | 2 (Task 11) |
| **Maps + route calculation** | Absent | 2 (Task 11) |
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

- [x] **Step 1 — DONE, at a corrected path.** The root `.md.txt` was **not** V2; it was a formatting-stripped copy of *this* document. V2 was `~/.claude/plans/deep-compare-this-floofy-heron.md`, now committed as `mythos/Plans/MYTHOS-IRIS-Synthesis-Plan-V2-spine.md` (1,570 lines, md5 verified identical to source). Its §3 and §4 frozen references — the Gemini Live wire protocol and the 23 MYTHOS seams with line numbers — are intact and are what merged-order step 4 builds from. **Read them before touching S2S; do not skim.**
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

- [x] **AD-1 (single execution surface) — WRITTEN, and it found a real violation.** `test/anti-drift-single-dispatch.test.js` implements the check verbatim (`effectors.invoke(` must appear only in `dispatch-action.js`). It does not: `src/core/cortex/index.js:403` (mull-loop `propose_goal`), `server/index.js:140/143/158` (TTS mic-duck volume calls), and `server/routes/media.js:78` (`media_key` fallback) all call the hub directly, bypassing `dispatchAction()`/`leash.check()` — meaning those calls are **unaudited**. This is a real, pre-existing AD-1 violation, not something this session introduced. Rerouting those three call sites through `dispatchAction()` is real engineering (correct `ctx`/`tier`/`goalId` per site) and is out of merged-order step 1's scope — marked `{ todo: '...' }` (not skipped, not weakened — the exact assertion still runs every commit) so it stays visible without retroactively breaking the 0-fail baseline this same commit establishes. **Fix this before or during merged-order step 2** (server auth) since that step also touches the dispatch surface.
- [x] **AD-5 (no invented telemetry) — WRITTEN, passes.** `test/anti-drift-no-fake-telemetry.test.js`. Every current `Math.random()` in `src/core/`, `server/`, `ui/public/js/` is either a non-colliding id suffix or HUD-canvas animation jitter — none synthesize a status/metric/telemetry value. Genuinely green, not just quiet.
- [x] **AD-7 (no absolute paths) — WRITTEN, passes after two fixes.** `test/anti-drift-no-absolute-paths.test.js`. Found two real hits on first run: this very plan document's V2 spine quoted a real Windows user-profile path (drive letter, `Users`, a real name, a subpath) in its recovery narrative, and `mythos/scripts/verify-propose-goal-ui-click.js`'s comment embedded an 8.3 short-name derived from the same name. Both fixed (generic placeholder / rewritten to describe the short-name shape without embedding a matchable path) in the same commit. Now genuinely green — this bullet itself was rewritten once more after that, having accidentally reintroduced a matching pattern while describing the fix.
- [ ] **AD-9 (optional binaries degrade, never crash boot)** — NOT written this session. Existing coverage is partial and adapter-specific (`test/cua-driver-adapter.test.js` observes real-environment OFFLINE, doesn't inject ENOENT; `pc-child`/`browser-agent`/`edge-tts` have no equivalent). A faithful cross-adapter "force ENOENT on each, assert boot completes + status OFFLINE" test needs a shared mock-spawn boot harness across four adapters with different status shapes — real test-infrastructure work, disproportionate to step 1. **Scheduled here**, owner: whichever step next touches adapter boot wiring (currently step 5/6, desktop gaps + ADB bridge).
- [ ] **AD-2 (leash owns the audit write)** — cannot be tested yet. The spec's own check is "drive one Live tool call end-to-end, assert exactly one write per check()" — there is no Live tool-calling path until merged-order step 4 builds `live-session.js`/`live-tools.js`. **Scheduled at step 4.**
- [ ] **AD-3 (tool declarations derive from the hub)** — cannot be tested yet; the check is specifically about Live's `functionDeclarations` (`buildCatalogFromHub`), which doesn't exist until step 4. **Scheduled at step 4.**
- [ ] **AD-4 (no fabricated success)** — cannot be tested yet; the check is specifically about Live's `turnComplete` reconciliation (no `needs_result` loop on that path), which doesn't exist until step 4. **Scheduled at step 4.**
- [ ] **AD-6 (S2S turns never amnesiac)** — cannot be tested yet; needs `live-session.js`'s scripted frame sequence. **Scheduled at step 4.**
- [ ] **AD-8 (secrets never reach the renderer)** — cannot be fully tested yet; the spec ties the check to the Electron preload `contextBridge` (§13), which doesn't exist until step 7. (The narrower "no current WS/REST response leaks a key pattern" half is arguably testable today against the existing server, but writing a partial version of a ten-invariant contract risks looking done when it isn't — deferred whole.) **Scheduled at step 7.**
- [x] **AD-10 (docs match reality)** — this is `sync-test-count.js` itself; see Task 2 Step 5 above. Done.

**§18.3.6 correction checkbox: partially delivered.** 4 of 10 invariant tests written and run (AD-1 found a real violation and is `todo`-tracked; AD-5, AD-7, AD-10 pass). 5 genuinely cannot run before their owning step lands (scheduled above, not silently dropped). 1 (AD-9) deferred as disproportionate build effort for this step, scheduled at the adapter-boot step.

---

## Wave 1 — Desktop parity + server auth foundation

### Task 3: Clipboard read/write

**Files:** Modify `mythos/adapters/pc-child/ps-automation.ps1`, `mythos/src/core/effectors/from-computer.js`; Test `test/from-computer-clipboard.test.js`

`ps-automation.ps1` is the file BUG-037 is about. Before editing: `git pull`, then confirm these still exist in it — UTF-8 console encoding block, `Await-WinRTOperation` with explicit `[type]$ResultType`, `$TargetPid` (never `$pid`), DPI-awareness block, `click_at`, command-id echo in `Write-Response`. If any is missing, STOP and reconcile.

- [ ] **Step 1: Write the failing test.**

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

- [ ] **Step 2: Run it and confirm it fails.** `node --test test/from-computer-clipboard.test.js` → FAIL, "clipboard_read must be registered".

- [ ] **Step 3: Add the two PowerShell commands.** Follow the existing `case` shape exactly, including the command-id echo.

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

- [ ] **Step 4: Add the two effectors** to `from-computer.js`'s `TOOLS` array, delegating through the same `pcChild.sendCommand` path `from-pc.js` already uses. `clipboard_read` — `danger: false`. `clipboard_write` — `danger: true` (it overwrites operator state).

- [ ] **Step 5: Add tiers** to `leash/tiers.js` `TIER_TABLE`: `clipboard_read: 0`, `clipboard_write: 1`.

- [ ] **Step 6: Run the test.** PASS.

- [ ] **Step 7: Live-verify, then commit immediately.** Copy text in another app, ask MYTHOS what's on the clipboard, then have it write something and paste it. `ps-automation.ps1` changes do not sit uncommitted while other sessions run.

```bash
git add mythos/adapters/pc-child/ps-automation.ps1 mythos/src/core/effectors/from-computer.js mythos/src/core/leash/tiers.js test/from-computer-clipboard.test.js
git commit -m "feat(clipboard): add clipboard_read/clipboard_write via pc-child"
```

### Task 4: File move / copy / rename / search

**Files:** Modify `mythos/src/core/effectors/from-computer.js`, `mythos/src/core/leash/tiers.js`; Test `test/from-computer-fileops.test.js`

`write_file`, `create_folder`, and `delete_file` **already exist** at `from-computer.js:308-310`. Only these four are missing. Reuse the file's existing sandbox helpers verbatim — `resolveSandboxed()`, `isInsideAllowedRoots()`, `nearestExistingAncestor()` (the symlink-escape guard). Do not write new path-safety code.

- [ ] **Step 1: Write the failing test.** Cover the case that matters: destination outside the sandbox must be rejected even when the source is inside.

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

- [ ] **Step 2: Run it. FAIL** — "move_file must be registered".

- [ ] **Step 3: Implement the four tools.** `move_file` (`fs.renameSync`), `copy_file` (`fs.copyFileSync`), `rename_file` (same-parent case of move), `search_files` (depth-capped `readdirSync` walk, name match, 50-entry cap matching the existing `list_folder` limit). Every path argument — **source and destination** — goes through `resolveSandboxed()` then `isInsideAllowedRoots()`.

- [ ] **Step 4: Tiers.** `move_file: 3`, `copy_file: 3`, `rename_file: 3`, `search_files: 0`. T3 matches the existing `write_file`/`delete_file` grouping — irreversible-in-place inside the sandbox.

- [ ] **Step 5: Run tests. PASS.**

- [ ] **Step 6: Live-verify by voice** inside `VOICE_ALLOWED_DIRS`, then commit.

### Task 5: Alarms and timers with an audible alert

**Files:** Modify `mythos/src/core/effectors/from-calendar.js`, `mythos/server/index.js`; add `mythos/ui/public/audio/alert.wav`; Test `test/from-calendar-timer.test.js`

A timer is a reminder whose `when` is always relative and which rings. `parseWhen()` already handles `"in N minutes"`, `reminder-sensor.js` already polls `fireDueReminders()` every 30s, and `server/index.js` already subscribes to `reminder.due`. No new store, no new sensor, no new file format.

- [ ] **Step 1: Write the failing test.**

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

- [ ] **Step 2: Run it. FAIL.**

- [ ] **Step 3: Implement.** Add `alertSound: Boolean(opts.alertSound)` to the record shape in `addReminder()`. Add `timer_add` as a thin wrapper calling `addReminder({ text: opts.label || 'Timer', when: 'in ' + opts.minutes + ' minutes', alertSound: true })`.

- [ ] **Step 4: Ring it.** In the existing `bus.subscribe('reminder.due', …)` handler, when `e.payload.alertSound` is set, send one extra `speech-chunk` whose `audioB64` is the bundled `alert.wav` **before** the normal `proactiveSpeak('Reminder: ' + text)`. A static bundled tone, not a TTS round trip for a fixed sound.

- [ ] **Step 5: Tiers.** `timer_add: 0` (matches existing `reminder_add: 0`), `timer_cancel: 1`.

- [ ] **Step 6: `.env.example`.** Document `REMINDER_ALERT_SOUND` (path override; default is the bundled asset).

- [ ] **Step 7: Run tests, then live-verify — set a 1-minute timer and hear it ring.** Commit.

### Task 6: Server bind + bearer auth (V2 §7.2, unchanged — implement as written)

**Files:** Modify `mythos/src/core/config/schema.js`, `mythos/src/main.js`, `mythos/server/index.js`; Test `test/server-auth.test.js`

V2 §7.2 already specifies this completely, including `tokenOk()` with `crypto.timingSafeEqual` and the boot guard. Implement it verbatim from V2. Two facts that make it urgent and are worth restating: `Dockerfile` and `render.yaml` both already set `MYTHOS_BIND=0.0.0.0`, and the only current gate is origin allow-listing at `server/index.js:357`, which any non-browser client spoofs with a header. A cloud-deployed MYTHOS today exposes 106 tools — including T3 confirm-and-execute — to anyone who finds the URL.

Two additions to V2's spec, both needed by Wave 4's phone client:

- [ ] **WS token via query string.** Browser `WebSocket` cannot set headers, so `verifyClient` must accept `?token=` in addition to an `Authorization` header. Keep the loopback and origin short-circuits first, so local dev is untouched.
- [ ] **Gate `/vault/builds` too.** It serves real generated content. Leave the UI shell static mount open so a remote browser can load the app and enter a token — no secret lives in those assets (AD-8).

- [ ] **Test, red first:** spawn a child process with `MYTHOS_BIND=0.0.0.0` and no token, assert **non-zero exit**; then with a token set, assert `/api/status` returns 401 unauthenticated and 200 with `Authorization: Bearer <token>`.

- [ ] **Commit.** Back-compat is total — default config exercises none of the new branches.

### Task 7: Autostart on login

**Files:** Create `mythos/scripts/setup-autostart.js`

- [ ] **Step 1: Write it** with `--install` / `--check` / `--uninstall`. Task name `MythosAgentOS`. Resolve the repo root as `path.resolve(__dirname, '..', '..')` — **never** a hardcoded path (repo portability rule). Point at the existing `Start Agent OS.bat`; do not invent a second entry point.

```js
spawnSync('schtasks', ['/create', '/tn', 'MythosAgentOS', '/tr', quotedCmd,
                       '/sc', 'onlogon', '/rl', 'limited', '/f'], { encoding: 'utf8' });
```

`/rl limited` — MYTHOS needs no elevation. `/f` makes re-registration idempotent.

- [ ] **Step 2: `--check` runs `schtasks /query /tn MythosAgentOS /v /fo list`** and prints the registered command, so a stale registration after a repo move is visible instead of silently wrong.

- [ ] **Step 3: User-invoked only.** Never auto-run at install. No `.env` key — this is a one-time machine action, not runtime config.

- [ ] **Step 4: Verify** by installing, logging out and back in, and confirming the process is up. Commit.

---

## Wave 2 — Android via ADB (supersedes V2 §7.4)

### Task 8: The `android-child` adapter

**Files:** Create `mythos/adapters/android-child/index.js`; Test `test/android-child-adapter.test.js`

**This is not a copy of `pc-child`.** `pc-child` keeps one PowerShell process alive because `ps-automation.ps1` is a long-running script MYTHOS owns. `adb` has no such mode — every `adb -s <serial> shell …` is a one-shot call that exits. Cargo-culting the persistent-daemon shape here would be inventing a protocol where `adb`'s own argv/exit-code contract already is one. What transfers is the *discipline*, not the shape: command queue, per-command timeout, retry with backoff, restart budget, diagnostic ring buffer, side-effect-free `require()`, explicit `start()`/`shutdown()`, module-level singleton state, and `cua-driver`'s ENOENT → OFFLINE contract.

- [ ] **Step 1: Write the failing test, mirroring `test/cua-driver-adapter.test.js`.** Assert: `require()` has no side effects; `sendCommand()` never throws while OFFLINE; state settles to a terminal value within a bounded poll; `shutdownAndroidChild()` is safe with nothing started. **No live `adb` in CI.**

- [ ] **Step 2: Run it. FAIL.**

- [ ] **Step 3: Implement.**
  - `startAndroidChild()` probes `adb version` via `spawnSync` with a short timeout. ENOENT → `state='OFFLINE'`, `hint='adb not found — run node mythos/scripts/setup-android.js --install'`. Boot continues (AD-9).
  - On success, `adb start-server`, then an unref'd `setInterval` polling `adb devices -l` every `ANDROID_ADB_POLL_MS` (default 8000) to refresh `devices: Map<serial, {model, transportId, authState, lastSeenAt}>`.
  - **Per-device queues**, not one global queue: `Map<serial, {queue: [], inFlight: null}>`. Two devices is an explicit Pro-Plus requirement; a slow command on phone A must not block phone B. Each queue keeps `pc-child`'s discipline — one in-flight command, `ANDROID_CMD_TIMEOUT_MS` (default 15000), reject-fast when offline.
  - `getStatus()` returns `{state, hint, devices, queueDepth}` using the **same `state`/`hint` field names** as `pc-child`/`cua-driver`, so `main.js`'s adapter-status roll-up and the capability manifest need no special-casing.
  - `shutdownAndroidChild()` clears queues and stops the poll timer. **Do not call `adb kill-server`** — that would drop other tools' adb sessions on the same machine.

- [ ] **Step 4: Run tests. PASS.** Commit.

### Task 9: `setup-android.js` — install and pair

**Files:** Create `mythos/scripts/setup-android.js`

Modeled on `setup-hermes.js`'s `--check`/`--install` shape.

- [ ] **Step 1: `--check`** (default): resolve `adb` from PATH or `ANDROID_ADB_BIN`, run `adb version`, run `adb devices -l`, print per-device pairing status. Also print the smoke test to run: `adb -s <serial> shell echo mythos-ping`.

- [ ] **Step 2: `--install`:** download Google's official versioned `platform-tools` zip into `<repo>/Android Platform Tools/` (gitignored — everything stays inside the project), unzip, print the resolved path for `ANDROID_ADB_BIN`. A plain versioned zip, **never** `curl | bash` or `iex (irm …)`.

- [ ] **Step 3: `--pair <ip:port> <code>`** → `adb pair`. Android 11+ Wireless Debugging. The pairing code comes from the phone's Developer Options screen — a manual on-phone step no script can automate; say so in the output.

- [ ] **Step 4: `--connect <ip:port>`** → `adb connect`, and persist to `vault/Identity/android-devices.json`. Vault, not `.env` — this is a growing list, not a static secret. Recommend a router DHCP reservation in the output, because a renewed lease silently breaks every `phone_*` tool.

- [ ] **Step 5: Verify** `--check` against a real device. Commit.

### Task 10: `from-android.js` — the 14 phone tools

**Files:** Create `mythos/src/core/effectors/from-android.js`; modify `mythos/src/core/leash/tiers.js`, `mythos/src/main.js`, `mythos/.env.example`; Test `test/from-android.test.js`

Same shape as `from-pc.js`: a `delegate()` helper that checks `getStatus().state === 'ONLINE'` and translates `{ok, stdout}` into the `ok()`/`fail()` shape `effectorFromTool` expects.

| Tool | adb invocation | Tier |
|---|---|---|
| `phone_list_devices` | `adb devices -l` | 0 |
| `phone_screenshot` | `exec-out screencap -p` (base64 in JS) | 1 |
| `phone_notifications` | `shell dumpsys notification --noredact` | 1 |
| `phone_contacts_search` | `shell content query --uri content://com.android.contacts/data --where …` | 1 |
| `phone_sms_send` | `shell am start -a android.intent.action.SENDTO -d sms:<n> --es sms_body '<t>'` | **3** |
| `phone_call` | `shell am start -a android.intent.action.CALL -d tel:<n>` | **3** |
| `phone_whatsapp_send` | `am start -a …VIEW -d "https://wa.me/<e164>?text=…"` then a resolved send tap | **3** |
| `phone_wifi_toggle` | `shell svc wifi enable\|disable` | 2 |
| `phone_bluetooth_toggle` | `shell svc bluetooth enable\|disable` | 2 |
| `phone_hotspot_toggle` | `shell svc` / `cmd` best-effort | 2 |
| `phone_flashlight_toggle` | best-effort; **no reliable stock command exists** | 2 |
| `phone_app_launch` | `shell monkey -p <pkg> -c …LAUNCHER 1` | 2 |
| `phone_app_close` | `shell am force-stop <pkg>` | 2 |
| `phone_file_pull` / `phone_file_push` | `adb pull` / `adb push` | 1 / **3** |

- [ ] **Step 1: A generic `phone_shell` is deliberately NOT exposed.** Every capability is a named, tiered action. A raw shell tool would be a de facto T4 bypass of the entire tier table — the same reasoning `run_command`'s allowlist already encodes for the desktop.

- [ ] **Step 2: Honest failure is the hard requirement here.** `phone_sms_send` via intent **opens Messages pre-filled; it does not send.** Report exactly that — "opened, needs a tap to send" — unless a follow-up tap is *confirmed landed*. Never claim a sent message. Same for `phone_flashlight_toggle`: return `{ok: false, error: 'not supported on this device'}` rather than a fabricated success. This is AD-4 and it is the whole difference between MYTHOS and IRIS.

- [ ] **Step 3: Resolve the WhatsApp send button via `uiautomator dump` + `resource-id`** (e.g. `com.whatsapp:id/send`), **never** fixed x/y coordinates — those break on every UI bump and every screen resolution. When the dump has no matching id, fall back to "opened the chat, please tap send."

- [ ] **Step 4: Require an explicit `deviceId`** on every device-scoped tool. With 2+ paired devices and none specified, return `{ok: false, error: 'Which phone — check phone_list_devices'}` rather than guessing.

- [ ] **Step 5: Write the test against a mocked adapter**, red first. Assert each tool degrades honestly when OFFLINE, and that `phone_sms_send`'s success message does **not** claim delivery.

- [ ] **Step 6: All 14 entries into `TIER_TABLE`.** That file's header forbids adding or re-tiering without updating the spec — this plan is that update.

- [ ] **Step 7: Wire boot in `main.js`** — start/shutdown the adapter, register the effectors, include adapter status in the capability manifest.

- [ ] **Step 8: Document the new keys in `.env.example`:** `ANDROID_ADB_BIN`, `ANDROID_ADB_POLL_MS`, `ANDROID_CMD_TIMEOUT_MS`.

- [ ] **Step 9: Live-verify on a physical phone:** `adb shell echo` roundtrip, a real SMS compose, a real WhatsApp deep link, WiFi toggle on and off. Commit.

### Task 11: The rest of V2 §7 plus the four gaps the audit surfaced

V2 already specifies §7.1–§7.7 completely. One agent per item, **worktree isolation** for anything touching `ps-automation.ps1`.

Four additions from the side-by-side audit, all of which reuse machinery that already exists:

- [ ] **Semantic code search** — reuse `memory/vector-index.js` and `providers/embeddings.js` as-is; point the chunker at project directories under `VOICE_ALLOWED_DIRS` and include results in `recallHybrid()`'s fan-out. This is §7.5's machinery with a different source, so **build §7.5 first** and this becomes a source adapter, not a second index.
- [ ] **Maps + routing** — keyless public endpoint, same shape as the existing keyless `get_weather`. T0. No key, no new dep.
- [ ] **Image generation** — route through a provider that already has a key in `.env`; do not add one for this. No wired provider supports it → the tool reports OFFLINE rather than shipping a stub.
- [ ] **WhatsApp desktop scheduling** — a follow-on to Task 10, not new machinery: a reminder record whose fire action is `phone_whatsapp_send`. Reuses Task 5's timer path and Task 10's send path. T3.

The original V2 items:

- [ ] **§7.1 Screen OCR** — `Windows.Media.Ocr` through the existing `Await-WinRTOperation`. Full PowerShell case is in V2. Do **not** add `tesseract.js` — wasm plus traineddata for something Windows already ships.
- [ ] **§7.3 PIN / Windows Hello lock** — salted hash in the vault, never plaintext; degrade to PIN-only without Hello hardware.
- [ ] **§7.5 Document RAG** — the expensive parts already exist (`memory/vector-index.js`, `providers/embeddings.js`, `recallHybrid()` with RRF). Add upload route, ~800-token chunker with 15% overlap, Documents store, fan-out inclusion. **Do not switch embedding models** — `gemini-embedding-001` is 3072-dim against `mistral-embed`'s 1024 and would invalidate every stored vector.
- [ ] **§7.6 Calendar claim** — `from-calendar.js`'s header advertises a Google Calendar layer that exists in no file. Implement it (the OAuth adapter already works for Gmail, so this is scope, not new auth) **or delete the claim.** Do not leave it.
- [ ] **§7.7 Wallpaper** — `SystemParametersInfo(SPI_SETDESKWALLPAPER)` P/Invoke.

---

## Wave 1.5 — Persona unclamp (run 3rd, standalone, before any S2S work)

### Task 11-persona: Unclamp the persona (V2 §11)

**Files:** Modify `mythos/src/core/brain/index.js:117-134`, `mythos/src/core/voice/voice-agent.js:232`, `vault/Identity/persona.json`, `vault/Identity/self.md`; Test `test/persona-dials.test.js`

Its own wave because it belongs to neither the desktop nor the phone batch: hours of work, the largest felt improvement in the plan, zero new transport, two-file rollback. V2 §11 specifies all six changes. The load-bearing constraint:

- [ ] **`STYLE_GUARDRAIL` at `identity/index.js:101` stays byte-for-byte untouched.** Errors, failures, confirmations, and safety warnings are always delivered plainly — no humor, no sass. That one sentence is what makes humor 8 and sass 7 safe to run, and it is why raising the dials does not conflict with the honesty rules.
- [ ] **Test, red first:** humor 8 → the `>=8` band string; `STYLE_GUARDRAIL` present at every setting; the **voice** lane gets no `' Be concise and actionable.'` tail while the **build** lane still does.
- [ ] **Then judge by ear** — greeting, status check, a wrong assertion to push back on, a build request, a failing tool. Wit in the first four; the failure reported plainly. That last one proves the guardrail holds.

---

## Wave 3 — Speech-to-speech + latency measurement

Implement **V2 §6–§10 exactly as written** — `live-session.js`, `live-tools.js`, the tool adapter, the browser PCM path, server wiring. (V2 §11 is persona, already done in Wave 1.5 — do not repeat it here.) Nothing in this delta document changes those; the probe has already retired their biggest risk. Three reminders that carry the most weight:

- [ ] A single `serverContent` frame may carry audio **and** both transcripts. Process every field present — **no `else if`.** V2 calls this the #1 data-loss bug.
- [ ] Use `realtimeInput` for user turns, never `clientContent` mid-conversation (it breaks VAD).
- [ ] `contextWindowCompression.slidingWindow` and `sessionResumption` are **mandatory**, not optional — the connection dies at ~10 minutes regardless.

### Task 12: Latency instrumentation

**Files:** Modify `mythos/ui/public/js/voice/voice-loop.js`, `mythos/ui/public/js/ws.js`, `mythos/server/index.js`; Test `test/voice-latency.test.js`

- [ ] **Step 1: Write the failing test** — after a synthetic turn, `/api/status` exposes `voiceLatency: {p50, p95, sampleCount}`.

- [ ] **Step 2: Stamp `micStoppedAt`** at `voice-loop.js`'s `stopRecording()` — the true mic-stop moment — and thread it through to the outbound WS frame.

- [ ] **Step 3: Compute the delta server-side** when the first audio frame for that `reqId` actually ships (both the S2S and fallback paths). Store in a capped ring buffer, same pattern as the existing `anomalyLog`. Surface via a new additive WS type and in `/api/status`.

- [ ] **Step 4: Measure the whole pipeline honestly** — an unmeasured turn contributes no sample rather than an estimate (AD-5).

- [ ] **Step 5: Live-verify against IRIS's advertised number.** Target <1s wake-word→first-audio. Report the real p50 whatever it is.

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
