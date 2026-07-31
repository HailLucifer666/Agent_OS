'use strict';

// electron-adblock-fallback.test.js — ad blocking must survive an Electron that
// predates session.registerPreloadScript().
//
// From a real launch, 2026-07-31:
//   "adblocker init failed — continuing WITHOUT blocking (YouTube pre-rolls will
//    play): this.session.registerPreloadScript is not a function"
//
// @ghostery/adblocker-electron calls that API for COSMETIC filtering only; it
// arrived in Electron 35 and this app pins ^32. Its peerDependency is ">11", so
// npm never warned. Because enableBlockingInSession() does cosmetic AND network
// setup in one call, the throw took the network filters down with it — and those
// are the ones that stop pre-rolls (dist/commonjs/index.js:88-100 gates them
// separately).
//
// Source-shape guards, for the same reason as electron-talk-hotkey.test.js:
// electron/main.js requires the real `electron` module and calls whenReady() at
// load, so it cannot be require()d under a bare `node --test`.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'main.js'), 'utf8');

describe('Electron ad blocker degrades to network-only, not to nothing', () => {
  it('feature-detects registerPreloadScript instead of assuming it exists', () => {
    assert.match(MAIN, /typeof session\.defaultSession\.registerPreloadScript === 'function'/);
  });

  it('registers both network listeners on the fallback path', () => {
    assert.match(MAIN, /wr\.onBeforeRequest\(\{ urls: \['<all_urls>'\] \}, \(d, cb\) => blocker\.onBeforeRequest\(d, cb\)\)/);
    assert.match(MAIN, /wr\.onHeadersReceived\(\{ urls: \['<all_urls>'\] \}, \(d, cb\) => blocker\.onHeadersReceived\(d, cb\)\)/);
  });

  it('still prefers the full path when the API is available', () => {
    assert.match(MAIN, /blocker\.enableBlockingInSession\(session\.defaultSession\)/);
  });

  it('says which mode it is in, and names the Electron version when degraded', () => {
    // "enabled" with no qualifier would read as full blocking — the exact kind of
    // quiet half-capability this repo keeps having to unpick.
    assert.match(MAIN, /network \+ cosmetic/);
    assert.match(MAIN, /cosmetic filtering needs Electron >= 35/);
    assert.match(MAIN, /process\.versions\.electron/);
  });

  it('keeps the honest failure log for a genuine init failure', () => {
    assert.match(MAIN, /adblocker init failed — continuing WITHOUT blocking/);
  });
});
