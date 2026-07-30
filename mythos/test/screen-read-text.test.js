'use strict';

// test/screen-read-text.test.js — §7.1 real screen OCR via Windows.Media.Ocr
// (ps-automation.ps1's Handle-ScreenReadText, through the existing
// Await-WinRTOperation helper — no tesseract.js, zero new dependencies).

const { test } = require('node:test');
const assert = require('node:assert');
const { TOOLS } = require('../src/core/effectors/from-pc.js');

test('screen_read_text is registered, tier 0, read-only', () => {
  const tool = TOOLS.find((t) => t.name === 'screen_read_text');
  assert.ok(tool, 'screen_read_text must be registered');
  assert.equal(tool.danger, false);
});

test('screen_read_text degrades honestly when pc-child is OFFLINE', async () => {
  const tool = TOOLS.find((t) => t.name === 'screen_read_text');
  const pcChildPath = require.resolve('../adapters/pc-child');
  const realModule = require.cache[pcChildPath];
  delete require.cache[pcChildPath];
  require.cache[pcChildPath] = {
    id: pcChildPath, filename: pcChildPath, loaded: true,
    exports: { getStatus: () => ({ state: 'OFFLINE', hint: 'not running' }) },
  };
  delete require.cache[require.resolve('../src/core/effectors/from-pc.js')];
  try {
    const { TOOLS: freshTools } = require('../src/core/effectors/from-pc.js');
    const freshTool = freshTools.find((t) => t.name === 'screen_read_text');
    const res = await freshTool.fn({});
    assert.equal(res.ok, false);
    assert.match(String(res.result), /offline/i);
  } finally {
    delete require.cache[require.resolve('../src/core/effectors/from-pc.js')];
    if (realModule) require.cache[pcChildPath] = realModule;
    else delete require.cache[pcChildPath];
  }
});

test('screen_read_text reports no-language-pack honestly, without fabricating text', async () => {
  const pcChildPath = require.resolve('../adapters/pc-child');
  const realModule = require.cache[pcChildPath];
  delete require.cache[pcChildPath];
  require.cache[pcChildPath] = {
    id: pcChildPath, filename: pcChildPath, loaded: true,
    exports: {
      getStatus: () => ({ state: 'ONLINE' }),
      sendCommand: (c) => {
        assert.equal(c.cmd, 'screen_read_text');
        return Promise.resolve({ ok: false, error: 'no OCR language pack installed' });
      },
    },
  };
  delete require.cache[require.resolve('../src/core/effectors/from-pc.js')];
  try {
    const { TOOLS: freshTools } = require('../src/core/effectors/from-pc.js');
    const freshTool = freshTools.find((t) => t.name === 'screen_read_text');
    const res = await freshTool.fn({});
    assert.equal(res.ok, false);
    assert.match(String(res.result), /language pack/i);
  } finally {
    delete require.cache[require.resolve('../src/core/effectors/from-pc.js')];
    if (realModule) require.cache[pcChildPath] = realModule;
    else delete require.cache[pcChildPath];
  }
});
