// server.js — Agentic OS local mission-control server.
// Express serves the static SPA + JSON APIs; ws is mounted for future streaming (Phase 2).
require('dotenv').config();

const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const vault = require('./lib/vault');
const goals = require('./lib/goals');
const kanban = require('./lib/kanban');
const pipeline = require('./lib/pipeline');
const builds = require('./lib/builds');
const probes = require('./lib/probes');
const freeModels = require('./lib/free-models');
const activityLog = require('./lib/activity-log');
const ollama = require('./lib/providers/ollama');
const openrouter = require('./lib/providers/openrouter');
const claudeCli = require('./lib/providers/claude-cli');
const reasoning = require('./lib/reasoning');
const zcode = require('./lib/providers/zcode');
const nim = require('./lib/providers/nim');
const openaiImages = require('./lib/providers/openai-images');
const suno = require('./lib/providers/suno');
const heygen = require('./lib/providers/heygen');
const elevenlabs = require('./lib/providers/elevenlabs');
const minimaxVideo = require('./lib/providers/minimax-video');
const grokVideo = require('./lib/providers/grok-video');
const edgeTts = require('./lib/providers/edge-tts');
const videoRender = require('./lib/video-render');
const radarFeeds = require('./lib/radar-feeds');
const { createLimiter } = require('./lib/rate-limit');
const { log, requestLogger } = require('./lib/logger');
const crypto = require('crypto');
const modelRegistry = require('./lib/models/registry');
const voiceAgent = require('./lib/voice/voice-agent');
const voiceTts = require('./lib/voice/tts');
const confirm = require('./lib/voice/confirm');
const voiceToolsDashboard = require('./lib/voice/tools-dashboard');
const { createS2sCompletionsRouter } = require('./lib/voice/s2s-completions');
const s2sChild = require('./lib/voice/s2s-child');
const pcChild = require('./lib/voice/pc-child');
const browserAgent = require('./lib/voice/browser-agent');
const voiceIntake = require('./lib/voice/intake');

const PORT = process.env.PORT || 4477;
// Bind to loopback by default so the dashboard (and the process-killing monitor
// endpoints) are unreachable from the LAN. Override with BIND=0.0.0.0 only if you
// deliberately want network exposure — the kill-* routes still gate to loopback (H2).
const BIND = process.env.BIND || '127.0.0.1';
const MODEL_RE = /^[a-zA-Z0-9._/-]+$/;

// Loopback check for the kill-* endpoints (H2): even if someone sets BIND=0.0.0.0,
// process-killing routes stay local-only. Accepts IPv4/IPv6 loopback forms.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
function isLoopback(req) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
  return LOOPBACK.has(ip);
}

const app = express();
// requestId must run BEFORE the body parser so JSON-parse errors still get an id.
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  next();
});
app.use(express.json({ limit: '1mb' }));

// ---- Rate limiting (zero-dep token-bucket) ----
// Global tier: generous cap across all API routes. Expensive tier: tight cap on
// routes that shell out or call LLMs (applied per-route below). Override limits
// via env if a workflow genuinely needs more headroom.
const globalLimit = createLimiter({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_GLOBAL) || 240,
  scope: 'global-api',
});
const expensiveLimit = createLimiter({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_EXPENSIVE) || 8,
  scope: 'expensive',
});

// ---- Structured access logging ----
// requestLogger emits one JSON line per request on response finish (skips /health
// to avoid liveness-probe noise). requestId is assigned earlier, before the body
// parser, so even JSON-parse errors carry an id.
app.use(requestLogger());

// ---- Explicit CORS posture (H7) ----
// The SPA is same-origin so it needs no CORS headers, but /api/* may be called
// from other localhost dev tools or a browser extension. Default allowlist is
// the dashboard's own localhost origin; extend with ALLOWED_ORIGINS (comma-sep).
// Binding to 127.0.0.1 (H1) makes cross-network abuse impractical — this is an
// explicit-intent posture, not a primary defense.
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  ...(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
]);
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    log.debug('missing env var', { name, note: 'related features will be disabled' });
    return false;
  }
  return true;
}

const _CRITICAL_ENV = ['ANTHROPIC_API_KEY'];
const haveCritical = _CRITICAL_ENV.map(requireEnv).every(Boolean);

if (!haveCritical) {
  // Default: honest-inert — warn and start degraded so the dashboard still loads
  // and the status tiles can show you exactly what's offline.
  log.warn('starting degraded', { missing: _CRITICAL_ENV, note: 'some surfaces will be limited' });
  // Opt-in fail-fast: set FAIL_FAST=1 in .env to refuse boot instead. Useful for
  // headless / orchestrated runs where a silent degraded boot would mask a misconfig.
  if (process.env.FAIL_FAST && process.env.FAIL_FAST.trim() && process.env.FAIL_FAST !== '0') {
    log.error('FAIL_FAST abort', { missing: _CRITICAL_ENV, note: 'set the missing keys or unset FAIL_FAST to start degraded' });
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== 'test') {
  log.info('ready', {
    url: `http://localhost:${PORT}`,
    bind: BIND,
    engines: reasoning.describeEngines(),
  });
}

// ---- env bootstrap (served before static so it's always fresh) ----
app.get('/js/env.js', (req, res) => {
  res.type('application/javascript').set('Cache-Control', 'no-store')
    .send(`window.__ENV_BRAND_NAME__=${JSON.stringify(process.env.BRAND_NAME || 'NOVA')};`);
});

// ---- static ----
// Dev server: no caching so the browser always picks up JS/CSS changes.
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0, lastModified: false }));
app.use('/vault/builds', express.static(vault.vaultPath('builds')));

// ---- health ----
// Global rate limit applies to all /api/* (not /health — keep it free for liveness probes).
app.use('/api', globalLimit);
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// ---- status ----
app.get('/api/status', async (req, res) => {
  try {
    const status = await probes.getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- goals ----
app.get('/api/goals', (req, res) => {
  res.json({ goals: goals.listGoals(), stats: goals.stats() });
});
app.post('/api/goals', (req, res) => {
  const { text, category } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
  const list = goals.addGoal(text, category);
  res.json({ goals: list, stats: goals.stats() });
});
app.post('/api/goals/:id/toggle', (req, res) => {
  const list = goals.toggleGoal(req.params.id);
  res.json({ goals: list, stats: goals.stats() });
});
app.delete('/api/goals/:id', (req, res) => {
  const list = goals.deleteGoal(req.params.id);
  res.json({ goals: list, stats: goals.stats() });
});

// ---- kanban ----
app.get('/api/kanban', (req, res) => {
  res.json(kanban.listBoard());
});
app.post('/api/kanban/cards', (req, res) => {
  const { title, lane } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'title required' });
  const card = kanban.addCard(title, lane);
  res.json({ card, board: kanban.listBoard() });
});
app.post('/api/kanban/cards/:id/move', (req, res) => {
  const { lane } = req.body || {};
  try {
    const card = kanban.moveCard(req.params.id, lane);
    res.json({ card, board: kanban.listBoard() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.delete('/api/kanban/cards/:id', (req, res) => {
  kanban.deleteCard(req.params.id);
  res.json({ board: kanban.listBoard() });
});

// ---- pipeline ----
app.get('/api/pipeline', (req, res) => {
  res.json(pipeline.listAll());
});
app.post('/api/pipeline/capture', (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
  const card = pipeline.capture(text);
  res.json({ card, board: pipeline.listAll() });
});
app.post('/api/pipeline/:id/shape', (req, res) => {
  try {
    const card = pipeline.moveCard(req.params.id, 'human-gate', { progress: 5 });
    res.json({ card, board: pipeline.listAll() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post('/api/pipeline/:id/approve', (req, res) => {
  try {
    const card = pipeline.approve(req.params.id);
    res.json({ card, board: pipeline.listAll() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post('/api/pipeline/:id/reject', (req, res) => {
  try {
    pipeline.reject(req.params.id);
    res.json({ board: pipeline.listAll() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post('/api/pipeline/:id/ship', (req, res) => {
  try {
    const card = pipeline.ship(req.params.id);
    res.json({ card, board: pipeline.listAll() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- memory / vault notes ----
app.get('/api/memory/notes', (req, res) => {
  const files = vault.listFiles('Memories', '.md');
  const notes = files.map((f) => {
    const text = vault.readText(path.join('Memories', f.name));
    const links = vault.extractLinks(text);
    let stat;
    try { stat = require('fs').statSync(f.full); } catch { stat = null; }
    return {
      name: f.name.replace(/\.md$/, ''),
      links,
      modified: stat ? stat.mtime.toISOString() : null,
      excerpt: text.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '',
    };
  });
  res.json({ notes, count: notes.length });
});

// ---- builds gallery ----
app.get('/api/builds/:kind', (req, res) => {
  res.json({ builds: builds.listBuilds(req.params.kind) });
});
app.get('/api/builds', (req, res) => {
  res.json({ builds: builds.listBuilds() });
});

// ---- models ----
app.get('/api/models', async (req, res) => {
  try {
    const models = await ollama.listModels();
    res.json({ models });
  } catch (err) {
    res.json({ models: [], error: err.message });
  }
});

// ---- game studio: commission a single-file HTML game via the reasoning engine ----
const GAME_BUILD_PREAMBLE = [
  'You are the Game Agent. Build a complete, playable, self-contained single-file HTML game.',
  'Rules: all CSS and JS inline in one document; no external libraries, fonts, images, or network requests;',
  'dark neon aesthetic; keyboard and/or mouse controls with brief on-screen instructions; include a <title>.',
  'Output ONLY the raw HTML document starting with <!DOCTYPE html> — no markdown fences, no commentary.',
  'Game request: ',
].join(' ');

app.post('/api/games/build', expensiveLimit, async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'prompt required' });
  try {
    const raw = await reasoning.chat(
      [{ role: 'user', content: GAME_BUILD_PREAMBLE + prompt.trim() }],
      {}
    );
    let html = raw.trim();
    const fence = html.match(/```(?:html)?\s*\n([\s\S]*?)\n```/);
    if (fence) html = fence[1].trim();
    const docStart = html.search(/<!DOCTYPE html/i);
    if (docStart > 0) html = html.slice(docStart);
    if (!/^<!DOCTYPE html/i.test(html) || !/<html[\s>]/i.test(html)) {
      throw new Error('build agent did not return a complete HTML document — try again');
    }
    const titleMatch = html.match(/<title>([^<]{1,60})<\/title>/i);
    const base = (titleMatch ? titleMatch[1] : prompt)
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'game';
    const fs = require('fs');
    let name = `${base}.html`;
    for (let i = 2; fs.existsSync(vault.vaultPath('builds', 'game', name)); i += 1) {
      name = `${base}-${i}.html`;
    }
    vault.writeText(path.join('builds', 'game', name), html);
    const build = builds.listBuilds('game').find((b) => b.name === name) || null;
    res.json({ build });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- free claude code: agent factory build via the reasoning engine ----
const FREE_CLAUDE_BUILD_PREAMBLE = [
  'You are the Agent Factory builder. Build a complete, self-contained single-file HTML page/app.',
  'Rules: all CSS and JS inline in one document; no external libraries, fonts, images, or network requests;',
  'dark aesthetic with clean typography; fully interactive and functional; include a <title>.',
  'Output ONLY the raw HTML document starting with <!DOCTYPE html> — no markdown fences, no commentary.',
  'Build request: ',
].join(' ');

app.post('/api/free-claude/build', expensiveLimit, async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'prompt required' });
  try {
    const raw = await reasoning.chat(
      [{ role: 'user', content: FREE_CLAUDE_BUILD_PREAMBLE + prompt.trim() }],
      {}
    );
    const artifact = saveDeliverable(raw, prompt.trim(), 'free-claude');
    const build = builds.listBuilds('free-claude').find((b) => b.name === artifact.name) || null;
    res.json({ build });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- shared helpers for the studios below ----
const fs = require('fs');
const ALLOWED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function slugify(text, fallback) {
  return (text || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || fallback;
}

function decodeBase64Image(dataUrl) {
  const match = /^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i.exec(dataUrl || '');
  if (!match) throw Object.assign(new Error('invalid image data'), { status: 400 });
  const mime = match[1].toLowerCase();
  if (!ALLOWED_IMAGE_MIMES.includes(mime)) {
    throw Object.assign(new Error(`unsupported image type: ${mime}`), { status: 400 });
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error('image exceeds 10MB limit'), { status: 400 });
  }
  return buffer;
}

// ---- thumbnail studio: OpenAI image generation/edit ----
app.post('/api/thumbnail/generate', expensiveLimit, async (req, res) => {
  const { instructions, files, versions, redesignFromScratch, preventGrid, varyEach } = req.body || {};
  const n = Math.min(Math.max(Number(versions) || 1, 1), 4);
  const promptParts = [instructions && instructions.trim() ? instructions.trim() : 'A high-CTR YouTube thumbnail.'];
  if (preventGrid) promptParts.push('Generate exactly one single image, not a grid or collage of multiple options.');
  if (varyEach) promptParts.push('Make this version visually distinct in layout, colors, and background from other versions.');
  const prompt = promptParts.join(' ');

  try {
    let imageBuffers = [];
    const useEdit = Array.isArray(files) && files.length > 0 && !redesignFromScratch;

    if (useEdit) {
      const refBuffers = files.slice(0, 16).map(decodeBase64Image);
      // Edit endpoint accepts one n per call; loop for multiple versions since each
      // edit call re-uses the same references but the model varies its own output.
      for (let i = 0; i < n; i += 1) {
        const result = await openaiImages.editImage(prompt, refBuffers, { n: 1 });
        imageBuffers.push(...result);
      }
    } else {
      // No references (or explicit redesign-from-scratch): cheaper to request n in one call.
      imageBuffers = await openaiImages.generateImage(prompt, { n });
    }

    const base = slugify(instructions, 'thumbnail');
    const images = imageBuffers.map((buf, i) => {
      let name = `${base}-${i + 1}.png`;
      for (let j = 2; fs.existsSync(vault.vaultPath('builds', 'thumbnail', name)); j += 1) {
        name = `${base}-${i + 1}-${j}.png`;
      }
      vault.ensureDir(vault.vaultPath('builds', 'thumbnail'));
      fs.writeFileSync(vault.vaultPath('builds', 'thumbnail', name), buf);
      return { path: `/vault/builds/thumbnail/${name}` };
    });

    res.json({ images });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---- music studio: Suno via sunoapi.org ----
app.post('/api/music/generate', expensiveLimit, async (req, res) => {
  const { prompt, style, title, instrumental } = req.body || {};
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'prompt required' });
  try {
    const result = await suno.generateTrack({ prompt, style, title, instrumental });
    const base = slugify(result.title || title, 'track');
    let slug = base;
    for (let i = 2; fs.existsSync(vault.vaultPath('builds', 'music', slug)); i += 1) {
      slug = `${base}-${i}`;
    }
    const dir = vault.vaultPath('builds', 'music', slug);
    vault.ensureDir(dir);
    fs.writeFileSync(path.join(dir, 'track.mp3'), result.audioBuffer);
    fs.writeFileSync(path.join(dir, 'cover.jpg'), result.coverBuffer);
    const meta = {
      title: result.title || title || 'Untitled',
      prompt,
      style,
      duration: result.duration,
      createdAt: new Date().toISOString(),
    };
    vault.writeJSON(path.join('builds', 'music', slug, 'meta.json'), meta);
    res.json({ track: { slug, ...meta, audio: `/vault/builds/music/${slug}/track.mp3`, cover: `/vault/builds/music/${slug}/cover.jpg` } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/music/webhook', (req, res) => {
  const { taskId } = req.body || {};
  if (taskId) suno.receiveWebhook(taskId, req.body);
  res.json({ ok: true });
});

app.get('/api/music/tracks', (req, res) => {
  const dirs = vault.listFiles('builds/music');
  const tracks = dirs.map((d) => {
    const meta = vault.readJSON(path.join('builds', 'music', d.name, 'meta.json'), null);
    if (!meta) return null;
    return { slug: d.name, ...meta, audio: `/vault/builds/music/${d.name}/track.mp3`, cover: `/vault/builds/music/${d.name}/cover.jpg` };
  }).filter(Boolean).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json({ tracks });
});

// ---- video studio: script (reasoning engine, real today) + assets (HeyGen/ElevenLabs/MiniMax/Grok) ----
const VIDEO_SCRIPT_PREAMBLE = [
  'You are the Video Director\'s script writer. Research the topic below from your own knowledge',
  '(no web browsing available) and write a spoken video script for a video of the given length.',
  'Output ONLY the script text — no markdown, no scene directions, no commentary.',
  'Video brief: ',
].join(' ');

app.post('/api/video/script', async (req, res) => {
  const { brief, lengthSeconds } = req.body || {};
  if (!brief || !brief.trim()) return res.status(400).json({ error: 'brief required' });
  try {
    const lengthNote = lengthSeconds ? ` The script should run about ${lengthSeconds} seconds when spoken aloud.` : '';
    const script = await reasoning.chat(
      [{ role: 'user', content: VIDEO_SCRIPT_PREAMBLE + brief.trim() + lengthNote }],
      {}
    );
    res.json({ script: script.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/video/assets', expensiveLimit, async (req, res) => {
  const { script, narratorMode, avatarId, voiceId, brollEngine, brollPrompt, lengthSeconds } = req.body || {};
  if (!script || !script.trim()) return res.status(400).json({ error: 'script required' });

  const narratorTask = narratorMode === 'voiceover'
    ? elevenlabs.textToSpeech({ text: script, voiceId }).then((buf) => ({ kind: 'voiceover', buf }))
    : heygen.generateAvatarVideo({ script, avatarId, voiceId }).then((r) => ({ kind: 'avatar', buf: r.videoBuffer }));

  const brollTask = brollEngine === 'grok'
    ? grokVideo.generateVideo({ prompt: brollPrompt }).then((r) => ({ kind: 'broll', buf: r.videoBuffer }))
    : minimaxVideo.generateVideo({ prompt: brollPrompt, duration: Math.min(Number(lengthSeconds) || 6, 6) }).then((r) => ({ kind: 'broll', buf: r.videoBuffer }));

  const [narratorResult, brollResult] = await Promise.allSettled([narratorTask, brollTask]);

  const base = slugify(script.slice(0, 40), 'video');
  let slug = base;
  for (let i = 2; fs.existsSync(vault.vaultPath('builds', 'video', slug)); i += 1) {
    slug = `${base}-${i}`;
  }
  const dir = vault.vaultPath('builds', 'video', slug);
  vault.ensureDir(dir);

  const saved = [];
  const errors = [];

  if (narratorResult.status === 'fulfilled') {
    const { kind, buf } = narratorResult.value;
    const filename = kind === 'voiceover' ? 'voiceover.mp3' : 'avatar.mp4';
    fs.writeFileSync(path.join(dir, filename), buf);
    saved.push({ stage: kind, path: `/vault/builds/video/${slug}/${filename}` });
  } else {
    errors.push({ stage: narratorMode === 'voiceover' ? 'voiceover' : 'avatar', message: narratorResult.reason.message });
  }

  if (brollResult.status === 'fulfilled') {
    fs.writeFileSync(path.join(dir, 'broll.mp4'), brollResult.value.buf);
    saved.push({ stage: 'broll', path: `/vault/builds/video/${slug}/broll.mp4` });
  } else {
    errors.push({ stage: 'broll', message: brollResult.reason.message });
  }

  const meta = {
    title: script.slice(0, 60),
    script,
    narratorMode,
    brollEngine,
    createdAt: new Date().toISOString(),
    assets: saved,
    note: 'Assets generated — use POST /api/video/render to combine into final.mp4 via ffmpeg.',
  };
  vault.writeJSON(path.join('builds', 'video', slug, 'meta.json'), meta);

  res.json({ saved, errors, slug });
});

// Combine a video set's saved narrator + b-roll assets into final.mp4 via ffmpeg.
// Honest-inert: rejects with a clear message if ffmpeg is missing or assets are incomplete.
app.post('/api/video/render', expensiveLimit, async (req, res) => {
  try {
    if (!videoRender.isFfmpegAvailable()) {
      res.status(503).json({ error: 'ffmpeg not found — set FFMPEG_PATH or install ffmpeg on PATH.' });
      return;
    }
    const { slug } = req.body || {};
    const result = await videoRender.render(slug);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/video/library', (req, res) => {
  const dirs = vault.listFiles('builds/video');
  const items = dirs.map((d) => vault.readJSON(path.join('builds', 'video', d.name, 'meta.json'), null))
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json({ items });
});

app.get('/api/video/voices', async (req, res) => {
  const mode = req.query.mode === 'voiceover' ? 'voiceover' : 'presenter';
  try {
    const voices = mode === 'voiceover' ? await elevenlabs.listVoices() : await heygen.listVoices();
    res.json({ voices, mode });
  } catch (err) {
    res.status(500).json({ error: err.message, mode });
  }
});

// ---- Radar: free RSS feed aggregation (no API keys, no X/Grok required) ----
// Honest-inert: returns empty signals + a note when RADAR_FEEDS is unset.
app.get('/api/radar/signals', async (req, res) => {
  try {
    const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 12));
    const result = await radarFeeds.fetchSignals(limit);
    res.json(result);
  } catch (err) {
    res.status(500).json({ signals: [], note: `Radar error: ${err.message}`, fedCount: 0, failCount: 0 });
  }
});

// ---- agent monitor: shells out to the `abtop` CLI for live session data ----
const abtop = require('./lib/collectors/abtop');
abtop.start();

app.get('/api/monitor/snapshot', (req, res) => {
  res.json(abtop.getState());
});

app.post('/api/monitor/kill-session', async (req, res) => {
  if (!isLoopback(req)) return res.status(403).json({ error: 'kill-session is loopback-only.' });
  const { pid, agentCli } = req.body || {};
  if (!pid || !agentCli) return res.status(400).json({ error: 'pid and agentCli required' });
  try {
    await abtop.killSession({ pid: Number(pid), agentCli });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/monitor/kill-port', async (req, res) => {
  if (!isLoopback(req)) return res.status(403).json({ error: 'kill-port is loopback-only.' });
  const { pid, port } = req.body || {};
  if (!pid || !port) return res.status(400).json({ error: 'pid and port required' });
  try {
    await abtop.killPort({ pid: Number(pid), port: Number(port) });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- orchestration spine: Pipeline Execute via the job runner ----
const orchestrator = require('./lib/orchestrator');
const agentActions = require('./lib/agent-actions');
const { saveDeliverable, extractJsonBlock } = agentActions;

app.post('/api/pipeline/:id/execute', expensiveLimit, (req, res) => {
  try {
    const result = agentActions.executePipelineCard(req.params.id);
    res.json(result);
  } catch (err) {
    const status = err.message === 'card not found' ? 404
      : err.message === 'a build is already in progress for this card' ? 409
      : 400;
    res.status(status).json({ error: err.message });
  }
});

// ---- orchestration spine: Kanban planner/builder/reviewer agents ----

app.post('/api/kanban/assemble', expensiveLimit, async (req, res) => {
  const { goal } = req.body || {};
  try {
    const result = agentActions.assembleKanbanPlan(goal);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/kanban/cards/:id/build', expensiveLimit, (req, res) => {
  try {
    const result = agentActions.buildKanbanCard(req.params.id);
    res.json(result);
  } catch (err) {
    const status = err.message === 'card not found' ? 404
      : err.message === 'a build is already in progress for this card' ? 409
      : 400;
    res.status(status).json({ error: err.message });
  }
});

const REVIEWER_PREAMBLE = [
  'You are the Kanban Reviewer agent, working independently of whoever built this — you have',
  'not seen their process, only the result. Judge whether the deliverable below plausibly',
  'satisfies the task. Respond with ONLY JSON, no commentary, no fence:',
  '{"verdict": "approve" or "reject", "notes": "1-2 sentences explaining why"}\n',
].join(' ');

app.post('/api/kanban/cards/:id/review', expensiveLimit, async (req, res) => {
  const card = kanban.findCard(req.params.id);
  if (!card) return res.status(404).json({ error: 'card not found' });
  if (!card.artifact) return res.status(400).json({ error: 'card has no built artifact to review yet' });
  let deliverableText = '';
  try {
    deliverableText = require('fs').readFileSync(vault.vaultPath('builds', 'pipeline', card.artifact.name), 'utf8').slice(0, 6000);
  } catch {
    try {
      deliverableText = require('fs').readFileSync(vault.vaultPath(card.artifact.path.replace(/^\/vault\//, '')), 'utf8').slice(0, 6000);
    } catch {
      deliverableText = '(artifact file could not be read for review)';
    }
  }
  const job = orchestrator.enqueue({
    kind: 'kanban-review',
    cardId: card.id,
    prompt: `${REVIEWER_PREAMBLE}Task: ${card.title}\n${card.detail || ''}\n\nDeliverable:\n${deliverableText}`,
    run: async (raw) => {
      let verdict;
      try {
        verdict = extractJsonBlock(raw);
      } catch {
        throw new Error('reviewer did not return valid JSON');
      }
      if (!verdict || (verdict.verdict !== 'approve' && verdict.verdict !== 'reject')) {
        throw new Error('reviewer returned an unrecognized verdict');
      }
      kanban.patchCard(card.id, { reviewVerdict: verdict.verdict, reviewNotes: verdict.notes || '' });
      return {};
    },
  });
  res.json({ job });
});

app.post('/api/kanban/cards/:id/accept', (req, res) => {
  const { lane } = req.body || {};
  if (!['done', 'backlog'].includes(lane)) return res.status(400).json({ error: 'lane must be done or backlog' });
  const card = kanban.patchCard(req.params.id, { lane });
  res.json({ card, board: kanban.listBoard() });
});

app.get('/api/jobs', (req, res) => {
  res.json({ jobs: orchestrator.listJobs() });
});
app.get('/api/jobs/:id', (req, res) => {
  const job = orchestrator.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json({ job, queuePosition: orchestrator.queuePosition(job.id) });
});

app.get('/api/activity/recent', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json({ calls: activityLog.getRecent(limit) });
});
app.get('/api/activity/stats', (req, res) => {
  res.json(activityLog.getStats());
});

// ---- quota tracking (usage-based estimation against known free-tier caps) ----
const quotas = require('./lib/quota');
app.get('/api/quotas', (req, res) => {
  res.json({ quotas: quotas.getAllQuotas() });
});

// ---- text-to-speech (edge-tts, free Microsoft Neural) ----
app.get('/api/tts/voices', async (req, res) => {
  try {
    const available = await edgeTts.isAvailable();
    if (!available) return res.status(503).json({ error: 'edge-tts service not running', voices: [] });
    const voices = await edgeTts.listVoices();
    res.json({ voices, count: voices.length });
  } catch (err) {
    res.status(500).json({ error: err.message, voices: [] });
  }
});

app.post('/api/tts/synthesize', async (req, res) => {
  const { text, voice, format, rate, pitch } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
  try {
    const available = await edgeTts.isAvailable();
    if (!available) return res.status(503).json({ error: 'edge-tts service not running — start with: python app/services/edge-tts-server.py' });
    const buf = await edgeTts.synthesize({ text: text.trim(), voice, format, rate, pitch });
    // Save to vault for history
    const base = (text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30) || 'tts');
    const fs = require('fs');
    let name = `${base}.mp3`;
    for (let i = 2; fs.existsSync(vault.vaultPath('builds', 'tts', name)); i += 1) name = `${base}-${i}.mp3`;
    vault.ensureDir(vault.vaultPath('builds', 'tts'));
    fs.writeFileSync(vault.vaultPath('builds', 'tts', name), buf);
    res.json({ ok: true, path: `/vault/builds/tts/${name}`, voice: voice || 'en-US-AriaNeural', bytes: buf.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- voice (Phase 1: browser push-to-talk + Ollama brain) ----
app.get('/api/voice/status', async (req, res) => {
  try {
    const [voiceOk, edgeTtsStatus] = await Promise.all([
      voiceAgent.isAvailable(),
      edgeTts.getStatus(),
    ]);
    const s2sStatus = s2sChild.getS2sStatus();
    const pcStatus = pcChild.getStatus();
    const browserStatus = browserAgent.getStatus();
    res.json({
      enabled: process.env.VOICE_ENABLED !== 'false',
      backend: 'chain',
      lastModelUsed: voiceAgent.getLastModelUsed(),
      ttsOk: edgeTtsStatus.ok,
      voiceOk,
      edgeTts: { status: edgeTtsStatus.ok ? 'ONLINE' : 'OFFLINE', voices: edgeTtsStatus.voices },
      s2s: { status: s2sStatus.state, hint: s2sStatus.hint, ringBuffer: s2sStatus.ringBuffer },
      pc: { status: pcStatus.state, hint: pcStatus.hint, queueDepth: pcStatus.queueDepth },
      browser: { status: browserStatus.state, hint: browserStatus.hint, cdpUrl: browserStatus.cdpUrl, pageCount: browserStatus.pageCount },
    });
  } catch (err) {
    res.status(500).json({ error: err.message, enabled: false });
  }
});

// ---- PC Automation (Phase C) ----
app.get('/api/pc/status', (req, res) => {
  const status = pcChild.getStatus();
  res.json(status);
});

app.post('/api/pc/start', (req, res) => {
  // Only allow from loopback (like kill endpoints)
  const ip = req.ip || req.connection.remoteAddress;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'Loopback only.' });
  }
  pcChild.startPcChild();
  res.json({ started: true });
});

app.post('/api/pc/stop', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'Loopback only.' });
  }
  pcChild.shutdownPcChild();
  browserAgent.disconnect();
  res.json({ stopped: true });
});

// ---- Browser Automation (Phase D) ----
app.get('/api/browser/status', (req, res) => {
  res.json(browserAgent.getStatus());
});

app.post('/api/browser/connect', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'Loopback only.' });
  }
  const url = req.body?.url || process.env.BROWSER_CDP_URL;
  if (!url) return res.status(400).json({ error: 'BROWSER_CDP_URL not set and no url in body.' });
  browserAgent.connect(url).then((ok) => {
    res.json({ connected: ok });
  }).catch((err) => {
    res.status(500).json({ error: err.message });
  });
});

app.post('/api/browser/disconnect', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'Loopback only.' });
  }
  browserAgent.disconnect();
  res.json({ disconnected: true });
});

// ---- model fallback chain (Phase A) ----
app.get('/api/models/status', async (req, res) => {
  try {
    res.json(await modelRegistry.getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/models/refresh', async (req, res) => {
  if (!isLoopback(req)) return res.status(403).json({ error: 'models/refresh is loopback-only.' });
  try {
    await modelRegistry.refresh(true);
    res.json(await modelRegistry.getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Global rate limit only (not the expensive tier) — this endpoint doesn't call an LLM,
// only edge-tts, and per-turn voice replies would starve against an 8/min cap.
app.post('/api/tts/speak', async (req, res) => {
  const { text, voice } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
  try {
    const buf = await voiceTts.speak(text, { voice });
    if (!buf) return res.status(503).json({ error: 'edge-tts service not running' });
    res.set('Content-Type', 'audio/mpeg');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- voice (Phase 2: browser-free voice via local speech-to-speech pipeline) ----
// Mounted OUTSIDE /api (literal path /voice/v1/chat/completions) because this is the OpenAI-
// chat-completions-shaped endpoint the huggingface/speech-to-speech child process (started by
// s2s-child.js, gated on S2S_AUTOSTART) is pointed at via --responses_api_base_url. It still
// gets JSON body parsing (express.json() is app-level, registered before any /api scoping) and
// the global rate-limit tier (applied explicitly below, since globalLimit is otherwise only
// wired under /api) — never the 8/min expensive tier, matching /api/tts/speak's reasoning:
// this fields per-turn conversational traffic, not LLM-orchestration calls.
app.post('/voice/v1/chat/completions', globalLimit, createS2sCompletionsRouter({ voiceAgent, isLoopback, confirm }));

// SPA fallback — anything not /api or a static file goes to index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/vault')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Centralized error middleware (H5) ----
// Catches errors from routes that don't try/catch (several sync routes in goals/
// kanban/pipeline currently propagate unguarded). Logs full stack server-side with
// the requestId so a user-reported error maps to one log line; returns a generic
// message to the client — never leaks stack traces or raw err.message.
// Note: routes that already catch and return specific { error } JSON are more useful
// as-is; this is the safety net for the ones that don't.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const requestId = req.id || 'unknown';
  // JSON parse errors from express.json are surfaced as 400 with a clean message.
  if (err && err.type === 'entity.parse.failed') {
    log.warn('malformed JSON body', { requestId, path: req.path, body: err.message });
    return res.status(400).json({ error: 'Malformed JSON in request body.', requestId });
  }
  if (err && err.type === 'entity.too.large') {
    log.warn('oversized body', { requestId, path: req.path, limit: err.limit });
    return res.status(413).json({ error: 'Request body too large.', requestId });
  }
  log.error('unhandled route error', {
    requestId,
    method: req.method,
    path: req.path,
    error: err && err.message ? err.message : String(err),
    stack: err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n') : undefined,
  });
  res.status(500).json({ error: 'Internal server error.', requestId });
});

const server = app.listen(PORT, BIND, () => {
  // listening confirmation is in the "ready" startup log above
});
// wss is created later (after the ws protocol helpers); keep a ref so the
// graceful-shutdown drain can close it. Assigned where WebSocketServer is built.
let wssRef = null;

// ---- edge-tts Python service autostart ----
// Detects python + edge-tts, spawns the local TTS service so Voice Studio works
// out of the box. Set EDGE_TTS_AUTOSTART=false to disable (e.g. if you run it
// manually or don't have Python). Honest: if not installed, the provider stays
// OFFLINE and we log a one-time hint — never a crash.
let edgeTtsChild = null;
const TTS_PORT = process.env.EDGE_TTS_PORT || '5050';
const TTS_SCRIPT = path.join(__dirname, 'services', 'edge-tts-server.py');

(async function autostartEdgeTts() {
  if (process.env.EDGE_TTS_AUTOSTART === 'false') return;
  if (process.env.NODE_ENV === 'test') return;
  const { spawnSync } = require('child_process');
  // Detect python (try "python" then "python3")
  let pyBin = null;
  for (const bin of ['python', 'python3']) {
    try {
      const r = spawnSync(bin, ['--version'], { shell: true, encoding: 'utf8', timeout: 3000 });
      if (r.status === 0) { pyBin = bin; break; }
    } catch { /* try next */ }
  }
  if (!pyBin) {
    log.warn('edge-tts python not found', { note: 'TTS service not started — Voice Studio will show OFFLINE' });
    return;
  }
  // Detect edge-tts module. NOTE: shell:false is required here — shell:true
  // mangles the -c "import edge_tts" quoting on Windows (Python sees bare 'import').
  try {
    const r = spawnSync(pyBin, ['-c', 'import edge_tts'], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0) {
      log.warn('edge-tts module not installed', { hint: `${pyBin} -m pip install edge-tts` });
      return;
    }
  } catch {
    log.warn('edge-tts module check failed', { note: 'TTS service not started' });
    return;
  }
  // Spawn the service
  try {
    edgeTtsChild = require('child_process').spawn(pyBin, [TTS_SCRIPT], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, EDGE_TTS_PORT: TTS_PORT },
    });
    edgeTtsChild.on('error', () => { edgeTtsChild = null; });
    log.debug('edge-tts started', { port: TTS_PORT });
  } catch {
    edgeTtsChild = null;
    log.warn('edge-tts spawn failed', { note: 'Voice Studio will show OFFLINE' });
  }
})();

// ---- speech-to-speech (S2S) child process autostart (Phase 2) ----
// Off by default: S2S_AUTOSTART must be explicitly 'true' — absence of the var (or any other
// value) must resolve to NOT starting. This is stricter than edge-tts's autostart (which
// defaults ON, gated only by an opt-out): the s2s pipeline is untested-on-Windows upstream,
// has multi-GB first-run downloads, and opens a live mic with no additional auth, so it needs
// deliberate opt-in rather than an opt-out default. Lifecycle itself lives in s2s-child.js
// (kept require()-able/side-effect-free at require time); only the actual start invocation is
// gated here.
if (process.env.S2S_AUTOSTART === 'true' && process.env.NODE_ENV !== 'test') {
  s2sChild.startS2s({ port: PORT });
}

// Phase C: PC automation child process (ps-automation.ps1). Opt-in via PC_AUTOMATION=true.
// Side-effect-free require — pc-child.js never spawns at require time.
if (process.env.PC_AUTOMATION === 'true' && process.env.NODE_ENV !== 'test') {
  pcChild.startPcChild();
}

// Phase D: Browser automation via playwright-core + Chrome CDP. Opt-in via BROWSER_CDP_URL.
// Connects to an already-running Chrome instance (setup-chrome-debug.ps1).
if (process.env.BROWSER_CDP_URL && process.env.NODE_ENV !== 'test') {
  browserAgent.connect(process.env.BROWSER_CDP_URL).catch(() => {});
}

// Graceful shutdown: kill the spawned TTS service if we started one.
function shutdownEdgeTts() {
  if (edgeTtsChild && !edgeTtsChild.killed) {
    try {
      if (process.platform === 'win32' && edgeTtsChild.pid) {
        require('child_process').execFile('taskkill', ['/PID', String(edgeTtsChild.pid), '/T', '/F']);
      } else {
        edgeTtsChild.kill('SIGTERM');
      }
    } catch { /* best-effort */ }
    edgeTtsChild = null;
  }
}
// Graceful shutdown (H6): drain in-flight HTTP + WS, then kill the TTS child.
// A 5s hard timeout guarantees a hung connection can't block shutdown forever.
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return; // second Ctrl+C → force exit immediately
  shuttingDown = true;
  log.info('shutdown signal received', { signal });

  // Hard-timeout fallback: if drain hangs, exit anyway after 5s.
  const forceTimer = setTimeout(() => {
    log.warn('shutdown drain timed out, forcing exit', { signal });
    shutdownEdgeTts();
    s2sChild.shutdownS2s();
    pcChild.shutdownPcChild();
    browserAgent.disconnect();
    process.exit(1);
  }, 5000);
  forceTimer.unref();

  // 1. Stop accepting new WS connections; close existing ones (code 1001 = going away).
  try {
    if (wssRef) wssRef.close();
  } catch { /* best-effort */ }
  // 2. Stop accepting new HTTP connections; let in-flight finish.
  server.close(() => {
    log.info('http server closed, draining complete', { signal });
    shutdownEdgeTts();
    s2sChild.shutdownS2s();
    pcChild.shutdownPcChild();
    browserAgent.disconnect();
    clearTimeout(forceTimer);
    process.exit(0);
  });
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Catch lifecycle/process errors that would otherwise crash silently, log them,
// and drain gracefully rather than aborting mid-request.
process.on('uncaughtException', (err) => {
  log.error('uncaughtException', { error: err.message, stack: err.stack });
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', { reason: reason && reason.message ? reason.message : String(reason) });
  gracefulShutdown('unhandledRejection');
});

// ---- ws chat / mastermind protocol (Phase 2) ----

// convId -> vault-relative note path, so repeat exchanges append to the same file.
const noteByConv = new Map();

function timeLabel(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function noteFilename(agentLabel, d) {
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
  return `Memories/${agentLabel} — ${stamp}.md`;
}

// Appends one exchange to the convId's vault note (creating it on first use). Returns the vault-relative path.
function appendExchange(convId, agentLabel, userText, replyText) {
  let notePath = noteByConv.get(convId);
  if (!notePath) {
    notePath = noteFilename(agentLabel, new Date());
    noteByConv.set(convId, notePath);
  }
  const now = new Date();
  const existing = vault.readText(notePath, '');
  const block = `${existing ? existing + '\n' : ''}## ${timeLabel(now)} You\n${userText}\n\n## ${timeLabel(now)} ${agentLabel}\n${replyText}\n`;
  vault.writeText(notePath, block);
  return notePath;
}

const SEATS = [
  { id: 'claude', label: 'Claude', kind: 'claude-cli' },
  { id: 'hermes', label: 'Hermes', kind: 'ollama' },
  { id: 'zcode', label: 'ZCode', kind: 'zcode' },
  { id: 'nim', label: 'NIM', kind: 'nim' },
  { id: 'free-claude', label: 'Free Claude Code', kind: 'claude-cli-free' },
  { id: 'gemini', label: 'Gemini', kind: 'openrouter', envModel: 'SEAT_GEMINI_MODEL', defaultModel: 'google/gemini-2.5-flash' },
  { id: 'codex', label: 'Codex', kind: 'openrouter', envModel: 'SEAT_CODEX_MODEL', defaultModel: 'openai/gpt-5-mini' },
  { id: 'glm', label: 'GLM', kind: 'openrouter', envModel: 'SEAT_GLM_MODEL', defaultModel: 'z-ai/glm-4.6' },
  { id: 'groq', label: 'Groq', kind: 'groq' },
  { id: 'openrouter-free', label: 'OpenRouter Free', kind: 'openrouter-free' },
  { id: 'cerebras', label: 'Cerebras', kind: 'cerebras' },
  { id: 'mistral', label: 'Mistral', kind: 'mistral' },
  { id: 'cloudflare', label: 'Cloudflare AI', kind: 'cloudflare' },
];

function seatAlias(text) {
  const m = /@([a-z-]+)/i.exec(text);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const aliases = { 'freeclaude': 'free-claude', 'free-claude': 'free-claude' };
  const id = aliases[raw] || raw;
  return SEATS.find((s) => s.id === id) ? id : null;
}

function roomPreamble(seatLabel) {
  return `You are seat ${seatLabel} in a multi-agent room called Mastermind, alongside other AI agents. Reply directly and keep it under ~150 words.\n\n`;
}

// dispatchAgentPrompt(seatId, prompt) — non-streaming, non-WS provider dispatch for a single
// prompt/reply exchange, reusing the same SEATS table and per-kind branches as handleChat/
// runSeat below (extracted so voice's ask_agent tool doesn't duplicate the provider-routing
// logic — see voice/tools-dashboard.js's setAskAgentDispatch wiring). Throws on an unknown/
// unavailable seat; callers (ask_agent) catch and turn that into an honest { ok:false }.
async function dispatchAgentPrompt(seatId, prompt) {
  const seat = SEATS.find((s) => s.id === seatId);
  if (!seat) throw new Error(`Unknown agent seat "${seatId}".`);
  const messages = [{ role: 'user', content: prompt }];

  if (seat.kind === 'ollama') {
    const models = await ollama.listModels().catch(() => []);
    const validModel = models.includes(process.env.OLLAMA_MODEL) ? process.env.OLLAMA_MODEL : undefined;
    return ollama.chat(messages, { model: validModel });
  }
  if (seat.kind === 'claude-cli') {
    return claudeCli.chat(messages, { convId: `voice:${seatId}:${Date.now()}` });
  }
  if (seat.kind === 'claude-cli-free') {
    const freeModel = process.env.FREE_CLAUDE_MODEL || 'haiku';
    const useModel = MODEL_RE.test(freeModel) ? freeModel : 'haiku';
    return claudeCli.chat(messages, { convId: `voice:${seatId}:${Date.now()}`, model: useModel });
  }
  if (seat.kind === 'zcode') {
    if (!zcode.isAvailable()) throw new Error('ZCode is not configured (missing ZCODE_API_KEY).');
    return zcode.chat(messages, {});
  }
  if (seat.kind === 'nim') {
    if (!nim.isAvailable()) throw new Error('NIM is not configured (missing NIM_API_KEY).');
    return nim.chat(messages, {});
  }
  if (seat.kind === 'openrouter') {
    const envModel = process.env[seat.envModel];
    const useModel = envModel && envModel.trim() ? envModel.trim() : seat.defaultModel;
    if (!process.env.OPENROUTER_API_KEY) throw new Error(`${seat.label} is not configured (missing OPENROUTER_API_KEY).`);
    return openrouter.chat(messages, { model: useModel });
  }
  const fleetEntry = freeModels.findById(seat.kind);
  if (fleetEntry && fleetEntry.kind === 'openai-compat') {
    if (!fleetEntry.provider.isAvailable()) throw new Error(`${seat.label} is not configured (missing ${fleetEntry.apiKeyEnv}).`);
    return fleetEntry.provider.chat(messages, { source: 'voice' });
  }
  throw new Error(`${seat.label} is not wired yet — honest by design.`);
}

// Wire the voice ask_agent tool to the same provider-dispatch logic handleChat/runSeat use,
// without voice/tools-dashboard.js importing server.js (would be a circular require).
voiceToolsDashboard.setAskAgentDispatch(dispatchAgentPrompt);

// Security review fix: the /ws upgrade handshake previously had no Origin check. Browsers
// don't apply CORS/SOP to WebSocket connections, so binding to 127.0.0.1 alone does NOT stop
// a hostile page open in the same local browser from doing `new WebSocket('ws://127.0.0.1:PORT/ws')`
// and driving voice-utterance / chat / room messages — cross-site WebSocket hijacking (CSWSH).
// Reuse the same ALLOWED_ORIGINS allowlist already enforced for /api: reject a connection that
// presents a foreign Origin header. Non-browser tools (curl, wscat, this repo's own tests) don't
// send an Origin header at all — those are allowed only when they also connect from loopback,
// matching the existing isLoopback-gated posture used for the kill-* endpoints.
function verifyWsClient(info, callback) {
  const origin = info.origin;
  if (origin) {
    if (ALLOWED_ORIGINS.has(origin)) return callback(true);
    log.warn('ws-upgrade-rejected', { reason: 'foreign origin', origin });
    return callback(false, 403, 'Forbidden');
  }
  if (isLoopback(info.req)) return callback(true);
  log.warn('ws-upgrade-rejected', { reason: 'no origin, non-loopback' });
  return callback(false, 403, 'Forbidden');
}

const wss = new WebSocketServer({ server, path: '/ws', verifyClient: verifyWsClient });
wssRef = wss; // hand the ref to the graceful-shutdown drain (declared near app.listen)

// Shared helper: sends msg to every currently-open WS client. Used for job-update
// broadcasts (orchestrator) and voice-ui side effects (voice WS handling) alike —
// one implementation, so both stay consumable via the client's onBroadcast registry.
function broadcastAll(msg) {
  const payload = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(payload);
  });
}

// Activity feed helper — broadcasts an {type:'activity', ...} message for the client-side activity bus.
function emitActivity(kind, detail) {
  broadcastAll({ type: 'activity', kind, detail, at: Date.now() });
}

// Job updates fan out to every connected client (pipeline view listens for these).
orchestrator.setBroadcast(broadcastAll);
const checkpointAnnouncer = require('./lib/voice/checkpoint-announcer');
orchestrator.onJobUpdate(checkpointAnnouncer.attach(broadcastAll));

wss.on('connection', (ws) => {
  // reqId -> AbortController, so 'stop' / socket close can cancel in-flight work.
  const inFlight = new Map();
  // Scopes voice confirmIds to this connection (security review fix) — a confirm created
  // by one WS connection cannot be accepted/rejected from a different one.
  const connectionId = crypto.randomUUID();

  function send(msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  async function runOllama(messages, model, onToken, signal) {
    const models = await ollama.listModels().catch(() => []);
    const validModel = model && models.includes(model) ? model : (process.env.OLLAMA_MODEL || 'qwen3:latest');
    return ollama.chat(messages, { model: validModel, onToken, signal });
  }

  async function runClaudeCli(messages, convId, onToken, signal, extraModel) {
    return claudeCli.chat(messages, { onToken, signal, convId, model: extraModel });
  }

  async function handleChat(msg) {
    const { reqId, convId, agent, model, messages } = msg;
    const controller = new AbortController();
    inFlight.set(reqId, controller);
    let full = '';
    const onToken = (token) => send({ type: 'token', reqId, token });

    try {
      if (agent === 'hermes') {
        full = await runOllama(messages, model, onToken, controller.signal);
      } else if (agent === 'claude') {
        full = await runClaudeCli(messages, convId, onToken, controller.signal);
      } else if (agent === 'free-claude-code') {
        const freeModel = process.env.FREE_CLAUDE_MODEL || 'haiku';
        const useModel = MODEL_RE.test(freeModel) ? freeModel : 'haiku';
        full = await runClaudeCli(messages, convId, onToken, controller.signal, useModel);
      } else if (agent === 'zcode') {
        full = await zcode.chat(messages, { model, onToken, signal: controller.signal, source: 'chat' });
      } else if (agent === 'nim') {
        full = await nim.chat(messages, { model, onToken, signal: controller.signal, source: 'chat' });
      } else if (agent === 'chain') {
        // Unified agents surface — routes through the model fallback chain.
        // Uses 'build' brain: Mistral Large → NIM GLM-5.2 → Ollama ornith:9b.
        const chain = require('./lib/models/chain');
        const { content } = await chain.complete({
          messages, kind: model || 'text', brain: 'build', signal: controller.signal,
        });
        // Simulate streaming by sending the whole response as tokens
        for (let i = 0; i < content.length; i++) {
          if (controller.signal.aborted) break;
          onToken(content[i]);
        }
        full = content;
      } else {
        // Try the free-provider fleet (groq, openrouter-free, cerebras, mistral, cloudflare)
        const fleetEntry = freeModels.findById(agent);
        if (fleetEntry && fleetEntry.kind === 'openai-compat') {
          full = await fleetEntry.provider.chat(messages, { model, onToken, signal: controller.signal, source: 'chat' });
        } else {
          send({ type: 'error', reqId, message: `${agent} is not wired yet — honest by design` });
          return;
        }
      }

      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const label = agent === 'chain' ? 'Chain'
        : agent === 'hermes' ? 'Hermes'
        : agent === 'free-claude-code' ? 'Free Claude Code'
        : (freeModels.findById(agent)?.label || (agent === 'claude' ? 'Claude' : agent));
      const saved = appendExchange(convId, label, lastUser ? lastUser.content : '', full);
      send({ type: 'done', reqId, full, saved });
    } catch (err) {
      send({ type: 'error', reqId, message: err.message });
    } finally {
      inFlight.delete(reqId);
    }
  }

  async function runSeat(seat, reqId, convId, transcriptMessages, controller) {
    send({ type: 'seat-start', reqId, seat: seat.id, label: seat.label });

    const preamble = roomPreamble(seat.label);
    const seatMessages = transcriptMessages.map((m, i) =>
      i === transcriptMessages.length - 1 && m.role === 'user'
        ? { ...m, content: preamble + m.content }
        : m
    );

    let full = '';
    const onToken = (token) => send({ type: 'token', reqId, seat: seat.id, token });

    try {
      if (seat.kind === 'ollama') {
        full = await runOllama(seatMessages, null, onToken, controller.signal);
      } else if (seat.kind === 'zcode') {
        if (!zcode.isAvailable()) {
          send({ type: 'seat-skip', reqId, seat: seat.id, reason: 'ZCODE_API_KEY missing — add it to app/.env' });
          return null;
        }
        full = await zcode.chat(seatMessages, { onToken, signal: controller.signal });
      } else if (seat.kind === 'nim') {
        if (!nim.isAvailable()) {
          send({ type: 'seat-skip', reqId, seat: seat.id, reason: 'NIM_API_KEY missing — add it to app/.env' });
          return null;
        }
        full = await nim.chat(seatMessages, { onToken, signal: controller.signal });
      } else if (seat.kind === 'claude-cli') {
        full = await runClaudeCli(seatMessages, `${convId}:${seat.id}`, onToken, controller.signal);
      } else if (seat.kind === 'claude-cli-free') {
        const freeModel = process.env.FREE_CLAUDE_MODEL || 'haiku';
        const useModel = MODEL_RE.test(freeModel) ? freeModel : 'haiku';
        full = await runClaudeCli(seatMessages, `${convId}:${seat.id}`, onToken, controller.signal, useModel);
      } else if (seat.kind === 'openrouter') {
        const envModel = process.env[seat.envModel];
        const useModel = envModel && envModel.trim() ? envModel.trim() : seat.defaultModel;
        if (!process.env.OPENROUTER_API_KEY) {
          send({ type: 'seat-skip', reqId, seat: seat.id, reason: 'OPENROUTER_API_KEY missing — add it to app/.env' });
          return null;
        }
        full = await openrouter.chat(seatMessages, { model: useModel, onToken, signal: controller.signal });
      } else if (freeModels.findById(seat.kind) && freeModels.findById(seat.kind).kind === 'openai-compat') {
        const entry = freeModels.findById(seat.kind);
        if (!entry.provider.isAvailable()) {
          send({ type: 'seat-skip', reqId, seat: seat.id, reason: `${entry.apiKeyEnv} missing — add it to app/.env` });
          return null;
        }
        full = await entry.provider.chat(seatMessages, { onToken, signal: controller.signal, source: 'mastermind' });
      } else {
        send({ type: 'seat-skip', reqId, seat: seat.id, reason: `${seat.label} is not wired yet — honest by design` });
        return null;
      }
      send({ type: 'seat-done', reqId, seat: seat.id, full });
      return full;
    } catch (err) {
      send({ type: 'error', reqId, seat: seat.id, message: err.message });
      return null;
    }
  }

  async function handleRoom(msg) {
    const { reqId, convId, text, mention } = msg;
    const controller = new AbortController();
    inFlight.set(reqId, controller);

    try {
      const transcript = [{ role: 'user', content: text }];
      const seatsToRun = mention ? SEATS.filter((s) => s.id === mention) : SEATS;

      for (const seat of seatsToRun) {
        if (controller.signal.aborted) break;
        const reply = await runSeat(seat, reqId, convId, transcript, controller);
        if (reply) {
          transcript.push({ role: 'assistant', content: `[${seat.label}] ${reply}` });
        }
      }

      const repliesText = transcript
        .slice(1)
        .map((m) => m.content)
        .join('\n\n');
      const saved = appendExchange(convId, 'Mastermind', text, repliesText || '(no replies)');
      send({ type: 'room-done', reqId, saved });
    } catch (err) {
      send({ type: 'error', reqId, message: err.message });
    } finally {
      inFlight.delete(reqId);
    }
  }

  // Emits voice-action for an executed tool result, or voice-confirm if it was danger-gated.
  function emitVoiceActionResult(reqId, result) {
    if (result.confirmPending) {
      send({ type: 'voice-confirm', reqId, confirmId: result.confirmId, summary: result.summary });
      emitActivity('confirm', { tool: result.tool, summary: result.summary });
    } else {
      send({ type: 'voice-action', reqId, tool: result.tool, args: result.args, ok: result.ok, summary: result.summary });
      emitActivity('tool', { tool: result.tool, ok: result.ok, summary: result.summary });
      if (result.uiActions && result.uiActions.length) {
        for (const action of result.uiActions) {
          broadcastAll({ type: 'voice-ui', ...action });
        }
      }
    }
  }

  // Speaks `text` (via voice/tts.js, honest-null when edge-tts is down) and closes the turn.
  async function finishVoiceTurn(reqId, text) {
    const audioBuf = await voiceTts.speak(text).catch(() => null);
    send({ type: 'voice-say', reqId, text, audioB64: audioBuf ? audioBuf.toString('base64') : null });
    send({ type: 'voice-done', reqId });
  }

  async function handleVoiceUtterance(msg) {
    const { reqId, text } = msg;
    if (process.env.VOICE_ENABLED === 'false') {
      send({ type: 'voice-status', reqId, state: 'error', detail: 'Voice control is disabled on this server.' });
      send({ type: 'voice-done', reqId });
      return;
    }
    const controller = new AbortController();
    inFlight.set(reqId, controller);
    send({ type: 'voice-status', reqId, state: 'thinking' });

    try {
      const priorTurns = voiceIntake.get(connectionId);
      const ctx = { dashboard: {}, history: priorTurns, connectionId };
      const result = await voiceAgent.handleUtterance({
        text,
        ctx,
        signal: controller.signal,
        onAction: (actionResult) => emitVoiceActionResult(reqId, actionResult),
      });

      if (result.aborted) return;
      voiceIntake.append(connectionId, 'user', text);
      voiceIntake.append(connectionId, 'assistant', result.say);
      if (result.actions && result.actions.some((a) => a && a.clearIntake)) {
        voiceIntake.clear(connectionId);
      }

      if (result.confirmPending) {
        // Turn ends here — the spoken confirm prompt already went out via voice-confirm
        // (emitVoiceActionResult). No voice-say/voice-done until the user resolves it.
        return;
      }

      await finishVoiceTurn(reqId, result.say);
    } catch (err) {
      const detail = err.chainExhausted ? 'No model backend is reachable right now.' : err.message;
      send({ type: 'voice-status', reqId, state: 'error', detail });
      send({ type: 'voice-done', reqId });
    } finally {
      inFlight.delete(reqId);
    }
  }

  async function handleVoiceConfirmReply(msg) {
    const { reqId, confirmId, accept } = msg;
    if (process.env.VOICE_ENABLED === 'false') {
      send({ type: 'voice-status', reqId, state: 'error', detail: 'Voice control is disabled on this server.' });
      send({ type: 'voice-done', reqId });
      return;
    }
    const controller = new AbortController();
    inFlight.set(reqId, controller);

    try {
      if (!accept) {
        confirm.reject(confirmId, connectionId);
        await finishVoiceTurn(reqId, 'Cancelled.');
        return;
      }

      // connectionId must match the connection that created this confirm (security review
      // fix) — accept() returns null for an unknown id, an expired one, OR one that belongs
      // to a different connection, so a hijacked/foreign socket can't ride someone else's confirm.
      const action = confirm.accept(confirmId, connectionId);
      if (!action) {
        await finishVoiceTurn(reqId, "That confirmation is no longer valid — it may have expired.");
        return;
      }

      send({ type: 'voice-status', reqId, state: 'thinking' });
      const result = await voiceAgent.executeConfirmedAction(action, { ctx: { connectionId } });
      emitVoiceActionResult(reqId, result);
      const say = result.ok ? result.summary : `That didn't work: ${result.summary}`;
      await finishVoiceTurn(reqId, say);
    } catch (err) {
      send({ type: 'voice-status', reqId, state: 'error', detail: err.message });
      send({ type: 'voice-done', reqId });
    } finally {
      inFlight.delete(reqId);
    }
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'chat') {
      handleChat(msg);
    } else if (msg.type === 'room') {
      handleRoom(msg);
    } else if (msg.type === 'voice-utterance') {
      handleVoiceUtterance(msg);
    } else if (msg.type === 'voice-confirm-reply') {
      handleVoiceConfirmReply(msg);
    } else if (msg.type === 'stop') {
      const controller = inFlight.get(msg.reqId);
      if (controller) controller.abort();
    }
  });

  ws.on('close', () => {
    for (const controller of inFlight.values()) controller.abort();
    inFlight.clear();
    voiceIntake.clear(connectionId);
  });
});

module.exports = server;
