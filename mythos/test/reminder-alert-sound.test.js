'use strict';

// test/reminder-alert-sound.test.js — Task 5, alarms/timers with an audible
// alert. Proves the real server wiring: a 'reminder.due' bus event carrying
// alertSound:true causes proactiveSpeak() to send the bundled alert tone as
// a real speech-chunk (mime:'audio/wav', non-empty audioB64) ahead of the
// spoken reminder text, on the SAME reqId — and that a plain reminder
// (alertSound:false/absent) never sends that chunk. Reuses
// test/rag-hybrid-recall-wiring.test.js's real-bus/real-server/real-ws
// harness pattern (seam bugs are invisible to fakes).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const path = require('path');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

function fakeFs() {
  return {
    vaultPath: (...segments) => path.join('/test-vault', ...segments),
    readJSON: () => null,
    writeJSON: () => {},
  };
}

function baseDeps(bus, overrides) {
  return Object.assign({
    bus,
    config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000 },
    logger: { info() {}, warn() {}, error() {} },
    memory: { working: { tick: 0, activeGoalId: null }, episodic: { write: async () => ({}) }, fs: fakeFs() },
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

async function collectReminderMessages(bus, payload) {
  const server = createServer(baseDeps(bus));
  await server.ready;
  const addr = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  const messages = [];
  const done = new Promise((resolve) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      messages.push(msg);
      if (msg.type === 'done' && msg.proactive) resolve();
    });
  });

  bus.emit('reminder.due', payload);
  await done;

  ws.close();
  await server.stop();
  return messages;
}

test('reminder.due with alertSound:true sends the bundled alert tone as a real speech-chunk before done', async () => {
  const bus = createBus({ historySize: 50 });
  const messages = await collectReminderMessages(bus, { id: 'rem-1', text: 'stretch break', alertSound: true });

  const chunks = messages.filter((m) => m.type === 'speech-chunk');
  assert.ok(chunks.length >= 1, 'expected at least one speech-chunk (the alert tone)');
  const alertChunk = chunks[0];
  assert.equal(alertChunk.index, 0);
  assert.equal(alertChunk.mime, 'audio/wav');
  assert.ok(typeof alertChunk.audioB64 === 'string' && alertChunk.audioB64.length > 100, 'alert chunk must carry real audio bytes');
  // Decode and confirm it is a real WAV (RIFF/WAVE magic), not a placeholder string.
  const bytes = Buffer.from(alertChunk.audioB64, 'base64');
  assert.equal(bytes.slice(0, 4).toString('ascii'), 'RIFF');
  assert.equal(bytes.slice(8, 12).toString('ascii'), 'WAVE');

  const doneMsg = messages.find((m) => m.type === 'done');
  assert.ok(doneMsg, 'expected a done message');
  assert.equal(doneMsg.chunked, true, 'done.chunked must be true so the client uses the chunk queue, not speechSynthesis');
  assert.match(doneMsg.say, /stretch break/);
});

test('a plain reminder (alertSound false/absent) never sends the alert-tone chunk', async () => {
  const bus = createBus({ historySize: 50 });
  const messages = await collectReminderMessages(bus, { id: 'rem-2', text: 'call mom' });

  const alertChunks = messages.filter((m) => m.type === 'speech-chunk' && m.mime === 'audio/wav');
  assert.equal(alertChunks.length, 0, 'a plain reminder must never emit the alert-tone chunk');

  const doneMsg = messages.find((m) => m.type === 'done');
  assert.ok(doneMsg);
  assert.match(doneMsg.say, /call mom/);
});
