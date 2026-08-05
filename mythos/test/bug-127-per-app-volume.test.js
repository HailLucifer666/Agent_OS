'use strict';

// test/bug-127-per-app-volume.test.js — BUG-127.
//
// 2026-08-06: "lower Spotify's volume" turned the WHOLE MACHINE down —
// spotify_volume's level path called pc set_volume, which is Core Audio's
// master endpoint volume. MYTHOS's own voice got quieter along with the music.
//
// The fix is a genuinely per-app path (pc-child set_app_volume -> Core Audio
// ISimpleAudioVolume on the app's own session), and the rule that matters as
// much as the plumbing: when the target app has no audio session, it must FAIL
// saying so, never silently widen back to the master volume. That silent
// widening is the bug itself.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { registerFromSpotify } = require('../src/core/effectors/from-spotify');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { tierOf } = require('../src/core/leash/tiers');
const { fakeBus } = require('./helpers');

function harness(pcResponder) {
  const calls = [];
  const hub = createEffectorHub({ bus: fakeBus(), config: {} });
  registerFromSpotify(hub, {
    effectors: {
      invoke: async (tool, args) => {
        calls.push({ tool, args });
        return pcResponder ? pcResponder(tool, args) : { ok: true, result: {} };
      },
    },
  });
  return { hub, calls };
}

describe('BUG-127 — "lower Spotify" must not move the system master volume', () => {
  it('an exact level goes to set_app_volume scoped to Spotify, never to set_volume', async () => {
    const { hub, calls } = harness((tool) => (
      tool === 'set_app_volume'
        ? { ok: true, result: { level: 20, count: 1, sessions: [{ process: 'Spotify', pid: 4242, level: 20 }] } }
        : { ok: false, result: `unexpected tool: ${tool}` }
    ));

    const res = await hub.invoke('spotify_volume', { level: 20 });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, 'set_app_volume', 'the master-volume tool must not be reachable from here');
    assert.equal(calls[0].args.name, 'Spotify');
    assert.equal(calls[0].args.level, 20);
    assert.equal(res.ok, true);
  });

  it('when Spotify has no audio session the failure surfaces — no fallback to master volume', async () => {
    const { hub, calls } = harness((tool) => (
      tool === 'set_app_volume'
        ? { ok: false, result: "No audio session for process 'Spotify' - its volume was NOT changed" }
        : { ok: true, result: {} }
    ));

    const res = await hub.invoke('spotify_volume', { level: 20 });

    assert.equal(res.ok, false, 'a missing session is a failure, not a silently-widened success');
    assert.equal(calls.length, 1, 'and nothing else may be attempted afterwards');
    assert.equal(calls[0].tool, 'set_app_volume');
  });

  it('a relative direction still uses the media keys (no per-app equivalent exists)', async () => {
    const { hub, calls } = harness(() => ({ ok: true, result: { sent: true } }));
    await hub.invoke('spotify_volume', { direction: 'down' });
    assert.equal(calls[0].tool, 'media_key');
    assert.equal(calls[0].args.key, 'volume_down');
  });

  it('an out-of-range level is rejected before any PC command is sent', async () => {
    const { hub, calls } = harness();
    const res = await hub.invoke('spotify_volume', { level: 400 });
    assert.equal(res.ok, false);
    assert.equal(calls.length, 0);
  });
});

// Same pc-child module mock as bug-077-send-key-fn-keys.test.js — from-pc.js
// requires the adapter at module scope, so it is swapped at require time.
const path = require('node:path');
const Module = require('node:module');
const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');
const originalRequire = Module.prototype.require;

function withMockedPcChild(mock, fn) {
  Module.prototype.require = function (id) {
    if (id === '../../../adapters/pc-child') return mock;
    return originalRequire.apply(this, arguments);
  };
  delete require.cache[FROM_PC_PATH];
  try {
    return fn(require(FROM_PC_PATH));
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[FROM_PC_PATH];
  }
}

function pc(sent) {
  return {
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (c) => {
      sent.push(c);
      if (c.cmd === 'set_app_volume') {
        return { ok: true, result: { level: c.level, count: 1, sessions: [{ process: 'Spotify', pid: 4242, level: c.level }] } };
      }
      return { ok: true, result: {} };
    },
  };
}

describe('BUG-127 — the pc-child set_app_volume tool itself', () => {
  it('is registered and tiered no higher than the broader set_volume it replaces', () => {
    const { TOOLS } = require('../src/core/effectors/from-pc');
    assert.ok(TOOLS.find((t) => t.name === 'set_app_volume'), 'set_app_volume must be registered on the PC effector');
    assert.equal(tierOf('set_app_volume'), tierOf('set_volume'),
      'a strictly narrower action cannot warrant a stricter gate than the wider one');
  });

  it('sends a set_app_volume command with the name/pid/level the PS handler expects', async () => {
    const sent = [];
    await withMockedPcChild(pc(sent), async (fromPc) => {
      const res = await fromPc.set_app_volume({ name: 'Spotify', level: 30 });
      assert.equal(res.ok, true);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].cmd, 'set_app_volume');
      assert.equal(sent[0].level, 30);
      assert.equal(sent[0].name, 'Spotify');
      assert.equal(sent[0].pid, null, 'a name-only call must not invent a pid');
    });
  });

  it('refuses a call that names no target at all — it must never mean "everything"', async () => {
    const sent = [];
    await withMockedPcChild(pc(sent), async (fromPc) => {
      const res = await fromPc.set_app_volume({ level: 30 });
      assert.equal(res.ok, false);
      assert.equal(sent.length, 0, 'nothing may reach the desktop when no target was given');
    });
  });
});
