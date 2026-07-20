'use strict';

// Phase 4 / Area D — V8 opt-in active-window perception sensor.
//
// Distinct from screen-sensor.js (vision captions). This sensor reads the
// foreground window's app/title via pc-child 'active_window' and emits
// perception.window with structured {app, title, pid} metadata.
// Hash-gated so unchanged focus = zero emits (keeps the OODA queue clean).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createWindowSensor } = require('../src/core/sensors/window-sensor');

function fakePcChild(responses) {
  var calls = 0;
  return {
    sendCommand: async function (cmd) {
      if (cmd.cmd !== 'active_window') return { ok: false, error: 'unknown cmd' };
      var r = responses[calls] || responses[responses.length - 1];
      calls++;
      return r;
    },
    _calls: function () { return calls; }
  };
}

function fakeBus() {
  var events = [];
  return { emit: function (n, p) { events.push({ name: n, payload: p }); }, _events: events };
}

function pollOnce(sensor) { return sensor._internal.poll(sensor._internal.gen()); }

describe('Phase 4 / Area D — window-sensor (V8)', function () {

  it('emits perception.window with structured app/title metadata', async function () {
    var pcChild = fakePcChild([{ ok: true, result: { app: 'Code', title: 'main.js - my-project', pid: 1234 } }]);
    var bus = fakeBus();
    var sensor = createWindowSensor({ pcChild: pcChild, bus: bus, config: {} });
    sensor.start();
    await pollOnce(sensor);
    sensor.stop();
    var win = bus._events.find(function (e) { return e.name === 'perception.window'; });
    assert.ok(win, 'must emit perception.window');
    assert.equal(win.payload.kind, 'window');
    assert.equal(win.payload.channel, 'window');
    assert.equal(win.payload.detail.app, 'Code');
    assert.equal(win.payload.detail.title, 'main.js - my-project');
    assert.equal(win.payload.detail.pid, 1234);
    assert.ok(win.payload.summary.indexOf('Code') !== -1);
    assert.ok(win.payload.summary.indexOf('main.js') !== -1);
  });

  it('hash-gates: same app+title across polls emits only once', async function () {
    var pcChild = fakePcChild([{ ok: true, result: { app: 'Code', title: 'same', pid: 1 } }]);
    var bus = fakeBus();
    var sensor = createWindowSensor({ pcChild: pcChild, bus: bus, config: {} });
    sensor.start();
    await pollOnce(sensor);
    await pollOnce(sensor);
    await pollOnce(sensor);
    sensor.stop();
    var wins = bus._events.filter(function (e) { return e.name === 'perception.window'; });
    assert.equal(wins.length, 1, 'unchanged focus must not re-emit');
  });

  it('emits again when the foreground window changes', async function () {
    var pcChild = fakePcChild([
      { ok: true, result: { app: 'Code', title: 'a.js', pid: 1 } },
      { ok: true, result: { app: 'chrome', title: 'gmail', pid: 2 } }
    ]);
    var bus = fakeBus();
    var sensor = createWindowSensor({ pcChild: pcChild, bus: bus, config: {} });
    sensor.start();
    await pollOnce(sensor);
    await pollOnce(sensor);
    sensor.stop();
    var wins = bus._events.filter(function (e) { return e.name === 'perception.window'; });
    assert.equal(wins.length, 2);
    assert.equal(wins[0].payload.detail.app, 'Code');
    assert.equal(wins[1].payload.detail.app, 'chrome');
  });

  it('respects custom WINDOW_AWARENESS_SALIENCE', async function () {
    var pcChild = fakePcChild([{ ok: true, result: { app: 'X', title: 'Y', pid: 1 } }]);
    var bus = fakeBus();
    var sensor = createWindowSensor({
      pcChild: pcChild, bus: bus,
      config: { WINDOW_AWARENESS_SALIENCE: 0.7 }
    });
    sensor.start();
    await pollOnce(sensor);
    sensor.stop();
    var win = bus._events.find(function (e) { return e.name === 'perception.window'; });
    assert.equal(win.payload.salience, 0.7);
  });

  it('skips empty windows (no app AND no title — desktop focus)', async function () {
    var pcChild = fakePcChild([{ ok: true, result: { app: '', title: '', pid: 0 } }]);
    var bus = fakeBus();
    var sensor = createWindowSensor({ pcChild: pcChild, bus: bus, config: {} });
    sensor.start();
    await pollOnce(sensor);
    sensor.stop();
    var wins = bus._events.filter(function (e) { return e.name === 'perception.window'; });
    assert.equal(wins.length, 0, 'empty focus must not emit');
  });

  it('never throws when pcChild is absent (defensive)', async function () {
    var sensor = createWindowSensor({ pcChild: null, bus: fakeBus(), config: {} });
    sensor.start();
    await assert.doesNotReject(async function () { await pollOnce(sensor); });
    sensor.stop();
  });

  it('never throws on pcChild errors (best-effort)', async function () {
    var badPcChild = { sendCommand: async function () { throw new Error('crash'); } };
    var sensor = createWindowSensor({ pcChild: badPcChild, bus: fakeBus(), config: {} });
    sensor.start();
    await assert.doesNotReject(async function () { await pollOnce(sensor); });
    sensor.stop();
  });

  it('never throws when pcChild returns an error response', async function () {
    var pcChild = fakePcChild([{ ok: false, error: 'command not found' }]);
    var sensor = createWindowSensor({ pcChild: pcChild, bus: fakeBus(), config: {} });
    sensor.start();
    await assert.doesNotReject(async function () { await pollOnce(sensor); });
    sensor.stop();
  });

  it('isRunning() reflects start/stop state', function () {
    var sensor = createWindowSensor({
      pcChild: fakePcChild([{ ok: true, result: { app: 'a', title: 'b', pid: 1 } }]),
      bus: fakeBus(), config: {}
    });
    assert.equal(sensor.isRunning(), false);
    sensor.start();
    assert.equal(sensor.isRunning(), true);
    sensor.stop();
    assert.equal(sensor.isRunning(), false);
  });

});
