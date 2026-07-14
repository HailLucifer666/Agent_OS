'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createResearch } = require('../src/core/effectors/research');

function makeBrain(overrides) {
  overrides = overrides || {};
  return {
    tryParseWithRepair(c) { try { return JSON.parse(c); } catch (_) { return null; } },
    async think({ lane, schemaHint }) {
      if (lane === 'simple' && schemaHint && /queries/.test(schemaHint)) {
        if (overrides.planUnparseable) return { content: 'not json at all', offline: false };
        return { parsed: { queries: ['q1 about topic', 'q2 about topic', 'q3 about topic'] }, content: '{}', offline: false };
      }
      if (lane === 'text') {
        if (overrides.synthOffline) return { content: null, offline: true };
        return { parsed: { headline: 'The Headline', summary: 'A cited summary [1][2].', keyFindings: [{ text: 'Finding one', citations: [1] }], caveats: ['Small sample'] }, content: '{}', offline: false };
      }
      return { content: 'condensed', offline: false };
    },
  };
}

function makeSearch(mode) {
  return async function () {
    if (mode === 'fail') return { ok: false, result: 'down' };
    return { ok: true, result: { provider: 'ddg', results: [
      { title: 'Source A', url: 'https://a.example/x', snippet: 'snip a' },
      { title: 'Source B', url: 'https://b.example/y', snippet: 'snip b' },
    ] } };
  };
}

function makeFetch(mode) {
  return async function ({ url }) {
    if (mode === 'fail') return { ok: false, result: 'blocked' };
    return { ok: true, result: { url, finalUrl: url, title: 'Title ' + url, text: 'Body text for ' + url, truncated: false } };
  };
}

function makeMemory(fs, calls) {
  return { fs, semantic: { write(topic, facts, opts) { calls.push({ topic, facts, opts }); return { ref: 'sem-1', degraded: false }; } } };
}

function build(opts) {
  opts = opts || {};
  const dir = tempVaultDir();
  const bus = fakeBus();
  const fs = createFsStore(() => dir, bus);
  const semanticCalls = [];
  const research = createResearch({
    config: { RESEARCH_MAX_SOURCES: 8, RESEARCH_FETCH_CONCURRENCY: 3, RESEARCH_MAX_PERSISTED: 50, RESEARCH_SCOPE_CHECKPOINT: false },
    brain: makeBrain(opts.brain || {}),
    bus, memory: makeMemory(fs, semanticCalls),
    search: makeSearch(opts.search), fetchPage: makeFetch(opts.fetch),
    checkpoints: null, fs, browserAgent: null,
  });
  return { dir, bus, fs, research, semanticCalls };
}

async function waitTerminal(research, id, timeout) {
  const start = Date.now();
  for (;;) {
    const r = research.getResearch(id);
    if (r && (r.stage === 'done' || r.stage === 'failed')) return r;
    if (Date.now() - start > (timeout || 3000)) return r;
    await new Promise((res) => setTimeout(res, 10));
  }
}

test('happy path: stage order, reportUrl, artifact written, semantic.write called', async () => {
  const h = build({});
  try {
    const { id } = h.research.runResearch('Best local LLMs for coding', 'standard');
    const r = await waitTerminal(h.research, id);
    assert.equal(r.stage, 'done');
    assert.equal(r.degraded, false);
    assert.ok(r.reportUrl && /\/vault\/builds\/research\/.*\.html$/.test(r.reportUrl), 'reportUrl set: ' + r.reportUrl);
    assert.equal(r.headline, 'The Headline');

    // stage order from the bus
    const stages = h.bus._emitted().filter((e) => e.type === 'research.update').map((e) => e.payload.stage);
    for (const s of ['plan-queries', 'searching', 'fetching', 'synthesizing', 'persisting', 'done']) {
      assert.ok(stages.indexOf(s) !== -1, 'saw stage ' + s + ' in ' + stages.join(','));
    }
    assert.ok(stages.indexOf('plan-queries') < stages.indexOf('searching'));
    assert.ok(stages.indexOf('searching') < stages.indexOf('fetching'));
    assert.ok(stages.indexOf('fetching') < stages.indexOf('done'));

    // artifact exists on disk
    const rel = r.reportUrl.replace('/vault/', '');
    assert.ok(h.fs.exists(rel), 'HTML artifact written to ' + rel);
    const html = h.fs.readText(rel, '');
    assert.ok(html.includes('The Headline'));
    assert.ok(html.includes('Sources'));

    // semantic memory written with sources
    assert.equal(h.semanticCalls.length, 1);
    assert.equal(h.semanticCalls[0].topic, 'Best local LLMs for coding');
    assert.deepEqual(h.semanticCalls[0].opts.sources, ['https://a.example/x', 'https://b.example/y']);
  } finally { cleanupVaultDir(h.dir); }
});

test('all searches failing → failed', async () => {
  const h = build({ search: 'fail' });
  try {
    const { id } = h.research.runResearch('topic', 'quick');
    const r = await waitTerminal(h.research, id);
    assert.equal(r.stage, 'failed');
    assert.match(r.error, /search/i);
    assert.equal(h.semanticCalls.length, 0);
  } finally { cleanupVaultDir(h.dir); }
});

test('all fetches failing → failed', async () => {
  const h = build({ fetch: 'fail' });
  try {
    const { id } = h.research.runResearch('topic', 'quick');
    const r = await waitTerminal(h.research, id);
    assert.equal(r.stage, 'failed');
    assert.match(r.error, /fetch/i);
  } finally { cleanupVaultDir(h.dir); }
});

test('plan-parse fallback: unparseable queries → uses topic, still completes', async () => {
  const h = build({ brain: { planUnparseable: true } });
  try {
    const { id } = h.research.runResearch('a fallback topic', 'quick');
    const r = await waitTerminal(h.research, id);
    assert.equal(r.stage, 'done');
  } finally { cleanupVaultDir(h.dir); }
});

test('synthesis offline → degraded but still done + persisted', async () => {
  const h = build({ brain: { synthOffline: true } });
  try {
    const { id } = h.research.runResearch('topic', 'standard');
    const r = await waitTerminal(h.research, id);
    assert.equal(r.stage, 'done');
    assert.equal(r.degraded, true);
    assert.ok(r.reportUrl, 'artifact still written when degraded');
    assert.equal(h.semanticCalls.length, 1, 'still persisted to semantic memory');
  } finally { cleanupVaultDir(h.dir); }
});

test('crash recovery: a non-terminal persisted run is marked interrupted at init()', async () => {
  const h = build({});
  try {
    h.fs.writeJSON('Checkpoints/research.json', [
      { id: 'research-old-1', topic: 't', depth: 'standard', stage: 'searching', createdAt: Date.now() - 1000, finishedAt: null, sources: [] },
    ]);
    h.research.init();
    const r = h.research.getResearch('research-old-1');
    assert.ok(r, 'run loaded');
    assert.equal(r.stage, 'interrupted');
    assert.match(r.error, /restarted/i);
  } finally { cleanupVaultDir(h.dir); }
});
