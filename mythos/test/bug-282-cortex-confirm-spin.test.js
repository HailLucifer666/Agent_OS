'use strict';

// BUG-282 — the cortex re-proposed a confirm-blocked action on every tick,
// minting a fresh confirm each time.
//
// Reproduced from the audited live session of 2026-08-20, not inferred. The
// Audit vault for that day holds 42 browser_click records: every one
// actor:"cortex", every one reason:"tier-3-requires-confirm", every one with
// the IDENTICAL args {"ref":"e12"}, spanning 41.6 seconds with an
// inter-arrival histogram of 1000ms x40 and 1300ms x1 — exactly one per tick
// at the default MYTHOS_TICK_MS. 42 of the session's 45 confirm records were
// that one action; the other three were each a distinct real intent.
//
// The leash was RIGHT to refuse: the cortex is not operator-present, so a
// tier-3 action correctly needs confirmation. The defect is entirely on our
// side of the refusal — act()'s requireConfirm branch created a confirm,
// emitted, and returned recording NOTHING, so the next tick had no way to know
// the same action was already sitting in front of the operator.
//
// This is the third instance of "the cortex retries something that cannot
// succeed until a human acts". The prior two are the unknown-effector
// pre-flight (whose own comment describes this exact stall) and mull's
// consecutive-failure counter. Two is a pattern, so the guard below asserts the
// invariant rather than the instance.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('../src/core/bus');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { createConfirmRegistry } = require('../src/core/leash/confirm');
const { createCortex, confirmSuppressionKey } = require('../src/core/cortex');

// The REAL confirm registry, not a stand-in. The suppression has to key off the
// registry's own lifecycle (peek returns null once a confirm is consumed), so a
// fake registry would let the test agree with a keying bug — and would be more
// generous than the thing production talks to.
function buildHarness({ plans, tier = 3 }) {
  const bus = createBus({ historySize: 200 });
  const hub = createEffectorHub({ bus, config: {} });
  const queue = plans.slice();
  let lastPlan = queue[0];

  for (const p of plans) {
    if (!hub.effectors.has(p.tool)) {
      hub.register({
        id: p.tool, tier,
        describe: () => p.tool,
        validate: () => ({ ok: true }),
        invoke: async () => ({ ok: true, result: 'done' }),
      });
    }
  }

  const confirm = createConfirmRegistry({ config: { LEASH_CONFIRM_TTL_MS: 60000 } });
  const leash = {
    confirm,
    // Refuse every action the same way the live leash refused browser_click:
    // not allowed, requires confirmation, tier 3.
    check: () => ({ allow: false, requireConfirm: true, tier: 3, reason: 'tier-3-requires-confirm' }),
  };

  const memory = {
    working: {
      tick: 0, activeGoalId: null, spendThisTick: 0,
      drainPerceptions: () => [{ summary: 'x', channel: 'test', salience: 0.9 }],
      resetTickState() { this.spendThisTick = 0; },
      pushPerception() {}, addSpend() {},
    },
    episodic: { write: async () => ({ ref: 'ep-1' }) },
    audit: { write: () => {} },
    consolidate: async () => {},
  };

  const goals = {
    getActive: () => null, hasActive: () => false,
    arbitrate: () => ({ id: 'goal-1' }),
    plan: async () => { if (queue.length > 1) lastPlan = queue.shift(); else lastPlan = queue[0]; return lastPlan; },
    debitBudget: () => {},
  };

  const cortex = createCortex({
    bus, memory, goals, brain: null, leash, effectors: hub,
    config: { MYTHOS_TICK_MS: 1000, ACTION_TIMEOUT_MS: 30000 },
  });

  return { bus, cortex, confirm };
}

async function tick(cortex, n) {
  cortex.start();
  for (let i = 0; i < n; i += 1) await cortex.tickOnce();
  cortex.stop();
}

function requests(bus) {
  return bus.history().filter((e) => e.type === 'confirm-request');
}
function suppressions(bus) {
  return bus.history().filter((e) => e.type === 'cortex.confirm-suppressed');
}

const CLICK = { tool: 'browser_click', args: { ref: 'e12' } };

describe('BUG-282: one unresolved confirm per action, however many ticks pass', () => {
  it('asks once across five ticks instead of once per tick', async () => {
    const { bus, cortex } = buildHarness({ plans: [CLICK] });
    await tick(cortex, 5);
    assert.equal(requests(bus).length, 1,
      'the operator must be asked once, not once per tick');
  });

  it('mints exactly one confirm record, not one per tick', async () => {
    // Assert the MECHANISM, not the event count. Emitting once while still
    // creating five confirm entries would be the bug wearing a fix's clothes:
    // four orphans sitting in the registry until they expire.
    const { cortex, confirm } = buildHarness({ plans: [CLICK] });
    await tick(cortex, 5);
    assert.equal(confirm.stats().pending, 1,
      'five ticks left ' + confirm.stats().pending + ' pending confirms in the registry');
  });

  it('makes the suppression visible instead of silently swallowing it', async () => {
    // Q2: suppressing 41 of 42 emissions removes 41 log lines. Silence here
    // would convert a visible spin into an invisible stall, which is strictly
    // worse than the bug. The count has to be reported.
    const { bus, cortex } = buildHarness({ plans: [CLICK] });
    await tick(cortex, 5);
    const sup = suppressions(bus);
    assert.equal(sup.length, 4, 'four suppressed re-proposals should be reported');
    assert.equal(sup[sup.length - 1].payload.tool, 'browser_click');
    assert.equal(sup[sup.length - 1].payload.suppressedCount, 4,
      'the event must carry a running count, so the spin is still measurable');
  });

  it('asks again once the operator answers', async () => {
    // Without this the fix becomes "the cortex can never ask twice", which is a
    // worse bug than the one it closes.
    const { bus, cortex, confirm } = buildHarness({ plans: [CLICK] });
    await tick(cortex, 3);
    assert.equal(requests(bus).length, 1);

    const id = requests(bus)[0].payload.confirmId;
    assert.ok(confirm.accept(id, 'system'), 'the confirm should be acceptable');

    await tick(cortex, 2);
    assert.equal(requests(bus).length, 2,
      'a resolved confirm must not suppress the next proposal of the same action');
  });

  it('asks again when the confirm is rejected, not only when accepted', async () => {
    const { bus, cortex, confirm } = buildHarness({ plans: [CLICK] });
    await tick(cortex, 2);
    const id = requests(bus)[0].payload.confirmId;
    assert.ok(confirm.reject(id, 'system'), 'the confirm should be rejectable');
    await tick(cortex, 2);
    assert.equal(requests(bus).length, 2, 'a rejection also frees the key');
  });

  it('keeps a different ref distinct — the key must not collapse two actions', async () => {
    // Q1: the danger in keying off args is over-matching. browser_click{ref:e12}
    // and browser_click{ref:e13} are different actions and must each get their
    // own confirm.
    const { bus, cortex } = buildHarness({
      plans: [{ tool: 'browser_click', args: { ref: 'e12' } },
        { tool: 'browser_click', args: { ref: 'e13' } }],
    });
    await tick(cortex, 4);
    const refs = requests(bus).map((e) => e.payload.args.ref);
    assert.deepEqual([...new Set(refs)].sort(), ['e12', 'e13'],
      'each distinct ref needs its own confirmation');
  });

  it('keys on args regardless of key order', async () => {
    // Two objects with the same content and different insertion order are the
    // same action. A JSON.stringify key would treat them as two.
    const { bus, cortex } = buildHarness({
      plans: [{ tool: 'browser_click', args: { ref: 'e12', why: 'a' } },
        { tool: 'browser_click', args: { why: 'a', ref: 'e12' } }],
    });
    await tick(cortex, 4);
    assert.equal(requests(bus).length, 1,
      'key order must not create a second confirm for the same action');
  });
});

describe('BUG-282: the suppression map does not grow without bound', () => {
  // Mutation testing found the original cleanup line was dead — removing it
  // changed no behaviour and failed no test, because the set() after it
  // overwrites the same key anyway. It only ever tidied the key being
  // re-proposed, so an entry survived for every action confirmed once and never
  // proposed again. This asserts the replacement actually prunes.
  it('forgets a key once its confirm has been answered', async () => {
    const { bus, cortex, confirm } = buildHarness({
      plans: [{ tool: 'browser_click', args: { ref: 'e12' } },
        { tool: 'browser_click', args: { ref: 'e13' } }],
    });
    await tick(cortex, 1);
    assert.equal(cortex.pendingConfirmKeyCount, 1, 'the first action is awaiting an answer');

    const first = requests(bus)[0].payload.confirmId;
    assert.ok(confirm.accept(first, 'system'));

    await tick(cortex, 1);
    assert.equal(cortex.pendingConfirmKeyCount, 1,
      'the answered key must be pruned, leaving only the newly proposed one');
  });
});

describe('BUG-282: the keying rule itself', () => {
  it('is insensitive to arg key order', () => {
    assert.equal(
      confirmSuppressionKey({ tool: 't', args: { a: 1, b: 2 } }),
      confirmSuppressionKey({ tool: 't', args: { b: 2, a: 1 } }));
  });

  it('separates different values, different tools, and different arg sets', () => {
    const k = (d) => confirmSuppressionKey(d);
    assert.notEqual(k({ tool: 't', args: { ref: 'e12' } }), k({ tool: 't', args: { ref: 'e13' } }));
    assert.notEqual(k({ tool: 't', args: { ref: 'e12' } }), k({ tool: 'u', args: { ref: 'e12' } }));
    assert.notEqual(k({ tool: 't', args: { ref: 'e12' } }), k({ tool: 't', args: {} }));
  });

  it('does not confuse the string "12" with the number 12', () => {
    assert.notEqual(
      confirmSuppressionKey({ tool: 't', args: { n: '12' } }),
      confirmSuppressionKey({ tool: 't', args: { n: 12 } }));
  });

  it('survives a decision with no args and no tool', () => {
    assert.equal(typeof confirmSuppressionKey({}), 'string');
    assert.equal(typeof confirmSuppressionKey(null), 'string');
  });
});

describe('BUG-282: deliberate non-change — the denied branch is left alone', () => {
  // The handoff that scoped this work also asked for the same keying on act()'s
  // action.denied branch. Measured against the same session first: it holds 11
  // deny records in total, none of them a repeat of the same action, while 42 of
  // 45 confirms were one action asked 42 times. The denied branch did not spin.
  //
  // So this guard is intentionally narrow. Suppressing denials would need a
  // second mechanism (a time-based backoff, since a denial has no confirm entry
  // to peek at) for a failure mode that has never been observed here — and a
  // second mechanism is a second thing that can disagree with the first. If the
  // denied branch is ever seen spinning, that measurement is the ticket; until
  // then this test pins the current behaviour so it is not "fixed" by accident.
  it('still emits action.denied on every tick', async () => {
    const bus = createBus({ historySize: 100 });
    const hub = createEffectorHub({ bus, config: {} });
    hub.register({
      id: 'browser_click', tier: 3,
      describe: () => 'browser_click',
      validate: () => ({ ok: true }),
      invoke: async () => ({ ok: true, result: 'done' }),
    });
    const leash = {
      confirm: createConfirmRegistry({ config: { LEASH_CONFIRM_TTL_MS: 60000 } }),
      // Denied outright: no confirm offered.
      check: () => ({ allow: false, requireConfirm: false, reason: 'breaker-open' }),
    };
    const memory = {
      working: {
        tick: 0, activeGoalId: null, spendThisTick: 0,
        drainPerceptions: () => [{ summary: 'x', channel: 'test', salience: 0.9 }],
        resetTickState() { this.spendThisTick = 0; },
        pushPerception() {}, addSpend() {},
      },
      episodic: { write: async () => ({ ref: 'ep-1' }) },
      audit: { write: () => {} },
      consolidate: async () => {},
    };
    const goals = {
      getActive: () => null, hasActive: () => false,
      arbitrate: () => ({ id: 'goal-1' }),
      plan: async () => ({ tool: 'browser_click', args: { ref: 'e12' } }),
      debitBudget: () => {},
    };
    const cortex = createCortex({
      bus, memory, goals, brain: null, leash, effectors: hub,
      config: { MYTHOS_TICK_MS: 1000, ACTION_TIMEOUT_MS: 30000 },
    });
    await tick(cortex, 3);
    const denied = bus.history().filter((e) => e.type === 'action.denied');
    assert.equal(denied.length, 3,
      'the denied branch is deliberately unsuppressed — see the comment above');
  });
});
