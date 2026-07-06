<div align="center">

# Agentic OS

**A local-first, single-user mission control for AI agents.**

One screen. One shared brain. One crew. Builds while you watch.

[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-3-005571?logo=npm&logoColor=white)](app/package.json)
[![Dev Deps](https://img.shields.io/badge/dev_dependencies-0-005571?logo=npm&logoColor=white)](app/package.json)
[![Tests](https://img.shields.io/badge/tests-node%3Atest%20%C2%B7%2098-2dd4bf)](app/server.test.js)
[![Bind](https://img.shields.io/badge/bind-127.0.0.1-76b900)](app/server.js)
[![License](https://img.shields.io/badge/license-personal%2Fhobby-lightgrey)](#license)

</div>

---

> **Honest-inert by design.** Missing keys, dead providers, and failed calls show up as `OFFLINE` / `DEGRADED` — never faked. Quota numbers are estimates. Errors surface verbatim. If something doesn't work, you see that it doesn't work.

Agentic OS runs entirely on your machine — no cloud, no account, no telemetry. Every agent shares one Obsidian-compatible **vault** so context is never re-explained. A reasoning engine resolves `ZCode → NIM → Claude CLI`, so the orchestrator runs without an Anthropic key. A fleet of free OpenAI-compatible providers (Groq, Cerebras, Mistral, Cloudflare, OpenRouter-Free) ships through one factory.

<p align="center">
  <em>Mission Control — the fleet at a glance.</em><br>
  <img src="Dashboard Assets/built/mission-control.png" alt="Mission Control dashboard" width="880">
</p>

---

## Table of contents

- [Quickstart](#quickstart)
- [How it's built](#how-its-built)
- [Core features](#core-features)
- [The provider fleet](#the-provider-fleet)
- [How a request flows](#how-a-request-flows)
- [Orchestration workflow](#orchestration-workflow)
- [Screenshots](#screenshots)
- [Roadmap](#roadmap)
- [What's left](#whats-left)
- [Tech stack & layout](#tech-stack--layout)
- [Documentation](#documentation)
- [License](#license)

---

## Quickstart

**Windows** — double-click `Start Agent OS.bat`.

**Any platform**

```bash
cd app
npm install        # 3 deps, finishes in seconds
node server.js
```

Then open <http://localhost:4477>.

The server binds to `127.0.0.1` (loopback only) — the dashboard is unreachable from your LAN. Set `BIND=0.0.0.0` only if you deliberately want network exposure; the process-killing monitor endpoints stay loopback-gated either way.

Copy `app/.env.example` to `app/.env` and fill in keys as desired. The app boots **degraded without any keys** — the dashboard still loads and status tiles show exactly what's offline.

---

## How it's built

```mermaid
flowchart LR
    subgraph Browser["Browser (vanilla-JS SPA, no build step)"]
        UI["Shell + 30 view modules"]
        WS["ws.js client"]
    end
    subgraph Server["Express server  :4477  bound 127.0.0.1"]
        Mid["Middleware stack<br/>requestId · json · logger · CORS · rate-limit"]
        API["34 API routes"]
        WSrv["WebSocket /ws<br/>13 Mastermind seats"]
        Orch["Orchestrator<br/>job queue + reasoning engine"]
    end
    subgraph Local["Local machine"]
        Vault[("Vault<br/>Obsidian-shaped<br/>JSON + Markdown")]
        TTS["edge-tts<br/>Python service :5050"]
        AB["abtop CLI<br/>agent monitor"]
        CLI["claude CLI<br/>child_process"]
        FF["ffmpeg<br/>video render"]
    end
    subgraph Cloud["Free / low-cost providers"]
        ZC["ZCode · NIM<br/>reasoning"]
        Fleet["Groq · Cerebras · Mistral<br/>Cloudflare · OpenRouter-Free"]
        Media["Suno · HeyGen · ElevenLabs<br/>MiniMax · Grok · OpenAI"]
    end

    UI <-->|HTTP /api| Mid
    UI <-->|WebSocket| WSrv
    Mid --> API --> Orch
    API --> Vault
    API --> TTS
    API --> AB
    API --> CLI
    API --> FF
    Orch -->|reasoning.chat| ZC
    WSrv --> Fleet
    WSrv --> CLI
    API --> Media
```

Everything inside the **Local** and **Server** boxes stays on your machine. Only the **Cloud** box leaves localhost, and only when a key is present.

---

## Core features

22 surfaces across 5 sidebar groups. Each row below is a real route in `app/public/js/sidebar-config.js`.

### 🛰️ Workspace — the dashboard layer

| Surface | What it does |
|---|---|
| **Mission Control** | Live status tiles for the whole fleet, one card per chat agent, heartbeat + latency. |
| **Provider Activity** | Real-time log of *your own* free-provider API calls — calls/min, tokens/min, success rate. |
| **Quota Tracker** | Estimated free-tier usage per provider against researched caps (labeled as estimates — no free API exposes real remaining quota). |
| **Agent Monitor** | Live Claude Code / Codex / OpenCode sessions on this machine, via the `abtop` CLI. Kill by PID (loopback-only). |

### 🧠 Agent Orchestration — the spine

| Surface | What it does |
|---|---|
| **Paperclip** | Idea intake → drops straight into Pipeline Capture. |
| **AI Agent Mastermind** | A 13-seat room streaming concurrently over WebSocket: Claude, Hermes, ZCode, NIM, Free-Claude, Gemini, Codex, GLM, Groq, OpenRouter-Free, Cerebras, Mistral, Cloudflare. `@mention` to filter seats. Every exchange auto-saves to the vault. |
| **Pipeline** | Capture → Human Gate → Execute → Shipped. Approve/reject/ship cards; Execute enqueues an orchestrator job. |
| **Agent Kanban** | Backlog → Building → Review → Done board, driven by Planner / Builder / Reviewer agents. |

### 💬 Agents — the chat fleet

Nine dedicated chat surfaces, all streaming over `/ws` with vault auto-save:

`Claude` · `Hermes` (Ollama) · `ZCode` (GLM-4.6) · `NVIDIA NIM` (Nemotron-70B) · `Groq` · `OpenRouter Free` · `Cerebras` · `Mistral` · `Cloudflare AI`

### 🪞 Self — your context

| Surface | What it does |
|---|---|
| **Memory** | Obsidian-vault notes rendered as a navigable **galaxy** — each note a star (size ∝ recency), each `[[wiki-link]]` an edge. |
| **Goals** | CRUD against `vault/Goals.md`, categories, progress stats. Voice-input supported. |
| **The Radar** | Free RSS signal aggregation (configure feeds via `RADAR_FEEDS`). Server-side fetch to avoid CORS. X/Grok paid APIs are a future enhancement. |
| **Free Claude Code** | Agent Factory UI for $0 local builds. *UI-ready; Claude Code CLI wiring into this view is in progress.* |

### 🎬 Studio — generation surfaces

| Surface | Engine | Status |
|---|---|---|
| **Game Studio** | Reasoning engine → single-file HTML game | ✅ Live |
| **Thumbnail Studio** | OpenAI `gpt-image-1` generate/edit | ✅ Live |
| **Music Studio** | Suno (via sunoapi.org proxy) | ✅ Live |
| **Video Studio** | HeyGen/ElevenLabs narrator + MiniMax/Grok b-roll, **combined via ffmpeg** | ✅ Live |
| **Voice Studio** | Free Microsoft Neural TTS via edge-tts — 322 voices | ✅ Live · *UNOFFICIAL* |

<p align="center">
  <em>Memory Galaxy — vault notes as a navigable starfield.</em><br>
  <img src="Dashboard Assets/built/memory-galaxy.png" alt="Memory Galaxy" width="880">
</p>

---

## The provider fleet

The reasoning engine (used by the orchestrator) resolves in priority order: **ZCode → NIM → Claude CLI fallback**, so Pipeline Execute / Kanban build / review jobs run without an Anthropic key. The chat fleet is OpenAI-SSE-compatible, built from one factory (`lib/providers/openai-compat.js`).

| Provider | Kind | Model | Free-tier cap | Powers | Status |
|---|:---:|---|---|---|:---:|
| **ZCode** | chat | Z.AI GLM-4.6 | Z.AI coding plan | Reasoning engine (primary), chat seat | ✅ |
| **NVIDIA NIM** | chat | Nemotron-70B | ~1,000 credits · 40 RPM | Reasoning engine (fallback), chat seat | 🧪 trial |
| **Groq** | chat | Llama 3.3 70B | ~14,400 req/day · 30 RPM | Chat seat, Mastermind seat | ✅ |
| **Cerebras** | chat | Llama 3.1 8B | ~1M tokens/day | Chat seat, Mastermind seat | ✅ |
| **Mistral** | chat | mistral-small-latest | ~1 req/sec | Chat seat, Mastermind seat | ✅ |
| **Cloudflare AI** | chat | Llama 3.3 70B fp8 | 10,000 Neurons/day | Chat seat, Mastermind seat | ✅ |
| **OpenRouter Free** | chat | `openrouter/free` router | ~50 req/day | Chat seat, Mastermind seat | ✅ |
| **Edge TTS** | tts | 322 Microsoft Neural voices | Unlimited | Voice Studio, video narration | ⚠️ unofficial |
| **Ollama** | chat | any local model | unlimited | Hermes seat | ✅ local |
| **Claude Code CLI** | chat | claude (binary) | Anthropic key | Claude seat, reasoning fallback | ✅ |
| OpenAI Images | media | `gpt-image-1` | paid | Thumbnail Studio | 🔧 key-gated |
| Suno | media | Suno API | paid | Music Studio | 🔧 key-gated |
| HeyGen · ElevenLabs | media | avatar · voiceover | paid | Video Studio narrator | 🔧 key-gated |
| MiniMax · Grok | media | b-roll video | paid | Video Studio b-roll | 🔧 key-gated |

**Legend:** ✅ wired · 🧪 trial (finite credits) · ⚠️ unofficial (personal use only) · 🔧 key-gated (honest-OFFLINE without key)

> The Edge TTS integration reverse-engineers Microsoft Edge's Read Aloud endpoint. It is **UNOFFICIAL and personal/hobby use only** — not licensed for commercial deployment. See [`app/services/README.md`](app/services/README.md).

---

## How a request flows

The Sprint 7 hardening stack — every request passes through these in order:

```mermaid
flowchart LR
    Req([HTTP request]) --> RID["requestId<br/>crypto.randomUUID"]
    RID --> JSON["express.json<br/>limit 1mb"]
    JSON --> LOG["requestLogger<br/>one JSON line on finish"]
    LOG --> CORS["CORS<br/>localhost allowlist"]
    CORS --> RL["rate-limit<br/>240/min global · 8/min expensive"]
    RL --> Routes["34 API routes"]
    Routes --> Err["error middleware<br/>generic msg + requestId to client<br/>full stack logged server-side"]
    Routes --> Resp([response])
    Err --> Resp
```

A user-reported `requestId` maps to exactly one server log line. Stack traces never leak to the client.

---

## Orchestration workflow

Two coordinated boards drive work from idea to shipped artifact. The orchestrator is a persisted job queue with concurrency control and honest failure (restarted jobs are marked `failed`, never fake-resumed).

```mermaid
flowchart LR
    Idea([Idea]) --> Cap["Paperclip<br/>capture"]
    Cap --> Pipe["Pipeline<br/>Inbox"]
    Pipe --> Gate{Human Gate}
    Gate -->|reject| Drop([discarded])
    Gate -->|approve| Exec["Execute<br/>orchestrator job"]
    Exec --> Reason["reasoning.chat<br/>ZCode → NIM → Claude CLI"]
    Reason --> Ship([Shipped])

    Goal([Goal]) --> Plan["Kanban<br/>Planner agent"]
    Plan --> Tasks["3-6 JSON tasks"]
    Tasks --> Build["Builder agent"]
    Build --> Rev["Reviewer agent"]
    Rev -->|accept| Done([Done])
    Rev -->|reject| Build
```

Every orchestrator job streams progress over WebSocket to all connected clients.

---

## Screenshots

<p align="center">
  <table>
    <tr>
      <td width="50%" align="center"><b>Pipeline — Capture → Human Gate → Execute → Shipped</b></td>
      <td width="50%" align="center"><b>Agent Kanban — Planner / Builder / Reviewer</b></td>
    </tr>
    <tr>
      <td><img src="Dashboard Assets/built/pipeline.png" alt="Pipeline board" width="100%"></td>
      <td><img src="Dashboard Assets/built/agent-kanban.png" alt="Agent Kanban" width="100%"></td>
    </tr>
    <tr>
      <td align="center"><b>Mastermind — 13 concurrent seats</b></td>
      <td align="center"><b>The Radar — signals + oracle</b></td>
    </tr>
    <tr>
      <td><img src="Dashboard Assets/built/agent-room.png" alt="Mastermind room" width="100%"></td>
      <td><img src="Dashboard Assets/built/radar.png" alt="The Radar" width="100%"></td>
    </tr>
  </table>
</p>

More captures in [`Dashboard Assets/built/`](Dashboard%20Assets/built/) — goals, game studio, video studio, music studio, thumbnail studio, palette, and more.

---

## Roadmap

Seven sprints shipped. Linear history on `main`. 98 tests green throughout, zero new dependencies added in any sprint.

```mermaid
gantt
    title Sprint history
    dateFormat YYYY-MM-DD
    axisFormat %b
    section Shipped
    Sprint 1 — Runnable core          :done, s1, 2026-06-20, 4d
    Sprint 2 — ZCode + NIM reasoning  :done, s2, after s1, 3d
    Sprint 3 — node:test safety net   :done, s3, after s2, 3d
    Sprint 4 — Free fleet + quota     :done, s4, after s3, 4d
    Sprint 5 — Edge TTS (322 voices)  :done, s5, after s4, 2d
    Sprint 6 — Close Phase 2 gaps     :done, s6, after s5, 3d
    Sprint 7 — Land + harden          :done, s7, after s6, 2d
```

| Sprint | Scope |
|---|---|
| **1** | Runnable core: Mission Control, Express server, vault, `/api/status` probes, SPA shell |
| **2** | ZCode + NVIDIA NIM reasoning engines — orchestrator runs without an Anthropic key |
| **3** | `node:test` safety net (10 suites across state modules + server smoke) |
| **4** | Free-provider fleet (7 providers) + activity monitor + Quota Tracker |
| **5** | Free Microsoft Neural TTS via edge-tts (322 voices, unofficial) |
| **6** | Close Phase 2 gaps: full-fleet Mission Control cards, Web Speech voice input, Video Studio ffmpeg render, Radar RSS MVP. *(Memory Galaxy was already wired — verified, no change needed.)* |
| **7** | Land sprints 1–6 to `main`, then harden: loopback bind, loopback-only kill endpoints, zero-dep rate limiter, structured JSON logger + requestId, centralized error middleware, graceful shutdown, explicit CORS, this README + ROADMAP |

Full history with per-commit detail in [`ROADMAP.md`](ROADMAP.md).

---

## What's left

**Deferred by design** (not oversights):

- **Auth / multi-user** — single-user local-first is the product. Loopback bind + loopback-only kill endpoints close the network exposure without auth complexity.
- **Next.js / React migration** — `the-agent-operating-system Idea.txt` references it; the shipped codebase is intentionally a no-build vanilla-JS SPA.
- **Express 5 upgrade** — GA, but carries subtle breaking-change risk; separate from hardening.

**Ranked feature ideas** (from the gap audit — not committed):

| Priority | Feature | Honest status |
|---|---|---|
| High | Radar X/Grok live API wiring | Free RSS MVP shipped (Sprint 6); paid X/Grok APIs are the original vision |
| High | Free Claude Code: full builder wiring | Agent Factory UI ready; Claude Code CLI plumbing into this view in progress |
| Med | Video Studio: Create + Avatar tabs | "coming in Phase 2" placeholders |
| Med | Session picker for Claude Code `--resume` | The flag works; no UI to choose which past session |
| Low | Omi device sync | Memory surface is vault-wired; physical Omi recorder sync is a device-integration feature |
| Low | Hermes Goal Mode / profiles / Jarvis / MCP tabs | Listed placeholders |

---

## Tech stack & layout

| Layer | Choice |
|---|---|
| Backend | Node.js + Express 4 + `ws` — **3 production deps, 0 dev deps** (deliberate minimalism) |
| Frontend | Hand-written vanilla-JS SPA — no framework, no bundler, no build step |
| Data | Filesystem "vault" (`app/vault/`) — JSON + Markdown, Obsidian-compatible |
| Realtime | WebSocket `/ws` for chat streaming + Mastermind room + job broadcast |
| Tests | Built-in `node:test` runner — 98 tests, 10 suites |
| Logging | Zero-dep structured JSON to stdout, keyed by `requestId` |
| Rate limiting | Zero-dep token-bucket — 240/min global, 8/min on expensive routes |

```
the-agent-operating-system/
├── app/
│   ├── server.js              # Express + WebSocket server (~1080 lines)
│   ├── package.json           # 3 prod deps, 0 dev deps
│   ├── lib/                   # 19 modules: vault, providers/, orchestrator,
│   │                          #   probes, reasoning, rate-limit, logger, video-render, radar-feeds
│   ├── public/                # vanilla-JS SPA
│   │   ├── css/               # 20 surface stylesheets + tokens.css
│   │   ├── js/                # shell, router, palette, ws, sidebar-config
│   │   │   └── views/         # 30 ES-module view files
│   │   └── fonts/             # 4 self-hosted variable woff2 fonts
│   ├── services/              # edge-tts Python service (unofficial)
│   └── vault/                 # your data — gitignored
├── Dashboard Assets/          # product screenshots (committed)
├── ROADMAP.md                 # full sprint history
└── Start Agent OS.bat         # Windows launcher
```

---

## Documentation

- 📜 **[ROADMAP.md](ROADMAP.md)** — full sprint history, deferred items, feature ideas
- 🛠️ **[app/README.md](app/README.md)** — developer guide: architecture, request pipeline, running, testing, how to add a provider, hardening posture
- ⚙️ **[app/.env.example](app/.env.example)** — every configuration knob, documented inline with free-tier caps
- 🔊 **[app/services/README.md](app/services/README.md)** — edge-tts Python service (unofficial / personal-use caveat)

---

## License

Personal / hobby use. The bundled **edge-tts** integration reverse-engineers Microsoft Edge's Read Aloud endpoint and is **not licensed for commercial deployment** (violates Microsoft ToS). Provider integrations (OpenAI, Suno, HeyGen, ElevenLabs, MiniMax, Grok) require their respective API keys and are subject to those providers' terms. No warranty. See [`app/services/README.md`](app/services/README.md) for details.

---

<div align="center">

*Designed for the local-first operator. Built honestly.*

</div>
