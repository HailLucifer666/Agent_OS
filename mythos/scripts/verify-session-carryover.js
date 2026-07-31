#!/usr/bin/env node
'use strict';

// verify-session-carryover.js — the boot greeting picks up yesterday's thread.
//
// Why a script and not a test: deliverBootGreeting() is hard-suppressed under
// the node test runner (server/index.js sets bootGreetingFired from
// NODE_TEST_CONTEXT) because it fires 2.5s after a WS connection and its
// TTS-probe/brain fetches leave sockets open past the last test, wedging the
// test-file child process. That guard is deliberate and stays. Running the same
// code from a plain script has no runner to wedge, so this is the honest way to
// exercise it.
//
// What it verifies, against the REAL createServer/deliverBootGreeting:
//   1. Conversation records from the last few days are recalled and passed to
//      the greeting brain call as a "Last time we spoke:" fact.
//   2. The greeting prompt instructs the model to resume that thread.
//   3. With NO prior conversations, the greeting still works and simply carries
//      no carryover fact (it must never depend on memory).
//
// Everything except the server itself is a fake: the brain captures the prompt
// instead of calling a provider, and TTS reports unavailable so no audio is
// synthesized. No API keys required.
//
// Usage:
//   node scripts/verify-session-carryover.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

// Must be cleared BEFORE requiring the server: bootGreetingFired is computed at
// createServer() time from this variable.
delete process.env.NODE_TEST_CONTEXT;
delete process.env.BOOT_GREETING;

const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');
const { createFsStore } = require('../src/core/memory/fs-store');

const GREET_WAIT_MS = 4000; // the greeting timer is 2.5s

function deps(bus, store, convos, captured) {
  return {
    bus,
    config: {
      MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'MYTHOS',
      MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000,
    },
    logger: { info() {}, warn() {}, error() {} },
    memory: {
      working: { tick: 0, activeGoalId: null },
      episodic: {
        write: async () => ({ ref: 'ep-1' }),
        // Mirrors episodic.recall's contract: recall('', {kind}) is recency-ranked.
        recall: (query, opts) => (opts && opts.kind === 'conversation' ? convos : []),
      },
      recallHybrid: async () => [],
      fs: store,
    },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 2, active: 1 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
    leash: {
      check: () => ({ allow: true, tier: 0, requireConfirm: false }),
      confirm: { create: () => 'cf-1', accept: () => null, reject: () => true },
    },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({ providers: {} }) },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
    brain: {
      think: async (req) => {
        if (req.source === 'boot-greeting') captured.push(String(req.messages[0].content));
        return {
          content: 'Evening, sir. Picking up where we left off.',
          parsed: null,
          offline: false,
        };
      },
    },
    tts: { isAvailable: async () => false },
  };
}

async function runCase(name, convos) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-carryover-'));
  const store = createFsStore(() => dir);
  const bus = createBus({ historySize: 50 });
  const captured = [];
  const spoken = [];
  const server = createServer(deps(bus, store, convos, captured));
  let ws = null;
  try {
    await server.ready;
    const addr = server.httpServer.address();
    ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'proactive-speech') spoken.push(msg.text);
    });
    await new Promise((r) => setTimeout(r, GREET_WAIT_MS));
    return { name, prompt: captured[0] || null, spoken };
  } finally {
    if (ws) { try { ws.close(); } catch (_) {} }
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function check(label, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? ' — ' + detail : ''));
  return ok;
}

(async () => {
  let allOk = true;
  console.log('verify-session-carryover: boot greeting resumes the last conversation\n');

  // Case 1: prior conversations exist.
  const withHistory = await runCase('with history', [
    { record: { summary: 'User: build me a landing page for the pet shop | MYTHOS: started it' } },
    { record: { summary: 'User: is it done yet | MYTHOS: still generating' } },
    { record: { summary: 'User: fix the notepad typing bug | MYTHOS: logged it' } },
  ]);
  console.log('Case 1 — three recent conversations:');
  allOk = check('greeting brain call happened', !!withHistory.prompt) && allOk;
  if (withHistory.prompt) {
    allOk = check('carryover fact present', /Last time we spoke:/.test(withHistory.prompt)) && allOk;
    allOk = check('carries a real prior topic', /pet shop/.test(withHistory.prompt)) && allOk;
    allOk = check('instructs the model to resume the thread',
      /picking up that thread/i.test(withHistory.prompt)) && allOk;
  }
  allOk = check('greeting was spoken to the client', withHistory.spoken.length === 1,
    withHistory.spoken[0] || 'nothing spoken') && allOk;

  // Case 2: a first-ever boot must still greet, just without carryover.
  const noHistory = await runCase('no history', []);
  console.log('\nCase 2 — no prior conversations:');
  allOk = check('greeting brain call happened', !!noHistory.prompt) && allOk;
  if (noHistory.prompt) {
    allOk = check('no carryover fact invented', !/Last time we spoke:/.test(noHistory.prompt)) && allOk;
  }
  allOk = check('greeting still spoken', noHistory.spoken.length === 1) && allOk;

  console.log('\n' + (allOk ? 'RESULT: all checks passed' : 'RESULT: FAILURES above'));
  process.exit(allOk ? 0 : 1);
})().catch((err) => {
  console.error('verify-session-carryover crashed:', err);
  process.exit(1);
});
