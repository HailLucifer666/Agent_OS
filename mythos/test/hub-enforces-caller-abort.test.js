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
//
// BUG-398 R1 (2026-09-02) — WHY THESE TESTS USE AN AbortController AND A REF'D
// setTimeout INSTEAD OF AbortSignal.timeout.
//
// This file was red on CI on essentially every run since it was added, while
// green on every developer machine, and it is one of the three causes behind
// BUG-399 ("CI's test job fails every run on a shifting set of tests"). All
// FOUR subtests failed together — including the negative control, which is four
// lines of trivially-correct code — with failureType 'cancelledByParent' and
// error 'Promise resolution is still pending but the event loop has already
// resolved'. A whole file failing on its simplest test is the signature of a
// harness problem, not a code problem.
//
// THE MECHANISM. raceSignal (hub.js) attaches an 'abort' listener and nothing
// else. The hung effector never settles. So the ONLY pending work in the process
// is the timer inside AbortSignal.timeout — and that timer is unref'd by the
// platform, which cannot be changed from here. The event loop therefore has
// nothing keeping it alive, drains, and the test runner cancels the pending test
// and every sibling still queued under the describe.
//
// TWO PROBES, run 2026-09-02, recorded here because between them they settle the
// question without needing the CI runtime to hand.
//
//   1. `node -e "AbortSignal.timeout(400).addEventListener('abort',()=>console.log('FIRED'))"`
//      prints nothing and exits immediately — on Node 26 as well as Node 22, so
//      the unref is not version-specific.
//   2. The decisive one. A bare process (no test runner) doing exactly what the
//      first test below does — register the hung effector, call hub.invoke with a
//      budget, print the result — was run twice, once per pattern:
//        old (AbortSignal.timeout): printed only "process exit, code=0". The race
//            NEVER SETTLED. That is the CI error in one line.
//        new (AbortController + ref'd setTimeout): printed the settled
//            tool-timeout result, then exited.
//      Same machine, same Node, same code under test. So the cause is loop
//      liveness, not the runtime version: Node 26's runner happens to hold enough
//      handles to mask it and Node 22's (which CI pins, see
//      .github/workflows/ci.yml) does not. The fix removes the dependency on
//      runner internals altogether rather than betting on which way they lean.
//
// This is the third instance of BUG-259's class ("an unref'd timeout is a timeout
// that never fires in the process that most needs it"), and the first where the
// unref'd timer belongs to a platform API rather than to our own code — which is
// why it could not be fixed the way BUG-259 fixed the other two.
//
// NOT VERIFIED: this file passing under Node 22 specifically. No Node 22 is
// installed here and pulling a second runtime needs the operator's say-so. Probe
// 2 is the substitute, and it is a stronger claim than a green run on one
// version would be — but the honest statement is that CI is the thing that will
// confirm it.
//
// WHY THE FIX IS HERE AND NOT IN dispatch-action.js. Every AbortSignal.timeout in
// src/ is passed to a fetch or an effector call that owns a live handle (a
// socket, a child process), so the loop always has something to keep it alive
// and the budget always fires. A process whose only pending work is the budget
// itself is a test condition. Replacing AbortSignal.timeout with a ref'd
// controller in dispatch-action.js would make the budget fire even in a quiet
// process — plausibly worth doing for short-lived script callers — but nothing
// has measured that, and this file is not the place to change production
// behaviour on a hunch.
//
// The tests below assert exactly what they asserted before; only the clock that
// fires the abort changed. clearTimeout in each keeps the handle from outliving
// its test.

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

// A caller budget on a REF'd clock, standing in for AbortSignal.timeout — whose
// timer is unref'd, so in a process whose only pending work IS the budget the
// loop drains before it fires (see the BUG-398 R1 note in the header). Returns
// the signal plus a dispose() the caller runs, so no handle outlives its test.
function callerBudget(ms) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, ms);
  return { signal: controller.signal, dispose: function () { clearTimeout(timer); } };
}

describe('hub.invoke enforces the caller-supplied abort signal', () => {
  it('a hung effector cannot outlive the caller signal', { timeout: 2000 }, async () => {
    const bus = { emit: function () {} };
    const hub = makeHubWithHungTool(bus);
    const budget = callerBudget(80);
    const res = await hub.invoke('hung_tool', {}, { signal: budget.signal });
    budget.dispose();
    assert.equal(res.ok, false, 'an aborted tool must not report success');
    assert.equal(res.result, 'tool-timeout');
  });

  it('asserts the mechanism: the abort is announced on the bus', { timeout: 2000 }, async () => {
    const seen = [];
    const bus = { emit: function (t, p) { seen.push({ t, p }); } };
    const hub = makeHubWithHungTool(bus);
    const budget = callerBudget(60);
    await hub.invoke('hung_tool', {}, { signal: budget.signal });
    budget.dispose();
    const anomaly = seen.find((e) => e.t === 'health.anomaly' && e.p && e.p.kind === 'tool-timeout');
    assert.ok(anomaly, 'health.anomaly kind=tool-timeout must be emitted, saw: ' + JSON.stringify(seen));
    assert.equal(anomaly.p.target, 'hung_tool');
  });

  it('records the timeout as a breaker FAILURE, not a success', { timeout: 2000 }, async function () {
    const bus = { emit: function () {} };
    const hub = makeHubWithHungTool(bus);
    const budget = callerBudget(60);
    await hub.invoke('hung_tool', {}, { signal: budget.signal });
    budget.dispose();
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
