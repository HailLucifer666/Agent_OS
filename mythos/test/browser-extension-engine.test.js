'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createExtensionEngine } = require('../browser-extension/engine');
function fixture() {
  const calls = [], events = {}, frames = { id: 'f0', loaderId: 'doc', url: 'https://www.youtube.com/' };
  const listener = key => ({ addListener(fn) { events[key] = fn; } });
  const chrome = {
    tabs: { onRemoved: listener('removed'), query: async () => [{ id: 2, url: frames.url, active: true }, { id: 3, incognito: true }], get: async () => ({ id: 2, url: frames.url }), update: async (...x) => { calls.push(['update', ...x]); }, create: async x => { calls.push(['create', x]); return { id: 4, ...x }; } },
    debugger: { onDetach: listener('detach'), onEvent: listener('event'), attach: async (...x) => { calls.push(['attach', ...x]); }, detach: async (...x) => { calls.push(['detach', ...x]); }, sendCommand: async (target, method, args) => {
      calls.push([method, target, args]);
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { ...frames } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      if (method === 'Runtime.evaluate') return { result: { value: args.expression.startsWith('(function snapshot') ? { url: frames.url, items: [{ ref: 'e2', videoId: 'third', ordinal: 3 }], targets: [] } : args.expression.startsWith('(function playback') ? { url: frames.url, paused: false, currentTime: 2, ad: false } : { commandAccepted: true } } };
      return {};
    } },
  };
  const notifications = [];
  const engine = createExtensionEngine(chrome, { uuid: () => 'observation', notify: event => notifications.push(event) }); engine.welcome('browser');
  return { engine, calls, events, frames, notifications, target: { browserId: 'browser', tabId: 2, frameId: 0 } };
}
test('existing-browser tabs are observed, not switched or launched; createTab never navigates unrelated tab', async () => {
  const f = fixture(); assert.equal((await f.engine.execute('tabs', {}, 'task')).tabs.length, 1);
  const created = await f.engine.execute('createTab', { browserId: 'browser', url: 'https://www.youtube.com/' }, 'task');
  assert.equal(created.tabId, 4); assert.equal(created.browserId, 'browser'); assert.equal(f.calls.filter(x => x[0] === 'create').length, 1);
  assert.equal(f.calls.filter(x => x[0] === 'Page.navigate' || x[0] === 'update').length, 0);
});
test('observations use an isolated world and bind exact document; navigation rejects action before Runtime delivery', async () => {
  const f = fixture(), observation = await f.engine.execute('observe', f.target, 'task');
  assert.equal(observation.items[0].ref, 'e2'); assert.equal(observation.target.documentId, 'doc');
  assert.ok(f.calls.some(x => x[0] === 'Page.createIsolatedWorld'));
  const before = f.calls.filter(x => x[0] === 'Runtime.evaluate').length;
  f.frames.loaderId = 'replacement';
  await assert.rejects(f.engine.execute('click', { target: observation.target, ref: 'e2' }, 'task'), /Stale/);
  assert.equal(f.calls.filter(x => x[0] === 'Runtime.evaluate').length, before);
});
test('cancel detaches owned tab, rejects actions and supports explicit resume with fresh observation', async () => {
  const f = fixture(), observation = await f.engine.execute('observe', f.target, 'task');
  await f.engine.cancel('task');
  await assert.rejects(f.engine.execute('click', { target: observation.target, ref: 'e2' }, 'task'), /cancelled/);
  assert.ok(f.calls.some(x => x[0] === 'detach'));
  await f.engine.execute('resumeTask', {}, 'task'); assert.ok((await f.engine.execute('observe', f.target, 'task')).target);
});
test('subframes and non-http targets fail rather than falling back to another browser', async () => {
  const f = fixture(); await assert.rejects(f.engine.execute('observe', { ...f.target, frameId: 1 }, 'task'), /frame/);
  f.frames.url = 'chrome://settings'; await assert.rejects(f.engine.execute('observe', f.target, 'task'), /HTTP/);
  assert.equal(f.calls.filter(x => x[0] === 'attach').length, 0);
});
test('operator debugger detach blocks automatic reattach until trusted resume', async () => {
  const f = fixture(), observation = await f.engine.execute('observe', f.target, 'task');
  f.events.detach({ tabId: 2 }, 'canceled_by_user');
  await assert.rejects(f.engine.execute('observe', f.target, 'task'), /cancelled/);
  await assert.rejects(f.engine.execute('click', { target: observation.target, ref: 'e2' }, 'task'), /cancelled/);
  assert.equal(f.calls.filter(x => x[0] === 'attach').length, 1);
});
test('user takeover binding is scoped to attached isolated context and cancels the owning task', async () => {
  const f = fixture(); await f.engine.execute('observe', f.target, 'task');
  f.events.event({ tabId: 2 }, 'Runtime.bindingCalled', { name: '__mythosOperatorInput', executionContextId: 999, payload: '{"inputType":"pointerdown"}' });
  assert.equal(f.notifications.length, 0);
  f.events.event({ tabId: 2 }, 'Runtime.bindingCalled', { name: '__mythosOperatorInput', executionContextId: 7, payload: '{"inputType":"pointerdown"}' });
  assert.ok(f.notifications.some(x => x.type === 'user-takeover' && x.taskId === 'task'));
  await assert.rejects(f.engine.execute('observe', f.target, 'task'), /cancelled/);
});
