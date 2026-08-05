'use strict';

// BUG-111 — Gmail was read 14 times; a stored `remember` note cannot stop it.
// GMAIL_TRIAGE_MODE (schema.js) now gates the sensor's own recurring-poll
// behavior: 'boot-once' (new default) runs exactly one pass at startup and
// never arms a recurring timer; 'poll' is the pre-2026-08-05 always-on
// interval behavior, unchanged; 'off' never runs at all. gmail_unread (the
// effector/tool) is untouched — only this sensor's background cadence changes.
//
// Pattern mirrors test/gmail-triage-sensor.test.js: fake bus, node:test mock
// timers, generation-token stop() semantics.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { fakeBus } = require('./helpers');
const { createGmailSensor } = require('../src/core/sensors/gmail-sensor');
const { validate, SCHEMA } = require('../src/core/config');

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function okBatch(messages) {
  return { ok: true, result: { count: messages.length, messages: messages } };
}

describe('BUG-111: GMAIL_TRIAGE_MODE schema key', () => {
  it('defaults to boot-once with the documented enum', () => {
    assert.equal(SCHEMA.GMAIL_TRIAGE_MODE.default, 'boot-once');
    assert.deepEqual(SCHEMA.GMAIL_TRIAGE_MODE.enum, ['boot-once', 'poll', 'off']);
  });

  it('resolves to boot-once when the env var is unset', () => {
    const { ok, config } = validate({}, SCHEMA);
    assert.equal(ok, true);
    assert.equal(config.GMAIL_TRIAGE_MODE, 'boot-once');
  });

  it('rejects a value outside the enum', () => {
    const { ok, errors } = validate({ GMAIL_TRIAGE_MODE: 'always' }, SCHEMA);
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes('GMAIL_TRIAGE_MODE')));
  });
});

describe('BUG-111: gmail-sensor mode gates recurring polling', () => {
  it("'boot-once' calls gmailUnread exactly once at start() and never arms a recurring timer", async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    const bus = fakeBus();
    let calls = 0;
    const gmailUnread = async () => { calls++; return okBatch([{ id: 'm1' }]); };
    const sensor = createGmailSensor({ gmailUnread, bus, pollMs: 300000, mode: 'boot-once' });

    sensor.start();
    await flushMicrotasks();
    assert.equal(calls, 1, 'boot-once must poll immediately on start(), not wait for a timer tick');

    // Advance time repeatedly — a recurring timer would fire more calls.
    t.mock.timers.tick(300000);
    await flushMicrotasks();
    t.mock.timers.tick(3000000);
    await flushMicrotasks();

    assert.equal(calls, 1, 'boot-once must never call gmailUnread a second time, no matter how far time advances');
    assert.equal(sensor.getPollCount(), 1);

    sensor.stop();
  });

  it('schema default (mode omitted from validate, then passed through) behaves as boot-once', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    const { config } = validate({}, SCHEMA); // GMAIL_TRIAGE_MODE unset -> schema default
    const bus = fakeBus();
    let calls = 0;
    const gmailUnread = async () => { calls++; return okBatch([{ id: 'm1' }]); };
    const sensor = createGmailSensor({ gmailUnread, bus, pollMs: 300000, mode: config.GMAIL_TRIAGE_MODE });

    sensor.start();
    await flushMicrotasks();
    t.mock.timers.tick(600000);
    await flushMicrotasks();

    assert.equal(calls, 1, 'the schema default must produce boot-once (single-pass) behavior');
    assert.equal(sensor.getPollCount(), 1);

    sensor.stop();
  });

  it("'poll' preserves today's recurring behavior — multiple calls as time advances", async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    const bus = fakeBus();
    let calls = 0;
    const gmailUnread = async () => { calls++; return okBatch([{ id: 'm' + calls }]); };
    const sensor = createGmailSensor({ gmailUnread, bus, pollMs: 300000, mode: 'poll' });

    sensor.start();
    assert.equal(calls, 0, 'poll mode must not fire before the first interval tick');

    t.mock.timers.tick(300000);
    await flushMicrotasks();
    assert.equal(calls, 1);

    t.mock.timers.tick(300000);
    await flushMicrotasks();
    assert.equal(calls, 2, 'poll mode must keep firing on every interval tick');

    assert.equal(sensor.getPollCount(), 2);

    sensor.stop();
  });

  it("'off' never calls gmailUnread at all, even after start() and time advancing", async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    const bus = fakeBus();
    let calls = 0;
    const gmailUnread = async () => { calls++; return okBatch([{ id: 'm1' }]); };
    const sensor = createGmailSensor({ gmailUnread, bus, pollMs: 300000, mode: 'off' });

    sensor.start();
    await flushMicrotasks();
    t.mock.timers.tick(3000000);
    await flushMicrotasks();

    assert.equal(calls, 0, "'off' must never call gmailUnread");
    assert.equal(sensor.getPollCount(), 0);

    sensor.stop();
  });

  it('omitting mode entirely preserves legacy recurring behavior (back-compat for existing callers)', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    const bus = fakeBus();
    let calls = 0;
    const gmailUnread = async () => { calls++; return okBatch([{ id: 'm' + calls }]); };
    const sensor = createGmailSensor({ gmailUnread, bus, pollMs: 300000 }); // no mode field

    sensor.start();
    t.mock.timers.tick(300000);
    await flushMicrotasks();
    t.mock.timers.tick(300000);
    await flushMicrotasks();

    assert.equal(calls, 2, 'no mode field must behave like poll (matches the pre-existing test file)');

    sensor.stop();
  });
});
