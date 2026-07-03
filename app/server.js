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
const ollama = require('./lib/providers/ollama');
const openrouter = require('./lib/providers/openrouter');
const claudeCli = require('./lib/providers/claude-cli');
const openaiImages = require('./lib/providers/openai-images');
const suno = require('./lib/providers/suno');
const heygen = require('./lib/providers/heygen');
const elevenlabs = require('./lib/providers/elevenlabs');
const minimaxVideo = require('./lib/providers/minimax-video');
const grokVideo = require('./lib/providers/grok-video');

const PORT = process.env.PORT || 4477;
const MODEL_RE = /^[a-zA-Z0-9._/-]+$/;

const app = express();
app.use(express.json());

// ---- static ----
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vault/builds', express.static(vault.vaultPath('builds')));

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

// ---- game studio: commission a single-file HTML game via Claude Code CLI ----
const GAME_BUILD_PREAMBLE = [
  'You are the Game Agent. Build a complete, playable, self-contained single-file HTML game.',
  'Rules: all CSS and JS inline in one document; no external libraries, fonts, images, or network requests;',
  'dark neon aesthetic; keyboard and/or mouse controls with brief on-screen instructions; include a <title>.',
  'Output ONLY the raw HTML document starting with <!DOCTYPE html> — no markdown fences, no commentary.',
  'Game request: ',
].join(' ');

app.post('/api/games/build', async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'prompt required' });
  try {
    const raw = await claudeCli.chat(
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
app.post('/api/thumbnail/generate', async (req, res) => {
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
app.post('/api/music/generate', async (req, res) => {
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

// ---- video studio: script (Claude CLI, real today) + assets (HeyGen/ElevenLabs/MiniMax/Grok) ----
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
    const script = await claudeCli.chat(
      [{ role: 'user', content: VIDEO_SCRIPT_PREAMBLE + brief.trim() + lengthNote }],
      {}
    );
    res.json({ script: script.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/video/assets', async (req, res) => {
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
    note: 'Assets generated — combined render (Edit + Render) lands next.',
  };
  vault.writeJSON(path.join('builds', 'video', slug, 'meta.json'), meta);

  res.json({ saved, errors, slug });
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

// ---- agent monitor: shells out to the `abtop` CLI for live session data ----
const abtop = require('./lib/collectors/abtop');
abtop.start();

app.get('/api/monitor/snapshot', (req, res) => {
  res.json(abtop.getState());
});

app.post('/api/monitor/kill-session', async (req, res) => {
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

app.post('/api/pipeline/:id/execute', (req, res) => {
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

app.post('/api/kanban/assemble', async (req, res) => {
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

app.post('/api/kanban/cards/:id/build', (req, res) => {
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

app.post('/api/kanban/cards/:id/review', async (req, res) => {
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

// SPA fallback — anything not /api or a static file goes to index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/vault')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`Agentic OS running at http://localhost:${PORT}`);
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
  { id: 'free-claude', label: 'Free Claude Code', kind: 'claude-cli-free' },
  { id: 'gemini', label: 'Gemini', kind: 'openrouter', envModel: 'SEAT_GEMINI_MODEL', defaultModel: 'google/gemini-2.5-flash' },
  { id: 'codex', label: 'Codex', kind: 'openrouter', envModel: 'SEAT_CODEX_MODEL', defaultModel: 'openai/gpt-5-mini' },
  { id: 'glm', label: 'GLM', kind: 'openrouter', envModel: 'SEAT_GLM_MODEL', defaultModel: 'z-ai/glm-4.6' },
  { id: 'openclaw', label: 'OpenClaw', kind: 'unwired' },
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
      } else {
        send({ type: 'error', reqId, message: `${agent} is not wired yet — honest by design` });
        return;
      }

      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const label = agent === 'hermes' ? 'Hermes' : 'Claude';
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

    if (seat.kind === 'unwired') {
      send({ type: 'seat-skip', reqId, seat: seat.id, reason: 'gateway not configured' });
      return null;
    }

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
