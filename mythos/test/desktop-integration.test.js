'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withBrowserDriver } = require('../src/core/effectors/browser-driver-tools');
const { createDesktopConnection, classify, outcomeText, conversationTools } = require('../server/desktop-connection');

test('extension-bound calls cannot switch silently to the legacy CDP profile', async () => {
  let legacy = 0;
  const tools = withBrowserDriver([{ name: 'browser_click', params: {}, fn: () => { legacy++; return { ok: true }; } }], { isDesktopTask: id => id === 'task' });
  const click = tools.find(t => t.name === 'browser_click').fn;
  assert.equal((await click({}, {})).ok, true);
  assert.equal((await click({ target: {} }, {})).ok, false);
  assert.equal((await click({}, { goalId: 'task' })).ok, false);
  assert.equal(legacy, 1);
});

test('extension leaves retain task, target and cancellation identity', async () => {
  const calls = [], abort = new AbortController();
  const tools = withBrowserDriver([], { isDesktopTask: id => id === 'task', getBridge: () => ({ execute: (...args) => { calls.push(args); return { ok: true, result: { commandAccepted: true } }; } }) });
  const target = { browserId: 'brave', tabId: 1, observationId: 'fresh' };
  await tools.find(t => t.name === 'browser_media_control').fn({ target, action: 'pause' }, { goalId: 'task', signal: abort.signal });
  assert.deepEqual(calls[0], ['mediaControl', { target, action: 'pause' }, { taskId: 'task', signal: abort.signal }]);
});

test('completed utterance classification prevents partial-task promotion', () => {
  assert.deepEqual(classify('Open YouTube and play the third video', false), { request: 'Open YouTube and play the third video' });
  assert.deepEqual(classify('Open YouTube and send an email', false), { unsupported: true });
  assert.deepEqual(classify('cancel it', false), { control: 'cancel' });
  assert.equal(classify('Why is the sky blue?', false), null);
  assert.deepEqual(classify('Do not open YouTube', false), { unsupported: true });
  assert.deepEqual(classify('Could you play the third video on YouTube?', false), { request: 'play the third video on YouTube' });
});

test('extension scroll translates legacy direction and unmapped leaves never switch profiles', async () => {
  const calls = []; let legacy = 0;
  const tools = withBrowserDriver(['browser_scroll', 'browser_type'].map(name => ({ name, params: {}, fn: () => { legacy++; return { ok: true }; } })), {
    isDesktopTask: id => id === 'task', getBridge: () => ({ execute: (...args) => { calls.push(args); return { ok: true }; } }),
  });
  const scroll = tools.find(t => t.name === 'browser_scroll').fn, type = tools.find(t => t.name === 'browser_type').fn;
  for (const direction of ['up', 'down']) await scroll({ direction, target: { tabId: 7 } }, { goalId: 'task' });
  assert.deepEqual(calls.map(call => call[1].deltaY), [-600, 600]);
  assert.equal((await scroll({ direction: 'sideways' }, { goalId: 'task' })).notExecuted, true);
  assert.equal((await type({}, { goalId: 'task' })).notExecuted, true);
  assert.equal((await type({ target: {} }, {})).notExecuted, true);
  assert.equal(legacy, 0); assert.equal(calls.length, 2);
  assert.equal((await type({}, {})).ok, true); assert.equal(legacy, 1);
});

test('task narration requires completed state and independent evidence', () => {
  for (const state of ['running', 'paused', 'blocked', 'cancelled']) {
    assert.doesNotMatch(outcomeText({ ok: true, result: { state, intent: { kind: 'play-third' } } }), /video is playing/);
  }
  assert.doesNotMatch(outcomeText({ ok: true, result: { state: 'completed', intent: { kind: 'play-third' } } }), /video is playing/);
  assert.match(outcomeText({ ok: true, result: { state: 'completed', intent: { kind: 'open-youtube' }, evidence: { oracle: 'page-state' } } }), /YouTube is open/);
});

test('conversation tool calls cannot bypass desktop task routing and receive explicit refusals', async () => {
  const executed = [], responses = [];
  await conversationTools([{ id: 'write', name: 'browser_click' }, { id: 'read', name: 'get_time' }], { sendToolResponse: r => responses.push(...r) }, { handleLiveToolCalls: calls => executed.push(...calls) });
  assert.deepEqual(executed.map(c => c.id), ['read']);
  assert.equal(responses[0].id, 'write');
  assert.equal(responses[0].response.status, 'blocked');
});

test('duplicate requests start once through the checked dispatch and cancellation suppresses late narration', async () => {
  const dispatched = [], said = [], frames = [], checks = [];
  let finish;
  const settled = new Promise(resolve => { finish = resolve; });
  const runtime = { bind() {}, unbind() {}, controller: { status: () => ({ ok: false }), settled: () => settled } };
  const router = createDesktopConnection({ runtime, connectionId: 'trusted', leash: { check: (d, c) => { checks.push(c); return { allow: true, tier: 1 }; } },
    dispatch: async (d, c) => { dispatched.push({ d, c }); return { ok: true, started: true, result: { taskId: 'task' } }; },
    reply: async () => {}, speak: async text => said.push(text), send: frame => frames.push(frame), historyAppend() {}, cancelSpeech() {} });
  const msg = { type: 'utterance', reqId: 'one', text: 'Open YouTube and play the third video' };
  router.handle(msg); router.handle(msg);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].c.connectionId, 'trusted');
  assert.equal(checks[0].connectionId, 'trusted');
  await router.stop();
  finish({ ok: true, result: { state: 'completed', intent: { kind: 'play-third' }, evidence: {} } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(said, []);
  await router.close();
});
