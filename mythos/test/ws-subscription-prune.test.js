'use strict';

// REMEDIATION P1-6 (part 2): ws.js's subscribe(types, onEvent, opts) pushes a
// {types, replay} entry into module-level activeSubscriptions on every call
// (so a reconnect can resend it — see the FIX I entry above it), but the
// returned unsubscribe function never removed that entry. Every view that
// opens then closes (a panel, a widget) leaves a permanent stale entry —
// unbounded growth across the app's lifetime — and a reconnect resends an
// ever-growing list, including subscriptions for views that no longer exist.
//
// ws.js is a browser ES module (uses the global WebSocket + location) — this
// test stubs both with an in-memory FakeWebSocket (matching the real
// WebSocket API surface ws.js actually touches: readyState, OPEN/CONNECTING
// constants, addEventListener, send, close) before dynamically importing the
// real module, same pathToFileURL + import() pattern already established by
// test/hud-model.test.js. A cache-busting query string forces a fresh module
// instance (ESM modules are singleton-cached per resolved URL in Node).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this._listeners = {};
    this.sent = [];
    FakeWebSocket.lastInstance = this;
  }
  addEventListener(evt, cb) { (this._listeners[evt] = this._listeners[evt] || []).push(cb); }
  send(data) { this.sent.push(data); }
  close() { this.readyState = FakeWebSocket.CLOSED; this._fire('close'); }
  open() { this.readyState = FakeWebSocket.OPEN; this._fire('open'); }
  _fire(evt) { (this._listeners[evt] || []).slice().forEach((cb) => cb()); }
}
FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSING = 2;
FakeWebSocket.CLOSED = 3;

test("subscribe()'s returned unsubscribe prunes activeSubscriptions — a reconnect must not resend a closed view's subscription", async () => {
  const realWebSocket = global.WebSocket;
  const realLocation = global.location;
  global.WebSocket = FakeWebSocket;
  global.location = { protocol: 'http:', host: 'test.local' };

  try {
    const wsPath = path.join(__dirname, '..', 'ui', 'public', 'js', 'ws.js');
    const wsUrl = pathToFileURL(wsPath).href + '?t=' + Date.now() + Math.random();
    const wsMod = await import(wsUrl);

    // A permanent subscription (e.g. the HUD's always-on 'tick' listener).
    wsMod.subscribe(['tick'], () => {});
    FakeWebSocket.lastInstance.open();
    await new Promise((r) => setImmediate(r));

    // A transient panel that opens then immediately closes.
    const unsubscribe = wsMod.subscribe(['action'], () => {});
    unsubscribe();

    // Simulate a drop + reconnect (real backoff timer — starts at 500ms).
    const dropped = FakeWebSocket.lastInstance;
    dropped.close();
    await new Promise((resolve) => setTimeout(resolve, 700));

    const reconnected = FakeWebSocket.lastInstance;
    assert.notEqual(reconnected, dropped, 'a new socket must have been created on reconnect');
    reconnected.open();
    await new Promise((r) => setImmediate(r));

    const resentTypes = reconnected.sent
      .map((raw) => JSON.parse(raw))
      .filter((m) => m.type === 'subscribe')
      .map((m) => m.types.join(','));

    assert.ok(resentTypes.includes('tick'), 'the still-open subscription must be resent on reconnect');
    assert.ok(!resentTypes.includes('action'), "an unsubscribed view's subscription must NOT be resent on reconnect");
  } finally {
    global.WebSocket = realWebSocket;
    global.location = realLocation;
  }
});
