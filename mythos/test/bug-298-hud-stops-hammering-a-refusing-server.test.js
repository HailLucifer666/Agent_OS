'use strict';

// test/bug-298-hud-stops-hammering-a-refusing-server.test.js — BUG-298.
//
// BUG-292's SECOND HALF, and the client is named now.
//
// BUG-292 shipped a caller fingerprint on every ws-upgrade-rejected log because
// 147 identical "bad or missing token" lines could not say WHICH client was
// retrying. The answer did not need the fingerprint in the end — the live log
// carries enough to identify it by arithmetic:
//
//   %APPDATA%/MYTHOS/mythos-server.log
//   147 rejections, ALL of them 2026-08-19T15:23:04.462Z .. 15:44:33.465Z
//   = 1289 seconds / 147 attempts = one attempt every ~8.8 seconds
//   and the line immediately preceding the first one is `server.listening`.
//
// ui/public/js/ws.js:7 sets `BACKOFF_MAX_MS = 8000`. A saturated 8s backoff plus
// the handshake round-trip is ~8.8s. THE CLIENT IS THE HUD ITSELF — it starts
// hammering the moment the server comes up, because `wsUrl()` builds
// `ws://host/ws` with no `?token=`, and a browser cannot set an Authorization
// header on a WebSocket upgrade. With MYTHOS_AUTH_TOKEN configured there is no
// channel through which the HUD can authenticate at all.
//
// ws.js's own header comment already diagnosed this and says the fix was
// "purely additive — reconnect behaviour below is untouched". That is the half
// still open: the socket now EXPOSES its state, and still retries forever.
//
// WHAT THIS DOES NOT DO. It does not loosen verifyClient, and it must not:
// MYTHOS_AUTH_TOKEN is mandatory for the phone node, and the server is refusing
// correctly. It does not invent an auth channel for the HUD either — that is a
// real feature (the PIN session in tokenOk() is the intended one) and not
// something to improvise inside a retry-loop fix.
//
// It does the one thing that is unambiguously the client's own defect: tell
// "the server is down" apart from "the server is up and refusing me", stop
// hammering in the second case, and say so out loud instead of looking frozen.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WS_PATH = path.join(__dirname, '..', 'ui', 'public', 'js', 'ws.js');

const realWebSocket = global.WebSocket;
const realFetch = global.fetch;
const realLocation = global.location;

// Minimal WebSocket stand-in. Records every construction so "how many times did
// the HUD try" is a count, not an inference.
function installFakeWebSocket(sockets) {
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.listeners = new Map();
      sockets.push(this);
    }

    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }

    send() {}

    close() { this.fire('close'); }

    fire(type, ev) {
      const set = this.listeners.get(type);
      if (set) set.forEach((fn) => fn(ev || {}));
    }

    // What the browser actually does to a rejected upgrade: the handshake fails,
    // there is no close code worth reading, and the socket simply closes.
    rejectUpgrade() {
      this.readyState = FakeWebSocket.CLOSED;
      this.fire('close', { code: 1006 });
    }
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSED = 3;
  global.WebSocket = FakeWebSocket;
  return FakeWebSocket;
}

// Each test needs its own module state: ws.js keeps `backoffMs`,
// `consecutiveFailures` and the socket at module scope, and ESM caches by URL.
let moduleSeq = 0;
async function freshWs() {
  moduleSeq += 1;
  return import(`${pathToFileURL(WS_PATH).href}?bug298=${moduleSeq}`);
}

// Captures scheduled reconnects instead of running them. Deliberately does NOT
// auto-fire: an earlier version did, and a module instance from a FINISHED test
// went on reconnecting into the next test's arrays — the unauthorized test's
// 60000ms delay turned up inside the "server is merely down" test and looked
// exactly like a product defect. ESM caches per URL and ws.js keeps its state at
// module scope, so a stale instance is still live; the only reliable fix is to
// let nothing run unless this test asks for it.
function installCapturingTimers(pendingDelays, pendingCallbacks) {
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => {
    pendingDelays.push(ms);
    pendingCallbacks.push(fn);
    return 0;
  };
  return () => { global.setTimeout = realSetTimeout; };
}

describe('BUG-298 — the HUD stops hammering a server that is refusing it', () => {
  let sockets;
  let delays;
  let callbacks;
  let restoreTimers;
  let fetchCalls;

  beforeEach(() => {
    sockets = [];
    delays = [];
    callbacks = [];
    fetchCalls = [];
    installFakeWebSocket(sockets);
    global.location = { protocol: 'http:', host: '127.0.0.1:4999' };
    restoreTimers = installCapturingTimers(delays, callbacks);
  });

  afterEach(() => {
    restoreTimers();
    global.WebSocket = realWebSocket;
    global.fetch = realFetch;
    global.location = realLocation;
  });

  function stubProbe(status) {
    global.fetch = async (url, opts) => {
      fetchCalls.push({ url: String(url), opts });
      if (status === 'unreachable') throw new TypeError('Failed to fetch');
      return { ok: status < 400, status };
    };
  }

  async function rejectTimes(ws, n) {
    for (let i = 0; i < n; i += 1) {
      // Run the previous iteration's reconnect at the TOP, not the bottom, so the
      // loop ends on a close rather than on a fresh connect(). Otherwise the last
      // observable state is always 'connecting' and every state assertion below
      // would be about the retry rather than about the refusal.
      if (i > 0) {
        const next = callbacks.pop();
        callbacks.length = 0;
        if (next) next();
      }
      const s = sockets[sockets.length - 1];
      if (!s) break;
      s.rejectUpgrade();
      // Let the probe's promise chain settle, so the 401 verdict is in hand by
      // the time the following reconnect is scheduled.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    }
  }

  it('the premise: the HUD sends no credential, so the server is right to refuse it', async () => {
    // Guard the diagnosis itself. If a token ever IS attached, this whole ticket
    // changes shape and should be re-derived rather than silently kept passing.
    stubProbe(401);
    const ws = await freshWs();
    ws.onBroadcast('tick', () => {});
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].url, 'ws://127.0.0.1:4999/ws');
    assert.doesNotMatch(sockets[0].url, /token=/,
      'a browser cannot set an Authorization header on a WS upgrade, and no ?token= is added — '
      + 'this is why 147 upgrades were refused');
  });

  it('a refusing server is diagnosed over HTTP and reported as unauthorized', async () => {
    stubProbe(401);
    const ws = await freshWs();
    const seen = [];
    ws.onStateChange((s) => seen.push(s.state));
    ws.onBroadcast('tick', () => {});
    await rejectTimes(ws, 4);
    assert.ok(fetchCalls.length > 0,
      'the socket close alone cannot distinguish "down" from "refusing" — a 1006 close carries '
      + 'no status, so the client has to ask over HTTP');
    assert.ok(seen.includes('unauthorized'),
      `the HUD must say WHY it is not connected, not merely that it is not. Saw: ${seen.join(',')}`);
    assert.equal(ws.getState().state, 'unauthorized');
  });

  it('once unauthorized it backs off to minutes, not seconds', async () => {
    // The whole point. 147 attempts in 21.5 minutes is ~8.8s apart; anything in
    // that range after a definitive 401 is the same defect wearing a fix.
    stubProbe(401);
    const ws = await freshWs();
    ws.onBroadcast('tick', () => {});
    await rejectTimes(ws, 5);
    const last = delays[delays.length - 1];
    assert.ok(last >= 60000,
      `after a 401 the retry interval must be at least a minute, got ${last}ms`);
  });

  it('a server that is merely DOWN keeps the fast backoff — this is not a give-up', async () => {
    // The negative control, and it matters more than the fix: a dev restarting
    // the server must still get a reconnect in seconds, not in a minute.
    stubProbe('unreachable');
    const ws = await freshWs();
    ws.onBroadcast('tick', () => {});
    await rejectTimes(ws, 5);
    assert.equal(ws.getState().state, 'closed',
      'unreachable is not unauthorized — do not report a cause that was not established');
    const last = delays[delays.length - 1];
    assert.ok(last <= 8000,
      `an unreachable server must keep the 8s ceiling, got ${last}ms`);
  });

  it('a healthy 200 does not mark the socket unauthorized either', async () => {
    // If the API answers but the socket keeps failing, the cause is NOT auth and
    // the client must not invent one — same rule as the effector evidence
    // contract: report what was established, nothing more.
    stubProbe(200);
    const ws = await freshWs();
    ws.onBroadcast('tick', () => {});
    await rejectTimes(ws, 5);
    assert.equal(ws.getState().state, 'closed');
    assert.ok(delays[delays.length - 1] <= 8000);
  });

  it('the probe is not issued on the first stumble', async () => {
    // A single dropped socket is ordinary. Probing on every close would add an
    // HTTP request per reconnect to the exact path that is already noisy.
    stubProbe(401);
    const ws = await freshWs();
    ws.onBroadcast('tick', () => {});
    await rejectTimes(ws, 1);
    assert.deepEqual(fetchCalls, [], 'one failure is not evidence of anything');
  });

  it('recovery: a later success clears the unauthorized state and the slow backoff', async () => {
    // Without this the fix becomes "the HUD never reconnects again", which is
    // worse than the bug. The operator may start a PIN session at any moment.
    stubProbe(401);
    const ws = await freshWs();
    ws.onBroadcast('tick', () => {});
    await rejectTimes(ws, 4);
    assert.equal(ws.getState().state, 'unauthorized');
    const s = sockets[sockets.length - 1];
    s.readyState = 1;
    s.fire('open');
    assert.equal(ws.getState().state, 'open');
    assert.equal(ws.getState().consecutiveFailures, 0);

    // ASSERT THE FLAG, NOT JUST THE DELAY. The first version of this test only
    // checked the next delay was <= 8000, and mutation M26 (deleting
    // `unauthorized = false` from the open handler) left it GREEN: the open
    // handler resets backoffMs to 500 regardless, and scheduleReconnect records
    // the delay BEFORE updating it, so the stale flag was invisible for exactly
    // one cycle. The state string is the flag, so this reads it directly.
    s.rejectUpgrade();
    assert.equal(ws.getState().state, 'closed',
      'a socket that reconnected successfully is no longer unauthorized — reporting it as such '
      + 'would strand the HUD on the slow retry after the operator fixed the problem');
    assert.ok(delays[delays.length - 1] <= 8000,
      'after a successful connection the fast backoff must be restored');

    // And it must STAY restored on the following cycle, which is where a stale
    // flag would surface even if the state string had not caught it.
    const next = callbacks.pop();
    callbacks.length = 0;
    if (next) next();
    sockets[sockets.length - 1].rejectUpgrade();
    assert.ok(delays[delays.length - 1] <= 8000,
      `the slow interval must not creep back in, got ${delays[delays.length - 1]}ms`);
  });
});
