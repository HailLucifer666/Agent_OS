'use strict';

// test/cua-driver-adapter.test.js — BUG-026 (4th attempt) part B. This machine does not have
// cua-driver installed (external binary, install requires explicit user
// go-ahead — see BUGS.md / the plan this was built from), so these tests only
// cover graceful-degradation behavior: side-effect-free require, invoke()
// never throwing, and startCuaDriver() settling cleanly to OFFLINE with a
// clear hint (not an infinite restart loop) when the binary genuinely isn't
// on PATH. Real MCP handshake/tool-call behavior against an installed binary
// is NOT covered here — that needs live verification once cua-driver is
// actually installed (mirrors pc-child's own "no PS test harness" precedent
// for behavior that can't be verified without the real external dependency).

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

  it('startCuaDriver() on a box without the binary settles to OFFLINE with a "not found" hint, never throws, never restart-loops', async function() {
    var cuaDriver = require('../adapters/cua-driver');
    assert.doesNotThrow(function() { cuaDriver.startCuaDriver(); });
    // spawn's ENOENT error fires asynchronously (process.nextTick/libuv), not
    // synchronously from spawn() itself.
    await sleep(500);
    var status = cuaDriver.getStatus();
    assert.equal(status.state, 'OFFLINE', 'must degrade to OFFLINE, not hang in STARTING');
    assert.ok(status.hint, 'must carry a hint explaining why it is offline');
    assert.ok(
      status.hint.toLowerCase().indexOf('not found') !== -1,
      'hint should explain the binary was not found on PATH, got: ' + status.hint
    );
    cuaDriver.shutdownCuaDriver();
  });
});
