# MYTHOS Phase 5 — Production & Docs (task-957 §26)

**Branch:** `phase5/production-and-docs` (5 commits, `e4fca4e` → this docs commit)
**Base:** `main` @ `f402026` (post-Phase-4 + .bat crash fix)
**Suite:** 1307/1312 pass (+17 new — Phase 5 auth + platform-gate)
**Baseline fails:** 4 unchanged (boot SIGINT flake + 3 eval/memory-impact data-dependent)

## What landed

Phase 5 closes the production gap. The system that ran on the operator's loopback
laptop is now hardened for cloud deployment: auth gate, CORS via config, platform-
gates on Windows-only adapters, deployment manifest with persistent vault.

| Item | Spec ref | Commit | Status |
|---|---|---|---|
| `MYTHOS_AUTH_TOKEN` bearer gate on `/api` + WS | P1 | `e4fca4e` | ✅ |
| `ALLOWED_ORIGINS` via config (D-46) + CORS auth headers | P3 | `3ce3802` | ✅ |
| Platform-gate pc-child / cua-driver on non-Windows | P6 | `3ce3802` | ✅ |
| `render.yaml` `/health` + persistent vault disk + cloud-mode env | P2, P4 | `82ef724` | ✅ |
| Docs re-sync (ROADMAP, BUGS) | P5 | this commit | ✅ |

## P1 — MYTHOS_AUTH_TOKEN

The HTTP server had no auth. Any client reaching `/api/*` could drive the entire
leash-gated surface (effectors, confirm-reply, engagements, voice transcribe).

**Operator-chosen fail-safe:** empty token = gate DISABLED. Local dev + loopback
keep working without any code change. Set the env var to engage.

- Reads `config.MYTHOS_AUTH_TOKEN` LIVE at request time (D-46)
- Accepts `X-Auth-Token` header OR `Authorization: Bearer`
- `/health` stays OPEN (Render/k8s readiness probes — mounted at root, not `/api`)
- WS `verifyClient` gates via `?token=<token>` on the upgrade URL (browsers can't
  set custom headers on `new WebSocket()`). Loopback bypasses.
- CORS `Access-Control-Allow-Headers` extended to include `Authorization` +
  `X-Auth-Token` so browser fetches carrying the token pass preflight
- UI: transparent `fetch` override in `app.js` injects the header when
  `window.MYTHOS_AUTH_TOKEN` or `localStorage` has it. `ws.js` passes `?token=`.

## P3 — ALLOWED_ORIGINS via config

The schema key existed but the server bypassed it (read `process.env` directly).
Now reads `config.ALLOWED_ORIGINS` with `process.env` fallback for D-46 consistency.

## P6 — Platform-gate pc-child / cua-driver

`pc-child` spawns `powershell.exe`. `cua-driver` is a Windows binary. On
Linux/macOS (Render, Docker, etc.) they emitted noisy ENOENT spawn errors
(the adapters caught them internally and degraded to OFFLINE, but the spam
was ugly). Now wrapped in `process.platform === 'win32'` — skipped outright
on non-Windows with a logged `*.skipped` message.

`browser-agent` stays ungated — playwright-core is cross-platform and already
fails-soft on CDP-unreachable.

## P2/P4 — render.yaml

Three gaps in the existing manifest:
1. `healthCheckPath: /api/health` was WRONG (the endpoint is `/health` —
   Render was hitting a 404 and never declaring the service healthy)
2. No persistent disk (every deploy wiped the vault — MYTHOS forgot everything)
3. Missing Phase 5 env vars

Fixed: `/health` path, 1 GB disk at `/data` with `MYTHOS_VAULT_ROOT=/data/vault`,
cloud-mode disables (`BROWSER_AUTOMATION=false`, `SCREEN_AWARENESS=false`, etc.),
`plan: starter` (free tier sleeps after 15 min — wrong for always-on).

## Files touched

```
mythos/server/index.js                      (P1 auth middleware + WS gate, P3 config read)
mythos/src/main.js                          (P6 platform-gate)
mythos/src/core/config/schema.js            (P1 MYTHOS_AUTH_TOKEN key)
mythos/ui/public/js/app.js                  (P1 fetch override)
mythos/ui/public/js/ws.js                   (P1 ?token= on WS URL)
mythos/.env.example                         (P1 key docs)
render.yaml                                 (P2/P4 manifest hardening)
mythos/test/phase5-auth-token.test.js       (new — 10 cases)
mythos/test/phase5-platform-gate.test.js    (new — 7 cases)
ROADMAP.md                                  (P5 Phase 2-5 commit log append)
BUGS.md                                     (P5 Phase 5 section)
MYTHOS_Phase5-Production_Handoff.md         (new — this doc)
```

## What I did NOT do

- No `git push` (house rule §24.2)
- No live deploy / no live OAuth / no live sensor verification
- No `MYTHOS_AUTH_TOKEN` value baked in (operator secret)
- No removal of the single-pane `.bat` fallback
- No autonomous goal-completion trigger (Phase 4.5 design call)

## Verification

```bash
# Phase 5 specific tests
cd mythos
node --test test/phase5-auth-token.test.js test/phase5-platform-gate.test.js

# Manual auth smoke (token required path)
MYTHOS_AUTH_TOKEN=test-token node src/main.js &
curl -i http://127.0.0.1:4478/api/status                            # → 401
curl -i -H 'X-Auth-Token: test-token' http://127.0.0.1:4478/api/status   # → 200
curl -i http://127.0.0.1:4478/health                                # → 200 {ok:true,...}

# Deploy-shape verification
docker build -t mythos -f mythos/Dockerfile mythos/
docker run -p 4478:4478 -e MYTHOS_AUTH_TOKEN=test -e MYTHOS_BIND=0.0.0.0 mythos
```

## Task-957 §26 — closeout

All five phases of the Gap-Close Upgrade have shipped:
- ✅ Phase 1 — Engagement executor + desktop/browser expansions
- ✅ Phase 2 — Wiring integrity (W1-W10 + D)
- ✅ Phase 3 — run_command + BUG-029/024
- ✅ Phase 4 — Autonomy advancement (all 10 vision gaps)
- ✅ Phase 5 — Production & docs

The remaining work is operator-hardware verification (live OAuth, live sensor
repro, live Render deploy) — tracked separately in BUGS.md.
