'use strict';
// phone-torch.test.js — `phone_torch` against a mocked android-child (same module-singleton
// stubbing as from-android.test.js). No adb, no device. What is pinned here is the contract
// the live measurement on 2026-09-08 (OnePlus 7T, Android 12) established: the quick-settings
// tile is BOTH the actuator and the oracle, and the tool never taps blind.
//
// Mutation probes, run 2026-09-08 against from-android.js with sed, each verified applied
// (grep count 1), each red with the suite otherwise green, source restored byte-identical
// from a backup copy after each:
//   (a) replace the `input tap` dispatch with `{ ok: true }` -> 8 pass / 1 fail ("taps the tile
//       once ..."): no tap command captured.
//   (c) `if (before.on === want)` -> `if (false)` -> 8/1 ("already in the requested state"): a tap
//       was captured and changed came back true.
//   (d) `if (after.on !== want)` -> `if (false && ...)` -> 8/1 ("a tap that changed nothing is a
//       failure").
//   (e) remove the `finally` collapse call -> 7/2 ("collapsed on every path" plus the
//       command-order test).
// Not mutation-run: "no tile: fails BEFORE tapping" — disabling that guard makes the code throw on
// `before.tile.x` before it could tap, so the test would fail for the wrong reason; its assertion
// (no `input tap` in the captured commands) is the guard.
// Adjacent case that must keep passing: a read-back that cannot be parsed AFTER a real tap is
// unverified with torch:null (AD-5), never a claimed on/off.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const androidChild = require('../adapters/android-child');
const android = require('../src/core/effectors/from-android');

const SERIAL = 'test-serial';

function tileXml(checked, desc) {
  return '<?xml version="1.0"?><hierarchy rotation="0">' +
    '<node index="0" text="" class="android.widget.FrameLayout" content-desc="" checkable="false" checked="false" clickable="false" bounds="[0,0][1080,2400]">' +
    '<node index="3" text="' + (checked ? 'On' : 'Off') + '" class="android.widget.Switch" content-desc="' + (desc || 'Torch') + '"' +
    ' checkable="true" checked="' + (checked ? 'true' : 'false') + '" clickable="true" bounds="[786,349][1017,588]">' +
    '<node index="1" text="Flashlight" resource-id="com.android.systemui:id/tile_label" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="false" bounds="[839,501][964,537]" />' +
    '</node></node></hierarchy>';
}

describe('phone_torch — quick-settings tile as actuator and oracle', () => {
  let originalGetStatus, originalSendCommand, commands, dumps;

  // `dumps` is the sequence of XML the fake device returns for successive dump reads;
  // the last entry repeats once exhausted (a stable tile state).
  function install(dumpSequence) {
    dumps = dumpSequence.slice();
    commands = [];
    androidChild.sendCommand = async (opts) => {
      const remote = String(opts.args[1] || '');
      commands.push(remote);
      if (/^uiautomator dump/.test(remote)) {
        const xml = dumps.length > 1 ? dumps.shift() : dumps[0];
        if (xml instanceof Error) return { ok: false, error: xml.message };
        return { ok: true, stdout: Buffer.from(xml), stderr: '' };
      }
      return { ok: true, stdout: Buffer.from(''), stderr: '' };
    };
  }

  beforeEach(() => {
    // Zero the real-device waits (2 s settle, 600 ms between read-backs): the
    // fake device answers instantly, and the waits would cost ~10 s per
    // failing-path test while proving nothing about the logic under test.
    android.TORCH_TIMING.settleMs = 0;
    android.TORCH_TIMING.readbackDelayMs = 0;
    originalGetStatus = androidChild.getStatus;
    originalSendCommand = androidChild.sendCommand;
    androidChild.getStatus = () => ({
      state: 'ONLINE', hint: null, queueDepth: 0,
      devices: [{ serial: SERIAL, model: 'HD1901', transportId: '1', authState: 'device', lastSeenAt: Date.now() }],
    });
  });
  afterEach(() => {
    androidChild.getStatus = originalGetStatus;
    androidChild.sendCommand = originalSendCommand;
  });

  it('taps the tile once and reports the observed state, in the order a finger would', async () => {
    install([tileXml(false), tileXml(true)]);
    const r = await android.phone_torch({ deviceId: SERIAL, state: 'on' });
    assert.equal(r.ok, true);
    assert.deepEqual({ torch: r.result.torch, verified: r.result.verified, changed: r.result.changed },
      { torch: 'on', verified: true, changed: true });
    assert.match(r.result.observed, /checked=true/);
    const kinds = commands.map((c) => c.split(' ')[0] + (c.startsWith('cmd') ? ' ' + c.split(' ')[2] : ''));
    assert.deepEqual(kinds, ['cmd expand-settings', 'uiautomator', 'input', 'uiautomator', 'cmd collapse']);
    assert.equal(commands[2], 'input tap 901 468', 'tap lands at the centre of the tile bounds, not the label');
  });

  it('no tile in the dump: fails BEFORE tapping, names the cause, and never taps blind', async () => {
    install([tileXml(false, 'Bluetooth')]);
    const r = await android.phone_torch({ deviceId: SERIAL, state: 'on' });
    assert.equal(r.ok, false);
    assert.match(String(r.result), /no Flashlight\/Torch tile/);
    assert.equal(commands.some((c) => c.startsWith('input tap')), false, 'a missing tile must never be tapped at a remembered coordinate');
  });

  it('already in the requested state: reports verified, changed:false, and does not tap', async () => {
    install([tileXml(true)]);
    const r = await android.phone_torch({ deviceId: SERIAL, state: 'on' });
    assert.equal(r.ok, true);
    assert.equal(r.result.changed, false);
    assert.equal(r.result.verified, true);
    assert.equal(commands.some((c) => c.startsWith('input tap')), false);
  });

  it('a tap that changed nothing is a failure, not a success', async () => {
    install([tileXml(false), tileXml(false)]);
    const r = await android.phone_torch({ deviceId: SERIAL, state: 'on' });
    assert.equal(r.ok, false);
    assert.match(String(r.result), /did not take effect/);
  });

  it('read-back unparseable AFTER a real tap is unverified with torch:null — never a claimed state (AD-5)', async () => {
    install([tileXml(false), new Error('device offline mid-command')]);
    const r = await android.phone_torch({ deviceId: SERIAL, state: 'on' });
    assert.equal(r.ok, true, 'nothing observed: not a claimed failure either');
    assert.equal(r.result.verified, false);
    assert.equal(r.result.torch, null);
    assert.equal(r.result.dispatched, true);
  });

  it('the shade is collapsed on every path, including the early failure', async () => {
    install([tileXml(false, 'Bluetooth')]);
    await android.phone_torch({ deviceId: SERIAL, state: 'off' });
    assert.equal(commands[commands.length - 1], 'cmd statusbar collapse');
    install([tileXml(false), tileXml(true)]);
    await android.phone_torch({ deviceId: SERIAL, state: 'on' });
    assert.equal(commands[commands.length - 1], 'cmd statusbar collapse');
  });

  it('accepts on/off and enable/disable, rejects anything else before touching adb', async () => {
    install([tileXml(true)]);
    assert.equal((await android.phone_torch({ deviceId: SERIAL, state: 'enable' })).result.torch, 'on');
    install([tileXml(false)]);
    assert.equal((await android.phone_torch({ deviceId: SERIAL, state: 'disable' })).result.torch, 'off');
    install([tileXml(false)]);
    const bad = await android.phone_torch({ deviceId: SERIAL, state: 'blink' });
    assert.equal(bad.ok, false);
    assert.equal(commands.length, 0);
  });

  it('parseTorchTile: AOSP "Flashlight" and OxygenOS "Torch" both match; the label TextView never does', () => {
    assert.equal(android.parseTorchTile(tileXml(true, 'Flashlight')).on, true);
    assert.equal(android.parseTorchTile(tileXml(false, 'Torch')).on, false);
    assert.equal(android.parseTorchTile(tileXml(false, 'Torchlight app')), null, 'a third-party tile whose name merely starts with "torch" is not the system torch');
    assert.equal(android.parseTorchTile(tileXml(false, 'Torch, Off')).label, 'Torch, Off', 'AOSP appends the state after a comma; the word boundary still matches');
    assert.equal(android.parseTorchTile('<hierarchy><node text="Flashlight" content-desc="" checkable="false" checked="false" bounds="[0,0][1,1]"/></hierarchy>'), null);
    assert.equal(android.parseTorchTile(''), null);
  });
});

describe('phone_torch — catalogue wiring', () => {
  it('is registered as a T2 tool with needs_result:true and is voice-reachable', () => {
    const t = android.TOOLS.find((x) => x.name === 'phone_torch');
    assert.ok(t, 'phone_torch must be in TOOLS');
    assert.equal(t.needs_result, true);
    assert.equal(require('../src/core/leash/tiers').tierOf('phone_torch'), 2);
    const { DEFAULT_ALLOWLIST } = require('../src/core/voice/live-tools');
    assert.ok(DEFAULT_ALLOWLIST.includes('phone_torch'));
  });
});
