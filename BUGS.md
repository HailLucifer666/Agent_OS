# MYTHOS — Complete Bug Registry

Comprehensive issue log covering the entire MYTHOS history, mined from:
- Episodic conversation logs (vault/Episodic/)
- Audit decision logs (vault/Audit/)
- Incident reports (vault/Incidents/)
- Semantic memory (vault/Semantic/)
- Code comments (D-NN drift items, SPEC/REALITY GAPs)
- Git commit history
- Live session bug reports

Last updated: 2026-07-16
Maintainer: update this file as issues are resolved. Strike through the status.

---

## Legend

- ✅ **FIXED** — resolved and verified working
- 🔧 **CODED** — code written but NOT verified working
- ❌ **BROKEN** — reported broken, not yet fixed
- ⚠️ **REGRESSION** — was working, got broken by a change
- 🔍 **DIAGNOSED** — root cause identified, fix not applied
- 📋 **TRACKED** — formally tracked in ROADMAP.md as D-NN drift item

---

## CRITICAL — User-Facing Breakage

### BUG-001: Spotify play doesn't play the song
**Status:** ❌ BROKEN — 🔍 DIAGNOSED
**Severity:** CRITICAL (high-severity incident logged)
**First reported:** 2026-07-15 | **Last seen:** 2026-07-16

**Symptom:** User says "play Russia on Ice by Porcupine Tree." Spotify opens, search box fills with the query, but the song does NOT play. User must manually click play. In earlier incidents, it opened the Documents folder instead of Spotify entirely.

**Root cause:** `Handle-LaunchApp` in `ps-automation.ps1` line 169:
```powershell
if ($name -eq 'spotify')    # ← exact string match ONLY
```
`spotify_play` sends `name = 'spotify:search:Russia%20on%20Ice'` — does NOT match `'spotify'`. Falls through to `Start-Process -FilePath 'spotify:search:...'` which is unreliable for URI schemes. The `send_key('enter')` IS correctly wired (Send-VkKey sends real VK_RETURN 0x0D), but Enter goes to whatever has focus — not Spotify's search results.

**Audit evidence:** 6 of 7 `spotify_play` completions failed (~86% failure rate). The 1 success ("Russia on Ice Porcupine Tree") only succeeded because it sent a keystroke — but the song still didn't play.

**Fix needed:**
1. `ps-automation.ps1` — change guard from `$name -eq 'spotify'` to `$name -like 'spotify*'` so URI schemes use the reliable launch path
2. `from-spotify.js` — focus the Spotify window before sending Enter
3. Stop fabrication: the voice agent must NOT say "Playing X" when `spotify_play` returns `ok:false`

**Files:** `mythos/adapters/pc-child/ps-automation.ps1` (line ~169), `mythos/src/core/effectors/from-spotify.js` (lines 166-187)

---

### BUG-002: Text compose bar sends but reply never appears
**Status:** ❌ BROKEN — 🔍 DIAGNOSED
**Severity:** CRITICAL (blocks all text chat)
**First reported:** 2026-07-15 (this session)

**Symptom:** Type a message in the compose bar, press Enter. Nothing appears. No reply shows. Prompt chips ("Play a song on Spotify", "What can you do?") submit but nothing comes back and they disappear.

**Root cause:** The compose bar calls `utterance({ text })` from `ws.js`. The server processes it and sends back `speech-chunk` + `done` messages with the reqId. BUT in `ws.js`, replies with a reqId are routed to the `handlers` Map (line 49), NOT to broadcast listeners. The conversation panel subscribes to broadcasts — it never sees utterance replies. Meanwhile `app.js` line 63 wires `onCaption` as `(text, kind) => {}` — an EMPTY function. The reply is discarded.

**Fix needed (recommended approach):**
Route text input through the voice loop's `beginTurn()/onExternalChunk()/deliverExternalReply()` path (same pattern as proactive speech in app.js lines 228-237). This reuses existing reply display + TTS playback.

**Files:** `mythos/ui/public/js/compose-bar.js`, `mythos/ui/public/js/app.js` (line 63), `mythos/ui/public/js/ws.js`

---

### BUG-003: Google News "refused to connect" in dashboard panel
**Status:** ✅ FIXED (session 2026-07-15)
**Severity:** HIGH | **Reported:** 2026-07-14 | **Recurring:** 4 log_incident entries across 2 days

**Symptom:** Opening Google News in the dashboard web panel showed "news.google.com refused to connect." Recurred for 3+ days.

**Root cause:** `open_web type:"web"` created an iframe for `news.google.com`. Google sends `X-Frame-Options: SAMEORIGIN`, browser blocked it.

**Fix applied:**
- `from-dashboard.js` — smart URL routing: `news.google.com` → `widgetType:'news'`, known blocking domains → `widgetType:'newtab'`
- `app.js` — `open-web` subscriber handles `newtab`/`news`: calls `window.open()` instead of iframe

---

### BUG-004: Music/media widget shows nothing when Spotify is playing
**Status:** ❌ BROKEN — 🔍 DIAGNOSED
**Severity:** HIGH | **First reported:** 2026-07-15

**Symptom:** The "NOW PLAYING" widget is blank when a song is playing on Spotify.

**Root cause (3 issues):**
1. **Server bug** — `server/index.js` line 147: `res.json({ ok: false, error: result.result })` — should be `result.error`. Error messages swallowed as `undefined`.
2. **SMTC availability** — `Handle-MediaStatus` checks if WinRT type `Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager` is available. The PS script loads `UIAutomationClient` and `System.Windows.Forms` but NOT the Windows Runtime assemblies needed for SMTC.
3. **No WinRT initialization** — `[Windows.Media.Control...]` type may not resolve without explicit WinRT projection.

**Fix needed:**
1. `server/index.js` line 147: `result.result` → `result.error`
2. `ps-automation.ps1`: add WinRT initialization (`[Windows.Runtime.WindowsRuntimeSystemRuntimeInformation]` or equivalent)
3. Verify SMTC type resolves by testing standalone in PowerShell

**Files:** `mythos/server/index.js` (line 147), `mythos/adapters/pc-child/ps-automation.ps1` (Handle-MediaStatus), `mythos/ui/public/js/widgets/kinds/media.js` (code correct)

---

### BUG-005: Floating news widgets cannot be closed
**Status:** ❌ BROKEN
**Severity:** MEDIUM | **Reported:** 2026-07-14 (log_incident)

**Symptom:** User opened AI/family/space news widgets. Can drag them but cannot close them — close button is non-functional.

**Note:** The widget resize feature was added this session. The close button issue may be related to event propagation (the resize handle's `stopPropagation` might interfere) or the close button was never wired for boot widgets.

**Files:** `mythos/ui/public/js/widgets/widget-host.js` (close button wiring for spawned widgets)

---

### BUG-006: YouTube embed shows "Video unavailable"
**Status:** ⚠️ REGRESSION → PARTIALLY REVERTED
**Severity:** MEDIUM | **Reported:** 2026-07-15

**What happened:**
1. YouTube was working with `youtube-nocookie.com/embed/...?autoplay=1`
2. Changed to `youtube.com/embed/...?autoplay=0` — BROKE it
3. Reverted to original URL
4. Added fallback detection in `web-panel.js` (postMessage onReady + 8s timeout)

**Current state:** Embed URL reverted. Fallback is 🔧 CODED but unverified. YouTube's 2025-2026 bot-detection increasingly blocks embedded playback for music content — may be unfixable client-side.

**Files:** `mythos/ui/public/js/views/web-panel.js`, `mythos/src/core/effectors/from-dashboard.js`

---

## HIGH — Functional Issues

### BUG-007: MYTHOS fabricates success ("Playing X now") when tools fail
**Status:** ❌ BROKEN
**Severity:** HIGH (trust-destroying) | **Pattern across:** 07-15, 07-16

**Symptom:** Throughout the Spotify sequence, MYTHOS replied "Playing Moved by Mild Orange on Spotify" / "Playing Mood by Mild Orange now" while every `spotify_play` call returned `ok:false`. The voice agent asserts success the tool never achieved.

**Root cause:** The voice agent's response generation (`voice-agent.js`) doesn't check whether the dispatched action's result was `ok:true` before announcing success in the `say` field. The LLM generates a confident "playing now" reply based on the intent, not the outcome.

**Fix needed:** After all actions execute, inject the actual outcomes into the reply context. The agent must say "I tried to play X but it failed: [reason]" when the action fails. This is partially addressed in `dispatch-action.js` (system outcome messages), but the voice agent's `say` field doesn't use them.

**Files:** `mythos/src/core/voice/voice-agent.js`

---

### BUG-008: `open_artifact` fails on voice channel (cortex channel works)
**Status:** ❌ BROKEN
**Severity:** HIGH | **Recurring:** 07-12, 07-14, 07-15 (6 occurrences)

**Symptom:** Voice-channel calls to `open_artifact` consistently return `ok:false`. The cortex-channel retry that immediately follows succeeds. So the voice-tier wrapper is broken, not the underlying open.

**Audit evidence:** Confirmed on every day sampled — the voice tier fails, cortex succeeds.

**Fix needed:** Investigate why the voice-tier dispatch path for `open_artifact` differs from cortex. Likely a wiring or context difference in how `server/index.js` `handleUtterance` dispatches vs the cortex loop.

**Files:** `mythos/server/index.js` (handleUtterance dispatch), `mythos/src/core/effectors/from-dashboard.js` (open_artifact)

---

### BUG-009: No screenshot tool — cannot capture UI bugs as evidence
**Status:** ❌ BROKEN (missing feature)
**Severity:** MEDIUM | **Reported:** 2026-07-15

**Symptom:** User said "take a screenshot and log this incident." MYTHOS admitted "I don't have a tool to take screenshots."

**Note:** A `screen_look` tool exists in `from-pc.js` but it captures a screenshot for vision *description*, not for saving/artifact logging. There's no way to persist a screenshot as evidence of a UI bug.

**Fix needed:** Add a `capture_screenshot` tool that saves a PNG to the vault/Incidents/ directory.

---

### BUG-010: `ask_agent` not wired up — multi-agent dispatch broken
**Status:** ❌ BROKEN
**Severity:** HIGH | **Reported:** 07-12 (~10 failures)

**Symptom:** Every `ask_agent` call returns "ask_agent is not wired up in this context." The multi-agent dispatch tool is non-functional.

**Note:** `main.js` does wire `setAskAgentDispatch` in the dashboard wiring (lines 293-303), but the cortex loop's `ask_agent` dispatch may not be going through the same path.

**Files:** `mythos/src/main.js` (setAskAgentDispatch), `mythos/src/core/effectors/from-dashboard.js` (ask_agent)

---

### BUG-011: Browser automation offline / misconfigured
**Status:** ❌ BROKEN
**Severity:** HIGH | **Reported:** 07-12 (6 failures)

**Symptom:** `browser_navigate` returns "Browser automation is OFFLINE. Run setup-chrome-debug.ps1 first." Even though the user said "I have given you Chrome access." Also `browser_evaluate` gets wrong parameter name (`query`/`expression`/`javascript` instead of expected key).

**Fix needed:** CDP auto-connect on boot, correct parameter names for browser_evaluate.

---

### BUG-012: Approval popup on every action
**Status:** ✅ FIXED
**Severity:** HIGH | **Fixed:** 2026-07-15

**Root cause:** `AUTONOMOUS_MAX_TIER=2` + `max_autonomous_tier: 2`. Many common actions are T3 (ui_click, ui_type, spotify_play, compose_email, build_project). T3 > ceiling(2) → popup.

**Fix applied:** `.env` `AUTONOMOUS_MAX_TIER=3`, `boundaries.md` `max_autonomous_tier: 3`.

---

## MEDIUM — System Issues

### BUG-013: Cortex stalls and effector flapping (healer can't fix)
**Status:** ❌ BROKEN (partially mitigated)
**Severity:** MEDIUM | **Pattern:** 07-11 through 07-14

**Symptom:** The cortex enters tight repeat-call loops (dozens of identical `list_folder path:"."` calls, fake-URL `browser_navigate`, repeated `list_goals`). The immune system's healer detects `effector-flapping` (5 occurrences) and `cortex-stall` (6 occurrences) but:
- `effector-flapping` → always `no-match` (no playbook to break the loop)
- `cortex-stall` → resolved via `stall-restart` (works, but loses context)
- Two goals burned entire budget looping and were force-paused (`budget-exhausted`)

**Fix needed:** Add a flapping-breaker playbook to the healer: when an effector flaps, inject a "stop repeating this tool" instruction into the cortex's next brain call, or temporarily blacklist that tool for the goal.

**Files:** `mythos/src/core/immune/healer.js`

---

### BUG-014: Memory pollution — `remember` auto-saves transcription noise
**Status:** ❌ BROKEN
**Severity:** MEDIUM | **Reported:** 2026-07-15

**Symptom:** User said "that you like." (a fragment, STT noise). MYTHOS ran `remember({text:"The user mentioned they like something, but did not specify what."})` and replied "Noted — I'll remember that." This garbage was persisted to semantic memory.

**Root cause:** The voice agent's MEMORY RULE tries to prevent this ("Only call remember when user EXPLICITLY asks"), but the LLM still fires it on fragments. The rule is a soft prompt instruction, not a hard gate.

**Fix needed:** Add a server-side guard in the `remember` effector — reject entries that are too short (< 10 chars), match known STT-noise patterns ("that you like", "the", incomplete sentences), or lack an explicit save trigger.

**Files:** `mythos/src/core/effectors/from-memory.js` (add validation guard)

---

### BUG-015: `identity-boundaries-malformed` — healer can't fix (9 occurrences)
**Status:** ❌ BROKEN
**Severity:** MEDIUM | **Pattern:** 07-10, 07-11 (9 healer events, all `no-match`)

**Symptom:** On boot, the healer detects malformed identity-boundaries 9 times but finds no matching playbook. Nothing is fixed. `boundaries.md` currently contains only `max_autonomous_tier: 3` (23 bytes) — essentially empty.

**Root cause:** The boundaries.md file is under-specified. The healer's `identity-boundaries-malformed` detector fires but has no playbook to repair it.

**Fix needed:** Either populate `boundaries.md` with the full boundary spec, or add a healer playbook that regenerates a default boundaries file.

---

### BUG-016: Pipeline ships builds with `reviewStatus: "failed"`
**Status:** ❌ BROKEN
**Severity:** MEDIUM | **Reported:** 07-14, 07-15

**Symptom:** Build jobs fail verification (generic template, wrong palette, invented brand names) but the pipeline marks them as "shipped" (progress 100%) and MYTHOS announces completion. User says "you said it's finished" and discovers it's not.

**Root cause:** The pipeline doesn't block shipping when review fails. The `reviewStatus: "failed"` flag is recorded but not enforced as a gate.

**Fix needed:** Make `reviewStatus: "failed"` a hard gate — the pipeline should NOT mark a build as complete/shipped if review failed. MYTHOS should say "Build completed but review found issues: [list]" not "Build finished."

---

### BUG-017: Tool parameter schemas wrong / inconsistent (partially fixed)
**Status:** ✅ PARTIALLY FIXED
**Severity:** MEDIUM | **Reported:** 07-12 (~9 failures)

**What broke (07-12):** `capture_idea({})` empty text, `create_goal({description:...})` wrong field name (should be `text`), `launch_app({app:...})` wrong field name (should be `name`). All returned validation errors.

**What's fixed:** By 07-15, the voice agent catalog uses correct field names and these calls succeed.

**What may still be broken:** Schema drift between the voice agent catalog (`voice-agent.js`) and the effector implementations (`from-*.js`) — no single source of truth.

---

### BUG-018: `list_folder` of source dirs "outside allowed folders"
**Status:** ❌ BROKEN
**Severity:** MEDIUM | **Reported:** 07-12 (6 failures)

**Symptom:** MYTHOS cannot read its own source tree. `list_folder({path:"."})` and `list_folder({path:"src/components/..."})` return "is outside the allowed folders." MYTHOS doesn't know where its own code lives.

**Fix needed:** Whitelist the MYTHOS project root as an allowed folder, or add a "read own source" capability.

---

## LOW — Quality / Polish

### BUG-019: Audit panel shows no audits
**Status:** ❌ BROKEN
**Severity:** LOW | **Reported:** 07-16

**Symptom:** User opened the audit panel — it was empty, even though incident logs were being written to disk.

**Fix needed:** The audit panel view needs to read from `vault/Audit/` and `vault/Incidents/` and display them.

---

### BUG-020: Voice pipeline picks up phantom background noise
**Status:** ❌ BROKEN (intermittent)
**Severity:** LOW | **Reported:** 07-12

**Symptom:** User in an AC room (should be quiet) but MYTHOS picks up background noise and transcribes it. User says they'll "have to use third-party STT software from GitHub because this ain't working well."

**Root cause:** VAD sensitivity too high, or no noise gate before recording.

---

### BUG-021: MYTHOS gives canned empathy instead of diagnosing problems
**Status:** ❌ BROKEN
**Severity:** LOW | **Reported:** 07-12

**Symptom:** When user expressed deep frustration ("you are not working as expected"), MYTHOS repeated "You seem frustrated, what's not working?" verbatim three times — no actual diagnosis, templated empathy.

**Fix needed:** The voice agent should run `read_status` + `list_goals` + check recent audit failures when it detects frustration, and give a concrete diagnosis.

---

### BUG-022: `identity.learn()` never populates learned preferences
**Status:** ❌ BROKEN (missing feature)
**Severity:** LOW

**Symptom:** `vault/Identity/self.md` has a "Learned Preferences" section that contains only `<!-- populated at runtime by identity.learn() -->`. It's never been populated.

---

### BUG-023: Weather widget fails without resolved location
**Status:** ❌ BROKEN
**Severity:** MEDIUM | **Reported:** 2026-07-15 (2 audit failures)

**Symptom:** `open_web type:"weather"` called without a usable location arg returns `ok:false`. Failed twice (once with no location, once with "Kolkata, West Bengal" which couldn't be geocoded), then succeeded with bare "Kolkata". The geocoder is brittle with city+state formatting.

**Audit evidence:** `aud-ea61766b33db` (no location → fail), `aud-4f23b6bd9cfe` ("Kolkata, West Bengal" → fail), `aud-922f2147b02c` ("Kolkata" → ok).

**Fix needed:** The weather path in `from-dashboard.js` should trim location to city name before geocoding, or use a more robust geocoding approach.

**Files:** `mythos/src/core/effectors/from-dashboard.js` (weather branch, lines ~117-130)

---

### BUG-024: Calendar and Gmail integration never completed
**Status:** ❌ BROKEN (missing feature)
**Severity:** HIGH (user expectation) | **Reported:** 07-12, 07-14

**Symptom:** User repeatedly asked about calendar integration ("calendar phase is still left to add to integrate") and Gmail. MYTHOS correctly said it doesn't have those tools — but this is a stated user expectation that remained unfulfilled across the entire dataset.

**Note:** Gmail tools DO exist in the catalog (`gmail_unread`, `gmail_read`, `gmail_send`, `gmail_draft` in voice-agent.js) but require OAuth setup. Calendar wiring exists in main.js (`registerFromCalendar`) but the reminder sensor depends on it working.

**Fix needed:** Complete Gmail OAuth adapter setup. Verify calendar reminder sensor fires.

---

### BUG-025: Pipeline spec lost between capture and execute stages
**Status:** ❌ BROKEN
**Severity:** HIGH | **Reported:** 07-14, 07-15

**Symptom:** The build reviewer repeatedly reports "The deliverable does not match the task spec as the task is undefined." The spec passed to the builder arrives as `undefined` or "not specified" even though the user gave detailed requirements.

**Root cause:** The spec/description from `start_project` or `capture_idea` is being lost between the capture stage and the execute stage of the pipeline. The builder agent receives no spec context.

**Evidence:** 07-14.jsonl review issues: "task is undefined"; 07-15.jsonl same. Multiple builds failed verification for this reason.

**Fix needed:** Trace the spec field through `capture_idea → pipeline → start_project → build-runner → brain.think({lane:'build'})`. Find where the description/spec is dropped.

**Files:** `mythos/src/core/effectors/pipeline.js`, `mythos/src/core/effectors/build-runner.js`, `mythos/src/core/effectors/agent-actions.js`

---

## 📋 TRACKED — ROADMAP.md D-NN Drift Items (architectural debt)

These are formally tracked in `ROADMAP.md`, not user-facing bugs. 43 open (20 MAJOR + 23 MINOR). Most impactful:

| ID | Severity | Description |
|---|---|---|
| D-07 | MAJOR | Graceful 7-step shutdown sequence missing (only hard-exit timer exists) |
| D-19 | MAJOR | Missing store methods: `consolidate()`, audit `recall()`/`get()` |
| D-21 | MAJOR | No per-path mutex on fs-store — unlocked read→mutate→write race |
| D-29 | MAJOR | Providers don't implement canonical interface `{name, chat, isAvailable, getStatus, getModel}` |
| D-30 | MAJOR | `openrouter.js`, `claude-cli.js` built but never imported — dead code |
| D-47 | MAJOR | Goal budget field dropped from brain.think() — Brain never learns remaining tokens |
| D-49 | MAJOR | Goals hardcode budget `tokens:50000, actions:50` instead of reading config |
| D-51 | MINOR | MAX_ACTIVE_GOALS slices before scoring — high-priority goal created 6th is permanently excluded |

Full list in `ROADMAP.md` lines 396-403.

---

## ✅ Previously Fixed (Historical Record)

| ID | Description | Fixed in |
|---|---|---|
| D-56 | Every `brain.think({lane})` silently fell through to `text` lane since Phase 2 | Phase 4.5 |
| D-57 | Boot order + job↔goal mapping + auto-resume | P17/P18/P19 |
| D-23 | WorkingMemory checkpoint consult | P17 |
| D-55 | Audit-writer nested-secret redaction | — |
| — | `decide()` async but called without await — every decision dispatched as `unknown-effector` | P7 |
| — | `addGoal()` pre-populated map before writeBack — new goals never written to Goals.md | P7 |
| — | `addSpend()` dead code — every action showed `tokensSpent:0` | — |
| — | Echo loop, hallucinations, fabrication — 5 compounding bugs | commit `eb3ff49` |
| — | Browser auto-launch at boot stealing mic on Windows | commit `30f72dd` |
| — | Dashboard navigation: health/audit/memory routes didn't exist (07-12) | fixed by 07-14 |

---

## Priority Queue (what to fix next, in order)

1. **BUG-002** — Compose bar reply not wired (blocks ALL text chat)
2. **BUG-001** — Spotify play doesn't play (most-reported bug, 6 failures; URI fix applied, needs verification)
3. **BUG-004** — Media widget blank (3 sub-issues; WinRT init fix applied, needs verification)
4. **BUG-007** — Fabrication of success (trust-destroying)
5. **BUG-025** — Pipeline spec lost between capture and execute
6. **BUG-016** — Pipeline ships failed-review builds
7. **BUG-008** — `open_artifact` voice channel broken
8. **BUG-005** — Widget close button non-functional
9. **BUG-013** — Cortex flapping/stall loops (healer can't fix)
10. **BUG-010** — `ask_agent` not wired
11. **BUG-011** — Browser automation offline
12. **BUG-014** — Memory pollution (remember auto-saves noise)
13. **BUG-024** — Calendar/Gmail integration incomplete
14. **BUG-023** — Weather widget fails with city+state location
15. **BUG-009** — No screenshot tool for evidence
16. **BUG-018** — Can't read own source tree
17. **BUG-015** — Identity boundaries malformed (healer can't fix)
18. **BUG-019** — Audit panel empty
19. **BUG-020** — Voice noise sensitivity
20. **BUG-021** — Canned empathy instead of diagnosis
21. **BUG-022** — identity.learn() never writes

---

## Files Modified This Session (2026-07-15)

| File | Change | Bug |
|---|---|---|
| `mythos/src/main.js` | Merge conflict resolved | — |
| `mythos/ui/public/js/overlay/panel-registry.js` | Merge conflict resolved | — |
| `mythos/src/core/effectors/from-dashboard.js` | Smart URL routing for news/blocking domains | BUG-003 |
| `mythos/ui/public/js/app.js` | newtab/news handling, compose bar wiring, mic shim | BUG-002, BUG-003 |
| `mythos/ui/public/js/views/web-panel.js` | YouTube fallback detection | BUG-006 |
| `mythos/ui/public/js/widgets/widget-host.js` | Widget resize (makeResizable + persistence) | — |
| `mythos/ui/public/css/widgets.css` | Resize handle CSS, tabular-nums, media styles | — |
| `mythos/ui/public/css/tokens.css` | Contrast fix (--text-faint) | — |
| `mythos/ui/public/css/hud.css` | line-height: 1.5 | — |
| `mythos/ui/public/css/compose-bar.css` | NEW — compose bar styling | BUG-002 |
| `mythos/ui/public/js/compose-bar.js` | NEW — multimodal input (BROKEN) | BUG-002 |
| `mythos/ui/public/index.html` | Compose bar container, mic indicator hidden | BUG-002 |
| `mythos/.env` | AUTONOMOUS_MAX_TIER=3 | BUG-012 |
| `mythos/vault/Identity/boundaries.md` | max_autonomous_tier: 3 | BUG-012 |
