'use strict';

// barge-in-tts-cancel.test.js — Item B (barge-in stretch, Phase-1 follow-up).
//
// Phase-1's barge-in fix stops audible playback client-side immediately
// (stopSpeaking()), but server-side TTS synthesis of not-yet-sent chunks kept
// running in the background — wasted edge-tts calls for audio nobody would
// ever hear. The WS inbound 'stop' handler was a documented no-op stub.
//
// Fix: sendSpokenReply() (and proactiveSpeak(), same pattern) now registers
// an AbortController per reqId in a server-wide `inflightSpeech` map; the WS
// 'stop' handler looks it up by reqId and calls .abort(). This test proves
// that once the client sends {type:'stop', reqId}, no further chunk
// synthesis calls happen for that turn.
//
// Harness: test/server.test.js's real-bus/real-server/real-ws pattern.
// edge-tts is a module-level singleton required directly by server/index.js
// (not injected via deps), so this monkey-patches it for the test's duration
// and restores it after — same pattern as test/server.test.js's BUG-004 test.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const path = require('path');
const { createServer } = require('../server');
const edgeTts = require('../providers/edge-tts');

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

test('WS "stop" aborts sendSpokenReply mid-turn — no chunk synthesis after abort (Item B)', async () => {
  const bus = createBus({ historySize: 50 });

  const synthCalls = [];
  const originalIsAvailable = edgeTts.isAvailable;
  const originalSynthesize = edgeTts.synthesize;
  edgeTts.isAvailable = async () => true;
  edgeTts.synthesize = async ({ text }) => {
    synthCalls.push(text);
    await new Promise((resolve) => setTimeout(resolve, 150)); // slow provider — leaves a window to barge in
    return Buffer.from('fake-audio-bytes');
  };

  const longReply = 'Sentence number one is right here for the test to use. '
    + 'Sentence number two follows right after that one. '
    + 'Sentence number three wraps this whole thing up nicely.';

  const fakeMemory = {
    working: { tick: 0, activeGoalId: null },
    fs: fakeFs(),
    episodic: { write: async () => ({ ref: 'ep-1' }), recall: () => [] },
    semantic: { recall: () => [] },
    recallHybrid: async () => [],
  };
  const fakeBrain = {
    think: async () => ({
      content: JSON.stringify({ say: longReply, actions: [], needs_result: false }),
      parsed: { say: longReply, actions: [], needs_result: false },
      offline: false,
    }),
  };
  const fakeLeash = {
    check: () => ({ allow: true, tier: 0, requireConfirm: false }),
    confirm: { create: () => 'cf-1', accept: () => null, reject: () => true },
  };

  const server = createServer(baseDeps(bus, { memory: fakeMemory, brain: fakeBrain, leash: fakeLeash }));

  try {
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

    ws.send(JSON.stringify({ type: 'utterance', reqId: 'r1', text: 'tell me something long' }));
    // Chunk 0's synthesize() call is 150ms — this fires well inside that
    // window, while it's still in flight, simulating a barge-in.
    await new Promise((resolve) => setTimeout(resolve, 60));
    ws.send(JSON.stringify({ type: 'stop', reqId: 'r1' }));

    const reply = await done;
    assert.equal(reply.chunked, true, "aborted turn's done still routes through the client's chunked/session-checked path");

    // Give any straggler (already in-flight when abort fired) time to settle,
    // then confirm no further synthesize calls ever happened.
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(synthCalls.length, 1, 'only the chunk already in flight when stop arrived should have synthesized; the remaining sentences must never call synthesize');

    ws.close();
  } finally {
    edgeTts.isAvailable = originalIsAvailable;
    edgeTts.synthesize = originalSynthesize;
    await server.stop();
  }
});

test('WS "stop" for an unknown/already-finished reqId is a harmless no-op', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus));

  await server.ready;
  const addr = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  // Must not throw, crash the connection, or emit any reply.
  ws.send(JSON.stringify({ type: 'stop', reqId: 'never-existed' }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(ws.readyState, WebSocket.OPEN, 'connection stays healthy after a stop for an unknown reqId');

  ws.close();
  await server.stop();
});
