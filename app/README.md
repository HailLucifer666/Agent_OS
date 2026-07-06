# Agentic OS — Developer Guide

This is the application directory. See the [root README](../README.md) for the project overview and the [ROADMAP](../ROADMAP.md) for sprint history.

## Architecture

```
app/
├── server.js              # Express HTTP + ws WebSocket server (~1050 lines)
├── package.json           # 3 prod deps (dotenv, express, ws), 0 dev deps
├── lib/
│   ├── vault.js           # filesystem helpers for the Obsidian-compatible vault
│   ├── goals.js           # Goals CRUD → vault/Goals.md
│   ├── kanban.js          # Kanban board CRUD → vault/Kanban.json
│   ├── pipeline.js        # Inbox → Human Gate → Execute → Shipped cards
│   ├── orchestrator.js    # job queue/runner for Pipeline Execute + Kanban agents
│   ├── probes.js          # honest status probes for agent tiles
│   ├── reasoning.js       # picks orchestrator engine: ZCode → NIM → Claude CLI
│   ├── free-models.js     # single source of truth for the free-provider fleet
│   ├── activity-log.js    # ring buffer + daily aggregates of provider calls
│   ├── quota.js           # estimated free-tier quota usage per provider
│   ├── builds.js          # lists generated artifacts in vault/builds/
│   ├── rate-limit.js      # zero-dep token-bucket limiter (Sprint 7 H3)
│   ├── logger.js          # zero-dep structured JSON logger (Sprint 7 H4)
│   ├── video-render.js    # ffmpeg mux/concat for Video Studio (Sprint 6)
│   ├── radar-feeds.js     # RSS/Atom fetch+parse for The Radar (Sprint 6)
│   ├── collectors/abtop.js      # Agent Monitor: shells out to the abtop CLI
│   └── providers/         # one file per AI/media provider (OpenAI-compat factory)
├── public/                # vanilla-JS SPA (no build step)
│   ├── index.html
│   ├── css/               # tokens.css + one stylesheet per surface
│   ├── js/                # shell, router, palette, ws, sidebar-config
│   │   └── views/         # one ES module per dashboard surface
│   └── fonts/             # 4 self-hosted variable woff2 fonts
├── services/
│   └── edge-tts-server.py # local OpenAI-compatible TTS (322 voices, unofficial)
└── vault/                 # your data — gitignored, never published
```

The request pipeline, in order: `requestId` → `express.json` → `requestLogger` → `CORS` → `rate-limit (global on /api)` → routes → `error middleware`. The `app.listen` binds to `127.0.0.1`.

## Running

```bash
npm install
npm start              # node server.js → http://localhost:4477
```

### Configuration

Copy `.env.example` to `.env` and fill in keys as needed. The app boots degraded without any keys — the dashboard still loads and status tiles show what's offline. Critical vars:

- `BIND` / `PORT` — bind address (default `127.0.0.1:4477`).
- `ZCODE_API_KEY` / `NIM_API_KEY` — the reasoning engine (powers the orchestrator without an Anthropic key).
- `ANTHROPIC_API_KEY` — powers the Claude chat seat + Claude Code CLI.
- `OLLAMA_URL` — local Ollama (powers the Hermes seat).
- Free fleet: `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `MISTRAL_API_KEY`, `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, `OPENROUTER_API_KEY`.
- Media studios: `OPENAI_API_KEY` (thumbnails), `SUNO_API_KEY` (music), `HEYGEN_API_KEY`/`ELEVENLABS_API_KEY` + `MINIMAX_API_KEY`/`XAI_API_KEY` (video).
- `RADAR_FEEDS` — comma-separated RSS/Atom URLs for The Radar.
- `RATE_LIMIT_GLOBAL` / `RATE_LIMIT_EXPENSIVE` — per-IP request caps per minute.
- `LOG_LEVEL` — `debug`/`info`/`warn`/`error` (default `info`).
- `ALLOWED_ORIGINS` — comma-separated extra CORS origins.

See `.env.example` for the full list with free-tier caps.

## Testing

```bash
npm test               # node --test — discovers every *.test.js
```

98 tests across 10 suites. The suites use isolated temp vaults (`lib/test-helpers.js`) so they don't touch your real `vault/`. Provider network paths are **not** tested — the suites cover CRUD, state, orchestrator logic, and read-only server endpoints.

To add a test: create `lib/<module>.test.js` using `node:test` + `node:assert/strict`, wrap any vault-touching test in `tempVaultDir()`/`rmrf()`.

## Adding a provider

Most chat providers speak OpenAI-compatible SSE. The factory in `lib/providers/openai-compat.js` powers Groq, Cerebras, Mistral, Cloudflare, OpenRouter-Free, ZCode, NIM. To add one:

1. Create `lib/providers/<your-provider>.js` as a thin wrapper calling `createOpenAICompatProvider({...})` with the base URL, model, env-key name, and accent color.
2. Register it in `lib/free-models.js` (`FREE_PROVIDERS` array) so it appears in Mission Control, Mastermind, and the fleet.
3. Add its key to `.env.example` with the free-tier cap.
4. Add a chat view under `public/js/views/<id>.js` (copy an existing one like `groq.js`) and register the route in `public/js/sidebar-config.js`.

The provider's `isAvailable()` gates honestly on the env key — no key means OFFLINE, never faked.

## Hardening posture (Sprint 7)

- **Loopback bind** (`BIND=127.0.0.1`) — dashboard is LAN-unreachable by default.
- **Loopback-only kill endpoints** — `kill-session`/`kill-port` 403 any non-local request, even if `BIND=0.0.0.0`.
- **Rate limiting** — 240 req/min global on `/api/*`, 8 req/min on expensive (LLML/shelling) routes. Override via env.
- **Structured logging** — one-line JSON per event + per request, keyed by `requestId`. `grep '"level":"error"'`.
- **Error middleware** — generic `{ error, requestId }` to clients; full stack logged server-side only.
- **Graceful shutdown** — SIGINT/SIGTERM drains HTTP + WS + TTS child, 5s hard timeout.
- **CORS allowlist** — explicit localhost origins; extend via `ALLOWED_ORIGINS`.

There is **no auth** and **no multi-user support** by design — this is a single-user local-first tool. The hardening above closes the network exposure class without adding auth complexity.
