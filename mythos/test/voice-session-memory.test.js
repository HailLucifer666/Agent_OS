'use strict';

// voice-session-memory.test.js — conversation-memory regressions.
//
// Three defects fixed here, all in the same block of server/index.js:
//
//   1. The history lived inside wss.on('connection'), so every WebSocket
//      reconnect (the dashboard reconnects on any network blip or tab sleep —
//      ui/public/js/ws.js scheduleReconnect) silently erased the entire
//      conversation. The operator experienced this as "it forgot what we were
//      talking about" mid-chat.
//   2. The window was 12 MIXED entries (user + assistant + action-outcome
//      notes), i.e. only ~4-6 real exchanges.
//   3. Nothing survived a process restart.
//
// Harness: reuses test/server.test.js's real-bus/real-server/real-ws pattern
// (Lesson #4 — seam bugs are invisible to fakes) and its baseDeps() shape.
// Every server is created through withServer(), which stops it in a finally:
// a bare assertion failure would otherwise leave the HTTP/WS server listening
// and the test-file child process never exits (the runner then waits forever —
// the same class of wedge the boot greeting's NODE_TEST_CONTEXT guard prevents).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');
const { createFsStore } = require('../src/core/memory/fs-store');

function fakeFs() {
  return { vaultPath: (...segments) => path.join('/test-vault', ...segments) };
}

// Captures every prompt the voice agent sends to the brain, so assertions can
// look at what the model actually saw rather than at internal state.
function capturingBrain(prompts) {
  return {
    think: async (req) => {
      try { prompts.push(String(req.messages[0].content)); } catch (_) { prompts.push(''); }
      return {
        content: JSON.stringify({ say: 'Noted.', actions: [], needs_result: false }),
        parsed: { say: 'Noted.', actions: [], needs_result: false },
        offline: false,
      };
    },
  };
}

function cfg(extra) {
  return Object.assign({
    MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
    MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000,
  }, extra || {});
}

function baseDeps(bus, overrides) {
  return Object.assign({
    bus,
    config: cfg(),
    logger: { info() {}, warn() {}, error() {} },
    memory: {
      working: { tick: 0, activeGoalId: null },
      episodic: { write: async () => ({ ref: 'ep-1' }), recall: () => [] },
      recallHybrid: async () => [],
      fs: fakeFs(),
    },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
    leash: {
      check: () => ({ allow: true, tier: 0, requireConfirm: false }),
      confirm: { create: () => 'cf-1', accept: () => null, reject: () => true },
    },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({}) },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
  }, overrides || {});
}

// Creates a server, runs fn(server, openSocket), and always stops the server
// and closes any socket opened through the helper.
async function withServer(deps, fn) {
  const server = createServer(deps);
  const sockets = [];
  try {
    await server.ready; // address() is null until the listening event
    const openSocket = async () => {
      const addr = server.httpServer.address();
      const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
      await new Promise((resolve) => ws.on('open', resolve));
      sockets.push(ws);
      return ws;
    };
    return await fn(server, openSocket);
  } finally {
    for (const ws of sockets) { try { ws.close(); } catch (_) {} }
    await server.stop();
  }
}

// Sends one utterance and resolves when the server finishes that turn.
async function say(ws, reqId, text) {
  const done = new Promise((resolve) => {
    const onMsg = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'done' && msg.reqId === reqId) { ws.off('message', onMsg); resolve(msg); }
    };
    ws.on('message', onMsg);
  });
  ws.send(JSON.stringify({ type: 'utterance', reqId, text }));
  return done;
}

// The history section of an assembled prompt: from the LAST 'RECENT EXCHANGES:'
// header (RULES itself mentions the phrase, so indexOf would match too early and
// scoop up the ~25k-char tool catalog) up to the output contract that follows it.
function historyBlock(prompt) {
  const start = prompt.lastIndexOf('RECENT EXCHANGES:');
  if (start < 0) return '';
  const end = prompt.indexOf('Respond with ONLY', start);
  return prompt.slice(start, end > start ? end : undefined);
}

test('conversation survives a WebSocket reconnect (history is server-scoped, not per-connection)', async () => {
  const bus = createBus({ historySize: 50 });
  const prompts = [];
  await withServer(baseDeps(bus, { brain: capturingBrain(prompts) }), async (server, openSocket) => {
    const ws1 = await openSocket();
    await say(ws1, 'r1', 'my dog is called Bagel');
    await say(ws1, 'r2', 'remember that');
    ws1.close();
    await new Promise((r) => setTimeout(r, 50));

    // A fresh socket is exactly what the browser does after a blip. Before the
    // fix this started a brand-new empty conversation.
    const ws2 = await openSocket();
    await say(ws2, 'r3', 'what is my dog called');

    assert.match(historyBlock(prompts[prompts.length - 1]), /Bagel/,
      'history from the previous connection must survive a reconnect');
  });
});

test('history keeps far more than the old 12 mixed entries, still bounded by the turn cap', async () => {
  const bus = createBus({ historySize: 50 });
  const prompts = [];
  const deps = baseDeps(bus, {
    brain: capturingBrain(prompts),
    config: cfg({ VOICE_HISTORY_MAX_TURNS: 40, VOICE_HISTORY_MAX_CHARS: 12000, VOICE_INTAKE_IDLE_MS: 2700000 }),
  });
  await withServer(deps, async (server, openSocket) => {
    const ws = await openSocket();
    // 15 utterances = 30 history entries with the assistant replies — more than
    // double the old 12-entry ceiling, so entry #1 used to be long gone.
    await say(ws, 'u0', 'marker-alpha is the passphrase');
    for (let i = 1; i <= 13; i++) await say(ws, 'u' + i, 'filler utterance number ' + i);
    await say(ws, 'final', 'what was the passphrase');

    const block = historyBlock(prompts[prompts.length - 1]);
    assert.match(block, /marker-alpha/, '14 exchanges back must still be in the prompt');
    // The turn cap must still bind — memory is wider, not unbounded.
    const lines = block.split('\n').filter((l) => /^(User|You):/.test(l));
    assert.ok(lines.length <= 40, 'history must stay within the turn cap, got ' + lines.length);
  });
});

test('char budget evicts oldest entries once the total is exceeded', async () => {
  const bus = createBus({ historySize: 50 });
  const prompts = [];
  const deps = baseDeps(bus, {
    brain: capturingBrain(prompts),
    // Deliberately tiny char budget with a generous turn cap, so the CHAR bound
    // is unambiguously the thing doing the eviction.
    config: cfg({ VOICE_HISTORY_MAX_TURNS: 100, VOICE_HISTORY_MAX_CHARS: 300, VOICE_INTAKE_IDLE_MS: 2700000 }),
  });
  await withServer(deps, async (server, openSocket) => {
    const ws = await openSocket();
    await say(ws, 'a', 'oldest-marker ' + 'x'.repeat(200));
    for (let i = 0; i < 5; i++) await say(ws, 'b' + i, 'later message ' + i + ' ' + 'y'.repeat(80));
    await say(ws, 'z', 'anything');

    const block = historyBlock(prompts[prompts.length - 1]);
    assert.doesNotMatch(block, /oldest-marker/, 'oldest entry must be evicted once the char budget is exceeded');
    // The current utterance is appended AFTER the model call, so it appears under
    // USER SAID rather than in the history block; the newest entry the history
    // itself can hold is the previous exchange.
    assert.match(block, /later message 4/, 'the most recent retained exchange must survive eviction');
  });
});

test('a saved session is restored on restart, and a stale one is not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-session-'));
  const store = createFsStore(() => dir);
  const memory = () => ({
    working: { tick: 0, activeGoalId: null },
    episodic: { write: async () => ({ ref: 'ep-1' }), recall: () => [] },
    recallHybrid: async () => [],
    fs: store,
  });

  try {
    // Fresh save: within the idle TTL, so it must be picked up.
    store.writeJSON('Conversation/session.json', {
      turns: [{ role: 'user', content: 'the server room code is quail-seven' }],
      savedAt: Date.now(),
    });
    const prompts = [];
    await withServer(
      baseDeps(createBus({ historySize: 50 }), { brain: capturingBrain(prompts), memory: memory() }),
      async (server, openSocket) => {
        const ws = await openSocket();
        await say(ws, 'r1', 'what was the server room code');
        assert.match(historyBlock(prompts[prompts.length - 1]), /quail-seven/,
          'a fresh session file must be restored into history');
      });

    // Stale save: older than the idle TTL, so it must be ignored rather than
    // resurrecting a conversation from days ago.
    store.writeJSON('Conversation/session.json', {
      turns: [{ role: 'user', content: 'ancient-marker from a dead session' }],
      savedAt: Date.now() - (10 * 24 * 60 * 60 * 1000),
    });
    const prompts2 = [];
    await withServer(
      baseDeps(createBus({ historySize: 50 }), { brain: capturingBrain(prompts2), memory: memory() }),
      async (server, openSocket) => {
        const ws = await openSocket();
        await say(ws, 'r1', 'hello');
        assert.doesNotMatch(prompts2[prompts2.length - 1], /ancient-marker/,
          'a stale session file must not be loaded');
      });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a turn is persisted to the vault so it can outlive the process', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-session-'));
  const store = createFsStore(() => dir);
  const memory = {
    working: { tick: 0, activeGoalId: null },
    episodic: { write: async () => ({ ref: 'ep-1' }), recall: () => [] },
    recallHybrid: async () => [],
    fs: store,
  };
  try {
    await withServer(
      baseDeps(createBus({ historySize: 50 }), { brain: capturingBrain([]), memory }),
      async (server, openSocket) => {
        const ws = await openSocket();
        await say(ws, 'r1', 'persist-me please');

        const saved = store.readJSON('Conversation/session.json', null);
        assert.ok(saved && Array.isArray(saved.turns), 'session.json must be written');
        assert.ok(saved.turns.some((t) => /persist-me/.test(t.content)), 'the turn must be in the saved session');
        assert.ok(saved.savedAt > 0, 'savedAt must be stamped');
      });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a fake fs exposing only vaultPath does not break the turn path (guard is load-bearing)', async () => {
  // The whole server suite passes memory.fs = { vaultPath }. An unguarded
  // readJSON/writeJSON in the history block is a TypeError on every turn, which
  // is why both calls are wrapped.
  const prompts = [];
  await withServer(
    baseDeps(createBus({ historySize: 50 }), { brain: capturingBrain(prompts) }),
    async (server, openSocket) => {
      const ws = await openSocket();
      const done = await say(ws, 'r1', 'still works');
      assert.equal(done.type, 'done');
      assert.ok(prompts.length >= 1);
    });
});
