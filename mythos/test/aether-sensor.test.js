'use strict';

// Aether-BLE proximity-focus sensor — Phase 1 wiring tests.
//
// The sensor connects OUT to the Aether aggregator's WS and consumes its locked
// `election` broadcast. The whole point is the dedup gate: the aggregator fires
// every 400ms, but the cortex perception queue drains 1×/sec (cap 50), so we
// must emit ONLY on owner transition, first acquisition, or a meaningful RSSI
// drift (≥3 dBm, throttled 1 Hz). These cases exercise the gate directly via
// the decide() test hook — no live socket needed for gate logic. The real
// socket path (connect → broadcast → perception.aether; disconnect → offline)
// is covered end-to-end against a local WebSocketServer.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const { createAetherSensor } = require('../src/core/sensors/aether');

const SILENT = { info: function () {}, warn: function () {}, error: function () {} };

function fakeBus() {
  var events = [];
  return { emit: function (n, p) { events.push({ name: n, payload: p }); }, _events: events };
}

// Build an election payload matching aggregator messages.py's locked schema.
function election(owner, scanners, lastHandoff) {
  return {
    type: 'election',
    owner: owner,
    tick: 1,
    ts: '00:00:00',
    scanners: scanners || [],
    lastHandoff: lastHandoff || null,
    wakeOutcome: null
  };
}

function scanner(id, rssi) {
  return { id: id, rssi: rssi, smoothedRssi: rssi, lastSeenMs: 100, present: true };
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Poll until `cond()` is truthy or the timeout elapses; returns success bool.
async function waitFor(cond, ms) {
  var deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

// A throwaway aggregator on an ephemeral port. Listening is async: address()
// is null until the 'listening' event, so await it before reading the port.
async function fakeAggregator() {
  var wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(function (resolve) { wss.once('listening', resolve); });
  return { wss: wss, port: wss.address().port };
}

async function closeAggregator(wss) {
  await new Promise(function (resolve) {
    try { wss.close(resolve); } catch (_) { resolve(); }
  });
}

describe('aether-sensor (Phase 1)', function () {

  it('emits perception.aether on first acquisition with correct shape', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: SILENT });
    sensor._internal._reset();
    var p = sensor._internal.decide(election('PC', [scanner('PC', -59)]), 1000);
    assert.ok(p, 'first acquisition must produce a perception');
    assert.equal(p.kind, 'aether');
    assert.equal(p.channel, 'aether');
    assert.equal(p.salience, 0.5);
    assert.equal(p.detail.owner, 'PC');
    assert.equal(p.detail.rssi, -59);
    assert.equal(p.detail.connected, true);
    assert.ok(p.summary.indexOf('PC') !== -1);
    assert.ok(p.summary.indexOf('-59') !== -1);
  });

  it('dedup: repeated same-owner broadcasts do NOT re-emit', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: SILENT });
    sensor._internal._reset();
    var e = election('PC', [scanner('PC', -59)]);
    assert.ok(sensor._internal.decide(e, 1000), 'first must emit');
    assert.equal(sensor._internal.decide(e, 1100), null, 'second identical broadcast must be a no-op');
    assert.equal(sensor._internal.decide(e, 1200), null, 'third identical broadcast must be a no-op');
  });

  it('owner transition emits with handoff flag derived from lastHandoff', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: SILENT });
    sensor._internal._reset();
    sensor._internal.decide(election('PC', [scanner('PC', -59)]), 1000); // acquire PC
    // Walk to Phone — aggregator records the handoff.
    var p = sensor._internal.decide(election('Phone', [scanner('Phone', -42)], { from: 'PC', to: 'Phone', atTick: 2 }), 2000);
    assert.ok(p, 'owner change must emit');
    assert.equal(p.detail.owner, 'Phone');
    assert.equal(p.detail.handoff, true);
    assert.equal(p.detail.fromDevice, 'PC');
  });

  it('owner change without a recorded lastHandoff emits handoff:false', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: SILENT });
    sensor._internal._reset();
    sensor._internal.decide(election('PC', [scanner('PC', -59)]), 1000);
    // No lastHandoff payload — still a transition, but not a recorded handoff.
    var p = sensor._internal.decide(election('Phone', [scanner('Phone', -42)]), 2000);
    assert.ok(p);
    assert.equal(p.detail.owner, 'Phone');
    assert.equal(p.detail.handoff, false);
  });

  it('owner stable + <3 dBm drift does NOT re-emit (noise floor)', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: SILENT });
    sensor._internal._reset();
    sensor._internal.decide(election('PC', [scanner('PC', -59)]), 1000);
    var p = sensor._internal.decide(election('PC', [scanner('PC', -61)]), 2000); // 2 dBm drift
    assert.equal(p, null, 'sub-threshold jitter must not re-emit');
  });

  it('owner stable + >=3 dBm drift re-emits (throttled 1 Hz)', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: SILENT });
    sensor._internal._reset();
    sensor._internal.decide(election('PC', [scanner('PC', -59)]), 1000); // first emit
    var p1 = sensor._internal.decide(election('PC', [scanner('PC', -50)]), 1100); // 9 dBm drift, 100ms later
    assert.equal(p1, null, 'drift within 1 Hz throttle window must not emit');
    var p2 = sensor._internal.decide(election('PC', [scanner('PC', -50)]), 2100); // past throttle
    assert.ok(p2, 'drift past throttle window must emit');
    assert.equal(p2.detail.rssi, -50);
  });

  it('re-emits when rssi flips known<->unknown while the owner is stable', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: SILENT });
    sensor._internal._reset();
    // First acquisition: owner present but the scanner row is missing -> rssi unknown.
    var p1 = sensor._internal.decide(election('PC', []), 1000);
    assert.ok(p1);
    assert.equal(p1.detail.rssi, null);
    assert.ok(p1.summary.indexOf('rssi unknown') !== -1);
    // Same owner, scanner row now present -> the HUD must learn the real value
    // (the old gate never re-emitted here, leaving a stale "rssi unknown").
    var p2 = sensor._internal.decide(election('PC', [scanner('PC', -55)]), 2000);
    assert.ok(p2, 'unknown -> known rssi must re-emit');
    assert.equal(p2.detail.rssi, -55);
    // And the reverse: the row disappears again.
    var p3 = sensor._internal.decide(election('PC', []), 3000);
    assert.ok(p3, 'known -> unknown rssi must re-emit');
    assert.equal(p3.detail.rssi, null);
  });

  it('swallows malformed election payloads (fail-honest-inert)', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: SILENT });
    sensor._internal._reset();
    assert.equal(sensor._internal.decide(null, 1), null);
    assert.equal(sensor._internal.decide({}, 1), null);
    assert.equal(sensor._internal.decide({ type: 'reading' }, 1), null); // wrong type
    assert.equal(sensor._internal.decide({ type: 'election', owner: null, scanners: [] }, 1), null); // null owner, never acquired
  });

  it('falls back to raw rssi when smoothedRssi is absent', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: SILENT });
    sensor._internal._reset();
    var p = sensor._internal.decide(election('PC', [{ id: 'PC', rssi: -55, lastSeenMs: 1, present: true }]), 1000);
    assert.ok(p);
    assert.equal(p.detail.rssi, -55);
  });

  it('null owner after acquisition is a loss transition (emits)', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: SILENT });
    sensor._internal._reset();
    sensor._internal.decide(election('PC', [scanner('PC', -59)]), 1000);
    var p = sensor._internal.decide(election(null, []), 2000);
    assert.ok(p, 'loss of owner must emit');
    assert.equal(p.detail.owner, null);
  });

  it('isRunning() reflects start/stop state', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: SILENT });
    assert.equal(sensor.isRunning(), false);
    sensor.start();
    assert.equal(sensor.isRunning(), true);
    sensor.stop();
    assert.equal(sensor.isRunning(), false);
  });

  it('start/stop are idempotent', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: SILENT });
    sensor.start();
    sensor.start(); // second start is a no-op
    assert.equal(sensor.isRunning(), true);
    sensor.stop();
    sensor.stop(); // second stop is a no-op
    assert.equal(sensor.isRunning(), false);
  });

  it('start() does not throw when AETHER_WS_URL points at a dead port (graceful degradation)', async function () {
    // A port nothing is listening on — connect() must schedule a reconnect,
    // not throw and not crash the boot. Let the connection attempt settle so
    // any deferred ECONNREFUSED lands inside the test (absorbed by the sensor's
    // no-op error listener), then stop and assert clean state.
    var sensor = createAetherSensor({
      bus: fakeBus(),
      config: { AETHER_WS_URL: 'ws://127.0.0.1:9' }, // unused port
      logger: SILENT
    });
    assert.doesNotThrow(function () { sensor.start(); });
    assert.equal(sensor.isRunning(), true);
    await sleep(80); // drain the connection-failure microtask
    assert.doesNotThrow(function () { sensor.stop(); });
    assert.equal(sensor.isRunning(), false);
  });

  it('round-trips an election broadcast over a real WS into perception.aether', async function () {
    var bus = fakeBus();
    var agg = await fakeAggregator();
    var sensor = createAetherSensor({
      bus: bus,
      config: { AETHER_WS_URL: 'ws://127.0.0.1:' + agg.port },
      logger: SILENT
    });
    sensor.start();
    try {
      assert.ok(await waitFor(function () { return agg.wss.clients.size === 1; }, 1000), 'sensor must connect');
      var client = [...agg.wss.clients][0];

      client.send(JSON.stringify(election('PC', [scanner('PC', -59)])));
      assert.ok(await waitFor(function () { return bus._events.length === 1; }, 1000), 'broadcast must emit a perception');
      var ev = bus._events[0];
      assert.equal(ev.name, 'perception.aether');
      assert.equal(ev.payload.detail.owner, 'PC');
      assert.equal(ev.payload.detail.rssi, -59);
      assert.equal(ev.payload.salience, 0.5);

      // Duplicate broadcast -> still one perception (dedup works on the wire).
      client.send(JSON.stringify(election('PC', [scanner('PC', -59)])));
      await sleep(80);
      assert.equal(bus._events.length, 1, 'duplicate broadcast must not re-emit');

      // Non-election message type -> ignored.
      client.send(JSON.stringify({ type: 'reading', owner: 'PC', rssi: -30 }));
      await sleep(30);
      assert.equal(bus._events.length, 1, 'non-election messages must be ignored');
    } finally {
      sensor.stop();
      await closeAggregator(agg.wss);
    }
  });

  it('emits a fail-honest offline perception when the aggregator drops the socket', async function () {
    var bus = fakeBus();
    var agg = await fakeAggregator();
    var sensor = createAetherSensor({
      bus: bus,
      config: { AETHER_WS_URL: 'ws://127.0.0.1:' + agg.port },
      logger: SILENT
    });
    sensor.start();
    try {
      assert.ok(await waitFor(function () { return agg.wss.clients.size === 1; }, 1000), 'sensor must connect');
      var client = [...agg.wss.clients][0];
      client.send(JSON.stringify(election('PC', [scanner('PC', -59)])));
      assert.ok(await waitFor(function () { return bus._events.length === 1; }, 1000), 'broadcast must emit a perception');

      // Kill the connection from the aggregator side.
      client.close();
      assert.ok(await waitFor(function () { return bus._events.length === 2; }, 1000), 'drop must emit the offline perception');
      var off = bus._events[1];
      assert.equal(off.name, 'perception.aether');
      assert.equal(off.payload.detail.connected, false);
      assert.equal(off.payload.detail.owner, null);
      assert.equal(off.payload.salience, 0.5, 'offline must clear the HUD chip (relay gate is salience >= 0.3)');
      assert.ok(off.payload.summary.indexOf('offline') !== -1);
    } finally {
      sensor.stop();
      await closeAggregator(agg.wss);
    }
  });

  // ---- Phase 1.5: ranging/position enrichment (real ToF distance) ----

  it('enriches the perception with the owner\'s real ToF distance from the ranging broadcast', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: SILENT });
    sensor._internal._reset();
    // Same-socket `ranging` broadcast (aggregator messages.py schema): chirp
    // carries per-scanner ToF measurements — REAL data, never estimated.
    sensor._internal.ingest({
      type: 'ranging',
      contest: null,
      chirp: {
        measurements: [{ scannerId: 'PC', tofUs: 2000.0, distanceM: 0.686 }],
        winnerId: 'PC', sameRoom: true, resolvedTick: 5
      },
      fusionReason: 'chirp-confirmed',
      rangingEvent: null
    });
    var p = sensor._internal.decide(election('PC', [scanner('PC', -59)]), 1000);
    assert.ok(p, 'first acquisition must emit');
    assert.equal(p.detail.distanceM, 0.686, 'owner distance must come from the ranging cache');
    assert.ok(p.summary.indexOf('0.69 m') !== -1, 'summary must show the real distance');
  });

  it('no ranging broadcast yet -> rssi-only perception, distanceM null', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: SILENT });
    sensor._internal._reset();
    var p = sensor._internal.decide(election('PC', [scanner('PC', -59)]), 1000);
    assert.ok(p);
    assert.equal(p.detail.distanceM, null);
    assert.equal(p.detail.position, null);
    assert.ok(p.summary.indexOf(' m') === -1, 'no distance -> no metres in the summary');
  });

  it('ranging for a non-owner scanner does not leak into the summary', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: SILENT });
    sensor._internal._reset();
    sensor._internal.ingest({
      type: 'ranging',
      chirp: { measurements: [{ scannerId: 'Phone', tofUs: 1000.0, distanceM: 0.35 }] }
    });
    var p = sensor._internal.decide(election('PC', [scanner('PC', -59)]), 1000);
    assert.ok(p);
    assert.equal(p.detail.distanceM, null, 'distance is per-owner; Phone\'s must not apply to PC');
  });

  it('enriches with the fused 2-D position when the position broadcast is live', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: SILENT });
    sensor._internal._reset();
    sensor._internal.ingest({ type: 'position', userId: 'SIM-A', x: 1.23, y: 4.56, uncertaintyRadiusM: 0.8 });
    var p = sensor._internal.decide(election('PC', [scanner('PC', -59)]), 1000);
    assert.ok(p);
    assert.deepEqual(p.detail.position, { x: 1.23, y: 4.56, uncertaintyRadiusM: 0.8 });
  });

  it('socket drop clears the ranging cache (no stale distance after reconnect)', async function () {
    var bus = fakeBus();
    var agg = await fakeAggregator();
    var sensor = createAetherSensor({
      bus: bus,
      config: { AETHER_WS_URL: 'ws://127.0.0.1:' + agg.port },
      logger: SILENT
    });
    sensor.start();
    try {
      assert.ok(await waitFor(function () { return agg.wss.clients.size === 1; }, 1000), 'sensor must connect');
      var client = [...agg.wss.clients][0];
      client.send(JSON.stringify({
        type: 'ranging',
        chirp: { measurements: [{ scannerId: 'PC', tofUs: 2000.0, distanceM: 0.686 }] }
      }));
      client.send(JSON.stringify(election('PC', [scanner('PC', -59)])));
      assert.ok(await waitFor(function () { return bus._events.length === 1; }, 1000), 'perception must emit');
      assert.equal(bus._events[0].payload.detail.distanceM, 0.686);

      // Kill the socket; the drop must clear the enrichment caches.
      client.close();
      assert.ok(await waitFor(function () { return bus._events.length === 2; }, 1000), 'offline must emit');
      assert.equal(bus._events[1].payload.detail.distanceM, null, 'offline has no distance');
      // Reacquisition after reconnect: it IS a transition (emits), but the
      // cleared cache means the old distance must not resurrect.
      var p = sensor._internal.decide(election('PC', [scanner('PC', -59)]), Date.now());
      assert.ok(p, 'reacquisition after offline must emit (it is a transition)');
      assert.equal(p.detail.distanceM, null, 'stale pre-drop distance must not survive the drop');
    } finally {
      sensor.stop();
      await closeAggregator(agg.wss);
    }
  });

  it('round-trips a real ranging broadcast over WS without emitting on its own', async function () {
    var bus = fakeBus();
    var agg = await fakeAggregator();
    var sensor = createAetherSensor({
      bus: bus,
      config: { AETHER_WS_URL: 'ws://127.0.0.1:' + agg.port },
      logger: SILENT
    });
    sensor.start();
    try {
      assert.ok(await waitFor(function () { return agg.wss.clients.size === 1; }, 1000), 'sensor must connect');
      var client = [...agg.wss.clients][0];
      // Ranging alone (no election) must be silent — enrichment never emits.
      client.send(JSON.stringify({
        type: 'ranging',
        chirp: { measurements: [{ scannerId: 'PC', tofUs: 2000.0, distanceM: 0.686 }] }
      }));
      await sleep(60);
      assert.equal(bus._events.length, 0, 'ranging broadcast alone must not emit a perception');
      // Then the election perception carries the cached distance.
      client.send(JSON.stringify(election('PC', [scanner('PC', -59)])));
      assert.ok(await waitFor(function () { return bus._events.length === 1; }, 1000));
      assert.equal(bus._events[0].payload.detail.distanceM, 0.686);
      assert.ok(bus._events[0].payload.summary.indexOf('0.69 m') !== -1);
    } finally {
      sensor.stop();
      await closeAggregator(agg.wss);
    }
  });

  // ---- Phase 4: conversation FSM listen slice (awareness only) ----

  it('carries the conversation FSM phase in the next election perception', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: SILENT });
    sensor._internal._reset();
    // Same-socket `conversation` broadcast (messages.py locked schema):
    // mid-handoff the phase is TRANSFER and speaking is still the old owner.
    sensor._internal.ingest({
      type: 'conversation',
      transcript: [],
      utterance: { text: '...', audioBase64: null, durationMs: 2400, offsetMs: 1200, isSynthetic: false },
      speakingScanner: 'PC',
      phase: 'TRANSFER',
      phaseFrom: 'PC',
      phaseTo: 'Phone',
      conversationEvent: null
    });
    var p = sensor._internal.decide(election('PC', [scanner('PC', -59)]), 1000);
    assert.ok(p, 'first acquisition must emit');
    assert.equal(p.detail.phase, 'TRANSFER', 'the live FSM phase must ride the perception');
    assert.equal(p.detail.speakingScanner, 'PC');
  });

  it('conversation broadcast alone must NOT emit (enrichment-only, like ranging)', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: SILENT });
    sensor._internal._reset();
    // Ingest a handoff event with no election: nothing may be emitted.
    assert.doesNotThrow(function () {
      sensor._internal.ingest({
        type: 'conversation',
        transcript: [],
        utterance: null,
        speakingScanner: 'PC',
        phase: 'PREPARE',
        phaseFrom: 'PC',
        phaseTo: 'Phone',
        conversationEvent: { phase: 'PREPARE', fromScanner: 'PC', toScanner: 'Phone', atTick: 4830 }
      });
    });
    // decide() with no owner still must not emit a perception.
    assert.equal(sensor._internal.decide(election(null, []), 1000), null);
  });

  it('the one-shot conversationEvent is carried exactly once, then cleared', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: SILENT });
    sensor._internal._reset();
    sensor._internal.decide(election('PC', [scanner('PC', -59)]), 1000); // acquire PC
    // Handoff begins: one-shot conversationEvent marks the transition.
    sensor._internal.ingest({
      type: 'conversation',
      transcript: [],
      utterance: { text: '...', audioBase64: null, durationMs: 2400, offsetMs: 0, isSynthetic: false },
      speakingScanner: 'PC',
      phase: 'PREPARE',
      phaseFrom: 'PC',
      phaseTo: 'Phone',
      conversationEvent: { phase: 'PREPARE', fromScanner: 'PC', toScanner: 'Phone', atTick: 4830 }
    });
    var p1 = sensor._internal.decide(election('Phone', [scanner('Phone', -42)], { from: 'PC', to: 'Phone', atTick: 4830 }), 2000);
    assert.ok(p1, 'owner transition must emit');
    assert.deepEqual(p1.detail.handoffPhase, { phase: 'PREPARE', from: 'PC', to: 'Phone' });
    assert.equal(p1.detail.phase, 'PREPARE');

    // Next perception (owner stable, force a drift re-emit): the one-shot
    // event must NOT be carried again.
    var p2 = sensor._internal.decide(election('Phone', [scanner('Phone', -30)]), 3000);
    assert.ok(p2, 'drift past throttle must emit');
    assert.equal(p2.detail.handoffPhase, null, 'one-shot event is consumed by the first perception');
  });

  it('one-shot event survives a deduped election (consumed only on a real emit)', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: SILENT });
    sensor._internal._reset();
    var e = election('PC', [scanner('PC', -59)]);
    assert.ok(sensor._internal.decide(e, 1000), 'first acquisition must emit');
    // Handoff begins while the owner is still stable: the event arrives, but
    // the very next election is identical -> deduped (decide returns null).
    sensor._internal.ingest({
      type: 'conversation',
      transcript: [],
      utterance: { text: '...', audioBase64: null, durationMs: 2400, offsetMs: 0, isSynthetic: false },
      speakingScanner: 'PC',
      phase: 'PREPARE',
      phaseFrom: 'PC',
      phaseTo: 'Phone',
      conversationEvent: { phase: 'PREPARE', fromScanner: 'PC', toScanner: 'Phone', atTick: 4830 }
    });
    assert.equal(sensor._internal.decide(e, 1100), null, 'identical broadcast is deduped');
    // The event must NOT have been eaten by the deduped broadcast — the next
    // real emit (a >=3 dBm drift past the 1 Hz throttle) still carries it.
    var p = sensor._internal.decide(election('PC', [scanner('PC', -50)]), 2100);
    assert.ok(p, 'drift past throttle must emit');
    assert.deepEqual(p.detail.handoffPhase, { phase: 'PREPARE', from: 'PC', to: 'Phone' },
      'one-shot event must survive a deduped broadcast and ride the next real emit');
    assert.equal(p.detail.phase, 'PREPARE');
  });

  it('socket drop resets the conversation FSM cache (no stale phase after reconnect)', async function () {
    var bus = fakeBus();
    var agg = await fakeAggregator();
    var sensor = createAetherSensor({
      bus: bus,
      config: { AETHER_WS_URL: 'ws://127.0.0.1:' + agg.port },
      logger: SILENT
    });
    sensor.start();
    try {
      assert.ok(await waitFor(function () { return agg.wss.clients.size === 1; }, 1000), 'sensor must connect');
      var client = [...agg.wss.clients][0];
      client.send(JSON.stringify({
        type: 'conversation',
        transcript: [],
        utterance: null,
        speakingScanner: 'PC',
        phase: 'TRANSFER',
        phaseFrom: 'PC',
        phaseTo: 'Phone',
        conversationEvent: { phase: 'TRANSFER', fromScanner: 'PC', toScanner: 'Phone', atTick: 4831 }
      }));
      client.send(JSON.stringify(election('PC', [scanner('PC', -59)])));
      assert.ok(await waitFor(function () { return bus._events.length === 1; }, 1000), 'perception must emit');
      assert.equal(bus._events[0].payload.detail.phase, 'TRANSFER');
      assert.deepEqual(bus._events[0].payload.detail.handoffPhase, { phase: 'TRANSFER', from: 'PC', to: 'Phone' });

      // Kill the socket: drop must clear the FSM cache.
      client.close();
      assert.ok(await waitFor(function () { return bus._events.length === 2; }, 1000), 'offline must emit');
      assert.equal(bus._events[1].payload.detail.phase, 'IDLE', 'offline has no FSM phase');
      assert.equal(bus._events[1].payload.detail.handoffPhase, null);
    } finally {
      sensor.stop();
      await closeAggregator(agg.wss);
    }
  });

  it('speak() sends {type:say, text} over the live socket to the aggregator (Phase 2)', async function () {
    var agg = await fakeAggregator();
    var sensor = createAetherSensor({
      bus: fakeBus(),
      config: { AETHER_WS_URL: 'ws://127.0.0.1:' + agg.port },
      logger: SILENT
    });
    sensor.start();
    try {
      assert.ok(await waitFor(function () { return agg.wss.clients.size === 1; }, 1000), 'sensor must connect');
      var client = [...agg.wss.clients][0];
      var received = new Promise(function (resolve) {
        client.on('message', function (raw) { resolve(JSON.parse(raw.toString())); });
      });
      assert.equal(sensor.speak('hello from agent os'), true, 'speak must report the send went out');
      var msg = await received;
      assert.equal(msg.type, 'say');
      assert.equal(msg.text, 'hello from agent os');
    } finally {
      sensor.stop();
      await closeAggregator(agg.wss);
    }
  });

  it('speak() returns false (never throws) when the socket is down or the text is empty', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: SILENT });
    assert.equal(sensor.speak('anyone there?'), false, 'never-connected sensor cannot speak');
    assert.equal(sensor.speak('   '), false, 'blank text must be rejected');
    assert.equal(sensor.speak(null), false);
    assert.doesNotThrow(function () { sensor.speak('x'); });
    sensor.stop();
    assert.equal(sensor.speak('after stop'), false);
  });

  // ---- Phase 4: speak-gating (defer say during a handoff, drain on IDLE) ----

  // Same-socket `conversation` broadcast builder (messages.py locked schema).
  function conversation(phase, speakingScanner) {
    return {
      type: 'conversation',
      transcript: [],
      utterance: null,
      speakingScanner: speakingScanner,
      phase: phase,
      phaseFrom: phase === 'IDLE' ? null : 'PC',
      phaseTo: phase === 'IDLE' ? null : 'Phone',
      conversationEvent: null
    };
  }

  it('Phase 4 speak-gating: speak() defers while the FSM is mid-handoff, drains on IDLE', async function () {
    var agg = await fakeAggregator();
    var sensor = createAetherSensor({
      bus: fakeBus(),
      config: { AETHER_WS_URL: 'ws://127.0.0.1:' + agg.port },
      logger: SILENT
    });
    sensor.start();
    try {
      assert.ok(await waitFor(function () { return agg.wss.clients.size === 1; }, 1000), 'sensor must connect');
      var client = [...agg.wss.clients][0];
      var received = [];
      client.on('message', function (raw) { received.push(JSON.parse(raw.toString())); });

      // FSM mid-handoff: the say must be deferred, not sent.
      client.send(JSON.stringify(conversation('TRANSFER', 'PC')));
      await sleep(50);
      assert.equal(sensor.speak('hello during handoff'), true, 'must queue optimistically');
      assert.ok(sensor._internal._queueState().queued, 'the say must be queued while busy');
      await sleep(50);
      assert.equal(received.length, 0, 'nothing may reach the wire while the FSM is busy');

      // FSM returns to idle: the queued say drains immediately.
      client.send(JSON.stringify(conversation('IDLE', null)));
      assert.ok(await waitFor(function () { return received.length === 1; }, 1000), 'queued say must drain on IDLE');
      assert.equal(received[0].type, 'say');
      assert.equal(received[0].text, 'hello during handoff');
      assert.equal(sensor._internal._queueState().queued, null, 'queue must be empty after the drain');
    } finally {
      sensor.stop();
      await closeAggregator(agg.wss);
    }
  });

  it('Phase 4 speak-gating: speak() sends immediately when the FSM is IDLE (no queue)', async function () {
    var agg = await fakeAggregator();
    var sensor = createAetherSensor({
      bus: fakeBus(),
      config: { AETHER_WS_URL: 'ws://127.0.0.1:' + agg.port },
      logger: SILENT
    });
    sensor.start();
    try {
      assert.ok(await waitFor(function () { return agg.wss.clients.size === 1; }, 1000), 'sensor must connect');
      var client = [...agg.wss.clients][0];
      // Explicitly idle FSM (the default state when Aether audio routing is off).
      client.send(JSON.stringify(conversation('IDLE', null)));
      await sleep(50);
      var received = new Promise(function (resolve) {
        client.once('message', function (raw) { resolve(JSON.parse(raw.toString())); });
      });
      assert.equal(sensor.speak('hi when idle'), true);
      var msg = await received;
      assert.equal(msg.type, 'say');
      assert.equal(msg.text, 'hi when idle');
      assert.equal(sensor._internal._queueState().queued, null, 'the idle path must never queue');
    } finally {
      sensor.stop();
      await closeAggregator(agg.wss);
    }
  });

  it('Phase 4 speak-gating: the queue is capped at 1 — a second speak replaces the first', async function () {
    var agg = await fakeAggregator();
    var sensor = createAetherSensor({
      bus: fakeBus(),
      config: { AETHER_WS_URL: 'ws://127.0.0.1:' + agg.port },
      logger: SILENT
    });
    sensor.start();
    try {
      assert.ok(await waitFor(function () { return agg.wss.clients.size === 1; }, 1000), 'sensor must connect');
      var client = [...agg.wss.clients][0];
      var received = [];
      client.on('message', function (raw) { received.push(JSON.parse(raw.toString())); });
      client.send(JSON.stringify(conversation('TRANSFER', 'PC')));
      await sleep(50);
      assert.equal(sensor.speak('first'), true);
      assert.equal(sensor.speak('second'), true);
      assert.equal(sensor._internal._queueState().queued.text, 'second', 'newest must replace the queued first');
      client.send(JSON.stringify(conversation('IDLE', null)));
      assert.ok(await waitFor(function () { return received.length === 1; }, 1000), 'exactly one say may drain');
      assert.equal(received[0].text, 'second', 'only the newest may reach the wire');
    } finally {
      sensor.stop();
      await closeAggregator(agg.wss);
    }
  });

  it('Phase 4 speak-gating: the safety timer delivers the queued text even if IDLE never returns', async function () {
    var agg = await fakeAggregator();
    var sensor = createAetherSensor({
      bus: fakeBus(),
      config: { AETHER_WS_URL: 'ws://127.0.0.1:' + agg.port },
      logger: SILENT
    });
    sensor.start();
    try {
      assert.ok(await waitFor(function () { return agg.wss.clients.size === 1; }, 1000), 'sensor must connect');
      var client = [...agg.wss.clients][0];
      var received = [];
      client.on('message', function (raw) { received.push(JSON.parse(raw.toString())); });
      client.send(JSON.stringify(conversation('TRANSFER', 'PC')));
      await sleep(50);
      assert.equal(sensor.speak('fail-open text'), true);
      assert.equal(sensor._internal._queueState().timerActive, true, 'safety timer must be armed');
      // No IDLE broadcast ever arrives — the timer must fail open (~1.2s).
      assert.ok(await waitFor(function () { return received.length === 1; }, 2500), 'queued text must reach the wire via the safety timer');
      assert.equal(received[0].text, 'fail-open text');
      assert.equal(sensor._internal._queueState().queued, null);
      assert.equal(sensor._internal._queueState().timerActive, false);
    } finally {
      sensor.stop();
      await closeAggregator(agg.wss);
    }
  });

  it('Phase 4 speak-gating: a socket drop clears the queued say (no stale send after reconnect)', async function () {
    var agg = await fakeAggregator();
    var sensor = createAetherSensor({
      bus: fakeBus(),
      config: { AETHER_WS_URL: 'ws://127.0.0.1:' + agg.port },
      logger: SILENT
    });
    sensor.start();
    try {
      assert.ok(await waitFor(function () { return agg.wss.clients.size === 1; }, 1000), 'sensor must connect');
      var client = [...agg.wss.clients][0];
      client.send(JSON.stringify(conversation('TRANSFER', 'PC')));
      await sleep(50);
      assert.equal(sensor.speak('stale queued text'), true);
      assert.ok(sensor._internal._queueState().queued, 'must be queued');

      // Kill the connection: the drop must clear queue and timer.
      client.close();
      assert.ok(await waitFor(function () { return agg.wss.clients.size === 0; }, 1000), 'connection must drop');
      assert.equal(sensor._internal._queueState().queued, null, 'drop must clear the queued say');
      assert.equal(sensor._internal._queueState().timerActive, false, 'drop must clear the safety timer');

      // Reconnect: the stale text must never arrive; the next speak works.
      assert.ok(await waitFor(function () { return agg.wss.clients.size === 1; }, 3000), 'sensor must reconnect');
      var reconnected = [...agg.wss.clients][0];
      var staleArrived = false;
      reconnected.on('message', function (raw) {
        if (JSON.parse(raw.toString()).type === 'say') staleArrived = true;
      });
      await sleep(150);
      assert.equal(staleArrived, false, 'the pre-drop queued text must never be sent after reconnect');
      var fresh = new Promise(function (resolve) {
        reconnected.once('message', function (raw) { resolve(JSON.parse(raw.toString())); });
      });
      assert.equal(sensor.speak('fresh after reconnect'), true, 'forward progress must continue');
      assert.equal((await fresh).text, 'fresh after reconnect');
    } finally {
      sensor.stop();
      await closeAggregator(agg.wss);
    }
  });

  it('Phase 4 speak-gating: stop() clears the queued say and the safety timer', async function () {
    var agg = await fakeAggregator();
    var sensor = createAetherSensor({
      bus: fakeBus(),
      config: { AETHER_WS_URL: 'ws://127.0.0.1:' + agg.port },
      logger: SILENT
    });
    sensor.start();
    try {
      assert.ok(await waitFor(function () { return agg.wss.clients.size === 1; }, 1000), 'sensor must connect');
      var client = [...agg.wss.clients][0];
      client.send(JSON.stringify(conversation('TRANSFER', 'PC')));
      await sleep(50);
      assert.equal(sensor.speak('queued then stopped'), true);
      assert.ok(sensor._internal._queueState().queued, 'must be queued');
      assert.ok(sensor._internal._queueState().timerActive, 'timer must be armed');

      sensor.stop();
      assert.equal(sensor._internal._queueState().queued, null, 'stop must clear the queue');
      assert.equal(sensor._internal._queueState().timerActive, false, 'stop must clear the timer');

      // Nothing may arrive even past the old timer deadline — the timer was
      // cleared, not merely orphaned.
      var lateArrived = false;
      client.on('message', function () { lateArrived = true; });
      await sleep(1400);
      assert.equal(lateArrived, false, 'a stopped sensor must never deliver the queued text');
    } finally {
      await closeAggregator(agg.wss);
    }
  });

});
