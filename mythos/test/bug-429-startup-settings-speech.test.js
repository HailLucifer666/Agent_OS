'use strict';

// Settings anomalies precede announcer construction. A direct handler test
// cannot prove delivery: this drives the real server's dashboard-ready timer.
// Probes 2026-09-10: remove warning/reconnect delivery, disarm warning-only
// readiness, drop retained diagnostics or inbox state. All failed; SHA256 restores.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');
const { once } = require('node:events');

function fixtureServer(bus, warnings, think) {
  return createServer({
        bus, config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
          MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, VOICE_TTS_CHAIN: 'disabled-test-provider', VOICE_SETTINGS_WARNINGS_ENABLED: warnings },
        settingsDiagnostics: { settingsUnknown: ['BROWSER_USE_MODEL'], settingsDropped: [], settingsError: null },
        logger: { info() {}, warn() {}, error() {} },
        memory: { working: { tick: 0 }, episodic: { write: async () => {} }, fs: { vaultPath: (...parts) => path.join(__dirname, ...parts) } },
        goalsEffector: { listGoals: () => [], stats: () => ({}) },
        kanbanEffector: { listBoard: () => ({ cards: [] }) },
        pipelineEffector: { listAll: () => ({}) },
        effectors: { breakers: new Map(), effectors: new Map(), invoke: async () => ({ ok: true }) },
        leash: { confirm: { create() {}, accept() {}, reject() {} } }, goals: { debitBudget() {} },
        probes: { getStatus: async () => ({}) },
        agentActions: { assembleKanbanPlan() {}, buildKanbanCard() {}, reviewKanbanCard() {} },
        buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
        brain: { think },
      });
}

it('startup diagnosis survives boot, joins one greeting, and obeys both switches', async () => {
  const original = process.env.BOOT_GREETING;
  const testContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT; // Exercise the production timer-arming decision.
  try {
    for (const greeting of [true, false]) for (const warnings of [true, false]) {
      process.env.BOOT_GREETING = greeting ? 'true' : 'false';
      const bus = createBus({ historySize: 2 });
      bus.emit('health.anomaly', { kind: 'config-settings-ignored', unknown: ['BROWSER_USE_MODEL'] });
      bus.emit('boot.step', {}); bus.emit('boot.step', {}); // history replay alone is insufficient.
      let greetingCalls = 0;
      const server = fixtureServer(bus, warnings, async () => { greetingCalls++; return { content: 'Hello from the greeting.', offline: false }; });
      await server.ready;
      server._internal.setBootGreetingDelayMs(10);
      const inputs = [];
      server.wss.on('connection', (ws) => {
        ws.getLiveSession = () => ({ isOpen: () => true, sendText(text) {
          inputs.push(text);
          ws.send(JSON.stringify({ type: 'test-live-input', text }));
          return true;
        } });
      });
      const ws = new WebSocket('ws://127.0.0.1:' + server.httpServer.address().port + '/ws');
      try {
        await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        // RE-POINTED 2026-09-18 (BUG-433): connecting no longer arms the boot
        // greeting — a client must first say it can PLAY one. This fixture
        // stands in for the dashboard, so it says what the dashboard says.
        ws.send(JSON.stringify({ type: 'hud-ready', greetable: true }));
        if (!greeting) assert.equal(server._internal.isBootGreetingDelivered(), true, 'warning-only startup never claims to cover the inbox');
        if (greeting || warnings) {
          await new Promise((resolve, reject) => {
            const deadline = setTimeout(() => reject(new Error('startup speech never reached dashboard')), 3000);
            ws.on('message', (raw) => {
              if (JSON.parse(raw).type === 'test-live-input') { clearTimeout(deadline); resolve(); }
            });
          });
          assert.equal(inputs.length, 1, 'greeting and warning use one Live injection');
          assert.equal(inputs[0].includes('BROWSER_USE_MODEL'), warnings);
          assert.equal(inputs[0].includes('Hello from the greeting.'), greeting);
        } else {
          await new Promise((resolve) => setTimeout(resolve, 60));
          assert.deepEqual(inputs, []);
        }
        assert.equal(greetingCalls, greeting ? 1 : 0, 'disabled greeting never spends a model call');
        const before = inputs.length;
        await server._internal.deliverBootGreeting([...server.wss.clients][0]);
        if (!greeting) assert.equal(inputs.length, before, 'warning-only repeats use existing backoff');
      } finally { ws.close(); await server.stop(); }
    }
  } finally {
    if (original === undefined) delete process.env.BOOT_GREETING; else process.env.BOOT_GREETING = original;
    if (testContext !== undefined) process.env.NODE_TEST_CONTEXT = testContext;
  }
});

it('the real boot passes the retained settings diagnosis into the server', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8'), /settingsDiagnostics:\s*configResult/);
});

it('a dashboard closing during greeting generation cannot consume settings warnings', async () => {
  const original = process.env.BOOT_GREETING;
  process.env.BOOT_GREETING = 'true';
  try {
    for (const replacementAlreadyConnected of [true, false]) {
      let release, started;
      const pending = new Promise((resolve) => { release = resolve; });
      const began = new Promise((resolve) => { started = resolve; });
      let calls = 0;
      const bus = createBus();
      const server = fixtureServer(bus, true, async () => {
        if (++calls === 1) { started(); await pending; }
        return { content: 'Hello again.', offline: false };
      });
      await server.ready;
      server._internal.setBootGreetingDelayMs(5);
      const inputs = [], sockets = [];
      server.wss.on('connection', (ws) => {
        ws.getLiveSession = () => ({ isOpen: () => ws.readyState === 1, sendText(text) { assert.equal(ws.readyState, 1); inputs.push(text); return true; } });
      });
      // RE-POINTED 2026-09-18 (BUG-433). Readiness is announced PER CALL SITE, and
      // the first version of this re-point put it in the helper, where it was
      // wrong in a way that only showed up under load: this test drives
      // deliverBootGreeting() directly, so a socket that ALSO announces itself
      // arms the scheduler as well, and the warning is then spoken twice. It
      // passed alone and on three full runs, and failed in the pre-commit hook.
      // Only the socket that must be greeted by the ordinary path announces.
      const connect = async (announceReady) => {
        const ws = new WebSocket('ws://127.0.0.1:' + server.httpServer.address().port + '/ws');
        sockets.push(ws); await once(ws, 'open');
        if (announceReady) ws.send(JSON.stringify({ type: 'hud-ready', greetable: true }));
        return ws;
      };
      try {
        const first = await connect();
        const peer = [...server.wss.clients][0];
        const delivery = server._internal.deliverBootGreeting(peer);
        await began;
        const closed = once(peer, 'close'); first.close(); await closed;
        if (replacementAlreadyConnected) await connect();
        release(); await delivery;
        if (!replacementAlreadyConnected) {
          assert.equal(bus.history((e) => e.type === 'conversation.announced').length, 0, 'no socket, no consumed warning');
          // The ONLY announcing socket in this test. Delivery found nobody and
          // handed the shot back, so this dashboard is greeted by the ordinary
          // scheduler path — which is exactly what "hands the shot back" means.
          await connect(true);
        }
        await new Promise((resolve, reject) => {
          const deadline = Date.now() + 3000;
          const timer = setInterval(() => {
            if (inputs.length) { clearInterval(timer); resolve(); }
            else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('replacement dashboard got no warning')); }
          }, 5);
        });
        assert.equal(inputs.length, 1);
        assert.match(inputs[0], /BROWSER_USE_MODEL/);
      } finally {
        release(); for (const ws of sockets) ws.close(); await server.stop();
      }
    }
  } finally {
    if (original === undefined) delete process.env.BOOT_GREETING; else process.env.BOOT_GREETING = original;
  }
});
