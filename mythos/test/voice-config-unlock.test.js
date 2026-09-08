'use strict';

// Offline lifecycle proof. The attended HUD probe additionally exercises app.js
// wiring, real DOM rendering, and browser cookie propagation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const ui = name => pathToFileURL(path.join(__dirname, '../ui/public/js', name)).href;
const response = (value, status = 200) => ({ ok: status === 200, status, json: async () => value });
const settle = () => new Promise(resolve => setImmediate(resolve));
const facts = {
  vad: { threshold: 0.2 },
  wakeword: { enabled: true, modelsPresent: true, threshold: 0.7 },
  s2s: { enabled: true, operatorEnabled: true },
};

test('voice configuration retries every protected fact after initial 401 and updates existing and late subscribers', async () => {
  const { createVoiceConfigStore } = await import(ui('voice/voice-config.js'));
  let unlocked = false;
  const calls = [], changes = [];
  const store = createVoiceConfigStore(async url => {
    calls.push(url);
    return unlocked ? response(facts[url.split('/').at(-1)]) : response({ error: 'Unauthorized' }, 401);
  });
  const unsubscribe = store.subscribe(value => changes.push(value));
  const initial = await store.refresh();
  for (const name of Object.keys(facts)) {
    assert.equal(initial[name].value, null);
    assert.equal(initial[name].error, 'HTTP 401');
  }
  unlocked = true;
  const current = await store.refresh();
  for (const name of Object.keys(facts)) {
    assert.deepEqual(current[name], { value: facts[name], error: null });
    assert.equal(calls.filter(url => url === '/api/config/' + name).length, 2);
  }
  assert.equal(changes.length, 2, 'mounted consumers must receive the successful retry');
  let late;
  const stopLate = store.subscribe(value => { late = value; });
  assert.equal(late, current, 'widgets mounted after unlock must receive current facts immediately');
  unsubscribe(); stopLate();
  await store.refresh();
  assert.equal(changes.length, 2, 'disposed consumers must not be updated');
});

test('late pre-unlock 401 cannot overwrite refreshed facts or resolve an old waiter with stale config', async () => {
  const { createVoiceConfigStore } = await import(ui('voice/voice-config.js'));
  const release = [], changes = [];
  let count = 0;
  const store = createVoiceConfigStore(url => {
    if (count++ < 3) return new Promise(resolve => release.push(() => resolve(response(null, 401))));
    return Promise.resolve(response(facts[url.split('/').at(-1)]));
  });
  store.subscribe(value => changes.push(value));
  const beforeUnlock = store.refresh();
  const current = await store.refresh();
  release.forEach(resolve => resolve());
  assert.equal(await beforeUnlock, current);
  assert.equal(await store.ready, current);
  assert.deepEqual(changes, [current], 'an older generation must never notify subscribers');
});

test('no-PIN boot obtains all voice facts without waiting for an unlock event', async () => {
  const { createVoiceConfigStore } = await import(ui('voice/voice-config.js'));
  const store = createVoiceConfigStore(async url => response(facts[url.split('/').at(-1)]));
  const loaded = await store.refresh();
  assert.equal(loaded.s2s.value.enabled, true);
  assert.equal(loaded.wakeword.value.modelsPresent, true);
  assert.equal(loaded.vad.value.threshold, 0.2);
});

test('malformed and unreachable facts remain unavailable while independent endpoints succeed', async () => {
  const { createVoiceConfigStore } = await import(ui('voice/voice-config.js'));
  const store = createVoiceConfigStore(async url => {
    if (url.endsWith('/vad')) throw new Error('connection reset');
    if (url.endsWith('/wakeword')) return response([]);
    return response({ enabled: false });
  });
  const loaded = await store.refresh();
  assert.deepEqual(loaded.vad, { value: null, error: 'connection reset' });
  assert.deepEqual(loaded.wakeword, { value: null, error: 'Invalid voice configuration' });
  assert.deepEqual(loaded.s2s, { value: { enabled: false }, error: null });
});

test('PIN component invokes refresh only after successful verification, not a wrong PIN or default boot', async t => {
  // Focus trapping has separate accessibility tests. Keep its unrelated DOM
  // dependency out of this component lifecycle fixture; execute real PIN logic.
  const source = readFileSync(new URL(ui('pin/pin-lock-screen.js')), 'utf8')
    .replace("import { trapFocus } from '../a11y/focus-trap.js';", 'const trapFocus = () => () => {};')
    .replace("'./pin-gate.js'", JSON.stringify(ui('pin/pin-gate.js')));
  const { mountPinLockScreen } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => previous ? Object.defineProperty(globalThis, 'document', previous) : delete globalThis.document);
  let overlay;
  globalThis.document = {
    querySelectorAll: () => [],
    createElement() {
      const controls = Object.fromEntries(['form', '.pin-input', '.pin-submit', '.pin-message'].map(key => [key, {
        value: '', focus() {}, addEventListener(type, callback) { this[type] = callback; },
      }]));
      overlay = { controls, setAttribute() {}, remove() {}, classList: { toggle() {} }, querySelector: key => controls[key] };
      return overlay;
    },
  };
  let accepted = false, unlocks = 0;
  const screen = mountPinLockScreen({ appendChild() {} }, {
    onUnlock: () => { unlocks++; },
    fetchImpl: async url => url.endsWith('/status') ? response({ configured: true })
      : accepted ? response({ ok: true }) : response({ error: 'Incorrect PIN.' }, 401),
  });
  t.after(() => screen.cleanup());
  await settle();
  assert.equal(screen.lockState(), 'locked');
  overlay.controls['.pin-input'].value = '1234';
  overlay.controls.form.submit({ preventDefault() {} });
  await settle();
  assert.equal(unlocks, 0);
  assert.equal(screen.lockState(), 'locked');
  assert.equal(overlay.controls['.pin-message'].textContent, 'Incorrect PIN.');
  accepted = true;
  overlay.controls['.pin-input'].value = '5678';
  overlay.controls.form.submit({ preventDefault() {} });
  await settle();
  assert.equal(unlocks, 1);
  assert.equal(screen.lockState(), 'unlocked');
  assert.equal(overlay.controls['.pin-input'].value, '', 'PIN must not remain in the input');
  const noPin = mountPinLockScreen({ appendChild() { assert.fail('no PIN must not render a lock'); } }, {
    onUnlock: () => { unlocks++; }, fetchImpl: async () => response({ configured: false }),
  });
  await settle();
  assert.equal(noPin.lockState(), 'unlocked');
  assert.equal(unlocks, 1, 'default boot is independent of successful-PIN callback');
  noPin.cleanup();
});

test('successful unlock reconnects immediately without duplicate OPEN or CONNECTING sockets', async t => {
  const names = ['WebSocket', 'location', 'setTimeout'];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => names.forEach(name => previous.get(name)
    ? Object.defineProperty(globalThis, name, previous.get(name)) : delete globalThis[name]));
  const sockets = [], timers = [];
  globalThis.location = { protocol: 'http:', host: '127.0.0.1:9999' };
  globalThis.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length; };
  globalThis.WebSocket = class {
    static OPEN = 1; static CONNECTING = 0;
    constructor() { this.readyState = 0; this.events = {}; sockets.push(this); }
    addEventListener(name, callback) { this.events[name] = callback; }
    send() {}
  };
  const ws = await import(ui('ws.js') + '?pin-unlock-regression');
  ws.reconnectAfterUnlock();
  assert.equal(sockets.length, 1);
  ws.reconnectAfterUnlock();
  assert.equal(sockets.length, 1, 'connecting handshake must not be duplicated');
  sockets[0].readyState = 1;
  sockets[0].events.open();
  sockets[0].readyState = 3;
  sockets[0].events.close();
  assert.equal(timers.length, 1);
  ws.reconnectAfterUnlock();
  assert.equal(sockets.length, 2, 'unlock must not wait for previously scheduled reconnect');
  sockets[1].readyState = 1;
  sockets[1].events.open();
  ws.reconnectAfterUnlock();
  timers[0].callback();
  assert.equal(sockets.length, 2, 'old backoff and repeated unlock must preserve the open socket');
  assert.equal(ws.getState().state, 'open');
});

function socketFixture(t) {
  const names = ['WebSocket', 'location', 'setTimeout', 'fetch'];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => names.forEach(name => previous.get(name)
    ? Object.defineProperty(globalThis, name, previous.get(name)) : delete globalThis[name]));
  const sockets = [], timers = [];
  globalThis.location = { protocol: 'http:', host: '127.0.0.1:9999' };
  globalThis.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length; };
  globalThis.WebSocket = class {
    static OPEN = 1; static CONNECTING = 0;
    constructor() { this.readyState = 0; this.events = {}; sockets.push(this); }
    addEventListener(name, callback) { this.events[name] = callback; }
    send() {}
    open() { this.readyState = 1; this.events.open(); }
    close() { this.readyState = 3; this.events.close(); }
  };
  return { sockets, timers };
}

test('late unauthorized probe from before unlock cannot mark the authenticated socket unauthorized', async t => {
  const { sockets, timers } = socketFixture(t);
  let finishProbe;
  globalThis.fetch = () => new Promise(resolve => { finishProbe = resolve; });
  const ws = await import(ui('ws.js') + '?pin-late-auth-probe');
  ws.sendMessage({ type: 'subscribe', types: ['entity-state'] });
  for (let i = 0; i < 3; i++) {
    sockets.at(-1).close();
    if (i < 2) timers.at(-1).callback();
  }
  assert.equal(typeof finishProbe, 'function', 'three refused sockets must exercise a real auth probe');
  ws.reconnectAfterUnlock();
  sockets.at(-1).open();
  assert.equal(ws.getState().state, 'open');
  finishProbe(response(null, 401));
  await settle();
  assert.equal(ws.getState().state, 'open', 'pre-unlock HTTP result must not overwrite post-unlock connection evidence');
  sockets.at(-1).close();
  assert.equal(timers.at(-1).delay, 500, 'stale refusal must not restore the minute-long unauthorized backoff');
});

test('unlock during a pre-cookie handshake retries immediately when that old handshake is refused', async t => {
  const { sockets, timers } = socketFixture(t);
  globalThis.fetch = async () => response(null, 401);
  const ws = await import(ui('ws.js') + '?pin-connecting-unlock');
  ws.sendMessage({ type: 'subscribe', types: ['entity-state'] });
  for (let i = 0; i < 3; i++) {
    sockets.at(-1).close();
    await settle();
    timers.at(-1).callback();
  }
  assert.equal(sockets.at(-1).readyState, WebSocket.CONNECTING);
  const before = sockets.length;
  ws.reconnectAfterUnlock();
  assert.equal(sockets.length, before, 'never run two handshakes concurrently');
  sockets.at(-1).close();
  assert.equal(sockets.length, before + 1, 'cookie installation must not be lost behind an old connecting socket');
  sockets.at(-1).open();
  sockets.at(-1).close();
  assert.equal(sockets.length, before + 1, 'unlock retry is one-shot, not a permanent reconnect loop');
  assert.equal(timers.at(-1).delay, 500);
});

test('mounted voice widget repaints refreshed S2S facts and threshold, then unsubscribes on disposal', async t => {
  const names = ['document', 'window', 'Node', 'MutationObserver', 'fetch'];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => names.forEach(name => previous.get(name)
    ? Object.defineProperty(globalThis, name, previous.get(name)) : delete globalThis[name]));
  class Element {
    constructor(text = '') { this.children = []; this.dataset = {}; this.content = text; }
    setAttribute() {}
    appendChild(node) { this.children.push(node); node.parent = this; }
    replaceChildren(...nodes) { this.children = []; nodes.forEach(node => this.appendChild(node)); }
    insertBefore(node, before) {
      if (node.parent) node.remove();
      const index = this.children.indexOf(before);
      this.children.splice(index < 0 ? this.children.length : index, 0, node); node.parent = this;
    }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    get firstChild() { return this.children[0]; }
    get lastChild() { return this.children.at(-1); }
    get nextSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1]; }
    set textContent(value) { this.content = value; this.children = []; }
    get textContent() { return this.content + this.children.map(child => child.textContent).join(''); }
  }
  globalThis.Node = Element;
  const root = new Element();
  root.dataset = { wakeword: 'listening', wakewordPeak: '0.4' };
  globalThis.document = {
    documentElement: root, getElementById: () => null,
    createElement: () => new Element(), createTextNode: text => new Element(text),
  };
  globalThis.window = { speechSynthesis: {} };
  let disconnected = 0;
  globalThis.MutationObserver = class { observe() {} disconnect() { disconnected++; } };
  let unlocked = false;
  globalThis.fetch = async url => unlocked ? response(facts[url.split('/').at(-1)]) : response(null, 401);
  const { voiceConfiguration } = await import(ui('voice/voice-config.js'));
  const { mountVoice } = await import(ui('widgets/kinds/voice.js'));
  await voiceConfiguration.refresh();
  const host = new Element();
  const dispose = mountVoice(host, {});
  t.after(dispose);
  const row = key => host.children[1].children.find(node => node.dataset.key === key).lastChild.textContent;
  assert.equal(row('s2s'), 'unavailable');
  assert.equal(row('synthesis'), 'available', 'S2S facts must not overwrite browser TTS row');
  unlocked = true;
  await voiceConfiguration.refresh();
  assert.equal(row('s2s'), 'enabled');
  assert.match(row('wakeword'), /peak 0\.40 \/ 0\.7$/);
  assert.equal(row('synthesis'), 'available');
  dispose();
  assert.equal(disconnected, 1);
  unlocked = false;
  await voiceConfiguration.refresh();
  assert.equal(row('s2s'), 'enabled', 'disposed widget must not receive later state changes');
});
