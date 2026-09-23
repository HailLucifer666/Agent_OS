'use strict';

// BUG-422: log only; exit still owns restart. Ordinary connected children stay quiet.
// Mutation probes 2026-09-10: strip timestamp, collapse event kind, invert
// connected, remove main wiring, and rename process-exit all fail assertions.
// Restored each source by absolute-path copy and verified its SHA256.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const lifecycle = require('../../electron/child-lifecycle');

it('timestamps every log line and preserves diagnostic fields', () => {
  assert.match(lifecycle.formatLogLine(['child', { code: 2 }]), /^\d{4}-\d\d-\d\dT[^ ]+Z child {"code":2}\n$/);
  const source = fs.readFileSync(path.resolve(__dirname, '../../electron/main.js'), 'utf8');
  assert.match(source.slice(source.indexOf('function log('), source.indexOf('function safeStringify(')), /formatLogLine\(args/);
  assert.match(source, /observeChildLifecycle\(child, childLogStream, log\)/);
});

it('close, exit and disconnect retain their own identity and stream state', () => {
  const state = { destroyed: true, writableEnded: false };
  for (const kind of ['close', 'exit', 'disconnect']) {
    const line = lifecycle.describeChildEvent(kind, 7, 'SIGTERM', state);
    assert.match(line, new RegExp('child ' + kind + ':'));
    assert.match(line, /"code":7/);
    assert.match(line, /"destroyed":true/);
  }
});

it('only a disconnected child with no recorded exit is unreachable', () => {
  const child = { connected: false, exitCode: null, signalCode: null };
  assert.deepEqual(lifecycle.livenessProbe(child), { unreachable: true, reason: 'child unreachable, no exit event seen' });
  for (const patch of [{ connected: true }, { exitCode: 0 }, { signalCode: 'SIGTERM' }]) {
    assert.equal(lifecycle.livenessProbe({ ...child, ...patch }).unreachable, false);
  }
  assert.equal(lifecycle.livenessProbe(null).unreachable, false);
});

it('observes events without restarting and retires its unreferenced probe', () => {
  const child = Object.assign(new EventEmitter(), { connected: true, exitCode: null, signalCode: null });
  const stream = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false });
  const lines = [];
  let probe, unrefs = 0, clears = 0;
  lifecycle.observeChildLifecycle(child, stream, (line) => lines.push(line), {
    setInterval(fn, ms) { assert.equal(ms, 30000); probe = fn; return { unref() { unrefs++; } }; },
    clearInterval() { clears++; },
  });
  probe();
  assert.equal(lines.length, 0);
  child.connected = false;
  child.emit('disconnect');
  probe();
  stream.emit('error', new Error('stream refused'));
  child.exitCode = 1;
  child.emit('exit', 1, null);
  child.emit('close', 1, null);
  assert.equal(unrefs, 1);
  assert.equal(clears, 1);
  assert.ok(lines.some((line) => /child unreachable/.test(line)));
  assert.ok(lines.some((line) => /child log stream error/.test(line)));
});

it('counts failed main-log writes and leaves a separate, value-free record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'child-lifecycle-'));
  try {
    const file = path.join(dir, 'main.log');
    const before = lifecycle.logFailureCounter.count;
    lifecycle.recordLogFailure(() => file, Object.assign(new Error('private value'), { code: 'EACCES' }));
    assert.equal(lifecycle.logFailureCounter.count, before + 1);
    const line = fs.readFileSync(file + '.write-failures', 'utf8');
    assert.match(line, /EACCES/);
    assert.doesNotMatch(line, /private value/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it('the child writes beforeExit and exit synchronously in a real process', () => {
  const modulePath = path.resolve(__dirname, '../src/core/lifecycle');
  const child = spawnSync(process.execPath, ['-e',
    'require(' + JSON.stringify(modulePath) + ').createLifecycle({bus:{},logger:{},config:{}}).registerShutdown()',
  ], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stderr, /"msg":"lifecycle.process-before-exit","code":0/);
  assert.match(child.stderr, /"msg":"lifecycle.process-exit","code":0/);
});
