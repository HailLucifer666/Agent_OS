'use strict';

// bug-075-launch-app-routing.test.js — Stage 5 of 7.
//
// Two mis-routings logged in the 2026-07-31 session:
//   1. launch_app("youtube") failed 3x — nothing named YouTube is installed on
//      Windows, so every launch tier honestly missed. It should instead route
//      to the same 'ui.open-web' signal open_web uses (BUG-075's Electron
//      media-window bridge picks it up from there).
//   2. launch_app('explorer.exe "D:\\..."') was attempted 3x — a shape that
//      can never resolve (launch_app takes an app NAME, not a command with
//      arguments). It should redirect to open_folder (BUG-058), which already
//      exists for exactly this.
//
// Both branches must short-circuit BEFORE calling into pc-child at all — the
// mocked sendCommand below throws on any unexpected cmd, so a call reaching
// it proves the guard did NOT engage.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const originalRequire = Module.prototype.require;
const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');
const FROM_COMPUTER_PATH = path.resolve(__dirname, '../src/core/effectors/from-computer.js');

function withMocks({ pcChildMock, openFolderMock }, fn) {
  Module.prototype.require = function (id, ...rest) {
    if (id === '../../../adapters/pc-child') return pcChildMock;
    if (openFolderMock && this.filename === FROM_PC_PATH && id === './from-computer') {
      const real = originalRequire.call(this, id, ...rest);
      return Object.assign({}, real, { open_folder: openFolderMock });
    }
    return originalRequire.call(this, id, ...rest);
  };
  delete require.cache[FROM_PC_PATH];
  try {
    return fn(require(FROM_PC_PATH));
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[FROM_PC_PATH];
  }
}

function explodingPcChild() {
  return {
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmdObj) => {
      throw new Error('pc-child must not be called for this branch: ' + JSON.stringify(cmdObj));
    },
  };
}

test('launch_app("youtube") emits ui.open-web instead of hitting pc-child', async () => {
  await withMocks({ pcChildMock: explodingPcChild() }, async (fromPc) => {
    const emitted = [];
    const ctx = { bus: { emit: (name, payload) => emitted.push({ name, payload }) } };

    const res = await fromPc.launch_app({ name: 'youtube' }, ctx);

    assert.equal(res.ok, true);
    assert.equal(res.result.widgetType, 'web');
    assert.equal(res.result.embedUrl, 'https://www.youtube.com');

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].name, 'ui.open-web');
    assert.deepEqual(emitted[0].payload, { widgetType: 'web', embedUrl: 'https://www.youtube.com', title: 'youtube' });
  });
});

test('launch_app is case-insensitive and trims whitespace for known web apps', async () => {
  await withMocks({ pcChildMock: explodingPcChild() }, async (fromPc) => {
    const ctx = { bus: { emit: () => {} } };
    const res = await fromPc.launch_app({ name: '  Gmail  ' }, ctx);
    assert.equal(res.ok, true);
    assert.equal(res.result.embedUrl, 'https://mail.google.com');
  });
});

test('an unmapped app name still falls through to the real launch tiers (no over-broad routing)', async () => {
  let sawLaunchAppCall = false;
  const pcChildMock = {
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmdObj) => {
      if (cmdObj.cmd === 'launch_app') { sawLaunchAppCall = true; return { ok: true, result: { pid: 42, matchedBy: 'process', name: 'notepad' } }; }
      throw new Error('unexpected cmd: ' + cmdObj.cmd);
    },
  };
  await withMocks({ pcChildMock }, async (fromPc) => {
    const res = await fromPc.launch_app({ name: 'notepad' }, { bus: { emit: () => {} } });
    assert.equal(sawLaunchAppCall, true, 'notepad must still go through the real launch path');
    assert.equal(res.ok, true);
  });
});

test('launch_app("explorer.exe \\"D:\\\\projects\\"") redirects to open_folder instead of calling pc-child', async () => {
  let openFolderArgs = null;
  const openFolderMock = async (args) => { openFolderArgs = args; return { ok: true, result: { opened: args.path, name: 'projects' } }; };

  await withMocks({ pcChildMock: explodingPcChild(), openFolderMock }, async (fromPc) => {
    const res = await fromPc.launch_app({ name: 'explorer.exe "D:\\projects"' }, { bus: { emit: () => {} } });
    assert.equal(res.ok, true);
    assert.ok(openFolderArgs, 'open_folder must have been called');
    assert.equal(openFolderArgs.path, 'D:\\projects');
  });
});

test('launch_app("explorer D:\\reports") (no .exe, no quotes) also redirects', async () => {
  let openFolderArgs = null;
  const openFolderMock = async (args) => { openFolderArgs = args; return { ok: true, result: { opened: args.path } }; };

  await withMocks({ pcChildMock: explodingPcChild(), openFolderMock }, async (fromPc) => {
    const res = await fromPc.launch_app({ name: 'explorer D:\\reports' }, { bus: { emit: () => {} } });
    assert.equal(res.ok, true);
    assert.equal(openFolderArgs.path, 'D:\\reports');
  });
});

test('KNOWN_WEB_APPS stays a small, deliberate list (ponytail — not a general registry)', async () => {
  await withMocks({ pcChildMock: explodingPcChild() }, async (fromPc) => {
    const names = Object.keys(fromPc.KNOWN_WEB_APPS);
    assert.ok(names.length <= 5, 'the list is meant to stay small — see the ponytail comment in from-pc.js');
    assert.deepEqual(names.sort(), ['gmail', 'maps', 'youtube']);
  });
});
