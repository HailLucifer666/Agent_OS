'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');
const { tempVaultDir, cleanupVaultDir } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');

test('OCR IPC handler preserves effector failure reasons in HUD response and outcome telemetry', async () => {
  const before = process.listeners('message');
  const events = [], invocations = [];
  const dir = tempVaultDir();
  let outcome;
  const server = createServer({
    bus: createBus({ historySize: 30 }),
    config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', ACTION_TIMEOUT_MS: 30000 },
    logger: { info: (name, value) => events.push({ name, value }), warn() {}, error() {} },
    memory: { working: {}, episodic: { write: async () => {} }, fs: createFsStore(() => dir) },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0 }) },
    effectors: { breakers: new Map(), effectors: new Map(), invoke: async (tool, args, ctx) => {
      invocations.push({ tool, args, channel: ctx.channel });
      return outcome;
    } },
    goals: { debitBudget() {} },
    leash: { confirm: { create() {}, accept() {}, reject() {} } },
    probes: { getStatus: async () => ({}) },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
  });
  let socket;
  try {
    await server.ready;
    const handler = process.listeners('message').find(fn => !before.includes(fn));
    assert.equal(typeof handler, 'function', 'real server must install the Electron IPC handler');
    socket = new WebSocket('ws://127.0.0.1:' + server.httpServer.address().port + '/ws');
    await once(socket, 'open');
    for (const [value, expected] of [
      [{ ok: false, result: 'PowerShell OCR language unavailable' }, 'PowerShell OCR language unavailable'],
      [{ ok: false, result: { error: 'capture denied' } }, 'capture denied'],
      [{ ok: false, error: 'adapter offline' }, 'adapter offline'],
      [{ ok: false }, 'OCR failed'],
    ]) {
      outcome = value;
      const received = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('OCR response missing')), 3000);
        function onMessage(raw) {
          const msg = JSON.parse(String(raw));
          if (msg.type !== 'ocr-result') return;
          clearTimeout(timer); socket.off('message', onMessage); resolve(msg.payload);
        }
        socket.on('message', onMessage);
      });
      handler({ channel: 'mythos:ocr-grab' });
      assert.deepEqual(await received, { ok: false, text: '', error: expected });
      assert.equal(events.findLast(e => e.name === 'ocr.hotkey.dispatched')?.value.error, expected);
    }
    assert.equal(events.filter(e => e.name === 'ocr.hotkey.received').length, 4);
    assert.equal(invocations.length, 4);
    assert.ok(invocations.every(x => x.tool === 'screen_read_text' && x.channel === 'hotkey'));
  } finally {
    if (socket) { socket.terminate(); }
    await server.stop();
    cleanupVaultDir(dir);
    for (const listener of process.listeners('message')) if (!before.includes(listener)) process.removeListener('message', listener);
  }
});
