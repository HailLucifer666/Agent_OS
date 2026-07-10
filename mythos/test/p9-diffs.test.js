'use strict';

// p9-diffs.test.js — regression coverage for Phase 9's small additive diffs to
// already-shipped modules: logger.onLog, lifecycle.registerStopServer (shutdown
// step 0), cortex act()'s leash.confirm.create + confirmId-carrying
// confirm-request payload (spec Ambiguity #2 contract), and the ACTION_TIMEOUT_MS
// schema key (Gap 4).

const { test, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createLogger } = require('../src/core/logger');
const { createLifecycle } = require('../src/core/lifecycle');
const { createCortex } = require('../src/core/cortex');
const { createBus } = require('../src/core/bus');
const { createConfirmRegistry } = require('../src/core/leash/confirm');
const { SCHEMA } = require('../src/core/config/schema');

describe('logger.onLog (P9 diff)', () => {
  it('notifies listeners with the structured entry for emitted lines only', () => {
    const logger = createLogger('info');
    const seen = [];
    logger.onLog((entry) => seen.push(entry));

    logger.debug('below-threshold');          // filtered — must NOT notify
    logger.info('hello', { extra: 1 });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].level, 'info');
    assert.equal(seen[0].msg, 'hello');
    assert.equal(seen[0].extra, 1);
  });

  it('a throwing listener never crashes logging, and unsubscribe works', () => {
    const logger = createLogger('info');
    const seen = [];
    logger.onLog(() => { throw new Error('bad listener'); });
    const unsub = logger.onLog((entry) => seen.push(entry));

    assert.doesNotThrow(() => logger.warn('still logs'));
    assert.equal(seen.length, 1);

    unsub();
    logger.warn('after unsubscribe');
    assert.equal(seen.length, 1, 'unsubscribed listener must not fire');
  });
});

describe('lifecycle.registerStopServer (P9 diff — shutdown step 0)', () => {
  it('runs the registered stopServer callback first, then completes shutdown', async () => {
    const bus = createBus({ historySize: 10 });
    const order = [];
    const logger = {
      info: (msg) => order.push(msg),
      warn: () => {}, error: () => {},
    };
    const lifecycle = createLifecycle({ bus, logger, config: { MYTHOS_NAME: 'TEST' } });

    let stopped = false;
    lifecycle.registerStopServer(async () => {
      stopped = true;
      order.push('server.stopped');
    });

    await lifecycle.shutdown(2000);
    assert.equal(stopped, true, 'stopServer must run during shutdown');
    assert.equal(lifecycle.getState(), 'dead');
    const stopIdx = order.indexOf('server.stopped');
    const completeIdx = order.indexOf('lifecycle.shutdown.complete');
    assert.ok(stopIdx !== -1 && completeIdx !== -1 && stopIdx < completeIdx,
      'server must close before shutdown completes (step 0)');
  });

  it('a throwing stopServer never blocks shutdown (best-effort)', async () => {
    const bus = createBus({ historySize: 10 });
    const lifecycle = createLifecycle({ bus, logger: { info() {}, warn() {}, error() {} }, config: {} });
    lifecycle.registerStopServer(async () => { throw new Error('socket already dead'); });
    await lifecycle.shutdown(2000);
    assert.equal(lifecycle.getState(), 'dead');
  });
});

describe('cortex confirm flow (P9 diff — spec Ambiguity #2 contract)', () => {
  function harness(confirmRegistry) {
    const bus = createBus({ historySize: 50 });
    const emitted = [];
    bus.subscribe('confirm-request', (e) => emitted.push(e.payload));

    const memory = {
      working: {
        tick: 0, activeGoalId: null, spendThisTick: 0,
        resetTickState() {}, drainPerceptions() { return [{ summary: 'x', channel: 'test', salience: 0.9 }]; },
      },
      episodic: { write: async () => {} },
    };
    const goals = {
      getActive: () => ({ id: 'g-1' }),
      hasActive: () => true,
      arbitrate: () => ({ id: 'g-1' }),
      plan: async () => ({ tool: 'kill_session', args: { sessionId: 'x' } }),
      debitBudget: () => {},
      get: () => null,
    };
    const createCalls = [];
    const leash = {
      check: () => ({ allow: false, requireConfirm: true, tier: 3, reason: 'tier-3-requires-confirm' }),
      confirm: {
        create: (summary, action, connectionId) => {
          createCalls.push({ summary, action, connectionId });
          return confirmRegistry.create(summary, action, connectionId);
        },
        accept: confirmRegistry.accept,
        reject: confirmRegistry.reject,
        peek: confirmRegistry.peek,
      },
    };
    const effectors = { invoke: async () => ({ ok: true }), breakers: { allow: () => true } };
    const cortex = createCortex({
      bus, memory, goals, brain: null, leash, effectors,
      config: { MYTHOS_TICK_MS: 60000, ACTION_TIMEOUT_MS: 30000, MYTHOS_IDLE_SALIENCE: 0.3 },
    });
    return { bus, cortex, emitted, createCalls };
  }

  it('act() with a tier-3 requireConfirm decision registers via leash.confirm.create and embeds confirmId', async () => {
    // Real confirm registry (Lesson #4 — the registry seam, not a mock of it).
    const registry = createConfirmRegistry({ config: { LEASH_CONFIRM_TTL_MS: 30000 } });
    const { cortex, emitted, createCalls } = harness(registry);

    cortex.start();
    await cortex.tickOnce();
    cortex.stop();

    assert.equal(createCalls.length, 1, 'leash.confirm.create must be called exactly once');
    assert.equal(createCalls[0].connectionId, 'system', "cortex-initiated confirms use the 'system' sentinel");
    assert.equal(createCalls[0].action.decision.tool, 'kill_session');
    assert.equal(createCalls[0].action.tier, 3);

    assert.equal(emitted.length, 1, 'exactly one confirm-request emitted');
    assert.ok(emitted[0].confirmId, 'payload must carry the confirmId');
    assert.equal(emitted[0].tier, 3);
    // Human-readable "key: value" summary (not raw JSON) — see cortex/index.js's humanizeArgs.
    assert.match(emitted[0].summary, /^kill_session \(/);

    // The registered confirm is resolvable through the REAL registry with the
    // 'system' scope — the exact path server/index.js takes on confirm-reply.
    const action = registry.accept(emitted[0].confirmId, 'system');
    assert.ok(action, 'accept(confirmId, system) must return the stored action');
    assert.equal(action.decision.tool, 'kill_session');
  });
});

test('config schema declares ACTION_TIMEOUT_MS (Gap 4 closed)', () => {
  assert.ok(SCHEMA.ACTION_TIMEOUT_MS, 'ACTION_TIMEOUT_MS must be a schema key');
  assert.equal(SCHEMA.ACTION_TIMEOUT_MS.default, 30000);
  assert.equal(SCHEMA.ACTION_TIMEOUT_MS.type, 'number');
});
