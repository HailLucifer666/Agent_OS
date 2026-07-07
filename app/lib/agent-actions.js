// agent-actions.js — shared enqueue logic for the three orchestrator actions that both
// the REST routes (server.js) and the voice tool layer (voice/tools-dashboard.js) need to
// trigger identically. Extracted so there is exactly one implementation of each action —
// no duplicated enqueue logic between the HTTP and voice paths.
const path = require('path');
const fs = require('fs');
const vault = require('./vault');
const pipeline = require('./pipeline');
const kanban = require('./kanban');
const orchestrator = require('./orchestrator');

const DELIVERABLE_PREAMBLE = [
  'You are the Pipeline build agent. Take the captured idea below and produce the single',
  'most useful self-contained deliverable for it: EITHER a complete single-file HTML page/app',
  '(all CSS/JS inline, no external resources, starting with <!DOCTYPE html>) OR a thorough',
  'markdown document (plan, spec, draft, or write-up, starting with a # title line).',
  'Choose whichever genuinely fits the idea. Output ONLY the raw file content — no',
  'commentary, no markdown fences around the whole output. Idea: ',
].join(' ');

const PLANNER_PREAMBLE = [
  'You are the Kanban Planner agent. Break the goal below into 3-6 concrete, independently',
  'buildable tasks. Respond with ONLY a JSON array, no commentary, no markdown fence:',
  '[{"title": "short task title", "detail": "1-3 sentences describing exactly what to build"}]',
  'Goal: ',
].join(' ');

const BUILDER_PREAMBLE = [
  'You are the Kanban Builder agent. Build the single most useful self-contained deliverable',
  'for this task: EITHER a complete single-file HTML page/app (all CSS/JS inline, starting',
  'with <!DOCTYPE html>) OR a markdown document (starting with a # title). Output ONLY the',
  'raw file content, no commentary, no fences around the whole output.\nTask: ',
].join(' ');

function extractJsonBlock(raw) {
  const fence = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const text = fence ? fence[1] : raw;
  return JSON.parse(text.trim());
}

// Saves an LLM deliverable (HTML or markdown) into vault/builds/<kind>/, deriving a
// filename from a <title>/# heading (or the source text) and de-duplicating on disk.
function saveDeliverable(raw, sourceText, kind = 'pipeline') {
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
  let name = `${base}.${ext}`;
  for (let i = 2; fs.existsSync(vault.vaultPath('builds', kind, name)); i += 1) {
    name = `${base}-${i}.${ext}`;
  }
  vault.writeText(path.join('builds', kind, name), content);
  return { path: `/vault/builds/${kind}/${name}`, title, name };
}

// executePipelineCard(cardId) — same behavior as POST /api/pipeline/:id/execute.
// Throws with a user-facing message on invalid state; caller (route or voice tool) decides
// how to surface it (HTTP status vs. { ok:false }).
function executePipelineCard(cardId) {
  const found = pipeline.findCard(cardId);
  if (!found) throw new Error('card not found');
  if (found.stage !== 'execute') throw new Error('card is not in the Execute stage');
  const existing = found.card.jobId ? orchestrator.getJob(found.card.jobId) : null;
  if (existing && (existing.status === 'queued' || existing.status === 'running')) {
    throw new Error('a build is already in progress for this card');
  }
  const card = found.card;
  const job = orchestrator.enqueue({
    kind: 'pipeline-execute',
    cardId: card.id,
    prompt: DELIVERABLE_PREAMBLE + card.text,
    run: async (raw, j) => {
      const artifact = saveDeliverable(raw, card.text, 'pipeline');
      pipeline.moveCard(card.id, 'shipped', { progress: 100, jobId: j.id, artifact });
      return { artifact };
    },
  });
  pipeline.moveCard(card.id, 'execute', { jobId: job.id, progress: 25 });
  return { job, board: pipeline.listAll() };
}

// assembleKanbanPlan(goal) — same behavior as POST /api/kanban/assemble.
function assembleKanbanPlan(goal) {
  if (!goal || !goal.trim()) throw new Error('goal required');
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
  return { job };
}

// buildKanbanCard(cardId) — same behavior as POST /api/kanban/cards/:id/build.
function buildKanbanCard(cardId) {
  const card = kanban.findCard(cardId);
  if (!card) throw new Error('card not found');
  const existing = card.jobId ? orchestrator.getJob(card.jobId) : null;
  if (existing && (existing.status === 'queued' || existing.status === 'running')) {
    throw new Error('a build is already in progress for this card');
  }
  const job = orchestrator.enqueue({
    kind: 'kanban-build',
    cardId: card.id,
    prompt: BUILDER_PREAMBLE + `${card.title}\n${card.detail || ''}`,
    run: async (raw, j) => {
      const slug = (card.title || 'card').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'card';
      const artifact = saveDeliverable(raw, `${slug}-${j.id}`, 'kanban');
      kanban.patchCard(card.id, { lane: 'review', jobId: j.id, builderOutput: artifact.title, artifact });
      return { artifact };
    },
  });
  kanban.patchCard(card.id, { lane: 'building', jobId: job.id });
  return { job, board: kanban.listBoard() };
}

module.exports = {
  saveDeliverable,
  extractJsonBlock,
  executePipelineCard,
  assembleKanbanPlan,
  buildKanbanCard,
};
