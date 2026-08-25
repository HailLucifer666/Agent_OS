'use strict';

// test/s2s-capture-suspend-log.test.js — Wave 0 (2026-08-13). s2s-bridge.js
// suspends mic capture around MYTHOS's own TTS and media playback (the
// German-narration-transcribed-as-operator incident, 2026-07-31) but never
// told the server it had done so — every suspend/clear was invisible outside
// the browser tab, so Wave 2's lost-transcript diagnosis had no server-side
// trail to correlate against a blind turn. This proves the transition log
// fires for suspend-start and ceiling fail-open-clear, with the right
// suspended/holdMs/reason fields.
//
// s2s-bridge.js is a browser ES module (no bundler — see ui/CLAUDE.md) with
// no meaningful Node double for getUserMedia/AudioContext, so this only
// exercises the pure capture-suspend gate via createS2SBridge's injected
// `sendMessageOverride` seam, added specifically so this logic is testable
// without mocking the whole ws.js module graph every other voice module
// shares (mock.module() replaces that graph-wide and is still experimental
// in this Node version).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

const BRIDGE_PATH = path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 's2s-bridge.js');
const BRIDGE_URL = pathToFileURL(BRIDGE_PATH).href;

let createS2SBridge;
test.before(async () => {
  ({ createS2SBridge } = await import(BRIDGE_URL));
});

describe('s2s-bridge: capture-suspend transition log', () => {
  test('suspendForMedia logs a suspend-start transition with the actual hold', () => {
    const sent = [];
    const bridge = createS2SBridge({ sendMessageOverride: (m) => sent.push(m) });

    bridge.suspendForMedia(500);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'voice-capture-suspend');
    assert.equal(sent[0].suspended, true);
    assert.equal(sent[0].holdMs, 500);
    assert.equal(sent[0].reason, 'media-start');
    assert.equal(typeof sent[0].at, 'number');
  });

  test('the hold is capped at MAX_SUSPEND_MS (30000) even if a caller asks for longer', () => {
    const sent = [];
    const bridge = createS2SBridge({ sendMessageOverride: (m) => sent.push(m) });

    bridge.suspendForMedia(999999);

    assert.equal(sent[0].holdMs, 30000);
  });

  test('the suspend ceiling fails open and logs its own transition, without a fake timer never firing', (t) => {
    // t.mock (test-scoped, auto-restored), NOT the global mock — a leaked global
    // mock.timers.enable here replaced setTimeout for every later test in this
    // file and hung the BUG-271 server-side suite's wait loop.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sent = [];
    const bridge = createS2SBridge({ sendMessageOverride: (m) => sent.push(m) });

    bridge.suspendForMedia(1000);
    assert.equal(bridge.isCaptureSuspended(), true);

    t.mock.timers.tick(1000);

    assert.equal(bridge.isCaptureSuspended(), false, 'fail-open: a deaf assistant is the worse failure');
    assert.equal(sent.length, 2);
    assert.equal(sent[1].suspended, false);
    // BUG-272: renamed to distinguish this MEDIA/TTS suspend ceiling from the
    // own-voice hold ceiling, which used to emit the identical string from a
    // different timer — making a count of them unattributable (BUG-272 counted 16
    // and could not split them by cause).
    //
    // BUG-273 A4: split once more, and this case moved. A caller-chosen 1000ms hold
    // running to completion is the ROUTINE end of a deliberate window, not a safety
    // net catching a stuck state — measured 2026-08-18 as 8 media-start arms, 8
    // expiries and 0 clears, i.e. 100% of the designed path wearing a fail-open name.
    // The fail-open name is kept for MAX_SUSPEND_MS, asserted in the test below.
    assert.equal(sent[1].reason, 'suspend-window-elapsed');
    assert.equal(sent[1].heldMs, 1000, 'and it reports the window it actually served');
  });

  test('BUG-273 A4: reaching MAX_SUSPEND_MS is still a fail-open, and says so', (t) => {
    // The case the fail-open name exists for: no caller-chosen hold, so the only
    // thing that clears the gate is the 30s net. That means a 'speaking' state never
    // cleared (a SpeechSynthesisUtterance whose onend never fired) and Live would
    // have gone permanently deaf without it. A real fault, and it must not share a
    // label with the routine window above or the count stops meaning anything.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sent = [];
    const bridge = createS2SBridge({ sendMessageOverride: (m) => sent.push(m) });

    bridge.suspendForMedia(999999);   // clamped to MAX_SUSPEND_MS
    assert.equal(bridge.isCaptureSuspended(), true);
    t.mock.timers.tick(30000);

    assert.equal(bridge.isCaptureSuspended(), false, 'fail-open: a deaf assistant is the worse failure');
    assert.equal(sent[1].reason, 'suspend-ceiling-fail-open');
    assert.equal(sent[1].heldMs, 30000);
  });

  test('setCaptureSuspended(false, ...) with an explicit reason logs a clear, not a re-suspend', () => {
    const sent = [];
    const bridge = createS2SBridge({ sendMessageOverride: (m) => sent.push(m) });

    bridge.suspendForMedia(500);
    bridge.setCaptureSuspended(false, undefined, 'watchdog-clear');

    assert.equal(sent.length, 2);
    assert.equal(sent[1].suspended, false);
    assert.equal(sent[1].reason, 'watchdog-clear');
  });

  test('a throwing sendMessage never blocks the gate itself', () => {
    const bridge = createS2SBridge({ sendMessageOverride: () => { throw new Error('socket not open'); } });
    assert.doesNotThrow(() => bridge.suspendForMedia(200));
    assert.equal(bridge.isCaptureSuspended(), true, 'the gate still took effect even though logging failed');
  });
});

// Wave 2 (2026-08-13): candidate 1 for the lost-transcript incidents — the
// gate above dropped mic frames while the HUD orb kept showing 'listening',
// so the operator had no reason to doubt they were being heard. onState is
// the wire from this module to core-orb.js's setVoiceState; this proves the
// 'muted' overlay wins over whatever the real voice state is while suspended,
// and that the real state (not a hardcoded 'listening') comes back once clear.
describe('s2s-bridge: mic-muted HUD state overlay', () => {
  test('suspending while listening reports muted, and clearing restores listening — not a hardcoded guess', () => {
    const states = [];
    const bridge = createS2SBridge({ onState: (s) => states.push(s), sendMessageOverride: () => {} });

    // Simulate the server having already told us we're listening (the normal
    // steady state a mid-conversation media-echo suspend interrupts).
    bridge.setCaptureSuspended(false); // no-op transition, establishes baseline
    states.length = 0;
    // There is no public setVoiceState — drive the real transition path via
    // the same live-state message handling this module wires internally is
    // out of scope for a bridge unit test (needs a live session); instead
    // pin the overlay's OWN contract directly through the public seam it
    // actually exposes.
    bridge.suspendForMedia(300);
    assert.deepEqual(states, ['muted']);

    bridge.setCaptureSuspended(false, undefined, 'watchdog-clear');
    // With no prior real voice state ever recorded (idle by default), clearing
    // restores 'idle' — proving it restores the TRACKED state, not a hardcoded
    // 'listening', which is the actual bug this closes.
    assert.deepEqual(states, ['muted', 'idle']);
  });

  test('the ceiling fail-open clear also restores state, not just the transition log', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const states = [];
    const bridge = createS2SBridge({ onState: (s) => states.push(s), sendMessageOverride: () => {} });

    bridge.suspendForMedia(1000);
    assert.deepEqual(states, ['muted']);
    t.mock.timers.tick(1000);
    assert.deepEqual(states, ['muted', 'idle']);
  });

  test('a bridge with no onState callback never throws', () => {
    const bridge = createS2SBridge({ sendMessageOverride: () => {} });
    assert.doesNotThrow(() => bridge.suspendForMedia(200));
    assert.doesNotThrow(() => bridge.setCaptureSuspended(false));
  });
});

// BUG-271 Task 3 (2026-08-17): the OTHER half of the evidence chain. The block
// above pins what the CLIENT sends; this pins that the SERVER's
// `voice-capture-suspend` handler actually LOGS the diagnostic fields instead of
// discarding them. Since 36561bd (2026-08-14) the own-voice-release transition
// has carried prerollFrames/prerollCap/heldMs/framesDropped/peakRms (and BUG-271
// Task 2 added framesZeroed), but server/index.js logged only
// { suspended, holdMs, reason, at } — so the ring-overflow / self-echo numbers
// that diagnose BUG-271 never reached mythos-server.log and could only be
// INFERRED from Gemini's audioIn counts a day later. No wire change: the server
// only logs more of what it already receives.
//
// NOTE on field names: `holdMs` (suspend-start, media path) and `heldMs`
// (own-voice-release) are DISTINCT fields sent on different transitions — never
// both on one message. The plan's "heldMs" is the own-voice-release duration and
// is logged under that exact client name; it is NOT a duplicate of `holdMs`.
function fakeFs() {
  return { vaultPath: (...s) => path.join('/test-vault', ...s) };
}

function baseDeps(bus, logger) {
  return {
    bus,
    config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '' },
    logger,
    memory: { working: { tick: 0, activeGoalId: null }, episodic: { write: async () => {} }, fs: fakeFs() },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
    leash: { confirm: { create: () => 'cf-1', accept: () => null, reject: () => true } },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({ ok: true }) },
    agentActions: {},
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
  };
}

function connectWs(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

describe('server: voice-capture-suspend handler logs the fields the client sends (BUG-271)', () => {
  test('an own-voice-release transition reaches the log with every diagnostic field under its exact client name', async () => {
    const bus = createBus({ historySize: 50 });
    const logged = [];
    const logger = {
      info: (msg, fields) => logged.push({ msg, fields }),
      warn() {}, error() {}, debug() {}, onLog: () => () => {},
    };
    const server = createServer(baseDeps(bus, logger));
    await server.ready;
    const { port } = server.httpServer.address();
    let ws;
    try {
      ws = await connectWs(port);
      // Exactly the shape s2s-bridge.js's releaseOwnVoiceGate sends (see
      // logSuspendTransition's own-voice-release call site).
      ws.send(JSON.stringify({
        type: 'voice-capture-suspend',
        suspended: false,
        at: 1755432100000,
        reason: 'own-voice-release',
        ownVoiceGate: false,
        prerollFrames: 37,
        prerollCap: 50,
        heldMs: 6650,
        framesDropped: 0,
        framesZeroed: 12,
        peakRms: 0.0421,
        // BUG-272 slice 3's three calibration fields.
        bargeVetoed: 4,
        bargeVetoTier: 'eager',
        bleedFloor: 0.1305,
      }));
      // The handler is fire-and-forget; poll briefly for the log line.
      const entry = await new Promise((resolve, reject) => {
        const deadline = Date.now() + 3000;
        (function poll() {
          const hit = logged.find((e) => e.msg === 'voice.capture-suspend' && e.fields && e.fields.reason === 'own-voice-release');
          if (hit) return resolve(hit);
          if (Date.now() > deadline) return reject(new Error('voice.capture-suspend own-voice-release never logged'));
          setTimeout(poll, 20);
        })();
      });

      const f = entry.fields;
      // The four fields the handler already logged (must not regress).
      assert.equal(f.suspended, false);
      assert.equal(f.reason, 'own-voice-release');
      assert.equal(f.at, 1755432100000);
      // The six BUG-271 fields, each under its exact client name.
      assert.equal(f.prerollFrames, 37);
      assert.equal(f.prerollCap, 50);
      assert.equal(f.heldMs, 6650);
      assert.equal(f.framesDropped, 0);
      assert.equal(f.framesZeroed, 12);
      assert.equal(f.peakRms, 0.0421);
      // ownVoiceGate is a boolean the client sends on both own-voice
      // transitions — part of the evidence chain, never transcript text.
      assert.equal(f.ownVoiceGate, false);
      // BUG-272: found DROPPED on the first live run. Slice 3 added these to the
      // client's message and not to the handler's allowlist, so they were computed,
      // sent, and discarded — precisely the defect BUG-271 fixed for the fields
      // above, reintroduced by the commit that added new ones. They are the three
      // numbers that say whether the barge-in policy is calibrated, so losing them
      // silently made the live session unreadable for its main question.
      assert.equal(f.bargeVetoed, 4, 'how many level-triggered barge-ins the policy vetoed');
      assert.equal(f.bargeVetoTier, 'eager', 'which tier last tried');
      assert.equal(f.bleedFloor, 0.1305, "the floor learned from this room's bleed");
    } finally {
      if (ws) try { ws.close(); } catch (_) {}
      await server.stop();
    }
  });

  test('a media-start suspend still logs holdMs and does not fabricate the release-only fields', async () => {
    const bus = createBus({ historySize: 50 });
    const logged = [];
    const logger = {
      info: (msg, fields) => logged.push({ msg, fields }),
      warn() {}, error() {}, debug() {}, onLog: () => () => {},
    };
    const server = createServer(baseDeps(bus, logger));
    await server.ready;
    const { port } = server.httpServer.address();
    let ws;
    try {
      ws = await connectWs(port);
      ws.send(JSON.stringify({
        type: 'voice-capture-suspend',
        suspended: true,
        at: 1755432200000,
        holdMs: 8000,
        reason: 'media-start',
      }));
      const entry = await new Promise((resolve, reject) => {
        const deadline = Date.now() + 3000;
        (function poll() {
          const hit = logged.find((e) => e.msg === 'voice.capture-suspend' && e.fields && e.fields.reason === 'media-start');
          if (hit) return resolve(hit);
          if (Date.now() > deadline) return reject(new Error('voice.capture-suspend media-start never logged'));
          setTimeout(poll, 20);
        })();
      });

      const f = entry.fields;
      assert.equal(f.suspended, true);
      assert.equal(f.holdMs, 8000);
      assert.equal(f.reason, 'media-start');
      // The release-only fields were not sent, so they must be absent from the
      // log line — not coerced to 0/false, which would falsify the evidence.
      assert.equal(f.prerollFrames, undefined);
      assert.equal(f.heldMs, undefined);
      assert.equal(f.framesZeroed, undefined);
      assert.equal(f.peakRms, undefined);
    } finally {
      if (ws) try { ws.close(); } catch (_) {}
      await server.stop();
    }
  });
});
