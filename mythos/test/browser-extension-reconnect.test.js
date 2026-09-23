'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../browser-extension/background.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
// BUG-416 turned this fixture async and gave it two APIs it did not have.
//
// `connect()` now resolves the persisted instance id BEFORE opening the port,
// so no port exists until a microtask has run — every caller awaits `ready()`.
// And the fixture needs a REAL in-memory chrome.storage.local rather than a
// stub returning nothing: the whole point of BUG-416 is that the id survives a
// reconnect, and a storage that forgets would let a fix that mints a fresh UUID
// every time pass. `store` is exposed so a test can seed a corrupt value or
// assert what was written.
function fixture(overrides = {}) {
  const ports = [], timers = new Map(), calls = [], events = {};
  let timerId = 0, notify;
  const event = () => ({ addListener(fn) { this.emit = fn; } });
  const store = Object.assign(Object.create(null), overrides.storage || {});
  const engine = {
    welcome(id) { calls.push(['welcome', id]); },
    async execute(...args) { calls.push(['execute', ...args]); return overrides.execute ? overrides.execute(...args) : { accepted: true }; },
    async cancel(id) { calls.push(['cancel', id]); },
    async disconnect() { calls.push(['disconnect']); if (overrides.disconnect) await overrides.disconnect(); calls.push(['clean']); },
  };
  const chrome = { action: { onClicked: event() }, runtime: { id: 'test-extension', onStartup: event(), lastError: null,
    connectNative() {
      calls.push(['connect']);
      if (overrides.connectThrows) throw new Error('Native host unavailable');
      const port = { onMessage: event(), onDisconnect: event(), sent: [],
        postMessage(message) { this.sent.push(message); }, disconnect() { this.onDisconnect.emit(); } };
      ports.push(port); return port;
    },
  },
  storage: { local: {
    async get(key) { calls.push(['storage.get', key]); return key in store ? { [key]: store[key] } : {}; },
    async set(patch) { calls.push(['storage.set']); Object.assign(store, patch); },
  } } };
  vm.runInNewContext(source, { chrome, navigator: { brave: {} }, importScripts() {}, console,
    crypto: { randomUUID: () => (overrides.uuid ? overrides.uuid() : require('node:crypto').randomUUID()) },
    MythosBrowserEngine: { createExtensionEngine(_chrome, opts) { notify = opts.notify; return engine; } },
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  return { ports, timers, calls, chrome, events, store, notify: message => notify(message),
    // connect() resolves the persisted id before opening a port, so nothing
    // exists synchronously. Two ticks: one for the storage read, one for the
    // .then that opens the port.
    async ready() { await tick(); await tick(); return this; },
    // Firing the retry timer calls connect(), which now resolves the persisted
    // identity before opening a port — so the port and any follow-on timer
    // appear a microtask later, not synchronously. Awaiting here rather than at
    // every call site keeps that fact in one place.
    async fireTimer() { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn(); await tick(); await tick(); return timer.ms; } };
}

test('native disconnect reconnects after serialized cleanup without replaying or resuming tasks', async () => {
  const cleanup = deferred(), f = await fixture({ disconnect: () => cleanup.promise }).ready();
  f.ports[0].onMessage.emit({ type: 'welcome', browserId: 'old' });
  f.ports[0].onDisconnect.emit();
  await tick();
  f.chrome.action.onClicked.emit(); f.chrome.runtime.onStartup.emit();
  assert.equal(f.ports.length, 1, 'new welcome must not race old engine cleanup');
  assert.equal(f.timers.size, 0);
  cleanup.resolve(); await tick();
  assert.equal(f.timers.size, 1, 'backend restart needs automatic native reconnect');
  assert.equal(await f.fireTimer(), 500);
  assert.equal(f.ports.length, 2);
  f.ports[1].onMessage.emit({ type: 'welcome', browserId: 'new' });
  assert.ok(f.calls.findIndex(call => call[0] === 'clean') < f.calls.findLastIndex(call => call[0] === 'welcome'));
  assert.equal(f.calls.filter(call => call[0] === 'execute').length, 0, 'connection recovery must not auto-resume a task');
  assert.equal(f.ports[1].sent.length, 1);
  assert.equal(f.ports[1].sent[0].type, 'hello');
});

test('old command results and old port callbacks cannot reach a replacement native connection', async () => {
  const command = deferred(), f = await fixture({ execute: () => command.promise }).ready();
  const old = f.ports[0];
  old.onMessage.emit({ type: 'welcome', browserId: 'old' });
  old.onMessage.emit({ type: 'command', id: 'old-command', taskId: 'old-task', operation: 'click' });
  old.onDisconnect.emit(); await tick();
  assert.ok(f.calls.some(call => call[0] === 'cancel' && call[1] === 'old-task'), 'disconnect must revoke in-flight ownership');
  assert.equal(f.timers.size, 0, 'pending work must settle before reconnect can reuse the engine');
  command.resolve({ accepted: true }); await tick();
  await f.fireTimer();
  const fresh = f.ports[1];
  fresh.onMessage.emit({ type: 'welcome', browserId: 'fresh' });
  const before = f.calls.length;
  old.onMessage.emit({ type: 'welcome', browserId: 'stale' });
  old.onMessage.emit({ type: 'command', id: 'stale', taskId: 'old-task', operation: 'click' });
  old.onDisconnect.emit(); await tick();
  assert.equal(f.calls.length, before, 'obsolete port callbacks must be inert');
  assert.equal(fresh.sent.some(message => message.id === 'old-command'), false);
  assert.equal(old.sent.some(message => message.id === 'old-command'), false);
  f.notify({ type: 'invalidated', tabId: 1 });
  assert.equal(fresh.sent.at(-1).type, 'invalidated');
});

test('reconnect backoff stays below MV3 idle expiry and only a welcome resets it', async () => {
  const f = await fixture().ready();
  const delays = [];
  for (let attempt = 0; attempt < 9; attempt++) {
    f.ports.at(-1).onDisconnect.emit(); await tick();
    assert.equal(f.timers.size, 1);
    delays.push(await f.fireTimer());
  }
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000, 16000, 20000, 20000, 20000]);
  f.ports.at(-1).onMessage.emit({ type: 'welcome', browserId: 'recovered' });
  f.ports.at(-1).onDisconnect.emit(); await tick();
  assert.equal(await f.fireTimer(), 500);
});

test('synchronous native connection failure schedules bounded retry instead of killing the worker', async () => {
  const f = await fixture({ connectThrows: true }).ready();
  assert.equal(f.ports.length, 0);
  assert.equal(f.timers.size, 1);
  assert.equal(await f.fireTimer(), 500);
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].ms, 1000);
});
