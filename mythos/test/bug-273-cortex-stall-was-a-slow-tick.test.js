'use strict';

// bug-273-cortex-stall-was-a-slow-tick.test.js — the stalls themselves.
//
// The operator heard "Self-healed: cortex restart after a stall" four times in
// sixteen minutes, 5m07s apart to within 40ms. The vault has the arithmetic:
//
//     anomaly ts 1787077001758
//     anomaly ts 1787077308953   (+307195ms)
//     anomaly ts 1787077616183   (+307230ms)
//
// 307s is not a coincidence, and it is not the healer's 300000ms cooldown either
// (that would land at 300-302s). It is 300 CORTEX TICKS at the observed ~1.024s
// interval — the cadence of mull(), the idle reasoning pass, which fires on
// `tick % MYTHOS_MULL_EVERY_TICKS === 0` with the default 300. The session's
// first stall lands 57s after the boot marker, and working.tick was restored
// from the vault at 261550, whose distance to the next multiple of 300 is 50
// ticks. Everything matches: the cortex was not stalled. It was THINKING.
//
// THE MEASUREMENT IS THE BUG. `lastTickAt` is stamped once, at the top of the
// tick body, and the reentrancy guard stops another tick from starting while one
// is in flight. So during any awaited call inside a tick — mull()'s reasoning-
// lane brain call above all — "time since the last tick began" grows without
// bound, and the watchdog cannot tell a loop that is BUSY from a loop that is
// DEAD. It reports dead. The healer then restarts the cortex, which pauses the
// active goal, and the immune announcer says so out loud.
//
// THIS WAS FOUND ONCE BEFORE AND PAPERED OVER. config/schema.js still carries
// the note: "FIX C: was 5000 — lastTickAt is set once at tick start and not
// refreshed mid-tick ... Raised to match ACTION_TIMEOUT_MS so only a truly hung
// loop fires it." The default moved 5000 -> 30000 and .env.example was updated
// with a warning. But STALL_MS is operator config, this machine's .env still
// says 5000, and a stale .env silently un-fixes it. A fix that any user's config
// file can revert is not a fix — so the measurement is corrected here, and the
// threshold stops being load-bearing.
//
// Q1 — WHAT ELSE MATCHES THIS? Every awaited call in the tick body, not just
// mull: decide()'s planner call, memory.consolidate(), and act()'s dispatch
// (bounded by ACTION_TIMEOUT_MS = 30s, i.e. ALREADY at the schema default this
// was raised to). Any of them on a slow provider produces the same false stall.
// That is the class, and it is why the threshold was never the fix.
//
// Q2 — DOES THIS HIDE EVIDENCE? The opposite. The anomaly payload gained
// `target` and `reason`, so the vault record stops reading "anomaly:
// cortex-stall — " with nothing after the dash, and the spoken sentence (which
// is built from reason/target) can say which of the two conditions fired.
//
// Q5 — IS THE CONSTANT CORRECT? TICK_WEDGED_MS is not derived from STALL_MS. A
// tick still in flight after two minutes is wedged under any configuration —
// the longest legitimate await in the body is ACTION_TIMEOUT_MS (30s) — while
// STALL_MS answers a different question (is the timer firing at all) on a
// TICK_MS scale. Deriving one from the other is what tangled them before.
//
// Q8 — PIN THE DISPOSITION: detection of a REAL stall is unchanged. Both failure
// modes still fire, on the same event with the same kind, so the diagnostician
// and the stall-restart playbook need no edit.
//
// Run: cd mythos && node --test test/bug-273-cortex-stall-was-a-slow-tick.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createWatchdog } = require('../src/core/immune/watchdog');

function busSpy() {
  const seen = [];
  return { emit: (type, payload) => seen.push({ type, payload }), seen };
}

// A cortex as the watchdog sees it: a tick-start stamp and an in-flight stamp.
function fakeCortex({ lastTickAt, inFlightSince }) {
  return {
    lastTickAt: { value: lastTickAt },
    inFlightSince: { value: inFlightSince || 0 },
  };
}

const CONFIG = { STALL_MS: 5000, WATCHDOG_MS: 2000, TICK_WEDGED_MS: 120000 };
const stalls = (bus) => bus.seen.filter((e) => e.type === 'health.anomaly'
  && e.payload && e.payload.kind === 'cortex-stall');

function checkWith(bus, cortex) {
  createWatchdog({ bus, config: CONFIG, getCortex: () => cortex })._internal.check();
}

describe('BUG-273 — a busy cortex is not a stalled cortex', () => {
  it('a tick in flight for six seconds is NOT a stall', () => {
    // This is mull(). STALL_MS is 5000 on the operator's machine, the reasoning-
    // lane call takes longer than that, and the loop is working the whole time.
    const bus = busSpy();
    const now = Date.now();
    checkWith(bus, fakeCortex({ lastTickAt: now - 6000, inFlightSince: now - 6000 }));
    assert.deepEqual(stalls(bus), [],
      'the tick began six seconds ago and has not finished — that is a brain call, '
      + 'not a dead loop, and restarting the cortex for it pauses the active goal');
  });

  it('a tick in flight for a whole ACTION_TIMEOUT_MS is still not a stall', () => {
    // act()'s dispatch is bounded at 30s, which is exactly the value STALL_MS was
    // raised to. Under the old measurement the ceiling and the false positive met.
    const bus = busSpy();
    const now = Date.now();
    checkWith(bus, fakeCortex({ lastTickAt: now - 30000, inFlightSince: now - 30000 }));
    assert.deepEqual(stalls(bus), []);
  });

  it('a tick wedged past the ceiling IS a stall — the mechanism still fires', () => {
    const bus = busSpy();
    const now = Date.now();
    checkWith(bus, fakeCortex({ lastTickAt: now - 200000, inFlightSince: now - 200000 }));
    assert.equal(stalls(bus).length, 1, 'an await that never resolves is a real stall');
    assert.equal(stalls(bus)[0].payload.mode, 'tick-wedged');
  });

  it('a loop that has stopped scheduling ticks IS a stall — the original fault', () => {
    // Nothing in flight, and no tick has begun for longer than STALL_MS: the
    // timer is not firing. This is what the watchdog was built to catch and it
    // must keep catching it, or the fix has traded one blindness for another.
    const bus = busSpy();
    const now = Date.now();
    checkWith(bus, fakeCortex({ lastTickAt: now - 20000, inFlightSince: 0 }));
    assert.equal(stalls(bus).length, 1);
    assert.equal(stalls(bus)[0].payload.mode, 'no-tick');
  });

  it('a healthy idle loop says nothing', () => {
    const bus = busSpy();
    const now = Date.now();
    checkWith(bus, fakeCortex({ lastTickAt: now - 900, inFlightSince: 0 }));
    assert.deepEqual(stalls(bus), []);
  });

  it('the anomaly names its target and its reason, so the record is not a blank', () => {
    // Q2. The vault rows for this fault read `anomaly: cortex-stall — ` with
    // nothing after the dash, because the payload carried neither. The spoken
    // sentence is built from reason/target too.
    const bus = busSpy();
    const now = Date.now();
    checkWith(bus, fakeCortex({ lastTickAt: now - 20000, inFlightSince: 0 }));
    const p = stalls(bus)[0].payload;
    assert.equal(p.target, 'tick-loop');
    assert.ok(p.reason, 'a reason is what the announcer speaks');
    assert.ok(typeof p.elapsed === 'number', 'elapsed is still reported');
  });
});

describe('BUG-273 — the cortex publishes whether a tick is actually running', () => {
  const CORTEX = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'cortex', 'index.js'), 'utf8');

  it('inFlightSince is exposed, or the watchdog is guessing again', () => {
    assert.match(CORTEX, /inFlightSince/,
      'the watchdog cannot distinguish busy from dead without this');
    assert.match(CORTEX, /get inFlightSince\(\)/, 'and it must be on the public surface');
  });

  it('it is cleared on the same generation rule as the reentrancy flag', () => {
    // A stale tick from a superseded generation must not clear the stamp a live
    // tick is relying on — the same trap the _inFlight guard already documents
    // two lines away.
    const fin = CORTEX.slice(CORTEX.indexOf('} finally {'), CORTEX.indexOf('async function decide'));
    assert.match(fin, /generation === myGen/);
    assert.match(fin, /inFlightSince\.value = 0/);
  });

  it('mull no longer claims it never blocks the tick loop', () => {
    // The comment said "never blocks the tick loop" directly above an `await`
    // that blocked the tick loop for six seconds every five minutes, and that
    // sentence is why nobody looked here.
    assert.doesNotMatch(CORTEX, /never blocks the tick loop/);
  });
});
