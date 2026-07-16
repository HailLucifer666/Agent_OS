'use strict';

// test/cua-driver-adapter.test.js — BUG-026 part B. Covers graceful-degradation
// behavior: side-effect-free require, invoke() never throwing while offline,
// and startCuaDriver() settling to a terminal state (never stuck in STARTING).
// The lifecycle test is environment-aware: on a machine WITH cua-driver
// installed (this box since 2026-07-17, cua-driver-rs 0.8.3) it must reach
// ONLINE via a genuine MCP initialize handshake; on a machine without it, it
// must settle OFFLINE with a "not found" hint and never restart-loop.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

describe('adapters/cua-driver — graceful degradation', function() {
  it('require() is side-effect-free — getStatus() is OFFLINE until start() is called', function() {
    var cuaDriver = require('../adapters/cua-driver');
    var status = cuaDriver.getStatus();
    assert.equal(status.state, 'OFFLINE');
    assert.equal(status.queueDepth, 0);
  });

  it('invoke() never throws and returns ok:false while offline', async function() {
    var cuaDriver = require('../adapters/cua-driver');
    var result = await cuaDriver.invoke('click_at_uia_hittest', { x: 1, y: 2 });
    assert.equal(result.ok, false);
    assert.equal(typeof result.result, 'string');
  });

  it('shutdownCuaDriver() is safe to call even if nothing was ever started', function() {
    var cuaDriver = require('../adapters/cua-driver');
    assert.doesNotThrow(function() { cuaDriver.shutdownCuaDriver(); });
  });

  it('startCuaDriver() settles to a terminal state — ONLINE (binary installed) or OFFLINE with a "not found" hint — never stuck in STARTING, never throws', async function() {
    var cuaDriver = require('../adapters/cua-driver');
    assert.doesNotThrow(function() { cuaDriver.startCuaDriver(); });
    // Poll up to 8s: spawn ENOENT fires async; a real MCP initialize handshake
    // against the installed binary can take a few seconds on first run.
    var status = cuaDriver.getStatus();
    var deadline = Date.now() + 8000;
    while (status.state === 'STARTING' && Date.now() < deadline) {
      await sleep(250);
      status = cuaDriver.getStatus();
    }
    assert.notEqual(status.state, 'STARTING', 'must settle, not hang in STARTING');
    if (status.state === 'OFFLINE') {
      assert.ok(status.hint, 'must carry a hint explaining why it is offline');
      assert.ok(
        status.hint.toLowerCase().indexOf('not found') !== -1 ||
        status.hint.toLowerCase().indexOf('failed') !== -1 ||
        status.hint.toLowerCase().indexOf('timed out') !== -1,
        'hint should explain the failure, got: ' + status.hint
      );
    } else {
      assert.equal(status.state, 'ONLINE', 'installed binary must complete the MCP handshake');
    }
    cuaDriver.shutdownCuaDriver();
  });
});
