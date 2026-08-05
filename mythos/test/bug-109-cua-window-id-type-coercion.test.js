'use strict';

// BUG-109 (2026-08-05 audit): cua_get_window_state rejected a string
// window_id -- "Missing required integer field window_id." The model passed
// window_id:"854628" (a numeric string). from-cua.js's `if (!windowId && ...)`
// sees a truthy string, skips the pid-resolution path built for exactly this,
// and forwards the string straight to cua-driver, which demands an integer.
//
// Fix: coerce a numeric-looking window_id string to a real number at the
// boundary. A NON-numeric window_id (e.g. the opaque 'w-1234' ids
// cua-window-state-resolution.test.js already exercises) is left untouched --
// it is a valid opaque id, not a malformed integer, and nulling it out would
// silently discard a caller-supplied value the pid-fallback path was never
// meant to override.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const FROM_CUA_PATH = path.resolve(__dirname, '../src/core/effectors/from-cua.js');

const originalRequire = Module.prototype.require;
function withMockedCuaDriver(mock, fn) {
  Module.prototype.require = function (id) {
    if (id === '../../../adapters/cua-driver') return mock;
    return originalRequire.apply(this, arguments);
  };
  delete require.cache[FROM_CUA_PATH];
  try {
    return fn(require(FROM_CUA_PATH));
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[FROM_CUA_PATH];
  }
}

function mcpOk(structuredContent) {
  return { content: [], structuredContent: structuredContent, isError: false };
}

function driverFor(recorder) {
  return {
    getStatus: () => ({ state: 'ONLINE' }),
    invoke: async (tool, args) => {
      recorder.push({ tool, args });
      return { ok: true, result: mcpOk({ elements: [], windows: [] }) };
    },
  };
}

describe('BUG-109: cua_* tools coerce a numeric-string window_id to a real number', () => {
  it('cua_get_window_state: window_id:"854628" reaches the driver as the number 854628, not a string', async () => {
    const calls = [];
    await withMockedCuaDriver(driverFor(calls), async (m) => {
      const res = await m.TOOLS.find((t) => t.name === 'cua_get_window_state').fn({ window_id: '854628', pid: 111 });
      assert.equal(res.ok, true);
      const gws = calls.find((c) => c.tool === 'get_window_state');
      assert.ok(gws, 'get_window_state must have been called');
      assert.strictEqual(gws.args.window_id, 854628, 'window_id must be a real number, not the string "854628"');
      assert.equal(typeof gws.args.window_id, 'number');
      assert.equal(calls.some((c) => c.tool === 'list_windows'), false,
        'a valid (coerced) window_id must not trigger pid-resolution — it is already usable');
    });
  });

  it('cua_click: window_id:"999" reaches the driver as the number 999', async () => {
    const calls = [];
    await withMockedCuaDriver(driverFor(calls), async (m) => {
      const res = await m.TOOLS.find((t) => t.name === 'cua_click').fn({ element_index: 0, window_id: '999' });
      assert.equal(res.ok, true);
      const click = calls.find((c) => c.tool === 'click');
      assert.ok(click);
      assert.strictEqual(click.args.window_id, 999);
      assert.equal(typeof click.args.window_id, 'number');
    });
  });

  it('cua_bring_to_front: window_id:"42" reaches the driver as the number 42', async () => {
    const calls = [];
    await withMockedCuaDriver(driverFor(calls), async (m) => {
      const res = await m.TOOLS.find((t) => t.name === 'cua_bring_to_front').fn({ window_id: '42' });
      assert.equal(res.ok, true);
      const call = calls.find((c) => c.tool === 'bring_to_front');
      assert.ok(call);
      assert.strictEqual(call.args.window_id, 42);
    });
  });

  it('regression: a non-numeric opaque window_id (e.g. "w-1234") is forwarded unchanged, never coerced or nulled', async () => {
    const calls = [];
    await withMockedCuaDriver(driverFor(calls), async (m) => {
      const res = await m.TOOLS.find((t) => t.name === 'cua_get_window_state').fn({ window_id: 'w-1234' });
      assert.equal(res.ok, true);
      const gws = calls.find((c) => c.tool === 'get_window_state');
      assert.strictEqual(gws.args.window_id, 'w-1234', 'a non-numeric window_id must pass through as-is');
    });
  });

  it('edge: a non-integer numeric-looking string ("12.5") is left as-is rather than mangled by parseInt', async () => {
    const calls = [];
    await withMockedCuaDriver(driverFor(calls), async (m) => {
      await m.TOOLS.find((t) => t.name === 'cua_get_window_state').fn({ window_id: '12.5' });
      const gws = calls.find((c) => c.tool === 'get_window_state');
      assert.strictEqual(gws.args.window_id, '12.5', 'a non-clean-integer string must not be silently truncated to 12');
    });
  });
});
