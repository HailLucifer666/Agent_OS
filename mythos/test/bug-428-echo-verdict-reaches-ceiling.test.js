'use strict';
// BUG-428, 2026-09-10. Diagnoses: Sept 9 filing / Sept 10 real-log replay.
// Mutations 2026-09-10: drop server callback; send with switch off; pass verdict
// to observe; drop ceiling ratio; remove per-hold reset. All five red;
// absolute-path file copy restored each, SHA256 matched.
// Acoustic benefit is not proven here. The idle/max ceilings remain 8s/30s,
// and barge-in's echo veto deliberately stays dormant (BUG-406 needs a room).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');
const { SCHEMA } = require('../src/core/config/schema');

class FakeSocket extends EventEmitter {
  constructor() { super(); this.readyState = 0; this.sent = []; }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.emit('close', 1000, 'test-close'); }
  frame(data) { this.emit('message', Buffer.from(JSON.stringify(data))); }
}
const waitFor = async predicate => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'expected Live frame did not arrive');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

for (const enabled of [true, false]) test(`real server emits private numeric verdict only when enabled=${enabled}`, async () => {
  const oldKey = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = 'test-key';
  const sockets = [];
  const server = createServer({
    config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_AUTH_TOKEN: '',
      VOICE_S2S_ENABLED: true, VOICE_ECHO_VERDICT_TO_CLIENT: enabled, ACTION_TIMEOUT_MS: 30000 },
    bus: createBus({ historySize: 20 }), logger: { info() {}, warn() {}, error() {} },
    memory: { working: { tick: 0 }, episodic: { write: async () => {} },
      fs: { vaultPath: (...parts) => path.join(__dirname, '../../.cache/temp/echo-vault', ...parts) },
      audit: { write: () => ({ ok: true }) } },
    goalsEffector: { listGoals: () => [], stats: () => ({}) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) }, pipelineEffector: { listAll: () => ({}) },
    effectors: { breakers: { allow: () => true }, effectors: new Map(), catalog: () => [], get: () => undefined },
    leash: { check: () => ({ allow: true }), confirm: { create: () => 'test', accept: () => null } },
    goals: { debitBudget() {} }, probes: { getStatus: async () => ({}) }, agentActions: {},
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
    createLiveSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
  });
  let ws;
  try {
    await server.ready;
    ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}/ws`);
    const frames = [];
    ws.on('message', data => frames.push(JSON.parse(data)));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'live-open' }));
    await waitFor(() => sockets.length === 1);
    sockets[0].readyState = 1; sockets[0].emit('open'); sockets[0].frame({ setupComplete: {} });
    await waitFor(() => frames.some(frame => frame.type === 'live-state' && frame.state === 'open'));
    sockets[0].frame({ serverContent: { inputTranscription: { text: 'open another program please' } } });
    await waitFor(() => frames.some(frame => frame.type === 'live-transcript' && frame.role === 'user'));
    const speech = 'the weather is sunny today in London';
    sockets[0].frame({ serverContent: { outputTranscription: { text: speech } } });
    sockets[0].frame({ serverContent: { inputTranscription: { text: speech } } });
    sockets[0].frame({ serverContent: { turnComplete: true } });
    await waitFor(() => frames.some(frame => frame.type === 'live-turn-complete'));
    assert.deepEqual(frames.filter(frame => frame.type === 'live-echo-check'), enabled ? [
      { type: 'live-echo-check', ratio: 0, matched: false },
      { type: 'live-echo-check', ratio: 1, matched: true },
    ] : []);
  } finally {
    if (ws) ws.close();
    await server.stop();
    if (oldKey === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = oldKey;
  }
});

test('bridge consumes verdict only at ceiling and resets it for every hold', () => {
  const source = fs.readFileSync(path.join(__dirname, '../ui/public/js/voice/s2s-bridge.js'), 'utf8');
  assert.match(source, /bargePolicy\.ceilingDecision\(\{\s*echoRatio: echoVerdict\.echoRatio,\s*hasTranscript: echoVerdict\.transcriptSeen,/);
  assert.match(source, /bargePolicy\.observe\(\{[^}]*echoRatio: null,/);
  assert.match(source.slice(source.indexOf('function holdOwnVoiceGate'), source.indexOf('function releaseOwnVoiceGate')), /echoVerdict\.reset\(\)/);
  assert.match(source, /onEchoCheckMsg = \(msg\) => \{ if \(ownVoiceGate\) echoVerdict\.accept\(msg\); \}/);
  assert.match(source, /onBroadcast\('live-echo-check', onEchoCheckMsg\)/);
  assert.match(source, /offBroadcast\('live-echo-check', onEchoCheckMsg\)/);
  assert.match(source, /OWN_VOICE_IDLE_CEILING_MS = 8000/);
  assert.match(source, /OWN_VOICE_MAX_HOLD_MS = 30000/);
  assert.equal(SCHEMA.VOICE_ECHO_VERDICT_TO_CLIENT.default, true);
});
