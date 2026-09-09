'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { createBrowserExtensionBridge } = require('../adapters/browser-extension');
const { tempVaultDir, cleanupVaultDir } = require('./helpers');
const ID = 'a'.repeat(32);
async function setup(t) {
  const dir = tempVaultDir(); const wire = new EventEmitter(); let browserId;
  wire.start = async () => ({ sid: 'fixture', sddl: 'fixture' }); wire.stop = async () => {};
  wire.close = id => wire.emit('disconnected', id);
  const sent = [];
  wire.send = (clientId, frame) => {
    sent.push(frame); if (frame.type === 'welcome') browserId = frame.browserId;
    if (frame.type !== 'command') return;
    queueMicrotask(() => {
      if (wire.hold) return;
      const result = frame.operation === 'tabs' ? { tabs: [{ tabId: 8, url: 'https://www.youtube.com/', active: true }] }
        : frame.operation === 'observe' ? { target: { browserId, tabId: 8, frameId: 0, observationId: 'obs-' + frame.id, documentId: 'doc', generation: 1, url: 'https://www.youtube.com/' }, items: [] }
          : { commandAccepted: true };
      wire.emit('message', clientId, { id: frame.id, taskId: frame.taskId, ok: true, result });
    });
  };
  const bridge = createBrowserExtensionBridge({ runtimeDir: path.resolve(dir), allowedExtensionIds: [ID], transportFactory: () => wire, requestTimeoutMs: 1000 });
  await bridge.start(); wire.emit('message', 'client', { type: 'hello', extensionId: ID });
  t.after(async () => { await bridge.stop(); cleanupVaultDir(dir); });
  return { bridge, wire, sent, target: () => ({ browserId, tabId: 8, frameId: 0 }) };
}
test('bridge requires explicit allowlist and rejects unapproved extension without registering browser', async t => {
  const env = await setup(t); env.wire.emit('message', 'outsider', { type: 'hello', extensionId: 'b'.repeat(32) });
  assert.equal(env.bridge.getStatus().browsers.length, 1);
  assert.equal((await env.bridge.execute('tabs')).code, 'TASK_REQUIRED');
  await assert.rejects(createBrowserExtensionBridge({ runtimeDir: path.resolve('.'), allowedExtensionIds: [] }).start(), /Explicit/);
});
test('takeover from another browser/tab cannot cancel unrelated task', async t => {
  const { bridge, wire, target } = await setup(t);
  const observation = await bridge.execute('observe', target(), { taskId: 'task' });
  wire.emit('message', 'client', { type: 'user-takeover', taskId: 'task', tabId: 99, inputType: 'pointerdown' });
  assert.equal((await bridge.execute('playbackState', { target: observation.result.target }, { taskId: 'task' })).ok, true);
  wire.emit('message', 'client', { type: 'user-takeover', taskId: 'task', tabId: 8, inputType: 'pointerdown' });
  assert.equal((await bridge.execute('observe', target(), { taskId: 'task' })).code, 'CANCELLED');
});

test('disconnected bridge reports missing extension instead of a successful empty browser list', async t => {
  const { bridge, wire } = await setup(t);
  wire.emit('disconnected', 'client');
  const missing = await bridge.execute('tabs', {}, { taskId: 'task' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'EXTENSION_DISCONNECTED');
  assert.match(missing.error, /MYTHOS Browser Operator/);
  wire.emit('message', 'reconnected', { type: 'hello', extensionId: ID });
  const restored = await bridge.execute('tabs', {}, { taskId: 'task' });
  assert.equal(restored.ok, true);
  assert.equal(restored.result.tabs.length, 1);
});

// The set this guard covers is derived from its reason, not from the one
// operation whose symptom was noticed. "Nothing is connected" is a fact about
// the bridge, so it must answer for EVERY operation; before this, only `tabs`
// said so and the rest returned BROWSER_REQUIRED, which tells the operator to
// choose among zero browsers rather than to reconnect the extension.
// Probe, 2026-09-09: moving the guard back inside the `tabs` branch fails this
// test on the first non-tabs operation with code BROWSER_REQUIRED.
test('with no extension connected, EVERY operation names the disconnection, not a browser choice', async t => {
  const { bridge, wire, target } = await setup(t);
  // Capture a real capsule while the extension is still attached, so the only
  // thing wrong on each call below is that nothing is connected.
  const observed = await bridge.execute('observe', target(), { taskId: 'seed' });
  assert.equal(observed.ok, true);
  const capsule = observed.result.target;
  wire.emit('disconnected', 'client');
  assert.equal(bridge.getStatus().browsers.length, 0);

  for (const [operation, args] of [
    ['tabs', {}],
    ['observe', capsule],
    ['videoList', capsule],
    ['playbackState', { target: capsule }],
    ['click', { target: capsule, ref: 'e1' }],
    ['navigate', { target: capsule, url: 'https://example.com' }],
    ['createTab', { browserId: capsule.browserId, url: 'https://example.com' }],
  ]) {
    const res = await bridge.execute(operation, args, { taskId: 'task-' + operation });
    assert.equal(res.ok, false, `${operation} must not succeed with no extension connected`);
    assert.equal(res.code, 'EXTENSION_DISCONNECTED',
      `${operation} reported ${res.code}; "nothing is connected" is not a browser-choice problem`);
    assert.match(res.error, /reconnect/i, `${operation} must name the recovery step`);
  }
});
test('mutations require exact task/browser/tab/frame/document and consume fresh observation once', async t => {
  const { bridge, target, sent } = await setup(t);
  const observed = await bridge.execute('observe', target(), { taskId: 'task' }); assert.equal(observed.ok, true);
  const capsule = observed.result.target;
  for (const wrong of [{ ...capsule, tabId: 9 }, { ...capsule, frameId: 1 }, { ...capsule, documentId: 'old' }, { ...capsule, observationId: 'old' }]) assert.equal((await bridge.execute('click', { target: wrong, ref: 'e0' }, { taskId: 'task' })).ok, false);
  assert.equal((await bridge.execute('click', { target: capsule, ref: 'e0' }, { taskId: 'other-task' })).code, 'STALE_OBSERVATION');
  assert.equal((await bridge.execute('click', { target: capsule, ref: 'e0' }, { taskId: 'task' })).ok, true);
  assert.equal((await bridge.execute('click', { target: capsule, ref: 'e0' }, { taskId: 'task' })).code, 'STALE_OBSERVATION');
  assert.equal(sent.filter(x => x.operation === 'click').length, 1);
});
test('abort between operations invalidates capsules; explicit trusted resume requires a new observation', async t => {
  const { bridge, target, sent } = await setup(t); const controller = new AbortController();
  const observed = await bridge.execute('observe', target(), { taskId: 'task', signal: controller.signal });
  controller.abort();
  assert.ok(sent.some(x => x.type === 'cancel'));
  assert.equal((await bridge.execute('observe', target(), { taskId: 'task' })).code, 'CANCELLED');
  assert.equal((await bridge.resumeTask('task')).ok, true);
  assert.equal((await bridge.execute('click', { target: observed.result.target, ref: 'e0' }, { taskId: 'task' })).code, 'STALE_OBSERVATION');
  assert.equal((await bridge.execute('observe', target(), { taskId: 'task' })).ok, true);
});
test('detach and navigation invalidation refuse stale actions and late replies', async t => {
  const { bridge, wire, target } = await setup(t);
  const observed = await bridge.execute('observe', target(), { taskId: 'task' });
  wire.emit('message', 'client', { type: 'invalidated', tabId: 8, reason: 'navigation' });
  assert.equal((await bridge.execute('pause', { target: observed.result.target }, { taskId: 'task' })).code, 'STALE_OBSERVATION');
  wire.hold = true; const pending = bridge.execute('observe', target(), { taskId: 'task' });
  wire.emit('disconnected', 'client'); assert.equal((await pending).code, 'DETACHED');
});
