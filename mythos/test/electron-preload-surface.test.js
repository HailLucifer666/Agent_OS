'use strict';

// test/electron-preload-surface.test.js — §14 phase-8 gate (V2 spine).
//
// Asserts the Electron preload's contextBridge surface is EXACTLY
// { getKeyNames, setKey, hasKey } — no more, no fewer — and that each
// function forwards to its named IPC channel with the right args.
//
// Method: the repo's require-cache module-stubbing idiom (see
// test/from-calendar-google.test.js lines ~94-111), generalised so it works
// whether or not `electron` is npm-installed. When electron IS installed we
// seed the cache the classic way; when it is NOT installed (this machine: a
// plain `node --test` run with no `npm install`), `require.resolve('electron')`
// throws MODULE_NOT_FOUND before the cache is even consulted, so we additionally
// hook Module._resolveFilename to point `require('electron')` at a synthetic
// cache entry. Either path lands the same fake {contextBridge, ipcRenderer} in
// front of preload.js, which then exposes its surface for assertion. The hook
// and the cache seed are restored in finally.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const PRELOAD_PATH = require.resolve('../../electron/preload');
const FAKE_ELECTRON_FILE = 'mythos-test-fake-electron.js'; // synthetic cache key, no real file

// Installs a fake `electron` module export under a synthetic filename, then
// returns a restore() that undoes both the resolver hook and the cache seed.
function installElectronStub(stubExports) {
  const savedResolve = Module._resolveFilename;
  Module._resolveFilename = function (request) {
    if (request === 'electron') return FAKE_ELECTRON_FILE;
    return savedResolve.apply(this, arguments);
  };
  const prev = Module._cache[FAKE_ELECTRON_FILE];
  Module._cache[FAKE_ELECTRON_FILE] = {
    id: FAKE_ELECTRON_FILE, filename: FAKE_ELECTRON_FILE, loaded: true,
    exports: stubExports, children: [], paths: [],
  };
  // Force preload to re-evaluate against our stub.
  delete require.cache[PRELOAD_PATH];
  return function restore() {
    Module._resolveFilename = savedResolve;
    if (prev) Module._cache[FAKE_ELECTRON_FILE] = prev;
    else delete Module._cache[FAKE_ELECTRON_FILE];
    delete require.cache[PRELOAD_PATH];
  };
}

describe('§13/§14 phase-8: Electron preload contextBridge surface', () => {
  it('exposes exactly { getKeyNames, setKey, hasKey, onHotkey }, each forwarding to its named IPC channel', async () => {
    let exposedName = null;
    let exposedApi = null;
    const invokeCalls = [];
    const onCalls = [];
    const restore = installElectronStub({
      contextBridge: {
        exposeInMainWorld: (name, api) => { exposedName = name; exposedApi = api; },
      },
      ipcRenderer: {
        invoke: async (...args) => { invokeCalls.push(args); return { ok: true }; },
        on: (channel, handler) => { onCalls.push({ channel, handler }); },
      },
    });
    try {
      require(PRELOAD_PATH); // runs preload.js against the stub

      // exposeInMainWorld was called once, on a surface named 'mythos'.
      assert.equal(exposedName, 'mythos');
      assert.ok(exposedApi && typeof exposedApi === 'object', 'surface object must be exposed');

      // EXACT surface shape — sorted deep-equal, no more, no fewer.
      assert.deepEqual(
        Object.keys(exposedApi).sort(),
        ['getKeyNames', 'hasKey', 'onHotkey', 'setKey'],
        'preload must expose exactly getKeyNames/setKey/hasKey/onHotkey',
      );

      // setKey(name, value) → ipcRenderer.invoke('mythos:set-key', name, value)
      await exposedApi.setKey('GOOGLE_API_KEY', 'supersecret');
      assert.deepEqual(
        invokeCalls[invokeCalls.length - 1],
        ['mythos:set-key', 'GOOGLE_API_KEY', 'supersecret'],
        'setKey must invoke channel mythos:set-key with (name, value)',
      );

      // getKeyNames() → ipcRenderer.invoke('mythos:get-key-names')
      await exposedApi.getKeyNames();
      assert.deepEqual(
        invokeCalls[invokeCalls.length - 1],
        ['mythos:get-key-names'],
        'getKeyNames must invoke channel mythos:get-key-names',
      );

      // hasKey(name) → ipcRenderer.invoke('mythos:has-key', name)
      await exposedApi.hasKey('GOOGLE_API_KEY');
      assert.deepEqual(
        invokeCalls[invokeCalls.length - 1],
        ['mythos:has-key', 'GOOGLE_API_KEY'],
        'hasKey must invoke channel mythos:has-key with (name)',
      );

      // onHotkey(cb) subscribes to exactly one named channel. It is the only
      // main->renderer listener on the surface: the global push-to-talk
      // accelerator lives in the main process (a web page cannot claim one) and
      // has to reach the HUD somehow.
      const received = [];
      exposedApi.onHotkey((action) => received.push(action));
      assert.equal(onCalls.length, 1, 'onHotkey must subscribe to exactly one channel');
      assert.equal(onCalls[0].channel, 'mythos:hotkey');

      // The payload is re-derived as a plain string rather than forwarded, so a
      // structured (and therefore possibly secret-bearing) event cannot ride the
      // channel into the renderer — AD-8 applies to inbound events too.
      onCalls[0].handler({ senderId: 1 }, 'talk');
      assert.deepEqual(received, ['talk']);
      onCalls[0].handler({}, { value: 'a-secret-object' });
      assert.equal(typeof received[1], 'string', 'a non-string payload must be stringified, never passed through');
      assert.doesNotMatch(received[1], /a-secret-object/, 'object payloads must not leak their contents');

      // A non-function argument must be ignored rather than throwing or
      // registering a second listener.
      exposedApi.onHotkey('not-a-function');
      assert.equal(onCalls.length, 1);
    } finally {
      restore();
    }
  });
});
