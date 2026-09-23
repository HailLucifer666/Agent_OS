'use strict';

// BUG-284 — "the browser is declared OFFLINE for a whole Live session, so 13
// browser tools are withheld even after a browser could be started."
//
// NOT REPRODUCED. Closed against the audit of the session it was raised from,
// and this file exists so it is not re-opened on the same reasoning.
//
// What the 2026-08-20 audit actually shows:
//   13:59:28  browser_snapshot  allow
//   13:59:30  browser_snapshot  completed  ok
//   13:59:31  browser_click     first of 42, reason "tier-3-requires-confirm"
//   14:00:13  browser_click     last of 42
// browser_snapshot is NOT in the capability rule's `except` list, so it can only
// have been declared and invoked if the snapshot reported the browser ONLINE. It
// then succeeded — one second before the click spin began, in the same session
// and the same window. So browser tools were declared and working throughout.
//
// The operator's report ("browser automation fails") traces to BUG-282: 42
// browser_click proposals were blocked by the tier-3 confirm gate and re-asked
// once per tick, never reaching the adapter at all. That is fixed separately.
//
// Why this matters beyond one closed ticket: the proposed fix was to drop the
// browser rule from tool-capability.js, on the reasoning that from-browser.js's
// requireOnline() can bring a browser up lazily, so withholding is always
// wrong. That reasoning is not obviously false — requireOnline() really does
// connect-then-launch on each invocation — but acting on it would have deleted
// five deliberate assertions in
// bug-276-f1-browser-recovery-tool-survives-offline.test.js to solve a problem
// that did not exist in the session that motivated it. Two documented decisions
// disagreeing is not licence to overturn the older one from source reading
// alone; it needs a session where the withholding demonstrably cost something.
//
// The assertion below is the negative control BUG-276 F1 never had: it tests
// the OFFLINE half only, so nothing pinned the ONLINE half. If a future change
// widens the browser rule so that tools are withheld even with a healthy
// adapter, F1's tests would all still pass and this one would not.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildCapabilitySnapshot, checkToolCapability } = require('../src/core/voice/tool-capability');

// Adapter shapes, not hand-written booleans. buildCapabilitySnapshot resolves an
// unreadable adapter to `true`, so a fixture that skipped the builder could pass
// while the real path did something else entirely.
const ONLINE_BROWSER = { browser: { getStatus: () => ({ state: 'ONLINE' }) } };
const OFFLINE_BROWSER = { browser: { getStatus: () => ({ state: 'OFFLINE' }) } };

// The tools the session actually used or attempted, by name.
const USED_IN_SESSION = ['browser_snapshot', 'browser_click'];

describe('BUG-284: browser tools are declared when the adapter is healthy', () => {
  it('an ONLINE adapter produces browserOnline:true', () => {
    const snap = buildCapabilitySnapshot({ config: {}, adapters: ONLINE_BROWSER });
    assert.equal(snap.browserOnline, true);
  });

  it('withholds nothing that the audited session used', () => {
    // This is the property BUG-284 claimed was violated. It was not.
    const snap = buildCapabilitySnapshot({ config: {}, adapters: ONLINE_BROWSER });
    for (const name of USED_IN_SESSION) {
      const cap = checkToolCapability(name, snap);
      assert.equal(cap.ok, true,
        name + ' must be declared when the browser is online — the 2026-08-20 session '
        + 'invoked browser_snapshot successfully, which is only possible if it was');
    }
  });

  it('browser_snapshot is not exempt from the rule, so its success proves the snapshot said ONLINE', () => {
    // The load-bearing step in the refutation. If browser_snapshot were exempt
    // (like browser_launch_debug), its success would prove nothing about the
    // snapshot and BUG-284 would still be open.
    const offline = buildCapabilitySnapshot({ config: {}, adapters: OFFLINE_BROWSER });
    // 2026-09-11: the FIELD moved, the evidence did not, and the difference
    // matters enough to state. This used to assert ok:false, and warned that if
    // browser_snapshot ever became exempt "the evidence closing BUG-284 stops
    // holding". It has not become exempt — BUG-435 made the browser rule
    // selfHealing, which DECLARES the tool while still evaluating the snapshot
    // and still reporting the gate. So the load-bearing fact is unchanged (the
    // rule fires when the browser is offline) and is asserted below on `needs`
    // instead of `ok`. What genuinely no longer holds is the inference
    // "declared ⇒ the snapshot said ONLINE" — BUG-284's refutation rests on the
    // historical 2026-08-20 session under the old code, where that inference was
    // sound, so its conclusion stands; do not reuse that inference on new logs.
    const snapshotVerdict = checkToolCapability('browser_snapshot', offline);
    assert.equal(snapshotVerdict.rule, 'browser',
      'the rule must still evaluate the snapshot for this tool — if it stops, BUG-284 should be re-opened');
    assert.ok(snapshotVerdict.needs,
      'and must still report the gate it found, or the offline state has become invisible');
    assert.ok(!('reason' in snapshotVerdict) || snapshotVerdict.ok,
      'browser_snapshot is no longer withheld; it is declared with a stated prerequisite');
  });
});

describe('BUG-284: deliberate non-changes in tool-capability.js', () => {
  // Pinned because each was considered and rejected while investigating, and an
  // undocumented deliberate choice reads as an oversight.
  it('gmail stays gated on credentials, which no in-session action can supply', () => {
    const snap = buildCapabilitySnapshot({ config: {}, adapters: {} });
    assert.equal(checkToolCapability('gmail_unread', snap).ok, false);
    assert.match(checkToolCapability('gmail_unread', snap).reason, /google-auth\.js/,
      'the reason must name the script that fixes it');
  });

  it('phone stays gated on an attached device, which no in-session action can supply', () => {
    const snap = buildCapabilitySnapshot({
      config: {},
      adapters: { android: { getStatus: () => ({ state: 'ONLINE', devices: [] }) } },
    });
    assert.equal(snap.androidDevice, false, 'adb online with zero devices is not a device');
    assert.equal(checkToolCapability('phone_call', snap).ok, false);
  });

  it('the recovery tools stay exempt while offline', () => {
    const snap = buildCapabilitySnapshot({ config: {}, adapters: OFFLINE_BROWSER });
    assert.equal(checkToolCapability('browser_launch_debug', snap).ok, true);
    assert.equal(checkToolCapability('browser_switch', snap).ok, true);
  });
});
