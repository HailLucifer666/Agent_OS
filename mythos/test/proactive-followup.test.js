'use strict';

// proactive-followup.test.js — the cortex.thought -> spoken follow-up wiring.
//
// Defect fixed: cortex/index.js has emitted 'cortex.thought' after every
// productive idle mull since Phase 4, and NOTHING subscribed to it. The entity
// formed follow-up thoughts ("you never told me which theme you wanted") and
// never said one — they surfaced only as prompt context IF the operator happened
// to speak first. This asserts the subscriber exists and that its four guards
// hold, because "proactive" turns into "annoying" the moment they don't:
//   - priority must be 'high' (the mull prompt reserves that for an unanswered
//     question or a stalled goal/build; medium/low stay next-turn context)
//   - never within FOLLOWUP_QUIET_MS of the operator's last turn
//   - at most one per FOLLOWUP_MIN_GAP_MS
//   - FOLLOWUP_MIN_GAP_MS = 0 disables the feature outright
//
// Harness: real bus + real server + real WS, same shape as server.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const path = require('path');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

function baseDeps(bus, configExtra) {
  return {
    bus,
    config: Object.assign({
      MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
      MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000,
      FOLLOWUP_QUIET_MS: 0,        // no quiet requirement unless a test sets one
      FOLLOWUP_MIN_GAP_MS: 3600000,
    }, configExtra || {}),
    logger: { info() {}, warn() {}, error() {} },
    memory: {
      working: { tick: 0, activeGoalId: null },
      episodic: { write: async () => ({ ref: 'ep-1' }), recall: () => [] },
      recallHybrid: async () => [],
      fs: { vaultPath: (...s) => path.join('/test-vault', ...s) },
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
    brain: {
      think: async () => ({
        content: JSON.stringify({ say: 'Noted.', actions: [], needs_result: false }),
        parsed: { say: 'Noted.', actions: [], needs_result: false },
        offline: false,
      }),
    },
    tts: { isAvailable: async () => false },
  };
}

// Collects proactive-speech frames pushed to a connected client.
async function withClient(deps, fn) {
  const server = createServer(deps);
  const spoken = [];
  let ws = null;
  try {
    await server.ready;
    const addr = server.httpServer.address();
    ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    await new Promise((resolve) => ws.on('open', resolve));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'proactive-speech') spoken.push(msg.text);
    });
    return await fn({ ws, spoken, server });
  } finally {
    if (ws) { try { ws.close(); } catch (_) {} }
    await server.stop();
  }
}

// proactiveSpeak awaits a TTS availability probe before emitting, so give the
// microtask queue a beat before asserting on what was delivered.
const settle = () => new Promise((r) => setTimeout(r, 120));

test('a high-priority cortex thought is spoken unprompted', async () => {
  const bus = createBus({ historySize: 50 });
  await withClient(baseDeps(bus), async ({ spoken }) => {
    bus.emit('cortex.thought', { text: 'You never told me which theme you wanted.', priority: 'high' });
    await settle();
    assert.equal(spoken.length, 1, 'a high-priority thought must be spoken');
    assert.match(spoken[0], /which theme/);
  });
});

test('medium and low priority thoughts stay silent (they ride the next turn as context)', async () => {
  const bus = createBus({ historySize: 50 });
  await withClient(baseDeps(bus), async ({ spoken }) => {
    bus.emit('cortex.thought', { text: 'They tend to work late.', priority: 'medium' });
    bus.emit('cortex.thought', { text: 'Disk is getting full-ish.', priority: 'low' });
    await settle();
    assert.equal(spoken.length, 0, 'only high-priority thoughts may interrupt');
  });
});

test('an empty thought is never spoken', async () => {
  const bus = createBus({ historySize: 50 });
  await withClient(baseDeps(bus), async ({ spoken }) => {
    bus.emit('cortex.thought', { text: '', priority: 'high' });
    await settle();
    assert.equal(spoken.length, 0);
  });
});

test('the quiet gate suppresses a follow-up right after the operator speaks', async () => {
  const bus = createBus({ historySize: 50 });
  // 10-minute quiet requirement: an utterance moments ago must block the thought.
  await withClient(baseDeps(bus, { FOLLOWUP_QUIET_MS: 600000 }), async ({ ws, spoken }) => {
    const done = new Promise((resolve) => {
      const onMsg = (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'done') { ws.off('message', onMsg); resolve(); }
      };
      ws.on('message', onMsg);
    });
    ws.send(JSON.stringify({ type: 'utterance', reqId: 'r1', text: 'hello' }));
    await done;

    bus.emit('cortex.thought', { text: 'Loose end from earlier.', priority: 'high' });
    await settle();
    assert.equal(spoken.length, 0, 'must not interrupt a live conversation');
  });
});

test('the nag gate allows one follow-up per gap, not two', async () => {
  const bus = createBus({ historySize: 50 });
  await withClient(baseDeps(bus), async ({ spoken }) => {
    bus.emit('cortex.thought', { text: 'First loose end.', priority: 'high' });
    await settle();
    bus.emit('cortex.thought', { text: 'Second loose end.', priority: 'high' });
    await settle();
    assert.equal(spoken.length, 1, 'the second thought inside the gap must be dropped');
    assert.match(spoken[0], /First loose end/);
  });
});

test('FOLLOWUP_MIN_GAP_MS = 0 disables proactive follow-ups entirely', async () => {
  const bus = createBus({ historySize: 50 });
  await withClient(baseDeps(bus, { FOLLOWUP_MIN_GAP_MS: 0 }), async ({ spoken }) => {
    bus.emit('cortex.thought', { text: 'Would have spoken.', priority: 'high' });
    await settle();
    assert.equal(spoken.length, 0, '0 must be an off switch, not a zero-length gap');
  });
});
