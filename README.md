# Agentic OS

A local-first, single-user mission-control dashboard for orchestrating and monitoring AI agents. Runs entirely on your machine — no cloud, no account, no telemetry. Every agent shares one Obsidian-compatible "vault" so context is never re-explained.

**One screen, one shared brain, one crew. Builds while you watch. Local + private. Never falls behind.**

## Quickstart

**Windows:** double-click `Start Agent OS.bat`.

**Any platform:**
```bash
cd app
npm install
node server.js
```
Then open <http://localhost:4477>.

> The server binds to `127.0.0.1` (loopback only) by default — the dashboard is unreachable from your LAN. Set `BIND=0.0.0.0` only if you deliberately want network exposure.

## Design principle: honest-inert

The whole UI is built around honesty. Missing API keys, unavailable providers, and failed calls are shown explicitly as **OFFLINE** or **DEGRADED** — never faked. Errors surface verbatim. Quota numbers are labeled as estimates. A "Phase 2" placeholder is shown rather than a fake success. If a feature doesn't work, you see that it doesn't work.

## What's in it

- **Mission Control** — live status tiles for the whole agent fleet, with one card per chat agent.
- **Mastermind room** — a multi-seat chat (Claude, Hermes, ZCode, NIM, Groq, Cerebras, Mistral, Cloudflare, OpenRouter-Free, Free Claude Code) streaming concurrently over WebSocket.
- **Pipeline + Kanban** — capture ideas, route them through a human gate, then let the orchestrator execute via a Planner/Builder/Reviewer job runner.
- **Studios** — Game (single-file HTML), Thumbnail (OpenAI gpt-image-1), Music (Suno), Video (HeyGen/ElevenLabs narrator + MiniMax/Grok b-roll, combined into a final mp4 via ffmpeg), Voice (free Microsoft Neural TTS via edge-tts).
- **Memory** — Obsidian-vault notes rendered as a navigable galaxy; `[[wiki-links]]` become edges.
- **Radar** — free RSS signal aggregation (configure feeds via `RADAR_FEEDS`).
- **Agent Monitor** — live view of Claude Code / Codex / OpenCode sessions on this machine (via the `abtop` CLI).

## The free-only provider fleet

The dashboard runs on free or low-cost keys so it works without an Anthropic key. The reasoning engine (used by the orchestrator) resolves in priority order: **ZCode (Z.AI GLM-4.6) → NVIDIA NIM (Nemotron-70B) → Claude Code CLI fallback**. The fleet of OpenAI-compatible free providers (Groq, Cerebras, Mistral, Cloudflare AI, OpenRouter-Free) is wired through one factory. See `app/.env.example` for every key and its free-tier cap.

## Tech stack

- **Backend:** Node.js + Express + `ws` (3 production dependencies, zero dev dependencies — deliberate minimalism).
- **Frontend:** hand-written vanilla-JS SPA, no framework, no build step.
- **Data:** the filesystem "vault" (`app/vault/`) — JSON + Markdown, Obsidian-compatible.
- **Tests:** built-in `node:test` runner.

## Documentation

- [`ROADMAP.md`](ROADMAP.md) — sprint history (1–7) and what's intentionally deferred.
- [`app/README.md`](app/README.md) — developer guide: architecture, how to add a provider, env vars, running tests.
- [`app/.env.example`](app/.env.example) — every configuration knob, documented inline.
- [`app/services/README.md`](app/services/README.md) — the local edge-tts Python service (unofficial, personal-use caveat).

## Project layout

```
the-agent-operating-system/
├── app/
│   ├── server.js          # Express + WebSocket server
│   ├── lib/               # vault, providers, orchestrator, rate-limit, logger, ...
│   ├── public/            # vanilla-JS SPA (css/, js/, fonts/)
│   ├── services/          # edge-tts Python service
│   └── vault/             # your data (gitignored)
├── Start Agent OS.bat     # Windows launcher
└── ROADMAP.md
```

## License

Personal/hobby use. The bundled edge-tts integration reverse-engineers Microsoft Edge's Read Aloud endpoint and is **not** licensed for commercial deployment — see `app/services/README.md`.
