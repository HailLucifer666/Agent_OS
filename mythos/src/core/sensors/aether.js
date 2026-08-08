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
// Ranging enrichment (Phase 1.5): the aggregator ALSO broadcasts `ranging`
// (per-scanner ToF `distanceM` — real data, the tier the original plan said
// to carry rssi until it was wired) and `position` (fused 2-D x/y) on the
// same socket. Those never emit on their own (gate stays election-driven);
// they only enrich the next election perception with the owner's real
// distance. The caches are cleared on a socket drop so a reconnect never
// reuses pre-disconnect distances (real data only — never show a distance
// you didn't just hear).
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
var QUEUE_SAFETY_MS = 1200;   // Phase 4 speak-gating fail-open ceiling (FSM window ~800ms + jitter)

// The aggregator only broadcasts ranging while a chirp/contest is live, so
// entries in the per-instance ranging cache are real ToF measurements, never
// estimates.

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

  // Enrichment data from the same socket — per-instance caches, seeded via
  // ingest() (exposed as _internal.ingest for tests). Cleared on socket drop
  // so a reconnect never reuses pre-disconnect distances.
  var myRanging = {};
  var myPosition = null;

  // Conversation FSM awareness (Phase 4 listen slice): the aggregator's
  // `conversation` broadcast rides this same socket. We cache the live FSM
  // phase + speaking scanner, plus the one-shot `conversationEvent` (present
  // in one broadcast, then absent — mirroring wakeOutcome's one-shot
  // semantics). Never emits on its own; the next election perception carries
  // them in detail so the cortex knows a handoff is mid-flight.
  var convPhase = 'IDLE';
  var convSpeakingScanner = null;
  var pendingConvEvent = null; // one-shot {phase, from, to} — carried once

  // Phase 4 speak-gating state: while the conversation FSM is mid-handoff
  // (phase != IDLE, ~800ms), outgoing say messages are deferred so a fresh
  // 'say' does not call the aggregator's start_utterance and cancel the
  // device-to-device sentence move (AETHER-WIRING.md §Phase 4, the load-
  // bearing constraint). Cap 1: a second speak during the same window
  // replaces the first — the aggregator's own "new utterance replaces
  // in-flight" semantics, so we never fight it.
  var queuedSay = null;    // { text, queuedAt } — newest wins
  var safetyTimer = null;  // fail-open: deliver the queued say after QUEUE_SAFETY_MS even if IDLE never returns

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
    // Real ToF distance for the owner, when the ranging tier has broadcast one
    // (Phase 1.5). Shown as-is — never estimated from rssi.
    var ownerRanging = owner ? myRanging[owner] : null;
    var distanceM = ownerRanging ? ownerRanging.distanceM : null;
    var lh = election && election.lastHandoff;
    var handoff = !!(lh && typeof lh === 'object' && lh.to === owner && lh.from);
    // Conversation FSM phase, and the one-shot handoff event if one arrived
    // since the last perception (Phase 4 listen slice).
    var phase = convPhase || 'IDLE';
    var handoffPhase = pendingConvEvent;
    pendingConvEvent = null; // one-shot: carried exactly once
    var summaryBits = ['Nearest: ' + (owner || 'none')];
    if (distanceM != null) summaryBits.push(distanceM.toFixed(2) + ' m');
    summaryBits.push(rssiLabel);
    return {
      ts: now,
      kind: 'aether',
      channel: 'aether',
      summary: summaryBits.join(' \u00b7 ').slice(0, 200),
      salience: SALIENCE,
      detail: {
        owner: owner,
        rssi: rssi,
        distanceM: distanceM,
        position: myPosition ? { x: myPosition.x, y: myPosition.y, uncertaintyRadiusM: myPosition.uncertaintyRadiusM } : null,
        handoff: handoff,
        fromDevice: handoff ? lh.from : null,
        phase: phase,
        speakingScanner: convSpeakingScanner,
        handoffPhase: handoffPhase,
        scanners: (election && election.scanners) ? election.scanners.slice() : [],
        connected: true
      }
    };
  }

  // Ingest a same-socket non-election broadcast (ranging / position). These
  // enrich the next election perception; they never emit on their own.
  function ingest(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ranging') {
      var chirp = msg.chirp;
      if (chirp && Array.isArray(chirp.measurements)) {
        for (var i = 0; i < chirp.measurements.length; i++) {
          var m = chirp.measurements[i];
          if (m && m.scannerId && typeof m.distanceM === 'number') {
            myRanging[m.scannerId] = { distanceM: m.distanceM, tofUs: m.tofUs };
          }
        }
      }
    } else if (msg.type === 'position') {
      if (typeof msg.x === 'number' && typeof msg.y === 'number') {
        myPosition = { x: msg.x, y: msg.y, uncertaintyRadiusM: msg.uncertaintyRadiusM };
      }
    } else if (msg.type === 'conversation') {
      // Phase 4 listen slice — cache the FSM state; never emits a PERCEPTION on
      // its own (the election gate owns those).
      //
      // Stage 5 (voice nodes) does need the phase on the bus, though: a phone
      // holding a half-played sentence has to pause, seek and resume in step with
      // the FSM's 200ms-per-phase sequence (§6.3), and by the time the next
      // election perception carries the phase the handoff is already over.
      // Emitted on CHANGE only — the aggregator re-broadcasts the same phase
      // every 400ms, and relaying that would be a 2.5Hz flood into the bus's
      // storm guard for no new information.
      var previousPhase = convPhase;
      if (typeof msg.phase === 'string') convPhase = msg.phase;
      convSpeakingScanner = (msg.speakingScanner == null) ? null : String(msg.speakingScanner);
      if (msg.conversationEvent && typeof msg.conversationEvent === 'object') {
        var ev = msg.conversationEvent;
        pendingConvEvent = {
          phase: (ev.phase == null) ? null : String(ev.phase),
          from: (ev.fromScanner == null) ? null : String(ev.fromScanner),
          to: (ev.toScanner == null) ? null : String(ev.toScanner)
        };
      }
      if (convPhase !== previousPhase) {
        // Stage 5: the payload the server relays to voice nodes verbatim. `from`
        // is our own observed previous phase rather than the aggregator's
        // phaseFrom, because a client that connected mid-handoff has no
        // phaseFrom to trust and would otherwise report a transition from null.
        try {
          bus.emit('aether.conversation', {
            phase: convPhase,
            from: previousPhase,
            speakingScanner: convSpeakingScanner
          });
        } catch (_) { /* a bus failure must never break the socket loop */ }
      }
      // Phase 4 speak-gating drain: the FSM returned to idle — deliver any
      // queued say now instead of waiting out the safety timer. No-op when
      // the queue is empty (the aggregator re-broadcasts IDLE every 400ms).
      if (msg.phase === 'IDLE') flushQueuedSay();
    }
  }

  // Real-data-only hygiene: a socket drop (or stop) must never leave stale
  // enrichment or FSM state behind for the next reconnect to reuse. The queued
  // say and its safety timer are cleared too — a reconnect must never deliver
  // a pre-disconnect message (a stale say mid-handoff would itself cancel a
  // handoff).
  function clearEnrichment() {
    myRanging = {};
    myPosition = null;
    convPhase = 'IDLE';
    convSpeakingScanner = null;
    pendingConvEvent = null;
    queuedSay = null;
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
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
        distanceM: null,
        position: null,
        handoff: false,
        fromDevice: null,
        phase: 'IDLE',
        speakingScanner: null,
        handoffPhase: null,
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
      var msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (!msg || typeof msg !== 'object') return;
      // Ranging/position/conversation broadcasts enrich the next election
      // perception without emitting (they fire far more often than the gate
      // allows, and the conversation FSM must not emit on its own either).
      if (msg.type === 'ranging' || msg.type === 'position' || msg.type === 'conversation') {
        ingest(msg);
        return;
      }
      if (msg.type !== 'election') return;
      var payload = decide(msg, Date.now());
      if (payload) bus.emit('perception.aether', payload);
    });

    socket.on('close', function () { onSocketDead(myGen); });
  }

  function onSocketDead(myGen) {
    if (generation !== myGen) return;
    var wasConnected = connected;
    connected = false;
    clearEnrichment();
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
    // Same real-data-only hygiene as a socket drop: a stop->start cycle must
    // not let the first post-restart election perception resurrect pre-stop
    // distances.
    clearEnrichment();
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

  // Single guarded send — shared by the immediate path, the drain hook and the
  // safety timer. Returns true only when the message was actually put on the
  // wire; false when there is no live connection.
  function sendSay(text) {
    if (!running || !connected || !ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify({ type: 'say', text: text }));
      return true;
    } catch (_) {
      return false;
    }
  }

  // Deliver the queued say (best-effort) and clear queue + timer. Called from
  // the IDLE drain and the safety timer; if the socket died in the meantime,
  // this is the acknowledged drop edge case (clearEnrichment has already
  // cleared both, so the timer path cannot even reach here after a drop).
  function flushQueuedSay() {
    if (!queuedSay) return;
    var entry = queuedSay;
    queuedSay = null;
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
    sendSay(entry.text);
  }

  // Phase 2 — nearest-device voice output. Sends {type:'say', text} down the
  // open socket to the aggregator, which generates TTS and assigns the
  // utterance to the CURRENT owner (aggregator.py _handle_say) — this is the
  // whole Aether routing mechanism. Returns true only when the message was
  // actually put on the wire (or is guaranteed to reach it via the queue +
  // fail-open timer); false when there is no live connection, so the caller
  // can fail open to local TTS. Never throws.
  //
  // Phase 4 speak-gating: while the conversation FSM is mid-handoff
  // (convPhase != 'IDLE'), the say is deferred into the 1-entry queue and
  // `true` is still returned — the server treats true as "sent, skip local
  // TTS" (server/index.js speakViaAether), which is the desired caption-only,
  // device-routed behavior during a handoff. The queue drains on the next
  // IDLE broadcast; the safety timer fails open within QUEUE_SAFETY_MS even
  // if IDLE never returns, so the text is never dropped while the socket
  // stays live. (A socket drop before delivery clears the queue — the
  // acknowledged edge case; the offline perception + the next speak returning
  // false handle forward progress.)
  function speak(text) {
    var msgText = (text == null) ? '' : String(text).trim();
    if (!msgText) return false;
    if (!running || !connected || !ws || ws.readyState !== 1) return false;
    if (convPhase !== 'IDLE') {
      queuedSay = { text: msgText, queuedAt: Date.now() };
      if (!safetyTimer) {
        safetyTimer = setTimeout(function () {
          safetyTimer = null;
          if (queuedSay) flushQueuedSay(); // fail-open: by now the handoff ended
        }, QUEUE_SAFETY_MS);
        if (safetyTimer.unref) safetyTimer.unref();
      }
      return true;
    }
    return sendSay(msgText);
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
      ingest: ingest,            // test hook: seed ranging/position enrichment
      _reset: function () {      // test hook: clear gate + enrichment state
        lastEmittedOwner = null;
        lastEmittedRssi = null;
        lastEmitTs = 0;
        hadFirstEmit = false;
        clearEnrichment();
      },
      _queueState: function () { // test hook: inspect the speak-gating queue
        return { queued: queuedSay, timerActive: safetyTimer !== null, phase: convPhase };
      }
    }
  };
}

module.exports = { createAetherSensor };
