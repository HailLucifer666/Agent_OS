'use strict';

// test/aether-proxy-rebind-playbook.test.js — Wave 7 (2026-08-13).
//
// main.js's aether-proxy-bind-failed anomaly used to stop() the scanner-proxy
// and leave it dead for the rest of the process — nothing ever retried.
// scanner-proxy.js's own start()/stop() comments document exactly this as
// the sanctioned recovery path ("the caller retry start() after fixing
// whatever held the port"), most commonly a stale MYTHOS instance still
// releasing its ports on exit. This is a SAME-PORT retry, deliberately never
// a port shift — "PORT ORDER IS THE CONTRACT" in that file's own header: the
// Aether aggregator is a separate, externally-run process pointed at these
// exact ports via --peers, so silently moving to a different base would
// misattribute room readings instead of failing loudly.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createHealer } = require('../src/core/immune/healer');

function fakeBus() {
  const { createBus } = require('../src/core/bus');
  const bus = createBus({ historySize: 200 });
  const emitted = [];
  const origEmit = bus.emit.bind(bus);
  bus.emit = function(type, payload, opts) {
    emitted.push({ type, payload });
    return origEmit(type, payload, opts);
  };
  bus._emitted = () => emitted.slice();
  return bus;
}

function fakeMemory() {
  return { audit: { write: () => ({ ok: true }) }, fs: { listFiles: () => [] } };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

describe('immune/healer — aether-proxy-rebind playbook', () => {
  it('a successful retry reports outcome:applied and calls start()+whenReady()', async () => {
    const bus = fakeBus();
    let startCalled = 0;
    const proxy = {
      start: () => { startCalled++; },
      whenReady: () => Promise.resolve(),
      ports: () => [4480, 4481],
    };
    const healer = createHealer({
      bus, config: {}, memory: fakeMemory(),
      getCortex: () => null, getGoals: () => null,
      getScannerProxy: () => proxy,
    });
    healer.start();

    bus.emit('health.diagnosed', { kind: 'aether-proxy-bind-failed', target: 'ports 4480, 4481' });
    await sleep(10);

    const healed = bus._emitted().filter((e) => e.type === 'health.healed');
    assert.equal(healed.length, 1);
    assert.equal(healed[0].payload.playbookId, 'aether-proxy-rebind');
    assert.equal(healed[0].payload.outcome, 'applied');
    assert.equal(startCalled, 1);
    healer.stop();
  });

  it('a retry that fails again (port still held) reports outcome:error, not a fake success', async () => {
    const bus = fakeBus();
    const proxy = {
      start: () => {},
      whenReady: () => Promise.reject(new Error('EADDRINUSE :4480')),
    };
    const healer = createHealer({
      bus, config: {}, memory: fakeMemory(),
      getCortex: () => null, getGoals: () => null,
      getScannerProxy: () => proxy,
    });
    healer.start();

    bus.emit('health.diagnosed', { kind: 'aether-proxy-bind-failed', target: 'ports 4480' });
    await sleep(10);

    const healed = bus._emitted().filter((e) => e.type === 'health.healed');
    assert.equal(healed[0].payload.outcome, 'error');
    healer.stop();
  });

  it('with no scanner-proxy instance available, reports missing-dependency rather than throwing', async () => {
    const bus = fakeBus();
    const healer = createHealer({
      bus, config: {}, memory: fakeMemory(),
      getCortex: () => null, getGoals: () => null,
      getScannerProxy: () => null,
    });
    healer.start();

    bus.emit('health.diagnosed', { kind: 'aether-proxy-bind-failed', target: 'ports 4480' });
    await sleep(10);

    const healed = bus._emitted().filter((e) => e.type === 'health.healed');
    assert.equal(healed[0].payload.outcome, 'error');
    healer.stop();
  });

  it('a second bind-failed anomaly inside the cooldown window is blocked, not retried again immediately', async () => {
    const bus = fakeBus();
    let startCalled = 0;
    const proxy = { start: () => { startCalled++; }, whenReady: () => Promise.resolve() };
    const healer = createHealer({
      bus, config: {}, memory: fakeMemory(),
      getCortex: () => null, getGoals: () => null,
      getScannerProxy: () => proxy,
    });
    healer.start();

    bus.emit('health.diagnosed', { kind: 'aether-proxy-bind-failed', target: 'ports 4480' });
    await sleep(10);
    bus.emit('health.diagnosed', { kind: 'aether-proxy-bind-failed', target: 'ports 4480' });
    await sleep(10);

    const healed = bus._emitted().filter((e) => e.type === 'health.healed');
    assert.equal(healed.length, 2);
    assert.equal(healed[1].payload.outcome, 'cooldown');
    assert.equal(startCalled, 1, 'only the first anomaly may trigger a real retry');
    healer.stop();
  });

  it('never shifts to a different port base — the retry calls the SAME proxy instance\'s start(), no new base/config is ever passed', async () => {
    const bus = fakeBus();
    const startArgs = [];
    const proxy = {
      start: (...args) => { startArgs.push(args); },
      whenReady: () => Promise.resolve(),
    };
    const healer = createHealer({
      bus, config: {}, memory: fakeMemory(),
      getCortex: () => null, getGoals: () => null,
      getScannerProxy: () => proxy,
    });
    healer.start();
    bus.emit('health.diagnosed', { kind: 'aether-proxy-bind-failed', target: 'ports 4480' });
    await sleep(10);
    assert.deepEqual(startArgs, [[]], 'start() must be called with no arguments — same config, same ports, no renumbering');
    healer.stop();
  });
});
