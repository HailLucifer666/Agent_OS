'use strict';
// Filed 2026-09-09; replayed 2026-09-10. The two disconnects followed our own
// close_window calls. Mutation 2026-09-10: remove refusal -> attached PID closes.
// Same-date probes: remove offline announcement or remedy.needsInput -> red.
// Full-suite follow-up, same date: eager browser import breaks unrelated PC setup; probe fails.
// A click on X can still close it; offline notification + unavailable tools are
// the class fix. This guard only prevents the measured close_window mistake.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeCloseWindow } = require('../src/core/effectors/close-window-guard');
const { createConversationAnnouncer } = require('../src/core/conversation/announcer');
const { onOffline, notifyOffline } = require('../adapters/browser-agent/offline-notice');

test('constructing PC tools does not load the optional browser adapter', () => {
  const Module = require('node:module'), original = Module.prototype.require;
  Module.prototype.require = function(id) {
    if (id === '../../../adapters/browser-agent') throw Error('browser import before a close call');
    return original.apply(this, arguments);
  };
  try { assert.doesNotThrow(() => makeCloseWindow({ delegate() {}, fail() {}, implicitTarget: {} })); }
  finally { Module.prototype.require = original; }
});
test('one offline announcement then repeat-backoff; listener unsubscribes', () => {
  const spoken = [], events = [];
  const announcer = createConversationAnnouncer({ bus: { emit: (type, p) => events.push({ type, ...p }), subscribe: () => () => {} },
    config: {}, brain: { think: async () => ({ offline: true }) }, speak: text => spoken.push(text), now: () => 100000 });
  const stop = onOffline(({ reason }) => announcer._onHealthAnomaly({ payload: { kind: 'browser-automation-offline', reason } }));
  try { notifyOffline('Chrome disconnected unexpectedly.'); notifyOffline('Chrome disconnected unexpectedly.'); }
  finally { stop(); }
  assert.equal(spoken.length, 1);
  assert.ok(events.some(e => e.reason === 'repeat-backoff'));
  notifyOffline('Already unsubscribed'); assert.equal(spoken.length, 1);
});
test('attached pid refused before delegate; unrelated and OFFLINE still close', async () => {
  let online = true, delegated = [], queries = 0;
  const agent = { getStatus: () => ({ state: online ? 'ONLINE' : 'OFFLINE', cdpUrl: 'http://127.0.0.1:9222' }),
    processOnPort: port => { assert.equal(port, 9222); queries++; return { pid: 4360 }; } };
  const close = makeCloseWindow({ agent, readPid: () => null, delegate: async args => { delegated.push(args); return { ok: true }; },
    fail: result => ({ ok: false, result }), implicitTarget: { forgetIf() {} } });
  const refusal = await close({ pid: 4360 });
  assert.equal(refusal.ok, false); assert.equal(refusal.remedy.tool, 'browser_switch');
  assert.equal(delegated.length, 0);
  assert.equal((await close({ pid: 1234 })).ok, true); assert.equal(queries, 1, 'cached for 10 seconds');
  online = false; assert.equal((await close({ pid: 4360 })).ok, true); assert.equal(queries, 1);
});
test('pidfile is preferred over the process query', async () => {
  const close = makeCloseWindow({ agent: { getStatus: () => ({ state: 'ONLINE' }), processOnPort: () => { throw Error('not needed'); } },
    readPid: () => '4360', delegate: async () => { throw Error('must not close'); },
    fail: result => ({ ok: false, result }), implicitTarget: {} });
  const refusal = await close({ pid: '4360' });
  assert.equal(refusal.ok, false);
  assert.deepEqual(refusal.remedy.needsInput, ['browser']);
  const blocked = await require('../src/core/effectors/from-browser').browser_switch(refusal.remedy.args);
  assert.equal(blocked.ok, false); assert.match(String(blocked.result), /browser is required/);
});
