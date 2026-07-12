'use strict';

// effectors/agent-actions.js — CA of app/lib/agent-actions.js. `executePipelineCard`/
// `assembleKanbanPlan`/`buildKanbanCard` call `buildRunner.enqueue({kind, prompt, run})`
// (no `cardId` arg) instead of `orchestrator.enqueue({kind, cardId, prompt, run})` — card
// association moves into the `run` closure per Spec Ambiguities Resolved #7. Re-pointed
// from the NOVA singleton `require('./vault')`/`require('./pipeline')`/`require('./kanban')`
// to injected instances (same factory convention as effectors/pipeline.js/kanban.js).

var path = require('path');
var designSystemEngine = require('../design/system');
var personas = require('../agents/personas');

var DELIVERABLE_PREAMBLE = [
  'You are the Pipeline build agent. Take the captured idea below and produce the single',
  'most useful self-contained deliverable for it: EITHER a complete single-file HTML page/app',
  '(all CSS/JS inline, no external resources, starting with <!DOCTYPE html>) OR a thorough',
  'markdown document (plan, spec, draft, or write-up, starting with a # title line).',
  'Choose whichever genuinely fits the idea. Output ONLY the raw file content — no',
  'commentary, no markdown fences around the whole output.',
  'TITLE CONSTRAINT: the <title> or # heading MUST use words FROM the idea, describing',
  'what the deliverable IS. Do NOT invent a brand name, product name, or marketing title.',
  'If the idea is "a landing page for AI news", the title should be "AI News Landing Page"',
  'or similar — never "The Applied Signal" or any other name you made up. Idea: '
].join(' ');

var PLANNER_PREAMBLE = [
  'You are the Kanban Planner agent. Break the goal below into 3-6 concrete, independently',
  'buildable tasks. Respond with ONLY a JSON array, no commentary, no markdown fence:',
  '[{"title": "short task title", "detail": "1-3 sentences describing exactly what to build"}]',
  'Goal: '
].join(' ');

var BUILDER_PREAMBLE = [
  'You are the Kanban Builder agent. Build the single most useful self-contained deliverable',
  'for this task: EITHER a complete single-file HTML page/app (all CSS/JS inline, starting',
  'with <!DOCTYPE html>) OR a markdown document (starting with a # title). Output ONLY the',
  'raw file content, no commentary, no fences around the whole output.',
  'Title the deliverable using words FROM the task, not an invented brand name.\nTask: '
].join(' ');

function extractJsonBlock(raw) {
  var fence = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  var text = fence ? fence[1] : raw;
  return JSON.parse(text.trim());
}

function createAgentActions({ fs, pipeline, kanban, buildRunner, designSystem }) {
  if (!fs || typeof fs.writeText !== 'function' || typeof fs.exists !== 'function') {
    throw new Error('createAgentActions requires a vault fs-store with writeText/exists');
  }
  if (!pipeline || typeof pipeline.findCard !== 'function') {
    throw new Error('createAgentActions requires a pipeline effector');
  }
  if (!kanban || typeof kanban.findCard !== 'function') {
    throw new Error('createAgentActions requires a kanban effector');
  }
  if (!buildRunner || typeof buildRunner.enqueue !== 'function') {
    throw new Error('createAgentActions requires a buildRunner with enqueue()');
  }

  // Saves an LLM deliverable (HTML or markdown) into vault/builds/<kind>/, deriving a
  // filename from a <title>/# heading (or the source text) and de-duplicating on disk.
  function saveDeliverable(raw, sourceText, kind) {
    kind = kind || 'pipeline';
    var content = raw.trim();
    var fence = content.match(/^```[a-z]*\s*\n([\s\S]*?)\n```\s*$/);
    if (fence) content = fence[1].trim();
    if (!content) throw new Error('build agent returned empty output — try again');

    var isHtml = /<!DOCTYPE html/i.test(content);
    if (isHtml) {
      var docStart = content.search(/<!DOCTYPE html/i);
      if (docStart > 0) content = content.slice(docStart);
    }
    var ext = isHtml ? 'html' : 'md';
    var titleMatch = isHtml
      ? content.match(/<title>([^<]{1,60})<\/title>/i)
      : content.match(/^#\s+(.{1,60})/m);
    var title = titleMatch ? titleMatch[1].trim() : sourceText.slice(0, 60);
    var base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'deliverable';
    var name = base + '.' + ext;
    for (var i = 2; fs.exists(path.join('builds', kind, name)); i += 1) {
      name = base + '-' + i + '.' + ext;
    }
    fs.writeText(path.join('builds', kind, name), content);
    return { path: '/vault/builds/' + kind + '/' + name, title: title, name: name };
  }

  // executePipelineCard(cardId, goalId?) — same behavior as NOVA's POST
  // /api/pipeline/:id/execute. `goalId` (Phase 18) carries the originating GoalSystem
  // goal, if any, onto the enqueued job — omitted/undefined means a goal-less,
  // dashboard/voice-triggered action, and enqueue() honestly records that as null.
  function executePipelineCard(cardId, goalId) {
    var found = pipeline.findCard(cardId);
    if (!found) throw new Error('card not found');
    if (found.stage !== 'execute') throw new Error('card is not in the Execute stage');
    var existing = found.card.jobId ? buildRunner.getJob(found.card.jobId) : null;
    if (existing && (existing.status === 'queued' || existing.status === 'running')) {
      throw new Error('a build is already in progress for this card');
    }
    var card = found.card;
    var job = buildRunner.enqueue({
      kind: 'pipeline-execute',
      goalId: goalId,
      prompt: (function() {
        var base = DELIVERABLE_PREAMBLE + card.text;
        if (designSystem) {
          try {
            var ds = designSystemEngine.generateDesignSystem(card.text);
            var dsBlock = designSystemEngine.formatDesignSystemForPrompt(ds);
            if (dsBlock) return dsBlock + '\n\n' + base;
          } catch (_) { /* design system lookup is best-effort */ }
        }
        return base;
      })(),
      run: async function(raw, j) {
        var artifact = saveDeliverable(raw, card.text, 'pipeline');
        pipeline.moveCard(card.id, 'shipped', { progress: 100, jobId: j.id, artifact: artifact });
        return { artifact: artifact };
      }
    });
    pipeline.moveCard(card.id, 'execute', { jobId: job.id, progress: 25 });
    return { job: job, board: pipeline.listAll() };
  }

  // assembleKanbanPlan(goal, goalId?) — same behavior as NOVA's POST /api/kanban/assemble.
  // goalId (Phase 18) — see executePipelineCard's comment above.
  function assembleKanbanPlan(goal, goalId) {
    if (!goal || !goal.trim()) throw new Error('goal required');
    var job = buildRunner.enqueue({
      kind: 'kanban-plan',
      goalId: goalId,
      prompt: PLANNER_PREAMBLE + goal.trim(),
      run: async function(raw) {
        var tasks;
        try {
          tasks = extractJsonBlock(raw);
        } catch (_) {
          throw new Error('planner did not return valid JSON — try rephrasing the goal');
        }
        if (!Array.isArray(tasks) || !tasks.length) throw new Error('planner returned no tasks');
        var created = kanban.addCards(tasks, 'backlog');
        return { artifact: { cards: created } };
      }
    });
    return { job: job };
  }

  // buildKanbanCard(cardId, goalId?) — same behavior as NOVA's POST
  // /api/kanban/cards/:id/build. goalId (Phase 18) — see executePipelineCard's comment above.
  function buildKanbanCard(cardId, goalId) {
    var card = kanban.findCard(cardId);
    if (!card) throw new Error('card not found');
    var existing = card.jobId ? buildRunner.getJob(card.jobId) : null;
    if (existing && (existing.status === 'queued' || existing.status === 'running')) {
      throw new Error('a build is already in progress for this card');
    }
    var builderPersonaRole = personas.pickBuilderPersona(card.title, card.detail);
    var builderPersona = personas.loadPersona(builderPersonaRole);
    var job = buildRunner.enqueue({
      kind: 'kanban-build',
      goalId: goalId,
      prompt: (function() {
        var base = BUILDER_PREAMBLE + card.title + '\n' + (card.detail || '');
        if (designSystem) {
          try {
            var ds = designSystemEngine.generateDesignSystem(card.title + ' ' + (card.detail || ''));
            var dsBlock = designSystemEngine.formatDesignSystemForPrompt(ds);
            if (dsBlock) return dsBlock + '\n\n' + base;
          } catch (_) { /* best-effort */ }
        }
        return base;
      })(),
      persona: builderPersona,
      run: async function(raw, j) {
        var slug = (card.title || 'card').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'card';
        var artifact = saveDeliverable(raw, slug + '-' + j.id, 'kanban');
        kanban.patchCard(card.id, { lane: 'review', jobId: j.id, builderOutput: artifact.title, artifact: artifact });
        return { artifact: artifact };
      }
    });
    kanban.patchCard(card.id, { lane: 'building', jobId: job.id });
    return { job: job, board: kanban.listBoard() };
  }

  return {
    saveDeliverable: saveDeliverable,
    extractJsonBlock: extractJsonBlock,
    executePipelineCard: executePipelineCard,
    assembleKanbanPlan: assembleKanbanPlan,
    buildKanbanCard: buildKanbanCard
  };
}

module.exports = { createAgentActions, extractJsonBlock };
