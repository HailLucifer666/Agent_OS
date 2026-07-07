# Agentic OS — Roadmap

This document captures the sprint history and what is intentionally deferred, so the scheme stops living only in code comments and commit messages.

## Sprint history

| Sprint | Branch | Scope | Outcome |
|--------|--------|-------|---------|
| 1 | `sprint-1-2-runnable-zcode-nim` (contained in main) | Runnable core: Mission Control dashboard, Express server, vault, `/api/status` agent probes, SPA shell | ✅ Shipped (`e73c9ca`) |
| 2 | (same) | ZCode + NVIDIA NIM reasoning engines so the orchestrator runs without an Anthropic key | ✅ Shipped (`e3d1fc9`, `f03884e`) |
| 3 | (same) | `node:test` safety net across state modules + server smoke | ✅ Shipped (`680c71e`) — 62 tests / 6 suites |
| 4 | (same) | Free-provider fleet (7 providers) + activity monitor + Quota Tracker | ✅ Shipped (`3fe2dfa`, `c8f9d91`) |
| 5 | (same) | Free Microsoft Neural TTS via edge-tts (322 voices) | ✅ Shipped (`7de3a6d`) |
| 6 | `sprint-6-close-phase-2-gaps` | Close documented "Phase 2" UI gaps | ✅ Shipped (5 commits) — see below |
| 7 | `main` (direct) | Land sprints 1–6 to main, then harden | ✅ Shipped (8 commits) — see below |
| 8 | `sprint-8-free-claude-builder` | Wire Free Claude Code Agent Factory + Chat & Workspace | ✅ Shipped (see below) |
| 9 | `sprint-9-radar-improvements` | Free-only Radar improvements: dedup, keyword scoring, Draft this button | ✅ Shipped (see below) |
| 10 | `sprint-10-voice-control-phase-1` | Hands-free voice control: hold Space or mic pill → Ollama JSON agent → dashboard + computer tools | ✅ Shipped (see below) |
| 11 | `main` (direct) | Voice Control Phase 2: fully-local speech-to-speech pipeline, browser-free open-mic, connection-scoped confirmations | ✅ Shipped (see below) |
| 12 | `main` (direct) | Voice Control Phase 3: Voice HUD observability view with merged activity log, health status, confirmation banner | ✅ Shipped (see below) |
| 13 | `main` (direct) | Jarvis UI Shell Rebuild: navy/cyan palette, 56px icon rail, canvas arc reactor, Command Deck + Agents + Settings views, brand system | ✅ Shipped (see below) |
| 14 | `main` (direct) | Model Registry + Provider Fallback Chain: live-probed NIM/Ollama registry, ranked chains, cooldown, key rotation | ✅ Shipped (see below) |
| 15 | `main` (direct) | PC Control: PowerShell UIA + SendInput automation, 10 voice tools (windows, media, screenshots, UI automation), settings integration | ✅ Shipped (see below) |
| 16 | `main` (direct) | Browser Automation: Chrome CDP via playwright-core, 10 voice tools (navigate, click, type, screenshot, tabs, scroll, evaluate), settings integration | ✅ Shipped (see below) |

### Sprint 6 — Close Phase 2 gaps

| Workstream | Outcome |
|------------|---------|
| Mission Control cards | Cards now render for all ~10 chat agents, driven from `/api/status` (was hardcoded to 3) |
| Voice input | Web Speech API helper wired into agent-chat, free-claude, goals, video-studio. Honest-disable on Firefox/Safari |
| Memory Galaxy | **No change needed** — verified already wired in Sprints 1–3 (27 notes / 16 with real `[[wiki-link]]` edges). The "Phase 2" attribution came from a research prototype, not the shipped canvas |
| Video render | `POST /api/video/render` via ffmpeg (mux voiceover+broll, or concat avatar+broll) → `final.mp4` |
| Radar signals | `GET /api/radar/signals` free RSS aggregation (no API keys) + `RADAR_FEEDS` env |

Built a codebase knowledge graph first via `graphify` (632 nodes, 927 edges, 50 communities, 0 host-session tokens) so build agents queried a compact graph instead of re-reading files.

### Sprint 7 — Land + harden

Fast-forward merged sprint-6 to `main` (11 commits, zero conflicts). Then hardened, in priority order:

| Item | Change |
|------|--------|
| H1 | Bind `app.listen` to `127.0.0.1` (was `0.0.0.0` — dashboard was LAN-reachable). `BIND` env override. |
| H2 | Gate `kill-session`/`kill-port` endpoints to loopback (403 non-local, even if `BIND=0.0.0.0`). |
| H3 | Zero-dep token-bucket rate limiter: 240/min global, 8/min on expensive routes. |
| H4 | Zero-dep structured JSON logger + `requestId` on every request. |
| H5 | Centralized error middleware: generic `{ error, requestId }` to client, full stack logged server-side. |
| H6 | Graceful shutdown drains HTTP + WS + TTS child (5s hard timeout) + `uncaughtException`/`unhandledRejection` handlers. |
| H7 | Explicit CORS allowlist (localhost origins; `ALLOWED_ORIGINS` env). |
| H8 | This README + root README + `app/README.md`. |

98 tests green throughout. No new npm dependencies — deliberate minimalism (3 prod deps, 0 dev deps).

### Sprint 8 — Wire Free Claude Code

| Workstream | Outcome |
|------------|---------|
| Agent Factory build | `POST /api/free-claude/build` endpoint via reasoning engine chain (ZCode → NIM → Claude CLI). Builds save single-file HTML to `vault/builds/free-claude/`. Same pattern as Game Studio. |
| Chat & Workspace | WebSocket agent `free-claude-code` wired to Claude CLI (defaults to `FREE_CLAUDE_MODEL` or haiku). Real streaming, vault auto-save, stop support. |
| `saveDeliverable()` refactor | Extracted `kind` parameter so builds save to the correct `vault/builds/{kind}/` subfolder instead of hard-coded `pipeline/`. |
| Phase 2 placeholders removed | Build button now triggers real builds. Chat tab streams live. Gallery auto-refreshes after builds. |

102 tests green. No new npm dependencies.

### Sprint 9 — Free-only Radar improvements

| Workstream | Outcome |
|------------|---------|
| Signal dedup | Cross-posted articles appearing in multiple feeds are now deduplicated by normalized title. Keeps first occurrence (earliest date wins). |
| Keyword relevance boost | Optional `RADAR_KEYWORDS` env var boosts signal scores when configured topics appear in title/body (+5 per keyword, max +20). Zero API cost. |
| Draft this button | "Draft this" on each signal card copies a formatted draft (title, body, source, link) to clipboard with visual confirmation. Zero dependencies. |

111 tests green. No new npm dependencies.

### Sprint 10 — Voice Control Phase 1

| Workstream | Outcome |
|------------|---------|
| Voice brain | Ollama-driven JSON tool-calling agent in `app/lib/voice/voice-agent.js` — parses utterances against a 20-tool catalog (10 dashboard: navigate/goals/pipeline/kanban/ask-agent/monitor, 10 computer: folder/files/text/email). Zero arbitrary shell execution, auditable tool set only. |
| Dashboard integration | Push-to-talk: hold Space bar (ignored in text fields) or click header mic pill → live voice input → local Ollama model → execute dashboard tools live. Browser mic + existing edge-tts for replies. |
| Safety layer | Danger-tier tools (delete goal, execute card, assemble/build, kill session) require explicit spoken confirmation round-trip before executing. Confirms use `crypto.randomUUID()` and bind to originating WebSocket connection. |
| Computer tools | `open_folder` (Explorer), `list_folder`, `read_file` (text only), `compose_email` (drafts + opens mailto:/Gmail, does not auto-send). Filesystem access sandboxed to `VOICE_ALLOWED_DIRS`. |
| Config | 7 new env vars: `VOICE_ENABLED`, `VOICE_OLLAMA_MODEL`, `VOICE_MAX_TOOL_ITERATIONS`, `VOICE_TTS_VOICE`, `VOICE_CONFIRM_TTL_MS`, `VOICE_ALLOWED_DIRS`, `VOICE_EMAIL_MODE`. |
| Honest degradation | Pill shows `VOICE OFFLINE` if Ollama is unreachable; falls back to browser speech synthesis if edge-tts fails; tool errors surface plainly, never silently swallowed. |
| Security review | Pre-ship audit found 2 issues (both fixed + regression-tested): missing Origin check on `/ws` (cross-site WebSocket hijacking — fixed with same allowlist as `/api/*`), and low-entropy confirm IDs (fixed with UUID + per-connection binding). Two informational items noted for future hardening: symlink resolution in sandbox, untrusted-content delimiters in model context. |
| Testing | 214 tests green. Spike: ~20 candidate-model utterances against Ollama before finalizing prompt — caught and fixed 25% false-danger-invocation rate on ambiguous phrasing (e.g. "get rid of it"). Full WS protocol integration suite. |

214 tests total (111 → 214). No new npm dependencies.

### Sprint 10 Phase planning

**Phase 1 (shipped):** Browser mic + Ollama reasoning + existing edge-tts (requires Ollama running locally + edge-tts service). Dashboard control + basic computer tools. Confirmation gating on danger actions. Voice-over-WebSocket protocol.

**Phase 2 (shipped Sprint 11):** Fully-local speech-to-speech pipeline (Silero VAD + faster-whisper STT + Kokoro TTS) replacing browser Web Speech API. True open-mic hands-free without browser tab, no cloud STT.

**Phase 3 (planned):** Dedicated Voice HUD view with live transcript, action log, and tool result viewer.

### Sprint 11 — Voice Control Phase 2

| Workstream | Outcome |
|------------|---------|
| S2S child process | `app/lib/voice/s2s-child.js` manages optional HuggingFace speech-to-speech pipeline lifecycle: resolves venv, spawns with local mode + faster-whisper + Kokoro, captures stdout/stderr ring buffer, auto-restart on crash (2 attempts), graceful shutdown. If pipeline not installed, server behaves identically to before — honest OFFLINE status. |
| S2S transport adapter | `app/lib/voice/s2s-completions.js` exposes `POST /voice/v1/chat/completions` (OpenAI-shaped endpoint) so pipeline points to dashboard as its LLM backend. Reuses exact same Phase 1 `voiceAgent.handleUtterance` brain — zero modifications to voice-agent.js, tools, or WS protocol. New transport, same agent. |
| Confirmation fix | Phase 1 security review found confirmations lacked connection identity. Fixed: S2S transport generates stable connection ID, so all confirmations are properly scoped like WebSocket transports. Additionally, one-pending tracker now recognizes accept phrases to resolve confirmations, mirroring Phase 1's behavior. Both fixes regression-tested. |
| Status endpoint | `/api/voice/status` now reports third `s2s` block (process state + ring buffer log lines) alongside existing Ollama-brain and edge-tts status. |
| Setup script | `app/services/setup-s2s.ps1` (new): locates Python 3.10-3.12, creates venv, installs pipeline with faster-whisper, detects CUDA vs CPU for torch, checks espeak-ng, smoke-tests, lists audio devices. Off by default; operator runs manually to enable Phase 2. |
| Env vars | Five new knobs: `S2S_AUTOSTART` (default false), `S2S_VENV`, `S2S_MODE`, `S2S_STT`, `S2S_TTS`. Allows tuning of VAD/STT/TTS models if pipeline updated. |
| Secondary: compose_email default | `compose_email` tool's `VOICE_EMAIL_MODE` default changed from `mailto` (desktop app) to `gmail` (browser tab) — no desktop client configured on this machine. Same tool, same safety (drafts only, human clicks Send). |
| Secondary: test hygiene | `compose_email` unit test wasn't mocking `child_process.spawn`, so running tests was opening real browser/mail windows. Now stubbed — tests assert behavior without side effects. |
| Security review | Pre-ship audit on Phase 2 additions: confirmed connection-scoped confirmations (fix above) + functional confirmation-reply mechanism (fix above) + diagnostic log redaction (no local paths leaked via status endpoint). No exploitable issues; honest framing matches Phase 1 review posture. |
| Testing | 240 tests green (214 → 240). New suites for s2s-child, s2s-completions, confirm tracker. End-to-end live testing with real installed pipeline and microphone not performed in this dev environment — validation checklist in `app/services/README.md` documents specific items to verify on a live install. |

240 tests total. No new npm dependencies.

### Voice Control Phase planning (post Phase 2)

**Phase 1 (shipped):** Browser mic + Ollama reasoning + existing edge-tts. Dashboard control + basic computer tools. Confirmation gating on danger actions. Voice-over-WebSocket protocol.

**Phase 2 (shipped):** Fully-local speech-to-speech pipeline (Silero VAD + faster-whisper STT + Kokoro TTS) running as managed child process. True open-mic hands-free without browser tab. Same agent brain, new transport. Off by default, opt-in via setup script.

**Phase 3 (shipped):** Dedicated Voice HUD view with merged, chronological activity log (utterances, tool calls, replies, confirmations). Health panel for brain/S2S/TTS status. Interactive Confirm/Cancel banner. Same-tab-only scope by design. Pure client-side, zero backend changes.

### Sprint 12 — Voice Control Phase 3

| Workstream | Outcome |
|------------|---------|
| Voice HUD view | New file `app/public/js/views/voice-hud.js`: unified observability of voice activity from the current browser tab since page load. Merged chronological feed (utterances, tool calls with arguments/results, agent replies, pending confirmations). Registered in router and sidebar under WORKSPACE group (alongside Mission Control and Agent Monitor). |
| Health panel | Status cards for voice brain (Ollama) reachability, S2S child process state (if enabled), and TTS availability. Mute toggle for the mic pill. Pulls from existing `/api/voice/status` endpoint — no new backend work. |
| Confirmation banner | Interactive Confirm/Cancel buttons for pending danger-tier confirmations, using the same underlying WebSocket mechanism as Phases 1 and 2. User can click to confirm or cancel pending actions in place. |
| Same-tab scope | By design, the view shows activity only from the current browser tab since page load. No cross-tab history, no persistence across reload, no activity from before page opened. This is a deliberate investigation-backed choice (not an apology), stated plainly in the UI. |
| Client-side extension | Small, additive extension to existing Phase 1 `voice-control.js` module (which was originally designed for this consumer): in-memory bounded event history (subscription API) tracking utterances, tool calls, replies, and confirmations. Zero changes to any server-side voice code (brain, tool catalogs, WebSocket protocol, S2S transport). |
| Test suite | 257 tests green (240 → 257). New suites for voice-hud view, event/history API, and subscription mechanics. All new tests cover client-side behavior only; zero edits to pre-existing tests. |

257 tests total. No new npm dependencies.

### Sprint 13 — Jarvis UI Shell Rebuild

| Workstream | Outcome |
|------------|---------|
| Design tokens | `tokens.css`: all CSS var NAMES preserved, values shifted from purple/gold to navy/cyan Jarvis palette. Added `--accent-dim`, `--accent-glow`, `--danger`, `--ok`, `--hairline`, `--panel`, `--font-ui`, `.glass` utility, `prefers-reduced-motion` block. |
| Brand system | `brand.js` reads `BRAND_NAME` env (default "NOVA") via `/js/env.js` server endpoint. Title, header, wordmark all derive from one source of truth. |
| Arc reactor | `jarvis-core.js`: 5 concentric canvas rings with per-state speed multipliers (idle/listening/thinking/speaking). Respects `prefers-reduced-motion`, pauses on tab hidden. |
| Sidebar rebuild | `shell.css` + `sidebar-config.js`: 56px icon rail with centered icons + labels below. STUDIOS group collapsed. Legacy route redirects (9 old routes → `agents`). |
| New views | Command Deck (reactor + activity feed + model strip), Agents (unified chat with model picker via chain), Settings (brand, model chain, voice, integrations). |
| Activity bus | `activity-bus.js` client-side ring buffer subscribes to WS broadcasts (`activity`, `voice-ui`, `job-update`). Powers Command Deck feed. |
| Legacy safety | `LEGACY_REDIRECTS` map + `history.replaceState` for silent redirects. Old seat files still exist but unreachable via sidebar. |

133 tests green. No new npm dependencies.

### Sprint 14 — Model Registry + Provider Fallback Chain

| Workstream | Outcome |
|------------|---------|
| Registry | `lib/models/registry.js`: probes NIM and Ollama endpoints concurrently, ranks alive models per preference table, TTL cache (5min default), force-refresh, concurrent coalescing. |
| Chain | `lib/models/chain.js`: walks ranked text/vision chains with per-model cooldown (60s), NIM key rotation between two keys, vision message translation for Ollama. `chainExhausted` error when all lanes fail. |
| API | `GET /api/models/status` (live chain state), `POST /api/models/refresh` (force reprobe). |
| Integration | Voice agent (`chain.complete()`) and Agents chat view both use the chain for model selection. Best-first fallback with zero configuration. |

21 model tests green. No new npm dependencies.

### Sprint 15 — PC Control

| Workstream | Outcome |
|------------|---------|
| Spike C0 | UIA tree walking, SendInput P/Invoke, and screenshot capture all validated GO on Windows 11. Scripts in `scripts/pc-spike/`. |
| PowerShell module | `ps-automation.ps1`: JSON-over-stdin daemon handling 10 commands (launch_app, list_windows, focus_window, close_window, media_key, screen_look, ui_elements, ui_click, ui_type, write_note). Uses UIAutomationClient for window management, SendInput for keyboard/mouse, System.Drawing for screenshots. |
| Child bridge | `pc-child.js`: lifecycle management (spawn/restart/shutdown) matching s2s-child.js pattern. Serialized command queue, 15s timeout per command, ping handshake on startup. |
| Voice tools | `tools-pc.js`: 10 async tools wired into voice-agent's TOOL_REGISTRY. `close_window` and `ui_click` are danger:true (confirm-gated). `list_windows`, `screen_look`, `ui_elements` return needs_result for multi-turn reasoning. |
| Server wiring | `PC_AUTOMATION=true` env to opt-in. `/api/pc/status`, `/api/pc/start`, `/api/pc/stop` endpoints (loopback-gated). Voice status endpoint includes `pc` block. Graceful shutdown kills PS child. |
| Settings view | PC Automation panel with Start/Stop toggle, live status polling. Voice panel shows PC status inline. |

82 tests green (257 → 82 in combined A+C suite). No new npm dependencies. Phase C complete.

### Sprint 16 — Browser Automation (Chrome CDP)

| Workstream | Outcome |
|------------|---------|
| Spike | Chrome CDP confirmed on Windows 11 (Chrome 149). playwright-core connects via `connectOverCDP`, navigates, reads DOM, screenshots. No browser download needed — reuses existing Chrome installation. |
| playwright-core | Installed as sole new npm dependency (72 packages). Connects to Chrome with `--remote-debugging-port=9222` launched via setup script. |
| Setup script | `app/services/setup-chrome-debug.ps1`: finds Chrome, launches with debug port, validates CDP endpoint, handles already-running instances. |
| Browser agent | `browser-agent.js`: CDP lifecycle management — `connect(url)`, `disconnect()`, `getStatus()`, `withPage(callback)`. Auto-cleanup on disconnect events. |
| Voice tools | `tools-browser.js`: 10 async tools — `browser_navigate`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_get_title`, `browser_get_text`, `browser_scroll`, `browser_tabs` (list/new/switch/close), `browser_go_back`, `browser_evaluate`. Only `browser_evaluate` is danger:true. |
| Server wiring | `BROWSER_CDP_URL` env opt-in. `/api/browser/status`, `/api/browser/connect`, `/api/browser/disconnect` endpoints (loopback-gated). Voice status includes `browser` block. |
| Settings view | Browser Automation panel with Connect/Disconnect toggle, live status polling, CDP URL display. Voice panel shows browser status inline. |
| Input validation | All tools validate inputs before checking online status — specific error messages even when browser is offline. |

111 tests green (82 C + 29 D). 1 new npm dependency (playwright-core). Phase D complete.

**Phase 1 (shipped):** Browser mic + Ollama reasoning + existing edge-tts. Dashboard control + basic computer tools. Confirmation gating on danger actions. Voice-over-WebSocket protocol.

**Phase 2 (shipped):** Fully-local speech-to-speech pipeline (Silero VAD + faster-whisper STT + Kokoro TTS) running as managed child process. True open-mic hands-free without browser tab. Same agent brain, new transport. Off by default, opt-in via setup script.

**Phase 3 (shipped):** Dedicated Voice HUD view with merged, chronological activity log (utterances, tool calls, replies, confirmations). Health panel for brain/S2S/TTS status. Interactive Confirm/Cancel banner. Same-tab-only scope by design. Pure client-side, zero backend changes. Voice control feature complete.

## Intentionally deferred

These are out of scope by design, not oversights:

- **Auth / multi-user** — the project is single-user local-first. Sprint 7's loopback bind + loopback-only kill endpoints close the network exposure without auth complexity. Multi-user would change the product fundamentally.
- **Next.js / React migration** — `the-agent-operating-system Idea.txt` references Next.js/React, but the shipped codebase is intentionally a no-build vanilla-JS SPA. No migration planned.
- **Express 5 upgrade** — Express 5 is GA but the upgrade carries subtle breaking-change risk; separate from hardening.
- **Static-asset cache headers** — minor perf, not security.
- **Per-route body size limits** — the global 1mb cap is adequate for localhost.

### Feature ideas for future sprints

Gathered from the `.kilo` gap audit and code comments — not committed, ranked roughly by user value:

- **Radar X/Grok live API wiring** — Sprint 6 closed the gap with a free RSS MVP; the original vision was paid X/Grok APIs for higher-signal sourcing.
- **Video Studio: Create + Avatar tabs** — currently "coming in Phase 2" placeholders.
- **Omi device sync** — Memory surface is vault-wired already; physical Omi recorder sync is a device-integration feature.
- **Session picker for Claude Code `--resume`** — the flag works; there's no UI to choose which past session to resume.
- **Hermes Goal Mode / profiles / Jarvis / MCP tabs** — listed placeholders.
- **PC Automation vision fallback** — Phase C shipped UIA + SendInput; the vision pipeline (screenshot → VLM → coordinate extraction → click) is the next capability layer for when UIA can't reach a target.
- **Browser automation (Chrome CDP)** — Phase D candidate. `playwright-core` as the sole new npm dependency. DevTools Protocol for web page control.
- **OpenClaw local gateway** — surface exists but no gateway is configured.

## Process notes

- Sprints are merged to `main` via fast-forward when possible (main is kept linear).
- The `graphify-out/` knowledge graph and `.kilo/` planner scratch are gitignored — regenerated locally per sprint.
- The two sprint branches (`sprint-1-2-runnable-zcode-nim`, `sprint-6-close-phase-2-gaps`) are preserved for history; all their work is in `main`.
