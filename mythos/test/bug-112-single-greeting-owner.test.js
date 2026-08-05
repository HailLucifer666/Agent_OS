'use strict';

// BUG-112 — four greetings in three minutes.
//
// This file covers the "one greeting owner per session" half of the bug: the
// daily planner's morning brief (bus event 'plan.morning-brief') used to reach
// proactiveSpeak() through a bare bus.subscribe with NO dedup check at all —
// conversation/announcer.js's isRecent()/markAnnounced() dedup exists for
// exactly this class of problem, but that module never subscribed to
// 'plan.morning-brief', so its guard never ran for this source. The boot
// greeting (deliverBootGreeting) is now the canonical "session opened"
// announcement: it marks a shared dedup key via conversationAnnouncer, and the
// plan.morning-brief handler checks/marks the SAME key before speaking.
//
// Run: cd mythos && MYTHOS_PORT=4983 EDGE_TTS_PORT=5083 EDGE_TTS_URL=http://127.0.0.1:5083 \
//   node --test test/bug-112-single-greeting-owner.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
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

function waitForMessages(received, predicate, ms) {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const timer = setInterval(() => {
      if (received.some(predicate) || Date.now() > deadline) { clearInterval(timer); resolve(); }
    }, 10);
  });
}

describe('BUG-112: one greeting owner per session', () => {
  it('a plan.morning-brief firing right after the boot greeting is suppressed by the shared dedup, not spoken as a second greeting', async () => {
    const bus = createBus({ historySize: 50 });
    const brain = { think: async () => ({ content: 'Good evening, sir. MYTHOS online.', offline: false }) };
    const server = createServer(baseDeps(bus, { brain }));
    await server.ready;
    const addr = server.httpServer.address();
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    await new Promise((resolve) => ws.on('open', resolve));
    const received = [];
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));

    try {
      // Simulate the boot greeting firing — call it directly instead of
      // waiting out the real 2.5s post-connection timer. No targetWs ->
      // broadcastAll, which reaches our connected client same as production.
      await server._internal.deliverBootGreeting();
      await waitForMessages(received, (m) => m.type === 'proactive-speech', 2000);
      assert.equal(received.filter((m) => m.type === 'proactive-speech').length, 1,
        'the boot greeting itself must produce exactly one proactive-speech');

      // The actual BUG-112 scenario: the daily planner's own morning brief
      // tries to speak seconds later. Before the fix, bus.subscribe
      // ('plan.morning-brief') called proactiveSpeak(e.payload.text) directly
      // with no dedup check whatsoever, so this always produced a second
      // greeting-shaped utterance.
      bus.emit('plan.morning-brief', { text: 'Good morning. Your top goal today is the quarterly report.' });
      await new Promise((resolve) => setTimeout(resolve, 300));

      const proactiveMsgs = received.filter((m) => m.type === 'proactive-speech');
      assert.equal(proactiveMsgs.length, 1,
        'the morning brief must be suppressed by the shared greeting dedup, not spoken as a second ' +
        'greeting (got ' + proactiveMsgs.length + ' proactive-speech messages)');
      assert.equal(
        proactiveMsgs.some((m) => m.text && m.text.indexOf('quarterly report') !== -1),
        false,
        'the suppressed morning-brief text must never have reached the client'
      );
    } finally {
      ws.close();
      await server.stop();
    }
  });

  it('a plan.morning-brief with no prior boot greeting still speaks normally (dedup does not silence the first greeting-shaped event)', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus, {}));
    await server.ready;
    const addr = server.httpServer.address();
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    await new Promise((resolve) => ws.on('open', resolve));
    const received = [];
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));

    try {
      bus.emit('plan.morning-brief', { text: 'Good morning. Focus on the report today.' });
      await waitForMessages(received, (m) => m.type === 'proactive-speech', 2000);

      assert.equal(received.filter((m) => m.type === 'proactive-speech').length, 1,
        'a morning brief with nothing announced yet must still be spoken');
    } finally {
      ws.close();
      await server.stop();
    }
  });

  // BUG-112 residual, found 2026-08-05. The morning brief was routed through
  // the shared key, but gmail.unread-batch — the other greeting-shaped source —
  // still called proactiveSpeak() with no dedup at all. The boot greeting
  // already reads unread mail into its own opening line, so the sensor's batch
  // arriving seconds later produced the same duplicate shape BUG-112 closed.
  it('a gmail.unread-batch firing right after the boot greeting is suppressed too', async () => {
    const bus = createBus({ historySize: 50 });
    const brain = { think: async () => ({ content: 'Good evening, sir. MYTHOS online.', offline: false }) };
    const server = createServer(baseDeps(bus, { brain }));
    await server.ready;
    const addr = server.httpServer.address();
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    await new Promise((resolve) => ws.on('open', resolve));
    const received = [];
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));

    try {
      await server._internal.deliverBootGreeting();
      await waitForMessages(received, (m) => m.type === 'proactive-speech', 2000);

      bus.emit('gmail.unread-batch', { count: 3, messages: [{ subject: 'Invoice overdue' }] });
      await new Promise((resolve) => setTimeout(resolve, 300));

      const proactiveMsgs = received.filter((m) => m.type === 'proactive-speech');
      assert.equal(proactiveMsgs.length, 1,
        'one utterance total — the email summary must not be a second greeting-shaped announcement');
      assert.equal(
        proactiveMsgs.some((m) => m.text && m.text.indexOf('Invoice overdue') !== -1),
        false,
        'the suppressed email summary must never have reached the client'
      );
    } finally {
      ws.close();
      await server.stop();
    }
  });

  it('a gmail.unread-batch with no prior greeting still speaks — the mail itself is not silenced', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus, {}));
    await server.ready;
    const addr = server.httpServer.address();
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    await new Promise((resolve) => ws.on('open', resolve));
    const received = [];
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));

    try {
      bus.emit('gmail.unread-batch', { count: 2, messages: [{ subject: 'Standup notes' }] });
      await waitForMessages(received, (m) => m.type === 'proactive-speech', 2000);

      const proactiveMsgs = received.filter((m) => m.type === 'proactive-speech');
      assert.equal(proactiveMsgs.length, 1, 'unread mail with nothing announced yet must still be spoken');
      assert.match(proactiveMsgs[0].text, /2 new emails/);
    } finally {
      ws.close();
      await server.stop();
    }
  });

  it('reminder.due is NOT gated by the greeting key — a different class of speech', async () => {
    // The dedup exists to stop duplicate GREETINGS. A due reminder landing
    // inside the same five-minute window is legitimate speech and must survive.
    const bus = createBus({ historySize: 50 });
    const brain = { think: async () => ({ content: 'Good evening, sir. MYTHOS online.', offline: false }) };
    const server = createServer(baseDeps(bus, { brain }));
    await server.ready;
    const addr = server.httpServer.address();
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    await new Promise((resolve) => ws.on('open', resolve));
    const received = [];
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));

    try {
      await server._internal.deliverBootGreeting();
      await waitForMessages(received, (m) => m.type === 'proactive-speech', 2000);

      bus.emit('reminder.due', { text: 'Stand-up in five minutes' });
      await waitForMessages(received,
        (m) => m.type === 'proactive-speech' && /Stand-up/.test(m.text || ''), 2000);

      assert.equal(
        received.some((m) => m.type === 'proactive-speech' && /Stand-up/.test(m.text || '')),
        true,
        'gating this would make MYTHOS miss real reminders — over-correction, not a fix'
      );
    } finally {
      ws.close();
      await server.stop();
    }
  });
});
