'use strict';

// Two defects observed live 2026-08-02 in from-cua.js's cua_get_window_state:
//
// DEFECT 1: it forwarded {pid, window_id} straight to cua-driver, which
// answers "Missing required integer field window_id". The model only ever
// holds a pid (from launch_app / list_windows), never a window_id, so the
// tool failed 100% of the time. Fixed by resolving window_id from pid via
// the file's own cua_list_windows path before calling the driver.
//
// DEFECT 2: cua-driver's MCP-shaped error object ({content:[{type:'text',
// text:'...'}], isError:true}) was passed straight to fail(), so the model
// was literally told "[object Object]" twice in one session. Fixed with a
// local cuaErrText() unwrapper routed through every fail() in the file.

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

function mcpError(text) {
  return { content: [{ type: 'text', text: text }], structuredContent: {}, isError: true };
}

describe('cua_get_window_state resolves window_id from pid (DEFECT 1)', () => {
  it('THE RECORDED CASE: only a pid is given — resolves a window_id via list_windows and calls the driver with it', async () => {
    const invokeCalls = [];
    const driver = {
      getStatus: () => ({ state: 'ONLINE' }),
      invoke: async (tool, args) => {
        invokeCalls.push({ tool, args });
        if (tool === 'list_windows') {
          return {
            ok: true,
            result: mcpOk({
              windows: [
                { pid: 1234, window_id: 'w-1234', title: 'Spotify' },
                { pid: 9999, window_id: 'w-9999', title: 'Other App' },
              ],
            }),
          };
        }
        if (tool === 'get_window_state') {
          return { ok: true, result: mcpOk({ elements: [] }) };
        }
        throw new Error('unexpected tool: ' + tool);
      },
    };

    await withMockedCuaDriver(driver, async (m) => {
      const res = await m.TOOLS.find((t) => t.name === 'cua_get_window_state').fn({ pid: 1234 });
      assert.equal(res.ok, true, 'get_window_state must succeed once window_id is resolved from pid');

      const gws = invokeCalls.find((c) => c.tool === 'get_window_state');
      assert.ok(gws, 'get_window_state must have been called');
      assert.equal(gws.args.window_id, 'w-1234', 'the resolved window_id must be forwarded to the driver');
      assert.equal(gws.args.pid, 1234);
    });
  });

  it('prefers the candidate with a non-empty title when several windows share a pid', async () => {
    const invokeCalls = [];
    const driver = {
      getStatus: () => ({ state: 'ONLINE' }),
      invoke: async (tool, args) => {
        invokeCalls.push({ tool, args });
        if (tool === 'list_windows') {
          return {
            ok: true,
            result: mcpOk({
              windows: [
                { pid: 42, window_id: 'w-blank', title: '' },
                { pid: 42, window_id: 'w-titled', title: 'Main Window' },
              ],
            }),
          };
        }
        if (tool === 'get_window_state') return { ok: true, result: mcpOk({ elements: [] }) };
        throw new Error('unexpected tool: ' + tool);
      },
    };

    await withMockedCuaDriver(driver, async (m) => {
      const res = await m.TOOLS.find((t) => t.name === 'cua_get_window_state').fn({ pid: 42 });
      assert.equal(res.ok, true);
      const gws = invokeCalls.find((c) => c.tool === 'get_window_state');
      assert.equal(gws.args.window_id, 'w-titled');
    });
  });

  it('window_id passed directly by the caller is used as-is (no resolution needed)', async () => {
    const invokeCalls = [];
    const driver = {
      getStatus: () => ({ state: 'ONLINE' }),
      invoke: async (tool, args) => {
        invokeCalls.push({ tool, args });
        if (tool === 'get_window_state') return { ok: true, result: mcpOk({ elements: [] }) };
        throw new Error('unexpected tool: ' + tool);
      },
    };

    await withMockedCuaDriver(driver, async (m) => {
      const res = await m.TOOLS.find((t) => t.name === 'cua_get_window_state').fn({ window_id: 'w-direct' });
      assert.equal(res.ok, true);
      assert.equal(invokeCalls.length, 1, 'list_windows must not be called when window_id is already given');
      assert.equal(invokeCalls[0].tool, 'get_window_state');
      assert.equal(invokeCalls[0].args.window_id, 'w-direct');
    });
  });
});

describe('cua-driver MCP errors surface as readable prose, not "[object Object]" (DEFECT 2)', () => {
  it('THE RECORDED CASE: an MCP-shaped isError response never renders as "[object Object]"', async () => {
    const driver = {
      getStatus: () => ({ state: 'ONLINE' }),
      invoke: async (tool) => {
        if (tool === 'list_windows') {
          return { ok: true, result: mcpOk({ windows: [{ pid: 55, window_id: 'w-55', title: 'App' }] }) };
        }
        if (tool === 'get_window_state') {
          return { ok: false, result: mcpError('background_unavailable: element not reachable') };
        }
        throw new Error('unexpected tool: ' + tool);
      },
    };

    await withMockedCuaDriver(driver, async (m) => {
      const res = await m.TOOLS.find((t) => t.name === 'cua_get_window_state').fn({ pid: 55 });
      assert.equal(res.ok, false);
      assert.doesNotMatch(String(res.result), /\[object Object\]/);
      assert.match(String(res.result), /background_unavailable: element not reachable/);
    });
  });

  it('cua_get_window_state failures name see_and_click as the recovery tool', async () => {
    const driver = {
      getStatus: () => ({ state: 'ONLINE' }),
      invoke: async (tool) => {
        if (tool === 'list_windows') {
          return { ok: true, result: mcpOk({ windows: [{ pid: 55, window_id: 'w-55', title: 'App' }] }) };
        }
        if (tool === 'get_window_state') {
          return { ok: false, result: mcpError('some driver failure') };
        }
        throw new Error('unexpected tool: ' + tool);
      },
    };

    await withMockedCuaDriver(driver, async (m) => {
      const res = await m.TOOLS.find((t) => t.name === 'cua_get_window_state').fn({ pid: 55 });
      assert.equal(res.ok, false);
      assert.match(String(res.result), /see_and_click/);
    });
  });

  it('a plain string driver error (e.g. a timeout) still surfaces intact', async () => {
    const driver = {
      getStatus: () => ({ state: 'ONLINE' }),
      invoke: async (tool) => {
        if (tool === 'list_windows') {
          return { ok: true, result: mcpOk({ windows: [{ pid: 1, window_id: 'w-1', title: 'X' }] }) };
        }
        if (tool === 'get_window_state') return { ok: false, result: 'cua-driver command timed out' };
        throw new Error('unexpected tool: ' + tool);
      },
    };

    await withMockedCuaDriver(driver, async (m) => {
      const res = await m.TOOLS.find((t) => t.name === 'cua_get_window_state').fn({ pid: 1 });
      assert.equal(res.ok, false);
      assert.match(String(res.result), /cua-driver command timed out/);
    });
  });
});

describe('cua_get_window_state with no window found for the pid (honest failure)', () => {
  it('THE RECORDED CASE: pid has no matching window — ok:false naming the pid, no driver call, no fabricated success', async () => {
    const invokeCalls = [];
    const driver = {
      getStatus: () => ({ state: 'ONLINE' }),
      invoke: async (tool, args) => {
        invokeCalls.push({ tool, args });
        if (tool === 'list_windows') {
          return { ok: true, result: mcpOk({ windows: [{ pid: 111, window_id: 'w-111', title: 'Unrelated' }] }) };
        }
        throw new Error('get_window_state must not be called when no window resolves for the pid');
      },
    };

    await withMockedCuaDriver(driver, async (m) => {
      const res = await m.TOOLS.find((t) => t.name === 'cua_get_window_state').fn({ pid: 404 });
      assert.equal(res.ok, false);
      assert.match(String(res.result), /404/, 'failure text must name the pid that could not be resolved');
      assert.match(String(res.result), /see_and_click/);
      assert.equal(
        invokeCalls.filter((c) => c.tool === 'get_window_state').length,
        0,
        'the driver must never be called with a window_id we could not resolve'
      );
    });
  });
});
