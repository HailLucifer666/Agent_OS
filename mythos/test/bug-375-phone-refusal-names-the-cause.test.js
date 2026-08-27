'use strict';

// test/bug-375-phone-refusal-names-the-cause.test.js
//
// The phone capability rule had ONE reason string for TWO different causes:
//
//   adb reachable, no handset plugged in  -> "no Android device is attached over adb"  (true)
//   adb UNREACHABLE (missing binary, or   -> "no Android device is attached over adb"  (false,
//   ANDROID_ADB_BIN pointing nowhere)         and it sends the operator looking for a phone)
//
// Both collapsed into `snap.androidDevice === false`, because that flag was
// computed as `state === 'ONLINE' && devices.length > 0` — one boolean carrying
// two facts. The second case is not hypothetical: BUG-374 measured doctor
// reporting "OK" for adb while an override pointed at a nonexistent path, which
// is exactly the state that produces it.
//
// This is the same defect family as BUG-374 and BUG-372 — a report naming a
// cause it did not measure — and here the audience is the MODEL, which will
// relay the wrong remedy to the operator out loud.
//
// Found by running the 2026-08-26 audit plan's verification step 3, which named
// this rule specifically and had never been executed.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  buildCapabilitySnapshot,
  checkToolCapability,
} = require('../src/core/voice/tool-capability');

// A stand-in android adapter. Only getStatus() is consulted.
function androidStub(state, devices) {
  return { getStatus: () => ({ state: state, devices: devices }) };
}

function snapFor(state, devices) {
  return buildCapabilitySnapshot({ config: {}, adapters: { android: androidStub(state, devices) } });
}

describe('BUG-375 — a withheld phone tool names the cause it actually measured', () => {
  test('adapter ONLINE with no handset: the reason is the missing DEVICE', () => {
    const verdict = checkToolCapability('phone_list_devices', snapFor('ONLINE', []));
    assert.equal(verdict.ok, false, 'no device means the tool must still be withheld');
    assert.match(verdict.reason, /no Android device is attached/,
      'with adb working, the handset really is what is missing');
    assert.doesNotMatch(verdict.reason, /ANDROID_ADB_BIN|unreachable/,
      'and it must NOT blame the binary, which is fine here');
  });

  test('adapter OFFLINE: the reason is adb, not a missing handset', () => {
    // THE REGRESSION. This used to say "no Android device is attached over adb"
    // while adb itself could not be reached, so the remedy the model relays is
    // "plug in your phone" for a problem no phone can fix.
    const verdict = checkToolCapability('phone_screenshot', snapFor('OFFLINE', []));
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /adb itself is unreachable/,
      'the operator must be told the binary is the problem');
    assert.match(verdict.reason, /ANDROID_ADB_BIN/,
      'and pointed at the variable that overrides every install location (BUG-374)');
    assert.doesNotMatch(verdict.reason, /^no Android device is attached over adb$/,
      'the old single string is exactly what made this misleading');
  });

  test('the two causes produce DIFFERENT strings', () => {
    // Guards against a "fix" that appends the adb sentence to both branches,
    // which would satisfy each test above independently.
    const offline = checkToolCapability('phone_notifications', snapFor('OFFLINE', [])).reason;
    const noDevice = checkToolCapability('phone_notifications', snapFor('ONLINE', [])).reason;
    assert.notEqual(offline, noDevice,
      'one string for two causes is the whole bug; they must differ');
  });

  test('a device attached and ONLINE is not withheld at all', () => {
    // The control. Without it, a rule that always refused would pass every
    // assertion above.
    const verdict = checkToolCapability('phone_list_devices',
      snapFor('ONLINE', [{ serial: 'ABC123', model: 'Pixel', state: 'device' }]));
    assert.equal(verdict.ok, true, 'a real attached device must declare the phone tools');
  });

  test('an unreadable adapter does not manufacture an adb accusation', () => {
    // The header's rule: unknown is not offline, and over-withholding with a
    // wrong reason is worse than the withholding itself. With no android adapter
    // at all, nothing is known and nothing is blamed.
    const snap = buildCapabilitySnapshot({ config: {}, adapters: {} });
    assert.equal(snap.androidOnline, true, 'absent adapter is UNKNOWN, not offline');
    assert.equal(snap.androidDevice, true, 'and its tools stay available — pre-existing behaviour');
    assert.equal(checkToolCapability('phone_list_devices', snap).ok, true);
  });

  test('a getStatus() that THROWS is unknown, not offline', () => {
    // The catch branch, which the "absent adapter" case above does NOT reach: with
    // no android adapter the try body is skipped entirely, so the catch was
    // untested and a mutation setting androidOnline=false there SURVIVED. A
    // throwing status probe is a failure to ASK, and answering it by accusing adb
    // would put a wrong remedy in the model's mouth on the strength of an
    // exception.
    const throwing = { getStatus: () => { throw new Error('adapter exploded'); } };
    const snap = buildCapabilitySnapshot({ config: {}, adapters: { android: throwing } });
    assert.equal(snap.androidOnline, true,
      'could-not-ask is unknown; only a real OFFLINE state may blame adb');
    assert.equal(snap.androidDevice, true, 'and the tools stay available, per the header rule');
    assert.equal(checkToolCapability('phone_list_devices', snap).ok, true);
  });

  test('an empty state string is unknown, not offline', () => {
    // A getStatus() that answers with a shape carrying no state must not be read
    // as OFFLINE — that would blame adb on the strength of a parsing miss.
    const snap = snapFor('', []);
    assert.equal(snap.androidOnline, true, 'no state is unknown');
    // Pinned, not endorsed: androidDevice is false here because the flag requires
    // state === 'ONLINE'. So the tools are withheld with the DEVICE reason while
    // the state is unknown. That is pre-existing behaviour and this test records
    // it deliberately rather than changing it inside a fix about wording.
    const verdict = checkToolCapability('phone_list_devices', snap);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /no Android device is attached/,
      'unknown state falls to the device reason, and must not accuse the binary');
  });

  test('the other four rules still carry plain string reasons', () => {
    // `reason` became "string OR function of the snapshot". If that change had
    // been made by converting every rule, an unconverted consumer would render
    // "function (snap) {...}" to the model. Only the phone rule moved.
    const gmail = checkToolCapability('gmail_unread', buildCapabilitySnapshot({ config: {} }));
    assert.equal(gmail.ok, false, 'no OAuth triple in an empty config');
    assert.equal(typeof gmail.reason, 'string');
    assert.match(gmail.reason, /GOOGLE_CLIENT_ID/);
    const browser = checkToolCapability('browser_navigate',
      buildCapabilitySnapshot({ config: {}, adapters: { browser: { getStatus: () => ({ state: 'OFFLINE' }) } } }));
    assert.equal(browser.ok, false);
    assert.equal(typeof browser.reason, 'string');
  });

  test('every reason reaching a caller is a string, never a function', () => {
    // The failure this shape invites: `reason: rule.reason` handed the model a
    // function. Checked across every rule and both phone branches.
    const snaps = [
      buildCapabilitySnapshot({ config: {} }),
      snapFor('OFFLINE', []),
      snapFor('ONLINE', []),
    ];
    const names = ['gmail_unread', 'calendar_upcoming', 'phone_list_devices',
      'browser_navigate', 'cua_click'];
    for (const snap of snaps) {
      for (const name of names) {
        const v = checkToolCapability(name, snap);
        if (v.ok) continue;
        assert.equal(typeof v.reason, 'string',
          `${name} produced a ${typeof v.reason} reason — the model would be shown source code`);
        assert.ok(v.reason.length > 0 && !v.reason.includes('=>'),
          `${name} leaked a function body into its reason: ${v.reason}`);
      }
    }
  });
});
