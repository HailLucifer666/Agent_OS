# MYTHOS dependency research — 15 capability areas

*2026-08-19. Every star count, licence and last-push date below was read live from the
GitHub API, not from articles. Where GitHub could not classify a licence it says
`NOASSERTION`, which means "unverified", not "permissive" — those are flagged.*

## How to read this

The product is being sold, so each area is judged on three things, in order:

1. **Does it solve the actual failure?** Not "is it popular".
2. **Is the licence safe for resale?** Code licence and *model-weights* licence are
   different questions. That distinction has already bitten this project twice.
3. **What does integrating it cost?** A new runtime the user must install is a real
   cost under the repo's own portability rule.

Where the honest answer is "you already have the right thing", it says so instead of
recommending a swap.

---

## The headline: three corrections to received wisdom

**1. Windows-MCP does not solve the desktop automation problem.** 6,766 stars, MIT,
pushed daily — and verified against its own source (`src/windows_mcp/desktop/service.py`),
not its README:

- `click()` → `uia.Click(x, y)` — a coordinate click, not `InvokePattern.Invoke()`
- `type()` → `uia.Click(x, y)` then `uia.SendKeys(...)` — it clicks to place the caret
  and types, which **is** the caret-follows-focus failure
- window activation → `SetForegroundWindow` + `AttachThreadInput` +
  `AllowSetForegroundWindow(-1)` — the ladder BUG-272 T3 already exhausted

There is no `InvokePattern`, `ExpandCollapsePattern` or `ValuePattern.SetValue` call
anywhere in the file. It uses the accessibility tree to **find** controls and synthetic
input to **drive** them. On MSIX apps it would fail exactly as today.

**2. `rhasspy/piper` is archived and its successor is GPL-3.0.** `providers/piper-tts.js`
still states in a tracked comment that Piper is *"MIT ... the only one of the three usable
in a product that is sold."* That is now false:

- `rhasspy/piper` — 11,279 stars, MIT, **archived 2025-08-26**
- `OHF-Voice/piper1-gpl` — 5,172 stars, **GPL-3.0**, active

Voices on `rhasspy/piper-voices` are also licensed **per voice** (CC BY 4.0 / CC0 / MIT
mixed), so "the voice models carry their own open licences" hides a per-file check that
has not been done.

**3. robotjs was revived and it is still irrelevant here.** v0.8.0 on 24 Jul 2026,
v0.9.1 on 7 Aug 2026, 12,768 stars, MIT. Every article calling it abandoned is stale. It
is also blind coordinate input with no accessibility tree, so it solves none of the three
failures.

---

## 1. Windows desktop automation (no screenshots)

| Repo | Stars | Licence | Last push | MSIX SendInput | Foreground lock | Caret follows focus |
|---|---|---|---|---|---|---|
| FlaUI/FlaUI | 3,095 | MIT | 2026-08-13 | Yes, via patterns | Yes, via patterns | Yes, `ValuePattern` |
| pywinauto/pywinauto | 6,146 | BSD-3 | 2026-05-23 | Yes, if patterns not `click_input()` | Yes | Yes |
| CursorTouch/Windows-MCP | 6,766 | MIT | 2026-08-18 | **No** | **No** | **No** |
| microsoft/WinAppDriver | 4,046 | MIT | last release Nov 2020 | Abandoned | Abandoned | Abandoned |
| octalmage/robotjs | 12,768 | MIT | 2026-08-07 | **No** | **No** | **No** |

**The mechanism that works is `InvokePattern.Invoke()` / `ValuePattern.SetValue()` called
through the UIA COM interface.** It talks to the target app's own automation provider
in-process, never touches the Windows input queue, and needs no foreground window.

**You already built this.** `adapters/pc-child/ps-automation.ps1` has a `uia-setvalue`
route — one of only two measured-working routes on MSIX apps, and it needs no focus.

**So the bottleneck is not a missing library. It is the per-command spawn.** The repo's
own note (`uia-invoke-noop-under-pc-child-spawn.md`) records that `InvokePattern.Invoke()`
works standalone and **silently no-ops** — no exception, false success — when run through
`pc-child`'s per-command `child_process.spawn`. That is a property of how the automation
client is hosted, not of which library issues the COM call. FlaUI or pywinauto, spawned
the same way, would very plausibly no-op identically.

> **Recommendation: do not adopt a library. Change the architecture.** Host the
> UIA-invoking side as a **persistent interactive daemon** — one long-lived automation
> host MYTHOS talks to over a pipe — instead of spawning `powershell.exe` per command.
> If a richer UIA client is wanted afterwards, FlaUI (MIT, active) over pywinauto. But it
> only pays off after the daemon fix; before that it inherits the same no-op.

---

## 2. Acoustic echo cancellation / barge-in

**No maintained Node-native AEC exists.** That is a real gap, not a search failure.

| Option | Stars | Licence | Notes |
|---|---|---|---|
| xiph/speexdsp | 722 | `NOASSERTION` (upstream is Xiph BSD-style — read the file) | The actual AEC algorithm. Small, proven. Needs your own N-API binding |
| WebRTC `audio_processing` (AEC3) | — | BSD-style | Gold standard; what Chromium and Discord use. Extracting it is real work |
| thewh1teagle/aec | 98 | MIT | Rust wrapper over speexdsp. Quiet since Apr 2025 — prototype against it, don't depend on it |
| xiph/rnnoise | 5,785 | BSD-3 | **Noise suppression, not echo cancellation.** Does not fix hearing yourself |

**Check this before building anything.** `ui/public/js/voice/mic-device.js` already requests
`echoCancellation: true`, which is Chromium's AEC3 — the same gold-standard algorithm — and
MYTHOS still hears itself. Adding a second AEC is unlikely to help if the first is being
bypassed. The likely explanation is that some speech leaves through a path AEC3 cannot use
as a reference. Gemini Live audio goes through `pcm-player.js` into a normal `AudioContext`,
which AEC3 should cancel; but there are **three** voice engines, and the browser's
`speechSynthesis` renders outside the page's audio graph where nothing in the renderer can
cancel it.

> **Test before building:** play one sentence through each engine with the mic live and see
> which comes back as a transcript. One session separates a config bug from a missing
> capability — and from a native DSP addon you would then own forever.

---

## 3. VAD

| Repo | Stars | Licence | Last push |
|---|---|---|---|
| **snakers4/silero-vad** | 9,996 | **MIT** (code and models) | 2026-08-18 |
| ricky0123/vad | 2,041 | `NOASSERTION` | 2026-01-30 |

> **Already what you use (`ui/public/js/voice/silero-vad.js`). Change nothing.**

---

## 4. Wake word — the live licensing blocker

| Engine | Stars | Code | **Weights** | Commercial |
|---|---|---|---|---|
| dscripka/openWakeWord *(current)* | 2,673 | Apache-2.0 | **CC BY-NC-SA 4.0** | **Blocks resale** |
| Picovoice/porcupine | 4,913 | Apache-2.0 SDK | **Proprietary** | Paid product. Free tier = 3 users/month; custom training on a personal account is non-commercial only |
| livekit/livekit-wakeword | 245 | Apache-2.0 | You train, you own | Clean |
| AndreiBulzan/heed-wakeword | 11 | Apache-2.0 | You train, you own | Clean but 11 stars |

> **Recommendation: keep openWakeWord's Apache-2.0 *code*, stop shipping its pretrained
> weights.** Train replacement weights you own — LiveKit's pipeline is the best-maintained
> route and has a company behind it. **Porcupine is not the free answer**; its SDK badge
> says Apache-2.0 while the models are proprietary and metered.

---

## 5. TTS

| Option | Stars | Code | Weights | Verdict |
|---|---|---|---|---|
| **hexgrad/kokoro** | 8,466 | Apache-2.0 | **Apache-2.0** | **Clean. Already installed** |
| remsky/Kokoro-FastAPI | 5,348 | Apache-2.0 | same | Optional sidecar |
| OHF-Voice/piper1-gpl | 5,172 | **GPL-3.0** | per-voice, mixed | Copyleft risk |
| rhasspy/piper | 11,279 | MIT | — | **Archived** |
| edge-tts | — | **LGPLv3** | — | Keep BYO, never bundle |

> **Recommendation: promote Kokoro in the chain.** `providers/kokoro-tts.js` exists,
> `kokoro-js` is already a dependency, and `THIRD_PARTY_NOTICES.md` already records the
> Apache-2.0 weights. Your live chain resolved to `gemini-tts,edge-tts,piper-tts` — Kokoro
> is not in it. Reordering removes the LGPL exposure and the new GPL exposure at once,
> with no new dependency.

---

## 6. STT

| Repo | Stars | Licence | Last push |
|---|---|---|---|
| **ggml-org/whisper.cpp** | 53,008 | MIT | 2026-08-18 |
| SYSTRAN/faster-whisper | 24,970 | MIT | 2025-11-19 |
| Const-me/Whisper | 10,631 | MPL-2.0 | 2026-05-24 |
| Kutalia/whisper-node-addon | 14 | MIT | 2025-07-18 |

> **Already what `local-whisper-stt.js` wraps. Change nothing.** If a Node binding is ever
> wanted, vendor its source rather than depending on a 14-star upstream.

---

## 7. Gmail

| Repo | Stars | Licence | Last push |
|---|---|---|---|
| **googleapis/google-api-nodejs-client** | 12,230 | Apache-2.0 | 2026-08-18 |
| taylorwilsdon/google_workspace_mcp | 3,035 | MIT | 2026-08-18 |
| GongRzhe/Gmail-MCP-Server | 1,165 | MIT | **archived** |

> **Change nothing.** The failure is a revoked refresh token, not a library gap. Note:
> the standalone `google-auth-library-nodejs` repo is archived, but that is Google
> consolidating into a monorepo — the npm package is current.

---

## 8. WhatsApp — no safe open-source answer for a sold product

| Repo | Stars | Licence | Weight | Notes |
|---|---|---|---|---|
| wwebjs/whatsapp-web.js | 22,424 | Apache-2.0 | Heavy (Puppeteer) | Browser emulation; breaks when the web client changes |
| WhiskeySockets/Baileys | 10,750 | MIT | Light (WebSocket) | Protocol reimplementation; more fingerprintable |
| open-wa/wa-automate-nodejs | 3,642 | `NOASSERTION` | Heavy | Exclude on licence alone |

**Both violate WhatsApp's Terms of Service.** Meta can ban the linked number without
warning. On a sold product that is a *customer's* number and your support incident.

> **Recommendation: the official WhatsApp Business Cloud API is the only clean route** —
> per-message pricing, template pre-approval, business verification, usually a provider
> fee. A business decision for the licensing gate, not a code choice.

---

## 9. Browser automation

| Repo | Stars | Licence | Last push |
|---|---|---|---|
| puppeteer | 95,462 | Apache-2.0 | 2026-08-18 |
| playwright | 94,693 | Apache-2.0 | 2026-08-18 |
| microsoft/playwright-mcp | 36,247 | Apache-2.0 | 2026-08-17 |

> You already ship `playwright-core`. Puppeteer is the thinner fit for your existing raw
> CDP connection on port 9222; `playwright-mcp` is the cheapest way to get agent-shaped
> browser tools without hand-rolling them.

---

## 10. Android control

| Repo | Stars | Licence | Notes |
|---|---|---|---|
| Genymobile/scrcpy | 147,866 | Apache-2.0 | Standalone binary, screen control — same shell-out shape as today |
| DeviceFarmer/adbkit | 300 | `NOASSERTION` | Real Node adb client; **read the LICENSE before shipping** |
| appium-uiautomator2-driver | 863 | Apache-2.0 | Needs Java + Android SDK — disproportionate |

> Stay on adb. `adbkit` would remove the per-call process spawn, *if* its licence checks out.

---

## 11. Vector memory

| Repo | Stars | Licence | Embedded? |
|---|---|---|---|
| **lancedb/lancedb** | 11,184 | Apache-2.0 | **Yes**, in-process, prebuilt Node binaries |
| qdrant/qdrant | 34,048 | Apache-2.0 | No — server |
| chroma-core/chroma | 29,080 | Apache-2.0 | No — server |
| asg017/sqlite-vec | 8,024 | Apache-2.0 | Yes, as a SQLite extension |

> **LanceDB.** The only genuinely embedded option with first-class Node bindings. It sits
> beside the JSONL vault as an embedding index rather than replacing it. The two
> higher-star options both want a server process, which does not fit.

---

## 12. Screen OCR

| Repo | Stars | Licence | Integration |
|---|---|---|---|
| **naptha/tesseract.js** | 38,638 | Apache-2.0 | Pure JS, no binary |
| RapidAI/RapidOCR | 7,521 | Apache-2.0 | Python sidecar |
| gutenye/ocr | 205 | MIT | Node + ONNX, unproven at scale |

> **tesseract.js** — satisfies the no-external-binary portability rule outright.

---

## 13. Calendar

> **Change nothing.** Already covered by the same `googleapis` client and the same auth
> flow as Gmail. `natelindev/tsdav` (354, MIT) only if non-Google/CalDAV is ever wanted.

---

## 14. Media / Spotify

| Repo | Stars | Licence | Status |
|---|---|---|---|
| DubyaDude/WindowsMediaController | 190 | MIT | C# — same sidecar shape you already have |
| NodeRT/NodeRT | 669 | `NOASSERTION` | Stale since 2024-05 |
| thelinmichael/spotify-web-api-node | 3,154 | MIT | **archived** — works, no future patches |
| Abdullah-Malik/spotified | 114 | none declared | Active but tiny, licence unverified |

> Keep the WinRT/SMTC approach — every Node binding is stale with an unverified licence.
> Budget for forking or replacing the archived Spotify client before release.

---

## 15. MCP servers worth adopting

MYTHOS already has an MCP client (`src/core/effectors/from-mcp.js`), so these are cheap.

1. **fetch** (official monorepo, 89,665 stars) — web content to clean markdown
2. **filesystem** (official) — sandboxed file ops without touching PowerShell
3. **microsoft/playwright-mcp** (36,247, Apache-2.0) — structured web automation
4. **git** (official) — only if developer workflows land

> Skip everything in `servers-archived` — retired by the MCP org with an explicit
> no-security-guarantees notice. Note the parent repo's licence reads `NOASSERTION`; the
> individual packages are MIT, so check the sub-package before bundling.

---

## Licence gate — the loud list

| Item | Problem | Status |
|---|---|---|
| openWakeWord weights | CC BY-NC-SA 4.0, non-commercial | **Blocks resale today** |
| `piper-tts.js` comment | Asserts Piper is MIT and sale-safe; upstream archived, successor GPL-3.0 | **Stale claim in a tracked file** |
| edge-tts | LGPLv3, personal-use labelled | Mitigated by BYO; Kokoro removes it entirely |
| Picovoice/Porcupine | Apache-2.0 badge, proprietary metered models | Do not record as "solved" |
| WhatsApp libraries | ToS violation, customer ban risk | Business decision |
| `adbkit`, `NodeRT`, `speexdsp`, MCP monorepo | `NOASSERTION` | Read the actual LICENSE before shipping |
| `spotify-web-api-node` | Archived, no security patches | Fork or replace before release |

*Observations about licences, not legal advice. The gate is still a lawyer's call.*

---

## What I would actually do, in order

1. **Reorder the TTS chain to put Kokoro first.** Config only. Removes two licence
   exposures. Nothing to install.
2. **Run the three-engine echo test.** One session. Decides whether AEC is a config bug
   or a native addon you own forever.
3. **Make the UIA automation host a persistent daemon.** This is the desktop automation
   fix. No library adoption changes it.
4. **Train your own wake-word weights.** The only item that hard-blocks selling.
5. **Decide WhatsApp at the business level** before writing any more code against it.

Everything else — Gmail, calendar, VAD, STT, browser — is already correct. The most common
honest answer in this research was "you already have it."
