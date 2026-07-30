'use strict';

// test/from-pc-wallpaper.test.js — §7.7 wallpaper engine
// (SystemParametersInfo/SPI_SETDESKWALLPAPER P/Invoke in ps-automation.ps1).
// The path argument is sandboxed via from-computer.js's resolveSandboxed
// (reused, not reimplemented) before ever reaching pc-child.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

function freshFromPc() {
  delete require.cache[require.resolve('../src/core/effectors/from-pc.js')];
  return require('../src/core/effectors/from-pc.js');
}

test('set_wallpaper is registered, tier-appropriate danger flag', () => {
  const { TOOLS } = freshFromPc();
  const tool = TOOLS.find((t) => t.name === 'set_wallpaper');
  assert.ok(tool, 'set_wallpaper must be registered');
  assert.equal(tool.danger, false);
});

test('set_wallpaper rejects a path outside the sandbox before ever calling pc-child', async () => {
  const pcChildPath = require.resolve('../adapters/pc-child');
  const realModule = require.cache[pcChildPath];
  delete require.cache[pcChildPath];
  let sendCommandCalled = false;
  require.cache[pcChildPath] = {
    id: pcChildPath, filename: pcChildPath, loaded: true,
    exports: {
      getStatus: () => ({ state: 'ONLINE' }),
      sendCommand: () => { sendCommandCalled = true; return Promise.resolve({ ok: true, result: {} }); },
    },
  };
  try {
    const { TOOLS } = freshFromPc();
    const tool = TOOLS.find((t) => t.name === 'set_wallpaper');
    const res = await tool.fn({ path: 'C:\\Windows\\System32\\mythos-wallpaper-outside.bmp' });
    assert.equal(res.ok, false);
    assert.equal(sendCommandCalled, false, 'must never reach pc-child for an out-of-sandbox path');
  } finally {
    delete require.cache[require.resolve('../src/core/effectors/from-pc.js')];
    if (realModule) require.cache[pcChildPath] = realModule;
    else delete require.cache[pcChildPath];
  }
});

test('set_wallpaper forwards the resolved, sandboxed path to pc-child set_wallpaper', async () => {
  const scratchDir = path.resolve(__dirname, '..', '.tmp-wallpaper-test');
  fs.mkdirSync(scratchDir, { recursive: true });
  const imgPath = path.join(scratchDir, 'wall.bmp');
  fs.writeFileSync(imgPath, 'not a real bmp, just a fixture');

  const pcChildPath = require.resolve('../adapters/pc-child');
  const realModule = require.cache[pcChildPath];
  delete require.cache[pcChildPath];
  const sent = [];
  require.cache[pcChildPath] = {
    id: pcChildPath, filename: pcChildPath, loaded: true,
    exports: {
      getStatus: () => ({ state: 'ONLINE' }),
      sendCommand: (c) => { sent.push(c); return Promise.resolve({ ok: true, result: { set: true, path: c.path } }); },
    },
  };
  try {
    const { TOOLS } = freshFromPc();
    const tool = TOOLS.find((t) => t.name === 'set_wallpaper');
    const res = await tool.fn({ path: imgPath });
    assert.equal(res.ok, true);
    assert.equal(sent[0].cmd, 'set_wallpaper');
    assert.ok(sent[0].path, 'a resolved path must be forwarded');
  } finally {
    delete require.cache[require.resolve('../src/core/effectors/from-pc.js')];
    if (realModule) require.cache[pcChildPath] = realModule;
    else delete require.cache[pcChildPath];
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
});
