'use strict';
// Filed 2026-09-09; replayed 2026-09-10. Mutation probes 2026-09-10:
// drop the unavailable set or build the prompt before declarations -> red.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLiveSession } = require('../src/core/voice/live-session');
const { createLiveDeclarations } = require('../src/core/voice/live-declarations');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');
const WebSocket = require('ws');
const { baseDeps, FakeGeminiSocket, waitFor } = require('./pr3-wire-helpers.cjs');
test('real server passes OFFLINE browser names and recovery hint into the setup frame', async () => {
  const browser = require('../adapters/browser-agent'), before = browser.getStatus;
  browser.getStatus = () => ({ state: 'OFFLINE' });
  const sockets = [];
  const prev = process.env.GOOGLE_API_KEY; process.env.GOOGLE_API_KEY = 'test-key';
  const effectors = new Map(['browser_navigate', 'browser_launch_debug'].map(name => [name,
    { name, description: 'browser action', params: { url: 'string' }, tier: 1 }]));
  const server = createServer(baseDeps(createBus({ historySize: 30 }), {
    config: { VOICE_S2S_ENABLED: true },
    effectors: { effectors, catalog: () => [...effectors.values()], breakers: { allow: () => true } },
    createLiveSocket: () => { const s = new FakeGeminiSocket(); sockets.push(s); return s; },
  }));
  await server.ready;
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}/ws`);
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    ws.send(JSON.stringify({ type: 'live-open' })); await waitFor(() => sockets.length);
    sockets[0].simulateOpen(); sockets[0].serverFrame({ setupComplete: {} });
    await waitFor(() => sockets[0].sent.some(f => f.setup));
    const setup = sockets[0].sent.find(f => f.setup).setup;
    // BUG-423's REQUIREMENT — the model must be TOLD — is unchanged and still
    // asserted here. What changed on 2026-09-11 is the second assertion below.
    assert.match(setup.systemInstruction.parts[0].text, /browser_navigate.*browser_launch_debug can start one/s);
    // DISPOSITION CORRECTED 2026-09-11. This line used to assert the OPPOSITE:
    // that browser_navigate must NOT be declared while the browser is offline.
    // Measured cost of that, attended session 2026-09-10 (boot 19:38:29Z):
    //   19:40:41 browser_navigate withheld · 19:41:28 browser_launch_debug called
    //   19:41:30 connected via CDP · then think_deeply, list_windows, open_web.
    // The launcher worked and the model had nothing to launch FOR, because
    // declarations are rebuilt only in buildSetup() — once per socket — so the
    // list stayed frozen at the pre-browser state for the whole session. It
    // improvised, which is the exact failure tool-capability.js's own header
    // says withholding exists to prevent.
    // The gate is now selfHealing: the tool is DECLARED and the instruction says
    // what to do first. Calling it with no browser is safe and honest —
    // from-browser.js's requireOnline() connects or launches (BUG-011) and
    // otherwise reports OFFLINE, and browser-agent's connectingPromise mutex
    // means it can never open a second browser alongside browser_launch_debug.
    assert.ok(setup.tools?.[0]?.functionDeclarations.some(d => d.name === 'browser_navigate'),
      'a tool whose gate a step in THIS session can clear must be reachable in this session');
    assert.match(setup.systemInstruction.parts[0].text, /NEED A STEP FIRST/,
      'and declaring it is only honest if the model is told the order');
    // BOUNDS: the mechanism must still withhold what genuinely cannot run here.
    // A gate nothing in the session can clear (no OAuth triple) stays a refusal.
    const { checkToolCapability } = require('../src/core/voice/tool-capability');
    assert.equal(checkToolCapability('gmail_unread', { googleOAuth: false }).ok, false,
      'selfHealing must not have turned every capability gate into a suggestion');
    assert.equal(sockets[0].sent.filter(f => f.realtimeInput).length, 0);
  } finally {
    ws?.close(); await server.stop(); browser.getStatus = before;
    if (prev === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prev;
  }
});
test('setup declares only available tools and tells the model what is missing', async () => {
  let online = false;
  const catalog = createLiveDeclarations({ config: {}, logger: { info() {}, warn() {} },
    rebuild: () => ({ declarations: online ? [{ name: 'browser_navigate' }] : [], withheld: [],
      unavailable: online ? [] : [{ name: 'browser_navigate', reason: 'browser_launch_debug can start one' }] }) });
  const sockets = [];
  class FakeGeminiSocket extends EventEmitter {
    constructor() { super(); this.OPEN = 1; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(json) { this.sent.push(JSON.parse(json)); }
    close() { this.readyState = 3; this.emit('close', 1000, 'done'); }
  }
  const session = createLiveSession({ config: { GOOGLE_API_KEY: 'test-key', GEMINI_LIVE_IDLE_TIMEOUT_MS: 0 },
    logger: { info() {}, warn() {}, error() {} }, createSocket: () => new FakeGeminiSocket(),
    functionDeclarations: catalog.forSession, systemInstruction: () => 'original prompt' + catalog.instructionBlock() });
  const prev = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = 'test-key';
  try {
    for (const up of [false, true]) {
      online = up;
      const opened = session.open(); const socket = sockets.at(-1);
      socket.readyState = 1; socket.emit('open');
      socket.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} }))); await opened;
      const setup = socket.sent.find(f => f.setup).setup;
      if (up) assert.equal(setup.systemInstruction.parts[0].text, 'original prompt');
      else {
        assert.match(setup.systemInstruction.parts[0].text, /browser_navigate.*browser_launch_debug can start one/s);
        assert.ok(!setup.tools?.[0]?.functionDeclarations.some(d => d.name === 'browser_navigate'));
      }
      assert.equal(socket.sent.filter(f => f.realtimeInput).length, 0);
      session.close();
    }
  } finally { session.close(); if (prev === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prev; }
});
