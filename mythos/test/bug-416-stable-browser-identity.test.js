'use strict';

// bug-416-stable-browser-identity.test.js — BUG-416.
//
// THE DEFECT, traced through source 2026-09-09 (not reproduced live: the
// desktop operator is not set up on this checkout, and the ticket says so).
//
// The bridge minted `randomUUID()` on every `hello`. The desktop controller
// persists its target — `save(id, { target })` in src/core/desktop/controller.js
// — and on resume calls `browser_video_list` with the browserId inside it.
// After a backend restart the bridge looks that id up among live clients, does
// not find it, and answers BROWSER_REQUIRED, "Choose an observed connected
// browser". observe() retries three times and blocks with that reason. So the
// reconnection shipped in 8afc989 restores the PIPE and can never restore the
// TASK, and it names the wrong cause — the operator is told to choose a browser
// that is already connected.
//
// WHY NOTHING SAW IT (/kee class 3). Every controller rig returns a fixed
// `browserId: 'b'` or `'brave'` and never checks the one it is handed, so the
// resume tests pass AROUND the bridge. The fixture was more generous than the
// wire.
//
// AND THE SAME CLASS BIT THE FIX ITSELF, WHICH IS THE MOST USEFUL THING HERE.
// The first pass had the extension persisting an id and the bridge requiring
// one, with every unit test green — and it could not have worked in production
// for one line. electron/native-browser-host.cs does not FORWARD the hello: it
// rebuilds it from an allowlist of four fields, deliberately, because the frame
// comes from a browser extension. `instanceId` was not on that list, so the
// host would have stripped it and the bridge would have refused every real
// connection as identity-invalid. Nothing in the unit suite could see it —
// those tests inject into the bridge directly. Only the compiled-host test,
// which spawns the real exe, went red. The host now validates and passes the id
// through, and the two validators agree by construction (Guid.TryParseExact "D"
// against the same 8-4-4-4-12 shape).
//
// MUTATION PROBES, run 2026-09-09, all landed, all fired, no survivors; sources
// restored by byte copy with matching hashes:
//   (m1) the bridge falls back to randomUUID() when instanceId is absent
//        -> fails (b) "an identity-less hello is refused"
//   (m2) the collision check is removed
//        -> fails (c) "a second client claiming a live id is refused"
//   (m3) the collision closes the FIRST client instead of the newcomer
//        -> fails (c)'s "the running session is untouched" half
//   (m4) the extension mints a fresh id instead of reading storage
//        -> fails (a) "the same id survives a reconnect"
//   (m5) protocol 1 is accepted
//        -> fails (d) "an old extension is refused, loudly"

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createBrowserExtensionBridge } = require('../adapters/browser-extension');
const { tempVaultDir, cleanupVaultDir } = require('./helpers');

const ID = 'a'.repeat(32);
const INSTANCE = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function bridgeRig(t) {
  const dir = tempVaultDir();
  const wire = new EventEmitter();
  const closed = [];
  const events = [];
  wire.start = async () => ({ sid: 'fixture', sddl: 'fixture' });
  wire.stop = async () => {};
  wire.close = (id) => { closed.push(id); wire.emit('disconnected', id); };
  wire.send = () => {};
  const bus = { emit: (type, fields) => events.push([type, fields]) };
  const bridge = createBrowserExtensionBridge({
    runtimeDir: path.resolve(dir), allowedExtensionIds: [ID], bus,
    transportFactory: () => wire, requestTimeoutMs: 500,
  });
  await bridge.start();
  t.after(async () => { await bridge.stop(); cleanupVaultDir(dir); });
  const hello = (clientId, patch) => wire.emit('message', clientId, Object.assign(
    { type: 'hello', protocol: 2, instanceId: INSTANCE, extensionId: ID, browserName: 'brave' }, patch));
  return { bridge, wire, closed, events, hello };
}

test('BUG-416 (a) — the browser keeps ONE identity across reconnects', async (t) => {
  const { bridge, wire, hello } = await bridgeRig(t);
  hello('first');
  const before = bridge.getStatus().browsers.map((b) => b.browserId ?? b);
  assert.deepEqual(before, [INSTANCE],
    'the bridge adopts the extension identity instead of minting one');

  wire.emit('disconnected', 'first');
  assert.equal(bridge.getStatus().browsers.length, 0);

  hello('second');
  const after = bridge.getStatus().browsers.map((b) => b.browserId ?? b);
  assert.deepEqual(after, [INSTANCE],
    'a task that persisted this browserId can still address it after a restart — '
    + 'which is the whole ticket: before, the reconnect restored the pipe and orphaned the task');
});

test('BUG-416 (b) — an identity-less or malformed hello is refused, not defaulted', async (t) => {
  // (m1). A fallback to randomUUID here would rebuild the bug behind a
  // mechanism that looks like it works.
  for (const patch of [
    { instanceId: undefined }, { instanceId: '' }, { instanceId: 'not-a-uuid' },
    { instanceId: 42 }, { instanceId: INSTANCE.replace(/-/g, '') },
  ]) {
    const { bridge, closed, events, hello } = await bridgeRig(t);
    hello('client', patch);
    assert.equal(bridge.getStatus().browsers.length, 0,
      'instanceId ' + JSON.stringify(patch.instanceId) + ' must not register a browser');
    assert.deepEqual(closed, ['client']);
    assert.ok(events.some(([type]) => type === 'browser.extension.identity-invalid'),
      'a closed pipe with no reason is indistinguishable from a crash, and the extension '
      + 'retries on its own backoff — so a silent refusal loops invisibly forever');
  }
});

test('BUG-416 (c) — a second client claiming a live identity is refused, and the first is untouched', async (t) => {
  // (m2) and (m3). A duplicate can only be a cloned profile or a second copy of
  // the extension. Handing it the running session's identity would let it
  // inherit task ownership and observations.
  const { bridge, closed, events, hello } = await bridgeRig(t);
  hello('running');
  assert.equal(bridge.getStatus().browsers.length, 1);

  hello('clone');
  assert.deepEqual(closed, ['clone'],
    'the NEWCOMER is closed; closing the running session would kill a task mid-flight');
  assert.equal(bridge.getStatus().browsers.length, 1, 'and the running session survives');
  const collision = events.find(([type]) => type === 'browser.extension.collision');
  assert.ok(collision, 'a real clone must be visible rather than mysterious');
  assert.equal(collision[1].browserId, INSTANCE);

  // The adjacent case that must keep passing: a DIFFERENT browser is welcome.
  // Refusing every second client would break the two-browser case entirely.
  hello('other-browser', { instanceId: OTHER });
  assert.equal(bridge.getStatus().browsers.length, 2,
    'the refusal is scoped to a duplicate identity, not to a second browser');
});

test('BUG-416 (d) — an extension speaking the old protocol is refused, loudly', async (t) => {
  // (m5). The extension ships from this repo with the bridge, so there is no
  // third-party client to keep working, and an old extension silently falling
  // back to random identities would rebuild the bug behind a version number.
  const { bridge, closed, events, hello } = await bridgeRig(t);
  hello('old', { protocol: 1, instanceId: undefined });
  assert.equal(bridge.getStatus().browsers.length, 0);
  assert.deepEqual(closed, ['old']);
  const mismatch = events.find(([type]) => type === 'browser.extension.protocol-mismatch');
  assert.ok(mismatch, 'the reason must reach the bus, or the reload is unguessable');
  assert.equal(mismatch[1].got, 1);
  assert.equal(mismatch[1].want, 2);
});

test('BUG-416 (a2) — the extension persists its identity, and reuses what it finds', async () => {
  // (m4), driven against the real background.js in a VM. A fresh UUID per
  // connection is the defect; the storage read is the fix, and this is the only
  // place it is observable.
  const source = fs.readFileSync(path.join(__dirname, '../browser-extension/background.js'), 'utf8');
  const store = Object.create(null);
  const ports = [];
  let minted = 0;
  const event = () => ({ addListener(fn) { this.emit = fn; } });
  const chrome = {
    action: { onClicked: event() },
    runtime: {
      id: 'test-extension', onStartup: event(), lastError: null,
      connectNative() {
        const port = { onMessage: event(), onDisconnect: event(), sent: [],
          postMessage(m) { this.sent.push(m); }, disconnect() { this.onDisconnect.emit(); } };
        ports.push(port); return port;
      },
    },
    storage: { local: {
      async get(key) { return key in store ? { [key]: store[key] } : {}; },
      async set(patch) { Object.assign(store, patch); },
    } },
  };
  vm.runInNewContext(source, {
    chrome, navigator: { brave: {} }, importScripts() {}, console,
    crypto: { randomUUID: () => { minted += 1; return INSTANCE; } },
    MythosBrowserEngine: { createExtensionEngine: () => ({
      welcome() {}, async execute() { return {}; }, async cancel() {}, async disconnect() {},
    }) },
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout() {},
  });
  await tick(); await tick();

  assert.equal(ports.length, 1);
  assert.equal(ports[0].sent[0].type, 'hello');
  assert.equal(ports[0].sent[0].protocol, 2, 'the bridge refuses anything else');
  assert.equal(ports[0].sent[0].instanceId, INSTANCE);
  assert.equal(store.mythosInstanceId, INSTANCE,
    'the id is WRITTEN, or it is lost the moment the MV3 worker idles out at 30s');
  assert.equal(minted, 1, 'first run has nothing stored, so exactly one id is minted');
});

test('BUG-416 — a stored identity is reused rather than replaced', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../browser-extension/background.js'), 'utf8');
  const store = { mythosInstanceId: OTHER };
  const ports = [];
  let minted = 0;
  const event = () => ({ addListener(fn) { this.emit = fn; } });
  const chrome = {
    action: { onClicked: event() },
    runtime: { id: 'test-extension', onStartup: event(), lastError: null,
      connectNative() {
        const port = { onMessage: event(), onDisconnect: event(), sent: [],
          postMessage(m) { this.sent.push(m); }, disconnect() { this.onDisconnect.emit(); } };
        ports.push(port); return port;
      } },
    storage: { local: {
      async get(key) { return key in store ? { [key]: store[key] } : {}; },
      async set(patch) { Object.assign(store, patch); },
    } },
  };
  vm.runInNewContext(source, {
    chrome, navigator: {}, importScripts() {}, console,
    crypto: { randomUUID: () => { minted += 1; return INSTANCE; } },
    MythosBrowserEngine: { createExtensionEngine: () => ({
      welcome() {}, async execute() { return {}; }, async cancel() {}, async disconnect() {},
    }) },
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout() {},
  });
  await tick(); await tick();

  assert.equal(ports[0].sent[0].instanceId, OTHER, 'a browser that has connected before keeps its identity');
  assert.equal(minted, 0, '(m4) minting here is the defect — the stored value must win');
  assert.equal(store.mythosInstanceId, OTHER, 'and it is not rewritten');
});

test('BUG-416 — a corrupt stored identity is replaced, not carried forward', async () => {
  // The adjacent case. The bridge refuses anything not UUID-shaped, so keeping a
  // bad stored value would produce a silent reconnect loop forever.
  const source = fs.readFileSync(path.join(__dirname, '../browser-extension/background.js'), 'utf8');
  const store = { mythosInstanceId: 'garbage-from-an-older-build' };
  const ports = [];
  const event = () => ({ addListener(fn) { this.emit = fn; } });
  const chrome = {
    action: { onClicked: event() },
    runtime: { id: 'test-extension', onStartup: event(), lastError: null,
      connectNative() {
        const port = { onMessage: event(), onDisconnect: event(), sent: [],
          postMessage(m) { this.sent.push(m); }, disconnect() { this.onDisconnect.emit(); } };
        ports.push(port); return port;
      } },
    storage: { local: {
      async get(key) { return key in store ? { [key]: store[key] } : {}; },
      async set(patch) { Object.assign(store, patch); },
    } },
  };
  vm.runInNewContext(source, {
    chrome, navigator: {}, importScripts() {}, console,
    crypto: { randomUUID: () => INSTANCE },
    MythosBrowserEngine: { createExtensionEngine: () => ({
      welcome() {}, async execute() { return {}; }, async cancel() {}, async disconnect() {},
    }) },
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout() {},
  });
  await tick(); await tick();

  assert.equal(ports[0].sent[0].instanceId, INSTANCE);
  assert.equal(store.mythosInstanceId, INSTANCE, 'the bad value is overwritten so it cannot loop again');
});

test('BUG-416 — the extension needs the storage permission it now depends on', () => {
  // Without "storage" in the manifest, chrome.storage is undefined, the try/catch
  // in ensureInstanceId falls through, and a FRESH id is minted on every
  // connection — the original bug, wearing the fix's clothes and passing every
  // test above, because those inject a working storage. One manifest edit away.
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../browser-extension/manifest.json'), 'utf8'));
  assert.ok(manifest.permissions.includes('storage'),
    'ensureInstanceId reads chrome.storage.local, which MV3 gates behind this permission');
});

test('BUG-416 — the host and the bridge agree on the identity shape', () => {
  // Two validators for one fact. The C# host checks Guid.TryParseExact(id, "D")
  // at the trust boundary and the bridge re-checks with a regex; if they ever
  // disagree, a frame that passes one is refused by the other and the failure is
  // a silent reconnect loop. Pinned as source shape because the C# side cannot
  // be imported here.
  const cs = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'native-browser-host.cs'), 'utf8');
  assert.match(cs, /Guid\.TryParseExact\(instanceId, "D", out parsedInstance\)/,
    'the host must validate the id at the edge, before anything reaches the pipe');
  assert.match(cs, /\{ "instanceId", instanceId \}/,
    'and it must PASS IT THROUGH — the host rebuilds hello from an allowlist, and '
    + 'omitting it here is what made the first pass of this fix unable to work at all');
  assert.match(cs, /!Equals\(Value\(message, "protocol"\), 2\)/,
    'the host and the bridge must require the same protocol number');
});
