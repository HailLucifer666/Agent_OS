'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

function bridge() {
  const filename = path.resolve(__dirname, '../adapters/android-child/index.js');
  const actualRequire = createRequire(filename);
  const calls = [];
  const runtime = path.resolve(__dirname, '../../.cache/bug-404-runtime');
  const fakeProcess = { ...process, env: { ...process.env, MYTHOS_TOOLS_DIR: runtime } };
  const childProcess = {
    spawnSync(bin, args, opts) { calls.push({ args, opts }); return { status: 0, stdout: '' }; },
    spawn(bin, args, opts) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => { child.killed = true; return true; };
      calls.push({ args, opts, child });
      return child;
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename),
    require: (id) => id === 'child_process' ? childProcess : actualRequire(id),
    process: fakeProcess, Buffer, setInterval, clearInterval, setTimeout, clearTimeout,
  }, { filename });
  const api = module.exports;
  api.startAndroidChild({ adbBin: path.join(runtime, 'adb.exe'), log: { info() {}, warn() {} } });
  return { api, calls, runtime };
}

test('BUG-404 every adb entry point gives daemon a writable runtime cwd', (t) => {
  const { api, calls, runtime } = bridge();
  t.after(() => api.shutdownAndroidChild());
  assert.equal(calls.length, 3, 'version, start-server, devices all exercised');
  for (const { opts } of calls) {
    assert.equal(opts.cwd, path.join(runtime, 'runtime'));
    assert.ok(fs.statSync(opts.cwd).isDirectory());
  }
});

test('BUG-404 shutdown settles owned in-flight and queued commands without killing shared adb server', async () => {
  const { api, calls } = bridge();
  const first = api.sendCommand({ serial: 'phone', args: ['shell', 'echo', 'one'] });
  const second = api.sendCommand({ serial: 'phone', args: ['shell', 'echo', 'two'] });
  api.shutdownAndroidChild();
  const result = await Promise.all([first, second]);
  assert.ok(result.every((r) => !r.ok && /shutting down/.test(r.error)));
  assert.ok(calls.filter((c) => c.child).every((c) => c.child.killed));
  assert.ok(calls.every((c) => !c.args.includes('kill-server')));
  assert.equal(api.getStatus().queueDepth, 0);
});

test('BUG-404 server retains relative path semantics while child commands retain executable identity', () => {
  const filename = path.resolve(__dirname, '../../electron/main.js');
  const src = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /child_process\.fork\(SERVER_ENTRY, \[\], \{[\s\S]*?cwd: MYTHOS_DIR,/);
  const { childCommand } = require('../src/core/util/child-runtime');
  const executable = './my-relative-env/python';
  assert.equal(childCommand(executable), path.resolve(executable));
  assert.equal(childCommand('python'), 'python');
  assert.equal(childCommand(process.execPath), process.execPath);
});

test('BUG-404 late polling completion cannot repopulate a stopped bridge', async () => {
  const { api } = bridge();
  let finish;
  api.startAndroidChild({
    versionProbe: () => ({ status: 0 }),
    devicesRunner: () => new Promise((resolve) => { finish = resolve; }),
  });
  api.shutdownAndroidChild();
  finish({ ok: true, stdout: 'List of devices attached\nlate-device device model:phone\n' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(api.getStatus().state, 'OFFLINE');
  assert.equal(api.getStatus().devices.length, 0);
});
