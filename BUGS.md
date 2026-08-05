# MYTHOS — Complete Bug Registry

Comprehensive issue log covering the entire MYTHOS history, mined from:
- Episodic conversation logs (vault/Episodic/)
- Audit decision logs (vault/Audit/)
- Incident reports (vault/Incidents/)
- Semantic memory (vault/Semantic/)
- Code comments (D-NN drift items, SPEC/REALITY GAPs)
- Git commit history
- Live session bug reports

Last updated: 2026-08-05 (afternoon) — the 2026-08-05 afternoon incident batch:
BUG-106..BUG-116, 10 fixed + BUG-114 diagnosed-and-fixed (unit-verified, live
gate pending for all). See the LAST section. The prior entry: 2026-08-05
(morning) — BUG-099..BUG-105, 6 fixed (unit-verified, live gate pending) +
BUG-104 registered as a §7.6 feature. The entry before that: 2026-08-02 — the
2026-07-31/08-01 voice-session fixes, 19 defects, 7 stages,
BUG-059(new)..BUG-081 (its own section carries the collision note on
BUG-059/060/061's numbers and a live-verification runbook, still OUTSTANDING).
Maintainer: update this file as issues are resolved. Strike through the status.

---

## Session (2026-07-22) — HUD dashboard fixes

Four live-reported dashboard defects, each root-caused (4 parallel read-only investigations + live probes) then fixed:

- **BUG-042 (media controls dead):** ✅ FIXED + LIVE-VERIFIED. Media widget play/pause/next/prev/volume did nothing. Wiring (frontend `/api/media/control` → `routes/media.js` → `media_key` effector → pc-child) was byte-correct; the break was the execution boundary — `Send-VkKey` in `ps-automation.ps1` injected global media VK codes via `SendInput` and discarded the return count, so `Handle-MediaKey` always reported `sent:$true` even when the OS silently dropped the input (UIPI/foreground/integrity — a fragility this repo already documents). Read path (`media_status`) worked because it never touches `SendInput`. **Fix:** route transport (play/pause/next/prev) through the SAME `GlobalSystemMediaTransportControlsSession` the read path uses — `TryTogglePlayPauseAsync`/`TrySkipNextAsync`/`TrySkipPreviousAsync` via `Await-WinRTOperation` — so control is direct and foreground-independent; keep volume keys on VK injection but capture the `SendInput` count and report an honest failure on 0. Live-verified against running Spotify: `next_track` changed the title (A PERFECT WORLD → PIECES), `play_pause` froze then resumed the position oracle. Note: the widget's ▶/⏸ flag can lag one 5s poll (SMTC PlaybackStatus latency) — cosmetic, not a control bug.
- **BUG-006 (YouTube "Video unavailable"):** ✅ enhanced (see full entry below). Root cause of "most videos fail": the video was chosen as the first search hit with ZERO embeddability check, and most YouTube videos have embedding disabled by the uploader. **Fix:** `from-dashboard.js` now pulls 6 candidates and pre-checks each via YouTube's keyless oEmbed endpoint, embedding the first that allows it; if none do, it opens the real youtube.com page in a browser tab (always plays). `web-panel.js` also catches the player's `onError` postMessage → auto-opens the real tab. Combined with the earlier `enablejsapi=1` + `listening` handshake fix.
- **BUG-043 (weather wrong location):** ✅ FIXED (auto-detect). "Brisbane/Australia" was NOT hardcoded (zero repo hits) — `weather.js` used only `navigator.geolocation` (desktop → unreliable network/IP location) and showed no city name. **Fix:** keep geolocation as primary but reverse-geocode the coords to a city name (BigDataCloud, keyless) and always display it; on denial/timeout, fall back to IP geolocation (ipapi.co → ip-api.com, keyless) which returns city directly; Kolkata constant only as last resort. Shows a real city name every launch. Honest caveat: if the machine's public IP itself geolocates wrong (VPN), both sources may agree on the wrong city — but the visible name now makes that obvious.
- **BUG-044 (widget resize doesn't scale content):** ✅ FIXED. `makeResizable` set width/height on `.widget-card`, but the card was a plain block capped at `max-width:260px` with a non-filling `.widget-body`, so the frame grew while content stayed put. **Fix (`widgets.css`):** `.widget-card` becomes a flex column with a raised max-width; `.widget-body` gets `flex:1; min-height:0; overflow:auto` so content fills/scrolls with the frame; removed fixed `max-height` caps on feed/news lists so they use the resized space.

---

## Session (2026-07-24) — Phase 0–2 execution: batch secured, 4 bugs live-verified, wiring audit

Full end-to-end wiring audit against a live MYTHOS boot (see `docs/WIRING-AUDIT.md`). BUG-041/014/006/040 all re-verified with real oracle evidence (details in their own entries above); three verify-harness bugs and one product wiring bug found along the way are recorded there too. Two more findings surfaced live during the pc-child/browser effector checks:

- **BUG-045 (list_windows can fail on a live desktop — UI Automation COM fragility):** ✅ FIXED. Live-verifying the pc-child effector, `list_windows` returned `outcome:"fail"` once against a real, busy desktop (audit line `aud-a4606b0aabaa`), while a standalone re-probe seconds later succeeded cleanly with real window data — a one-off, not reproduced twice. Root cause (plausible, matches this repo's established COM-fragility pattern — see CLAUDE.md's WinRT note): `Handle-ListWindows` in `ps-automation.ps1` read `$child.Current.ProcessId/Name/ClassName/BoundingRectangle` on every enumerated `AutomationElement` with NO guard — only the subsequent `Get-Process` lookup was wrapped in try/catch. A window that closes between `FindAll()` enumerating it and this loop reading its properties throws `ElementNotAvailableException` on ANY property access, aborting the entire `foreach` and failing `list_windows` for every window, not just the stale one. **Fix:** wrap the property-read block in its own try/catch; skip just that window (`$skipped` count added to the response) and keep enumerating the rest. `total` now reflects `$windows.Count` (previously `$all.Count`, which could over-count relative to the returned array once skips exist). Not unit-testable (PowerShell, not part of `node --test`) — verified via a standalone probe script against a live pc-child instance (real 9-window desktop, `skipped:0`, real PIDs/titles/classNames returned) before and after the change.
- **BUG-046 (voice agent occasionally fabricates "PC automation is offline" without calling the tool)** — 🔍 DIAGNOSED, not code-fixed (prompt-behavior, needs a live operator session per the Phase 5 gate, not a blind prompt edit). Sent "list my open windows" 3 times via raw WS utterance in one MYTHOS session; all 3 replies said some variant of "PC automation is offline, sir" — but `/api/audit/recent` showed **zero new audit entries** for any of the three (proof no tool call was ever attempted; pc-child was in fact ONLINE and answering `media_status` polls correctly throughout, per boot log). A separate dashboard-driven attempt earlier in the same investigation DID call `list_windows` correctly. This is the mirror image of BUG-007 (fabricated success) — a fabricated *failure* claim, violating the voice-agent's own stated HONESTY RULE ("NEVER claim you are doing it" applies in both directions: also never claim it's impossible without checking). Needs prompt tuning + a live conversational test to confirm a fix doesn't regress tone elsewhere — deferred to the guided operator session (Phase 5).

**Files:** `mythos/adapters/pc-child/ps-automation.ps1` (`Handle-ListWindows`), `mythos/adapters/browser-agent/index.js` (`findChromePidByUserDataDir`, `writeBrowserPidFile` — see BUG-029 entry above for the pidfile fix found in the same session), `mythos/server/index.js` (perception relay — see BUG-040 entry above), `mythos/scripts/verify-{planner,memory-guard,youtube}.js` (harness fixes — see BUG-041/014/006 entries above).

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
**Status:** ✅ CLOSED via BUG-026's 5th-attempt fix (2026-07-17) — playback live-verified working; see BUG-026 for the full mechanism. (Historic sub-items: URI launch guard fixed earlier; focus fix superseded — focus_window itself was broken by the `$pid` bug, see BUG-031.)
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
**Status:** ✅ VERIFIED (2026-07-17) — live browser check done: typed "what day is it today?" into the real compose bar, reply caption rendered "It's Friday, July 17th." Full path proven: compose → WS utterance → voice-agent → brain (groq) → reply caption + speech chunks. (Server side additionally verified with a raw WS client: utterance → correct answer in 4.3s.)
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
**Status:** ✅ FIXED & LIVE-VERIFIED (2026-07-17) — full chain proven in the running HUD: title/artist/album/300×300 album art rendering across multiple real track changes, curly-quote titles intact. Three stacked root causes fixed along the way: (1) WinRT `.Wait()`/COM-reflection bug (explicit-type `Await-WinRTOperation`, 2026-07-16), (2) OEM-codepage JSON corruption + queue starvation (see BUG-038, the actual cause of "blank no matter what"), (3) art moved to a temp-file + `/api/media/art` route instead of base64-in-JSON.
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
**Status:** ✅ ROOT-CAUSED + FIXED 2026-07-22 (live-verified); server-side harness re-confirmed 2026-07-24 (both `YOUTUBE_MODE=embed` and `=newtab`) — see "Actual root cause" below; prior CODED status attributed this to unfixable YouTube bot/consent blocks, which was not correct
**Live-verify harness:** `node scripts/verify-youtube.js` (server-side) + manual iframe check — see `docs/live-verification-runbook.md` §A3
**Severity:** MEDIUM | **Reported:** 2026-07-15

**Harness bug found + fixed 2026-07-24:** `verify-youtube.js` used `sendUtterance()`'s reqId-scoped event collector to look for the `open-web` broadcast, but `server/index.js` re-broadcasts `ui.open-web` as `{type:'open-web'}` via `broadcastAll()` — a global send to every connected WS client with no `reqId` attached at all. `sendUtterance()` only keeps messages whose `reqId` matches its own request, so it could never see this event and would always fall through to `no YouTube open-web event captured`. Fixed by running a second, type-subscribed `captureEvents(port, ['open-web'], ...)` connection concurrently with the utterance send (the same pattern `verify-screen-sensor.js` already uses for `perception.*`, which is broadcast the same reqId-less way). Re-run after the fix: PASS in both modes — default mode's URL uses `youtube-nocookie.com/embed/`, `newtab` mode's URL uses `youtube.com/watch`.

**Actual root cause (found 2026-07-22, after a fresh live report: video plays fine for a few seconds, then goes black while a redundant fallback thumbnail card appears below it, the panel becomes scrollable, and audio keeps playing in the background):**

Two independent, compounding bugs — not YouTube-side blocking at all:

1. **8s failTimer always fires, even on a healthy video.** The embed URL built in `from-dashboard.js`'s `open_web` youtube branch (`https://www.youtube-nocookie.com/embed/<id>?autoplay=1&rel=0&modestbranding=1`) never included `enablejsapi=1`, in any commit. Without it, the YouTube player never activates its postMessage bridge, so `web-panel.js`'s success-detection listener (waiting for `onReady`/`infoDelivery`) never fires, and the 8-second `failTimer` unconditionally assumes failure — every time. On timeout, only the iframe was hidden (not its parent `.web-iframe-wrap` box, not `iframe.src`), so the wrap stayed as an empty black box, the fallback thumbnail rendered below it, the panel overflowed into a scrollbar, and the still-loaded iframe kept playing audio invisibly.
2. **The video panel's ancestor carried a persistent CSS `transform`.** `.hud-panel`'s base open animation (`fadeInUp`, fill-mode `both`) leaves `transform: translateY(0)` on the panel forever after the ~300ms animation completes. A non-`none` `transform`/`filter`/`backdrop-filter` on an iframe's ancestor breaks Chromium's hardware-accelerated video compositing (video paints black, audio keeps playing) — matches the "plays fine, then blacks out" timing (GPU promotes the video to a hardware overlay a beat after first paint; compositing through the transformed ancestor fails at that point). A same-session `backdrop-filter` fix on the video panel didn't address this since it's a separate CSS property causing the same effect.

**Fix (2026-07-22):**
- `from-dashboard.js`: added `&enablejsapi=1` to the embed URL.
- `web-widget.css` (`.hud-panel.web-panel-video`): added `animation: none; transform: none;` alongside the existing `backdrop-filter: none` override.
- `web-panel.js` failTimer: now hides the whole `.web-iframe-wrap` and blanks `iframe.src` (not just the inner iframe) when a genuine failure does occur, so a real dead/blocked video shows only the fallback card — no leftover black box, no scroll, no lingering audio.
- `web-panel.js` (follow-up, same day): `enablejsapi=1` alone was NOT enough — the YT widget protocol posts no events until the parent sends a `{"event":"listening","channel":"widget"}` postMessage handshake into the iframe (what YouTube's official IFrame API library does internally). Added the handshake (sent on iframe load + retried every 500ms until an event arrives), which is what finally lets `onReady`/`infoDelivery` reach the detector so healthy videos stop being swapped for the fallback card at the 8s mark.

Live-verified: MYTHOS relaunched with the fix; `/health` 200 on fresh boot. (Visual re-check of an actual video playing past 8s is operator-eyes-only, same as the original BUG-006 verification — see runbook §A3.)

---

### BUG-006 (historical entry, pre-2026-07-22 investigation, kept for context)
**Status (as of 2026-07-15):** 🔧 CODED — fallback UI enhanced + config escape hatch added

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
**Status:** Fix 2 (param aliasing) ✅ VERIFIED · Fix 1 (lazy auto-connect) ✅ LIVE-VERIFIED (2026-07-27) · on-demand launch ✅ LIVE-VERIFIED (2026-07-27)
**Severity:** HIGH | **Reported:** 07-12 (6 failures) | **Fixed:** 2026-07-16

**Symptom:** `browser_navigate` returns "Browser automation is OFFLINE. Run setup-chrome-debug.ps1 first." even after the user grants Chrome access, because nothing ever called the adapter's own auto-connect. Also `browser_evaluate` only read a `script` key, so calls sending `query`/`expression`/`javascript` failed with a missing-argument error even when the browser was online.

**Fix 1 — lazy auto-connect (✅ LIVE-VERIFIED 2026-07-27):** `mythos/src/core/effectors/from-browser.js` — `requireOnline()` (line 22) is now `async`. When status isn't `ONLINE` it now awaits `browserAgent.ensureOnline({ cdpUrl: process.env.BROWSER_CDP_URL || config?.BROWSER_CDP_URL })` (adapters/browser-agent's existing CDP-connect-then-launchLocal-fallback, previously never called by any effector) before re-checking status and failing. All 10 call sites in the file (`browser_navigate`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_get_title`, `browser_get_text`, `browser_scroll`, `browser_tabs`, `browser_go_back`, `browser_evaluate`) were updated from `const guard = requireOnline();` to `const guard = await requireOnline();`. `registerFromBrowser(hub, ctx)` now accepts a `ctx` and stashes `ctx.config` into a module-level `config` var for the CDP URL lookup; `mythos/src/main.js`'s call site (was `registerFromBrowser(hub);`, no ctx ever passed) is now `registerFromBrowser(hub, { config: config });`. Verified with mocked `browserAgent.ensureOnline()`/`getStatus()` in `mythos/test/bug-011-browser-auto-connect.test.js` (OFFLINE→ensureOnline()→ONLINE path, ensureOnline-fails-cleanly path, and already-ONLINE-skips-ensureOnline path all pass). **Live-verified 2026-07-27** via `mythos/scripts/verify-browser-autoconnect.js` against real Chrome + real playwright-core (no mocks): with debug Chrome off, calling a browser tool self-connected via CDP-attempt-then-launch-fallback exactly as this fix describes (`browser_get_title()` returned `{ok:true}`, `getStatus()` went OFFLINE→ONLINE) — with **zero manual `setup-chrome-debug.ps1` step**, not even the one-time run this note used to require. Independently re-run and reproduced with a different Chrome PID (rules out a cached/replayed result). **After a fresh boot, `browser_navigate` (and every other browser tool) now self-connects with no setup step needed at all.**

**On-demand launch (✅ LIVE-VERIFIED 2026-07-27):** live-invoked the real `browser_launch_debug` effector (`mythos/scripts/verify-browser-launch.js`) with no debug browser running; it spawned a genuine Chrome process (BUG-029 pidfile written with the real PID), came ONLINE over CDP, and drove a real page (`page.goto` + `page.title()` returned the expected title) — all cleaned up afterward with no orphan left. Independently re-run with a different Chrome PID each time, confirming this isn't replayed output.

**Fix 2 — `browser_evaluate` param aliasing (✅ VERIFIED):** now accepts `{ script, expression, javascript, query }` and uses whichever is present (`const code = script || expression || javascript || query;`), with a clearer error message when none are given. Fully unit-tested (no live Chrome needed): `bug-011-browser-auto-connect.test.js` asserts `browser_evaluate({expression:'1+1'})`, `{query:'1+1'}`, and `{javascript:'1+1'}` all behave identically to `{script:'1+1'}`, plus the no-alias-provided failure message.

**Test run:** `node --test mythos/test/bug-011-browser-auto-connect.test.js` — **8/8 pass**.

**Files:** `mythos/src/core/effectors/from-browser.js`, `mythos/src/main.js` (registerFromBrowser ctx wiring), `mythos/test/bug-011-browser-auto-connect.test.js` (new)

---

### BUG-012: Approval popup on every action
**Status:** ✅ FIXED (2026-07-17) — root cause: T3's "confirm-once-per-goal" grant lives on the goal record (`goal.grants['3']`), but the voice/conversation path always carries `goalId:null`, so the grant cache could never engage there — every T3 voice action asked every time (live audit entries confirmed: `"tool":"spotify_play","tier":3,"decision":"confirm","goalId":null`). Fix (NOT a global ceiling raise — that stays rejected as a safety regression, see analysis below): **session-scoped per-tool grants** in `leash/index.js`. Accepting a confirm for an eligible tool grants THAT tool for 15 minutes. Eligible list is deliberately narrow (spotify_play, spotify_search, ui_click, ui_type, click_at, send_key, focus_window); outward-facing/destructive T3 tools (gmail_send, compose_email, delete_goal, build/pipeline execution) still confirm every time by design. 3 regression tests added (grant engages, gmail_send never grantable, no cross-tool leakage) — 20/20 leash tests pass. Live voice-flow check pending the user's next session.
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
**Status:** ✅ LIVE-VERIFIED 2026-07-24 via `scripts/verify-memory-guard.js` — all 4 noise samples ("uh", "the", "that you like", "hmm") left `vault/Semantic/user-facts.md` byte-identical; the signal ("i really enjoy playing jazz piano") was persisted (`- The operator really enjoys playing jazz piano.` appended).
**Live-verify harness:** `node scripts/verify-memory-guard.js` — see `docs/live-verification-runbook.md` §A2
**Severity:** MEDIUM | **Reported:** 2026-07-15

**Harness rewritten 2026-07-24 — the original detection method could never pass or fail correctly:** it grepped the WS event JSON for `ok":false`/`reject`/`too short`/`noise`, but `remember()`'s raw `{ok,result}` is a server-internal dispatch value — the WS `'done'` message only carries `{say, speak, chunked}` (see `server/index.js`'s `sendSpokenReply`), so those substrings can never appear on the wire. It also looked for a *new* file in `vault/Semantic/`, but `remember()` always appends to the one persistent `user-facts.md` (never a per-session file) — so `newFiles.length` was always 0 even on success. Rewritten to snapshot `user-facts.md`'s raw content immediately before/after each utterance: noise must leave it byte-identical (the guard returns before `semantic.write()` is ever called); the signal must change it (semantic.js's append-mode write always rewrites the `{id,ts}` sidecar comment on every accepted call, even when dedup recognizes the fact as already present with unchanged bullet lines — so the check is content inequality, not length growth, which was a mistake caught in an interim run of this same fix).

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
**Status:** ✅ VERIFIED (2026-07-17) — `GET /api/audit/recent` returns real entries live (spotify_play tier-3 confirm/completed records observed).
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
**Live-verify:** manual session + VAD constant tuning — see `docs/live-verification-runbook.md` §C4
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
**Status:** ⚠️ CODE-LEVEL VERIFIED (session 2026-07-16) — clean errors and calendar sensor wiring proven by test; real Gmail/Calendar functionality still un-verifiable without user-supplied Google OAuth credentials. **Phase 3 (2026-07-19) update:** scripts/google-auth.js now requests `calendar.readonly` (was Gmail-only — operators' existing tokens would 403 on Calendar reads); full operator walkthrough at `mythos/docs/google-oauth-setup.md`. The live OAuth pass remains operator-hardware work.
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

**User action required (not automatable — must be done by whoever runs the instance, with their own Google account):**
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
**Status:** ✅ FIXED & LIVE-VERIFIED (5th attempt, 2026-07-17, commit `756966e`) — **music actually plays**; user confirmed live. cua-driver-rs 0.8.3 installed (user-approved), real MCP tool surface probed (`list_windows` / `get_window_state` / `click` — the old placeholder name is gone). New flow: walk Spotify's real Chromium accessibility tree until QUERY-MATCHED "Play <track>" buttons appear (the tree builds lazily — a minimized Spotify exposes 1 element, fronted 350+, which alone explains every earlier "cannot see, cannot click" failure), click by `element_index` with background→foreground escalation (Chromium silently drops posted background clicks — driver reports `verified:false`), then verify via the window-title oracle ("Artist - Track") with a strict-majority term match and retry the next candidate when a same-named playlist starts the wrong song. Oracle-verified across ~19 live play-throughs during development (17 pass, final code passing every retest). ALSO fixed here: the `$pid` parameter bug (see BUG-031 update) that had silently broken focus_window/ui_click/ui_elements/ui_type/close_window since they were written.
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
**Live-verify:** manual voice session with open-air speakers — see `docs/live-verification-runbook.md` §C2
**Severity:** HIGH (causes hallucinated/unrequested tool calls) | **Reported:** 2026-07-16 (live session)

**Symptom:** MYTHOS executed `web_search({"query":"best pizza recipe"})` and `open_web` when the user never asked for it — user confirmed: "I never said to web search best pizza recipe." Transcript shows the trigger text was MYTHOS's own prior spoken reply ("...including Neapolitan and NYT styles. Shall I show you the search results...") echoed back as if the user had said it. A `remember()` and a `log_incident()` call fired the same way — off MYTHOS's own speech, not the user's.

**Root cause:** `voice-loop.js:395` sets `echoCancellation: true` on `getUserMedia`, but browser AEC only reliably cancels audio that the browser recognizes as its own reference-output signal — it degrades badly over open-air speaker→mic setups (not headphones) and doesn't help at all once the reference signal is louder/longer than a short reply. There is no explicit "mute/ignore mic input while TTS is actively playing" gate anywhere in the VAD loop (checked: no `isSpeaking`/playback-state flag consulted near the VAD/chunk-playback code) — the system relies entirely on AEC, and AEC is not holding up in real use. This is a distinct, more severe failure mode than BUG-020 (background noise sensitivity) — this is the assistant hearing itself, not ambient noise.

**Fix applied:** Added a module-scoped `assistantSpeaking` flag (`voice-loop.js` line 113) inside `createVoiceLoop`. It is set `true` at the two points playback of a reply actually starts — `playNextChunk()` (line 289, chunked speech-chunk streaming) and `speakFallback()` (line 355, non-chunked browser-TTS path) — and set back to `false` in `stopSpeaking()` (line 274), the single place already called both when the chunk queue is fully drained (`maybeFinishTurn` → `stopSpeaking`) and when non-chunked playback finishes (`speakFallback`'s `finish()` → `stopSpeaking`). The VAD tick loop (`vadTick()`, starts line 627) now checks this flag first and returns immediately — resetting `aboveCount` and never calling `startRecording()` — while `assistantSpeaking` is true. This is a hard mechanical gate on the capture pipeline itself, independent of and in addition to the existing `ECHO_GUARD_MS` fuzzy text-match guard (kept in place unchanged, defense in depth). Note: this necessarily disables the "barge-in" behavior the code comments describe (talking over MYTHOS mid-reply to interrupt it) — VAD cannot distinguish real barge-in speech from TTS bleed at the mic, so blocking one blocks both. Given this bug's severity (hallucinated tool calls from MYTHOS's own voice), that tradeoff was made deliberately per the fix spec; flagging it here since it changes previously-intended behavior.

**Verification note:** No automated test coverage exists for this decision. `voice-loop.js` is a browser-only ES module (`import`, `window`, `navigator.mediaDevices`, `MediaRecorder`, `AudioContext`, `AudioWorklet`) with no jsdom/happy-dom or DOM-shim dependency anywhere in this repo's `package.json`, and no prior test in `mythos/test/` imports anything from `ui/public/js/` — confirmed by checking both. Building a real harness would mean adding a new test-infrastructure dependency and mocking `MediaRecorder`/`AudioContext`/`getUserMedia`/`AudioWorklet`, which is out of scope for a surgical two-bug patch. Marking 🔧 CODED per the fallback path: have a real voice conversation with MYTHOS and confirm its own spoken reply is never picked up and re-transcribed as a new user turn — specifically watch for any tool call (web_search, open_web, remember, log_incident, etc.) firing in the few seconds right after MYTHOS finishes speaking with no new thing said by the user.

**Files:** `mythos/ui/public/js/voice/voice-loop.js` (`assistantSpeaking` flag declaration line 113, set `true` in `playNextChunk` line 289 and `speakFallback` line 355, set `false` in `stopSpeaking` line 274, VAD gate at the top of `vadTick` line ~633).

---

### BUG-028: `navigate` has no "news" route — MYTHOS opens the wrong panel or fails while claiming success
**Status:** ✅ LIVE-VERIFIED (2026-07-27) | **Severity:** MEDIUM | **Reported:** 2026-07-16 (live session)
**Live-verify:** `node scripts/verify-news-route.js` (automated WS harness against a real boot, no human needed) — see `docs/live-verification-runbook.md` §B1

**Symptom:** User: "what's the news for today?" → MYTHOS says "Opening the news feed now, Alex" but the actual call logged is `navigate({"route":"health"})` — wrong panel opens while the reply claims the right one did. User calls it out directly, MYTHOS then tries `navigate({"route":"news"})` and gets a clean rejection: "I attempted to open the news feed, but it is not a valid route."

**Root cause:** `mythos/src/core/effectors/routes.js` — `ALL_ROUTES` is `['goals', 'kanban', 'pipeline', 'memory', 'health', 'audit', 'backend', 'conversation', 'engagements']` and `SYNONYMS` has no `news` key at all. There is no dashboard panel called "news" — news is only ever a static boot widget (Google News headlines, always-on) or an ephemeral `spawnWebWidget`/new-tab result from a search, never a navigable route. Because the voice-agent's catalog/prompt doesn't tell the model this, the LLM either (a) hallucinates the closest-sounding valid route (`health`) and narrates as if it opened news — same fabrication pattern as BUG-007, just for a route that structurally cannot succeed — or (b) correctly calls `navigate({route:'news'})`, which cleanly fails since that's not the bug: the bug is nothing tells the model in advance that "news" isn't a route so it can respond honestly ("the news widget is already on your dashboard, there's no separate news panel to open") instead of guessing.

**Fix applied:** Updated the `navigate` tool description in the CATALOG_RAW (`mythos/src/core/voice/voice-agent.js` line 43) to add a clarifying note: "Note: there is no "news" route — news is a boot-time floating widget spawned separately, not a navigable dashboard panel. Never call navigate with route:"news"." This keeps the model from guessing or hallucinating a "news" route and instead responds honestly when asked about news.

**Verification note:** This is a prompt-behavior change that cannot be unit-tested (no automated way to verify an LLM's future decision-making from a static prompt string), but it was live-verified via a scripted WS harness driving a real boot instead of a human: `mythos/scripts/verify-news-route.js` sent the real utterance "what's the news for today?" over the actual compose-bar WS protocol and inspected the server's own `action`/`navigate` broadcast telemetry. Result (run twice, adversarially rechecked): exactly one action fired — `{tool:'open_web', ok:true}` — with real dated search-card content; zero `navigate` calls of any kind (no `route:'news'` attempt, no `route:'health'` hallucination); the spoken reply ("Opening today's AI news on the dashboard now, Alex.") accurately described the real, successful action. The original BUG-028 fabrication pattern (wrong-route navigate + false success claim) did not occur.

**Files:** `mythos/src/core/voice/voice-agent.js` (CATALOG_RAW navigate description updated, line 43) — `mythos/src/core/effectors/routes.js` (reference only, no change needed)

---

### BUG-029: Orphaned browser-automation Chrome process keeps playing audio after MYTHOS + browser are fully closed
**Status:** 🔧 CODED (2026-07-17, hardened 2026-07-19 Phase 3) — mitigation shipped + hardened. `adapters/browser-agent/index.js` writes the launched browser's PID to `mythos/.browser-agent.pid` on launch (cleared on clean close/disconnect); `Start Agent OS.bat` kills any PID found in that file (with `/T` for the tree) before booting. **Phase 3 hardening (2026-07-19):** (a) the pidfile now ALSO covers `from-browser.js` `browser_launch_debug`'s detached spawn (previously the orphan gap — those browsers didn't write the pidfile, so `.bat` cleanup missed them); (b) the `.bat` now verifies the PID's command line contains `MYTHOS` or `chrome-debug-profile` before tree-killing — belt-and-suspenders so a wrong PID in the file can't close the operator's own Chrome. The proper D-07 graceful-shutdown fix and a live reproduction remain open.
**Severity:** HIGH (survives full app shutdown, invisible in Task Manager, only recoverable by restarting) | **Reported:** 2026-07-16 (live session)

**Symptom:** A YouTube video MYTHOS opened for "news" kept playing audio in the background after the user closed the browser window AND closed the terminal running `start.bat`. Checked Task Manager — nothing obviously identifiable was running. Only fix was to run `start.bat` again, reopen the HUD, and ask MYTHOS by voice to close the news panel — which worked.

**Root cause (two candidate mechanisms, not yet isolated by live reproduction):**
1. **Windows SIGINT/SIGTERM delivery gap (already documented elsewhere in this codebase).** `main.js:541-542` wires `process.on('SIGINT'/'SIGTERM', stopRunningLoops)`, which calls `pcChild.shutdownPcChild()` and `browserAgent.disconnect()` (`main.js:524-525`). But `main.js`'s own comment block (lines 493-495) already documents that a watched-directory handle can block `child.kill('SIGINT'/'SIGTERM')` from ever reaching `process.on()` on Windows — the same known gap `test/boot.test.js` already skips around on win32. If the terminal window was closed rather than stopped with a clean Ctrl+C, this shutdown path may never have run at all, so `browserAgent.disconnect()` never fired.
2. **`adapters/browser-agent/index.js` `launchLocal()`** (lines 88-136) spawns a real, visible (`headless:false`) Chrome/Edge process via `chromium.launchPersistentContext()` whenever CDP isn't available (the "launched" fallback mode, `ensureOnline()`). This is a separate OS process from whatever browser window the user thinks of as "their browser" — closing their regular Chrome window does not touch it, and depending on window placement/minimization it's easy to miss among other `chrome.exe` entries in Task Manager. If mechanism (1) prevented `disconnect()` from running, this process would be left completely orphaned with its last page (the YouTube tab) still playing.
3. **Separately worth checking (not MYTHOS's fault if true):** Chrome's own "Continue running background apps when Google Chrome is closed" setting (`chrome://settings` → System) keeps regular tabs — including their media — alive after all visible Chrome windows close. Worth the user checking that setting regardless of which of the above turns out to be the actual mechanism, since it would explain persistence even with zero MYTHOS involvement.

**Fix needed:** This is the real-world symptom of the already-tracked **D-07** (graceful 7-step shutdown missing, only a hard-exit timer exists) — implementing D-07 properly, with a shutdown path that's actually reliable on Windows (plain `process.on('SIGINT')` is not, per the existing comment in `main.js`), would close this. Needs live reproduction first to confirm which mechanism (1 or 2) is actually firing before writing the fix — don't guess a fix against an unconfirmed mechanism twice in one week (see BUG-026).

**Update 2026-07-24 — D-07's coordinated shutdown IS now wired (found already in place this session, not newly added):** `main.js`'s `stopRunningLoops()` (registered as the `'stop-loops'` lifecycle shutdown step, part of the full server-close → stop-loops → episodic-flush → checkpoint-write → audit-flush → exit sequence) already calls `browserAgent.stopAutoConnect()` then `browserAgent.disconnect()`, which closes the launched Playwright persistent context (`context.close()`) — this reliably terminates the underlying Chrome process tree when it runs. Live-verified: `taskkill /PID <mythos> /T /F` (tree-kill, the one termination path this session could reliably trigger against a detached background process) correctly took down every child Chrome process alongside MYTHOS, both before and after the fix below.

**Real gap found + fixed live 2026-07-24 (mechanism 2's safety net, not mechanism 1):** `writeBrowserPidFile()` in `mythos/adapters/browser-agent/index.js` — on the installed `playwright-core@1.61.1`, **neither** accessor it tried (`ctx.browser()`, `ctx._browser._process`) actually returns a process for a `launchPersistentContext()`-created context; both are null/undefined on this version. Confirmed live: `"browser-agent launched local browser","browserPid":null` in the boot log on every launch. This meant `.browser-agent.pid` was **never written**, so `Start Agent OS.bat`'s orphan-cleanup step (which reads that exact file) had no PID to check on the next boot — the BUG-029 "hardened" safety net for the mechanism-1 (SIGINT-never-delivered) scenario was silently inert. Fixed by adding `findChromePidByUserDataDir()`: when the Playwright accessors fail, identify the top-level browser process by its unique `--user-data-dir` command-line argument (excluding `--type=` child processes — renderer/gpu-process/utility) via `Get-CimInstance Win32_Process`, the same distinguishing signal the `.bat`'s own provenance check already uses. **First implementation attempt used `execSync` with a shell command string and silently returned empty output** — Windows' `cmd.exe` intermediary mangles a PowerShell one-liner containing nested double quotes; caught by testing as a standalone script rather than trusting the first "no error, returns null" result. Fixed by switching to `execFileSync('powershell.exe', [args...])` (args array, no shell layer — the exact pattern `adapters/pc-child/index.js` already uses to spawn PowerShell) plus rewriting the WQL filter to use only single quotes. Live-verified after the fix: launching the browser now writes a real PID (`"browserPid":40204"`) to `.browser-agent.pid` matching the actual top-level `chrome.exe` process.

**Still open (unchanged, cannot be verified in this non-interactive session):** whether `process.on('SIGINT')` itself reliably fires when a Windows terminal is closed (vs. a proper Ctrl-C in an attached console) — this needs a real attached terminal and is best exercised live by the operator (or in the Phase 5 interactive session), not something a detached background process can reproduce.

**Files:** `mythos/src/main.js` (lines 493-495, 520-542, `stopRunningLoops`), `mythos/adapters/browser-agent/index.js` (`launchLocal`, `disconnect`, `writeBrowserPidFile`, new `findChromePidByUserDataDir`) — cross-reference `D-07` in the roadmap table below.

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
**Status:** ✅ FIXED (2026-07-16 guards; REAL root cause found + fixed 2026-07-17) — the null guards treated the symptom. The actual cause: `ps-automation.ps1` handlers declared a parameter named `$pid`, which is PowerShell's READ-ONLY automatic variable — parameter binding throws `"Cannot overwrite variable pid because it is read-only or constant"` before the function body runs, so the handler returns null. **focus_window, close_window, ui_elements, ui_click, and ui_type were all broken this way since they were written.** All renamed to `$TargetPid` (commit `756966e`); focus_window + ui_elements verified working live for the first time ever through the pipeline.
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

**Root cause (verified, file:line):** `from-computer.js:73` — `path.resolve('/vault/builds')` on win32 resolves from whichever drive the process is running on (e.g. `<drive-letter>:\vault\builds`), which is outside the allowed sandbox roots (the project directory). The cortex AI, trained on Linux paths, routinely prepends `/` to relative paths.

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
**Status:** ⚠️ MITIGATED (2026-07-17) — repo-level `CLAUDE.md` now carries binding rules for every AI session: pull+diff against BUGS.md claims before editing recently-verified files, commit verified fixes immediately, and a checklist of load-bearing pieces in `ps-automation.ps1` to re-verify after any pull. Not systemically enforced (git can't be), but no longer undocumented.
**Severity:** HIGH (can silently erase live-verified work with zero git-level warning) | **Reported:** 2026-07-16 (live session)

**Symptom:** This session live-verified a fix to `mythos/adapters/pc-child/ps-automation.ps1` (BUG-004's WinRT bridging + BUG-026's DPI-awareness + `click_at`), then pushed it to `origin/main`. A different, concurrent session had branched from an *older* snapshot of that same file, made its own (different, ultimately also-not-fully-working) fix attempt, and pushed its own commit. When this session later ran `git pull --ff-only origin main`, the pull succeeded cleanly — a normal fast-forward, zero conflicts — but the resulting file on disk had lost the DPI-awareness block, the entire `click_at` command, and the proven WinRT fix, replaced by the other session's untested rewrite.

**Root cause:** git's fast-forward merge only checks that the incoming commit is a linear descendant of the current `HEAD` — it does not, and cannot, detect "this new commit's file content is actually a regression relative to what was last verified working," because from git's perspective a full-file rewrite in a later commit is just... the new state of the file. There is no conflict to flag when one session's commit simply doesn't build on the other session's most recent work — if the other session's local checkout was stale at the time it made its edits, that staleness becomes invisible the moment it commits and pushes (as long as it eventually rebases/is based on a common ancestor that IS in this session's history — which it was here, since the fast-forward succeeded).

**Fix needed:** this is a coordination/process problem, not a single-file code bug — no code change closes it. Options worth considering for whoever owns this: (a) before starting work on a file another concurrent session might also touch, `git fetch` and diff against `origin/main` first, not just the last-known local commit; (b) after any multi-session pull, diff the pulled commit against the immediately-prior local `HEAD` for files this session itself recently modified, specifically looking for removed code, not just added; (c) treat "another session is also active on this repo" as a signal to serialize work on shared hot files (this one especially — `ps-automation.ps1` has now been independently rewritten by at least two different sessions in the same day) rather than both editing concurrently.

**Not fixed in this pass:** documented and reconciled by hand this one time (see BUG-004's timeline). No systemic guard exists yet.

**Files:** N/A — process issue, not a specific file. The concrete instance affected `mythos/adapters/pc-child/ps-automation.ps1`.

---

### BUG-038: `Handle-MediaStatus` hangs indefinitely when a track has album art (thumbnail extraction)
**Status:** ✅ FIXED (2026-07-17) — the "hang" was never a hang. REAL root cause, confirmed byte-exact: PowerShell 5.1 writes stdout in the OEM codepage, which best-fits curly Unicode quotes (U+201C/U+201D — present in this user's ENTIRE playlist, e.g. every track "From “Cocktail 2”") down to raw ASCII `"`. ConvertTo-Json legally leaves curly quotes unescaped, so VALID JSON left the child and INVALID JSON reached Node; Node dropped each response as noise, every media_status burned its 15s timeout, and the widget's 5s polls permanently jammed the serial queue — starving ALL pc-child tools. Fixed (commit `f5f6856`): UTF-8 console encoding + blanket `\uXXXX` non-ASCII escaping in `Write-Response` (survives ANY pipe encoding), command-id echo for response correlation (a late response can no longer resolve the NEXT command), thumbnail re-enabled via a temp-FILE design (`/api/media/art` route streams it; no 240KB base64 JSON lines ever). Live-verified: 3 consecutive track changes with art, 62–85ms per call, art rendering 300×300 in the HUD.
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

## Phase 1 — Engagement Execution Engine (cherry-picked from 8706ccc)

### P1-001: command-type stage verification is SKIPPED, not run

**Where:** `src/core/engagements/executor.js` `verifyStage()` (type === 'command').

**What:** Stages with `verification: { type: 'command', cmd, expectedExitCode }`
are NOT executed. The executor emits `health.anomaly` with kind
`engagement-command-verification-skipped` and treats the stage as
`verified: true, skipped: true`.

**Why deferred:** there is no safe sandboxed shell runner in the codebase.
Shelling out to `child_process.exec` from inside the engagement executor would
run arbitrary `cmd` strings (often model-generated, e.g. `npm test`, `rm -rf`)
without a container, jail, or cwd guard — an unacceptable RCE surface for a
voice/agent-driven system. The cortex loop itself never shells out either
(effectors are typed tools, not raw shells).

**Honest behavior shipped:** skipped + anomaly. A stage that declares a command
verification is marked complete; the anomaly is observable in the HUD/health
channel so an operator knows the command was never actually run. When a
sandboxed runner lands (planned: a WASM or container-isolated `run_command`
effector gated by leash tier 4 — see MYTHOS_Gap-Close_Upgrade task-957 §26
Phase 3), `verifyStage()` should route command checks through it instead of
skipping.

**Test:** `test/phase1-engagement-executor.test.js` "emits health.anomaly and
does NOT shell out".

### P1-002: stage-approval checkpoint closures do not survive restart

**Where:** `src/core/engagements/executor.js` `init()` + `parkForStageApproval()`.

**What:** in-memory `approvedStages` Set tracks which stages have been
approved this process so a resumed run does not re-park. On restart the Set is
empty; `init()` re-arms the checkpoint for AWAITING_STAGE_APPROVAL engagements,
and approval sets the flag before resuming — so the resume path is correct.
However, an engagement that was approved but crashed BEFORE the stage ran would
re-park on restart (the approval is lost). This mirrors the inherent limitation
documented in `src/core/leash/checkpoints.js` (closures cannot be serialized).

**Why accepted:** matches the forge.js precedent (honest-inert: never fakes
resume of half-done work). A double-approval prompt is a safe failure mode; a
silently-skipped approval is not.

### P1-003: build-stage file output is best-effort, not Forge-coupled

**Where:** `src/core/engagements/executor.js` `runBuildStage()`.

**What:** build stages use `brain.think({lane:'build'})` directly and write a
single file under `vault/builds/engagements/<id>/`. The richer Forge pipeline
(manifest → per-file generation → final review) is NOT invoked — the executor
and Forge do not share a clean integration point yet.

**Why deferred:** Forge's API (`createProject(spec, kind)`) is fire-and-forget
with its own checkpoint-gated flow; wiring it as a synchronous stage step would
require a blocking adapter that doesn't exist. The brain-driven single-file
write is a viable v1 that still produces a real artifact and emits
`engagement.artifact_created`. Defer full Forge coupling to a follow-up that
introduces a `runForgeStage` kind.

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

## Session (2026-07-31) — Slice 2 Hardening: click gap + honesty + self-loops + Electron playback

All 8 incidents below were flagged by the operator during live MYTHOS sessions on 2026-07-30/31 (episodic logs `vault/Episodic/2026-07-30.jsonl`, `2026-07-31.jsonl`; incidents `vault/Incidents/2026-07-30.jsonl`). Root-caused and fixed in Slice 2. Test suite 1742 → 1761, 0 fail. Note: "the white leg" in the operator's note was a voice-transcription garble for "the UI click is not **wired for the** electron" — there is no "white leg" anywhere in the codebase.

| Bug | Root cause | Fix | Files |
|---|---|---|---|
| **Click-inside-rendered-content gap** (Spotify native search/play, YouTube in-app, Electron HUD — "the wire for the electron") | `cua-driver` (element-addressed click binary) existed on disk but was wired to ONE private caller (Spotify), never exposed to the brain as a general tool | `from-cua.js` exposes `cua_list_windows`/`cua_bring_to_front`/`cua_get_window_state`/`cua_click` with OFFLINE-honesty; `main.js` wires them; binary resolves ONLINE | `mythos/src/core/effectors/from-cua.js` (new), `mythos/src/main.js`, `mythos/test/from-cua.test.js` (new) |
| **YouTube ad-blocker failing (10-15s pre-rolls)** | `fromPrebuiltAdsAndTracking(...).then(...)` never awaited before `loadURL`; cold-cache 7MB fetch finished after the iframe already fired ad requests | Await blocker init before `loadURL`; surface `.catch` failure honestly | `electron/main.js` |
| **Electron YouTube severely laggy (audio cuts every 1-2s)** | `backgroundThrottling` defaulted to true → iframe renderer throttled when unfocused | `backgroundThrottling:false` + `disable-background-timer-throttling`/`disable-renderer-backgrounding` switches | `electron/main.js` |
| **"Opened Chrome despite electron-only"** | `YOUTUBE_MODE` enum was only `embed`/`newtab` (no in-app intent), and Electron had no `setWindowOpenHandler` → default `newtab` fired `window.open(_blank)` → external browser | Add `'electron'` mode (new default) + `setWindowOpenHandler` that traps external opens | `mythos/src/core/config/schema.js`, `mythos/src/core/effectors/from-dashboard.js`, `electron/main.js` |
| **HUD stuck on "degraded" after self-heal** | Healer suppressed/restored tools but never transitioned the breaker FSM → `broadcastHealth` kept rebuilding it as open | Added `breaker.reset()`; healer calls it on `tool-restore` | `mythos/src/core/immune/breakers.js`, `mythos/src/core/effectors/hub.js`, `mythos/src/core/immune/healer.js`, `mythos/src/main.js` |
| **Goals die on spawn (`budget-exhausted` at creation)** | Planner's full ~107-tool catalog prompt was debited to the goal via `spentTokens: working.spendThisTick`, so each action re-charged for re-planning | Debit planner cost ONCE to the goal at plan time (`actions:0`); action carries only its own cost | `mythos/src/core/cortex/index.js` |
| **Fabricated success ("now playing", "I minimized Spotify")** | Corrective pass relied on the model choosing to admit failure; effectors returned unverified `sent:$true` | Deterministic honesty guard: when the entire turn failed, force a truthful frame regardless of model output; `show_desktop` result annotated with `scope:'all-windows'` | `mythos/src/core/voice/voice-agent.js`, `mythos/src/core/effectors/from-pc.js` |
| **Volume ducking self-sabotage (symptom)** | Current tree already saves/restores real pre-duck level; the "40/50/62" symptom was a stale premise. Made `DUCK_VOLUME_LEVEL`/`UNDUCK_SAFETY_MS` env-overridable for live tuning; restore logic unchanged pending live verification | Env knobs only | `mythos/server/index.js` |

**Not fixed (live-verification needed):** Tier 1a/1b/1c and the mic/YouTube-click fixes can only be fully verified by launching the real Electron app against real Spotify/YouTube — same caveat Slice 1 carried. The deterministic + honesty fixes are unit-tested.

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
16. ~~**BUG-028**~~ — `navigate` has no "news" route — ✅ LIVE-VERIFIED 2026-07-27 (see entry above)
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

**2026-07-17 stabilization session — queue status after the full pass:**

CLOSED this session: ~~BUG-038~~ (OEM-codepage JSON corruption — the real "nothing works" root cause), ~~BUG-004~~ (media widget fully live-verified incl. album art), ~~BUG-026/BUG-001~~ (Spotify actually plays — cua-driver 0.8.3 element clicks + verify-retry; user confirmed), ~~BUG-031~~ (real root cause: `$pid` read-only parameter — focus_window/ui_click/ui_elements/ui_type/close_window were ALL broken by it), ~~BUG-002~~ (compose bar live-verified), ~~BUG-019~~ (audit endpoint live-verified), ~~BUG-012~~ (session-scoped T3 grants; live voice check pending).

Still open, in priority order:
31. **BUG-029** — orphaned automation browser: pidfile mitigation shipped (kills orphans on next launch); proper D-07 graceful shutdown + live repro still open.
32. **BUG-027 / BUG-020 / BUG-021** — voice-only checks that need the user in a live session (TTS echo, mic noise, conversation tone) — see the guided acceptance list in the session notes. (BUG-028's "news" ask is no longer in this list — ✅ LIVE-VERIFIED 2026-07-27 via a scripted WS harness, no human needed.)
33. **BUG-037** — mitigated via repo CLAUDE.md rules; unenforceable by git, keep the discipline.
34. ~~**BUG-011**~~ — browser automation lazy auto-connect + on-demand launch both ✅ LIVE-VERIFIED 2026-07-27 (see entry above).
35. **BUG-024** — Gmail/Calendar: needs user's Google OAuth setup (code-level done).

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

---

## Session 4 (2026-07-17/18) — core repair + jarvis-class upgrade

Two separate build passes, both phase-gated (test-suite hold + commit + restart + live-verify per phase where possible):

**Core repair** (commits `53f96ee`..`2d8992a`): STT-failure honesty, audit-panel sync-read freeze fix, Spotify window retry backport, risk-tiered auto-approval (benign actions no longer confirm) + per-connection session grants, media widget transport controls + progress bar + art sizing, persistent quick-action chips, Engagements subsystem wired end-to-end (interview→spec→plan state machine only — stage-EXECUTION engine intentionally NOT built, flagged as follow-up), on-demand browser launcher, honest degradation warnings. All live-verified against a running server except two-tab confirm-isolation/proactive-speech-targeting and live voice/mic turns (code + new regression tests cover those instead).

**Jarvis-class upgrade** (commits `10ad982`, `72f36f5`, `da25c36`) — clean-room built in MYTHOS's own stack (Node/vanilla ESM), NOT copied from github.com/vierisid/jarvis (incompatible source-available license + unrelated stack). Independently gap-audited against the build spec after landing; all three genuinely implemented, no stubs, no fabricated logic:

36. **BUG-039 — Wake-word ("hey jarvis")** 🔧 CODED, not yet live-verified. Real 3-stage ONNX pipeline (melspectrogram→embedding→classifier) in `wakeword.js`, tensor shapes (1280-sample frames, 32 mel bins, 76-frame/stride-8 embedding window, 96-dim output) byte-verified against openWakeWord's actual `utils.py` source. Models are CC BY-NC-SA — fetched by `scripts/setup-wakeword.js`, never committed (gitignored same-commit as the script); `WAKEWORD_ENABLED=false` by default. Needs a live mic session: say "hey jarvis," confirm activation with no click and no re-trigger during TTS playback. **Live-verify:** manual voice session — see `docs/live-verification-runbook.md` §C1.
37. **BUG-040 — Ambient screen awareness** ✅ LIVE-VERIFIED 2026-07-24. Hash-gated vision sensor (`screen-sensor.js`) — identical screen skips the brain call entirely; privacy-audited paranoid-level, zero raw image/base64 ever touches disk. `ambient_awareness` voice tool (on/off/status) really toggles the running sensor. `SCREEN_AWARENESS_ENABLED=false` by default. **Live-verify harness:** `SCREEN_AWARENESS_ENABLED=true node scripts/verify-screen-sensor.js` — see `docs/live-verification-runbook.md` §A4. Real vision-brain description captured live: *"The user is playing the game 'Robot Factory' on TikTok, assembling or modifying a robot."* (mistral-large-2512, the first PREF_VISION entry); hash-skip held (exactly 1 event over 2 poll cycles on an unchanged screen). **A genuine wiring bug was found and fixed along the way (not screen-sensor-specific):** `server/index.js`'s generic `perception.*` -> WS relay read `p.payload.text`, but `p` (== `e.payload`) IS the sensor's emitted object already — there is no second nested `.payload` on it, so this was `undefined` for every sensor's broadcast, not just screen-sensor's (first live run showed `perception.screen` firing with `(no summary)`). Every sensor sets `summary`; only `perception.voice` additionally sets an untruncated `text`. Fixed to `text: p.text || p.summary` in `mythos/server/index.js`; `test/server.test.js`'s salience-gate test previously used a synthetic double-nested `{payload:{text:...}}` shape that coincidentally matched the bug and masked it — updated to the real flat sensor shape.
38. **BUG-041 — Daily planning + accountability** ✅ CODED + LIVE-VERIFIED (2026-07-21, re-confirmed 2026-07-24 via `scripts/verify-planner.js` — morning brief fires on first 60s tick, day file written with morningFiredAt, restart idempotence holds). Morning brief / stalled-goal check-in / evening review (`planner/daily.js`) built entirely on the existing Goals API (`goals.arbitrate`/`goals.list`, no reimplemented ranking); day-file idempotence line-traced and test-verified — a mid-day restart cannot re-fire the morning brief (fired-flags persisted in `vault/Plans/YYYY-MM-DD.json`, read fresh every tick). New 7th persona dial `strictness` (drill-sergeant tone at high values); pre-existing `persona.json` files missing the key are safely defaulted via the existing `loadLevels()` merge. **Live-verify harness:** `node scripts/verify-planner.js` — see `docs/live-verification-runbook.md` §A1. **Harness bug found + fixed 2026-07-24:** `verify-planner.js`'s `todayDateStr()` computed the date via `toISOString().slice(0,10)` (UTC) while `daily.js`'s `dateKeyFor()` (the actual day-file naming) uses local date components — for any host west of UTC, running the harness in the ~UTC+X hours after local midnight looked for yesterday's UTC-dated file and reported a false `planner did NOT fire`, even though `vault/Plans/<local-date>.json` had already been written correctly with `morningFiredAt` set. Fixed by switching `todayDateStr()` to local `getFullYear()/getMonth()/getDate()`, matching `daily.js` exactly; re-run after the fix: full PASS (fire + restart idempotence both hold).

| File | Change | Bug |
|---|---|---|
| `mythos/ui/public/js/voice/wakeword.js` | NEW — on-device wake-word detector, 3-stage ONNX pipeline | BUG-039 |
| `mythos/ui/public/js/voice/wakeword-worklet.js` | NEW — AudioWorklet, 1280-sample frame posting | BUG-039 |
| `mythos/scripts/setup-wakeword.js` | NEW — downloads CC BY-NC-SA models, never vendored | BUG-039 |
| `mythos/THIRD_PARTY_NOTICES.md` | Apache-2.0 attribution for ported openWakeWord pipeline | BUG-039 |
| `mythos/src/core/sensors/screen-sensor.js` | NEW — hash-gated ambient vision sensor | BUG-040 |
| `mythos/src/core/planner/daily.js` | NEW — morning brief / check-in / evening review scheduler | BUG-041 |
| `mythos/src/core/identity/index.js` | 7th persona dial `strictness` + DEFAULT_LEVELS merge | BUG-041 |
| `mythos/src/core/effectors/from-persona.js` | strictness trait synonyms | BUG-041 |
| `mythos/src/core/effectors/from-dashboard.js` | `daily_plan` tool (status/replan/skip_today) | BUG-041 |
| `mythos/src/core/leash/tiers.js` | +3 tools (`ambient_awareness`, `daily_plan`, plus core-repair's `browser_launch_debug`) | — |
| `MYTHOS-ARCHITECTURE.md` | §9 tier table resynced, byte-for-byte verified | — |

---

## Phase 2 — Wiring Integrity (task-957 §24 W1–W9 + D)

Landed on `phase2/wiring-integrity`, rebased onto `main` @ `66cb7e8` (Phase 1). 20 commits: 9 W-fixes + dead-code decisions + the W9 god-file decomposition (10 family commits) + a rebase-resolution commit. Each W-fix its own commit + regression test. Suite 1160 (Phase 1 baseline) → 1180 pass (the 2 baseline fails unchanged: `boot.test.js` SIGINT env + `eval/memory-impact` data-dependent).

**Rebase note:** Phase 2 was initially built against `main` @ `685dbaa` (pre-Phase-1) because the working clone's last `git fetch` predated Phase 1's push. After the operator flagged this, a `git fetch` confirmed Phase 1 was on `origin/main`, and the branch was rebased. The pre-rebase backup is at `phase2/pre-rebase-backup` @ `c9a9247`. Conflicts in `server/index.js` (W4 + W9 checkpoints/kanban/engagements) and the W7 skip (Phase 1 superseded it — see below) were resolved in the rebase.

### Resolved by Phase 1 (was "blocked-on-Phase-1" pre-rebase)

| Item | Status |
|---|---|
| W7 (engagement events via builders + executor dispatch) | **Phase 1 already did it.** Phase 1's `emitTransitionEvent` uses the real `events.js` builders with live record data, and the executor emits granular `stage_*` events. My W7 was redundant post-Phase-1 — correctly skipped on the rebase. |
| W9 engagements Phase-1 extras | **Resolved.** Phase 1's 4 engagement routes (list/get/transition/create) are extracted into the engagements factory with Phase 1's exact UI contract. The `phase5-merge-invariants` guard was updated to scan both `server/index.js` and `server/routes/engagements.js`. |

### Still deferred (post-rebase)

| Item | Why deferred | Resumes when |
|---|---|---|
| D — `assistant/{intent-router,response-planner,style,summary}` (~470 lines) | Test-only today, but Phase 4 autonomy may want them. | Phase 4 evaluation |
| D — `sensors/ws.js .ingest()` | Zero callers, but the module IS constructed in main.js. Pure deletion unwinds wiring; wiring the ingestion path is Phase 4 conversation-subscriber work (the W5-unblocked gateway emit is the natural subscriber). | Phase 4 |
| D — orphan `conversation.intent` event | W5 just unblocked the emit (it was permanently dead pre-W5). Removing it now would undo W5. | Phase 4 decides whether to subscribe |
| W10 — `/api/media/control` raw invoke | Deliberately deferred per W9 §4.4 — extraction-only in W9/media; the leash-check-but-no-audit fix is its own item. | Next pass |

### Pre-existing flakes found during Phase 2 (NOT introduced by Phase 2)

- **`test/engagements/events.test.js:43`** — ~~`assert.equal(event.timestamp, Date.now() || event.timestamp > 0)`. The `||` short-circuits on truthy `Date.now()` and compares `event.timestamp` against a fresh `Date.now()` call that's 0–1ms different. Flakes ~1/3 runs. Independent of Phase 2 (passes in isolation). Fix: `assert.ok(event.timestamp > 0)` — separate cleanup.~~ **✅ RESOLVED 2026-07-21** — fixed in commit `23165ad` (verify/live-sensor-and-flakes branch). Replaced with `assert.ok(event.timestamp > 0)`.

- **`test/boot.test.js` Windows SIGINT race + `test/eval/memory-impact.eval.js` date-window rot** — **✅ RESOLVED 2026-07-21** (same commit `23165ad`). The boot test now accepts `exitCode === null` on win32 (Node's signal-emulation failure for detached piped-stdio spawns). The eval was NOT operator-vault-dependent as long believed — it was date-relative rot (records pinned to `2026-07-12` aged past the 7-day window). Re-anchored at `Date.now()` with the same relative offsets. Suite now 1294/1295 (0 fails, 1 skip).

### W9 acceptance (post-rebase, honest residual)

server/index.js shrank from 1674 lines (Phase 1's version, which grew the god-file slightly with its 4 engagement routes) to 1295 lines across the 10 family extractions; 49 → 14 `app.*` calls. The residual is the WS layer + voice turns + vision + proactive speech + TTS + camera broker + confirm/checkpoint flows + middleware + `/health` + `/api/status` — all mandated to STAY by W9 rule §4.2 #5/#9. The remaining `app.*` calls are the must-stay set (middleware + identity routes + voice transcribe + 404/SPA/error). This is the honest floor for the W9 scope. The §4.3 "~600 line" target would require extracting the WS layer too, which §4.2 #5 explicitly forbids in Phase 2.

---

## Phase 3 — run_command (V7) + Engagement/Forge Wiring + BUG-029/024

Landed on `phase3/run-command-and-cleanup`, branched off `phase2/wiring-integrity` @ `2714407`. 7 commits: run_command effector (V7 core) + executor verify wiring (with a pre-existing-bug fix split out) + Forge verify wiring + BUG-029 hardening + BUG-024 OAuth docs + this docs commit. Suite 1180 (Phase 1+2 baseline) → 1197 pass (+17 net tests; the 4 baseline fails unchanged — boot.test.js SIGINT env + 3 eval/memory-impact data-dependent, all confirmed pre-existing on main).

### What landed (per piece)

| Piece | Commit | What |
|---|---|---|
| 1 — run_command effector | `62c69f4` | T3 effector: 5-layer safety (allowlist, shell-metachar reject, cwd pin, env scrub, timeout). New `from-runner.js` + `adapters/command-runner/`. Count gate 71 → 72. |
| 2a — makeDispatchCtx fix | `0c60a12` | Pre-existing Phase 1 bug surfaced by Phase 3: executor's dispatch ctx hardcoded `effectors: null`, would have NPE'd on any T3 action-stage dispatch. Threaded the real hub through. |
| 2b — executor verify-stage | `2fba6ed` | Replace the SKIPPED-command branch with a real run_command dispatch (allowlist-gated, leash-checked). Empty allowlist preserves pre-Phase-3 behavior. |
| 3 — Forge verify-stage | `7b1ab4e` | `finishGenerateStage` runs `manifest.verify.command` via run_command before arming final-review. Failure routes into mid-build-decision. |
| 4a — BUG-029 hardening | `9a4f5ea` | `browser_launch_debug` now records its PID (was the orphan gap); `.bat` verifies launch provenance before tree-kill. |
| 4b — BUG-024 docs | `48b3684` | Added `calendar.readonly` scope to `google-auth.js`; new `docs/google-oauth-setup.md` operator walkthrough. |

### Honest caveats

- **run_command is v1, not a sandbox.** Per task-957 handoff: allowlist + timeout + shell-metachar reject. A malicious allowlisted command can still do damage inside its cwd — the allowlist is the trust boundary. A real sandbox (seccomp, seatbelt, container) is a later phase.
- **Live OAuth pass still operator work.** This commit ships the doc + the scope fix; the operator must actually run `scripts/google-auth.js` and verify Gmail/Calendar work end-to-end.
- **Live verification of BUG-029 hardening still operator work.** The pidfile write + `.bat` provenance check are coded; the operator should force-kill MYTHOS mid-browser-session and confirm the next boot cleans up the orphan without touching their own Chrome.
- **The eval/memory-impact baseline fails** are still pending — those are data-dependent tests that need a populated vault. Not Phase 3's scope.
- **The Phase 3 scope excluded the operator-hardware live passes** for BUG-039/040/041 + barge-in + BUG-020/014/027/028/006 (per the task-957 §26 Phase 3 list). Those are tracked separately.

### Verification

```bash
git checkout phase3/run-command-and-cleanup
cd mythos && npm install                # exceljs + pptxgenjs (Phase 1) + the existing deps
cd mythos && node --test                # expect 1197/1202 (4 documented baseline fails)
node src/main.js                        # expect MYTHOS ALIVE, effectors.ready count:100
```

`effectors.ready count` rose from 99 (Phase 1+2) to **100** — the new run_command effector.

### Phase 4 preview (per task-957 §26)

Phase 4 is autonomy advancement (biggest leverage first, all respecting idle-skip):
- Execution→learning loop — `skills.recordUse()` in the dispatchAction completion path; goal-completion/consolidate-time procedure distillation into Skills; `plan()` consults procedures with real successRate, executes multi-step procedures, persists brain plans into `goal.plan` (V2, V3 — the deepest cut).
- Memory on the autonomous path — orient→recallHybrid for high-salience perceptions; hybrid skill recall; consolidate dedup/contradiction (V1, V10).
- Proactivity that acts — `mull()` → `propose_goal` suggestions; calendar-event perception; opt-in active-window sensor (V5, V8).
- `reflect()` analyzes last-N outcomes → recurring failures to diagnostician, successes to Skills (V9).
- Brain-driven interview/spec/plan with template fallback (V6 cognition).


## Phase 4 — Autonomy Advancement (task-957 §26)

**Status:** ✅ CODED (2026-07-20) — 13 commits on `phase4/autonomy-advancement`, 1290/1295 tests pass (4 baseline fails unchanged). Full vision-gap close-out in `MYTHOS_Phase4-Autonomy_Handoff.md`. Live operator verification: see "Honest caveats" below — a 2026-07-27 pass closed 3 of the 4 named gaps and found the remaining one (mull→propose_goal routing) structurally broken, not merely unverified.

### Latent bugs surfaced + fixed (Area A foundation)

Three bugs had silently disabled the execution→learning loop since the goal system shipped. The closing integration test (`test/phase4a-loop-integration.test.js`) would have caught all three in one run if it had existed:

- **B-1 (goals/index.js:215)** — `skills.recall({query,limit})` passed an object where the signature expected a string (`recall(query, opts)`). `query.toLowerCase()` → TypeError → swallowed by the surrounding try/catch → procedural-skill branch silently dead since day one. The "V3 plan() consults Skills" feature looked shipped but had never fired once.
- **B-2 (goals/index.js:216)** — `skill.successRate` was tracked by recordUse() but no planner ever read it. plan() gated purely on keyword-overlap score, so a procedure that consistently failed would be replayed forever.
- **B-3 (goals/index.js:57)** — `goal.plan: []` initialized + read but never written to. The plan-step reader at the top of plan() was dead code; procedural-skill recall returned ONLY step[0] every tick.

Fix shipped in commit `6505f93` (B-1 + B-2 + skills.recall signature) + `03c4eb7` (B-3 + multi-step plan persistence).

### What landed (per vision gap)

| Gap | Spec text | Commit | Status |
|---|---|---|---|
| V1 | orient→recallHybrid + per-tick cache | `055d408` | ✅ Cortex consults memory on the autonomous path; 1 embeddings call per non-idle tick, zero when idle |
| V2 | skills.recordUse() in dispatchAction | `f475307` | ✅ Loop closed: planner picks skill → dispatch records outcome → EMA successRate updates → next plan call respects new rate |
| V3 | plan() consults successRate, multi-step procedures, goal.plan, completion distill | `03c4eb7` + `b2e70c8` | ✅ Multi-step procedures advance; successful goals distill into Skills |
| V5 | propose_goal + one-tap acceptance | `a27b980` | ✅ Cortex SUGGESTS goals; operator accepts/rejects via dashboard; never auto-activates |
| V6 | brain-driven interview/spec/plan | `6abd921` | ✅ All three builders have brain seams with honest-inert fallback |
| V8 | mull→propose_goal + calendar perception + opt-in window sensor | `2c5f969` + `19a8925` + `cf3406c` | ✅ Cortex acts during idle; events enter OODA; opt-in window-title sensor |
| V9 | reflect() → diagnostician + Skills | `bc64aa0` | ✅ Action-outcome reflection on its own cadence |
| V10 | consolidate dedup + contradiction | `c7a2379` | ✅ One bounded brain call merges accumulated consolidated-* topics |

### Honest caveats

- **No autonomous goal-completion trigger** — `goals.complete(id)` API exists but no cortex path calls it autonomously yet. Deciding when the cortex is allowed to declare success is a Phase 4.5 design call.
- **No engagement-transition brain driving** — the transition handler stays synchronous (canned paths). The brain-driven methods are surfaces for cortex/gateway/future orchestrator; this keeps the existing phase1-engagement-executor.test.js harness (which bypasses interview/spec) working unchanged.
- **Status:** ✅ LIVE-VERIFIED (2026-07-27) — calendar-upcoming-sensor (V8a): a real seeded reminder was perceived and written to the episodic log end-to-end (`mythos/scripts/verify-calendar-upcoming-sensor.js`). Opt-in window-sensor (V8b): a real OS foreground-window change (driven via pc-child/`ps-automation.ps1`) was relayed over the WS `perception` broadcast with the correct summary (`mythos/scripts/verify-window-sensor.js`). propose_goal dashboard accept/reject click flow (V5, UI half): real Accept/Reject clicks in a real headless Chromium flipped on-disk goal status to `active` and deleted the rejected proposal's JSON file, through the real REST routes (`mythos/scripts/verify-propose-goal-ui-click.js`). All three re-run and adversarially rechecked as genuine (no mocks, no stale/replayed state).
- **Live-tested 2026-07-27 and found BROKEN, not merely unverified** (`mythos/scripts/verify-propose-goal.js`, `mythos/scripts/verify-mull-propose-goal.js`): both the `mull()`→`propose_goal` idle-branch routing (V8c) and the backend suggestion-generation half of V5 are structurally unreachable. `cortex/index.js`'s `if (perceptions.length === 0 && !hasActive)` gate — the only call site for `mull()` — never opens in real operation, because `sensors/timer.js` unconditionally emits a `perception.tick` heartbeat every tick that main.js's unfiltered `bus.subscribe('perception.*', ...)` queues into the same perception buffer the gate inspects, so `perceptions.length` never reaches 0 in steady state. Confirmed on live boots (45/45 and 65/65 real ticks observed, never 0 perceptions) and corroborated by a separate check showing the configured brain model DOES return real proposals when `mull()`'s exact prompt is called directly — the gap is that `mull()` is never invoked, not that the model declines. This needs a real fix (e.g. excluding the timer's own heartbeat from the idle-perception count), not another verification pass.
- **The boot + eval baseline fails** remain (boot is the Windows-SIGINT test flake, eval/memory-impact are data-dependent tests that need a populated vault). Unchanged from Phase 3.
- **The pre-existing flake at `test/engagements/events.test.js:43`** still intermittently fires under suite load (~1/3 runs). Independent of Phase 4. Same `Date.now()` race documented in Phase 2.


---

## Session (2026-07-31, overnight) — first real voice session + Electron/S2S bring-up

Operator held a ~70-minute voice conversation (35 turns, 23:22–00:33) and reported two problems; the entity had itself logged three incidents (`vault/Incidents/2026-07-31.jsonl`). All were real. Every diagnosis below came from that session's own recorded data, not from a plausible theory. Commits `0cd4e4d`, `966545f`, `aa6a354`, `7e6a60d`.

| Bug | Root cause | Fix |
|---|---|---|
| **The entity was two different people.** "At the starting there is this British guy, male accent… but then comes the female voice." | Three engines speak in one session and nothing kept them matched: `VOICE_TTS_VOICE` = `en-GB-RyanNeural` (male), `GEMINI_LIVE_VOICE` = `Aoede` (female), and the browser `speechSynthesis` fallback set **no voice at all**, inheriting Windows' Microsoft David (male). Each module was individually defensible — only the *set* was wrong, which is why nothing ever failed. | `en-GB-SoniaNeural` + `Aoede` + a pure `pickSpeechVoice()` preferring en-GB female (returns `null` rather than actively selecting a male voice). `test/voice-identity-consistent.test.js` pins the two engine defaults **as a pair**. New voice verified real by synthesizing 17,856 bytes through the live sidecar. |
| **"Speech consistently cut off at the end, losing the last one or two words."** | NOT text truncation — all 29 replies round-trip `splitSentences()` losslessly, longest 628 chars vs an 800 cap. The decisive clue was the clock: session ran 23:22–00:33, `edge_tts` was not installed until 04:01, so TTS was down for **every turn**. `sendSpokenReply()` computed `ttsUp ? splitSentences(speak) : []` → zero chunks → the client spoke the ENTIRE reply as one `SpeechSynthesisUtterance`, and Chrome truncates long ones. The comment directly above already described the correct behaviour and `playNextChunk()` already had the text-only branch; the code disagreed with its own comment. | Always split; synthesize only when `ttsUp`. Fixed in **both** callers — `proactiveSpeak` too, since the boot greeting rides it. AD-5 preserved (latency sampled only from chunks that shipped real audio). `test/tts-down-sentence-chunks.test.js`; its red run reported exactly "got 0 chunks". |
| **Narrated playback from memory** — claimed "COME DOWN" was playing when "SHE DON'T NEED TO KNOW" was. | Mechanically fine: `media_status`/`spotify_status` both declare `needs_result:true` and P3-8 forces a re-derive for any tool that does. The gap was the prompt — grounding rules existed for the outside world, artifact paths and dependent calls, but none for the state of the machine itself. | New **DEVICE STATE RULE** mirroring WEB GROUNDING, including "the tool wins over your earlier claim" — the observed failure was the entity *defending* the stale claim. |
| **Deleting a goal did not delete it, and it came back.** `DELETE /api/goals/:id` → 200, audited `'ok'`, goal still listed with `id: null` (unaddressable forever). | `writeBack()` rebuilds Goals.md **from its existing rows**, so it can never remove one; the row survived unmapped. Worse: `sync()` creates a user-service goal for every unmapped row at boot, so the goal was **resurrected on restart**. | `deleteGoal()` captures the rows the id owns *before* dropping the mapping (afterwards they are unidentifiable — that is the bug) and removes them. `test/goal-delete-removes-row.test.js` proves the resurrection path specifically. |
| **`truncateAtSentenceBoundary()` was dead code** — defined, exported, called by nothing — while four paths hard-sliced spoken text mid-word. Its own file header claimed it was "live". | Never wired since it was written. | All four call sites now use it (boot greeting, vision reply, and voice-agent's `say` + fallback caps). |

### ⚠️ CORRECTION 2026-07-31 (later the same day) — the clipping diagnosis above is WRONG

The "speech cut off at the end" row states edge-tts was down for every turn and the reply therefore went out as one long `SpeechSynthesisUtterance`. **Both halves are false.** Two errors compounded:

1. **Timezone.** `ls --time-style` prints LOCAL time; a literal `Z` had been appended to the format string and the result was then read as UTC. In real local time (machine is UTC+5:30): `edge_tts` was installed at **04:01**, the session ran **04:52–06:03** — so edge-tts was live *before* the session, not 3.5h after it.
2. **Wrong transport entirely.** Every conversation record carries `detail.transport`. **43 of 44 turns were `s2s`**, not batch — the lone `batch` entry is a test probe. The S2S path plays PCM through `pcm-player.js` and never touches `speechSynthesis`, so the browser-utterance theory cannot apply.

**What is actually true:** the boot greeting rides `proactiveSpeak` → edge-tts → `en-GB-RyanNeural` (male); every turn after it rode S2S → `Aoede` (female). That is the real, fully-evidenced explanation of the operator's "British guy at the start, then the female voice" — and the Ryan→Sonia change remains the correct fix for it.

**The clipping cause is therefore still OPEN.** On the S2S path exactly one thing stops audio: `live-interrupted` → `player.flush()` (`s2s-bridge.js:77`). Gemini Live's own server-side VAD (`realtimeInputConfig.automaticActivityDetection`) emits `interrupted` when it believes the user has begun speaking; music or room noise trips it and playback is cut mid-sentence. The same session's incident log independently records *"Playback interruption … interrupted by user singing/feedback"*, which is the same mechanism. **Not yet proven and not fixed** — proving it needs the `live-interrupted` frames counted against a turn that the operator confirms was clipped.

The per-sentence chunking fix shipped in `0cd4e4d` is still a real bug fix (sending zero chunks when TTS is down genuinely does produce one over-long utterance) — it simply is not the fix for THIS report, and was mis-attributed as such in that commit message and in the roadmap row for it.

**NOT fixed, deliberately — acoustic, needs a human present.** The third incident (playback interrupted by the operator singing / speaker feedback) cannot be fixed in-browser: the mic already requests `echoCancellation`, `noiseSuppression` and `autoGainControl`, and browser AEC cannot cancel Spotify because it is a **separate process**. Barge-in is level-based and fires before transcription, so `isEcho()` (a post-hoc text match) cannot catch it either.

### Electron bring-up findings (`npm install` + `npm start`, first real boot)

- **⚠️ OPEN — the ad-blocker from `5a64d88` is INERT on the pinned Electron.** This qualifies the "YouTube ad-blocker failing" row in the Slice 2 Hardening session above: awaiting `fromPrebuiltAdsAndTracking(...)` before `loadURL` was a correct fix for a real race, but it cannot take effect, because initialization itself throws first: `adblocker init failed — continuing WITHOUT blocking (YouTube pre-rolls will play): this.session.registerPreloadScript is not a function`. `@ghostery/adblocker-electron@2.18.1` calls `session.registerPreloadScript`, an API **absent from Electron 32** (zero occurrences in its `electron.d.ts`). The package's peer range is `"electron": ">11"`, which is wrong, so npm never warns. It degrades honestly (AD-9) rather than crashing, but **no blocking happens**. Two options, both with consequences the operator should choose between: bump `electron` to ≥35 (a three-major jump against Slice 1 and an unbuilt installer), or pin the adblocker to a release predating that API. **Not changed unilaterally.**
- **`electron`'s postinstall extraction fails SILENTLY on this machine.** `npm install` exits 0, the 108MB zip downloads and caches correctly, but `node_modules/electron/dist/` ends up containing only `locales/` and no `path.txt` — surfacing later as `Error: Electron failed to install correctly`. Workaround: extract the cached zip by hand (`$env:LOCALAPPDATA\electron\Cache\<hash>\electron-v<ver>-win32-x64.zip`) into `dist/` and write `path.txt` containing `electron.exe`. Worth knowing before Slice 4 builds the installer.
- **`ELECTRON_RUN_AS_NODE=1` inherited from a VS Code extension host makes `electron.exe` run as plain Node**, so `require('electron')` returns the npm path shim and every destructured API is `undefined` — crashing at `electron/main.js:167` on `ipcMain.handle`. Not a MYTHOS defect; launch with that variable cleared.
- **Verified working:** window titled "MYTHOS", forked child server on `127.0.0.1:4478`, HUD served, `/js/app.js` 8,800B gzipped (the perf work carries into the desktop app), `/api/config/s2s` → `{"enabled":true}`.

---

## Session 2026-07-31 (later) — brain smartness + build pipeline

Four operator reports, all root-caused to code rather than to model quality.
Every entry below is ✅ FIXED with tests unless marked otherwise.

### BUG-047 — "It forgets what we were talking about" (in-session)

**Symptom.** Mid-conversation, MYTHOS loses the thread; sometimes it forgets a
build it started three turns earlier.

**Root cause — three defects in one 16-line block** (`mythos/server/index.js`,
the conversation-history block):

1. The history lived inside `wss.on('connection', ...)`, so it was
   **per-connection** state. The dashboard reconnects on any network blip or tab
   sleep (`ui/public/js/ws.js` `scheduleReconnect`), and each reconnect silently
   started an empty conversation. This is the one that produced the complaint.
2. `HISTORY_MAX_TURNS = 12` counted **mixed** entries (user + assistant +
   action-outcome notes) — roughly 4-6 real exchanges.
3. A 10-minute idle TTL wiped everything, and nothing survived a restart.

**Fix.** Hoisted to `createServer` scope; 40 entries bounded by a 12000-char
total budget (real voice turns run 50-400 chars, so this holds ~12-18 exchanges
while costing LESS at the worst case than the old 12 x 2000 = 24000-char
ceiling); idle TTL 45 min; persisted to `vault/Conversation/session.json` and
restored when younger than the TTL. `VOICE_HISTORY_MAX_TURNS` /
`VOICE_HISTORY_MAX_CHARS` added to the schema.

**Gotcha for anyone editing this block.** The `memory.fs.readJSON/writeJSON`
calls MUST stay inside `try/catch`: the server test fakes expose only
`memory.fs.vaultPath`, so an unguarded call is a `TypeError` on every turn across
the whole server suite. Same guard shape as the `LAST_BOOT_PATH` read above it.

**Tests.** `test/voice-session-memory.test.js` (6 cases, real bus/server/WS).

### BUG-048 — Durable facts evicted by trivia (cross-session)

**Symptom.** It forgets things it was explicitly told days ago, while remembering
recent noise.

**Root cause.** `persona()` folded in `topLearnedPrefs(5)`, and that list is
**newest-first**. A day-one durable fact was pushed out by five newer
preferences. Raising the cap only delays the eviction.

**Fix.** New pinned `Identity/operator-profile.txt` on the proven
`operator-style.txt` pattern, folded into `persona()` as "Operator profile
(durable facts — never contradict these)". `identity/reflection.js` REWRITES it
whole each pass, preserving everything still true — that is what makes it
accumulate *and* self-compact with no append log and no eviction policy. A
too-short model reply can never blank an existing profile. Preference cap 5 -> 10;
reflection's conversation window 2 -> 7 days. Recall widened from 8 hits/7 days to
12/21 (measured +20ms on a real 2.2MB vault; 21 days stays inside
`EPISODIC_RETENTION_DAYS`).

**Tests.** `test/persona.test.js`, `test/reflection.test.js`.

### BUG-049 — Replies feel like "just another chatbot"

**Root cause.** Not the model. `RULES` in `voice-agent.js` carried ~39
prohibition tokens against 3 permissions, so the prompt itself trained
disengagement. Two specific offenders: the FRUSTRATION RULE fired on **any**
frustration, so venting about the world was answered with a `read_status` +
`list_goals` probe; and CLARIFYING QUESTIONS had no "they are just chatting"
branch.

**Fix.** A `CHARACTER` block placed FIRST (where the model weights it) granting
opinions, dry wit, teasing and callbacks; FRUSTRATION scoped to frustration with
MYTHOS/the system; MEMORY RULE's no-write path no longer reads as no-engagement;
CLARIFYING QUESTIONS tells it not to interrogate small talk; `OUTPUT_CONTRACT`'s
style line (last in the prompt) says personality is expected. Dial VALUES
untouched — the tests pin them and the `terseness:5` rationale is deliberate.

**Cost note.** `RULES` 15051 -> 16162 chars. A test caps it at 18000 so future
prompt edits stay deliberate: this string is re-sent on EVERY voice turn.

**Not unit-testable.** Whether it actually *feels* witty is only answerable by
talking to it. The tests assert the permissions are present and the contract is
intact.

### BUG-050 — `cortex.thought` had zero subscribers (no proactivity)

**Symptom.** MYTHOS never follows up on a loose end unprompted.

**Root cause.** `cortex/index.js` has emitted `cortex.thought` after every
productive idle mull since Phase 4. **Nothing subscribed to it.** The entity
formed follow-up thoughts and never said one; they surfaced only as prompt
context if the operator happened to speak first. Separately, the pending-thought
injection had no consumption marker, so one thought was prepended to **every**
prompt for 24h — an "earlier I noticed..." that read as a stuck record.

**Fix.** One subscriber -> the existing `proactiveSpeak` path (same event class as
`reminder.due`), behind four guards: `priority === 'high'` only, nothing within
`FOLLOWUP_QUIET_MS` of the operator's last turn, at most one per
`FOLLOWUP_MIN_GAP_MS` (0 disables), non-empty text. The mull prompt now reserves
"high" for the two cases worth breaking a silence over: a question the operator
never answered, or a stalled goal/build. Thought injection now de-dupes by
record ref.

**Known limitation, documented not fixed.** `mull` only runs on fully-idle ticks
with no active goals (`cortex/index.js`), so follow-ups stay quiet while a goal
is active. Changing that is a cortex-tick change, not a conversation change.

**Tests.** `test/proactive-followup.test.js` (6 cases).

### BUG-051 — Builds shipped content from the engine the repo had already retired

**Symptom (operator's words).** Builds fail "drastically"; the few that land are
"ugly as shit", blank, or about the wrong topic entirely.

**Root cause.** Commit `37953ca` made Hermes-Agent the single build-content
engine "so there is one engine with one behaviour", precisely because the
brain-backed generators invented titles and topics (the fabricated "Week of
November 20, 2023" page in `build-engine.js`'s header; live failures where a
"DESIGN SYSTEM" spec shipped as "Kinetic Depth | Parallax Engine"). That commit
wired `build-runner.js` and the engagement executor — **it never touched
`agent-actions.js`**. So the Hermes first draft was then OVERWRITTEN by a direct
`brain.think({lane:'build'})` call in two places: the research-grounded
regeneration and the review-rejection retry. Both fire for `risk='feature'`,
which `risk-classifier.js` assigns to nearly every real request ("landing page",
"dashboard", and the verbs build/create/design). Net effect: the artifact the
operator actually received came from the exact engine the swap existed to retire.

**Fix.** One `generateContent()` seam in `agent-actions.js` routes all four
regeneration sites through `buildEngine.generate()`; `main.js` injects the
engine. `buildEngine`'s own guarded brain fallback still covers a transient
Hermes outage, tagged `engine:'brain-fallback'` with a `health.anomaly` rather
than silently. Hermes has no `persona` parameter, so the kanban builder voice is
folded into the prompt instead of being dropped.

**Tests.** `test/build-single-engine-regeneration.test.js` (4 cases).

### BUG-052 — Every text build silently ran on a 3-minute timeout

**Root cause.** `build-engine.js` passed `timeoutMs: o.timeoutMs` and **no
caller has ever set it**, so every build inherited the hermes adapter's generic
`HERMES_TASK_TIMEOUT_MS` (180000). Meanwhile `hermes-runner.js` — the other
Hermes path — gives its builds 30 minutes because (.env.example) "builds run a
real agent loop and need real headroom". A grounded build stacks research +
skill resolution + a possible review-retry into that one budget.

**Fix.** Defaulted inside `build-engine.js` (`HERMES_TEXT_BUILD_TIMEOUT_MS`,
10 min) rather than threaded through three call sites, so no caller can forget
it. Below hermes-runner's 30 min: this path generates one artifact, not a tree.

### BUG-053 — Built pages had no images, by construction

**Symptom.** "There are no pictures. There is nothing. It is just blank pages."

**Root cause.** There is **no image or asset step anywhere in the build
pipeline** — no `generate_image` reference in `agent-actions.js`, and nothing in
`design/system.js` about placeholder assets. Worse, `DELIVERABLE_PREAMBLE` said
"no external resources", which reads as "no pictures at all". Whatever imagery
appeared was whatever the model happened to invent. The standalone
`generate_image` tool cannot fill the gap either: its own header records that the
configured free-tier Google key has a **permanent zero-quota entitlement** for
every image model.

**Fix (free, keyless).** A `VISUALS` section in both build preambles: inline
`<svg>` for logos/icons/patterns, `https://picsum.photos/seed/<word>/<w>/<h>` for
photographs, an explicit ban on inventing `images.unsplash.com/photo-<id>` URLs
(those ids are real — a guessed one 404s into a broken image), real `alt` text,
and CSS sizing so a failed load degrades gracefully. The blanket "no external
resources" is narrowed to images-only while CSS/JS stay inline.

**Still open (operator decision, not a code bug).** Real image *generation* needs
a paid key. Not attempted.

### BUG-054 — Installed skills reached builds only partly

**Root cause.** The 2026-07-31 multi-root loader fix (`7d95f42`) was real but
incomplete in two ways:

1. `pluginRoots()` searched `<pack>/src` and `<pack>/.claude/skills` but not
   `<pack>/skills` — a third layout real packs use. A skill in an unsearched
   layout fails exactly like an uninstalled one: silently.
2. `loadEssence()` read ONLY the repo-vendored
   `mythos/skills/<name>/SKILL-CORE.md`. Since essences are what get
   auto-injected into every build prompt, a skill cloned from GitHub was visible
   to `use_skill` but absent from the automatic injection — the operator's "add
   skills from GitHub in future" requirement could not work.

**Fix.** Third layout added; `loadEssence()` falls back to the head (~40 lines /
4000 chars) of an installed skill's own `SKILL.md`, frontmatter stripped. A
vendored essence still wins, so a fresh clone stays deterministic.

**Live-verified on this machine** (not just unit-tested): the allowlisted catalog
went **9 -> 15 skills**, and `resolveSkillTool()` returns **2596 chars** of real
ui-ux-pro-max design-system output (pattern, style, palette) that is prepended to
UI build prompts, alongside 3797 chars of skill essences.

**Tests.** `test/skills-external-roots.test.js` (6 new cases).

### BUG-055 — One chunk spoken twice: the "5-6 word repetition"

**Reported by the operator 2026-07-31**, mid-session: "the voice glitches, I am
hearing 5-6 words repetitions". Two separate defects were behind it; this is the
first.

**Root cause.** `voice-loop.js`'s `playNextChunk()` wired the same unguarded
fallback to two handlers:

```js
audio.onerror = () => speakChunkFallback(chunk.text, session, onOneDone);
audio.play().catch(() => speakChunkFallback(chunk.text, session, onOneDone));
```

An `<audio>` element whose data fails to decode does BOTH — fires `error` and
rejects the pending `play()` promise. That is specified resource-selection
behaviour, not an edge case. `speakChunkFallback()` **queues** a
`SpeechSynthesisUtterance` rather than replacing the current one, so the chunk
(one sentence, i.e. about 5-6 words) was spoken twice back to back.

The same double fire also called `onOneDone` twice, advancing the chunk queue
by two and **skipping the next chunk**. Landing on the second-to-last chunk
silently dropped the end of the reply — which is the *"speech consistently cut
off at the end, losing the last one or two words"* the entity logged as an
incident earlier the same day. `test/tts-down-sentence-chunks.test.js` fixed a
different cause of that symptom (zero chunks sent while TTS was down); both are
real, and this is the one that survives with TTS up.

**Fix.** `createChunkCompletion()` — exported and pure, the same testability seam
as `decideBargeIn()`. A chunk now advances the queue at most once and falls back
to `speechSynthesis` at most once, and a late error after successful playback is
ignored instead of re-speaking what was already heard.

**Tests.** `test/voice-chunk-double-speak.test.js` (6 cases, including a
source-shape gate so an unguarded handler cannot be re-wired).

### BUG-056 — MYTHOS talks to itself: own TTS fed back into the Live mic

**The other half of the repetition report**, and the more consequential one.

**Root cause.** In S2S (Gemini Live) mode the microphone streams continuously
while MYTHOS's *server-side* TTS — the boot greeting, reminders, build
announcements, idle thoughts — plays out of the speakers from a **separate**
`<audio>` element (`voice-loop.js`'s chunk queue). Gemini hears it, transcribes
it as the operator, and answers itself.

**Evidence, not theory** — `vault/Episodic/2026-07-31.jsonl`, three consecutive
user-role transcripts:

```
06:37:43  User: Sir. All systems are online and the build is green.
06:37:50  User: Yes, go go ahead. Good afternoon. Sir, all systems are online and the build is green.
06:38:04  User: Good afternoon, sir. All systems are online and the build is green.  | MYTHOS: Very good, sir. ...
```

That is the entity's own boot greeting arriving as operator speech, with a reply
generated to each. `getUserMedia`'s `echoCancellation` was already on
(`mic-device.js`) and did not stop it on speakers.

`s2s-bridge.js`'s header explicitly declines an echo guard for S2S, and that
reasoning is still correct — but it only covers a **text-similarity** guard on
transcripts, which would fight the model's own VAD over what the operator said.
It never covered "we are knowingly making noise ourselves right now".

**Fix.** A half-duplex gate: `setCaptureSuspended()` drops mic frames (stream
stays open — no permission churn, no worklet teardown, mic indicator stays
honest) while the voice loop reports state `speaking`, which is set only by our
own TTS playback and never by the bridge. It **fails open** after
`MAX_SUSPEND_MS` (30s): a `speaking` state that never clears would otherwise
leave Live permanently deaf with no symptom except silence.

**Known trade-off, deliberate:** voice barge-in over a *proactive* announcement
is not possible while the gate is closed. The hotkey and the HUD still stop it,
and the alternative is the model interrupting itself, which is strictly worse.

**Tests.** `test/voice-chunk-double-speak.test.js` (3 source-shape cases — the
bridge's own header documents why it has no meaningful Node-side double).
**Needs live confirmation by the operator**, ideally once on speakers and once
on headphones.

### BUG-057 — The article copy was choosing the design system

**Reported by the operator 2026-07-31** with the artifact attached: a news digest
that "does not match" the requested dark-theme/ui-ux-pro-max expectation. It was
worse than a miss — it shipped a **pricing section** and an **ISO/SOC2/GDPR badge
carousel** on a news page, in monospace type.

**Root cause.** `build-pack.js` passed the WHOLE card text to ui-ux-pro-max's
`search.py`, which keyword-matches the entire query string against its pattern /
style / typography databases. The card text was mostly *article copy*, so the news
content picked the design:

| Words in the copy | What the skill returned |
|---|---|
| "price-performance" | pattern **Pricing Page + CTA** — sections: price cards, comparison table, FAQ |
| "security tests", "breach" | style **Trust & Authority** — "certificates/badges displayed, security badges" |
| "agents", "systems" | typography **JetBrains Mono** for heading AND body, mood "terminal, hacker, matrix" |

Verified by re-running the same brief with the content stripped: **Newsreader /
Roboto** and an editorial section order, no pricing, no badges.

**Fix, three parts.**
1. `designQuery()` sends the design intent only — the leading design sentence,
   cut at the first content marker ("main feature", "headline:", "supporting
   stories", …), capped at 160 chars, plus any style word ("dark-themed",
   "glassmorphism") that appears later and would otherwise be lost with the copy.
2. `--stack html-tailwind` is now passed, matching what the pipeline actually
   emits, instead of taking generic guidance.
3. The build preambles state the precedence that was missing: a design-system
   block is **colour/type/spacing/effects, not a content outline** — the idea
   decides which sections exist and **the idea wins**. Sections the brief never
   asked for must be left out.

**Also fixed: dark themes looked muddy.** Every palette the skill returns is
light-first (Background `#FFFBEB`, Foreground `#0F172A`). Asked for a dark theme,
the model simply swapped those two — amber-800 accents on near-black. The preamble
now says to derive a real dark ramp (near-black neutral surface, elevated card
steps, foreground ≥ `#E6E8EB`, accent hue kept but lightened until it clears
4.5:1) and never to invert a light palette.

**And the reviewer was blind to it.** It checked five things, all about *missing*
or *wrong* content — nothing about content **nobody asked for**, which is why it
approved a pricing table on a news site. It now flags extra sections as defects.
(For the record, the reviewer did catch real problems on that build and correctly
rejected it: inconsistent branding, a missing story, an unsupported statistic.)

**Tests.** `test/design-query-intent.test.js` (10 cases).

### BUG-058 — Every build failed as "hermes-agent not installed" on a busy machine

**The likely explanation for the operator's "everything fails" and "tens of
thousands of attempts".** Measured 2026-07-31 while MYTHOS was running:

```
$ time hermes --version      # the adapter's availability probe
real  0m21.212s              # probe cap was 15000ms
→ hermes-agent.cli-probe-failed  kind: timeout
→ "hermes-agent OFFLINE: hermes-agent not installed/running — install from ..."
```

Hermes was installed, licensed and working — the same command takes ~800ms on an
idle machine, which is how a 15s cap ever looked generous. Under load (Electron
running, venv Python 3.11 importing the OpenAI SDK on Windows) it does not
finish, and **since Hermes is the only build-content engine by design, every
build fails with an install hint.** The failure is loudest exactly when the
operator is using the app, which is exactly when they try to build.

**Root cause, and it is a policy bug not a number bug.** A probe timeout was
treated as evidence of absence. It is evidence of *slowness*. ENOENT, EACCES and
a non-zero exit are real evidence; a child that did not finish is not.

**Fix.** The probe resolves `true | false | 'timeout'`. A timeout keeps the
adapter **ONLINE** in `cli` mode, still records the `timeout` diagnostic, and logs
`hermes-agent.cli-probe-slow` with a hint that says why it is trusting thin
evidence. The real task call has its own 10-minute timeout and will fail with the
actual error if the binary genuinely cannot run — so an optimistic probe costs at
most one slow build attempt, while a pessimistic one costs every build. The
default cap also went 15s → 30s, since 21.2s is measured reality here.

**Contract change:** `test/p0-1-hermes-probe-diagnostics.test.js` asserted
`probe() === false` on timeout. That test encoded the wrong policy and was
updated deliberately, with the reason recorded in it. The ENOENT and
exit-nonzero cases still assert OFFLINE.

### BUG-059 — Ad blocking silently gave up entirely, over a cosmetic-only API

From a real launch log the operator pasted:

```
adblocker init failed — continuing WITHOUT blocking (YouTube pre-rolls will play):
this.session.registerPreloadScript is not a function
```

**Root cause.** `session.registerPreloadScript()` arrived in **Electron 35**; this
app pins `^32` (32.3.3 installed). `@ghostery/adblocker-electron` declares
`peerDependencies: {electron: ">11"}`, so npm never warned. The library uses that
API for **cosmetic filtering only** and gates network filtering separately
(`dist/commonjs/index.js:88-100`) — but `enableBlockingInSession()` does both in
one call, so the throw took the **network** filters down with it. Those are the
ones that stop pre-rolls.

**Fix.** Feature-detect the API. Present → full path unchanged. Absent → register
the two network listeners directly (`onBeforeRequest`, `onHeadersReceived`, both
public on the blocker) and log "network only — cosmetic filtering needs Electron
>= 35 (running 32.3.3)". No Electron bump, no dependency change, and no
third-party preload injected into the HUD's own session — which is the better
default here anyway, given AD-8.

**Tests.** `test/electron-adblock-fallback.test.js` (5 source-shape cases).

### Gemini TTS free tier is 10 requests/day — ⚠️ OPERATOR DECISION

Not a code bug; found while verifying the above and worth recording because it
looks exactly like a bug from the outside.

`VOICE_TTS_CHAIN` is `gemini,edge,piper` and every **sentence** is a separate
TTS request. A real synthesis run on this machine returned:

```
gemini-tts audio/wav bytes=115770 RIFF ok          <- first chunk fine
WARN tts.provider-failed gemini-tts: 429 ... limit: 10,
     model: gemini-2.5-flash-tts ... retry in 47.7s
```

So the Gemini voice is exhausted after roughly two replies per day, mid-reply,
and the sticky chain then fails over to edge-tts — **the voice changes in the
middle of a sentence and stays changed for the session**. The chain behaved
correctly; the quota is the constraint.

Options, operator's call: put `edge` first in `VOICE_TTS_CHAIN` (local,
unmetered, consistent — costs the Gemini voice), or supply a paid Google key.
Leaving it as-is means one nice-sounding reply per session followed by a
different voice.

### Two-brain provider key — ⚠️ OPERATOR ACTION REQUIRED

`mythos/.env` used the **same Mistral key** for `MISTRAL_API_KEY` (the Mythos
brain) and `HERMES_PROVIDER_KEY` (the build engine) — verified byte-identical by
hash. `.env.example` had warned about exactly this ("a shared key reintroduces
the exact voice stutter this separation avoids") as a *preference*; it is now
stated as REQUIRED, with the observable symptom named. Boot logs
`hermes.shared-provider-key` when it detects the condition (a boolean only —
never a key value).

**The operator must mint a second Mistral workspace key for Hermes and rotate the
shared one.** Code cannot do this. Until then, a 20-60-call build shares one
workspace rate limit with voice, vision and memory consolidation — and Mistral
was independently observed flapping (3,622 `provider-down` anomalies on
2026-07-21 alone).

### Not reproduced — the reported failure volume

The operator reports "tens of thousands of attempts" failing. The authoritative
ledger (`vault/Checkpoints/build-jobs.json`, capped at 100 and holding only 25
records since 2026-07-10, so nothing was evicted) shows **25 jobs: 15 done, 10
failed**. The 10 failures are fully explained: 8 pre-Hermes brain-engine
spec/quality rejections, and 2 honest `hermes-agent OFFLINE` hard-fails from
2026-07-29 before Hermes was installed. Either most attempts die before reaching
`buildRunner.enqueue()` (voice/engagement level, never persisted as jobs), or the
figure counts in-session retries. **Worth re-measuring after these fixes rather
than theorising.**

---

## Session (2026-07-31, evening) — the Trust Plan: nine waves, one root cause

Commits `05ec87d` (pre-flight), `731fcb6`, `28ac5ab`, `94f6006`, `7e77d5a`,
`01e2e2e`, `871deb9`, `607e2e2`. All pushed to `origin/main`.

**The single root cause.** Every effector in this codebase returned "the API call
succeeded" and the voice layer spoke it as "the thing happened". SendInput
accepting 46 events is not text in Notepad. A cua click landing is not the right
song playing. A vision model producing prose is not what is on the screen. Four
previous waves of fixes each killed one symptom and the next session surfaced its
sibling. This work fixed the CONTRACT (`src/core/effectors/evidence.js`) and then
brought each surface onto it.

**BUG-051 — `ui_type` reported 23 characters into an empty Notepad.** 11:28:09.
Target pid resolved, foreground confirmed "Untitled - Notepad", SendInput returned
its full event count, `typed:true`. The screenshot MYTHOS took 28s later shows an
empty document. Every guard verified the CALL; nothing read the window back.
🔧 FIXED (Wave 2): `Read-FocusedElementText` (ValuePattern then TextPattern), a
before/after comparison that also requires the content to have CHANGED, and four
verdicts (confirmed / mismatch / unchanged / unavailable) mapped onto the evidence
contract. ⚠️ **HONEST, NOT YET CORRECT** — typing into Win11 Notepad may still
fail; it will now say so instead of claiming success. Which injection mechanism
actually works is still UNMEASURED: run `node scripts/diagnose-type-mechanisms.js`
against Notepad, Slack and the IDE and record the answers here.

**BUG-052 — `launch_app("notepad")` targeted the operator's IDE.** 11:25:57.
`Resolve-WindowedProcessByName`'s third fallback matched on window TITLE
("...Fix notepad typing...") and returned that pid as a bare number,
indistinguishable from a real process-name match. Two `ui_type` calls put 23 chars
each into the IDE, and the honesty cross-check PASSED because landed pid equalled
target pid equalled the same wrong pid.
🔧 FIXED (Wave 1), live-verified with a decoy window on this machine: a title match
is now labelled `matchedBy:'title'` and an unresolved launch carries NO `pid` at
all, only `candidatePid`.

**BUG-053 — Enter was pressed in a real Slack DM before anything was typed.**
`send_key('enter')` at 11:23:33 and 11:24:15, both ok:true; the first successful
`ui_type` was 11:25:17. MYTHOS then said "I have typed the message and sent it."
🔧 FIXED (Wave 2): a bare Enter in a messaging app requires a preceding VERIFIED
read-back into that same live-foreground window.

**BUG-054 — `screen_look` fabricated, and it is the verification step.** 11:21:51
returned a bare imgur URL; 11:28:36 returned a generic Notepad tutorial paragraph
while the screen showed an empty document, and MYTHOS relayed it as visual
confirmation.
🔧 FIXED (Wave 4): OCR is ground truth, the vision model's prose is commentary;
empty replies, bare URLs and zero-overlap descriptions are rejected, and
`ocrSample` carries literal screen text for the voice layer to quote.

**BUG-055 — Spotify returned `verified:true` next to refuting evidence.** The plan
blamed a missing comparison; the comparison exists and is FOOLED. Real queries
(vault/Episodic + vault/Audit) were "The Kid LAROI Down" and "down by the kid
laroi": terms [kid, laroi, down] need ceil(3*0.6)=2, and "The Kid LAROI - SHE DON'T
NEED TO KNOW" matches kid+laroi = 2. **The artist name alone clears the majority bar
whenever the artist is more than one token** — the in-file comment claiming this case
was closed was true only for two-token queries.
🔧 FIXED (Wave 5): the TRACK half of "Artist - Track" must earn its own match.

**BUG-056 — the HUD ticked a checkmark for "called", not "worked".** `action.*`
relayed only `{tool, ok, goalId, reason}`, so `unverified` could not reach the
widget at all.
🔧 FIXED (Wave 0): threaded through `dispatch-action.js`, the server, and the
widget, which now draws verified / attempted / failed as three distinct states.
`actions.js` was also interpolating tool/reason into innerHTML against the HUD's
own rule — escaped, which matters because Wave 2 puts read-back text (i.e. operator
dictation) into `reason`.

**BUG-057 — narration outran outcomes.** `finalSay` is composed BEFORE actions run
and was only re-derived on ok:false, so an ok-but-unproven result sailed through.
Separately, `executeAction` never copied `unverified` onto the action it returns, so
the turn loop could not see it even in principle. On the Live path, awaiting a slow
tool inside the turn guarantees the model speaks first — the 9+
`live-tool-outcome-late-for-turn` anomalies were that, not a broken detector.
🔧 FIXED (Wave 3): unverified forces the corrective pass (scoped to tools whose
result is heard as an outcome, so a Ctrl+N does not cost a brain call); slow tools
answer `status:'started'` and report the real outcome via `[SYSTEM]` afterwards.

**BUG-058 — `open_folder` already existed and nobody noticed.** The plan called for
a new tool; `from-computer.js` has had one since NOVA, tiered T2 and sandboxed.
Adding a second collided on the tool name and duplicated its TIER_TABLE key (last
duplicate wins, so an entry written as `1` read back as `2`). The real defects: it
returned `ok({opened})` because `spawn()` did not throw — the Wave 0 defect in a tool
nobody had audited, and `explorer.exe` exits non-zero even on success — and its
one-sentence description is the likely reason the model reached for
`launch_app('explorer.exe "D:\...")` three times instead.
🔧 FIXED (Wave 6): window-title oracle, and a description that names the wrong turn.
Unknown tool names now suggest the nearest registered ones (`status` offers
`read_status`) with the `unknown-effector` prefix preserved for `cortex/index.js`.

**Wave 8 — the modal is gone for operator-initiated sends.** Spoken confirm
(recipient + exact text, "say send") for `whatsapp_send`/`gmail_send` from
`channel:'voice'` only. The leash is untouched: same tier, same
confirm.create/accept, same audit. Every other T3 tool keeps the modal;
cortex/engagements/absent-channel keep the modal; `AUTONOMOUS_MAX_TIER` stays 2.
Worth recording that the modal was **protecting nothing** — the operator approved the
Notepad type and it went to the IDE anyway, because a confirmation gates INTENT and
only evidence gates OUTCOME.

### Test-harness defects found while proving the above

All of the kind that make a green suite meaningless, and all now fixed:
- `try/finally` around an **un-awaited** async fn restored a module stub before the
  code under test had finished, so a lazily-required oracle silently loaded the real
  offline adapter and the test failed while the code was right.
- Two tests were spawning real Explorer windows on the machine running the suite.
- Two suite-only failures were hardcoded per-test child-spawn ceilings starved by
  suite parallelism (`ps-dispatch-honest-failure` answers in ~830ms alone but hit a
  15s ceiling in-suite; `immune.test.js`'s poll budget was shorter than the probe
  timeout it waits on). Reproducible on an idle machine — NOT the orphaned-`node.exe`
  cause this file documents elsewhere.
- One test of mine was named "an expired confirm sends nothing" while actually
  re-asserting the decline path. A test whose name lies is the same defect as an
  effector whose `ok:true` lies; the TTL is now config-read so expiry is testable.

### ⚠️ NOT LIVE-VERIFIED — the operator deferred verification to the end

Everything above is unit-verified (2133 tests, 0 fail, 1 pre-existing honest skip)
plus two live checks: Wave 1's decoy-title resolution, and `get_foreground_window`
round-tripping through the real PowerShell child. **Restart MYTHOS before any live
check** — nothing was running during this work.

Run these, in order:
1. `node scripts/diagnose-type-mechanisms.js` against Win11 Notepad, then Slack, then
   the IDE. Record which mechanisms land. This decides whether typing WORKS; Wave 2
   only guarantees it stops lying.
2. `node scripts/verify-notepad-typing.js` — now includes the decoy-title case (Step
   0) and asserts the `process-window` oracle.
3. Fresh Notepad + "type Hi Alex": the screenshot must show the text, and the
   read-back must be quoted in the result.
4. A real Slack DM + "reply that I am on my way": typed, quoted back, NOT sent.
5. "play <song> on Spotify": either it plays, or MYTHOS says which song is actually
   playing.
6. "whatsapp <contact> ...": spoken confirm, no popup; "send it" sends.
7. Check `vault/Episodic` for zero `live-tool-outcome-late-for-turn` anomalies and
   zero spoken "done" over an unverified action.

**Open operator decision (flagged, not silently chosen):** media-echo suppression is
bounded to the opening ~8s of playback rather than the whole track, because
suspending capture for a full song leaves MYTHOS deaf exactly when you would say
"next" or "stop". Full-duration deafness is available by passing a larger hold. Pick
one after hearing both.

---

## Session (2026-08-01/02) — the voice-session-19 fixes: 19 defects, 7 stages

Branch `fix/voice-session-19` (off `47fe0f2`, NOT pushed — a second machine shares
this repo through `main`, which is untouched). 8 commits: `f97f4e3`, `5c5a038`,
`6cd14a4`, `623a5a5`, `d36f2d3`, `954514d`, `fea7d7f`, `a06a82b`, `7eea2c5`
(9 total — one more than listed above; see the commit log on the branch for the
exact SHAs and order). Built from a real logged voice session
(`vault/Conversation/session.json`, `vault/Incidents/2026-07-31.jsonl`,
`vault/Audit/2026-07-31.jsonl`) where MYTHOS went deaf repeatedly, played the wrong
song twice while claiming otherwise, could not close Spotify, and could not open
YouTube in the Electron app as asked. Full plan: the spec this session executed
against (not tracked in this repo — see the session that dispatched this work).

**⚠️ NUMBERING COLLISION — read this before grepping for a BUG number.** The
source comments and commit messages for this session's Stage 1-7 work use
`BUG-059` through `BUG-081`. Those numbers were ALREADY in use in this repo's
source at the branch point (`47fe0f2`) for an entirely different, earlier batch of
`pc-child`/WhatsApp fixes (commits around `21f8743`) that were never given their
own BUGS.md prose entries — e.g. `ps-automation.ps1`'s own `BUG-060`/`BUG-061`
comments are about foreground-vs-minimized windows and SendInput silent discards,
NOT the two-voices/tail-clip defects this session's `BUG-060`/`BUG-061` source
comments describe. This was not caught before the numbers were baked into commit
messages and test names on this branch, and those are not being rewritten after
the fact (no history rewrite on a shared branch). **To keep this file's own
numbering collision-free, every entry below uses a FRESH number (BUG-082 onward)
and cites the colliding in-source label in brackets so the code is still
findable.** If BUGS.md ever gets a numbering pass, reconciling the `21f8743`
batch's own undocumented `BUG-059..071` range against this file is the thing to
do it alongside.

**Test baseline.** Before this session: 2152 passing / 0 failing (confirmed at
`47fe0f2`, matching this file's own header). After all 7 stages: **2222 tests,
2221 pass, 0 fail, 1 skip** (the skip is the pre-existing, honest
`sensors-file.test.js` skip documented elsewhere in this file — unrelated). Net
+69 tests, zero regressions, verified by a full recursive `cd mythos && node
--test` after every commit, not just once at the end.

### BUG-082 [source: BUG-059] — MYTHOS went deaf; idle-timeout and session-max killed the reconnect path

**Complaint:** "why do you keep going offline? I have to click you every time."

**Root cause**, `src/core/voice/live-session.js`: `armIdle()`'s 45s idle timer and
a hardcoded 10-minute session-max timer both called `close(reason)`, which
unconditionally set `closedByUs = true` — exactly the flag `ws.on('close')`'s
reconnect branch checked to decide **not** to reconnect. An idle timeout was
therefore indistinguishable from an intentional shutdown: the session just died,
silently, with no client notification.

**Fix.** `close(reason, {final})` — a non-final close (idle-timeout, session-max,
goAway) leaves `closedByUs` false and does nothing else; the ONE existing
reconnect branch in `ws.on('close')` (not a second parallel path) sees
`!closedByUs` and reconnects on its own, carrying `resumeHandle` if present but no
longer requiring it (a `goAway` can race ahead of the first
`sessionResumptionUpdate` and must still reconnect). `LIVE_IDLE_TIMEOUT_MS`
default raised 45000→120000ms (`schema.js`) to survive a ~30s TTS-suspend window
without the deadline racing normal turn-taking. `handleFrame()` now rearms the
idle clock on **every** server frame, not just specific branches, so a future
protocol addition can't silently starve it.

**Checked against Google's actual Live API docs before touching this** (session
management guide, fetched 2026-08-01 — this repo's own prior comment claiming
`contextWindowCompression` makes the session live "forever" was **not** trusted
at face value, per this file's own house rule about plausible-but-wrong theories):
`slidingWindow` compression does extend an audio session's *content* window
indefinitely, but the underlying **connection** still has its own ~10-minute
ceiling independent of that — session resumption exists specifically to
reconnect across it. So the session-max timer firing is expected, load-bearing
behavior, not a bug to delete; it must reconnect, never dead-end. Fixed
accordingly rather than just removing the timer.

**Two more defects found on adversarial re-review of the first pass (same file,
folded into this entry, not a separate number):**
- **Unbounded idle rotation was a cost leak.** An unattended mic would rotate a
  brand-new Gemini Live session every `IDLE_MS` forever — real money on BYO keys
  with per-day ceilings (this repo has a documented 10-request/day voice model).
  Fixed with `idleRotationsWithoutSpeech`: 3 idle rotations with zero recognized
  user speech in between is the ceiling; past it, the session does a genuinely
  FINAL close (revived by a click or wake word, same as any closed session) and
  emits `health.anomaly {kind:'live-idle-exhausted'}` so it's observable. Any real
  transcript resets the counter. Session-max's own 10-min housekeeping rotations
  are NOT counted against this ceiling (a busy, healthy conversation shouldn't be
  punished for it).
- **A stale socket's late `error` could stomp the replacement session.** `close()`
  handed off to a new socket but left the OLD socket's `error` listener attached;
  a late error from it (realistic for a real TCP/TLS teardown) called
  `breakers.fail()` and forced state back to `'closed'` on the healthy new
  session. Fixed by stripping the old socket's `error` listener (replacing with a
  no-op — an `EventEmitter` throws on an unlistened `'error'`) while leaving
  `close` attached, since that's what fires the reconnect.

🔧 FIXED+UNIT-VERIFIED: `test/live-session.test.js`, 11 cases covering
idle-timeout, session-max, goAway, the idle-rotation ceiling + transcript reset,
and the stale-socket-error isolation — all verified red before each fix by
reverting it locally. **NEEDS-LIVE-CHECK**: a real multi-minute silence-then-speak
session against the real Gemini Live endpoint, and whether 3 rotations / 120s /
250ms-class constants feel right against real TTS timing. See runbook item 1.

### BUG-083 [source: BUG-060] — two voices speaking simultaneously

**Complaint:** "two voices speaking simultaneously" (2 incidents).

**Root cause.** `server/index.js`'s `proactiveSpeak()` (boot greeting, reminders,
late-outcome reports) streamed edge-tts audio to the client with no check for an
open Gemini Live session on that connection — so Gemini's own PCM voice and
edge-tts played at once.

**Fix.** `proactiveSpeak()` now looks up the connection's live session
(`ws.getLiveSession()`, newly exposed); if open, it calls `liveSession.sendText('[SYSTEM] ...')`
— the exact `[SYSTEM]` channel `reportLateOutcome()` already used
(`live-tool-adapter.js`) — and emits **zero** audio chunks, so Gemini's own voice
speaks it. If no Live session is open, the legacy edge-tts path is untouched. The
dead `setCaptureSuspended` call tied to own-TTS playback was removed from
`app.js` (the `suspendForMedia` media-echo path is untouched — that's BUG-092's
territory).

🔧 FIXED+UNIT-VERIFIED: `test/proactive-speak-live-routing.test.js` — asserts a
real fake-socket Live session gets `sendText` and zero `speech-chunk` messages;
the no-Live-session legacy path is asserted unchanged. **NEEDS-LIVE-CHECK**:
whether the operator genuinely hears one voice during a real reminder/greeting
while a live conversation is running. See runbook item 2.

**Known remaining gap, NOT fixed in this pass, flagged rather than hidden:**
`sendSpokenReply()` — the direct typed-compose-bar reply path, distinct from
`proactiveSpeak()` — still emits edge-tts audio unconditionally even while a Live
session is open. Typing into the chat box while Live is active can still leak
audio into the Live mic. Out of this stage's mandate (proactive/background
announcements only); needs its own pass.

### BUG-084 [source: BUG-061] — the last word clipped on barge-in

**Complaint:** speech "consistently cut off at the end, losing the last one or
two words."

**Root cause.** `pcm-player.js`'s `flush()` hard-stopped every queued audio source
on any `live-interrupted` event, with no minimum-remaining-duration guard —
compounded by BUG-083 above: Gemini's own VAD was firing `interrupted` on hearing
MYTHOS's own leaked edge-tts audio.

**Fix.** `flush()` now ignores an interrupt when the queued tail is under 250ms
remaining, computed against the real Web Audio scheduled-start time; a genuine
barge-in with more tail than that still stops immediately. `close()` (real
teardown) still stops unconditionally via a separate `stopAll()` path.

🔧 FIXED+UNIT-VERIFIED: `test/pcm-player.test.js` — 3 new cases for the threshold
(ignored under it, honored over it, no-op when idle), 3 pre-existing tests updated
to use long-duration chunks so they still test genuine-interrupt behavior.
**NEEDS-LIVE-CHECK**: whether 250ms sounds right against real speech cadence and
doesn't make barge-in feel unresponsive. See runbook item 2.

### BUG-085 [source: BUG-065] — Spotify played the wrong song while reporting success

**Complaint:** asked for "Russia on Ice" and "soft jazz", got "Of the New Day" and
"Lady in the Blue Dress" — while MYTHOS reported success. BUGS.md's Wave 5 already
fixed the *detection*; this is the flag being thrown away one frame up the stack.

**Proof.** `vault/Audit/2026-07-31.jsonl` record `aud-9696f4641ba2`:
`{"tool":"spotify_play","outcome":"ok"}` with **no** `unverified`, while the
episodic result in the same second says `"verified":false,"note":"clicked a play
control but the playing title did not match the query"`.

**Root cause**, `from-spotify.js`: the cua-driver play path spread only
`cuaResult.result` into a bare `ok()`, dropping the `unverified` flag
`cuaResult` actually carried. The `click_at` and `keystroke_fallback` fallback
paths were worse: bare `ok()` with **no oracle consulted at all**.

**Fix.** The cua-driver path now checks for `unverified`/`reason` and returns
`evidence.unverified()` instead of re-wrapping in `ok()`. `click_at` and
`keystroke_fallback` now run the same now-playing-title comparison
(`titleSatisfiesQuery()`, extracted once, not duplicated) the cua path already
had; if they can't run it, they return `unverified` honestly. The cua path's
confirmed-match branch was also upgraded from bare `ok()` to
`evidence.verifiedOk(..., {oracle:'media-status', ...})` — same law, success
side.

🔧 FIXED+UNIT-VERIFIED: `test/bug-065-spotify-evidence-propagation.test.js`
(propagation + both fallback paths, mocked pc-effectors/cua-driver, no live
Spotify needed for the logic itself). **NEEDS-LIVE-CHECK**: "play Russia on Ice"
against a real Spotify session — either it plays, or MYTHOS names what's actually
playing. See runbook item 3.

### BUG-086 [source: BUG-068] — an unverified outcome still reported `status:ok` on the fast path

**Root cause**, `live-tool-adapter.js`: the AWAITED (fast) branch answered
`ok: Boolean(outcome && outcome.ok)` with no check for `outcome.unverified` at
all; only the slow/late path (`reportLateOutcome`) honored it. A real record
(`aud`@14:33:38): `ui_type` returning "the focused control exposes neither
ValuePattern nor TextPattern" — an honest unverified — was still reported to the
model as `status:'ok'` whenever it happened to resolve before the awaited
branch's timeout.

**Fix.** Extracted `evaluateOutcome()`/`unverifiedNarration()` once; both the
awaited branch and `reportLateOutcome()` now call the same helpers, so an
unverified result reads as `status:'unverified'` with the real reason regardless
of which branch happened to catch it.

🔧 FIXED+UNIT-VERIFIED: `test/live-tool-adapter.test.js` (2 new cases) — fully
verifiable without a mic or live Spotify session; this is pure verdict-building
logic. No live check owed for this one specifically.

### BUG-087 [source: BUG-063] — "spotify_play FAILED: spotify_play started"

**Root cause.** A slow tool's in-progress START was committed with `ok:false`,
which the narration layer rendered as the nonsensical (verbatim, `session.json`)
"spotify_play FAILED: spotify_play started".

**Fix.** New `src/core/voice/action-outcome-summary.js` (`summarizeActionsForResult`,
extracted from `server/index.js`) special-cases `a.started` before reading
`a.ok`, rendering `"spotify_play started (outcome pending)"` instead.

🔧 FIXED+UNIT-VERIFIED: `test/bug-063-started-state.test.js` (6 cases, including
the exact recorded narration string). Pure narration logic — no live check owed.

### BUG-088 [source: BUG-069] — the immune healer claimed to heal things it never touched

**Root cause**, `server/index.js`'s `health.healed` subscriber: it labeled an
outcome `healed` whenever the event fired, including `outcome:'no-match'` /
`'cooldown'` / `'error'` — 36 such pairs in the episodic logs per the operator's
plan. Same defect class as BUG-085: an instrument reporting success it didn't
achieve.

**Fix.** `actuallyHealed = !('outcome' in p) || p.outcome === 'applied'` gates the
label; `no-match`/`cooldown`/`error` now write `outcome:'unhandled'`.
`probes.js`'s own `provider-recovered` event (no `outcome` field) still reads as
healed, unchanged.

🔧 FIXED+UNIT-VERIFIED: `test/bug-069-healer-no-match-label.test.js` (4 cases,
real bus + real server + real WS client). No live check owed — this is a labeling
fix over deterministic inputs.

### BUG-089/090/091 [source: BUG-072/073/074] — `ui_click`/`ui_type` target the right window, or say they cannot

**Complaint (operator, mid-plan):** "the ui_click is not working." Plus one
incident: "ui_type repeatedly failing despite approvals and visible confirmation
to agent... says it is 'bugging me out'."

**Failure mode A — dead pid, no retry (BUG-089/BUG-072).** `foregroundThenRetry`
(`from-pc.js`) short-circuited on the first `focus_window` failure, abandoning all
3 attempts, and never invalidated `lastLaunchedPid` when that process died. Real
dead pids from the logs: 5168, 26428, 7448 ("Process 7448 has no main window").
**Fix:** a failed focus now retries once before giving up; on a still-dead pid,
`lastLaunchedPid` is cleared and the failure names `list_windows` explicitly so
the model re-resolves instead of retrying a corpse.

**Failure mode B — stale a11y element path (folded into BUG-089).**
`Resolve-UIAElement` (`ps-automation.ps1`) now retries once on an out-of-range
path and, on a genuine miss, returns the current candidate labels instead of a
bare index error.

**Failure mode C — `ui_click` had no evidence oracle at all (BUG-090/BUG-073).**
**Fix:** `ui_click` now checks `get_foreground_window` (the cheapest oracle
available there) before returning `ok`, and returns `unverified` when it can't.
`ponytail:` noted ceiling — this proves "clicked in the right window", not "the
element reacted"; a per-element post-condition is the upgrade path if a
false-positive click surfaces live.

**Failure mode D — console-host false negative (BUG-091/BUG-074).** pid 9152
(`cmd.exe`) returned `typed:true`, correct `typedIntoPid`, and was still graded
FAIL because a console host's TextPattern echoes the whole scrollback, not the
input line. **Fix:** a title-regex exemption (`cmd.exe|powershell.exe|pwsh.exe|conhost.exe`)
now grades console hosts `unverified`, not failed.

🔧 FIXED+UNIT-VERIFIED: `test/from-pc-window-target.test.js` (6 cases, mocked
delegate) covers A/C/D. **NEEDS-LIVE-CHECK**: failure mode B specifically — there
is no way to fake a real `System.Windows.Automation` tree headlessly; needs a
real stale Electron/Chromium a11y tree. See runbook item 5. Run
`node scripts/verify-notepad-typing.js` live as well.

### BUG-092 [source: BUG-075] — YouTube belongs in the Electron app, not the dashboard widget

**Complaint (verbatim):** "I did not ask you to play on YouTube widget. I
specifically said, open YouTube on the Electron app." `launch_app("youtube")`
then failed 3x — honestly, since nothing named YouTube is a Windows executable.
Separately, a German video played that "could not be stopped with standard
playback controls."

**Verified before building anything (per the plan's own instruction to check the
premise first):** `ui.open-web` was emitted server-side and picked up by exactly
one subscriber — the dashboard's own browser JS, an overlay inside the SAME
window, never a second `BrowserWindow`. `electron/main.js` had **zero**
subscription to anything from the server child; the `'ipc'` fork slot existed but
carried only lifecycle messages. Confirms the complaint exactly: "the Electron
app" literally could not have opened, regardless of client branch.

**Fix — the lazy path, per the operator's explicit instruction not to invent new
plumbing:** the EXISTING `ui.open-web` event now also does
`process.send({channel:'mythos:ui.open-web', payload})` over the existing fork IPC
slot; `electron/main.js` listens and opens a second `BrowserWindow` (reusing the
already-awaited ad-blocker and `preload.js`), tracked so a second call
reuses/replaces it rather than stacking. `close_panel` gained a matching
`mediaWindowClosed` count via the same request/ack shape `requestClosePanel`
already used. `launch_app` routes a small (`ponytail:`) known-web-app map
(youtube, gmail, maps — only what's evidenced in the transcript) to this path
instead of hard-failing through all 3 launch tiers, and redirects
`explorer.exe "D:\..."` to the existing `open_folder` effector (BUG-058) instead
of retrying a launch that can't work. No new effector, tool, or TIER_TABLE entry.

🔧 FIXED+UNIT-VERIFIED: `test/bug-075-electron-media-window.test.js` (21 cases,
against an injected-`BrowserWindow` seam mirroring `live-session.js`'s
`createSocket` pattern — `electron/main.js` itself can't be `require()`d under
`node --test`), `test/bug-075-launch-app-routing.test.js` (6 cases).
**NEEDS-LIVE-CHECK**: a real Electron `BrowserWindow` actually appearing and
"close that" actually closing it — needs a live `npm start`. See runbook item 7.

### BUG-093 [source: BUG-076] — `status` kept dead-ending on `unknown-effector` even after being approved

**Root cause**, `effectors/hub.js`: Wave 6 already added a "did you mean
read_status?" suggestion for the literal `status`, but nothing ever wired that
suggestion to an actual retry — the operator approved it (`aud`@11:11:29) and the
next call still said `status` and still got `unknown-effector`. A suggestion
nobody can act on is the same defect as no suggestion.

**Fix.** A one-entry `ALIASES` table (`{'status': 'read_status'}`) resolves
before the unknown-effector path, so the name the model actually reaches for
just works.

🔧 FIXED+UNIT-VERIFIED: `test/open-folder-and-suggestions.test.js` — `status` now
resolves (`ok:true`) instead of merely suggesting; the bare `unknown-effector`
prefix contract still holds for a genuinely unmapped name. No live check owed —
this is deterministic dispatch logic.

### BUG-094 [source: BUG-077] — `send_key` had no function-key row, so alt+F4 ("close Spotify") was unexpressible

**Evidence:** `Invalid key: "alt"`, `Invalid key: "f4"` — the model tried them as
two separate calls, both rejected; `alt` was already a valid modifier, but `f4`
was not a valid base key at all, so even the combo form could never have worked.

**Fix.** Added `f1`-`f12` to `NAMED_KEYS` (`from-pc.js`) and `$VK_CODES`
(`ps-automation.ps1`, `VK_F1=0x70`..`VK_F12=0x7B`, contiguous). The
honest-failure-for-anything-unmapped contract is unchanged.

🔧 FIXED+UNIT-VERIFIED: `test/bug-077-send-key-fn-keys.test.js` (4 cases,
including the exact recorded case and all 12 function keys). **NEEDS-LIVE-CHECK**:
a real `alt+f4` against a real Spotify window closing it. See runbook item 8.

### BUG-095 [source: BUG-078] — `spotify_volume` moves system volume, not Spotify's — ALREADY FIXED before this session

**Evidence cited in the plan:** 20x `{"direction":"up"}` in 50s then
`{"level":100}` — the operator escalating because nothing per-app happened.

**Checked against actual git history before building anything:** commit `c5abcde`
(2026-07-29, predating this whole plan) already rewrote `spotify_volume`'s
description to say "Adjust or set system volume (Spotify plays through the
system output, same volume control)" — exactly the honesty fix the plan calls
for. **This defect was not real at the time this session ran; it was already
closed.** Per the operator's own ruling for this stage (do not build
`ISimpleAudioVolume` per-app Core Audio interop for one incident; ship the
honesty fix and name the real upgrade path), a regression test was added so a
future change can't silently revert the honest description, and a `ponytail:`
comment names per-app Core Audio volume as the explicit upgrade path if this
still bites live.

🔧 FIXED+UNIT-VERIFIED (already fixed pre-session; verified, not re-fixed):
`test/bug-078-spotify-volume-honesty.test.js`. No live check owed for the
description text itself; if per-app control is still wanted after hearing it
live, that's a new, bigger piece of work — not a regression of this fix.

### BUG-096 [source: BUG-080] — durable identity facts written from text nobody said

**Evidence:** `vault/Semantic/user-facts.md` contained "The user's name is Alex"
(mined from MYTHOS's OWN typed Notepad probe text, "Hi Alex, this is Mythos"),
"the user will call me 'Eve'", and an inferred "operator really enjoys playing
jazz piano" (written right after a "soft jazz" query, never a stated fact) — all
at high confidence, all contradicting `Identity/operator-profile.txt` ("Address
them with 'Sir'").

**Root cause.** `from-memory.js`'s `remember()` tool already quarantined identity
claims to low confidence; `memory/index.js`'s automatic conversation-distillation
loop (3b) did not — it wrote straight to `user-facts` at confidence 0.7 with no
check at all.

**Fix — one guard at the shared chokepoint, per the operator's instruction,**
inside `semantic.js`'s `write()` itself (every caller passes through it): an
identity-class claim (name/nickname/address-as) is quarantined to confidence 0.2
unless its `sources` explicitly mark a confirmed operator utterance, AND a cheap
word-overlap check against `Identity/operator-profile.txt` catches contradictions
even from a "confirmed" source.

**Root-cause note, stated honestly rather than assumed:** the specific
Notepad-probe example most likely entered via BUG-083 (own-TTS bleeding into the
Live mic, transcribed by Gemini as the operator speaking) — the `userText` itself
was contaminated upstream of `semantic.write()`, not just mislabeled inside it.
BUG-083's fix closes that specific hole; this guard is defense-in-depth for the
class of bug (self-authored/inferred text becoming a durable identity fact), not
a duplicate fix of the same line.

🔧 FIXED+UNIT-VERIFIED: `test/bug-080-semantic-identity-guard.test.js` (5 cases,
using the exact recorded fixture strings above, plus a confirmed-non-contradicting
case and a contradicting-a-confirmed-source case). No live check owed — this is a
deterministic write-path guard testable with real vault fixtures.

### BUG-097 [source: BUG-079] — no local time anywhere in the Live prompt

**Evidence:** MYTHOS said "have a good afternoon" at ~01:50 local; the operator
corrected "a.m. not p.m."

**Fix.** `buildLiveSystemInstruction()` (`server/index.js`) now appends the
current local date/time; `server/index.js` passes the FUNCTION itself (not its
one-time result) as `live-session.js`'s `systemInstruction` dependency, and
`buildSetup()` calls it fresh — piggybacking on the reconnect occasion BUG-082
already created, rather than adding a new timer.

🔧 FIXED+UNIT-VERIFIED: `test/server-live-wiring.test.js` — asserts the setup
frame's `systemInstruction` carries a real current-year local time string on
first connect AND after an idle-triggered reconnect (proving the refresh, not
just the initial injection). No live check owed for the mechanism; the runbook's
time-check (item 9) is about the SPOKEN behavior, which does need ears.

### BUG-098 [source: BUG-081] — `spawnWebWidget` never dedupes, so surfaces stack

**Traced the "widgets restyle missing" claim first, per the plan's instruction —
no styling defect was found, and none invented:** `tokens.css`'s three-layer
import chain is intact, both widget-card renderers apply the same styled
classes, the gzip/cache layer can't serve anything stale, and the Electron shell
loads the same live HUD, not a stale copy.

**The one real defect found.** `spawnWebWidget()` (`widget-host.js`) staggered
every new card by 30px and appended it, with no dedup by `widgetType` — so two
`open_web` calls for the same surface (or an `open_web` call landing on top of
the registry's own `NOW PLAYING` widget) left two live panels stacked at once,
matching the incidents of music playing through both the widget and Spotify
simultaneously, and an unstoppable German video (BUG-092 is the other half of
that fix).

**Fix.** `spawnedByType` (widgetType → teardown) reuses/replaces the existing
card for that surface. Deliberately exempt: `'dynamic'` (Item 11 generative-UI
cards) are legitimately multi-instance and deduping them would be a regression.

No new test: this codebase has zero DOM/jsdom precedent for any widget-kind
module (`test/dynamic-widget-spec-validation.test.js`'s own header states this
explicitly) — matching that existing convention rather than introducing new test
infra for one fix.

🔧 FIXED, **NEEDS-LIVE-CHECK explicitly, not claimed further**: the plan itself
says "run the app, screenshot the HUD, and put it next to what the restyle was
supposed to produce" before touching styling — that visual comparison was not
done in this session (no way to run/screenshot the real Electron app headlessly
here). See runbook item 10.

### Live runbook — run these against a restarted MYTHOS, in order

Nothing was running during this work; restart before any check. Unit-green is
necessary, not sufficient — most of the following genuinely needs ears, a real
Spotify session, or a real Electron window, and that is the correct, honest state
for voice work, not a gap in the fix.

1. **Deafness (BUG-082).** Open a Live session, stay silent 3+ minutes (past the
   raised 120s idle timeout), then speak — it must answer with no click needed.
   Then leave it silent past ~3 idle-timeout cycles (~6 min) with nobody talking —
   confirm it goes to a real closed state (not endless reconnect spam) and that a
   click or wake word revives it. Watch `vault/Audit`/logs for `live-idle-exhausted`
   at that point, and zero `live-reconnect-failed` before it.
2. **One voice, whole words (BUG-083/BUG-084).** Boot with Live on — the greeting
   must be spoken once, in the Gemini voice, complete to the last word. Trigger a
   reminder mid-conversation: one voice, not two. Also test typing into the
   compose bar while Live is active — if a second voice/audio leak appears there,
   that is the known, flagged, NOT-yet-fixed `sendSpokenReply()` gap (see
   BUG-083's entry), not a new bug.
3. **Spotify honesty (BUG-085).** "Play Russia on Ice" — either it plays, or
   MYTHOS explicitly names the song that is actually playing. Grep
   `vault/Audit` for `spotify_play` with `outcome:ok` and no `unverified` next to
   a `verified:false` episodic result: must be zero.
4. **ui_click/ui_type (BUG-089/090/091).** Run
   `node scripts/verify-notepad-typing.js`. Then: fresh Notepad + "type Hi
   there" — screenshot shows it, read-back is quoted. Then: kill Spotify, then
   "click play" — MYTHOS must say the window is gone and call `list_windows`
   again, never fabricate a click landing.
5. **Stale a11y tree (BUG-089, failure mode B specifically).** Trigger a UI
   interaction against a window whose accessibility tree has visibly changed
   since an earlier turn (e.g. a WhatsApp/Electron window after a re-render) —
   confirm `ui_click` re-queries and either succeeds or returns current candidate
   labels, not a bare "index out of range".
6. **YouTube in Electron (BUG-092).** "Open YouTube on the Electron app and play
   Russia on Ice" — a real second OS window appears (not a dashboard panel), its
   title is quoted back, and "close that" actually closes it.
7. **Widget stacking (BUG-098).** Two `open_web` calls in a row for the same
   surface — one panel, updated in place, not two stacked. While there,
   screenshot the HUD and compare it against the intended widget restyle — this
   is the one item this session could not check at all.
8. **alt+F4 (BUG-094).** "Close Spotify" — the alt+F4 path must actually work now.
9. **Local time (BUG-097).** Ask the time, ideally near a day boundary — correct
   meridiem, matching the machine's actual local clock.
10. **Volume honesty (BUG-095).** "Set volume to 20%" — confirm MYTHOS's own
    language now matches reality (system volume, not "Spotify's volume"); decide
    live whether the per-app upgrade is still wanted after hearing this.

Finally: check `vault/Audit` + `vault/Episodic` for the session against the same
bar the original plan set — zero `live-tool-outcome-late-for-turn`, zero
`live-reconnect-failed`, zero `outcome:ok` on a result whose payload says
`verified:false`, and no `healed:` line whose outcome is `no-match`. Tick each
BUG-08x above to LIVE-VERIFIED only for what was actually observed, then commit
and — this branch is not pushed — decide when `fix/voice-session-19` merges to
`main`.

---

## Session (2026-08-05) — voice-session incident triage: 7 defects from 5 logged incidents

The operator ran a live voice session in the early hours of 2026-08-05, hit a run
of failures, and told MYTHOS to log them ("Yes, log it", "log it as bug", "log
this as a bug or log this as a feature to add"). MYTHOS wrote five
`log_incident` records — a raw voice-side journal with no root cause attached and
nothing scheduled to fix. This section is that triage.

**Sources.** `mythos/vault/Incidents/2026-08-04.jsonl` (the 5 records; the file is
named by the store's date rollover, every `ts` in it is from this session) and
`mythos/vault/Episodic/2026-08-05.jsonl` (108 entries: conversation, every tool
call, one `live-tool-outcome-late-for-turn` anomaly).

Two of the root causes were NOT what the incidents described, which is the lesson
worth keeping: the reminder failure was blamed on the reminder tool and was
actually a case-sensitivity bug in the time parser, and the "wrong tool"
narration was not a lookup error but an underspecified prompt inviting a guess.

- **BUG-099 (`browser_navigate` cannot target Brave — it always drives Chrome):**
  FIXED (unit-verified; live gate pending). The operator asked four times for
  YouTube in **Brave only**. `launch_app('brave')` opened Brave and every
  `browser_navigate` landed in Chrome, which MYTHOS then narrated as if the
  request had been honored. Structural, not prompt-level: the browser effectors
  drive one fixed CDP endpoint (`http://127.0.0.1:9222`) and
  `findBrowserExecutable()` in `from-browser.js` only ever knew Chrome and Edge,
  so "in Brave" was unexpressible. **Fix:** Brave joins the resolver as a
  first-class browser (`BROWSER_SUBPATHS`, env-derived paths only, plus a
  `BROWSER_EXECUTABLE` override), `browser_launch_debug` takes a `browser`
  argument with its own profile dir, and it and `browser_navigate` now carry a
  `browser` field naming the browser MYTHOS can actually vouch for. The honesty
  half is `checkBrowserTarget()`: a named browser that does not match the
  attached one is **refused** with both names and the remedy, and an attached
  browser MYTHOS did not launch reports `unknown` rather than assuming a match —
  over CDP, Brave deliberately reports a plain `Chrome/<version>` product string,
  so no version probe can tell them apart. Also added
  `browser_launch_debug`/`browser_get_title`/`browser_tabs` to `live-tools.js`'s
  `DEFAULT_ALLOWLIST`: the new refusal tells the model to call
  `browser_launch_debug`, which was not reachable from the Live path — a failure
  hint naming an unreachable tool is a dead end (same trap as the
  `ui_click`-without-`ui_elements` entry above).
  **Files:** `mythos/src/core/effectors/from-browser.js`,
  `mythos/src/core/voice/live-tools.js`,
  `mythos/test/browser-target-honesty.test.js`.

- **BUG-100 (`reminder_add` failed twice on a vet appointment; the operator heard
  only "Failed"):** FIXED. **Two distinct defects, and the incident text named
  neither.** (1) The real failure: `parseWhen()` in `from-calendar.js` lowercases
  its input (`str.trim().toLowerCase()`) and then matched an **uppercase-only**
  `[T ]` separator class — so *every* ISO datetime the voice model produced
  (`2026-08-05T16:00:00`) fell straight through to `return null` and came back
  "Could not parse that time". Confirmed by direct probe, not inference. (2) Next
  in line behind it: the Live model fills the optional `action` slot with `{}`
  rather than omitting it, and `addReminder()` treated a truthy object as a
  fire-action declaration, rejecting the reminder with "action.tool required".
  **Fix:** match `[t ]` on the already-lowercased string; treat an action object
  with zero keys (`{}` or `[]`) as no action while keeping the hard error for a
  non-empty action missing `tool`; tighten the schema string to tell the model to
  omit the field entirely.
  **Files:** `mythos/src/core/effectors/from-calendar.js`,
  `mythos/test/reminder-add-empty-action.test.js`.

- **BUG-101 (a failing tool's reason never reached voice — everything arrived as a
  bare "Failed"):** FIXED. `addReminder` returned a precise, actionable message
  and the operator heard "Failed indeed, Sir." The convention is `{ok, result}`
  (the `ok()`/`fail()` helpers), but several effectors return
  `{ok:false, error:'...'}` and **every consumer downstream reads only
  `.result`**: `live-tool-adapter.js`'s `evaluateOutcome()`
  (`(result && result.error) || result || 'Failed.'` with `result === undefined`)
  and `dispatch-action.js`'s audit line (`reasonText(result && result.result)` →
  an empty `reason`). So the audit trail for the vet reminder recorded no reason
  either. **Fix:** `effectors/adapter.js` mirrors an `{ok:false, error}` message
  into `result` at the single registration boundary every path shares — voice,
  audit, and the non-Live voice agent all get the text, and the original `error`
  field is preserved — plus a defensive read of `outcome.error` in
  `evaluateOutcome()` for outcomes that reach the Live adapter by another route.
  **Files:** `mythos/src/core/effectors/adapter.js`,
  `mythos/src/core/voice/live-tool-adapter.js`,
  `mythos/test/live-tool-error-surfacing.test.js`.

- **BUG-102 (`cua_list_windows` demanded human approval for a pure read):** FIXED.
  Mid-troubleshooting, twice, MYTHOS answered "I've requested the window list
  now, but I'll need your approval". `tierOf()` fail-safes an unmapped tool to T3
  (correct, and unchanged), but **none of the four cua-driver tools had a
  `TIER_TABLE` entry at all** — so listing windows sat on the confirm-and-execute
  tier. **Fix:** `cua_list_windows: 0`, `cua_get_window_state: 0`,
  `cua_bring_to_front: 1` (with `focus_window`), `cua_click: 3` (with
  `click_at`). The second half matters more than the rows:
  `test/tier-table-conformance.test.js` — the anti-drift gate whose whole job is
  catching exactly this — **never called `registerFromCua`**, so its hub could not
  see the four tools and the drift was invisible to the one test written to find
  it. That registration is now in step with `main.js`, and a new coverage test
  asserts every registered `cua_*` tool carries an explicit tier so the next one
  cannot silently inherit T3.
  **Files:** `mythos/src/core/leash/tiers.js`,
  `mythos/test/tier-table-conformance.test.js`,
  `mythos/test/tiers-cua-coverage.test.js`.

- **BUG-103 (`close_window` reported "process couldn't be found" on Chrome and a
  graceful-close timeout on Brave — and audited a still-open window as success):**
  FIXED (unit-verified + PowerShell parse-checked; live gate pending). Three
  faults in one handler. (1) The pid held upstream was a non-windowed child of a
  multi-process browser (or an already-exited process), so `CloseMainWindow()` had
  nothing to act on. (2) `WaitForExit(3000)` is the **wrong oracle** for a
  multi-window browser — closing one window never exits the process, so a
  successful close looked like a timeout. (3) The timeout branch returned a
  **hashtable** (`@{closed=$false; note=...}`), and the dispatcher reads any
  hashtable as `ok:true` — a window that was demonstrably still open was audited
  as a successful close, the exact evidence-contract violation
  `src/core/CLAUDE.md` exists to forbid. **Fix:** a pid with no main window is
  re-resolved to the windowed process of the same executable via the existing
  `Resolve-WindowedProcessByName` (same class as the `launch_app` MSIX fix); the
  oracle is now the window handle itself (`HasExited` or
  `MainWindowHandle -eq Zero`), polled for 3s; and a window still open returns an
  honest **string**, which this file's dispatcher maps to `ok:false`. No
  force-kill — closing a browser over unsaved state stays the operator's call.
  `from-pc.js` carries the Node-side backstop for both shapes and no longer clears
  `lastLaunchedPid` on a failed close (the pid is still valid — the window is
  still there).
  **Files:** `mythos/adapters/pc-child/ps-automation.ps1` (`Handle-CloseWindow`),
  `mythos/src/core/effectors/from-pc.js`,
  `mythos/test/close-window-honesty.test.js`. BUG-037's pre-edit protocol was
  followed: all six load-bearing pieces verified present before the edit (UTF-8
  console block, `Await-WinRTOperation` with explicit `[type]$ResultType`,
  `$TargetPid` never `$pid`, DPI-awareness block, `click_at`, command-id echo in
  `Write-Response`).

- **BUG-104 (calendar write does not exist, and `from-calendar.js` advertises one
  that does):** REGISTERED, not fixed — feature, see roadmap §7.6. The operator
  only wanted the appointment marked on his calendar. MYTHOS declined correctly
  under its honesty rule, then fell back to `reminder_add` and hit BUG-100.
  `from-calendar.js`'s header still advertises a Google Calendar layer that exists
  in no file. §7.6 must either implement it (the OAuth adapter already works for
  Gmail, so this is scope, not new auth) or delete the claim — leaving it standing
  is what made the fallback look like a bug rather than a missing feature.

- **BUG-105 (a late tool outcome was narrated as the wrong tool):** FIXED.
  `list_windows` was the late tool; MYTHOS told the operator "It appears the
  **music playback tool** is running late to turn due to an internal
  communication delay" (episodic `ts 1785883515932`). Nothing looked it up wrong.
  `live-tool-adapter.js` emitted the anomaly with the tool under a `tool` key, but
  every immune consumer keys on **`target`** — so `immune/explainer.js` prompted
  the brain with `Target: (none)` and the model invented a plausible component to
  finish the sentence. The server's episodic writer dropped it for the same
  reason, persisting `anomaly: live-tool-outcome-late-for-turn — ` with the one
  useful fact missing. **Fix:** emit `target` alongside `tool`; read `tool` as a
  last resort in the episodic summary; and forbid the explainer from naming any
  tool, provider or subsystem not present in its prompt (with an explicit "say 'a
  tool' rather than guessing" clause when no component was identified). Same
  fabrication class as AD-5's synthesized metrics.
  **Files:** `mythos/src/core/voice/live-tool-adapter.js`,
  `mythos/src/core/immune/explainer.js`, `mythos/server/index.js`,
  `mythos/test/late-tool-anomaly-attribution.test.js`.

### Also surfaced 2026-08-05 — recorded so they are not re-discovered as new

- **Tetris build rejected at review** (`job-1785884427784-197`), plus one
  `kanban-review job job-1785884520157-100 failed`. Markup shipped, game logic
  rejected. Engine quality, not wiring — and one sample proves nothing here
  (sample at least 3 before calling it).
- **No tool for Aether BLE / wake-word phone setup guidance** — MYTHOS said so
  honestly. Documentation gap (`AETHER-WIRING.md`), not a defect.
- **No tool to probe an external CLI (Mistral / hermes)** — honest refusal.
- **`gmail_send` went to a personal address** the operator then had to ask about.
  Worth confirming the self-send default resolves from the authorized account
  rather than a stored contact string.

### Live gate for this session's fixes (none are LIVE-VERIFIED yet)

1. "Remind me about the vet tomorrow at 4pm" → created, real time read back,
   visible in `reminder_list`. (BUG-100)
2. Ask for the window list → **no approval prompt**, real windows. (BUG-102)
3. Force a tool failure (a reminder with a nonsense time) → MYTHOS speaks the
   actual reason, not "Failed". (BUG-101)
4. "Open Brave and open YouTube in it, only Brave" → YouTube is in **Brave**, or
   MYTHOS says plainly it is attached to Chrome and what to do about it. Never a
   silent Chrome navigation described as Brave. (BUG-099)
5. "Close Brave" → it closes, or MYTHOS reports it did not while the window is
   verifiably still open. (BUG-103)
6. Afterwards: no `live-tool-outcome-late-for-turn` in
   `vault/Episodic/<today>.jsonl` narrated with the wrong tool name, and no
   `outcome:ok` in `vault/Audit/<today>.jsonl` on a payload that says otherwise.
   (BUG-105, AD-4/AD-5)

## Session (2026-08-05, afternoon) — same-day follow-up batch: 11 defects, 8 records

Sources: `mythos/vault/Incidents/2026-08-05.jsonl` (8 records, later than the
morning triage above), `mythos/vault/Episodic/2026-08-05.jsonl` (entries
108–203), `mythos/vault/Audit/2026-08-05.jsonl` (89 lines, 4 honest fails, 0
unverified). Two morning fixes were already live-confirmed in this same audit
(`cua_list_windows` ran 9 times with zero approval prompts, BUG-102; the
wrong-browser guard fired honestly, BUG-099's honesty half) — BUG-106 is the
hole in BUG-099's capability half.

- **BUG-110 (`get_directions` exists but voice cannot reach it):** FIXED.
  Registered and tiered T0 (read-only) but absent from `live-tools.js`'s
  `DEFAULT_ALLOWLIST` — voice said "Direct Google Maps directions aren't
  possible" and then did exactly that via `browser_navigate` 26 seconds later.
  Added `get_directions` (and `cua_bring_to_front`, `focus_window`'s cua twin,
  also drifted off the list) to the allowlist, plus a new
  `VOICE_ALLOWLIST_EXEMPT` list and gate test closing the CLASS: every T0/T1
  effector must now be in one list or the other, each entry commented.
  **Files:** `mythos/src/core/voice/live-tools.js`,
  `mythos/test/bug-110-t0-t1-allowlist-reachability.test.js`.

- **BUG-109 (`cua_get_window_state` rejects a string `window_id`):** FIXED.
  The model passed `window_id:"854628"` (numeric string); the truthy-string
  check skipped the pid-resolution fallback and forwarded the string to a
  driver demanding an integer. Added `coerceWindowId()`: a clean numeric
  string becomes a real number; an opaque non-numeric id (`'w-1234'`) passes
  through unchanged, so the pre-existing pid-resolution regression test stays
  green. Applied to `cua_get_window_state`, `cua_click`, `cua_bring_to_front`.
  **Files:** `mythos/src/core/effectors/from-cua.js`,
  `mythos/test/bug-109-cua-window-id-type-coercion.test.js`.

- **BUG-106 (`attachedBrowser` goes stale, driving Chrome under Brave's name):**
  FIXED. Brave was launched and attached; the operator closed it; the adapter
  dropped OFFLINE; the next `browser_navigate`'s lazy `ensureOnline()` silently
  connected/launched Chrome while `attachedBrowser` still said `'brave'` —
  `checkBrowserTarget()` compared against the stale value and passed.
  `checkBrowserTarget()` now reads `browserAgent.getStatus().state` and clears
  `attachedBrowser` whenever not ONLINE; the lazy fallback only sets an
  identity when it actually launched a browser itself, never for a bare CDP
  connect it didn't start.
  **Files:** `mythos/src/core/effectors/from-browser.js`,
  `mythos/test/bug-106-attached-browser-stale.test.js`.

- **BUG-107 (the wrong-browser refusal was a dead end):** FIXED. Added
  `browser_switch(browser)`: disconnects, closes only a browser MYTHOS itself
  launched (never one it merely attached to — that could be the operator's own
  window), and routes through `browser_launch_debug` itself (no second launch
  path). Added to `DEFAULT_ALLOWLIST` and `TIER_TABLE` (T2, matching
  `browser_launch_debug`) — the registered-tool-count gate in
  `effectors-hub.test.js` moved 91→92 to match the genuinely new tool.
  **Files:** `mythos/src/core/effectors/from-browser.js`,
  `mythos/src/core/voice/live-tools.js`, `mythos/src/core/leash/tiers.js`,
  `mythos/test/bug-107-browser-switch-remedy.test.js`,
  `mythos/test/effectors-hub.test.js`.
  **Follow-up (`572a157`), found by review after the fix was called done:** the
  dead end lived in TWO refusals, and only one was fixed. `checkBrowserTarget()`
  (the `browser_navigate` path) named `browser_switch`, but
  `browser_launch_debug`'s own already-ONLINE mismatch branch still said "Close
  it first, then launch chrome" — and that is the branch a model asked to change
  browsers actually reaches first, since it calls `browser_launch_debug`, not
  `browser_navigate`. "Close it first" is an instruction to the operator, not
  something MYTHOS can act on, so the exact defect survived one function over.
  Both refusals now name the remedy. The general lesson: when a fix is "name the
  remedy in the refusal", grep for every site that refuses, not the one the
  incident happened to come through.

- **BUG-115 (the ad blocker cannot work — throwaway debug profile, no
  extensions):** FIXED. Verified read-only during planning: neither debug
  profile has ever had a `Default/Extensions` directory. `browser_launch_debug`
  now reads `BROWSER_EXTENSIONS` (semicolon-separated unpacked directories),
  validates each exists and has a `manifest.json` before spawning anything
  (fails loudly by name otherwise), and passes `--load-extension` +
  `--disable-extensions-except`. The result reports which profile and which
  extension dirs actually loaded — never claims one is active in a profile
  that has none.
  **Files:** `mythos/src/core/effectors/from-browser.js`, `mythos/.env.example`,
  `mythos/test/bug-115-browser-extensions.test.js`.

- **BUG-108 (`see_and_click` OCRs the whole screen, including MYTHOS's own
  window):** FIXED (BUG-037 protocol followed — all six load-bearing pieces
  verified present before and after). `Handle-ScreenReadText` took no
  arguments and always captured the full desktop, so a click meant for a
  YouTube page instead read back MYTHOS's own window. `screen_read_text`/
  `see_and_click` now take an optional `pid` that scopes the OCR capture to
  that window's rectangle (via the existing `Resolve-TargetWindow`/
  `Handle-ListWindows`, no new resolver); with no target, behavior is
  unchanged. The subtle part: OCR boxes come back relative to the captured
  bitmap, with the capture rectangle's own top-left reported as `origin`;
  `from-pc.js`'s `toAbsoluteRegions()` is the single place `origin` is added
  back on, so a window-scoped click still lands at real screen-absolute
  coordinates — pinned with a dedicated test asserting the window-relative
  coordinates are explicitly NOT what gets clicked.
  **Files:** `mythos/adapters/pc-child/ps-automation.ps1`,
  `mythos/src/core/effectors/from-pc.js`,
  `mythos/test/bug-108-screen-read-text-window-scope.test.js`.

- **BUG-116 (MYTHOS narrated a click as successful in the same second it
  failed — largest blast radius):** FIXED. 17:13:04 "The click went through,
  and the screen did change afterwards" — `see_and_click` FAILED at that
  moment per the audit; 49 seconds later it said the opposite. On the Live
  (Gemini S2S) path there is no batch turn boundary to correct at — the model
  speaks its own audio as results arrive, so the functionResponse text is the
  only channel that teaches it what happened, both for the sentence being
  spoken now and for the rest of the retained session. The `started`/
  `unverified` response branches already carried an explicit
  "do not claim this worked" instruction; the failure branches — the ones
  with the strongest reason to — carried a bare error string and nothing
  else. Added one shared `NO_SUCCESS_CLAIM` sentence to every failure-shaped
  response (`status:'failed'`, both `status:'error'` branches,
  `reportLateOutcome`'s failure verdict, `resolveLiveConfirm`'s
  approved-but-failed verdict). No new correction channel — reuses
  `evaluateOutcome`'s existing status vocabulary and the `[SYSTEM]` `sendText`
  channel `reportLateOutcome()` already used. `voice-agent.js` (the non-Live
  batch path) needed no change: its corrective pass already re-derives
  `finalSay` on any failure/unverified action, and its deterministic honesty
  guard already overrides the model's own text when a turn's actions all
  failed — both pre-existing and already test-pinned.
  **Files:** `mythos/src/core/voice/live-tool-adapter.js`,
  `mythos/test/bug-116-live-failed-tool-no-success-claim.test.js`.

- **BUG-114 (`open_web(youtube)` still ships error 153 — diagnosed first):**
  FIXED. `from-dashboard.js`'s oEmbed embeddability pre-check (the BUG-006
  fix) was already correct and already ran unconditionally — no bypass, no
  change needed there. `web-panel.js`'s `onError` postMessage listener was
  also correctly wired. The actual gap: oEmbed's 200 only proves a video is
  embeddable in general, not that YouTube's per-request domain restriction
  allows MYTHOS's own origin — that failure is enforced when the
  `/embed/<id>` document is served, before the IFrame Player API ever
  initializes, so a domain-restricted video never posts `onReady` OR
  `onError` — it silently stalls. The stall timeout fell back to the weak
  "Open in new tab" link instead of the guaranteed auto-open every other
  failure path already uses. Added `shouldAutoOpenOnStall(widgetType)`
  (true only for `'youtube'`); the stall timeout now calls
  `showFallback(shouldAutoOpenOnStall(...))` instead of a hardcoded `false`.
  No second embeddability mechanism added.
  **Files:** `mythos/ui/public/js/views/web-panel.js`,
  `mythos/test/bug-114-youtube-embed-stall-fallback.test.js`.

- **BUG-112 (four greetings in three minutes, one saying "Good morning" at
  5:08 PM):** FIXED. `server/index.js`'s `deliverBootGreeting` correctly
  computes an hour-based salutation, but its brain-composed prompt never
  passed that salutation to the model or forbade inventing a different one —
  same no-fabrication gap as BUG-105's fix to `immune/explainer.js`, now
  applied here too. `planner/daily.js`'s `CANNED_MORNING` was a module-load-
  time constant hardcoded to "Good morning" regardless of actual time —
  replaced with `salutationFor(ts)`/`cannedMorning(ts)`, and its own
  brain-composed brief prompt gets the same salutation-plus-no-invention
  treatment. `conversation/announcer.js`'s `isRecent`/`markAnnounced` dedup
  existed but was private; exposed so other proactive-speech sources share
  one dedup namespace. The actual bypass: `server/index.js`'s
  `bus.subscribe('plan.morning-brief', ...)` handler called `proactiveSpeak`
  with zero dedup check of any kind — it now checks/marks the same
  `'greeting:session'` key `deliverBootGreeting` uses.
  **Files:** `mythos/server/index.js`, `mythos/src/core/planner/daily.js`,
  `mythos/src/core/conversation/announcer.js`,
  `mythos/test/bug-112-greeting-time-honesty.test.js`,
  `mythos/test/bug-112-single-greeting-owner.test.js`.

- **BUG-111 (Gmail was read 14 times; `remember` cannot stop it):** FIXED.
  A stored preference can't change a background timer's behavior — it's code,
  not something the sensor reads. Added `GMAIL_TRIAGE_MODE` to
  `config/schema.js`: `'boot-once'` (new default) runs the sensor's poll
  exactly once at startup then never arms a recurring timer; `'poll'` is the
  pre-2026-08-05 always-on behavior; `'off'` disables the sensor entirely.
  `gmail_unread` (the tool) is unaffected in every mode. Added a poll counter
  exposed via `getPollCount()`, surfaced in `/api/status` via a
  `setGmailPollCountGetter()` setter on `createServer`'s return value (same
  pattern already used for `requestCameraFrame`/`requestClosePanel`).
  **Files:** `mythos/src/core/config/schema.js`,
  `mythos/src/core/sensors/gmail-sensor.js`, `mythos/src/main.js`,
  `mythos/server/index.js`, `mythos/.env.example`,
  `mythos/test/bug-111-gmail-triage-mode.test.js`.

- **BUG-113 (spoken commitments are dropped):** FIXED. MYTHOS said "I'll check
  the ad thing" / "let me look into that", the turn ended, and nothing was
  recorded — asked later "where are we on X", it had to admit nothing had been
  done. `from-calendar.js` gains `detectCommitment(text)` (an explicit, narrow,
  commented first-person-future pattern list — deliberately not a general
  offer/hedge/conditional classifier, since a false entry teaches distrust of
  the ledger, which is worse than missing one), `logCommitmentIfPresent(text,
  {goals})` (logs one inert `status:'proposed'` ledger entry, same anchor
  pattern as the existing reminder-action grant, invisible to
  `getActiveGoals()`'s autonomous-arbiter filter), and `listOpenCommitments(goals)`.
  Wired into both turn-completion paths (`server/index.js`'s batch path,
  `live-tool-adapter.js`'s `onLiveTurnComplete` for Live) and into
  `read_status` (`from-dashboard.js`, via `goals` newly threaded through
  `registerFromDashboard`'s ctx in `main.js`) so "where are we on X" is
  answerable from state.
  **Files:** `mythos/src/core/effectors/from-calendar.js`,
  `mythos/src/core/effectors/from-dashboard.js`, `mythos/src/main.js`,
  `mythos/server/index.js`, `mythos/src/core/voice/live-tool-adapter.js`,
  `mythos/test/bug-113-commitment-ledger.test.js`.

**Incidental fix found mid-batch, not in the original 11:** `main.js`'s
`serverHandle` was `var`-declared inside the `'server'` boot step's own
function literal. Each named boot step (`'server'`, `'sensors'`, …) is its
own function, so the `var` never actually reached the later `'sensors'` step
— BUG-111's `setGmailPollCountGetter()` wiring needed it there, and a full
suite run caught the resulting boot-fatal (`boot.test.js`:
`"serverHandle is not defined"`) before it was committed. Fixed by hoisting
the declaration to the shared outer scope (matching the existing
`metricSensor`/`aetherSensor` pattern) and reassigning it in place.

### Live gate for this session's fixes (none are LIVE-VERIFIED yet)

1. "Open Brave, play Starboy on YouTube" → plays in Brave or names the real
   browser; then close Brave mid-session and ask again → must refuse or
   re-derive, never drive Chrome as Brave. (BUG-106)
2. "Use Chrome instead" while attached to Brave → switches or says why not;
   not a dead end. (BUG-107)
3. "Click the first video" with YouTube focused → any failure's OCR sample
   names YouTube content, never `MYTHOS | File Edit View`. (BUG-108)
4. "Show directions from Kolkata to Bangalore" → answered by `get_directions`,
   no "not possible" preamble. (BUG-110)
5. Watch `vault/Audit/<today>.jsonl` for a full session → exactly one
   `gmail_unread` at boot plus only requested ones, not 14. (BUG-111)
6. Point `BROWSER_EXTENSIONS` at the unpacked ad blocker → ads blocked and the
   launch names the loaded extension; then point it at a missing directory →
   launch fails loudly. (BUG-115)
7. Open the app → one greeting, correct time of day. (BUG-112)
8. "Check X and tell me later" → visible in `read_status`, and "where are we
   on X" answers from it. (BUG-113)
9. Force a tool failure → MYTHOS never says an action succeeded in a turn
   whose audit line says fail; grep `vault/Audit/<today>.jsonl` for any
   `outcome:ok` whose payload disagrees. (BUG-116, AD-4/AD-5)

