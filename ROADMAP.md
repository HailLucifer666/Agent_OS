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
- **OpenClaw local gateway** — surface exists but no gateway is configured.

## Process notes

- Sprints are merged to `main` via fast-forward when possible (main is kept linear).
- The `graphify-out/` knowledge graph and `.kilo/` planner scratch are gitignored — regenerated locally per sprint.
- The two sprint branches (`sprint-1-2-runnable-zcode-nim`, `sprint-6-close-phase-2-gaps`) are preserved for history; all their work is in `main`.
