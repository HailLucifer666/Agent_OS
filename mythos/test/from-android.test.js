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
const { TOOLS, READBACK_MARKER } = require('../src/core/effectors/from-android');

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

describe('from-android.js — needs_result:true on the four read-back tools (regression guard)', () => {
  // voice-agent.js builds the spoken summary for ANY ok:true action as
  // `${tool} done.` and only re-derives it when the catalog entry declares
  // needs_result:true (see needsResultToolNames / forceNeedsResult around
  // voice-agent.js:386,561-566). Without this flag, a dispatched-but-
  // unverified or verified-unchanged outcome from these four tools would
  // still be reported to the user as a flat "done" — exactly the AD-4
  // fabrication the read-back verification above was meant to remove.
  it('phone_wifi_toggle, phone_bluetooth_toggle, phone_app_launch and phone_app_close all declare needs_result:true', () => {
    for (const name of ['phone_wifi_toggle', 'phone_bluetooth_toggle', 'phone_app_launch', 'phone_app_close']) {
      const t = TOOLS.find((x) => x.name === name);
      assert.ok(t, name + ' must be registered');
      assert.equal(t.needs_result, true, name + ' must declare needs_result:true so the spoken reply is re-derived instead of a fabricated "done."');
    }
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

// ---------------------------------------------------------------------------
// AD-4 read-back verification (mocked adapter only — there is NO physical
// Android device on this machine and none of these paths has been run against
// real hardware).
//
// The defect these tests pin down: `svc wifi enable|disable`,
// `svc bluetooth enable|disable`, `am force-stop` and `monkey -p <pkg> -c
// LAUNCHER 1` all commonly exit 0 on a real device WITHOUT the requested
// change happening (unsupported OEM state, permission-restricted package,
// monkey finding no launchable activity). Reporting the bare exit code as
// success is exactly the fabrication AD-4 forbids, so each of the four tools
// now reads the resulting state back and reports what was actually observed.
//
// Three outcomes per tool, and the third is the one that is easy to get
// wrong: a read-back that ITSELF fails must report dispatched-but-unverified
// — neither a claimed success (AD-4) nor a claimed failure (equally a
// fabrication, since nothing was observed), with the unobserved field null
// rather than guessed (AD-5).
// ---------------------------------------------------------------------------
describe('from-android.js — AD-4 read-back verification for toggles and app lifecycle', () => {
  let originalGetStatus, originalSendCommand, capturedCommands, respond;

  // The dispatch command ALWAYS exits 0 in this mock — that is the whole
  // point of the bug. Only what the read-back reports varies per test.
  function adbOk(stdout) {
    return { ok: true, stdout: Buffer.from(String(stdout == null ? '' : stdout)), stderr: '' };
  }
  function adbFail(error) {
    return { ok: false, error: error, stdout: Buffer.from(''), stderr: error };
  }
  function isReadBack(cmd) {
    return cmd.indexOf('settings get global') === 0 || cmd.indexOf('pidof') === 0;
  }
  // pidof's answer lives in its EXIT CODE (0 running / 1 not running), which
  // `adb shell` propagates and android-child turns into ok:false — so the
  // read-back appends a fixed `; echo <marker>=$?` to stay exit-0 and carry
  // the real status in stdout. These build that stdout.
  function pidofOut(rc, pids) {
    return (pids ? pids + '\n' : '') + READBACK_MARKER + '=' + rc + '\n';
  }

  beforeEach(() => {
    capturedCommands = [];
    originalGetStatus = androidChild.getStatus;
    originalSendCommand = androidChild.sendCommand;
    androidChild.getStatus = () => ({
      state: 'ONLINE', hint: null,
      devices: [{ serial: 'test-serial', model: 'Pixel', transportId: '1', authState: 'device', lastSeenAt: Date.now() }],
      queueDepth: 0,
    });
    respond = () => adbOk('');
    androidChild.sendCommand = async (opts) => {
      const cmd = opts.args[0] === 'shell' ? String(opts.args[1]) : opts.args.join(' ');
      capturedCommands.push(cmd);
      return respond(cmd);
    };
  });
  afterEach(() => {
    androidChild.getStatus = originalGetStatus;
    androidChild.sendCommand = originalSendCommand;
  });

  // ---- phone_wifi_toggle ----

  it('phone_wifi_toggle: exit 0 AND wifi_on read back as 1 -> ok, reporting the OBSERVED state', async () => {
    respond = (cmd) => (isReadBack(cmd) ? adbOk('1\n') : adbOk(''));
    const result = await toolFn('phone_wifi_toggle')({ deviceId: 'test-serial', state: 'enable' });
    assert.equal(result.ok, true);
    assert.equal(result.result.verified, true);
    assert.equal(result.result.wifi, 'enable');
    assert.equal(capturedCommands.length, 2, 'must dispatch AND read back');
    assert.equal(capturedCommands[0], "svc wifi 'enable'");
    assert.match(capturedCommands[1], /^settings get global 'wifi_on'$/);
  });

  it('phone_wifi_toggle: exit 0 but wifi_on still reads back as the OLD state -> must NOT claim success', async () => {
    respond = (cmd) => (isReadBack(cmd) ? adbOk('0\n') : adbOk(''));
    const result = await toolFn('phone_wifi_toggle')({ deviceId: 'test-serial', state: 'enable' });
    assert.equal(result.ok, false, 'a silent OEM no-op must never be reported as a successful toggle');
    assert.match(String(result.result), /did not take effect|still reports/i);
  });

  it('phone_wifi_toggle: read-back itself fails -> dispatched-but-unverified, never a fabricated ok and never a fabricated failure', async () => {
    respond = (cmd) => (isReadBack(cmd) ? adbFail('device offline mid-command') : adbOk(''));
    const result = await toolFn('phone_wifi_toggle')({ deviceId: 'test-serial', state: 'enable' });
    assert.equal(result.ok, true, 'nothing was observed, so this is not a claimed failure either');
    assert.equal(result.result.verified, false);
    assert.equal(result.result.wifi, null, 'AD-5: an unobserved state is null, never the requested value');
    assert.equal(result.result.dispatched, true);
    assert.match(result.result.note, /unverified/i);
  });

  it('phone_wifi_toggle: enabling an ALREADY-enabled radio reads back enabled and reports honest success, not "no change" failure', async () => {
    respond = (cmd) => (isReadBack(cmd) ? adbOk('1\n') : adbOk(''));
    const result = await toolFn('phone_wifi_toggle')({ deviceId: 'test-serial', state: 'enable' });
    assert.equal(result.ok, true);
    assert.equal(result.result.wifi, 'enable');
    assert.equal(result.result.verified, true);
  });

  it('phone_wifi_toggle: an unreadable setting value (e.g. "null") is unverified, not silently treated as off', async () => {
    respond = (cmd) => (isReadBack(cmd) ? adbOk('null\n') : adbOk(''));
    const result = await toolFn('phone_wifi_toggle')({ deviceId: 'test-serial', state: 'enable' });
    assert.equal(result.ok, true);
    assert.equal(result.result.verified, false);
    assert.equal(result.result.wifi, null);
  });

  it('phone_wifi_toggle: read-back FIRST verifies a MISMATCH, then goes unreadable on retries -> must still fail, never fall through to dispatched-but-unverified', async () => {
    // Pins down the "strongest observation wins" fix: once the phone has
    // actively contradicted the request, a later flaky/unreadable retry must
    // not erase that and smuggle the outcome through as ok:true unverified.
    let readBackCalls = 0;
    respond = (cmd) => {
      if (!isReadBack(cmd)) return adbOk('');
      readBackCalls++;
      return readBackCalls === 1 ? adbOk('0\n') : adbFail('device offline mid-command');
    };
    const result = await toolFn('phone_wifi_toggle')({ deviceId: 'test-serial', state: 'enable' });
    assert.equal(result.ok, false, 'a verified mismatch must win over a later unreadable retry');
    assert.match(String(result.result), /did not take effect|still reports/i);
  });

  // ---- phone_bluetooth_toggle ----

  it('phone_bluetooth_toggle: exit 0 AND bluetooth_on read back as 0 for a disable -> ok, observed state reported', async () => {
    respond = (cmd) => (isReadBack(cmd) ? adbOk('0\n') : adbOk(''));
    const result = await toolFn('phone_bluetooth_toggle')({ deviceId: 'test-serial', state: 'disable' });
    assert.equal(result.ok, true);
    assert.equal(result.result.verified, true);
    assert.equal(result.result.bluetooth, 'disable');
    assert.equal(capturedCommands[0], "svc bluetooth 'disable'");
    assert.match(capturedCommands[1], /^settings get global 'bluetooth_on'$/);
  });

  it('phone_bluetooth_toggle: exit 0 but bluetooth_on still reads back as the OLD state -> must NOT claim success', async () => {
    respond = (cmd) => (isReadBack(cmd) ? adbOk('1\n') : adbOk(''));
    const result = await toolFn('phone_bluetooth_toggle')({ deviceId: 'test-serial', state: 'disable' });
    assert.equal(result.ok, false);
    assert.match(String(result.result), /did not take effect|still reports/i);
  });

  it('phone_bluetooth_toggle: read-back itself fails -> dispatched-but-unverified', async () => {
    respond = (cmd) => (isReadBack(cmd) ? adbFail('settings: permission denied') : adbOk(''));
    const result = await toolFn('phone_bluetooth_toggle')({ deviceId: 'test-serial', state: 'enable' });
    assert.equal(result.ok, true);
    assert.equal(result.result.verified, false);
    assert.equal(result.result.bluetooth, null);
    assert.match(result.result.note, /unverified/i);
  });

  // ---- phone_app_launch ----

  it('phone_app_launch: monkey exits 0 AND pidof finds the process -> ok, running:true observed', async () => {
    respond = (cmd) => (isReadBack(cmd) ? adbOk(pidofOut(0, '4711')) : adbOk('Events injected: 1'));
    const result = await toolFn('phone_app_launch')({ deviceId: 'test-serial', packageName: 'com.whatsapp' });
    assert.equal(result.ok, true);
    assert.equal(result.result.verified, true);
    assert.equal(result.result.running, true);
    assert.equal(result.result.launched, 'com.whatsapp');
    assert.equal(capturedCommands.length, 2);
    assert.ok(capturedCommands[1].indexOf("pidof 'com.whatsapp'") === 0, 'the package name must still be shell-quoted in the read-back, got: ' + capturedCommands[1]);
  });

  it('phone_app_launch: monkey exits 0 but no process exists afterwards -> must NOT claim the app launched', async () => {
    respond = (cmd) => (isReadBack(cmd) ? adbOk(pidofOut(1, '')) : adbOk('Events injected: 1'));
    const result = await toolFn('phone_app_launch')({ deviceId: 'test-serial', packageName: 'com.whatsapp' });
    assert.equal(result.ok, false, 'monkey exits 0 even with no launchable activity — that is not a launch');
    assert.match(String(result.result), /not running|no process/i);
  });

  it('phone_app_launch: pidof unavailable on the device (exit 127) -> dispatched-but-unverified, running:null', async () => {
    respond = (cmd) => (isReadBack(cmd) ? adbOk('/system/bin/sh: pidof: not found\n' + READBACK_MARKER + '=127\n') : adbOk('Events injected: 1'));
    const result = await toolFn('phone_app_launch')({ deviceId: 'test-serial', packageName: 'com.whatsapp' });
    assert.equal(result.ok, true);
    assert.equal(result.result.verified, false);
    assert.equal(result.result.running, null);
    assert.equal(result.result.launched, null, 'AD-5: an unobserved launch is null, never the package name');
    assert.match(result.result.note, /unverified/i);
  });

  it('phone_app_launch: read-back command fails outright -> dispatched-but-unverified', async () => {
    respond = (cmd) => (isReadBack(cmd) ? adbFail('device unauthorized') : adbOk('Events injected: 1'));
    const result = await toolFn('phone_app_launch')({ deviceId: 'test-serial', packageName: 'com.whatsapp' });
    assert.equal(result.ok, true);
    assert.equal(result.result.verified, false);
    assert.equal(result.result.running, null);
  });

  it('phone_app_launch: pidof FIRST verifies no process (mismatch), then goes unreadable on retries -> must still fail, never dispatched-but-unverified', async () => {
    let readBackCalls = 0;
    respond = (cmd) => {
      if (!isReadBack(cmd)) return adbOk('Events injected: 1');
      readBackCalls++;
      return readBackCalls === 1 ? adbOk(pidofOut(1, '')) : adbFail('device unauthorized');
    };
    const result = await toolFn('phone_app_launch')({ deviceId: 'test-serial', packageName: 'com.whatsapp' });
    assert.equal(result.ok, false, 'a verified "not running" observation must win over a later unreadable retry');
    assert.match(String(result.result), /not running|no process/i);
  });

  // ---- phone_app_close ----

  it('phone_app_close: force-stop exits 0 AND pidof finds no process -> ok, running:false observed', async () => {
    respond = (cmd) => (isReadBack(cmd) ? adbOk(pidofOut(1, '')) : adbOk(''));
    const result = await toolFn('phone_app_close')({ deviceId: 'test-serial', packageName: 'com.whatsapp' });
    assert.equal(result.ok, true);
    assert.equal(result.result.verified, true);
    assert.equal(result.result.running, false);
    assert.equal(result.result.closed, 'com.whatsapp');
    assert.equal(capturedCommands[0], "am force-stop 'com.whatsapp'");
  });

  it('phone_app_close: force-stop exits 0 but the process is STILL running -> must NOT claim it closed', async () => {
    respond = (cmd) => (isReadBack(cmd) ? adbOk(pidofOut(0, '4711')) : adbOk(''));
    const result = await toolFn('phone_app_close')({ deviceId: 'test-serial', packageName: 'com.whatsapp' });
    assert.equal(result.ok, false);
    assert.match(String(result.result), /still running/i);
  });

  it('phone_app_close: read-back returns no status marker -> dispatched-but-unverified, closed:null', async () => {
    respond = (cmd) => (isReadBack(cmd) ? adbOk('garbage with no marker\n') : adbOk(''));
    const result = await toolFn('phone_app_close')({ deviceId: 'test-serial', packageName: 'com.whatsapp' });
    assert.equal(result.ok, true);
    assert.equal(result.result.verified, false);
    assert.equal(result.result.running, null);
    assert.equal(result.result.closed, null);
    assert.match(result.result.note, /unverified/i);
  });

  // ---- the read-back must never loosen the file's quoting discipline ----

  it('a package name with shell metacharacters is still rejected before either the dispatch OR the read-back runs', async () => {
    const r1 = await toolFn('phone_app_launch')({ deviceId: 'test-serial', packageName: 'com.evil; pidof com.bank' });
    const r2 = await toolFn('phone_app_close')({ deviceId: 'test-serial', packageName: '`id`' });
    assert.equal(r1.ok, false);
    assert.equal(r2.ok, false);
    assert.equal(capturedCommands.length, 0);
  });
});

describe('from-android.js — the four verified tools still fail honestly while OFFLINE', () => {
  let originalGetStatus, originalSendCommand, sendCommandCalls;
  beforeEach(() => {
    sendCommandCalls = 0;
    originalGetStatus = androidChild.getStatus;
    originalSendCommand = androidChild.sendCommand;
    androidChild.getStatus = () => ({ state: 'OFFLINE', hint: 'adb not found', devices: [], queueDepth: 0 });
    androidChild.sendCommand = async () => { sendCommandCalls++; return { ok: false, error: 'offline' }; };
  });
  afterEach(() => {
    androidChild.getStatus = originalGetStatus;
    androidChild.sendCommand = originalSendCommand;
  });

  it('adding a read-back does not turn an OFFLINE bridge into a partial success', async () => {
    const cases = [
      ['phone_wifi_toggle', { deviceId: 'test-serial', state: 'enable' }],
      ['phone_bluetooth_toggle', { deviceId: 'test-serial', state: 'enable' }],
      ['phone_app_launch', { deviceId: 'test-serial', packageName: 'com.whatsapp' }],
      ['phone_app_close', { deviceId: 'test-serial', packageName: 'com.whatsapp' }],
    ];
    for (const [name, args] of cases) {
      const result = await toolFn(name)(args);
      assert.equal(result.ok, false, name + ' must report ok:false while OFFLINE');
      assert.match(String(result.result), /OFFLINE|Unknown device|No Android devices/);
    }
    assert.equal(sendCommandCalls, 0, 'nothing should reach adb while OFFLINE');
  });
});
