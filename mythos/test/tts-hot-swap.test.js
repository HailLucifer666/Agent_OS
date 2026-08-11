'use strict';

// tts-hot-swap.test.js — a voice picked in the HUD reaches the NEXT reply, and
// never the middle of the current one.
//
// THE OPERATOR'S ASK (2026-08-11): choose a voice and hear it without restarting.
// The chain object in providers/tts.js parses VOICE_TTS_CHAIN once at
// construction and cannot be re-pointed, so "apply immediately" is implemented as
// "build a new chain and hand it to whoever asks next" (currentTts/setTtsChain in
// server/index.js).
//
// That leaves exactly one way to get it wrong, and it is audible: re-reading the
// holder PER CHUNK instead of per turn. The entity would then change voice
// mid-sentence — the precise failure providers/tts.js's sticky resolve exists to
// prevent (the entity used to greet as a British man and answer as a woman). So
// the load-bearing case here is the mid-reply swap: the POST lands while turn 1
// is paused between chunks, and every chunk of turn 1 must still come from the
// old chain.
//
// Harness copied from test/tts-down-sentence-chunks.test.js.
//
// Run: cd mythos && node --test test/tts-hot-swap.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');
const edgeTts = require('../providers/edge-tts');

const REPLY = 'Sentence number one is right here for the test to use. '
  + 'Sentence number two follows right after that one. '
  + 'Sentence number three wraps this whole thing up nicely.';

function fakeFs() {
  return { vaultPath: (...segments) => path.join('/test-vault', ...segments) };
}

// A chain object shaped like createTtsChain's return, emitting a marker payload
// so every chunk can be traced back to the chain that produced it.
function markerChain(marker, opts = {}) {
  const chain = {
    synthCalls: 0,
    async isAvailable() { return true; },
    async resolve() { return null; },
    async synthesize({ text }) {
      chain.synthCalls++;
      if (opts.gate && chain.synthCalls === 1) await opts.gate;
      return { audio: Buffer.from(marker), mime: 'audio/wav', provider: marker };
    },
    get name() { return marker; },
    get mime() { return 'audio/wav'; },
    chainNames: [marker],
  };
  return chain;
}

function depsFor(bus, vault, ttsChain) {
  return {
    bus,
    ttsChain,
    config: {
      MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3,
      ACTION_TIMEOUT_MS: 30000, MYTHOS_VAULT_ROOT: vault,
      // The rebuilt chain must not reach for a model download in a test: pin it
      // to edge, whose module is monkey-patched below.
      VOICE_TTS_CHAIN: 'edge', VOICE_TTS_VOICE: 'en-US-AvaNeural',
    },
    logger: { info() {}, warn() {}, error() {} },
    memory: {
      working: { tick: 0, activeGoalId: null },
      fs: fakeFs(),
      episodic: { write: async () => ({ ref: 'ep-1' }), recall: () => [] },
      semantic: { recall: () => [] },
      recallHybrid: async () => [],
    },
    brain: {
      think: async () => ({
        content: JSON.stringify({ say: REPLY, actions: [], needs_result: false }),
        parsed: { say: REPLY, actions: [], needs_result: false },
        offline: false,
      }),
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
  };
}

function collectTurn(ws, reqId) {
  const chunks = [];
  return new Promise((resolve) => {
    const onMessage = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.reqId !== reqId) return;
      if (msg.type === 'speech-chunk') chunks.push(msg);
      if (msg.type === 'done') { ws.off('message', onMessage); resolve(chunks); }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: 'utterance', reqId, text: 'say something' }));
  });
}

function markersOf(chunks) {
  return [...new Set(chunks.filter((c) => c.audioB64).map((c) => Buffer.from(c.audioB64, 'base64').toString()))];
}

test('a voice picked mid-reply lands on the NEXT reply, never inside this one', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-hotswap-'));
  const originalIsAvailable = edgeTts.isAvailable;
  const originalSynthesize = edgeTts.synthesize;
  const originalListVoices = edgeTts.listVoices;
  // The chain the POST rebuilds is a REAL createTtsChain over these stubs.
  edgeTts.isAvailable = async () => true;
  edgeTts.synthesize = async () => Buffer.from('NEW-CHAIN');
  edgeTts.listVoices = async () => ['en-US-AvaNeural'];

  let releaseGate;
  const gate = new Promise((r) => { releaseGate = r; });
  const bus = createBus({ historySize: 50 });
  const server = createServer(depsFor(bus, vault, markerChain('OLD-CHAIN', { gate })));
  await server.ready;
  const { port } = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  try {
    // Turn 1 starts and blocks inside its FIRST chunk's synthesis.
    const turn1 = collectTurn(ws, 'r1');

    // The operator picks a voice while that reply is still streaming.
    const res = await fetch(`http://127.0.0.1:${port}/api/tts/voice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'edge-tts', voice: 'en-US-AvaNeural' }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.applied, true, 'the chain must be rebuilt, not merely stored');

    releaseGate();
    const chunks1 = await turn1;
    assert.ok(chunks1.length >= 3, 'expected a chunked reply, got ' + chunks1.length);
    assert.deepEqual(markersOf(chunks1), ['OLD-CHAIN'],
      'every chunk of a reply already in flight must come from the chain it started on — '
      + 'a swap landing mid-reply would change the voice mid-sentence');

    // Turn 2 is the "immediately, no restart" half of the promise.
    const chunks2 = await collectTurn(ws, 'r2');
    assert.deepEqual(markersOf(chunks2), ['NEW-CHAIN'],
      'the next reply must already use the newly picked voice, with no server restart');
  } finally {
    ws.close();
    await server.stop();
    edgeTts.isAvailable = originalIsAvailable;
    edgeTts.synthesize = originalSynthesize;
    edgeTts.listVoices = originalListVoices;
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('with no pick, every turn keeps using the chain the server booted with', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-hotswap-'));
  const bus = createBus({ historySize: 50 });
  const server = createServer(depsFor(bus, vault, markerChain('BOOT-CHAIN')));
  await server.ready;
  const { port } = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));
  try {
    assert.deepEqual(markersOf(await collectTurn(ws, 'r1')), ['BOOT-CHAIN']);
    assert.deepEqual(markersOf(await collectTurn(ws, 'r2')), ['BOOT-CHAIN'],
      'the injected chain seam must behave exactly as it did before it became swappable');
  } finally {
    ws.close();
    await server.stop();
    fs.rmSync(vault, { recursive: true, force: true });
  }
});
