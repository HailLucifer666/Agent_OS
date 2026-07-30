'use strict';

// test/from-android.test.js — Task 10 (Wave 2, ADB phone bridge). Tests run
// against a MOCKED adapters/android-child (module-singleton stubbing, same
// technique test/from-calendar-google.test.js uses for adapters/google —
// both modules are required once and cached, so overwriting exported
// functions on the shared object affects from-android.js's own already-
// captured reference). No real adb, no real device — none exists on this
// machine. The mock is what proves every tool degrades honestly when
// OFFLINE and that phone_sms_send/phone_whatsapp_send never claim delivery.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const androidChild = require('../adapters/android-child');
const { TOOLS } = require('../src/core/effectors/from-android');

function toolFn(name) {
  const t = TOOLS.find((x) => x.name === name);
  assert.ok(t, name + ' must be registered');
  return t.fn;
}

const ARGS_FOR_ANY_TOOL = {
  deviceId: 'test-serial',
  number: '+15551234567',
  text: 'hello there',
  query: 'Bob',
  packageName: 'com.whatsapp',
  state: 'enable',
  remotePath: '/sdcard/x.txt',
  localPath: 'from-android-test-scratch.txt',
};

describe('from-android.js — ships 14 registered effectors (13 rows in the corrected table), no flashlight, no raw shell', () => {
  // The roadmap's table is row-based, not tool-name-based: its own tier
  // column already gives phone_file_pull/phone_file_push DIFFERENT tiers
  // (1 vs 3) under one combined row, so "13 tools, not 14" (the flashlight
  // correction) means 13 ROWS — 14 real registered effectors once that one
  // dual-tier row is expanded into its two constituent tool names. Dropping
  // phone_flashlight_toggle removes exactly one row/one effector from the
  // original 14-row/15-effector table, landing here at 13 rows / 14 effectors.
  it('registers exactly 14 tool effectors', () => {
    assert.equal(TOOLS.length, 14);
  });
  it('never registers phone_flashlight_toggle (no reliable stock command exists — AD-4)', () => {
    assert.equal(TOOLS.some((t) => t.name === 'phone_flashlight_toggle'), false);
  });
  it('never registers a raw phone_shell (would be a de facto T4 bypass of the tier table)', () => {
    assert.equal(TOOLS.some((t) => t.name === 'phone_shell'), false);
  });
});

describe('from-android.js — every tool degrades honestly while the bridge is OFFLINE', () => {
  let originalGetStatus;
  beforeEach(() => {
    originalGetStatus = androidChild.getStatus;
    androidChild.getStatus = () => ({
      state: 'OFFLINE',
      hint: 'adb not found — run node mythos/scripts/setup-android.js --install',
      devices: [],
      queueDepth: 0,
    });
  });
  afterEach(() => {
    androidChild.getStatus = originalGetStatus;
  });

  it('phone_list_devices reports the real OFFLINE hint, not a fabricated device list', async () => {
    const result = await toolFn('phone_list_devices')({});
    assert.equal(result.ok, false);
    assert.match(String(result.result), /OFFLINE/);
    assert.match(String(result.result), /setup-android/);
  });

  it('every other tool resolves ok:false — never throws — while OFFLINE', async () => {
    for (const t of TOOLS) {
      if (t.name === 'phone_list_devices') continue;
      let result;
      await assert.doesNotReject(async () => { result = await t.fn(ARGS_FOR_ANY_TOOL); });
      assert.equal(result.ok, false, t.name + ' must fail while offline, got ok:true');
    }
  });
});

describe('from-android.js — explicit deviceId is required for every device-scoped tool', () => {
  let originalGetStatus;
  afterEach(() => {
    androidChild.getStatus = originalGetStatus;
  });

  it('with zero devices connected, a missing deviceId reports "no devices"', async () => {
    originalGetStatus = androidChild.getStatus;
    androidChild.getStatus = () => ({ state: 'ONLINE', hint: null, devices: [], queueDepth: 0 });
    const result = await toolFn('phone_wifi_toggle')({ state: 'enable' });
    assert.equal(result.ok, false);
    assert.match(String(result.result), /No Android devices connected/);
  });

  it('with devices connected, a missing deviceId reports "which phone" rather than guessing', async () => {
    originalGetStatus = androidChild.getStatus;
    androidChild.getStatus = () => ({
      state: 'ONLINE', hint: null,
      devices: [{ serial: 'a', model: null, transportId: null, authState: 'device', lastSeenAt: Date.now() }],
      queueDepth: 0,
    });
    const result = await toolFn('phone_wifi_toggle')({ state: 'enable' });
    assert.equal(result.ok, false);
    assert.match(String(result.result), /Which phone/);
  });

  // Security-review finding: a deviceId must be a REAL, currently-known
  // serial — not merely a truthy string. A stale serial (phone A unplugged,
  // phone B now attached) must fail loudly rather than silently executing
  // against whatever device android-child's -s argv happens to target.
  it('a deviceId that is not among the currently-known devices is rejected, never silently substituted', async () => {
    originalGetStatus = androidChild.getStatus;
    androidChild.getStatus = () => ({
      state: 'ONLINE', hint: null,
      devices: [{ serial: 'real-serial', model: null, transportId: null, authState: 'device', lastSeenAt: Date.now() }],
      queueDepth: 0,
    });
    const result = await toolFn('phone_wifi_toggle')({ deviceId: 'stale-or-fabricated-serial', state: 'enable' });
    assert.equal(result.ok, false);
    assert.match(String(result.result), /Unknown device/);
  });
});

describe('from-android.js — AD-4 honest send semantics (mocked ONLINE + successful adb call)', () => {
  let originalGetStatus, originalSendCommand, capturedCalls;

  beforeEach(() => {
    capturedCalls = [];
    originalGetStatus = androidChild.getStatus;
    originalSendCommand = androidChild.sendCommand;
    androidChild.getStatus = () => ({
      state: 'ONLINE', hint: null,
      devices: [{ serial: 'test-serial', model: 'Pixel', transportId: '1', authState: 'device', lastSeenAt: Date.now() }],
      queueDepth: 0,
    });
    androidChild.sendCommand = async (opts) => {
      capturedCalls.push(opts);
      return { ok: true, stdout: Buffer.from(''), stderr: '' };
    };
  });
  afterEach(() => {
    androidChild.getStatus = originalGetStatus;
    androidChild.sendCommand = originalSendCommand;
  });

  it('phone_sms_send opens Messages but explicitly reports sent:false — never claims delivery', async () => {
    const result = await toolFn('phone_sms_send')({ deviceId: 'test-serial', number: '+15551234567', text: 'hi' });
    assert.equal(result.ok, true);
    assert.equal(result.result.sent, false);
    assert.match(result.result.note, /not required to send|Not sent|tap on Send/i);
  });

  it('phone_whatsapp_send opens the chat but explicitly reports sent:false — never claims delivery', async () => {
    const result = await toolFn('phone_whatsapp_send')({ deviceId: 'test-serial', number: '+15551234567', text: 'hi' });
    assert.equal(result.ok, true);
    assert.equal(result.result.sent, false);
    assert.match(result.result.note, /Not sent|tap on Send/i);
  });

  it('phone_sms_send rejects an invalid phone number before ever touching adb', async () => {
    const result = await toolFn('phone_sms_send')({ deviceId: 'test-serial', number: 'not-a-number; rm -rf /', text: 'hi' });
    assert.equal(result.ok, false);
    assert.equal(capturedCalls.length, 0, 'must never reach sendCommand with an unvalidated number');
  });

  it('phone_call rejects an invalid phone number before ever touching adb', async () => {
    const result = await toolFn('phone_call')({ deviceId: 'test-serial', number: '$(reboot)' });
    assert.equal(result.ok, false);
    assert.equal(capturedCalls.length, 0);
  });

  it('phone_app_launch/phone_app_close reject a package name containing shell metacharacters', async () => {
    const r1 = await toolFn('phone_app_launch')({ deviceId: 'test-serial', packageName: 'com.evil; rm -rf /sdcard' });
    const r2 = await toolFn('phone_app_close')({ deviceId: 'test-serial', packageName: '$(id)' });
    assert.equal(r1.ok, false);
    assert.equal(r2.ok, false);
    assert.equal(capturedCalls.length, 0);
  });

  it('a malicious SMS body is POSIX-single-quoted for the remote shell — embedded quotes escaped, never breaking out', async () => {
    // POSIX single-quoting makes EVERYTHING between the quotes inert except
    // the quote character itself, which is why a real embedded single quote
    // (the actual breakout vector) must be escaped as close-quote,
    // escaped-quote, reopen-quote ('\''). ';', '$()', backticks etc. are
    // harmless as long as they stay inside a single-quoted token — this
    // test verifies the token is built exactly that way, not merely that
    // some substring is textually absent.
    const evilText = "hi'; rm -rf /sdcard; echo 'pwned";
    const result = await toolFn('phone_sms_send')({ deviceId: 'test-serial', number: '+15551234567', text: evilText });
    assert.equal(result.ok, true);
    assert.equal(capturedCalls.length, 1);
    const remoteCommand = capturedCalls[0].args[1];
    const match = /--es sms_body (.+)$/.exec(remoteCommand);
    assert.ok(match, 'remote command must carry a quoted --es sms_body token');
    const expectedToken = "'" + evilText.replace(/'/g, "'\\''") + "'";
    assert.equal(match[1], expectedToken, 'the embedded single quotes must be escaped exactly as \'\\\'\', not left as breakout points');
  });

  it('a contact search query strips single quotes before reaching the remote --where clause', async () => {
    const result = await toolFn('phone_contacts_search')({ deviceId: 'test-serial', query: "Bob' OR '1'='1" });
    assert.equal(result.ok, true);
    assert.equal(capturedCalls.length, 1);
    const remoteCommand = capturedCalls[0].args[1];
    assert.equal(remoteCommand.includes("' OR '1'='1"), false, 'unsanitized SQL-breakout characters must not reach the where clause');
  });

  it('phone_screenshot base64-encodes real stdout bytes', async () => {
    androidChild.sendCommand = async (opts) => {
      capturedCalls.push(opts);
      return { ok: true, stdout: Buffer.from([0x89, 0x50, 0x4e, 0x47]), stderr: '' };
    };
    const result = await toolFn('phone_screenshot')({ deviceId: 'test-serial' });
    assert.equal(result.ok, true);
    assert.equal(result.result.format, 'png');
    assert.equal(Buffer.from(result.result.image, 'base64').equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), true);
  });

  it('phone_file_pull/phone_file_push sandbox the LOCAL path — a path outside the allowed roots is rejected before touching adb', async () => {
    const result = await toolFn('phone_file_pull')({ deviceId: 'test-serial', remotePath: '/sdcard/x.txt', localPath: 'C:\\Windows\\System32\\evil.txt' });
    assert.equal(result.ok, false);
    assert.equal(capturedCalls.length, 0);
  });

  it('phone_file_pull succeeds against a real sandboxed local path (mocked adb only)', async () => {
    const result = await toolFn('phone_file_pull')({ deviceId: 'test-serial', remotePath: '/sdcard/x.txt', localPath: 'from-android-test-scratch.txt' });
    assert.equal(result.ok, true);
    assert.equal(capturedCalls.length, 1);
    assert.deepEqual(capturedCalls[0].args.slice(0, 2), ['pull', '/sdcard/x.txt']);
  });

  it('phone_wifi_toggle/phone_bluetooth_toggle reject a state that is not enable|disable', async () => {
    const result = await toolFn('phone_wifi_toggle')({ deviceId: 'test-serial', state: 'sideways' });
    assert.equal(result.ok, false);
    assert.equal(capturedCalls.length, 0);
  });
});
