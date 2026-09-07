'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const WebSocket = require('ws');
const { createServer } = require('../server');
const { createBus } = require('../src/core/bus');
const { createFsStore } = require('../src/core/memory/fs-store');
const { buildTools } = require('../src/core/effectors/from-dashboard');
const { tempVaultDir, cleanupVaultDir } = require('./helpers');

test('noopener unknown acknowledgement survives the actual HUD handler, websocket route and tool consumer', async () => {
  const dir = tempVaultDir();
  const prior = process.listeners('message');
  const server = createServer({ config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1' },
    memory: { working: {}, fs: createFsStore(() => dir) }, bus: createBus(),
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0 }) },
    probes: { getStatus: async () => ({}) }, logger: { info() {}, warn() {}, error() {} },
  });
  let socket;
  try {
    if (!server.httpServer.listening) await once(server.httpServer, 'listening');
    socket = new WebSocket('ws://127.0.0.1:' + server.httpServer.address().port + '/ws');
    await once(socket, 'open');
    let handler, popup = null;
    const calls = [];
    const source = fs.readFileSync(path.join(__dirname, '../ui/public/js/app.js'), 'utf8');
    const start = source.indexOf('function ackRender(');
    const end = source.indexOf('\n});', source.indexOf("subscribe(['open-web']", start)) + 4;
    vm.runInNewContext(source.slice(start, end), {
      subscribe: (_types, fn) => { handler = fn; },
      sendMessage: msg => socket.send(JSON.stringify(msg)),
      safeUrl: url => url,
      window: { open: (...args) => { calls.push(args); return popup; } },
    });
    socket.on('message', raw => { const msg = JSON.parse(raw); if (msg.type === 'open-web') handler(msg); });
    const built = buildTools({ config: {}, bus: createBus() });
    built.setWidgetRenderer(server.requestWidgetRender);
    const open = built.TOOLS.find(t => t.name === 'open_web').fn;
    const unknown = await open({ type: 'web', url: 'https://news.google.com' });
    assert.equal(unknown.ok, true);
    assert.equal(unknown.unverified, true);
    assert.match(unknown.reason, /cannot confirm whether/i);
    assert.doesNotMatch(unknown.reason, /blocked|nothing is on screen/i);
    assert.equal(calls[0][2], 'noopener');
    popup = {};
    const mounted = await open({ type: 'web', url: 'https://news.google.com' });
    assert.equal(mounted.unverified, false);
    // A malformed flag cannot turn a definite failure into an unknown success.
    handler = msg => socket.send(JSON.stringify({ type: 'open-web-ack', reqId: msg.reqId, mounted: false, unverified: 'true', reason: 'actual failure' }));
    assert.equal((await open({ type: 'web', url: 'https://news.google.com' })).ok, false);
  } finally {
    if (socket) socket.terminate();
    await server.stop();
    cleanupVaultDir(dir);
    for (const listener of process.listeners('message')) if (!prior.includes(listener)) process.removeListener('message', listener);
  }
});
