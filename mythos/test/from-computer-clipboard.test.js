'use strict';

// test/from-computer-clipboard.test.js — Task 3, clipboard read/write.
// ps-automation.ps1 changes (get_clipboard/set_clipboard cases) are the
// file BUG-037 is about; load-bearing pieces reconfirmed present before and
// after editing it (see the roadmap Progress log for this item).
//
// from-computer.js requires adapters/pc-child directly at module scope
// (matching from-pc.js's own delegate() convention — dispatch-action.js's
// real ctx is {signal, bus, goalId}, it never carries adapter handles), so
// these tests mock it via require-cache substitution, the same pattern
// test/bug-024-gmail-calendar.test.js already uses for adapters/google.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const pcChildPath = require.resolve('../adapters/pc-child');
const fromComputerPath = require.resolve('../src/core/effectors/from-computer.js');
let realPcChildModule;

function installFakePcChild(fake) {
  realPcChildModule = require.cache[pcChildPath];
  delete require.cache[pcChildPath];
  delete require.cache[fromComputerPath];
  require.cache[pcChildPath] = { id: pcChildPath, filename: pcChildPath, loaded: true, exports: fake };
}

beforeEach(() => {
  delete require.cache[fromComputerPath];
});

afterEach(() => {
  delete require.cache[fromComputerPath];
  if (realPcChildModule) { require.cache[pcChildPath] = realPcChildModule; realPcChildModule = null; }
  else delete require.cache[pcChildPath];
});

test('clipboard_read degrades honestly when pc-child is OFFLINE', async () => {
  installFakePcChild({ getStatus: () => ({ state: 'OFFLINE', hint: 'not running' }) });
  const { TOOLS } = require('../src/core/effectors/from-computer.js');
  const tool = TOOLS.find((t) => t.name === 'clipboard_read');
  assert.ok(tool, 'clipboard_read must be registered');
  const res = await tool.fn({}, {});
  assert.equal(res.ok, false);
  assert.match(String(res.result), /offline/i);
});

test('clipboard_write forwards text to pc-child set_clipboard', async () => {
  const sent = [];
  installFakePcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: (c) => { sent.push(c); return Promise.resolve({ ok: true, result: { set: true } }); },
  });
  const { TOOLS } = require('../src/core/effectors/from-computer.js');
  const tool = TOOLS.find((t) => t.name === 'clipboard_write');
  const res = await tool.fn({ text: 'hello' }, {});
  assert.equal(res.ok, true);
  assert.equal(sent[0].cmd, 'set_clipboard');
  assert.equal(sent[0].text, 'hello');
});

test('clipboard_read forwards the real clipboard text back when pc-child is ONLINE', async () => {
  installFakePcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: (c) => {
      assert.equal(c.cmd, 'get_clipboard');
      return Promise.resolve({ ok: true, result: { text: 'copied text' } });
    },
  });
  const { TOOLS } = require('../src/core/effectors/from-computer.js');
  const tool = TOOLS.find((t) => t.name === 'clipboard_read');
  const res = await tool.fn({}, {});
  assert.equal(res.ok, true);
  assert.equal(res.result.text, 'copied text');
});

test('clipboard_write requires text', async () => {
  installFakePcChild({ getStatus: () => ({ state: 'ONLINE' }) });
  const { TOOLS } = require('../src/core/effectors/from-computer.js');
  const tool = TOOLS.find((t) => t.name === 'clipboard_write');
  const res = await tool.fn({}, {});
  assert.equal(res.ok, false);
});

test('both tools are registered with the correct danger flag', () => {
  const { TOOLS } = require('../src/core/effectors/from-computer.js');
  const read = TOOLS.find((t) => t.name === 'clipboard_read');
  const write = TOOLS.find((t) => t.name === 'clipboard_write');
  assert.equal(read.danger, false);
  // clipboard_write is danger:false (not the write_file/delete_file class) —
  // it's tiered T2 like set_volume/media_key, and this repo's own
  // "danger:true -> tier>=3" invariant requires danger:false at T2.
  assert.equal(write.danger, false);
});
