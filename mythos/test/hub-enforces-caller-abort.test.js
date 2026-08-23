'use strict';

// test/hub-enforces-caller-abort.test.js — GAP-ANALYSIS-2026-08-24 finding H1.
//
// dispatch-action.js:53 builds AbortSignal.timeout(ACTION_TIMEOUT_MS||30000) and
// hands it to every tool via hub.invoke(name, args, {signal}). Until this fix,
// hub.invoke merely FORWARDED the signal: an effector that dropped it on the floor
// (confirmed instance: from-image-gen.js:99, fetch with no signal) hung the await
// forever — the repo's own "unbounded call on the Live path is permanent silence"
// class (from-dashboard.js:486). The dispatcher's budget was advisory.
//
// THE FIX UNDER TEST: hub.invoke races the effector against the caller's signal.
// Aborted -> { ok:false, result:'tool-timeout' } + health.anomaly, and the breaker
// records a failure. Deliberately NO new default timeout is invented here: tools
// invoked WITHOUT a caller signal (long builds with their own 10-min budget,
// direct unit-test calls) keep today's behaviour — this only makes an explicit
// caller budget binding, which is the minimum that closes the class.
//
// Offline and instant by construction: the hung effector is a promise that never
// resolves and ignores its signal, exactly the shape from-image-gen had.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createEffectorHub } = require('../src/core/effectors/hub');

function makeHubWithHungTool(bus) {
  const hub = createEffectorHub({ bus, config: {} });
  hub.register({
    id: 'hung_tool',
    // The exact shape from-image-gen.js:99 had: receives ctx.signal and ignores it.
    invoke: function () { return new Promise(function () { /* never settles */ }); },
  });
  return hub;
}

describe('hub.invoke enforces the caller-supplied abort signal', () => {
  it('a hung effector cannot outlive the caller signal', { timeout: 2000 }, async () => {
    const bus = { emit: function () {} };
    const hub = makeHubWithHungTool(bus);
    const res = await hub.invoke('hung_tool', {}, { signal: AbortSignal.timeout(80) });
    assert.equal(res.ok, false, 'an aborted tool must not report success');
    assert.equal(res.result, 'tool-timeout');
  });

  it('asserts the mechanism: the abort is announced on the bus', { timeout: 2000 }, async () => {
    const seen = [];
    const bus = { emit: function (t, p) { seen.push({ t, p }); } };
    const hub = makeHubWithHungTool(bus);
    await hub.invoke('hung_tool', {}, { signal: AbortSignal.timeout(60) });
    const anomaly = seen.find((e) => e.t === 'health.anomaly' && e.p && e.p.kind === 'tool-timeout');
    assert.ok(anomaly, 'health.anomaly kind=tool-timeout must be emitted, saw: ' + JSON.stringify(seen));
    assert.equal(anomaly.p.target, 'hung_tool');
  });

  it('records the timeout as a breaker FAILURE, not a success', { timeout: 2000 }, async function () {
    const bus = { emit: function () {} };
    const hub = makeHubWithHungTool(bus);
    await hub.invoke('hung_tool', {}, { signal: AbortSignal.timeout(60) });
    const br = hub.breakers.get('hung_tool');
    assert.ok(br, 'breaker entry must exist');
    assert.notEqual(br.state, 'closed-ok', 'a timed-out tool must not be recorded as a success');
  });

  it('NEGATIVE CONTROL: no caller signal keeps today\\u2019s behaviour', async () => {
    // Long-running tools invoked directly (no dispatchAction) must be untouched:
    // no invented budget, the effector's own answer still comes back.
    const hub = createEffectorHub({ bus: { emit: function () {} }, config: {} });
    hub.register({ id: 'slow_ok', invoke: async () => ({ ok: true, result: 'done' }) });
    const res = await hub.invoke('slow_ok', {}, {});
    assert.equal(res.ok, true);
  });
});
