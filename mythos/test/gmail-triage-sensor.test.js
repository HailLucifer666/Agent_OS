'use strict';

// Item 7 — Gmail triage sensor. Mirrors BUG-024's reminder-sensor test structure
// (test/bug-024-gmail-calendar.test.js): fake bus, node:test's mock timers for
// the interval, generation-token stop() semantics. gmailUnread is an async bound
// fn (goes through the hub in production), so after each timer tick we flush the
// microtask queue with a setImmediate before asserting on emitted bus events.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { fakeBus } = require('./helpers');
const { createGmailSensor } = require('../src/core/sensors/gmail-sensor');

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function okBatch(messages) {
  return { ok: true, result: { count: messages.length, messages: messages } };
}

describe('Item 7: gmail-sensor polls a bound gmailUnread() fn and emits gmail.unread-batch', () => {
  it('emits gmail.unread-batch for genuinely new message ids on the first tick', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    const bus = fakeBus();
    const messages = [
      { id: 'm1', from: 'a@x.com', subject: 'Hello' },
      { id: 'm2', from: 'b@x.com', subject: 'World' },
    ];
    const gmailUnread = async () => okBatch(messages);
    const sensor = createGmailSensor({ gmailUnread, bus, pollMs: 300000 });

    sensor.start();
    assert.equal(bus._lastEvent('gmail.unread-batch'), null, 'should not fire before the first interval tick');

    t.mock.timers.tick(300000);
    await flushMicrotasks();

    const evt = bus._lastEvent('gmail.unread-batch');
    assert.ok(evt, 'expected gmail.unread-batch to have been emitted');
    assert.equal(evt.payload.count, 2);
    assert.deepEqual(evt.payload.messages.map((m) => m.id), ['m1', 'm2']);

    sensor.stop();
  });

  it('does not re-announce ids already seen in a previous poll', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    const bus = fakeBus();
    let call = 0;
    const gmailUnread = async () => {
      call++;
      if (call === 1) {
        return okBatch([{ id: 'm1', subject: 'first' }, { id: 'm2', subject: 'second' }]);
      }
      // second poll: m1/m2 still unread (already seen), m3 is genuinely new
      return okBatch([{ id: 'm1', subject: 'first' }, { id: 'm2', subject: 'second' }, { id: 'm3', subject: 'third' }]);
    };
    const sensor = createGmailSensor({ gmailUnread, bus, pollMs: 300000 });

    sensor.start();
    t.mock.timers.tick(300000);
    await flushMicrotasks();

    const first = bus._lastEvent('gmail.unread-batch');
    assert.deepEqual(first.payload.messages.map((m) => m.id), ['m1', 'm2']);

    t.mock.timers.tick(300000);
    await flushMicrotasks();

    const events = bus._emitted().filter((e) => e.type === 'gmail.unread-batch');
    assert.equal(events.length, 2, 'a second poll with one genuinely new id should emit again');
    const second = events[1];
    assert.equal(second.payload.count, 1, 'only the genuinely new id should be announced');
    assert.deepEqual(second.payload.messages.map((m) => m.id), ['m3']);

    sensor.stop();
  });

  it('stops polling once stop() is called', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    const bus = fakeBus();
    const gmailUnread = async () => okBatch([{ id: 'm1', subject: 'should not fire' }]);
    const sensor = createGmailSensor({ gmailUnread, bus, pollMs: 300000 });

    sensor.start();
    sensor.stop();

    t.mock.timers.tick(600000);
    await flushMicrotasks();

    assert.equal(bus._lastEvent('gmail.unread-batch'), null, 'sensor must not poll after stop()');
  });

  it('treats a { ok:false } result as a silent no-op — no throw, no emit, no health.anomaly', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    const bus = fakeBus();
    const gmailUnread = async () => ({ ok: false, result: { error: 'Gmail is not configured' } });
    const sensor = createGmailSensor({ gmailUnread, bus, pollMs: 300000 });

    sensor.start();
    t.mock.timers.tick(300000);
    await flushMicrotasks();

    assert.equal(bus._lastEvent('gmail.unread-batch'), null, 'no batch should be emitted for an ok:false result');
    assert.equal(bus._lastEvent('health.anomaly'), null, 'an unconfigured/not-authed Gmail must not spam health.anomaly');

    sensor.stop();
  });
});
