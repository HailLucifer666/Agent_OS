'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const http = require('node:http');
const cp = require('node:child_process');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

for (const parentExited of [false, true]) {
  test(`Unix group cleanup escalates surviving descendants (parent exited: ${parentExited})`, async () => {
    const filename = require.resolve('../scripts/verify-lib');
    const timers = new Map();
    const signals = [];
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, exports: module.exports, __dirname: path.dirname(filename),
      process: { ...process, platform: 'linux', kill: (pid, signal) => signals.push([pid, signal]) },
      setTimeout: (fn, ms) => { const id = {}; timers.set(id, { fn, ms }); return id; },
      clearTimeout: (id) => timers.delete(id), console, require: createRequire(filename),
    }, { filename });
    const child = Object.assign(new EventEmitter(), { pid: 8123, exitCode: parentExited ? 0 : null, signalCode: null,
      kill() { assert.fail('must kill owned group, not its exited leader'); } });
    let settled = false;
    const promise = module.exports.killTree(child).then(() => { settled = true; });
    child.emit('close', 0);
    await Promise.resolve();
    assert.equal(settled, false, 'leader close must not cancel descendant escalation');
    assert.deepEqual(signals[0], [-8123, 'SIGTERM']);
    const deadline = [...timers.values()].find((timer) => timer.ms === 5000);
    assert.ok(deadline);
    deadline.fn();
    await promise;
    assert.deepEqual(signals.at(-1), [-8123, 'SIGKILL']);
    assert.equal(timers.size, 0);
  });
}

function loadHarness(t) {
  const filename = require.resolve('../scripts/verify-lib');
  const realRequire = createRequire(filename);
  const owned = [];
  const replacement = { ...cp, spawn(command, args, opts) {
    const probe = command === process.execPath && args[0].endsWith(path.join('src', 'main.js'));
    const child = cp.spawn(command, probe ? ['-e', 'setInterval(() => {}, 1000)'] : args, opts);
    if (probe) owned.push(child);
    return child;
  } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), process,
    setTimeout, clearTimeout, console: { log() {} },
    require: (id) => id === 'child_process' ? replacement : realRequire(id),
  }, { filename });
  t.after(async () => { for (const child of owned) await module.exports.killTree(child); });
  return { api: module.exports, owned };
}

test('unhealthy boot rejects only after owned child cleanup and leaves no health polls', async (t) => {
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; res.writeHead(503); res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { api, owned } = loadHarness(t);
  await assert.rejects(api.bootMythos({ port: server.address().port, bootTimeoutMs: 250 }), /boot timed out/);
  assert.ok(owned[0].exitCode !== null || owned[0].signalCode, 'rejected boot cannot leave its child running');
  const count = requests;
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(requests, count, 'no retry remains after rejection');
  assert.ok(count > 0, 'real HTTP unhealthy response was exercised');
});

test('hanging health connection is destroyed when boot deadline expires', async (t) => {
  const sockets = new Set();
  const server = http.createServer(() => {});
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const { api, owned } = loadHarness(t);
  await assert.rejects(api.bootMythos({ port: server.address().port, bootTimeoutMs: 250 }), /boot timed out/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sockets.size, 0);
  assert.ok(owned[0].exitCode !== null || owned[0].signalCode);
});
