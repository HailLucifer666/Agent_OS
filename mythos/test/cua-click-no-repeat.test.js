'use strict';

// test/cua-click-no-repeat.test.js — live session 2026-08-12: cua_click({pid: 2736,
// element_index: 10}) fired twice and hit "What's New" both times, after the
// operator said the first click was wrong. The model just retried the exact
// same args and got the exact same (wrong) result, wasting a turn.
//
// Fix under test: cua_click caches the resolved label of the last (pid/window,
// element_index) it clicked. A second identical click re-resolves the live
// element tree; if the index still maps to the SAME label, the click is
// refused and the label is named in the error so the model picks a different
// target. If the label has changed (UI moved on), the click is allowed
// through and the cache is refreshed.

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

// A driver whose get_window_state answer can change between calls (to model
// the UI moving on between clicks) and whose click always "succeeds".
function driverWithElements(getElements, calls) {
  return {
    getStatus: () => ({ state: 'ONLINE' }),
    invoke: async (tool, args) => {
      calls.push({ tool, args });
      if (tool === 'list_windows') {
        // cua_get_window_state resolves window_id from pid via list_windows
        // when no window_id is given — hand back a window for every pid this
        // suite exercises so resolution succeeds regardless of which one asked.
        return {
          ok: true,
          result: mcpOk({
            windows: [
              { pid: 2736, window_id: 'w-2736', title: 'Test Window' },
              { pid: 9999, window_id: 'w-9999', title: 'Other Window' },
            ],
          }),
        };
      }
      if (tool === 'get_window_state') {
        return { ok: true, result: mcpOk({ elements: getElements() }) };
      }
      if (tool === 'click') {
        return { ok: true, result: mcpOk({}) };
      }
      throw new Error('unexpected tool: ' + tool);
    },
  };
}

describe('cua_click refuses to repeat an identical click on an unchanged control', () => {
  it('THE RECORDED CASE: a second identical (pid, element_index) click is refused and names the unchanged label', async () => {
    const calls = [];
    const driver = driverWithElements(
      () => [{ element_index: 10, role: 'button', label: "What's New" }],
      calls
    );

    await withMockedCuaDriver(driver, async (m) => {
      const click = m.TOOLS.find((t) => t.name === 'cua_click');

      const first = await click.fn({ pid: 2736, element_index: 10 });
      assert.equal(first.ok, true, 'the first click must go through normally');

      const clicksSoFar = calls.filter((c) => c.tool === 'click').length;
      assert.equal(clicksSoFar, 1);

      const second = await click.fn({ pid: 2736, element_index: 10 });
      assert.equal(second.ok, false, 'an identical repeat must be refused, not re-fired');
      assert.match(String(second.result), /What's New/,
        'the refusal must name the unchanged label so the model can pick a different target');

      assert.equal(calls.filter((c) => c.tool === 'click').length, 1,
        'the driver must never receive a second click for the refused repeat');
    });
  });

  it('allows the repeat through when the element at that index now has a different label (UI changed)', async () => {
    const calls = [];
    let label = "What's New";
    const driver = driverWithElements(
      () => [{ element_index: 10, role: 'button', label: label }],
      calls
    );

    await withMockedCuaDriver(driver, async (m) => {
      const click = m.TOOLS.find((t) => t.name === 'cua_click');

      const first = await click.fn({ pid: 2736, element_index: 10 });
      assert.equal(first.ok, true);

      label = 'Close'; // the UI moved on: the same index now points at a different control

      const second = await click.fn({ pid: 2736, element_index: 10 });
      assert.equal(second.ok, true, 'a changed label means this is not the same wrong click — allow it');
      assert.equal(calls.filter((c) => c.tool === 'click').length, 2,
        'the driver must receive the click once the label has changed');
    });
  });

  it('does not treat identical element_index values on different pids as a repeat', async () => {
    const calls = [];
    const driver = driverWithElements(
      () => [{ element_index: 10, role: 'button', label: "What's New" }],
      calls
    );

    await withMockedCuaDriver(driver, async (m) => {
      const click = m.TOOLS.find((t) => t.name === 'cua_click');

      const first = await click.fn({ pid: 2736, element_index: 10 });
      assert.equal(first.ok, true);

      const otherPid = await click.fn({ pid: 9999, element_index: 10 });
      assert.equal(otherPid.ok, true, 'a different pid at the same element_index is not the same control');
      assert.equal(calls.filter((c) => c.tool === 'click').length, 2);
    });
  });

  it('a third identical click after an allowed "label changed" repeat is refused again against the new label', async () => {
    const calls = [];
    let label = "What's New";
    const driver = driverWithElements(
      () => [{ element_index: 10, role: 'button', label: label }],
      calls
    );

    await withMockedCuaDriver(driver, async (m) => {
      const click = m.TOOLS.find((t) => t.name === 'cua_click');

      await click.fn({ pid: 2736, element_index: 10 }); // first click, label "What's New"
      label = 'Close';
      const second = await click.fn({ pid: 2736, element_index: 10 }); // label changed -> allowed
      assert.equal(second.ok, true);

      const third = await click.fn({ pid: 2736, element_index: 10 }); // label unchanged since 2nd click ("Close")
      assert.equal(third.ok, false, 'the cache must have been refreshed to "Close" after the allowed repeat');
      assert.match(String(third.result), /Close/);
      assert.equal(calls.filter((c) => c.tool === 'click').length, 2,
        'the third, refused call must not reach the driver');
    });
  });
});
