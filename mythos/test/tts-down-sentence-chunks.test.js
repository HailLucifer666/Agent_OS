'use strict';

// tts-down-sentence-chunks.test.js — when edge-tts is DOWN, the reply must still
// be delivered as per-sentence chunks so the browser speaks it one sentence at a
// time. Sending the whole reply as a single utterance is what truncates it.
//
// REPORTED BY THE OPERATOR 2026-07-31 and logged by the entity itself as an
// incident: "User reports that my speech is consistently being cut off at the
// end, losing the last one or two words."
//
// Diagnosis, from that session's real data rather than a guess:
//   * The reply TEXT was never truncated. All 29 replies in vault/Episodic for
//     that session round-trip through splitSentences() losslessly, and the
//     longest was 628 chars against an 800-char cap — nothing hit a limit.
//   * The session ran 23:22-00:33; edge_tts was not installed until 04:01. So
//     edge-tts was DOWN for every single turn, ttsUp was false, and the client
//     took the browser speechSynthesis fallback.
//   * sendSpokenReply() computed `ttsUp ? splitSentences(speak) : []`, so with
//     TTS down it sent ZERO speech-chunks and `chunked:false`. The client then
//     spoke the entire reply as ONE SpeechSynthesisUtterance — and Chrome
//     truncates long utterances, which is exactly the reported symptom.
//
// The fix makes the code match the comment that was already sitting above it:
// "If edge-tts is down, chunks are sent with audioB64:null and the client falls
// back to browser speechSynthesis exactly as before." The client side already
// supported this — playNextChunk() has an `else speakChunkFallback(chunk.text)`
// branch for text-only chunks that nothing ever fed.
//
// Harness copied from test/barge-in-tts-cancel.test.js: edge-tts is a
// module-level singleton required directly by server/index.js, so it is
// monkey-patched for the test's duration and restored after.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const path = require('path');
const { createBus } = require('../src/core/bus');
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
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
  }, overrides || {});
}

// Three real sentences, each comfortably over MIN_CHUNK_CHARS so splitSentences
// keeps them separate rather than grouping them.
const REPLY = 'Sentence number one is right here for the test to use. '
  + 'Sentence number two follows right after that one. '
  + 'Sentence number three wraps this whole thing up nicely.';

function depsForReply(bus, reply) {
  return baseDeps(bus, {
    memory: {
      working: { tick: 0, activeGoalId: null },
      fs: fakeFs(),
      episodic: { write: async () => ({ ref: 'ep-1' }), recall: () => [] },
      semantic: { recall: () => [] },
      recallHybrid: async () => [],
    },
    brain: {
      think: async () => ({
        content: JSON.stringify({ say: reply, actions: [], needs_result: false }),
        parsed: { say: reply, actions: [], needs_result: false },
        offline: false,
      }),
    },
    leash: {
      check: () => ({ allow: true, tier: 0, requireConfirm: false }),
      confirm: { create: () => 'cf-1', accept: () => null, reject: () => true },
    },
  });
}

async function runTurn(reply) {
  const bus = createBus({ historySize: 50 });
  const server = createServer(depsForReply(bus, reply));
  await server.ready;
  const addr = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  const chunks = [];
  const done = new Promise((resolve) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'speech-chunk') chunks.push(msg);
      if (msg.type === 'done') resolve(msg);
    });
  });
  ws.send(JSON.stringify({ type: 'utterance', reqId: 'r1', text: 'say something' }));
  const doneMsg = await done;
  ws.close();
  await server.stop();
  return { chunks, doneMsg };
}

test('edge-tts DOWN: the reply still arrives as per-sentence chunks, audio-less', async () => {
  const originalIsAvailable = edgeTts.isAvailable;
  const originalSynthesize = edgeTts.synthesize;
  let synthCalls = 0;
  edgeTts.isAvailable = async () => false;
  edgeTts.synthesize = async () => { synthCalls++; throw new Error('must not be called when TTS is down'); };

  try {
    const { chunks, doneMsg } = await runTurn(REPLY);

    assert.ok(chunks.length >= 3,
      'with TTS down the reply must still be split per sentence so the browser speaks it '
      + 'one at a time — got ' + chunks.length + ' chunks. A single long utterance is what Chrome truncates.');
    assert.equal(synthCalls, 0, 'synthesize() must never be called while edge-tts is unavailable');

    for (const c of chunks) {
      assert.equal(c.audioB64, null, 'a TTS-down chunk carries text only, never fabricated audio');
      assert.ok(c.text && c.text.trim().length > 0, 'every chunk must carry speakable text');
      assert.equal(c.total, chunks.length, 'total must match the number of chunks actually sent');
    }

    // The client keys its finish logic off index === total - 1.
    assert.deepEqual(chunks.map((c) => c.index), chunks.map((_, i) => i), 'indices must be dense and ordered');

    assert.equal(doneMsg.chunked, true,
      'done.chunked must be true so the client drains the chunk queue instead of '
      + 'speaking the whole reply again through the non-chunked fallback');

    // No text may be lost: the chunks must reconstitute the spoken reply.
    const rejoined = chunks.map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim();
    assert.equal(rejoined, REPLY.replace(/\s+/g, ' ').trim(), 'chunking must be lossless');
  } finally {
    edgeTts.isAvailable = originalIsAvailable;
    edgeTts.synthesize = originalSynthesize;
  }
});

test('edge-tts UP: unchanged — chunks still carry real audio', async () => {
  const originalIsAvailable = edgeTts.isAvailable;
  const originalSynthesize = edgeTts.synthesize;
  edgeTts.isAvailable = async () => true;
  edgeTts.synthesize = async () => Buffer.from('fake-audio-bytes');

  try {
    const { chunks, doneMsg } = await runTurn(REPLY);
    assert.ok(chunks.length >= 3);
    assert.equal(doneMsg.chunked, true);
    for (const c of chunks) {
      assert.ok(typeof c.audioB64 === 'string' && c.audioB64.length > 0,
        'the healthy path must still ship real audio — this fix must not regress it');
    }
  } finally {
    edgeTts.isAvailable = originalIsAvailable;
    edgeTts.synthesize = originalSynthesize;
  }
});

test('a single short sentence still produces one chunk, not zero', async () => {
  const originalIsAvailable = edgeTts.isAvailable;
  edgeTts.isAvailable = async () => false;
  try {
    const { chunks, doneMsg } = await runTurn('Understood.');
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].text, 'Understood.');
    assert.equal(doneMsg.chunked, true);
  } finally {
    edgeTts.isAvailable = originalIsAvailable;
  }
});
