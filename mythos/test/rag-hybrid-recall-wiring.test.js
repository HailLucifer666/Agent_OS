'use strict';

// rag-hybrid-recall-wiring.test.js — Item 9 RAG hardening regression.
//
// Defect fixed: handleUtterance() (server/index.js, primary voice recall path)
// used to call memory.episodic.recall() + memory.semantic.recall() directly —
// plain lexical recall, bypassing the vector/hybrid recall system entirely
// (memory.recallHybrid(), which fuses keyword + vector hits via RRF, had zero
// external callers before this fix). This test asserts the hot path now calls
// recallHybrid() once with the utterance text, and does not build the primary
// memoryContext from direct episodic/semantic recall calls.
//
// Harness: reuses test/server.test.js's real-bus/real-server/real-ws pattern
// (Lesson #4 — seam bugs are invisible to fakes) and its baseDeps() shape.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const path = require('path');
const { createServer } = require('../server');

function fakeFs() {
  return { vaultPath: (...segments) => path.join('/test-vault', ...segments) };
}

function baseDeps(bus, overrides) {
  return Object.assign({
    bus,
    config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000 },
    logger: { info() {}, warn() {}, error() {} },
    memory: { working: { tick: 0, activeGoalId: null }, episodic: { write: async () => {} }, fs: fakeFs() },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
    leash: { confirm: { create: () => 'cf-1', accept: () => null, reject: () => true } },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({}) },
    agentActions: {
      assembleKanbanPlan: () => ({ job: { id: 'j1', status: 'queued' } }),
      buildKanbanCard: () => ({ job: { id: 'j1', status: 'queued' }, board: { cards: [] } }),
      reviewKanbanCard: () => ({ job: { id: 'j1', status: 'queued' } }),
    },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
  }, overrides || {});
}

test('handleUtterance recalls via memory.recallHybrid, not direct episodic/semantic recall', async () => {
  const bus = createBus({ historySize: 50 });

  const calls = { recallHybrid: [], episodicRecall: [], semanticRecall: [] };

  const fakeMemory = {
    working: { tick: 0, activeGoalId: null },
    fs: fakeFs(),
    episodic: {
      write: async () => ({ ref: 'ep-turn-1' }),
      // Still legitimately called by the untouched "pending thoughts" block
      // (kind:'thought', query ''); must NOT be called with the utterance text.
      recall: (query, opts) => { calls.episodicRecall.push({ query, opts }); return []; },
    },
    semantic: {
      // Must never be called directly now that recallHybrid owns fusion.
      recall: (query, opts) => { calls.semanticRecall.push({ query, opts }); return []; },
    },
    recallHybrid: async (query, opts) => {
      calls.recallHybrid.push({ query, opts });
      return [
        { ref: 'ep-9', score: 0.9, snippet: 'keyword hit about coffee', store: 'episodic' },
        { ref: 'sem-1', score: 0.8, snippet: 'user prefers dark roast', store: 'semantic' },
      ];
    },
  };

  // Minimal brain/leash so createVoiceAgent() succeeds (requires brain.think,
  // leash.check, dispatch, bus) and handleUtterance reaches the recall block
  // instead of short-circuiting to "Brain is offline."
  const fakeBrain = {
    think: async () => ({
      content: JSON.stringify({ say: 'Noted.', actions: [], needs_result: false }),
      parsed: { say: 'Noted.', actions: [], needs_result: false },
      offline: false,
    }),
  };
  const fakeLeash = {
    check: () => ({ allow: true, tier: 0, requireConfirm: false }),
    confirm: { create: () => 'cf-1', accept: () => null, reject: () => true },
  };

  const server = createServer(baseDeps(bus, { memory: fakeMemory, brain: fakeBrain, leash: fakeLeash }));

  await server.ready; // address() is null until the listening event (async bind on Windows)
  const addr = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  const done = new Promise((resolve) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'done') resolve(msg);
    });
  });

  ws.send(JSON.stringify({ type: 'utterance', reqId: 'r1', text: 'what coffee do I like' }));
  await done;

  assert.equal(calls.recallHybrid.length, 1, 'recallHybrid should be called exactly once');
  assert.equal(calls.recallHybrid[0].query, 'what coffee do I like');
  assert.equal(calls.recallHybrid[0].opts.limit, 12);
  // 21-day window (inside EPISODIC_RETENTION_DAYS=30): measured +20ms on a real
  // 2.2MB vault, so "what did we discuss last week" stops falling off the edge.
  assert.equal(calls.recallHybrid[0].opts.windowDays, 21);

  assert.equal(calls.semanticRecall.length, 0, 'semantic.recall must not be called directly anymore');
  assert.ok(
    calls.episodicRecall.every((c) => c.query !== 'what coffee do I like'),
    'episodic.recall must not be called with the utterance text (only the untouched pending-thoughts lookup remains)'
  );

  ws.close();
  await server.stop();
});

// Item A (Phase-1 hardening follow-up): recallHybrid() embeds the query via
// providers/embeddings.js's Ollama-then-Mistral chain, each attempt bounded by
// its own 8s timeout — a provider that HANGS (never resolves, doesn't error)
// can stack up to ~16s onto a live voice turn before recallHybrid() itself
// would ever settle. handleUtterance now wraps that call in a tighter,
// independent Promise.race timeout (VOICE_RECALL_TIMEOUT_MS, default 3500ms)
// so a hung embed provider degrades to no-memory-context instead of stalling
// the whole turn. This proves the bound holds even when recallHybrid() never
// resolves at all.
test('handleUtterance does not stall past the recall timeout when recallHybrid hangs (Item A)', async () => {
  const bus = createBus({ historySize: 50 });

  const fakeMemory = {
    working: { tick: 0, activeGoalId: null },
    fs: fakeFs(),
    episodic: { write: async () => ({ ref: 'ep-1' }), recall: () => [] },
    semantic: { recall: () => [] },
    // Simulates a provider that hangs rather than erroring or timing out on
    // its own — recallHybrid() would never settle on its own in this case.
    recallHybrid: () => new Promise(() => {}),
  };
  const fakeBrain = {
    think: async () => ({
      content: JSON.stringify({ say: 'Noted.', actions: [], needs_result: false }),
      parsed: { say: 'Noted.', actions: [], needs_result: false },
      offline: false,
    }),
  };
  const fakeLeash = {
    check: () => ({ allow: true, tier: 0, requireConfirm: false }),
    confirm: { create: () => 'cf-1', accept: () => null, reject: () => true },
  };

  const server = createServer(baseDeps(bus, { memory: fakeMemory, brain: fakeBrain, leash: fakeLeash }));

  await server.ready; // address() is null until the listening event (async bind on Windows)
  const addr = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  const done = new Promise((resolve) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'done') resolve(msg);
    });
  });

  const start = Date.now();
  ws.send(JSON.stringify({ type: 'utterance', reqId: 'r1', text: 'hello' }));
  const reply = await done;
  const elapsedMs = Date.now() - start;

  // Comfortably above the ~3.5s recall timeout (headroom for edge-tts/CI jitter)
  // and well under the old worst case (~16s: two chained 8s provider attempts).
  assert.ok(elapsedMs < 7000, `turn should resolve well under the old ~16s stall, took ${elapsedMs}ms`);
  assert.equal(reply.say, 'Noted.', 'the turn still completes normally — recall just degrades to no context');

  ws.close();
  await server.stop();
});
