'use strict';

// REMEDIATION P0-3 (2026-07-29 audit, item 10 — audio isolation).
// Council verdict (Torvalds/Feynman/Musashi, unanimous, 3/3): STT
// transcribing Spotify lyrics as operator commands is a state-coordination
// bug ("mic hot while speakers hot"), not a signal-processing one. AEC and
// speaker verification were both rejected as solving problems this
// single-user desktop assistant doesn't have. The fix: duck (lower) system
// volume for exactly the VAD-confirmed recording window using the real
// Windows master-volume API (get_volume/set_volume, item 4), restore it
// when the window closes.
//
// Real server + real WS client (server.test.js's own pattern) — a fake
// effectors hub stands in for get_volume/set_volume so this test proves the
// WS wiring end-to-end without needing real Windows Core Audio.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const path = require('path');
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
    leash: { confirm: { create: () => 'cf-1', accept: () => null, reject: () => true } },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({}) },
    agentActions: {},
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
  }, overrides || {});
}

function makeVolumeEffectors(startingLevel) {
  let level = startingLevel;
  const calls = [];
  return {
    calls,
    effectors: {
      breakers: new Map(),
      effectors: new Map(),
      invoke: async (tool, args) => {
        calls.push({ tool, args });
        if (tool === 'get_volume') return { ok: true, result: { level, muted: false } };
        if (tool === 'set_volume') { level = args.level; return { ok: true, result: { level } }; }
        return { ok: false, result: 'unknown tool' };
      },
    },
    getLevel: () => level,
  };
}

test('duck-audio lowers volume and unduck-audio restores the ORIGINAL level', async () => {
  const bus = createBus({ historySize: 50 });
  const vol = makeVolumeEffectors(80);
  const server = createServer(baseDeps(bus, { effectors: vol.effectors }));

  await server.ready;
  const addr = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  ws.send(JSON.stringify({ type: 'duck-audio' }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(vol.getLevel(), 15, 'volume must be ducked to the low level');

  ws.send(JSON.stringify({ type: 'unduck-audio' }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(vol.getLevel(), 80, 'volume must be restored to the ORIGINAL pre-duck level, not a hardcoded default');

  ws.close();
  await server.stop();
});

test('a second duck (e.g. barge-in re-arming) does not overwrite the real original level', async () => {
  const bus = createBus({ historySize: 50 });
  const vol = makeVolumeEffectors(60);
  const server = createServer(baseDeps(bus, { effectors: vol.effectors }));

  await server.ready;
  const addr = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  ws.send(JSON.stringify({ type: 'duck-audio' }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  ws.send(JSON.stringify({ type: 'duck-audio' })); // second duck while already ducked
  await new Promise((resolve) => setTimeout(resolve, 60));
  ws.send(JSON.stringify({ type: 'unduck-audio' }));
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(vol.getLevel(), 60, 'restoring must use the ORIGINAL 60, not the ducked 15 a naive re-save would have captured');
  // get_volume should only have been called once (the first duck) — the
  // second duck must be a no-op, confirmed by call count.
  const getVolumeCalls = vol.calls.filter((c) => c.tool === 'get_volume').length;
  assert.equal(getVolumeCalls, 1, 'a second duck while already ducked must not re-read/re-save volume');

  ws.close();
  await server.stop();
});

test('unduck with nothing ducked is a harmless no-op (does not call set_volume)', async () => {
  const bus = createBus({ historySize: 50 });
  const vol = makeVolumeEffectors(50);
  const server = createServer(baseDeps(bus, { effectors: vol.effectors }));

  await server.ready;
  const addr = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  ws.send(JSON.stringify({ type: 'unduck-audio' }));
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(vol.calls.length, 0, 'an unduck with no prior duck must not touch volume at all');

  ws.close();
  await server.stop();
});

test('duck-audio degrades silently when get_volume fails (PC automation offline)', async () => {
  const bus = createBus({ historySize: 50 });
  const effectors = {
    breakers: new Map(), effectors: new Map(),
    invoke: async (tool) => (tool === 'get_volume' ? { ok: false, result: 'PC automation is OFFLINE' } : { ok: false, result: 'n/a' }),
  };
  const server = createServer(baseDeps(bus, { effectors }));

  await server.ready;
  const addr = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  // Must not throw / crash the connection.
  ws.send(JSON.stringify({ type: 'duck-audio' }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(ws.readyState, WebSocket.OPEN, 'a failed duck must not break the WS connection');

  ws.close();
  await server.stop();
});
