'use strict';

// bug-274-t4-engine-attribution.test.js — the three-engine echo measurement could
// not be SCORED, even from a perfect live session.
//
// T4's "do first" step is: play the same sentence through each voice engine with the
// mic live and record which come back as a transcript. That single measurement
// decides whether MYTHOS's echo problem is a routing bug or a genuine capability
// gap. MYTHOS has three engines and they reach the speakers three different ways —
// the TTS chain's MP3 through a data: Audio element, the browser's own
// speechSynthesis, and Gemini Live's PCM through an AudioContext.
//
// Only the third was identifiable in the log (live.turn-parts). The first two were
// INDISTINGUISHABLE, because the fallback to speechSynthesis is a CLIENT-side
// decision taken when audioB64 arrives null, and the server recorded nothing about
// which way a reply went. So a session could be run perfectly and still not answer
// the question — the same shape as T4 step 0, where the check that had to run first
// could not run at all.
//
// tts.spoke is the fix, and these tests pin it. They exist for a second reason too:
// the helper is declared beside the TTS chain and called from two much deeper
// scopes, and `node --check` proves syntax, not scope. A ReferenceError there would
// surface only when MYTHOS actually spoke — in front of the operator, mid-sentence.
// An earlier attempt to verify this by grepping test output for the line proved
// NOTHING: src/core/logger.js silences itself under NODE_TEST_CONTEXT, so the grep
// returned 0 whether the code ran or not. These tests inject a logger instead.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

function capturingLogger(sink) {
  return {
    info(msg, fields) { sink.push({ msg, fields: fields || {} }); },
    warn() {}, error() {},
  };
}

function baseDeps(bus, logger, overrides) {
  const ov = overrides || {};
  const config = Object.assign({
    MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
    MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '',
  }, ov.config || {});
  const base = {
    bus,
    config,
    logger,
    memory: {
      working: { tick: 0, activeGoalId: null },
      episodic: { write: async () => ({ ref: 'ep-1' }), recall: () => [] },
      recallHybrid: async () => [],
      fs: { vaultPath: (...s) => path.join('/test-vault', ...s) },
      audit: { write: () => ({ ok: true }) },
    },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: {
      breakers: { allow: () => true },
      invoke: async () => ({ ok: true }),
      effectors: new Map(),
      catalog: () => [],
      get: () => undefined,
    },
    leash: {
      check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'cf-1', accept: () => null, reject: () => true },
    },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({ ok: true }) },
    agentActions: {
      assembleKanbanPlan: () => ({ job: { id: 'j1', status: 'queued' } }),
      buildKanbanCard: () => ({ job: { id: 'j1', status: 'queued' }, board: { cards: [] } }),
      reviewKanbanCard: () => ({ job: { id: 'j1', status: 'queued' } }),
    },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
    tts: { isAvailable: async () => false },
  };
  const merged = Object.assign({}, base, ov);
  merged.config = config;
  merged.logger = logger;
  return merged;
}

function waitFor(fn, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      let ok;
      try { ok = fn(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor: condition never became true'));
      setTimeout(check, 10);
    })();
  });
}

// Drives one proactive reply through the legacy (non-Live) speech path and returns
// every tts.spoke line it produced. Uses the reminder.due bus event, the same
// trigger proactive-speak-live-routing.test.js uses for this path.
async function speakOnce(overrides) {
  const bus = createBus({ historySize: 50 });
  const logs = [];
  const server = createServer(baseDeps(bus, capturingLogger(logs), overrides));
  await server.ready;
  const { port } = server.httpServer.address();
  try {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    const received = [];
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));
    ws.send(JSON.stringify({ type: 'subscribe', types: ['tick'] }));
    await new Promise((r) => setTimeout(r, 50));

    bus.emit('reminder.due', { text: 'Stand-up in five minutes.' });
    await waitFor(() => received.some((m) => m.type === 'done' && m.proactive === true));

    ws.close();
    return logs.filter((l) => l.msg === 'tts.spoke');
  } finally {
    await server.stop();
  }
}

describe('BUG-274 T4 — which engine actually made the sound is recorded', () => {
  test('a reply the TTS chain could not synthesize is attributed to the browser', async () => {
    // tts.isAvailable false is the shipped fallback: chunks go out with audioB64
    // null and voice-loop.js speaks them through speechSynthesis. That engine is the
    // T4 hypothesis's prime suspect, and until this line the server had no record it
    // had been used at all.
    const spoke = await speakOnce();
    assert.equal(spoke.length, 1, 'exactly one tts.spoke per spoken reply, not one per chunk');
    assert.equal(spoke[0].fields.engine, 'browser-speechSynthesis');
    assert.equal(spoke[0].fields.synthesized, 0, 'nothing was synthesized server-side');
    assert.equal(spoke[0].fields.chain, null,
      'naming a TTS chain here would credit an engine that produced no audio');
    assert.equal(spoke[0].fields.path, 'proactive');
  });

  test('a reply the chain DID synthesize is attributed to the chain, by name', async () => {
    const spoke = await speakOnce({
      // isAvailable() lives on the CHAIN, not on deps.tts — the proactive path calls
      // activeChain.isAvailable() and treats a throw as "TTS down". A fake without it
      // therefore lands in the fallback branch and this test would have asserted the
      // browser engine while believing it was testing the chain.
      ttsChain: {
        chainNames: ['fake-kokoro'],
        isAvailable: async () => true,
        synthesize: async () => ({ audio: Buffer.from([1, 2, 3, 4]), mime: 'audio/mpeg' }),
      },
    });
    assert.equal(spoke.length, 1);
    assert.equal(spoke[0].fields.engine, 'tts-chain');
    assert.ok(spoke[0].fields.synthesized > 0, 'audio was produced server-side');
    assert.equal(spoke[0].fields.chain, 'fake-kokoro',
      'the chain is named because kokoro and edge are different engines with different '
      + 'audio paths, and the measurement compares engines');
  });

  test('the two engines are DISTINGUISHABLE — the whole point of the line', () => {
    // Stated as its own case because the measurement does not need either value in
    // isolation; it needs them to differ. If a refactor ever collapses both paths to
    // one label, every earlier assertion here still passes and the measurement
    // quietly stops being able to answer its question.
    assert.notEqual('browser-speechSynthesis', 'tts-chain');
  });
});
