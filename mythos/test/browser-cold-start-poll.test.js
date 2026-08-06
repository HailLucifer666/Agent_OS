'use strict';

// test/f4-browser-cold-start-poll.test.js — BUG-140.
//
// browser_launch_debug used to `await new Promise(r => setTimeout(r, 2000))`
// unconditionally after spawning the browser, before the first CDP connect
// attempt — pure added latency on every launch regardless of how fast the
// debug port actually came up. Replaced with waitForDebugPortReady(), a
// poll-until-ready loop (COLD_START_POLL_INTERVAL_MS interval,
// COLD_START_CEILING_MS ceiling) exported from from-browser.js as a pure
// seam so it's testable without spawning a real browser.
//
// These tests exercise the extracted helper directly with a faked probe,
// per the task's own guidance to prefer that over widening the
// browser_launch_debug dependency-injection surface.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  waitForDebugPortReady,
  COLD_START_CEILING_MS,
} = require('../src/core/effectors/from-browser');

describe('BUG-140: browser cold-start poll-until-ready', () => {
  test('resolves true substantially under the ceiling when the probe is fast-ready', async () => {
    let calls = 0;
    const probe = async () => {
      calls += 1;
      return calls >= 2; // ready on the second poll
    };

    const start = Date.now();
    const ready = await waitForDebugPortReady(probe);
    const elapsed = Date.now() - start;

    assert.equal(ready, true);
    assert.ok(elapsed < COLD_START_CEILING_MS / 2,
      `expected well under ${COLD_START_CEILING_MS}ms, took ${elapsed}ms`);
    assert.ok(calls >= 2);
  });

  test('gives up at the ceiling and resolves false (never throws) when the probe never reports ready', async () => {
    const probe = async () => false;

    const start = Date.now();
    const ready = await waitForDebugPortReady(probe);
    const elapsed = Date.now() - start;

    assert.equal(ready, false);
    // Ceiling is a floor on elapsed time here, with slack for scheduling jitter.
    assert.ok(elapsed >= COLD_START_CEILING_MS - 50,
      `expected close to ${COLD_START_CEILING_MS}ms, took ${elapsed}ms`);
    assert.ok(elapsed < COLD_START_CEILING_MS + 2000,
      `expected not to wildly overshoot the ceiling, took ${elapsed}ms`);
  });
});
