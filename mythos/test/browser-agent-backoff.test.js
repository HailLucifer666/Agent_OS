'use strict';

// test/browser-agent-backoff.test.js — MYTHOS Installed-Build Repair Plan, Task D2.
//
// startAutoConnect's CDP attach poller retried a fixed 15s interval forever,
// logging a full Playwright stack trace at warn level on every single attempt
// even when no debug Chrome was ever going to appear. On the 2026-08-12
// installed-build session mythos-server.log grew 42 KB -> 363 KB in ~2 hours
// from this one line, burying 19 genuine warnings that were the actual signal.
//
// This pins the backoff contract the connector must uphold:
//   - each ramp-up attempt logs at most one warn ("log at most once per
//     backoff window")
//   - exactly one 'browser-agent.giving-up' line marks the ceiling being
//     reached — never zero (discoverable), never more than one
//   - after the ceiling, connect() keeps being retried forever (never
//     silently stops trying), but with no further log lines
//   - a successful connect resets the backoff to its floor immediately, so
//     the NEXT unexpected drop is retried promptly rather than at the ceiling
//
// TIME SEAM: adapters/browser-agent/index.js exports autoConnectTick(url,
// onOnline, intervalMs) — the exact unit of work startAutoConnect's real
// setInterval invokes on every tick. Driving THAT function directly, call by
// call, exercises the whole backoff state machine with no real timer
// anywhere in the loop: each call only awaits the mocked connectOverCDP
// (a microtask, resolved/rejected immediately), so 63 ticks execute about as
// fast as the CPU can run 63 async calls, with zero dependency on any timer
// firing on schedule. An earlier version of this test drove the real
// setInterval-based startAutoConnect() with a 5ms interval and asserted on
// wall-clock timeouts — that is a genuine wall-clock dependency (a 5ms
// interval assumes the event loop gets back to it within a few ms), and it
// went flaky under full-suite CPU contention where hundreds of other test
// files are competing for the event loop. This version has no timer to drift.
//
// Mocking follows browser-auto-connect-poller.test.js: intercept
// Module.prototype.require for 'playwright-core' (fakes connectOverCDP) and
// for '../../src/core/logger' (captures warn/info calls instead of writing to
// stdout/stderr) then require a fresh copy of the adapter so it binds to both
// mocks — this also gives each test its own fresh module-level backoff state.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const originalRequire = Module.prototype.require;
const ADAPTER_PATH = path.resolve(__dirname, '../adapters/browser-agent/index.js');
const URL = 'http://127.0.0.1:9222';

function makeSpyLogger() {
  const entries = [];
  const logger = {
    debug: () => {},
    info: (msg, fields) => entries.push({ level: 'info', msg, fields }),
    warn: (msg, fields) => entries.push({ level: 'warn', msg, fields }),
    error: (msg, fields) => entries.push({ level: 'error', msg, fields }),
  };
  return { entries, logger };
}

function withMockedAdapter(mockChromium, mockLogger, fn) {
  Module.prototype.require = function (id) {
    if (id === 'playwright-core') return { chromium: mockChromium };
    if (id === '../../src/core/logger') return { createLogger: () => mockLogger };
    return originalRequire.apply(this, arguments);
  };
  delete require.cache[ADAPTER_PATH];
  try {
    return fn(require(ADAPTER_PATH));
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[ADAPTER_PATH];
  }
}

// Drives `count` ticks, one at a time, awaiting each — no real timer, no
// real delay beyond whatever the mocked connectOverCDP actually takes.
async function tick(agent, count, onOnline) {
  for (let i = 0; i < count; i++) {
    await agent.autoConnectTick(URL, onOnline || function () {});
  }
}

test('autoConnectTick: warns at most once per backoff window, gives up exactly once at the ceiling, then keeps retrying forever in silence', async () => {
  let connectCalls = 0;
  const mockChromium = {
    connectOverCDP: async () => {
      connectCalls++;
      throw new Error('connect ECONNREFUSED 127.0.0.1:9222');
    },
    launchPersistentContext: async () => { throw new Error('unused'); },
  };
  const { entries, logger } = makeSpyLogger();

  await withMockedAdapter(mockChromium, logger, async (agent) => {
    // Backoff windows double 1, 2, 4, 8, 16, 32 (floor 1, multiplier 2,
    // ceiling 32) — 1+2+4+8+16+32 = 63 ticks covers exactly the 6 attempts
    // that ramp up to and reach the ceiling.
    await tick(agent, 63);

    assert.equal(connectCalls, 6, 'exactly 6 attempts happen across the 6 backoff windows within 63 ticks');

    const givingUp = entries.filter((e) => e.msg === 'browser-agent.giving-up');
    assert.equal(givingUp.length, 1, 'exactly one browser-agent.giving-up line once the ceiling is reached');

    const warns = entries.filter((e) => e.level === 'warn');
    assert.ok(warns.length >= 2, 'ramp-up must log a handful of warns, not zero (discoverable) and not one-per-tick');
    assert.ok(warns.length <= connectCalls, 'no single attempt may log more than one warn (at most once per window)');

    const callsAtGivingUp = connectCalls;
    const entriesAtGivingUp = entries.length;

    // Never silently stop trying: three more ceiling-length windows (32 ticks
    // each) worth of ticks must still produce new connect attempts.
    await tick(agent, 32 * 3);
    assert.ok(connectCalls > callsAtGivingUp + 2, 'retries must continue past the ceiling, forever');

    // ...but "giving up" also means giving up on logging each one — no new
    // lines once the ceiling has been announced, even though attempts continue.
    assert.equal(entries.length, entriesAtGivingUp, 'no further log lines after giving-up, even though retries continue forever');
  });
});

test('autoConnectTick: a successful connect resets the backoff to its floor for the next disconnect', async () => {
  let connectCalls = 0;
  let shouldSucceed = false;
  let disconnectedCb = null;
  const mockChromium = {
    connectOverCDP: async () => {
      connectCalls++;
      if (shouldSucceed) {
        return { contexts: () => [], on: (event, cb) => { if (event === 'disconnected') disconnectedCb = cb; } };
      }
      throw new Error('connect ECONNREFUSED 127.0.0.1:9222');
    },
    launchPersistentContext: async () => { throw new Error('unused'); },
  };
  const { logger } = makeSpyLogger();

  await withMockedAdapter(mockChromium, logger, async (agent) => {
    // Window 1 (factor 1) fails on tick 1; window 2 (factor 2) fails on the
    // 2nd of its ticks — 3 ticks total, 2 failed attempts, factor now 4.
    await tick(agent, 3);
    assert.equal(connectCalls, 2, 'two attempts have failed, the backoff factor has climbed to 4');

    // A debug Chrome appears — window 3 (factor 4) needs 4 more ticks.
    shouldSucceed = true;
    await tick(agent, 4);
    assert.equal(connectCalls, 3, 'the third attempt succeeded');
    assert.equal(agent.getStatus().state, 'ONLINE');

    // It drops unexpectedly (the adapter's own 'disconnected' listener fires,
    // not a manual disconnect() — that sets intentionalDisconnect and would
    // stop the poller on purpose, which is not what this is testing).
    shouldSucceed = false;
    assert.ok(disconnectedCb, 'connect() must have registered a disconnected listener on success');
    disconnectedCb();
    assert.equal(agent.getStatus().state, 'OFFLINE');

    // The very next tick must attempt immediately: the success reset the
    // backoff to its floor (factor 1), so it does not need to wait out the
    // 4-tick window the previous failing run had climbed to.
    const callsBefore = connectCalls;
    await tick(agent, 1);
    assert.equal(connectCalls, callsBefore + 1, 'the first tick after an unexpected drop must retry — backoff was reset by the prior success');
  });
});
