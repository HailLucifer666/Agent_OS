# MYTHOS — Complete Bug Registry

Comprehensive issue log covering the entire MYTHOS history, mined from:
- Episodic conversation logs (vault/Episodic/)
- Audit decision logs (vault/Audit/)
- Incident reports (vault/Incidents/)
- Semantic memory (vault/Semantic/)
- Code comments (D-NN drift items, SPEC/REALITY GAPs)
- Git commit history
- Live session bug reports

Last updated: 2026-07-16 (session 3 — 6 new bugs BUG-031→036, 5 fixed, SMTC diagnosed)
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
**Status:** 🔧 CODED — item 1 (URI launch guard) was already fixed in code prior to this pass; item 2 (focus window before Enter) fixed this pass with a passing regression test; item 3 (fabrication) covered separately by BUG-007, confirmed already-fixed.
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

**Verification note (this pass):** Item 1 was found already fixed on disk (`ps-automation.ps1` line 170 reads `if ($name -eq 'spotify' -or $name -like 'spotify:*')`) — no change needed there. PowerShell syntax check on the entire `ps-automation.ps1` file passed (using `[System.Management.Automation.PSParser]::Tokenize()` — the file parses without syntax errors). Item 2: `spotify_play()` (from-spotify.js) now calls `getSpotifyWindow()` and `pcEffectors.invoke('focus_window', {pid}, {})` after the 2500ms render wait and before `send_key`, best-effort (falls through to send_key even if focus fails/window not found, surfacing the focus problem in the result instead of silently dropping it). Added `test/spotify-effector.test.js` describe block "BUG-001: spotify_play focuses the Spotify window before send_key" asserting `focus_window` is invoked (with the correct pid) before `send_key` via call-order tracking on a mocked `pcEffectors`. Ran `node --test test/spotify-effector.test.js`: 17/17 pass. This is a mock-verified call-order fix, not a live-hardware confirmation — actual play-through with a running Spotify instance is still 🔧 CODED, not ✅ VERIFIED. Item 3 is covered by BUG-007 below (already-fixed-confirmed).

**Live re-test (2026-07-16, real session, post-fix):** User confirmed the focus fix did NOT resolve playback. Transcript: "play Led Zeppelin" → `spotify_play` → "Playing Led Zeppelin on Spotify now" (still fabricated, see BUG-007) → user: "it still doesn't play, you opened it, you searched for it, but it—" → retried with `spotify_search`+`spotify_status` → still no playback → user: "it's opening [the app]... it can open Spotify but it cannot play the song, it searches for the song, it shows up, it cannot navigate to that particular tile... there is no key action." Focus-then-Enter is landing on the Spotify window but not on a playable target — the code comment's assumption ("the first track is auto-focused in the results list," from-spotify.js line 175) is not holding up against the real client: Enter appears to be re-triggering the search box, not a result tile. Root cause of THIS specific failure mode is tracked as **BUG-026** below — do not re-close BUG-001 as fixed until BUG-026 lands and is live-verified with an actual play-through.

---

### BUG-002: Text compose bar sends but reply never appears
**Status:** 🔧 CODED — fixed per the recommended approach below; no headless DOM harness exists for this UI, so this needs a manual browser check (see verification note).
**Severity:** CRITICAL (blocks all text chat)
**First reported:** 2026-07-15 (this session)

**Symptom:** Type a message in the compose bar, press Enter. Nothing appears. No reply shows. Prompt chips ("Play a song on Spotify", "What can you do?") submit but nothing comes back and they disappear.

**Root cause:** The compose bar calls `utterance({ text })` from `ws.js`. The server processes it and sends back `speech-chunk` + `done` messages with the reqId. BUT in `ws.js`, replies with a reqId are routed to the `handlers` Map (line 49), NOT to broadcast listeners. The conversation panel subscribes to broadcasts — it never sees utterance replies. Meanwhile `app.js` line 63 wires `onCaption` as `(text, kind) => {}` — an EMPTY function. The reply is discarded.

**Fix needed (recommended approach):**
Route text input through the voice loop's `beginTurn()/onExternalChunk()/deliverExternalReply()` path (same pattern as proactive speech in app.js lines 228-237). This reuses existing reply display + TTS playback.

**Files:** `mythos/ui/public/js/compose-bar.js`, `mythos/ui/public/js/app.js` (line 63), `mythos/ui/public/js/ws.js`

**Verification note (this pass):** `compose-bar.js`'s `submit()` now calls its own internal `setCaption(text, 'heard')` for the user's own message (instead of the dead `onCaption` prop) and hands off via a new `onSubmitText(text)` callback; the dead `utterance()` import/call was removed from that file. `app.js` now imports `utterance` from `ws.js` and adds `sendTextMessage(text)` (mirrors `describeScene()`'s `beginTurn/onExternalChunk/deliverExternalReply` pattern), wired in as `onSubmitText: sendTextMessage` on the `createComposeBar({...})` call. Both files pass `node --check` (syntax-clean). No headless DOM test harness exists for this UI, so this is CODED, not unit-verified — manual check: open the HUD, type a message in the compose bar and press Enter/click send; the user's own message should appear immediately as a "heard" caption, and the reply should appear as a "reply" caption AND play as TTS, the same as a voice utterance.

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
**Status:** 🔧 CODED (2026-07-16) — WinRT `.Wait()` bug fixed via `AsTask()` reflection bridge; NOT yet live-verified (needs a real Windows session playing something)
**Severity:** HIGH | **First reported:** 2026-07-15

**Symptom:** The "NOW PLAYING" widget is blank when a song is playing on Spotify.

**Root cause (3 issues):**
1. **Server bug** — `server/index.js` line 147: `res.json({ ok: false, error: result.result })` — should be `result.error`. Error messages swallowed as `undefined`. **FIXED** — now reads `result.error`, matching `pcChild.sendCommand`'s real `{ ok, result/error }` failure shape. Covered by `mythos/test/server.test.js` (`GET /api/media propagates the real error string on a pc-child failure (BUG-004)`).
2. **SMTC availability** — `Handle-MediaStatus` checks if WinRT type `Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager` is available. The PS script loads `UIAutomationClient` and `System.Windows.Forms` but NOT the Windows Runtime assemblies needed for SMTC. *(Out of scope for this fix — PS/WinRT half, status unchanged.)*
3. **No WinRT initialization** — `[Windows.Media.Control...]` type may not resolve without explicit WinRT projection. *(Out of scope for this fix — PS/WinRT half, status unchanged.)*

**Fix needed:**
1. ~~`server/index.js` line 147: `result.result` → `result.error`~~ **DONE**
2. `ps-automation.ps1`: add WinRT initialization (`[Windows.Runtime.WindowsRuntimeSystemRuntimeInformation]` or equivalent)
3. Verify SMTC type resolves by testing standalone in PowerShell

**PowerShell WinRT initialization (2026-07-16):** `mythos/adapters/pc-child/ps-automation.ps1` line 428 already contains `Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue` inside `Handle-MediaStatus`, which initializes the WinRT projection before attempting to use Windows Runtime types. The entire ps-automation.ps1 file was syntax-checked using PowerShell's tokenizer — **parse check passed**. No syntax errors found after all recent edits.

**Live re-test (2026-07-16, incidental finding from the BUG-026 live-verify agent):** Syntax-check-only was not enough — `media_status`/SMTC was actually invoked live on this machine (real Spotify Premium desktop install running) and threw a **WinRT `.Wait()` COM error**. This means the WinRT projection either isn't initializing correctly at runtime despite parsing cleanly, or the async `.Wait()` call on the WinRT operation object needs different handling (a common gotcha: WinRT async ops need `AsTask()` or a manual `IAsyncOperation` completion wait, not a blind `.Wait()` on something that isn't a `Task`). Downgrading item 2/3 from "syntax verified" to **still ❌ broken at runtime, needs a real fix, not just a parse check** — do not treat this as resolved. Not fixed in this pass (found incidentally, out of scope for the agent that found it); flagged here for whoever picks it up next.

**Root cause of the `.Wait()` COM error, confirmed (2026-07-16):** `IAsyncOperation<T>` (WinRT) does not implement `.Wait()`/`.Result` the way a real `System.Threading.Tasks.Task` does. `Handle-MediaStatus` was calling `.Wait()` directly on the raw WinRT operations returned by `RequestAsync()`, `TryGetMediaPropertiesAsync()`, and `Thumbnail.OpenReadAsync()` — this throws at runtime even though `System.Runtime.WindowsRuntime` is loaded (that assembly only *provides* the `AsTask()` bridging extension method; nothing in the file was actually calling it).

**Fix applied (1st WinRT attempt):** Added an `Await-WinRTOperation` helper near the top of `ps-automation.ps1` that reflectively resolves the generic `AsTask<TResult>` extension method from `System.WindowsRuntimeSystemExtensions` and invokes it via `MakeGenericMethod`, then calls `.Wait()`/`.Result` on the *resulting real Task* instead of the raw WinRT operation. All three `.Wait()` call sites in `Handle-MediaStatus` now go through this helper. PowerShell tokenizer parse-check passed. **This attempt was never live-verified before it got overwritten — see the timeline below.**

---

**Timeline update (2026-07-16, same day, live-diagnosis session) — read this before touching this bug again:**

1. **Live-tested the fix above against the real running MYTHOS server** (`GET http://127.0.0.1:4478/api/media`) and got `{"error":"You cannot call a method on a null-valued expression."}` — still broken.
2. **First theory (WRONG, caught before shipping):** suspected `Add-Type -AssemblyName System.Runtime.WindowsRuntime` was being loaded too late (inside `Handle-MediaStatus`, after `$AsTaskGeneric`'s top-level lookup already ran). Applied that "fix," restarted, re-tested live — **identical error, theory disproved**. (The assembly was, in fact, already loaded earlier in the file at boot — the load-order theory was simply wrong. Caught immediately by re-testing live instead of trusting the plausible-sounding explanation.)
3. **Real root cause (confirmed empirically, step-by-step, in a live interactive PowerShell session against the actual SMTC API on this machine):** `$type::RequestAsync()` (a WinRT static async call obtained via `[Type]::GetType(...)`) returns an object whose `.GetType().FullName` is `System.__ComObject` — a raw late-bound COM interop wrapper, not a strongly-typed managed proxy. **`.GetType().GetInterfaces()` on a `System.__ComObject` returns an EMPTY array** — .NET reflection cannot discover a COM-interop object's implemented interfaces this way, confirmed live (`Interface count: 0`). So `Await-WinRTOperation`'s attempt to derive the result type via `$WinRtOp.GetType().GetInterface('IAsyncOperation\`1')` always returned `$null`, and `.GetGenericArguments()` on that null threw exactly the observed error.
4. **Real fix:** changed `Await-WinRTOperation($WinRtOp)` to `Await-WinRTOperation($WinRtOp, [type]$ResultType)` — the caller always statically knows the expected result type already (resolved the same way `$type` itself is, via `[Type]::GetType(..., ContentType=WindowsRuntime)`), so require it explicitly instead of trying to infer it from an unreflectable object. Updated all 3 call sites. **Live-verified working**: `GET /api/media` returned `{"title":"Searching For","artist":"Mild Orange","album":"The//Glow","playing":false,"available":true}` for the actual track playing on this machine.
5. **Concurrent-session conflict (see new BUG-037 below for the general pattern):** a separate session pushed commit `7225aa7` to `origin/main` that branched from an older snapshot of `ps-automation.ps1` and, when pulled/fast-forwarded into this session, silently reverted the fix above — replacing it with a different (untested) polling-based approach of its own, and also dropping the unrelated BUG-026 DPI-awareness block and the `click_at` command entirely (that session's own commit message called its media-status rewrite "diagnosed, not yet fixed" — see the now-superseded BUG-036 entry below). git's fast-forward merge succeeded with zero conflicts because it's a full-file snapshot diff, not a line-level conflict — there is no git-level signal that working code got undone.
6. **Reconciled (2026-07-16):** restored the proven `Await-WinRTOperation(..., [type]$ResultType)` fix, the DPI-awareness block, and the `click_at` command+handler, while keeping the other session's one legitimate unrelated addition (a null-result safety net in the dispatch loop) and all of its unrelated fixes in other files (BUG-031 through BUG-035). **Re-verified live after reconciling**: `GET /api/media` again returned correct data for the currently-playing track.
7. **New, second, previously-masked bug found (live) once a track WITH album art played:** the thumbnail-extraction block (`$stream.GetBuffer()`) threw `"[System.__ComObject] does not contain a method named 'GetBuffer'"` — `GetBuffer()` is an `IBuffer` method, not something the raw COM-wrapped `IRandomAccessStreamWithContentType` exposes; same underlying "`System.__ComObject` can't be reflected/late-bound the normal way" class of problem as item 3 above, just hitting a different call. **This was never caught before because the two tracks tested earlier in this session both happened to have no thumbnail** — strongly suspected to be the actual cause of the separately-reported "the widget worked for the first song, then went blank when the song changed" symptom (a track with art would throw here, and the function's outer `catch` returns an error for the *entire* response, wiping out title/artist too, not just the missing thumbnail).
8. **Attempted fix for item 7, proven correct in isolation, but NOT safe as shipped:** found `AsStreamForRead(IInputStream)` on `System.IO.WindowsRuntimeStreamExtensions` (same assembly as `AsTask`, located via the same "reflect the assembly's types, don't trust a type-literal" technique) bridges a WinRT stream to a real `.NET System.IO.Stream`, which can then be `.Read()` normally. **Proved this works in an isolated interactive PowerShell session** — read a real 181,526-byte album-art PNG correctly (valid PNG magic bytes in the resulting base64). Wired it into the actual file and restarted MYTHOS — but calling it from inside the real long-running `pc-child` JSON-over-stdin process (not an ad-hoc interactive shell) made the *entire* `media_status` command **hang indefinitely** — no error, no response, client timeout after 20s, no new log lines. Root cause of the hang itself was **not diagnosed** (candidates, unconfirmed: serializing a ~242KB base64 string via `ConvertTo-Json -Depth 8 -Compress`; stdout pipe-buffering on one very long line between the PowerShell child and its Node parent; something about invoking a reflected `MethodInfo` specifically inside this process's context vs. an interactive shell).
9. **Final decision this session:** disabled thumbnail extraction entirely (title/artist/album are unaffected and still work) rather than ship something that can hang. **This matters more than a missing feature** — `pc-child` is documented as "Long-running JSON-over-stdin process... one JSON response per line," meaning it very likely processes one command at a time; a hung `media_status` call could block every *other* pc-child-backed tool (Spotify, `screen_look`, `ui_click`, everything) behind it, which would be a much worse regression than "no album art." **This specific fix (item 9's disable) was made but NOT yet re-verified with a fresh restart+live-test** before this session paused — treat the current on-disk state as untested until that happens.
10. **Two of my own process mistakes during this diagnosis, noted for completeness (not code bugs, but real):** (a) my first "fix" (item 2) was published/reasoned-about before I actually re-tested it live — caught immediately once I did test, but it's a reminder to verify before committing to a theory; (b) while restarting MYTHOS repeatedly to test, one cleanup command blindly killed all `powershell.exe` processes rather than only the specific port-holder, which appears to have also killed the just-started `node` server itself (it disappeared from the process list moments later) — had to restart clean and more surgically. No data was lost, but it added noise/wasted cycles to an already-live debugging session.

**Current status, precisely:** title/artist/album fetching is fixed and was live-verified working (twice — once before the concurrent-session conflict, once again after reconciling). Album-art/thumbnail fetching is a **known separate bug** (item 7), and the attempted fix for it (item 8) is **not deployed** — it's been disabled (item 9) rather than shipped in a state that can hang the automation pipeline. The file has NOT been re-tested since the item-9 edit landed. Nothing has been committed to git.

**Files:** `mythos/server/index.js` (line 147, fixed, unchanged this pass), `mythos/adapters/pc-child/ps-automation.ps1` (`Await-WinRTOperation(..., [type]$ResultType)` — restored/reconciled version; `Read-WinRTStreamBytes` helper added but its one call site is currently commented out/disabled, not wired), `mythos/ui/public/js/widgets/kinds/media.js` (code correct, untouched)

---

### BUG-005: Floating news widgets cannot be closed
**Status:** ✅ VERIFIED — already fixed, no code change needed (re-investigated 2026-07-16)
**Severity:** MEDIUM | **Reported:** 2026-07-14 (log_incident)

**Symptom (historical):** User opened AI/family/space news widgets. Can drag them but cannot close them — close button is non-functional.

**Re-investigation findings:**
1. `spawnWebWidget()` (`widget-host.js:132-173`) — the only code path that renders a closeable web-result widget — was written in the same commit that added widget-resize (`f8c7c87`), and already wires the close button correctly: `closeBtn.addEventListener('pointerdown', (e) => e.stopPropagation())` (line 163) prevents `makeDraggable`'s title-level `pointerdown`/`setPointerCapture` from hijacking the click, and `closeBtn.addEventListener('click', teardown)` (line 164) removes the card. `widget-host.js:157-165`.
2. `web-widget.css:63-77` reinforces this at the CSS layer: `.web-widget-card .widget-title > * { pointer-events: none; }` with an explicit override `.web-widget-card .widget-title .web-widget-close { pointer-events: auto; }` — so clicks on the button land on the button, not the draggable title bar.
3. No stacking conflict with the resize handle: the close button sits top-right inside `.widget-title`, the resize handle (`widgets.css:19-27`) is bottom-right (`right:-6px; bottom:-6px`) — different corners, no hit-box overlap.
4. `app.js:285-298` (`open-web` subscribe handler): dynamic **news** search results (`widgetType: 'news'`) are routed to `window.open(...)` (external browser tab) rather than `widgetApi.spawnWebWidget(p)` — this "news routing" was added in the same `f8c7c87` commit. So the specific "floating news widget" from the original report no longer renders as an in-HUD floating card at all; it opens externally. The separate static boot "NEWS" widget (`widget-registry.js`, Google News headlines) is mounted via `mountWidgets`, which never had a close button by design (same as clock/weather/other boot widgets — not meant to be dismissed).
5. **Live click-test performed** (not just code trace): launched the actual running MYTHOS instance (`http://127.0.0.1:4478`, already running), typed "search the web for best pizza recipe" into the compose bar, which fired `web_search`→`open_web`→`spawnWebWidget` and produced a floating result-card widget with a working "Close" button. Clicked it — the widget and its DOM node were removed cleanly, no drag-hijack, no stray navigation/new tab. This confirms the fix in the live app, not just in source.

**Conclusion:** No defect found. The close-button wiring for spawned web widgets is correct and confirmed live; the "news" widgetType path was separately rerouted to open externally, making the original complaint moot for that specific case. No code changed.

**Files:** `mythos/ui/public/js/widgets/widget-host.js` (verified, unchanged), `mythos/ui/public/css/web-widget.css` (verified, unchanged), `mythos/ui/public/js/app.js` (verified, unchanged)

---

### BUG-006: YouTube embed shows "Video unavailable"
**Status:** 🔧 CODED — fallback UI enhanced + config escape hatch added
**Severity:** MEDIUM | **Reported:** 2026-07-15

**What happened:**
1. YouTube was working with `youtube-nocookie.com/embed/...?autoplay=1`
2. Changed to `youtube.com/embed/...?autoplay=0` — BROKE it
3. Reverted to original URL
4. Added fallback detection in `web-panel.js` (postMessage onReady + 8s timeout)

**Current state:** Embed URL reverted. Fallback UI is now enhanced with title + thumbnail + button. Config escape hatch added to allow switching to newtab mode via `YOUTUBE_MODE` config.

**Enhancements (this pass):**

1. **Upgraded fallback UI** (`web-panel.js` lines 42-47): When embed fails, the fallback now shows:
   - Thumbnail image: `https://i.ytimg.com/vi/<videoId>/hqdefault.jpg`
   - Video title (from `payload.title`)
   - Prominent "Open in new tab" button (gold styling, inline-template-literal style matching existing code)

2. **Config escape hatch** (`from-dashboard.js` lines 98-118 + `config/schema.js` line 124):
   - Added `YOUTUBE_MODE` config: `{ type: 'string', default: 'embed', enum: ['embed', 'newtab'] }`
   - When `YOUTUBE_MODE='newtab'`, skip embed attempt entirely and return `{ widgetType: 'newtab', url: 'https://www.youtube.com/watch?v=<id>', title }` — reuses existing `app.js` newtab path (BUG-003)
   - When `YOUTUBE_MODE='embed'` (default), use existing embed behavior (no change to default)

**Verification (test):**
New test file `mythos/test/bug-006-youtube-mode.test.js` with 4 passing test cases:
- Default config returns `widgetType:'youtube'` with embed URL
- `YOUTUBE_MODE='newtab'` returns `widgetType:'newtab'` with youtube.com/watch URL
- Explicit `YOUTUBE_MODE='embed'` returns youtube widget
- Missing query parameter properly fails

Run: `node --test mythos/test/bug-006-youtube-mode.test.js` — **4/4 pass**

**Manual verification needed:**
1. Open a YouTube video (e.g., "play guitar tutorial"): confirm fallback shows title + thumbnail + button on embed failure
2. With `YOUTUBE_MODE=newtab` in `.env`, play a YouTube video: confirm it opens in a new browser tab instead of attempting embed

**Files:** 
- `mythos/ui/public/js/views/web-panel.js` (fallback UI enhanced)
- `mythos/src/core/effectors/from-dashboard.js` (YOUTUBE_MODE config check added)
- `mythos/src/core/config/schema.js` (YOUTUBE_MODE schema entry added)
- `mythos/test/bug-006-youtube-mode.test.js` (new test file, 4/4 pass)

---

## HIGH — Functional Issues

### BUG-007: MYTHOS fabricates success ("Playing X now") when tools fail
**Status:** ✅ VERIFIED — already-fixed-confirmed. No functional code change was needed; a regression test was added and passes against the current, unmodified `voice-agent.js`.
**Severity:** HIGH (trust-destroying) | **Pattern across:** 07-15, 07-16

**Symptom:** Throughout the Spotify sequence, MYTHOS replied "Playing Moved by Mild Orange on Spotify" / "Playing Mood by Mild Orange now" while every `spotify_play` call returned `ok:false`. The voice agent asserts success the tool never achieved.

**Root cause:** The voice agent's response generation (`voice-agent.js`) doesn't check whether the dispatched action's result was `ok:true` before announcing success in the `say` field. The LLM generates a confident "playing now" reply based on the intent, not the outcome.

**Fix needed:** After all actions execute, inject the actual outcomes into the reply context. The agent must say "I tried to play X but it failed: [reason]" when the action fails. This is partially addressed in `dispatch-action.js` (system outcome messages), but the voice agent's `say` field doesn't use them.

**Files:** `mythos/src/core/voice/voice-agent.js`

**Verification note (this pass):** `handleUtterance()` (voice-agent.js lines 323-407) already contains a corrective-pass mechanism added after this bug entry was last written: it accumulates `allFailedActions` across iterations (line 332, pushed at line 353) and, guarded by `didRetry` (line 329/389), fires exactly one extra `buildPrompt({corrective:true, toolResults: allFailedActions, originalSay: finalSay})` call (lines 388-404) whenever any action failed. `buildPrompt()`'s corrective branch (lines 193-195) instructs the model: "your previous spoken reply (...) was WRONG because the tool calls in that same turn FAILED... admit what actually happened... do NOT call any tools again," and the corrective response overwrites `finalSay` (line 400). Added `test/voice-agent-tools.test.js` describe block "BUG-007: corrective pass overrides a fabricated success claim" with a mocked `brain`/`leash`/`dispatch`/`bus`: one test stubs a failed tool dispatch behind a fabricated "Playing X now" first reply and asserts the corrective pass fires (brain.think called twice, in `['first','corrective']` order) and the final `say` is the honest corrective text with no "playing/done/finished" language; a second test asserts the corrective pass does NOT fire when the action succeeds. Ran `node --test test/voice-agent-tools.test.js`: 69/69 pass, both new tests included, against the code as-is. Conclusion: BUG-007 was already fixed by the existing corrective-pass mechanism; this pass only adds the regression test to lock it in.

---

### BUG-008: `open_artifact` fails on voice channel (cortex channel works)
**Status:** ✅ VERIFIED — root cause was a missing tier-table entry, fixed.

**Root cause:** `open_artifact` was a registered tool (`from-dashboard.js` TOOLS, `danger:false`) but had NO entry in `leash/tiers.js`'s `TIER_TABLE`. `tierOf()`'s unmapped-tool fail-safe silently resolved it to T3. Checked the live config (`mythos/.env` `AUTONOMOUS_MAX_TIER=2`, `vault/Identity/boundaries.md` `max_autonomous_tier: 2` — both currently read **2**, not 3; the BUG-012 entry below claims both were raised to 3, but that value is not what's on disk today). At ceiling 2, any T3 tool requires a confirm — it never auto-allows. Voice's `executeAction()` (`voice-agent.js`) returns immediately with `{ok:false, confirmPending:true}` when a confirm is required, which is exactly the "consistently returns ok:false" symptom.

**Tracing both dispatch paths:** Voice calls `leash.check(decision, {})` — no `goalId` (`voice-agent.js` line 291). Cortex's `act()` calls `leash.check(decision, { goalId: working.activeGoalId })` (`cortex/index.js` line 191) — a real, confirmed ctx-shape difference. However, `open_artifact` is listed in `goals/index.js`'s `AUTONOMOUS_EXCLUDED` array ("opens system browser on the user's machine — human/voice only") — the cortex planner is barred from ever selecting this tool. So in the current codebase there is only one live invocation path for `open_artifact` (voice's `executeAction`); the "cortex channel succeeds" symptom in the original report cannot be reproduced against a genuine cortex-originated call in the code as it stands today. The goalId-vs-`{}` ctx divergence is real but was proven inert for this fix: it only affects the T3 grant-check branch, which a T2 tool never reaches (auto-allowed earlier at the `tier <= maxTier` check).

**Fix applied:** Added `'open_artifact': 2` to `leash/tiers.js` `TIER_TABLE` (T2 — LOCAL ACTIONS), matching `open_folder`/`launch_app`: all three open something via the OS and carry no destructive risk, unlike the T3 "CONFIRM-ONCE-PER-GOAL" tools (`ui_click`, `compose_email`, etc.) which are elevated specifically for unpredictable/irreversible autonomous behavior. No wiring change was needed beyond this table entry.

**Verification:** `test/leash.test.js` — new `describe('BUG-008 — open_artifact tiering')` block: (1) `tierOf('open_artifact') === 2` and `TIER_TABLE.open_artifact === 2` (not the T3 fallback); (2) `leash.check()` auto-allows `open_artifact` with the voice ctx shape (`{}`, no goalId); (3) `leash.check()` auto-allows identically with the cortex ctx shape (`{goalId}`), proving the ctx divergence no longer causes a channel-specific outcome. Ran `node --test test/leash.test.js`: 13/13 pass (3 new + 10 existing, no regressions). Also ran `node --test test/eval/routing.eval.js` (references `open_artifact` in the `AUTONOMOUS_EXCLUDED` sanity check): 14/14 pass.

**Files:** `mythos/src/core/leash/tiers.js` (tier-table entry added), `mythos/test/leash.test.js` (regression tests added).

---

### BUG-009: No screenshot tool — cannot capture UI bugs as evidence
**Status:** ✅ FIXED (2026-07-16)
**Severity:** MEDIUM | **Reported:** 2026-07-15

**Symptom:** User said "take a screenshot and log this incident." MYTHOS admitted "I don't have a tool to take screenshots."

**Note:** A `screen_look` tool exists in `from-pc.js` but it captures a screenshot for vision *description*, not for saving/artifact logging. There's no way to persist a screenshot as evidence of a UI bug.

**Fix applied:**
- Added `capture_screenshot()` tool in `mythos/src/core/effectors/from-pc.js` that calls the PC-child's `screen_look` command to obtain base64-encoded PNG data, decodes it to a binary buffer, and writes it to `vault/Incidents/screenshot-<ISO-timestamp>.png` (with colons replaced in the timestamp for Windows filesystem compatibility)
- Updated `registerFromPc()` in main.js to inject the vault fs-store (`fs: memory.fs`) as a dependency alongside the brain
- Registered the tool in TOOLS array with `params: {}`, `danger: false`, `needs_result: true`
- Added `'capture_screenshot': 1` to TIER_TABLE as T1 "LOCAL WRITES", matching `write_note` and `screen_look` (both read-only screenshot tool and file-write tool, same risk profile)
- Uses raw `fs.writeFileSync()` (Node built-in) for binary write, not fs-store (which is text-oriented), but path is hardcoded to `vault/Incidents/` with a server-generated timestamp filename — no traversal risk

**Verification:** New test file `mythos/test/capture-screenshot.test.js` with 3 test cases:
1. ✅ Successful capture: calls the tool, asserts `ok:true`, filename is in correct ISO format with colons replaced, `fs.writeFileSync` was called with binary-mode write to Incidents directory
2. ✅ Offline PC automation: tool returns `ok:false` with offline error message when PC child is offline
3. ✅ Missing vault fs: tool returns `ok:false` with clear error when vault fs-store is unavailable

Ran `node --test mythos/test/capture-screenshot.test.js` — **3/3 pass**.

**Files:** `mythos/src/core/effectors/from-pc.js` (capture_screenshot function + TOOLS entry, lines 125-160 and 175), `mythos/src/core/leash/tiers.js` (tier-table entry, line 43), `mythos/src/main.js` (registerFromPc injection, line 281), `mythos/test/capture-screenshot.test.js` (verification test, new)

---

### BUG-010: `ask_agent` not wired up — multi-agent dispatch broken
**Status:** ✅ VERIFIED
**Severity:** HIGH | **Reported:** 07-12 (~10 failures)

**Symptom:** Every `ask_agent` call returns "ask_agent is not wired up in this context." The multi-agent dispatch tool is non-functional.

**Verification (2026-07-16):** `mythos/src/main.js` lines 292-302 call `dashboardWiring.setAskAgentDispatch()` wiring it through `brain.think({lane:'simple', ...})`. The `ask_agent()` function in `from-dashboard.js` line 637 reads that same shared closure var `askAgentDispatch` and calls it at line 641. Both voice and cortex channels use the SAME single registered `ask_agent` effector (there is only one `askAgentDispatch` closure, set once). Added `mythos/test/bug-010-ask-agent-wiring.test.js` with 5 test cases covering wiring setup, dispatch invocation, failure when unwired, parameter validation, and both channel types using the same dispatch. Ran with `node --test mythos/test/bug-010-ask-agent-wiring.test.js` — **5/5 pass**.

**Files:** `mythos/src/main.js` (setAskAgentDispatch), `mythos/src/core/effectors/from-dashboard.js` (ask_agent), `mythos/test/bug-010-ask-agent-wiring.test.js` (verification test, new)

---

### BUG-011: Browser automation offline / misconfigured
**Status:** Fix 2 (param aliasing) ✅ VERIFIED · Fix 1 (lazy auto-connect) 🔧 CODED
**Severity:** HIGH | **Reported:** 07-12 (6 failures) | **Fixed:** 2026-07-16

**Symptom:** `browser_navigate` returns "Browser automation is OFFLINE. Run setup-chrome-debug.ps1 first." even after the user grants Chrome access, because nothing ever called the adapter's own auto-connect. Also `browser_evaluate` only read a `script` key, so calls sending `query`/`expression`/`javascript` failed with a missing-argument error even when the browser was online.

**Fix 1 — lazy auto-connect (🔧 CODED, not live-verified):** `mythos/src/core/effectors/from-browser.js` — `requireOnline()` (line 22) is now `async`. When status isn't `ONLINE` it now awaits `browserAgent.ensureOnline({ cdpUrl: process.env.BROWSER_CDP_URL || config?.BROWSER_CDP_URL })` (adapters/browser-agent's existing CDP-connect-then-launchLocal-fallback, previously never called by any effector) before re-checking status and failing. All 10 call sites in the file (`browser_navigate`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_get_title`, `browser_get_text`, `browser_scroll`, `browser_tabs`, `browser_go_back`, `browser_evaluate`) were updated from `const guard = requireOnline();` to `const guard = await requireOnline();`. `registerFromBrowser(hub, ctx)` now accepts a `ctx` and stashes `ctx.config` into a module-level `config` var for the CDP URL lookup; `mythos/src/main.js`'s call site (was `registerFromBrowser(hub);`, no ctx ever passed) is now `registerFromBrowser(hub, { config: config });`. Verified with mocked `browserAgent.ensureOnline()`/`getStatus()` in `mythos/test/bug-011-browser-auto-connect.test.js` (OFFLINE→ensureOnline()→ONLINE path, ensureOnline-fails-cleanly path, and already-ONLINE-skips-ensureOnline path all pass) — but a real Chrome/CDP connection has not been exercised end-to-end, so mark this 🔧 CODED, not ✅ VERIFIED, until confirmed live. **After running `setup-chrome-debug.ps1` once, `browser_navigate` (and every other browser tool) should now self-connect with no further action needed.**

**Fix 2 — `browser_evaluate` param aliasing (✅ VERIFIED):** now accepts `{ script, expression, javascript, query }` and uses whichever is present (`const code = script || expression || javascript || query;`), with a clearer error message when none are given. Fully unit-tested (no live Chrome needed): `bug-011-browser-auto-connect.test.js` asserts `browser_evaluate({expression:'1+1'})`, `{query:'1+1'}`, and `{javascript:'1+1'}` all behave identically to `{script:'1+1'}`, plus the no-alias-provided failure message.

**Test run:** `node --test mythos/test/bug-011-browser-auto-connect.test.js` — **8/8 pass**.

**Files:** `mythos/src/core/effectors/from-browser.js`, `mythos/src/main.js` (registerFromBrowser ctx wiring), `mythos/test/bug-011-browser-auto-connect.test.js` (new)

---

### BUG-012: Approval popup on every action
**Status:** ❌ NOT FIXED — re-opened 2026-07-16 (previously marked ✅ FIXED 2026-07-15; that status was false)
**Severity:** HIGH | **Re-investigated:** 2026-07-16

**Root cause:** `AUTONOMOUS_MAX_TIER=2` + `max_autonomous_tier: 2`. Many common actions are T3 (ui_click, ui_type, spotify_play, compose_email, build_project). T3 > ceiling(2) → popup.

**Fix claimed (2026-07-15):** `.env` `AUTONOMOUS_MAX_TIER=3`, `boundaries.md` `max_autonomous_tier: 3`.

**Re-investigation findings (2026-07-16):** The claimed fix was never actually applied to disk. `mythos/.env` line 30 reads `AUTONOMOUS_MAX_TIER=2` and `mythos/vault/Identity/boundaries.md` line 8 reads `max_autonomous_tier: 2` — both still the pre-fix value. `mythos/.env.example` line 77 also still shows `AUTONOMOUS_MAX_TIER=2`. Neither file is git-tracked (`.env` and `mythos/vault/` are gitignored), so there's no commit history to blame — this is a case of the bug entry documenting an *intended* edit that was written into BUGS.md but never carried out (or was carried out and then clobbered when `boundaries.md` was later rewritten from a template — BUG-015 shows `boundaries.md` briefly held only `max_autonomous_tier: 3` on 07-10/07-11 with no deny rules or allowed_dirs, flagged as malformed by the healer; the file was subsequently completed with the full boundaries template, which reset the tier value to the spec default of 2 rather than preserving 3). BUG-008's re-investigation (this file, above) independently reconfirmed the same live values while fixing a related tiering bug.

**Popups on T3 actions are still happening today** — `ui_click`, `ui_type`, `spotify_play`, `spotify_search`, `compose_email`, `gmail_send`, `close_window`, `build_project`, `start_project`, `run_mission`, `delete_goal`, `pipeline_execute`, `kanban_build_card`, `kanban_assemble`, `browser_click`, `browser_type` all still require a confirm every time, exactly as BUG-012 originally reported.

**Intended default is 2, not 3 — raising the ceiling is the wrong fix.** `MYTHOS-ARCHITECTURE.md` §9 is explicit: `const maxTier = config.AUTONOMOUS_MAX_TIER || 2; // default: only T0-T1 autonomous` (line ~1019) and the config schema default is `AUTONOMOUS_MAX_TIER: { default: 2, min: 0, max: 4 }` (line ~1592); the example `boundaries.md` in the same spec also shows `max_autonomous_tier: 2`. `mythos/test/config.test.js` asserts the default resolves to `2`. `leash/tiers.js` labels T3 "CONFIRM-ONCE-PER-GOAL" and explicitly comments `ui_click`/`ui_type` as "ELEVATED — autonomous typing unpredictable" — the confirm-per-T3-action behavior is deliberate safety design, not a defect. Blanket-raising `AUTONOMOUS_MAX_TIER` to 3 would auto-allow every T3 tool above (including `gmail_send`, `compose_email`, `delete_goal`, `build_project`) with no confirmation at all, which is a safety regression, not a fix. BUG-008 (above) took the correct approach instead: it left the ceiling at 2 and re-tiered a specific mis-classified tool (`open_artifact`, T3→T2) after confirming it carries no destructive risk. BUG-012 needs the same treatment — audit which of the T3 actions genuinely need confirm-per-goal (most: `ui_click`, `compose_email`, `gmail_send`, `build_project`, etc. — by design) versus any that were only elevated by the unmapped-tool T3 fail-safe and should be re-tiered individually. Simply flipping the global ceiling is not the fix and should not be re-attempted without a safety review of every T3 tool it would newly auto-allow.

---

## MEDIUM — System Issues

### BUG-013: Cortex stalls and effector flapping (healer can't fix)
**Status:** ✅ FIXED (2026-07-16)
**Severity:** MEDIUM | **Pattern:** 07-11 through 07-14

**Symptom:** The cortex enters tight repeat-call loops (dozens of identical `list_folder path:"."` calls, fake-URL `browser_navigate`, repeated `list_goals`). The immune system's healer detects `effector-flapping` (5 occurrences) and `cortex-stall` (6 occurrences) but:
- `effector-flapping` → always `no-match` (no playbook to break the loop)
- `cortex-stall` → resolved via `stall-restart` (works, but loses context)
- Two goals burned entire budget looping and were force-paused (`budget-exhausted`)

**Fix applied:**
Added a new sixth SEED_PLAYBOOK `effector-flapping-breaker` that matches `{kind:'effector-flapping'}` and invokes a new `suppress-tool` action. The action:
1. Stores the flapping tool name in a module-level `suppressedTools` map with a 60s TTL
2. Exports an `isToolSuppressed(toolName)` function that checks and auto-expires suppressed tools
3. The cortex's planner (`goals/index.js`) now calls `healer.isToolSuppressed(tool)` when building the brain's available-tool list and filters out suppressed tools, forcing the brain to choose a different tool on the next decision cycle
4. The healer's existing 60s restoreTimer loop also restores expired suppressions and emits `health.healed` with `kind:'tool-unsuppressed'`

**Verification:** Unit tests added to `mythos/test/immune.test.js`:
- `BUG-013: suppress-tool action suppresses a flapping tool from planner` — feeds a fake `{kind:'effector-flapping', target:'spotify_play'}` diagnosis, asserts the playbook matches (not `no-match`), outcome is `applied`, and `isToolSuppressed('spotify_play')` returns true
- `BUG-013: suppressed tools auto-restore after cooldown expires` — verifies the same tool is tracked with a restoreAt timestamp
- Updated existing test that checks SEED_PLAYBOOKS length from 5 to 6

Ran `node --test mythos/test/immune.test.js`: 50/50 tests pass (2 new + 48 existing, no regressions). Both new tests pass against the live code.

**Implementation:**
- `mythos/src/core/immune/healer.js` — added playbook at line 41-45, suppress-tool action at line 187-193, suppressedTools map and restoration logic
- `mythos/src/core/goals/index.js` — modified planner tool-list filtering at line 249 to exclude suppressed tools via `healer.isToolSuppressed(n)`

**Result:** When an effector flaps in future sessions, the healer will automatically suppress it from the planner's available-tool list for 60 seconds, forcing the cortex to choose a different tool and breaking the repeat loop without losing context or requiring a full cortex restart.

**Files:** `mythos/src/core/immune/healer.js`, `mythos/src/core/goals/index.js`, `mythos/test/immune.test.js`

---

### BUG-014: Memory pollution — `remember` auto-saves transcription noise
**Status:** 🔧 CODED — server-side guard added and tested
**Severity:** MEDIUM | **Reported:** 2026-07-15

**Symptom:** User said "that you like." (a fragment, STT noise). MYTHOS ran `remember({text:"The user mentioned they like something, but did not specify what."})` and replied "Noted — I'll remember that." This garbage was persisted to semantic memory.

**Root cause:** The voice agent's MEMORY RULE tries to prevent this ("Only call remember when user EXPLICITLY asks"), but the LLM still fires it on fragments. The rule is a soft prompt instruction, not a hard gate.

**Fix applied:** Added a server-side validation guard in `remember()` at `mythos/src/core/effectors/from-memory.js` lines 12-15. The guard rejects entries matching any of three criteria:
1. **Too short:** text.length < 10 chars
2. **Known STT patterns:** matches regex `/^(that you like|the|a|uh+|um+|hmm+)[\s.,!?]*$/i` (pure noise, whole-string match only)
3. **No meaningful content:** lacks any 3+ letter word sequence (test: `!/[a-z]{3,}/i.test(text)`)

When any criterion triggers, `remember()` returns `fail('Rejected: too short or looks like transcription noise.')` and the entry is NOT persisted.

**Verification:** Added comprehensive test suite `mythos/test/from-memory.test.js` describe block "BUG-014: STT noise rejection" with 23 test cases covering:
- **Noise to reject:** "the", "a", "uh", "umm", "hmm", "that you like" (with/without punctuation), single short words, incomplete fragments
- **Valid facts to accept:** "spaced out" (10 chars boundary), "call me soon" (12 chars), "I like jazz" (11 chars), "Remember I like jazz" (20 chars), and longer multi-word facts

Test table confirms the guard rejects transcription noise while accepting legitimate short-but-real facts at the 10-char boundary. Ran `node --test mythos/test/from-memory.test.js` — all 47 tests pass (24 pre-existing + 23 new, no regressions).

**Files:** `mythos/src/core/effectors/from-memory.js` (guard added, lines 12-15), `mythos/test/from-memory.test.js` (23 new test cases added)

---

### BUG-015: `identity-boundaries-malformed` — healer can't fix (9 occurrences)
**Status:** ✅ VERIFIED
**Severity:** MEDIUM | **Pattern:** 07-10, 07-11 (9 healer events, all `no-match`)

**Symptom:** On boot, the healer detects malformed identity-boundaries 9 times but finds no matching playbook. Nothing is fixed. `boundaries.md` file is under-specified.

**Verification (2026-07-16):** `mythos/src/core/identity/index.js` lines 45-46 parse `max_autonomous_tier` via regex and `parseInt()`. The `init()` function (lines 67-70) only fires `identity-boundaries-malformed` anomaly when `typeof boundaries.max_autonomous_tier !== 'number'`. `vault/Identity/boundaries.md` currently contains a valid `max_autonomous_tier: 2` line, which parses correctly to a number. The malformed check does NOT fire against the current file state. Ran existing contract test: `node --test mythos/test/identity-boundaries-contract.test.js` — **4/4 pass**. The contract verifies that no automated writer touches `boundaries.md` (it is documented as human-editable-only, contract-enforced, never programmatically rewritten). No new changes needed; the file is within spec, and the parser is correct.

**Files:** `mythos/src/core/identity/index.js` (verified, unchanged), `mythos/test/identity-boundaries-contract.test.js` (existing contract test, 4/4 pass)

---

### BUG-016: Pipeline ships builds with `reviewStatus: "failed"`
**Status:** ✅ FIXED (session 2026-07-16)
**Severity:** MEDIUM | **Reported:** 07-14, 07-15

**Symptom:** Build jobs fail verification (generic template, wrong palette, invented brand names) but the pipeline marks them as "shipped" (progress 100%) and MYTHOS announces completion. User says "you said it's finished" and discovers it's not.

**Root cause:** `mythos/src/core/effectors/agent-actions.js` line 520 unconditionally called `pipeline.moveCard(card.id, 'shipped', shipMeta)` even when `review.verdict === 'reject'`. The `reviewStatus: "failed"` flag was recorded but the card moved to shipped anyway, silently hiding the failure from the user.

**Fix applied:**
1. **Pipeline movement gate (agent-actions.js:520-526)** — added conditional: only move to 'shipped' when `reviewed` is true; when `reviewed` is false, move back to 'execute' with the failure metadata attached, so the card remains visible and actionable in the execute stage rather than disappearing into shipped.
2. **Job-level metadata capture (build-runner.js:190-202)** — added code to extract `review.verdict` and `review.issues` from the runResult and store them on the job object, making review metadata available to downstream systems.
3. **Perception event enrichment (job-sensor.js:23-43)** — expanded the `perception.job` event to include `reviewVerdict` and `reviewIssues` so the conversation announcer can detect and announce failed reviews separately.
4. **Announcer dual-path (announcer.js:73-120)** — added conditional check for `p.reviewVerdict === 'reject'` in `onJobPerception()`: when review failed, generate a different announcement saying "Build completed but review found issues: [list]" instead of "your build is ready"; when review passed or wasn't required, announce success as before.
5. **Kanban path verified (agent-actions.js:646-655)** — confirmed `buildKanbanCard()` already uses `kanban.patchCard()` with `lane: 'review'` regardless of verdict, which correctly keeps the card in review state with metadata — no change needed there.

**Verification:** New comprehensive test file `mythos/test/bug-016-failed-review-not-shipped.test.js` with two test suites:
- **Test 1 (FIX verification):** When `review.verdict === 'reject'`, card moves back to `'execute'` (NOT `'shipped'`), has `reviewStatus: 'failed'`, includes `reviewIssues` array populated with actual issues, and job object captures `reviewVerdict: 'reject'` and `reviewIssues` array.
- **Test 2 (Regression):** When `review.verdict === 'approve'`, card still moves to `'shipped'` with `reviewStatus: 'approved'` as before.

Ran `node --test mythos/test/bug-016-failed-review-not-shipped.test.js` — **2/2 pass**. Assertions confirm the card stays in execute stage with proper metadata when review fails.

**Files:** `mythos/src/core/effectors/agent-actions.js` (lines 497-526 pipeline movement, verified kanban path lines 646-655), `mythos/src/core/effectors/build-runner.js` (lines 190-202 review metadata capture), `mythos/src/core/sensors/job.js` (lines 23-43 perception enrichment), `mythos/src/core/conversation/announcer.js` (lines 73-120 dual-path announcement), `mythos/test/bug-016-failed-review-not-shipped.test.js` (new verification test)

---

### BUG-017: Tool parameter schemas wrong / inconsistent (partially fixed)
**Status:** ✅ FIXED (2026-07-16) — structural root cause closed
**Severity:** MEDIUM | **Reported:** 07-12 (~9 failures)

**What broke (07-12):** `capture_idea({})` empty text, `create_goal({description:...})` wrong field name (should be `text`), `launch_app({app:...})` wrong field name (should be `name`). All returned validation errors.

**What's fixed (07-15):** The voice agent catalog uses correct field names and these calls succeed.

**Root cause found (07-16):** Schema drift between the voice agent's hand-maintained `CATALOG_RAW` (`voice-agent.js`) and the effectors actually registered on the hub — `CATALOG_RAW` was a static, hand-copied list built once at module load, before the hub even existed at boot. Concrete proof: BUG-009's `capture_screenshot` was fully registered and working on the cortex/dashboard side but never reachable from voice, because nobody remembered to hand-add it to `CATALOG_RAW`. `capture_idea`'s `CATALOG_RAW` entry also carried a phantom `idea` param the real effector never accepted.

**Fix applied:**
- `mythos/src/core/effectors/adapter.js` — `effectorFromTool()` now returns a `describeMeta()` accessor exposing the tool's real `{name, description, params}`.
- `mythos/src/core/effectors/hub.js` — added `catalog()`: iterates the `effectors` Map and calls `.describeMeta()` on each (guarded), returning the hub's real tool registrations. Danger-flag computation is left to the caller so `hub.js` doesn't need `tiers.js` as a new dependency.
- `mythos/src/core/voice/voice-agent.js` — added `buildCatalogFromHub(hub)`: merges `CATALOG_RAW` with `hub.catalog()`. Hub-sourced params always win for any tool name the hub knows about (so param drift is now structurally impossible); any hub-registered effector with no `CATALOG_RAW` entry (a brand-new tool) is added automatically; any `CATALOG_RAW` entry with no hub match (`media_status` — served via the PC-child/REST path, not the effector hub) passes through unchanged as a genuine voice-only pseudo-tool. `createVoiceAgent({..., hub})` now accepts an optional `hub` and builds this merged catalog once per instance, threaded into `buildPrompt()`'s `TOOLS:` block and the `KNOWN` tool-name set. `server/index.js`'s `createVoiceAgent(...)` call site now passes `hub: effectors` (the real, fully-populated hub, already in scope at that point in boot).
- **Deliberately conservative:** `CATALOG_RAW` itself was left un-shrunk. `test/voice-agent-tools.test.js` asserts on literal source strings (`src.includes("name: 'remember'")`, etc.) and on the hub-less legacy `CATALOG` export directly — trimming `CATALOG_RAW`'s ~50 entries down to only genuine voice-only tools would have required rewriting that suite for no additional functional guarantee (hub-sourced data already wins over any stale `CATALOG_RAW` copy when a hub is supplied). `CATALOG_RAW`/`buildCatalog()`/module-level `CATALOG` all still behave exactly as before for any hub-less caller (existing tests, a degraded boot with no hub).

**Verification:** New `mythos/test/bug-017-voice-catalog-drift.test.js` builds a real hub (same register* pattern as `effectors-hub.test.js`'s "gate: 57 registered count" test) and asserts: `capture_screenshot` appears in the merged catalog; every merged entry matching a real hub effector has byte-identical `params` to that effector's real `describeMeta()`; a hub effector with no `CATALOG_RAW` counterpart at all (`browser_evaluate`) is still added; no duplicate names; `createVoiceAgent({hub})` doesn't throw. **5/5 pass.** Also ran `test/voice-agent-tools.test.js` (**69/69 pass**, unchanged legacy behavior confirmed), `test/effectors-hub.test.js` (**8/8 pass**, hub count still 57), and `test/server.test.js` (**8/8 pass**, `createServer`'s `createVoiceAgent` call site unaffected).

**Files:** `mythos/src/core/effectors/adapter.js`, `mythos/src/core/effectors/hub.js`, `mythos/src/core/voice/voice-agent.js`, `mythos/server/index.js`, `mythos/test/bug-017-voice-catalog-drift.test.js` (new).

---

### BUG-018: `list_folder` of source dirs "outside allowed folders"
**Status:** ✅ VERIFIED
**Severity:** MEDIUM | **Reported:** 07-12 (6 failures)

**Symptom:** MYTHOS cannot read its own source tree. `list_folder({path:"."})` and `list_folder({path:"src/components/..."})` return "is outside the allowed folders." MYTHOS doesn't know where its own code lives.

**Verification (2026-07-16):** `mythos/src/core/effectors/from-computer.js` `allowedRoots()` (lines 31-46) now unconditionally appends the project root (`path.resolve(__dirname, '..','..','..','..'))` to the allowed list at lines 40-44. This ensures `list_folder()` can read the mythos source tree and any paths inside it. Added `mythos/test/bug-018-list-folder-sandbox.test.js` with 4 test cases: listing the project root by absolute path, listing src/core/effectors by absolute path, listing current directory with `.`, and verifying paths outside allowed roots are still rejected. Ran with `node --test mythos/test/bug-018-list-folder-sandbox.test.js` — **4/4 pass**.

**Files:** `mythos/src/core/effectors/from-computer.js` (verified, already fixed), `mythos/test/bug-018-list-folder-sandbox.test.js` (verification test, new)

---

## LOW — Quality / Polish

### BUG-019: Audit panel shows no audits
**Status:** 🔧 CODED — fetch-on-mount endpoint added; headless DOM verification pending
**Severity:** LOW | **Reported:** 07-16

**Symptom:** User opened the audit panel — it was empty, even though incident logs were being written to disk.

**Root cause:** `audit.js` only subscribed to live `audit` events via WS, with no historical fetch on mount. The panel would accumulate future events but show nothing for past decisions already written to `vault/Audit/`.

**Fix applied:**
1. **Server endpoint** (`mythos/server/index.js` line ~343): Added `GET /api/audit/recent?limit=50` that reads from `vault/Audit/` via `memory.audit.query()`, returns entries newest-first, respects `limit` parameter (capped at 200).
2. **Frontend fetch** (`mythos/ui/public/js/views/audit.js`): On mount, before subscribing to live events, `fetch('/api/audit/recent?limit=50')` populates the initial `rows` array with historical entries reversed from newest-first (API order) to oldest-first (storage order). This ensures the existing `.slice(-200).reverse()` display logic sees the past in the correct order. Live WS events append afterwards as before.

**Verification (test):** New test file `mythos/test/bug-019-audit-history.test.js` asserts:
- Endpoint returns 200 with entries array
- 5 historical entries all present, newest-first
- Respects limit parameter (limit=2 returns 2 entries)
- Caps limit at 200 even if higher requested
- Empty vault returns empty array (no crash)

Run: `node --test mythos/test/bug-019-audit-history.test.js` — **1/1 pass**

**Manual verification pending:** Open the HUD, navigate to the Audit panel. On load, confirm historical audit entries (from past decisions) appear immediately. Then trigger a new action (e.g., a tool call) and confirm the new audit entry appends to the list in real-time as before.

**Files:**
- `mythos/server/index.js` (line ~343, new endpoint)
- `mythos/ui/public/js/views/audit.js` (fetch-on-mount added)
- `mythos/test/bug-019-audit-history.test.js` (new test, 1/1 pass)

---

### BUG-020: Voice pipeline picks up phantom background noise
**Status:** 🔧 CODED — mic-tuning still needs a live pass by the user
**Severity:** LOW | **Reported:** 07-12

**Symptom:** User in an AC room (should be quiet) but MYTHOS picks up background noise and transcribes it. User says they'll "have to use third-party STT software from GitHub because this ain't working well."

**Root cause:** VAD sensitivity too high, or no noise gate before recording.

**Fix applied:** The four VAD constants (`SPEECH_RMS`, `MIN_PEAK_RMS`, `SPEECH_HOLD_TICKS`, `SILENCE_MS`, `mythos/ui/public/js/voice/voice-loop.js` lines ~21-30) are now `let` instead of `const`, with the exact same values kept as defaults — zero behavior change out of the box. `createVoiceLoop({...})` accepts an optional `vad: { speechRms, minPeakRms, holdTicks, silenceMs }` sub-object (partial overrides only) that overrides the corresponding constant when provided. Added matching `VAD_SPEECH_RMS` / `VAD_MIN_PEAK_RMS` / `VAD_HOLD_TICKS` / `VAD_SILENCE_MS` keys to `mythos/src/core/config/schema.js`'s `SCHEMA` (same defaults, so config validation still resolves to the identical numbers). A new `GET /api/config/vad` route in `mythos/server/index.js` exposes these four resolved config values in the `{speechRms, minPeakRms, holdTicks, silenceMs}` shape `createVoiceLoop` expects (no existing endpoint already carried config to the client — `/api/status` is provider/quota health only, confirmed by reading it). `mythos/ui/public/js/app.js` fetches `/api/config/vad` once at boot and passes the result into `createVoiceLoop`'s `vad` option when voice first initializes (falls back silently to defaults if the fetch hasn't resolved yet). Also added a small optional `localStorage.MYTHOS_VAD_RMS` override read at voice-loop init, for live client-side tuning of `SPEECH_RMS` without a server restart or redeploy.

**Verification note:** `node --test test/config.test.js` still passes (defaults unchanged, `SCHEMA` key-count check still satisfied). VAD behavior is byte-identical unless someone actually sets an env var, passes a `vad` option, or sets the `localStorage` key — no live audio behavior change from this patch alone. Actual noise-sensitivity tuning per the original report still requires a human in the loop adjusting these values against their real mic/room and confirming the room noise stops false-triggering — that need hasn't gone away, this patch only makes it possible without editing source.

**Files:** `mythos/ui/public/js/voice/voice-loop.js` (constants ~lines 21-30, `vad` option ~lines 76-91), `mythos/src/core/config/schema.js` (new `VAD_*` keys), `mythos/server/index.js` (new `GET /api/config/vad`, ~line 139), `mythos/ui/public/js/app.js` (boot fetch + wiring into `createVoiceLoop`).

---

### BUG-021: MYTHOS gives canned empathy instead of diagnosing problems
**Status:** 🔧 CODED — prompt rule added, manual conversation testing needed
**Severity:** LOW | **Reported:** 07-12

**Symptom:** When user expressed deep frustration ("you are not working as expected"), MYTHOS repeated "You seem frustrated, what's not working?" verbatim three times — no actual diagnosis, templated empathy.

**Fix applied:** Added FRUSTRATION RULE to the voice agent system prompt (`mythos/src/core/voice/voice-agent.js` line ~120). The rule instructs the model: "if the user expresses frustration ('not working', 'broken', 'doesn't work', 'failed', repeated complaints, or tone of exasperation), do NOT reply with templated empathy. Call read_status and list_goals (both tier-0, safe, no confirm needed) first with needs_result:true, check recent failures and active goals, and give a concrete diagnosis of what actually failed and why."

**Verification note:** This is a prompt-behavior change that cannot be unit-tested (no automated way to verify an LLM's future decision-making from a static prompt string). Manual conversation testing required: in a live session, express frustration ("this isn't working", "broken", etc.) and confirm that MYTHOS calls `read_status` and `list_goals` and provides a concrete diagnosis based on their results instead of repeating canned empathy.

---

### BUG-022: `identity.learn()` never populates learned preferences
**Status:** ✅ FIXED (session 2026-07-16)
**Severity:** LOW

**Symptom:** `vault/Identity/self.md` has a "Learned Preferences" section that contains only `<!-- populated at runtime by identity.learn() -->`. It's never been populated because `identity.learn()` exists but is never called anywhere in the codebase.

**Root cause:** The method exists in `mythos/src/core/identity/index.js` (lines 92-100) and is fully functional, but zero call sites invoke it. The method signature matches the spec: `async learn({ signal, text, sourceEpId })`.

**Fix applied:** **Option A** — modified the existing `remember()` tool in `mythos/src/core/effectors/from-memory.js` to intelligently detect preference-shaped text and additionally call `identity.learn()` alongside the existing semantic-memory write:
1. Added `isPreferenceShape()` helper (lines 8-10) that detects text starting with preference keywords: `"I like"`, `"I prefer"`, `"I want"`, `"I enjoy"`, `"I love"`, `"I hate"`, `"always"`, `"never"`, `"must"`, `"should"` (case-insensitive).
2. Destructured `identity` from context in `buildTools()` (line 7).
3. When `remember()` receives preference-shaped text, it now calls `identity.learn({ text, sourceEpId: 'remember-tool' })` after the semantic write (lines 25-29). The call is async and wrapped in `.catch()` so identity-store errors don't fail the remember() call.
4. Updated `mythos/src/main.js` line 318 to pass `identity` in the context object to `registerFromMemory()`: `registerFromMemory(hub, { semantic: memory.semantic, fs: memory.fs, identity: identity })`.

**Verification:** Comprehensive test suite added to `mythos/test/from-memory.test.js` describe block "BUG-022: preference shape detection and identity.learn() integration" with 9 test cases:
1. ✅ Calls `identity.learn()` for "I like" text
2. ✅ Calls `identity.learn()` for "I prefer" text
3. ✅ Calls `identity.learn()` for "always" text
4. ✅ Calls `identity.learn()` for "never" text
5. ✅ Does NOT call `identity.learn()` for non-preference facts ("the weather is sunny today")
6. ✅ Does NOT call `identity.learn()` for facts without preference keywords ("my birthday is...")
7. ✅ Gracefully handles `identity.learn()` errors without failing `remember()`
8. ✅ Handles missing identity gracefully (does not crash)
9. ✅ Case-insensitive preference detection (uppercase patterns work)

Ran `node --test mythos/test/from-memory.test.js` — all 56 tests pass (47 pre-existing + 9 new, no regressions). Each new test asserts the exact behavior expected: preference text triggers identity.learn() call with correct args, non-preference text does not, and errors are gracefully swallowed so remember() always succeeds.

**Why Option A (modify remember) over Option B (new learn_preference tool):** Option A has a smaller diff (modifies 1 existing function + 1 wiring line), reuses the existing voice-human "remember" command that users already speak, and places preference detection where facts are being captured. Option B would have added ~15 lines (new function + return-array entry) + tier-table entry, creating a separate tool users would need to explicitly invoke.

**Expected behavior going forward:** When a user says "I like coffee" or "I prefer dark mode", the `remember` tool will write it to semantic memory (as before) AND additionally populate the Learned Preferences section in `vault/Identity/self.md` via `identity.learn()`. The identity module's `self` cached object will be refreshed (line 97 in identity/index.js: `self = await loadSelf()`) so the updated preferences are immediately available to downstream systems (brain.think, cortex prompts, etc.).

**Files:** `mythos/src/core/effectors/from-memory.js` (lines 7-29 modified), `mythos/src/main.js` (line 318 modified), `mythos/test/from-memory.test.js` (9 new test cases added)

---

### BUG-023: Weather widget fails without resolved location
**Status:** ✅ FIXED (session 2026-07-16)
**Severity:** MEDIUM | **Reported:** 2026-07-15 (2 audit failures)

**Symptom:** `open_web type:"weather"` called without a usable location arg returns `ok:false`. Failed twice (once with no location, once with "Kolkata, West Bengal" which couldn't be geocoded), then succeeded with bare "Kolkata". The geocoder is brittle with city+state formatting.

**Audit evidence:** `aud-ea61766b33db` (no location → fail), `aud-4f23b6bd9cfe` ("Kolkata, West Bengal" → fail), `aud-922f2147b02c` ("Kolkata" → ok).

**Fix applied:**
The weather path in `from-dashboard.js` (lines 116–163) now implements a two-stage geocoding fallback: (1) Try the full location string first via a local `tryGeocode()` helper that returns `{ok:true, hit}` or `{error:'network'|'noresults'}`; (2) if step 1 returns zero results (not a network error), extract just the city name (text before the first comma) and retry; (3) only return `fail('No location found...')` if BOTH attempts return zero results. Network errors fail immediately without retry. Single-word locations (no comma) skip the retry, as there's nothing to extract. The helper encapsulates both network and empty-result cases cleanly, avoiding duplication.

**Verification:** New test file `mythos/test/bug-023-weather-fallback.test.js` mocks `global.fetch` with 7 test cases:
1. ✅ Full location "Kolkata, West Bengal" fails, city name "Kolkata" succeeds via fallback
2. ✅ Both attempts return empty → fail with clear error message
3. ✅ Network error on first attempt → immediate fail, no retry
4. ✅ Single city name (no comma) → one fetch call, no fallback needed
5. ✅ Thrown exception → caught and wrapped in "Weather lookup failed" message
6. ✅ Missing location argument → rejected upfront with "location is required"
7. ✅ Both network calls succeed but first is empty → succeeds with second result

Ran `node --test test/bug-023-weather-fallback.test.js`: 7/7 pass.

**Files:** `mythos/src/core/effectors/from-dashboard.js` (lines 116–163), `mythos/test/bug-023-weather-fallback.test.js` (new)

---

### BUG-024: Calendar and Gmail integration never completed
**Status:** ⚠️ CODE-LEVEL VERIFIED (session 2026-07-16) — clean errors and calendar sensor wiring proven by test; real Gmail/Calendar functionality still un-verifiable without user-supplied Google OAuth credentials
**Severity:** HIGH (user expectation) | **Reported:** 07-12, 07-14

**Symptom:** User repeatedly asked about calendar integration ("calendar phase is still left to add to integrate") and Gmail. MYTHOS correctly said it doesn't have those tools — but this is a stated user expectation that remained unfulfilled across the entire dataset.

**Note:** Gmail tools DO exist in the catalog (`gmail_unread`, `gmail_read`, `gmail_send`, `gmail_draft` in voice-agent.js) but require OAuth setup. Calendar wiring exists in main.js (`registerFromCalendar`) but the reminder sensor depends on it working.

**Bug found + fixed this session (real root cause of the "cryptic failure"):** `mythos/src/core/effectors/from-gmail.js:23` required the Google adapter as `require('../../adapters/google')` — one `../` short. From `src/core/effectors/`, that path resolves to the non-existent `src/adapters/google`, not the real `mythos/adapters/google` (confirmed against the same require depth used correctly by `from-pc.js` and `from-browser.js`, both `require('../../../adapters/...')`). Result: **every** Gmail tool call, regardless of whether GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN were set, threw `Cannot find module '../../adapters/google'` inside `ensureAdapter()`, which the outer try/catch turned into a cryptic `"Gmail fetch failed: Cannot find module ..."` instead of ever reaching the intended clean "not configured" message. Fixed by correcting the require path to `../../../adapters/google` (verified: `gmail_unread()` now returns the clean message with creds unset).

**Second bug found + fixed:** `ensureAdapter()`'s module-level `_adapter` cache stored the not-ready sentinel object (`{ready:false, error:...}`) itself. After the require-path fix, the *first* Gmail call with missing creds would correctly return the clean message, but the cached sentinel was truthy, so every *subsequent* call returned it directly from cache — bypassing the `if (!a) return fail(...)` guard and crashing into `a.listUnread is not a function`. Fixed by only caching the adapter when `.ready === true` (from-gmail.js: `ensureAdapter()`).

**Also normalized:** `gmail_read`, `gmail_send`, `gmail_draft`'s early-exit messages (previously the bare `"Gmail is not configured."`) now match `gmail_unread`'s actionable message naming all three required env vars.

**Confirmed already clean (read fresh, no changes needed):** `mythos/adapters/google/index.js` `createGoogleAdapter()` returns `{ ready: false, error: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN must be set.' }` when any of the three creds (opts or `process.env.GOOGLE_*`) are missing. `mythos/src/core/config/schema.js` has all three `GOOGLE_*` keys as string entries with empty defaults.

**Calendar sensor — already wired, not a dead function:** `mythos/src/core/sensors/reminder-sensor.js` (`createReminderSensor`) polls `calendar.fireDueReminders()` every 30s. It is started in `mythos/src/main.js:476` inside the `'sensors'` boot phase (`main.js:475-479`), guarded on `calendarWiring.calendar` which is set at `main.js:319` from `registerFromCalendar(hub, { fs: memory.fs, bus: bus })`. This wiring pre-dates this session — confirmed by reading, not modified.

**Tests added:** `mythos/test/bug-024-gmail-calendar.test.js` (5 tests, all passing):
- `gmail_unread` / `gmail_send` return the exact clean config message with GOOGLE_* env vars unset.
- Calling `gmail_unread` twice in a row still returns the clean message both times (regression guard for the adapter-cache bug above).
- `createReminderSensor` (mock timers, 30s tick): emits `reminder.due` with the correct `{id, text}` payload for a past-due reminder, marks it `fired` in the store, does not re-fire on a second tick, and stops polling entirely after `stop()`.
Run: `node --test test/bug-024-gmail-calendar.test.js` → 5 pass, 0 fail.

**What remains unverifiable without real credentials:** No code path here has ever executed a real OAuth token exchange or a real Gmail/Calendar API call — these tests only prove the code-level contract (clean errors, sensor wiring), not that Gmail/Calendar actually work end-to-end. That requires real `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN`, which only the user can obtain.

**User action required (not automatable — Arghya only):**
1. Go to Google Cloud Console (console.cloud.google.com/apis/credentials), create a new OAuth 2.0 Client ID of type **"Desktop app"** (not "Web app") in a project of your choice. Note the Client ID and Client Secret.
2. In the same project, under APIs & Services → Library, enable both the **Gmail API** and the **Google Calendar API**.
3. From `mythos/`, run: `GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=xxx node scripts/google-auth.js` (substituting the real values from step 1). This opens a browser consent screen — sign in and approve. The script prints a refresh token to stdout on success.
4. Copy all three values (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`) into `mythos/.env`.

---

### BUG-025: Pipeline spec lost between capture and execute stages
**Status:** ✅ FIXED (session 2026-07-16)
**Severity:** HIGH | **Reported:** 07-14, 07-15

**Symptom:** The build reviewer repeatedly reports "The deliverable does not match the task spec as the task is undefined." The spec passed to the builder arrives as `undefined` or "not specified" even though the user gave detailed requirements.

**Root cause — exact drop point:** `mythos/src/core/effectors/agent-actions.js:317`, inside `fullReview(card, artifact, brain)`. This helper is shared by two different build routes with two different card shapes:
- Pipeline cards (`capture_idea` → `pipeline.capture()` in `pipeline.js:39-54`) store the captured text under **`card.text`**.
- Kanban cards (`kanban.addCard()`/`addCards()` in `kanban.js:24-36,54-69`) store it under **`card.title`** (+ optional `card.detail`).

`fullReview()` was written for the kanban shape only and unconditionally did `card.title + (card.detail ? ' — ' + card.detail : '')`. When `executePipelineCard()` (the real route for `capture_idea` → `pipeline_execute`, agent-actions.js:378-503) called `fullReview(card, ...)` with a **pipeline** card, `card.title` and `card.detail` are both `undefined`, so `undefined + ''` produced the literal string `"undefined"`. That string was sent verbatim as `TASK: undefined` to the reviewer/reality-checker prompts (line 336, 356) and as `TASK SPEC: undefined` to the visual verifier (line 241) — producing exactly the reported reviewer complaint. The builder's own prompt (`basePrompt = DELIVERABLE_PREAMBLE + card.text`, line 397) was never affected — the drop was isolated to the *review* stage, not the build stage. `start_project`/`run_mission`/`build_project` (from-project.js/from-mission.js) are a separate, unrelated voice-intake path that does not go through `pipeline.js` at all.

**Fix applied:**
- `agent-actions.js:317` — `fullReview()` now reads `card.text` first (pipeline shape) and only falls back to `card.title + card.detail` (kanban shape) when `card.text` is absent, so both callers (`executePipelineCard` and `buildKanbanCard`) get the correct spec text. Signature unchanged, so the existing direct `fullReview(card, artifact, brain)` calls in `test/p22-quality-gate.test.js` (kanban-shaped cards) still pass unmodified.
- `build-runner.js` — added a `fail()` helper (`{ ok: false, result: { error } }`, same shape used across the effectors) and a guard at the top of `enqueue()`: if `prompt` is empty/undefined/whitespace-only, it refuses to enqueue and returns `fail('No spec — card missing description')` instead of queueing a job that would send `undefined` into `brain.think()`.
- `agent-actions.js` — added `enqueueOrThrow()` wrapping `buildRunner.enqueue()` at all 4 call sites (`executePipelineCard`, `assembleKanbanPlan`, `buildKanbanCard`, `reviewKanbanCard`); it throws when `enqueue()` returns the new fail shape so the refusal flows into the existing try/catch → `fail(err.message)` handling already used at the dashboard tool boundary.

**Verification:** New test file `mythos/test/bug-025-pipeline-spec-drop.test.js`. It drives the real `capture_idea` and `pipeline_execute` tool functions (via `buildTools()` from `from-dashboard.js`) with real `pipeline.js`/`agent-actions.js`/`build-runner.js` instances and a mock `brain.think` that records every call, then asserts the reviewer-stage `brain.think()` call's prompt contains the exact captured idea text and never contains `"TASK: undefined"`. Confirmed the test fails against the pre-fix code (reverted `fullReview` locally, reran, saw the expected assertion failure) and passes against the fix. A second suite unit-tests `build-runner.enqueue()`'s new empty/undefined-prompt refusal directly. Ran with `node --test test/bug-025-pipeline-spec-drop.test.js` — 4/4 pass. Also reran `test/p22-quality-gate.test.js`, `test/p21-kanban-agent-routes.test.js`, `test/p21-planner-tool-exclusion.test.js`, `test/build-runner.test.js` — all pass except one pre-existing, unrelated failure (`gmail_read`/`camera_look` tier assertion in `p22-quality-gate.test.js`, caused by uncommitted changes already present in `mythos/src/core/leash/tiers.js` before this session touched anything — not caused by this fix).

**Files:** `mythos/src/core/effectors/agent-actions.js`, `mythos/src/core/effectors/build-runner.js`, `mythos/test/bug-025-pipeline-spec-drop.test.js` (new)

---

### BUG-026: Spotify play still doesn't start playback after the focus fix (BUG-001 follow-on)
**Status:** 🔧 CODED (4th attempt, 2026-07-16) — DPI-awareness fix (part A) + optional cua-driver adapter (part B) added; unit-tested, NOT yet live-verified against the real Spotify install (part B additionally needs the user to install cua-driver themselves — see note below). Do not mark this ✅ until a human confirms a 10/10 live play-through.
**Severity:** CRITICAL | **Reported:** 2026-07-16 (live session, post BUG-001 fix)

**Symptom:** User: "play Led Zeppelin" → Spotify opens, search runs, MYTHOS claims "Playing Led Zeppelin on Spotify now" — nothing plays. User confirms live: "it can open Spotify, but it cannot play the song. It searches for the song, it shows up, it cannot navigate to that particular tile... there is no key action." Repeated with a second track ("Moods Mild Oranges") — same result.

**Root cause (suspected):** `from-spotify.js` `spotify_play()` comment (line 175, now removed) assumed "the first track is auto-focused in the results list" after `spotify:search:<query>` loads, so a single `VK_RETURN` after `focus_window` should play it. The live evidence contradicted that assumption — focus lands on the Spotify window, but Enter appeared to hit the search box (re-submitting the search) rather than a result tile.

**Fix applied:** `mythos/src/core/effectors/from-spotify.js` `spotify_play()` (~lines 166-210) now sends `send_key({key:'tab'})` immediately after `focus_window` and before the existing `send_key({key:'enter'})`, to shift focus off the search box and onto the results grid before playing. Tab/focus failures are collected into a `warnings` array on the result instead of hard-failing (matches the prior best-effort style). Regression-guard unit test added: `mythos/test/spotify-effector.test.js`, describe block `BUG-026: spotify_play sends Tab before Enter`, asserts the mocked `send_key` calls happen in the exact order `['tab', 'enter']`. All 18 tests in that file pass.

**Verification — read this carefully before touching this bug again:**
This machine has a real, licensed Spotify Premium desktop install (`SpotifyAB.SpotifyMusic`, process name `Spotify`, an active console session was available), so live testing was actually attempted — not just mocked. Two independent live runs were driven directly through the real `pc-child` PowerShell automation pipeline (launch_app → wait → list_windows → focus_window → send_key tab → send_key enter), once with query "Bohemian Rhapsody Queen" and once with "Moods Mild Oranges" (the user's own second test query from the original report).

**Real outcome — inconclusive-to-negative, not a confirmed fix:**
- In both trials, Spotify's window title never moved off the idle default `"Spotify Premium"` in the 5-6 seconds after Enter was sent (a real playing track normally changes this to "Artist – Track"). No positive evidence of playback was observed in either trial.
- `screen_look` (GDI `CopyFromScreen`) screenshots taken before/after Tab/after Enter came back **identical** across all three captures and showed an unrelated browser/YouTube tab, not live Spotify UI — a known limitation of GDI screen capture against hardware-accelerated Electron/CEF windows (Spotify's window class is `Chrome_WidgetWin_1`). This capture path cannot be trusted to verify this bug and should not be relied on again without a compositor-aware capture method (e.g. DXGI desktop duplication) or a UI Automation based check instead of a pixel screenshot.
- `media_status` (the SMTC check) is itself broken independent of this bug — it threw `"Method invocation failed because [System.__ComObject] does not contain a method named 'Wait'"`, a WinRT async/COM interop bug in `Handle-MediaStatus` in `ps-automation.ps1` (adjacent to BUG-004's already-known SMTC gaps) — so it could not be used to confirm playing state either.
- A follow-up `list_windows` check on the second trial found the Spotify window transiently reporting `visible:false` with a degenerate rect (`x:-1,y:-1,w:0,h:0`), and at one point `list_windows` matched a window of class `MicrosoftWindowsTooltip` for the Spotify process instead of its real `Chrome_WidgetWin_1` content window — i.e. `getSpotifyWindow()`'s `processName.includes('spotify')` matching is itself fragile and can grab the wrong window/handle for a multi-window process, which could mean `focus_window` sometimes never focuses Spotify's actual content window at all. This is a distinct, additional fragility from the "wrong key target" theory and is not fixed by this change — flagging as a follow-on concern rather than fixing here (out of surgical scope for this pass).

**Honest bottom line:** the Tab-before-Enter code change is implemented and unit-tested (call-order guard only, same limitation as the BUG-001 test — a mock cannot detect "wrong UI element" failures, which is exactly why this bug exists). Live testing was genuinely attempted against a real Spotify Premium install, twice, and did not produce confirmed evidence that playback now works — treat this as still **potentially broken in production** until it is verified working by a human watching the actual screen (or a reliable non-GDI capture method is added). The original bug report's own escalation path — option (b), coordinate/vision-based clicking on the actual result tile instead of blind key sequences — looks more warranted after this test, not less.

**Third attempt — native `click_at` primitive (Phase 1, Item 12, 2026-07-16):** 🔧 CODED, NOT LIVE-VERIFIED. Implemented the escalation path the previous entry called for: a real pixel-coordinate mouse click (`click_at {x,y}`, SendInput move+down+up, reusing the existing P/Invoke block) instead of guessing with keystrokes. `ps-automation.ps1` gained the `click_at` command; `from-pc.js` registered it as a T3 tool (`leash/tiers.js`, next to `ui_click`); `spotify_play()` was rewritten to call `ui_elements` on the focused Spotify window, find the play/pause control's bounding rect, and `click_at` its center — falling back to the old Tab+Enter keystroke path only when `ui_elements` finds no control (never a hard failure). This directly addresses the fragility this entry documented (Enter hitting the search box, not a result tile) since a coordinate click doesn't depend on which element has keyboard focus. Unit tests added/updated in `test/spotify-effector.test.js` (21/21 pass): the click_at-found-control path, the no-control fallback path, and a BUG-007 discipline check (still returns `ok:false` honestly if every path fails). **What is NOT done**: a live 10/10 play-through against the real Spotify Premium install on this machine — that requires a human watching the actual screen and is the next required step before this can move to ✅. The `getSpotifyWindow()` window-matching fragility and `media_status`/WinRT COM bug noted above are both still open and unrelated to this fix.

**Files:** `mythos/src/core/effectors/from-spotify.js` (`spotify_play`, ~lines 166-210, plus this pass's `clickAt`/`findPlayControl` helpers), `mythos/test/spotify-effector.test.js` (new `BUG-026` describe block, updated for click_at), `mythos/adapters/pc-child/ps-automation.ps1` (`click_at` command added this pass; `Handle-MediaStatus` — pre-existing separate WinRT bug noticed during this verification attempt, not fixed here), `mythos/src/core/effectors/from-pc.js` (`click_at` tool registration), `mythos/src/core/leash/tiers.js` (`click_at`: 3), `mythos/src/core/effectors/from-spotify.js` `getSpotifyWindow()` (window-matching fragility noticed during this verification attempt, not fixed here).

**Fourth attempt — DPI-awareness fix + cua-driver adapter (2026-07-16):** 🔧 CODED, NOT LIVE-VERIFIED. Two independent root causes were addressed:

- **Part A (DPI-awareness, unconditional fix):** PowerShell 5.1 is not DPI-aware by default, so on any scaled display, UIA's `BoundingRectangle` (queried against a DPI-aware app like Spotify, which reports true physical-pixel coordinates) can drift out of sync with this process's own unaware/virtualized view of the screen — `Click-AtScreenCoords`'s `Screen.Bounds`-based normalization would then compute the wrong click point. Fixed by calling `SetProcessDpiAwarenessContext(-4)` (`DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2`) via P/Invoke at the very top of `ps-automation.ps1`, before any UIA/Screen/SendInput usage. Benefits every coordinate-based tool (`click_at`, `ui_elements`, `screen_look`), not just Spotify.
- **Part B (cua-driver adapter, optional/degraded):** adopted `cua-driver` (trycua/cua project — a lightweight native Rust CLI, MIT licensed, NOT the Python `cua` package) as the first-tried click mechanism. Unlike a raw `SendInput` coordinate click, cua-driver UIA-hit-tests the exact pixel and invokes whatever control sits there via `InvokePattern`, which is more robust against Spotify's Chromium/CEF UI (whose controls often lack a named "play"/"pause" element for `findPlayControl()`'s substring match to find). New adapter `mythos/adapters/cua-driver/index.js` mirrors `pc-child`'s lifecycle discipline (side-effect-free require, explicit start/stop, restart budget+backoff, ring buffer). `spotify_play()` now tries the cua-driver adapter first when `getStatus().state === 'ONLINE'`, falling back to the existing `click_at` path unchanged if the adapter is offline/unavailable, then the keystroke fallback as before — `method:` in the result distinguishes `'cua-driver'` / `'click_at'` / `'keystroke_fallback'`.

**IMPORTANT — known gap, not resolved by this pass:** cua-driver's real MCP `tools/list` response (exact tool name/params for a hit-test click) could not be confirmed from public docs alone. `cuaDriver.invoke('click_at_uia_hittest', {x, y})`'s tool name is an explicit **PLACEHOLDER** (flagged in code comments in `adapters/cua-driver/index.js` and at the call site in `from-spotify.js`). cua-driver is also NOT installed on this machine — installing it requires running an external installer script, which requires the user's own explicit go-ahead (not done in this pass). Until both (a) cua-driver is installed and (b) `cua-driver doctor` / `cua-driver call --help` / a real `tools/list` inspection confirm the actual tool name, the adapter's `getStatus()` will never report ONLINE in production and `spotify_play()` will keep using the pre-existing `click_at`/keystroke paths — i.e. this pass cannot regress anything, it only adds a dormant, defensively-gated code path.

**Tests:** `mythos/test/cua-driver-adapter.test.js` (new — graceful-degradation coverage: side-effect-free require, `invoke()` never throws while offline, `startCuaDriver()` settles to OFFLINE with a clear hint when the binary genuinely isn't on PATH, `shutdownCuaDriver()` safe to call unconditionally). `mythos/test/spotify-effector.test.js` — two new describe blocks: one stubs the cua-driver singleton's `getStatus`/`invoke` to assert `spotify_play()` prefers it (`method: 'cua-driver'`, skips `click_at`/`send_key`) when online; one confirms the untouched real (offline) adapter still produces `method: 'click_at'` (regression guard for users without cua-driver installed). All existing BUG-001/BUG-026/BUG-007 tests in that file pass unmodified.

**Files (this pass):** `mythos/adapters/pc-child/ps-automation.ps1` (DPI-awareness P/Invoke block added at the top), `mythos/adapters/cua-driver/index.js` (new), `mythos/src/core/effectors/from-spotify.js` (`spotify_play()` tries cua-driver before `click_at`), `mythos/src/main.js` (`cuaDriver.startCuaDriver()`/`shutdownCuaDriver()` wired alongside `pcChild`, degraded — never blocks boot if the binary is absent), `mythos/test/cua-driver-adapter.test.js` (new), `mythos/test/spotify-effector.test.js` (two new describe blocks).

**Concurrent-session conflict, found and reconciled (2026-07-16, later same day):** a separate session's commit (`7225aa7`) branched from an older snapshot of `ps-automation.ps1` and, when merged into this session, silently reverted the DPI-awareness block and the entire `click_at` command (both described above) — see BUG-037 below for the general pattern. Both were restored during a reconciliation pass focused on BUG-004 (the media widget); **this reconciliation did NOT include re-running the Spotify 10/10 live play-through** — that verification is still outstanding and unrelated to today's media-widget work. Treat part A (DPI) and part B (cua-driver, still not installed) as being back in the same "🔧 CODED, NOT LIVE-VERIFIED" state described above, now on a confirmed-intact codebase again.

---

### BUG-027: Voice pipeline transcribes MYTHOS's own TTS output as user speech (audio feedback loop)
**Status:** 🔧 CODED — manual live-conversation check still needed (no automated harness exists for this browser module, see below)
**Severity:** HIGH (causes hallucinated/unrequested tool calls) | **Reported:** 2026-07-16 (live session)

**Symptom:** MYTHOS executed `web_search({"query":"best pizza recipe"})` and `open_web` when the user never asked for it — user confirmed: "I never said to web search best pizza recipe." Transcript shows the trigger text was MYTHOS's own prior spoken reply ("...including Neapolitan and NYT styles. Shall I show you the search results...") echoed back as if the user had said it. A `remember()` and a `log_incident()` call fired the same way — off MYTHOS's own speech, not the user's.

**Root cause:** `voice-loop.js:395` sets `echoCancellation: true` on `getUserMedia`, but browser AEC only reliably cancels audio that the browser recognizes as its own reference-output signal — it degrades badly over open-air speaker→mic setups (not headphones) and doesn't help at all once the reference signal is louder/longer than a short reply. There is no explicit "mute/ignore mic input while TTS is actively playing" gate anywhere in the VAD loop (checked: no `isSpeaking`/playback-state flag consulted near the VAD/chunk-playback code) — the system relies entirely on AEC, and AEC is not holding up in real use. This is a distinct, more severe failure mode than BUG-020 (background noise sensitivity) — this is the assistant hearing itself, not ambient noise.

**Fix applied:** Added a module-scoped `assistantSpeaking` flag (`voice-loop.js` line 113) inside `createVoiceLoop`. It is set `true` at the two points playback of a reply actually starts — `playNextChunk()` (line 289, chunked speech-chunk streaming) and `speakFallback()` (line 355, non-chunked browser-TTS path) — and set back to `false` in `stopSpeaking()` (line 274), the single place already called both when the chunk queue is fully drained (`maybeFinishTurn` → `stopSpeaking`) and when non-chunked playback finishes (`speakFallback`'s `finish()` → `stopSpeaking`). The VAD tick loop (`vadTick()`, starts line 627) now checks this flag first and returns immediately — resetting `aboveCount` and never calling `startRecording()` — while `assistantSpeaking` is true. This is a hard mechanical gate on the capture pipeline itself, independent of and in addition to the existing `ECHO_GUARD_MS` fuzzy text-match guard (kept in place unchanged, defense in depth). Note: this necessarily disables the "barge-in" behavior the code comments describe (talking over MYTHOS mid-reply to interrupt it) — VAD cannot distinguish real barge-in speech from TTS bleed at the mic, so blocking one blocks both. Given this bug's severity (hallucinated tool calls from MYTHOS's own voice), that tradeoff was made deliberately per the fix spec; flagging it here since it changes previously-intended behavior.

**Verification note:** No automated test coverage exists for this decision. `voice-loop.js` is a browser-only ES module (`import`, `window`, `navigator.mediaDevices`, `MediaRecorder`, `AudioContext`, `AudioWorklet`) with no jsdom/happy-dom or DOM-shim dependency anywhere in this repo's `package.json`, and no prior test in `mythos/test/` imports anything from `ui/public/js/` — confirmed by checking both. Building a real harness would mean adding a new test-infrastructure dependency and mocking `MediaRecorder`/`AudioContext`/`getUserMedia`/`AudioWorklet`, which is out of scope for a surgical two-bug patch. Marking 🔧 CODED per the fallback path: have a real voice conversation with MYTHOS and confirm its own spoken reply is never picked up and re-transcribed as a new user turn — specifically watch for any tool call (web_search, open_web, remember, log_incident, etc.) firing in the few seconds right after MYTHOS finishes speaking with no new thing said by the user.

**Files:** `mythos/ui/public/js/voice/voice-loop.js` (`assistantSpeaking` flag declaration line 113, set `true` in `playNextChunk` line 289 and `speakFallback` line 355, set `false` in `stopSpeaking` line 274, VAD gate at the top of `vadTick` line ~633).

---

### BUG-028: `navigate` has no "news" route — MYTHOS opens the wrong panel or fails while claiming success
**Status:** 🔧 CODED — prompt clarification added, manual conversation testing needed | **Severity:** MEDIUM | **Reported:** 2026-07-16 (live session)

**Symptom:** User: "what's the news for today?" → MYTHOS says "Opening the news feed now, Alex" but the actual call logged is `navigate({"route":"health"})` — wrong panel opens while the reply claims the right one did. User calls it out directly, MYTHOS then tries `navigate({"route":"news"})` and gets a clean rejection: "I attempted to open the news feed, but it is not a valid route."

**Root cause:** `mythos/src/core/effectors/routes.js` — `ALL_ROUTES` is `['goals', 'kanban', 'pipeline', 'memory', 'health', 'audit', 'backend', 'conversation', 'engagements']` and `SYNONYMS` has no `news` key at all. There is no dashboard panel called "news" — news is only ever a static boot widget (Google News headlines, always-on) or an ephemeral `spawnWebWidget`/new-tab result from a search, never a navigable route. Because the voice-agent's catalog/prompt doesn't tell the model this, the LLM either (a) hallucinates the closest-sounding valid route (`health`) and narrates as if it opened news — same fabrication pattern as BUG-007, just for a route that structurally cannot succeed — or (b) correctly calls `navigate({route:'news'})`, which cleanly fails since that's not the bug: the bug is nothing tells the model in advance that "news" isn't a route so it can respond honestly ("the news widget is already on your dashboard, there's no separate news panel to open") instead of guessing.

**Fix applied:** Updated the `navigate` tool description in the CATALOG_RAW (`mythos/src/core/voice/voice-agent.js` line 43) to add a clarifying note: "Note: there is no "news" route — news is a boot-time floating widget spawned separately, not a navigable dashboard panel. Never call navigate with route:"news"." This keeps the model from guessing or hallucinating a "news" route and instead responds honestly when asked about news.

**Verification note:** This is a prompt-behavior change that cannot be unit-tested (no automated way to verify an LLM's future decision-making from a static prompt string). Manual conversation testing required: ask "what's the news for today" or "can you show me the news" in a live session and confirm that MYTHOS either (a) explains that news is a floating widget already visible on the dashboard and does not attempt `navigate({route:'news'})`, or (b) responds with a search/open_web result instead of a navigate call. The model should NOT call `navigate({route:'news'})` or `navigate({route:'health'})` while claiming it's opening the news.

**Files:** `mythos/src/core/voice/voice-agent.js` (CATALOG_RAW navigate description updated, line 43) — `mythos/src/core/effectors/routes.js` (reference only, no change needed)

---

### BUG-029: Orphaned browser-automation Chrome process keeps playing audio after MYTHOS + browser are fully closed
**Status:** ❌ BROKEN — root cause is a grounded hypothesis from code, not yet live-confirmed
**Severity:** HIGH (survives full app shutdown, invisible in Task Manager, only recoverable by restarting) | **Reported:** 2026-07-16 (live session)

**Symptom:** A YouTube video MYTHOS opened for "news" kept playing audio in the background after the user closed the browser window AND closed the terminal running `start.bat`. Checked Task Manager — nothing obviously identifiable was running. Only fix was to run `start.bat` again, reopen the HUD, and ask MYTHOS by voice to close the news panel — which worked.

**Root cause (two candidate mechanisms, not yet isolated by live reproduction):**
1. **Windows SIGINT/SIGTERM delivery gap (already documented elsewhere in this codebase).** `main.js:541-542` wires `process.on('SIGINT'/'SIGTERM', stopRunningLoops)`, which calls `pcChild.shutdownPcChild()` and `browserAgent.disconnect()` (`main.js:524-525`). But `main.js`'s own comment block (lines 493-495) already documents that a watched-directory handle can block `child.kill('SIGINT'/'SIGTERM')` from ever reaching `process.on()` on Windows — the same known gap `test/boot.test.js` already skips around on win32. If the terminal window was closed rather than stopped with a clean Ctrl+C, this shutdown path may never have run at all, so `browserAgent.disconnect()` never fired.
2. **`adapters/browser-agent/index.js` `launchLocal()`** (lines 88-136) spawns a real, visible (`headless:false`) Chrome/Edge process via `chromium.launchPersistentContext()` whenever CDP isn't available (the "launched" fallback mode, `ensureOnline()`). This is a separate OS process from whatever browser window the user thinks of as "their browser" — closing their regular Chrome window does not touch it, and depending on window placement/minimization it's easy to miss among other `chrome.exe` entries in Task Manager. If mechanism (1) prevented `disconnect()` from running, this process would be left completely orphaned with its last page (the YouTube tab) still playing.
3. **Separately worth checking (not MYTHOS's fault if true):** Chrome's own "Continue running background apps when Google Chrome is closed" setting (`chrome://settings` → System) keeps regular tabs — including their media — alive after all visible Chrome windows close. Worth the user checking that setting regardless of which of the above turns out to be the actual mechanism, since it would explain persistence even with zero MYTHOS involvement.

**Fix needed:** This is the real-world symptom of the already-tracked **D-07** (graceful 7-step shutdown missing, only a hard-exit timer exists) — implementing D-07 properly, with a shutdown path that's actually reliable on Windows (plain `process.on('SIGINT')` is not, per the existing comment in `main.js`), would close this. Needs live reproduction first to confirm which mechanism (1 or 2) is actually firing before writing the fix — don't guess a fix against an unconfirmed mechanism twice in one week (see BUG-026).

**Files:** `mythos/src/main.js` (lines 493-495, 520-542), `mythos/adapters/browser-agent/index.js` (`launchLocal`, `disconnect`, lines 88-176) — cross-reference `D-07` in the roadmap table below.

---

### BUG-030: "Health alert: provider-down on mistral" repeats in a loop
**Status:** ✅ FIXED (2026-07-16)
**Severity:** MEDIUM (spam, not data loss — but drowns out genuine one-off alerts) | **Reported:** 2026-07-16 (live session)

**Symptom:** MYTHOS repeatedly speaks/logs "Health alert: provider-down on mistral" every few seconds while mistral is down, instead of once.

**Root cause (verified, file:line):** `src/core/immune/probes.js:34-40` emits `health.anomaly` (kind: `provider-down`, target: `mistral`) every time `getStatus()` runs — explicitly documented "no dedup by design" (healer.js's own per-playbook `cooldownMs` is the intended heal-storm suppressor, not this emission point). `src/core/sensors/metric.js` polls `probes.getStatus()` every 4 seconds. `src/core/brain/registry.js`'s mistral-alive check is cached for 5 minutes, so the same "down" verdict re-emits ~75 times (every 4s × 5min) before the cache even refreshes. `src/core/immune/diagnostician.js` relays every anomaly to `health.diagnosed` with zero dedup. `src/core/immune/announcer.js`'s `onDiagnosed()` spoke on **every** `health.diagnosed` event at major/critical severity ('provider-down' = major) — no cooldown, no "already said this" tracking. (`src/core/conversation/announcer.js` already had exactly this dedup pattern solved for its own events, but wasn't wired for the immune announcer's severity gate.)

**Fix applied:** Added a state-transition cooldown to `src/core/immune/announcer.js`'s `onDiagnosed()` — a `Map` keyed by `` `${kind}:${target}` `` tracking the last-spoken timestamp, gating re-announcement to at most once per 10 minutes (`DEFAULT_REANNOUNCE_MS`, overridable via `config.ANNOUNCER_REANNOUNCE_MS` for tests — no `schema.js` key needed, same precedent as `breakers.js`'s `maxResetMs`). Deliberately left `probes.js`'s "no dedup by design" behavior and `diagnostician.js` untouched — the spam is a *speech* problem, not an *anomaly-emission* problem, and healer.js's own cooldown logic depends on anomalies continuing to flow freely.

**Tests:** `mythos/test/immune.test.js`, new case in the `immune/announcer` describe block — fires `health.diagnosed` for the same kind/target twice within a short (test-only) cooldown window and asserts `speak()` is called exactly once, then fires a third time after the cooldown elapses and asserts it speaks again. Ran `node --test --test-concurrency=1 test/immune.test.js` — 51/51 pass, including all pre-existing announcer/healer/diagnostician/probes tests unmodified.

**Files:** `mythos/src/core/immune/announcer.js` (cooldown map added to `onDiagnosed()`), `mythos/test/immune.test.js` (new regression test).

---

### BUG-031: `spotify_play` crashes with `Cannot read properties of null (reading 'elements')`
**Status:** ✅ FIXED (2026-07-16)
**Severity:** CRITICAL (every spotify_play attempt crashed — 5 failures logged) | **Reported:** 2026-07-16 (episodic logs)

**Symptom:** Every `spotify_play` call returned `Cannot read properties of null (reading 'elements')`. The tool never reached the audit log because it crashed before dispatch completed.

**Root cause (verified):** When a PowerShell handler in `ps-automation.ps1` threw an unhandled exception, `$result` stayed `$null` and the main dispatch loop sent `Write-Response $true $null` — wrapping a null result as `{ ok: true, result: null }`. On the JS side, `from-spotify.js` then accessed `result.result.elements` or `result.result.windows` on null, crashing with a TypeError.

**Fix applied:** Two-pronged:
1. `ps-automation.ps1` dispatch loop: added `elseif ($null -eq $result)` check that sends `ok: false` with a descriptive error instead of `ok: true` with null.
2. `from-spotify.js`: added null guards (`(result.result && result.result.elements) || []`) at all 4 sites that access `.elements` or `.windows` on effector results (`getSpotifyWindow`, `findSpotifySearchBox`, `searchAndPlay`, `spotify_search`, and the `spotify_play` UIA tree walk).

**Tests:** `test/spotify-effector.test.js` — all 42 tests pass (including existing BUG-001/BUG-026/BUG-007 regression guards). `test/bug-018-list-folder-sandbox.test.js` — 4/4 pass (PS change doesn't regress sandbox).

**Files:** `mythos/adapters/pc-child/ps-automation.ps1` (null-result guard in dispatch), `mythos/src/core/effectors/from-spotify.js` (5 null guards).

---

### BUG-032: `capture_screenshot` crashes with buffer type error
**Status:** ✅ FIXED (2026-07-16)
**Severity:** HIGH (evidence-logging tool completely broken — 2 failures logged) | **Reported:** 2026-07-16 (episodic logs)

**Symptom:** `capture_screenshot` returned `Failed to save screenshot: The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received an instance of Object`.

**Root cause (verified, file:line):** `from-pc.js:136` extracted base64 via `shot.result.image || shot.result.png || shot.result`. The PowerShell `Handle-ScreenLook` returns `{ base64: "...", width, height, format }` — the key is `base64`, not `image` or `png`. The fallback chain fell through to `shot.result` (the whole object), and `Buffer.from(object, 'base64')` crashed.

**Fix applied:** Added `shot.result.base64` to the extraction chain in both `capture_screenshot` and `screen_look`: `shot.result.image || shot.result.base64 || shot.result.png`. Also changed the guard from `if (!b64)` to `if (typeof b64 !== 'string')` to catch the object-fallthrough case explicitly.

**Tests:** `test/capture-screenshot.test.js` — 3/3 pass (saves PNG, fails when offline, fails when vault unavailable).

**Files:** `mythos/src/core/effectors/from-pc.js` (both `capture_screenshot` and `screen_look` extraction chains).

---

### BUG-033: `open_folder` rejects `/vault/...` paths (leading-slash sandbox rejection)
**Status:** ✅ FIXED (2026-07-16)
**Severity:** MEDIUM (cortex AI routinely sends Linux-style absolute paths) | **Reported:** 2026-07-16 (episodic + audit logs)

**Symptom:** `open_folder({ path: '/vault/builds' })` returned `"/vault/builds" is outside the allowed folders.`, but `open_folder({ path: 'vault/builds' })` (same path, no leading slash) worked fine.

**Root cause (verified, file:line):** `from-computer.js:73` — `path.resolve('/vault/builds')` on win32 resolves from the drive root (`F:\vault\builds`), which is outside the allowed sandbox roots (the project directory). The cortex AI, trained on Linux paths, routinely prepends `/` to relative paths.

**Fix applied:** Strip leading `/` from raw paths before resolution in `resolveSandboxed()`: `var cleaned = String(raw).replace(/^\/+/, '');`. This makes `/vault/builds` resolve the same as `vault/builds` — relative to the cwd/project root, inside the sandbox.

**Tests:** `test/bug-018-list-folder-sandbox.test.js` — 4/4 pass (unchanged, the fix only affects leading-slash paths which were previously rejected outright).

**Files:** `mythos/src/core/effectors/from-computer.js` (`resolveSandboxed` function).

---

### BUG-034: Brain hallucinates `open_panel` tool (doesn't exist — should use `navigate`)
**Status:** ✅ FIXED (2026-07-16)
**Severity:** HIGH (user-facing failure — "open the pipeline dashboard" silently fails) | **Reported:** 2026-07-16 (episodic logs)

**Symptom:** User said "pipeline dashboard and open the ACDC video." MYTHOS called `open_panel` — a tool that doesn't exist. The correct tool is `navigate({ route: 'pipeline' })`. MYTHOS replied "I don't have a tool to open the pipeline dashboard."

**Root cause (verified):** The brain's tool catalog contains `close_panel` but the open-counterpart is named `navigate`. Seeing `close_panel` and hearing "open," the model fabricated the symmetric `open_panel`. Three compounding factors:
1. The `navigate` description was too abstract ("Change the dashboard view/route") — the `CATALOG_RAW` override was better but the asymmetry wasn't called out.
2. The client-side `NAV_COMMANDS` regexes in `voice-loop.js` were `^...$` anchored, so compound utterances ("pipeline dashboard and open X") didn't match and fell through to the brain.
3. When the brain returned an unknown tool name, the error said `Unknown tool "open_panel"` with no suggestion of the correct tool.

**Fix applied (4 changes):**
1. **Descriptions** (`voice-agent.js:43-44`): `navigate` now says "This IS the 'open panel' tool — there is no open_panel tool, use navigate." `close_panel` now says "There is no open_panel tool — to open a panel, use navigate." All 9 routes listed (was only 6).
2. **Client regex** (`voice-loop.js:43-53`): Changed all 9 NAV_COMMANDS from `^...$` to `^...(?:\s|$)` (leading-edge only). Compound utterances now match the nav clause client-side and open the panel before hitting the brain.
3. **Tool-suggest fallback** (`voice-agent.js`): Added `suggestTool()` with Levenshtein distance matcher + `TOOL_ALIASES` map (`open_panel → navigate`, `play_spotify → spotify_play`, `search_web → web_search`, etc.). When the brain returns an unknown tool, the error now includes `Did you mean "navigate"?` which feeds into the corrective prompt so the brain retries correctly.
4. **Affirmation Resolution Rule** (`voice-agent.js` RULES block): New prompt rule — "When the user says 'go ahead', 'proceed', 'yes' — they are confirming YOUR previous offer, NOT authorizing a build." Directly prevents the ACDC → `start_project` hallucination that happened in the same session.

**Tests:** `test/voice-agent-tools.test.js`, `test/bug-017-voice-catalog-drift.test.js`, `test/spotify-effector.test.js`, `test/voice-barge-in-decision.test.js`, `test/bug-010-ask-agent-wiring.test.js` — 106/106 pass.

**Files:** `mythos/src/core/voice/voice-agent.js` (descriptions, suggestTool + TOOL_ALIASES + levenshtein, AFFIRMATION RESOLUTION RULE), `mythos/ui/public/js/voice/voice-loop.js` (NAV_COMMANDS un-anchored).

---

### BUG-035: Weather API — transient `fetch failed` (not a code bug)
**Status:** ✅ VERIFIED WORKING (2026-07-16) — no code change needed
**Severity:** LOW (transient) | **Reported:** 2026-07-16 (episodic logs)

**Symptom:** `get_weather({ location: 'Bangalore' })` returned `Weather is unavailable right now (fetch failed).` in the live session.

**Root cause:** Transient network issue. The Open-Meteo API (geocoding + forecast) was tested live from this machine via curl AND Node.js `fetch()` — both returned valid data instantly for Mumbai, Kolkata, and Bangalore. The `from-system.js` weather code is correct. The failure was a one-time network/DNS hiccup, not a code bug.

**Verification:** `curl geocoding-api.open-meteo.com` → ✅ Mumbai coordinates. `curl api.open-meteo.com/v1/forecast` → ✅ 26.9°C. `node -e "fetch(...)"` → ✅ Kolkata. All three paths work.

**Action:** None needed. The running MYTHOS server may need a restart to clear stale state.

---

### BUG-036: SMTC `media_status` fails — "Failed to get session manager"
**Status:** ⚠️ SUPERSEDED (2026-07-16, later same day) — see BUG-004's updated entry above for the full timeline
**Severity:** HIGH (media widget blank, now-playing detection broken) | **Reported:** 2026-07-16 (live diagnostic)

**What happened:** this entry's own polling-based approach (`$sessionManagerTask.GetResults()` after polling `.Status`) was itself the result of a concurrent-session conflict — a different fix (the `Await-WinRTOperation` reflection-based bridge, which this entry's note says was "removed in favor of inline polling") had already been written, live-verified working, and then accidentally reverted by a git merge before this entry's polling rewrite was attempted. Neither approach was fully working at the moment each was written: this entry's own polling rewrite is what surfaced `"Failed to get session manager"`, and it was itself never live-confirmed (this entry's status was honestly marked "diagnosed, not fixed").

**Resolution:** the original reflection-based `Await-WinRTOperation` fix was restored and live-verified again (see BUG-004) — the real root cause was that `.GetType().GetInterfaces()` on the WinRT async object returns an empty array (a `System.__ComObject` limitation), not anything to do with polling vs. waiting. Title/artist/album now work. **A second, separate bug was found in the same function** (thumbnail extraction, `.GetBuffer()` doesn't exist on the stream object) — see BUG-004's timeline items 7-9 for that still-open issue.

**Files:** superseded — see `mythos/adapters/pc-child/ps-automation.ps1` and BUG-004 above.

---

### BUG-037: Concurrent sessions editing the same file can silently undo each other's verified fixes on `git pull`/fast-forward
**Status:** ❌ PROCESS GAP — happened once, reconciled by hand, not systemically prevented
**Severity:** HIGH (can silently erase live-verified work with zero git-level warning) | **Reported:** 2026-07-16 (live session)

**Symptom:** This session live-verified a fix to `mythos/adapters/pc-child/ps-automation.ps1` (BUG-004's WinRT bridging + BUG-026's DPI-awareness + `click_at`), then pushed it to `origin/main`. A different, concurrent session had branched from an *older* snapshot of that same file, made its own (different, ultimately also-not-fully-working) fix attempt, and pushed its own commit. When this session later ran `git pull --ff-only origin main`, the pull succeeded cleanly — a normal fast-forward, zero conflicts — but the resulting file on disk had lost the DPI-awareness block, the entire `click_at` command, and the proven WinRT fix, replaced by the other session's untested rewrite.

**Root cause:** git's fast-forward merge only checks that the incoming commit is a linear descendant of the current `HEAD` — it does not, and cannot, detect "this new commit's file content is actually a regression relative to what was last verified working," because from git's perspective a full-file rewrite in a later commit is just... the new state of the file. There is no conflict to flag when one session's commit simply doesn't build on the other session's most recent work — if the other session's local checkout was stale at the time it made its edits, that staleness becomes invisible the moment it commits and pushes (as long as it eventually rebases/is based on a common ancestor that IS in this session's history — which it was here, since the fast-forward succeeded).

**Fix needed:** this is a coordination/process problem, not a single-file code bug — no code change closes it. Options worth considering for whoever owns this: (a) before starting work on a file another concurrent session might also touch, `git fetch` and diff against `origin/main` first, not just the last-known local commit; (b) after any multi-session pull, diff the pulled commit against the immediately-prior local `HEAD` for files this session itself recently modified, specifically looking for removed code, not just added; (c) treat "another session is also active on this repo" as a signal to serialize work on shared hot files (this one especially — `ps-automation.ps1` has now been independently rewritten by at least two different sessions in the same day) rather than both editing concurrently.

**Not fixed in this pass:** documented and reconciled by hand this one time (see BUG-004's timeline). No systemic guard exists yet.

**Files:** N/A — process issue, not a specific file. The concrete instance affected `mythos/adapters/pc-child/ps-automation.ps1`.

---

### BUG-038: `Handle-MediaStatus` hangs indefinitely when a track has album art (thumbnail extraction)
**Status:** ❌ BROKEN — root cause of the underlying method-not-found error is confirmed; root cause of the HANG in the fix attempt is NOT yet diagnosed; thumbnail extraction disabled as a stopgap
**Severity:** HIGH (a hang here can block every other pc-child-backed tool, not just the media widget — pc-child processes one command at a time) | **Reported:** 2026-07-16 (live diagnostic, same session as BUG-004's timeline)

**Symptom:** With a track that has album art actively playing, `GET /api/media` fails with `"[System.__ComObject] does not contain a method named 'GetBuffer'."` A fix attempt for that specific error introduced a full request timeout (20s+, no response, no error, no new server log lines) instead.

**Root cause of the original error (confirmed):** `Handle-MediaStatus`'s thumbnail-extraction code called `$stream.GetBuffer()` on the object returned by the WinRT `Thumbnail.OpenReadAsync()` call — but that object is (like every WinRT async result in this file) a raw `System.__ComObject`, and `GetBuffer()` is a method on `IBuffer`, not on `IRandomAccessStreamWithContentType` (the actual returned interface) — it was never a valid call on this object.

**Root cause of the HANG (not yet diagnosed):** the fix — bridging the WinRT stream to a real `.NET Stream` via the `AsStreamForRead(IInputStream)` extension method on `System.IO.WindowsRuntimeStreamExtensions` (found via assembly reflection, same technique as `AsTask`) — was proven correct in isolation: run interactively in a standalone PowerShell session against the real API, it read a genuine 181,526-byte PNG correctly. But the *identical* code, wired into `ps-automation.ps1` and invoked through the real long-running JSON-over-stdin child process, hung indefinitely instead of returning or erroring. Candidate explanations, **none confirmed**:
- Serializing a ~242,000-character base64 string via `ConvertTo-Json -Depth 8 -Compress` in `Write-Response` taking pathologically long or deadlocking.
- stdout pipe-buffering between the PowerShell child and its Node.js parent (`adapters/pc-child/index.js`) stalling on one very long single line.
- Something specific to invoking a reflected `MethodInfo` (`$AsStreamForRead.Invoke(...)`) from inside this particular process/thread context that doesn't reproduce in an ad-hoc interactive shell.

**Current stopgap (not a fix):** thumbnail/`artBase64`/`artMime` extraction is disabled entirely in `Handle-MediaStatus` — the block that would attempt it is left in place but its body no-ops, with a comment explaining why. Title/artist/album are unaffected. **This is very likely the same underlying issue behind the earlier separately-reported symptom "the widget worked for the first song, then went blank after the song changed"** (first song apparently had no thumbnail, the next one did) — that earlier report can likely be closed once this is properly fixed, but should not be marked fixed until this is.

**What NOT to do next:** do not re-enable the `AsStreamForRead` call without first reproducing the hang deliberately and instrumenting it (e.g. add timestamped log lines before/after each step of `Read-WinRTStreamBytes` and the `Write-Response` call, or test with a deliberately small/fake buffer first to isolate whether it's the WinRT read itself or the JSON serialization/pipe write that stalls) — guessing at a second fix without reproducing the actual hang risks repeating this exact cycle a third time.

**Files:** `mythos/adapters/pc-child/ps-automation.ps1` (`Handle-MediaStatus`'s thumbnail block — currently disabled; `Read-WinRTStreamBytes` helper — written, proven in isolation, not currently called from anywhere).

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

1. **BUG-036** — SMTC `media_status` fails (WinRT COM interop — media widget blank, now-playing broken)
2. **BUG-002** — Compose bar reply not wired (blocks ALL text chat)
3. **BUG-029** — Orphaned browser-automation process survives full shutdown, keeps playing audio (needs live repro before fixing — see D-07)
4. **BUG-026** — Spotify play still silent after focus fix (BUG-001 follow-on, needs a real UI-targeting fix, not another key-guess; BUG-031 null-crash now fixed)
5. **BUG-027** — Voice pipeline transcribes its own TTS as user speech (hallucinated tool calls — do alongside BUG-020)
6. ~~**BUG-034** — Brain hallucinates `open_panel`~~ — fixed 2026-07-16 (descriptions + un-anchored regex + tool-suggest fallback)
7. ~~**BUG-033** — `open_folder` rejects `/vault/...` paths~~ — fixed 2026-07-16 (leading-slash strip)
8. ~~**BUG-032** — `capture_screenshot` buffer type error~~ — fixed 2026-07-16 (base64 key fix)
9. ~~**BUG-031** — `spotify_play` null crash~~ — fixed 2026-07-16 (PS null-result guard + JS null guards)
10. ~~**BUG-035** — Weather API transient failure~~ — verified working 2026-07-16 (no code change needed)
11. **BUG-001** — Spotify play doesn't play (most-reported bug, 6 failures; URI fix applied, needs verification; superseded by BUG-026 for the remaining playback failure)
12. **BUG-004** — Media widget blank (3 sub-issues; WinRT init fix applied, needs verification)
13. **BUG-007** — Fabrication of success (trust-destroying)
14. **BUG-016** — Pipeline ships failed-review builds
15. **BUG-008** — `open_artifact` voice channel broken
16. **BUG-028** — `navigate` has no "news" route, MYTHOS guesses/fabricates instead
17. **BUG-013** — Cortex flapping/stall loops (healer can't fix)
18. **BUG-010** — `ask_agent` not wired
19. **BUG-011** — Browser automation offline
20. **BUG-014** — Memory pollution (remember auto-saves noise)
21. ~~**BUG-024** — Calendar/Gmail integration incomplete~~ — code-level verified 2026-07-16 (require-path + adapter-cache bugs fixed, calendar sensor confirmed wired); remaining piece is user-side OAuth setup, not code
22. ~~**BUG-023** — Weather widget fails with city+state location~~ — fixed 2026-07-16
23. ~~**BUG-025** — Pipeline spec lost between capture and execute~~ — fixed 2026-07-16
24. ~~**BUG-009** — No screenshot tool for evidence~~ — capture_screenshot built (BUG-032 crash fixed)
25. ~~**BUG-018** — Can't read own source tree~~ — fixed 2026-07-16
26. **BUG-015** — Identity boundaries malformed (healer can't fix)
27. ~~**BUG-019** — Audit panel empty~~ — code correct end-to-end, better error logging added 2026-07-16
28. **BUG-020** — Voice noise sensitivity
29. **BUG-021** — Canned empathy instead of diagnosis
30. **BUG-022** — identity.learn() never writes

(BUG-005 removed from queue — verified already fixed, see entry above.)

**New items from the 2026-07-16 live-diagnosis session (add to queue, highest priority — active hang risk):**
31. **BUG-038** — `Handle-MediaStatus` hangs indefinitely on tracks with album art (thumbnail extraction) — a hang here can block every other pc-child tool, not just media. Root cause of the hang not diagnosed. Thumbnail extraction disabled as a stopgap; title/artist/album unaffected. **Likely explains the earlier "widget blank after song change" report.**
32. **BUG-037** — Process gap: concurrent sessions editing the same file can silently undo each other's live-verified fixes on a clean `git pull --ff-only` (no conflict, no warning). Happened once today on `ps-automation.ps1`, reconciled by hand. No systemic fix yet.
33. **BUG-026** (re-flagged) — the Spotify 10/10 live play-through verification is still outstanding; today's work only reconciled the DPI-awareness/click_at/cua-driver code back to intact after BUG-037's conflict, it did not re-run the actual play-through test.

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
| `mythos/.env` | AUTONOMOUS_MAX_TIER=3 (claimed, NOT applied — still 2 on disk) | BUG-012 |
| `mythos/vault/Identity/boundaries.md` | max_autonomous_tier: 3 (claimed, NOT applied — still 2 on disk) | BUG-012 |

---

## Files Modified Session 3 (2026-07-16 — log audit + hallucination fixes)

| File | Change | Bug |
|---|---|---|
| `mythos/adapters/pc-child/ps-automation.ps1` | Null-result guard in dispatch loop (`$null -eq $result` → `ok:false`) | BUG-031 |
| `mythos/src/core/effectors/from-spotify.js` | 5 null guards on `.elements`/`.windows` access | BUG-031 |
| `mythos/src/core/effectors/from-pc.js` | `base64` key added to extraction chain + `typeof` guard (both `capture_screenshot` + `screen_look`) | BUG-032 |
| `mythos/src/core/effectors/from-computer.js` | Leading-slash strip in `resolveSandboxed()` for win32 | BUG-033 |
| `mythos/src/core/voice/voice-agent.js` | navigate/close_panel descriptions, `suggestTool()`+`TOOL_ALIASES`+`levenshtein`, AFFIRMATION RESOLUTION RULE | BUG-034 |
| `mythos/ui/public/js/voice/voice-loop.js` | NAV_COMMANDS un-anchored (`^...$` → `^...(?:\s\|$)`) | BUG-034 |
| `mythos/ui/public/js/views/audit.js` | Better error logging on fetch failure | BUG-019 |
| `mythos/ui/public/js/neural-map/core-orb.js` | Speaking voice state visual identity (green/yellow glow) | — |
