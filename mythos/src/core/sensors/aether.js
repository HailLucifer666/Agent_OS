'use strict';

// sensors/aether.js — Aether-BLE proximity-focus perception sensor.
//
// Connects OUT as a WebSocket client to the Aether aggregator (default
// ws://127.0.0.1:8766) and consumes its locked `election` broadcast — the
// nearest device is `election.owner`. On a focus change (or a meaningful RSSI
// drift while the owner stays stable) it emits `perception.aether`, which the
// existing `perception.*` relay in server/index.js forwards to the HUD when
// salience >= MYTHOS_IDLE_SALIENCE. The HUD "NEAREST DEVICE" widget paints it.
//
// Pull model: Agent_OS is just another dashboard client of the aggregator. The
// aggregator already accepts inbound `say`/`ask` on this same socket, so Phase
// 2 voice routing will reuse this connection — no second channel needed.
//
// Dedup gate (the whole point): the aggregator broadcasts every 400ms. The
// cortex perception queue drains once per tick (cap MAX_DRAIN_PER_TICK=50).
// Emitting per broadcast would flood it (~2.5 events/sec in, 1/sec drain) and
// crowd out every other sensor. So we emit ONLY on:
//   (a) owner transition (null->X, X->Y, X->null), or first acquisition; or
//   (b) owner stable but the owner's smoothedRssi moved >= DRIFT_DB since the
//       last emit — throttled to max 1 Hz so a noisy radio can't spam.
// Stable 400ms broadcasts are silent no-ops; the HUD distance still updates
// live via (b) as the user actually moves.
//
// Mirrors window-sensor.js's generation-token + fail-honest-inert contract.
// Field is `salience` (NOT `salienceHint` — cortex/ooda.js reads .salience).
// Opt-in (AETHER_ENABLED, default false). If Aether is down the sensor retries
// with exponential backoff and Agent_OS is otherwise unaffected.

var WebSocket = require('ws');

var DEFAULT_WS_URL = 'ws://127.0.0.1:8766';
var RECONNECT_MIN_MS = 200;
var RECONNECT_MAX_MS = 5000;
var DRIFT_DB = 3;          // owner-stable re-emit threshold on smoothedRssi
var DRIFT_THROTTLE_MS = 1000; // cap owner-stable emits to 1 Hz
var DISCONNECT_SALIENCE = 0.2; // below MYTHOS_IDLE_SALIENCE → reaches HUD via detail only when relayed by kind
var DEFAULT_SALIENCE = 0.5;

function createAetherSensor(ctx) {
  var bus = ctx.bus;
  var config = ctx.config || {};
  var logger = ctx.logger || { info: function () {}, warn: function () {}, error: function () {} };
  var generation = 0;      // bumped on start/stop; stale callbacks bail on it
  var running = false;
  var ws = null;
  var reconnectTimer = null;
  var reconnectDelay = RECONNECT_MIN_MS;
  var connected = false;

  // Dedup gate state — what we last emitted, so we can decide whether the
  // incoming election is "different enough" to be worth a perception.
  var lastEmittedOwner = null;     // owner at last emit (null = never acquired / lost)
  var lastEmittedRssi = null;
  var lastEmitTs = 0;
  var hadFirstEmit = false;        // suppresses the null->null initial transition

  // Pull the owner scanner entry (with its smoothedRssi) out of the election
  // payload. Aggregator sends scanners as a list; owner may be null.
  function findOwnerScanner(election) {
    if (!election || !Array.isArray(election.scanners)) return null;
    var owner = election.owner;
    if (!owner) return null;
    for (var i = 0; i < election.scanners.length; i++) {
      var s = election.scanners[i];
      if (s && s.id === owner) return s;
    }
    return null;
  }

  // Core gate decision. Returns the perception payload to emit, or null to skip.
  // Pure — no side effects except reading/clearing throttle state via the
  // passed-in `now` (so injectFocus can drive it deterministically in tests).
  function decide(election, now) {
    var owner = (election && election.owner) || null;
    var ownerScanner = findOwnerScanner(election);
    var rssi = ownerScanner ? ownerScanner.smoothedRssi : null;
    if (rssi == null && ownerScanner && ownerScanner.rssi != null) rssi = ownerScanner.rssi;
    var handoff = false;
    var fromDevice = null;
    var lh = election && election.lastHandoff;
    if (lh && typeof lh === 'object' && lh.to === owner && lh.from) {
      handoff = true;
      fromDevice = lh.from;
    }

    var shouldEmit = false;
    if (!hadFirstEmit) {
      // First acquisition (owner present) or first loss after acquisition.
      if (owner !== null) shouldEmit = true;
    } else if (owner !== lastEmittedOwner) {
      // Owner transition — the primary signal.
      shouldEmit = true;
    } else if (rssi != null && lastEmittedRssi != null &&
               Math.abs(rssi - lastEmittedRssi) >= DRIFT_DB) {
      // Owner stable but radio moved meaningfully — throttle to 1 Hz.
      if (now - lastEmitTs >= DRIFT_THROTTLE_MS) shouldEmit = true;
    }

    if (!shouldEmit) return null;

    hadFirstEmit = true;
    lastEmittedOwner = owner;
    lastEmittedRssi = rssi;
    lastEmitTs = now;

    var ownerLabel = owner || 'none';
    // 'rssi unknown' (not 'offline') when the socket is live but the owner row
    // is missing from the scanners list — avoids contradicting connected:true.
    var rssiLabel = (rssi != null) ? (rssi + ' dBm') : 'rssi unknown';
    return {
      ts: now,
      kind: 'aether',
      channel: 'aether',
      summary: ('Nearest: ' + ownerLabel + ' \u00b7 ' + rssiLabel).slice(0, 200),
      salience: DEFAULT_SALIENCE,
      detail: {
        owner: owner,
        rssi: rssi,
        handoff: handoff,
        fromDevice: fromDevice,
        scanners: (election && election.scanners) ? election.scanners.slice() : [],
        connected: true
      }
    };
  }

  function emitPerception(payload) {
    if (!payload) return;
    try {
      bus.emit('perception.aether', payload);
    } catch (_) {
      // A bus emit must never crash the sensor loop.
    }
  }

  // Test hook + push-path entry point. Lets tests and a future Python push
  // client drive the gate without a live aggregator connection.
  function injectFocus(election) {
    return decide(election, Date.now());
  }

  function emitOffline() {
    if (!hadFirstEmit && !connected) return; // never acquired → don't noise "offline"
    var now = Date.now();
    emitPerception({
      ts: now,
      kind: 'aether',
      channel: 'aether',
      summary: 'Nearest: none \u00b7 Aether offline',
      salience: DISCONNECT_SALIENCE,
      detail: {
        owner: null,
        rssi: null,
        handoff: false,
        fromDevice: null,
        scanners: [],
        connected: false
      }
    });
    // After reporting loss, the next reacquisition is a real transition again.
    lastEmittedOwner = null;
    lastEmittedRssi = null;
  }

  function connect(myGen) {
    if (generation !== myGen || !running) return;
    var url = config.AETHER_WS_URL || DEFAULT_WS_URL;
    var socket;
    try {
      socket = new WebSocket(url);
    } catch (e) {
      scheduleReconnect(myGen);
      return;
    }
    ws = socket;

    // A bare 'error' listener MUST be attached before any await gap: ws fires
    // 'error' synchronously on construction failure and asynchronously on
    // ECONNREFUSED, and without a listener it surfaces as uncaughtException.
    // stop() deliberately does NOT removeAllListeners(), so this listener
    // stays attached through teardown and absorbs the deferred error from a
    // CONNECTING socket that fails after stop() returns.
    socket.on('error', function () {
      // 'close' follows and drives reconnect; log once for observability so a
      // down Aether isn't indistinguishable from "sensor never started."
      try { logger.warn('sensors.aether.socket_error'); } catch (_) {}
    });

    socket.on('open', function () {
      if (generation !== myGen) { try { socket.close(); } catch (_) {} return; }
      connected = true;
      reconnectDelay = RECONNECT_MIN_MS; // reset backoff on a clean connect
      try { logger.info('sensors.aether.connected', { url: url }); } catch (_) {}
    });

    socket.on('message', function (raw) {
      if (generation !== myGen) return;
      handleElectionLocked(raw, myGen);
    });

    socket.on('close', function () { onSocketDead(myGen); });
  }

  // Bound separately so handleElection can be unit-tested without rebinding.
  function handleElectionLocked(raw, myGen) {
    if (generation !== myGen) return;
    var election;
    try { election = JSON.parse(raw.toString()); } catch (_) { return; }
    if (!election || election.type !== 'election') return;
    var payload = decide(election, Date.now());
    if (payload) emitPerception(payload);
  }

  function onSocketDead(myGen) {
    if (generation !== myGen) return;
    var wasConnected = connected;
    connected = false;
    if (ws) { try { ws.removeAllListeners(); ws = null; } catch (_) {} }
    if (wasConnected) emitOffline();
    scheduleReconnect(myGen);
  }

  function scheduleReconnect(myGen) {
    if (generation !== myGen || !running) return;
    if (reconnectTimer) return; // already pending
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      if (generation !== myGen || !running) return;
      connect(myGen);
      // Exponential backoff with cap.
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    }, reconnectDelay);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  function start() {
    if (running) return;
    running = true;
    generation++;
    var myGen = generation;
    reconnectDelay = RECONNECT_MIN_MS;
    connect(myGen);
  }

  function stop() {
    running = false;
    generation++;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) {
      // Do NOT removeAllListeners() here: a CONNECTING socket that's about to
      // fail (ECONNREFUSED) fires 'error' on the next tick, and stripping
      // listeners first turns that into an uncaughtException. Keep the no-op
      // error listener attached; only close() if OPEN, and drop our reference.
      var ready = ws.readyState;
      if (ready === 1) { try { ws.close(); } catch (_) {} } // OPEN
      ws = null;
    }
    connected = false;
  }

  function isRunning() { return running; }

  return {
    start: start,
    stop: stop,
    isRunning: isRunning,
    _internal: {
      injectFocus: injectFocus,
      decide: decide,
      findOwnerScanner: findOwnerScanner,
      _reset: function () {        // test hook: clear gate state between cases
        lastEmittedOwner = null;
        lastEmittedRssi = null;
        lastEmitTs = 0;
        hadFirstEmit = false;
      },
      _state: function () {
        return {
          connected: connected,
          lastEmittedOwner: lastEmittedOwner,
          lastEmittedRssi: lastEmittedRssi,
          lastEmitTs: lastEmitTs,
          hadFirstEmit: hadFirstEmit
        };
      }
    }
  };
}

module.exports = { createAetherSensor };
