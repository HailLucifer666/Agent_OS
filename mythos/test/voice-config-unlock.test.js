'use strict';

// Offline lifecycle proof. The attended HUD probe additionally exercises app.js
// wiring, real DOM rendering, and browser cookie propagation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const ui = name => pathToFileURL(path.join(__dirname, '../ui/public/js', name)).href;
const response = (value, status = 200) => ({ ok: status === 200, status, json: async () => value });
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

// 2026-09-23: four tests of the PIN screen's refresh-after-unlock and of
// ws.reconnectAfterUnlock() were deleted with the PIN. A remote browser that signs
// in with the token reloads the page (auth-gate.js), so no socket is re-driven.

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
