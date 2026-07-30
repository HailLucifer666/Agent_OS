'use strict';

// test/anti-drift-no-key-to-client.test.js — AD-8 regression gate.
//
// AD-8 (V2 spine §1): "Secrets never reach the renderer." The Electron preload
// (electron/preload.js) exposes a contextBridge surface over ipcRenderer.
// This gate exists because the renderer (the HUD, served at
// http://127.0.0.1:<port>) is remote-page content: any key value that reaches
// it is one XSS / renderer-compromise away from leaking every provider
// credential. So the surface rule is absolute:
//
//     The renderer must never see a key value — names + booleans only.
//
// What that requires of the preload:
//   1. No function on the surface whose name suggests it returns a VALUE:
//      no getKey / getValue / readKey / read / secret / decrypt. (A getter
//      that returns a value would defeat the entire point of the safeStorage
//      store — main.js keeps the decrypted values server-side, injecting them
//      only into the child process env at fork().)
//   2. setKey() must NOT echo the submitted value back in its resolved result —
//      it returns a status object (e.g. { ok: true }), never { value: ... }.
//
// This test is the regression gate: a future edit that adds a getKey() to the
// preload, or that returns the value from setKey(), will fail this file and
// block the commit via the pre-commit / CI gate.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const PRELOAD_PATH = require.resolve('../../electron/preload');
const FAKE_ELECTRON_FILE = 'mythos-test-fake-electron-ad8.js';

// Same install-agnostic require-cache stubbing idiom as
// electron-preload-surface.test.js — works whether or not `electron` is
// npm-installed (it is NOT installed on a bare `node --test` run here).
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
  delete require.cache[PRELOAD_PATH];
  return function restore() {
    Module._resolveFilename = savedResolve;
    if (prev) Module._cache[FAKE_ELECTRON_FILE] = prev;
    else delete Module._cache[FAKE_ELECTRON_FILE];
    delete require.cache[PRELOAD_PATH];
  };
}

describe('AD-8: no key value may cross the Electron preload bridge', () => {
  it('surface has no value-returning function and setKey never echoes the value', async () => {
    let exposedApi = null;
    const VALUE_SENTINEL = 'if-you-can-read-this-from-a-result-AD8-is-broken-' + Math.random();
    const restore = installElectronStub({
      contextBridge: {
        exposeInMainWorld: (_name, api) => { exposedApi = api; },
      },
      // ipcRenderer.invoke is what every surface function calls; we control its
      // return so we can prove setKey's result can't carry the value.
      ipcRenderer: {
        invoke: async () => ({ ok: true }),
      },
    });
    try {
      require(PRELOAD_PATH);
      assert.ok(exposedApi, 'preload exposed no surface at all');

      // 1. No function name may suggest it returns a key VALUE.
      const forbidden = ['getKey', 'getValue', 'readKey', 'read', 'secret', 'decrypt', 'getSecret'];
      const present = Object.keys(exposedApi).filter((k) =>
        forbidden.some((f) => k.toLowerCase() === f.toLowerCase()));
      assert.deepEqual(present, [],
        'preload surface must not expose a value-returning function (found: ' + present.join(', ') + ')');

      // 2. setKey's resolved result must NOT contain the value (by reference or
      //    substring). Even though our stub returns { ok: true } (the shape the
      //    real main-process handler returns), assert against the real risk: the
      //    result object has no property holding the value, and the value string
      //    does not appear anywhere in it.
      const result = await exposedApi.setKey('GOOGLE_API_KEY', VALUE_SENTINEL);
      const resultJson = JSON.stringify(result);
      assert.ok(
        !resultJson.includes(VALUE_SENTINEL),
        'setKey result must not echo the value back across the bridge: ' + resultJson,
      );
      assert.ok(
        !(result && Object.prototype.hasOwnProperty.call(result, 'value')),
        'setKey result must not carry a .value field',
      );
    } finally {
      restore();
    }
  });
});
