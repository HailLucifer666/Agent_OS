'use strict';

// Aether-BLE proximity-focus sensor — Phase 1 wiring tests.
//
// The sensor connects OUT to the Aether aggregator's WS and consumes its locked
// `election` broadcast. The whole point is the dedup gate: the aggregator fires
// every 400ms, but the cortex perception queue drains 1×/sec (cap 50), so we
// must emit ONLY on owner transition, first acquisition, or a meaningful RSSI
// drift (≥3 dBm, throttled 1 Hz). These cases exercise the gate directly via
// the injectFocus/decide test hooks — no live socket needed for gate logic.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAetherSensor } = require('../src/core/sensors/aether');

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

describe('aether-sensor (Phase 1)', function () {

  it('emits perception.aether on first acquisition with correct shape', function () {
    var bus = fakeBus();
    var sensor = createAetherSensor({ bus: bus, config: {}, logger: { info: function () {} } });
    sensor._internal._reset();
    var p = sensor._internal.injectFocus(election('PC', [scanner('PC', -59)]));
    assert.ok(p, 'first acquisition must produce a perception');
    assert.equal(p.kind, 'aether');
    assert.equal(p.channel, 'aether');
    assert.equal(p.salience, 0.5);
    assert.equal(p.detail.owner, 'PC');
    assert.equal(p.detail.rssi, -59);
    assert.equal(p.detail.connected, true);
    assert.ok(p.summary.indexOf('PC') !== -1);
    assert.ok(p.summary.indexOf('-59') !== -1);
    sensor.stop();
  });

  it('dedup: repeated same-owner broadcasts do NOT re-emit', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: { info: function () {} } });
    sensor._internal._reset();
    var e = election('PC', [scanner('PC', -59)]);
    var p1 = sensor._internal.injectFocus(e);
    var p2 = sensor._internal.injectFocus(e);
    var p3 = sensor._internal.injectFocus(e);
    assert.ok(p1, 'first must emit');
    assert.equal(p2, null, 'second identical broadcast must be a no-op');
    assert.equal(p3, null, 'third identical broadcast must be a no-op');
    sensor.stop();
  });

  it('owner transition emits with handoff flag derived from lastHandoff', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: { info: function () {} } });
    sensor._internal._reset();
    // Acquire PC first.
    sensor._internal.injectFocus(election('PC', [scanner('PC', -59)]));
    // Walk to Phone — aggregator records the handoff.
    var p = sensor._internal.injectFocus(election('Phone', [scanner('Phone', -42)], { from: 'PC', to: 'Phone', atTick: 2 }));
    assert.ok(p, 'owner change must emit');
    assert.equal(p.detail.owner, 'Phone');
    assert.equal(p.detail.handoff, true);
    assert.equal(p.detail.fromDevice, 'PC');
    sensor.stop();
  });

  it('owner change without a recorded lastHandoff emits handoff:false', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: { info: function () {} } });
    sensor._internal._reset();
    sensor._internal.injectFocus(election('PC', [scanner('PC', -59)]));
    // No lastHandoff payload — still a transition, but not a recorded handoff.
    var p = sensor._internal.injectFocus(election('Phone', [scanner('Phone', -42)]));
    assert.ok(p);
    assert.equal(p.detail.owner, 'Phone');
    assert.equal(p.detail.handoff, false);
    sensor.stop();
  });

  it('owner stable + <3 dBm drift does NOT re-emit (noise floor)', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: { info: function () {} } });
    sensor._internal._reset();
    sensor._internal.injectFocus(election('PC', [scanner('PC', -59)]));
    var p = sensor._internal.injectFocus(election('PC', [scanner('PC', -61)])); // 2 dBm drift
    assert.equal(p, null, 'sub-threshold jitter must not re-emit');
    sensor.stop();
  });

  it('owner stable + >=3 dBm drift re-emits (throttled 1 Hz)', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: { info: function () {} } });
    sensor._internal._reset();
    // Drive decide() with controlled timestamps to exercise the throttle.
    sensor._internal._reset();
    sensor._internal.decide(election('PC', [scanner('PC', -59)]), 1000); // first emit
    var p1 = sensor._internal.decide(election('PC', [scanner('PC', -50)]), 1100); // 9 dBm drift, 100ms later
    assert.equal(p1, null, 'drift within 1 Hz throttle window must not emit');
    var p2 = sensor._internal.decide(election('PC', [scanner('PC', -50)]), 2100); // 1100ms later — past throttle
    assert.ok(p2, 'drift past throttle window must emit');
    assert.equal(p2.detail.rssi, -50);
    sensor.stop();
  });

  it('swallows malformed election payloads (fail-honest-inert)', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: { info: function () {} } });
    sensor._internal._reset();
    assert.equal(sensor._internal.injectFocus(null), null);
    assert.equal(sensor._internal.injectFocus({}), null);
    assert.equal(sensor._internal.injectFocus({ type: 'reading' }), null); // wrong type
    assert.equal(sensor._internal.injectFocus({ type: 'election', owner: null, scanners: [] }), null); // null owner, never acquired
    sensor.stop();
  });

  it('falls back to raw rssi when smoothedRssi is absent', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: { info: function () {} } });
    sensor._internal._reset();
    var p = sensor._internal.injectFocus(election('PC', [{ id: 'PC', rssi: -55, lastSeenMs: 1, present: true }]));
    assert.ok(p);
    assert.equal(p.detail.rssi, -55);
    sensor.stop();
  });

  it('null owner after acquisition is a loss transition (emits)', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: { info: function () {} } });
    sensor._internal._reset();
    sensor._internal.injectFocus(election('PC', [scanner('PC', -59)]));
    var p = sensor._internal.injectFocus(election(null, []));
    assert.ok(p, 'loss of owner must emit');
    assert.equal(p.detail.owner, null);
    sensor.stop();
  });

  it('isRunning() reflects start/stop state', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: { info: function () {} } });
    assert.equal(sensor.isRunning(), false);
    sensor.start();
    assert.equal(sensor.isRunning(), true);
    sensor.stop();
    assert.equal(sensor.isRunning(), false);
  });

  it('start/stop are idempotent', function () {
    var sensor = createAetherSensor({ bus: fakeBus(), config: {}, logger: { info: function () {} } });
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
      logger: { info: function () {}, warn: function () {}, error: function () {} }
    });
    assert.doesNotThrow(function () { sensor.start(); });
    assert.equal(sensor.isRunning(), true);
    // Drain the connection-failure microtask before tearing down so the
    // deferred 'error'/'close' events fire while the no-op listener is attached.
    await new Promise(function (resolve) { setTimeout(resolve, 80); });
    assert.doesNotThrow(function () { sensor.stop(); });
    assert.equal(sensor.isRunning(), false);
  });

});
