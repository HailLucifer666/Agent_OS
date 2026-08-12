'use strict';

// test/cua-arg-validation.test.js — live session 2026-08-12: the model called
// cua_get_window_state with pid:1738, a value that matched no live process,
// and a fabricated window_id "artifact-window-1738" (numbers borrowed from the
// same bogus pid). Both failures said only "not found" -- nothing the model
// could act on. The follow-up call then omitted pid entirely, which the FIRST
// error had explicitly required, and that "missing pid" error dropped the
// live-pid guidance the first error had already surfaced.
//
// Fix under test: every target-not-found / target-missing failure now names
// the live windows (pid + title), capped at WINDOW_LIST_CAP so a machine with
// hundreds of windows never floods the model's context, and a module-level
// cache of the most recent live-window snapshot keeps that guidance available
// even for a later LOCAL validation failure that never itself talks to the
// driver.

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

// 13 live windows so the cap (10) actually has to trim something.
const MANY_WINDOWS = Array.from({ length: 13 }, (_, i) => ({
  pid: 100 + i,
  window_id: 'w-' + (100 + i),
  title: 'App ' + i,
}));

describe('cua_get_window_state: an unknown pid names the live pids and titles', () => {
  it('THE RECORDED CASE: pid 1738 matches no live process — the failure lists real pids to pick from', async () => {
    const calls = [];
    const driver = {
      getStatus: () => ({ state: 'ONLINE' }),
      invoke: async (tool, args) => {
        calls.push({ tool, args });
        if (tool === 'list_windows') return { ok: true, result: mcpOk({ windows: MANY_WINDOWS }) };
        throw new Error('unexpected tool: ' + tool);
      },
    };

    await withMockedCuaDriver(driver, async (m) => {
      const res = await m.TOOLS.find((t) => t.name === 'cua_get_window_state').fn({ pid: 1738 });
      assert.equal(res.ok, false);
      assert.match(String(res.result), /1738/, 'must name the pid that was not found');
      assert.match(String(res.result), /pid 100/, 'must list a real, live pid the model can pick instead');
      assert.match(String(res.result), /App 0/, 'must include the window title alongside the pid');
    });
  });

  it('bounds the live-window list to WINDOW_LIST_CAP (10) even when far more windows are open', async () => {
    const driver = {
      getStatus: () => ({ state: 'ONLINE' }),
      invoke: async (tool) => {
        if (tool === 'list_windows') return { ok: true, result: mcpOk({ windows: MANY_WINDOWS }) };
        throw new Error('unexpected tool: ' + tool);
      },
    };

    await withMockedCuaDriver(driver, async (m) => {
      const res = await m.TOOLS.find((t) => t.name === 'cua_get_window_state').fn({ pid: 9999 });
      assert.equal(res.ok, false);
      const text = String(res.result);
      const listedPids = MANY_WINDOWS.filter((w) => text.indexOf('pid ' + w.pid + ' ') !== -1).length;
      assert.equal(listedPids, 10, 'no more than 10 live windows should be named in the failure text');
      assert.match(text, /\+3 more/, 'the count beyond the cap must still be acknowledged, not silently dropped');
    });
  });
});

describe('cua_get_window_state: an unknown window_id names the valid window handles', () => {
  it('a fabricated window_id fails with the real windows listed, not a bare "not found"', async () => {
    const driver = {
      getStatus: () => ({ state: 'ONLINE' }),
      invoke: async (tool, args) => {
        if (tool === 'get_window_state') return { ok: false, result: mcpError('unknown window_id') };
        if (tool === 'list_windows') {
          return { ok: true, result: mcpOk({ windows: [{ pid: 55, window_id: 'w-55', title: 'Real App' }] }) };
        }
        throw new Error('unexpected tool: ' + tool);
      },
    };

    await withMockedCuaDriver(driver, async (m) => {
      const res = await m.TOOLS.find((t) => t.name === 'cua_get_window_state').fn({ window_id: 'artifact-window-1738' });
      assert.equal(res.ok, false);
      assert.match(String(res.result), /unknown window_id/, 'the underlying driver error must still be present');
      assert.match(String(res.result), /pid 55/, 'must name a real live window the model can use instead');
      assert.match(String(res.result), /Real App/);
    });
  });
});

describe('missing required field: guidance from an earlier failure survives into a later call', () => {
  it('a call missing pid AND window_id names the missing field and repeats the earlier pid guidance', async () => {
    const driver = {
      getStatus: () => ({ state: 'ONLINE' }),
      invoke: async (tool, args) => {
        if (tool === 'list_windows') return { ok: true, result: mcpOk({ windows: [{ pid: 2222, window_id: 'w-2222', title: 'Notes' }] }) };
        if (tool === 'click') return { ok: false, result: mcpError('no such pid') };
        throw new Error('unexpected tool: ' + tool);
      },
    };

    await withMockedCuaDriver(driver, async (m) => {
      const click = m.TOOLS.find((t) => t.name === 'cua_click');

      // First call: a fabricated pid. This fails at the driver, and the
      // failure enrichment fetches (and caches) the live-window snapshot.
      const first = await click.fn({ pid: 1738, element_index: 10 });
      assert.equal(first.ok, false);
      assert.match(String(first.result), /pid 2222/, 'the first error must surface the live pid');

      // Follow-up call: omits pid AND window_id entirely (exactly the bug's
      // "omitted pid entirely" step). This never reaches the driver at all —
      // it must still carry the earlier guidance, not just "pid is missing".
      const second = await click.fn({ element_index: 10 });
      assert.equal(second.ok, false);
      assert.match(String(second.result), /pid|window_id/i, 'must name the missing field');
      assert.match(String(second.result), /pid 2222/,
        'the guidance from the earlier failure must still be present, not silently dropped');
    });
  });
});
