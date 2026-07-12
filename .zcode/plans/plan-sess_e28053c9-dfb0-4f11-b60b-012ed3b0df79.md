## Plan: Deploy MYTHOS to Render (auto-deploy on git push)

### Problem
MYTHOS is a long-running Node.js + WebSocket server that currently only runs locally via `Start Agent OS.bat`. We need it live on the internet, auto-updating on every git push.

### Why Render Works (Vercel Didn't)
- Render **Web Service** runs a real persistent Node.js process (not serverless)
- Supports **WebSockets** natively
- Auto-deploys from GitHub on every push
- Free tier available

### Changes Needed (3 files)

#### 1. Create `mythos/Dockerfile`
Render uses Docker. The Dockerfile will:
- Use `node:20-alpine` base
- Copy `mythos/` as the working directory
- Run `npm install` + `npm start`
- Expose port from `PORT` env var (Render sets this automatically)
- Include Python + edge-tts for voice synthesis

#### 2. Create `render.yaml` in repo root
Render's Infrastructure-as-Code config:
- **Web Service** type (not static, not cron)
- Root directory: `mythos/`
- Build: `npm install`
- Start: `node src/main.js`
- Environment variables set in Render dashboard (API keys — NOT in the repo)

#### 3. Modify `mythos/src/core/config/schema.js`
- Change `MYTHOS_BIND` default from `127.0.0.1` to `0.0.0.0` (Render requires binding to all interfaces)
- Add `PORT` env var support — Render injects `PORT`, MYTHOS should respect it

#### 4. Modify `mythos/src/main.js` (minimal)
- Read `PORT` env var as fallback for `MYTHOS_PORT` (Render mandates `PORT`)

### Environment Variables on Render Dashboard (NOT in git)
Set these in Render's Environment settings — they'll never be in the repo:
- `NIM_API_KEY`, `NIM_API_KEY_2`
- `GROQ_API_KEY`
- `MISTRAL_API_KEY`
- `OPENROUTER_API_KEY`
- `CEREBRAS_API_KEY`
- `MYTHOS_BIND=0.0.0.0`

### What You'll Get
- URL like `https://agent-os-xxxx.onrender.com`
- Live dashboard + WebSocket + voice
- Auto-redeploy on every `git push` to `main`
- Vault stored in Render's ephemeral disk (free tier) — persists across restarts but not redeploy. Add a Render persistent disk ($) if needed later.

### Important Caveat
- Ollama won't be available (no GPU on Render free tier) — the chain will skip to the next cloud provider, which is fine since all 6 cloud providers are alive
- Vault data resets on redeploy (ephemeral disk) — acceptable for now, can upgrade to persistent disk later