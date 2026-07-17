'use strict';

// Phase 2 Jarvis upgrade — ambient screen awareness sensor. Mirrors
// gmail-triage-sensor.test.js's structure: fake bus, node:test mock timers
// for the interval, generation-token stop() semantics, flushMicrotasks()
// between a timer tick and asserting on emitted bus events (poll() is async).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { fakeBus } = require('./helpers');
const { createScreenSensor } = require('../src/core/sensors/screen-sensor');

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

// A minimal but valid-looking base64 payload — the sensor never decodes it,
// just hashes it and forwards it as a data URL, so any non-empty string works.
const B64_A = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const B64_B = 'aVZCT1J3MEtHZ29BQUFBTlNVaEVVZ0FBQUFFQUFBQUJDQVlBQUFBZkZjU0pBQUFBRFVsRVFWUjQ=';

function okShot(b64) {
  return { ok: true, result: { png: b64 } };
}

function fakePcChild(b64Sequence) {
  let i = 0;
  return {
    sendCommand: async (cmd) => {
      assert.equal(cmd.cmd, 'screen_look');
      const b64 = b64Sequence[Math.min(i, b64Sequence.length - 1)];
      i += 1;
      return okShot(b64);
    },
  };
}

function fakeBrain(reply) {
  const calls = [];
  return {
    calls,
    think: async (args) => {
      calls.push(args);
      if (reply === undefined) return { content: 'Working in VS Code on a JavaScript file.', offline: false };
      return reply;
    },
  };
}

describe('sensors/screen: createScreenSensor', () => {
  it('throws in the constructor if bus is missing', () => {
    assert.throws(() => createScreenSensor({ bus: null, config: {}, brain: fakeBrain(), pcChild: fakePcChild([B64_A]) }));
  });

  it('emits perception.screen with the correct shape on a genuinely new screen', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    const bus = fakeBus();
    const brain = fakeBrain();
    const pcChild = fakePcChild([B64_A]);
    const sensor = createScreenSensor({ bus, config: { SCREEN_AWARENESS_POLL_MS: 30000, SCREEN_AWARENESS_SALIENCE: 0.3 }, brain, pcChild });

    sensor.start();
    t.mock.timers.tick(30000);
    await flushMicrotasks();
    await flushMicrotasks(); // one extra tick for the brain.think() promise chain

    const evt = bus._lastEvent('perception.screen');
    assert.ok(evt, 'expected a perception.screen event');
    assert.equal(evt.payload.kind, 'screen');
    assert.equal(evt.payload.channel, 'ambient-screen');
    assert.equal(evt.payload.salience, 0.3);
    assert.equal(typeof evt.payload.ts, 'number');
    assert.equal(evt.payload.summary, 'Working in VS Code on a JavaScript file.');
    assert.equal(evt.payload.detail.description, 'Working in VS Code on a JavaScript file.');
    assert.equal(brain.calls.length, 1);
    assert.equal(brain.calls[0].lane, 'vision');
    assert.equal(brain.calls[0].source, 'screen-sensor');
    assert.match(brain.calls[0].messages[0].content[0].text, /what is the user doing on this screen/i);
    assert.match(brain.calls[0].messages[0].content[1].image_url.url, /^data:image\/png;base64,/);

    sensor.stop();
  });

  it('an identical screen on the second poll makes ZERO brain.think calls (hash gate)', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    const bus = fakeBus();
    const brain = fakeBrain();
    const pcChild = fakePcChild([B64_A, B64_A]); // same screenshot both polls
    const sensor = createScreenSensor({ bus, config: { SCREEN_AWARENESS_POLL_MS: 1000 }, brain, pcChild });

    sensor.start();
    t.mock.timers.tick(1000);
    await flushMicrotasks();
    await flushMicrotasks();
    assert.equal(brain.calls.length, 1, 'first poll (new screen) should call the vision brain once');

    t.mock.timers.tick(1000);
    await flushMicrotasks();
    await flushMicrotasks();
    assert.equal(brain.calls.length, 1, 'second poll with an identical screen must make ZERO additional brain.think calls');

    const events = bus._emitted().filter((e) => e.type === 'perception.screen');
    assert.equal(events.length, 1, 'only the first (genuinely new) screen should emit perception.screen');

    sensor.stop();
  });

  it('a changed screen on the second poll calls the vision brain again and emits a new event', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    const bus = fakeBus();
    const brain = fakeBrain();
    const pcChild = fakePcChild([B64_A, B64_B]);
    const sensor = createScreenSensor({ bus, config: { SCREEN_AWARENESS_POLL_MS: 1000 }, brain, pcChild });

    sensor.start();
    t.mock.timers.tick(1000);
    await flushMicrotasks();
    await flushMicrotasks();

    t.mock.timers.tick(1000);
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(brain.calls.length, 2, 'a genuinely changed screen must trigger a fresh vision call');
    const events = bus._emitted().filter((e) => e.type === 'perception.screen');
    assert.equal(events.length, 2);

    sensor.stop();
  });

  it('pcChild offline (sendCommand rejects) emits nothing and does not throw', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    const bus = fakeBus();
    const brain = fakeBrain();
    const pcChild = { sendCommand: async () => { throw new Error('PC automation offline'); } };
    const sensor = createScreenSensor({ bus, config: { SCREEN_AWARENESS_POLL_MS: 1000 }, brain, pcChild });

    sensor.start();
    t.mock.timers.tick(1000);
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(bus._lastEvent('perception.screen'), null);
    assert.equal(brain.calls.length, 0);

    sensor.stop();
  });

  it('pcChild reporting { ok:false } emits nothing and does not throw', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    const bus = fakeBus();
    const brain = fakeBrain();
    const pcChild = { sendCommand: async () => ({ ok: false, result: 'PC automation is OFFLINE.' }) };
    const sensor = createScreenSensor({ bus, config: { SCREEN_AWARENESS_POLL_MS: 1000 }, brain, pcChild });

    sensor.start();
    t.mock.timers.tick(1000);
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(bus._lastEvent('perception.screen'), null);
    assert.equal(brain.calls.length, 0);

    sensor.stop();
  });

  it('vision brain offline/empty result skips the emit without throwing', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    const bus = fakeBus();
    const brain = fakeBrain({ offline: true, content: null });
    const pcChild = fakePcChild([B64_A]);
    const sensor = createScreenSensor({ bus, config: { SCREEN_AWARENESS_POLL_MS: 1000 }, brain, pcChild });

    sensor.start();
    t.mock.timers.tick(1000);
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(bus._lastEvent('perception.screen'), null);

    sensor.stop();
  });

  it('no brain available skips the emit without throwing', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    const bus = fakeBus();
    const pcChild = fakePcChild([B64_A]);
    const sensor = createScreenSensor({ bus, config: { SCREEN_AWARENESS_POLL_MS: 1000 }, brain: null, pcChild });

    sensor.start();
    t.mock.timers.tick(1000);
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(bus._lastEvent('perception.screen'), null);

    sensor.stop();
  });

  it('never polls if start() is not called — mirrors main.js only starting the sensor when SCREEN_AWARENESS_ENABLED is true', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    const bus = fakeBus();
    const brain = fakeBrain();
    const pcChild = fakePcChild([B64_A]);
    createScreenSensor({ bus, config: { SCREEN_AWARENESS_POLL_MS: 1000 }, brain, pcChild });
    // start() intentionally never called.

    t.mock.timers.tick(100000);
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(bus._lastEvent('perception.screen'), null);
    assert.equal(brain.calls.length, 0);
  });

  it('stops polling once stop() is called', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    const bus = fakeBus();
    const brain = fakeBrain();
    const pcChild = fakePcChild([B64_A]);
    const sensor = createScreenSensor({ bus, config: { SCREEN_AWARENESS_POLL_MS: 1000 }, brain, pcChild });

    sensor.start();
    assert.equal(sensor.isRunning(), true);
    sensor.stop();
    assert.equal(sensor.isRunning(), false);

    t.mock.timers.tick(10000);
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(bus._lastEvent('perception.screen'), null, 'sensor must not poll after stop()');
    assert.equal(brain.calls.length, 0);
  });

  it('generation token: a poll already in-flight when stop() is called must not emit once it resolves (classic stale-poll regression)', async (t) => {
    const bus = fakeBus();
    let resolveThink;
    const brain = {
      calls: [],
      think: function (args) {
        brain.calls.push(args);
        return new Promise((resolve) => { resolveThink = resolve; });
      },
    };
    const pcChild = fakePcChild([B64_A]);
    const sensor = createScreenSensor({ bus, config: { SCREEN_AWARENESS_POLL_MS: 1000 }, brain, pcChild });

    // Kick a poll directly (avoids fighting mock timers over the in-flight promise).
    sensor.start();
    const inFlight = sensor._internal.poll(1); // generation 1, matches start()'s own generation
    await flushMicrotasks(); // let sendCommand + hash-gate resolve, brain.think() is now pending

    sensor.stop(); // bumps the generation token — the in-flight poll is now stale
    resolveThink({ content: 'Should never be emitted.', offline: false });
    await inFlight;
    await flushMicrotasks();

    assert.equal(bus._lastEvent('perception.screen'), null, 'a stale (pre-stop) poll must not emit after resolving');
  });
});
