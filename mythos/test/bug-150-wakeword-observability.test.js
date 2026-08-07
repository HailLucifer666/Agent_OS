'use strict';

// BUG-150 — "hey jarvis has never worked", and no log could say why.
//
// The wake word ran entirely in the browser and reported entirely into a
// transient HUD caption. Nothing — not whether it armed, not whether audio
// reached it, not what it scored — ever reached the server. So the operator's
// week of testing produced exactly zero diagnostic information, and every theory
// stayed a theory.
//
// Worse, `start()` returned true once the audio graph was WIRED, having never
// confirmed a single frame arrived. Every silent failure mode (suspended
// AudioContext, worklet never firing, mic delivering nothing) builds that graph
// without throwing, so all of them displayed "Standby — listening". That is the
// same defect class as BUG-137: reporting a success that was never proven.
//
// Measured headlessly after the fix (fake audio device, real HUD, real ONNX):
//   ctxState running / ctxStateAtStart running  <- the suspended-context theory,
//                                                  disproven rather than assumed
//   frames 63 per 5s                            <- exactly the expected 12.5/s
//   peakScore 4e-6 .. 1.7e-5                    <- classifier genuinely running
//
// Run: cd mythos && MYTHOS_PORT=4992 EDGE_TTS_PORT=5092 EDGE_TTS_URL=http://127.0.0.1:5092 \
//   node --test test/bug-150-wakeword-observability.test.js

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

function fakeFs() {
  return { vaultPath: (...s) => path.join('/test-vault', ...s) };
}

function baseDeps(bus, logger) {
  return {
    bus,
    config: {
      MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
      MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '',
    },
    logger,
    memory: {
      working: { tick: 0, activeGoalId: null },
      episodic: { write: async () => ({ ref: 'ep-1' }), recall: () => [] },
      recallHybrid: async () => [],
      fs: fakeFs(),
      audit: { write: () => ({ ok: true }) },
    },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: {
      breakers: { allow: () => true }, invoke: async () => ({ ok: true }),
      effectors: new Map(), catalog: () => [], get: () => undefined,
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
}

function capturingLogger() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push(Object.assign({ level, msg }, fields || {}));
  return { lines, info: rec('info'), warn: rec('warn'), error: rec('error') };
}

function waitFor(fn, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      let ok; try { ok = fn(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor: never true'));
      setTimeout(check, 10);
    })();
  });
}

describe('BUG-150: wake-word state reaches the server log', () => {
  test('a wakeword-status message is logged with its diagnostic numbers intact', async () => {
    const bus = createBus({ historySize: 50 });
    const logger = capturingLogger();
    const server = createServer(baseDeps(bus, logger));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

      ws.send(JSON.stringify({
        type: 'wakeword-status', state: 'metrics', detail: 'wake-word listening',
        peakScore: 0.42, scores: 61, frames: 63, framesTotal: 313,
        threshold: 0.5, ctxState: 'running', streamLive: true,
      }));
      await waitFor(() => logger.lines.some((l) => l.msg === 'wakeword.metrics'));

      const line = logger.lines.find((l) => l.msg === 'wakeword.metrics');
      // The three numbers that actually separate the causes must survive: a peak
      // without its threshold is meaningless, and frames-without-scores is the
      // signature of a structurally dead pipeline.
      assert.equal(line.peakScore, 0.42, 'the peak score must be logged');
      assert.equal(line.threshold, 0.5, 'the threshold must be logged beside it, or the peak cannot be judged');
      assert.equal(line.frames, 63, 'the frame count must be logged');
      assert.equal(line.scores, 61, 'the classifier-run count must be logged');
      assert.equal(line.ctxState, 'running', 'the AudioContext state must be logged');
      assert.equal(line.streamLive, true, 'mic-track liveness must be logged');

      ws.close();
    } finally { await server.stop(); }
  });

  test('the armed-but-deaf state warns rather than passing as ordinary info', async () => {
    const bus = createBus({ historySize: 50 });
    const logger = capturingLogger();
    const server = createServer(baseDeps(bus, logger));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

      ws.send(JSON.stringify({
        type: 'wakeword-status', state: 'silent',
        detail: 'armed but received no audio', ctxState: 'suspended', streamLive: false,
      }));
      await waitFor(() => logger.lines.some((l) => l.msg === 'wakeword.silent'));

      const line = logger.lines.find((l) => l.msg === 'wakeword.silent');
      assert.equal(line.level, 'warn',
        'a detector that armed but hears nothing is the headline failure — it must not sit at info level');
      assert.equal(line.ctxState, 'suspended');

      ws.close();
    } finally { await server.stop(); }
  });

  test('a suppressed detection is logged with its reason, so heard-but-ignored is distinguishable from never-heard', async () => {
    const bus = createBus({ historySize: 50 });
    const logger = capturingLogger();
    const server = createServer(baseDeps(bus, logger));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

      ws.send(JSON.stringify({
        type: 'wakeword-status', state: 'detected-suppressed',
        detail: 'wake word detected but not acted on', reason: 'pin-gate-closed', score: 0.81,
      }));
      await waitFor(() => logger.lines.some((l) => l.msg === 'wakeword.detected-suppressed'));

      const line = logger.lines.find((l) => l.msg === 'wakeword.detected-suppressed');
      assert.equal(line.reason, 'pin-gate-closed', 'the specific guard that swallowed it must be named');
      assert.equal(line.score, 0.81);

      ws.close();
    } finally { await server.stop(); }
  });

  test('an untrusted client cannot inflate the log with arbitrary keys or oversized strings', async () => {
    const bus = createBus({ historySize: 50 });
    const logger = capturingLogger();
    const server = createServer(baseDeps(bus, logger));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

      ws.send(JSON.stringify({
        type: 'wakeword-status', state: 'metrics',
        detail: 'x'.repeat(5000), injected: 'should-not-appear',
        peakScore: 'not-a-number', ctxState: 'y'.repeat(500),
      }));
      await waitFor(() => logger.lines.some((l) => l.msg === 'wakeword.metrics'));

      const line = logger.lines.find((l) => l.msg === 'wakeword.metrics');
      assert.equal(line.injected, undefined, 'unknown keys must not be copied into the log');
      assert.equal(line.peakScore, undefined, 'a non-numeric score must be dropped, not logged as a string');
      assert.ok(line.detail.length <= 300, 'detail must be truncated');
      assert.ok(line.ctxState.length <= 40, 'ctxState must be truncated');

      ws.close();
    } finally { await server.stop(); }
  });
});

// wakeword.js and app.js run in the browser and have no meaningful Node double
// (AudioContext, AudioWorklet, getUserMedia). Source-shape assertions are the
// only automated guard, per the root CLAUDE.md's Electron lesson and the
// precedent set by test/bug-147-orb-click-feedback.test.js.
describe('BUG-150: the detector proves liveness instead of asserting it', () => {
  const WW = fs.readFileSync(path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'wakeword.js'), 'utf8');
  const APP = fs.readFileSync(path.join(__dirname, '..', 'ui', 'public', 'js', 'app.js'), 'utf8');

  test('frames are counted in the port handler, BEFORE the running gate that would discard them', () => {
    const handlerIdx = WW.indexOf('workletNode.port.onmessage');
    assert.ok(handlerIdx !== -1, 'the worklet message handler must still exist');
    const handler = WW.slice(handlerIdx, handlerIdx + 700);
    assert.match(handler, /framesSeen\+\+/, 'the handler must count every frame');
    // onFrame() early-returns on !running, and running is set AFTER ensureAudio(),
    // so counting inside onFrame would miss exactly the frames start() waits for.
    const countIdx = handler.indexOf('framesSeen++');
    const callIdx = handler.indexOf('onFrame(');
    assert.ok(countIdx !== -1 && callIdx !== -1 && countIdx < callIdx,
      'the frame must be counted before onFrame() is called, since onFrame gates on `running`');
  });

  test('start() waits for a real frame and refuses to claim standby without one', () => {
    assert.match(WW, /FIRST_FRAME_TIMEOUT_MS/, 'there must be a bounded wait for the first frame');
    assert.match(WW, /waitForFirstFrame\(/, 'start() must actually wait for it');
    const startIdx = WW.indexOf('async function start()');
    const body = WW.slice(startIdx, WW.indexOf('function stop()', startIdx));
    assert.match(body, /if \(!gotAudio\)/, 'start() must branch on whether audio arrived');
    assert.match(body, /status\('silent'/, 'the no-audio case must report an honest status');
    const silentIdx = body.indexOf("status('silent'");
    const returnTrueIdx = body.lastIndexOf('return true');
    assert.ok(silentIdx !== -1 && silentIdx < returnTrueIdx,
      'the silent branch must return before the success path — otherwise it still claims to be listening');
  });

  test('the AudioContext state is read and resumed rather than assumed', () => {
    assert.match(WW, /ctxStateAtStart\s*=\s*audioCtx\.state/,
      'the context state must be MEASURED — this is what disproved the suspended-context theory');
    assert.match(WW, /audioCtx\.resume\(\)/, 'a suspended context must be resumed, as pcm-player.js already does');
    assert.match(WW, /addEventListener\('statechange'/,
      'a context suspended later (device change, sleep) must surface, not go quietly deaf');
  });

  test('the metrics report carries the threshold and the classifier-run count with the peak', () => {
    const idx = WW.indexOf('function reportMetrics()');
    assert.ok(idx !== -1, 'reportMetrics must exist');
    const body = WW.slice(idx, idx + 1200);
    assert.match(body, /peakScore:/, 'the peak must be reported');
    assert.match(body, /threshold:/, 'with the threshold, or the peak cannot be judged');
    assert.match(body, /scores:/, 'and the classifier-run count, which separates a dead pipeline from a quiet one');
    assert.match(body, /toFixed\(6\)/,
      '6dp: a real classifier on silence emits ~1e-6, and 4dp rounds that to a flat 0 — ' +
      'indistinguishable from never having run');
  });

  test('the metrics timer cannot outlive the detector', () => {
    const stopIdx = WW.indexOf('function stop()');
    const body = WW.slice(stopIdx, stopIdx + 500);
    assert.match(body, /clearInterval\(metricsTimer\)/,
      'stop() must clear the interval, or it keeps reporting "listening" after the mic is released');
  });

  test("onWake's five guards each name themselves instead of returning silently", () => {
    const idx = APP.indexOf('onWake:');
    assert.ok(idx !== -1, 'the onWake handler must still exist');
    const body = APP.slice(idx, idx + 1800);
    for (const reason of ['pin-gate-closed', 'voice-turn-already-active', 's2s-session-already-active',
      'mythos-is-speaking', 'voice-state-speaking']) {
      assert.ok(body.includes(reason), 'guard must be named in telemetry: ' + reason);
    }
    assert.match(body, /reportWakeword\('detected-suppressed'/,
      'a suppressed detection must be reported, not dropped');
    // The PIN gate is a security control: it must still be the first thing checked
    // and must still prevent the turn.
    assert.ok(body.indexOf('isGateClosed') < body.indexOf('voice.isActive()'),
      'the PIN gate must remain the first guard');
  });
});
