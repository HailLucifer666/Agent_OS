'use strict';

// duck-hysteresis.test.js — the volume must stop ping-ponging.
//
// REPORTED BY THE OPERATOR 2026-08-11 against the installed 0.1.2 build: "it
// keeps telling me volume is set". Their audit log for that session holds 58
// set_volume + 29 get_volume calls, every one actor:'voice-ducking', none
// operator-driven. The mechanism is a self-cancelling loop, not a bad value:
// mic-hot ducks the system to 15% -> the room goes quiet -> the RMS VAD sees
// silence and stops recording -> unduck restores 100% -> the music that was
// playing immediately re-arms the mic -> duck again, roughly every two seconds.
// The entity filed its own incident calling it a "volume control feedback loop".
//
// Two bounds break it, and this file pins both:
//   * a minimum hold, so a duck cannot be undone the instant it lands
//   * a cooldown after restoring, so the media coming back up cannot re-duck
// with the constraint that a real utterance STILL gets its volume back — the
// deferred restore must fire, not be dropped.
//
// Run: cd mythos && node --test test/duck-hysteresis.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const path = require('path');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

const HOLD_MS = 150;
const COOLDOWN_MS = 250;

function fakeFs() {
  return { vaultPath: (...segments) => path.join('/test-vault', ...segments) };
}

// Records every volume call the ducking path makes, in order.
function volumeSpy() {
  const calls = [];
  return {
    calls,
    effectors: {
      breakers: new Map(),
      effectors: new Map(),
      invoke: async (tool, args) => {
        calls.push({ tool, level: args && args.level });
        if (tool === 'get_volume') return { ok: true, result: { level: 100, muted: false } };
        return { ok: true, result: { level: args && args.level } };
      },
    },
  };
}

function deps(bus, spy) {
  return {
    bus,
    config: {
      MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3,
      ACTION_TIMEOUT_MS: 30000,
    },
    logger: { info() {}, warn() {}, error() {} },
    memory: {
      working: { tick: 0, activeGoalId: null },
      fs: fakeFs(),
      episodic: { write: async () => ({ ref: 'ep-1' }), recall: () => [] },
      semantic: { recall: () => [] },
      audit: { write() {} },
      recallHybrid: async () => [],
    },
    effectors: spy.effectors,
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    leash: { check: () => ({ allow: true, tier: 0, requireConfirm: false }), confirm: { create: () => 'cf-1', accept: () => null, reject: () => true } },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({}) },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const bus = createBus({ historySize: 20 });
  const spy = volumeSpy();
  const server = createServer(deps(bus, spy));
  await server.ready;
  const ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));
  return {
    spy,
    duck: () => ws.send(JSON.stringify({ type: 'duck-audio' })),
    unduck: () => ws.send(JSON.stringify({ type: 'unduck-audio' })),
    // A real turn: this is the proof the mic-hot window heard a person. The
    // brain is absent in this harness, so the turn answers "offline" — which is
    // fine, the duck path only cares that an utterance arrived.
    utterance: (text) => ws.send(JSON.stringify({ type: 'utterance', reqId: 'u-' + Math.floor(performance.now()), text })),
    async close() { ws.close(); await server.stop(); },
  };
}

function setLevels(calls) {
  return calls.filter((c) => c.tool === 'set_volume').map((c) => c.level);
}

test('a duck/unduck storm with no speech backs off instead of ping-ponging', async () => {
  process.env.DUCK_MIN_HOLD_MS = String(HOLD_MS);
  process.env.DUCK_COOLDOWN_MS = String(COOLDOWN_MS);
  const c = await connect();
  try {
    // Twenty cycles at the rate the operator's log shows — the VAD arming on
    // music and dropping again as soon as the duck quiets it. Not one of these
    // windows produces an utterance, which is exactly what makes them false.
    for (let i = 0; i < 20; i++) {
      c.duck();
      await sleep(20);
      c.unduck();
      await sleep(20);
    }
    await sleep(HOLD_MS + 150);
    const levels = setLevels(c.spy.calls);
    const ducks = levels.filter((l) => l === 15).length;
    assert.ok(ducks <= 2,
      'after two windows with no speech, ducking must back off — the operator\'s session did this 58 times. '
      + 'got: ' + JSON.stringify(levels));
    assert.equal(levels[levels.length - 1], 100, 'the volume must be left restored, never stuck at the duck level');
  } finally {
    delete process.env.DUCK_MIN_HOLD_MS;
    delete process.env.DUCK_COOLDOWN_MS;
    await c.close();
  }
});

test('a window that DID produce speech never counts against the back-off', async () => {
  process.env.DUCK_MIN_HOLD_MS = String(HOLD_MS);
  process.env.DUCK_COOLDOWN_MS = String(COOLDOWN_MS);
  const c = await connect();
  try {
    // Three real turns: duck, speak, restore — repeatedly. Ducking must survive
    // this untouched, because every window carried an utterance.
    for (let i = 0; i < 3; i++) {
      c.duck();
      await sleep(30);
      c.utterance('hello there');
      await sleep(HOLD_MS + 40);
      c.unduck();
      await sleep(COOLDOWN_MS + 60);
    }
    const ducks = setLevels(c.spy.calls).filter((l) => l === 15).length;
    assert.equal(ducks, 3, 'a real conversation must keep getting its ducking — got ' + ducks);
  } finally {
    delete process.env.DUCK_MIN_HOLD_MS;
    delete process.env.DUCK_COOLDOWN_MS;
    await c.close();
  }
});

test('a short utterance still gets its volume back — the restore is deferred, never dropped', async () => {
  process.env.DUCK_MIN_HOLD_MS = String(HOLD_MS);
  process.env.DUCK_COOLDOWN_MS = String(COOLDOWN_MS);
  const c = await connect();
  try {
    c.duck();
    await sleep(20);
    c.unduck();                 // well inside the hold window
    await sleep(20);
    assert.deepEqual(setLevels(c.spy.calls), [15], 'not restored yet — the hold has not elapsed');
    await sleep(HOLD_MS + 120);
    assert.deepEqual(setLevels(c.spy.calls), [15, 100], 'the deferred restore must actually fire');
  } finally {
    delete process.env.DUCK_MIN_HOLD_MS;
    delete process.env.DUCK_COOLDOWN_MS;
    await c.close();
  }
});

test('after the cooldown a genuine second utterance ducks again', async () => {
  process.env.DUCK_MIN_HOLD_MS = String(HOLD_MS);
  process.env.DUCK_COOLDOWN_MS = String(COOLDOWN_MS);
  const c = await connect();
  try {
    c.duck();
    await sleep(HOLD_MS + 60);
    c.unduck();
    await sleep(COOLDOWN_MS + 80);   // the operator pauses, then speaks again
    c.duck();
    await sleep(60);
    assert.deepEqual(setLevels(c.spy.calls), [15, 100, 15],
      'hysteresis must not disable ducking — a real second turn still ducks');
  } finally {
    delete process.env.DUCK_MIN_HOLD_MS;
    delete process.env.DUCK_COOLDOWN_MS;
    await c.close();
  }
});
