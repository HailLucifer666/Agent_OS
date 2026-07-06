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

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    log.warn('missing env var', { name, note: 'related features will be disabled' });
    return false;
  }
  return true;
}

const _CRITICAL_ENV = ['ANTHROPIC_API_KEY'];
const haveCritical = _CRITICAL_ENV.map(requireEnv).every(Boolean);

if (!haveCritical) {
  // Default: honest-inert — warn and start degraded so the dashboard still loads
  // and the status tiles can show you exactly what's offline.
  log.warn('starting without full provider keys', { note: 'some surfaces will show degraded' });
  // Opt-in fail-fast: set FAIL_FAST=1 in .env to refuse boot instead. Useful for
  // headless / orchestrated runs where a silent degraded boot would mask a misconfig.
  if (process.env.FAIL_FAST && process.env.FAIL_FAST.trim() && process.env.FAIL_FAST !== '0') {
    log.error('FAIL_FAST abort', { missing: _CRITICAL_ENV, note: 'set the missing keys or unset FAIL_FAST to start degraded' });
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== 'test') {
  log.info('startup', {
    port: PORT,
    bind: BIND,
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
    ollama: Boolean(process.env.OLLAMA_URL),
    engines: reasoning.describeEngines(),
  });
}

// ---- static ----
app.use(express.static(path.join(__dirname, 'public')));
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

const DELIVERABLE_PREAMBLE = [
  'You are the Pipeline build agent. Take the captured idea below and produce the single',
  'most useful self-contained deliverable for it: EITHER a complete single-file HTML page/app',
  '(all CSS/JS inline, no external resources, starting with <!DOCTYPE html>) OR a thorough',
  'markdown document (plan, spec, draft, or write-up, starting with a # title line).',
  'Choose whichever genuinely fits the idea. Output ONLY the raw file content — no',
  'commentary, no markdown fences around the whole output. Idea: ',
].join(' ');

function saveDeliverable(raw, sourceText) {
  let content = raw.trim();
  const fence = content.match(/^```[a-z]*\s*\n([\s\S]*?)\n```\s*$/);
  if (fence) content = fence[1].trim();
  if (!content) throw new Error('build agent returned empty output — try again');

  const isHtml = /<!DOCTYPE html/i.test(content);
  if (isHtml) {
    const docStart = content.search(/<!DOCTYPE html/i);
    if (docStart > 0) content = content.slice(docStart);
  }
  const ext = isHtml ? 'html' : 'md';
  const titleMatch = isHtml
    ? content.match(/<title>([^<]{1,60})<\/title>/i)
    : content.match(/^#\s+(.{1,60})/m);
  const title = titleMatch ? titleMatch[1].trim() : sourceText.slice(0, 60);
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'deliverable';
  const fs = require('fs');
  let name = `${base}.${ext}`;
  for (let i = 2; fs.existsSync(vault.vaultPath('builds', 'pipeline', name)); i += 1) {
    name = `${base}-${i}.${ext}`;
  }
  vault.writeText(path.join('builds', 'pipeline', name), content);
  return { path: `/vault/builds/pipeline/${name}`, title, name };
}

app.post('/api/pipeline/:id/execute', expensiveLimit, (req, res) => {
  const found = pipeline.findCard(req.params.id);
  if (!found) return res.status(404).json({ error: 'card not found' });
  if (found.stage !== 'execute') return res.status(400).json({ error: 'card is not in the Execute stage' });
  const existing = found.card.jobId ? orchestrator.getJob(found.card.jobId) : null;
  if (existing && (existing.status === 'queued' || existing.status === 'running')) {
    return res.status(409).json({ error: 'a build is already in progress for this card' });
  }
  const card = found.card;
  const job = orchestrator.enqueue({
    kind: 'pipeline-execute',
    cardId: card.id,
    prompt: DELIVERABLE_PREAMBLE + card.text,
    run: async (raw, j) => {
      const artifact = saveDeliverable(raw, card.text);
      pipeline.moveCard(card.id, 'shipped', { progress: 100, jobId: j.id, artifact });
      return { artifact };
    },
  });
  pipeline.moveCard(card.id, 'execute', { jobId: job.id, progress: 25 });
  res.json({ job, board: pipeline.listAll() });
});

// ---- orchestration spine: Kanban planner/builder/reviewer agents ----
function extractJsonBlock(raw) {
  const fence = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const text = fence ? fence[1] : raw;
  return JSON.parse(text.trim());
}

const PLANNER_PREAMBLE = [
  'You are the Kanban Planner agent. Break the goal below into 3-6 concrete, independently',
  'buildable tasks. Respond with ONLY a JSON array, no commentary, no markdown fence:',
  '[{"title": "short task title", "detail": "1-3 sentences describing exactly what to build"}]',
  'Goal: ',
].join(' ');

app.post('/api/kanban/assemble', expensiveLimit, async (req, res) => {
  const { goal } = req.body || {};
  if (!goal || !goal.trim()) return res.status(400).json({ error: 'goal required' });
  const job = orchestrator.enqueue({
    kind: 'kanban-plan',
    cardId: null,
    prompt: PLANNER_PREAMBLE + goal.trim(),
    run: async (raw) => {
      let tasks;
      try {
        tasks = extractJsonBlock(raw);
      } catch {
        throw new Error('planner did not return valid JSON — try rephrasing the goal');
      }
      if (!Array.isArray(tasks) || !tasks.length) throw new Error('planner returned no tasks');
      const created = kanban.addCards(tasks, 'backlog');
      return { artifact: { cards: created } };
    },
  });
  res.json({ job });
});

const BUILDER_PREAMBLE = [
  'You are the Kanban Builder agent. Build the single most useful self-contained deliverable',
  'for this task: EITHER a complete single-file HTML page/app (all CSS/JS inline, starting',
  'with <!DOCTYPE html>) OR a markdown document (starting with a # title). Output ONLY the',
  'raw file content, no commentary, no fences around the whole output.\nTask: ',
].join(' ');

app.post('/api/kanban/cards/:id/build', expensiveLimit, (req, res) => {
  const card = kanban.findCard(req.params.id);
  if (!card) return res.status(404).json({ error: 'card not found' });
  const existing = card.jobId ? orchestrator.getJob(card.jobId) : null;
  if (existing && (existing.status === 'queued' || existing.status === 'running')) {
    return res.status(409).json({ error: 'a build is already in progress for this card' });
  }
  const job = orchestrator.enqueue({
    kind: 'kanban-build',
    cardId: card.id,
    prompt: BUILDER_PREAMBLE + `${card.title}\n${card.detail || ''}`,
    run: async (raw, j) => {
      const slug = (card.title || 'card').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'card';
      const artifact = saveDeliverable(raw, `${slug}-${j.id}`);
      kanban.patchCard(card.id, { lane: 'review', jobId: j.id, builderOutput: artifact.title, artifact });
      return { artifact };
    },
  });
  kanban.patchCard(card.id, { lane: 'building', jobId: job.id });
  res.json({ job, board: kanban.listBoard() });
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
  log.info('listening', { url: `http://localhost:${PORT}`, bind: BIND });
});

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
    log.info('edge-tts service started', { port: TTS_PORT, python: pyBin, note: 'UNOFFICIAL, personal use' });
  } catch {
    edgeTtsChild = null;
    log.warn('edge-tts spawn failed', { note: 'Voice Studio will show OFFLINE' });
  }
})();

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
process.on('SIGINT', () => { shutdownEdgeTts(); process.exit(0); });
process.on('SIGTERM', () => { shutdownEdgeTts(); process.exit(0); });

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

const wss = new WebSocketServer({ server, path: '/ws' });

// Job updates fan out to every connected client (pipeline view listens for these).
orchestrator.setBroadcast((msg) => {
  const payload = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(payload);
  });
});

wss.on('connection', (ws) => {
  // reqId -> AbortController, so 'stop' / socket close can cancel in-flight work.
  const inFlight = new Map();

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
      } else if (agent === 'zcode') {
        full = await zcode.chat(messages, { model, onToken, signal: controller.signal, source: 'chat' });
      } else if (agent === 'nim') {
        full = await nim.chat(messages, { model, onToken, signal: controller.signal, source: 'chat' });
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
      const label = agent === 'hermes' ? 'Hermes'
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
    } else if (msg.type === 'stop') {
      const controller = inFlight.get(msg.reqId);
      if (controller) controller.abort();
    }
  });

  ws.on('close', () => {
    for (const controller of inFlight.values()) controller.abort();
    inFlight.clear();
  });
});

module.exports = server;
