'use strict';

// sensors/aether.js — Aether-BLE proximity-focus perception sensor.
//
// Connects OUT as a WebSocket client to the Aether aggregator (default
// ws://127.0.0.1:8766) and consumes its locked `election` broadcast — the
// nearest device is `election.owner`. On a focus change (or a meaningful RSSI
// drift while the owner stays stable) it emits `perception.aether`, which the
// existing `perception.*` relay in server/index.js forwards to the HUD (the
// "NEAREST DEVICE" widget) when salience >= MYTHOS_IDLE_SALIENCE.
//
// Pull model: Agent_OS is just another dashboard client of the aggregator. The
// aggregator already accepts inbound `say`/`ask` on this same socket, so Phase
// 2 voice routing will reuse this connection — no second channel needed.
//
// Phase 2 (voice output): the SAME socket is bidirectional — speak(text) sends
// {type:'say'} and the aggregator routes the TTS utterance to the current
// owner, so Agent_OS never needs a second channel to talk through the nearest
// device (see AETHER-WIRING.md Phase 2).
//
// Dedup gate (the whole point): the aggregator broadcasts every 400ms. The
// cortex perception queue drains once per tick (cap MAX_DRAIN_PER_TICK=50).
// Emitting per broadcast would flood it (~2.5 events/sec in, 1/sec drain) and
// crowd out every other sensor. So `decide()` emits ONLY on:
//   (a) owner transition (null->X, X->Y, X->null) or first acquisition; or
//   (b) owner stable but the owner's smoothedRssi moved >= DRIFT_DB since the
//       last emit — or flipped between known/unknown — throttled to 1 Hz.
// Stable 400ms broadcasts are silent no-ops; the HUD still updates live via
// (b) as the user actually moves.
//
// A socket drop after a real connection emits one fail-honest "Aether offline"
// perception at the SAME salience as everything else, so the HUD relay (gate:
// salience >= MYTHOS_IDLE_SALIENCE) clears the stale chip — a down Aether must
// never keep painting "Nearest: PC" as if nothing happened. A drop before any
// device was ever acquired emits nothing: the HUD already reads "no device".
//
// Mirrors window-sensor.js's generation-token + fail-honest-inert contract.
// Field is `salience` (NOT `salienceHint` — cortex/ooda.js reads .salience).
// Opt-in (AETHER_ENABLED, default false). If Aether is down the sensor retries
// with exponential backoff and Agent_OS is otherwise unaffected.

var WebSocket = require('ws');

var DEFAULT_WS_URL = 'ws://127.0.0.1:8766';
var RECONNECT_MIN_MS = 200;
var RECONNECT_MAX_MS = 5000;
var DRIFT_DB = 3;             // owner-stable re-emit threshold on smoothedRssi
var DRIFT_THROTTLE_MS = 1000; // cap owner-stable emits to 1 Hz
var SALIENCE = 0.5;           // one salience for every aether perception

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

  // Dedup-gate state — what we last emitted, so an incoming election can be
  // judged "different enough" to be worth a perception.
  var lastEmittedOwner = null; // owner at last emit (null = never acquired / lost)
  var lastEmittedRssi = null;
  var lastEmitTs = 0;
  var hadFirstEmit = false;    // suppresses the pre-acquisition null->null case

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

  // The dedup gate. Stateful: reads AND updates the last-emit state above, so
  // two calls with the same election yield one perception then null. Returns
  // the perception payload to emit, or null to skip. `now` is passed in so
  // tests can drive the 1 Hz throttle deterministically.
  function decide(election, now) {
    var owner = (election && election.owner) || null;
    var ownerScanner = findOwnerScanner(election);
    var rssi = null;
    if (ownerScanner) {
      if (ownerScanner.smoothedRssi != null) rssi = ownerScanner.smoothedRssi;
      else if (ownerScanner.rssi != null) rssi = ownerScanner.rssi;
    }

    var shouldEmit = false;
    if (!hadFirstEmit) {
      shouldEmit = owner !== null; // first acquisition (pre-acquisition loss: skip)
    } else if (owner !== lastEmittedOwner) {
      shouldEmit = true;           // owner transition — the primary signal
    } else {
      // Owner stable — re-emit only on a meaningful radio change: >=DRIFT_DB
      // drift, or a known<->unknown flip on rssi (the HUD must not keep a
      // stale "rssi unknown" forever). Throttled to 1 Hz so a noisy radio
      // can't spam.
      var rssiChanged = rssi !== lastEmittedRssi &&
        ((rssi == null || lastEmittedRssi == null) || Math.abs(rssi - lastEmittedRssi) >= DRIFT_DB);
      if (rssiChanged && now - lastEmitTs >= DRIFT_THROTTLE_MS) shouldEmit = true;
    }
    if (!shouldEmit) return null;

    hadFirstEmit = true;
    lastEmittedOwner = owner;
    lastEmittedRssi = rssi;
    lastEmitTs = now;

    // 'rssi unknown' (not 'offline') while the socket is live but the owner row
    // is missing from the scanners list — avoids contradicting connected:true.
    var rssiLabel = (rssi != null) ? (rssi + ' dBm') : 'rssi unknown';
    var lh = election && election.lastHandoff;
    var handoff = !!(lh && typeof lh === 'object' && lh.to === owner && lh.from);
    return {
      ts: now,
      kind: 'aether',
      channel: 'aether',
      summary: ('Nearest: ' + (owner || 'none') + ' \u00b7 ' + rssiLabel).slice(0, 200),
      salience: SALIENCE,
      detail: {
        owner: owner,
        rssi: rssi,
        handoff: handoff,
        fromDevice: handoff ? lh.from : null,
        scanners: (election && election.scanners) ? election.scanners.slice() : [],
        connected: true
      }
    };
  }

  function emitOffline() {
    // Never acquired a device yet -> the HUD already reads "no device"; an
    // offline blip adds nothing and would be noise on every failed boot.
    if (!hadFirstEmit) return;
    var now = Date.now();
    bus.emit('perception.aether', {
      ts: now,
      kind: 'aether',
      channel: 'aether',
      summary: 'Nearest: none \u00b7 Aether offline',
      salience: SALIENCE,
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
      var election;
      try { election = JSON.parse(raw.toString()); } catch (_) { return; }
      if (!election || election.type !== 'election') return;
      var payload = decide(election, Date.now());
      if (payload) bus.emit('perception.aether', payload);
    });

    socket.on('close', function () { onSocketDead(myGen); });
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

  // Phase 2 — nearest-device voice output. Sends {type:'say', text} down the
  // open socket to the aggregator, which generates TTS and assigns the
  // utterance to the CURRENT owner (aggregator.py _handle_say) — this is the
  // whole Aether routing mechanism. Returns true only when the message was
  // actually put on the wire; false when there is no live connection, so the
  // caller can fail open to local TTS. Never throws.
  function speak(text) {
    var msgText = (text == null) ? '' : String(text).trim();
    if (!msgText) return false;
    if (!running || !connected || !ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify({ type: 'say', text: msgText }));
      return true;
    } catch (_) {
      return false;
    }
  }

  function isRunning() { return running; }

  return {
    start: start,
    stop: stop,
    speak: speak,
    isRunning: isRunning,
    _internal: {
      decide: decide,            // test hook: drive the dedup gate directly
      findOwnerScanner: findOwnerScanner,
      _reset: function () {      // test hook: clear gate state between cases
        lastEmittedOwner = null;
        lastEmittedRssi = null;
        lastEmitTs = 0;
        hadFirstEmit = false;
      }
    }
  };
}

module.exports = { createAetherSensor };
