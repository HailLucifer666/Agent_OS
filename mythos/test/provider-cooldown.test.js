'use strict';

// provider-cooldown (2026-08-26): a web_search call took 32.4 seconds and
// answered the wrong thing. Twenty of those seconds were two DuckDuckGo rungs
// each burning a full 10s PROVIDER_TIMEOUT against a host this network cannot
// reach — and every subsequent call paid it again, because healer.js's flat 30s
// suppression is bus-driven and most callers pass no bus.
//
// Shape under test: repeated failure must cost progressively more skipping, a
// single success must restore the provider immediately, and — the case a naive
// implementation gets wrong — an EXPIRED cooldown must keep its failure count,
// so a permanently dead provider escalates instead of ping-ponging at the first
// rung of the ladder forever.

const test = require('node:test');
const assert = require('node:assert');

const {
  createProviderCooldown,
  DEFAULT_LADDER_MS,
} = require('../src/core/effectors/provider-cooldown.js');

// A clock the test drives by hand. Used ONLY for the ladder/expiry arithmetic,
// which is about durations rather than timers; the real-clock behaviour gets its
// own test below, because this repo has been bitten by a frozen fake clock
// hiding the very logic under test.
function fakeClock(start) {
  let t = start || 1000000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('a provider that has never failed is not skipped', () => {
  const cd = createProviderCooldown();
  assert.equal(cd.reason('ddg-html'), null);
});

test('the first failure skips the provider and names the original cause', () => {
  const clock = fakeClock();
  const cd = createProviderCooldown({ now: clock.now });

  const rec = cd.recordFailure('ddg-html', 'connect ETIMEDOUT');
  assert.equal(rec.count, 1);
  assert.equal(rec.ttlMs, DEFAULT_LADDER_MS[0]);

  const why = cd.reason('ddg-html');
  assert.ok(why, 'the provider must be skipped after a failure');
  // The skip must carry the ORIGINAL diagnosis. A reason that says only
  // "cooling down" replaces one diagnosis with none.
  assert.match(why, /ETIMEDOUT/);
  assert.match(why, /1 consecutive failure\b/);
});

test('consecutive failures climb the ladder', () => {
  const clock = fakeClock();
  const cd = createProviderCooldown({ now: clock.now });

  const seen = [];
  for (let i = 0; i < 5; i += 1) {
    // Expire the previous cooldown before failing again, so each failure is a
    // real retry rather than a call made while already skipped.
    clock.advance(DEFAULT_LADDER_MS[DEFAULT_LADDER_MS.length - 1] + 1);
    seen.push(cd.recordFailure('ddg-html', 'connect ETIMEDOUT').ttlMs);
  }

  assert.deepEqual(seen.slice(0, 4), DEFAULT_LADDER_MS);
  // Past the end of the table the last rung repeats — it does not fall off or
  // wrap back to the start.
  assert.equal(seen[4], DEFAULT_LADDER_MS[DEFAULT_LADDER_MS.length - 1]);
});

test('one success clears the ladder completely', () => {
  const clock = fakeClock();
  const cd = createProviderCooldown({ now: clock.now });

  cd.recordFailure('exa-mcp', 'HTTP 429');
  clock.advance(DEFAULT_LADDER_MS[0] + 1);
  cd.recordFailure('exa-mcp', 'HTTP 429');
  assert.equal(cd.snapshot()['exa-mcp'].count, 2);

  cd.recordSuccess('exa-mcp');

  assert.equal(cd.reason('exa-mcp'), null, 'a recovered provider must be tried again at once');
  assert.equal(cd.snapshot()['exa-mcp'], undefined);
  // And it starts again at the BOTTOM of the ladder, not where it left off — a
  // provider that answered is working, and an outage that is over must not keep
  // being charged for.
  assert.equal(cd.recordFailure('exa-mcp', 'HTTP 429').ttlMs, DEFAULT_LADDER_MS[0]);
});

test('an expired cooldown allows a retry but KEEPS the failure count', () => {
  // The case a naive implementation gets wrong. If expiry reset the count, a
  // permanently unreachable provider would be retried every 60 seconds forever
  // — paying a 10s timeout each time — which is the exact cost this module
  // exists to stop.
  const clock = fakeClock();
  const cd = createProviderCooldown({ now: clock.now });

  cd.recordFailure('ddg-lite', 'connect ETIMEDOUT');
  assert.ok(cd.reason('ddg-lite'), 'skipped while the cooldown is live');

  clock.advance(DEFAULT_LADDER_MS[0] + 1);
  assert.equal(cd.reason('ddg-lite'), null, 'an expired cooldown must permit one retry');

  // That retry fails too. It must be charged as the SECOND failure.
  const rec = cd.recordFailure('ddg-lite', 'connect ETIMEDOUT');
  assert.equal(rec.count, 2, 'expiry must not reset the ladder');
  assert.equal(rec.ttlMs, DEFAULT_LADDER_MS[1]);
});

test('providers are tracked independently', () => {
  const clock = fakeClock();
  const cd = createProviderCooldown({ now: clock.now });

  cd.recordFailure('ddg-html', 'connect ETIMEDOUT');

  assert.ok(cd.reason('ddg-html'));
  assert.equal(cd.reason('local-websearch'), null,
    'one dead provider must not skip a healthy one');
});

test('snapshot is a copy, not the live state', () => {
  const cd = createProviderCooldown();
  cd.recordFailure('jina', 'HTTP 401');

  const snap = cd.snapshot();
  snap.jina.count = 999;
  snap.jina.until = 0;

  assert.equal(cd.snapshot().jina.count, 1, 'mutating a snapshot must not reach the cooldown');
  assert.ok(cd.reason('jina'), 'and must not un-skip the provider');
});

test('recordFailure and recordSuccess ignore an absent provider name', () => {
  const cd = createProviderCooldown();
  assert.equal(cd.recordFailure(null, 'x'), null);
  assert.equal(cd.recordFailure('', 'x'), null);
  assert.doesNotThrow(() => cd.recordSuccess(null));
  assert.doesNotThrow(() => cd.recordSuccess(undefined));
});

test('a later failure with no error keeps the last known cause', () => {
  // The chain sometimes knows only "no results" on a retry. Losing the earlier,
  // specific cause would turn a diagnosable skip back into an opaque one.
  const clock = fakeClock();
  const cd = createProviderCooldown({ now: clock.now });

  cd.recordFailure('ddg-html', 'connect ETIMEDOUT');
  clock.advance(DEFAULT_LADDER_MS[0] + 1);
  cd.recordFailure('ddg-html', null);

  assert.match(cd.reason('ddg-html'), /ETIMEDOUT/);
});

test('against the REAL clock, a short ladder expires on its own', async () => {
  // Deliberately not the fake clock: the tests above prove the arithmetic, and
  // this one proves the module behaves the same when time passes for real.
  const cd = createProviderCooldown({ ladderMs: [40] });

  cd.recordFailure('ddg-html', 'connect ETIMEDOUT');
  assert.ok(cd.reason('ddg-html'), 'skipped immediately after failing');

  await new Promise((r) => setTimeout(r, 70));

  assert.equal(cd.reason('ddg-html'), null, 'and tried again once the window really passes');
});
